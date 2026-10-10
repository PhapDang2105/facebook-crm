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
// livestream: khách đến từ phiên live · wholesale: hỏi sỉ/CTV · bad: số hay bom hàng ·
// phone: khách ghi số điện thoại trong tin/bình luận (app/phone-labels.mjs) ·
// shipment-sent / delivered: đã gửi hành trình vận đơn cho khách / vận đơn giao thành công (app/sapo-sync.mjs).
export const autoLabelEvents = Object.freeze(['order', 'handoff', 'complaint', 'update', 'cancel', 'warranty', 'livestream', 'wholesale', 'bad', 'followup', 'followup-won', 'phone', 'shipment-sent', 'delivered', 'remarketing']);

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
  // Vòng 12 (B4 #1, #2): chê dưới bình luận từng bị cảm ơn công khai.
  'không ngon', 'hok ngon', 'hông ngon', 'ko ngon', 'chả ngon', 'chẳng ngon', 'khó ăn', 'nuốt không nổi', 'cứng như đá',
  'hôi dầu', 'có mùi', 'mùi lạ', 'mốc', 'bị ẩm', 'bị ỉu', 'hết hạn', 'quá hạn', 'cận date',
  'bị hỏng', 'bị hư', 'bị móp', 'bị bể', 'bị vỡ', 'bị rách', 'chảy nước', 'dị vật', 'có sâu', 'có kiến',
  'hàng lỗi', 'sản phẩm lỗi', 'kém chất lượng', 'không giống', 'sai hàng', 'giao sai', 'giao nhầm',
  'thiếu hàng', 'thiếu quà', 'chưa nhận được', 'giao chậm', 'lâu quá', 'chưa thấy hàng',
  'đổi trả', 'trả hàng', 'hoàn tiền', 'bồi thường'
].join(', ');

// R17 (bình luận A2, ca …229538 "Hũ hạnh nhân sấy mộc có ko e" → xin lỗi công khai + thẻ Khiếu nại/Bảo hành): bỏ dấu thì "mộc"
// (sấy mộc, vị mộc, "mộc mạc") và "mọc" trùng từ khoá "mốc". Chữ CÒN DẤU "mộc"/"mọc" đổi sang một từ khác trước khi bỏ dấu, nên
// chỉ "mốc" (hay "moc" gõ không dấu, như cũ) mới khớp.
const ACCENT_COLLISIONS = /(?<![\p{L}\p{N}])m(?:ộ|ọ)c(?![\p{L}\p{N}])/giu;
/** Cắt câu thành danh sách từ đã bỏ dấu. */
function toWords(value) {
  return foldVietnamese(String(value ?? '').normalize('NFC').replace(ACCENT_COLLISIONS, 'mocx')).split(/[^a-z0-9]+/).filter(Boolean);
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

// R14 (quyết định chủ shop 4, ca thật 02–03/10): lời chê "không như quảng cáo" / "không đúng với quoảng cáo" /
// "ko đc như quảng cao" / "khác hình" / "mở ra bên trong toàn yến mạch" — có chữ chen giữa nên không viết được thành
// từ khoá liền; so bằng mã trên chữ bỏ dấu (luôn bật, không phụ thuộc danh sách từ khoá trong Cài đặt).
export const AD_MISMATCH_COMPLAINT = /\b(?:khong|ko|k|kg|hong|hok|cha|chang)(?: (?:duoc|dc|dung|giong|nhu|voi|la|bang|y))+ (?:quang cao|quoang cao|quang cau|qc)\b|\b(?:khong|ko|k|kg|hong|hok|cha|chang)(?: (?:duoc|dc|dung|y))? (?:nhu|giong) (?:(?:tren|trong) )?(?:hinh|anh quang cao)\b|\bkhac (?:(?:voi|so voi|xa|han) )?(?:quang cao|quoang cao|qc|hinh|(?:tren|trong) hinh)\b|\bmo ra\b.{0,20}\b(?:toan|chu yeu)\b|\bmo ra (?:thi )?it\b/;
// "Dở" / "Dỡ" (chê, gõ sai dấu) đứng riêng trong tin ngắn (≤ 3 từ): chỉ nhận trên chữ CÒN DẤU — bỏ dấu thì "dở" trùng
// "đó/đỏ/do". "bỏ dở", "dở dang", "dở chừng" không phải chê.
const BAD_TASTE_RAW = /(?<![\p{L}])(?:dở|dỡ)(?![\p{L}])/iu;
const BAD_TASTE_NOT = /(?<![\p{L}])(?:bỏ\s+dở|dở\s+dang|dở\s+chừng|dỡ\s+hàng)(?![\p{L}])/iu;
export function shortBadTaste(text) {
  const raw = String(text || '').normalize('NFC').trim();
  if (!raw || !BAD_TASTE_RAW.test(raw) || BAD_TASTE_NOT.test(raw)) return false;
  return raw.split(/[^\p{L}\p{N}]+/u).filter(Boolean).length <= 3;
}
// R14 (ca …727620): khách kể hàng CHỖ KHÁC dở/hôi ("bữa mua một loại ở chổ khác mà về ăn ko ngon, bị hôi dầu") — không phải
// khiếu nại / bảo hành với shop (thẻ đó chặn bám đuổi). "thôi mua bên khác" (dọa bỏ shop) KHÔNG thuộc mẫu này.
export const OTHER_SELLER = /\b(?:o|tu|cua|tai|hang|bua|lan truoc) (?:cho|shop|ben|noi|tiem|cua hang|hang) khac\b|\b(?:shop|ben|tiem|cua hang|hang) khac (?:ban|giao|gui)\b/;
export const mentionsOtherSeller = text => OTHER_SELLER.test(foldVietnamese(text).replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim());

/**
 * Khách đang khiếu nại? Hoặc bot chọn mẫu trả lời khiếu nại, hoặc lời khách có
 * từ khoá. Chỉ xét tin của khách gửi vào, không xét tin bot gửi ra.
 * R14: thêm lời chê "không như quảng cáo / khác hình / mở ra … toàn yến mạch", "dở" đứng riêng; câu chê hàng CHỖ KHÁC
 * không tính (kể cả khi bot chọn mẫu bảo hành cho câu đó).
 */
export function isComplaint({ text = '', templateId = '', keywords = defaultComplaintKeywords } = {}) {
  const otherSeller = mentionsOtherSeller(text);
  if (complaintTemplateIds.includes(templateId) && !otherSeller) return true;
  const message = toWords(text);
  if (!message.length || otherSeller) return false;
  if (AD_MISMATCH_COMPLAINT.test(message.join(' ')) || shortBadTaste(text)) return true;
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
  // R14 (ca …727620): kể hàng chỗ khác bị hôi dầu → không gắn Bảo hành (thẻ này chặn bám đuổi).
  if (!mentionsOtherSeller(text) && (warrantyTemplateIds.includes(templateId) || parseKeywords(warrantyKeywords).some(keyword => hasWordSequence(words, keyword)))) events.push('warranty');
  if (wholesaleTemplateIds.includes(templateId) || parseKeywords(wholesaleKeywords).some(keyword => hasWordSequence(words, keyword))) events.push('wholesale');
  // Số bị POS chặn hay bom nhiều: thẻ "Khách xấu" để nhân viên cân nhắc trước khi giao.
  const level = String(phoneWarningLevel || order?.phoneWarning?.level || '');
  if (level === 'high' || level === 'block') events.push('bad');
  return [...new Set(events)];
}
