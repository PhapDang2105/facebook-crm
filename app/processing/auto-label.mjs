// Gắn thẻ tự động cho hội thoại.
// Ba việc trong inbox luôn cần thấy ngay: đơn đã chốt, thread bot trả cho nhân
// viên, và khách đang phàn nàn. Bot phát ra "sự kiện" (order/handoff/complaint),
// còn THẺ nào được gắn thì do Cài đặt → Tin nhắn → Thẻ hội thoại quyết định,
// nên đổi tên hay đổi màu thẻ không cần sửa code.

/** Bỏ dấu tiếng Việt để từ khoá vẫn khớp khi khách gõ không dấu — cách gõ
 *  phổ biến nhất trên điện thoại. */
export function foldVietnamese(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\u0111/g, 'd')
    .replace(/\u0110/g, 'D')
    .toLowerCase();
}

// order: chốt đơn · handoff: chuyển nhân viên · complaint: khiếu nại · update: khách
// đổi sản phẩm/số lượng · cancel: khách hủy đơn · warranty: hỏi bảo hành/đổi trả ·
// livestream: khách đến từ phiên live · wholesale: hỏi sỉ/CTV · bad: số hay bom hàng.
export const autoLabelEvents = Object.freeze(['order', 'handoff', 'complaint', 'update', 'cancel', 'warranty', 'livestream', 'wholesale', 'bad', 'followup', 'followup-won']);

// Mẫu tin bot chọn khi khách hỏi bảo hành/đổi trả hay muốn mua sỉ.
export const warrantyTemplateIds = Object.freeze(['OIL_SMELL_WARRANTY', 'INSPECTION_RETURN_POLICY']);
export const wholesaleTemplateIds = Object.freeze(['WHOLESALE_CTV_CONTACT']);
const warrantyKeywords = 'bảo hành, đổi trả, trả hàng, đổi mới, hàng lỗi, sản phẩm lỗi, bị hỏng, bị hư, hôi dầu, có mùi, mốc, bị ẩm, bị ỉu';
const wholesaleKeywords = 'mua sỉ, giá sỉ, lấy sỉ, bỏ sỉ, sỉ lẻ, ctv, cộng tác viên, đại lý, nhập hàng, chiết khấu';

// Mẫu tin bot chọn khi đang xử lý một lời phàn nàn: chọn đúng mẫu này nghĩa là
// khách đang khiếu nại, không cần đợi trùng từ khoá.
export const complaintTemplateIds = Object.freeze(['OIL_SMELL_WARRANTY', 'DELIVERY_DELAY', 'REFUSED_DELIVERY']);

// Từ khoá mặc định, sửa được ở Thiết lập chatbot. Viết không dấu cũng khớp vì
// cả hai vế đều được bỏ dấu trước khi so. Từ khoá được so theo TỪ, không so
// chuỗi con: bỏ dấu xong "hỏng" và "không" đều còn "hong", nên so chuỗi con sẽ
// biến mọi câu "shop còn hàng không" thành một lời khiếu nại.
export const defaultComplaintKeywords = [
  'khiếu nại', 'phàn nàn', 'không hài lòng', 'thất vọng', 'tệ quá', 'dở quá', 'quá tệ',
  'hôi dầu', 'có mùi', 'mùi lạ', 'mốc', 'bị ẩm', 'bị ỉu', 'hết hạn', 'quá hạn', 'cận date',
  'bị hỏng', 'bị hư', 'bị móp', 'bị bể', 'bị vỡ', 'bị rách', 'chảy nước', 'dị vật', 'có sâu', 'có kiến',
  'hàng lỗi', 'sản phẩm lỗi', 'kém chất lượng', 'không giống', 'sai hàng', 'giao sai', 'giao nhầm',
  'thiếu hàng', 'thiếu quà', 'chưa nhận được', 'giao chậm', 'lâu quá', 'chưa thấy hàng',
  'đổi trả', 'trả hàng', 'hoàn tiền', 'bồi thường'
].join(', ');

/** Cắt câu thành danh sách từ đã bỏ dấu. */
function toWords(value) {
  return foldVietnamese(value).split(/[^a-z0-9]+/).filter(Boolean);
}

/** Dãy từ `needle` có nằm liền nhau trong `haystack` không. */
function hasWordSequence(haystack, needle) {
  if (!needle.length || needle.length > haystack.length) return false;
  return haystack.some((_, index) => needle.every((word, offset) => haystack[index + offset] === word));
}

/** Tách chuỗi từ khoá thành các dãy từ; chuỗi rỗng → không bắt gì cả. */
export function parseKeywords(value) {
  return String(value ?? '')
    .split(',')
    .map(item => toWords(item))
    .filter(words => words.length);
}

/**
 * Khách đang khiếu nại? Hoặc bot chọn mẫu trả lời khiếu nại, hoặc lời khách có
 * từ khoá. Chỉ xét tin của khách gửi vào, không xét tin bot gửi ra.
 */
export function isComplaint({ text = '', templateId = '', keywords = defaultComplaintKeywords } = {}) {
  if (complaintTemplateIds.includes(templateId)) return true;
  const message = toWords(text);
  if (!message.length) return false;
  return parseKeywords(keywords).some(keyword => hasWordSequence(message, keyword));
}

/**
 * Sự kiện gắn thẻ của một lượt trả lời. Trả về mảng rỗng khi không có gì để gắn.
 */
export function autoLabelEventsFor({ order = null, handoff = false, text = '', templateId = '', keywords, updated = false, cancelled = false, livestream = false, phoneWarningLevel = '' } = {}) {
  const events = [];
  if (handoff) events.push('handoff');
  if (order) events.push('order');
  // Số điện thoại từng bom hàng: thẻ "Cần người xử lý" để nhân viên gọi xác nhận trước khi giao.
  if (order?.phoneWarning && order.phoneWarning.level !== 'watch') events.push('handoff');
  if (isComplaint({ text, templateId, keywords })) events.push('complaint');
  if (updated) events.push('update');
  if (cancelled) events.push('cancel');
  if (livestream) events.push('livestream');
  const words = toWords(text);
  if (warrantyTemplateIds.includes(templateId) || parseKeywords(warrantyKeywords).some(keyword => hasWordSequence(words, keyword))) events.push('warranty');
  if (wholesaleTemplateIds.includes(templateId) || parseKeywords(wholesaleKeywords).some(keyword => hasWordSequence(words, keyword))) events.push('wholesale');
  // Số bị POS chặn hay bom nhiều: thẻ "Khách xấu" để nhân viên cân nhắc trước khi giao.
  const level = String(phoneWarningLevel || order?.phoneWarning?.level || '');
  if (level === 'high' || level === 'block') events.push('bad');
  return [...new Set(events)];
}
