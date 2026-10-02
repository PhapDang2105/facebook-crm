// R13: hai việc nhỏ dùng chung cho các route (tách khỏi server.mjs để có test):
// - friendlyClientError: lỗi kỹ thuật tiếng Anh của Node không đưa nguyên văn ra giao diện;
// - vnDateStamp: ngày theo giờ Việt Nam cho tên tệp tải về.

/**
 * Câu báo lỗi cho người dùng (HTTP 400). Lỗi do mã tự ném (Error thường, lời tiếng Việt) giữ nguyên; lỗi kỹ thuật
 * của Node — thân không phải JSON ("Unexpected end of JSON input", "Unexpected token…"), đường dẫn mã hoá sai
 * ("URI malformed"), truy cập thuộc tính của null/undefined ("Cannot read properties of null…") — đổi thành câu
 * tiếng Việt. Trước R13 các câu này hiện nguyên văn trên giao diện.
 */
export function friendlyClientError(error) {
  const message = String(error?.message || '');
  const name = String(error?.name || '');
  if (name === 'URIError' || /URI malformed/i.test(message)) return 'Đường dẫn không hợp lệ (ký tự % mã hoá sai).';
  if (name === 'SyntaxError' || /Unexpected (end of JSON input|token|non-whitespace|number|string)|is not valid JSON|JSON at position|in JSON/i.test(message)) {
    return 'Nội dung gửi lên không phải JSON hợp lệ.';
  }
  if (['TypeError', 'RangeError', 'ReferenceError'].includes(name)) return 'Yêu cầu không hợp lệ hoặc thiếu dữ liệu. Vui lòng kiểm tra lại rồi thử lại.';
  return message || 'Yêu cầu không hợp lệ.';
}

/**
 * "2026-10-02" theo GIỜ VIỆT NAM. Tên tệp tải về (CSV khách hàng, file kho, bảng Nhập dữ liệu) trước đây lấy
 * ngày UTC: tải lúc 00:00–06:59 sáng thì tệp mang ngày hôm trước.
 */
export function vnDateStamp(now = Date.now()) {
  const local = new Date((Number(now) || Date.now()) + 7 * 60 * 60 * 1000);
  const pad = number => String(number).padStart(2, '0');
  return `${local.getUTCFullYear()}-${pad(local.getUTCMonth() + 1)}-${pad(local.getUTCDate())}`;
}
