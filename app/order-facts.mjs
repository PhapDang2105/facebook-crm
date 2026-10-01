// Bộ gom đơn dùng chung cho Tổng quan, Báo cáo và Chiến dịch: mọi đơn của CRM
// (đơn trong hội thoại — bot chốt, nhân viên lên, POS kéo về — và đơn landing)
// thành một danh sách "sự kiện đơn" phẳng, cùng một luật hủy / bỏ dở, cùng một
// cách chia doanh thu cho từng dòng sản phẩm.
//
// Nguồn đơn (`source`):
//  - 'landing': đơn form landing (kể cả đơn landing kéo từ Pancake POS về).
//  - 'pos':     đơn nhân viên/Shop tạo trên Pancake POS, kéo về hội thoại.
//  - 'chatbot': bot chốt trong hội thoại (automatic / employee "Chatbot AI").
//  - 'import':  nhân viên lên đơn tay ở khung khách hàng ("Nhập tay").
//  - còn lại:   chữ thường của trường `source` gốc (hoặc 'other').
import { INCOMPLETE_LABEL, LANDING_SOURCE, campaignKey } from './landing-orders.mjs';
import { vietnamDay } from './meta-ads.mjs';
import { toLocalPhone } from './processing/customer-info.mjs';

export const SOURCE_LABELS = Object.freeze({
  chatbot: 'Chatbot',
  landing: 'Landing page',
  pos: 'POS',
  import: 'Nhập tay',
  other: 'Khác'
});

export function sourceLabel(key) {
  return SOURCE_LABELS[key] || String(key || SOURCE_LABELS.other);
}

/**
 * Mã trạng thái Pancake POS coi là không thành doanh thu: 4 đang hoàn, 5 đã
 * hoàn (bom/khách không nhận), 6 đã hủy, 7 đã xóa.
 */
export const POS_FAILED_STATUS_CODES = Object.freeze([4, 5, 6, 7]);

const foldStatus = value => String(value || '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/gi, 'd').toLowerCase();
// "hoàn tất"/"hoàn thành" (form Webcake) không phải hoàn hàng; "bom"/"boom" là khách không nhận hàng.
const FAILED_STATUS = /\bhuy\b|\bhoan\b(?!\s*(tat|thanh))|return|cancel|delet|\bbo+m\b|tra hang|khong nhan hang|giao (hang )?that bai/;

/**
 * Đơn hủy / hoàn / đang hoàn / bom: không tính doanh thu. Xét trạng thái MỚI
 * NHẤT ở mọi nơi đơn mang: trạng thái CRM, trạng thái POS lúc đẩy/kéo về
 * (`pos.status`) và trạng thái POS đồng bộ sau đó (`posStatus`, cập nhật cả khi
 * đơn bị hủy/hoàn trên POS nhiều ngày sau lúc đặt).
 */
export function isCancelledOrder(order) {
  if (String(order?.processingStatus || '') === 'cancelled') return true;
  const posCode = order?.posStatus?.code;
  const hasPosCode = posCode !== undefined && posCode !== null && posCode !== '' && Number.isFinite(Number(posCode));
  if (hasPosCode && POS_FAILED_STATUS_CODES.includes(Number(posCode))) return true;
  // Có mã POS mới nhất thì tin mã (tên "hoàn một phần" không làm mất cả đơn); trạng thái POS
  // cũ lúc đẩy/kéo về chỉ dùng khi chưa đồng bộ mã mới.
  const names = hasPosCode ? [order?.status] : [order?.status, order?.posStatus?.name, order?.pos?.status];
  return names.some(value => FAILED_STATUS.test(foldStatus(value)));
}

/** Form landing khách bỏ dở: chưa là đơn, trừ khi nhân viên đã gọi xác nhận. */
export function isIncompleteOrder(order) {
  if (String(order?.processingStatus || '') === 'confirmed') return false;
  return order?.landing?.incomplete === true || order?.status === INCOMPLETE_LABEL;
}

export function orderSourceKey(order) {
  const source = String(order?.source || '').trim();
  if (source === LANDING_SOURCE || order?.landing) return 'landing';
  if (source === 'POS') return 'pos';
  if (order?.automatic === true || order?.employee === 'Chatbot AI') return 'chatbot';
  if (!source || source === 'Facebook') return 'import';
  return source.toLowerCase();
}

/** Khóa khách: SĐT dạng 0xxxxxxxxx; không có SĐT hợp lệ thì theo hội thoại, rồi theo mã đơn. */
export function customerKeyOf(phone, conversation, orderId) {
  const local = toLocalPhone(phone) || String(phone ?? '').replace(/\D/g, '');
  if (local) return `phone:${local}`;
  if (conversation?.pageId && conversation?.psid) return `psid:${conversation.pageId}:${conversation.psid}`;
  return `order:${orderId}`;
}

/**
 * Chia tổng đơn cho từng dòng theo giá khách trả (paidPrice, không có thì giá
 * niêm yết) × số lượng; dòng cuối nhận phần làm tròn để cộng lại đúng bằng tổng.
 */
function productLines(products, total) {
  const lines = (Array.isArray(products) ? products : []).filter(item => item && (item.sku || item.name)).map(item => ({
    sku: String(item.sku || '').trim(),
    name: String(item.name || item.sku || '').trim(),
    quantity: Math.max(1, Math.round(Number(item.quantity) || 1)),
    weight: Math.max(0, Number(item.paidPrice) || Number(item.price) || 0)
  }));
  if (!lines.length) return [];
  let weights = lines.map(line => line.weight * line.quantity);
  if (!weights.some(Boolean)) weights = lines.map(line => line.quantity);
  const sum = weights.reduce((acc, value) => acc + value, 0);
  let left = Math.round(Number(total) || 0);
  return lines.map((line, index) => {
    const revenue = index === lines.length - 1 ? left : Math.round((Number(total) || 0) * weights[index] / sum);
    left -= revenue;
    return { sku: line.sku, name: line.name, quantity: line.quantity, revenue };
  });
}

/** Phí ship khách trả trong tổng đơn (miễn ship → 0; không vượt tổng). */
function chargedShipping(order, total) {
  if (!order || order.freeShipping === true) return 0;
  return Math.min(Math.max(0, Math.round(Number(order.shippingFee) || 0)), total);
}

/** Một đơn → một sự kiện đơn phẳng. */
export function orderFact(order, conversation = null) {
  const createdAt = Number(order?.createdAt) || 0;
  const id = String(order?.id || '');
  const total = Math.max(0, Math.round(Number(order?.total) || 0));
  const source = orderSourceKey(order);
  const fact = {
    id,
    createdAt,
    dateVN: createdAt ? vietnamDay(createdAt) : '',
    source,
    status: String(order?.status || ''),
    processingStatus: String(order?.processingStatus || ''),
    cancelled: isCancelledOrder(order),
    incomplete: isIncompleteOrder(order),
    // Nhân viên đã xóa khỏi bảng Đơn hàng; là đơn trùng hay không do markHiddenDuplicates quyết.
    hidden: order?.hiddenFromTable === true,
    duplicate: false,
    total,
    // Doanh thu theo sản phẩm chia phần TIỀN HÀNG (tổng trừ phí ship khách trả), không chia cả phí ship
    // (01/10: 1 Túi Xanh 174k + ship 15k từng ghi 189k cho Túi Xanh). Tổng đơn, cột Đơn giá và file xuất kho
    // vẫn gồm ship như cũ (paidUnitPrices — chủ ý).
    products: productLines(order?.products, Math.max(0, total - chargedShipping(order, total))),
    phone: toLocalPhone(order?.phone) || String(order?.phone || ''),
    customerKey: customerKeyOf(order?.phone, conversation, id),
    employee: String(order?.employee || '').trim(),
    conversationId: String(conversation?.id || order?.conversationId || '')
  };
  if (source === 'landing') {
    const key = String(campaignKey(order) || '').trim();
    if (key) fact.utmCampaign = key;
  }
  return fact;
}

/**
 * Mọi đơn của CRM thành danh sách sự kiện đơn, cũ trước. Đơn cùng mã xuất hiện
 * hai lần (hai hội thoại, hay vừa trong hội thoại vừa trong kho landing) chỉ giữ
 * bản sửa sau cùng. `attribute(order, conversation)` (tùy chọn) trả về mã chiến
 * dịch của đơn → `campaignId`.
 */
export function collectOrderFacts({ conversations = [], landingOrders = [], attribute = null } = {}) {
  const byId = new Map();
  const add = (order, conversation) => {
    if (!order || !Number(order.createdAt)) return;
    const id = String(order.id || '');
    const existing = id ? byId.get(id) : null;
    if (existing && (Number(existing.order.updatedAt) || 0) >= (Number(order.updatedAt) || 0)) return;
    byId.set(id || `#${byId.size}`, { order, conversation });
  };
  for (const conversation of conversations) {
    for (const order of Array.isArray(conversation?.customerOrders) ? conversation.customerOrders : []) add(order, conversation);
  }
  for (const order of Array.isArray(landingOrders) ? landingOrders : []) add(order, null);
  const facts = [];
  for (const { order, conversation } of byId.values()) {
    const fact = orderFact(order, conversation);
    if (attribute) {
      const campaignId = attribute(order, conversation, fact);
      if (campaignId) fact.campaignId = campaignId;
    }
    facts.push(fact);
  }
  return markHiddenDuplicates(facts.sort((first, second) => first.createdAt - second.createdAt));
}

/** Cửa sổ "trùng đơn" — cùng 7 ngày bảng Đơn hàng dùng để báo "Trùng đơn ngày …". */
export const DUPLICATE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Đơn trùng đã xóa khỏi bảng: đơn bị ẩn (hiddenFromTable) mà cùng khách (cùng
 * SĐT) còn một đơn khác vẫn được tính trong vòng 7 ngày — đơn còn hiện trong
 * bảng, hoặc đơn ẩn sớm hơn đã được giữ — thì là bản trùng, không đếm đơn,
 * doanh thu hay khách. Đơn ẩn không có đơn nào khác đứng thay (nhân viên "Xóa
 * bảng", đơn quá hẹn tự rời bảng) vẫn là đơn thật và vẫn được tính.
 * `facts` xếp cũ trước; đánh dấu tại chỗ và trả lại chính mảng đó.
 */
export function markHiddenDuplicates(facts, windowMs = DUPLICATE_WINDOW_MS) {
  const byCustomer = new Map();
  for (const fact of facts) {
    if (fact.cancelled || fact.incomplete) continue;
    const list = byCustomer.get(fact.customerKey) || [];
    list.push(fact);
    byCustomer.set(fact.customerKey, list);
  }
  for (const list of byCustomer.values()) {
    if (list.length < 2 || !list.some(fact => fact.hidden)) continue;
    for (const fact of list) {
      if (!fact.hidden) continue;
      fact.duplicate = list.some(other => other !== fact
        && !other.duplicate
        && Math.abs(other.createdAt - fact.createdAt) <= windowMs
        // Đơn còn hiện trong bảng đứng thay được ở bất kỳ phía nào; đơn ẩn chỉ khi sớm hơn (đã được giữ).
        && (!other.hidden || other.createdAt < fact.createdAt || (other.createdAt === fact.createdAt && other.id < fact.id)));
    }
  }
  return facts;
}

/** Đơn tính doanh thu: chưa hủy/hoàn/bom, không phải form bỏ dở, không phải đơn trùng đã xóa khỏi bảng. */
export const isValidFact = fact => !fact.cancelled && !fact.incomplete && !fact.duplicate;

// ===== Khoảng ngày (giờ Việt Nam) =====

export const DAY_MS = 24 * 60 * 60 * 1000;
const VIETNAM_OFFSET_MS = 7 * 60 * 60 * 1000;
const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** "YYYY-MM-DD" hợp lệ (có thật trên lịch) hay không. */
export function isDayString(value) {
  if (!DAY_PATTERN.test(String(value || ''))) return false;
  const at = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(at) && new Date(at).toISOString().slice(0, 10) === value;
}

/** Cộng/trừ ngày trên chuỗi "YYYY-MM-DD". */
export function shiftDay(day, delta) {
  return new Date(Date.parse(`${day}T00:00:00Z`) + delta * DAY_MS).toISOString().slice(0, 10);
}

/** Số ngày của khoảng [since, until], tính cả hai đầu. */
export function daySpan(since, until) {
  return Math.round((Date.parse(`${until}T00:00:00Z`) - Date.parse(`${since}T00:00:00Z`)) / DAY_MS) + 1;
}

export function datesBetween(since, until) {
  const dates = [];
  for (let at = Date.parse(`${since}T00:00:00Z`); at <= Date.parse(`${until}T00:00:00Z`); at += DAY_MS) dates.push(new Date(at).toISOString().slice(0, 10));
  return dates;
}

/** Mốc ms đầu ngày (00:00 giờ Việt Nam) của "YYYY-MM-DD". */
export function vietnamDayStartMs(day) {
  return Date.parse(`${day}T00:00:00Z`) - VIETNAM_OFFSET_MS;
}

/**
 * Khoảng from/to ("YYYY-MM-DD", giờ Việt Nam) hợp lệ thì dùng; đảo ngược thì
 * đổi chỗ; dài quá `maxDays` thì cắt bớt phía đầu. Không hợp lệ → null.
 */
export function normalizeDayRange(from, to, { maxDays = 366 } = {}) {
  if (!isDayString(from) || !isDayString(to)) return null;
  let since = from;
  let until = to;
  if (since > until) [since, until] = [until, since];
  if (daySpan(since, until) > maxDays) since = shiftDay(until, -(maxDays - 1));
  return { since, until, days: daySpan(since, until) };
}
