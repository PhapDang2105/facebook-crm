// Ghi chú xử lý cho từng đơn: những gì nhân viên cần biết để chốt và giao
// đơn thuận lợi (thiếu địa chỉ cấp nào, chưa chọn sản phẩm, máy đã tự điền
// gì, số điện thoại hay bom hàng, khách bỏ dở form, khách gửi mấy lần...).
//
// Mỗi ghi chú bắt đầu bằng một ký hiệu để bảng Đơn hàng tô màu và để file
// xuất kho lọc bỏ (ghi chú xử lý là việc nội bộ, không gửi cho vận chuyển):
//   ⚠ thiếu/không rõ thông tin   ⏳ khách chưa hoàn tất
//   🤖 máy tự điền, cần duyệt     ☎ số điện thoại cần gọi xác nhận
//   ℹ thông tin thêm
import { isUsableStreet } from './processing/locations.mjs';

export const NOTE_MARKERS = ['⚠', '⏳', '🤖', '☎', 'ℹ'];
export const NOTE_SEPARATOR = ' · ';

/** Các mẩu ghi chú máy tự thêm trước đây, không phải lời khách. */
const SYSTEM_NOTE_FRAGMENTS = [/^Đơn từ landing page\.?$/i, /^Tự điền, cần duyệt trước khi giao$/i, /^Tạo tự động từ xác nhận của chatbot\.?$/i, /^Nguồn: /i, /^Chiến dịch: /i, /^utm_[a-z]+=/i,
  // Ô lựa chọn của form Webcake từng bị ghi vào ghi chú ("select_1: 1 Túi Dùng Thử…"),
  // và các dòng POS tự chèn vào note đơn ("address: …", "link: …", "IP: …", "Order ID: …").
  /^(select|single ?choice|multiple ?choice|radio|checkbox|option|singlechoice|multiplechoice)[ _-]?\d*\s*:/i,
  /^(address|link|IP|Order ID)\s*:/i];
const NOTE_SPLIT = /\r?\n| · /;

export function isProcessingNote(segment) {
  const text = String(segment || '').trim();
  return NOTE_MARKERS.some(marker => text.startsWith(marker));
}

/** Lời khách ghi trong form/tin nhắn, bỏ các mẩu máy tự thêm. */
export function customerNote(order) {
  return String(order?.note || '').split(NOTE_SPLIT)
    .map(segment => segment.trim())
    .filter(segment => segment && !isProcessingNote(segment) && !SYSTEM_NOTE_FRAGMENTS.some(pattern => pattern.test(segment)))
    .join(NOTE_SEPARATOR);
}

/** Bỏ ghi chú xử lý khỏi ô Ghi chú (dùng khi xuất file cho kho/vận chuyển). */
export function stripProcessingNotes(note) {
  return String(note || '').split(NOTE_SEPARATOR).map(segment => segment.trim()).filter(segment => segment && !isProcessingNote(segment)).join(NOTE_SEPARATOR);
}

/** "Granola Túi Xanh 450g x2 (mặc định theo chiến dịch 1202…, 18 đơn)" → "Granola Túi Xanh 450g x2". */
function shortAutoFill(text) {
  return String(text || '').replace(/\s*\(mặc định theo (chiến dịch|trang|mọi đơn)[^)]*\)/i, '').trim();
}

/** "7/12 (58%)": số đơn khách đã nhận trên tổng số đơn. */
export function receiveRate(received, total) {
  if (!total) return '';
  return `${received}/${total} (${Math.round((received / total) * 100)}%)`;
}

/**
 * Nói bằng tỷ lệ khách nhận hàng, không dùng chữ "bom": Pancake đếm số đơn bom
 * trên tổng, shop mình đếm hoàn/huỷ và giao thành công. "Tỷ lệ nhận hàng: 7/12 (58%)".
 */
export function shortWarning(warning) {
  const source = Array.isArray(warning.sources) && warning.sources.length ? String(warning.sources[0]) : '';
  if (warning.level === 'block') return 'POS chặn số';
  const bom = source.match(/bom (\d+)\/(\d+)/i);
  if (bom) return `Tỷ lệ nhận hàng: ${receiveRate(Number(bom[2]) - Number(bom[1]), Number(bom[2]))}`;
  const shop = source.match(/hoàn\/huỷ (\d+) đơn(?:, giao thành công (\d+))?/i);
  if (shop) {
    const delivered = Number(shop[2]) || 0;
    return `Tỷ lệ nhận hàng ở shop: ${receiveRate(delivered, delivered + Number(shop[1]))}`;
  }
  if (source.includes('thẻ')) return 'POS gắn thẻ hoàn';
  return 'Số cần kiểm tra';
}

/** Cấp địa chỉ còn thiếu, theo thứ tự nhân viên hỏi khách. */
export function missingAddressParts(order) {
  const parts = [];
  if (!isUsableStreet(order.street || '')) parts.push('số nhà');
  if (!order.ward) parts.push('phường/xã');
  if (!order.district) parts.push('quận/huyện');
  if (!order.province) parts.push('tỉnh/thành');
  return parts;
}

/**
 * Danh sách ghi chú xử lý của một đơn (chatbot hoặc landing). Thứ tự: việc
 * phải làm trước (gọi khách, bổ sung) rồi đến thông tin nền.
 */
export function processingNotes(order) {
  if (!order || typeof order !== 'object') return [];
  const notes = [];
  const landing = order.landing || {};
  const address = String(order.address || '').trim();
  const noAddress = !address || /^chưa có địa chỉ$/i.test(address);
  const products = Array.isArray(order.products) ? order.products : [];
  const hasProduct = products.some(item => item?.sku || item?.name);
  const unmatched = products.filter(item => item?.name && !item?.sku).map(item => item.name);

  // Câu ngắn, đọc lướt được trong một ô: việc gì, thiếu gì. Giờ bỏ dở không
  // ghi vì trùng cột Ngày của bảng.
  if (landing.incomplete) notes.push('⏳ Bỏ dở form');
  if (noAddress) {
    notes.push('⚠ Chưa có địa chỉ');
  } else {
    const missing = missingAddressParts(order);
    // Kho chỉ nhận ba cấp trước sáp nhập 2025; khách ghi phường mới thì không tự đổi, nhân viên hỏi lại.
    if (order.postMerger) notes.push('⚠ Địa chỉ ghi theo đơn vị sau sáp nhập, hỏi lại khách');
    if (missing.length === 4) notes.push(`⚠ Địa chỉ không rõ: "${address.slice(0, 60)}"`);
    else if (missing.length) notes.push(`⚠ Thiếu ${missing.join(', ')}`);
    if (order.locationConfidence === 'ambiguous' || landing.ambiguousAddress) notes.push('⚠ Địa chỉ trùng tên, hỏi lại');
    else if (!missing.length && order.locationConfidence === 'fuzzy') notes.push('⚠ Địa chỉ đã sửa, đối chiếu');
  }
  if (!hasProduct) notes.push('⚠ Chưa chọn sản phẩm');
  else if (unmatched.length) notes.push(`⚠ Sản phẩm lạ: ${unmatched.join(', ')}`);
  else if (landing.needsProduct && landing.rawProducts && !landing.autoFilled?.product) notes.push(`⚠ Form ghi SP: ${String(landing.rawProducts).slice(0, 80)}`);

  const autoFilled = landing.autoFilled || null;
  if (autoFilled?.product) notes.push(`🤖 Tự điền SP: ${shortAutoFill(autoFilled.product)}`);
  if (autoFilled?.address) notes.push(`🤖 Tự điền địa chỉ: ${autoFilled.address}`);

  const warning = order.phoneWarning;
  if (warning && warning.level && warning.level !== 'none') notes.push(`☎ ${shortWarning(warning)}`);

  // Khách điền nhiều form thì mỗi form một đơn, không tự gộp; bảng Đơn hàng tự
  // ghi "cùng số điện thoại với đơn …" và bấm vào đơn thì hiện cả nhóm.
  return notes;
}
