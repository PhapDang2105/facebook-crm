import { getPageAccessToken } from './channel-store.mjs';
import {
  fetchCustomerProfile,
  fetchPageConversations,
  normalizeGraphConversation,
  sendPageAttachment,
  sendPageMessage,
  sendPageTemplate
} from './meta-graph.mjs';
import { publishMessagingEvent } from './message-events.mjs';
import {
  conversationId,
  ensureConversation,
  publicConversation,
  readMessagingStore,
  saveMessage,
  updateMessagingStore
} from './messaging-store.mjs';

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

/** Sends a reply through the Send API and records it in the local conversation. */
export async function sendConversationMessage(conversation, { text = '', attachment = null, template = null, templateText = '' }) {
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
  } else {
    result = await sendPageMessage({ ...target, text });
  }
  // A caption cannot ride along with an attachment, so it follows as its own message.
  if (attachment && text) await sendPageMessage({ ...target, text });
  const message = {
    id: String(result.message_id || `sent-${Date.now()}`),
    mid: String(result.message_id || ''),
    direction: 'outgoing',
    // The local timeline keeps rendering its own order card, so a delivered template
    // is still recorded as the plain confirmation text rather than a new message type.
    type: attachment?.type || 'text',
    text: usedTemplate ? (templateText || text) : text,
    createdAt: Date.now(),
    status: 'sent',
    // The uploaded bytes stay out of the store; the echo webhook supplies Meta's hosted URL.
    ...(attachment ? { name: attachment.name || '', dataUrl: '' } : {})
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
