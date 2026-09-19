// Pancake (pages.fm): Page vận hành trong Pancake, nhân viên xem và trả lời ở
// đó; CRM chỉ theo dõi. Pancake bắn webhook `messaging` về đây khi khách nhắn,
// tin được ghi vào hộp thư CRM (để theo dõi) rồi đưa cho bot; câu trả lời của
// bot gửi ngược qua Public API của Pancake nên hiện ngay trong Pancake cho
// nhân viên thấy. Tài liệu: integrations/pancake/README.md.
import { timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { metaConfig, pancakeConfig as defaultConfig, projectRoot } from './config.mjs';
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

/** Ảnh đại diện khách: đường công khai của Pancake (301 → ảnh trên content.pancake.vn), dùng thẳng làm src. */
export const pancakeAvatarUrl = (pageId, psid) => `https://pancake.vn/api/v1/pages/${encodeURIComponent(pageId)}/avatar/${encodeURIComponent(psid)}`;

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
  // Ảnh/video Pancake đưa kèm URL trên CDN của họ: hộp thư hiện thẳng. Loại
  // khác (tệp, âm thanh) chỉ ghi là có đính kèm.
  const kindOf = item => String(item?.type || '').toLowerCase();
  const photo = attachments.find(item => ['photo', 'image', 'sticker'].includes(kindOf(item)) && item?.url);
  const video = !photo && attachments.find(item => kindOf(item) === 'video' && item?.url);
  const media = photo ? { type: 'image', dataUrl: String(photo.url) } : video ? { type: 'video', dataUrl: String(video.url) } : null;
  const identifier = String(message.id || `pancake-${now}`);
  const at = pancakeTime(message.inserted_at, now);
  // Tin của Page: gửi từ CRM thì Pancake ghi người gửi là "Public API"; tên
  // khác là nhân viên gõ trong Pancake.
  const adminName = outgoing ? String(message.from?.admin_name || '').trim() : '';
  return {
    pageId,
    psid: customerId,
    timestamp: at,
    type: 'message',
    message: {
      id: identifier,
      mid: identifier,
      direction: outgoing ? 'outgoing' : 'incoming',
      type: media ? media.type : text || !attachments.length ? 'text' : 'attachment',
      text: text || (attachments.length && !media ? '[Tệp đính kèm]' : ''),
      ...(media ? { dataUrl: media.dataUrl, name: '' } : {}),
      createdAt: at,
      status: outgoing ? 'sent' : 'received'
    },
    pancake: {
      conversationId: String(conversation.id || message.conversation_id || ''),
      customerName: String(conversation.from?.name || (outgoing ? '' : message.from?.name) || '').trim(),
      pageCustomerId: String(message.from?.page_customer_id || ''),
      // Hội thoại đã có nhân viên nhận thì bot đứng ngoài (trừ khi cấu hình cho phép).
      assigned: Array.isArray(conversation.assignee_ids) && conversation.assignee_ids.length > 0,
      staff: Boolean(adminName) && adminName !== 'Public API',
      staffName: adminName
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
export async function storePancakeEvents(events, { fromWebhook = false } = {}) {
  if (!events.length) return [];
  const changes = await updateMessagingStore(store => {
    const applied = applyWebhookEvents(store, events);
    for (const event of events) {
      const conversation = store.conversations.find(item => item.pageId === event.pageId && item.psid === event.psid && item.source !== 'comment');
      if (!conversation) continue;
      if (event.pancake.conversationId) conversation.pancakeConversationId = event.pancake.conversationId;
      if (event.pancake.pageCustomerId) conversation.pancakePageCustomerId = event.pancake.pageCustomerId;
      const inserted = applied.some(change => change.message?.id === event.message.id && !change.updated);
      // Ảnh CRM gửi đi được ghi trước khi Pancake dội lại; bản dội mang URL ảnh
      // trên CDN (đã gộp vào tin cùng mã), báo cho hộp thư vẽ lại.
      if (!inserted && event.message.dataUrl) {
        const stored = (store.messages[conversation.id] || []).find(item => item.id === event.message.id);
        if (stored) applied.push({ type: 'message', conversation, message: stored, updated: true });
      }
      // Nhân viên trả lời trong Pancake (tin mới, không phải tin dội lại của
      // CRM, không phải lịch sử kéo về): bot đứng ngoài hội thoại này cho tới
      // khi bật lại trong CRM, để không nói chen vào người thật.
      if (fromWebhook && inserted && event.pancake.staff && conversation.botEnabled !== false) {
        conversation.botEnabled = false;
        conversation.botPausedBy = event.pancake.staffName;
        conversation.botPausedAt = Date.now();
      }
      // Ảnh khách: Pancake có đường công khai chuyển hướng tới ảnh trên CDN, không cần token.
      if (!conversation.picture) {
        conversation.picture = pancakeAvatarUrl(event.pageId, event.psid);
        conversation.profileResolvedAt = conversation.profileResolvedAt || Date.now();
      }
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

const apiRoot = config => config.apiBase.replace(/\/+$/, '');

/**
 * Gửi một tin vào hội thoại Pancake bằng Public API v1: chữ (`message`) hoặc
 * tệp đã tải lên (`content_ids`); Pancake không cho gửi cả hai trong một tin.
 */
export async function sendPancakeMessage({ pageId, conversationId, text = '', contentIds = [] }, config = defaultConfig, fetchImpl = fetch) {
  if (!config.pageAccessToken) throw new Error('Chưa có PANCAKE_PAGE_ACCESS_TOKEN.');
  if (!conversationId) throw new Error('Hội thoại này chưa có mã Pancake để gửi.');
  if (!text && !contentIds.length) throw new Error('Tin nhắn trống.');
  const url = `${apiRoot(config)}/v1/pages/${encodeURIComponent(pageId)}/conversations/${encodeURIComponent(conversationId)}/messages?page_access_token=${encodeURIComponent(config.pageAccessToken)}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(contentIds.length ? { action: 'reply_inbox', content_ids: contentIds } : { action: 'reply_inbox', message: text }),
      signal: controller.signal
    });
    let body = {};
    try { body = await response.json(); } catch {}
    if (!response.ok || body.success === false) {
      // Pancake hay trả 200 + success:false, lý do nằm trong original_error.
      const reason = body.message || body.error
        || (body.original_error && (typeof body.original_error === 'string' ? body.original_error : JSON.stringify(body.original_error).slice(0, 300)))
        || `phản hồi: ${JSON.stringify(body).slice(0, 300)}`;
      throw new Error(`Pancake không nhận tin (${response.status}): ${reason}`);
    }
    return { id: String(body.id || body.message_id || `pancake-sent-${Date.now()}`) };
  } finally {
    clearTimeout(timer);
  }
}

/** Tải một tệp (ảnh, video…) lên Page trong Pancake; mã trả về dùng để gửi kèm tin. */
export async function uploadPancakeContent({ pageId, buffer, filename = 'anh.jpg', mime = 'application/octet-stream' }, config = defaultConfig, fetchImpl = fetch) {
  if (!config.pageAccessToken) throw new Error('Chưa có PANCAKE_PAGE_ACCESS_TOKEN.');
  if (!buffer?.length) throw new Error('Tệp trống.');
  const url = `${apiRoot(config)}/v1/pages/${encodeURIComponent(pageId)}/upload_contents?page_access_token=${encodeURIComponent(config.pageAccessToken)}`;
  const form = new FormData();
  form.append('file', new Blob([buffer], { type: mime }), filename);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30000);
  try {
    const response = await fetchImpl(url, { method: 'POST', body: form, signal: controller.signal });
    let body = {};
    try { body = await response.json(); } catch {}
    if (!response.ok || body.success === false || !body.id) {
      throw new Error(`Pancake không nhận tệp (${response.status}): ${body.message || body.error || 'không rõ lý do'}`);
    }
    return { id: String(body.id), attachmentType: String(body.attachment_type || '') };
  } finally {
    clearTimeout(timer);
  }
}

const productImagesPath = path.join(projectRoot, 'data', 'processed', 'product-images');
const imageMimeTypes = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' };
const maxUploadBytes = 5 * 1024 * 1024;

/** Ảnh gửi đi: ảnh sản phẩm của CRM đọc thẳng từ đĩa, ảnh ngoài thì tải về. */
async function readImageForUpload(imageUrl, fetchImpl) {
  const parsed = new URL(imageUrl);
  const local = parsed.origin === new URL(metaConfig.publicBaseUrl).origin && parsed.pathname.match(/^\/product-images\/([A-Za-z0-9-]+\.(?:png|jpe?g|webp))$/);
  if (local) {
    const filename = local[1];
    return { buffer: await readFile(path.join(productImagesPath, filename)), filename, mime: imageMimeTypes[path.extname(filename).toLowerCase()] };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetchImpl(parsed, { signal: controller.signal });
    if (!response.ok) throw new Error(`Không tải được ảnh (${response.status}).`);
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > maxUploadBytes) throw new Error('Ảnh lớn hơn 5 MB.');
    const mime = String(response.headers?.get?.('content-type') || 'image/jpeg').split(';')[0].trim();
    return { buffer, filename: path.basename(parsed.pathname) || 'anh.jpg', mime };
  } finally {
    clearTimeout(timer);
  }
}

// Pancake chỉ nhận tệp tải lên tới 500 KB ("File size should not exceed
// 500KB"); ảnh sản phẩm trong Cài đặt thường 1–2 MB, nên ảnh được thu nhỏ
// và nén sang JPEG trước khi tải (sharp). Tệp không phải ảnh thì phải tự nhỏ.
export const pancakeUploadLimit = 500 * 1024;

/** Ảnh lớn hơn giới hạn của Pancake → JPEG nhỏ dần (cạnh dài 1080px, chất lượng giảm) cho tới khi lọt. */
export async function fitImageForPancake(file, limit = pancakeUploadLimit) {
  if (!file?.buffer || file.buffer.length <= limit || !/^image\/(png|jpe?g|webp)$/i.test(file.mime || '')) return file;
  let sharp;
  try {
    ({ default: sharp } = await import('sharp'));
  } catch {
    throw new Error('Ảnh lớn hơn 500 KB mà thiếu thư viện sharp để nén (chạy npm install).');
  }
  let width = 1080;
  let quality = 82;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const buffer = await sharp(file.buffer).rotate().resize({ width, height: width, fit: 'inside', withoutEnlargement: true }).jpeg({ quality, mozjpeg: true }).toBuffer();
    if (buffer.length <= limit) {
      return { buffer, filename: String(file.filename || 'anh').replace(/\.[^.]*$/, '') + '.jpg', mime: 'image/jpeg' };
    }
    width = Math.round(width * 0.8);
    quality = Math.max(40, quality - 12);
  }
  throw new Error('Không nén được ảnh xuống dưới 500 KB để gửi qua Pancake.');
}

// Mã nội dung Pancake của ảnh đã tải lên, để mỗi lần báo giá không tải lại
// cùng một ảnh sản phẩm. Khoá là URL bỏ phần truy vấn (?v= đổi mỗi lần).
const contentIdCache = new Map();
const contentIdTtlMs = 12 * 60 * 60 * 1000;
const contentCacheKey = imageUrl => String(imageUrl).replace(/[?#].*$/, '');

async function pancakeContentIdForImage(pageId, imageUrl, config, fetchImpl) {
  const key = contentCacheKey(imageUrl);
  const cached = contentIdCache.get(key);
  if (cached && Date.now() - cached.at < contentIdTtlMs) return { id: cached.id, cached: true };
  const file = await fitImageForPancake(await readImageForUpload(imageUrl, fetchImpl));
  const { id } = await uploadPancakeContent({ pageId, ...file }, config, fetchImpl);
  contentIdCache.set(key, { id, at: Date.now() });
  return { id, cached: false };
}

function decodeDataUrl(dataUrl) {
  const match = String(dataUrl || '').match(/^data:([^;,]+)(?:;[^,]*)?;base64,([A-Za-z0-9+/=\s]+)$/);
  if (!match) throw Object.assign(new Error('Tệp đính kèm không đọc được.'), { statusCode: 400 });
  const buffer = Buffer.from(match[2].replace(/\s+/g, ''), 'base64');
  if (!buffer.length) throw Object.assign(new Error('Tệp đính kèm trống.'), { statusCode: 400 });
  if (buffer.length > maxUploadBytes) throw Object.assign(new Error('Tệp đính kèm lớn hơn 5 MB.'), { statusCode: 400 });
  return { mime: match[1], buffer };
}

/**
 * Gửi tin của CRM/bot qua Pancake và ghi vào hộp thư như một tin đi. Chữ gửi
 * thẳng; ảnh sản phẩm của mẫu tin (imageUrl) và tệp nhân viên đính kèm
 * (attachment) tải lên Pancake trước rồi gửi bằng mã nội dung. Receipt/template
 * dùng bản chữ. Chữ đi kèm tệp được gửi thành tin riêng sau tệp.
 */
export async function sendConversationMessageViaPancake(conversation, { text = '', templateText = '', attachment = null, imageUrl = '' }, config = defaultConfig, fetchImpl = fetch) {
  const body = String(templateText || text || '').trim();
  const target = { pageId: conversation.pageId, conversationId: conversation.pancakeConversationId };
  if (!body && !attachment && !imageUrl) throw Object.assign(new Error('Tin nhắn trống.'), { statusCode: 400 });
  let message;
  if (imageUrl) {
    const first = await pancakeContentIdForImage(target.pageId, imageUrl, config, fetchImpl);
    let sent;
    try {
      sent = await sendPancakeMessage({ ...target, contentIds: [first.id] }, config, fetchImpl);
    } catch (error) {
      // Mã cũ trong bộ nhớ có thể đã hết hạn phía Pancake: tải lại một lần.
      if (!first.cached) throw error;
      contentIdCache.delete(contentCacheKey(imageUrl));
      const fresh = await pancakeContentIdForImage(target.pageId, imageUrl, config, fetchImpl);
      sent = await sendPancakeMessage({ ...target, contentIds: [fresh.id] }, config, fetchImpl);
    }
    message = { id: sent.id, mid: sent.id, direction: 'outgoing', type: 'image', text: '', name: 'anh-san-pham', dataUrl: imageUrl, createdAt: Date.now(), status: 'sent' };
  } else if (attachment) {
    const { mime, buffer } = decodeDataUrl(attachment.dataUrl);
    const file = await fitImageForPancake({ buffer, filename: attachment.name || 'tep-dinh-kem', mime });
    if (file.buffer.length > pancakeUploadLimit) throw Object.assign(new Error('Pancake chỉ nhận tệp tới 500 KB; ảnh được nén tự động, tệp khác cần nhỏ hơn.'), { statusCode: 400 });
    const { id } = await uploadPancakeContent({ pageId: target.pageId, ...file }, config, fetchImpl);
    const sent = await sendPancakeMessage({ ...target, contentIds: [id] }, config, fetchImpl);
    // Nội dung tệp không lưu vào kho; bản dội lại từ Pancake mang URL ảnh trên CDN.
    message = { id: sent.id, mid: sent.id, direction: 'outgoing', type: attachment.type || 'document', text: '', name: attachment.name || '', dataUrl: '', createdAt: Date.now(), status: 'sent' };
    if (body) await sendPancakeMessage({ ...target, text: body }, config, fetchImpl);
  } else {
    const sent = await sendPancakeMessage({ ...target, text: body }, config, fetchImpl);
    message = { id: sent.id, mid: sent.id, direction: 'outgoing', type: 'text', text: body, createdAt: Date.now(), status: 'sent' };
  }
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
  const changes = await storePancakeEvents(events, { fromWebhook: true });
  const assigned = new Set(events.filter(event => event.pancake.assigned).map(event => `${event.pageId}:${event.psid}`));
  const forBot = config.botWhenAssigned
    ? changes
    : changes.filter(change => !change.conversation || !assigned.has(`${change.conversation.pageId}:${change.conversation.psid}`));
  if (forBot.length && processChatbotChanges) await processChatbotChanges(forBot, chatbotDependencies);
  return { stored: changes.length, bot: forBot.length };
}
