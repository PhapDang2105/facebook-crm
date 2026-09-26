// Nhận diện một tin Page đã gửi là mẫu nào: so đầu câu (đã bỏ dấu, bỏ xưng hô) với chữ ký
// của từng mẫu trong Thiết lập tin nhắn, cộng vài mẫu dựng riêng (bảng giá, xác nhận đơn…).
// Dùng để gán nhãn tập huấn luyện mô hình nhỏ và để tách câu nhân viên tự viết (không khớp mẫu nào).

export const foldText = value => String(value || '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
const dropHonorific = text => text.replace(/\b(anh|chi|co|chu|ban|minh|a|c|e|em)\b/g, ' ').replace(/\s+/g, ' ').trim();
const normalize = text => dropHonorific(foldText(text));

// Mẫu dựng riêng: nội dung thay đổi theo sản phẩm/đơn nên không có chữ ký cố định.
const SPECIAL = [
  ['PRICE_MIX_TUI_LON', /^da gui .{0,10}bang gia mix/],
  ['PRICE_QUOTE', /^da gui .{0,14}bang gia|^da gui uu dai granola|^da gui hinh granola/],
  ['GENERAL_INFO', /^da hien tai nha .{0,8}(co )?3 vi|^da hien tai nha (dang )?co|^da giot nang (xin )?chao/],
  ['ORDER_CONFIRMATION', /^da xin phep xac nhan lai thong tin dat hang|^da gui xac nhan don hang/],
  ['ORDER_CART_LINE', /^da don (hang )?cua .{0,8}gom/],
  ['ORDER_ADDRESS_REMIND', /^da van dang giu don/],
  ['ORDER_ADDRESS', /^da de len don dung tuyen|^cho xin so dien thoai va dia/],
  ['ORDER_UPDATED', /^da da sua lai don/],
  ['UPSELL_TWO_BAGS', /^da neu .{0,8}lay 2/],
  ['THANK_YOU', /^da cam on/],
  ['LIVESTREAM_COMMENT', /^da oi phien live/],
  ['LIVESTREAM_VOUCHER', /^da hien tai voi cac phien livestream/],
  ['INGREDIENTS_ALLERGY', /^da granola ben lam tu|^da thanh phan granola/],
  ['COMMENT_PUBLIC_REPLY', /^da (da )?nhan tin|^da vui long kiem tra ib|^da .{0,24}oi vua ib|^da .{0,24}check hop tin nhan/],
  ['COMMENT_PRIVATE_REPLY', /^da thay de lai binh luan duoi bai viet/],
  ['SHIPPING_POLICY', /^da thoi gian giao du kien/],
  ['WEIGHT_EXPIRY', /^da mot tui granola|^da khoi luong 1 tui/],
  ['BAG_COMPARISON', /^da cac tui ben deu dung chung/],
  ['DISCOUNT_POLICY', /^da tuy vao tung dong san pham/],
  ['ORDER_STATUS_NONE', /^da khong tra duoc thong tin/],
  ['ORDER_STATUS', /^da em kiem tra thay don|^da kiem tra thay don/],
  ['CSKH_HANDOFF', /^da nhan tin cho giot nang qua messenger/]
];

/** Chữ ký (đầu câu ≥ 12 ký tự trước placeholder đầu tiên) của từng biến thể mẫu, dài trước ngắn sau. */
export function templateSignatures(templates = {}) {
  const signatures = [];
  for (const [id, raw] of Object.entries(templates)) {
    const text = String(raw || '');
    if (!text.trim()) continue;
    for (const variant of text.split('###')) {
      const plain = variant.replace(/\[\?[^\]]*\]|\[\/\?\]|\[\[[^\]]*\]\]/g, ' ').replace(/\{[^}]+\}/g, ' | ');
      const pieces = plain.split('|').map(normalize);
      // Đầu câu: so bằng startsWith. Đoạn mở đầu bằng placeholder ("{Title} cần em tư vấn thêm…", câu đuôi
      // của bảng giá) lấy mảnh đủ dài đầu tiên, so bằng includes để không bị nhận nhầm là nhân viên viết.
      if (pieces[0].length >= 12) signatures.push({ id, key: pieces[0].slice(0, 60), anywhere: false });
      else { const piece = pieces.find(item => item.length >= 20); if (piece) signatures.push({ id, key: piece.slice(0, 60), anywhere: true }); }
    }
  }
  return signatures.sort((first, second) => second.key.length - first.key.length);
}

/** Mã mẫu của một tin Page đã gửi, '' nếu không khớp mẫu nào (nhân viên tự viết). */
export function matchTemplate(text, signatures) {
  const norm = normalize(text);
  if (!norm) return '';
  for (const [id, pattern] of SPECIAL) if (pattern.test(norm)) return id;
  for (const { id, key, anywhere } of signatures) if (anywhere ? norm.includes(key) : norm.startsWith(key)) return id;
  return '';
}

/** Tin Page không phải câu trả lời: thông báo hệ thống (bình luận, quảng cáo, tệp) hay lời chào tự động. */
export function isSystemNotice(text) {
  return /^Bạn đang phản hồi bình luận|^Khách bấm vào quảng cáo|đã trả lời (một quảng cáo|về một bài viết)|^\[Tệp đính kèm\]|^Chào .{1,40}! Chúng tôi có thể giúp gì/u.test(String(text || '').trim());
}
