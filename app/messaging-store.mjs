import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { projectRoot } from './config.mjs';

// META_CONVERSATIONS_PATH lets the integration test run without touching real customer data.
const messagingStorePath = process.env.META_CONVERSATIONS_PATH
  || path.join(projectRoot, 'data', 'processed', 'meta-conversations.json');
const maximumMessagesPerConversation = 500;

let cachedStore = null;
let writeQueue = Promise.resolve();

function emptyStore() {
  return { conversations: [], messages: {} };
}

// Order confirmations recorded before the Messenger receipt template existed were
// stored either as the long plain-text confirmation or, for the template echo, as
// the generic "unsupported attachment" label. Both describe an order the timeline
// already draws as a card, so they are retagged once when the store is loaded.
const legacyReceiptAttachmentText = 'Đã gửi một tệp đính kèm chưa hỗ trợ';
const legacyReceiptTextPrefix = 'XÁC NHẬN ĐƠN ĐẶT HÀNG GIỌT NẮNG #';
const receiptPreview = 'Đã gửi xác nhận đơn hàng';

function isLegacyReceiptText(value) {
  const text = String(value || '');
  return text === legacyReceiptAttachmentText || text.startsWith(legacyReceiptTextPrefix);
}

function migrateLegacyReceipts(store) {
  for (const list of Object.values(store.messages)) {
    if (!Array.isArray(list)) continue;
    for (const message of list) {
      if (message?.direction !== 'outgoing' || !isLegacyReceiptText(message.text)) continue;
      message.type = 'order-receipt';
      message.text = receiptPreview;
    }
  }
  for (const conversation of store.conversations) {
    if (conversation?.lastMessageDirection !== 'outgoing') continue;
    if (isLegacyReceiptText(conversation.lastMessagePreview)) conversation.lastMessagePreview = receiptPreview;
  }
  return store;
}

function normalizeStore(value) {
  if (!value || typeof value !== 'object') return emptyStore();
  return migrateLegacyReceipts({
    conversations: Array.isArray(value.conversations) ? value.conversations : [],
    messages: value.messages && typeof value.messages === 'object' && !Array.isArray(value.messages) ? value.messages : {}
  });
}

export function conversationId(pageId, psid) {
  return `${pageId}:${psid}`;
}

export async function readMessagingStore() {
  if (cachedStore) return cachedStore;
  try {
    cachedStore = normalizeStore(JSON.parse(await readFile(messagingStorePath, 'utf8')));
  } catch {
    cachedStore = emptyStore();
  }
  return cachedStore;
}

async function persistStore(store) {
  await mkdir(path.dirname(messagingStorePath), { recursive: true });
  const temporaryPath = `${messagingStorePath}.tmp`;
  await writeFile(temporaryPath, JSON.stringify(store, null, 2), 'utf8');
  await rename(temporaryPath, messagingStorePath);
}

/** Serializes writes so bursts of webhook events cannot overwrite each other. */
export function updateMessagingStore(mutate) {
  const operation = writeQueue.then(async () => {
    const store = await readMessagingStore();
    const result = await mutate(store);
    await persistStore(store);
    return result;
  });
  writeQueue = operation.then(() => undefined, () => undefined);
  return operation;
}

export function messagePreview(message) {
  if (!message) return '';
  if (message.type === 'order-receipt') return receiptPreview;
  if (message.type === 'image') return message.text ? `Ảnh · ${message.text}` : 'Đã gửi một ảnh';
  if (message.type === 'video') return message.text ? `Video · ${message.text}` : 'Đã gửi một video';
  if (message.type === 'audio') return 'Đã gửi một tin nhắn thoại';
  if (message.type === 'document') return message.name ? `Tài liệu · ${message.name}` : 'Đã gửi một tài liệu';
  return message.text || '';
}

function findConversation(store, id) {
  return store.conversations.find(item => item.id === id) || null;
}

export function ensureConversation(store, { pageId, psid, name, picture }) {
  const id = conversationId(pageId, psid);
  let conversation = findConversation(store, id);
  if (!conversation) {
    conversation = {
      id,
      pageId: String(pageId),
      psid: String(psid),
      name: name || `Khách Facebook ${String(psid).slice(-4)}`,
      picture: picture || '',
      source: 'inbox',
      unread: false,
      muted: false,
      labels: ['new'],
      lastMessageAt: 0,
      lastMessagePreview: '',
      lastMessageDirection: '',
      lastCustomerMessageAt: 0,
      createdAt: Date.now()
    };
    store.conversations.push(conversation);
    store.messages[id] = [];
  }
  if (name && conversation.name !== name) conversation.name = name;
  if (picture) conversation.picture = picture;
  if (!Array.isArray(store.messages[id])) store.messages[id] = [];
  return conversation;
}

function applyLatestMessage(conversation, messages) {
  const latest = messages.at(-1);
  if (!latest) return;
  conversation.lastMessageAt = latest.createdAt;
  conversation.lastMessagePreview = messagePreview(latest);
  conversation.lastMessageDirection = latest.direction;
  if (latest.direction === 'incoming') {
    conversation.lastCustomerMessageAt = Math.max(conversation.lastCustomerMessageAt || 0, latest.createdAt);
  }
}

function insertMessage(messages, message) {
  const existingIndex = messages.findIndex(item => (message.mid && item.mid === message.mid) || item.id === message.id);
  if (existingIndex >= 0) {
    messages[existingIndex] = { ...messages[existingIndex], ...message };
    return { message: messages[existingIndex], inserted: false };
  }
  const position = messages.findIndex(item => item.createdAt > message.createdAt);
  if (position < 0) messages.push(message);
  else messages.splice(position, 0, message);
  if (messages.length > maximumMessagesPerConversation) messages.splice(0, messages.length - maximumMessagesPerConversation);
  return { message, inserted: true };
}

/** Adds a message and returns the updated conversation plus whether it was new. */
export function saveMessage(store, { pageId, psid, name, picture, message, markUnread = false }) {
  const conversation = ensureConversation(store, { pageId, psid, name, picture });
  const messages = store.messages[conversation.id];
  const { message: saved, inserted } = insertMessage(messages, message);
  applyLatestMessage(conversation, messages);
  if (markUnread && inserted) conversation.unread = true;
  return { conversation, message: saved, inserted };
}

export function updateMessageStatus(store, { conversationId: id, mid, status, error = '' }) {
  const messages = store.messages[id];
  if (!Array.isArray(messages)) return null;
  const message = messages.find(item => item.mid === mid || item.id === mid);
  if (!message) return null;
  message.status = status;
  if (error) message.error = error;
  else delete message.error;
  return message;
}

/** Marks every outgoing message up to `until` as delivered or read. */
export function markOutgoingStatusUntil(store, { conversationId: id, until, status }) {
  const messages = store.messages[id];
  if (!Array.isArray(messages)) return 0;
  const ranking = { sent: 0, delivered: 1, read: 2 };
  let changed = 0;
  for (const message of messages) {
    if (message.direction !== 'outgoing' || message.createdAt > until) continue;
    if ((ranking[message.status] ?? 0) >= ranking[status]) continue;
    message.status = status;
    changed += 1;
  }
  return changed;
}

export function publicConversation(conversation) {
  const replyWindowEndsAt = conversation.lastCustomerMessageAt
    ? conversation.lastCustomerMessageAt + 24 * 60 * 60 * 1000
    : 0;
  return {
    id: conversation.id,
    channelId: conversation.pageId,
    psid: conversation.psid,
    name: conversation.name,
    picture: conversation.picture || '',
    source: conversation.source || 'inbox',
    unread: Boolean(conversation.unread),
    muted: Boolean(conversation.muted),
    labels: Array.isArray(conversation.labels) ? conversation.labels : [],
    lastMessageAt: conversation.lastMessageAt || 0,
    lastMessagePreview: conversation.lastMessagePreview || '',
    lastMessageDirection: conversation.lastMessageDirection || '',
    replyWindowEndsAt,
    canReply: replyWindowEndsAt > Date.now()
  };
}

export async function listConversations(pageId) {
  const store = await readMessagingStore();
  return store.conversations
    .filter(conversation => !pageId || conversation.pageId === String(pageId))
    .sort((first, second) => (second.lastMessageAt || 0) - (first.lastMessageAt || 0))
    .map(publicConversation);
}

export async function getConversation(id) {
  const store = await readMessagingStore();
  return findConversation(store, id);
}

export async function listMessages(id, limit = 100) {
  const store = await readMessagingStore();
  const messages = store.messages[id];
  return Array.isArray(messages) ? messages.slice(-limit) : [];
}

export function setConversationFlags(store, id, changes) {
  const conversation = findConversation(store, id);
  if (!conversation) return null;
  if (typeof changes.unread === 'boolean') conversation.unread = changes.unread;
  if (typeof changes.muted === 'boolean') conversation.muted = changes.muted;
  if (Array.isArray(changes.labels)) conversation.labels = changes.labels;
  return conversation;
}
