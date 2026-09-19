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
  const event = pancakeMessageEvent(pageId, data.conversation || {}, data.message || {}, now);
  return event ? [event] : [];
}

/**
 * Một tin của Pancake (từ webhook hay từ API liệt kê tin) → sự kiện cùng dạng
 * với webhook Meta. Chỉ tin inbox; null khi không xếp được về khách nào.
 */
export function pancakeMessageEvent(pageId, conversation, message, now = Date.now()) {
  if (String(message.type || conversation.type || 'INBOX').toUpperCase() !== 'INBOX') return null;
  const fromId = String(message.from?.id || '');
  const customerId = String(conversation.from?.id || (fromId !== pageId ? fromId : ''));
  if (!fromId || !customerId) return null;
  const outgoing = fromId === pageId || fromId !== customerId;
  const text = pancakeMessageText(message);
  const attachments = Array.isArray(message.attachments) ? message.attachments : [];
  const identifier = String(message.id || `pancake-${now}`);
  const at = pancakeTime(message.inserted_at, now);
  return {
    pageId,
    psid: customerId,
    timestamp: at,
    type: 'message',
    message: {
      id: identifier,
      mid: identifier,
      direction: outgoing ? 'outgoing' : 'incoming',
      type: text || !attachments.length ? 'text' : 'attachment',
      text: text || (attachments.length ? '[Tệp đính kèm]' : ''),
      createdAt: at,
      status: outgoing ? 'sent' : 'received'
    },
    pancake: {
      conversationId: String(conversation.id || message.conversation_id || ''),
      customerName: String(conversation.from?.name || (outgoing ? '' : message.from?.name) || '').trim(),
      pageCustomerId: String(message.from?.page_customer_id || ''),
      // Hội thoại đã có nhân viên nhận thì bot đứng ngoài (trừ khi cấu hình cho phép).
      assigned: Array.isArray(conversation.assignee_ids) && conversation.assignee_ids.length > 0
    }
  };
}

// ===== Đồng bộ lịch sử từ Pancake =====
//
// Webhook chỉ mang tin MỚI. Hội thoại đã có trong Pancake từ trước, hay tin đến
// lúc server đang khởi động lại, được kéo về bằng API liệt kê hội thoại và tin
// nhắn: khi mở kênh lần đầu, lúc khởi động, và định kỳ. Chỉ ghi hộp thư, không
// đưa bot (tin cũ không phải để trả lời).
async function pancakeGet(pathname, params, config, fetchImpl) {
  const url = new URL(`${config.apiBase.replace(/\/+$/, '')}${pathname}`);
  url.searchParams.set('page_access_token', config.pageAccessToken);
  for (const [key, value] of Object.entries(params)) if (value !== undefined && value !== '') url.searchParams.set(key, String(value));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  try {
    const response = await fetchImpl(url, { signal: controller.signal });
    let body = {};
    try { body = await response.json(); } catch {}
    if (!response.ok || body.success === false) throw new Error(`Pancake trả về ${response.status}: ${body.message || body.error || 'không rõ lý do'}`);
    return body;
  } finally {
    clearTimeout(timer);
  }
}

/** Hội thoại inbox mới nhất của Page, nhiều nhất `limit`, lùi dần bằng last_conversation_id. */
export async function fetchPancakeConversations({ limit = 60 } = {}, config = defaultConfig, fetchImpl = fetch) {
  const conversations = [];
  let lastConversationId = '';
  while (conversations.length < limit) {
    const body = await pancakeGet(`/v2/pages/${encodeURIComponent(config.pageId)}/conversations`, { type: 'INBOX', order_by: 'updated_at', last_conversation_id: lastConversationId }, config, fetchImpl);
    const batch = (Array.isArray(body.conversations) ? body.conversations : []).filter(item => String(item?.type || 'INBOX').toUpperCase() === 'INBOX');
    if (!batch.length) break;
    conversations.push(...batch);
    const last = batch.at(-1)?.id;
    if (!last || last === lastConversationId) break;
    lastConversationId = last;
    if (batch.length < 30) break;
  }
  return conversations.slice(0, limit);
}

/** Tin của một hội thoại, mới nhất trước; mỗi trang 30 tin, `pages` trang. */
export async function fetchPancakeMessages(conversationId, { pages = 1 } = {}, config = defaultConfig, fetchImpl = fetch) {
  const messages = [];
  for (let page = 0; page < pages; page += 1) {
    const body = await pancakeGet(`/v1/pages/${encodeURIComponent(config.pageId)}/conversations/${encodeURIComponent(conversationId)}/messages`, { current_count: page ? messages.length : '' }, config, fetchImpl);
    const batch = Array.isArray(body.messages) ? body.messages : [];
    if (!batch.length) break;
    messages.push(...batch);
    if (batch.length < 30) break;
  }
  return messages;
}

/**
 * Kéo hội thoại và tin gần đây từ Pancake vào hộp thư. Tin đã có (cùng mã)
 * không ghi lại, nên chạy nhiều lần vô hại. Trả về số hội thoại đã duyệt và
 * số tin mới ghi.
 */
export async function syncPancakeConversations({ limit = 60, messagePages = 1 } = {}, config = defaultConfig, fetchImpl = fetch) {
  if (!isPancakeConfigured(config)) return { conversations: 0, messages: 0, skipped: 'chưa cấu hình' };
  const conversations = await fetchPancakeConversations({ limit }, config, fetchImpl);
  let stored = 0;
  for (const conversation of conversations) {
    const messages = await fetchPancakeMessages(conversation.id, { pages: messagePages }, config, fetchImpl);
    const events = messages
      .map(message => pancakeMessageEvent(String(config.pageId), conversation, message))
      .filter(Boolean)
      .sort((first, second) => first.timestamp - second.timestamp);
    stored += (await storePancakeEvents(events)).length;
  }
  return { conversations: conversations.length, messages: stored };
}

let pancakeSyncTimer = null;
/** Đồng bộ lúc khởi động rồi mỗi 10 phút, để không lọt tin trong lúc webhook gián đoạn. */
export function startPancakeSync({ intervalMs = 10 * 60 * 1000, log = console.log, config = defaultConfig } = {}) {
  if (!isPancakeConfigured(config) || pancakeSyncTimer) return null;
  const run = async () => {
    try {
      const summary = await syncPancakeConversations({ limit: 60, messagePages: 1 }, config);
      if (summary.messages) log(`Đồng bộ Pancake: ${summary.conversations} hội thoại, ghi ${summary.messages} tin mới`);
    } catch (error) {
      log(`Đồng bộ Pancake lỗi: ${error.message}`);
    }
  };
  setTimeout(run, 5000);
  pancakeSyncTimer = setInterval(run, intervalMs);
  return pancakeSyncTimer;
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
