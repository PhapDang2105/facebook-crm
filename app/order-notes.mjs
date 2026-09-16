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
const SYSTEM_NOTE_FRAGMENTS = [/^Đơn từ landing page\.?$/i, /^Tự điền, cần duyệt trước khi giao$/i, /^Nguồn: /i, /^Chiến dịch: /i, /^utm_[a-z]+=/i,
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

function formatSubmittedAt(value) {
  const text = String(value || '').trim();
  const match = text.match(/^(\d{4})-(\d\d)-(\d\d)[ T](\d\d):(\d\d)/);
  return match ? `${match[4]}:${match[5]} ${match[3]}/${match[2]}` : text;
}

/** Cấp địa chỉ còn thiếu, theo thứ tự nhân viên hỏi khách. */
export function missingAddressParts(order) {
  const parts = [];
  if (!isUsableStreet(order.street || '')) parts.push('số nhà/đường');
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

  if (landing.incomplete) {
    const when = formatSubmittedAt(landing.submittedAt);
    notes.push(`⏳ Khách bỏ dở form${when ? ` lúc ${when}` : ''}, chưa bấm gửi: gọi xác nhận đơn`);
  }
  if (noAddress) {
    notes.push('⚠ Chưa có địa chỉ giao hàng');
  } else {
    const missing = missingAddressParts(order);
    if (missing.length === 4) notes.push(`⚠ Địa chỉ không đọc được tỉnh/quận/phường ("${address.slice(0, 60)}"), hỏi lại khách`);
    else if (missing.length) notes.push(`⚠ Địa chỉ thiếu ${missing.join(', ')}`);
    if (order.locationConfidence === 'ambiguous' || landing.ambiguousAddress) notes.push('⚠ Địa chỉ trùng tên nhiều nơi, xác nhận lại với khách');
    else if (!missing.length && order.locationConfidence === 'fuzzy') notes.push('ℹ Địa chỉ đã sửa chính tả theo danh mục, đối chiếu khi gọi');
  }
  if (!hasProduct) notes.push('⚠ Chưa chọn sản phẩm');
  else if (unmatched.length) notes.push(`⚠ Sản phẩm chưa khớp danh mục: ${unmatched.join(', ')}`);
  else if (landing.needsProduct && landing.rawProducts && !landing.autoFilled?.product) notes.push(`⚠ Kiểm tra sản phẩm, form ghi: ${String(landing.rawProducts).slice(0, 120)}`);

  const autoFilled = landing.autoFilled || null;
  if (autoFilled?.product) notes.push(`🤖 Tự điền sản phẩm: ${autoFilled.product}`);
  if (autoFilled?.address) notes.push(`🤖 Tự điền địa chỉ: ${autoFilled.address}`);

  const warning = order.phoneWarning;
  if (warning && warning.level && warning.level !== 'none') {
    const detail = Array.isArray(warning.sources) && warning.sources.length ? `: ${warning.sources[0]}` : '';
    notes.push(`☎ ${warning.label || 'Số điện thoại cần gọi xác nhận'}${detail}`);
  }

  // formIds là các mã form gộp thêm (ngoài externalId); posIds gồm cả mã chính.
  const times = Math.max((landing.formIds || []).length + 1, (landing.posIds || []).length);
  if (times > 1) notes.push(`ℹ Khách gửi form ${times} lần, đã gộp thành một đơn`);
  return notes;
}
