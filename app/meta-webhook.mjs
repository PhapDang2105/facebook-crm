import { createHmac, timingSafeEqual } from 'node:crypto';
import { getPageAccessToken } from './channel-store.mjs';
import { fetchCustomerProfile } from './meta-graph.mjs';
import { publishMessagingEvent } from './message-events.mjs';
import {
  ensureConversation,
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
  const base = {
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
      // Kept on the conversation, not the message: the ad is context for the
      // whole thread and only ever arrives on the first event.
      if (event.referral && !conversation.referral) conversation.referral = event.referral;
      if (inserted) changes.push({ type: 'message', conversation, message });
      continue;
    }
    if (event.type === 'referral' && event.referral) {
      const conversation = ensureConversation(store, { pageId: event.pageId, psid: event.psid });
      if (!conversation.referral) conversation.referral = event.referral;
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
  if (!unique.length) return [];
  const profiles = [];
  for (const item of unique) {
    try {
      const profile = await fetchCustomerProfile(item.psid, await getPageAccessToken(item.pageId));
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
    return profile.name || profile.picture ? { type: 'conversation', conversation } : null;
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
