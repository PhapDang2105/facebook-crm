import { createHmac, timingSafeEqual } from 'node:crypto';
import { getPageAccessToken } from './channel-store.mjs';
import { fetchCommentDetails, fetchCustomerProfile, fetchPostSummary } from './meta-graph.mjs';
import { publishMessagingEvent } from './message-events.mjs';
import { genderFromMessage, genderFromName } from './processing/customer-info.mjs';
import {
  applyGenderGuess,
  reconcileCustomerGender,
  commentConversationId,
  ensureConversation,
  conversationId,
  markOutgoingStatusUntil,
  publicConversation,
  readMessagingStore,
  saveMessage,
  updateMessageStatus,
  updateMessagingStore
} from './messaging-store.mjs';

export function verifyWebhookSubscription(searchParams, verifyToken) {
  const mode = searchParams.get('hub.mode');
  const token = searchParams.get('hub.verify_token');
  if (mode !== 'subscribe' || !verifyToken || token !== verifyToken) return null;
  return searchParams.get('hub.challenge') || '';
}

export function verifyWebhookSignature(rawBody, signatureHeader, appSecret) {
  if (!appSecret) return false;
  const header = String(signatureHeader || '');
  if (!header.startsWith('sha256=')) return false;
  const expected = Buffer.from(createHmac('sha256', appSecret).update(rawBody).digest('hex'), 'utf8');
  const received = Buffer.from(header.slice('sha256='.length), 'utf8');
  return expected.length === received.length && timingSafeEqual(expected, received);
}

export function normalizeWebhookAttachment(attachment) {
  const payload = attachment?.payload || {};
  const url = payload.url || '';
  if (attachment?.type === 'image') return { type: 'image', dataUrl: url, name: payload.sticker_id ? 'sticker' : '' };
  if (attachment?.type === 'video') return { type: 'video', dataUrl: url, name: '' };
  if (attachment?.type === 'audio') return { type: 'audio', dataUrl: url, name: '' };
  if (attachment?.type === 'file') return { type: 'document', dataUrl: url, name: payload.name || 'Tài liệu' };
  // Messenger echoes back the receipt template we sent. The order card in the
  // timeline already shows that order, so this is tagged instead of being
  // rendered as an "unsupported attachment" bubble.
  if (attachment?.type === 'template') return { type: 'order-receipt', text: 'Đã gửi xác nhận đơn hàng' };
  if (attachment?.type === 'location') {
    const { lat, long } = payload.coordinates || {};
    return { type: 'text', text: lat && long ? `Đã gửi vị trí: ${lat}, ${long}` : 'Đã gửi một vị trí' };
  }
  return { type: 'text', text: [payload.title, url].filter(Boolean).join(' — ') || 'Đã gửi một tệp đính kèm chưa hỗ trợ' };
}

export function normalizeWebhookReferral(referral) {
  if (!referral) return null;
  const context = referral.ads_context_data || {};
  const value = {
    ref: String(referral.ref || '').trim(),
    source: String(referral.source || '').trim(),
    adId: String(referral.ad_id || '').trim(),
    adTitle: String(context.ad_title || '').trim(),
    postId: String(context.post_id || '').trim(),
    photoUrl: String(context.photo_url || '').trim()
  };
  return Object.values(value).some(Boolean) ? value : null;
}

export function normalizeWebhookMessage(messagingEvent) {
  const message = messagingEvent?.message || {};
  const isEcho = Boolean(message.is_echo);
  const identifier = String(message.mid || `webhook-${messagingEvent?.timestamp || Date.now()}`);
  const attachment = (message.attachments || []).map(normalizeWebhookAttachment).find(Boolean);
  // Khách gửi nhiều ảnh trong một tin: giữ đủ danh sách để hộp thư vẽ lưới ảnh.
  const images = (message.attachments || []).filter(item => item?.type === 'image' && item.payload?.url).map(item => String(item.payload.url));
  const base = {
    ...(images.length > 1 ? { images } : {}),
    id: identifier,
    mid: identifier,
    direction: isEcho ? 'outgoing' : 'incoming',
    text: message.text || '',
    createdAt: Number(messagingEvent?.timestamp) || Date.now(),
    status: isEcho ? 'sent' : 'received'
  };
  if (!attachment) return { ...base, type: 'text' };
  if (attachment.type === 'order-receipt') return { ...base, type: 'order-receipt', text: attachment.text };
  if (attachment.type === 'text') return { ...base, type: 'text', text: base.text || attachment.text };
  return { ...base, ...attachment, text: base.text };
}

export function normalizeWebhookEvent(messagingEvent, pageId) {
  if (!messagingEvent || !pageId) return null;
  const senderId = String(messagingEvent.sender?.id || '');
  const recipientId = String(messagingEvent.recipient?.id || '');
  const isFromPage = senderId === String(pageId);
  const psid = isFromPage ? recipientId : senderId;
  if (!psid) return null;
  const shared = { pageId: String(pageId), psid, timestamp: Number(messagingEvent.timestamp) || Date.now() };
  // Click-to-Messenger ads carry the creative's title. It is the only signal
  // saying which product the customer was looking at when they opened the chat,
  // and it arrives once — on the first event — so it is captured here.
  const referral = normalizeWebhookReferral(messagingEvent.referral || messagingEvent.message?.referral || messagingEvent.postback?.referral);

  if (messagingEvent.message) {
    return { ...shared, type: 'message', message: normalizeWebhookMessage(messagingEvent), ...(referral ? { referral } : {}) };
  }
  if (messagingEvent.referral && !messagingEvent.message && !messagingEvent.postback) {
    return { ...shared, type: 'referral', referral };
  }
  if (messagingEvent.postback) {
    const title = messagingEvent.postback.title || messagingEvent.postback.payload || 'Đã bấm một nút';
    return {
      ...shared,
      type: 'message',
      ...(referral ? { referral } : {}),
      message: {
        id: String(messagingEvent.postback.mid || `postback-${shared.timestamp}`),
        mid: String(messagingEvent.postback.mid || `postback-${shared.timestamp}`),
        direction: 'incoming',
        type: 'text',
        text: title,
        createdAt: shared.timestamp,
        status: 'received'
      }
    };
  }
  if (messagingEvent.delivery) {
    // Meta kèm danh sách mid đã giao: tin CRM gửi ghi createdAt theo giờ máy
    // (sau khi Send API trả về) nên có thể muộn hơn watermark — mid mới chắc chắn.
    const mids = (Array.isArray(messagingEvent.delivery.mids) ? messagingEvent.delivery.mids : []).map(String).filter(Boolean);
    return { ...shared, type: 'delivery', watermark: Number(messagingEvent.delivery.watermark) || shared.timestamp, ...(mids.length ? { mids } : {}) };
  }
  if (messagingEvent.read) {
    return { ...shared, type: 'read', watermark: Number(messagingEvent.read.watermark) || shared.timestamp };
  }
  if (messagingEvent.reaction) {
    return {
      ...shared,
      type: 'reaction',
      mid: String(messagingEvent.reaction.mid || ''),
      action: messagingEvent.reaction.action || 'react',
      emoji: messagingEvent.reaction.emoji || ''
    };
  }
  return null;
}

/**
 * A comment from the `feed` field. Only comments are kept — likes, shares and
 * new posts also arrive here — and only additions or edits: a removed comment
 * stays in the thread as history.
 */
export function normalizeCommentEvent(change, pageId) {
  const value = change?.value || {};
  if (change?.field !== 'feed' || value.item !== 'comment' || !['add', 'edited'].includes(value.verb)) return null;
  const commentId = String(value.comment_id || '');
  const postId = String(value.post_id || '');
  const fromId = String(value.from?.id || '');
  if (!commentId || !postId || !fromId) return null;
  return {
    type: 'comment',
    pageId: String(pageId),
    commentId,
    postId,
    parentId: String(value.parent_id || ''),
    fromId,
    fromName: String(value.from?.name || '').trim(),
    text: String(value.message || '').trim(),
    photo: String(value.photo || '').trim(),
    createdAt: (Number(value.created_time) || Math.floor(Date.now() / 1000)) * 1000,
    fromPage: fromId === String(pageId)
  };
}

export function collectWebhookEvents(payload) {
  if (payload?.object !== 'page') return [];
  const events = [];
  for (const entry of payload.entry || []) {
    for (const messagingEvent of entry.messaging || []) {
      const normalized = normalizeWebhookEvent(messagingEvent, entry.id);
      if (normalized) events.push(normalized);
    }
    for (const change of entry.changes || []) {
      const normalized = normalizeCommentEvent(change, entry.id);
      if (normalized) events.push(normalized);
    }
  }
  return events;
}

/** Comment webhooks into the store: a customer's comment opens or continues their thread on that post; the Page's reply joins the thread it answers. */
function applyCommentEvent(store, event) {
  const message = {
    id: event.commentId,
    mid: event.commentId,
    direction: event.fromPage ? 'outgoing' : 'incoming',
    type: event.photo && !event.text ? 'image' : 'text',
    text: event.text,
    ...(event.photo ? { dataUrl: event.photo, name: '' } : {}),
    createdAt: event.createdAt,
    status: event.fromPage ? 'sent' : 'received',
    commentId: event.commentId,
    parentId: event.parentId
  };
  if (event.fromPage) {
    // Our own reply, echoed back. Attach it to the thread of the comment it
    // answers; a Page comment with no known parent is not a customer thread.
    const id = store.commentIndex[event.parentId] || store.commentIndex[event.commentId];
    if (!id) return null;
    const conversation = store.conversations.find(item => item.id === id);
    if (!conversation) return null;
    const { message: saved, inserted } = saveMessage(store, { pageId: event.pageId, psid: conversation.psid, id, source: 'comment', message });
    store.commentIndex[event.commentId] = id;
    return inserted ? { type: 'message', conversation, message: saved } : null;
  }
  // A reply the customer writes under our reply belongs to the thread that
  // reply is in; a fresh top-level comment opens their thread on this post.
  const parentThreadId = event.parentId ? store.commentIndex[event.parentId] : '';
  const parentThread = parentThreadId ? store.conversations.find(item => item.id === parentThreadId) : null;
  // Someone else answering under another customer's comment gets their own thread.
  const id = parentThread && parentThread.psid === event.fromId ? parentThread.id : commentConversationId(event.pageId, event.fromId, event.postId);
  const { conversation, message: saved, inserted } = saveMessage(store, {
    pageId: event.pageId,
    psid: event.fromId,
    name: event.fromName,
    id,
    source: 'comment',
    post: { id: event.postId },
    message,
    markUnread: true
  });
  conversation.lastCommentId = event.commentId;
  store.commentIndex[event.commentId] = conversation.id;
  if (inserted && applyGenderGuess(conversation, genderFromMessage(event.text), 'message')) reconcileCustomerGender(store, conversation);
  return inserted ? { type: 'message', conversation, message: saved } : null;
}

export function applyWebhookEvents(store, events) {
  const changes = [];
  for (const event of events) {
    if (event.type === 'comment') {
      const change = applyCommentEvent(store, event);
      if (change) changes.push(change);
      continue;
    }
    const id = conversationId(event.pageId, event.psid);
    if (event.type === 'message') {
      const { conversation, message, inserted } = saveMessage(store, {
        pageId: event.pageId,
        psid: event.psid,
        message: event.message,
        markUnread: event.message.direction === 'incoming'
      });
      // Gắn vào hội thoại chứ không vào tin nhắn: đây là bối cảnh của cả luồng.
      // Quảng cáo chỉ đến một lần, nhưng mã QR thì khách quét lại nhiều lần —
      // nên giữ bản mới nhất và một ít lịch sử, thay vì chỉ giữ lần đầu.
      if (event.referral) {
        conversation.referrals = [...(conversation.referrals || []), { ...event.referral, at: Date.now() }].slice(-20);
        conversation.referral = event.referral;
      }
      // A customer who commented first and then writes in Messenger (after the
      // bot's private reply) is still asking about that post's product.
      if (inserted && message.direction === 'incoming' && (!conversation.post || !conversation.picture)) {
        const commentThread = store.conversations
          .filter(item => item.source === 'comment' && item.pageId === conversation.pageId && item.psid === conversation.psid)
          .sort((first, second) => (second.lastMessageAt || 0) - (first.lastMessageAt || 0))[0];
        if (commentThread?.post?.message && !conversation.post) conversation.post = { ...commentThread.post, inheritedFrom: commentThread.id };
        // The comment webhook carries the person's picture; Messenger's profile lookup often does not.
        if (commentThread?.picture && !conversation.picture) conversation.picture = commentThread.picture;
      }
      if (inserted && message.direction === 'incoming' && applyGenderGuess(conversation, genderFromMessage(message.text), 'message')) reconcileCustomerGender(store, conversation);
      // Kèm referral vào change: khách MỚI bấm "Bắt đầu" thì Meta gửi postback,
      // và postback được chuẩn hoá thành sự kiện kiểu `message` — nên nếu chỉ
      // nghe nhánh `referral` sẽ bỏ sót đúng nhóm khách mới.
      if (inserted) changes.push({ type: 'message', conversation, message, ...(event.referral ? { referral: event.referral } : {}) });
      continue;
    }
    if (event.type === 'referral' && event.referral) {
      const conversation = ensureConversation(store, { pageId: event.pageId, psid: event.psid });
      // Quảng cáo thì chỉ đến một lần nên giữ lần đầu là đúng. Mã QR trên bao bì
      // thì ngược lại: khách mua lô mới lại quét, và chính lần quét SAU mới nói
      // cho ta biết họ quay lại. Giữ bản mới nhất, kèm vài lần gần đây.
      conversation.referrals = [...(conversation.referrals || []), { ...event.referral, at: Date.now() }].slice(-20);
      conversation.referral = event.referral;
      // Trước đây nhánh này lặng lẽ `continue`, nên không ai dưới hạ nguồn biết
      // khách vừa quét. Đẩy một thay đổi ra để còn chào lại được.
      changes.push({ type: 'referral', conversation, referral: event.referral });
      continue;
    }
    if (event.type === 'delivery' || event.type === 'read') {
      const status = event.type === 'delivery' ? 'delivered' : 'read';
      const updated = markOutgoingStatusUntil(store, { conversationId: id, until: event.watermark, status, mids: event.mids });
      if (updated) changes.push({ type: 'status', conversationId: id, pageId: event.pageId, status });
      continue;
    }
    if (event.type === 'reaction' && event.mid) {
      const message = updateMessageStatus(store, { conversationId: id, mid: event.mid, status: 'read' });
      if (message) {
        if (event.action === 'unreact') delete message.reaction;
        else message.reaction = event.emoji;
        changes.push({ type: 'reaction', conversationId: id, pageId: event.pageId, mid: event.mid });
      }
    }
  }
  return changes;
}

/** For a new comment thread: the commenter's picture and what post it is on. */
async function resolveCommentContext(changes) {
  const needsPost = conversation => !conversation.post?.permalink || conversation.post?.picture === undefined;
  const pending = changes.filter(change => change.type === 'message' && change.conversation.source === 'comment'
    && change.message.direction === 'incoming' && (!change.conversation.profileResolvedAt || needsPost(change.conversation)));
  if (!pending.length) return [];
  const details = [];
  for (const change of pending) {
    const token = await getPageAccessToken(change.conversation.pageId).catch(() => '');
    if (!token) continue;
    const comment = change.conversation.profileResolvedAt ? {} : await fetchCommentDetails(change.message.commentId, token);
    if (!change.conversation.profileResolvedAt && !comment.picture) logProfileMiss('bình luận', change.conversation.psid, comment.error);
    const post = needsPost(change.conversation) ? await fetchPostSummary(change.conversation.post?.id, token) : null;
    details.push({ id: change.conversation.id, comment, post });
  }
  return updateMessagingStore(store => details.map(({ id, comment, post }) => {
    const conversation = store.conversations.find(item => item.id === id);
    if (!conversation) return null;
    conversation.profileResolvedAt = Date.now();
    if (comment.name) conversation.name = comment.name;
    if (comment.picture) conversation.picture = comment.picture;
    applyGenderGuess(conversation, genderFromName(conversation.name), 'name');
    if (post && !post.error) conversation.post = { ...conversation.post, message: post.message, permalink: post.permalink, picture: post.picture };
    return { type: 'conversation', conversation };
  }).filter(Boolean));
}

// A lookup that failed (Standard access, app still in Development) is retried
// every few hours, so pictures fill in by themselves after the app goes Live.
const profileRetryAfterMs = 3 * 60 * 60 * 1000;

// The same Graph refusal repeats for every customer; journalctl gets it once
// per reason, with the first PSID it happened for.
const loggedProfileMisses = new Set();
function logProfileMiss(kind, psid, error) {
  const reason = error || 'Graph không trả về ảnh';
  const key = `${kind}:${reason}`;
  if (loggedProfileMisses.has(key)) return;
  loggedProfileMisses.add(key);
  console.warn(`Ảnh đại diện (${kind}) không lấy được cho ${psid}: ${reason}`);
}

/**
 * Cài đặt → Kênh → "Tải ảnh khách": retries the profile lookup for every
 * thread of a Page that still has no picture, and reports why it failed so
 * the reason is visible without reading the server log.
 */
export async function refreshCustomerProfiles(pageId, { limit = 100 } = {}) {
  const token = await getPageAccessToken(pageId);
  const store = await readMessagingStore();
  const targets = store.conversations
    .filter(item => item.pageId === String(pageId) && !item.picture && item.psid !== item.pageId)
    .sort((first, second) => (second.lastMessageAt || 0) - (first.lastMessageAt || 0))
    .slice(0, limit)
    .map(item => ({ id: item.id, psid: item.psid, source: item.source, lastCommentId: item.lastCommentId || '' }));
  const results = [];
  for (const target of targets) {
    const profile = target.source === 'comment'
      ? (target.lastCommentId ? await fetchCommentDetails(target.lastCommentId, token) : { error: 'Không còn mã bình luận để tra' })
      : await fetchCustomerProfile(target.psid, token);
    results.push({ ...target, name: profile.name || '', picture: profile.picture || '', error: profile.error || (profile.picture ? '' : 'Graph không trả về ảnh') });
  }
  await updateMessagingStore(current => {
    for (const result of results) {
      const conversation = current.conversations.find(item => item.id === result.id);
      if (!conversation) continue;
      conversation.profileResolvedAt = Date.now();
      if (result.name) conversation.name = result.name;
      if (result.picture) conversation.picture = result.picture;
      if (result.name || result.picture) publishMessagingEvent({ type: 'conversation', conversation: publicConversation(conversation) });
    }
    return null;
  });
  const errors = [...new Set(results.filter(item => !item.picture).map(item => item.error))];
  return { checked: results.length, updated: results.filter(item => item.picture).length, errors: errors.slice(0, 3) };
}

/** Fills in the customer name and photo once, right after their first message arrives. */
async function resolveMissingProfiles(changes) {
  const pending = changes
    .filter(change => change.type === 'message' && change.conversation.source !== 'comment'
      && (!change.conversation.profileResolvedAt || (!change.conversation.picture && change.conversation.profileResolvedAt < Date.now() - profileRetryAfterMs)))
    .map(change => ({ pageId: change.conversation.pageId, psid: change.conversation.psid }));
  const unique = [...new Map(pending.map(item => [`${item.pageId}:${item.psid}`, item])).values()];
  if (!unique.length) return [];
  const profiles = [];
  for (const item of unique) {
    try {
      const profile = await fetchCustomerProfile(item.psid, await getPageAccessToken(item.pageId));
      if (!profile.picture) logProfileMiss('Messenger', item.psid, profile.error);
      profiles.push({ ...item, ...profile });
    } catch (error) {
      // Without a valid Page token the conversation keeps its placeholder name.
      profiles.push({ ...item, name: '', picture: '', error: error.message });
    }
  }
  // Mark every attempt, including the failures. Standard access refuses these
  // lookups, and without the marker every incoming message would retry.
  return updateMessagingStore(store => profiles.map(profile => {
    const conversation = store.conversations.find(item => item.id === conversationId(profile.pageId, profile.psid));
    if (!conversation) return null;
    conversation.profileResolvedAt = Date.now();
    if (profile.name) conversation.name = profile.name;
    if (profile.picture) conversation.picture = profile.picture;
    applyGenderGuess(conversation, genderFromName(conversation.name), 'name');
    return profile.name || profile.picture ? { type: 'conversation', conversation } : null;
  }).filter(Boolean));
}

/** One line per delivery so `journalctl` shows what Meta actually sent. */
function describeWebhookPayload(payload, events) {
  const fields = (payload?.entry || []).flatMap(entry => (entry.changes || []).map(change => `${change.field}:${change.value?.item || '?'}/${change.value?.verb || '?'}`));
  const messaging = (payload?.entry || []).reduce((count, entry) => count + (entry.messaging || []).length, 0);
  // Chẩn đoán bật bằng WEBHOOK_DEBUG_KEYS=1: ghi TÊN TRƯỜNG Meta gửi tới, không
  // ghi nội dung tin nhắn. Dùng để biết CRM đang bỏ sót sự kiện nào — ví dụ
  // referral có về mà bị chuẩn hoá nhầm thì dòng tóm tắt bên trên không lộ ra.
  const shape = process.env.WEBHOOK_DEBUG_KEYS
    ? (payload?.entry || []).flatMap(entry => (entry.messaging || []).map(item => {
      const keys = Object.keys(item).filter(key => key !== 'sender' && key !== 'recipient' && key !== 'timestamp');
      const chiTiet = [];
      if (item.referral) chiTiet.push(`referral{ref=${item.referral.ref || '-'},source=${item.referral.source || '-'},type=${item.referral.type || '-'}}`);
      if (item.postback) chiTiet.push(`postback{payload=${item.postback.payload ? 'có' : '-'},referral=${item.postback.referral ? 'CÓ' : '-'}}`);
      if (item.message) chiTiet.push(`message{referral=${item.message.referral ? 'CÓ' : '-'},echo=${item.message.is_echo ? 'có' : '-'}}`);
      if (item.optin) chiTiet.push(`optin{ref=${item.optin.ref || '-'},login_id=${item.optin.login_id || '-'}}`);
      return `[${keys.join('+') || 'rỗng'}] ${chiTiet.join(' ')}`;
    })).join(' || ')
    : '';

  return `Webhook Meta: ${events.length} sự kiện xử lý (${events.map(event => event.type).join(', ') || 'không'})` +
    (messaging ? `, messaging=${messaging}` : '') + (fields.length ? `, changes=${fields.join(' ')}` : '') +
    (shape ? `\n    └─ Meta gửi: ${shape}` : '');
}

export async function processWebhookPayload(payload) {
  const events = collectWebhookEvents(payload);
  console.log(describeWebhookPayload(payload, events));
  if (!events.length) return [];
  const changes = await updateMessagingStore(store => applyWebhookEvents(store, events));
  const profileChanges = [...await resolveMissingProfiles(changes), ...await resolveCommentContext(changes)];
  for (const change of [...changes, ...profileChanges]) {
    publishMessagingEvent(change.conversation
      ? { ...change, conversation: publicConversation(change.conversation) }
      : change);
  }
  return changes;
}
