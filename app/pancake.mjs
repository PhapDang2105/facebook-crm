// Pancake (pages.fm): Page vận hành trong Pancake, nhân viên xem và trả lời ở
// đó; CRM chỉ theo dõi. Pancake bắn webhook `messaging` về đây khi khách nhắn,
// tin được ghi vào hộp thư CRM (để theo dõi) rồi đưa cho bot; câu trả lời của
// bot gửi ngược qua Public API của Pancake nên hiện ngay trong Pancake cho
// nhân viên thấy. Tài liệu: integrations/pancake/README.md.
import { timingSafeEqual } from 'node:crypto';
import { pancakeConfig as defaultConfig } from './config.mjs';
import { applyWebhookEvents } from './meta-webhook.mjs';
import { publicConversation, saveMessage, updateMessagingStore } from './messaging-store.mjs';
import { publishMessagingEvent } from './message-events.mjs';

export function isPancakeConfigured(config = defaultConfig) {
  return Boolean(config.pageId && config.pageAccessToken && config.webhookToken);
}

/** Token trong URL webhook: so sánh theo thời gian hằng; token trống nghĩa là chưa bật. */
export function isPancakeWebhookTokenValid(provided, expected) {
  const given = Buffer.from(String(provided || ''));
  const wanted = Buffer.from(String(expected || ''));
  if (!wanted.length || given.length !== wanted.length) return false;
  return timingSafeEqual(given, wanted);
}

/** Pancake bọc nội dung trong HTML ("<div>Xin chào</div>"): về chữ thường, giữ xuống dòng. */
export function pancakeMessageText(message) {
  const raw = String(message?.original_message || message?.message || '');
  return raw
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(div|p)>\s*<(div|p)[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/[ \t]+\n/g, '\n')
    .trim();
}

/** "2024-12-25T11:06:07.000000" (không múi giờ, Pancake ghi theo UTC) → mốc thời gian. */
export function pancakeTime(value, fallback = Date.now()) {
  const text = String(value || '').trim();
  if (!text) return fallback;
  const iso = /(Z|[+-]\d\d:?\d\d)$/.test(text) ? text : `${text}Z`;
  const at = new Date(iso).getTime();
  return Number.isNaN(at) ? fallback : at;
}

/**
 * Sự kiện `messaging` của Pancake → sự kiện cùng dạng với webhook Meta, để đi
 * chung một đường vào hộp thư và bot (applyWebhookEvents). Chỉ nhận tin inbox
 * của đúng Page đã cấu hình; bình luận và các loại khác bỏ qua (chưa hỗ trợ).
 * Trả về [] khi không có gì để ghi.
 */
export function normalizePancakeWebhook(payload, config = defaultConfig, now = Date.now()) {
  if (!payload || payload.event_type !== 'messaging') return [];
  const pageId = String(payload.page_id || '');
  if (!pageId || (config.pageId && pageId !== String(config.pageId))) return [];
  const data = payload.data || {};
  const message = data.message || {};
  const conversation = data.conversation || {};
  if (String(message.type || conversation.type || 'INBOX').toUpperCase() !== 'INBOX') return [];
  const fromId = String(message.from?.id || '');
  const customerId = String(conversation.from?.id || (fromId !== pageId ? fromId : ''));
  if (!fromId || !customerId) return [];
  const outgoing = fromId === pageId || fromId !== customerId;
  const text = pancakeMessageText(message);
  const attachments = Array.isArray(message.attachments) ? message.attachments : [];
  const identifier = String(message.id || `pancake-${now}`);
  return [{
    pageId,
    psid: customerId,
    timestamp: pancakeTime(message.inserted_at, now),
    type: 'message',
    message: {
      id: identifier,
      mid: identifier,
      direction: outgoing ? 'outgoing' : 'incoming',
      type: text || !attachments.length ? 'text' : 'attachment',
      text: text || (attachments.length ? '[Tệp đính kèm]' : ''),
      createdAt: pancakeTime(message.inserted_at, now),
      status: outgoing ? 'sent' : 'received'
    },
    pancake: {
      conversationId: String(conversation.id || message.conversation_id || ''),
      customerName: String(conversation.from?.name || (outgoing ? '' : message.from?.name) || '').trim(),
      pageCustomerId: String(message.from?.page_customer_id || ''),
      // Hội thoại đã có nhân viên nhận thì bot đứng ngoài (trừ khi cấu hình cho phép).
      assigned: Array.isArray(conversation.assignee_ids) && conversation.assignee_ids.length > 0
    }
  }];
}

/**
 * Ghi tin vào hộp thư và trả về các thay đổi cho bot. Ghi thêm mã hội thoại
 * Pancake và tên khách lên hội thoại CRM để còn gửi trả lời đúng chỗ.
 */
export async function storePancakeEvents(events) {
  if (!events.length) return [];
  const changes = await updateMessagingStore(store => {
    const applied = applyWebhookEvents(store, events);
    for (const event of events) {
      const conversation = store.conversations.find(item => item.pageId === event.pageId && item.psid === event.psid && item.source !== 'comment');
      if (!conversation) continue;
      if (event.pancake.conversationId) conversation.pancakeConversationId = event.pancake.conversationId;
      if (event.pancake.pageCustomerId) conversation.pancakePageCustomerId = event.pancake.pageCustomerId;
      // Tên mặc định của hộp thư ("Khách Facebook 1234") thay bằng tên Pancake biết.
      if (event.pancake.customerName && (!conversation.name || /^Khách Facebook \d*$/.test(conversation.name))) conversation.name = event.pancake.customerName;
      conversation.pancakeAssigned = event.pancake.assigned;
    }
    return applied;
  });
  for (const change of changes) {
    publishMessagingEvent(change.conversation ? { ...change, conversation: publicConversation(change.conversation) } : change);
  }
  return changes;
}

/** Gửi một tin chữ vào hội thoại Pancake bằng Public API v1. */
export async function sendPancakeMessage({ pageId, conversationId, text }, config = defaultConfig, fetchImpl = fetch) {
  if (!config.pageAccessToken) throw new Error('Chưa có PANCAKE_PAGE_ACCESS_TOKEN.');
  if (!conversationId) throw new Error('Hội thoại này chưa có mã Pancake để gửi.');
  const url = `${config.apiBase.replace(/\/+$/, '')}/v1/pages/${encodeURIComponent(pageId)}/conversations/${encodeURIComponent(conversationId)}/messages?page_access_token=${encodeURIComponent(config.pageAccessToken)}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'reply_inbox', message: text }),
      signal: controller.signal
    });
    let body = {};
    try { body = await response.json(); } catch {}
    if (!response.ok || body.success === false) {
      throw new Error(`Pancake không nhận tin (${response.status}): ${body.message || body.error || 'không rõ lý do'}`);
    }
    return { id: String(body.id || body.message_id || `pancake-sent-${Date.now()}`) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Gửi tin của CRM/bot qua Pancake và ghi vào hộp thư như một tin đi. Chỉ gửi
 * được chữ: receipt/template dùng bản chữ, ảnh/tệp bị từ chối rõ ràng.
 */
export async function sendConversationMessageViaPancake(conversation, { text = '', templateText = '', attachment = null, imageUrl = '' }, config = defaultConfig, fetchImpl = fetch) {
  const body = String(templateText || text || '').trim();
  if (attachment || imageUrl) throw Object.assign(new Error('Qua Pancake chỉ gửi được tin chữ từ CRM.'), { statusCode: 400 });
  if (!body) throw Object.assign(new Error('Tin nhắn trống.'), { statusCode: 400 });
  const sent = await sendPancakeMessage({ pageId: conversation.pageId, conversationId: conversation.pancakeConversationId, text: body }, config, fetchImpl);
  const message = { id: sent.id, mid: sent.id, direction: 'outgoing', type: 'text', text: body, createdAt: Date.now(), status: 'sent' };
  const saved = await updateMessagingStore(store => {
    const outcome = saveMessage(store, { pageId: conversation.pageId, psid: conversation.psid, message });
    outcome.conversation.unread = false;
    return { message: outcome.message, conversation: publicConversation(outcome.conversation) };
  });
  publishMessagingEvent({ type: 'message', conversation: saved.conversation, message: saved.message });
  return saved;
}

/**
 * Một webhook Pancake từ đầu tới cuối: chuẩn hoá, ghi hộp thư, đưa cho bot.
 * Hội thoại đã có nhân viên nhận thì chỉ ghi, không đưa bot (trừ khi cấu hình
 * PANCAKE_BOT_WHEN_ASSIGNED=1). Trả về số tin đã ghi và số tin đưa bot.
 */
export async function handlePancakeWebhook(payload, { processChatbotChanges, chatbotDependencies, config = defaultConfig, now = Date.now() }) {
  const events = normalizePancakeWebhook(payload, config, now);
  const changes = await storePancakeEvents(events);
  const assigned = new Set(events.filter(event => event.pancake.assigned).map(event => `${event.pageId}:${event.psid}`));
  const forBot = config.botWhenAssigned
    ? changes
    : changes.filter(change => !change.conversation || !assigned.has(`${change.conversation.pageId}:${change.conversation.psid}`));
  if (forBot.length && processChatbotChanges) await processChatbotChanges(forBot, chatbotDependencies);
  return { stored: changes.length, bot: forBot.length };
}
