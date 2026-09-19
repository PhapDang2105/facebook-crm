import { getPageAccessToken } from './channel-store.mjs';
import {
  fetchCustomerProfile,
  fetchPageConversations,
  normalizeGraphConversation,
  replyToComment,
  sendPageAttachment,
  sendPrivateReply,
  sendPageImageUrl,
  sendPageMessage,
  sendPageTemplate,
  hideComment,
  likeComment
} from './meta-graph.mjs';
import { publishMessagingEvent } from './message-events.mjs';
import { sendConversationMessageViaPancake } from './pancake.mjs';
import {
  applyGenderGuess,
  conversationId,
  ensureConversation,
  publicConversation,
  readMessagingStore,
  saveMessage,
  updateMessagingStore
} from './messaging-store.mjs';
import { genderFromName } from './processing/customer-info.mjs';

const maximumProfileLookupsPerSync = 25;

/** Imports existing Messenger threads so the inbox is not empty before the first webhook arrives. */
export async function syncPageConversations(pageId, { limit = 25 } = {}) {
  const pageAccessToken = await getPageAccessToken(pageId);
  const result = await fetchPageConversations(pageId, pageAccessToken, limit);
  const threads = (result.data || [])
    .map(thread => normalizeGraphConversation(thread, pageId))
    .filter(Boolean);

  const summary = await updateMessagingStore(store => {
    let importedMessages = 0;
    for (const thread of threads) {
      const conversation = ensureConversation(store, { pageId, psid: thread.psid, name: thread.name });
      conversation.unread = thread.unreadCount > 0;
      conversation.profileResolvedAt = conversation.profileResolvedAt || Date.now();
      for (const message of thread.messages) {
        const { inserted } = saveMessage(store, { pageId, psid: thread.psid, name: thread.name, message });
        if (inserted) importedMessages += 1;
      }
    }
    return { conversations: threads.length, messages: importedMessages };
  });

  // Only look up customers we have never successfully resolved, and stop the
  // whole batch on the first refusal: when access is missing every lookup
  // fails the same way, and retrying 25 times just burns rate limit.
  const storedBeforeLookup = await readMessagingStore();
  const pending = threads
    .filter(thread => {
      const conversation = storedBeforeLookup.conversations.find(item => item.id === conversationId(pageId, thread.psid));
      return !conversation?.picture && !conversation?.pictureAttemptedAt;
    })
    .slice(0, maximumProfileLookupsPerSync);

  const pictures = [];
  let profileError = '';
  for (const thread of pending) {
    const profile = await fetchCustomerProfile(thread.psid, pageAccessToken);
    if (profile.error) { profileError = profile.error; break; }
    if (profile.picture) pictures.push({ psid: thread.psid, ...profile });
  }
  if (profileError) {
    console.error(`Không lấy được ảnh đại diện khách của Page ${pageId}: ${profileError}`);
  }
  if (pending.length) {
    await updateMessagingStore(current => {
      for (const thread of pending) {
        const conversation = current.conversations.find(item => item.id === conversationId(pageId, thread.psid));
        if (!conversation) continue;
        conversation.pictureAttemptedAt = Date.now();
        const profile = pictures.find(item => item.psid === thread.psid);
        if (!profile) continue;
        conversation.picture = profile.picture;
        if (profile.name) conversation.name = profile.name;
        applyGenderGuess(conversation, genderFromName(conversation.name), 'name');
      }
    });
  }

  const storedAfterSync = await readMessagingStore();
  const conversations = storedAfterSync.conversations
    .filter(conversation => conversation.pageId === String(pageId))
    .sort((first, second) => (second.lastMessageAt || 0) - (first.lastMessageAt || 0))
    .map(publicConversation);
  publishMessagingEvent({ type: 'sync', pageId: String(pageId), conversations });
  return summary;
}

/**
 * A comment thread answers under the customer's latest comment — publicly —
 * or, with `privateReply`, as one Messenger message to that person. The
 * public reply is echoed back by the feed webhook under the same comment id,
 * so recording it here and the echo merge into one bubble. A private reply
 * is a Messenger message, so it is recorded in the person's Messenger thread
 * (opened here if they never wrote in) — the comment thread keeps only
 * comments, the way Facebook itself separates the two.
 */
async function sendCommentReply(conversation, { text, imageUrl, privateReply }) {
  const body = String(text || imageUrl || '').trim();
  if (!body) throw Object.assign(new Error('Bình luận chỉ trả lời được bằng chữ.'), { statusCode: 400 });
  if (!conversation.lastCommentId) throw Object.assign(new Error('Chưa có bình luận nào của khách để trả lời.'), { statusCode: 400 });
  const pageAccessToken = await getPageAccessToken(conversation.pageId);
  const result = privateReply
    ? await sendPrivateReply({ pageId: conversation.pageId, commentId: conversation.lastCommentId, message: body, pageAccessToken })
    : await replyToComment({ commentId: conversation.lastCommentId, message: body, pageAccessToken });
  // A comment reply answers with {id}; the Send API with {message_id}.
  const id = String(result.id || result.message_id || `sent-${Date.now()}`);
  const message = {
    id,
    mid: id,
    direction: 'outgoing',
    type: 'text',
    text: body,
    createdAt: Date.now(),
    status: 'sent',
    ...(privateReply ? { privateReply: true } : { commentId: id, parentId: conversation.lastCommentId })
  };
  const saved = await updateMessagingStore(store => {
    const outcome = privateReply
      ? saveMessage(store, { pageId: conversation.pageId, psid: conversation.psid, name: conversation.name, picture: conversation.picture, message })
      : saveMessage(store, { pageId: conversation.pageId, psid: conversation.psid, id: conversation.id, source: 'comment', message });
    if (privateReply) {
      // The Messenger thread inherits what the comment was about.
      if (!outcome.conversation.post && conversation.post) outcome.conversation.post = { ...conversation.post, inheritedFrom: conversation.id };
      if (!outcome.conversation.gender && conversation.gender) applyGenderGuess(outcome.conversation, conversation.gender, conversation.genderSource);
    } else {
      outcome.conversation.unread = false;
      store.commentIndex[id] = conversation.id;
    }
    return { message: outcome.message, conversation: publicConversation(outcome.conversation) };
  });
  publishMessagingEvent({ type: 'message', conversation: saved.conversation, message: saved.message });
  return saved;
}

/** Like and/or hide the customer's latest comment, as the bot settings ask. */
export async function moderateComment(conversation, message, { like = false, hide = false } = {}) {
  const commentId = message?.commentId || conversation.lastCommentId;
  if (!commentId || (!like && !hide)) return;
  // Public API của Pancake không có thích/ẩn bình luận; Page đó cũng không có token Meta trong CRM.
  if (conversation.pancakeConversationId) return;
  const pageAccessToken = await getPageAccessToken(conversation.pageId);
  if (like) await likeComment({ commentId, pageAccessToken }).catch(() => {});
  if (hide) await hideComment({ commentId, pageAccessToken }).catch(() => {});
}

/** Sends a reply through the Send API and records it in the local conversation. */
export async function sendConversationMessage(conversation, { text = '', attachment = null, imageUrl = '', imageUrls = [], template = null, templateText = '', privateReply = false }) {
  // Hội thoại đến từ Pancake (Page vận hành trong Pancake, CRM không có token
  // Meta của Page đó): gửi ngược qua Public API của Pancake.
  if (conversation.pancakeConversationId) {
    // privateReply phải đi theo: thiếu nó, tin nhắn riêng cho người bình luận
    // bị đăng thành bình luận công khai (đã xảy ra với bảng giá).
    return sendConversationMessageViaPancake(conversation, { text, templateText, attachment, imageUrl, imageUrls, privateReply });
  }
  // Messenger Send API chỉ nhận một ảnh mỗi tin: nhiều ảnh thì gửi lần lượt.
  if (Array.isArray(imageUrls) && imageUrls.length) {
    let last = null;
    for (const url of [imageUrl, ...imageUrls].filter(Boolean)) last = await sendConversationMessage(conversation, { imageUrl: url, privateReply });
    return last;
  }
  if (conversation.source === 'comment') {
    if (attachment || template) throw Object.assign(new Error('Bình luận chỉ trả lời được bằng chữ.'), { statusCode: 400 });
    return sendCommentReply(conversation, { text, imageUrl, privateReply });
  }
  const pageAccessToken = await getPageAccessToken(conversation.pageId);
  const target = { pageId: conversation.pageId, psid: conversation.psid, pageAccessToken };
  let usedTemplate = Boolean(template);
  let result;
  if (template) {
    try {
      result = await sendPageTemplate({ ...target, payload: template });
    } catch (error) {
      // Messenger rejects a template for reasons the operator cannot fix mid-send
      // (unsupported field, image not publicly reachable). Falling back to the plain
      // text keeps the customer informed instead of failing the whole order.
      console.error(`Không gửi được receipt template, chuyển sang tin nhắn chữ: ${error.message}`);
      usedTemplate = false;
      result = await sendPageMessage({ ...target, text });
    }
  } else if (attachment) {
    result = await sendPageAttachment({ ...target, attachment });
  } else if (imageUrl) {
    // A product photo from a template: Messenger fetches the URL, nothing is uploaded.
    result = await sendPageImageUrl({ ...target, url: imageUrl });
  } else {
    result = await sendPageMessage({ ...target, text });
  }
  // A caption cannot ride along with an attachment, so it follows as its own message.
  if (attachment && text) await sendPageMessage({ ...target, text });
  const message = {
    id: String(result.message_id || `sent-${Date.now()}`),
    mid: String(result.message_id || ''),
    direction: 'outgoing',
    // A delivered receipt template is tagged so the timeline shows only the order
    // card, not a second bubble repeating the same thing as plain text.
    type: usedTemplate ? 'order-receipt' : (attachment?.type || (imageUrl ? 'image' : 'text')),
    text: usedTemplate ? 'Đã gửi xác nhận đơn hàng' : text,
    createdAt: Date.now(),
    status: 'sent',
    // The uploaded bytes stay out of the store; the echo webhook supplies Meta's hosted URL.
    ...(attachment ? { name: attachment.name || '', dataUrl: '' } : {}),
    ...(imageUrl ? { name: 'anh-san-pham', dataUrl: imageUrl } : {})
  };
  const saved = await updateMessagingStore(store => {
    const outcome = saveMessage(store, {
      pageId: conversation.pageId,
      psid: conversation.psid,
      message
    });
    outcome.conversation.unread = false;
    return { message: outcome.message, conversation: publicConversation(outcome.conversation) };
  });
  publishMessagingEvent({ type: 'message', conversation: saved.conversation, message: saved.message });
  return saved;
}
