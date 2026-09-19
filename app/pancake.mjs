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
import { publicConversation, readMessagingStore, saveMessage, updateMessagingStore } from './messaging-store.mjs';
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
  const conversation = data.conversation || {};
  const message = data.message || {};
  // Bình luận về cùng webhook `messaging`, chỉ khác type = COMMENT và có kèm bài viết.
  const kind = String(message.type || conversation.type || 'INBOX').toUpperCase();
  const event = kind === 'COMMENT'
    ? pancakeCommentEvent(pageId, conversation, message, data.post || {}, now)
    : pancakeMessageEvent(pageId, conversation, message, now);
  return event ? [event] : [];
}

/** Quảng cáo đưa khách tới hội thoại: Pancake chỉ cho ad_id và post_id của bài quảng cáo (tên tra riêng qua GET /ads). */
function pancakeAdOf(conversation) {
  const ads = Array.isArray(conversation?.ads) ? conversation.ads : [];
  const latest = ads.at(-1);
  const adId = String(latest?.ad_id || (Array.isArray(conversation?.ad_ids) ? conversation.ad_ids.at(-1) : '') || '');
  return adId ? { adId, postId: String(latest?.post_id || '') } : null;
}

/** Bài viết Pancake (webhook data.post hay `post` của API tin) → bối cảnh bài như bên Meta: id, nội dung, link, ảnh. */
export function pancakePostContext(post) {
  const id = String(post?.id || '');
  if (!id) return null;
  const attachments = Array.isArray(post.attachments?.data) ? post.attachments.data : Array.isArray(post.attachments) ? post.attachments : [];
  const first = attachments[0] || {};
  const picture = String(first.target?.thumbnail || first.media?.image?.src || first.thumbnail || first.url || '');
  return {
    id,
    message: String(post.message || '').trim().slice(0, 600),
    // Pancake không trả permalink; id bài dạng {page}_{post} mở được trên Facebook.
    permalink: `https://www.facebook.com/${id}`,
    picture
  };
}

/**
 * Một bình luận của Pancake → sự kiện `comment` cùng dạng với webhook feed
 * của Meta (applyCommentEvent): mỗi khách một luồng theo bài, trả lời của
 * Page nối vào luồng của bình luận cha. Null khi thiếu mã bình luận hay bài.
 */
export function pancakeCommentEvent(pageId, conversation, comment, post = {}, now = Date.now()) {
  const commentId = String(comment.id || '');
  const fromId = String(comment.from?.id || '');
  const postId = String(post?.id || conversation.post_id || '');
  if (!commentId || !fromId || !postId) return null;
  const fromPage = fromId === pageId;
  const attachments = Array.isArray(comment.attachments) ? comment.attachments : [];
  const photo = attachments.find(item => ['photo', 'image', 'sticker'].includes(String(item?.type || '').toLowerCase()) && item?.url);
  const at = pancakeTime(comment.inserted_at, now);
  const adminName = fromPage ? String(comment.from?.admin_name || '').trim() : '';
  return {
    type: 'comment',
    pageId,
    psid: fromPage ? String(conversation.from?.id || '') : fromId,
    timestamp: at,
    commentId,
    postId,
    // Bình luận gốc của Pancake có parent_id trỏ về chính nó; với CRM gốc là không có cha.
    parentId: comment.is_parent ? '' : String(comment.parent_id || ''),
    fromId,
    fromName: String(comment.from?.name || '').trim(),
    text: pancakeMessageText(comment),
    photo: photo ? String(photo.url) : '',
    createdAt: at,
    fromPage,
    pancake: {
      conversationId: String(conversation.id || comment.conversation_id || ''),
      customerName: String(conversation.from?.name || (fromPage ? '' : comment.from?.name) || '').trim(),
      pageCustomerId: String(comment.from?.page_customer_id || ''),
      assigned: Array.isArray(conversation.assignee_ids) && conversation.assignee_ids.length > 0,
      staff: Boolean(adminName) && adminName !== 'Public API',
      staffName: adminName,
      post: pancakePostContext(post) || { id: postId, message: '', permalink: `https://www.facebook.com/${postId}`, picture: '' },
      ad: null
    }
  };
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
      staffName: adminName,
      // Khách đến từ quảng cáo: ghi như referral của Meta để bot biết sản phẩm.
      ad: pancakeAdOf(conversation)
    }
  };
}

// ===== Đồng bộ lịch sử từ Pancake =====
//
// Webhook chỉ mang tin MỚI. Hội thoại đã có trong Pancake từ trước, hay tin đến
// lúc server đang khởi động lại, được kéo về bằng API liệt kê hội thoại và tin
// nhắn: khi mở kênh lần đầu, lúc khởi động, và định kỳ. Chỉ ghi hộp thư, không
// đưa bot (tin cũ không phải để trả lời).
const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

// Pancake giới hạn 5 lần gọi mỗi giây cho mỗi Page; quá thì trả 429 "Too many
// requests". Gặp 429 thì nghỉ rồi gọi lại (tối đa 3 lần).
async function pancakeGet(pathname, params, config, fetchImpl, attempt = 0) {
  const url = new URL(`${config.apiBase.replace(/\/+$/, '')}${pathname}`);
  url.searchParams.set('page_access_token', config.pageAccessToken);
  for (const [key, value] of Object.entries(params)) if (value !== undefined && value !== '') url.searchParams.set(key, String(value));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  try {
    const response = await fetchImpl(url, { signal: controller.signal });
    let body = {};
    try { body = await response.json(); } catch {}
    if (response.status === 429 && attempt < 3) {
      clearTimeout(timer);
      await pause(1500 * (attempt + 1));
      return pancakeGet(pathname, params, config, fetchImpl, attempt + 1);
    }
    if (!response.ok || body.success === false) throw new Error(`Pancake trả về ${response.status}: ${body.message || body.error || 'không rõ lý do'}`);
    return body;
  } finally {
    clearTimeout(timer);
  }
}

/** Hội thoại mới nhất của Page theo loại (INBOX hay COMMENT), nhiều nhất `limit`, lùi dần bằng last_conversation_id. */
export async function fetchPancakeConversations({ limit = 60, type = 'INBOX' } = {}, config = defaultConfig, fetchImpl = fetch) {
  const conversations = [];
  let lastConversationId = '';
  while (conversations.length < limit) {
    const body = await pancakeGet(`/v2/pages/${encodeURIComponent(config.pageId)}/conversations`, { type, order_by: 'updated_at', last_conversation_id: lastConversationId }, config, fetchImpl);
    const batch = (Array.isArray(body.conversations) ? body.conversations : []).filter(item => String(item?.type || 'INBOX').toUpperCase() === type);
    if (!batch.length) break;
    conversations.push(...batch);
    const last = batch.at(-1)?.id;
    if (!last || last === lastConversationId) break;
    lastConversationId = last;
    if (batch.length < 30) break;
  }
  return conversations.slice(0, limit);
}

/** Tin của một hội thoại, mới nhất trước; mỗi trang 30 tin, `pages` trang. Kèm bài viết (`post`) với luồng bình luận. */
export async function fetchPancakeMessages(conversationId, { pages = 1 } = {}, config = defaultConfig, fetchImpl = fetch) {
  const messages = [];
  let post = null;
  for (let page = 0; page < pages; page += 1) {
    const body = await pancakeGet(`/v1/pages/${encodeURIComponent(config.pageId)}/conversations/${encodeURIComponent(conversationId)}/messages`, { current_count: page ? messages.length : '' }, config, fetchImpl);
    const batch = Array.isArray(body.messages) ? body.messages : [];
    if (body.post && !post) post = body.post;
    if (!batch.length) break;
    messages.push(...batch);
    if (batch.length < 30) break;
  }
  messages.post = post;
  return messages;
}

/**
 * Kéo hội thoại và tin gần đây từ Pancake vào hộp thư: inbox, rồi luồng bình
 * luận (kèm bài viết). Tin đã có (cùng mã) không ghi lại, nên chạy nhiều lần
 * vô hại. Trả về số hội thoại đã duyệt và số tin mới ghi.
 */
export async function syncPancakeConversations({ limit = 60, messagePages = 1, commentLimit = 30 } = {}, config = defaultConfig, fetchImpl = fetch) {
  if (!isPancakeConfigured(config)) return { conversations: 0, messages: 0, skipped: 'chưa cấu hình' };
  const pageId = String(config.pageId);
  const conversations = await fetchPancakeConversations({ limit }, config, fetchImpl);
  let stored = 0;
  for (const conversation of conversations) {
    const messages = await fetchPancakeMessages(conversation.id, { pages: messagePages }, config, fetchImpl);
    const events = messages
      .map(message => pancakeMessageEvent(pageId, conversation, message))
      .filter(Boolean)
      .sort((first, second) => first.timestamp - second.timestamp);
    stored += (await storePancakeEvents(events)).length;
  }
  // Hội thoại từ quảng cáo còn thiếu tên/bài quảng cáo (kể cả không có tin mới): tra bổ sung.
  const store = await readMessagingStore();
  const pendingAds = store.conversations.filter(item => item.pageId === pageId && needsAdContext(item));
  if (pendingAds.length) await enrichPancakeAdContext(pendingAds, config, fetchImpl);
  const threads = commentLimit > 0 ? await fetchPancakeConversations({ limit: commentLimit, type: 'COMMENT' }, config, fetchImpl) : [];
  for (const thread of threads) {
    const comments = await fetchPancakeMessages(thread.id, { pages: 1 }, config, fetchImpl);
    const post = comments.post || { id: thread.post_id };
    // Bình luận gốc trước, trả lời sau, để trả lời của Page tìm được luồng cha.
    const events = comments
      .map(comment => pancakeCommentEvent(pageId, thread, comment, post))
      .filter(Boolean)
      .sort((first, second) => (first.parentId ? 1 : 0) - (second.parentId ? 1 : 0) || first.timestamp - second.timestamp);
    stored += (await storePancakeEvents(events)).length;
  }
  return { conversations: conversations.length + threads.length, messages: stored };
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
export async function storePancakeEvents(incomingEvents, { fromWebhook = false } = {}) {
  if (!incomingEvents.length) return [];
  const changes = await updateMessagingStore(store => {
    // Tin nhắn riêng CRM gửi từ bình luận đã nằm ở hộp thư của khách; Pancake
    // dội lại bản đó trong luồng bình luận thì không ghi thành bình luận của Page.
    const events = incomingEvents.filter(event => !(event.type === 'comment' && event.fromPage
      && (store.messages[`${event.pageId}:${event.psid}`] || []).some(item => item.id === event.commentId && item.privateReply)));
    if (!events.length) return [];
    // Tin ảnh đã có URL từ trước thì bản dội lại không có gì mới để báo hộp thư.
    const lackedPicture = new Set(events
      .filter(event => event.type === 'message' && event.message.dataUrl)
      .filter(event => {
        const id = `${event.pageId}:${event.psid}`;
        const stored = (store.messages[id] || []).find(item => item.id === event.message.id);
        return stored && !stored.dataUrl;
      })
      .map(event => event.message.id));
    const applied = applyWebhookEvents(store, events);
    for (const event of events) {
      const isComment = event.type === 'comment';
      const messageId = isComment ? event.commentId : event.message.id;
      // Luồng bình luận: applyCommentEvent đã ghi mã bình luận → mã luồng.
      const conversation = isComment
        ? store.conversations.find(item => item.id === store.commentIndex?.[messageId]) || null
        : store.conversations.find(item => item.pageId === event.pageId && item.psid === event.psid && item.source !== 'comment');
      if (!conversation) continue;
      if (event.pancake.conversationId) conversation.pancakeConversationId = event.pancake.conversationId;
      if (event.pancake.pageCustomerId) conversation.pancakePageCustomerId = event.pancake.pageCustomerId;
      const inserted = applied.some(change => change.message?.id === messageId && !change.updated);
      if (isComment) {
        // Bài viết đi kèm bình luận: nội dung bài là thứ bot dùng để đoán sản phẩm.
        const post = event.pancake.post;
        if (post?.id && (!conversation.post?.message || conversation.post.id !== post.id)) {
          conversation.post = { ...(conversation.post || {}), ...post, message: post.message || conversation.post?.message || '' };
        }
      } else {
        // Ảnh CRM gửi đi được ghi trước khi Pancake dội lại; bản dội mang URL ảnh
        // trên CDN (đã gộp vào tin cùng mã), báo cho hộp thư vẽ lại.
        if (!inserted && lackedPicture.has(messageId)) {
          const stored = (store.messages[conversation.id] || []).find(item => item.id === messageId);
          if (stored) applied.push({ type: 'message', conversation, message: stored, updated: true });
        }
        // Khách đến từ quảng cáo: ghi referral như Meta (nguồn 'ADS', tên quảng
        // cáo tra sau bằng enrichPancakeAdContext). Chỉ ghi khi quảng cáo đổi.
        const ad = event.pancake.ad;
        if (ad && conversation.referral?.adId !== ad.adId) {
          const referral = { ref: '', source: 'ADS', adId: ad.adId, adTitle: '', postId: ad.postId, photoUrl: '' };
          conversation.referrals = [...(conversation.referrals || []), { ...referral, at: Date.now() }].slice(-20);
          conversation.referral = referral;
        }
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
      if (!conversation.picture && conversation.psid) {
        conversation.picture = pancakeAvatarUrl(event.pageId, conversation.psid);
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
 * `action`: reply_inbox (mặc định), reply_comment (trả lời công khai dưới bình
 * luận `commentId`), private_replies (nhắn riêng cho người bình luận: cần
 * `postId`, `commentId`, `fromId`).
 */
export async function sendPancakeMessage({ pageId, conversationId, text = '', contentIds = [], action = 'reply_inbox', commentId = '', postId = '', fromId = '' }, config = defaultConfig, fetchImpl = fetch, attempt = 0) {
  if (!config.pageAccessToken) throw new Error('Chưa có PANCAKE_PAGE_ACCESS_TOKEN.');
  if (!conversationId) throw new Error('Hội thoại này chưa có mã Pancake để gửi.');
  if (!text && !contentIds.length) throw new Error('Tin nhắn trống.');
  if (action !== 'reply_inbox' && !commentId) throw new Error('Chưa có bình luận nào của khách để trả lời.');
  const url = `${apiRoot(config)}/v1/pages/${encodeURIComponent(pageId)}/conversations/${encodeURIComponent(conversationId)}/messages?page_access_token=${encodeURIComponent(config.pageAccessToken)}`;
  const content = contentIds.length ? { content_ids: contentIds } : { message: text };
  const payload = action === 'reply_comment'
    ? { action, message_id: commentId, ...content }
    : action === 'private_replies'
      ? { action, post_id: postId, message_id: commentId, from_id: fromId, ...content }
      : { action: 'reply_inbox', ...content };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal
    });
    let body = {};
    try { body = await response.json(); } catch {}
    // Quá 5 lần gọi/giây: nghỉ rồi gửi lại (tối đa 3 lần).
    if (response.status === 429 && attempt < 3) {
      clearTimeout(timer);
      await pause(1500 * (attempt + 1));
      return sendPancakeMessage({ pageId, conversationId, text, contentIds, action, commentId, postId, fromId }, config, fetchImpl, attempt + 1);
    }
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
export async function uploadPancakeContent({ pageId, buffer, filename = 'anh.jpg', mime = 'application/octet-stream' }, config = defaultConfig, fetchImpl = fetch, attempt = 0) {
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
    // Quá 5 lần gọi/giây: nghỉ rồi tải lại (tối đa 3 lần).
    if (response.status === 429 && attempt < 3) {
      clearTimeout(timer);
      await pause(1500 * (attempt + 1));
      return uploadPancakeContent({ pageId, buffer, filename, mime }, config, fetchImpl, attempt + 1);
    }
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

// Mỗi lần gửi tải ảnh lên mới: mã nội dung dùng lại bị Facebook từ chối
// ("invalid_upload_fb_attachments_result"), nên không giữ mã trong bộ nhớ.
// Ảnh sản phẩm đã nén còn ~130 KB, tải lên mất dưới một giây.
async function pancakeContentIdForImage(pageId, imageUrl, config, fetchImpl) {
  const file = await fitImageForPancake(await readImageForUpload(imageUrl, fetchImpl));
  const { id } = await uploadPancakeContent({ pageId, ...file }, config, fetchImpl);
  return { id };
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
export async function sendConversationMessageViaPancake(conversation, { text = '', templateText = '', attachment = null, imageUrl = '', imageUrls = [], privateReply = false }, config = defaultConfig, fetchImpl = fetch) {
  const body = String(templateText || text || '').trim();
  const target = { pageId: conversation.pageId, conversationId: conversation.pancakeConversationId };
  // Nhiều ảnh đi chung một tin (Facebook nhận tới 30 mã một lần), khách thấy một cụm ảnh thay vì từng ảnh lắc nhắc.
  const pictures = [...new Set([imageUrl, ...(Array.isArray(imageUrls) ? imageUrls : [])].map(item => String(item || '').trim()).filter(Boolean))].slice(0, 30);
  if (!body && !attachment && !pictures.length) throw Object.assign(new Error('Tin nhắn trống.'), { statusCode: 400 });
  if (conversation.source === 'comment') return sendCommentReplyViaPancake(conversation, { text: body, privateReply }, config, fetchImpl);
  let message;
  const extraMessages = [];
  if (pictures.length) {
    // Tải tuần tự, nghỉ giữa các ảnh: Pancake giới hạn 5 lần gọi mỗi giây mỗi Page.
    const upload = async () => {
      const ids = [];
      for (const [index, url] of pictures.entries()) {
        if (index) await pause(250);
        ids.push((await pancakeContentIdForImage(target.pageId, url, config, fetchImpl)).id);
      }
      return ids;
    };
    let sent;
    try {
      sent = await sendPancakeMessage({ ...target, contentIds: await upload() }, config, fetchImpl);
    } catch (error) {
      // Facebook thỉnh thoảng từ chối tệp vừa tải (invalid_upload_fb_attachments_result): tải lại và gửi thêm một lần.
      if (!/invalid_upload|không nhận tin/.test(error.message)) throw error;
      sent = await sendPancakeMessage({ ...target, contentIds: await upload() }, config, fetchImpl);
    }
    const at = Date.now();
    // Mỗi ảnh một bong bóng trong hộp thư; ảnh đầu mang mã tin của Pancake để bản dội lại gộp vào.
    pictures.forEach((url, index) => {
      const id = index ? `${sent.id}#${index}` : sent.id;
      const record = { id, mid: id, direction: 'outgoing', type: 'image', text: '', name: 'anh-san-pham', dataUrl: url, createdAt: at + index, status: 'sent' };
      if (index) extraMessages.push(record); else message = record;
    });
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
    const extras = extraMessages.map(extra => saveMessage(store, { pageId: conversation.pageId, psid: conversation.psid, message: extra }).message);
    outcome.conversation.unread = false;
    return { message: outcome.message, extras, conversation: publicConversation(outcome.conversation) };
  });
  publishMessagingEvent({ type: 'message', conversation: saved.conversation, message: saved.message });
  for (const extra of saved.extras) publishMessagingEvent({ type: 'message', conversation: saved.conversation, message: extra });
  return saved;
}

/**
 * Trả lời một luồng bình luận qua Pancake, cùng cách ghi như sendCommentReply
 * của Meta: trả lời công khai (`reply_comment`) ghi vào luồng bình luận và
 * đăng ký mã để bản dội lại gộp chung; nhắn riêng (`private_replies`) là tin
 * Messenger nên ghi vào hộp thư của khách (mở nếu chưa có), hộp thư đó kế
 * thừa bài viết và mang mã hội thoại inbox của Pancake ({page}_{psid}) để
 * các tin sau đi thẳng. Chỉ gửi được chữ (như Meta).
 */
async function sendCommentReplyViaPancake(conversation, { text, privateReply }, config, fetchImpl) {
  if (!text) throw Object.assign(new Error('Bình luận chỉ trả lời được bằng chữ.'), { statusCode: 400 });
  if (!conversation.lastCommentId) throw Object.assign(new Error('Chưa có bình luận nào của khách để trả lời.'), { statusCode: 400 });
  const sent = await sendPancakeMessage({
    pageId: conversation.pageId,
    conversationId: conversation.pancakeConversationId,
    text,
    action: privateReply ? 'private_replies' : 'reply_comment',
    commentId: conversation.lastCommentId,
    postId: conversation.post?.id || '',
    fromId: conversation.psid
  }, config, fetchImpl);
  const message = {
    id: sent.id, mid: sent.id, direction: 'outgoing', type: 'text', text, createdAt: Date.now(), status: 'sent',
    ...(privateReply ? { privateReply: true } : { commentId: sent.id, parentId: conversation.lastCommentId })
  };
  const saved = await updateMessagingStore(store => {
    const outcome = privateReply
      ? saveMessage(store, { pageId: conversation.pageId, psid: conversation.psid, name: conversation.name, picture: conversation.picture, message })
      : saveMessage(store, { pageId: conversation.pageId, psid: conversation.psid, id: conversation.id, source: 'comment', message });
    if (privateReply) {
      if (!outcome.conversation.post && conversation.post) outcome.conversation.post = { ...conversation.post, inheritedFrom: conversation.id };
      if (!outcome.conversation.pancakeConversationId) outcome.conversation.pancakeConversationId = `${conversation.pageId}_${conversation.psid}`;
    } else {
      outcome.conversation.unread = false;
      store.commentIndex[sent.id] = conversation.id;
    }
    return { message: outcome.message, conversation: publicConversation(outcome.conversation) };
  });
  publishMessagingEvent({ type: 'message', conversation: saved.conversation, message: saved.message });
  return saved;
}

// ===== Bối cảnh quảng cáo =====
//
// Pancake chỉ cho ad_id và post_id của bài quảng cáo. Tên quảng cáo (thường
// mang tên sản phẩm) tra qua GET /ads; nội dung bài quảng cáo thì Pancake
// không có API đọc theo id, chỉ có danh sách bài theo khoảng thời gian, nên
// bài được tìm lùi dần theo tháng và nhớ lại. Cả hai đổ vào conversation.referral
// (adTitle) và conversation.post (message) — đúng chỗ resolveConversationProduct đọc.
const adCache = new Map();
const postCache = new Map();
const adCacheTtlMs = 24 * 60 * 60 * 1000;
const postMissTtlMs = 6 * 60 * 60 * 1000;

/** Tên/ảnh/chiến dịch của các quảng cáo (tối đa 20 mã một lần), nhớ 24 giờ. */
export async function fetchPancakeAds(adIds, config = defaultConfig, fetchImpl = fetch) {
  const wanted = [...new Set(adIds.map(String).filter(Boolean))].slice(0, 20);
  const missing = wanted.filter(id => !(adCache.has(id) && Date.now() - adCache.get(id).at < adCacheTtlMs));
  if (missing.length) {
    const body = await pancakeGet(`/v1/pages/${encodeURIComponent(config.pageId)}/ads`, { ad_ids: missing.join(','), type: 'ads' }, config, fetchImpl);
    for (const item of Array.isArray(body.data) ? body.data : []) {
      adCache.set(String(item.id), { at: Date.now(), name: String(item.name || '').trim(), imageUrl: String(item.image_url || ''), campaignName: String(item.campaign_name || '').trim() });
    }
    for (const id of missing) if (!adCache.has(id)) adCache.set(id, { at: Date.now(), name: '', imageUrl: '', campaignName: '' });
  }
  return Object.fromEntries(wanted.map(id => [id, adCache.get(id)]));
}

/** Bài viết theo id: quét danh sách bài lùi dần từng tháng (tối đa `months`), nhớ kết quả kể cả không thấy. */
export async function findPancakePost(postId, { months = 12 } = {}, config = defaultConfig, fetchImpl = fetch) {
  const id = String(postId || '');
  if (!id) return null;
  const cached = postCache.get(id);
  if (cached && (cached.post || Date.now() - cached.at < postMissTtlMs)) return cached.post;
  const monthSeconds = 30 * 24 * 60 * 60;
  let until = Math.floor(Date.now() / 1000);
  let found = null;
  for (let month = 0; month < months && !found; month += 1) {
    const since = until - monthSeconds;
    for (let pageNumber = 1; pageNumber <= 3 && !found; pageNumber += 1) {
      // Quét lùi nhiều trang: giãn ra để không chạm giới hạn 5 lần/giây của Pancake.
      if (month || pageNumber > 1) await pause(350);
      const body = await pancakeGet(`/v1/pages/${encodeURIComponent(config.pageId)}/posts`, { since, until, page_number: pageNumber, page_size: 30 }, config, fetchImpl);
      const posts = Array.isArray(body.data) ? body.data : Array.isArray(body.posts) ? body.posts : [];
      found = posts.find(post => String(post?.id) === id) || null;
      for (const post of posts) if (post?.id && !postCache.get(String(post.id))?.post) postCache.set(String(post.id), { at: Date.now(), post: pancakePostContext(post) });
      if (posts.length < 30) break;
    }
    until = since;
  }
  postCache.set(id, { at: Date.now(), post: found ? pancakePostContext(found) : null });
  return postCache.get(id).post;
}

/**
 * Điền tên quảng cáo và nội dung bài quảng cáo cho các hội thoại vừa có
 * referral từ Pancake. Tên quảng cáo tra ngay (một lần gọi, nhanh); bài viết
 * tìm nền (có thể nhiều lần gọi), tin sau của khách sẽ có. Lỗi bỏ qua.
 */
const needsAdContext = conversation => Boolean(conversation?.referral?.adId)
  && (!conversation.referral.adTitle || (Boolean(conversation.referral.postId) && !conversation.post?.message));

export async function enrichPancakeAdContext(changes, config = defaultConfig, fetchImpl = fetch) {
  const pending = [...new Map(changes
    .map(change => change.conversation || change)
    .filter(needsAdContext)
    .map(conversation => [conversation.id, conversation])).values()];
  if (!pending.length) return 0;
  let ads = {};
  try {
    ads = await fetchPancakeAds(pending.map(item => item.referral.adId), config, fetchImpl);
  } catch {
    ads = {};
  }
  await updateMessagingStore(store => {
    for (const item of pending) {
      const conversation = store.conversations.find(entry => entry.id === item.id);
      const ad = ads[item.referral?.adId];
      if (!conversation?.referral || !ad?.name || conversation.referral.adTitle) continue;
      // Tên quảng cáo hay là mã nội bộ ("gn ht 2705"); tên chiến dịch ("mess Xanh") nói rõ sản phẩm hơn, ghép vào để bot đọc.
      const adTitle = ad.campaignName && !ad.name.includes(ad.campaignName) ? `${ad.name} · ${ad.campaignName}` : ad.name;
      conversation.referral = { ...conversation.referral, adTitle, photoUrl: conversation.referral.photoUrl || ad.imageUrl };
      publishMessagingEvent({ type: 'conversation', conversation: publicConversation(conversation) });
    }
    return null;
  });
  for (const item of pending) {
    if (!item.referral?.postId || item.post?.message) continue;
    findPancakePost(item.referral.postId, {}, config, fetchImpl).then(post => post && updateMessagingStore(store => {
      const conversation = store.conversations.find(entry => entry.id === item.id);
      if (conversation && !conversation.post?.message) {
        conversation.post = { ...(conversation.post || {}), ...post };
        publishMessagingEvent({ type: 'conversation', conversation: publicConversation(conversation) });
      }
      return null;
    })).catch(() => {});
  }
  return pending.length;
}

/**
 * Một webhook Pancake từ đầu tới cuối: chuẩn hoá, ghi hộp thư, điền bối cảnh
 * quảng cáo, đưa cho bot. Hội thoại đã có nhân viên nhận thì chỉ ghi, không
 * đưa bot (trừ khi cấu hình PANCAKE_BOT_WHEN_ASSIGNED=1). Trả về số tin đã
 * ghi và số tin đưa bot.
 */
export async function handlePancakeWebhook(payload, { processChatbotChanges, chatbotDependencies, config = defaultConfig, now = Date.now(), fetchImpl = fetch }) {
  const events = normalizePancakeWebhook(payload, config, now);
  const changes = await storePancakeEvents(events, { fromWebhook: true });
  if (changes.length) await enrichPancakeAdContext(changes, config, fetchImpl);
  const assigned = new Set(events.filter(event => event.pancake.assigned).map(event => `${event.pageId}:${event.psid}`));
  const forBot = config.botWhenAssigned
    ? changes
    : changes.filter(change => !change.conversation || !assigned.has(`${change.conversation.pageId}:${change.conversation.psid}`));
  if (forBot.length && processChatbotChanges) await processChatbotChanges(forBot, chatbotDependencies);
  return { stored: changes.length, bot: forBot.length };
}
