// 05/10 (chủ shop): "Có thể chọn quà khác trong chức năng tạo đơn cho khách". Nhân viên đổi quà ngay trong khung
// Tạo đơn / Sửa đơn (khách live 2 túi không lấy quạt, xin muỗng dừa…): đơn mang `giftOverride` = danh sách quà
// CHỌN TAY [{ name, sku, quantity, weight, giftId? }]. Có danh sách → quà của đơn là ĐÚNG danh sách này (POS, file
// kho, chữ `order.gift`), bỏ quà tự tính theo bảng quà, quà ưu đãi bám đuổi và đổi quà của bot. Rỗng / không có =
// theo bảng quà như cũ. Module này không phụ thuộc module nào khác của app (dùng được ở mọi tầng, không vòng import).

export const GIFT_OVERRIDE_LIMIT = 10;
export const GIFT_OVERRIDE_MAX_QUANTITY = 10;
/** Đầu câu ghi chú xử lý khi quà đổi tay chưa có mã POS (gỡ / thay theo đầu câu này). */
export const GIFT_OVERRIDE_FLAG_PREFIX = '⚠ Quà đổi tay chưa có mã POS';
const FREE_SHIPPING_TEXT = 'Miễn phí vận chuyển';

const clean = (value, max) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

/**
 * Chuẩn hoá danh sách quà chọn tay: tối đa 10 mục, tên ≤ 120 ký tự (bắt buộc), SKU chữ in hoa ≤ 80 ký tự (rỗng =
 * chưa có mã), số lượng 1–10, khối lượng gam ≥ 0, giftId (mã dòng bảng quà) tuỳ chọn. Không phải mảng → [].
 * Hai mục cùng SKU (hay cùng tên khi không có SKU) gộp số lượng.
 */
export function normalizeGiftOverride(input) {
  if (!Array.isArray(input)) return [];
  const list = [];
  for (const item of input.slice(0, 50)) {
    if (!item || typeof item !== 'object') continue;
    const name = clean(item.name, 120);
    if (!name) continue;
    const sku = clean(typeof item.sku === 'string' || typeof item.sku === 'number' ? item.sku : '', 80).toUpperCase();
    const quantity = Math.min(GIFT_OVERRIDE_MAX_QUANTITY, Math.max(1, Math.round(Number(item.quantity) || 1)));
    const weight = Math.max(0, Math.min(100000, Math.round(Number(item.weight) || 0)));
    const giftId = clean(item.giftId, 60);
    const same = list.find(entry => (sku ? entry.sku === sku : !entry.sku && entry.name === name));
    if (same) { same.quantity = Math.min(GIFT_OVERRIDE_MAX_QUANTITY, same.quantity + quantity); continue; }
    if (list.length >= GIFT_OVERRIDE_LIMIT) continue;
    list.push({ name, sku, quantity, weight, ...(giftId ? { giftId } : {}) });
  }
  return list;
}

/** Đơn có quà chọn tay (khác rỗng)? */
export function hasGiftOverride(order) {
  return Array.isArray(order?.giftOverride) && order.giftOverride.some(item => item && String(item.name || '').trim());
}

/** Một mục quà thành chữ: "Muỗng dừa", "2 Muỗng dừa". */
export function giftOverrideItemText(item) {
  const quantity = Math.max(1, Math.round(Number(item?.quantity) || 1));
  return `${quantity > 1 ? `${quantity} ` : ''}${String(item?.name || '').trim()}`;
}

/** Chữ quà của đơn từ danh sách chọn tay: "Miễn phí vận chuyển + Bộ bát gáo dừa + Muỗng dừa" (miễn ship đứng đầu như bảng quà). */
export function giftOverrideText(list, { freeShipping = false } = {}) {
  const items = (Array.isArray(list) ? list : []).map(giftOverrideItemText).filter(Boolean);
  return [freeShipping ? FREE_SHIPPING_TEXT : '', ...items].filter(Boolean).join(' + ').slice(0, 300);
}

/**
 * Kế hoạch dòng quà của đơn có quà chọn tay; null khi đơn theo bảng quà.
 * - `lines`: dòng quà đẩy được [{ sku, name, weight, quantity }] (gộp theo SKU);
 * - `missing`: mục KHÔNG đẩy được — không có SKU, hay `knownSkus` (mẫu mã POS) không có mã đó. Không đoán mã khác.
 */
export function giftOverridePlan(order, knownSkus = null) {
  if (!hasGiftOverride(order)) return null;
  const lines = new Map();
  const missing = [];
  for (const item of order.giftOverride) {
    const name = String(item?.name || '').trim();
    if (!name) continue;
    const sku = String(item?.sku || '').trim().toUpperCase();
    const quantity = Math.min(GIFT_OVERRIDE_MAX_QUANTITY, Math.max(1, Math.round(Number(item?.quantity) || 1)));
    if (!sku) { missing.push(giftOverrideItemText({ name, quantity })); continue; }
    if (knownSkus && !knownSkus.has(sku)) { missing.push(`${giftOverrideItemText({ name, quantity })} (${sku})`); continue; }
    const line = lines.get(sku) || { sku, name, weight: Math.max(0, Math.round(Number(item?.weight) || 0)), quantity: 0 };
    line.quantity += quantity;
    lines.set(sku, line);
  }
  return { lines: [...lines.values()], missing };
}

/** Câu ghi chú xử lý cho nhân viên khi quà đổi tay không lên được POS. */
export function giftOverrideFlag(missing = []) {
  return `${GIFT_OVERRIDE_FLAG_PREFIX}: ${[...new Set(missing)].join(', ')} — nhân viên thêm trên POS`.slice(0, 160);
}

/**
 * Đặt lại ghi chú xử lý "Quà đổi tay chưa có mã POS" của đơn (`processingFlags`, như order-edits addProcessingFlag):
 * bỏ ghi chú cũ, gắn ghi chú mới khi còn mục thiếu. Trả true nếu đơn đổi.
 */
export function applyGiftOverrideFlag(order, missing = []) {
  if (!order || typeof order !== 'object') return false;
  const list = (Array.isArray(missing) ? missing : []).filter(Boolean);
  const flag = list.length ? giftOverrideFlag(list) : '';
  const before = Array.isArray(order.processingFlags) ? order.processingFlags.filter(item => typeof item === 'string') : [];
  const kept = before.filter(item => !item.startsWith(GIFT_OVERRIDE_FLAG_PREFIX) || item === flag);
  const next = flag && !kept.includes(flag) ? [...kept, flag].slice(-8) : kept;
  const changed = next.length !== (Array.isArray(order.processingFlags) ? order.processingFlags.length : 0) || next.some((item, index) => item !== order.processingFlags[index]);
  if (!changed) return false;
  if (next.length) order.processingFlags = next; else delete order.processingFlags;
  return true;
}

/** Ghi chú xử lý theo dữ liệu đơn (mục không có SKU) — dùng lúc lưu đơn, trước khi biết mẫu mã POS. */
export function syncGiftOverrideFlag(order) {
  return applyGiftOverrideFlag(order, giftOverridePlan(order)?.missing || []);
}
