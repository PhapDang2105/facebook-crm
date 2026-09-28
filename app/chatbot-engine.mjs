import { buildTemplatePrompt, isProductQuoteId, maxAddressAsks, pickVariant, renderChatbotReply } from './chatbot-templates.mjs';
import { chatTimeoutMs, inferAddress } from './processing/address-ai.mjs';
import { describeDeliveryAddress, mergeAddressFragment } from './processing/locations.mjs';
import { extractVietnamesePhone } from './processing/customer-info.mjs';
import { autoLabelEventsFor, foldVietnamese, isComplaint } from './processing/auto-label.mjs';
import { productHint, resolveConversationProduct } from './processing/product-detect.mjs';
import { buildCatalogPrompt } from './processing/pricing.mjs';
import { isOrderStep, usablePendingOrder } from './processing/pending-order.mjs';
import { findProductBySku, getCatalogProducts, getGifts, matchProduct } from './processing/catalog.mjs';
import { isLivestreamConversation } from './conversation-orders.mjs';
import { ruleIntent } from './processing/rule-intent.mjs';
import { activeTrial, filterTrialReply, promoBowlActive, trialBagOptions, trialModelHint, trialStep } from './processing/trial-flow.mjs';
import { intentSafeTemplates, predictIntent } from './processing/intent-model.mjs';
import { formatExamples, loadExampleBank, nearestExamples } from './processing/example-bank.mjs';
import { appendDecisionLog } from './processing/decision-log.mjs';
import { gateCheck } from './processing/llm-router.mjs';

// Mô hình tầng (processing/intent-cascade.mjs, đang viết): nạp động MỘT lần, thiếu tệp / lỗi nạp → null
// (engine chạy như không có). Test đưa mô hình giả qua dependencies.predictCascade (+ cascadeGroupOf).
let cascadeModulePromise = null;
function loadCascadeModule() {
  return (cascadeModulePromise ||= import('./processing/intent-cascade.mjs').catch(() => null));
}
// Nhóm ý định mà mô hình tầng được tự trả lời khi 'on': ANSWER (tầng 1 bản mới) hay PRICE/INFO/SOCIAL (bản cũ);
// ORDER do máy trạng thái slot của engine, SUPPORT/OTHER về LLM — không bao giờ tự trả lời.
export const cascadeAutoGroups = new Set(['ANSWER', 'PRICE', 'INFO', 'SOCIAL']);
// Ngưỡng nhóm (tầng 1) cố định; ngưỡng mẫu trong nhóm lấy từ settings.cascadeThreshold.
export const CASCADE_GROUP_THRESHOLD = 0.85;
// Mẫu tầng KHÔNG được tự trả lời khi khách đã có đơn gần đây (câu trả lời chung chung sai ngữ cảnh đơn).
const cascadeNoRecentOrderTemplates = new Set(['SHIPPING_POLICY', 'WELCOME', 'DELIVERY_DELAY']);
// Mẫu loại hẳn khỏi tự trả lời của tầng (WELCOME hay bị chọn cho tin có màu/số túi).
const cascadeExcludedTemplates = new Set(['WELCOME']);

/** Hash ổn định (FNV-1a 32 bit) của mã hội thoại → 0..99, để chia canary. */
export function canaryBucket(id) {
  let hash = 0x811c9dc5;
  for (const char of String(id || '')) { hash ^= char.codePointAt(0); hash = Math.imul(hash, 0x01000193) >>> 0; }
  return hash % 100;
}

// Mẫu mới vòng 8 (26–28/09): agent luật đang thêm vào seed; cài đặt chưa có thì
// dùng lời dự phòng này để bot không chuyển người / im vì "mẫu lạ". Mẫu bị chủ
// shop để trống ('') trong Cài đặt vẫn là tắt (không thay bằng dự phòng).
export const fallbackTemplates = Object.freeze({
  WAITING_STAFF: 'Dạ em đã chuyển tin của {title} cho bạn phụ trách rồi ạ, bạn ấy sẽ kiểm tra và nhắn lại {title} ngay trong tin này. {Title} chờ em ít phút nha ạ 💛',
  PAYMENT_RECEIVED_CHECK: 'Dạ em đã nhận thông tin chuyển khoản của {title} ạ. Em chuyển bạn phụ trách kiểm tra giao dịch và lên đơn gửi {title} ngay, {title} chờ em ít phút nha ạ 💛',
  COMMENT_PUBLIC_THANKS: 'Dạ em cảm ơn {title} nhiều ạ 💛 Chúc {title} ăn ngon miệng và thật nhiều năng lượng nha ạ 🌾',
  ORDER_POSTPONED: 'Dạ em đã ghi nhận rồi ạ, khi nào {title} cần thì nhắn em tên túi và số lượng kèm SĐT, địa chỉ, em lên đơn liền cho mình nha ạ 🌾',
  NO_VARIANT: 'Dạ hiện nhà em chưa có vị {ingredient} ạ. Ba vị đang bán là Túi Xanh nguyên bản, Túi Vàng nhiều hạt và Túi Nâu cacao, {title} ưng loại nào nhắn em nha ạ 💛',
  WHOLESALE_RECEIVED: 'Dạ em đã ghi nhận nhu cầu lấy sỉ/CTV của {title} ạ. Bạn phụ trách kinh doanh sẽ liên hệ lại {title} sớm trong tin này nha ạ 💛',
  ORDER_ADDRESS_OLD_ASK_PHONE: 'Dạ em chưa thấy địa chỉ cũ của {title} trong hội thoại này ạ. {Title} cho em xin số điện thoại đã đặt lần trước để em tra và gửi đúng địa chỉ đó nha ạ 💛',
  ORDER_INFO_ASK_FLAVOR: 'Dạ em đã ghi nhận SĐT/địa chỉ của {title} rồi ạ. {Title} cho em biết mình lấy loại nào (Túi Xanh nguyên bản / Túi Vàng nhiều hạt / Túi Nâu cacao) và số lượng để em lên đơn liền nha ạ 🌾',
  ASK_FLAVOR_NGUYENBAN: 'Dạ Túi Xanh nguyên bản là vị cơ bản nhất, không thêm đường, hạt và yến mạch giòn tự nhiên ạ. {Title} lấy Túi Xanh hay muốn em tư vấn thêm Túi Vàng nhiều hạt / Túi Nâu cacao ạ?',
  RECOMMEND_BEGINNER: 'Dạ mới ăn lần đầu thì {title} thử Túi Xanh nguyên bản ạ, vị dễ ăn nhất, không thêm đường 🌾 {Title} lấy 1 túi dùng thử hay combo 2 túi để được miễn ship ạ?',
  CONFIRM_YES: 'Dạ vâng ạ 💛',
  COMBO3_FLAVOR: 'Dạ combo 3 túi {title} chọn vị tùy ý ạ (Xanh / Vàng / Nâu, được lấy trùng vị). {Title} nhắn em 3 túi vị gì để em lên đơn nha ạ 🌾'
});

/** Bộ mẫu để soạn câu: mẫu trong Cài đặt, mẫu mới chưa có thì lấy lời dự phòng. */
export function withFallbackTemplates(templates) {
  return { ...fallbackTemplates, ...(templates && typeof templates === 'object' ? templates : {}) };
}

// Giỏ Facebook Shop (attachment cart_order) mang SKU: một SKU sản phẩm → bảng
// giá sản phẩm đó; SKU combo của Shop ("CB2-XANH-Z450" = 2 Túi Xanh,
// "CB-VANGG+NAU" = Vàng + Nâu) → xin SĐT/địa chỉ với đúng giỏ. SKU lạ → để model.
export function cartQuickReply(cart, templates = {}, context = {}) {
  const items = [];
  for (const line of Array.isArray(cart) ? cart : []) {
    const sku = String(line?.sku || '').toUpperCase();
    const quantity = Math.max(1, Number(line?.quantity) || 1);
    const product = findProductBySku(sku);
    if (product) { items.push({ product: product.name, quantity }); continue; }
    const combo = sku.match(/^CB(\d*)-([A-Z0-9+]+?)(?:-Z\d+|-H\d+)?$/);
    if (!combo) return null;
    const each = Math.max(1, Number(combo[1]) || 1);
    for (const token of combo[2].split('+')) {
      const colour = token.replace(/G$/, '').toLowerCase();
      const found = getCatalogProducts().find(item => item.active !== false && /^gra-/i.test(item.sku || '') && String(item.sku || '').toLowerCase().includes(`-${colour}-`));
      if (!found) return null;
      items.push({ product: found.name, quantity: each * quantity });
    }
  }
  if (!items.length || !templates.PRICE_QUOTE) return null;
  // Khách bấm "Mua" là đã chọn: đi thẳng bước xin SĐT/địa chỉ (kèm gợi ý 2 túi
  // khi chỉ 1 túi), không gửi bảng giá rồi hỏi "cần thêm thông tin nào" —
  // giỏ 1 SKU trước đây chỉ chốt được 22%.
  const slots = ['Product_N1', 'No_A', 'Product_N2', 'No_B', 'Product_N3', 'No_C'];
  const value = { template_id: 'ORDER_ADDRESS' };
  items.slice(0, 3).forEach((item, index) => { value[slots[index * 2]] = item.product; value[slots[index * 2 + 1]] = String(item.quantity); });
  return renderChatbotReply(value, templates, context);
}
/**
 * Giỏ khách ghi thẳng trong bình luận: "C 2 túi vàng", "túi vàng với túi xanh lá
 * cây", "2 xanh 1 nâu". Chỉ ba túi lớn (Xanh/Vàng/Nâu; "xanh dương" là hàng
 * live khác); cần ý mua (lấy/mua/chốt/cho em…, có số lượng, hay từ hai màu).
 */
export function commentBasket(text) {
  // "nấu" (sữa hạt nấu…) bỏ dấu cũng thành "nau": giữ khác "nâu" trước khi bỏ dấu.
  // "nấu" (sữa hạt nấu…) bỏ dấu cũng thành "nau": giữ khác "nâu" trước khi bỏ dấu.
  // "sô cô la / socola / chocolate" là túi Nâu cacao.
  const folded = foldVietnamese(String(text || '').replace(/nấu/giu, 'nauu')).replace(/\bs[oô] ?c[oô] ?la\b|\bsocola\b|\bchocolate\b/g, 'cacao').replace(/\s+/g, ' ');
  // "Xanh dương" là hàng live khác; vị lạ (dâu, mint, tropical) không có túi lớn: giỏ có nó thì để
  // model/nhân viên, không tự lập giỏ thiếu món. "Đậu xanh" là thành phần, không phải túi.
  if (/\bxanh duong\b|\bmint\b|\btropical\b|\bdau tay\b/.test(folded) || /\bdâu\b/iu.test(String(text || ''))) return [];
  // "2 hộp xanh", "hộp 10 gói nâu", "1 hộp": Combo 10 gói (màu ghi kèm; không ghi thì Mix).
  const boxed = /\bhop\b/.test(folded) && !/\b(tui|bich)\b/.test(folded);
  const cleaned = folded.replace(/\bdau xanh\b/g, ' ').replace(/\bhop (?:10|muoi) goi(?: nho)?\b/g, 'hop');
  const counts = new Map();
  // Khách viết một kiểu cho cả câu: số TRƯỚC màu ("2 xanh 1 vàng", "2 túi vàng")
  // hay số SAU màu ("vàng 2 nâu 1", "xanh lá x2"). Đọc lẫn hai kiểu thì "1 xanh
  // 2 nâu" gán nhầm số 2 cho xanh.
  const firstColour = cleaned.search(/(?<![a-z])(xanh|vang|nau|cacao)(?![a-z])/);
  const firstNumber = cleaned.search(/(?<!\d)\d{1,2}(?!\d)/);
  const numberFirst = firstNumber >= 0 && firstNumber < firstColour;
  const pattern = numberFirst
    ? /(?:(?<!\d)(\d{1,2})\s*(?:tui|goi|bich)?\s*)?(?:(?:tui|mau)\s+)?(?<![a-z])(xanh|vang|nau|cacao)(?![a-z])/g
    : /(?<![a-z])(xanh|vang|nau|cacao)(?![a-z])(?:\s*la(?:\s*cay)?)?(?:\s*x?\s*(\d{1,2})(?!\d|\s*(?:g|gr|gram|k)\b))?/g;
  for (const match of cleaned.matchAll(pattern)) {
    const [colourText, quantityText] = numberFirst ? [match[2], match[1]] : [match[1], match[2]];
    const colour = colourText === 'cacao' ? 'nau' : colourText;
    counts.set(colour, (counts.get(colour) || 0) + (Number(quantityText) || 1));
  }
  // Hộp 10 gói: "2 hộp xanh" → Combo 10 gói Xanh x2; "hộp mix" / "1 hộp" → Combo 10 gói Mix.
  if (boxed) {
    const boxCount = Number(cleaned.match(/(?<!\d)(\d{1,2})\s*hop\b/)?.[1] || cleaned.match(/\bhop\b[^\d]{0,12}(?<!\d)(\d{1,2})(?!\d|\s*(?:goi|g|gr|gram|k)\b)/)?.[1]) || 0;
    const colourOfBox = counts.size === 1 ? [...counts.keys()][0] : (/\bmix\b/.test(cleaned) || !counts.size ? 'mix' : '');
    if (!colourOfBox) return [];
    const wantsBox = boxCount > 0 || /\b(lay|mua|chot|dat|gui|ship|cho (em|minh|chi|c|e|toi|tui|anh|a))\b/.test(folded);
    const box = getCatalogProducts().find(item => item.active !== false && /^cb10-/i.test(item.sku || '') && String(item.sku || '').toLowerCase().includes(`-${colourOfBox}`));
    return wantsBox && box ? [{ product: box.name, quantity: boxCount || (counts.size === 1 ? [...counts.values()][0] : 1) }] : [];
  }
  if (!counts.size) return [];
  const wantsIt = counts.size >= 2 || [...counts.values()].some(quantity => quantity > 1) || /\b(lay|mua|chot|dat|gui|ship|combo|cho (em|minh|chi|c|e|toi|tui|anh|a)|\d{1,2} ?(tui|goi|bich))\b/.test(folded);
  if (!wantsIt) return [];
  const items = [];
  for (const [colour, quantity] of counts) {
    const product = getCatalogProducts().find(item => item.active !== false && /^gra-/i.test(item.sku || '') && String(item.sku || '').toLowerCase().includes(`-${colour}-`));
    if (!product) return [];
    items.push({ product: product.name, quantity });
  }
  return items;
}

import { getVertexAccessToken, vertexProjectId } from './vertex-auth.mjs';
import { assertPublicHost } from './network-guard.mjs';
import { normalizeWarningPhone, posConfig, posConfigured, posRequest } from './phone-warnings.mjs';
import { INCOMPLETE_LABEL, readLandingStore } from './landing-orders.mjs';

// ===== Đơn ngoài hội thoại (landing / nhân viên lên trên POS) cùng SĐT =====
// Chủ shop 28/09: 10 ca trong 7 ngày bot lên đơn trùng với đơn khách đã đặt qua landing hay
// nhân viên lên trên POS (Văn Lý: landing 15:20, bot 15:24; Nguyễn Trang: NV 20:47, bot 20:50).
// ORDER_EXISTING_CONFIRM trước đây chỉ xét customerOrders trong hội thoại. Trước khi tạo đơn
// mới: tra kho landing cục bộ và POS theo SĐT (7 ngày, chưa hủy, không bỏ dở); có thì hỏi
// khách xác nhận đặt thêm như đơn trong hội thoại. Kết quả nhớ 10 phút theo SĐT.
const externalOrderCache = new Map();
const externalOrderCacheTtlMs = 10 * 60 * 1000;
const externalOrderWindowMs = 7 * 24 * 60 * 60 * 1000;
const externalOrderTimeoutMs = 5000;

export function clearExternalOrderCache() {
  externalOrderCache.clear();
}

/** Giờ POS (inserted_at là UTC không có Z) → mốc ms. */
function posTimeMs(value) {
  const text = String(value || '').trim();
  if (!text) return 0;
  return Date.parse(/[zZ]$|[+-]\d{2}:?\d{2}$/.test(text) ? text : `${text}Z`) || 0;
}

/**
 * Đơn 7 ngày cùng SĐT ở ngoài hội thoại: (a) kho landing cục bộ (đơn chưa hủy, không "Chưa hoàn tất");
 * (b) Pancake POS (`/orders?search=SĐT`, không hủy/hoàn, không bỏ dở, không phải đơn CRM đẩy sang).
 * Trả { orders (mới nhất trước, dạng customerOrder), error } — lỗi mạng/hết giờ POS ghi ở `error`,
 * không chặn lên đơn (bên gọi gắn thẻ để nhân viên soát trùng).
 */
export async function findExternalOrders(phone, { now = Date.now(), fetchImpl = fetch, config = null, landingStore = readLandingStore, excludeIds = [], timeoutMs = externalOrderTimeoutMs } = {}) {
  const key = normalizeWarningPhone(phone);
  if (!key) return { orders: [], error: '' };
  const cached = externalOrderCache.get(key);
  if (cached && now - cached.at < externalOrderCacheTtlMs) return cached.result;
  const excluded = new Set((excludeIds || []).map(String));
  const orders = [];
  let error = '';
  // (a) Kho landing (webhook Webcake + đồng bộ POS 5 phút): đơn đã có trong CRM.
  try {
    const store = await landingStore();
    for (const order of Array.isArray(store?.orders) ? store.orders : []) {
      if (!order || excluded.has(String(order.id)) || normalizeWarningPhone(order.phone) !== key) continue;
      if (now - (Number(order.createdAt) || 0) > externalOrderWindowMs) continue;
      if (String(order.processingStatus || '') === 'cancelled' || order.status === 'Hủy' || order.status === INCOMPLETE_LABEL || order.landing?.incomplete) continue;
      orders.push({ id: String(order.id), posId: String(order.landing?.posId || order.pos?.id || ''), createdAt: Number(order.createdAt) || 0, total: Number(order.total) || 0, status: String(order.status || ''), source: order.source || 'Landing page', phone: order.phone, address: order.address || '', products: (order.products || []).map(item => ({ name: item.name, sku: item.sku || '', quantity: Number(item.quantity) || 1 })) });
    }
  } catch (caught) {
    error = `kho landing: ${caught.message}`;
  }
  // (b) POS: đơn nhân viên lên tay / landing chưa kịp đồng bộ / Facebook Shop.
  const posSettings = config || posConfig();
  if (posConfigured(posSettings)) {
    try {
      const data = await Promise.race([
        posRequest('/orders', { search: key, page_size: 20 }, posSettings, fetchImpl),
        new Promise((_resolve, reject) => { const timer = setTimeout(() => reject(new Error(`hết ${timeoutMs}ms`)), timeoutMs); timer.unref?.(); })
      ]);
      for (const order of Array.isArray(data?.data) ? data.data : []) {
        if (normalizeWarningPhone(order.bill_phone_number || order.shipping_address?.phone_number) !== key) continue;
        if ([order.custom_id, order.id].some(value => String(value || '').startsWith('CRM-'))) continue;
        if (order.is_abandoned_order || Number(order.status) === 6 || /cancel|return|hủy|hoàn/i.test(String(order.status_name || ''))) continue;
        const createdAt = posTimeMs(order.inserted_at);
        if (!createdAt || now - createdAt > externalOrderWindowMs) continue;
        const id = `POS-${order.system_id || order.id}`;
        if (orders.some(item => item.posId === String(order.id))) continue;
        orders.push({
          id, posId: String(order.id), createdAt, total: Number(order.cod ?? order.total_price) || 0, status: String(order.status_name || ''), source: 'POS', phone: key,
          address: String(order.shipping_address?.full_address || ''),
          pos: { id: String(order.id), systemId: String(order.system_id || ''), status: String(order.status_name || '') },
          products: (order.items || []).filter(item => !item.is_bonus_product).map(item => {
            const sku = String(item.variation_info?.display_id || '').trim();
            return { name: findProductBySku(sku)?.name || matchProduct(String(item.variation_info?.detail || ''))?.name || String(item.variation_info?.name || '').trim() || sku || 'sản phẩm', sku, quantity: Number(item.quantity) || 1 };
          })
        });
      }
    } catch (caught) {
      error = [error, `POS: ${caught.message}`].filter(Boolean).join('; ');
    }
  }
  // Đơn landing đã đồng bộ từ POS (landing.posId) và chính đơn POS đó: giữ một bản.
  const seen = new Set();
  const unique = orders.sort((a, b) => b.createdAt - a.createdAt).filter(order => { const mark = order.posId || order.id; if (seen.has(mark)) return false; seen.add(mark); return true; });
  const result = { orders: unique, error };
  // Lỗi thì không nhớ: lượt sau tra lại.
  if (!error) externalOrderCache.set(key, { at: now, result });
  return result;
}

const endpointHostChecks = new Map();
/** Kiểm host endpoint AI tuỳ chỉnh không trỏ vào mạng nội bộ; nhớ kết quả 60 giây. */
async function assertEndpointHost(endpoint) {
  let hostname = '';
  try { hostname = new URL(endpoint).hostname; } catch { throw new Error('Endpoint AI không hợp lệ.'); }
  const checkedAt = endpointHostChecks.get(hostname) || 0;
  if (Date.now() - checkedAt < 60 * 1000) return;
  await assertPublicHost(hostname);
  endpointHostChecks.set(hostname, Date.now());
}

/**
 * Địa chỉ khách nhắn mà bộ đọc luật không tách đủ ba cấp thì hỏi AI trước khi
 * bot hỏi lại khách; câu trả lời chỉ được dùng khi khớp danh mục kho. Đổi
 * thẳng Customer_Address trong JSON của mô hình nên phần sau (ghép địa chỉ,
 * hỏi lại, lên đơn) không cần biết địa chỉ đến từ đâu.
 */
export async function refineAddressWithAi(parsed, context = {}, settings = {}, fetchImpl) {
  const fresh = String(parsed?.Customer_Address || '').trim();
  const merged = mergeAddressFragment(fresh !== '0' ? fresh : '', context.pendingOrder?.address || '');
  if (!merged || describeDeliveryAddress(merged).complete) return parsed;
  const guess = await inferAddress(merged, { settings, fetchImpl, timeoutMs: chatTimeoutMs }).catch(() => null);
  if (guess?.canonical) parsed.Customer_Address = guess.canonical;
  return parsed;
}

/** Bài đăng/quảng cáo là phiên livestream nhiều sản phẩm ("Săn deal hời", "live tối nay"): không có sản phẩm cụ thể để báo giá. */
export function isLivestreamPost(conversation) {
  return isLivestreamConversation(conversation);
}

export function parseModelAnswer(answer) {
  const raw = String(answer || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  // Mô hình trả JSON hỏng (hay JSON hợp lệ nhưng không phải object: null, mảng,
  // chuỗi): gửi bảng giá chung thay vì chuyển người và tắt bot.
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : { template_id: 'GENERAL_INFO' };
  } catch { return { template_id: 'GENERAL_INFO' }; }
}

export function buildChatbotQuery({ conversation, message, recentMessages = [], settings, includeHistory = true, examples = [] }) {
  const historyLimit = settings?.memoryEnabled === false ? 0 : Math.max(1, Number(settings?.memoryWindow) || 12);
  const history = historyLimit
    ? recentMessages.slice(-historyLimit).map(item => `${item.direction === 'incoming' ? 'Khách' : 'Giọt Nắng'}: ${item.text || `[${item.type}]`}`).join('\n')
    : '';
  // What the customer names beats the ad they arrived from; the ad is used only
  // when the message itself says nothing about a product.
  const { product } = resolveConversationProduct({
    messageText: message.text,
    adTitle: conversation.referral?.adTitle,
    referralRef: conversation.referral?.ref,
    postText: conversation.post?.message
  });
  const hint = productHint(product);
  // What the customer already gave in earlier messages, so the model neither
  // asks for it again nor drops it from the JSON.
  const pending = conversation.pendingOrder || {};
  const remembered = [
    pending.items?.length ? `Sản phẩm đang chờ lên đơn: ${pending.items.map(item => `${item.product} x${item.quantity}`).join(', ')}` : '',
    pending.phone ? `Số điện thoại đã có: ${pending.phone}` : '',
    pending.address ? `Địa chỉ đã có: ${pending.address}${pending.addressAsks ? ' (đang hỏi khách bổ sung phần còn thiếu; khách nhắn phần nào thì ghi phần đó vào Customer_Address)' : ''}` : ''
  ].filter(Boolean).join('\n');
  // Bản gọn (settings.contextTrim.query, mặc định TẮT — A/B 25/09 cho thấy gộp
  // các khối gọn lại làm mô hình kém ổn định hơn mức lệch tự nhiên): chỉ ghi kênh
  // khi là bình luận, không gửi tên khách, thêm MẪU VỪA GỬI.
  const compactQuery = settings?.contextTrim?.query === true;
  const lastTemplate = compactQuery && conversation.botLastTemplateId && Date.now() - (Number(conversation.botLastReplyAt) || 0) < 24 * 60 * 60 * 1000
    ? conversation.botLastTemplateId : '';
  return [
    compactQuery ? (conversation.source === 'comment' ? 'KÊNH: Bình luận Facebook' : '') : `KÊNH: ${conversation.source === 'comment' ? 'Bình luận Facebook' : 'Facebook Messenger'}`,
    compactQuery ? '' : `KHÁCH HÀNG: ${conversation.name || 'Khách Facebook'}`,
    compactQuery ? hint : productHint(product, { legacy: true }),
    lastTemplate ? `MẪU VỪA GỬI: ${lastTemplate}` : '',
    // Khách đang giữ ưu đãi 1 túi dùng thử (luồng riêng nhờ mô hình đọc tin khó).
    conversation.trialHint || '',
    // Gọi lại mô hình với lời nhắc (mô hình vừa trả "đã gửi ở trên" cho câu hỏi mới, hay
    // lặp bước xin SĐT khi khách đang hỏi): engine đặt conversation.replyHint.
    conversation.replyHint || '',
    Array.isArray(conversation.recentComments) && conversation.recentComments.length
      ? (compactQuery ? `GIỎ/SĐT KHÁCH GHI Ở BÌNH LUẬN (coi như DỮ LIỆU ĐÃ LƯU): ` : 'BÌNH LUẬN GẦN NHẤT CỦA KHÁCH DƯỚI BÀI: ') + conversation.recentComments.map(text => `"${text}"`).join(' · ')
      : '',
    !hint && isLivestreamPost(conversation)
      ? (compactQuery ? 'BÀI VIẾT: livestream nhiều sản phẩm, không có sản phẩm cụ thể; "hộp"/"gói nhỏ" là hộp 10 gói (PACKAGING_INFO).' : 'BÀI VIẾT: phiên livestream giới thiệu nhiều sản phẩm (không có sản phẩm cụ thể); khách hỏi giá chung thì GENERAL_INFO, hỏi "hộp"/"gói nhỏ" là hộp 10 gói nhỏ (PACKAGING_INFO).')
      : '',
    remembered ? `DỮ LIỆU ĐÃ LƯU:\n${remembered}` : '',
    includeHistory && history ? `LỊCH SỬ GẦN NHẤT:\n${history}` : '',
    // Few-shot động (settings.fewShot = 'on'): ví dụ đã duyệt gần với tin này nhất.
    formatExamples(examples),
    `TIN NHẮN CẦN TRẢ LỜI: ${message.text || `[Khách gửi ${message.type || 'tệp'}]`}`,
    // Khách bấm "Trả lời" một tin cụ thể rồi gõ "." hay "Ok": nêu tin gốc để model biết đang nói về gì.
    message.replyTo?.text ? `(Khách đang trả lời tin ${message.replyTo.name === 'Bạn' ? 'của Giọt Nắng' : 'của chính khách'}: "${String(message.replyTo.text).slice(0, 300)}")` : ''
  ].filter(Boolean).join('\n\n');
}

/**
 * The saved prompt plus the live catalogue and template blocks. Exported so
 * the settings screen can preview exactly what the model receives. The saved
 * prompt holds only the rules; products, prices, gifts and template ids are
 * appended from Cài đặt and Thiết lập tin nhắn on every request.
 */
export function composeSystemPrompt(basePrompt, templates = {}, contextTrim = {}) {
  // "Đã gửi ở trên" (REPLY_ALREADY_SENT / _INFO) là việc engine tự quyết bằng luật (khách giục /
  // lặp câu, vòng 8): mô hình không được chọn nữa → bỏ mọi dòng của prompt nhắc tới hai mẫu này
  // (danh sách MẪU TIN đã không liệt kê chúng). Vòng 9: mỗi lần mô hình chọn nhầm tốn thêm một lượt LLM.
  const prompt = String(basePrompt || '').split('\n').filter(line => !nudgeTemplateIds.some(id => line.includes(id))).join('\n').trim();
  return [
    prompt,
    buildCatalogPrompt({ compact: contextTrim?.catalog === true }),
    buildTemplatePrompt(templates, prompt, { compact: contextTrim?.templates === true })
  ].filter(Boolean).join('\n\n');
}

// Hai mẫu "đã gửi ở trên": engine tự chọn theo luật, mô hình không được chọn.
const nudgeTemplateIds = ['REPLY_ALREADY_SENT_INFO', 'REPLY_ALREADY_SENT'];
// Mã mẫu engine soạn riêng (không có text trong Thiết lập tin nhắn) mà mô hình vẫn được gọi tên.
const virtualModelTemplateIds = ['ORDER_ADDRESS', 'ORDER_CONFIRMATION', 'ORDER_UPDATE', 'ORDER_CANCEL', 'ORDER_NOTE', 'CSKH_HANDOFF', 'PRICE_QUOTE', 'GENERAL_INFO'];

/**
 * Mã mẫu mô hình được phép trả (cho responseSchema enum): mẫu có trong Thiết lập tin nhắn hay
 * mẫu ảo của bước đơn, VÀ được nêu tên trong prompt đã ghép (buildTemplatePrompt liệt kê mọi mẫu
 * dùng được; prompt gốc nêu cách dùng). Không gồm "đã gửi ở trên", bám đuổi, bình luận, bảng giá
 * theo sản phẩm (mô hình dùng PRICE_QUOTE + Product_N1).
 */
export function modelTemplateChoices(templates = {}, systemPrompt = '') {
  const prompt = String(systemPrompt || '');
  const banned = id => nudgeTemplateIds.includes(id) || /^(FOLLOW_UP_|COMMENT_)/.test(id) || isProductQuoteId(id);
  const ids = [...new Set([...Object.keys(templates || {}), ...virtualModelTemplateIds])]
    .map(id => String(id || '').trim())
    .filter(id => /^[A-Z0-9_]+$/.test(id) && !banned(id) && new RegExp(`(?<![A-Z0-9_])${id}(?![A-Z0-9_])`).test(prompt));
  return ids.sort();
}

/**
 * responseSchema (OpenAPI con của Vertex) cho câu trả lời JSON: template_id là enum các mẫu cho
 * phép, các trường còn lại là chuỗi tùy chọn (đúng những trường renderChatbotReply đọc).
 * Vertex không nhận additionalProperties nên mọi trường mô hình có thể trả phải kê ở đây.
 */
export function responseSchemaFor(templateIds = []) {
  const text = { type: 'string' };
  return {
    type: 'object',
    properties: {
      template_id: { type: 'string', enum: [...templateIds] },
      Product_N1: text, No_A: text, Product_N2: text, No_B: text, Product_N3: text, No_C: text,
      Phone_Number: text, Customer_Address: text, also: text, warming: text
    },
    required: ['template_id']
  };
}

// Tin hệ thống/nhiễu trong lịch sử: không giúp chọn mẫu (17% ký tự lịch sử).
const memoryNoise = /^(Bạn đang phản hồi bình luận|Dạ em đã (ib|nhắn tin nhờ)|Đã gửi xác nhận đơn hàng|Khách bấm vào quảng cáo|\[Tệp đính kèm\]|.{0,60} đã trả lời một quảng cáo\.?$)/u;

/**
 * Một lượt của Page, gọn: đầu tin (đang nói về gì: "Bảng giá Túi Xanh…") + câu
 * hỏi cuối (bot vừa hỏi gì: "…lấy 2 túi không ạ?"). Cắt 160 ký tự đầu như trước
 * làm mất câu hỏi ở 18% tin dài — khách đáp "ok" mà model không biết ok với gì.
 */
export function compressPageTurn(text) {
  const clean = String(text || '').replace(/\s+/g, ' ').replace(/^Dạ,?\s*/u, '').trim();
  if (clean.length <= 160) return clean;
  const head = clean.slice(0, 70).replace(/\s+\S*$/, '');
  const mark = clean.lastIndexOf('?');
  if (mark < 70) return `${head}…`;
  const start = Math.max(70, mark - 80, clean.lastIndexOf('. ', mark - 1) + 2, clean.lastIndexOf('! ', mark - 1) + 2);
  return `${head}… ${clean.slice(start, mark + 1).trim()}`;
}

function buildMemoryTurns({ recentMessages = [], message, settings }) {
  if (settings?.memoryEnabled === false) return [];
  const limit = Math.max(1, Number(settings?.memoryWindow) || 12);
  // Bản cũ (mặc định): từng tin, tin Page cắt 160 ký tự, tin khách 300. Bản gọn
  // (settings.contextTrim.memory) chưa bật: A/B 25/09 chưa chứng minh giữ độ chính xác.
  if (settings?.contextTrim?.memory !== true) {
    return recentMessages
      .filter(item => item && item.id !== message?.id && String(item.text || '').trim())
      .slice(-limit)
      .map(item => {
        const text = String(item.text).replace(/\s+/g, ' ').trim();
        const cut = item.direction === 'incoming' ? 300 : 160;
        return { role: item.direction === 'incoming' ? 'user' : 'model', text: text.length > cut ? `${text.slice(0, cut)}…` : text };
      });
  }
  // Bỏ tin hệ thống, gộp các tin liền nhau của cùng một bên thành một lượt (bảng
  // giá + lời mời, xác nhận + chính sách giao/đổi trả), rồi nén lượt của Page;
  // cửa sổ đếm theo lượt đã gộp. Tin khách giữ tối đa 300 ký tự.
  const turns = [];
  for (const item of recentMessages) {
    const text = String(item?.text || '').replace(/\s+/g, ' ').trim();
    if (!item || item.id === message?.id || !text || ['ad', 'order-receipt', 'attachment'].includes(item.type) || memoryNoise.test(text)) continue;
    const role = item.direction === 'incoming' ? 'user' : 'model';
    const previous = turns.at(-1);
    if (previous?.role === role) previous.parts.push(text);
    else turns.push({ role, parts: [text] });
  }
  return turns.slice(-limit).map(turn => {
    const text = turn.parts.join(' ');
    if (turn.role === 'model') return { role: 'model', text: compressPageTurn(text) };
    return { role: 'user', text: text.length > 300 ? `${text.slice(0, 300)}…` : text };
  });
}

function mergeAnthropicTurns(turns) {
  const merged = [];
  for (const turn of turns) {
    const role = turn.role === 'user' ? 'user' : 'assistant';
    const previous = merged.at(-1);
    if (previous?.role === role) previous.content += `\n${turn.text}`;
    else merged.push({ role, content: turn.text });
  }
  return merged;
}

// Ảnh khách gửi (ảnh quảng cáo, bao bì, bill chuyển khoản…) đưa thẳng cho
// Gemini xem cùng câu hỏi: model nhận ra sản phẩm trong ảnh thay vì bot chỉ
// đáp "đã nhận hình". Tối đa 3 ảnh, mỗi ảnh nén dưới 500 KB; ảnh không tải
// được thì bỏ qua, chữ vẫn gửi.
export async function collectImageParts(message, fetchImpl = fetch) {
  const urls = [...new Set([message?.dataUrl, ...(Array.isArray(message?.images) ? message.images : [])].map(item => String(item || '').trim()).filter(Boolean))].slice(0, 3);
  if (!urls.length) return [];
  const parts = [];
  for (const url of urls) {
    try {
      let file;
      const inline = url.match(/^data:(image\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=\s]+)$/i);
      if (inline) file = { buffer: Buffer.from(inline[2].replace(/\s+/g, ''), 'base64'), mime: inline[1].toLowerCase() };
      else {
        const { readImageForUpload, fitImageForPancake } = await import('./pancake.mjs');
        file = await fitImageForPancake(await readImageForUpload(url, fetchImpl));
      }
      if (!file?.buffer?.length || !/^image\//.test(file.mime || '')) continue;
      parts.push({ inlineData: { mimeType: file.mime, data: file.buffer.toString('base64') } });
    } catch (error) {
      console.warn(`Không đọc được ảnh khách gửi để đưa cho model: ${error.message}`);
    }
  }
  return parts;
}

/** thinkingConfig theo đời model: Gemini 3 nhận thinkingLevel, 2.5 nhận thinkingBudget (số token). */
export function thinkingConfigFor(model, level) {
  const wanted = String(level || '').trim().toLowerCase();
  if (!['minimal', 'low', 'medium', 'high'].includes(wanted)) return null;
  if (/gemini-2\.5/i.test(String(model || ''))) {
    return { thinkingBudget: { minimal: 0, low: 512, medium: 2048, high: 8192 }[wanted] };
  }
  return { thinkingLevel: wanted };
}

function wait(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

// ===== Cache phần tĩnh của prompt trên Vertex (explicit context cache) =====
// Prompt hệ thống (luật + danh mục + danh sách mẫu ≈ 2.300 token, 79% mỗi lượt) giống hệt
// giữa các lượt nhưng implicit cache của Gemini 3 Flash chỉ ăn từ 4.096 token. Thăm dò 25/09:
// cachedContents chạy với gemini-3-flash-preview, token cache tính giá 1/10. Cache theo băm
// (model + prompt), TTL 1 giờ, tạo lại khi hết hạn / đổi mẫu; Vertex báo cache hỏng thì bỏ và
// gửi như thường. settings.promptCache: 'on' (mặc định) | 'off'.
const promptCaches = new Map();
const promptCacheTtlSeconds = 3600;

function hashText(text) {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i += 1) { hash ^= text.charCodeAt(i); hash = Math.imul(hash, 16777619) >>> 0; }
  return hash.toString(16);
}

export function clearPromptCaches() {
  promptCaches.clear();
}

async function promptCacheFor({ endpoint, model, systemPrompt, accessToken, fetchImpl }) {
  const key = `${model}:${hashText(systemPrompt)}`;
  const entry = promptCaches.get(key);
  if (entry && entry.expiresAt > Date.now() + 60000) return entry.name;
  const root = endpoint.replace(/\/publishers\/google\/models\/.*$/, '');
  const project = root.match(/\/projects\/([^/]+)\/locations\/([^/]+)/);
  if (!project) return '';
  const response = await fetchImpl(`${root}/cachedContents`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: `projects/${project[1]}/locations/${project[2]}/publishers/google/models/${model}`, displayName: `giotnang-${key.slice(-12)}`, systemInstruction: { parts: [{ text: systemPrompt }] }, ttl: `${promptCacheTtlSeconds}s` })
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || !payload.name) throw new Error(payload?.error?.message || `cachedContents ${response.status}`);
  promptCaches.set(key, { name: payload.name, expiresAt: Date.now() + promptCacheTtlSeconds * 1000 });
  console.log(`Cache prompt: tạo mới cho ${model} (${payload.usageMetadata?.totalTokenCount || '?'} token, 1 giờ)`);
  return payload.name;
}

export async function requestDirectModelReply(options) {
  const { settings, conversation, message, recentMessages = [], fetchImpl = fetch, rawResponse = false } = options;
  const vertex = settings.provider === 'vertex';
  if (!settings.directApiKey && (!vertex || settings.directAuthType === 'api_key')) throw new Error('Chatbot chưa có khóa API hoặc access token của nhà cung cấp.');
  if (!settings.systemPrompt) throw new Error('Chatbot chưa có system prompt.');
  // The catalogue is appended on every request, never baked into the saved
  // prompt: a product added in settings is known to the model on its next reply.
  const systemPrompt = composeSystemPrompt(settings.systemPrompt, settings.messageTemplates, settings.contextTrim);
  const attempts = 1 + Math.max(0, Number(settings.retryCount) || 0);
  const primaryModel = settings.directModel || (vertex ? 'gemini-2.5-flash' : 'deepseek-v4-flash');
  // Model xem trước (gemini-3-flash-preview) dùng hạn mức chia sẻ, giờ cao điểm
  // Vertex trả 429 "Resource exhausted" hàng loạt. Khi đó: thử lại ít nhất 3 lần,
  // nghỉ lùi dần (2s → 4s → 8s), vẫn hỏng thì gọi model dự phòng (GA, hạn mức riêng).
  const fallbackModel = String(settings.fallbackModel ?? (vertex ? 'gemini-2.5-flash' : '')).trim();
  const capacityAttempts = Math.max(attempts, 3);
  const baseWait = Math.max(100, Number(settings.retryIntervalMs) || 1000);
  const capacityWait = Math.max(10, Number(settings.capacityWaitMs) || 2000);
  const callModel = async (model, noCache = false) => {
      const anthropic = settings.directProtocol === 'anthropic';
      const configuredEndpoint = String(settings.directEndpoint || '');
      const endpoint = vertex
        ? (configuredEndpoint.includes('PROJECT_ID')
            ? configuredEndpoint.replace('PROJECT_ID', encodeURIComponent(vertexProjectId()))
            : configuredEndpoint)
          .replace(/\/models\/[^/:]+:generateContent(?:\?.*)?$/, `/models/${encodeURIComponent(model)}:generateContent`)
        : settings.directEndpoint;
      const accessToken = vertex && settings.directAuthType !== 'api_key'
        ? (settings.directApiKey || await getVertexAccessToken({ fetchImpl }))
        : settings.directApiKey;
      const memoryTurns = buildMemoryTurns({ recentMessages, message, settings });
      // Ví dụ đã duyệt: replay đưa sẵn (bỏ chính tin đang đo); chạy thật lấy từ bộ chấm mẫu khi bật.
      const examples = (Array.isArray(options.examples) ? options.examples
        : settings.fewShot === 'on' && message?.type === 'text' && message.text
          // `source`: ví dụ bình luận không đưa vào hộp thư và ngược lại (example-bank lọc theo kênh).
          ? nearestExamples(await loadExampleBank(), { text: message.text, lastTemplate: conversation.botLastTemplateId || '', source: conversation.source || '' })
          : [])
        // Ví dụ chấm "đã gửi ở trên" không đưa cho mô hình: mẫu đó engine tự quyết bằng luật.
        .filter(item => !nudgeTemplateIds.includes(String(item?.label || '')));
      if (examples.length && !Array.isArray(options.examples)) console.log(`Few-shot: ${examples.length} ví dụ (${examples.map(item => item.label).join(', ')}) (${conversation.id})`);
      const query = buildChatbotQuery({ conversation, message, recentMessages, settings, includeHistory: false, examples });
      const imageParts = vertex && message?.type === 'image' ? await collectImageParts(message, fetchImpl) : [];
      // Cache prompt: chỉ Vertex + Gemini 3/2.5 (không phải khi dùng khóa API); lỗi tạo cache thì gửi như thường.
      let cachedContent = '';
      if (vertex && settings.promptCache === 'on' && settings.directAuthType !== 'api_key' && /gemini-(3|2\.5)/i.test(model) && !options.noPromptCache && !noCache) {
        try { cachedContent = await promptCacheFor({ endpoint, model, systemPrompt, accessToken, fetchImpl }); } catch (error) { console.warn(`Cache prompt: không tạo được (${String(error.message).slice(0, 80)}), gửi không cache.`); }
      }
      const body = vertex ? {
        ...(cachedContent ? { cachedContent } : { systemInstruction: { parts: [{ text: systemPrompt }] } }),
        contents: [
          ...memoryTurns.map(turn => ({ role: turn.role, parts: [{ text: turn.text }] })),
          { role: 'user', parts: [...imageParts, { text: query }] }
        ],
        generationConfig: {
          ...(settings.structuredOutput !== false ? { responseMimeType: 'application/json' } : {}),
          // settings.responseEnum = 'on': ép template_id vào enum các mẫu cho phép (không bịa mã, không
          // chọn "đã gửi ở trên"); các trường còn lại là chuỗi tùy chọn. Mặc định tắt để A/B.
          ...(settings.structuredOutput !== false && settings.responseEnum === 'on' && responseChoices.length ? { responseSchema: responseSchemaFor(responseChoices) } : {}),
          // Mức "suy nghĩ" (token suy nghĩ tính giá như đầu ra, đắt gấp 6 lần đầu vào).
          // Gemini 3 dùng thinkingLevel; 2.5 dùng thinkingBudget. Để trống = mặc định của model.
          ...(thinkingConfigFor(model, settings.thinkingLevel) ? { thinkingConfig: thinkingConfigFor(model, settings.thinkingLevel) } : {})
        }
      } : anthropic ? {
        model,
        max_tokens: 1024,
        system: systemPrompt,
        messages: mergeAnthropicTurns([...memoryTurns, { role: 'user', text: query }])
      } : {
        model,
        messages: [
          { role: 'system', content: systemPrompt },
          ...memoryTurns.map(turn => ({ role: turn.role === 'model' ? 'assistant' : 'user', content: turn.text })),
          { role: 'user', content: query }
        ],
        temperature: 0.1,
        ...(settings.structuredOutput !== false ? { response_format: { type: 'json_object' } } : {})
      };
      // Endpoint tuỳ chỉnh chỉ được kiểm SSRF lúc lưu cài đặt; DNS có thể đổi sau đó → kiểm lại (cache 60 s)
      // và không đi theo redirect để khoá/ngữ cảnh khách không bị chuyển sang máy khác.
      if (!vertex) await assertEndpointHost(endpoint);
      const response = await fetchImpl(endpoint, {
        method: 'POST',
        redirect: 'manual',
        headers: {
          ...(anthropic
            ? { 'x-api-key': settings.directApiKey, 'anthropic-version': '2023-06-01' }
            : vertex && settings.directAuthType === 'api_key'
            ? { 'x-goog-api-key': settings.directApiKey }
            : { Authorization: `Bearer ${accessToken}` }),
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(body)
      });
      if (response.status >= 300 && response.status < 400) throw new Error(`Endpoint AI chuyển hướng (${response.status}) — không theo để tránh lộ khóa.`);
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        // Cache hết hạn/hỏng phía Vertex (400/403/404): bỏ cache, gửi lại một lần với prompt đầy đủ.
        if (cachedContent && [400, 403, 404].includes(response.status)) {
          promptCaches.clear();
          console.warn(`Cache prompt: Vertex từ chối (${response.status}), gửi lại không cache.`);
          return callModel(model, true);
        }
        const error = new Error(payload?.error?.message || payload.message || `Nhà cung cấp model trả về lỗi ${response.status}.`);
        error.status = response.status;
        throw error;
      }
      const answer = vertex
        ? payload?.candidates?.[0]?.content?.parts?.map(part => part.text || '').join('').trim()
        : anthropic
          ? payload?.content?.map(part => part.type === 'text' ? part.text || '' : '').join('').trim()
        : payload?.choices?.[0]?.message?.content;
      if (!answer) throw new Error('Mô hình không trả về nội dung.');
      // Số token thật mỗi lượt (đầu vào, phần được cache, đầu ra, "suy nghĩ"): để đo
      // tối ưu prompt bằng số liệu thật thay vì ước lượng. Xem bằng journalctl | grep "Token".
      const usage = payload?.usageMetadata || null;
      if (usage && !rawResponse) {
        console.log(`Token ${model}: vào ${usage.promptTokenCount ?? '?'} (cache ${usage.cachedContentTokenCount ?? 0}) · ra ${usage.candidatesTokenCount ?? '?'} · suy nghĩ ${usage.thoughtsTokenCount ?? 0}`);
      }
      const parsedAnswer = parseModelAnswer(answer);
      if (rawResponse) return { raw: answer, parsed: parsedAnswer, usage, conversationId: '' };
      await refineAddressWithAi(parsedAnswer, options.context || {}, settings, fetchImpl);
      // Kèm số liệu lượt gọi cho nhật ký quyết định: token thật, ví dụ few-shot đã chèn, model, đã thử lại.
      return {
        ...renderChatbotReply(parsedAnswer, settings.messageTemplates, options.context || {}),
        conversationId: '',
        model,
        retried: attempt > 0 || usingFallback,
        fewShot: examples.map(item => String(item.label || '')),
        usage: usage ? { input: Number(usage.promptTokenCount) || 0, cached: Number(usage.cachedContentTokenCount) || 0, output: Number(usage.candidatesTokenCount) || 0, thinking: Number(usage.thoughtsTokenCount) || 0 } : null
      };
  };
  const responseChoices = vertex && settings.responseEnum === 'on' ? modelTemplateChoices(settings.messageTemplates, systemPrompt) : [];
  let model = primaryModel;
  let usingFallback = false;
  let attempt = 0;
  for (;;) {
    try {
      return await callModel(model);
    } catch (error) {
      const capacity = isCapacityError(error);
      attempt += 1;
      const limit = capacity ? (usingFallback ? 2 : capacityAttempts) : attempts;
      if (attempt < limit) {
        // Backoff mũ kèm jitter (khuyến nghị Vertex khi 429): nhiều hội thoại cùng lúc không thử lại đúng một nhịp.
        const delay = capacity ? Math.min(10000, capacityWait * 2 ** (attempt - 1)) * (0.5 + Math.random()) : baseWait;
        if (capacity) console.warn(`Model ${model} hết hạn mức/quá tải (${String(error.message).slice(0, 60)}), thử lại sau ${delay}ms (lần ${attempt}).`);
        await wait(delay);
        continue;
      }
      if (capacity && !usingFallback && fallbackModel && fallbackModel !== primaryModel) {
        console.warn(`Model ${model} vẫn hết hạn mức sau ${attempt} lần, chuyển sang model dự phòng ${fallbackModel}.`);
        usingFallback = true;
        model = fallbackModel;
        attempt = 0;
        continue;
      }
      throw error;
    }
  }
}

/** 429 (hết hạn mức) hay 503 (quá tải): lỗi tạm, đáng thử lại; lỗi khác (401, prompt sai…) thì không. */
export function isCapacityError(error) {
  const status = Number(error?.status) || 0;
  return status === 429 || status === 503 || /resource exhausted|rate limit|quota|overloaded|currently unavailable/i.test(String(error?.message || ''));
}

// Mỗi hội thoại một hàng đợi: tin thứ hai của cùng một khách chờ tin thứ nhất
// được trả lời xong. Pancake bắn mỗi tin một webhook (Meta cũng có lúc tách),
// nên không có hàng này thì hai lần gọi mô hình chạy song song, không thấy
// nhau, và khách nhận hai câu mâu thuẫn ("chị quan tâm loại nào?" rồi ngay
// sau đó "cho em xin địa chỉ").
const conversationQueues = new Map();
function queueForConversation(id, task) {
  const previous = conversationQueues.get(id) || Promise.resolve();
  const run = previous.then(task, task);
  const tracked = run.catch(() => {}).then(() => { if (conversationQueues.get(id) === tracked) conversationQueues.delete(id); });
  conversationQueues.set(id, tracked);
  return run;
}

/**
 * Giỏ Facebook Shop: bot đã xin SĐT/địa chỉ vì lúc đó POS chưa có đơn. Khách
 * thanh toán trong Shop thì Pancake tạo đơn POS sau 0–2 phút: tra lại ở nền
 * (30 giây, 1,5 phút, 3,5 phút); thấy đơn thì nhắn "đã nhận đơn… không cần gửi
 * lại" và bỏ giỏ chờ. Dừng khi nhân viên đã nhận khách, khách đã lên đơn khác,
 * hay giỏ đã đổi. Chạy trong hàng đợi của khách, không chen tin khác.
 */
function followUpShopOrder({ conversation, since, settings, dependencies, cartKey, shopOrderReply }) {
  const delays = Array.isArray(settings.shopOrderFollowUpMs) ? settings.shopOrderFollowUpMs : [30000, 60000, 120000];
  const queueKey = conversation.pageId && conversation.psid ? `${conversation.pageId}:${conversation.psid}` : conversation.id;
  const check = index => {
    if (index >= delays.length) return;
    const timer = setTimeout(() => {
      queueForConversation(queueKey, async () => {
        const latest = dependencies.getConversation ? await dependencies.getConversation(conversation.id).catch(() => null) : null;
        const current = latest || conversation;
        if (current.botEnabled === false) return;
        if ((current.customerOrders || []).some(order => (Number(order?.createdAt) || 0) >= since)) return;
        if (latest && cartKey && current.pendingOrder?.key !== cartKey) return;
        const found = await dependencies.findShopOrder(current, { since }).catch(() => null);
        if (!found) { check(index + 1); return; }
        const reply = shopOrderReply(found);
        for (const text of reply.messages) await dependencies.sendMessage(current, { text });
        await dependencies.saveBotState?.(current.id, { pendingOrder: null, botLastTemplateId: reply.templateId, botLastReplyAt: Date.now() });
      }).catch(error => console.warn(`Tra đơn Shop ở nền lỗi (${conversation.id}): ${error.message}`));
    }, Number(delays[index]) || 0);
    timer.unref?.();
  };
  check(0);
}

// Tin liền nhau của khách ("C đặt 2 gói" / "Giảm ko e") gộp thành một câu hỏi
// cho mô hình: chỉ tin chữ, gửi sau câu trả lời gần nhất của Page, trong vòng
// mười phút, nhiều nhất năm tin.
const bundleWindowMs = 10 * 60 * 1000;
const bundleLimit = 5;

/** Tin khách chưa được trả lời, tính cả tin đang xử lý; tin cũ đứng trước. */
export function unansweredCustomerMessages(recentMessages, current) {
  const list = Array.isArray(recentMessages) ? recentMessages : [];
  const lastReply = list.findLastIndex(item => item?.direction === 'outgoing');
  const now = Number(current?.createdAt) || Date.now();
  const since = list.slice(lastReply + 1).filter(item => item?.direction === 'incoming' && (item.type || 'text') === 'text'
    && String(item.text || '').trim() && now - (Number(item.createdAt) || now) <= bundleWindowMs);
  const bundle = since.some(item => item.id && item.id === current?.id) ? since : [...since, current];
  return bundle.slice(-bundleLimit);
}

/** Đã có tin khách mới hơn tin đang xử lý: tin này nhường, tin sau trả lời gộp cả hai. */
export function hasNewerCustomerMessage(recentMessages, current) {
  const list = Array.isArray(recentMessages) ? recentMessages : [];
  const index = list.findIndex(item => item?.id && item.id === current?.id);
  const after = index >= 0 ? list.slice(index + 1) : list.filter(item => (Number(item?.createdAt) || 0) > (Number(current?.createdAt) || Infinity));
  return after.some(item => item?.direction === 'incoming');
}

// Ảnh sản phẩm chưa gửi được sau tin nhắn riêng từ bình luận (Facebook chặn
// tới khi khách nhắn vào Messenger): giữ theo khách, gửi ngay khi khách nhắn lại.
const pendingInboxImages = new Map();
const pendingImagesTtl = 3 * 24 * 60 * 60 * 1000;
export function rememberPendingImages(pageId, psid, images) {
  if (!pageId || !psid || !images?.length) return;
  pendingInboxImages.set(`${pageId}:${psid}`, { images: [...new Set(images)], at: Date.now() });
}
export function takePendingImages(pageId, psid) {
  const key = `${pageId}:${psid}`;
  const entry = pendingInboxImages.get(key);
  if (!entry) return [];
  pendingInboxImages.delete(key);
  return Date.now() - entry.at > pendingImagesTtl ? [] : entry.images;
}

// Tin đang được bot xử lý (khóa theo hội thoại:tin) — chặn cùng một tin vào hai lần qua hai đường.
const inFlightMessages = new Set();

/** Chuỗi so lặp: bỏ dấu, chỉ giữ chữ/số, gộp khoảng trắng. */
function squashText(value) {
  return foldVietnamese(String(value || '')).replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Độ giống hai câu (0–1) theo cặp ký tự liền nhau (Dice): "Shop ơi giá sao" và
 * "shop oi gia sao" ≈ 1; câu có thêm ý mới thì thấp. Dùng để nhận khách LẶP LẠI
 * câu vừa hỏi (ngưỡng 0,8) trước khi nhắc "em gửi ở trên".
 */
export function textSimilarity(left, right) {
  const a = squashText(left);
  const b = squashText(right);
  if (!a || !b) return 0;
  if (a === b) return 1;
  const grams = text => { const map = new Map(); for (let i = 0; i < text.length - 1; i += 1) { const key = text.slice(i, i + 2); map.set(key, (map.get(key) || 0) + 1); } return map; };
  const ga = grams(a);
  const gb = grams(b);
  let shared = 0;
  for (const [key, count] of ga) shared += Math.min(count, gb.get(key) || 0);
  const total = Math.max(1, a.length - 1) + Math.max(1, b.length - 1);
  return (2 * shared) / total;
}

// Tin khách chỉ là lời giục / lặp ("sao chưa trả lời", "???", "alo", "shop ơi", "có ai không"):
// chỉ khi đó mới được nhắc "em vừa gửi ở trên" (7 ca 26–28/09 nhắc sai vì khách hỏi ý mới).
const nudgePattern = /^(?:sao (?:(?:em|e|shop|c|chi|anh|ban|ad|admin|minh|ben em) )?(?:chua|ko|khong|k|hong) (?:tra loi|rep|thay|thay rep|tl|tra loi minh|tra loi em|noi gi|phan hoi)|\?+|hello|helo|hi|alo|a lo|shop oi|shop|oi|co ai (?:khong|ko|k|hong)(?: a)?|co ai o (?:do|day) (?:khong|ko|k))$/;
export function isNudgeMessage(text) {
  const core = foldVietnamese(String(text || '')).replace(/[^a-z0-9? ]+/g, ' ').replace(/\s+/g, ' ').trim()
    .replace(/(?: (?:a|ạ|nha|nhe|shop|em|e|c|chi|anh|vay|z|ha|the|voi))+$/, '');
  return nudgePattern.test(core) || /^\?+$/.test(String(text || '').trim());
}

/**
 * Cắt chữ dài thành các tin ≤ limit ký tự, ưu tiên cắt ở đoạn trống, xuống dòng, rồi dấu
 * chấm — Messenger cắt cụt tin quá 2.000 ký tự ("…+ miễn phí v"). Tách gửi thay vì cắt.
 */
export function splitMessageText(text, limit = 1900) {
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

/**
 * Dòng log so luật thử với luật ổn định. Giá trị luật thử là JSON thô (ORDER_ADDRESS +
 * SĐT) — phải qua bộ soạn đơn (cùng ngữ cảnh) rồi mới so mẫu, không thì PHONE_ONLY luôn bị
 * ghi ✗ giả khi bộ soạn đơn chốt thành ORDER_CONFIRMATION.
 */
export function shadowRuleLine(shadow, stableTemplateId, render, conversationId = '') {
  const rendered = shadow?.commentRule ? stableTemplateId : shadow?.value ? render(shadow.value)?.templateId || shadow.value.template_id : shadow?.rule;
  return `Luật ${shadow?.rule} (thử): luật ${rendered} / luật ổn định ${stableTemplateId}${rendered === stableTemplateId ? ' ✓' : ' ✗'}${conversationId ? ` (${conversationId})` : ''}`;
}

/**
 * Dấu so mô hình nhỏ với câu trả lời thật: so với mẫu mô hình/luật CHỌN (trước hậu xử lý);
 * ORDER_ADDRESS_REMIND ≡ ORDER_ADDRESS, còn "đã gửi ở trên" là trung tính (~).
 */
export function intentMatchMark(predicted, chosen) {
  const same = id => (id === 'ORDER_ADDRESS_REMIND' ? 'ORDER_ADDRESS' : id);
  if (['REPLY_ALREADY_SENT', 'REPLY_ALREADY_SENT_INFO'].includes(chosen)) return '~';
  return same(predicted) === same(chosen) ? '✓' : '✗';
}

/**
 * Dấu so mô hình tầng với mẫu CHỌN: ✓ khi mẫu tương đương (cùng quy ước intentMatchMark, nhóm khi đó
 * cũng đúng), ~ khi "đã gửi ở trên", "nhóm✓" khi chỉ nhóm đúng (cần groupOf của mô-đun tầng), còn lại ✗.
 */
export function cascadeMatchMark(cascade, chosen, groupOf = null) {
  const mark = intentMatchMark(cascade?.templateId, chosen);
  if (mark !== '✗') return mark;
  const chosenGroup = typeof groupOf === 'function' ? (() => { try { return groupOf(chosen); } catch { return ''; } })() : '';
  return chosenGroup && chosenGroup === cascade?.group ? 'nhóm✓' : '✗';
}

/**
 * Người gác có thêm top-K của mô hình tầng làm tham chiếu: so luật / mô hình phẳng như cũ (gateCheck),
 * chưa đồng thuận thì so với top-K tầng → reason 'cascade-top1' / 'cascade-topk'; chỉ có tầng mà lệch → 'cascade-mismatch'.
 */
export function gateCheckWithCascade({ llmTemplateId = '', intentTopK = [], cascadeTopK = [], ruleTemplateId = '' } = {}) {
  const base = gateCheck({ llmTemplateId, intentTopK, ruleTemplateId });
  const topK = Array.isArray(cascadeTopK) ? cascadeTopK : [];
  if (base.agree || base.reason === 'no-llm' || !topK.length) return base;
  const viaCascade = gateCheck({ llmTemplateId, intentTopK: topK });
  if (viaCascade.agree) return { agree: true, reason: viaCascade.reason.replace('intent-', 'cascade-') };
  return base.agree === null ? { agree: false, reason: 'cascade-mismatch' } : base;
}

/** Đơn còn hiệu lực (chưa hủy qua bot, nhân viên hay POS). */
export function isActiveOrder(order) {
  return Boolean(order) && String(order.processingStatus || '') !== 'cancelled' && order.status !== 'Hủy';
}

export async function processChatbotChanges(changes, dependencies) {
  const { readSettings } = dependencies;
  const settings = await readSettings();
  if (!settings.enabled) return [];
  const results = [];
  for (const change of changes) {
    // `updated`: tin cũ vừa có thêm dữ liệu (ảnh có URL) — hộp thư vẽ lại, bot không trả lời lần hai.
    if (change.type !== 'message' || change.message?.direction !== 'incoming' || !change.conversation || change.updated) continue;
    // Cùng một tin về qua hai đường (webhook + đồng bộ/backlog) trong lúc lượt đầu còn đang chạy: bỏ.
    const inFlightKey = `${change.conversation.id}:${change.message.id || change.message.mid || change.message.createdAt}`;
    if (inFlightMessages.has(inFlightKey)) { results.push({ conversationId: change.conversation.id, skipped: 'đang xử lý tin này' }); continue; }
    inFlightMessages.add(inFlightKey);
    try {
      // Hàng đợi theo KHÁCH (pageId:psid): bình luận và hộp thư của cùng một
      // người nối tiếp nhau, hai bình luận liền nhau không chạy song song.
      const queueKey = change.conversation.pageId && change.conversation.psid ? `${change.conversation.pageId}:${change.conversation.psid}` : change.conversation.id;
      await queueForConversation(queueKey, () => answerChange(change, settings, results, dependencies));
    } catch (error) {
      // Một hội thoại hỏng (kho tin không ghi được…) không làm rơi các tin còn lại trong lô.
      results.push({ conversationId: change.conversation.id, error: error.message });
    } finally {
      inFlightMessages.delete(inFlightKey);
    }
  }
  // Bot im (nhân viên vừa trả lời, gộp tin, lặp…): ghi một dòng để rà được về sau.
  for (const item of results) if (item.skipped && item.skipped !== 'gộp với tin sau') console.log(`Bot bỏ qua: ${item.skipped} (${item.conversationId})`);
  return results;
}

async function answerChange(incomingChange, settings, results, dependencies) {
  const { listMessages, getConversation, saveBotState, sendMessage, createOrder, updateOrder, cancelOrder, sendReceipt, moderateComment, requestReply = requestDirectModelReply } = dependencies;
  // Ảnh kèm chữ ("giá bao nhiêu" + ảnh túi): xử lý theo chữ như tin thường (ảnh là phụ), không "đã nhận hình".
  const captioned = incomingChange?.message?.type === 'image' && /\p{L}{2,}/u.test(String(incomingChange.message.text || ''));
  const change = captioned ? { ...incomingChange, message: { ...incomingChange.message, type: 'text', captionOfImage: true } } : incomingChange;
  // Mẫu trong Cài đặt + lời dự phòng cho mẫu mới chưa có (xem fallbackTemplates).
  const templates = withFallbackTemplates(settings.messageTemplates);
  // Luật nhận ý: test có thể đưa luật giả qua dependencies.ruleIntent (kiểm clearBasket/values).
  const ruleIntentFn = typeof dependencies.ruleIntent === 'function' ? dependencies.ruleIntent : ruleIntent;
  // Mô hình tầng: test đưa dependencies.predictCascade (+ cascadeGroupOf) giả; chạy thật nạp mô-đun động (thiếu → null).
  const cascadeMode = ['on', 'shadow', 'off'].includes(settings.intentCascade) ? settings.intentCascade : 'shadow';
  const cascadeModule = cascadeMode !== 'off' && typeof dependencies.predictCascade !== 'function' ? await loadCascadeModule() : null;
  const predictCascadeFn = typeof dependencies.predictCascade === 'function' ? dependencies.predictCascade : typeof cascadeModule?.predictCascade === 'function' ? cascadeModule.predictCascade : null;
  const cascadeGroupOf = typeof dependencies.cascadeGroupOf === 'function' ? dependencies.cascadeGroupOf : typeof cascadeModule?.groupOf === 'function' ? cascadeModule.groupOf : null;
  // Bản mới nhất của hội thoại: tin đứng trước trong hàng có thể vừa lưu giỏ
  // hàng, hay nhân viên vừa tắt bot. Every thread is answered unless staff
  // switched the bot off for it.
  const conversation = (getConversation ? await getConversation(change.conversation.id).catch(() => null) : null) || change.conversation;
  if (conversation.botEnabled === false) return;
  // Vết của lượt này cho nhật ký quyết định (processing/decision-log.mjs): điền dần theo luồng,
  // ghi ở `finally` (kể cả khi bỏ qua hay lỗi). Xem buildDecisionRecord về schema.
  const startedAt = Date.now();
  const resultsBefore = results.length;
  const trace = { text: String(change.message?.text || ''), type: String(change.message?.type || 'text'), ctx: null, rule: null, shadow: [], intent: null, cascade: null, llm: null, fewShot: [], chosen: null, final: null, also: null, preGuard: null, gate: null, attention: false, handoff: false };
  try {
    const recent = await listMessages(conversation.id);
    const askedAt = Number(change.message?.createdAt) || 0;
    // Tin chạy lại (hết hạn mức) hay tin đến muộn (đồng bộ/backlog): có thể đã được trả lời trong lúc chờ.
    if ((change.delayedRetry || change.late) && recent.some(item => item?.direction === 'outgoing' && (Number(item?.createdAt) || 0) >= askedAt)) {
      results.push({ conversationId: conversation.id, skipped: 'đã có người trả lời' });
      return;
    }
    if (hasNewerCustomerMessage(recent, change.message)) {
      results.push({ conversationId: conversation.id, skipped: 'gộp với tin sau' });
      return;
    }
    const bundle = change.message.type === 'text' ? unansweredCustomerMessages(recent, change.message) : [change.message];
    const bundled = new Set(bundle.map(item => item?.id).filter(Boolean));
    const message = bundle.length > 1
      ? { ...change.message, text: bundle.map(item => String(item.text || '').trim()).join('\n') }
      : change.message;
    trace.text = String(message.text || '');
    trace.type = String(message.type || 'text');
    const keywords = settings.handoffKeywords.split(',').map(item => foldVietnamese(item.trim())).filter(Boolean);
    const incomingText = foldVietnamese(message.text);
    const asksForHuman = keywords.some(keyword => incomingText.includes(keyword));
    // The basket the customer named earlier travels with the request so a later
    // "0385805790" alone is still enough to close the same order.
    // Đơn gần nhất của khách: để "lấy thêm…" ngay sau khi chốt không gộp lại món đã đặt.
    // Luồng bình luận đọc hộp thư cùng khách: xưng hô nhân viên đã chọn, và đơn
    // khách đã đặt trong Messenger (bình luận "đã đặt", "hủy đơn" phải thấy đơn thật).
    const inboxThread = conversation.source === 'comment' && getConversation
      ? await getConversation(`${conversation.pageId}:${conversation.psid}`).catch(() => null)
      : null;
    // Đơn gần nhất CHƯA hủy đi trước: đơn vừa hủy không được che đơn cũ còn giao (bỏ bước hỏi
    // "đặt thêm?"), không được kể là "đang chuẩn bị hàng", không làm giỏ mới bị bớt món "đã đặt".
    // Không còn đơn nào chưa hủy thì lấy đơn hủy gần nhất (để "hủy đơn" lần hai được đáp "đã hủy rồi").
    const allOrders = [...(Array.isArray(conversation.customerOrders) ? conversation.customerOrders : []), ...(Array.isArray(inboxThread?.customerOrders) ? inboxThread.customerOrders : [])];
    const latestOf = list => list.reduce((latest, order) => ((Number(order?.createdAt) || 0) > (Number(latest?.createdAt) || 0) ? order : latest), null);
    const latestOrder = latestOf(allOrders);
    const recentOrder = latestOf(allOrders.filter(isActiveOrder)) || latestOrder;
    // Tin hệ thống của Messenger ("Bạn đã bỏ lỡ cuộc gọi…") không phải lời khách.
    if (/bỏ lỡ cuộc gọi|có thể gọi cho .* trong 7 ngày|đã gọi cho bạn|cuộc gọi (thoại|video) đã kết thúc|missed (a )?call/i.test(String(change.message?.text || ''))) {
      results.push({ conversationId: conversation.id, skipped: 'tin hệ thống cuộc gọi' });
      return;
    }
    // Vài tin chữ gần nhất của khách: SĐT/địa chỉ khách gửi ở tin riêng trước đó
    // được đọc lại thay vì hỏi lần nữa.
    const recentCustomerTexts = recent.filter(item => item?.direction === 'incoming' && item.type === 'text' && item.text).slice(-5).map(item => String(item.text));
    // Khách đi từ bình luận sang Messenger: bình luận gần nhất của khách dưới
    // bài ("1 xanh 1 vàng", "cho mình 2 túi") là ngữ cảnh model cần thấy — hộp
    // thư không chứa bình luận.
    const commentThreadId = conversation.source !== 'comment' && String(conversation.post?.inheritedFrom || '').includes(':comment:') ? conversation.post.inheritedFrom : '';
    const recentComments = commentThreadId && listMessages
      ? (await listMessages(commentThreadId).catch(() => [])).filter(item => item?.direction === 'incoming' && item.text).slice(-2).map(item => String(item.text).replace(/\s+/g, ' ').trim().slice(0, 200))
      : [];
    const conversationForModel = recentComments.length ? { ...conversation, recentComments } : conversation;
    // Ưu đãi bám đuổi 1 túi dùng thử (processing/trial-flow.mjs): chỉ hộp thư, còn hạn,
    // chưa đặt đơn sau khi nhận. Chỉ luồng dùng thử đặt context.trial (miễn ship 1 túi).
    let trialState = activeTrial(conversation);
    // "Gửi về địa chỉ cũ" mà đơn không gắn vào hội thoại (nhân viên lên tay, đơn cũ): đọc SĐT +
    // địa chỉ từ tin xác nhận đơn gần nhất trong lịch sử thay vì hỏi lại khách.
    const previousDelivery = (() => {
      const confirmation = [...recent].reverse().find(item => item?.direction === 'outgoing' && /Số điện thoại:\s*\S+/u.test(String(item.text || '')) && /Địa chỉ nhận hàng:/u.test(String(item.text || '')));
      if (!confirmation) return null;
      const phone = String(confirmation.text).match(/Số điện thoại:\s*([\d .+-]{9,16})/u)?.[1]?.replace(/[^\d+]/g, '') || '';
      const address = String(confirmation.text).match(/Địa chỉ nhận hàng:\s*([^\n]+)/u)?.[1]?.trim() || '';
      return phone && address ? { phone, address, at: Number(confirmation.createdAt) || 0 } : null;
    })();
    // Xưng hô khóa một lần trong hội thoại (botGender): giới tính đoán từ tin/tên có thể đổi
    // giữa chừng, khách thấy "chị" rồi "anh". Nhân viên đặt tay (genderSource 'staff') vẫn thắng.
    const lockedGender = conversation.genderSource === 'staff' && conversation.gender
      ? conversation.gender
      : conversation.botGender || inboxThread?.botGender || conversation.gender || inboxThread?.gender || '';
    // Thẻ của hội thoại (bình luận đọc cả hộp thư cùng khách).
    const conversationLabels = [...(Array.isArray(conversation.labels) ? conversation.labels : []), ...(Array.isArray(inboxThread?.labels) ? inboxThread.labels : [])].map(String);
    // Không mời lên 2 túi khi hội thoại có khiếu nại/cần người xử lý, vừa nói chuyện sỉ/CTV,
    // hay đã mời một lần trong hội thoại (botUpsoldAt, hoặc lời mời còn trong lịch sử).
    const noUpsell = conversationLabels.some(label => /^(complaint|warranty|consulting|handoff)$/.test(label))
      || isComplaint({ text: message.text, keywords: settings.complaintKeywords })
      || conversation.botLastTemplateId === 'WHOLESALE_CTV_CONTACT'
      || Boolean(conversation.botUpsoldAt)
      || recent.some(item => item?.direction === 'outgoing' && /lấy 2 \S+ thì giá chỉ còn/iu.test(String(item.text || '')));
    const replyContext = { pendingOrder: conversation.pendingOrder, recentOrder, latestOrder, lastTemplateId: conversation.botLastTemplateId || '', previousDelivery, trial: trialState, trialBags: trialState ? trialBagOptions() : '', promoBowl: promoBowlActive(conversation), now: Date.now(), recentOutgoing: recent.filter(item => item?.direction === 'outgoing' && Date.now() - (Number(item.createdAt) || 0) < 30 * 60 * 1000).map(item => String(item.text || '')), messageText: String(message.text || ''), recentCustomerTexts: [...recentComments, ...recentCustomerTexts], noUpsell, customer: { gender: lockedGender, name: conversation.name || '' } };
    // Mốc tin Page gần nhất (nhân viên hay bot): nhân viên nhắn sau bot > 5 giây thì luật/gác coi là nhân viên đang trả lời.
    const lastOutgoingAt = Math.max(0, ...recent.filter(item => item?.direction === 'outgoing').map(item => Number(item.createdAt) || 0));
    const staffRepliedAfterBot = lastOutgoingAt > (Number(conversation.botLastReplyAt) || 0) + 5000;
    trace.ctx = decisionContext({ conversation, message, recentOrder, staffRepliedAfterBot, labels: conversationLabels, gender: lockedGender });
    // Nhân viên đang xử lý hội thoại này (đọc 214 hội thoại 26–28/09: bot chen vào giữa lúc
    // nhân viên đang trao đổi, "Đúng rồi" của khách đáp câu hỏi của nhân viên mà bot cảm ơn):
    // nhân viên (tin Page mang cờ staff) nhắn sau lượt bot gần nhất trong 2 giờ, hay hội thoại
    // mang thẻ khiếu nại / bảo hành / cần người xử lý và nhân viên có nhắn trong 24 giờ → bot im.
    // Bình luận cũng đọc hộp thư cùng khách. Thẻ không có mốc giờ nên không im chỉ vì thẻ cũ
    // (khách quay lại mua sau nhiều tuần): cần nhân viên có nhắn mới tính.
    const staffMessagesOf = list => (Array.isArray(list) ? list : []).filter(item => item?.direction === 'outgoing' && item.staff);
    const inboxMessages = inboxThread && listMessages ? await listMessages(inboxThread.id).catch(() => []) : [];
    const staffMessages = [...staffMessagesOf(recent), ...staffMessagesOf(inboxMessages)];
    const botLastAt = Math.max(Number(conversation.botLastReplyAt) || 0, Number(inboxThread?.botLastReplyAt) || 0);
    const staffAfterBot = staffMessages.some(item => (Number(item.createdAt) || 0) >= botLastAt && Date.now() - (Number(item.createdAt) || 0) < 2 * 60 * 60 * 1000);
    const staffLabelled = conversationLabels.some(label => /^(complaint|warranty|consulting|handoff)$/.test(label));
    const staffRecently = staffMessages.some(item => Date.now() - (Number(item.createdAt) || 0) < 24 * 60 * 60 * 1000);
    if (staffAfterBot || (staffLabelled && staffRecently)) {
      results.push({ conversationId: conversation.id, skipped: 'nhân viên đang xử lý' });
      return;
    }
    // Bot vừa báo "nhân viên sẽ kiểm tra / nhắn lại" (ORDER_STATUS_CHECKING, CSKH_HANDOFF) dưới 24
    // giờ mà nhân viên chưa nhắn: khách nhắn tiếp → WAITING_STAFF đúng một lần, các tin sau im —
    // không bao giờ "chưa thấy đơn nào" / "em vừa gửi ở trên" (ca Hải Yến Trân → "Buôn bán kiểu gì vậy").
    const staffSinceBot = staffMessages.some(item => (Number(item.createdAt) || 0) >= (Number(conversation.botLastReplyAt) || 0));
    const waitingAge = Date.now() - (Number(conversation.botLastReplyAt) || 0);
    if (conversation.source !== 'comment' && !staffSinceBot && waitingAge < 24 * 60 * 60 * 1000 && !['sticker', 'ad'].includes(message.type)) {
      if (conversation.botLastTemplateId === 'WAITING_STAFF') {
        results.push({ conversationId: conversation.id, skipped: 'đang chờ nhân viên' });
        return;
      }
      if (['ORDER_STATUS_CHECKING', 'CSKH_HANDOFF'].includes(conversation.botLastTemplateId)) {
        const waiting = renderChatbotReply({ template_id: 'WAITING_STAFF' }, templates, replyContext);
        if (waiting.templateId === 'WAITING_STAFF') {
          if (settings.responseMode === 'automatic') for (const text of waiting.messages) await sendMessage(conversation, { text });
          await saveBotState(conversation.id, { botLastTemplateId: 'WAITING_STAFF', botLastReplyAt: Date.now(), botDraft: settings.responseMode === 'draft' ? waiting.messages.join('\n\n') : '', addLabelEvents: ['handoff'] });
          results.push({ conversationId: conversation.id, mode: settings.responseMode, templateId: 'WAITING_STAFF' });
          return;
        }
      }
    }
    // Khách chỉ để ".", "ib", "bn", "xin giá"… dưới bài/quảng cáo có sản phẩm cụ
    // thể: gửi thẳng bảng giá sản phẩm đó, không đưa danh sách chung để khách phải chọn.
    const folded = foldVietnamese(String(message.text || '').trim()).replace(/\s+/g, ' ');
    // Tin mảnh (chỉ SĐT, "đó a", tên người…) khi đang lấy thông tin đơn, hoặc bot
    // vừa hỏi ở bước lên đơn, hoặc tin chỉ toàn số: đợi vài giây cho tin kế tiếp
    // của khách tới để gộp, tránh xin lại thứ khách vừa gửi. Bình luận liên tiếp
    // ("1 vàng 1 xanh" rồi "1 xanh 1 vàng") cũng gộp thành một câu trả lời.
    const shortText = String(message.text || '').trim();
    const digitsOnly = /^\+?\d[\d .-]{7,}$/.test(shortText);
    // Tin chỉ là lời chào ("Hi", "shop ơi"): câu hỏi thật thường tới ngay sau —
    // chờ để trả lời gộp, không chào trước rồi mới trả lời.
    const greetingOnly = /^(hi|hello|helo|alo|a lo|chao|xin chao|chao (shop|em|ban|chi|anh)|(shop|em|chi|ad|admin|ban) (oi|ơi)|oi)[.!\s]*$/i.test(foldVietnamese(shortText));
    // SĐT rồi địa chỉ (hay ngược lại) thường là hai tin liền nhau: tin chỉ SĐT ("sđt 09…", "0909… nha")
    // và tin chỉ địa chỉ (có xã/phường/quận/đường…) cũng đợi để gộp — trước đây bot gửi
    // ORDER_ADDRESS_PARTIAL rồi ORDER_CONFIRMATION cùng phút. Tin chỉ SĐT đợi lâu gấp đôi.
    const phoneFragment = message.type === 'text' && Boolean(extractVietnamesePhone(shortText)) && shortText.replace(/\+?\d[\d .-]{8,13}/g, ' ').replace(/\s+/g, ' ').trim().length < 40;
    const addressFragment = message.type === 'text' && shortText.length < 160 && /\b(xa|huyen|quan|phuong|thi tran|thi xa|tp|thanh pho|duong|thon|ap|kp|khu pho|so nha|ngo|hem|to)\b/.test(foldVietnamese(shortText))
      && (conversation.pendingOrder || isOrderStep(conversation.botLastTemplateId) || ['ASK_FLAVOR', 'ORDER_ADDRESS_REMIND', 'ORDER_CUSTOM_BASKET', 'PRICE_QUOTE', 'GENERAL_INFO'].includes(conversation.botLastTemplateId));
    const waitForFragments = message.type === 'text' && (
      conversation.source === 'comment'
      || greetingOnly
      || phoneFragment
      || addressFragment
      || ((conversation.pendingOrder || isOrderStep(conversation.botLastTemplateId) || ['ASK_FLAVOR', 'ORDER_ADDRESS_REMIND', 'ORDER_CUSTOM_BASKET'].includes(conversation.botLastTemplateId) || digitsOnly) && shortText.length < 40)
    );
    if (waitForFragments) {
      const baseWaitMs = Number(settings.fragmentWaitMs ?? 4000);
      await new Promise(resolve => setTimeout(resolve, phoneFragment ? Number(settings.phoneFragmentWaitMs ?? baseWaitMs * 2) : baseWaitMs));
      if (hasNewerCustomerMessage(await listMessages(conversation.id), change.message)) {
        results.push({ conversationId: conversation.id, skipped: 'gộp với tin sau' });
        return;
      }
    }
    // Bot vừa hỏi số lượng/vị/SĐT/địa chỉ thì "1", "?"… là câu trả lời, không phải xin giá.
    const collectingOrder = isOrderStep(conversation.botLastTemplateId) || ['ASK_FLAVOR', 'ORDER_ADDRESS_REMIND', 'ORDER_CUSTOM_BASKET'].includes(conversation.botLastTemplateId);
    const terse = message.type === 'text' && !collectingOrder && /^(\.+|…|ib|inbox|in box|bn|gia|xin gia|gia bao nhieu|bao nhieu|bao gia|cho hoi gia|gia sao|gia the nao|gia ntn|\?|\+1|1|\.ib|ib\.)$/i.test(folded);
    const contextProduct = terse ? resolveConversationProduct({ adTitle: conversation.referral?.adTitle, referralRef: conversation.referral?.ref, postText: conversation.post?.message }).product : '';
    const quickQuote = terse && productHint(contextProduct) && templates?.PRICE_QUOTE
      ? renderChatbotReply({ template_id: 'PRICE_QUOTE', Product_N1: contextProduct }, templates, replyContext)
      : null;
    // Sticker/biểu tượng: không cần trả lời, càng không cần chuyển người.
    // Dòng ghi "khách bấm quảng cáo" cũng không phải tin để trả lời.
    if (message.type === 'sticker' || message.type === 'ad') {
      results.push({ conversationId: conversation.id, skipped: message.type });
      return;
    }
    // Ảnh, video, tệp: trước đây mọi tin không phải chữ đều chuyển nhân viên và
    // tắt bot (nguồn chuyển CSKH lớn nhất). Giờ bot báo đã nhận hình, gắn thẻ
    // để nhân viên xem, nhưng vẫn bật để trả lời tin chữ tiếp theo; nhiều ảnh
    // liền nhau chỉ báo một lần.
    const nonText = message.type !== 'text';
    if (nonText && conversation.botLastTemplateId === 'IMAGE_RECEIVED') {
      results.push({ conversationId: conversation.id, skipped: 'ảnh liền nhau' });
      return;
    }
    // Ảnh khách gửi: Gemini (Vertex) xem ảnh cùng lịch sử — ảnh quảng cáo/bao bì
    // thì nhận ra sản phẩm và đi tiếp (báo giá, lên đơn); model không rõ ảnh
    // là gì thì trả IMAGE_RECEIVED và bot gắn thẻ cho nhân viên xem.
    const seesImage = nonText && message.type === 'image' && settings.provider === 'vertex' && settings.visionEnabled !== false && (message.dataUrl || message.images?.length);
    // Khách đã có đơn trong 24 giờ (chưa hủy).
    const hasOrder = Boolean(recentOrder?.id) && Date.now() - (Number(recentOrder.createdAt) || 0) < 24 * 60 * 60 * 1000
      && isActiveOrder(recentOrder);
    // Ảnh model không đọc ra, khách đến từ quảng cáo/bài của MỘT sản phẩm và chưa
    // có đơn: gửi bảng giá sản phẩm đó (ảnh thường là ảnh quảng cáo chụp lại),
    // vẫn gắn thẻ để nhân viên xem ảnh. Trước đây "mình cần hỗ trợ gì về hình
    // này" làm khách im luôn.
    const adQuote = () => {
      if (conversation.source === 'comment' || hasOrder || isLivestreamPost(conversation) || !templates?.PRICE_QUOTE) return null;
      const product = resolveConversationProduct({ adTitle: conversation.referral?.adTitle, referralRef: conversation.referral?.ref, postText: conversation.post?.message }).product;
      return productHint(product) ? renderChatbotReply({ template_id: 'PRICE_QUOTE', Product_N1: product }, templates, replyContext) : null;
    };
    const imageFallback = () => ({ ...(adQuote() || renderChatbotReply({ template_id: templates?.IMAGE_RECEIVED ? 'IMAGE_RECEIVED' : 'CSKH_HANDOFF' }, templates || {}, replyContext)), attention: true });
    // Khách bấm "Mua"/"Gửi giỏ hàng" ở Facebook Shop: SKU đã rõ, không cần model.
    const cartReply = message.cart?.length ? cartQuickReply(message.cart, templates, replyContext) : null;
    // Khách thanh toán luôn trong Facebook Shop: Pancake tạo đơn POS (có SĐT, địa
    // chỉ) vài chục giây sau tin giỏ. Có đơn đó thì báo đã nhận, không xin lại
    // thông tin khách vừa điền (trước đây khách phải nhắn "chị đặt trên web rồi").
    const shopOrderReply = found => ({
      ...renderChatbotReply({
        template_id: 'SHOP_ORDER_RECEIVED',
        values: {
          cart: (cartReply?.pendingOrder?.items?.length ? cartReply.pendingOrder.items.map(item => `${item.quantity} ${item.product}`) : found.items.map(item => `${item.quantity} ${findProductBySku(item.sku)?.name || item.name}`)).join(' + '),
          total: found.total ? `${found.total.toLocaleString('vi-VN')}đ` : ''
        }
      }, templates, replyContext),
      pendingOrder: null
    });
    // Tra một lần ngay (không bắt khách chờ); chưa có thì trả lời như thường và
    // tra lại ở nền (followUpShopOrder) — đơn Shop thường vào POS sau 0–2 phút.
    const canFindShopOrder = Boolean(cartReply && dependencies.findShopOrder && templates?.SHOP_ORDER_RECEIVED && conversation.pancakeConversationId);
    const cartSince = (Number(change.message?.createdAt) || Date.now()) - 5 * 60 * 1000;
    const shopOrder = canFindShopOrder ? await dependencies.findShopOrder(conversation, { since: cartSince }).catch(() => null) : null;
    // Dưới bình luận, câu trả lời theo luật khi không có model: bảng giá sản
    // phẩm của bài, lời chào live, hay bảng giá chung.
    const postProduct = conversation.source === 'comment'
      ? resolveConversationProduct({ adTitle: conversation.referral?.adTitle, referralRef: conversation.referral?.ref, postText: conversation.post?.message }).product
      : '';
    const commentRuleReply = () => renderChatbotReply(
      productHint(postProduct) && templates?.PRICE_QUOTE ? { template_id: 'PRICE_QUOTE', Product_N1: postProduct } : { template_id: 'GENERAL_INFO' },
      templates, replyContext
    );
    const askModel = async (extra = {}) => {
      try {
        const answer = await requestReply({ settings, conversation: { ...conversationForModel, ...extra }, message, recentMessages: recent.filter(item => !bundled.has(item?.id)), context: replyContext });
        // Nhật ký: lượt LLM gần nhất (hint: lý do gọi lại — giỏ đang giữ mà khách hỏi; dùng thử).
        trace.llm = {
          templateId: answer?.templateId || '',
          retried: Boolean(answer?.retried),
          hint: extra.replyHint ? 'basket-question' : extra.trialHint ? 'trial' : '',
          usage: answer?.usage || null,
          model: answer?.model || '',
          calls: (trace.llm?.calls || 0) + 1
        };
        if (Array.isArray(answer?.fewShot)) trace.fewShot = answer.fewShot;
        return answer;
      } catch (error) {
        // Model hết hạn mức/quá tải dưới bình luận: không để bình luận rơi —
        // trả lời theo luật (bảng giá bài viết / lời chào live / bảng giá chung).
        if (conversation.source === 'comment' && isCapacityError(error) && templates?.GENERAL_INFO) {
          console.warn(`Model lỗi dưới bình luận (${conversation.id}): ${error.message} — trả lời theo luật.`);
          return commentRuleReply();
        }
        throw error;
      }
    };
    // Lời đáp ngắn ("ok", "dạ", "cảm ơn") của khách.
    // Lời đáp ngắn, hay chỉ emoji/sticker chữ ("💕", "🥰🥰") sau đơn: cảm ơn, không hỏi mô hình.
    // Chữ một ký tự (a/c/e/u) chỉ đứng một mình hay làm đuôi ("dạ a", "ok c"): ghép tự do
    // từng biến "ủa" (u+a), "đâu" (da+u), "ca" (c+a) thành lời cảm ơn.
    const shortAck = message.type === 'text' && (/^(?:(?:ok|oke|okie|okay|okela|da|vang|uh|um|nhe|nha|shop|cam ?on|thanks?|tks|\.|👍|❤️)+(?:a|c|e)?|[aceu])$/i.test(folded.replace(/\s+/g, ''))
      || (/^[\p{Extended_Pictographic}\p{Emoji_Modifier}‍️\s.!]+$/u.test(String(message.text || '')) && /\p{Extended_Pictographic}/u.test(String(message.text || ''))));
    // "ok" ngay sau tin xác nhận/sửa đơn: cảm ơn luôn, không hỏi mô hình — mô hình
    // từng đọc lịch sử cũ và trả lời "ok" bằng tư vấn mẹ bầu/tiểu đường.
    const orderJustClosed = ['ORDER_CONFIRMATION', 'ORDER_UPDATE', 'ORDER_UNCHANGED', 'ORDER_NOTE', 'SHOP_ORDER_RECEIVED'].includes(conversation.botLastTemplateId);
    // Chỉ emoji ("🥰", "👍") ngay sau lời cảm ơn / tin đơn hàng: không cần trả lời gì thêm.
    const emojiOnly = message.type === 'text' && /^[\p{Extended_Pictographic}\p{Emoji_Modifier}‍️\s.!]+$/u.test(String(message.text || '')) && /\p{Extended_Pictographic}/u.test(String(message.text || ''));
    if (emojiOnly && (conversation.botLastTemplateId === 'THANK_YOU' || String(conversation.botLastTemplateId || '').startsWith('ORDER_'))) {
      results.push({ conversationId: conversation.id, skipped: 'chỉ emoji' });
      return;
    }
    const ackReply = shortAck && orderJustClosed && templates?.THANK_YOU
      ? renderChatbotReply({ template_id: 'THANK_YOU' }, templates, replyContext)
      : null;
    // Giỏ đang giữ (còn hạn) và bot vừa ở bước đơn.
    const basketHeld = Boolean(usablePendingOrder(conversation.pendingOrder, { templateId: 'ORDER_ADDRESS' })?.items?.length);
    const orderStepLast = isOrderStep(conversation.botLastTemplateId) || ['ASK_FLAVOR', 'ORDER_ADDRESS_REMIND', 'ORDER_CUSTOM_BASKET'].includes(conversation.botLastTemplateId);
    // Lời "có/ok/gửi đi" sau khi bot hỏi "cần bảng giá combo gói nhỏ không?" (PACKAGING_INFO):
    // gửi bảng giá Combo 10 gói theo màu khách đang nói (mặc định Xanh), không hỏi mô hình.
    const ackCore = folded.replace(/[.!?…,]+/g, ' ').replace(/\s+/g, ' ').trim().replace(/(?: (?:a|nha|nhe|shop|em|e|c|chi|anh|di|voi|luon))+$/, '');
    const yesAck = shortAck || (ackCore.length > 0
      && /^(?:(?:ok|oke|okie|okay|oki|da|vang|co|duoc|dc|u|uh|ua)\s*)*(?:(?:gui|xin|cho xin|cho|xem|coi)\s*)?(?:(?:di|em|minh|luon|bang gia|thu|coi|xem|cho (?:em|minh|chi|c|a|anh))\s*)*$/.test(ackCore));
    const comboQuote = (() => {
      if (!yesAck || conversation.botLastTemplateId !== 'PACKAGING_INFO' || !templates?.PRICE_QUOTE) return null;
      const mentioned = [...replyContext.recentCustomerTexts, String(message.text || '')].map(text => foldVietnamese(text)).join(' ').match(/\b(xanh|nau|cacao|cam|mix)\b/g) || [];
      const colour = (mentioned.at(-1) || 'xanh').replace('cacao', 'nau');
      const combo = getCatalogProducts().find(item => item.active !== false && /^CB10-/i.test(String(item.sku || '')) && String(item.sku || '').toLowerCase().includes(`-${colour}`))
        || getCatalogProducts().find(item => item.active !== false && /^CB10-XANH/i.test(String(item.sku || '')));
      return combo ? renderChatbotReply({ template_id: 'PRICE_QUOTE', Product_N1: combo.name }, templates, replyContext) : null;
    })();
    // "Ok/Dạ/👍" khi giỏ còn thiếu SĐT/địa chỉ: nhắc ngắn giỏ + phần còn thiếu, không cảm ơn suông.
    const remindAck = (() => {
      if (!shortAck || !basketHeld || !orderStepLast || orderJustClosed) return null;
      const held = renderChatbotReply({ template_id: 'ORDER_ADDRESS' }, templates, replyContext);
      return held.remind ? { templateId: 'ORDER_ADDRESS_REMIND', messages: [held.remind], images: [], handoff: false } : null;
    })();
    // Sau khi bot gửi thông tin chuyển khoản (BANK_TRANSFER): khách gửi ảnh hay "ck rồi / chuyển xong"
    // là bill → báo đã nhận, nhân viên kiểm tra và lên đơn (gắn thẻ); không "đã nhận hình, cần hỗ trợ gì".
    const paidText = message.type === 'text' && (/\b(?:ck|chuyen khoan|chuyen tien|chuyen|thanh toan|tt)(?: tien)?(?: cho (?:em|shop|minh|ben em))? (?:roi|xong|r|thanh cong)\b/.test(folded) || /\b(?:da|vua|moi) (?:ck|chuyen khoan|chuyen tien|thanh toan|chuyen)\b/.test(folded));
    const paymentReply = conversation.botLastTemplateId === 'BANK_TRANSFER' && (message.type === 'image' || paidText)
      ? (() => { const paid = renderChatbotReply({ template_id: 'PAYMENT_RECEIVED_CHECK' }, templates, replyContext); return paid.templateId === 'PAYMENT_RECEIVED_CHECK' ? { ...paid, attention: true } : null; })()
      : null;
    // Đang chờ khách xác nhận đặt THÊM đơn (đã có đơn trong 7 ngày, xem ORDER_EXISTING_CONFIRM bên dưới):
    // "đúng/ok/lên đơn" → chốt giỏ đang giữ; "không/đơn cũ/kiểm tra" → kể đơn cũ, gắn thẻ cho nhân viên.
    // Chỉ đọc yes/no khi bot VỪA hỏi (mẫu gần nhất là ORDER_EXISTING_CONFIRM) và giỏ chờ còn hạn.
    // "Yes" phải là cả câu đáp ngắn ("đúng rồi e", "ok lên đơn đi"): "Dạ cảm ơn shop", "Đã đặt rồi mà"
    // mở đầu bằng dạ/đã không phải đồng ý. Tin nêu túi/số lượng/đổi giỏ/câu hỏi để luật/mô hình đọc
    // (giỏ mới sẽ được hỏi lại ở ORDER_EXISTING_CONFIRM bên dưới).
    const awaitingAsked = conversation.botLastTemplateId === 'ORDER_EXISTING_CONFIRM' && Boolean(conversation.pendingOrder?.awaitingConfirm);
    const awaitingPending = awaitingAsked ? usablePendingOrder(conversation.pendingOrder, { templateId: 'ORDER_ADDRESS' }) : null;
    // Đã hỏi "đặt thêm?" trong 30 phút (pendingOrder.at là lúc hỏi): không hỏi lại lần hai trong cùng
    // hội thoại — khách nhắn tin khác có/không thì xử lý bình thường, giữ cờ chờ (log: hỏi 2 lần trong 4 phút).
    const awaitingRecent = Boolean(conversation.pendingOrder?.awaitingConfirm) && Date.now() - (Number(conversation.pendingOrder?.at) || 0) < 30 * 60 * 1000;
    // Dấu câu bỏ hết ("Đúng rồi, lên đơn giúp chị" cũng là đồng ý); "đơn mới" không số/không màu chính là đồng ý.
    const awaitingText = folded.trim().replace(/[,;:.!…]+/g, ' ').replace(/\s+/g, ' ').trim();
    const awaitingOther = /\d|\?/.test(awaitingText) || /\b(tui|goi|bich|xanh|vang|nau|cacao|combo|doi|sua|dia chi)\b/.test(awaitingText);
    const awaitingNo = Boolean(awaitingPending) && message.type === 'text' && !awaitingOther
      && /\b(khong|ko|kg|hong phai|huy|don cu|don do|don kia|don truoc|nham|kiem tra|check|xem lai)\b/.test(awaitingText);
    const awaitingYes = Boolean(awaitingPending) && !awaitingNo && message.type === 'text' && !awaitingOther && awaitingText.length <= 40
      && /^(?:da|vang|dung|ok|oke|okie|okay|co|u|uh|len don|chot|yes|dat|dat them|dat luon)(?: (?:a|roi|r|nha|nhe|em|e|shop|c|chi|anh|di|luon|nhe shop|nha shop|len don|dat them|dat|chot|dung|ok|da|vang|don moi|cho (?:em|minh|chi|anh|c|e)|giup (?:em|minh|chi|c|e)))*$/.test(awaitingText);
    const existingConfirmReply = awaitingYes
      ? renderChatbotReply({ template_id: 'ORDER_CONFIRMATION', Phone_Number: awaitingPending.phone || '0', Customer_Address: awaitingPending.address || '0' }, templates, replyContext)
      // "Không": kể lại đơn đang có — đơn trong hội thoại, hay đơn ngoài (landing/POS) đã lưu kèm giỏ chờ.
      : awaitingNo ? { ...renderChatbotReply({ template_id: 'ORDER_STATUS' }, templates, { ...replyContext, recentOrder: recentOrder || conversation.pendingOrder?.externalOrder || null }), attention: true, pendingOrder: null } : null;
    // Ngay sau bảng giá một sản phẩm, "dùng thử" / "combo 2" / "3 túi" là khách đã
    // chọn: lên bước xin SĐT/địa chỉ với đúng sản phẩm vừa báo giá. Mô hình hay
    // gửi lại bảng giá vì chữ "dùng thử" có sẵn trong bảng (khách bỏ đi).
    const quoteAge = Date.now() - (Number(conversation.botLastReplyAt) || 0);
    const quotedName = !nonText && (conversation.botLastTemplateId === 'PRICE_QUOTE' || (conversation.botLastTemplateId === 'GENERAL_INFO' && recent.some(item => item?.direction === 'outgoing' && /Bảng giá (.+?) để/u.test(String(item.text || '')) && Date.now() - (Number(item.createdAt) || 0) < 30 * 60 * 1000))) && quoteAge < 30 * 60 * 1000
      ? [...recent].reverse().filter(item => item?.direction === 'outgoing').map(item => String(item.text || '').match(/Bảng giá (.+?) để/u)?.[1]).find(Boolean) || ''
      : '';
    const quoted = quotedName ? matchProduct(quotedName) : null;
    const choice = folded.trim().replace(/[.!]+$/, '').replace(/(\s+(nha|nhe|a|shop|em|e|nha shop|nhe shop|luon|di))+$/, '');
    const lead = '^(?:(?:cho|lay|dat|gui|ship|mua)\\s+)?(?:(?:em|minh|chi|c|e|a|anh|to|tui)\\s+)?(?:(?:lay|dat|mua)\\s+)?';
    const chosenQuantity = !quoted ? 0
      : new RegExp(`${lead}(?:(?:1|mot)\\s+(?:tui|goi|bich|hop)\\s+)?(?:dung thu|lay thu|an thu|mua thu)$`).test(choice) ? 1
        : new RegExp(`${lead}(?:combo\\s*2(?:\\s*(?:tui|goi|bich|hop))?|2\\s*(?:tui|goi|bich|hop))$`).test(choice) ? 2
          : new RegExp(`${lead}(?:combo\\s*3(?:\\s*(?:tui|goi|bich|hop))?|combo gia dinh|3\\s*(?:tui|goi|bich|hop))$`).test(choice) ? 3 : 0;
    const choiceReply = chosenQuantity
      ? renderChatbotReply({ template_id: 'ORDER_ADDRESS', Product_N1: quoted.name, No_A: String(chosenQuantity) }, templates, replyContext)
      : null;
    // Khách hỏi đơn đã đặt và gửi SĐT: tra đơn theo SĐT ở mọi hội thoại (đơn đặt
    // ở trang kia, qua bình luận…) thay vì coi SĐT là thông tin cho đơn MỚI.
    // Không gồm "xác nhận đơn"/"mua rồi": "xác nhận đơn giúp chị: 2 túi xanh, SĐT…"
    // và "mua rồi thấy ngon, lấy thêm 2 túi" là ĐẶT đơn mới, không phải tra đơn.
    const asksAboutOrder = /\b(da dat|dat roi|da mua|da chot|chua (thay|nhan)( duoc)? (hang|don)|don (toi|den) dau|gui hang chua|kiem tra don|tra don)\b/.test(folded);
    // "gói" bỏ dấu trùng "gọi" ("gọi trước khi giao"): chỉ tính khi có số hay "gói nhỏ".
    const namesProducts = /\b(tui|\d+ ?goi|goi nho|bich|hop|combo|xanh|vang|nau|cacao|lay them)\b/.test(folded);
    const phoneInText = nonText ? '' : extractVietnamesePhone(message.text || '');
    let lookupReply = null;
    if (phoneInText && !recentOrder?.id && !namesProducts && (asksAboutOrder || conversation.botLastTemplateId === 'ORDER_STATUS') && dependencies.findOrdersByPhone) {
      const found = (await dependencies.findOrdersByPhone(phoneInText).catch(() => [])) || [];
      lookupReply = found.length
        ? renderChatbotReply({ template_id: 'ORDER_STATUS' }, templates, { ...replyContext, recentOrder: found[0] })
        : templates?.ORDER_STATUS_CHECKING
          ? { ...renderChatbotReply({ template_id: 'ORDER_STATUS_CHECKING' }, templates, replyContext), attention: true }
          : null;
    }
    // Khách vừa đặt dặn thêm về giao hàng ("gửi hàng mới cho mình", "giao giờ hành
    // chính", "gọi trước khi giao"): ghi chú vào đơn, trả lời ngắn — mô hình từng
    // chọn ORDER_STATUS và gửi lại cả đoạn trạng thái đơn khách vừa đọc xong.
    // Chỉ lời dặn THUẦN: hộp thư, tin ngắn, không SĐT/số nhà/sản phẩm, không kèm
    // sửa địa chỉ, đặt thêm, bớt túi hay câu hỏi — những tin đó để mô hình xử lý.
    const deliveryNote = !nonText && hasOrder && conversation.source !== 'comment' && templates?.ORDER_NOTE_ADDED
      && folded.length <= 80 && !phoneInText && !/\d{2,}/.test(folded) && !namesProducts
      && /\b(hang moi|date moi|han (su dung |dung )?(dai|xa|moi|lau)|moi san xuat|giao (gio hanh chinh|buoi|sang|chieu|toi|cuoi tuan|truoc|sau|nhanh|som)|goi (truoc|dien truoc|cho (minh|em|chi|anh|c|e) truoc)|de (o|tai|cho) (bao ve|le tan|cong|nha ben|hang xom)|gui (som|nhanh|gap)|dong goi (can than|ky)|(ngoai )?gio hanh chinh)\b/.test(folded)
      && !/\?|\b(huy|doi|them|nua|bot|sua|lay|dat|mua|dia chi|sdt|so dien thoai|khong lay|chua nhan|bi loi|bi hu|khi nao|bao gio|duoc khong|dc khong|ko|khong)\b/.test(folded);
    const noteReply = deliveryNote ? renderChatbotReply({ template_id: 'ORDER_NOTE' }, templates, replyContext) : null;
    // Luật nhận ý bằng code (processing/rule-intent.mjs): tin ngắn, rõ ý (hỏi giá
    // cụt, ".", chào, giỏ ghi rõ, SĐT trơn, câu hỏi thông tin ngắn) trả thẳng mẫu,
    // không gọi mô hình. settings.ruleIntent: 'on' (mặc định) | 'shadow' (chỉ ghi
    // log so với mô hình) | 'off'.
    const ruleMode = settings.ruleIntent || 'off';
    const ruleProduct = conversation.source === 'comment' ? '' : resolveConversationProduct({ adTitle: conversation.referral?.adTitle, referralRef: conversation.referral?.ref, postText: conversation.post?.message }).product;
    // Luồng riêng cho ưu đãi 1 túi dùng thử: chạy trước mọi câu trả lời nhanh / luật /
    // mô hình của luồng chung (không bảng giá combo, không mời 2 túi). Khách tự xin
    // ≥ 2 túi thì thoát sang luồng thường (giá combo). Xin gặp người, giỏ Shop: như cũ.
    let trialPatch = null;
    let trialOutcome = null;
    if (trialState && !asksForHuman && !cartReply) {
      trialOutcome = trialStep({ text: message.text, type: message.type, trial: trialState, lastTemplateId: conversation.botLastTemplateId || '' });
      trialPatch = trialOutcome.patch || null;
      if (trialOutcome.exit) trialState = null;
      else if (trialPatch) trialState = { ...trialState, ...trialPatch };
      replyContext.trial = trialState;
      // Khách chọn combo 2 túi ngay trong lượt này: quà bát gáo dừa áp từ lượt này.
      if (trialOutcome.exit === 'combo2') replyContext.promoBowl = true;
      console.log(`Dùng thử: ${trialOutcome.exit ? `thoát (${trialOutcome.exit})` : trialOutcome.delegate ? 'nhờ mô hình' : trialOutcome.value.template_id} (${conversation.id})`);
    }
    const trialActive = Boolean(trialState && trialOutcome && !trialOutcome.exit);
    const ruled = message.type === 'text' && !asksForHuman && !cartReply && ruleMode !== 'off'
      ? ruleIntentFn(message.text, {
          source: conversation.source,
          botLastTemplateId: conversation.botLastTemplateId || '',
          // Có SĐT/địa chỉ đơn cũ để "gửi địa chỉ cũ" chốt được; không có thì luật hỏi SĐT đặt lần trước.
          hasPreviousDelivery: Boolean(previousDelivery || (recentOrder?.address && recentOrder?.phone)),
          staffRepliedAfterBot,
          botLastAgeMin: conversation.botLastReplyAt ? (Date.now() - Number(conversation.botLastReplyAt)) / 60000 : Infinity,
          // Giỏ đang giữ chỉ tính khi còn hạn (2 giờ) — giỏ cũ quá hạn làm luật ADDRESS_COMPLETE dựng ASK_PRODUCT.
          hasBasket: Boolean(usablePendingOrder(conversation.pendingOrder, { templateId: 'ORDER_ADDRESS' })?.items?.length),
          lastWasOrderStep: isOrderStep(conversation.botLastTemplateId) || ['ASK_FLAVOR', 'ORDER_ADDRESS_REMIND', 'ORDER_CUSTOM_BASKET'].includes(conversation.botLastTemplateId),
          hasRecentOrder: Boolean(recentOrder?.id),
          orderAgeMin: recentOrder?.id && String(recentOrder.processingStatus || '') !== 'cancelled' ? (Date.now() - (Number(recentOrder.createdAt) || 0)) / 60000 : Infinity,
          livestream: isLivestreamPost(conversation),
          contextProduct: productHint(ruleProduct) ? ruleProduct : '',
          bundleSize: bundle.length,
          complaint: isComplaint({ text: message.text, keywords: settings.complaintKeywords }),
          commentBasket,
          trialOffer: Boolean(trialState),
          experimentalRules: settings.experimentalRules || 'shadow',
          quotedProduct: quotedName || '',
          addressComplete: Boolean(message.type === 'text' && conversation.pendingOrder?.items?.length && describeDeliveryAddress(String(message.text || '').replace(/\+?\d[\d .-]{8,13}/g, ' ').trim()).complete),
          addressText: String(message.text || '').replace(/\+?\d[\d .-]{8,13}/g, ' ').replace(/\s+/g, ' ').trim(),
          smallPackContext: conversation.botLastTemplateId === 'PACKAGING_INFO'
            || (conversation.pendingOrder?.items || []).some(item => /^CB10|combo 10/i.test(String(item.code || item.product || '')))
            || replyContext.recentOutgoing.some(text => /gói nhỏ|combo 10 gói/i.test(text))
        })
      : null;
    // Luật trả `clearBasket` (khách hoãn: ORDER_POSTPONED) → bỏ giỏ đang giữ; `values` trong value
    // (NO_VARIANT {ingredient}) do renderChatbotReply điền vào mẫu.
    const ruleReply = ruled
      ? (ruled.commentRule ? commentRuleReply() : { ...renderChatbotReply(ruled.value, templates, replyContext), ...(ruled.attention ? { attention: true } : {}), ...(ruled.clearBasket || ruled.value?.clearBasket ? { pendingOrder: null } : {}) })
      : null;
    // Luật thử nghiệm: chỉ dùng khi settings.experimentalRules = 'on'; còn lại ghi log so với mô hình.
    // Mô hình ra quyết định (nhỏ, học từ hội thoại shop): đoán mẫu + xác suất trước khi hỏi LLM.
    // Chế độ 'shadow' (mặc định) chỉ ghi log so với câu trả lời thật ở cuối lượt.
    const intentMode = settings.intentModel || 'shadow';
    // Chỉ hộp thư: bình luận đi luồng riêng (mẫu COMMENT_*), so sánh không có nghĩa.
    const intentEligible = message.type === 'text' && conversation.source !== 'comment' && !asksForHuman && !cartReply && !trialActive;
    // Row chung cho mô hình phẳng và mô hình tầng: ngữ cảnh v2 + các trường của decisionContext (mô hình v5 bỏ
    // qua đặc trưng lạ; tầng và v6 dùng hasOrder/orderAgeMin/prevBotAsks/phoneInText/addressInText/bagCount…).
    const intentRow = intentEligible ? {
      text: message.text, source: conversation.source, lastTemplate: conversation.botLastTemplateId || '',
      lastWasOrderStep: isOrderStep(conversation.botLastTemplateId),
      hasBasket: Boolean(usablePendingOrder(conversation.pendingOrder, { templateId: 'ORDER_ADDRESS' })?.items?.length),
      livestream: isLivestreamPost(conversation),
      hasOrder: Boolean(hasOrder), hasRecentOrder: Boolean(trace.ctx?.hasRecentOrder), orderAgeMin: trace.ctx?.orderAgeMin ?? null,
      prevBotAsks: prevBotAsks(conversation.botLastTemplateId, conversation.pendingOrder),
      phoneInText: Boolean(phoneInText), addressInText: Boolean(trace.ctx?.addressInText), bagCount: Number(trace.ctx?.bagCount) || 0,
      staffRepliedAfterBot: Boolean(staffRepliedAfterBot)
    } : null;
    const intent = intentMode !== 'off' && intentRow ? predictIntent(intentRow) : null;
    const intentThreshold = Number(settings.intentThreshold) || 0.9;
    const intentUsable = Boolean(intent) && intentMode === 'on' && intent.confidence >= intentThreshold && intent.margin >= 0.25 && intentSafeTemplates.has(intent.templateId) && templates?.[intent.templateId] !== undefined
      && !phoneInText && conversation.source !== 'comment';
    const intentReply = intentUsable ? renderChatbotReply({ template_id: intent.templateId, ...(intent.templateId === 'PRICE_QUOTE' && productHint(ruleProduct) ? { Product_N1: ruleProduct } : {}) }, templates, replyContext) : null;
    // Mô hình tầng: cùng `row`, cùng điều kiện với mô hình phẳng; lỗi mô-đun → như không có. 'on' chỉ tự trả
    // lời nhóm ANSWER (hay PRICE/INFO/SOCIAL) với mẫu an toàn, pGroup ≥ 0,85, pWithin ≥ cascadeThreshold, biên trong
    // nhóm ≥ 0,25, cùng rào của mô hình phẳng (không SĐT, không bình luận, không dùng thử/giỏ Shop qua intentEligible)
    // và rào cứng: không màu/số túi trong tin, không khiếu nại, có đơn gần đây thì không SHIPPING_POLICY/WELCOME/
    // DELIVERY_DELAY, loại hẳn WELCOME; ORDER/SUPPORT/OTHER không bao giờ. Canary: ngoài phần hash → chạy như shadow.
    const cascade = cascadeMode !== 'off' && intentRow && predictCascadeFn
      ? (() => { try { const out = predictCascadeFn(intentRow); return out && typeof out === 'object' && out.group ? out : null; } catch (error) { console.warn(`Mô hình tầng lỗi: ${String(error?.message || error).slice(0, 120)}`); return null; } })()
      : null;
    // pWithin/marginWithin (xác suất mẫu trong nhóm) là chuẩn; mô-đun cũ chưa trả thì dùng p/margin (ghi log một lần mỗi tiến trình).
    const cascadeWithin = cascade ? { p: Number(cascade.pWithin ?? cascade.p) || 0, margin: Number(cascade.marginWithin ?? cascade.margin) || 0, fallback: cascade.pWithin === undefined || cascade.marginWithin === undefined } : null;
    if (cascadeWithin?.fallback && !cascadeWithinWarned) { cascadeWithinWarned = true; console.log('Mô hình tầng: kết quả chưa có pWithin/marginWithin — dùng p/margin thay (mô-đun cũ)'); }
    const cascadeCanary = cascadeMode === 'on' ? canaryBucket(conversation.id) < (settings.cascadeCanary === undefined ? 100 : Number(settings.cascadeCanary) || 0) : null;
    const cascadeColourNumber = /\b(xanh|vang|nau|cacao)\b/.test(folded) && /\d/.test(folded.replace(/\+?\d[\d .-]{8,13}/g, ' '));
    const cascadeComplaint = isComplaint({ text: message.text, keywords: settings.complaintKeywords }) || conversationLabels.some(label => /^(complaint|warranty)$/.test(label));
    const cascadeHardBlock = Boolean(cascade) && (
      (Number(trace.ctx?.bagCount) || 0) > 0 || cascadeColourNumber || cascadeComplaint
      || (Boolean(trace.ctx?.hasRecentOrder) && cascadeNoRecentOrderTemplates.has(cascade.templateId))
      || cascadeExcludedTemplates.has(cascade.templateId)
    );
    const cascadeUsable = Boolean(cascade) && cascadeMode === 'on' && cascadeCanary === true && cascadeAutoGroups.has(String(cascade.group))
      && Number(cascade.pGroup) >= CASCADE_GROUP_THRESHOLD && cascadeWithin.p >= (Number(settings.cascadeThreshold) || 0.8) && cascadeWithin.margin >= 0.25
      && intentSafeTemplates.has(cascade.templateId) && templates?.[cascade.templateId] !== undefined && !phoneInText && conversation.source !== 'comment' && !cascadeHardBlock;
    const cascadeReply = cascadeUsable ? renderChatbotReply({ template_id: cascade.templateId, ...(cascade.templateId === 'PRICE_QUOTE' && productHint(ruleProduct) ? { Product_N1: ruleProduct } : {}) }, templates, replyContext) : null;
    const ruleUsable = Boolean(ruled) && !ruled.shadowOnly;
    const ruleShadow = Boolean(ruled) && (ruleMode === 'shadow' || !ruleUsable);
    if (ruled) console.log(`Luật ${ruled.rule}${ruleShadow ? ' (thử)' : ''} → ${ruleReply.templateId} (${conversation.id})`);
    // Luật thử nghiệm đính kèm một luật ổn định: ghi log so với luật ổn định, không đổi câu trả lời.
    // Giá trị luật thử là JSON thô: soạn qua renderChatbotReply (cùng ngữ cảnh) rồi mới so mẫu.
    if (ruled?.shadow) console.log(shadowRuleLine(ruled.shadow, ruleReply.templateId, value => renderChatbotReply(value, templates, replyContext), conversation.id));
    // Nhật ký: luật ổn định đang dùng thật, luật thử (kèm luật ổn định khi chỉ chạy ẩn), mô hình nhỏ (top-K).
    const ruleLive = Boolean(ruled) && ruleUsable && ruleMode === 'on';
    trace.rule = ruleLive ? { name: ruled.rule, templateId: ruleReply.templateId } : null;
    trace.shadow = [
      ...(ruled && !ruleLive ? [{ name: ruled.rule, templateId: ruleReply.templateId }] : []),
      ...(ruled?.shadow ? [{ name: ruled.shadow.rule, templateId: ruled.shadow.commentRule ? ruleReply.templateId : ruled.shadow.value ? renderChatbotReply(ruled.shadow.value, templates, replyContext)?.templateId || '' : '' }] : [])
    ];
    trace.intent = intent ? { templateId: intent.templateId, p: round2(intent.confidence), margin: round2(intent.margin), topK: intentTopK(intent) } : null;
    trace.cascade = cascade ? { ...cascadeTrace(cascade), canary: cascadeCanary } : null;
    // Sau ASK_PRODUCT/ASK_FLAVOR, khách chỉ nêu MỘT màu mà trước đó đang hỏi giá ("2 túi giá bao nhiêu"
    // → "xanh"): báo giá màu đó, không lên đơn 1 túi (ca Đào Bia). Không hỏi giá trước → để luật/mô hình.
    const priceAsk = /\b(gia|bao nhieu|bao nhiu|bn|bnhiu|nhieu tien|nhiu tien|bao tien|bao gia)\b/;
    const colourQuote = (() => {
      if (nonText || !['ASK_PRODUCT', 'ASK_FLAVOR'].includes(conversation.botLastTemplateId) || phoneInText || /\d/.test(folded) || !templates?.PRICE_QUOTE) return null;
      const colours = [...new Set((folded.match(/\b(xanh|vang|nau|cacao)\b/g) || []).map(colour => (colour === 'cacao' ? 'nau' : colour)))];
      const leftover = folded.replace(/\b(xanh|vang|nau|cacao|la|cay|tui|goi|bich|granola|vi|mau|loai|cho|em|minh|chi|c|e|a|anh|lay|nha|nhe|shop|di)\b/g, '').replace(/[^a-z]/g, '');
      if (colours.length !== 1 || leftover) return null;
      const earlier = replyContext.recentCustomerTexts.filter(text => squashText(text) !== squashText(message.text)).slice(-3);
      if (!earlier.some(text => priceAsk.test(foldVietnamese(text)))) return null;
      const product = getCatalogProducts().find(item => item.active !== false && /^gra-/i.test(item.sku || '') && String(item.sku || '').toLowerCase().includes(`-${colours[0]}-`));
      return product ? renderChatbotReply({ template_id: 'PRICE_QUOTE', Product_N1: product.name }, templates, replyContext) : null;
    })();
    // Khách lặp lại câu vừa hỏi, hay chỉ giục ("sao chưa trả lời", "???", "alo"): chỉ khi đó mới
    // được nhắc "em vừa gửi ở trên". Tin có ý mới / dấu hỏi thì không.
    const previousIncoming = [...recent].reverse().find(item => item?.direction === 'incoming' && item.id !== message.id && (!message.mid || item.mid !== message.mid) && !bundled.has(item.id));
    const customerRepeats = Boolean(previousIncoming) && textSimilarity(previousIncoming.text, message.text) >= 0.8;
    const nudgeLike = message.type === 'text' && isNudgeMessage(message.text);
    // Gác trước LLM (settings.preGuard: 'shadow' mặc định | 'on' | 'off'): hộp thư, tin chữ không SĐT/địa
    // chỉ, khách chỉ giục hay lặp y câu (≥ 80%, trong 10 phút, câu trước không có dấu hỏi) ngay sau một
    // mẫu THÔNG TIN của bot mà bot chưa nhắc lần nào → "đã gửi ở trên" không cần hỏi mô hình. 'shadow'
    // vẫn hỏi mô hình, chỉ ghi so sánh vào nhật ký (guards.preGuard) + log; 'on' trả luôn.
    const preGuardMode = ['on', 'shadow', 'off'].includes(settings.preGuard) ? settings.preGuard : 'shadow';
    const preGuard = (() => {
      if (preGuardMode === 'off' || nonText || conversation.source === 'comment' || asksForHuman || cartReply || trialActive || phoneInText || trace.ctx?.addressInText) return null;
      const last = String(conversation.botLastTemplateId || '');
      if (!last || isOrderStep(last) || /^(ORDER_|TRIAL_|COMMENT_|FOLLOW_UP_)/.test(last) || preGuardExcludedLast.has(last)) return null;
      if (Date.now() - (Number(conversation.botLastReplyAt) || 0) >= 24 * 60 * 60 * 1000 || staffRepliedAfterBot) return null;
      const prevAt = Number(previousIncoming?.createdAt) || 0;
      const repeatsPlain = Boolean(previousIncoming) && customerRepeats && prevAt <= (Number(conversation.botLastReplyAt) || 0)
        && (Number(message.createdAt) || Date.now()) - prevAt <= 10 * 60 * 1000 && !/\?/.test(String(previousIncoming.text || ''));
      if (!nudgeLike && !repeatsPlain) return null;
      const nudgeId = priceFamilyTemplates.has(last) && !hasOrder ? 'REPLY_ALREADY_SENT' : 'REPLY_ALREADY_SENT_INFO';
      if (!templates?.[nudgeId]) return null;
      const rendered = renderChatbotReply({ template_id: nudgeId }, templates, replyContext);
      if (rendered.templateId !== nudgeId) return null;
      return { decision: nudgeId, reason: nudgeLike ? 'nudge' : 'repeat', reply: { ...rendered, attention: nudgeId === 'REPLY_ALREADY_SENT_INFO' } };
    })();
    trace.preGuard = preGuard ? { decision: preGuard.decision, reason: preGuard.reason, mode: preGuardMode, matched: null } : null;
    let reply = asksForHuman
      ? renderChatbotReply({ template_id: 'CSKH_HANDOFF', warming: '1' }, templates, replyContext)
      : cartReply
        // Khách giữ ưu đãi dùng thử mà đặt qua giỏ Shop (Shop tự cộng ship): gắn thẻ
        // để nhân viên sửa đơn miễn ship trên POS.
        ? (trialState ? { ...(shopOrder ? shopOrderReply(shopOrder) : cartReply), attention: true } : shopOrder ? shopOrderReply(shopOrder) : cartReply)
        // Bill chuyển khoản sau BANK_TRANSFER, rồi khách vừa được hỏi "đặt thêm đơn?" mà đáp đúng/không:
        // xử lý trước cả luồng dùng thử.
        : paymentReply || existingConfirmReply || (trialOutcome?.value
          ? renderChatbotReply(trialOutcome.value, templates, replyContext)
          : trialActive
            ? (nonText && !seesImage
              ? { ...renderChatbotReply({ template_id: templates?.IMAGE_RECEIVED ? 'IMAGE_RECEIVED' : 'CSKH_HANDOFF' }, templates, replyContext), attention: true }
              : await askModel({ trialHint: trialModelHint(trialState) }))
            : nonText
              ? (seesImage ? await askModel() : imageFallback())
              : ackReply || comboQuote || remindAck || noteReply || lookupReply || choiceReply || colourQuote || quickQuote || (ruleMode === 'on' && ruleUsable ? ruleReply : null) || (cascadeReply?.templateId === cascade?.templateId ? cascadeReply : null) || (intentReply?.templateId === intent?.templateId ? intentReply : null) || (preGuardMode === 'on' && preGuard ? preGuard.reply : null) || await askModel());
    // Mẫu mô hình/luật CHỌN, trước mọi hậu xử lý (để log so mô hình nhỏ không bị ✗ giả).
    const chosenTemplateId = reply.templateId;
    trace.chosen = chosenTemplateId;
    // Người gác (processing/llm-router.mjs): LLM có cùng nhóm với mô hình nhỏ (top-K) / luật ổn định không — chỉ ghi.
    // Tham chiếu gộp: top-K mô hình phẳng + top-K mô hình tầng (reason 'cascade-top1'/'cascade-topk').
    trace.gate = trace.llm ? gateCheckWithCascade({ llmTemplateId: trace.llm.templateId, intentTopK: trace.intent?.topK || [], cascadeTopK: trace.cascade?.topK || [], ruleTemplateId: trace.rule?.templateId || '' }) : null;
    // Mô hình trả lời khách đang giữ ưu đãi bằng mẫu của luồng chung (bảng giá, combo,
    // mời 2 túi, "từ 2 túi miễn ship"): đổi sang mẫu dùng thử.
    if (trialActive && !trialOutcome.value) {
      const replacement = filterTrialReply(reply, trialState, isProductQuoteId);
      if (replacement) reply = renderChatbotReply(replacement, templates, replyContext);
    }
    // Mô hình vẫn chọn "đã gửi ở trên" cho một câu hỏi mới (prompt đã bỏ hai mẫu này khỏi lựa chọn):
    // chuyển nhân viên (gắn thẻ), KHÔNG gọi lại mô hình lần hai (vòng 8 gọi lại tốn 2 lượt LLM mỗi ca)
    // — không bảo khách "xem ở trên" lần nữa.
    if (nudgeTemplateIds.includes(reply.templateId) && !customerRepeats && !nudgeLike && !nonText) {
      reply = { ...renderChatbotReply({ template_id: 'CSKH_HANDOFF', warming: '1' }, templates, replyContext), attention: true };
    }
    // Đang giữ giỏ mà khách HỎI ("cho xem hình bát", "túi nào ngon", "có yến mạch không?"): phải trả lời
    // câu hỏi rồi kèm nhắc giỏ (ORDER_ADDRESS_REMIND), không được trả nhắc giỏ trơn. Ảnh quà (bát gáo
    // dừa) chỉ gửi khi quà có ảnh trong Cài đặt; không có thì kể chính sách quà.
    const basketQuestion = !nonText && basketHeld && orderStepLast && !phoneInText && !awaitingAsked && !cartReply && !asksForHuman && !nudgeLike && !shortAck
      && (/\?/.test(String(message.text || '')) || /\b(cho xem|xem|coi|nao|sao|khac gi|duoc (khong|ko|k)|co (khong|ko|k)|bao nhieu|bn)\b/.test(folded))
      && !describeDeliveryAddress(String(message.text || '')).complete;
    const giftPhotoAsk = basketQuestion && /\b(hinh|anh|xem|coi)\b/.test(folded) && /\b(bat|gao dua|qua|muong|dua)\b/.test(folded);
    if (basketQuestion && !reply.order && !reply.handoff) {
      const remind = renderChatbotReply({ template_id: 'ORDER_ADDRESS' }, templates, replyContext).remind || '';
      const orderish = item => isOrderStep(item.templateId) || ['ORDER_ADDRESS_REMIND', 'ORDER_CUSTOM_BASKET', 'ASK_FLAVOR', 'ASK_PRODUCT', 'THANK_YOU', 'WELCOME'].includes(item.templateId);
      let answer = null;
      if (giftPhotoAsk) {
        const giftImages = getGifts().filter(gift => gift.active !== false && (gift.image || (Array.isArray(gift.images) && gift.images.length)));
        answer = giftImages.length && templates?.PRODUCT_PHOTOS
          ? renderChatbotReply({ template_id: 'PRODUCT_PHOTOS', values: { products: giftImages.map(gift => gift.name).join(', '), images: giftImages.flatMap(gift => [gift.image, ...(Array.isArray(gift.images) ? gift.images : [])].filter(Boolean).slice(0, 2).map(url => `![${gift.name}](${url})`)).join(' ') } }, templates, replyContext)
          : renderChatbotReply({ template_id: 'GIFT_POLICY' }, templates, replyContext);
        if (answer.handoff) answer = null;
      } else if (orderish(reply) && !reply.alsoTemplateId) {
        // Luật/mô hình lặp bước xin SĐT: hỏi lại mô hình, nhắc rằng giỏ đã lưu và khách đang hỏi.
        const again = await askModel({ replyHint: 'LƯU Ý: giỏ hàng của khách ĐÃ LƯU, engine sẽ tự nhắc SĐT/địa chỉ. Khách đang HỎI — chọn mẫu thông tin trả lời đúng câu hỏi (không chọn ORDER_ADDRESS/ORDER_CONFIRMATION/ASK_*).' });
        answer = !orderish(again) && !again.handoff && !again.order ? again : null;
      } else if (!orderish(reply)) {
        answer = reply;
      }
      if (answer) {
        const partsOf = item => item.parts || [...item.messages.map(text => ({ type: 'text', text })), ...(item.images || []).map(url => ({ type: 'image', url }))];
        reply = remind
          ? { ...answer, messages: [...answer.messages, remind], parts: [...partsOf(answer), { type: 'text', text: remind }], alsoTemplateId: 'ORDER_ADDRESS_REMIND', pendingOrder: undefined, order: undefined }
          : { ...answer, pendingOrder: undefined, order: undefined };
      } else if (remind && !reply.alsoTemplateId && conversation.botLastTemplateId !== 'ORDER_ADDRESS_REMIND') {
        // Không trả lời được câu hỏi: nhắc giỏ nhưng gắn thẻ để nhân viên trả lời phần khách hỏi
        // (vừa nhắc lượt trước rồi thì để cơ chế chống lặp im + gắn thẻ).
        reply = { templateId: 'ORDER_ADDRESS_REMIND', messages: [remind], images: [], parts: undefined, handoff: false, attention: true };
      }
    }
    // Bảng giá chung (3 vị, giá lẻ chưa ship) một mình làm khách rối và thấy đắt: trong
    // hộp thư gửi kèm luôn bảng giá chi tiết Túi Xanh (1 túi / combo 2 / combo 3 + quà,
    // kèm ảnh). Không áp cho bình luận, phiên live, khách đang giữ ưu đãi dùng thử; bảng
    // Túi Xanh vừa gửi trong 30 phút thì cơ chế ý phụ tự bỏ, không gửi lại.
    const defaultQuoteProduct = findProductBySku('GRA-XANH-Z450')?.name || '';
    if (reply.templateId === 'GENERAL_INFO' && !reply.alsoTemplateId && !trialActive && defaultQuoteProduct
      && conversation.source !== 'comment' && !isLivestreamPost(conversation) && templates?.PRICE_QUOTE) {
      const quote = renderChatbotReply({ template_id: 'PRICE_QUOTE', Product_N1: defaultQuoteProduct }, templates, replyContext);
      const opening = String(quote.messages?.[0] || '').replace(/\s+/g, ' ').trim().slice(0, 40);
      const justSent = opening && replyContext.recentOutgoing.some(text => String(text).replace(/\s+/g, ' ').includes(opening));
      // Pancake tự chào khách bấm quảng cáo bằng bảng 3 giá (có khi cùng phút, chưa kịp vào kho tin):
      // khách đến từ quảng cáo mà bot chưa trả lời gì cũng coi như đã có bảng 3 giá.
      const adGreeted = Boolean(conversation.referral?.adTitle || conversation.referral?.ref) && !conversation.botLastTemplateId;
      // Tin tự động của Page dưới quảng cáo đã liệt kê 3 giá ("bảng giá hiện nay gồm", "Túi Xanh … 174.000đ")
      // trong 30 phút (≈50 ca 26–28/09 nhận bảng 3 giá hai lần): chỉ gửi bảng giá túi mặc định.
      const priceListSent = adGreeted || replyContext.recentOutgoing.some(text => (/174\.000đ/.test(text) && /Túi Vàng/i.test(text) && !/Bảng giá Granola/i.test(text))
        || /bảng giá (hiện nay|hiện tại|bên em|nhà em|của (shop|em))|bảng giá[^\n]{0,40}gồm|Túi Xanh[\s\S]{0,80}174/iu.test(text));
      if (quote.templateId === 'PRICE_QUOTE' && !justSent && priceListSent) reply = { ...quote, ...(reply.attention ? { attention: true } : {}) };
      else if (quote.templateId === 'PRICE_QUOTE' && !justSent) {
        const partsOf = item => item.parts || [...item.messages.map(text => ({ type: 'text', text })), ...(item.images || []).map(url => ({ type: 'image', url }))];
        // Bảng giá chi tiết đi ngay sau: bỏ đoạn cuối "quan tâm loại nào / cần thêm thông tin nào" của bảng
        // chung (hỏi rồi tự trả lời), và không gửi hai bộ ảnh bảng giá cùng lúc (giữ ảnh của bảng chung).
        const closing = /quan tâm loại nào|cần thêm thông tin nào/iu;
        const generalParts = partsOf(reply).filter((part, index, list) => !(part.type === 'text' && closing.test(part.text) && index === list.findLastIndex(item => item.type === 'text')));
        const generalMessages = reply.messages.filter((text, index) => !(closing.test(text) && index === reply.messages.length - 1));
        const quoteParts = (reply.images || []).length ? partsOf(quote).filter(part => part.type !== 'image') : partsOf(quote);
        const quoteImages = (reply.images || []).length ? [] : quote.images || [];
        reply = { ...reply, messages: [...generalMessages, ...quote.messages], parts: [...generalParts, ...quoteParts], images: [...(reply.images || []), ...quoteImages], alsoTemplateId: 'PRICE_QUOTE' };
      }
    }
    // Cùng mẫu dùng thử vừa gửi lượt trước: nhắc ngắn thay vì gửi lại nguyên văn.
    if (trialActive && String(reply.templateId).startsWith('TRIAL_') && reply.templateId !== 'TRIAL_REMIND'
      && conversation.botLastTemplateId === reply.templateId && templates?.TRIAL_REMIND) {
      reply = renderChatbotReply({ template_id: 'TRIAL_REMIND', values: { bags: trialBagOptions() } }, templates, replyContext);
    }
    if (ruleShadow) console.log(`Luật ${ruled.rule} (thử): luật ${ruleReply.templateId} / mô hình ${reply.templateId}${ruleReply.templateId === reply.templateId ? ' ✓' : ' ✗'} (${conversation.id})`);
    if (seesImage && !trialActive && (reply.templateId === 'IMAGE_RECEIVED' || reply.templateId === 'CSKH_HANDOFF')) reply = imageFallback();
    // "Cảm ơn" mà khách chưa có đơn: ảnh (thường là ảnh sản phẩm, không phải
    // bill) → xử lý như ảnh; "đã đặt rồi" → tra đơn. Không cảm ơn suông rồi thôi.
    if (reply.templateId === 'THANK_YOU' && !hasOrder && !ackReply) {
      if (nonText) reply = imageFallback();
      else if (asksAboutOrder) reply = renderChatbotReply({ template_id: 'ORDER_STATUS' }, templates, replyContext);
    }
    // "Chưa nhận được hàng" mà hội thoại không có đơn (đơn ở trang kia, nhân viên
    // lên tay…): bot chỉ xin SĐT được — gắn thẻ để nhân viên tra ngay.
    if (reply.templateId === 'ORDER_STATUS' && !recentOrder?.id && !lookupReply && !reply.attention) reply = { ...reply, attention: true };
    // Khách than giao chậm / chưa nhận: luôn gắn thẻ để nhân viên tra vận đơn.
    if (reply.templateId === 'DELIVERY_DELAY' && !reply.attention) reply = { ...reply, attention: true };
    // Dưới bình luận không bao giờ chuyển người (khách chưa vào hộp thư): trả
    // bảng giá chung và mời nhắn tin. WELCOME/xác nhận đơn/"đã nhận hình" dưới
    // bình luận cũng vô nghĩa (khách đã hỏi giá rồi) → bảng giá sản phẩm của bài.
    // Riêng bình luận là khiếu nại/hủy/đổi đơn/chưa nhận hàng (khách đã là người
    // mua): không chào hàng — nhắn riêng rằng nhân viên sẽ kiểm tra, gắn thẻ.
    // Lời chê dưới bài ("hôi", "không ngon", "ăn k ngon", từ khóa khiếu nại): công khai xin lỗi + gắn thẻ,
    // nhắn riêng nhân viên kiểm tra — bất kể mô hình chọn mẫu gì. "hôi" so trên chữ CÒN DẤU (bỏ dấu
    // trùng "hỏi": "cho hỏi giá").
    const commentComplaint = conversation.source === 'comment' && (
      isComplaint({ text: message.text, keywords: settings.complaintKeywords })
      || /hôi/iu.test(String(message.text || ''))
      || /\b(khong|ko|k|kg|hong|cha|chang) (co |thay |an )?ngon\b|\b(te|do|chan) (qua|that|ghe|ec|lam)\b|\bkem (chat luong|qua)\b/.test(folded));
    const commentNeedsStaff = conversation.source === 'comment'
      && (commentComplaint || /\b(huy|doi don|khieu nai|chua nhan|khong thay (gui|hang)|chua thay (gui|hang)|bi loi|bi hu|sai don|giao sai)\b/.test(folded));
    // Mô hình tự chọn CSKH_HANDOFF dưới bình luận: chỉ chuyển nhân viên khi khách thật sự đòi người /
    // hủy / khiếu nại; còn lại về bảng giá của bài (không "nhân viên sẽ nhắn lại" cho câu hỏi giá).
    const commentWantsPerson = conversation.source === 'comment'
      && /\b(nhan vien|tu van vien|gap (nguoi|ai|nhan vien|admin)|goi (cho|lai|dien)|ai (tra loi|truc|ib)|lien he (lai|voi)|phan anh|so hotline|hotline)\b/.test(folded);
    // Hủy/tra đơn dưới bình luận chỉ được bot tự lo khi có đơn thật; đơn đặt trên
    // web/landing (không có trong hội thoại) thì báo nhân viên, không "chưa thấy đơn".
    // Dưới bình luận bot KHÔNG hủy/sửa/ghi chú/tạo đơn được (chỉ nhắn riêng một
    // lần): "đã hủy đơn" hay "xác nhận đơn" gửi qua bình luận là hứa suông — báo
    // nhân viên, gắn thẻ; giỏ + SĐT + địa chỉ khách ghi đi theo sang hộp thư.
    const commentOrderOp = conversation.source === 'comment' && Boolean(reply.order);
    if (conversation.source === 'comment' && templates?.COMMENT_STAFF_FOLLOWUP && (commentNeedsStaff || commentOrderOp || (reply.templateId === 'CSKH_HANDOFF' && !asksForHuman && commentWantsPerson))
      && !(reply.templateId === 'ORDER_STATUS' && recentOrder?.id)) {
      const carriedOrder = reply.templateId === 'ORDER_CONFIRMATION' && reply.order?.items?.length
        ? { items: reply.order.items.map(item => ({ product: item.product, code: item.code, quantity: item.quantity })), key: reply.order.orderKey || '', at: Date.now(), phone: reply.order.phone || '', address: reply.order.rawAddress || reply.order.address || '', addressAsks: 0 }
        : undefined;
      reply = { ...renderChatbotReply({ template_id: 'COMMENT_STAFF_FOLLOWUP' }, templates, replyContext), attention: true, ...(carriedOrder ? { pendingOrder: carriedOrder } : {}) };
    }
    const commentBlocked = new Set(['CSKH_HANDOFF', 'WELCOME', 'ASK_PRODUCT', 'IMAGE_RECEIVED']);
    if (commentBlocked.has(reply.templateId) && !asksForHuman && conversation.source === 'comment' && templates?.GENERAL_INFO) {
      reply = commentRuleReply();
    }
    // Bình luận nêu rõ giỏ ("C 2 túi vàng", "túi vàng với túi xanh lá") mà model
    // trả bảng giá/so sánh: lên bước xin SĐT/địa chỉ với giỏ đó. Có kèm câu hỏi
    // ("combo 2 túi vàng bn") thì vẫn trả lời câu hỏi, nhưng giỏ đi theo khách
    // sang hộp thư để khách nhắn địa chỉ là chốt được.
    const basket = conversation.source === 'comment' && !commentNeedsStaff && !commentOrderOp ? commentBasket(message.text) : [];
    const softForBasket = new Set(['PRICE_QUOTE', 'PRICE_MIX_TUI_LON', 'BAG_COMPARISON', 'BAG_COMPARISON_XANH_VANG', 'GENERAL_INFO', 'LIVESTREAM_COMMENT', 'LIVESTREAM_VOUCHER', 'COMMENT_STAFF_FOLLOWUP', 'ORDER_STATUS']);
    if (basket.length && softForBasket.has(reply.templateId) && !(reply.templateId === 'ORDER_STATUS' && recentOrder?.id)) {
      const slots = ['Product_N1', 'No_A', 'Product_N2', 'No_B', 'Product_N3', 'No_C'];
      const value = { template_id: 'ORDER_ADDRESS' };
      basket.slice(0, 3).forEach((item, index) => { value[slots[index * 2]] = item.product; value[slots[index * 2 + 1]] = String(item.quantity); });
      const orderReply = renderChatbotReply(value, templates, replyContext);
      const asksInfo = /\?|\b(gia|bn|bao nhieu|khac|sao|ntn|the nao|gam|gram|ngon|nao)\b/.test(folded);
      reply = asksInfo ? { ...reply, pendingOrder: orderReply.pendingOrder } : orderReply;
    }
    // Phiên live: khách báo "đã săn/đã mua 290k", hỏi "săn thế nào", mà chưa có
    // đơn → ghi nhận và xin loại, số lượng, SĐT, địa chỉ (trước đây nhận "chưa
    // thấy đơn nào" hay mẫu voucher sàn, không ai chốt).
    // Khiếu nại/hủy/chưa nhận hàng dưới live không phải "vừa săn deal".
    const liveDeal = isLivestreamPost(conversation) && !recentOrder?.id && !basket.length && !commentNeedsStaff && templates?.LIVE_DEAL_CLAIMED
      && !/\b(chua (nhan|thay|giao)|huy|khieu nai|bi loi|bi hu)\b/.test(folded)
      && (/\b(da (san|mua|chot|dat)|san (duoc|deal|the nao|tn|sao|ntn)|len ma|ma gi|cach (san|chot|tham gia|dat|mua))\b/.test(folded) || reply.templateId === 'ORDER_STATUS');
    if (liveDeal) reply = { ...renderChatbotReply({ template_id: 'LIVE_DEAL_CLAIMED' }, templates, replyContext), attention: true };
    // Dưới phiên livestream nhiều sản phẩm, "hỏi giá chung" không nên là bảng
    // 3 vị khô khan: dùng lời chào live (nêu các vị có trên live, ưu đãi live,
    // hỏi khách quan tâm loại nào) nếu chủ shop có soạn mẫu LIVESTREAM_COMMENT.
    // Câu hỏi không phải hỏi giá (mẹ bầu, cho bé, yến mạch, hạt điều) thì trả đúng mẫu.
    if (reply.templateId === 'GENERAL_INFO' && templates?.LIVESTREAM_COMMENT && isLivestreamPost(conversation)) {
      const routed = [
        [/\b(me bau|bau bi|dang bau|tieu duong|benh)\b/, 'HEALTH_CONDITION'],
        [/\b(cho be|be an|tre em|tre nho|con nho)\b/, 'KIDS_FAMILY'],
        [/\byen mach\b/, 'PRICE_YEN_MACH_UC_NGUYEN_CAM'],
        [/\b(hat dieu|hat bi|sua hat|xoai|dau say)\b/, 'LIVE_ONLY_PRODUCT']
      ].find(([pattern, id]) => pattern.test(folded) && templates?.[id]);
      reply = renderChatbotReply({ template_id: routed ? routed[1] : 'LIVESTREAM_COMMENT' }, templates, replyContext);
    }
    // Khách đến từ live (bài live hay thẻ Livestream) hỏi giá / số túi / quà: lời chào live (nêu vị, ưu đãi
    // live) thay cho chính sách quà / voucher sàn / bảng mix.
    const liveContext = isLivestreamPost(conversation) || conversationLabels.includes('livestream');
    if (liveContext && templates?.LIVESTREAM_COMMENT && ['GIFT_POLICY', 'LIVESTREAM_VOUCHER', 'PRICE_MIX_TUI_LON', 'DISCOUNT_POLICY'].includes(reply.templateId)
      && /\b(gia|bn|bao nhieu|bnhiu|may tui|\d+ ?tui|tui|qua|tang|combo|mua|lay|goi)\b/.test(folded)) {
      reply = renderChatbotReply({ template_id: 'LIVESTREAM_COMMENT' }, templates, replyContext);
    }
    // Mô hình chọn mẫu live cho khách không đến từ live: đổi về mẫu thường.
    if (!liveContext && conversation.source !== 'comment') {
      if (reply.templateId === 'LIVESTREAM_COMMENT' && templates?.GENERAL_INFO) reply = renderChatbotReply({ template_id: 'GENERAL_INFO' }, templates, replyContext);
      else if (reply.templateId === 'LIVESTREAM_VOUCHER' && templates?.DISCOUNT_POLICY) reply = renderChatbotReply({ template_id: 'DISCOUNT_POLICY' }, templates, replyContext);
      // Sản phẩm ngoài danh mục bot (hạt bí xanh, bơ hạt điều…) trong hộp thư: không nói "chỉ bán trên live" — nhân viên báo giá.
      else if (reply.templateId === 'LIVE_ONLY_PRODUCT') reply = { ...renderChatbotReply({ template_id: 'CSKH_HANDOFF', warming: '1' }, templates, replyContext), attention: true };
    }
    // KHÔNG dựng giỏ/đơn từ tin không phải đặt hàng (Vy Hoang: ảnh + "xanh mint" bị lên nhầm Túi Nâu):
    // - tin chỉ ảnh (không chữ) mà khách chưa từng nêu sản phẩm → báo đã nhận hình / bảng giá quảng cáo;
    // - tin chỉ "hình / ảnh 2 / xem hình" → ảnh sản phẩm, không giỏ;
    // - tin nêu vị chỉ bán trên live (xanh mint, dâu, tropical, hạt điều…) → LIVE_ONLY_PRODUCT + thẻ, không giỏ.
    const createsBasket = item => Boolean(item.order) || Boolean(item.pendingOrder?.items?.length) || isOrderStep(item.templateId) || item.templateId === 'ORDER_CUSTOM_BASKET';
    const earlierTexts = replyContext.recentCustomerTexts.filter(text => squashText(text) !== squashText(message.text));
    const namedProductBefore = earlierTexts.some(text => /\b(tui|goi|bich|hop|combo|xanh|vang|nau|cacao|granola|lay|dat|mua|chot)\b/.test(foldVietnamese(text)));
    const photoOnly = !nonText && /^(?:(?:cho|shop|em|e|minh|m|c|chi|a|anh|toi)\s+)*(?:(?:xem|coi|gui|cho xem|cho coi|xin)\s+)?(?:hinh|anh|hinh anh)(?:\s+(?:\d+|that|san pham|tui|goi|mau|san pham that))*(?:\s+(?:xem|coi|di|nha|nhe|a|voi|duoc khong|dc ko|dc k|ntn|sao|nao|cai|shop|em|e))*$/.test(folded);
    const liveOnlyMention = /\b(xanh mint|mint|tropical|dau tay|hat dieu|hat bi|sua hat|xoai|dau say|xanh duong|hu hat)\b/.test(folded) || /\bdâu\b/iu.test(String(message.text || ''));
    const mintBasket = (reply.order?.items || reply.pendingOrder?.items || []).some(item => /mint|tropical/i.test(String(item.code || item.sku || item.product || item.name || '')));
    if (nonText && !paymentReply && createsBasket(reply) && !namedProductBefore) reply = imageFallback();
    else if (photoOnly && createsBasket(reply)) reply = { ...renderChatbotReply({ template_id: 'PRODUCT_PHOTOS', ...(productHint(ruleProduct) ? { Product_N1: ruleProduct } : {}) }, templates, replyContext), pendingOrder: undefined, order: undefined };
    else if (!nonText && liveOnlyMention && createsBasket(reply) && !mintBasket) {
      const liveOnly = renderChatbotReply({ template_id: 'LIVE_ONLY_PRODUCT' }, templates, replyContext);
      reply = { ...(liveOnly.templateId === 'LIVE_ONLY_PRODUCT' ? liveOnly : renderChatbotReply({ template_id: 'CSKH_HANDOFF', warming: '1' }, templates, replyContext)), attention: true, pendingOrder: undefined, order: undefined };
    }
    // Bình luận nêu vị lạ (dâu, mint): nhân viên xem, không dựng giỏ thiếu.
    if (conversation.source === 'comment' && liveOnlyMention && !reply.attention) reply = { ...reply, attention: true };
    // Bình luận có SĐT: nhân viên cần thấy để gọi chốt.
    if (conversation.source === 'comment' && extractVietnamesePhone(message.text || '')) reply = { ...reply, attention: true };
    // Không gửi lại y nguyên tin bot vừa gửi trong 10 phút (hỏi SĐT lần ba, cảm ơn
    // hai lần), và không chuyển người lần hai trong 24 giờ.
    // Cùng lời (câu đầu của mẫu) đã gửi trong 10 phút, hay cùng một mẫu "không
    // nên lặp" (chào, cảm ơn, xin SĐT, xác nhận đơn…) vừa gửi chưa đầy 60 giây
    // (hai tin của khách tới cùng lô webhook): không gửi lần hai.
    const tenMinutesAgo = Date.now() - 10 * 60 * 1000;
    // So khớp lỏng: bỏ khoảng trắng thừa và câu mở đầu của tin riêng sau bình
    // luận ("Dạ em thấy … để lại bình luận…"), để lời vừa gửi riêng qua bình
    // luận cũng được nhận ra khi khách nhắn tiếp vào hộp thư.
    // Xưng hô cũng bỏ: "anh/chị" lượt trước, "chị" lượt sau vẫn là cùng một câu.
    const normalizeSent = value => String(value || '').replace(/^Dạ em thấy .*? để lại bình luận[^\n]*\n+/u, '')
      .replace(/(?<![\p{L}])(anh\s*\/\s*chị|anh chị|chị|anh|bạn|cô|chú)(?![\p{L}])/giu, '~').replace(/\s+/g, ' ').trim();
    const firstLine = normalizeSent(reply.messages?.[0] || '');
    const repeatsText = firstLine.length > 20 && recent.some(item => item?.direction === 'outgoing' && (Number(item.createdAt) || 0) > tenMinutesAgo && normalizeSent(item.text).includes(firstLine));
    const noRepeatTemplates = new Set(['WELCOME', 'THANK_YOU', 'CSKH_HANDOFF', 'ORDER_CONFIRMATION', 'ORDER_ADDRESS', 'ORDER_ADDRESS_PARTIAL', 'ORDER_ADDRESS_CLARIFY', 'ORDER_ADDRESS_CHOOSE', 'GENERAL_INFO', 'LIVESTREAM_COMMENT']);
    const repeatsTemplate = noRepeatTemplates.has(reply.templateId) && conversation.botLastTemplateId === reply.templateId && Date.now() - (Number(conversation.botLastReplyAt) || 0) < 60 * 1000;
    // Giỏ mới khác giỏ đang giữ (giỏ Shop mới, khách đổi vị/số túi, nhận lời gợi
    // ý 2 túi): là thay đổi thật, không phải lặp — trước đây bot im và giỏ mới mất.
    const changedCart = Boolean(reply.pendingOrder?.key) && reply.pendingOrder.key !== conversation.pendingOrder?.key;
    // Ghi chú/hủy/sửa đơn là thao tác thật (lời dặn thứ hai khác lời dặn đầu dù câu
    // trả lời giống nhau): không coi là lặp.
    const orderAction = Boolean(reply.order?.noteOrderId || reply.order?.cancelOrderId || reply.order?.updateOrderId);
    const repeatsLast = (repeatsText || repeatsTemplate) && !changedCart && !orderAction;
    const repeatsHandoff = reply.templateId === 'CSKH_HANDOFF' && conversation.botLastTemplateId === 'CSKH_HANDOFF'
      && Date.now() - (Number(conversation.botLastReplyAt) || 0) < 24 * 60 * 60 * 1000;
    const isComment = conversation.source === 'comment';
    if (repeatsLast || repeatsHandoff) {
      // Chỉ im lặng với lời đáp ngắn ("ok", "dạ") hay khi đã chuyển người; khách
      // nhắn có nội dung mà bot sắp lặp lại tin vừa gửi thì không để khách chờ:
      // - bước đơn (xin SĐT/địa chỉ): nhắc ngắn giỏ + tổng + phần còn thiếu;
      // - bảng giá: nhắc "đã gửi ở trên" và mời chốt (chỉ khi chưa có đơn);
      // - thông tin khác: nói đã gửi ở trên, gắn thẻ để nhân viên giải thích thêm.
      const substantive = !shortAck && message.type === 'text' && folded.replace(/\s+/g, '').length >= 2;
      const informational = !isOrderStep(reply.templateId) && !['ASK_FLAVOR', 'ASK_PRODUCT', 'THANK_YOU', 'WELCOME', 'CSKH_HANDOFF', 'ORDER_UNCHANGED', 'ORDER_CUSTOM_BASKET'].includes(reply.templateId);
      const priceFamily = priceFamilyTemplates;
      const remindOrder = repeatsLast && !repeatsHandoff && substantive && Boolean(reply.remind) && conversation.botLastTemplateId !== 'ORDER_ADDRESS_REMIND' && !isComment;
      // Khách đã đặt đơn (24 giờ, chưa hủy) mà hỏi lại điều vừa kèm trong tin xác
      // nhận ("Hà Nội mấy ngày tới?"): trả lời lại đúng thông tin đó, trừ khi
      // chính nó là tin bot vừa gửi.
      const answerAgain = repeatsLast && !repeatsHandoff && informational && substantive && hasOrder
        && conversation.botLastTemplateId !== reply.templateId && !isComment;
      const nudgeId = priceFamily.has(reply.templateId) && !hasOrder ? 'REPLY_ALREADY_SENT' : 'REPLY_ALREADY_SENT_INFO';
      // Nhắc 'đã gửi ở trên' chỉ khi CHÍNH KHÁCH lặp lại câu vừa hỏi (giống ≥ 80%) hay chỉ giục
      // ("sao chưa trả lời", "???", "alo"). Đọc 361 hội thoại 24–25/09 + 7 ca 26–28/09: mọi lần nhắc
      // cho tin có ý mới / dấu hỏi đều sai → tin đó im và gắn thẻ để nhân viên trả lời.
      const canNudge = repeatsLast && !answerAgain && !remindOrder && informational && substantive && (customerRepeats || nudgeLike) && templates?.[nudgeId]
        && !['REPLY_ALREADY_SENT', 'REPLY_ALREADY_SENT_INFO'].includes(conversation.botLastTemplateId) && !isComment;
      if (!canNudge && !answerAgain && !remindOrder) {
        // Im lặng nhưng không bỏ rơi: giỏ mới vẫn được lưu; khách nhắn có nội
        // dung thì gắn thẻ để nhân viên thấy có người đang chờ.
        if (saveBotState && !isComment) {
          await saveBotState(conversation.id, {
            ...(reply.pendingOrder !== undefined ? { pendingOrder: reply.pendingOrder } : {}),
            ...(substantive && !repeatsHandoff ? { addLabelEvents: ['handoff'] } : {})
          }).catch(() => {});
        }
        results.push({ conversationId: conversation.id, skipped: repeatsLast ? 'lặp tin vừa gửi' : 'đã chuyển người trong 24 giờ' });
        return;
      }
      if (remindOrder) reply = { ...reply, templateId: 'ORDER_ADDRESS_REMIND', messages: [reply.remind], parts: undefined, images: [] };
      else if (canNudge) reply = { ...renderChatbotReply({ template_id: nudgeId }, templates, replyContext), pendingOrder: reply.pendingOrder, attention: nudgeId === 'REPLY_ALREADY_SENT_INFO' };
    }
    // Trong lúc chờ mô hình khách nhắn thêm (chữ hay ảnh): bỏ câu này, tin sau trả lời gộp.
    if (hasNewerCustomerMessage(await listMessages(conversation.id), change.message)) {
      results.push({ conversationId: conversation.id, skipped: 'gộp với tin sau' });
      return;
    }
    // Nhân viên vừa nhận khách (tắt bot) trong lúc model chạy: không lên đơn trùng
    // với đơn nhân viên đang lên, không gửi chuỗi xác nhận thứ hai.
    if (reply.order && !isComment && getConversation) {
      const latest = await getConversation(conversation.id).catch(() => null);
      if (latest?.botEnabled === false) {
        results.push({ conversationId: conversation.id, skipped: 'nhân viên đã nhận khách' });
        return;
      }
    }
    // Khách đang có đơn trong 7 ngày (chưa hủy) mà sắp lên đơn MỚI: chưa tạo — kể đơn đang có và hỏi
    // khách xác nhận đặt thêm; khách "đúng" thì lượt sau chốt giỏ đang giữ (chủ shop 26/09: Mai Tran bị
    // tạo đơn thứ hai trong khi đơn 24/09 còn đang giao).
    const existingRecent = recentOrder?.id && Date.now() - (Number(recentOrder.createdAt) || 0) < 7 * 24 * 60 * 60 * 1000 && isActiveOrder(recentOrder) ? recentOrder : null;
    // Chỉ lời "đúng" tường minh cho câu hỏi vừa gửi mới được bỏ bước hỏi; giỏ mới (luật giỏ / mô hình)
    // trong lúc đang chờ, hay cờ chờ còn sót khi giỏ đã quá hạn, đều hỏi lại với giỏ mới.
    const explicitYes = awaitingYes && reply === existingConfirmReply;
    // Tin là câu hỏi GIÁ ("E mua 2 túi giá bao nhiêu?") mà mô hình chốt đơn: báo giá, không hỏi "đặt thêm?"
    // (ca Đào Bia bị hỏi xác nhận đặt thêm 2 Xanh). Một loại → bảng giá loại đó; nhiều loại → bảng mix.
    const newOrderReply = Boolean(reply.order) && !reply.order.updateOrderId && !reply.order.cancelOrderId && !reply.order.noteOrderId && !isComment;
    // Đơn ngoài hội thoại cùng SĐT (landing / nhân viên lên trên POS) trong 7 ngày: hỏi xác nhận đặt thêm
    // như đơn trong hội thoại (10 ca trùng đơn 21–28/09). POS lỗi/hết giờ → vẫn lên đơn nhưng gắn thẻ soát trùng.
    let outsideOrder = null;
    // Chỉ tra khi môi trường có POS/kho landing (server đưa findShopOrder) hay test đưa rõ fetchImpl/posConfig/readLandingStore.
    const canLookupOutside = typeof dependencies.findShopOrder === 'function' || dependencies.fetchImpl || dependencies.posConfig || dependencies.readLandingStore;
    if (newOrderReply && !existingRecent && !explicitYes && !awaitingRecent && canLookupOutside && templates?.ORDER_EXISTING_CONFIRM && reply.order.phone) {
      const found = await findExternalOrders(reply.order.phone, {
        fetchImpl: dependencies.fetchImpl || fetch,
        config: dependencies.posConfig || null,
        landingStore: dependencies.readLandingStore || readLandingStore,
        excludeIds: allOrders.map(order => String(order?.id || ''))
      }).catch(caught => ({ orders: [], error: caught.message }));
      outsideOrder = found.orders[0] || null;
      if (found.error) {
        console.warn(`Tra POS lỗi (${normalizeWarningPhone(reply.order.phone)}, ${conversation.id}): ${found.error} — vẫn lên đơn, gắn thẻ soát trùng`);
        reply = { ...reply, attention: true };
      } else if (outsideOrder) console.log(`Đơn ngoài hội thoại ${outsideOrder.id} (${outsideOrder.source}) cùng SĐT: hỏi khách xác nhận trước (${conversation.id})`);
    }
    const existingAny = existingRecent || outsideOrder;
    if (newOrderReply && existingAny && !explicitYes && !phoneInText && priceAsk.test(folded)) {
      const names = [...new Set((reply.order.items || []).map(item => String(item.product || item.name || '')).filter(Boolean))];
      const quoteValue = names.length === 1 && templates?.PRICE_QUOTE ? { template_id: 'PRICE_QUOTE', Product_N1: names[0] }
        : names.length > 1 && templates?.PRICE_MIX_TUI_LON ? { template_id: 'PRICE_MIX_TUI_LON' } : { template_id: 'GENERAL_INFO' };
      const quoted = renderChatbotReply(quoteValue, templates, replyContext);
      if (!quoted.handoff) reply = { ...quoted, order: undefined, pendingOrder: undefined };
    }
    if (reply.order && !reply.order.updateOrderId && !reply.order.cancelOrderId && !reply.order.noteOrderId && !isComment && existingAny && !explicitYes && templates?.ORDER_EXISTING_CONFIRM) {
      const cart = `${(reply.order.items || []).map(item => `${Number(item.quantity) || 1} ${item.product || item.name}`).join(' + ')}${reply.order.total ? ` – tổng ${Number(reply.order.total).toLocaleString('vi-VN')}đ` : ''}`;
      // Đã hỏi "đặt thêm?" trong 30 phút: không hỏi lại — giữ giỏ mới với cờ chờ, gắn thẻ, im.
      if (awaitingRecent) {
        console.log(`Đơn mới khi đang chờ xác nhận đặt thêm (đã hỏi < 30 phút): giữ giỏ, không hỏi lại (${conversation.id})`);
        if (saveBotState) {
          await saveBotState(conversation.id, {
            pendingOrder: { items: (reply.order.items || []).map(item => ({ product: item.product || item.name, code: item.code || item.sku || '', quantity: Number(item.quantity) || 1 })), key: reply.order.orderKey || '', at: Number(conversation.pendingOrder?.at) || Date.now(), phone: reply.order.phone || '', address: reply.order.rawAddress || reply.order.address || '', addressAsks: maxAddressAsks, awaitingConfirm: true },
            addLabelEvents: ['handoff']
          }).catch(() => {});
        }
        results.push({ conversationId: conversation.id, skipped: 'đang chờ xác nhận đặt thêm' });
        return;
      }
      // Đơn ngoài hội thoại: giỏ/giờ đơn cũ lấy từ đơn landing/POS (recentOrder tạm cho mẫu).
      const ask = renderChatbotReply({ template_id: 'ORDER_EXISTING_CONFIRM', cart }, templates, { ...replyContext, recentOrder: existingAny });
      if (ask.templateId === 'ORDER_EXISTING_CONFIRM') {
        console.log(`Đơn mới khi đang có đơn ${existingAny.id}: hỏi khách xác nhận trước (${conversation.id})`);
        // addressAsks = tối đa: địa chỉ này đã được bộ soạn đơn chấp nhận (có khi sau 2 lần hỏi) —
        // lượt "đúng" không được hỏi lại phường/xã lần nữa. Đơn ngoài lưu kèm giỏ chờ để "không" kể lại được.
        reply = { ...ask, order: undefined, attention: false, pendingOrder: { items: (reply.order.items || []).map(item => ({ product: item.product || item.name, code: item.code || item.sku || '', quantity: Number(item.quantity) || 1 })), key: reply.order.orderKey || '', at: Date.now(), phone: reply.order.phone || '', address: reply.order.rawAddress || reply.order.address || '', addressAsks: maxAddressAsks, awaitingConfirm: true, ...(outsideOrder ? { externalOrder: outsideOrder } : {}) } };
      }
    }
    // Sắp tự lên đơn mới mà hội thoại đã có đơn POS trong giờ qua (khách đặt qua
    // Facebook Shop, hay nhân viên vừa lên): không tạo đơn trùng, báo đã nhận đơn.
    if (reply.order && !reply.order.updateOrderId && !reply.order.cancelOrderId && !reply.order.noteOrderId && !isComment && dependencies.findShopOrder && templates?.SHOP_ORDER_RECEIVED) {
      const lookedUp = await dependencies.findShopOrder(conversation, { since: Date.now() - 60 * 60 * 1000 }).then(found => ({ found }), error => ({ error }));
      // POS lỗi (429/5xx/hết giờ) ≠ không có đơn Shop: vẫn lên đơn nhưng gắn thẻ để nhân viên soát trùng.
      if (lookedUp.error) { console.warn(`Tra đơn Shop lỗi (${String(lookedUp.error?.message || lookedUp.error).slice(0, 80)}) — gắn thẻ soát trùng (${conversation.id})`); reply = { ...reply, attention: true }; }
      const existing = lookedUp.found || null;
      // Chỉ coi là trùng khi CÙNG SĐT và khách không nói tách/thêm đơn ("đơn khác",
      // "gửi mẹ", "thêm", "nữa"); khác thì vẫn lên đơn nhưng gắn thẻ cho nhân viên soát.
      const separate = /\b(don khac|don moi|nguoi khac|dia chi khac|gui (cho )?(me|ba|bo|chi|em|ban|anh|nguoi)|tach don|them|nua)\b/.test(folded);
      const digits = value => String(value || '').replace(/\D/g, '').slice(-9);
      const samePhone = existing && digits(existing.phone) && digits(existing.phone) === digits(reply.order.phone);
      const skuOf = value => String(value || '').trim().toUpperCase();
      const basketOf = list => (Array.isArray(list) ? list : []).map(item => `${skuOf(item.sku || item.code)}=${Number(item.quantity) || 1}`).sort().join(',');
      const sameBasket = existing && (!Array.isArray(existing.items) || !existing.items.length || basketOf(existing.items) === basketOf(reply.order.items));
      if (existing && samePhone && !separate && sameBasket) reply = shopOrderReply(existing);
      else if (existing) reply = { ...reply, attention: true };
    }
    // The order is persisted BEFORE anything is sent. Sending first meant a
    // failed order left the customer holding a confirmation for an order that
    // did not exist, and a retried webhook sent the whole reply a second time.
    // "Tự động lên đơn" tắt (settings.autoOrder === false): bot vẫn xác nhận với
    // khách nhưng không tạo đơn; giỏ được giữ ở pendingOrder cho nhân viên.
    // Khách sửa đơn vừa chốt: cập nhật đúng đơn đó (updateOrder), không tạo đơn mới.
    const wantsUpdate = Boolean(reply.order?.updateOrderId) && typeof updateOrder === 'function';
    // Khách hủy đơn vừa đặt: đánh dấu hủy đúng đơn đó (không tạo, không sửa).
    const wantsCancel = Boolean(reply.order?.cancelOrderId) && typeof cancelOrder === 'function';
    // Khách dặn thêm cho đơn vừa đặt ("gửi hàng mới", "gọi trước khi giao"): ghi vào đơn.
    const wantsNote = Boolean(reply.order?.noteOrderId) && typeof dependencies.addOrderNote === 'function';
    // autoOrder chỉ chặn TẠO đơn mới; hủy / sửa / ghi chú đơn đã có vẫn phải làm thật — bot đã nói
    // "em đã hủy đơn" với khách.
    const outcome = settings.responseMode === 'automatic' && reply.order && !isComment && (wantsNote || wantsCancel || wantsUpdate || (settings.autoOrder !== false && createOrder))
      ? (wantsNote
        ? await dependencies.addOrderNote(conversation, reply.order.noteOrderId, reply.order.note)
        : wantsCancel
          ? await cancelOrder(conversation, reply.order.cancelOrderId)
          : wantsUpdate
            ? await updateOrder(conversation, reply.order.updateOrderId, reply.order)
            : await createOrder(conversation, reply.order, { sourceMessageId: String(change.message.mid || change.message.id || '') }))
      : null;
    // Đơn vừa hủy hay chỉ thêm ghi chú không phải "đơn mới" cho nhãn/phiếu.
    const order = outcome?.cancelled || outcome?.noted ? null : outcome?.order || null;
    const alreadyHandled = Boolean(outcome) && outcome.created === false && !outcome.updated && !outcome.cancelled && !outcome.noted;
    let privateError = '';
    let privateSkipped = false;
    if (settings.responseMode === 'automatic' && isComment) {
      // Under a comment: the full answer goes to the person's Messenger as a
      // private reply (Facebook allows one per comment, so the messages are
      // joined), and one short public reply tells them to check their inbox.
      // Orders are never created from a comment — the customer is asked to
      // continue in Messenger, where the address exchange is private.
      const intro = renderChatbotReply({ template_id: 'COMMENT_PRIVATE_REPLY' }, templates, replyContext);
      const privateText = [...(intro.templateId === 'COMMENT_PRIVATE_REPLY' ? intro.messages : []), ...reply.messages].join('\n\n')
        // Mẫu mở đầu kết bằng "Dạ," rồi mẫu sau lại "Dạ": chỉ giữ một.
        .replace(/Dạ,?\s*\n\n\s*Dạ,?/g, 'Dạ,');
      // Messenger can refuse the private reply — most often error #10, another
      // app holding the thread (Handover Protocol). Telling the customer to
      // check an inbox that stays empty loses the lead, so the public reply
      // then asks them to message the Page instead, and the error is kept
      // for the customer panel.
      // Khách bình luận nhiều lần dưới cùng bài ("cho coi combo", "combo đó mấy
      // gói"): cùng một tin riêng đã gửi trong 24 giờ thì không gửi lại — khách
      // nhận ba lần bảng giá y hệt là spam. Chỉ trả lời công khai ngắn.
      // Lời khen / tán gẫu dưới bài ("ngon", "tuyệt", "ăn ngon lắm", mô hình chọn THANK_YOU): chỉ cảm ơn
      // công khai, không nhắn riêng bảng giá cho người vừa khen.
      const commentPraise = !commentComplaint && !basket.length && !extractVietnamesePhone(message.text || '') && !reply.order && templates?.COMMENT_PUBLIC_THANKS
        && (reply.templateId === 'THANK_YOU' || (/\b(ngon|tuyet|tuyet voi|thich|thik|dinh|hop ly|ok lam|qua ngon|ung|dung y)\b/.test(folded)
          && !/\?|\b(nao|sao|khong|ko|k|gia|bn|bao nhieu|hon|the nao|ntn|khac|lay|dat|mua|cho|xin|ib|inbox|giam|ship|tui|goi|combo|bao)\b/.test(folded)));
      if (commentPraise) privateSkipped = true;
      if (privateText && !privateSkipped && getConversation && listMessages) {
        const inbox = await getConversation(`${conversation.pageId}:${conversation.psid}`).catch(() => null);
        const sentBefore = inbox ? await listMessages(inbox.id).catch(() => []) : [];
        const dayAgo = Date.now() - 24 * 60 * 60 * 1000;
        const normalize = value => String(value || '').replace(/\s+/g, ' ').trim();
        privateSkipped = sentBefore.some(item => item?.direction === 'outgoing' && (Number(item?.createdAt) || 0) > dayAgo && normalize(item.text) === normalize(privateText));
        // Khách bình luận ở nhiều bài trong vài phút: bảng giá khác nhau (bài Túi
        // Xanh, bài chung…) vẫn là bảng giá — hộp thư vừa nhận bảng giá dưới 30
        // phút thì không gửi thêm bảng thứ hai, thứ ba.
        const priceFamily = new Set(['PRICE_QUOTE', 'GENERAL_INFO', 'LIVESTREAM_COMMENT', 'PRICE_MIX_TUI_LON']);
        if (!privateSkipped && inbox && !basket.length && priceFamily.has(reply.templateId) && priceFamily.has(inbox.botLastTemplateId)
          && Date.now() - (Number(inbox.botLastReplyAt) || 0) < 30 * 60 * 1000) privateSkipped = true;
      }
      // Tin riêng ghép (mở đầu + bảng giá + chính sách) quá 1.900 ký tự bị Messenger cắt cụt ("…+ miễn phí v"):
      // phần đầu (≤ 1.900) đi qua tin riêng của bình luận, phần còn lại gửi tiếp vào hộp thư của khách.
      const privateChunks = privateText ? splitMessageText(privateText, 1900) : [];
      if (privateText && !privateSkipped) {
        try {
          await sendMessage(conversation, { text: privateChunks[0], privateReply: true });
        } catch (error) {
          // Lỗi tạm (aborted, #0, #1, mạng): thử lại một lần sau 3 giây. Khách
          // chặn tin (#10903), đã trả lời (#10900), ngoài cửa sổ (#10/#551): không.
          const permanent = /#10903|#10900|#551|\(#10\)|chưa có mã Pancake/i.test(error.message || '');
          // #10900: bình luận ĐÃ được nhắn riêng (Pancake/nhân viên) — không phải
          // lỗi; không đăng "mình ib cho Page giúp em".
          if (/#10900/.test(error.message || '')) privateSkipped = true;
          else if (permanent) privateError = error.message;
          else {
            await wait(3000);
            try {
              await sendMessage(conversation, { text: privateChunks[0], privateReply: true });
            } catch (again) {
              privateError = again.message;
            }
          }
        }
        // Phần còn lại: tin thường vào hộp thư (bị chặn khi khách chưa nhắn Page thì bỏ, không báo lỗi).
        if (!privateError && !privateSkipped && privateChunks.length > 1 && getConversation) {
          const inbox = await getConversation(`${conversation.pageId}:${conversation.psid}`).catch(() => null);
          for (const chunk of privateChunks.slice(1)) {
            if (!inbox) break;
            const ok = await sendMessage(inbox, { text: chunk }).then(() => true).catch(error => { console.warn(`Phần sau tin riêng không gửi được (${conversation.id}): ${error.message}`); return false; });
            if (!ok) break;
          }
        }
      }
      // Giỏ hàng khách nêu trong bình luận ("1 xanh 1 vàng", SĐT kèm theo) đi
      // theo khách sang hộp thư: khi khách nhắn địa chỉ vào Messenger, bot đã
      // có sẵn sản phẩm để chốt thay vì hỏi lại từ đầu.
      const carried = reply.pendingOrder && (reply.pendingOrder.items?.length || reply.pendingOrder.phone) ? reply.pendingOrder : null;
      // Giỏ khách vừa nêu trong hộp thư (dưới 30 phút) mới hơn bình luận: không ghi đè.
      const inboxBasketFresh = inboxThread?.pendingOrder?.items?.length && Date.now() - (Number(inboxThread.pendingOrder.at) || 0) < 30 * 60 * 1000;
      if (!privateError && !privateSkipped && saveBotState) {
        // Hộp thư biết mẫu vừa gửi riêng: khách nhắn tiếp thì bot không gửi lại y nguyên.
        await saveBotState(`${conversation.pageId}:${conversation.psid}`, {
          botLastTemplateId: reply.templateId,
          botLastReplyAt: Date.now(),
          ...(carried && !inboxBasketFresh ? { pendingOrder: carried } : {}),
          ...(!inboxThread?.botGender && (lockedGender === 'male' || lockedGender === 'female') ? { botGender: lockedGender } : {})
        }).catch(() => {});
      }
      // Ảnh của mẫu (ảnh sản phẩm) đi sau tin nhắn riêng như tin Messenger
      // thường vào hộp thư của khách. Facebook chỉ cho một tin nhắn riêng mỗi
      // bình luận nên tin đó phải là bảng giá; ảnh gửi thêm được thì tốt, bị
      // chặn (khách chưa nhắn lại) thì bỏ qua, không báo lỗi.
      if (!privateError && !privateSkipped && reply.images?.length && getConversation) {
        const inbox = await getConversation(`${conversation.pageId}:${conversation.psid}`).catch(() => null);
        const sentImages = inbox
          ? await sendMessage(inbox, { imageUrls: reply.images }).then(() => true).catch(error => { console.error(`Ảnh sau tin nhắn riêng không gửi được (${conversation.id}): ${error.message}`); return false; })
          : false;
        // Chưa gửi được (khách chưa mở Messenger với Page): giữ lại, gửi khi khách nhắn.
        if (!sentImages) rememberPendingImages(conversation.pageId, conversation.psid, reply.images);
      }
      // Lời chê/khiếu nại dưới bài: công khai xin lỗi, không "em đã ib 🥰".
      // Bất kể mẫu riêng là gì: khách chê là xin lỗi công khai + gắn thẻ.
      const complaintPublic = Boolean(templates?.COMMENT_PUBLIC_SORRY)
        && (commentComplaint || isComplaint({ text: message.text, templateId: reply.templateId, keywords: settings.complaintKeywords }));
      if (complaintPublic && !reply.attention) reply = { ...reply, attention: true };
      const publicId = privateError ? 'COMMENT_PUBLIC_FALLBACK'
        : complaintPublic ? 'COMMENT_PUBLIC_SORRY'
          : commentPraise ? 'COMMENT_PUBLIC_THANKS'
            : privateSkipped && templates?.COMMENT_PUBLIC_REPEAT ? 'COMMENT_PUBLIC_REPEAT' : 'COMMENT_PUBLIC_REPLY';
      // Luồng vừa có lời công khai trong 10 phút (khách bình luận liền 3–4 lần):
      // không đăng thêm "em đã ib" lần nữa dưới bài — trừ khi lần trước lỗi.
      const publicRecently = !privateError && recent.some(item => item?.direction === 'outgoing' && (Number(item.createdAt) || 0) > tenMinutesAgo);
      // Ẩn bình luận có SĐT trước khi đăng lời công khai: lời công khai có thể
      // chạm hết thời gian chờ, bình luận có SĐT không được nằm hiện trên bài.
      // Like the comment so the customer sees it was noticed; hide it when it
      // carries a phone number (or always, per settings) so competitors
      // cannot lift the lead from the post.
      if (moderateComment) {
        const hide = settings.commentHide === 'all' || (settings.commentHide === 'phone' && Boolean(extractVietnamesePhone(message.text)));
        await moderateComment(conversation, change.message, { like: settings.commentLike !== false, hide }).catch(() => {});
      }
      const publicReply = publicRecently ? { messages: [] } : renderChatbotReply({ template_id: publicId }, templates, replyContext);
      for (const text of pickVariant(publicReply)) {
        // Hết thời gian chờ khi đăng (Pancake vẫn đăng được): không coi là lỗi của cả lượt.
        await sendMessage(conversation, { text }).catch(error => {
          if (!/abort/i.test(error.message || '')) throw error;
          console.warn(`Lời công khai hết thời gian chờ (${conversation.id}): ${error.message}`);
        });
      }
    } else if (settings.responseMode === 'automatic' && !alreadyHandled) {
      // Theo đúng thứ tự của mẫu: ảnh đặt đầu mẫu đi trước bảng giá, ảnh đặt
      // cuối đi sau chữ. Mẫu không có dãy gửi thì chữ trước, ảnh sau.
      let parts = reply.parts || [...reply.messages.map(text => ({ type: 'text', text })), ...(reply.images || []).map(url => ({ type: 'image', url }))];
      // Cùng một đoạn chữ / ảnh xuất hiện hai lần trong một lượt: gửi một lần.
      const seenParts = new Set();
      parts = parts.filter(part => { const key = `${part.type}:${String(part.text || part.url || '').replace(/\s+/g, ' ').trim()}`; if (seenParts.has(key)) return false; seenParts.add(key); return true; });
      // Ảnh còn nợ từ tin nhắn riêng sau bình luận: gửi trước câu trả lời, bỏ
      // ảnh trùng trong câu trả lời để khách không nhận hai lần.
      const owed = conversation.source === 'comment' ? [] : takePendingImages(conversation.pageId, conversation.psid);
      if (owed.length) {
        const owedSet = new Set(owed);
        parts = [{ type: 'owed', urls: owed }, ...parts.filter(part => part.type !== 'image' || !owedSet.has(part.url))];
      }
      // Ảnh không gửi được (Pancake/Facebook từ chối tệp) thì bỏ ảnh đó, chữ
      // vẫn phải tới khách; lỗi ảnh ghi lại cho panel khách thay vì chặn cả câu.
      // Ảnh liền nhau gộp thành một tin nhiều ảnh (Pancake gửi một cụm; Meta tự tách từng ảnh).
      // Đoạn phụ (chính sách giao, đổi trả…) y hệt đã gửi trong 24 giờ thì bỏ:
      // chốt hai đơn liền nhau không lặp lại cả chuỗi "luyên thuyên". Đoạn đầu
      // (câu trả lời chính) luôn gửi.
      const dayAgo = Date.now() - 24 * 60 * 60 * 1000;
      const sentTexts = new Set(recent.filter(item => item?.direction === 'outgoing' && (Number(item.createdAt) || 0) > dayAgo).map(item => String(item.text || '').replace(/\s+/g, ' ').trim()));
      parts = parts.filter((part, index) => index === 0 || part.type !== 'text' || !sentTexts.has(String(part.text || '').replace(/\s+/g, ' ').trim()));
      const imageErrors = [];
      for (let index = 0; index < parts.length; index += 1) {
        const part = parts[index];
        if (part.type === 'owed') {
          await sendMessage(conversation, { imageUrls: part.urls }).catch(error => imageErrors.push(error.message));
          continue;
        }
        if (part.type !== 'image') { await sendMessage(conversation, { text: part.text }); continue; }
        const urls = [part.url];
        while (parts[index + 1]?.type === 'image') urls.push(parts[++index].url);
        try {
          await sendMessage(conversation, { imageUrls: urls });
        } catch (error) {
          imageErrors.push(error.message);
        }
      }
      if (imageErrors.length) privateError = privateError || `ảnh không gửi được: ${imageErrors[0]}`;
      // The receipt closes the exchange, so it is sent after the reply text and
      // never before it — the order itself was already persisted above.
      // Sửa đơn: không gửi lại phiếu (POS/khách đã có), chỉ tin sửa đơn ở trên.
      if (order && sendReceipt && !outcome?.updated) await sendReceipt(conversation, order);
    }
    // Mô hình nhỏ so với câu trả lời thật (luật / LLM): đọc log để quyết định bật.
    // So với mẫu mô hình/luật CHỌN (chosenTemplateId, trước hậu xử lý ORDER_ADDRESS→REMIND, GENERAL_INFO→PRICE_QUOTE…).
    if (intent) console.log(`Mô hình nhỏ${intentUsable && reply === intentReply ? '' : ' (thử)'}: ${intent.templateId} (${intent.confidence.toFixed(2)}, biên ${intent.margin.toFixed(2)}) / thật ${chosenTemplateId}${reply.templateId !== chosenTemplateId ? ` → ${reply.templateId}` : ''} ${intentMatchMark(intent.templateId, chosenTemplateId)} (${conversation.id})`);
    // Mô hình tầng: "NHÓM p / MẪU p (biên) / thật Y ✓|✗|~|nhóm✓" — cùng quy ước, thêm "nhóm✓" khi chỉ đúng nhóm.
    if (cascade) console.log(`Mô hình tầng${cascadeUsable && reply === cascadeReply ? '' : ' (thử)'}: ${cascade.group} ${(Number(cascade.pGroup) || 0).toFixed(2)} / ${cascade.templateId} ${(Number(cascade.p) || 0).toFixed(2)} (biên ${(Number(cascade.margin) || 0).toFixed(2)}) / thật ${chosenTemplateId}${reply.templateId !== chosenTemplateId ? ` → ${reply.templateId}` : ''} ${cascadeMatchMark(cascade, chosenTemplateId, cascadeGroupOf)} (${conversation.id})`);
    const labelEvents = autoLabelEventsFor({
      order,
      // Ảnh khách gửi: thẻ "Cần người xử lý" để nhân viên xem, bot vẫn bật.
      handoff: reply.handoff || Boolean(reply.attention),
      text: message.text,
      templateId: reply.templateId,
      keywords: settings.complaintKeywords,
      // Khách đổi/hủy đơn, đến từ phiên live, số hay bom hàng: thẻ tương ứng.
      updated: Boolean(outcome?.updated),
      cancelled: Boolean(outcome?.cancelled),
      livestream: isLivestreamPost(conversation),
      phoneWarningLevel: outcome?.order?.phoneWarning?.level || ''
    });
    // Ưu đãi dùng thử: lưu bước (đã chọn túi, đã mời, từ chối, chuyển đơn thường) và
    // đóng ưu đãi khi đơn dùng thử đã tạo (không dùng lại được).
    const trialOrdered = Boolean(order && (order.trialFreeShip || reply.order?.trial));
    const promoUpdate = conversation.promo && (trialPatch || trialOrdered)
      ? { ...conversation.promo, ...(trialPatch || {}), ...(trialOrdered ? { stage: 'ordered', orderId: String(order.id), endedAt: Date.now() } : {}) }
      : null;
    await saveBotState(conversation.id, {
      ...(promoUpdate ? { promo: promoUpdate } : {}),
      botConversationId: reply.conversationId || conversation.botConversationId || '',
      botLastTemplateId: reply.templateId,
      botLastReplyAt: Date.now(),
      botDraft: settings.responseMode === 'draft' ? reply.messages.join('\n\n') : '',
      botLastError: privateError ? `Không nhắn riêng được: ${privateError}` : '',
      botLastErrorAt: privateError ? Date.now() : 0,
      // undefined leaves the stored basket alone; null clears it once ordered.
      // undefined để nguyên giỏ đang giữ; null xóa khi đã lên đơn. Tắt tự động
      // lên đơn thì giỏ khách vừa chốt được giữ lại thay vì xóa.
      // Đang chờ khách xác nhận đặt thêm mà khách nói chuyện khác (không yes/no, không giỏ mới):
      // bỏ cờ chờ — lượt sau mọi đơn mới đều được hỏi lại, không có "đồng ý ngầm".
      // Vừa hỏi "đặt thêm?" dưới 30 phút (awaitingRecent) thì giữ cờ chờ: khách hỏi chuyện khác xong vẫn có
      // thể "đúng rồi" để chốt, và bot không hỏi lại lần hai.
      ...(!isComment && !order && reply.order && !outcome && settings.autoOrder === false
        ? { pendingOrder: { ...(conversation.pendingOrder || {}), ...reply.order, at: Date.now(), awaitingConfirm: false } }
        : reply.pendingOrder !== undefined && !isComment ? { pendingOrder: reply.pendingOrder }
          : !isComment && conversation.pendingOrder?.awaitingConfirm && !awaitingYes && !awaitingNo && !awaitingRecent ? { pendingOrder: { ...conversation.pendingOrder, awaitingConfirm: false } } : {}),
      ...(reply.handoff ? { botEnabled: false } : {}),
      // Xưng hô khóa lại từ lần đầu biết giới tính; đã mời 2 túi thì ghi mốc để không mời lại trong hội thoại.
      ...(!isComment && !conversation.botGender && (lockedGender === 'male' || lockedGender === 'female') ? { botGender: lockedGender } : {}),
      ...(!isComment && reply.pendingOrder?.upsold && !conversation.pendingOrder?.upsold && !conversation.botUpsoldAt ? { botUpsoldAt: Date.now() } : {}),
      // Thẻ tự động: bot chỉ nói chuyện gì vừa xảy ra (chốt đơn / chuyển nhân
      // viên / khách khiếu nại); thẻ nào được gắn là do Cài đặt → Tin nhắn.
      // Thẻ được cộng thêm, không bao giờ xoá thẻ nhân viên đã gắn.
      ...(labelEvents.length ? { addLabelEvents: labelEvents } : {})
    });
    // Giỏ Shop chưa thấy đơn POS lúc trả lời: tra lại ở nền vài lần; thấy thì báo
    // khách đã nhận đơn (khỏi gửi lại SĐT/địa chỉ) và bỏ giỏ đang chờ.
    // So theo mẫu + mã giỏ, không so tham chiếu: khách giữ ưu đãi dùng thử nhận bản sao của cartReply (kèm thẻ).
    const cartReplySent = Boolean(cartReply) && reply.templateId === cartReply.templateId && (reply.pendingOrder?.key || '') === (cartReply.pendingOrder?.key || '');
    if (canFindShopOrder && !shopOrder && cartReplySent && settings.responseMode === 'automatic') {
      followUpShopOrder({ conversation, since: cartSince, settings, dependencies, cartKey: cartReply.pendingOrder?.key || '', shopOrderReply });
    }
    trace.final = reply.templateId;
    trace.also = reply.alsoTemplateId || null;
    trace.attention = Boolean(reply.attention);
    trace.handoff = Boolean(reply.handoff);
    results.push({
      conversationId: conversation.id,
      mode: settings.responseMode,
      templateId: reply.templateId,
      ...(bundle.length > 1 ? { bundled: bundle.length } : {}),
      ...(privateSkipped ? { privateSkipped: true } : {}),
      ...(order ? { orderId: order.id } : {}),
      ...(alreadyHandled ? { duplicate: true } : {})
    });
  } catch (error) {
    console.error(`Bot không trả lời được (${conversation.id}): ${error.message}`);
    await saveBotState(conversation.id, { botLastError: error.message, botLastErrorAt: Date.now() }).catch(() => {});
    // Hết hạn mức/quá tải sau mọi lần thử: hẹn chạy lại tin này sau một phút
    // (một lần). Lúc chạy lại, tin đã được trả lời (nhân viên, hay tin sau của
    // khách gộp vào) thì bỏ qua. Cài đặt đọc lại lúc chạy: nhân viên đã tắt bot
    // trong lúc chờ thì không trả lời nữa.
    const retryDelay = Number(settings.capacityRetryDelayMs ?? 60000);
    if (isCapacityError(error) && !change.delayedRetry && retryDelay > 0) {
      const timer = setTimeout(() => {
        queueForConversation(conversation.pageId && conversation.psid ? `${conversation.pageId}:${conversation.psid}` : conversation.id, async () => {
          const latest = dependencies.readSettings ? await dependencies.readSettings().catch(() => settings) : settings;
          if (!latest?.enabled) return;
          await answerChange({ ...change, delayedRetry: true }, latest, [], dependencies);
        }).catch(() => {});
      }, retryDelay);
      timer.unref?.();
      results.push({ conversationId: conversation.id, error: error.message, retryLater: true });
      return;
    }
    results.push({ conversationId: conversation.id, error: error.message });
  } finally {
    // Nhật ký quyết định: một dòng cho lượt này (kể cả bỏ qua / lỗi). Kết quả của lượt là mục
    // results vừa đẩy trong lượt (skipped / templateId / error). Gác trước ở chế độ thử: so với mẫu gửi thật.
    const mine = results.length > resultsBefore ? results[results.length - 1] : null;
    const final = trace.final ?? (mine?.templateId || null);
    if (trace.preGuard) {
      trace.preGuard.matched = final === trace.preGuard.decision;
      console.log(`Gác trước${trace.preGuard.mode === 'on' ? '' : ' (thử)'}: ${trace.preGuard.decision} / thật ${final || (mine?.skipped ? `bỏ qua (${mine.skipped})` : 'lỗi')}${trace.preGuard.matched ? ' ✓' : ' ✗'} (${conversation.id})`);
    }
    // Trong tiến trình test (node --test) chỉ ghi khi test đưa writer riêng — không đụng thư mục dữ liệu thật.
    const writer = typeof dependencies.appendDecisionLog === 'function' ? dependencies.appendDecisionLog : process.env.NODE_TEST_CONTEXT ? null : appendDecisionLog;
    if (settings.decisionLog !== 'off' && writer) {
      const record = buildDecisionRecord({ conversation, change, trace, result: mine, final, startedAt });
      Promise.resolve().then(() => writer(record)).catch(error => console.warn(`Nhật ký quyết định: ${String(error?.message || error).slice(0, 120)}`));
    }
  }
}

// ===== Nhật ký quyết định =====
// Mẫu bot vừa gửi thuộc nhóm bảng giá: khách giục sau đó thì nhắc "đã gửi ở trên" (chưa có đơn) thay vì _INFO.
const priceFamilyTemplates = new Set(['PRICE_QUOTE', 'GENERAL_INFO', 'PRICE_MIX_TUI_LON', 'DISCOUNT_POLICY', 'LIVESTREAM_COMMENT', 'PRICE_QUOTE_COMBO']);
// Mẫu bot vừa gửi mà gác trước KHÔNG được nhắc "đã gửi ở trên": bot đang hỏi/chờ/đã nhắc/đã chuyển người.
const preGuardExcludedLast = new Set(['ASK_FLAVOR', 'ASK_PRODUCT', 'ORDER_INFO_ASK_FLAVOR', 'ASK_FLAVOR_NGUYENBAN', 'THANK_YOU', 'WELCOME', 'CSKH_HANDOFF', 'WAITING_STAFF', 'IMAGE_RECEIVED', 'REPLY_ALREADY_SENT', 'REPLY_ALREADY_SENT_INFO', 'BANK_TRANSFER', 'PAYMENT_RECEIVED_CHECK', 'SHOP_ORDER_RECEIVED', 'LIVE_DEAL_CLAIMED', 'CALLBACK_REQUEST', 'WHOLESALE_CTV_CONTACT', 'WHOLESALE_RECEIVED', 'DELIVERY_DELAY', 'OIL_SMELL_WARRANTY', 'REFUSED_DELIVERY', 'QR_OFFER']);

const round2 = value => Math.round((Number(value) || 0) * 100) / 100;
const minutesSince = at => (Number(at) ? Math.round(((Date.now() - Number(at)) / 60000) * 10) / 10 : null);

/** Top-K của mô hình nhỏ: dùng `topK` khi intent-model trả, còn lại [best, second] (p của second = p1 − biên). */
export function intentTopK(intent) {
  if (!intent) return [];
  if (Array.isArray(intent.topK) && intent.topK.length) return intent.topK.map(item => ({ templateId: String(item.templateId || item), p: round2(item.p ?? item.confidence) }));
  const best = { templateId: intent.templateId, p: round2(intent.confidence) };
  return intent.second ? [best, { templateId: intent.second, p: round2(intent.confidence - intent.margin) }] : [best];
}

// Đã nhắc "thiếu pWithin/marginWithin" chưa (một lần mỗi tiến trình).
let cascadeWithinWarned = false;

/**
 * Phần `cascade` của nhật ký từ kết quả predictCascade: { group, subGroup, pGroup, templateId, p, margin,
 * pWithin, marginWithin, topK, path } — subGroup (PRICE/INFO/SOCIAL dưới ANSWER) và pWithin/marginWithin null khi mô-đun không trả.
 */
export function cascadeTrace(cascade) {
  if (!cascade || typeof cascade !== 'object') return null;
  const topK = (Array.isArray(cascade.topK) ? cascade.topK : []).map(item => ({ templateId: typeof item === 'string' ? item : String(item?.templateId || ''), p: round2(item?.p) })).filter(item => item.templateId);
  const optional = value => (value === undefined || value === null ? null : round2(value));
  return {
    group: String(cascade.group || ''), subGroup: cascade.subGroup ? String(cascade.subGroup) : null, pGroup: round2(cascade.pGroup),
    templateId: String(cascade.templateId || ''), p: round2(cascade.p), margin: round2(cascade.margin),
    pWithin: optional(cascade.pWithin), marginWithin: optional(cascade.marginWithin), topK, path: cascade.path ?? null
  };
}

/** Bot vừa hỏi gì (suy từ mẫu bot trước + giỏ đang giữ còn thiếu gì). */
export function prevBotAsks(templateId, pending = null) {
  const id = String(templateId || '');
  if (['ORDER_ADDRESS', 'ORDER_ADDRESS_PARTIAL', 'ORDER_ADDRESS_CLARIFY', 'ORDER_ADDRESS_CHOOSE', 'ORDER_ADDRESS_REMIND', 'ORDER_CUSTOM_BASKET'].includes(id)) {
    const hasPhone = Boolean(pending?.phone);
    const hasAddress = Boolean(pending?.address);
    return !hasPhone && !hasAddress ? 'phone_address' : !hasPhone ? 'phone' : 'address';
  }
  if (['ORDER_PHONE', 'ORDER_ADDRESS_OLD_ASK_PHONE'].includes(id)) return 'phone';
  if (['ASK_FLAVOR', 'ASK_PRODUCT', 'ORDER_INFO_ASK_FLAVOR', 'ASK_FLAVOR_NGUYENBAN', 'COMBO3_FLAVOR'].includes(id)) return 'flavor';
  if (id === 'ORDER_EXISTING_CONFIRM') return 'confirm';
  if (id === 'ASK_QUANTITY') return 'quantity';
  return '';
}

/** Số túi khách nêu trong tin ("2 túi xanh", "combo 3", "hai bịch"); không rõ thì 0. */
export function bagCountInText(text) {
  const folded = foldVietnamese(String(text || '')).replace(/\s+/g, ' ');
  const words = { mot: 1, hai: 2, ba: 3, bon: 4, nam: 5 };
  let total = 0;
  for (const match of folded.matchAll(/\b(\d{1,2}|mot|hai|ba|bon|nam)\s*(?:tui|goi|bich|hop)\b/g)) total += Number(match[1]) || words[match[1]] || 0;
  for (const match of folded.matchAll(/\b(?:tui|goi|bich|hop)\s*(?:xanh|vang|nau|cacao)?\s*x?\s*(\d{1,2})\b/g)) total += Number(match[1]) || 0;
  if (!total) for (const match of folded.matchAll(/\bcombo\s*(\d)\b/g)) total += Number(match[1]) || 0;
  return total;
}

/** Ngữ cảnh của lượt (phần `ctx` trong nhật ký). */
export function decisionContext({ conversation, message, recentOrder = null, staffRepliedAfterBot = false, labels = [], gender = '' }) {
  const pending = conversation.pendingOrder || null;
  const last = String(conversation.botLastTemplateId || '');
  const text = message?.type === 'text' ? String(message.text || '') : '';
  const folded = foldVietnamese(text);
  return {
    hasBasket: Boolean(usablePendingOrder(pending, { templateId: 'ORDER_ADDRESS' })?.items?.length),
    basketAgeMin: pending?.items?.length ? minutesSince(pending.at) : null,
    basketItems: (pending?.items || []).reduce((sum, item) => sum + (Number(item?.quantity) || 0), 0),
    hasRecentOrder: Boolean(recentOrder?.id),
    orderAgeMin: recentOrder?.id ? minutesSince(recentOrder.createdAt) : null,
    staffRepliedAfterBot: Boolean(staffRepliedAfterBot),
    lastWasOrderStep: isOrderStep(last) || ['ASK_FLAVOR', 'ORDER_ADDRESS_REMIND', 'ORDER_CUSTOM_BASKET'].includes(last),
    livestream: isLivestreamPost(conversation),
    phoneInText: Boolean(text && extractVietnamesePhone(text)),
    addressInText: Boolean(text) && /\b(xa|huyen|quan|phuong|thi tran|thi xa|thanh pho|duong|thon|ap|kp|khu pho|so nha|ngo|hem|to \d)\b/.test(folded) && /\d/.test(folded.replace(/\+?\d[\d .-]{8,13}/g, ' ')),
    bagCount: bagCountInText(text),
    attentionOpen: (Array.isArray(labels) ? labels : []).some(label => /^(handoff|complaint|warranty)$/.test(String(label))),
    gender: String(gender || '')
  };
}

/**
 * Bản ghi nhật ký quyết định (schema v1) — xem docs trong báo cáo vòng 9:
 * { v, at, conversationId, source, mid, text, type, prevBot, prevBotAgeMin, prevBotAsks, ctx, rule, shadow,
 *   intent, cascade, llm, fewShot, chosen, final, also, skipped, guards: { preGuard, gate }, attention, handoff, ms }.
 * `cascade` (mô hình tầng, null khi không gọi / thiếu mô-đun): { group, subGroup, pGroup, templateId, p, margin,
 *   pWithin, marginWithin, topK, path, canary } — canary true/false khi intentCascade 'on' (ngoài canary chạy như shadow), null khi shadow.
 */
export function buildDecisionRecord({ conversation, change, trace, result = null, final = null, startedAt = Date.now() }) {
  const source = conversation.source === 'comment' ? 'comment' : 'inbox';
  return {
    v: 1,
    at: new Date().toISOString(),
    conversationId: String(conversation.id || ''),
    source,
    mid: String(change?.message?.mid || change?.message?.id || ''),
    text: String(trace.text || ''),
    type: String(trace.type || 'text'),
    prevBot: String(conversation.botLastTemplateId || ''),
    lastTemplate: String(conversation.botLastTemplateId || ''), // trùng prevBot (mã mẫu), để công cụ dựng dataset đọc thẳng
    prevBotAgeMin: minutesSince(conversation.botLastReplyAt),
    prevBotAsks: prevBotAsks(conversation.botLastTemplateId, conversation.pendingOrder),
    ctx: trace.ctx || decisionContext({ conversation, message: change?.message }),
    rule: trace.rule || null,
    shadow: Array.isArray(trace.shadow) ? trace.shadow : [],
    intent: trace.intent || null,
    cascade: trace.cascade || null,
    llm: trace.llm ? { templateId: trace.llm.templateId, retried: trace.llm.retried, hint: trace.llm.hint, usage: trace.llm.usage, model: trace.llm.model, calls: trace.llm.calls } : null,
    fewShot: Array.isArray(trace.fewShot) ? trace.fewShot : [],
    chosen: trace.chosen || null,
    final: final || null,
    also: trace.also || null,
    skipped: result?.skipped ? String(result.skipped) : result?.error ? `lỗi: ${String(result.error).slice(0, 160)}` : null,
    guards: {
      preGuard: trace.preGuard ? { decision: trace.preGuard.decision, reason: trace.preGuard.reason, mode: trace.preGuard.mode, matched: trace.preGuard.matched } : null,
      gate: trace.gate || null
    },
    attention: Boolean(trace.attention),
    handoff: Boolean(trace.handoff),
    ms: Date.now() - startedAt
  };
}
