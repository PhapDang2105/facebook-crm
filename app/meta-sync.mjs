import { getPageAccessToken } from './channel-store.mjs';
import {
  fetchCustomerProfile,
  fetchPageConversations,
  normalizeGraphConversation,
  sendPageAttachment,
  sendPageMessage
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

  const missingPictures = threads.slice(0, maximumProfileLookupsPerSync).map(thread => thread.psid);
  const pictures = [];
  for (const psid of missingPictures) {
    const profile = await fetchCustomerProfile(psid, pageAccessToken);
    if (profile.picture) pictures.push({ psid, ...profile });
  }
  if (pictures.length) {
    await updateMessagingStore(store => {
      for (const profile of pictures) {
        const conversation = store.conversations.find(item => item.id === conversationId(pageId, profile.psid));
        if (!conversation) continue;
        conversation.picture = profile.picture;
        if (profile.name) conversation.name = profile.name;
      }
    });
  }

  const store = await readMessagingStore();
  const conversations = store.conversations
    .filter(conversation => conversation.pageId === String(pageId))
    .sort((first, second) => (second.lastMessageAt || 0) - (first.lastMessageAt || 0))
    .map(publicConversation);
  publishMessagingEvent({ type: 'sync', pageId: String(pageId), conversations });
  return summary;
}

/** Sends a reply through the Send API and records it in the local conversation. */
export async function sendConversationMessage(conversation, { text = '', attachment = null }) {
  const pageAccessToken = await getPageAccessToken(conversation.pageId);
  const target = { pageId: conversation.pageId, psid: conversation.psid, pageAccessToken };
  const result = attachment
    ? await sendPageAttachment({ ...target, attachment })
    : await sendPageMessage({ ...target, text });
  // A caption cannot ride along with an attachment, so it follows as its own message.
  if (attachment && text) await sendPageMessage({ ...target, text });
  const message = {
    id: String(result.message_id || `sent-${Date.now()}`),
    mid: String(result.message_id || ''),
    direction: 'outgoing',
    type: attachment?.type || 'text',
    text,
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
