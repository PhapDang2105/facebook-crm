// Luật nhận ý khách bằng code, chạy TRƯỚC mô hình: tin nào code nhận chắc chắn
// thì trả thẳng mẫu, không gọi Gemini (không tốn token, không chờ, không 429).
// Bộ luật đo trên 856 lượt tin thật 22–25/09 và kiểm lại trên 788 lượt tuần
// 16–22/09 (không dùng khi viết luật): bắt ~33–44% lượt, rà tay từng tin bắt
// được, ≥ 97% đúng. Tin dài, nhiều ý, phụ thuộc ngữ cảnh vẫn để mô hình.
import { foldVietnamese } from './auto-label.mjs';
import { extractVietnamesePhone } from './customer-info.mjs';
import { getCatalogProducts } from './catalog.mjs';

/** Chuỗi chuẩn để so luật: bỏ dấu, bỏ dấu câu, bỏ lời gọi đầu câu và từ đệm cuối câu. */
export function core(text) {
  let s = foldVietnamese(text).toLowerCase().replace(/[^a-z0-9+/% ]+/g, ' ').replace(/\s+/g, ' ').trim();
  s = s.replace(/^(?:(?:shop|sop|em|e|chi|c|ban|b|ad|anh|a) (?:oi|oei|ui) )+/, '');
  const tail = / (?:a|ah|ak|ha|nha|nhe|nhi|shop|sop|shoo|em|e|ban|b|chi|c|oi|ui|vay|v|z|voi|di|luon|hi|ad|admin|ne|s)$/;
  let previous;
  do { previous = s; s = s.replace(tail, ''); } while (s !== previous);
  return s.trim();
}

// "nâu vị ca cao", "ca cao" → một chữ, để đếm màu không bị lệch.
const prep = raw => String(raw || '').replace(/n[âa]u\s+(v[ịi]\s+)?ca\s*cao/giu, 'nâu').replace(/ca\s+cao/giu, 'cacao');
const PRICE = /\b(gia|bn|bao nhieu|bnhiu|bao tien|nhieu tien|tong)\b|nhieu$/;
const ORDER_VERB = /\b(lay|dat|mua|chot|gui|ship cho|cho (minh|em|e|chi|c|toi|tui|anh|a|mk|m|u) \d|giao)\b/;
const LIVE_ONLY = /(sua hat|hat dieu|hat bi|xoai|dau say|xanh duong|hu hat)/;
const COMPLAINT = /\b(bi hoi|hoi dau|co mui|mui la|moc|qua cung|bi cung|di vat|bi hu|bi loi|hang loi|that vong|te qua|khong ngon|chua nhan|giao cham|nhan (dc|duoc) hang roi)\b/;
// Mẫu an toàn: sau những mẫu này "." / "giá" / "hi" là câu hỏi mới, không phải câu trả lời cho bước đơn.
const SAFE_LAST = new Set(['', 'WELCOME', 'GENERAL_INFO', 'LIVESTREAM_COMMENT', 'REPLY_ALREADY_SENT', 'REPLY_ALREADY_SENT_INFO', 'THANK_YOU', 'COMMENT_PRIVATE_REPLY']);
const ORDER_STEPS = new Set(['ORDER_ADDRESS', 'ORDER_PHONE', 'ORDER_CONFIRMATION', 'ORDER_UPDATE', 'ORDER_ADDRESS_REMIND', 'ORDER_CUSTOM_BASKET', 'ASK_FLAVOR']);

const TERSE_A = /^(ib|inb|inbox|in box|in|tv|tu van|xin gia|xin gua|xg|gia|bao gia|bn|bnt|gia bn|gia bao nhieu|gia bao nhieu tien|gia sao|gia the nao|gia ntn|gia nhieu|gia nhieu tien|bao nhieu|bao nhieu tien|nhieu z|nhiu z|cho xin gia|cho gia|xin bao gia|bao gia luon|gia ca|bn vay|gia bao tien|bao tien|xin gia (sp|san pham|granola|gran|ngu coc)|cho xin thong tin ve gia|tu van (cho minh|giup|dum|di)|xin (shop )?tu van( dum| giup)?|ib minh|inbox minh|granola|grannola|gannola|nola)$/;
const TERSE_B = /^(?:(?:xin |cho (?:hoi |xin )?)?gia |ban )?(?:bao nhieu|bn|bnhiu|nhieu|nhiu|bao tien|gia bao nhieu|gia bn|gia sao|gia nhieu|gia may)(?: tien)?(?: (?:1|mot))? ?(?:tui|tuy|goi|bich|bit|bicp|bao)?(?: vay)?$/;
const TERSE_C = /^(?:1|mot) ?(?:tui|tuy|goi|bich|bit) (?:gia )?(?:bao nhieu|bn|nhieu|may|sao)(?: tien)?$/;
const GREETING = /^(hi|hello|helo|alo|a lo|chao|xin chao|chao (shop|em|ban|chi|anh)|shop|shop oei|oi)$/;
const WANT_BUY = /^(?:(?:minh|em|e|chi|c|toi|m|mk|to|tui) (?:muon |can |dinh )?|(?:muon|can) )(?:mua|dat hang|mua hang|dat mua|order|mua sp|mua san pham|tham khao)$/;
const LIVE_DEAL = /\b(da (san|mua|chot|dat)|san (duoc|deal|the nao|tn|sao|ntn)|len ma|ma gi|cach (san|chot|tham gia|dat|mua))\b/;
const PHONE_ONLY = /^(?:(?:sdt|dt|so dt|so dien thoai)\s*:?\s*)?\+?[0-9][0-9 .-]{8,13}$/;

// Câu hỏi thông tin: [luật, regex trên core, mẫu, điều kiện loại trừ thêm].
const INFO_RULES = [
  ['HEALTH', /\b(me bau|bau bi|dang bau|mang thai|thai ky|tieu duong|tieu dg|huyet ap)\b/, 'HEALTH_CONDITION'],
  ['KIDS', /\b(cho be|be an|be \d+ tuoi|tre em|tre nho|con nho|cho con|nguoi lon tuoi)\b/, 'KIDS_FAMILY'],
  ['CALORIES', /(calo|kcal|giam can|an kieng|eat ?clean|tang can|\bbeo\b)/, 'CALORIES_DIET'],
  ['SUGAR', /(co ngot|ngot (lam|nhieu|khong|ko|k|kh)\b|(khong|ko|k) (co )?duong|it duong|co duong|loai nao (khong|ko|k) ngot)/, 'NO_ADDED_SUGAR'],
  ['CRUNCHY', /((hat|vien) (gion|tron)\b.*\b(la|lam tu|lam bang) (hat |gi|j)|hat tron nho la|co (chien|ngay)|(chien|dau an) (khong|ko|k)\b)/, 'CRUNCHY_CEREAL_INFO'],
  ['INGREDIENTS', /(thanh phan|gom (nhung |cac )?(gi|hat|loai)|(co|la) (nhung |cac )?(loai )?hat (gi|j|nao)|hat (gi|j)\b|di ung|(co|khong|ko) .*dau nanh|gluten)/, 'INGREDIENTS_ALLERGY', s => PRICE.test(s)],
  ['WEIGHT_EXPIRY', /((bao nhieu|bn|may|nhieu) ?(gam|gram|gr|g)\b|han (su dung|dung|sd)|hsd|an (duoc|dc) (bao )?lau|an (duoc|dc) may bua|dung (duoc|dc) may bua|trong luong)/, 'WEIGHT_EXPIRY', s => /\bgia\b|date moi|hang moi/.test(s)],
  ['COMPARE', /(khac nhau|khac (gi|sao|ntn|nhu nao|the nao)|nao ngon|ngon hon|nen (chon|mua|dung|lay) (loai|tui|vi)? ?nao|phan biet|giai thich|nguyen ban la (sao|gi)|loai nao nhieu hat)/, 'BAG_COMPARISON', s => PRICE.test(s) || /\bbi\b|can|beo|kieng|\bbe\b/.test(s)],
  // Đang giữ giỏ: vẫn khớp, ruleIntent giữ bước đơn (dòng giỏ có tổng + miễn ship) và trả lời kèm.
  ['FREESHIP', /(mien|free) ?(phi )?(ship|sip|van chuyen)|freeship/, 'FREESHIP_POLICY', s => PRICE.test(s)],
  ['DISCOUNT', /(giam gia|khuyen mai|\bkm\b|uu dai|chuong trinh|\bct\b|\bsale\b)/, 'DISCOUNT_POLICY', (s, ctx) => ctx.livestream || /(voucher|qua|tang|gau|live)/.test(s)],
  ['VOUCHER', /(voucher|vocher|vochur|ma giam)/, 'LIVESTREAM_VOUCHER', s => PRICE.test(s)],
  ['GIFT', /((qua|tang) (gi|j)\b|co (duoc )?(qua|tang)|duoc tang|qua tang)/, 'GIFT_POLICY', s => PRICE.test(s) || /\b(xanh|vang|nau|cacao)\b|gau|dau tay|doi qua|thay qua|khac/.test(s)],
  ['PHOTOS', /(xem (hinh|anh|mau|san pham)|chup (xem|hinh|anh|cho|minh|chi|em)|gui (hinh|anh|mau) xem|(anh|hinh) that|cho (xem|coi)|xem them anh)/, 'PRODUCT_PHOTOS'],
  ['SMALL_PACK', /\b(co|ban) (tui|goi) nho|hop 10 goi|chia (goi|nho)|goi le\b/, 'PACKAGING_INFO', (s, ctx) => PRICE.test(s) || ctx.hasBasket],
  ['SHIP_TIME', /((bao lau|may ngay|bao nhieu ngay|bn ngay|khi nao|chung nao) (thi )?(nhan|giao|toi|den|co)|(giao|ship|nhan)( hang)? (mat )?(bao lau|may ngay|bn ngay)|may ngay giao|khoang chung nao)/, 'SHIPPING_POLICY'],
  ['LINKS', /((xin|gui|cho) .*(link|linh gian hang|gian hang)|(co|vo|ban) (tren|o) (shopee|tiktok|lazada))/, 'ECOMMERCE_LINKS'],
  ['WHOLESALE', /(\bsi\b|\bctv\b|cong tac vien|dai ly|lay buon)/, 'WHOLESALE_CTV_CONTACT', s => /(bac|tien|y|ca|nghe|thac) si/.test(s)],
  ['VAT', /\b(vat|xuat hoa don|hoa don (do|vat|gtgt|dien tu))\b/, 'VAT_INVOICE']
];

const ICEBREAKERS = [
  [/^lam cach nao de dat hang$/, 'price'],
  [/^(lam cach nao de xem san pham truoc|toi co the xem them anh ve mat hang nay khong)$/, 'PRODUCT_PHOTOS'],
  [/^(co chuong trinh giam gia nao khong|khuyen mai combo dung thu tiet kiem)$/, 'DISCOUNT_POLICY'],
  [/^get started$/, 'WELCOME']
];

const colourSku = colour => getCatalogProducts().find(item => item.active !== false && /^gra-/i.test(item.sku || '') && String(item.sku || '').toLowerCase().includes(`-${colour}-`));

/** Giỏ ghi mơ hồ ("combo xanh", "2 gói xanh vàng", "vàng 2 túi", "1 combo vàng"): để mô hình. */
function basketAmbiguous(raw) {
  const x = foldVietnamese(prep(raw)).replace(/\b\d{3} ?(g|gr|gram)\b/g, ' ').replace(/\+?\d{9,11}/g, ' ');
  const numbers = x.match(/\b\d{1,2}\b/g) || [];
  const colours = new Set(x.match(/\b(xanh|vang|nau|cacao)\b/g) || []);
  return (/\bcombo\b/.test(x) && !numbers.length)
    || (colours.size >= 2 && numbers.length === 1 && Number(numbers[0]) >= 2)
    || /\b(xanh|vang|nau|cacao)\b[^0-9]*\b\d{1,2}\b(?!.*\b(xanh|vang|nau|cacao)\b)/.test(x)
    || /\d\s*combo\b/.test(x);
}

// Sau khi bỏ mọi chữ nói về giỏ, còn chữ nào thì tin có ý khác: để mô hình.
const BASKET_WORDS = new Set(['xanh', 'vang', 'nau', 'cacao', 'la', 'cay', 'tui', 'tuy', 'goi', 'bich', 'bit', 'hop', 'combo', 'lay', 'dat', 'mua', 'chot', 'gui', 'ship', 'cho', 'muon', 'can', 'em', 'e', 'minh', 'mk', 'm', 'chi', 'c', 'toi', 'tui', 'anh', 'a', 'to', 'ban', 'b', 'shop', 'va', 'voi', 'them', 'moi', 'loai', 'nha', 'nhe', 'ha', 'luon', 'di', 'thu', 'dung', 'nguyen', 'nhieu', 'hat', 'x', 'vi', 'granola', 'sdt', 'dt', 'nhe', 'ak', 'ah', 'oi']);

function basketFrom(raw, commentBasket) {
  const items = commentBasket(prep(raw));
  if (!items.length) return [];
  const words = core(prep(raw)).replace(/\+?\d{9,11}/g, ' ').split(/\s+/).filter(Boolean);
  const leftover = words.filter(word => !BASKET_WORDS.has(word) && !/^\d{1,2}$/.test(word) && !/^x\d{1,2}$/.test(word));
  return leftover.length ? [] : items;
}

/**
 * @param text  tin (đã gộp cụm) của khách
 * @param ctx   { source, botLastTemplateId, staffRepliedAfterBot, botLastAgeMin, hasBasket, lastWasOrderStep,
 *               orderAgeMin, livestream, contextProduct, bundleSize, commentBasket }
 * @returns null | { rule, value } | { rule, commentRule:true } | { rule, value, attention:true }
 */
export function ruleIntent(text, ctx = {}) {
  const raw = String(text || '').trim();
  if (!raw) return null;
  const s = core(raw);
  const last = String(ctx.botLastTemplateId || '');
  const fresh = (SAFE_LAST.has(last) && !ctx.staffRepliedAfterBot) || Number(ctx.botLastAgeMin) > 1440;
  const orderAgeMin = Number.isFinite(ctx.orderAgeMin) ? ctx.orderAgeMin : Infinity;
  const phone = extractVietnamesePhone(raw);
  const isComment = ctx.source === 'comment';
  const complaint = COMPLAINT.test(s);
  // Hỏi giá chung: bình luận → bảng giá của bài (luật bình luận); inbox → bảng giá sản phẩm ngữ cảnh / chung.
  const priceGeneral = rule => (isComment ? { rule, commentRule: true }
    : { rule, value: ctx.contextProduct ? { template_id: 'PRICE_QUOTE', Product_N1: ctx.contextProduct } : { template_id: 'GENERAL_INFO' } });
  const basket = !complaint && orderAgeMin >= 60 && !PRICE.test(s) && !raw.includes('?') && !basketAmbiguous(raw) && typeof ctx.commentBasket === 'function'
    ? basketFrom(raw, ctx.commentBasket) : [];

  if (ctx.livestream && !ctx.hasRecentOrder && !basket.length && !complaint && LIVE_DEAL.test(s) && !/\b(chua (nhan|thay|giao)|huy|khieu nai)\b/.test(s)) {
    return { rule: 'LIVE_DEAL', value: { template_id: 'LIVE_DEAL_CLAIMED' }, attention: true };
  }
  for (const [pattern, target] of ICEBREAKERS) {
    if (!pattern.test(s)) continue;
    if (target === 'price') return priceGeneral('ICEBREAKER');
    return { rule: 'ICEBREAKER', value: { template_id: target, ...(target === 'PRODUCT_PHOTOS' && ctx.contextProduct ? { Product_N1: ctx.contextProduct } : {}) } };
  }
  if (fresh && /^[\s.…,?!]+$/.test(raw)) return priceGeneral('DOTS');
  if (fresh && !phone && (TERSE_A.test(s) || TERSE_B.test(s) || TERSE_C.test(s))) return priceGeneral('TERSE_PRICE');
  if (!isComment && fresh && GREETING.test(s)) return { rule: 'GREETING', value: { template_id: 'WELCOME' } };
  if (fresh && WANT_BUY.test(s)) return priceGeneral('WANT_BUY');
  // SĐT trơn khi đang chờ đơn: bộ soạn đơn tự đọc SĐT, gộp giỏ, đủ thì tự xác nhận.
  if (ctx.hasBasket && ctx.lastWasOrderStep && phone && PHONE_ONLY.test(foldVietnamese(raw).toLowerCase())) {
    return { rule: 'PHONE_ONLY', value: { template_id: 'ORDER_ADDRESS' } };
  }
  if (basket.length) {
    const slots = ['Product_N1', 'No_A', 'Product_N2', 'No_B', 'Product_N3', 'No_C'];
    const value = { template_id: 'ORDER_ADDRESS' };
    basket.slice(0, 3).forEach((item, index) => { value[slots[index * 2]] = item.product; value[slots[index * 2 + 1]] = String(item.quantity); });
    return { rule: 'BASKET', value };
  }
  // Chỉ nêu một túi, không số, không động từ đặt ("Túi xanh", "túi vàng giá sao"): báo giá túi đó.
  const colours = [...new Set(s.match(/\b(xanh|vang|nau|cacao)\b/g) || [])].map(colour => (colour === 'cacao' ? 'nau' : colour));
  if (fresh && orderAgeMin >= 60 && !ORDER_VERB.test(s) && !phone && !/\d/.test(s) && new Set(colours).size === 1 && !LIVE_ONLY.test(s)
    && !s.replace(/\b(xanh|vang|nau|cacao|la|cay|tui|goi|bich|granola|vi|gia|bao nhieu|bn|sao|the nao|ntn|nhieu|tien|cho|xin|hoi|loai)\b/g, '').trim()) {
    const product = colourSku(colours[0]);
    if (product) return { rule: 'PRICE_ONE', value: { template_id: 'PRICE_QUOTE', Product_N1: product.name } };
  }
  if (/^(cam on|camon|thanks|thank you|tks|thank|cam on nhieu|da cam on)$/.test(s)) return { rule: 'THANKS', value: { template_id: 'THANK_YOU' } };
  // Câu hỏi thông tin: tin ngắn, một tin, không đặt hàng/SĐT/hàng live/khiếu nại, không ngay sau khi chốt.
  const info = s.length <= 70 && (ctx.bundleSize || 1) === 1 && !ORDER_VERB.test(s) && !phone && !LIVE_ONLY.test(s) && orderAgeMin >= 60 && !complaint && !ctx.complaint;
  if (!info) return null;
  for (const [rule, pattern, template, exclude] of INFO_RULES) {
    if (!pattern.test(s) || (exclude && exclude(s, ctx))) continue;
    let target = template;
    if (rule === 'COMPARE' && (/nhieu hat/.test(s) || (/\bxanh\b/.test(s) && /\bvang\b/.test(s) && !/\b(nau|cacao)\b/.test(s)))) target = 'BAG_COMPARISON_XANH_VANG';
    const value = { template_id: target, ...(target === 'PRODUCT_PHOTOS' && ctx.contextProduct ? { Product_N1: ctx.contextProduct } : {}) };
    // Đang ở bước lên đơn: giữ bước đơn, trả lời câu hỏi bằng ý phụ.
    if (ctx.hasBasket && ctx.lastWasOrderStep) return { rule, value: { template_id: 'ORDER_ADDRESS', also: target } };
    return { rule, value };
  }
  return null;
}

export { ORDER_STEPS as ruleOrderSteps };
