// Pancake (pages.fm): Page vận hành trong Pancake, nhân viên xem và trả lời ở
// đó; CRM chỉ theo dõi. Pancake bắn webhook `messaging` về đây khi khách nhắn,
// tin được ghi vào hộp thư CRM (để theo dõi) rồi đưa cho bot; câu trả lời của
// bot gửi ngược qua Public API của Pancake nên hiện ngay trong Pancake cho
// nhân viên thấy. Tài liệu: integrations/pancake/README.md.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { metaConfig, pancakeConfig as defaultConfig, projectRoot } from './config.mjs';
import { applyWebhookEvents } from './meta-webhook.mjs';
import { qrCodeFromText } from './qr-bridge.mjs';
import { isKnownQrCode } from './qr-scans.mjs';
import { applyGenderGuess, conversationId as crmConversationId, flushMessagingStore, publicConversation, readMessagingStore, reconcileCustomerGender, saveMessage, messageSenderFields, updateMessagingStore } from './messaging-store.mjs';
import { matchesFollowUpText, recentFollowUpTexts } from './follow-up.mjs';
import { genderFromMessage, genderFromName } from './processing/customer-info.mjs';
import { publishMessagingEvent } from './message-events.mjs';
import { assertPublicHost } from './network-guard.mjs';
import { AUTOMATED_ACTORS, appendAssignAudit, appendBotToggleAudit } from './audit-log.mjs';
import { backoffPancake, withPancakeSlot } from './pancake-rate-limit.mjs';
import { stickerFields } from './stickers.mjs';
export { stickerInfo, LIKE_STICKER_IDS } from './stickers.mjs';

// Đủ cấu hình khi có ít nhất một Page (mã + token API) và một token webhook: token chung
// PANCAKE_WEBHOOK_TOKEN HAY token riêng của từng Page trong PANCAKE_PAGES (webhookToken).
export function isPancakeConfigured(config = defaultConfig) {
  const pages = config.pages?.length ? config.pages : (config.pageId && config.pageAccessToken ? [config] : []);
  return pages.length > 0 && (Boolean(config.webhookToken) || pages.some(page => Boolean(String(page?.webhookToken || '').trim())));
}

export function getPancakePageConfig(pageId, config = defaultConfig) {
  const pages = config.pages || [];
  const found = pages.find(p => String(p.pageId) === String(pageId));
  if (found) {
    return {
      ...config,
      pageId: found.pageId,
      pageName: found.pageName,
      pageAccessToken: found.pageAccessToken
    };
  }
  return config;
}

/** Token trong URL webhook: so sánh theo thời gian hằng; token trống nghĩa là chưa bật (dùng chung với webhook landing). */
export { isLandingTokenValid as isPancakeWebhookTokenValid } from './landing-orders.mjs';

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
/**
 * Chẩn đoán (bật bằng PANCAKE_DEBUG_KEYS=1): mô tả CẤU TRÚC gói tin Pancake gửi
 * tới — đường dẫn khoá tới độ sâu 4, và giá trị (cắt ngắn) của khoá nào có tên
 * gợi nguồn vào (ref, referral, source, utm, link…). Không ghi nội dung tin
 * nhắn hay tên khách. Dùng để trả lời câu "Pancake có chuyển ref của m.me không".
 */
export function describePancakePayload(payload, { maxDepth = 4 } = {}) {
  const paths = [];
  const hints = [];
  const interesting = /ref|referral|source|origin|utm|link|entry|start|postback|payload/i;
  const walk = (value, path, depth) => {
    if (depth > maxDepth || value === null || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) {
      const here = path ? `${path}.${key}` : key;
      paths.push(here);
      if (interesting.test(key) && (child === null || typeof child !== 'object')) hints.push(`${here}=${String(child).slice(0, 80)}`);
      if (Array.isArray(child)) {
        if (child.length && typeof child[0] === 'object') walk(child[0], `${here}[0]`, depth + 1);
      } else walk(child, here, depth + 1);
    }
  };
  walk(payload, '', 0);
  return `Webhook Pancake (chẩn đoán): event=${payload?.event_type || '-'} khoá=[${paths.join(', ')}]${hints.length ? ` gợi nguồn: ${hints.join(' | ')}` : ' (không có khoá nào tên ref/referral/source)'}`;
}

export function normalizePancakeWebhook(payload, config = defaultConfig, now = Date.now()) {
  if (!payload || payload.event_type !== 'messaging') return [];
  const pageId = String(payload.page_id || '');
  const pages = config.pages?.length ? config.pages : (config.pageId ? [config] : []);
  if (!pageId || (pages.length && !pages.some(p => String(p.pageId) === pageId))) return [];
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

// Tên admin Pancake ghi cho tin do máy gửi (không phải người gõ): CRM qua Public API, thẻ đơn của
// POS, Botcake / bot Pancake (lời chào QR "Mã thẻ: #…"), chatbot. So không phân biệt hoa thường.
const automatedAdminNames = new Set(['public api', 'pos', 'botcake', 'pancake bot', 'chatbot']);
// Lời chào QR do Botcake gửi (kết thúc bằng "Mã thẻ: #<mã>"): máy gửi, dù Pancake ghi tên ai.
const qrGreetingPattern = /Mã thẻ:\s*#\S+/iu;

/** Tin của Page có admin_name là nhân viên thật (không phải máy gửi, không phải lời chào QR)? */
export function isStaffAdmin(adminName, text = '') {
  const name = String(adminName || '').trim();
  if (!name || automatedAdminNames.has(name.toLowerCase())) return false;
  return !qrGreetingPattern.test(String(text || ''));
}

/** Giới tính khách trong hồ sơ Pancake (`page_customer.gender`, Facebook khai): male/female, khác thì bỏ. */
export function pancakeGenderOf(conversation) {
  const value = String(conversation?.page_customer?.gender || conversation?.gender || '').trim().toLowerCase();
  return value === 'male' || value === 'nam' ? 'male' : value === 'female' || value === 'nữ' || value === 'nu' ? 'female' : '';
}

/** Quảng cáo đưa khách tới hội thoại: Pancake chỉ cho ad_id và post_id của bài quảng cáo (tên tra riêng qua GET /ads). */
/**
 * Người được phân công hội thoại trong Pancake: tên (current_assign_users), thiếu tên thì mã.
 * null khi gói không có assignee_ids (không biết), để nhật ký không ghi nhầm là "bỏ phân công".
 */
export function pancakeAssigneesOf(conversation = {}) {
  if (!Array.isArray(conversation?.assignee_ids)) return null;
  const names = new Map((Array.isArray(conversation.current_assign_users) ? conversation.current_assign_users : []).map(user => [String(user?.id || ''), String(user?.name || '').trim()]));
  return conversation.assignee_ids.map(id => names.get(String(id)) || String(id)).filter(Boolean).sort();
}

function pancakeAdOf(conversation) {
  const ads = Array.isArray(conversation?.ads) ? conversation.ads : [];
  const latest = ads.at(-1);
  const adId = String(latest?.ad_id || (Array.isArray(conversation?.ad_ids) ? conversation.ad_ids.at(-1) : '') || '');
  // `inserted_at` của mục quảng cáo = lúc khách bấm (mốc cho báo cáo chiến dịch); không có thì 0 (dùng giờ tin).
  const at = latest?.inserted_at ? pancakeTime(latest.inserted_at, 0) : 0;
  return adId ? { adId, postId: String(latest?.post_id || ''), ...(at ? { at } : {}) } : null;
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
      // Tên người được phân công (current_assign_users); null khi gói không kèm danh sách phân công.
      assignees: pancakeAssigneesOf(conversation),
      staff: isStaffAdmin(adminName, pancakeMessageText(comment)),
      staffName: adminName,
      post: pancakePostContext(post) || { id: postId, message: '', permalink: `https://www.facebook.com/${postId}`, picture: '' },
      ad: null,
      gender: pancakeGenderOf(conversation)
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
  // Khách của hội thoại: `from` của hội thoại, không có thì đọc từ mã hội thoại
  // Pancake ("{page}_{psid}") — để tin do Page/nhân viên gửi vẫn xếp đúng khách.
  const conversationKey = String(conversation.id || '');
  const psidFromKey = conversationKey.startsWith(`${pageId}_`) ? conversationKey.slice(String(pageId).length + 1) : '';
  const customerId = String(conversation.from?.id || psidFromKey || (fromId !== pageId ? fromId : ''));
  if (!fromId || !customerId) return null;
  const outgoing = fromId === pageId || fromId !== customerId;
  const text = pancakeMessageText(message);
  const attachments = Array.isArray(message.attachments) ? message.attachments : [];
  // Rác của Facebook Shop khi khách bấm "Gửi tin nhắn"/"Mua": một tin trống của
  // khách (không chữ, không đính kèm) và một tin của Page chỉ có đính kèm
  // {type:'attachment', name:'Gửi tin nhắn'} không URL; thẻ template trống
  // (khách chia sẻ thẻ Shop) và cảm xúc (reaction) không kèm chữ. Bỏ, không ghi hộp thư.
  const hasContent = item => item?.url || item?.payload || item?.order || item?.post_attachments || item?.full_address || item?.address;
  if (!text && (!attachments.length || attachments.every(item => ['attachment', 'fallback', 'template', 'reaction'].includes(String(item?.type || '').toLowerCase()) && !hasContent(item)))) return null;
  // Ảnh/video Pancake đưa kèm URL trên CDN của họ: hộp thư hiện thẳng. Loại
  // khác (tệp, âm thanh) chỉ ghi là có đính kèm.
  const kindOf = item => String(item?.type || '').toLowerCase();
  // Khách gửi một lúc nhiều ảnh: giữ đủ danh sách (`images`) để hộp thư vẽ lưới ảnh.
  const photos = attachments.filter(item => ['photo', 'image', 'sticker'].includes(kindOf(item)) && item?.url).map(item => String(item.url));
  // Khách "Trả lời" một tin cụ thể (Messenger reply): Pancake kèm attachment
  // replied_message (mã, chữ, người gửi của tin gốc). Ghi thành replyTo để hộp
  // thư vẽ phần trích dẫn và bot hiểu "." hay "Ok" đang nói về tin nào.
  const quoted = attachments.find(item => kindOf(item) === 'replied_message');
  const replyTo = quoted
    ? {
        id: String(quoted.id || ''),
        name: String(quoted.from?.id || '') === String(pageId) ? 'Bạn' : String(quoted.from?.name || conversation.from?.name || 'khách').trim(),
        text: pancakeMessageText({ message: quoted.message }) || (Array.isArray(quoted.attachments) && quoted.attachments.length ? '[Ảnh/tệp]' : 'tin nhắn')
      }
    : null;
  // Nhãn dán (sticker, kể cả nút 👍): vẫn vẽ như ảnh, nhưng tin mang cờ sticker/like để bot không
  // trả lời "em đã nhận được hình".
  const stickerAttachment = attachments.find(item => kindOf(item) === 'sticker' || /\/stickers\//.test(String(item?.url || '')));
  const sticker = stickerAttachment ? stickerFields({ ...stickerAttachment, sticker: true }) : {};
  const video = !photos.length && attachments.find(item => kindOf(item) === 'video' && item?.url);
  const media = photos.length
    ? { type: 'image', dataUrl: photos[0], ...(photos.length > 1 ? { images: photos } : {}) }
    : video ? { type: 'video', dataUrl: String(video.url) } : null;
  // Thẻ xác nhận đơn (receipt) do Pancake POS gửi khách khi CRM đẩy đơn sang:
  // hộp thư đã vẽ đơn đó thành thẻ đơn, tin này chỉ ghi dấu như receipt của Meta.
  const receipt = !media && attachments.some(item => kindOf(item) === 'template' && String(item?.payload?.template_type || '').toLowerCase() === 'receipt');
  // Khách bấm "Mua"/"Gửi giỏ hàng" ở Facebook Shop của Page: Pancake gửi tin
  // `m_send_cart:…` với attachment `cart_order` (tên, mã SKU, giá, số lượng có
  // thể bằng 0). Ghi thành chữ để hộp thư đọc được và bot biết khách chọn gì.
  const cart = attachments
    .filter(item => kindOf(item) === 'cart_order')
    .flatMap(item => Array.isArray(item?.order?.items) ? item.order.items : [])
    .map(item => {
      const info = item?.variation_info || {};
      return {
        name: String(info.name || '').trim(),
        sku: String(info.retailer_id || info.sku || '').trim(),
        quantity: Number(item?.quantity) || 0,
        price: Number(info.retail_price) || 0,
        image: Array.isArray(info.images) && info.images[0] ? String(info.images[0]) : ''
      };
    })
    .filter(item => item.name || item.sku);
  const cartText = cart.length
    ? `Khách chọn mua từ Facebook Shop: ${cart.map(item => `${item.name || item.sku}${item.sku && item.name ? ` (${item.sku})` : ''}${item.quantity ? ` × ${item.quantity}` : ''}${item.price ? ` — ${item.price.toLocaleString('vi-VN')}đ` : ''}`).join('; ')}`
    : '';
  // Khách bấm vào quảng cáo: Pancake ghi một "tin" ad_click không chữ, kèm mã
  // quảng cáo, nội dung và ảnh bài. Hộp thư vẽ thành dòng hệ thống; referral
  // lấy luôn tên và ảnh bài để bot biết khách đang quan tâm sản phẩm nào.
  const adClick = attachments.find(item => kindOf(item) === 'ad_click');
  const adPost = adClick?.post_attachments?.[0] || {};
  const adTitle = String(adPost.description || adPost.title || '').split('\n')[0].trim().slice(0, 120);
  const adInfo = adClick
    ? { adId: String(adClick.ad_id || ''), postId: String(adClick.url || '').split('/').filter(Boolean).pop() || '', adTitle, photoUrl: String(adPost.url || '') }
    : null;
  const adText = adClick ? `Khách bấm vào quảng cáo${adTitle ? `: «${adTitle}»` : ''}` : '';
  // Khách chia sẻ thẻ địa chỉ của Messenger (không gõ chữ): lấy địa chỉ đầy đủ làm nội dung.
  const addressCard = attachments.find(item => kindOf(item) === 'address');
  const addressText = addressCard ? String(addressCard.full_address || addressCard.address || '').trim() : '';
  const identifier = String(message.id || `pancake-${now}`);
  const at = pancakeTime(message.inserted_at, now);
  // Tin của Page: gửi từ CRM thì Pancake ghi người gửi là "Public API"; tên
  // khác là nhân viên gõ trong Pancake.
  const adminName = outgoing ? String(message.from?.admin_name || '').trim() : '';
  // Khách quét QR thẻ cảm ơn, hai dấu hiệu về cùng qua webhook Pancake:
  //  - tin của Page do Botcake tự gửi khi khách mở m.me?ref=<mã> (kết thúc
  //    bằng "Mã thẻ: #<mã>") → khách đã được chào, CRM chỉ ghi nhận;
  //  - tin khách gửi từ tin soạn sẵn mang `#<mã>` (đường dự phòng).
  // Cả hai ghi như referral SHORTLINK của Meta để thống kê QR, nhãn nguồn và
  // lượt chào dùng chung một đường; `type` cho biết ai đã chào.
  // Chỉ mã đã tạo ở Cài đặt → Mã QR: "#123456" cuối tin khách (số đơn) không phải mã thẻ.
  const foundCode = qrCodeFromText(text, { outgoing });
  const qrCode = foundCode && isKnownQrCode(foundCode) ? foundCode : '';
  const referral = qrCode ? { ref: qrCode, source: 'SHORTLINK', type: outgoing ? 'BOTCAKE_OPTIN' : 'PREFILL_TEXT' } : null;
  // "POS" là thẻ xác nhận đơn do Pancake POS tự gửi, không phải người gõ: không
  // được coi là nhân viên (trước đây bot bị tắt ngay sau mỗi đơn đẩy POS).
  return {
    pageId,
    psid: customerId,
    timestamp: at,
    type: 'message',
    ...(referral ? { referral } : {}),
    message: {
      id: identifier,
      mid: identifier,
      direction: outgoing ? 'outgoing' : 'incoming',
      type: media ? media.type : receipt ? 'order-receipt' : adClick ? 'ad' : text || cartText || addressText || !attachments.length ? 'text' : 'attachment',
      text: receipt ? 'Đã gửi xác nhận đơn hàng' : adClick ? adText : text || cartText || addressText || (attachments.length && !media ? '[Tệp đính kèm]' : ''),
      ...(media ? { dataUrl: media.dataUrl, name: '', ...(media.images ? { images: media.images } : {}) } : {}),
      ...sticker,
      ...(cart.length ? { cart } : {}),
      ...(replyTo ? { replyTo } : {}),
      // Nhân viên gõ trong Pancake: dấu trên tin để đường đồng bộ (không qua webhook) cũng biết mà nhường.
      // (Tin trùng lời bám đuổi trạm gửi đã gửi dưới tên nhân viên: storePancakeEvents gỡ cờ này, gắn followUp.)
      ...(outgoing && isStaffAdmin(adminName, text) ? { staff: true, staffName: adminName } : {}),
      createdAt: at,
      status: outgoing ? 'sent' : 'received'
    },
    pancake: {
      conversationId: String(conversation.id || message.conversation_id || ''),
      customerName: String(conversation.from?.name || (outgoing ? '' : message.from?.name) || '').trim(),
      pageCustomerId: String(message.from?.page_customer_id || ''),
      // Hội thoại đã có nhân viên nhận thì bot đứng ngoài (trừ khi cấu hình cho phép).
      assigned: Array.isArray(conversation.assignee_ids) && conversation.assignee_ids.length > 0,
      // Tên người được phân công (current_assign_users); null khi gói không kèm danh sách phân công.
      assignees: pancakeAssigneesOf(conversation),
      staff: outgoing && isStaffAdmin(adminName, text),
      staffName: adminName,
      // Khách đến từ quảng cáo: ghi như referral của Meta để bot biết sản phẩm.
      ad: adInfo || pancakeAdOf(conversation),
      gender: pancakeGenderOf(conversation)
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

/**
 * Một lần gọi Pancake qua hàng đợi giới hạn tốc độ của Page (pancake-rate-limit.mjs): đồng hồ
 * hủy (`timeoutMs`) chỉ chạy từ lúc thật sự gọi, không tính thời gian xếp hàng. Trả { response, body }.
 */
function pancakeFetch(pageId, url, init, fetchImpl, timeoutMs) {
  return withPancakeSlot(pageId, async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(url, { ...init, signal: controller.signal });
      let body = {};
      try { body = await response.json(); } catch {}
      return { response, body };
    } finally {
      clearTimeout(timer);
    }
  });
}

// Pancake giới hạn 5 lần gọi mỗi giây cho mỗi Page; quá thì trả 429 "Too many
// requests". Gặp 429 thì cả Page lùi lại rồi gọi lại (tối đa 3 lần).
async function pancakeGet(pathname, params, config, fetchImpl, attempt = 0) {
  const url = new URL(`${config.apiBase.replace(/\/+$/, '')}${pathname}`);
  url.searchParams.set('page_access_token', config.pageAccessToken);
  for (const [key, value] of Object.entries(params)) if (value !== undefined && value !== '') url.searchParams.set(key, String(value));
  const { response, body } = await pancakeFetch(config.pageId, url, {}, fetchImpl, 20000);
  if (response.status === 429 && attempt < 3) {
    backoffPancake(config.pageId, 1500 * (attempt + 1));
    return pancakeGet(pathname, params, config, fetchImpl, attempt + 1);
  }
  if (!response.ok || body.success === false) throw new Error(`Pancake trả về ${response.status}: ${body.message || body.error || 'không rõ lý do'}`);
  return body;
}

/** Hội thoại mới nhất của Page theo loại (INBOX hay COMMENT), nhiều nhất `limit`, lùi dần bằng last_conversation_id. */
export async function fetchPancakeConversations({ limit = 60, type = 'INBOX' } = {}, config = defaultConfig, fetchImpl = fetch) {
  const conversations = [];
  let lastConversationId = '';
  while (conversations.length < limit) {
    const body = await pancakeGet(`/v2/pages/${encodeURIComponent(config.pageId)}/conversations`, { type, order_by: 'updated_at', last_conversation_id: lastConversationId }, config, fetchImpl);
    const page = Array.isArray(body.conversations) ? body.conversations : [];
    const batch = page.filter(item => String(item?.type || 'INBOX').toUpperCase() === type);
    if (!page.length) break;
    conversations.push(...batch);
    // Lật trang theo dòng cuối của TRANG (kể cả dòng khác loại), hết trang khi trang ngắn.
    const last = page.at(-1)?.id;
    if (!last || last === lastConversationId) break;
    lastConversationId = last;
    if (page.length < 30) break;
  }
  return conversations.slice(0, limit);
}

/**
 * Thông tin khách của một hội thoại hộp thư: ID Facebook toàn cục (extension
 * Pancake cần nó để gửi tin ngoài 24 giờ), số đơn Pancake/POS gần đây và khách
 * còn nhận tin được không.
 */
export async function fetchPancakeConversationInfo(pageId, conversationId, config = defaultConfig, fetchImpl = fetch) {
  const pageConfig = getPancakePageConfig(pageId, config);
  const body = await pancakeGet(`/v1/pages/${encodeURIComponent(pageId)}/conversations/${encodeURIComponent(conversationId)}/messages`, {}, pageConfig, fetchImpl);
  const customers = Array.isArray(body.customers) ? body.customers : [];
  const customer = customers[0] || null;
  const phoneOf = value => String(typeof value === 'string' ? value : value?.phone_number || value?.captured || '').replace(/\D/g, '');
  return {
    globalId: String(body.global_id || customer?.global_id || ''),
    recentOrders: Array.isArray(body.recent_orders) ? body.recent_orders.length : 0,
    canInbox: body.can_inbox !== false && customer?.can_inbox !== false,
    name: String(customer?.name || ''),
    // Hồ sơ khách Pancake (liên kết POS): khách cũ nhận ra được cả khi chưa để lại SĐT.
    orderCount: Math.max(0, ...customers.map(item => Number(item.order_count) || 0)),
    succeedOrderCount: Math.max(0, ...customers.map(item => Number(item.succeed_order_count) || 0)),
    purchasedAmount: Math.max(0, ...customers.map(item => Number(item.purchased_amount) || 0)),
    lastOrderAt: customers.map(item => String(item.last_order_at || '')).find(Boolean) || '',
    tags: customers.flatMap(item => (Array.isArray(item.tags) ? item.tags : []).map(tag => String(tag?.name ?? tag))),
    phones: [...new Set([...(body.recent_phone_numbers || []), ...(body.conv_phone_numbers || []), ...customers.flatMap(item => item.recent_phone_numbers || [])].map(phoneOf).filter(phone => phone.length >= 9))]
  };
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
let activeSync = null;
export function syncPancakeConversations(options = {}, config = defaultConfig, fetchImpl = fetch) {
  // Vòng 10 phút và nút Đồng bộ trong CRM dùng chung một lượt đang chạy, không
  // chạy chồng (mỗi lượt là hàng trăm lần gọi Pancake trong hạn 5 lần/giây).
  if (activeSync) return activeSync;
  activeSync = runPancakeSync(options, config, fetchImpl).finally(() => { activeSync = null; });
  return activeSync;
}

/**
 * Tin khách vừa ghi qua đồng bộ mà webhook không đưa tới (Pancake tạm ngưng webhook khi gặp lỗi
 * liên tiếp, dịch vụ khởi động lại…): tin đến trong `windowMs`, bot còn bật, Page chưa trả lời
 * sau tin đó → đưa bot như một webhook muộn. Tin cũ hơn hay đã có người trả lời thì thôi.
 */
/** Tin Page gần nhất đứng trước mốc `at`. */
function lastOutgoingBefore(messages, at) {
  let found = null;
  for (const item of messages || []) if (item?.direction === 'outgoing' && (Number(item.createdAt) || 0) < at) found = item;
  return found;
}

// Tin Page gần nhất trước tin khách là của nhân viên: chỉ chặn bot khi tin đó trong 2 giờ (cùng quy
// tắc đường webhook — chatbot-engine staffAfterBot). Nhân viên nhắn từ hôm qua thì khách nhắn lại
// hôm nay vẫn được bot trả lời, không chặn vĩnh viễn.
const staffBlockMs = 2 * 60 * 60 * 1000;
const recentStaffBefore = (messages, at, now) => {
  const last = lastOutgoingBefore(messages, at);
  return Boolean(last?.staff) && now - (Number(last.createdAt) || 0) < staffBlockMs;
};

/** Nhân viên vừa nhắn trong hội thoại (60 phút): bot đứng ngoài, kể cả khi tin nhân viên về qua đồng bộ. */
export function staffRepliedRecently(messages, now = Date.now()) {
  return (messages || []).some(item => item?.direction === 'outgoing' && item.staff && now - (Number(item.createdAt) || 0) < 60 * 60 * 1000);
}

export function missedBotChanges(changes, store, { now = Date.now(), windowMs = 30 * 60 * 1000, botWhenAssigned = false } = {}) {
  const seen = new Set();
  return changes.filter(change => {
    if (change.type !== 'message' || change.updated || change.message?.direction !== 'incoming' || !change.conversation) return false;
    const at = Number(change.message.createdAt) || 0;
    if (now - at > windowMs || at > now + 5 * 60 * 1000) return false;
    if (change.conversation.botEnabled === false) return false;
    // Hội thoại đã có nhân viên nhận trong Pancake: như đường webhook, bot không chen.
    if (!botWhenAssigned && change.conversation.pancakeAssigned) return false;
    const messages = store?.messages?.[change.conversation.id] || [];
    if (messages.some(item => item.direction === 'outgoing' && (Number(item.createdAt) || 0) >= at)) return false;
    if (staffRepliedRecently(messages, now)) return false;
    // Tin Page gần nhất trước tin khách là của nhân viên (trong 2 giờ): khách đang nói chuyện với người thật.
    if (recentStaffBefore(messages, at, now)) return false;
    const key = `${change.conversation.id}:${change.message.id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  // `late`: tin đến muộn so với lúc phát sinh — bot kiểm lại "đã có người trả lời" ngay trước khi trả lời.
  }).map(change => ({ ...change, late: true }));
}

/**
 * Lúc khởi động: tin khách đã nằm trong kho (đồng bộ ghi lúc webhook im) mà chưa ai trả lời trong
 * `windowMs` → đưa bot một lần. Chỉ tin cuối của mỗi hội thoại, bot còn bật.
 */
export function backlogBotChanges(store, { now = Date.now(), windowMs = 60 * 60 * 1000, botWhenAssigned = false } = {}) {
  const changes = [];
  for (const conversation of store?.conversations || []) {
    if (conversation.botEnabled === false) continue;
    if (!botWhenAssigned && conversation.pancakeAssigned) continue;
    const messages = store.messages?.[conversation.id] || [];
    const last = messages[messages.length - 1];
    if (!last || last.direction !== 'incoming' || !['text', 'image'].includes(last.type)) continue;
    const at = Number(last.createdAt) || 0;
    if (now - at > windowMs || at > now + 5 * 60 * 1000) continue;
    if (messages.some(item => item.direction === 'outgoing' && (Number(item.createdAt) || 0) >= at)) continue;
    if (staffRepliedRecently(messages, now)) continue;
    if (recentStaffBefore(messages, at, now)) continue;
    changes.push({ type: 'message', conversation, message: last, late: true });
  }
  return changes;
}

async function runPancakeSync({ pageId, limit = 60, messagePages = 1, commentLimit = 30, processChatbotChanges = null, chatbotDependencies = null, botWindowMs = 30 * 60 * 1000 } = {}, config = defaultConfig, fetchImpl = fetch) {
  if (!isPancakeConfigured(config)) return { conversations: 0, messages: 0, skipped: 'chưa cấu hình' };
  const pages = pageId
    ? [getPancakePageConfig(pageId, config)]
    : (config.pages?.length ? config.pages.map(p => getPancakePageConfig(p.pageId, config)) : [config]);

  let totalConversations = 0;
  let totalStored = 0;
  const allFailures = [];
  const collected = [];

  // Mỗi bước bọc riêng: Pancake trả 500 / hủy giữa chừng ở một hội thoại, ở danh sách bình luận hay
  // ở bước tra quảng cáo thì chỉ bước đó hỏng; tin đã ghi trước đó vẫn được đưa bot ở cuối lượt
  // (trước đây một lỗi ném ra khỏi hàm là mất cả phần đã đồng bộ → bot bỏ sót khách).
  const step = async (label, task, fallback = null) => {
    try {
      return await task();
    } catch (error) {
      allFailures.push(`${label}: ${error.message}`);
      return fallback;
    }
  };
  // Ghi kho gộp: cả lượt chỉ sửa bộ nhớ, ghi đĩa một lần ở cuối (finally) thay vì mỗi hội thoại một lần.
  const store = events => storePancakeEvents(events, { deferWrite: true });
  try {
    for (const page of pages) {
      const pId = String(page.pageId);
      if (!pId || !page.pageAccessToken) continue;
      const conversations = await step(`${pId} danh sách hội thoại`, () => fetchPancakeConversations({ limit }, page, fetchImpl), []);
      for (const [index, conversation] of conversations.entries()) {
        if (index) await pause(200);
        await step(conversation.id, async () => {
          const messages = await fetchPancakeMessages(conversation.id, { pages: messagePages }, page, fetchImpl);
          const events = messages
            .map(message => pancakeMessageEvent(pId, conversation, message))
            .filter(Boolean)
            .sort((first, second) => first.timestamp - second.timestamp);
          const changes = await store(events);
          collected.push(...changes);
          totalStored += changes.filter(change => change.type === 'message').length;
        });
      }
      await step(`${pId} quảng cáo`, async () => {
        const current = await readMessagingStore();
        const pendingAds = current.conversations.filter(item => item.pageId === pId && needsAdContext(item));
        if (pendingAds.length) await enrichPancakeAdContext(pendingAds, page, fetchImpl);
      });
      const threads = commentLimit > 0
        ? await step(`${pId} danh sách bình luận`, () => fetchPancakeConversations({ limit: commentLimit, type: 'COMMENT' }, page, fetchImpl), [])
        : [];
      for (const thread of threads) {
        await pause(200);
        await step(thread.id, async () => {
          const comments = await fetchPancakeMessages(thread.id, { pages: 1 }, page, fetchImpl);
          const post = comments.post || { id: thread.post_id };
          const events = comments
            .map(comment => pancakeCommentEvent(pId, thread, comment, post))
            .filter(Boolean)
            .sort((first, second) => (first.parentId ? 1 : 0) - (second.parentId ? 1 : 0) || first.timestamp - second.timestamp);
          const changes = await store(events);
          collected.push(...changes);
          totalStored += changes.filter(change => change.type === 'message').length;
        });
      }
      totalConversations += conversations.length + threads.length;
    }
  } catch (error) {
    // Lỗi ngoài dự kiến (không thuộc bước nào): vẫn đi tiếp để tin đã ghi tới được bot.
    allFailures.push(`đồng bộ: ${error.message}`);
  } finally {
    await flushMessagingStore().catch(error => allFailures.push(`ghi kho: ${error.message}`));
  }
  // Webhook không tới (Pancake tạm ngưng, dịch vụ khởi động lại): tin mới chưa ai trả lời vẫn được bot xử lý.
  let bot = 0;
  if (processChatbotChanges && collected.length) {
    await step('bot', async () => {
      const missed = missedBotChanges(collected, await readMessagingStore(), { windowMs: botWindowMs, botWhenAssigned: Boolean(config.botWhenAssigned) });
      if (missed.length) {
        bot = missed.length;
        await processChatbotChanges(missed, chatbotDependencies);
      }
    });
  }
  return { conversations: totalConversations, messages: totalStored, ...(bot ? { bot } : {}), ...(allFailures.length ? { failures: allFailures } : {}) };
}

let pancakeSyncTimer = null;
let lastPancakeWebhookAt = 0;
/** Webhook Pancake vừa gọi tới (gói hợp lệ): mốc để biết webhook còn sống. */
export function notePancakeWebhook(now = Date.now()) { lastPancakeWebhookAt = now; }

/**
 * Lịch đồng bộ thích ứng: đủ (60 hội thoại) mỗi `intervalMs`; khi webhook im quá `silentMs` (Pancake
 * tạm ngưng webhook, như 26/09) thì thêm lượt nhanh (20 hội thoại + 10 luồng bình luận) mỗi `quickMs`
 * để bot trả lời trong ~2 phút thay vì 10. Trả về 'full' | 'quick' | null.
 */
export function pancakeSyncPlan({ now = Date.now(), startedAt = 0, lastWebhookAt = 0, lastFullAt = 0, lastQuickAt = 0, intervalMs = 10 * 60 * 1000, quickMs = 2 * 60 * 1000, silentMs = 15 * 60 * 1000 } = {}) {
  if (now - lastFullAt >= intervalMs) return 'full';
  const silent = now - Math.max(lastWebhookAt, startedAt) > silentMs;
  if (silent && now - lastQuickAt >= quickMs) return 'quick';
  return null;
}

/** Đồng bộ lúc khởi động rồi mỗi 10 phút (nhanh hơn khi webhook im), để không lọt tin trong lúc webhook gián đoạn. */
export function startPancakeSync({ intervalMs = 10 * 60 * 1000, quickMs = 2 * 60 * 1000, silentMs = 15 * 60 * 1000, log = console.log, config = defaultConfig, processChatbotChanges = null, chatbotDependencies = null } = {}) {
  if (!isPancakeConfigured(config) || pancakeSyncTimer) return null;
  // Lượt trước chưa xong (mạng chậm, bị chặn 429) thì lượt sau bỏ qua, không chạy chồng.
  let running = false;
  let first = true;
  const startedAt = Date.now();
  let lastFullAt = 0;
  let lastQuickAt = 0;
  let silentWarnedAt = 0;
  const run = async mode => {
    if (running) return;
    running = true;
    try {
      const quick = mode === 'quick';
      if (quick) lastQuickAt = Date.now(); else { lastFullAt = Date.now(); lastQuickAt = lastFullAt; }
      const summary = await syncPancakeConversations(quick
        ? { limit: 20, messagePages: 1, commentLimit: 10, processChatbotChanges, chatbotDependencies }
        : { limit: 60, messagePages: 1, processChatbotChanges, chatbotDependencies }, config);
      if (summary.messages) log(`Đồng bộ Pancake${quick ? ' (nhanh, webhook im)' : ''}: ${summary.conversations} hội thoại, ghi ${summary.messages} tin mới${summary.bot ? `, đưa bot ${summary.bot} tin webhook bỏ sót` : ''}`);
      // Lượt đầu sau khởi động: tin khách còn treo trong 60 phút (webhook im lúc dịch vụ dừng) đưa bot.
      if (first && processChatbotChanges) {
        first = false;
        const backlog = backlogBotChanges(await readMessagingStore(), { botWhenAssigned: Boolean(config.botWhenAssigned) });
        if (backlog.length) {
          log(`Đồng bộ Pancake: đưa bot ${backlog.length} tin khách còn treo sau khởi động`);
          await processChatbotChanges(backlog, chatbotDependencies);
        }
      }
      if (summary.failures?.length) log(`Đồng bộ Pancake: ${summary.failures.length} hội thoại lỗi, ví dụ ${summary.failures[0]}`);
    } catch (error) {
      log(`Đồng bộ Pancake lỗi: ${error.message}`);
    } finally {
      running = false;
    }
  };
  const tick = () => {
    const now = Date.now();
    const mode = pancakeSyncPlan({ now, startedAt, lastWebhookAt: lastPancakeWebhookAt, lastFullAt, lastQuickAt, intervalMs, quickMs, silentMs });
    if (mode === 'quick' && now - silentWarnedAt > 60 * 60 * 1000) {
      silentWarnedAt = now;
      log(`Webhook Pancake im ${Math.round((now - Math.max(lastPancakeWebhookAt, startedAt)) / 60000)} phút: đồng bộ nhanh mỗi ${Math.round(quickMs / 60000)} phút (kiểm tra Pancake → Cài đặt → Webhook).`);
    }
    if (mode) run(mode);
  };
  setTimeout(() => run('full'), 5000);
  pancakeSyncTimer = setInterval(tick, 30 * 1000);
  return pancakeSyncTimer;
}

// Dấu vân tay các hội thoại (và tin) mà lô sự kiện chạm tới: đồng bộ chạy lại trên tin đã có thì
// không đổi gì → không ghi kho (tệp ~19 MB). Rẻ: chỉ vài hội thoại của đúng khách trong lô.
function touchedFingerprint(store, keys) {
  const parts = [store.conversations.length, Object.keys(store.commentIndex || {}).length];
  for (const conversation of store.conversations) {
    if (!keys.has(`${conversation.pageId}:${conversation.psid}`)) continue;
    parts.push(JSON.stringify(conversation), JSON.stringify(store.messages[conversation.id] || []));
  }
  return parts.join('\u0000');
}

/**
 * Ghi tin vào hộp thư và trả về các thay đổi cho bot. Ghi thêm mã hội thoại
 * Pancake và tên khách lên hội thoại CRM để còn gửi trả lời đúng chỗ.
 * `deferWrite: true` (đường đồng bộ): kho chỉ sửa trong bộ nhớ, ghi đĩa gộp sau (runPancakeSync
 * gọi flushMessagingStore cuối lượt). Webhook giữ ghi ngay.
 */
export async function storePancakeEvents(incomingEvents, { fromWebhook = false, deferWrite = false } = {}) {
  if (!incomingEvents.length) return [];
  const touchedKeys = new Set(incomingEvents.map(event => `${event.pageId}:${event.psid}`));
  let touched = true;
  // Tin bám đuổi do trạm gửi (extension Pancake) gửi: Pancake ghi admin_name là nhân viên đang mở
  // trình duyệt (28/09: 6 tin "Dạ chị ơi, Giọt Nắng gửi chị ưu đãi riêng…" mang tên một nhân viên)
  // → trước đây bị coi là nhân viên nhắn: bot tắt, khách trả lời bám đuổi thì bot im. Tin Page mang
  // cờ staff mà trùng lời bám đuổi đã xếp/gửi trong 24 giờ cho đúng hội thoại → gỡ staff, gắn followUp.
  const staffOutgoing = incomingEvents.filter(event => event.type === 'message' && event.message?.direction === 'outgoing' && (event.message.staff || event.pancake?.staff));
  const echoes = staffOutgoing.length ? await recentFollowUpTexts().catch(() => new Map()) : null;
  for (const event of staffOutgoing) {
    const entries = echoes?.get?.(crmConversationId(event.pageId, event.psid));
    if (!matchesFollowUpText(entries, event.message)) continue;
    delete event.message.staff;
    delete event.message.staffName;
    event.message.sender = 'bot';
    event.message.followUp = true;
    event.pancake = { ...event.pancake, staff: false, followUp: true };
  }
  // Bot tự tắt / phân công đổi: ghi nhật ký sau khi lưu kho (ngoài hàng đợi ghi của kho).
  const automaticAudits = [];
  const changes = await updateMessagingStore(store => {
    const before = touchedFingerprint(store, touchedKeys);
    const applied = applyPancakeEventsToStore(store, incomingEvents, { fromWebhook, automaticAudits });
    touched = touchedFingerprint(store, touchedKeys) !== before;
    return applied;
  }, { defer: deferWrite, unchanged: () => !touched });
  for (const item of automaticAudits) {
    if (item.kind === 'bot') appendBotToggleAudit({ actor: AUTOMATED_ACTORS.system, conversation: item.conversation, enabled: false, reason: item.reason });
    else appendAssignAudit({ actor: AUTOMATED_ACTORS.system, conversation: item.conversation, from: item.from, to: item.to, reason: 'Pancake' });
  }
  for (const change of changes) {
    publishMessagingEvent(change.conversation ? { ...change, conversation: publicConversation(change.conversation) } : change);
  }
  return changes;
}

/**
 * Lần bấm quảng cáo (referral 'ADS') từ một tin Pancake. Mốc là giờ của TIN (tin ad_click, hay tin đầu
 * tiên mang quảng cáo trong hội thoại), không phải lúc đồng bộ kéo về (trước 01/10: Date.now() — đồng bộ
 * lần đầu sau khởi động dán mốc "bây giờ" cho mọi hội thoại cũ, báo cáo chiến dịch quy đơn sai).
 *  - quảng cáo mới (khác adId): thêm một lần bấm vào lịch sử `referrals`, `referral` = quảng cáo này
 *    (firstAt = lastAt = giờ tin);
 *  - cùng quảng cáo, tên quảng cáo vừa có: điền tên, KHÔNG thêm lần bấm (trước đây thêm → đếm trùng);
 *  - khách bấm LẠI cùng quảng cáo (tin ad_click mới): thêm lần bấm mới (quy đơn theo lần bấm gần nhất),
 *    `referral.lastAt` = mốc mới nhất, `referral.firstAt` giữ mốc lần đầu.
 * Đồng bộ kéo lại đúng tin đã có thì không đổi gì.
 */
export function applyPancakeAdReferral(conversation, event, { inserted = true } = {}) {
  const ad = event?.pancake?.ad;
  if (!ad?.adId) return false;
  // Giờ bấm: mục quảng cáo của hội thoại (ads[].inserted_at), không có thì giờ của tin mang quảng cáo.
  const clickedAt = Number(ad.at) || Number(event.message?.createdAt) || Number(event.timestamp) || Date.now();
  const current = conversation.referral;
  const sameAd = Boolean(current) && current.adId === ad.adId;
  const history = Array.isArray(conversation.referrals) ? conversation.referrals : [];
  if (!sameAd) {
    const referral = { ref: '', source: 'ADS', adId: ad.adId, adTitle: ad.adTitle || '', postId: ad.postId, photoUrl: ad.photoUrl || '', firstAt: clickedAt, lastAt: clickedAt };
    conversation.referrals = [...history, { ref: '', source: 'ADS', adId: ad.adId, adTitle: referral.adTitle, postId: ad.postId, photoUrl: referral.photoUrl, at: clickedAt }].slice(-20);
    conversation.referral = referral;
    return true;
  }
  let changed = false;
  if (ad.adTitle && !current.adTitle) {
    conversation.referral = { ...current, adTitle: ad.adTitle, photoUrl: current.photoUrl || ad.photoUrl || '' };
    const lastIndex = history.map(item => item?.adId).lastIndexOf(ad.adId);
    if (lastIndex >= 0 && !history[lastIndex].adTitle) {
      conversation.referrals = history.map((item, index) => (index === lastIndex ? { ...item, adTitle: ad.adTitle } : item));
    }
    changed = true;
  }
  // Bấm lại: tin ad_click MỚI, hay mục quảng cáo của hội thoại mang mốc bấm mới hơn lần đã ghi. Tin thường
  // không mốc bấm, hay tin kéo lại, thì không. Dữ liệu cũ chưa có lastAt: lấy lần bấm cuối trong lịch sử.
  const lastClick = Number(conversation.referral.lastAt)
    || Math.max(0, ...history.filter(item => item?.adId === ad.adId).map(item => Number(item.at) || 0));
  const reclick = ((inserted && event.message?.type === 'ad') || Number(ad.at) > 0) && clickedAt > lastClick
    && !history.some(item => item?.adId === ad.adId && Number(item.at) === clickedAt);
  if (reclick) {
    const referral = conversation.referral;
    conversation.referral = { ...referral, firstAt: Number(referral.firstAt) || Number(history.find(item => item?.adId === ad.adId)?.at) || clickedAt, lastAt: clickedAt };
    conversation.referrals = [...(conversation.referrals || history), { ref: '', source: 'ADS', adId: ad.adId, adTitle: referral.adTitle || '', postId: referral.postId || ad.postId, photoUrl: referral.photoUrl || '', at: clickedAt }].slice(-20);
    changed = true;
  }
  return changed;
}

function applyPancakeEventsToStore(store, incomingEvents, { fromWebhook, automaticAudits }) {
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
        // `updated`: hộp thư vẽ lại; bot bỏ qua (tin cũ, đã trả lời) để không trả lời lần hai.
        if (stored) applied.push({ type: 'message', conversation, message: stored, updated: true });
      }
      // Khách đến từ quảng cáo: ghi referral như Meta (nguồn 'ADS', tên quảng
      // cáo tra sau bằng enrichPancakeAdContext).
      applyPancakeAdReferral(conversation, event, { inserted });
    }
    // Nhân viên trả lời trong Pancake (tin mới, không phải tin dội lại của
    // CRM, không phải lịch sử kéo về): bot đứng ngoài hội thoại này cho tới
    // khi bật lại trong CRM, để không nói chen vào người thật.
    const recentStaff = event.pancake.staff && Date.now() - (Number(event.message?.createdAt || event.timestamp) || 0) < 60 * 60 * 1000;
    if ((fromWebhook || recentStaff) && inserted && event.pancake.staff && conversation.botEnabled !== false) {
      conversation.botEnabled = false;
      conversation.botPausedBy = event.pancake.staffName;
      conversation.botPausedAt = Date.now();
      automaticAudits.push({ kind: 'bot', conversation: { id: conversation.id, name: conversation.name || '' }, reason: `${event.pancake.staffName || 'nhân viên'} nhắn trong Pancake` });
    }
    // Ảnh khách: Pancake có đường công khai chuyển hướng tới ảnh trên CDN, không cần token.
    if (!conversation.picture && conversation.psid) {
      conversation.picture = pancakeAvatarUrl(event.pageId, conversation.psid);
      conversation.profileResolvedAt = conversation.profileResolvedAt || Date.now();
    }
    // Tên mặc định của hộp thư ("Khách Facebook 1234") thay bằng tên Pancake biết.
    if (event.pancake.customerName && (!conversation.name || /^Khách Facebook \d*$/.test(conversation.name))) conversation.name = event.pancake.customerName;
    // Giới tính trong hồ sơ Pancake: hơn bản đoán theo tên/xưng hô, kém nhân viên chọn tay; đổi thì báo hộp thư.
    // Không có trong hồ sơ thì đoán theo tên; rồi dồn cho mọi luồng của cùng khách.
    // Khách tự xưng trong tin vừa đến ("Lấy chị 1 túi vàng"): bằng chứng mạnh hơn hồ sơ Pancake (GENDER_SOURCE_RANK).
    const selfGender = !isComment && inserted && event.message?.direction === 'incoming' ? genderFromMessage(event.message.text) : '';
    const selfChanged = Boolean(selfGender) && applyGenderGuess(conversation, selfGender, 'message');
    const genderChanged = selfChanged
      || (event.pancake.gender && applyGenderGuess(conversation, event.pancake.gender, 'pancake'))
      || applyGenderGuess(conversation, genderFromName(conversation.name), 'name');
    const reconciled = reconcileCustomerGender(store, conversation);
    for (const changed of [...(genderChanged ? [conversation] : []), ...reconciled]) {
      if (!applied.some(change => change.type === 'conversation' && change.conversation?.id === changed.id)) applied.push({ type: 'conversation', conversation: changed });
    }
    conversation.pancakeAssigned = event.pancake.assigned;
    // Phân công trong Pancake đổi: lịch sử hội thoại (nhật ký, người làm 'system'). Lần đầu thấy
    // danh sách chỉ ghi nhớ (không biết trước đó là ai), gói không kèm danh sách thì bỏ qua.
    const assignees = Array.isArray(event.pancake.assignees) ? event.pancake.assignees : null;
    if (assignees) {
      const previous = Array.isArray(conversation.pancakeAssignees) ? conversation.pancakeAssignees : null;
      if (previous && previous.join('|') !== assignees.join('|')) {
        automaticAudits.push({ kind: 'assign', conversation: { id: conversation.id, name: conversation.name || '' }, from: previous.join(', '), to: assignees.join(', ') });
      }
      conversation.pancakeAssignees = assignees;
    }
  }
  return applied;
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
  const pageConfig = getPancakePageConfig(pageId, config);
  if (!pageConfig.pageAccessToken) throw new Error('Chưa có PANCAKE_PAGE_ACCESS_TOKEN.');
  if (!conversationId) throw new Error('Hội thoại này chưa có mã Pancake để gửi.');
  if (!text && !contentIds.length) throw new Error('Tin nhắn trống.');
  if (action !== 'reply_inbox' && !commentId) throw new Error('Chưa có bình luận nào của khách để trả lời.');
  const url = `${apiRoot(config)}/v1/pages/${encodeURIComponent(pageId)}/conversations/${encodeURIComponent(conversationId)}/messages?page_access_token=${encodeURIComponent(pageConfig.pageAccessToken)}`;
  const content = contentIds.length ? { content_ids: contentIds } : { message: text };
  const payload = action === 'reply_comment'
    ? { action, message_id: commentId, ...content }
    : action === 'private_replies'
      ? { action, post_id: postId, message_id: commentId, from_id: fromId, ...content }
      : { action: 'reply_inbox', ...content };
  // Lần gửi trước của đúng tin này hết giờ chờ (không rõ đã tới khách chưa): kiểm tin của hội
  // thoại trên Pancake trước, đã có thì coi như đã gửi, chưa chắc thì không gửi lại.
  const uncertainKey = uncertainSendKey({ pageId, conversationId, action, commentId, text, contentIds });
  if (attempt === 0 && uncertainSends.has(uncertainKey)) {
    const recovered = await resolveUncertainSend(uncertainKey, pageConfig, fetchImpl);
    if (recovered) return recovered;
  }
  let response;
  let body;
  try {
    ({ response, body } = await pancakeFetch(pageId, url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    }, fetchImpl, 15000));
  } catch (error) {
    // Hết giờ / đứt kết nối sau khi yêu cầu đã đi: Pancake có thể đã gửi cho khách.
    if (!isUncertainSendError(error)) throw error;
    throw markUncertainSend(uncertainKey, { pageId, conversationId, action, fromId, text, contentIds }, error.name === 'AbortError' ? 'hết giờ chờ 15 giây' : error.message);
  }
  // Quá 5 lần gọi/giây: cả Page lùi lại rồi gửi lại (tối đa 3 lần). 429 = Pancake chưa nhận, gửi lại an toàn.
  if (response.status === 429 && attempt < 3) {
    backoffPancake(pageId, 1500 * (attempt + 1));
    return sendPancakeMessage({ pageId, conversationId, text, contentIds, action, commentId, postId, fromId }, config, fetchImpl, attempt + 1);
  }
  // Cổng của Pancake hết giờ (502/504): yêu cầu có thể đã chạy xong phía sau.
  if (response.status === 502 || response.status === 504) {
    throw markUncertainSend(uncertainKey, { pageId, conversationId, action, fromId, text, contentIds }, `Pancake trả ${response.status}`);
  }
  if (!response.ok || body.success === false) {
    // Pancake hay trả 200 + success:false, lý do nằm trong original_error.
    // Mã lỗi hay gặp dịch sang tiếng Việt để panel khách đọc được thay vì JSON thô.
    const known = { invalid_upload_fb_attachments_result: 'Facebook từ chối ảnh vừa tải lên (invalid_upload_fb_attachments_result)' };
    const reason = body.message || body.error
      || (body.original_error && (typeof body.original_error === 'string' ? body.original_error : JSON.stringify(body.original_error).slice(0, 300)))
      || known[body.message_code]
      || `phản hồi: ${JSON.stringify(body).slice(0, 300)}`;
    throw new Error(`Pancake không nhận tin (${response.status}): ${reason}`);
  }
  uncertainSends.delete(uncertainKey);
  return { id: String(body.id || body.message_id || `pancake-sent-${Date.now()}`) };
}

// ===== Gửi "không rõ đã tới" =====
//
// Pancake không có khóa idempotency cho API gửi tin. Lần gửi hết giờ chờ (abort) hay cổng 502/504
// có thể đã tới khách; người gọi thử lại (bot thử lại sau 3 giây) là khách nhận hai tin. Nên: ghi
// lại lần gửi "không rõ", lần gửi lại đúng tin đó (cùng hội thoại, cùng kiểu, cùng chữ) phải kiểm
// tin của hội thoại trên Pancake trước — thấy tin của Page khớp thì trả về như đã gửi, không gửi
// lại; chưa thấy mà còn trong `uncertainGraceMs` (Pancake có thể còn đang xử lý) hay không kiểm
// được thì báo lỗi "không rõ đã gửi", không gửi; quá hạn đó mà vẫn không thấy thì mới gửi lại.
const uncertainSends = new Map();
const uncertainTtlMs = 30 * 60 * 1000;
const uncertainGraceMs = 30 * 1000;
const compactWhitespace = value => String(value || '').replace(/\s+/g, ' ').trim();

function uncertainSendKey({ pageId, conversationId, action, commentId, text, contentIds }) {
  // Ảnh/tệp: mỗi lần gửi lại tải lên mã nội dung mới, nên khóa theo "có tệp" chứ không theo mã.
  return [pageId, conversationId, action, commentId || '', contentIds?.length ? '[tệp]' : compactWhitespace(text)].join('|');
}

function isUncertainSendError(error) {
  if (error?.name === 'AbortError' || error?.name === 'TimeoutError') return true;
  // fetch failed: không kết nối được (DNS, từ chối kết nối) thì chắc chắn chưa gửi; đứt giữa chừng thì không rõ.
  const code = String(error?.cause?.code || error?.code || '');
  if (['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ENETUNREACH', 'EHOSTUNREACH'].includes(code)) return false;
  return error instanceof TypeError && /fetch failed|terminated|socket/i.test(`${error.message} ${error.cause?.message || ''}`);
}

function markUncertainSend(key, { pageId, conversationId, action, fromId, text, contentIds }, reason) {
  const now = Date.now();
  for (const [entryKey, entry] of uncertainSends) if (now - entry.at > uncertainTtlMs) uncertainSends.delete(entryKey);
  // Tin nhắn riêng (private_replies) nằm ở hộp thư của khách, không ở luồng bình luận.
  const verifyConversationId = action === 'private_replies' && fromId ? `${pageId}_${fromId}` : conversationId;
  uncertainSends.set(key, { at: now, pageId: String(pageId), verifyConversationId, text: compactWhitespace(text), attachment: Boolean(contentIds?.length) });
  return Object.assign(new Error(`Pancake không rõ đã nhận tin (${reason}) — không rõ đã gửi; không tự gửi lại, lần gửi sau sẽ kiểm tin trên Pancake trước.`), { code: 'PANCAKE_SEND_UNCERTAIN', unknownDelivery: true });
}

/** Tin của Page khớp lần gửi "không rõ" trong `messages` (API tin của Pancake), hay null. */
export function findUncertainSendMatch(messages, entry) {
  const since = entry.at - 2 * 60 * 1000;
  return (Array.isArray(messages) ? messages : []).find(message => {
    if (String(message?.from?.id || '') !== String(entry.pageId)) return false;
    if (pancakeTime(message.inserted_at, 0) < since) return false;
    if (entry.attachment) return Array.isArray(message.attachments) && message.attachments.length > 0;
    return compactWhitespace(pancakeMessageText(message)) === entry.text;
  }) || null;
}

async function resolveUncertainSend(key, pageConfig, fetchImpl) {
  const entry = uncertainSends.get(key);
  if (!entry || Date.now() - entry.at > uncertainTtlMs) {
    uncertainSends.delete(key);
    return null;
  }
  let messages;
  try {
    messages = await fetchPancakeMessages(entry.verifyConversationId, { pages: 1 }, { ...pageConfig, pageId: entry.pageId }, fetchImpl);
  } catch (error) {
    throw Object.assign(new Error(`Tin trước không rõ đã gửi và chưa kiểm được trên Pancake (${error.message}) — không gửi lại để tránh khách nhận hai lần.`), { code: 'PANCAKE_SEND_UNCERTAIN', unknownDelivery: true });
  }
  const found = findUncertainSendMatch(messages, entry);
  if (found) {
    uncertainSends.delete(key);
    return { id: String(found.id || `pancake-sent-${Date.now()}`), recovered: true };
  }
  if (Date.now() - entry.at < uncertainGraceMs) {
    throw Object.assign(new Error('Tin trước không rõ đã gửi, Pancake chưa hiện tin — không gửi lại lúc này để tránh khách nhận hai lần.'), { code: 'PANCAKE_SEND_UNCERTAIN', unknownDelivery: true });
  }
  // Quá thời gian chờ mà Pancake vẫn không có tin: lần trước không tới, gửi lại được.
  uncertainSends.delete(key);
  return null;
}

/** Tải một tệp (ảnh, video…) lên Page trong Pancake; mã trả về dùng để gửi kèm tin. */
export async function uploadPancakeContent({ pageId, buffer, filename = 'anh.jpg', mime = 'application/octet-stream' }, config = defaultConfig, fetchImpl = fetch, attempt = 0) {
  const pageConfig = getPancakePageConfig(pageId, config);
  if (!pageConfig.pageAccessToken) throw new Error('Chưa có PANCAKE_PAGE_ACCESS_TOKEN.');
  if (!buffer?.length) throw new Error('Tệp trống.');
  const url = `${apiRoot(config)}/v1/pages/${encodeURIComponent(pageId)}/upload_contents?page_access_token=${encodeURIComponent(pageConfig.pageAccessToken)}`;
  const form = new FormData();
  form.append('file', new Blob([buffer], { type: mime }), filename);
  // Tải lên (chưa gửi cho khách): thử lại an toàn, nên chỉ cần đi qua hàng đợi giới hạn tốc độ.
  const { response, body } = await pancakeFetch(pageId, url, { method: 'POST', body: form }, fetchImpl, 30000);
  // Quá 5 lần gọi/giây: cả Page lùi lại rồi tải lại (tối đa 3 lần).
  if (response.status === 429 && attempt < 3) {
    backoffPancake(pageId, 1500 * (attempt + 1));
    return uploadPancakeContent({ pageId, buffer, filename, mime }, config, fetchImpl, attempt + 1);
  }
  if (!response.ok || body.success === false || !body.id) {
    throw new Error(`Pancake không nhận tệp (${response.status}): ${body.message || body.error || 'không rõ lý do'}`);
  }
  return { id: String(body.id), attachmentType: String(body.attachment_type || '') };
}

const productImagesPath = path.join(projectRoot, 'data', 'processed', 'product-images');
const imageMimeTypes = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' };
const maxUploadBytes = 5 * 1024 * 1024;

/** Ảnh gửi đi: ảnh sản phẩm của CRM đọc thẳng từ đĩa, ảnh ngoài thì tải về. */
export async function readImageForUpload(imageUrl, fetchImpl) {
  const parsed = new URL(imageUrl);
  const local = parsed.origin === new URL(metaConfig.publicBaseUrl).origin && parsed.pathname.match(/^\/product-images\/([A-Za-z0-9-]+\.(?:png|jpe?g|webp))$/);
  if (local) {
    const filename = local[1];
    return { buffer: await readFile(path.join(productImagesPath, filename)), filename, mime: imageMimeTypes[path.extname(filename).toLowerCase()] };
  }
  // Ảnh ngoài: máy chủ tải hộ, nên đích phải là máy công khai (không phải
  // 127.0.0.1 hay metadata của VM), không theo chuyển hướng, phải là ảnh thật
  // và đọc theo dòng để dừng ngay khi quá 5 MB thay vì nuốt cả tệp vào bộ nhớ.
  if (!/^https?:$/.test(parsed.protocol)) throw new Error('Chỉ tải được ảnh qua http/https.');
  await assertPublicHost(parsed.hostname, { resolve: fetchImpl === fetch });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetchImpl(parsed, { signal: controller.signal, redirect: 'manual' });
    if (!response.ok) throw new Error(`Không tải được ảnh (${response.status}).`);
    const mime = String(response.headers?.get?.('content-type') || '').split(';')[0].trim().toLowerCase();
    if (!mime.startsWith('image/')) throw new Error('Địa chỉ không phải ảnh.');
    if (Number(response.headers?.get?.('content-length') || 0) > maxUploadBytes) throw new Error('Ảnh lớn hơn 5 MB.');
    const buffer = await readBodyUpTo(response, maxUploadBytes, controller);
    return { buffer, filename: path.basename(parsed.pathname) || 'anh.jpg', mime };
  } finally {
    clearTimeout(timer);
  }
}

async function readBodyUpTo(response, limit, controller) {
  if (!response.body?.getReader) {
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > limit) throw new Error('Ảnh lớn hơn 5 MB.');
    return buffer;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > limit) {
      controller.abort();
      throw new Error('Ảnh lớn hơn 5 MB.');
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

/** Chữ dài hơn giới hạn Messenger (2000 ký tự) cắt thành nhiều tin theo đoạn/câu, mỗi tin ≤ limit. */
export function splitLongText(text, limit = 1900) {
  const body = String(text || '');
  if (body.length <= limit) return [body];
  const chunks = [];
  let rest = body;
  while (rest.length > limit) {
    const window = rest.slice(0, limit);
    let cut = window.lastIndexOf('\n\n');
    if (cut < limit / 2) cut = window.lastIndexOf('\n');
    if (cut < limit / 2) cut = window.lastIndexOf('. ');
    if (cut < limit / 2) cut = window.lastIndexOf(' ');
    if (cut < 1) cut = limit;
    chunks.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) chunks.push(rest);
  return chunks.filter(Boolean);
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
    // JPEG không có lớp trong suốt: PNG nền trong phải trải lên nền trắng trước, nếu không nền thành đen.
    const buffer = await sharp(file.buffer).rotate().resize({ width, height: width, fit: 'inside', withoutEnlargement: true }).flatten({ background: '#ffffff' }).jpeg({ quality, mozjpeg: true }).toBuffer();
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
// `staff: true` (hay { name, username } của người gửi) = nhân viên gửi từ CRM; `followUp: true` = tin bám đuổi (follow-up.mjs) — hai cờ ghi lên tin lưu.
export async function sendConversationMessageViaPancake(conversation, { text = '', templateText = '', attachment = null, imageUrl = '', imageUrls = [], privateReply = false, staff = false, sentBy = null, followUp = false }, config = defaultConfig, fetchImpl = fetch) {
  const body = String(templateText || text || '').trim();
  const target = { pageId: conversation.pageId, conversationId: conversation.pancakeConversationId };
  // Nhiều ảnh đi chung một tin (Facebook nhận tới 30 mã một lần), khách thấy một cụm ảnh thay vì từng ảnh lắc nhắc.
  const pictures = [...new Set([imageUrl, ...(Array.isArray(imageUrls) ? imageUrls : [])].map(item => String(item || '').trim()).filter(Boolean))].slice(0, 30);
  if (!body && !attachment && !pictures.length) throw Object.assign(new Error('Tin nhắn trống.'), { statusCode: 400 });
  // Trả lời bình luận (công khai hay nhắn riêng) cũng mang cờ nhân viên / bám đuổi như tin hộp thư.
  if (conversation.source === 'comment') return sendCommentReplyViaPancake(conversation, { text: body, privateReply, staff, sentBy, followUp }, config, fetchImpl);
  let message;
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
      // Chỉ gửi lại khi Pancake báo mã ảnh hết hạn; lỗi mạng/cổng (502, 429 hết
      // lượt) có thể đã tới khách rồi, gửi lại là khách nhận cụm ảnh hai lần.
      if (!/invalid_upload/.test(error.message)) throw error;
      sent = await sendPancakeMessage({ ...target, contentIds: await upload() }, config, fetchImpl);
    }
    // Một tin, nhiều ảnh: hộp thư vẽ lưới ảnh; bản dội lại của Pancake (cùng mã) gộp vào.
    message = { id: sent.id, mid: sent.id, direction: 'outgoing', type: 'image', text: '', name: 'anh-san-pham', dataUrl: pictures[0], ...(pictures.length > 1 ? { images: pictures } : {}), createdAt: Date.now(), status: 'sent' };
  } else if (attachment) {
    const { mime, buffer } = decodeDataUrl(attachment.dataUrl);
    const file = await fitImageForPancake({ buffer, filename: attachment.name || 'tep-dinh-kem', mime });
    if (file.buffer.length > pancakeUploadLimit) throw Object.assign(new Error('Pancake chỉ nhận tệp tới 500 KB; ảnh được nén tự động, tệp khác cần nhỏ hơn.'), { statusCode: 400 });
    const uploadAndSend = async () => {
      const { id } = await uploadPancakeContent({ pageId: target.pageId, ...file }, config, fetchImpl);
      return sendPancakeMessage({ ...target, contentIds: [id] }, config, fetchImpl);
    };
    let sent;
    try {
      sent = await uploadAndSend();
    } catch (error) {
      // Như với ảnh sản phẩm: Facebook từ chối tệp vừa tải thì tải lại, gửi thêm một lần.
      if (!/invalid_upload/.test(error.message)) throw error;
      await pause(1000);
      sent = await uploadAndSend();
    }
    // Nội dung tệp không lưu vào kho; bản dội lại từ Pancake mang URL ảnh trên CDN.
    message = { id: sent.id, mid: sent.id, direction: 'outgoing', type: attachment.type || 'document', text: '', name: attachment.name || '', dataUrl: '', createdAt: Date.now(), status: 'sent' };
    if (body) for (const chunk of splitLongText(body)) await sendPancakeMessage({ ...target, text: chunk }, config, fetchImpl);
  } else {
    // Facebook từ chối tin dài quá 2000 ký tự: cắt theo đoạn, gửi lần lượt.
    let sent = null;
    for (const chunk of splitLongText(body)) sent = await sendPancakeMessage({ ...target, text: chunk }, config, fetchImpl);
    message = { id: sent.id, mid: sent.id, direction: 'outgoing', type: 'text', text: body, createdAt: Date.now(), status: 'sent' };
  }
  const saved = await updateMessagingStore(store => {
    // Nhân viên gửi từ CRM: gắn cờ staff như tin admin gửi trong Pancake (bot dùng để im khi nhân viên đang xử lý).
    Object.assign(message, messageSenderFields({ staff, sentBy }));
    if (followUp) message.followUp = true;
    const outcome = saveMessage(store, { pageId: conversation.pageId, psid: conversation.psid, message });
    outcome.conversation.unread = false;
    return { message: outcome.message, conversation: publicConversation(outcome.conversation) };
  });
  publishMessagingEvent({ type: 'message', conversation: saved.conversation, message: saved.message });
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
async function sendCommentReplyViaPancake(conversation, { text, privateReply, staff = false, sentBy = null, followUp = false }, config, fetchImpl) {
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
    ...(privateReply ? { privateReply: true } : { commentId: sent.id, parentId: conversation.lastCommentId }),
    // Nhân viên trả lời bình luận từ CRM: cờ staff như tin hộp thư (bot im khi nhân viên đang xử lý).
    ...messageSenderFields({ staff, sentBy }),
    ...(followUp ? { followUp: true } : {})
  };
  const saved = await updateMessagingStore(store => {
    const outcome = privateReply
      ? saveMessage(store, { pageId: conversation.pageId, psid: conversation.psid, name: conversation.name, picture: conversation.picture, message })
      : saveMessage(store, { pageId: conversation.pageId, psid: conversation.psid, id: conversation.id, source: 'comment', message });
    if (privateReply) {
      if (!outcome.conversation.post && conversation.post) outcome.conversation.post = { ...conversation.post, inheritedFrom: conversation.id };
      // Giới tính đã biết ở luồng bình luận đi theo sang hộp thư (như đường Meta).
      if (conversation.gender) applyGenderGuess(outcome.conversation, conversation.gender, conversation.genderSource || 'message');
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
  const wanted = [...new Set(adIds.map(String).filter(Boolean))];
  const missing = wanted.filter(id => !(adCache.has(id) && Date.now() - adCache.get(id).at < adCacheTtlMs));
  // Pancake nhận tối đa 20 mã một lần: chia lô, không cắt bỏ phần sau.
  for (let start = 0; start < missing.length; start += 20) {
    const chunk = missing.slice(start, start + 20);
    if (start) await pause(250);
    const body = await pancakeGet(`/v1/pages/${encodeURIComponent(config.pageId)}/ads`, { ad_ids: chunk.join(','), type: 'ads' }, config, fetchImpl);
    for (const item of Array.isArray(body.data) ? body.data : []) {
      adCache.set(String(item.id), { at: Date.now(), name: String(item.name || '').trim(), imageUrl: String(item.image_url || ''), campaignName: String(item.campaign_name || '').trim() });
    }
    for (const id of chunk) if (!adCache.has(id)) adCache.set(id, { at: Date.now(), name: '', imageUrl: '', campaignName: '' });
  }
  return Object.fromEntries(wanted.map(id => [id, adCache.get(id)]));
}

const maximumPostCacheEntries = 2000;
function rememberPost(id, entry) {
  postCache.delete(id);
  postCache.set(id, entry);
  // Bộ nhớ bài viết có hạn: bỏ mục cũ nhất khi đầy.
  while (postCache.size > maximumPostCacheEntries) postCache.delete(postCache.keys().next().value);
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
      for (const post of posts) if (post?.id && !postCache.get(String(post.id))?.post) rememberPost(String(post.id), { at: Date.now(), post: pancakePostContext(post) });
      if (posts.length < 30) break;
    }
    until = since;
  }
  rememberPost(id, { at: Date.now(), post: found ? pancakePostContext(found) : null });
  return postCache.get(id).post;
}

/**
 * Điền tên quảng cáo và nội dung bài quảng cáo cho các hội thoại vừa có
 * referral từ Pancake. Tên quảng cáo tra ngay (một lần gọi, nhanh); bài viết
 * tìm nền (có thể nhiều lần gọi), tin sau của khách sẽ có. Lỗi bỏ qua.
 */
// Bài quảng cáo tìm không ra (quá 12 tháng) thì ghi mốc đã tìm, một ngày sau mới tìm lại,
// để vòng đồng bộ không quét lại từng tháng cho cùng hội thoại mãi.
const postLookupRetryMs = 24 * 60 * 60 * 1000;
const needsPostLookup = conversation => Boolean(conversation.referral?.postId) && !conversation.post?.message
  && !(conversation.adPostLookupAt && Date.now() - conversation.adPostLookupAt < postLookupRetryMs);
const needsAdContext = conversation => Boolean(conversation?.referral?.adId)
  && (!conversation.referral.adTitle || needsPostLookup(conversation));

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
  // Tìm bài quảng cáo nền, từng hội thoại một và tối đa 5 mỗi lượt (mỗi lần
  // tìm có thể tới 36 lần gọi API); mốc đã tìm ghi lại dù thấy hay không.
  for (const item of pending.filter(needsPostLookup).slice(0, 5)) {
    postLookupQueue = postLookupQueue.then(async () => {
      const post = await findPancakePost(item.referral.postId, {}, config, fetchImpl).catch(error => {
        console.error(`Không tìm được bài quảng cáo ${item.referral.postId}: ${error.message}`);
        return null;
      });
      await updateMessagingStore(store => {
        const conversation = store.conversations.find(entry => entry.id === item.id);
        if (!conversation) return null;
        conversation.adPostLookupAt = Date.now();
        if (post && !conversation.post?.message) {
          conversation.post = { ...(conversation.post || {}), ...post };
          publishMessagingEvent({ type: 'conversation', conversation: publicConversation(conversation) });
        }
        return null;
      });
    }).catch(error => console.error(`Không ghi được bài quảng cáo ${item.referral.postId}: ${error.message}`));
  }
  return pending.length;
}
let postLookupQueue = Promise.resolve();

/**
 * Một webhook Pancake từ đầu tới cuối: chuẩn hoá, ghi hộp thư, điền bối cảnh
 * quảng cáo, đưa cho bot. Hội thoại đã có nhân viên nhận thì chỉ ghi, không
 * đưa bot (trừ khi cấu hình PANCAKE_BOT_WHEN_ASSIGNED=1). Trả về số tin đã
 * ghi và số tin đưa bot.
 */
export async function handlePancakeWebhook(payload, { processChatbotChanges, chatbotDependencies, beforeBot = null, config = defaultConfig, now = Date.now(), fetchImpl = fetch }) {
  const events = normalizePancakeWebhook(payload, config, now);
  if (payload?.event_type && payload.event_type !== 'verify') notePancakeWebhook(now);
  const changes = await storePancakeEvents(events, { fromWebhook: true });
  // Tra tên quảng cáo ở nền: gọi Pancake (tới 20 s, retry 429) không được làm khách chờ bot.
  // Chờ tối đa 1,5 s cho tên quảng cáo (thường về ngay); lâu hơn thì để chạy nền, bot đọc adTitle ở lượt sau.
  if (changes.length) {
    // Quảng cáo/bài viết thuộc Page nào thì tra bằng mã + token của Page đó (nhiều Page dùng chung
    // một webhook): tra nhầm Page đầu tiên thì không thấy, lại bị ghi mốc chặn tra lại 24 giờ.
    const byPage = new Map();
    for (const change of changes) {
      const pageId = String((change.conversation || change)?.pageId || '');
      byPage.set(pageId, [...(byPage.get(pageId) || []), change]);
    }
    const enrich = Promise.all([...byPage].map(([pageId, list]) => enrichPancakeAdContext(list, getPancakePageConfig(pageId, config), fetchImpl)
      .catch(error => console.warn(`Pancake: không tra được quảng cáo: ${error.message}`))));
    await Promise.race([enrich, pause(1500)]);
  }
  // Móc trước bot (server dùng để chào khách quét QR và bỏ tin đó khỏi bot):
  // nhận MỌI thay đổi, kể cả hội thoại đã có nhân viên nhận, trả về phần bot xử lý.
  const candidates = typeof beforeBot === 'function' ? (await beforeBot(changes)) || [] : changes;
  const assigned = new Set(events.filter(event => event.pancake.assigned).map(event => `${event.pageId}:${event.psid}`));
  const forBot = config.botWhenAssigned
    ? candidates
    : candidates.filter(change => !change.conversation || !assigned.has(`${change.conversation.pageId}:${change.conversation.psid}`));
  if (forBot.length && processChatbotChanges) await processChatbotChanges(forBot, chatbotDependencies);
  // Đếm tin đã ghi; thay đổi hội thoại (giới tính, tên) không tính là tin.
  const messagesOnly = list => list.filter(change => change.type === 'message').length;
  return { stored: messagesOnly(changes), bot: messagesOnly(forBot) };
}
