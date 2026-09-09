import { createHmac, timingSafeEqual } from 'node:crypto';
import { getPageAccessToken } from './channel-store.mjs';
import { fetchCustomerProfile } from './meta-graph.mjs';
import { publishMessagingEvent } from './message-events.mjs';
import {
  conversationId,
  markOutgoingStatusUntil,
  publicConversation,
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
  if (attachment?.type === 'location') {
    const { lat, long } = payload.coordinates || {};
    return { type: 'text', text: lat && long ? `Đã gửi vị trí: ${lat}, ${long}` : 'Đã gửi một vị trí' };
  }
  return { type: 'text', text: [payload.title, url].filter(Boolean).join(' — ') || 'Đã gửi một tệp đính kèm chưa hỗ trợ' };
}

export function normalizeWebhookMessage(messagingEvent) {
  const message = messagingEvent?.message || {};
  const isEcho = Boolean(message.is_echo);
  const identifier = String(message.mid || `webhook-${messagingEvent?.timestamp || Date.now()}`);
  const attachment = (message.attachments || []).map(normalizeWebhookAttachment).find(Boolean);
  const base = {
    id: identifier,
    mid: identifier,
    direction: isEcho ? 'outgoing' : 'incoming',
    text: message.text || '',
    createdAt: Number(messagingEvent?.timestamp) || Date.now(),
    status: isEcho ? 'sent' : 'received'
  };
  if (!attachment) return { ...base, type: 'text' };
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

  if (messagingEvent.message) {
    return { ...shared, type: 'message', message: normalizeWebhookMessage(messagingEvent) };
  }
  if (messagingEvent.postback) {
    const title = messagingEvent.postback.title || messagingEvent.postback.payload || 'Đã bấm một nút';
    return {
      ...shared,
      type: 'message',
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
    return { ...shared, type: 'delivery', watermark: Number(messagingEvent.delivery.watermark) || shared.timestamp };
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

export function collectWebhookEvents(payload) {
  if (payload?.object !== 'page') return [];
  const events = [];
  for (const entry of payload.entry || []) {
    for (const messagingEvent of entry.messaging || []) {
      const normalized = normalizeWebhookEvent(messagingEvent, entry.id);
      if (normalized) events.push(normalized);
    }
  }
  return events;
}

function applyWebhookEvents(store, events) {
  const changes = [];
  for (const event of events) {
    const id = conversationId(event.pageId, event.psid);
    if (event.type === 'message') {
      const { conversation, message, inserted } = saveMessage(store, {
        pageId: event.pageId,
        psid: event.psid,
        message: event.message,
        markUnread: event.message.direction === 'incoming'
      });
      if (inserted) changes.push({ type: 'message', conversation, message });
      continue;
    }
    if (event.type === 'delivery' || event.type === 'read') {
      const status = event.type === 'delivery' ? 'delivered' : 'read';
      const updated = markOutgoingStatusUntil(store, { conversationId: id, until: event.watermark, status });
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

/** Fills in the customer name and photo once, right after their first message arrives. */
async function resolveMissingProfiles(changes) {
  const pending = changes
    .filter(change => change.type === 'message' && !change.conversation.profileResolvedAt)
    .map(change => ({ pageId: change.conversation.pageId, psid: change.conversation.psid }));
  const unique = [...new Map(pending.map(item => [`${item.pageId}:${item.psid}`, item])).values()];
  const profiles = [];
  for (const item of unique) {
    try {
      const profile = await fetchCustomerProfile(item.psid, await getPageAccessToken(item.pageId));
      if (profile.name || profile.picture) profiles.push({ ...item, ...profile });
    } catch {
      // Without a valid Page token the conversation simply keeps its placeholder name.
    }
  }
  if (!profiles.length) return [];
  return updateMessagingStore(store => profiles.map(profile => {
    const conversation = store.conversations.find(item => item.id === conversationId(profile.pageId, profile.psid));
    if (!conversation) return null;
    if (profile.name) conversation.name = profile.name;
    if (profile.picture) conversation.picture = profile.picture;
    conversation.profileResolvedAt = Date.now();
    return { type: 'conversation', conversation };
  }).filter(Boolean));
}

export async function processWebhookPayload(payload) {
  const events = collectWebhookEvents(payload);
  if (!events.length) return [];
  const changes = await updateMessagingStore(store => applyWebhookEvents(store, events));
  const profileChanges = await resolveMissingProfiles(changes);
  for (const change of [...changes, ...profileChanges]) {
    publishMessagingEvent(change.conversation
      ? { ...change, conversation: publicConversation(change.conversation) }
      : change);
  }
  return changes;
}
