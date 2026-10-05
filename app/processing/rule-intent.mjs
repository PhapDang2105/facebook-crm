// Luật nhận ý khách bằng code, chạy TRƯỚC mô hình: tin nào code nhận chắc chắn
// thì trả thẳng mẫu, không gọi Gemini (không tốn token, không chờ, không 429).
// Bộ luật đo trên 856 lượt tin thật 22–25/09 và kiểm lại trên 788 lượt tuần
// 16–22/09 (không dùng khi viết luật): bắt ~33–44% lượt, rà tay từng tin bắt
// được, ≥ 97% đúng. Tin dài, nhiều ý, phụ thuộc ngữ cảnh vẫn để mô hình.
import { AD_MISMATCH_COMPLAINT, foldVietnamese, OTHER_SELLER, shortBadTaste } from './auto-label.mjs';
import { extractVietnamesePhone } from './customer-info.mjs';
import { getCatalogProducts, isFreeShippingGift, matchStaffOnlyProduct } from './catalog.mjs';
import { describeDeliveryAddress } from './locations.mjs';
import { priceBasket } from './pricing.mjs';

/** Chuỗi chuẩn để so luật: bỏ dấu, bỏ dấu câu, bỏ lời gọi đầu câu và từ đệm cuối câu. */
import { looksLikeAddressMessage, maskMarketWord, maskPlaceGia, normalizeColourTypos, orderFlowStep, stripPhone } from './order-flow.mjs';

// ===== Vòng 12 (rà 28/09–01/10, findings r12) — mẫu dùng chung với engine =====
// Granola Tropical vị Cacao 300g (GRA-MINT-Z300): khách gọi "xanh mint/min/bạc hà/biển/ngọc/da trời/dương", "túi dâu",
// "dâu tây", "xoài dâu", "nhiệt đới". Cùng danh sách alias của products.seed.json (BOT-C). "xanh nhạt" mơ hồ (có thể
// là Túi Xanh lá) → hỏi lại kèm ảnh (TROPICAL_UNSURE), không tự lên giỏ.
// R14 (ca thật 02–03/10): "Màu trắng dâu nhieu" (bình luận live), "Túi xanh Premium ạ", "granola premium 300g" cũng là
// Tropical. "trắng dâu" bỏ dấu trùng "trang đầu" → chỉ nhận khi có "màu/túi/bịch/gói/loại" đứng trước hay hỏi giá ngay sau.
export const TROPICAL_MENTION = /\b(?:tropical|nhiet doi|xanh (?:mint|min|bac ha|bien|ngoc|da troi|duong|premium)|(?:tui|goi|loai|granola|vi) (?:co )?dau(?: tay)?|dau tay|xoai dau|premium (?:cacao|300(?:g|gr|gram)?|tropical)|cacao 300(?:g|gr|gram)?|(?:mau|tui|bich|goi|loai) trang dau|trang dau (?:nhieu|nhiu|bn|bao nhieu|gia))\b/;
const TROPICAL_MENTION_ALL = new RegExp(TROPICAL_MENTION.source, 'g');
export const TROPICAL_UNSURE = /\bxanh nhat\b/;
// Hủy đơn / khoan giao (B5 #5, B2 #18): "cho c xin huỷ đơn shop nhé", "c xin huỷ e ui", "Đơn này khoan giao nha shop".
export const CANCEL_ORDER = /\b(?:xin |cho (?:minh|em|e|chi|c) )?(?:huy|hy) (?:don|giup|gium|dum|di|nhe|nha|e|em|ui)\b|(?:^|\s)(?:xin )?huy$/;
export const HOLD_DELIVERY = /\b(?:khoan|dung|tam dung|ngung|hoan) giao\b|\bgiu don\b|\bchua (?:can )?giao voi\b/;
// Ghi chú giao hàng cho đơn vừa đặt (B5 #7): "Giao trong giờ hành chính em nhé", "tránh chủ nhật", "gọi trước khi giao".
export const DELIVERY_NOTE = /\bgiao (?:trong )?gio hanh chinh\b|\btranh (?:ngay )?(?:cn|chu nhat|t7|thu 7)\b|\bgoi (?:dien )?truoc khi giao\b|\b(?:ngoai )?gio hanh chinh\b/;
// Lo ngại nguồn gốc / hàng giả / hạn gần (B2 #16): chuyển người, tắt bám đuổi.
export const TRUST_CONCERN = /\b(?:hsd gan|han (?:su dung |dung |sd )?(?:gan|sap het)|gan date|can date|sat date|nguon goc|xuat xu|china|trung quoc|hang gia|hang nhai|hang fake|fake|(?:2|hai) shop|(?:2|hai) giot nang|(?:2|hai) trang giot nang|shop gia)\b/;
// Câu hỏi về quà (B1 #8): "Bộ bát gì", "bô bát ntn vay", "Tặng quạt jì", "quạt xem hình".
// R13 (inbox1 C5): chiều ngược "xem mẫu quạt", "cho xem hình bộ bát", "gửi ảnh muỗng" (từng ra PRODUCT_PHOTOS — ảnh túi).
// "quà" trơn bỏ dấu trùng "qua" ("gửi hình qua zalo") → chỉ nhận trên chữ CÒN DẤU (GIFT_PHOTO_RAW bên dưới).
export const GIFT_QUESTION = /\b(?:bo bat|bat(?! dau)|quat|muong|qua tang)\b.{0,15}\b(?:ntn|the nao|nhu nao|gi|j|ji|xem|hinh|anh|ra sao|sao)\b|\btang (?:gi|j|ji)\b|\b(?:xem|coi|gui|chup|xin)\b.{0,14}\b(?:mau|hinh|anh|kieu)\b.{0,10}\b(?:bo bat|bat(?! dau)|quat|muong|qua tang)\b|\b(?:xem|coi|cho xem|cho coi) (?:(?:hinh|anh|mau|cai|bo) ){0,2}(?:quat|bo bat|bat(?! dau)|muong|qua tang)\b/;
const GIFT_PHOTO_RAW = /(?<![\p{L}])(?:xem|coi|gửi|gởi|gui|chụp|xin)(?![\p{L}])[^.?!\n]{0,14}(?<![\p{L}])(?:mẫu|hình|ảnh|kiểu)(?![\p{L}])[^.?!\n]{0,10}(?<![\p{L}])quà(?![\p{L}])|(?<![\p{L}])quà(?![\p{L}])[^.?!\n]{0,15}(?<![\p{L}])(?:ntn|thế nào|như nào|ra sao|hình|ảnh)(?![\p{L}])/iu;
// Đổi quà (B5 #8, chủ shop 01/10: quà thay = 2 gói nhỏ bất kỳ, không trừ tiền).
// ("không lấy quả" = bỏ trái cây sấy → NO_VARIANT: bỏ dấu "quả" trùng "quà", nên vế đầu không có "qua".)
// R13 (inbox1 B1): "Mình mua 2b mà không lấy quà có được không" — "quà" CÒN DẤU là quà tặng (GIFT_SWAP), không phải "quả".
const GIFT_DECLINE_RAW = /(?<![\p{L}])(?:không|ko|k|kg|kgg|hông|hong|khỏi|khoi)\s+(?:lấy|cần|nhận|muốn)\s+quà(?![\p{L}])/iu;
// R14 (ca thật 02/10): "C ko lấy set muỗng dừa nha e", "Sao k tặng đồ khác" từng rơi về GIFT_POLICY cụt.
export const GIFT_SWAP_ASK = /\b(?:khong|ko|k|kg|kgg|hong) (?:lay|can|thich|muon) (?:bo |cai |set )?(?:quat|bat|muong|qua tang)\b|\b(?:doi|thay) (?:qua|quat|bat|muong)(?! (?:tui|goi|hop|bich|xanh|vang|nau|loai|vi|cacao|\d))\b|\btang (?:cai|mon|thu|do) khac\b|\bqua thay\b|\b(?:quat|bat|muong|qua)\b.{0,20}\btru tien\b/;
// Lời khen/chê/góp ý dưới bình luận (B4 #1, #2, #9).
const COMMENT_DISLIKE_CORE = /\b(?:khong|ko|k|kg|hok|hong|hem|hk|cha|chang|chua) (?:co |thay |an |duoc |dc )?(?:ngon|gion|thom)\b|\bnuot (?:khong|ko|k|hong|cha) (?:noi|troi)\b|\b(?:khong|ko|k|kg|hong|hok|cha|chang) nuot (?:noi|troi|duoc|dc)\b|\bkho an\b|\bngot (?:qua|lam|gat|khe)\b|\bnut\b|\b(?:te|do|chan) (?:qua|that|ghe|ec|lam)\b|\bkem (?:chat luong|qua)\b/;
// R14 (quyết định 4): thêm lời chê quảng cáo ("Không như quảng cáo", "không đúng với quoảng cáo", "mở ra toàn yến mạch",
// "khác hình" — AD_MISMATCH_COMPLAINT dùng chung với isComplaint); bỏ câu chê hàng CHỖ KHÁC ("mua ở chỗ khác ko ngon").
// ("Dở"/"Dỡ" đứng riêng chỉ nhận được trên chữ còn dấu → isComplaint / shortBadTaste, engine đã gọi cho bình luận.)
export const COMMENT_DISLIKE = new RegExp(`^(?!.*(?:${OTHER_SELLER.source})).*?(?:${COMMENT_DISLIKE_CORE.source}|${AD_MISMATCH_COMPLAINT.source})`);
// R15 (comments A3, ca …076080 "Bán mà nói nhỏ xíu sao nghe"): thêm "nói nhỏ/bé xíu/quá/vậy/thế", "nhỏ xíu … nghe",
// "sao/không nghe được/rõ/gì".
export const LIVE_FEEDBACK = /\b(?:noi (?:nho|be) (?:xiu|qua|vay|the|lam)|nho xiu .{0,20}\bnghe|(?:sao|khong|ko|k) nghe (?:duoc|dc|ro|gi)|noi (?:cha|khong|ko|k) nghe|(?:cha|khong|ko|k) nghe (?:gi|ro|duoc|dc|thay)|nghe (?:khong|ko|k|cha) (?:ro|duoc|dc|thay)|tieng (?:nho|be|re|vang|on)|(?:nho|be) tieng|noi nhanh|doc rap|nhu (?:doc )?rap|lag|giat|mat tieng|re re)\b|\b(?:cha|khong|ko|k|kg|hong) thay (?:gi|gj|j|ji|hinh|tieng)(?: (?:het|ca|luon|het a|het tron))?$/;

/** Giỏ chỉ một vị túi lớn N túi ("3 túi", "4 túi có ưu đãi không"): giá + quà tính bằng bảng giá (BOT-C). */
function bagCountQuote(count, colour = 'xanh', livestream = false) {
  const product = getCatalogProducts().find(item => item.active !== false && /^gra-/i.test(item.sku || '') && String(item.sku || '').toLowerCase().includes(`-${colour}-`));
  if (!product) return null;
  const priced = priceBasket([{ sku: product.sku, quantity: count }], { livestream });
  return priced?.priceable ? { product, priced } : null;
}
const money = value => `${Math.max(0, Math.round(Number(value) || 0)).toLocaleString('vi-VN')}đ`;

export function core(text) {
  let s = foldVietnamese(text).toLowerCase().replace(/[^a-z0-9+/% ]+/g, ' ').replace(/\s+/g, ' ').trim();
  s = s.replace(/^(?:(?:shop|sop|em|e|chi|c|ban|b|ad|anh|a) (?:oi|oei|ui) )+/, '');
  const tail = / (?:a|ah|ak|ha|nha|nhe|nhi|shop|sop|shoo|em|e|ban|b|chi|c|oi|ui|vay|v|z|voi|di|luon|hi|ad|admin|ne|s)$/;
  let previous;
  do { previous = s; s = s.replace(tail, ''); } while (s !== previous);
  return s.trim();
}

// "nâu vị ca cao", "ca cao" → một chữ, để đếm màu không bị lệch. "socola"/"chocolate"/"sô cô la"
// là Túi Nâu cacao (khách hay gọi vậy) → đổi thành "nâu" ở mọi chỗ đếm màu.
// Vòng 10 (đo độ phủ nhóm MUA): "1túi"/"2bịch" → "1 túi"; số viết chữ trước túi/màu ("hai nâu", "ba túi ba vị",
// "một túi") → chữ số; "450g"/"túi 450" là Túi Xanh (túi duy nhất 450g), còn "350g" (Vàng hay Nâu) để nguyên;
// trọng lượng ghi kèm màu ("xanh 450g", "vàng 350g") bỏ đi để không đếm thành túi thứ hai.
const NUMBER_WORDS = { mot: '1', hai: '2', ba: '3' };
/**
 * R13 (inbox1 A4): chuẩn hoá lỗi gõ màu/vị trước khi đếm giỏ — dùng chung cho luật (prep) và bộ soạn đơn
 * (chatbot-templates colourCountsInText). Giữ nguyên chữ khác; trả chuỗi CÒN DẤU.
 *  - vag / vàg / vangf / vàngg / vnag → "vàng"; "vành" chỉ khi đứng sau số hay túi/gói/bịch/màu/vị ("1 túi vành";
 *    "đường Vành Đai" giữ nguyên);
 *  - xah / xanhh / xamh / xnah → "xanh" (kể cả dính số: "xamh450g" → "xanh 450g");
 *  - "2ca cao" / "cá cao" / "cà cao" / "ca kao" / "cacoa" → "cacao" ("2ca cao" → "2 cacao").
 * Thân hàm nằm ở order-flow.mjs (luồng đơn tất định cũng dùng, tránh import vòng); xuất lại ở đây theo giao diện đã thống nhất.
 */
export { normalizeColourTypos };
/**
 * R13 (inbox1 A4): tin CHỈ nêu số lượng, không nêu vị/sản phẩm ("Số lượng là 2", "lấy 2 nha", "Chị lấy 2 mà", "sl 3",
 * "cho mình 2 túi nhé") → số N (1–20); không phải thì 0. Bộ soạn đơn dùng để đổi số lượng khi giỏ đang giữ đúng một mã.
 * Không nhận câu hỏi ("lấy 2 được không", "2 túi bao nhiêu"), tin có màu/tên hàng, SĐT, địa chỉ hay giá tiền.
 */
export function quantityOnlyRequest(text) {
  const raw = String(text || '').trim();
  if (!raw || raw.length > 60 || raw.includes('?') || extractVietnamesePhone(raw)) return 0;
  // Có chữ "vàng" còn dấu / tên vị, sản phẩm → không phải tin chỉ nêu số lượng.
  if (/vàng/iu.test(raw.normalize('NFC')) || /\b(xanh|nau|cacao|mint|tropical|combo|hop|yen mach|cam|mix)\b/.test(core(raw))) return 0;
  const s = core(raw).replace(/\b(mot|hai|ba|bon|nam)\b(?= ?(?:tui|goi|bich|bit|cai)\b|$| (?:ma|thoi|luon|nha|nhe)\b)/g, word => ({ mot: '1', hai: '2', ba: '3', bon: '4', nam: '5' })[word]);
  const match = s.match(QUANTITY_ONLY_A) || s.match(QUANTITY_ONLY_B);
  const count = match ? Number(match[1] || match[2]) : 0;
  return count >= 1 && count <= 20 ? count : 0;
}
const QUANTITY_UNIT = '(?: ?(?:tui|goi|bich|bit|bi|cai))?';
// Không có "nữa" ("cho a 3 túi nữa" là THÊM) hay "rồi" ("mình đặt 3 túi rồi" là kể lại) — để mô hình.
// (Có "trước/đã/ăn thử/dùng thử": "mình lấy tạm 1 túi thôi", "lấy 1 túi ăn thử đã" — luật K3 của báo cáo mô hình.)
const QUANTITY_TAIL = '(?: (?:ma|co|thoi|luon|di|nhe|nha|nhen|nghe|chu|do|day|truoc|da|an thu|dung thu))*';
// "số lượng (là) 2", "sl 2", "sl: 2 túi"
const QUANTITY_ONLY_A = new RegExp(`^(?:(?:ok|oke|da|vang|u|uh) )?(?:so luong|sl)(?: (?:la|lay|minh lay|em lay|chi lay))? (\\d{1,2})${QUANTITY_UNIT}${QUANTITY_TAIL}$`);
// "lấy 2 nha", "Chị lấy 2 mà", "mình đặt 2", "cho mình 2 túi", "2 túi thôi" — phải có động từ đặt hoặc chữ túi/gói
// (số trơn "2" có thể là chọn phương án địa chỉ, không nhận).
// (Không có "vâng" ở đầu: bỏ dấu trùng "vàng" — "Vàng 2 túi" là nêu vị.)
const QUANTITY_LEAD = '(?:(?:ok|oke|da|u|uh|thoi|vay|the) )?(?:(?:cho|lay cho|gui cho|ship cho) )?(?:(?:minh|em|e|chi|c|toi|m|mk|a|anh|co|bac|chau|tui|t) )?';
const QUANTITY_ONLY_B = new RegExp(`^${QUANTITY_LEAD}(?:(?:lay|dat|mua|chot|can|gui|muon lay|lay luon|doi thanh|doi sang|doi lai|lay la|dat la) )(?:tam )?(\\d{1,2})${QUANTITY_UNIT}${QUANTITY_TAIL}$|^${QUANTITY_LEAD}(\\d{1,2}) ?(?:tui|goi|bich|bit|bi|cai)${QUANTITY_TAIL}$`);
const prep = raw => normalizeColourTypos(raw)
  // R15 (inbox2 A10, ca …958786 "1 xanh+1 nâu", …018879 "1xanh,1vàng"): tách "+", dấu phẩy và chữ số dính màu trước khi đọc giỏ.
  .replace(/\s*\+\s*/g, ' + ').replace(/,(?=\S)/g, ', ')
  .replace(/(\d)(?=(?:xanh|v[àa]ng|n[âa]u|cacao|mint|tropical)(?![\p{L}]))/giu, '$1 ')
  // R16 (inbox4 T1 "Lay 2 tui mà 2vị dc k ah", inbox1 A5 "2loai"): số dính "vị/loại/màu" tách ra; "tuis/tuj/tuii" (gõ sai, inbox2 M1
  // "3 tuis") là "túi".
  .replace(/(\d)(?=(?:v[ịi]|lo[ạa]i|m[àa]u)(?![\p{L}]))/giu, '$1 ')
  .replace(/(?<![\p{L}])(?:tuis|tuj|tuii|túii)(?![\p{L}])/giu, 'túi')
  .replace(/n[âa]u\s+(v[ịi]\s+)?ca\s*cao/giu, 'nâu').replace(/ca\s+cao/giu, 'cacao')
  .replace(/s[ôo]\s*-?\s*c[ôo]\s*-?\s*la|socola|chocolate|choco\b/giu, 'nâu')
  .replace(/(\d)(t[úu]i|g[óo]i|b[ịi]ch|b[ịi]t)\b/giu, '$1 $2')
  // \b không biết chữ có dấu ("vị", "hộp") → biên Unicode ở cuối.
  .replace(/\b(m[ộo]t|hai|ba)\s+(?=(?:t[úu]i|g[óo]i|b[ịi]ch|b[ịi]t|xanh|v[àa]ng|n[âa]u|cacao|combo|h[ộo]p|v[ịi]|lo[ạa]i)(?![\p{L}\p{N}]))/giu, (match, word) => `${NUMBER_WORDS[foldVietnamese(word).toLowerCase()] || word} `)
  .replace(/\b(xanh)\s+450\s*(?:g|gr|gam|gram)?\b/giu, '$1').replace(/\b(v[àa]ng|n[âa]u|cacao)\s+350\s*(?:g|gr|gam|gram)?\b/giu, '$1')
  .replace(/\b(t[úu]i|b[ịi]ch|g[óo]i)\s+450\s*(?:g|gr|gam|gram)?\b/giu, '$1 xanh').replace(/\b450\s*(?:g|gr|gam|gram)\b/giu, 'xanh').replace(/\b450\s+(?=granola|gran\b)/giu, 'xanh ');
// "xanh mint"/"xanh bạc hà" là túi Tropical (hàng live), không phải Túi Xanh: bỏ trước khi đếm màu
// (như đã bỏ "xanh dương"). Chỉ dùng cho phần đếm giỏ; chuỗi so luật vẫn giữ để bắt LIVE_ONLY.
// Vòng 12: mọi tên gọi Tropical (xanh mint/min/bạc hà/biển/ngọc/da trời/dương) → token "mint" (GRA-MINT-Z300, bộ đếm
// giỏ của engine hiểu), không còn bị đếm thành Túi Xanh.
const dropLiveColours = text => String(text || '').replace(/xanh\s+(mint|min|b[ạa]c\s+h[àa]|bi[ểe]n|ng[ọo]c|da\s+tr[ờo]i|d[ưu][ơo]ng)(?![\p{L}])/giu, ' mint ');
// "nhiêu" cuối câu là hỏi giá ("1 túi nhiêu"), trừ "hạt nhiều" ("lấy vàng, loại hạt nhiều").
// Vòng 12 (B3 #11): "Bịch nhieu Zay chi" / "túi nhiêu" cũng là hỏi giá.
const PRICE = /\b(gia|bn|bao nhieu|bnhiu|bao tien|nhieu tien|tong)\b|(?<!hat )nhieu$|\bnhieu (?:zay|vay|v|z)$|\b(?:bich|tui|goi) nhieu$/;
const ORDER_VERB = /\b(lay|dat|mua|chot|gui|ship cho|cho (minh|em|e|chi|c|toi|tui|anh|a|mk|m|u) \d|giao)\b/;
// Hàng chỉ bán trên live (sữa hạt, hũ hạt, túi Xanh dương, túi Xanh mint/Tropical, túi dâu…).
// Vòng 12: túi Tropical (xanh mint/biển/dương, túi dâu) là sản phẩm danh mục (GRA-MINT-Z300) → luật TROPICAL, không
// còn LIVE_ONLY.
export const LIVE_ONLY = /(sua hat|hat dieu|hat bi|xoai|dau say|hu hat)/;
// Từ live "xoài"/"hạt điều"/"đậu sấy" cũng là thành phần granola: câu hỏi có/không về thành phần để mô hình.
const LIVE_INGREDIENT = /\b(xoai|hat dieu|dau say)\b/;
const COMPLAINT = /\b(bi hoi|hoi dau|co mui|mui la|moc|qua cung|bi cung|di vat|bi hu|bi loi|hang loi|that vong|te qua|khong ngon|chua nhan|giao cham|nhan (dc|duoc) hang roi)\b/;
// Khiếu nại rõ ràng cần người thật (khác COMPLAINT ở trên chỉ dùng để chặn luật giỏ/thông tin).
// Vòng 9 (26–28/09) thêm: "mua bên khác", "k chốt đơn/giao", "người thật", "gặp người", "nói chuyện với
// người", "mở ra chủ yếu/toàn/ít…", "buôn bán kiểu gì".
// Vòng 12 (B3 #8): "cứng như đá k ăn đc", "trả lời tự động ngơ ngơ".
// R15 (inbox3 A1): "bot ngu" bỏ dấu trùng "Bột ngũ cốc" (sản phẩm bot đang giới thiệu) → không nhận khi ngay sau là "coc".
const STRONG_COMPLAINT = /\b(goi .{0,14}(khong|ko|k|hong) (duoc|dc)|goi .{0,12}suot|(khong|ko|k|co) (thay )?ai goi|luyen thuyen|(qua cung|bi cung|cung qua).{0,30}\bso\b|an phai .{0,12}\bso\b|rat so (qua|luon|that|roi)|that vong|te qua|lua dao|thai do|vo ly|khieu nai|bao cao shop|lam an .{0,10}(vay|the)|mua ben khac|(k|ko|khong) chot (don|giao)|(nguoi|nhan vien) that|gap nguoi|noi chuyen voi nguoi|mo ra (chu yeu|toan|it)|buon ban kieu gi|cung nhu da|tra loi tu dong|ngo ngo|nhu robot|bot ngu(?! coc))\b/;
// R16 (inbox1 B1, ca …7830380226 "quảng cáo nhiều hạt mà nhận toàn hạt gạo, yến mạch", "thực tế nhận thì khác hoàn toàn"; …6281113917
// "Nhg hơi ít hath"): chê hàng KHÁC quảng cáo / ít hạt / toàn hạt gạo-yến mạch-bột → khiếu nại (CSKH_HANDOFF + thẻ, như luật khiếu nại
// rõ). "ít hạt" chỉ tính khi có chữ chê mức độ ("hơi/quá/nhưng … ít hạt", "ít hạt quá") — "lấy loại ít hạt" là chọn vị.
const AD_VS_REALITY = /\b(?:quang cao|qc|hinh(?: anh)?(?: quang cao)?|video)\b.{0,40}\b(?:ma|nhung|nhg|ma sao)\b.{0,25}\b(?:nhan|thuc te|ve toi|ve nha|ve thi|mo ra|giao (?:toi|den|ve))\b|\bkhac hoan toan\b|\b(?:nhan|mo ra|ben trong|thay|ma|nhung|nhg)\b.{0,20}\btoan (?:la )?(?:hat gao|gao|yen mach|bot|vun)\b|\b(?:nhung|nhg|hoi|qua|rat|kha) ?(?:it|hoi it|qua it) (?:hat|hath|hatj|hac)\b|\bit (?:hat|hath|hatj) (?:qua|the|vay|lam|ghe|xiu)\b/;
// "phản ánh" chỉ so trên chữ CÒN DẤU: bỏ dấu thì trùng "phần anh" ("phần anh 2 túi vàng, phần chị 1 túi xanh").
const COMPLAINT_REPORT = /phản ánh/iu;
// Câu nêu giỏ (số + túi/gói, hay màu túi) mà không có từ khiếu nại rõ: là đặt hàng, không chuyển người.
const BASKET_MENTION = /\b(\d{1,2} ?(tui|goi|bich)|xanh|vang|nau|cacao|combo)\b/;
const COMPLAINT_WORDS = /\b(khieu nai|that vong|te qua|lua dao|thai do|vo ly|luyen thuyen|bao cao shop|goi .{0,14}(khong|ko|k|hong) (duoc|dc)|(khong|ko|k) (thay )?ai goi|mua ben khac|(k|ko|khong) chot (don|giao)|(nguoi|nhan vien) that|gap nguoi|noi chuyen voi nguoi|mo ra (chu yeu|toan|it)|buon ban kieu gi|cung nhu da|tra loi tu dong|ngo ngo|nhu robot|bot ngu(?! coc))\b/;
// Khách hẹn dịp khác / xin hủy ý định đặt ("bữa khác chốt", "thôi để sau", "xin lỗi shop mình hủy"):
// đáp mềm, xóa giỏ chờ. Không dùng khi đã có đơn (hủy đơn thật đi luồng ORDER_CANCEL).
const POSTPONED = /\b(bua khac|hom khac|khi khac|de sau|lan sau|dot khac)\b.{0,25}\b(chot|dat|lay|mua)\b|\b(huy|hy|khong lay|thoi) .{0,20}\b(bua khac|sau|khi khac)\b|\bxin loi\b.{0,30}\b(huy|hy|khong lay)\b/;
// R13 (inbox2 A3): "Ok bạn. Lần sau nếu ăn ngon mình sẽ mua ăn thường xuyên", "cảm ơn shop lần sau mua tiếp", "ăn thử xem
// loại nào ngon lần sau mình mua" — khách ĐANG mua và hứa mua tiếp, không phải hoãn đơn.
const NOT_POSTPONED = /\b(?:neu|ma|thay|an|xem)\b.{0,25}\bngon\b|\bngon\b.{0,25}\b(?:lan sau|dot sau|se mua|mua tiep|mua them|ung ho)\b|\bmua (?:tiep|them|nua|lai|dai|thuong xuyen|an thuong xuyen|lau dai)\b|\bthuong xuyen\b|\bung ho\b|\b(?:an|dung) thu\b/;
// Hoãn đơn có lời HỦY rõ ("xin lỗi shop mình hủy", "thôi không lấy nữa để sau") → xóa giỏ; chỉ hẹn dịp khác ("bữa khác
// chốt", "để sau") → giữ giỏ (keepBasket) để khách gửi SĐT/địa chỉ là chốt được.
const POSTPONE_CANCELS = /\b(?:huy|hy|khong lay|ko lay|k lay|khong mua|ko mua|k mua|khong dat|ko dat|xoa)\b/;
// R13 (inbox1 D4): "Em khong nhớ là em đặt hàng gì… gửi lại cho em xin mẫu" → tra đơn (ORDER_STATUS).
const FORGOT_ORDER = /\b(?:khong|ko|k|kg|chua|quen|chang|cha) (?:con )?(?:nho|biet|ro)(?: (?:la|minh|em|e|chi|c|toi|da|hom truoc|hom qua))* (?:dat|mua|chot)(?: (?:hang|don))? (?:gi|j|ji|nhung gi|loai nao|loai gi|mon nao|mon gi|may tui|bao nhieu)\b|\bquen (?:mat )?(?:la )?(?:minh |em |chi )?(?:da )?(?:dat|mua) (?:hang |don )?(?:gi|j|loai nao)\b/;
// R13 (inbox2 B2): "nhầm", "bấm nhầm", "mình ấn nhầm thôi", "lỡ tay bấm" khi đang giữ giỏ (giỏ Facebook Shop bấm nhầm) →
// xóa giỏ + lời mềm. "nhận nhầm hàng" (khiếu nại) và "chọn nhầm vị" (đổi giỏ, có màu/túi) không thuộc luật này.
const MISCLICK = /^(?:(?:xin loi|sorry|a|oi|uh|u|da) )?(?:(?:minh|em|e|chi|c|toi|a|anh|m|mk|co|chau|tui|t) )?(?:(?:lo|lo tay|vua|bi) )?(?:(?:bam|an|click|cham|chon|dat) (?:nham|lon)|nham)(?: (?:thoi|roi|a|nha|nhe|xin loi|sorry|ban|shop|em|e|chut|ty|ti|nut|vao|ma|do|day|chu khong mua|chu ko mua|khong mua|ko mua|k mua))*$|\b(?:bam|click|cham) (?:nham|lon)\b|\ban nham\b|\blo tay (?:bam|an|click|cham)\b|\blo (?:bam|click|cham)\b/;
// Khách xin bỏ một thành phần ("không yến mạch", "bỏ hạt", "không lấy quả"): công thức cố định, không có
// loại riêng → NO_VARIANT (điền {ingredient} có dấu) + nhờ người thật.
// Vòng 12 (B5 #8, B3 #13): "đừng bỏ nho khô", "không thích nho khô".
const NO_VARIANT = /\b(?:dung|dug) (?:bo|cho) (?:nho kho|yen mach|hat|trai cay)\b|\bkhong thich\b.{0,20}\bnho kho\b|\bbo nho kho\b|\b(?:khong|ko|k) (?:co )?(yen mach|hanh nhan|dau phong|hat dieu|trai cay|qua say|nho kho)\b|\bbo (hat|trai cay|qua say|qua kho)\b|\bbo qua\b(?=.*\b(tui|goi|granola|hat|an)\b)|\b(tui|goi|granola|hat|an)\b.*\bbo qua\b|\bkhong lay (qua|hat)\b/;
// R13: "(không|ko|k) có <thành phần>" — nói về thành phần CÓ hay không (dạng hỏi → INGREDIENTS_ALLERGY); các vế còn lại
// của NO_VARIANT là lời xin bỏ rõ ràng.
const INGREDIENT_ABSENT = /\b(?:khong|ko|k) (?:co )?(?:yen mach|hanh nhan|dau phong|hat dieu|trai cay|qua say|nho kho)\b/;
const NO_VARIANT_REQUEST = /\b(?:dung|dug) (?:bo|cho) (?:nho kho|yen mach|hat|trai cay)\b|\bkhong thich\b.{0,20}\bnho kho\b|\bbo nho kho\b|\bbo (?:hat|trai cay|qua say|qua kho)\b|\bbo qua\b|\bkhong lay (?:qua|hat)\b|\b(?:khong|ko|k) (?:co )?(?:yen mach|hanh nhan|dau phong|hat dieu|trai cay|qua say|nho kho) (?:thi )?(?:co )?(?:duoc|dc)\b|\b(?:loai|tui|vi|bich|goi) (?:nao )?(?:ma )?(?:khong|ko|k) (?:co )?(?:yen mach|hanh nhan|dau phong|hat dieu|trai cay|qua say|nho kho)\b|\b(?:muon|can|lay|mua|dat) .{0,20}\b(?:khong|ko|k) (?:co )?(?:yen mach|hanh nhan|dau phong|hat dieu|trai cay|qua say|nho kho)\b/;
// R15 (inbox2 A8, ca …350724 "vậy chị cảm ơn có trái cây sấy không ăn đc"): khách KHÔNG ĂN ĐƯỢC / kiêng / dị ứng một thành phần
// (từng ra HEALTH_CONDITION — lời mẹ bầu). Phải nêu thành phần ("ăn không được" trơn là lời chê → không thuộc luật này).
// R15 sửa (phản biện luật #3): mẫu NO_VARIANT nói "cả 3 túi đều có {ingredient}" → chỉ thành phần THẬT SỰ có trong granola
// (bảng của mẫu INGREDIENTS_ALLERGY: yến mạch, hạnh nhân, hạt điều, hạt bí, nho khô, xoài/nam việt quất/dừa sấy) — không có
// "đậu phộng". Câu "dị ứng …" (kể cả thành phần có) giữ INGREDIENTS_ALLERGY như bản cũ (gửi bảng thành phần, mời nhắn tên hạt).
const NO_EAT_ING = '(yen mach|hanh nhan|hat dieu|trai cay|qua say|qua kho|nho kho|hat)';
const NO_EAT = new RegExp(`\\b${NO_EAT_ING}\\b(?: say| kho)?(?: (?:thi|minh|em|e|chi|c|toi|nha minh|con|be|lai))* (?:khong|ko|k|kg|hong) an (?:duoc|dc)\\b|\\b(?:khong|ko|k|kg|hong) an (?:duoc|dc) (?:(?:mon|loai|cac loai|do|cac) )?${NO_EAT_ING}\\b|\\bkieng (?:an )?${NO_EAT_ING}\\b`);
const NO_EAT_NOT = /\bdi ung\b/;
const INGREDIENT_NAMES = { 'yen mach': 'yến mạch', 'hanh nhan': 'hạnh nhân', 'dau phong': 'đậu phộng', 'hat dieu': 'hạt điều', 'trai cay': 'trái cây sấy', 'qua say': 'quả sấy', 'qua kho': 'quả khô', 'nho kho': 'nho khô', hat: 'hạt', qua: 'quả sấy' };
// Câu tóm tắt xin xác nhận khi đang giữ giỏ ("2 túi xanh 298k miễn ship đúng không"): CONFIRM_YES,
// engine tự kèm dòng giỏ. So trên chữ bỏ dấu nhưng CHƯA cắt từ đệm cuối (core() cắt mất "ha"/"nhi").
const CONFIRM_TAIL = /\b(dung (khong|ko|k|kg|chu|ha|nhi|hong)|phai (khong|ko|k))(?: (?:a|ah|ak|shop|em|e|chi|c|ban|nha|nhe|v|vay|z|ta|he))*$/;
const BASKET_CHANGE = /\b(doi|them|bot|huy|thay|khong lay|ko lay|k lay|nua)\b/;
// "mua ở đâu / mua thế nào / mua sản phẩm này kiểu gì": hướng dẫn đặt ngay tại đây (ORDER_HELP), chỉ
// khi khách không nhắc sàn/link (ECOMMERCE_LINKS).
const HOW_TO_BUY = /\bmua (?:(?:sp|san pham|hang) )?(?:nay )?(?:o dau|cho nao|ntn|the nao|kieu gi)\b/;
// "sàn" chỉ tính khi là sàn TMĐT ("trên sàn", "sàn nào"): "sản phẩm" bỏ dấu cũng có "san".
const MARKETPLACE = /(shopee|tiktok|lazada|\b(tren|qua|o) san\b|\bsan (nao|tmdt|thuong mai)\b|\blink\b)/;
// "4/5/6 túi giá bao nhiêu": ngoài bảng combo, nhân viên tính ưu đãi (ORDER_CUSTOM_BASKET + thẻ).
const BIG_BASKET = /\b(4|5|6|bon|nam|sau) (tui|bich|goi)\b/;
// Mẫu bán hàng: SĐT trơn ngay sau các mẫu này là khách bắt đầu đặt (không phải SĐT tra đơn / xin gọi lại).
const SALES_LAST = new Set(['ASK_FLAVOR', 'PRICE_QUOTE', 'GENERAL_INFO', 'DISCOUNT_POLICY', 'FREESHIP_POLICY', 'ORDER_HELP', 'REPLY_ALREADY_SENT', 'PRICE_MIX_TUI_LON', 'PRICE_QUOTE_COMBO', 'ORDER_INFO_ASK_FLAVOR', 'ASK_FLAVOR_NGUYENBAN', 'RECOMMEND_BEGINNER', 'BAG_COMPARISON', 'BAG_COMPARISON_XANH_VANG', 'LIVESTREAM_COMMENT', 'WELCOME', 'CONFIRM_YES', 'COMBO3_FLAVOR']);
// Từ hành chính trong địa chỉ (bỏ dấu). "quận" chỉ tính khi kèm số/tên ("quan tam" là quan tâm).
// R14 (ca …603949): "ap" (ấp) bỏ dấu trùng "ap" (app — "Đặt trên ap r"): không nhận sau "trên/qua/trong/vào/bằng/đặt/mua/tải".
const ADDRESS_WORDS = /\b(xa|phuong|huyen|thi tran|thi xa|thanh pho|tphcm|tp hcm|hcm|ha noi|da nang|(?<!\b(?:tren|qua|trong|vao|bang|dat|mua|tai|cai) )ap|thon|khu pho|kp|ngo|hem|ngach|so nha|chung cu|duong)\b|\b(quan|q|p) ?\d{1,2}\b|\bquan (?!tam\b)[a-z]+/;
const ADDRESS_LABELS = /(?:^|\s)(?:s[đd]t|đt|dt|số điện thoại|so dien thoai|số đt|so dt|địa chỉ|dia chi|đ\/c|d\/c|dc)\s*[:.]?(?=\s|$)/giu;
const PRODUCT_MENTION = /\b(xanh|vang|nau|cacao|combo|tui|goi|bich|hop|set|granola|nghe lanh|hat an lanh|yen mach)\b|\b\d{1,2} ?(tui|goi|bich)\b/;
const POLICY_QUESTION = /\b(co|duoc|dc)\b.{0,40}\b(khong|ko|k|kg|hong)\s*(a|ạ|shop|e|em|b|ban|nhi)?\s*\??$|\?$/;
// Mẫu an toàn: sau những mẫu này "." / "giá" / "hi" là câu hỏi mới, không phải câu trả lời cho bước đơn.
const SAFE_LAST = new Set(['', 'WELCOME', 'GENERAL_INFO', 'LIVESTREAM_COMMENT', 'REPLY_ALREADY_SENT', 'REPLY_ALREADY_SENT_INFO', 'THANK_YOU', 'COMMENT_PRIVATE_REPLY']);
const ORDER_STEPS = new Set(['ORDER_ADDRESS', 'ORDER_PHONE', 'ORDER_CONFIRMATION', 'ORDER_UPDATE', 'ORDER_ADDRESS_REMIND', 'ORDER_CUSTOM_BASKET', 'ASK_FLAVOR']);

// R15 (inbox3 A10, ca …179261): "Ibox" (gõ nhầm "inbox") như "ib".
const TERSE_A = /^(ib|inb|inbox|ibox|in box|in|tv|tu van|xin gia|xin gua|xg|gia|bao gia|bn|bnt|gia bn|gia bao nhieu|gia bao nhieu tien|gia sao|gia the nao|gia ntn|gia nhieu|gia nhieu tien|bao nhieu|bao nhieu tien|nhieu z|nhiu z|cho xin gia|cho gia|xin bao gia|bao gia luon|gia ca|bn vay|gia bao tien|bao tien|xin gia (sp|san pham|granola|gran|ngu coc)|cho xin thong tin ve gia|tu van (cho minh|giup|dum|di)|xin (shop )?tu van( dum| giup)?|ib minh|inbox minh|ibox minh|granola|grannola|gannola|nola)$/;
const TERSE_B = /^(?:(?:xin |cho (?:hoi |xin )?)?gia |ban )?(?:bao nhieu|bn|bnhiu|nhieu|nhiu|bao tien|gia bao nhieu|gia bn|gia sao|gia nhieu|gia may)(?: tien)?(?: (?:1|mot))? ?(?:tui|tuy|goi|bich|bit|bicp|bao)?(?: vay)?$/;
const TERSE_C = /^(?:1|mot) ?(?:tui|tuy|goi|bich|bit) (?:gia )?(?:bao nhieu|bn|nhieu|may|sao)(?: tien)?$/;
// Vòng 12 (B5 #4): hỏi giá có tiền tố ("Chị cho em xin giá", "Alo giá thế nào ạ", "Granola giá sao 1 túi") — 22 lượt LLM
// đều chọn báo giá. So TERSE trên chuỗi đã bỏ tiền tố; TERSE_D chỉ khi tin không có màu/combo/yến mạch/SĐT. Không có
// "hạt" (chủ shop 01/10: hạt/Siêu Hạt chỉ CSKH bán).
const PRICE_LEAD = /^(?:(?:alo|a lo|hi|hello|chao|giot nang(?: healthy)?)\s)?(?:(?:minh|em|e|chi|c|toi|m|mk|t|anh|a)\s)?(?:cho\s)?(?:(?:minh|em|e|chi|c|toi|m|mk|t|anh|a)\s)?/;
const TERSE_D = /^(?:(?:xin|sin|x|cho xin|inbox|ibox|ib) ?gia|gia (?:tn|the nao|ntn|sao|bao nhieu|bn)(?: k)?)(?: (?:granola|ngu coc|sp|san pham|cac mat hang|cac sp|cac san pham|cac loai))?(?: (?:cua shop|ben minh|nha minh))?$|^(?:granola|gannola|ngu coc|bich|bit|bi|tui|goi) (?:gia )?(?:bn|bnh|bao nhieu|bao nhiu|nhieu|nhiu|sao|the nao|ntn|tn)(?: (?:1|mot) ?(?:tui|goi|bich|bi|bit|kg))?(?: (?:zay|vay|v|z))?$|^(?:bnh|bao nhieu|bn|nhieu) (?:1|mot) ?(?:tui|goi|bich|bi|bit|kg)(?: (?:ngu coc|granola))?$/;
// R13 — luật ứng viên K1/K4 (báo cáo mô hình, a7-candidates.mjs): hỏi giá cụt / "mua hàng" không cần ngữ cảnh fresh.
const SHORT_PRICE_OTHER = /\b(xanh|vang|nau|cacao|combo|mix|yen mach|hat|goi nho|10 goi|hop|ship|sip|qua|tang|giam|uu dai|voucher|km|kg|gram|gam|gr|don|size|loai nao|mau nao|vi nao|them|nua|tong)\b/;
const SHORT_PRICE = /^(?:(?:alo|hi|hello|chao|shop|ad|da) )?(?:(?:cho|xin|gui|bao|tu van va|cho (?:minh|em|e|chi|c|a|anh) (?:xin|hoi)?|(?:minh|em|e|chi|c|a|anh|ban|b) (?:xin|hoi|cho|bao)|cho hoi|cho xin|la) ?)?(?:bang )?(?:bao )?(?:gia|bn|bnh|bao nhieu|bao nhiu|bnhiu|nhieu|nhiu)(?: (?:ca|ban|sp|san pham|tien|bao nhieu|bao nhiu|bn|nhieu|nhiu|sao|the nao|ntn|tn|may))*(?: (?:1|mot) ?(?:tui|goi|bich|bit|bi|b|kg))?(?: (?:granola|grannola|gannola|ngu coc|goi ngu coc|sp|san pham|do|nay|day))?(?: (?:giup|cho|voi|nhe|nao|di|a|dc khong|duoc khong)(?: (?:minh|em|e|chi|c|a|anh|toi))?)*(?: nao)?$|^(?:1 ?)?(?:granola|grannola|gannola|ngu coc|goi ngu coc|tui|goi|bich) (?:gia )?(?:bao nhieu|bao nhiu|bn|bnh|nhieu|nhiu|sao|the nao)(?: (?:1|mot) ?(?:tui|goi|bich))?$/;
const WANT_BUY_PLUS = /^(?:(?:hi|alo|hello|chao) )?(?:(?:minh|em|e|chi|c|toi|m|mk|to|tui) )?(?:(?:muon|can|dinh) )?(?:mua|mua hang|dat hang|dat mua|mua sp)(?: (?:ngu coc|granola))?$/;
const GREETING = /^(hi|hello|helo|alo|a lo|chao|xin chao|chao (shop|em|ban|chi|anh)|shop|shop oei|oi)$/;
const WANT_BUY = /^(?:(?:minh|em|e|chi|c|toi|m|mk|to|tui) (?:muon |can |dinh )?|(?:muon|can) )(?:mua|dat hang|mua hang|dat mua|order|mua sp|mua san pham|tham khao)$/;
// Vòng 12 (B4 #7): bỏ "mã gì" ("Hộp nhựa là mã gì" là hỏi sản phẩm); "đã săn/mua/chốt" vẫn đủ.
const LIVE_DEAL = /\b(da (san|mua|chot|dat)|san (duoc|deal|the nao|tn|sao|ntn)|len ma|cach (san|chot|tham gia|dat|mua))\b/;
// R14: phủ định ("ko săn deal", "chưa mua") và câu hỏi cách săn ("Săn ntn ạh", "săn sao", "cách săn") → không "đã săn".
const LIVE_DEAL_NOT = /\b(?:khong|ko|k|kg|chua|hong|hok|cha|chang) (?:co )?(?:san|mua|chot|dat)\b|\bsan (?:the nao|tn|sao|ntn|nhu nao|kieu gi|o dau|lam sao)\b|\bcach (?:san|chot|tham gia|dat|mua)\b|\blam sao (?:de )?(?:san|chot|dat|mua)\b/;
const PHONE_ONLY = /^(?:(?:sdt|dt|so dt|so dien thoai)\s*:?\s*)?\+?[0-9][0-9 .-]{8,13}$/;
// ===== Luật thử nghiệm (vòng 6, đếm trên 1.678 tin 22–25/09): chạy ẩn so với mô hình cho tới khi
// settings.experimentalRules = 'on'. Kết quả trả về mang `experimental: true`.
// "Lấy c 1 túi dùng thử", "Mình lấy một túi xanh dung thử đã", "C.mua 1 túi ăn thử được không shop".
// R14 (ca …727620): thêm đại từ ĐỨNG TRƯỚC động từ ("E gui c 1 tui dùng thử nhé" = em gửi chị 1 túi dùng thử).
// ("đung thử" bỏ dấu đã là "dung thu".)
const TRIAL_ASK = /^(?:(?:em|e|minh|m|mk|chi|c|toi|a|anh|to|shop|ban|b)\s(?=(?:cho|lay|mua|dat|gui|ship)\s))?(?:(?:cho|lay|mua|dat|gui|ship)\s)?(?:(?:em|e|minh|m|mk|chi|c|toi|a|anh|to)\s)?(?:(?:mua|lay)\s)?(?:(?:1|mot)\s)?(?:(?:tui|goi|bich)\s)?(?:(xanh|vang|nau|cacao)\s)?(?:(?:nguyen ban|la)\s)?(?:dung|an|mua|lay) thu(?:\s(?:truoc|da|xem|duoc khong|dc ko|dc k|nha|nhe|coi|xem sao))?$/;
function trialHead(raw) {
  const parts = String(raw || '').split(/[.!\n]+/).map(part => part.trim()).filter(Boolean);
  if (parts.length < 2) return '';
  const rest = parts.slice(1).join(' ');
  const sRest = core(prep(rest));
  if (rest.includes('?') || extractVietnamesePhone(rest) || PRICE.test(sRest)) return '';
  if (!OTHER_SELLER.test(sRest) && (ORDER_VERB.test(sRest) || BASKET_MENTION.test(sRest))) return '';
  return core(prep(parts[0]));
}
// "Mình chưa nhận được hàng ạ", "Bữa e đặt hàng sao chưa thấy đơn về" (không SĐT, không nêu sản phẩm).
const ORDER_ASK = /\b(da dat|dat roi|da mua|da chot|chua (thay|nhan)( duoc)? (hang|don)|don (toi|den) dau|gui hang chua|kiem tra don|tra don|sao chua thay|bao gio (nhan|toi|giao))\b|\b(?:dat|mua) (?:tren|qua|o|bang) (?:app|ap|web|website|trang web|tiktok|tik tok|shopee|lazada|san)\b|\b(?:giao|di|ship) (?:toi|den) dau (?:roi|r)\b/;
// R14 (ca …603949): "Đặt trên ap r nhưng làm sao để biết hàng giao tới đâu r / Đặt 3 bịch" — đơn ĐÃ đặt (app/web/sàn) đang hỏi
// giao tới đâu: tra đơn, kể cả khi tin nhắc số túi (không phải giỏ mới) và dài hơn 70 ký tự.
const ORDER_PLACED = /\b(?:dat|mua) (?:tren|qua|o|bang) (?:app|ap|web|website|trang web|tiktok|tik tok|shopee|lazada|san)\b(?:.{0,40}\b(?:giao|toi|den|nhan|kiem tra|tra|biet|sao|chua)\b)|\b(?:giao|di|ship) (?:toi|den) dau (?:roi|r)\b|\bda dat\b.{0,30}\b(?:chua (?:thay|nhan|giao)|bao gio|giao (?:toi|den) dau|kiem tra|tra)\b/;
// R15 (inbox3 A2): "Mình đặt của shop trên tiktok rồi", "mình mua trên shopee rồi nhé" — đã mua ở sàn/web/app ("sàn" chỉ tính
// khi đứng sau trên/qua/ở/bên: "sản phẩm" bỏ dấu cũng là "san").
const BOUGHT_ELSEWHERE = /\b(?:dat|mua|chot)\b.{0,25}\b(?:tiktok|tik tok|shopee|lazada|(?:tren|qua|o|ben|bang) san|web|website|app|ap)\b.{0,15}\b(?:roi|r)\b/;
const BOUGHT_ELSEWHERE_NOT = /\b(?:duoc|dc) (?:khong|ko|k|kg|hong)\b|\b(?:chua|sao|bao gio|khi nao|bao lau|may ngay|kiem tra|tra don|giao (?:toi|den) dau|huy|doi|loi|hong|thieu|sai|khieu nai)\b|\b(?:lan truoc|truoc day|hom truoc|bua truoc|lan nay|gio|bay gio|them|nua|tiep|lai)\b|\b(?:ma|nhung|moc|iu|hoi|be|vo|nham|re hon|o day|ben nay|co ban|muon dat)\b/;
// R15 sửa (phản biện luật #2): chỉ câu NGẮN báo đã mua — "rồi/r" đứng cuối, sau đó chỉ còn từ đệm ("ạ/nha/nhé/shop").
// ("mua trên shopee rồi mà bị mốc", "… rồi. Mà shop có bán hạt điều không" là khiếu nại / câu hỏi khác → luật khác, mô hình.)
const BOUGHT_ELSEWHERE_TAIL = /\b(?:roi|r)(?: (?:a|ah|ak|nha|nhe|nhen|nghe|nhak|shop|sop|em|e|ad|ban|b|chi|c|anh|ne|do|day|oi|luon|nhe shop|nha shop))*$/;
// R15 (inbox1 A5, quyết định chủ shop 03/10 #1): mặc cả / khách quen xin giảm. "bớt" bỏ dấu trùng "bột" (bột ngũ cốc) → chữ
// "bot" chỉ nhận trong cụm rõ ("bớt chút/đi/cho", "không bớt", "giảm bớt") hay chữ CÒN DẤU "bớt"; "giảm giá" trơn trong câu hỏi
// chương trình ("có giảm giá không") không tính.
// R15 sửa (phản biện luật #1): "mac ca" bỏ dấu là hạt MẮC CA ("Lấy c loại ít hạt mac ca nja") → "mặc cả" chỉ nhận chữ CÒN DẤU
// (BARGAIN_HAGGLE, không đứng sau "hạt"); "khách quen/cũ/ruột" chỉ tính khi cùng câu có từ xin giảm (BARGAIN_DISCOUNT_WORD);
// "không bớt" bỏ dấu chỉ khi cả câu chỉ là "không bớt" ("Granola không bột hả" là hỏi bột); "bán cho … 400" chỉ khi số
// đứng cuối câu ("ban cho c 2 tui 123 le loi" là số nhà).
// R16 (inbox4 T5, ca …012423 "giảm 10%", "Giám 10phan tram"): xin giảm N% cũng là mặc cả.
const BARGAIN = /\bgiam ?\d{1,2} ?(?:%|phan tram\b|pt\b)|\btri an\b|\bbot (?:chut|ti|xiu|tien)\b|^(?:(?:vay|the|z|v|shop|ad|em|e) )?(?:khong|ko|k|kg|hong) bot$|\bgiam (?:them|bot|chut|ti|xiu|it|di|cho|duoc|dc)\b|\bgiam gia (?:cho|di|them|chut|ti|xiu|duoc|dc)\b|\bban cho\b.{0,12}\b\d{3}(?: ?k| ?nghin| ?ngan)?(?: (?:thoi|nha|nhe|duoc|dc|khong|ko|k|kg|hong|di|c|e|chi|em|a|anh|shop|ban|b|luon|duoc khong|dc khong))*$|\b\d{3} ?k? (?:duoc|dc) (?:khong|ko|k|kg|hong)\b/;
const BARGAIN_LOYAL = /\bkhach (?:quen|cu|ruot)\b/;
const BARGAIN_DISCOUNT_WORD = /\b(?:giam|uu dai|re|khuyen mai|km|bot gia|bot chut|bot ti|bot xiu|bot tien|chiet khau|sale)\b/;
const BARGAIN_HAGGLE = /(?<!hạt\s)(?<![\p{L}])mặc\s+cả(?![\p{L}])/iu;
// Không phải mặc cả: bớt SỐ TÚI ("giảm đi 1 túi", "Giảm cho mình còn 2 túi", "giảm còn 2 túi thôi"), giảm CÂN/MỠ ("có giảm được
// mỡ bụng không"), giảm/bớt ĐƯỜNG/NGỌT, hỏi giảm qua live/voucher ("Thế đạt trên live để dc giảm cho c" — LIVESTREAM_VOUCHER).
const BARGAIN_NOT = /\bgiam (?:(?:di|bot|lai|xuong|cho (?:minh|em|e|chi|c|toi|a|anh|m|mk|t|tui)) )*(?:con |xuong )?(?:\d{1,2}|mot|hai|ba|bon|nam) ?(?:tui|goi|bich|bit|hop|cai|xanh|vang|nau)\b|\bgiam (?:(?:duoc|dc|it|bot) )?(?:can|ky|ki|kg|mo|beo|bung|eo|duong|ngot|calo|dau|cholesterol)\b|\b(?:live|livestream|voucher|ma giam)\b/;
// ("bớt 1 túi", "bớt đi 1 xanh", "bớt lại" là bớt món trong giỏ; "bớt đường/ngọt/nho khô/hạt" là bớt thành phần — không phải mặc cả.)
const BARGAIN_RAW = /(?<![\p{L}])bớt(?![\p{L}])(?!\s*(?:\d|một|mot|1|túi|tui|gói|goi|bịch|bich|lại|lai|(?:đi|di|cho\s+\S+)\s+(?:\d|một|1)|màu|vị|loại|xanh|vàng|nâu))(?!\s*(?:đường|duong|ngọt|ngot|béo|beo|ngấy|ngay|dầu|dau|calo|nho|hạt|hat|trái|trai|quả|qua|yến|yen|hạnh|hanh|xoài|xoai|dừa|dua|mật|mat|muối|muoi|cân|can|mỡ|mo)(?![\p{L}]))/iu;
const isBargain = (raw, s) => {
  if (BARGAIN_NOT.test(s)) return false;
  const nfc = String(raw || '').normalize('NFC');
  const rawBargain = BARGAIN_RAW.test(nfc) || BARGAIN_HAGGLE.test(nfc);
  return BARGAIN.test(s) || rawBargain || (BARGAIN_LOYAL.test(s) && BARGAIN_DISCOUNT_WORD.test(s));
};
// Mặc cả có GIÁ khách đưa ra ("3 tui ban cho e 400 c nha", "350k được không") — vẫn là mặc cả dù câu đọc được giỏ.
const BARGAIN_PRICE_OFFER = /\bban cho\b.{0,12}\b\d{3}\b|\b\d{3} ?k? (?:duoc|dc) (?:khong|ko|k|kg|hong)\b/;
// R14 (ca …762063): "Dạ mua 2 bich giá 189k thôi ạ" — "dạ" (vâng) bỏ dấu thành "da" trùng "đã": bỏ "dạ" CÒN DẤU trước khi so ORDER_ASK.
// R16 (inbox3 A2: "E vua mua ben titok roi", "c đặt ở shoppee bên em rồi nhé"): tên sàn gõ sai → shopee / tiktok.
const marketplaceTypos = s => s.replace(/\b(?:shoppee|shoppe|shope|sopee|shopi|shoppi|shoppy)\b/g, 'shopee')
  .replace(/\b(?:titok|tictok|tiktoc|tic toc|tic tok|tik tok|tit tok|top top)\b/g, 'tiktok');
const orderAskCore = raw => marketplaceTypos(core(prep(String(raw || '').normalize('NFC').replace(/(?<![\p{L}])dạ(?![\p{L}])/giu, ' '))));
// "Mua sao e", "Đặt ở đâu e", "Gannola bán sao ạ", "Bán ntn vậy shop nhỉ".
const TERSE_HOW = /^(?:(?:granola|gannola|gran) )?(?:ban|mua|dat) (?:sao|ntn|nhu the nao|the nao|o dau|kieu gi|lam sao|ra sao)$/;
// "Cho chị thử 1 gói màu xanh", "Mua thử 1 gói granola", "M dùng thử 1 túi đã" (TRIAL_ASK chỉ nhận "… dùng thử" ở cuối).
const TRIAL_ASK_B = /^(?:(?:cho|lay|mua|dat|gui|ship)\s)?(?:(?:cho\s)?(?:em|e|minh|m|mk|chi|c|toi|a|anh|to|t)\s)?(?:(?:muon|can)\s)?(?:(?:dung|an|mua|lay)\s)?thu (?:(?:1|mot)\s)?(?:tui|goi|bich|bit)(?:\s(?:granola|gran))?(?:\s(?:mau\s)?(xanh|vang|nau|cacao))?(?:\s(?:nguyen ban|la))?(?:\s(?:truoc|da|xem|coi|xem sao|thoi|xem the nao))?$/;
// ===== Vòng 10 (đo độ phủ nhóm MUA trên bộ chấm + dòng nhân viên, xem tools-intent/order-coverage.mjs) =====
// Số túi không nêu vị ("M lấy 1 túi", "Cho chị 2 gói nhé", "Mình 3 túi", "combo 2 túi 298k fship", "1 túi thôi"):
// hỏi vị, không tự chọn. Chỉ khi CHƯA giữ giỏ (đang giữ giỏ thì "1 túi thôi" có thể là bớt túi → mô hình).
// ("… dùng thử / ăn thử" là của TRIAL_ASK (thử nghiệm), không lặp ở đây. Không có "vâng" ở đầu: bỏ dấu trùng "vàng".)
const BAGS_NO_FLAVOR = /^(?:(?:ok|oke|vay|the|uh|u|da|thoi) )?(?:(?:ban|shop|b) )?(?:(?:lay|cho|dat|mua|ship|giao|gui|goi|ban|inbox|ib|lay cho|gui cho|ban cho|ship cho) )?(?:(?:cho )?(?:em|e|minh|m|mk|mjh|chi|c|cj|ci|toi|a|anh|tui|t|co|bac|chau) )?(?:(?:lay|dat|mua|can|muon|muon lay|muon mua|chot|lay them|them) )?(?:(?:combo|com bo|set|1 set) )?(?:1|2|3) ?(?:tui|goi|bich|bit|bi|bao)(?: (?:thoi|luon|truoc|da|nua|nay|do|kia|la du))?(?: \d{3} ?k)?(?: (?:mien|free|miem) ?(?:phi )?(?:ship|sip|xip|van chuyen)| fship)?$/;
// Đuôi hỏi còn dấu ("1 túi miễn ship hả", "2 túi hông") — core() đã cắt nên so trên sFull.
const QUESTION_TAIL = /\b(ha|hong|khong|ko|k|kg|nhi|chu|phai khong|dung khong)$/;
// "3 túi 3 vị", "ba túi ba vị", "3 túi khác vị", "mỗi vị 1 túi", "combo 3 vị", "3 túi xanh vàng nâu": 1 Xanh + 1 Vàng + 1 Nâu.
const THREE_FLAVOURS = /\b3 (?:tui|goi|bich|bit) (?:mix )?3 (?:vi|loai|mau)\b|\b3 (?:tui|goi|bich|bit) (?:nhung |ma )?(?:khac (?:vi|loai|nhau|mau)|moi (?:tui|goi|bich|loai|vi|mau) 1 (?:vi|loai|mau|tui|goi|bich))\b|\b3 (?:vi|loai|mau) khac nhau\b|\bcombo 3 (?:vi|loai|mau)\b|\bmix 3 (?:vi|loai|mau)\b|\bmoi (?:vi|loai|mau) 1 (?:tui|goi|bich)\b|\bca 3 (?:vi|loai|mau)\b/;
const THREE_COLOURS = /\b3 (?:tui|goi|bich|bit) (xanh|vang|nau)(?:,| va | voi | \+ |\+| )(xanh|vang|nau)(?:,| va | voi | \+ |\+| )(xanh|vang|nau)\b/;
// "2 túi 2 vị", "hai gói hai vị", "2 túi khác vị": chưa biết 2 vị nào → hỏi vị.
const TWO_FLAVOURS = /\b2 (?:tui|goi|bich|bit) (?:mix )?2 (?:vi|loai|mau)\b|\b2 (?:tui|goi|bich|bit) (?:nhung |ma )?khac (?:vi|loai|nhau|mau)\b|\b2 (?:vi|loai|mau) khac nhau\b/;
// "C đặt nhé", "mình mua", "Gửi cho mình" sau khi được báo giá: muốn mua nhưng chưa nêu vị/số → hỏi vị. Có đại từ
// mới nhận ("Mua đi" không nhận); "em đặt rồi" không khớp (đuôi "rồi").
const DECIDE_BUY = /^(?:(?:ok|oke|okie|vang|da|u|uh|um|roi|vay|the|thoi|duoc|dc) )?(?:c|chi|e|em|minh|m|mk|mjh|a|anh|toi|t|co|bac|con|tui|chau|cj|ci) (?:(?:muon|can|se|xin|cho|quyet dinh) )?(?:dat|lay|mua|chot|order)(?: (?:hang|don|luon|thoi|ok|1 don))*$|^(?:gui|ship|giao|ban|lam don) (?:cho )?(?:minh|em|e|chi|c|toi|tui|anh|a|mk|m|mjh)$/;
// "ok" / "chốt" / "đúng rồi" khi bot đang xin SĐT/địa chỉ (giỏ đã có): nhắc lại phần còn thiếu, không hỏi mô hình.
const OK_STEP = /^(?:ok|oke|okie|okay|dc|duoc|vang|da|u|uh|um|dong y|dung roi|chuan|chot|ok chot|chot luon|chot don|dat luon|lay luon|ok lay|ok dat|ok chot don|dc roi|duoc roi|ok nhe|ok em|vang a|da vang)$/;
// "Có mấy loại vậy shop", "Xin xem các vị như nào", "sản phẩm có mấy vị": bảng giá chung (GENERAL_INFO liệt kê 3 vị).
// R13 (inbox1 B3): chịu lỗi gõ "Có mays lọi" (mays → mấy, lọi/laoi/loaj → loại) và dạng "có vị gì", "shop có những vị nào".
export const FLAVOR_LIST = /^(?:(?:shop|ben (?:minh|em|ban|shop)|san pham|sp|granola|nha minh|minh|ben minh co|hien|the|vay) )?(?:co )?(?:tat ca )?(?:may|mays|bao nhieu|bn|nhung|cac) (?:loai|loi|laoi|loaj|vi|mau)(?: (?:gi|nao|vay|the|nhi|het|ta|tat ca|ha))?$|^(?:(?:shop|ben (?:minh|em|ban|shop)|san pham|sp|granola|nha minh|minh|hien|the|vay) )?co (?:vi|loai) (?:gi|j|nao|nhung gi)$|^(?:xin |cho |minh )?(?:xem|coi) (?:cac |nhung |thu )?(?:vi|loai|mau)(?: (?:nhu nao|gi|nao|the nao|ntn))?$|^(?:co )?(?:nhung|cac) (?:vi|loai) (?:gi|nao)$/;
// Rút giỏ đang giữ ("không lấy nữa", "hủy giúp mình", "xóa hết đó đi", "thôi không mua"): đáp mềm + xóa giỏ
// (ORDER_POSTPONED). Chỉ khi chưa có đơn thật — có đơn thì "hủy" là hủy đơn (mô hình / ORDER_CANCEL).
// R14 (ca …958786): "Thôi dẹp khỏi mua", "thôi khỏi lấy" cũng là rút giỏ.
const CANCEL_BASKET = /(?:^|\s)(?:xin )?(?:huy|hy)$|^(?:thoi )?(?:(?:minh|em|e|chi|c|toi|m|mk|t|a|anh) )?(?:khong|ko|k|hong|chua) (?:lay|mua|dat|can|chot)(?: (?:nua|dau|gi|hang|don))*$|\b(?:huy|hy|xoa|bo) (?:don|het|gium|giup|dum|ho|cho (?:minh|em|e|chi|c|toi))\b|\bxoa het\b|\b(?:khong|ko|k) (?:lay|mua|dat|chot) nua\b|\bthoi (?:khong|ko|k) (?:lay|mua|dat)\b|\b(?:thoi |dep )+khoi (?:mua|lay|dat|chot)\b|^(?:(?:minh|em|e|chi|c|toi|m|mk|t|a|anh) )?khoi (?:mua|lay|dat|chot)(?: (?:nua|luon|di|hang|don))*$|\bthoi dep\b/;
// R14 (ca …455261): "C có bắt gáo dừa ròi / C ko lấy nữa thì có giảm tiền ko" là câu HỎI điều kiện (bỏ quà thì có giảm
// tiền không), không phải rút giỏ — xóa giỏ 3 túi 442k mất đơn. Câu hỏi / điều kiện "thì … có/được … không", "giảm/bớt/trừ
// tiền" → không áp CANCEL_BASKET; có nhắc quà (bát/gáo dừa/quạt/muỗng) → GIFT_SWAP (ghi chú + xin duyệt đổi quà).
const CANCEL_CONDITION = /\bthi\b.{0,25}\b(?:co|duoc|dc|giam|bot|tru)\b|\b(?:giam|bot|tru) (?:tien|gia|bot|duoc|dc|khong|ko|k)\b|\bgiam\b|\b(?:co|duoc|dc) (?:khong|ko|k|kg|hong)$/;
const CANCEL_GIFT = /\b(?:bo bat|bat (?:gao|dua|an|com)|gao dua|quat|muong|qua tang)\b/;
// Bot vừa hỏi vị (không gồm COMBO3_FLAVOR: "xanh" sau đó là 3 túi xanh) mà khách trả lời một màu ("Túi xanh",
// "Vàng nhiều hạt", "Nâu cacao ạ"): chọn vị đó, 1 túi → bộ soạn đơn ghép với SĐT/địa chỉ đang giữ.
const FLAVOR_ASK_LAST = new Set(['ASK_FLAVOR', 'ORDER_INFO_ASK_FLAVOR', 'ASK_FLAVOR_NGUYENBAN', 'RECOMMEND_BEGINNER']);
// R15 (inbox2 A1, ca …111673 lời chào live → "Túi xanh 450 g"; …734430 "2 túi miễn ship k ạ" → "Mình có vị gì ạ" → "Túi xanh
// 450g"): các mẫu bảng nhiều vị / chính sách kết bằng lời mời chọn loại ("chọn loại và số lượng nhắn em", "lấy 2 túi vị nào")
// → khách chỉ nêu MỘT màu (không hỏi giá, không "?", không đuôi hỏi) là trả lời vị, không phải xin bảng giá túi đó (PRICE_ONE).
const FLAVOR_MENU_LAST = new Set(['LIVESTREAM_COMMENT', 'GENERAL_INFO', 'FREESHIP_POLICY']);
// R15 sửa (phản biện luật #7): câu HỎI không có "?" ("Túi xanh à", "túi xanh còn", "túi nâu cho con", "túi vàng thì sao")
// không phải trả lời chọn vị. Xét trên chữ CÒN DẤU ("à/hả/nhỉ" là hỏi, "ạ" là lễ phép) sau khi bỏ lời gọi cuối câu.
// "cho con/cho bé" chỉ loại khi không có động từ đặt ("lấy túi nâu cho con" vẫn là chọn vị). Chỉ xét khi bot vừa gửi BẢNG
// nhiều vị (FLAVOR_MENU_LAST); bot vừa HỎI vị (FLAVOR_ASK_LAST) thì "Túi xanh ak" là lời đáp ("ak" = "ạ") như cũ.
const FLAVOUR_Q_TAIL_RAW = /(?:^|\s)(?:à|ạ\s+à|ak|hả|hở|ha|nhỉ|nhể|nhở|còn|còn\s+(?:không|ko|k|hông|hong|hàng)|thì\s+sao|là\s+gì|là\s+vị\s+gì|sao|vậy\s+à|thế\s+à)$/u;
const FLAVOUR_Q_TAIL = /\b(?:con|con (?:khong|ko|k|hong|hang)|thi sao|la gi|la vi gi|sao|ha|ak|nhi)$/;
const FLAVOUR_CALL_TAIL = /(?:\s+(?:shop|sốp|sop|em|e|ad|chị|chi|c|bạn|ban|b|ơi|oi|nhé|nhe|nha|ạ|a))+$/u;
function flavourQuestionTail(raw, s) {
  const nfc = String(raw || '').normalize('NFC').toLowerCase().replace(/[.!…~,;:]+/g, ' ').replace(/\s+/g, ' ').trim();
  const bare = nfc.replace(FLAVOUR_CALL_TAIL, '').trim();
  if (FLAVOUR_Q_TAIL_RAW.test(bare) || FLAVOUR_Q_TAIL_RAW.test(nfc)) return true;
  // Gõ không dấu: chỉ những đuôi không trùng lời đáp ("con" không dấu thường là "còn"; "a" không dấu để yên — có thể là "ạ").
  if (nfc === foldVietnamese(nfc).toLowerCase() && FLAVOUR_Q_TAIL.test(foldVietnamese(bare).toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim())) return true;
  return /\bcho (?:con|be|em be|chau|nha minh|nha)$/.test(s) && !ORDER_VERB.test(s);
}
// R16 (ca …3011340301 "Túi bao bì màu xanh" sau ASK_FLAVOR): "bao bì" là chữ đệm của lời chọn màu.
const FLAVOR_ANSWER_WORDS =/\b(xanh|vang|nau|cacao|la|cay|tui|goi|bich|bit|mau|vi|loai|bao bi|nguyen ban|nhieu hat|nhieu qua|it hat|1|minh|em|e|chi|c|m|mk|lay|cho|dat|mua|the|thi|vay|ok|oke|da|thoi|truoc|di|luon|cua|con)\b/g;

/**
 * R16: màu khách vừa chọn ở tin chữ NGAY TRƯỚC tin hiện tại ("Túi xanh", "Vàng nhiều hạt nhé", "nâu cacao"): 'xanh' | 'vang' | 'nau' | ''.
 * Tin trước phải chỉ gồm chữ chọn màu (FLAVOR_ANSWER_WORDS), đúng một màu, không số khác 1, không hỏi ("?", "à/hả/còn…"), và (nếu có
 * giờ) cách ≤ 15 phút. Mục cuối trùng tin hiện tại (engine có thể đưa cả tin này vào danh sách) thì bỏ qua.
 * @param {Array<string|{text?:string,at?:number,createdAt?:number}>|undefined} list
 * @param {string} current
 */
function previousNamedColour(list, current, now = Date.now()) {
  const entries = (Array.isArray(list) ? list : []).map(item => (typeof item === 'string' ? { text: item } : item || {})).filter(item => String(item.text || '').trim());
  const squash = text => foldVietnamese(String(text || '')).toLowerCase().replace(/[^a-z0-9]+/g, '');
  while (entries.length && squash(entries.at(-1).text) === squash(current)) entries.pop();
  const previous = entries.at(-1);
  if (!previous) return '';
  const at = Number(previous.at ?? previous.createdAt);
  if (Number.isFinite(at) && at > 0 && now - at > 15 * 60 * 1000) return '';
  const raw = String(previous.text).trim();
  if (raw.includes('?') || raw.length > 40 || extractVietnamesePhone(raw)) return '';
  const s = core(prep(raw));
  const colours = [...new Set((s.match(/\b(xanh|vang|nau|cacao)\b/g) || []).map(colour => (colour === 'cacao' ? 'nau' : colour)))];
  if (colours.length !== 1 || /\b(?:[02-9]|\d{2,})\b/.test(s) || s.replace(FLAVOR_ANSWER_WORDS, ' ').trim() || flavourQuestionTail(raw, s)) return '';
  return colours[0];
}

// R14 (ca …221660): "Hộp 10 gói và 1 túi xanh nguyên bản" là tin ĐẶT HÀNG (số lượng + vị, ngoài chữ "hộp 10 gói"), không
// hỏi bao bì gói nhỏ → không trả PACKAGING_INFO, không chặn luật giỏ.
const SMALL_PACK_ORDER = s => /\b(?:xanh|vang|nau|cacao|mint|tropical)\b/.test(s) && /\b\d{1,2} ?(?:tui|bich|bit|hop|goi|combo|set)\b/.test(s.replace(/\b(?:(?:hop|combo|set) )?10 goi(?: nho)?\b/g, ' '));
// R14 (quyết định chủ shop 11, ca …002949 "Chị bị cao huyết áp, ăn OK không em"): câu hỏi bệnh lý (huyết áp, tim mạch,
// gout, dạ dày, mỡ máu, thận…) → câu thận trọng ngắn HEALTH_CAUTION (thực phẩm thông thường, hỏi bác sĩ khẩu phần) + thẻ;
// không dùng mẫu mẹ sau sinh. Tiểu đường giữ HEALTH_DIABETES; mẹ bầu/sau sinh giữ HEALTH_CONDITION.
const HEALTH_CAUTION_RE = /\b(?:cao huyet ap|huyet ap|tang huyet ap|tim mach|benh tim|dau tim|gout|gut|benh gut|da day|dau bao tu|bao tu|trao nguoc|mo mau|cholesterol|choleterol|benh than|suy than|soi than|viem gan|gan nhiem mo|men gan|ung thu|xuong khop|tuyen giap)\b/;
// R15 (inbox1 A6, ca …937383 "ngu coc ca cao loại nào ngon e"): câu xin gợi ý ĐÃ nêu màu/vị → không gợi ý Túi Xanh cho người mới
// (RECOMMEND_BEGINNER); để luật so sánh / mô hình trả lời đúng vị khách nêu.
const RECOMMEND_NAMED = /\b(?:xanh|vang|nau|cacao|mint|tropical|nhieu hat|nguyen ban)\b/;
// Câu hỏi thông tin: [luật, regex trên core, mẫu, điều kiện loại trừ thêm].
const INFO_RULES = [
  // Vòng 12 (B5 #6, B2 #17): cách ăn / mỗi lần ăn bao nhiêu (30–40g) — trước WEIGHT_EXPIRY ("bao nhiêu"). Loại khi hỏi giá/yến mạch.
  ['HOW_TO_USE', /\b(?:an|dung|su dung) (?:nhu the nao|ntn|the nao|kieu gi|ra sao)\b|\bcach (?:an|dung|su dung)\b|\ban truc tiep\b|\bngam (?:voi )?(?:sua|qua dem)\b|\bphai ngam\b|\bmoi lan (?:an|dung)\b|\b(?:an|dung) (?:moi lan|1 lan|mot lan) (?:bao nhieu|bn|may)\b/, 'HOW_TO_USE_GRANOLA', s => /\bgia\b|\byen mach\b/.test(s)],
  // Vòng 12: tiểu đường / đường huyết cao tách khỏi mẫu mẹ sau sinh (trả lời thẳng, khuyên hỏi bác sĩ, không hứa công dụng).
  // R13 (inbox3 F5): thêm "đái tháo đường"; câu có "mua" ("mua cho người mắc tiểu đường ăn") xét riêng trong stableRules.
  ['DIABETES', /\b(?:tieu duong|tieu dg|dai thao duong|duong huyet|duong (?:hoi |rat |kha )?cao|duong trong mau|benh duong)\b/, 'HEALTH_DIABETES'],
  // Vòng 12 (B3 #12): mua cho người bệnh / người già → HEALTH_CONDITION + thẻ cần người (engine gắn attention theo tên luật).
  ['HEALTH_CAUTION', HEALTH_CAUTION_RE, 'HEALTH_CAUTION'],
  ['PATIENT', /\b(?:benh nhan|nguoi benh|nguoi om|dang om|nguoi gia|ong ba (?:gia|lon tuoi)|sau mo|dang dieu tri)\b/, 'HEALTH_CONDITION'],
  // Mẹ sau sinh / cho con bú / ở cữ: cùng mẫu HEALTH_CONDITION (đặt trước KIDS vì "cho con bú" có "cho con").
  ['HEALTH', /\b(me bau|bau bi|dang bau|mang thai|thai ky|sau sinh|cho con bu|dang cho bu|o cu)\b/, 'HEALTH_CONDITION'],
  ['KIDS', /\b(cho be|be an|be \d+ tuoi|tre em|tre nho|con nho|cho con|nguoi lon tuoi)\b/, 'KIDS_FAMILY'],
  // Vòng 12 (B2 #14): tăng cân tách khỏi CALORIES (khách muốn tăng cân từng nhận mẫu giảm cân 2 lần).
  ['WEIGHT_GAIN', /\b(?:tang can|len can|beo len|map len|tang ky)\b/, 'WEIGHT_GAIN'],
  // R13 (inbox3 F5, inbox2 C4): "Có bột ngũ cốc giảm béo không" hỏi SẢN PHẨM KHÁC (bột ngũ cốc) → không trả calo granola;
  // bot vừa gửi CALORIES_DIET mà khách hỏi tiếp ("Vậy loại ăn hỗ trợ giảm cân thì loại nào?") → không lặp y câu calo, để mô hình.
  ['CALORIES', /(calo|kcal|giam can|an kieng|eat ?clean|\bbeo\b)/, 'CALORIES_DIET', (s, ctx) => /\bbot (?:ngu coc|giam|an kieng|dinh duong)\b|\b(?:sua|tra|thuoc|vien|keo) (?:hat )?giam\b/.test(s) || ctx?.botLastTemplateId === 'CALORIES_DIET'],
  // Vòng 12 (B3 #12): người ăn chay.
  ['VEGAN', /\b(?:an chay|thuan chay|vegan|nguoi chay)\b/, 'VEGAN_INFO'],
  // Vòng 12 (B1 #12): "Công dụng như nào" → lợi ích (không phải bảng giá).
  ['BENEFITS', /\b(?:cong dung|tac dung|loi ich|tot (?:cho|khong) (?:suc khoe|co the))\b/, 'BENEFITS'],
  // R14 (ca …768385): "Loại nào ăn luôn được với sữa chua không đường" — "không đường" là của SỮA CHUA khách dùng kèm,
  // không hỏi granola có đường không → bỏ cụm "sữa chua/sữa/yaourt (không|ít|có) đường" trước khi xét (còn ý khác thì để mô hình).
  ['SUGAR', /(co ngot|ngot (lam|nhieu|khong|ko|k|kh)\b|(khong|ko|k) (co )?duong|it duong|co duong|loai nao (khong|ko|k) ngot)/, 'NO_ADDED_SUGAR', s => !/(co ngot|ngot (lam|nhieu|khong|ko|k|kh)\b|(khong|ko|k) (co )?duong|it duong|co duong|loai nao (khong|ko|k) ngot)/.test(s.replace(/\b(?:sua chua|sua tuoi|sua hat|sua|yaourt|yogurt|ya ua|da ua) (?:(?:khong|ko|k|it|co) )?(?:co )?duong\b/g, ' '))],
  ['CRUNCHY', /((hat|vien) (gion|tron)\b.*\b(la|lam tu|lam bang) (hat |gi|j)|hat tron nho la|co (chien|ngay)|(chien|dau an) (khong|ko|k)\b)/, 'CRUNCHY_CEREAL_INFO'],
  // Vòng 12 (B2 #15, B3 #12): "có hạt óc chó không", "có macca không" → thành phần (không có óc chó).
  ['INGREDIENTS', /(thanh phan|gom (nhung |cac )?(gi|hat|loai)|(co|la) (nhung |cac )?(loai )?hat (gi|j|nao)|hat (gi|j)\b|di ung|(co|khong|ko) .*dau nanh|gluten|oc cho|mac ?ca|hat chia|hat bi xanh)/, 'INGREDIENTS_ALLERGY', s => PRICE.test(s)],
  // Vòng 12 (B1 #12, B3 #26): chi nhánh / cửa hàng → địa chỉ + giao toàn quốc; "Sx ở đâu" → nơi sản xuất.
  ['STORE', /\b(?:chi nhanh|cua hang|showroom|dia chi (?:cua )?(?:shop|ben (?:em|minh|ban))|shop o (?:dau|tinh nao)|ban o dau)\b/, 'STORE_ADDRESS', s => /\bmua\b/.test(s)],
  ['PRODUCTION', /\b(?:sx|san xuat|lam) (?:o|tai) (?:dau|nao)\b|\bxuong (?:o )?(?:dau|nao)\b|\bnoi san xuat\b/, 'PRODUCTION_PLACE'],
  // "Hàng mới không em", "date mới không": hỏi độ mới, không phải trọng lượng/hạn dùng.
  // "Đúng hàng mới nhận" là điều kiện nhận hàng (đồng kiểm), không hỏi độ mới.
  ['FRESH', /\b(hang moi|date moi|han (dai|moi|xa)|moi san xuat|con han)\b|\bmoi (khong|ko|k|o|hong)\b/, 'FRESHNESS', s => /\bdung hang\b/.test(s)],
  // R14 (ca …070230): "2 túi trọng luong bn và bn tiền ạ" hỏi cả GIÁ → không chỉ trả trọng lượng (để mô hình trả cả hai).
  ['WEIGHT_EXPIRY', /((bao nhieu|bn|may|nhieu) ?(gam|gram|gr|g)\b|han (su dung|dung|sd)|hsd|an (duoc|dc) (bao )?lau|an (duoc|dc) may bua|dung (duoc|dc) may bua|trong luong)/, 'WEIGHT_EXPIRY', s => /\bgia\b|date moi|hang moi|\b(?:bn|bao nhieu|bnhiu|nhieu|nhiu|bao|may) ?tien\b/.test(s)],
  // Khách mới, xin gợi ý ("túi nào dễ ăn", "mới tập ăn", "tư vấn c 1 túi"): gợi ý Túi Xanh — đặt TRƯỚC
  // COMPARE vì "nào ngon" cũng nằm trong COMPARE.
  ['RECOMMEND', /\b(tui|loai|vi) nao (ok|ngon|hop|de an|nen (lay|mua|chon))\b|\bmoi (tap|bat dau) an\b|\bchua (duoc )?trai nghiem\b|\btu van (?:(?:giup|cho|dum|ho) )?(?:(?:c|e|minh|chi|anh|em|m|mk) )?(?:(?:1|mot) )?(?:tui|loai)\b/, 'RECOMMEND_BEGINNER', s => PRICE.test(s) || RECOMMEND_NAMED.test(s)],
  // Combo 3 túi chọn vị thế nào ("combo 3 túi khác nhau được không", "combo gia đình là 3 túi gì"): trước COMPARE.
  // "combo " + nhìn trước (3|ba|gia dinh) để "3 tui xanh" ngay sau "combo" vẫn khớp vế "3 tui (xanh|gi)".
  ['COMBO3', /\bcombo (?=(?:3|ba|gia dinh)\b).{0,25}?(vi gi|khac nhau|cung (vi|mau)|mau gi|la (3 )?tui|3 tui (xanh|gi))|\bcom ?bo gia dinh (co|la)\b/, 'COMBO3_FLAVOR'],
  ['COMPARE', /(khac nhau|khac (gi|sao|ntn|nhu nao|the nao)|nao ngon|ngon hon|nen (chon|mua|dung|lay) (loai|tui|vi)? ?nao|phan biet|giai thich|nguyen ban la (sao|gi)|loai nao nhieu hat)/, 'BAG_COMPARISON', s => PRICE.test(s) || /\bbi\b|can|beo|kieng|\bbe\b/.test(s)],
  // Đang giữ giỏ: vẫn khớp, ruleIntent giữ bước đơn (dòng giỏ có tổng + miễn ship) và trả lời kèm.
  // Đang giữ giỏ mà khách đổi số túi / xin "1 túi ăn thử miễn ship": không giữ giỏ cũ, để mô hình đọc.
  // "2 túi 298k miễn ship": khách nhắc lại giá vừa báo để đặt, không hỏi chính sách → để mô hình lên đơn.
  ['FREESHIP', /(mien|free) ?(phi )?(ship|sip|van chuyen)|freeship/, 'FREESHIP_POLICY', (s, ctx) => PRICE.test(s) || (ctx.hasBasket && /\b(\d{1,2} ?(tui|goi|bich)|mot tui|an thu|dung thu|thu)\b/.test(s)) || (/\b\d{1,2} ?(tui|goi|bich)\b/.test(s) && /\b\d{2,3} ?(k|nghin|ngan)\b|\d{3}\.000/.test(s))],
  ['DISCOUNT', /(giam gia|khuyen mai|\bkm\b|uu dai|chuong trinh|\bct\b|\bsale\b)/, 'DISCOUNT_POLICY', (s, ctx) => ctx.livestream || /(voucher|qua|tang|gau|live)/.test(s)],
  ['VOUCHER', /(voucher|vocher|vochur|ma giam)/, 'LIVESTREAM_VOUCHER', s => PRICE.test(s)],
  ['GIFT', /((qua|tang) (gi|j)\b|co (duoc )?(qua|tang)|duoc tang|qua tang)/, 'GIFT_POLICY', s => PRICE.test(s) || /\b(xanh|vang|nau|cacao)\b|gau|dau tay|doi qua|thay qua|khac/.test(s)],
  // Vòng 12 (B1 #12, B3 #26): "Gửi hình e xem", "gửi 3 mẫu" (không phải ảnh chuyển khoản).
  ['PHOTOS', /(xem (hinh|anh|mau|san pham)|chup (xem|hinh|anh|cho|minh|chi|em)|gui (hinh|anh|mau) xem|(anh|hinh) that|cho (xem|coi)|xem them anh|\b(?:gui|xin) (?:(?:e|em|c|chi|minh|m|a|anh|toi|tui) )?(?:xem )?(?:hinh|anh)\b(?! (?:ck|chuyen|bill|thanh toan))|\bgui (?:3|ba|cac) mau\b)/, 'PRODUCT_PHOTOS', s => /\b(ck|chuyen khoan|bill)\b/.test(s)],
  ['SMALL_PACK', /\b(co|ban) (tui|goi) nho|hop 10 goi|chia (goi|nho)|goi le\b|\b(set|combo|hop|bich|tui) .{0,10}goi nho|nhieu goi nho|goi nho .{0,10}(nhieu vi|mix|may vi)|chia (?:thanh )?(?:phan|goi)|phan nho|dung (?:1|mot) lan/, 'PACKAGING_INFO', (s, ctx) => PRICE.test(s) || ctx.hasBasket || SMALL_PACK_ORDER(s)],
  ['SHIP_TIME', /((bao lau|may ngay|bao nhieu ngay|bn ngay|khi nao|chung nao) (thi )?(nhan|giao|toi|den|co)|(giao|ship|nhan)( hang)? (mat )?(bao lau|may ngay|bn ngay)|may ngay giao|khoang chung nao)/, 'SHIPPING_POLICY'],
  ['LINKS', /((xin|gui|cho) .*(link|linh gian hang|gian hang)|(co|vo|ban) (tren|o) (shopee|tiktok|lazada))/, 'ECOMMERCE_LINKS'],
  ['WHOLESALE', /(\bsi\b|\bctv\b|cong tac vien|dai ly|lay buon)/, 'WHOLESALE_CTV_CONTACT', s => /(bac|tien|y|ca|nghe|thac) si/.test(s)],
  // R16 (inbox2 S1, inbox1 B2: "Túi nào dùng ăn vặt ạ", "Hạt này ăn vặt luôn ạ"): bỏ dấu thì "ăn vặt" thành "an vat", "dị vật" thành
  // "di vat" → chữ "vat" đứng sau ăn/đồ/món/dị/con/đồ vật… không phải thuế VAT. (Chữ CÒN DẤU "vặt/vật" xét thêm ở vòng INFO.)
  ['VAT', /\b(?<!\b(?:an|do|mon|di|con|hien|dong|vat) )vat(?! (?:dung|lieu|ly|nuoi|chat|va|vanh|vat|gia))\b|\bxuat hoa don\b|\bhoa don (?:do|vat|gtgt|dien tu)\b/, 'VAT_INVOICE'],
  ['PAYMENT', /\b(cod|thanh toan|chuyen khoan|ck truoc|tra tien|thu tien|tra truoc|tra sau|nhan hang roi tra)\b/, 'PAYMENT_METHODS', s => PRICE.test(s) && !/\b(cod|chuyen khoan|ck)\b/.test(s)]
];

// R16: chữ CÒN DẤU "vặt/vật" (ăn vặt, dị vật) mà câu không nói hoá đơn/xuất/thuế/MST/công ty và không có "VAT" viết hoa → không
// phải hỏi hoá đơn VAT.
function vatNotInvoice(raw) {
  const nfc = String(raw || '').normalize('NFC');
  return /(?<![\p{L}])v[ặậ]t(?![\p{L}])/iu.test(nfc) && !/(?<![\p{L}])VAT(?![\p{L}])/u.test(nfc)
    && !/(?<![\p{L}])(?:ho[áà] đơn|hoa don|xuất|xuat|thuế|thue|mst|công ty|cong ty|cty)(?![\p{L}])/iu.test(nfc);
}

const ICEBREAKERS = [
  [/^lam cach nao de dat hang$/, 'price'],
  [/^(lam cach nao de xem san pham truoc|toi co the xem them anh ve mat hang nay khong)$/, 'PRODUCT_PHOTOS'],
  [/^(co chuong trinh giam gia nao khong|khuyen mai combo dung thu tiet kiem)$/, 'DISCOUNT_POLICY'],
  [/^get started$/, 'WELCOME']
];

const productHintName = value => (value && typeof value === 'string' ? value : '');
const quotedProductName = value => (value && typeof value === 'string' ? value : '');
const colourSku = colour => getCatalogProducts().find(item => item.active !== false && /^gra-/i.test(item.sku || '') && String(item.sku || '').toLowerCase().includes(`-${colour}-`));

/**
 * R16 (ca …4455835868 "Đặt mua 2 gói Ngũ cốc ăn sáng màu xanh / ĐC … / ĐT …", "Cho mình 3 bịch ngũ cốc vị cacao nhé <sđt> <đc>"): tên
 * chung của hàng ("ngũ cốc", "ngủ cốc", "ngũ cốc ăn sáng", "… ăn sáng") chen giữa số và MÀU → token "granola" (chữ giỏ), để luật giỏ
 * đọc được "2 gói … màu xanh". Chỉ khi ngay sau là (màu/vị/loại) + màu: "1 ngủ cốc" đứng riêng (chưa nêu vị — chờ chủ shop chốt
 * mặc định) giữ nguyên, luật giỏ vẫn để mô hình.
 */
const CEREAL_BEFORE_COLOUR = /(?<![\p{L}])(?:(?:ngũ|ngủ|ngu|ngú)\s+c[ốoóồ]c(?:\s+(?:ăn|an)\s+s[áa]ng)?|(?:ăn|an)\s+s[áa]ng)(?=\s+(?:(?:màu|mau|vị|vi|loại|loai)\s+)?(?:xanh|vàng|vang|nâu|nau|cacao|ca\s*cao)(?![\p{L}]))/giu;
const foldCerealWords = raw => String(raw || '').normalize('NFC').replace(CEREAL_BEFORE_COLOUR, 'granola')
  .replace(/(?<![\p{L}])granola\s+granola(?![\p{L}])/giu, 'granola');
// R16 (A5 inbox1, mục 11): "N loại / N vị / N màu" là số LOẠI, không phải số túi ("sao co 2loai tui xanh va tui vang") — luật giỏ
// không đọc thành giỏ. ("3 túi 3 vị" / "2 túi 2 vị" có luật riêng THREE_FLAVOURS / TWO_FLAVOURS.)
// ("1 màu xanh 1 màu vàng", "1 vị cacao" — số + màu/vị + TÊN MÀU — vẫn là giỏ.)
const KINDS_COUNT = /\b\d{1,2} ?(?:loai|vi|mau)\b(?! (?:xanh|vang|nau|cacao|mint|tropical)\b)/;

/** Giỏ ghi mơ hồ ("combo xanh", "2 gói xanh vàng", "vàng 2 túi", "1 combo vàng"): để mô hình. */
function basketAmbiguous(raw) {
  const x = foldVietnamese(dropLiveColours(prep(raw))).replace(/\b\d{3} ?(g|gr|gram)\b/g, ' ').replace(/\+?\d{9,11}/g, ' ');
  const numbers = x.match(/\b\d{1,2}\b/g) || [];
  const colours = new Set(x.match(/\b(xanh|vang|nau|cacao)\b/g) || []);
  return (/\bcombo\b/.test(x) && !numbers.length)
    || (colours.size >= 2 && numbers.length === 1 && Number(numbers[0]) >= 2)
    // (R13: "1 xanh 1 ca cao 300g" → "1 xanh 1 tropical" — số sau "xanh" thuộc món Tropical đứng sau, không mơ hồ.)
    || /\b(xanh|vang|nau|cacao)\b[^0-9]*\b\d{1,2}\b(?!.*\b(xanh|vang|nau|cacao|mint|tropical)\b)/.test(x)
    || /\d\s*combo\b/.test(x)
    // R15 sửa (phản biện luật, THẤP): "10xanh" không đơn vị — combo 10 gói Xanh hay 10 túi lớn chưa rõ → để mô hình hỏi lại.
    || /(?<![\d.,])(?:[1-9]\d{1,2}|muoi)\s*(?:xanh|vang|nau|cacao)\b/.test(x);
}

// Sau khi bỏ mọi chữ nói về giỏ, còn chữ nào thì tin có ý khác: để mô hình.
const BASKET_WORDS = new Set(['xanh', 'vang', 'nau', 'mint', 'tropical', 'cacao', 'la', 'cay', 'tui', 'tuy', 'goi', 'bich', 'bit', 'hop', 'combo', 'lay', 'dat', 'mua', 'chot', 'gui', 'ship', 'cho', 'muon', 'can', 'em', 'e', 'minh', 'mk', 'm', 'chi', 'c', 'toi', 'tui', 'anh', 'a', 'to', 'ban', 'b', 'shop', 'va', 'voi', 'them', 'moi', 'loai', 'nha', 'nhe', 'ha', 'luon', 'di', 'thu', 'dung', 'nguyen', 'nhieu', 'hat', 'x', 'vi', 'granola', 'sdt', 'dt', 'nhe', 'ak', 'ah', 'oi']);

// Vòng 10: chữ nối / chữ đệm hay đi cùng giỏ mà không đổi nghĩa ("xanh + vàng", "1 xanh vs 1 vàng", "bịch màu
// vàng", "túi xanh to", "lấy chj", "cô lấy", "1 túi vàng 174k", "350g"…). KHÔNG có "khong/ko/k" ("ko lấy 2 túi xanh")
// hay "mix" — để mô hình.
const BASKET_FILLER = new Set(['+', '/', '&', 'vs', 'va', 'voi', 'cung', 'plus', 'to', 'lon', 'chj', 'cj', 'ci', 'mjh', 'mih', 'u', 'uh', 't', 'co', 'bac', 'me', 'chau', 'ok', 'oke', 'da', 'g', 'gr', 'gam', 'gram', 'set', 'giao', 'nhen', 'nghen', 'vay', 'the', 'thi', 'roi', 'nay', 'bit', 'bi', 'inbox', 'ib', 'uu', 'dum', 'giup', 'gium', 'ho', '000']);
const isBasketWord = word => BASKET_WORDS.has(word) || BASKET_FILLER.has(word) || /^\d{1,2}$/.test(word) || /^x\d{1,2}$/.test(word) || /^\d{1,2}(tui|goi|bich|bit|hop)$/.test(word) || /^\d{3}(k|000|g|gr|gam|gram)?$/.test(word);
// "màu" chỉ là chữ đệm khi có số hay động từ đặt ("1 bịch màu vàng", "lấy màu xanh"); "Màu nâu và vàng" trơn sau bảng giá
// là hỏi giá mix (PRICE_MIX_TUI_LON, bộ chấm) → để mô hình.
const colourWordOk = text => ORDER_VERB.test(text) || /\b\d{1,2}\b/.test(text) || /\b(tui|goi|bich|bit)\b/.test(text);
// Bỏ SĐT khỏi tin nhưng giữ số đứng trước/sau nó (stripPhone của order-flow.mjs).
// Khi tách "giỏ + địa chỉ": số 3 chữ số trơn ("450 Lê Lợi") thuộc địa chỉ, không phải giá.
const isBasketPrefixWord = word => isBasketWord(word) && !/^\d{3}$/.test(word);
// Câu xin tư vấn ("tư vấn c 1 túi nữa", "nên lấy loại nào") không phải giỏ: số túi trong câu là số hỏi.
const ADVICE_ASK = /\b(tu van|goi y|nen lay|loai nao)\b/;
// Bản không cờ g (FREESHIP_MENTION có g → .test giữ lastIndex giữa các lần gọi).
const FREESHIP_ANY = /\b(mien|free|miem) ?(phi )?(ship|sip|xip|van chuyen)\b|\bfreeship\b|\bfship\b/;
const FREESHIP_MENTION = /\b(mien|free|miem) ?(phi )?(ship|sip|xip|van chuyen)\b|\bfreeship\b|\bfship\b/g;

function basketParts(raw, commentBasket) {
  const cleaned = dropLiveColours(prep(foldCerealWords(raw)));
  if (ADVICE_ASK.test(core(cleaned))) return { items: [], leftover: '' };
  if (KINDS_COUNT.test(core(cleaned))) return { items: [], leftover: '' };
  const items = commentBasket(cleaned);
  if (!items.length) return { items: [], leftover: '' };
  // R14 (ca …221660 "Hộp 10 gói và 1 túi xanh nguyên bản"): tin nói hộp/combo 10 gói mà bộ đọc giỏ không ra món Combo 10 gói
  // ("combo 10 gói xanh" từng thành 10 Túi Xanh; "Hộp 10 gói và 1 túi xanh" mất hộp) → không tự lên giỏ, để mô hình.
  if (/\b(?:(?:hop|combo|set|cb) ?10|10 goi)\b/.test(core(cleaned)) && !items.some(item => /10 g[óo]i/iu.test(String(item.product || '')))) return { items: [], leftover: '' };
  // "2 túi xanh 298k miễn ship" / "trọn bộ xanh vàng nâu" / "mua 2 nâu 1 vàng được ko" (đuôi lịch sự chỉ bỏ khi có
  // động từ đặt — "2 túi có miễn ship không" vẫn là câu hỏi).
  let text = core(cleaned).replace(/\+?\d{9,11}/g, ' ').replace(FREESHIP_MENTION, ' ').replace(/\b(tron|du) bo\b/g, ' ');
  if (ORDER_VERB.test(text)) text = text.replace(/ (?:co )?(?:duoc|dc) (?:khong|ko|k|kg|hong)$/, '');
  const words = text.split(/\s+/).filter(Boolean);
  const mauOk = colourWordOk(text);
  const leftover = words.filter(word => !isBasketWord(word) && !(mauOk && word === 'mau'));
  return { items, leftover: leftover.join(' ') };
}

/**
 * Tách tin "giỏ + địa chỉ" ("1 túi xanh, 1 túi vàng Võ Thị Ngân tổ 13 ấp…", "Ship cho c 1 túi xanh và 1 túi vàng.
 * Hường- <sđt> HA02-17 Vinhomes…"): giỏ là cụm chữ-giỏ liền ở ĐẦU hay CUỐI tin (có màu túi), phần còn lại là địa chỉ.
 * Giỏ nằm giữa / không có màu → null (để mô hình).
 */
function splitBasketAddress(raw) {
  // R13: sửa lỗi gõ màu trước khi tách ("2ca cao,<sđt>,79xom hạ…" → "2 cacao, , 79xom hạ…"), dấu phẩy dính liền tách ra.
  // R16: "2 gói Ngũ cốc ăn sáng màu xanh" → "2 gói granola màu xanh" (foldCerealWords) trước khi tách.
  const tokens = stripPhone(normalizeColourTypos(foldCerealWords(raw))).replace(/,(?=\S)/g, ', ').split(/\s+/).filter(token => token && !/^[,.;:]+$/.test(token));
  const folded = tokens.map(token => core(prep(token)).split(' ').filter(Boolean));
  // R13 sửa (phản biện T4): chữ màu là ĐỊA DANH, không phải túi — đứng ngay sau "số/tổ/ngõ/khu/ấp/thôn/hẻm/kp/đường + số"
  // ("tổ 2 Vàng Anh", "số 2 Vàng Danh"), hay viết hoa và theo sau là chữ viết hoa khác (không phải màu/đơn vị/số) mà trước
  // nó không phải số/đơn vị túi ("Cầu Vàng, Hoà Vang"; "2 túi Xanh Nguyễn Huệ" vẫn là giỏ).
  const placeColour = index => {
    const words = folded[index];
    if (!words.some(word => /^(?:xanh|vang|nau|cacao)$/.test(word))) return false;
    const prev = (folded[index - 1] || []).join(' ');
    const prev2 = (folded[index - 2] || []).join(' ');
    if (/^\d+$/.test(prev) && /^(?:so|to|ngo|khu|ap|thon|hem|kp|duong|ngach|xom)$/.test(prev2)) return true;
    const next = tokens[index + 1] || '';
    const nextFolded = (folded[index + 1] || []).join(' ');
    return /^\p{Lu}/u.test(tokens[index]) && /^\p{Lu}/u.test(next) && !/^\d+$/.test(prev) && !(prev && folded[index - 1].every(isBasketPrefixWord))
      && !/^(?:xanh|vang|nau|cacao|tui|goi|bich|hop|combo|va|\d+)$/.test(nextFolded);
  };
  // R16: "nguyên" chỉ là chữ giỏ trong "nguyên bản" — "5 Nguyễn Huệ" (tên đường) không bị nuốt vào cụm giỏ.
  const basketish = index => !placeColour(index) && folded[index].every(word => isBasketPrefixWord(word) || word === 'mau')
    && !(folded[index].includes('nguyen') && (folded[index + 1] || []).join(' ') !== 'ban');
  // Cụm giỏ phải có màu túi, hoặc ít nhất số túi ("2 túi nhé. Thôn Đồng Tiến…" → giữ địa chỉ, hỏi vị).
  const signal = parts => {
    const joined = parts.map(part => part.join(' ')).join(' ');
    return /\b(xanh|vang|nau|cacao)\b/.test(joined) ? 'colour' : /\b\d{1,2} (tui|goi|bich|bit)\b/.test(joined) ? 'count' : '';
  };
  const digits = index => /^\d+$/.test(tokens[index]);
  let i = 0;
  while (i < tokens.length && basketish(i)) i += 1;
  // Số trơn cuối cụm giỏ ("2 túi xanh 12 Lê Lợi") là số nhà: trả về địa chỉ.
  while (i > 0 && digits(i - 1)) i -= 1;
  if (i > 0 && i < tokens.length && signal(folded.slice(0, i))) return { basket: tokens.slice(0, i).join(' '), address: tokens.slice(i).join(' '), signal: signal(folded.slice(0, i)) };
  let j = tokens.length;
  while (j > 0 && basketish(j - 1)) j -= 1;
  while (j < tokens.length - 1 && digits(j) && digits(j + 1)) j += 1;
  if (j > 0 && j < tokens.length && signal(folded.slice(j))) return { basket: tokens.slice(j).join(' '), address: tokens.slice(0, j).join(' '), signal: signal(folded.slice(j)) };
  return null;
}

/** Phần còn lại sau giỏ có phải "gửi (về) địa chỉ cũ / như cũ / thông tin như cũ"? (core của phần đó) */
const OLD_ADDRESS_TAIL = /^(?:(?:gui|goi|ship|giao|ve|toi|den|nhu|theo|thong tin|tt|dia chi|dc|d c|dchi|cho|van|the|cu|lan|don|hom|truoc|giong|nay|do|day|nghe|nhe|nha|em|e|chi|c|minh|luon|roi|va|so) )*(?:cu|truoc|the)$/;
const OLD_ADDRESS_CORE = /\b(?:dia chi|dc|d c|dchi|cho|thong tin|tt) (?:(?:van|nhu|giong|theo) )?(?:cu|the|lan truoc|don truoc|hom truoc|truoc)\b|\b(?:nhu|giong|theo) (?:cu|lan truoc|don truoc|hom truoc)\b/;

function basketFrom(raw, commentBasket) {
  const { items, leftover } = basketParts(raw, commentBasket);
  return leftover ? [] : items;
}

// R15: tên luật ứng viên → khoá trong cài đặt candidateRules dạng đối tượng.
const CANDIDATE_KEYS = { K1_SHORT_PRICE: 'K1', K1B_SHORT_PRICE_HELD: 'K1b', K3_QTY_HELD: 'K3', K4_WANT_BUY: 'K4', K5_FLAVOR_LIST_HELD: 'K5' };
const CANDIDATE_MODES = new Set(['on', 'shadow', 'off']);
/**
 * R15 — chế độ của MỘT luật ứng viên theo cài đặt `candidateRules`:
 *  - chuỗi 'on' | 'shadow' | 'off' (như cũ): áp cho cả 5 luật;
 *  - đối tượng theo từng luật `{ K1: 'on', K3: 'shadow', … }` (khoá K1, K1b, K3, K4, K5; không phân biệt hoa thường; nhận cả tên
 *    luật đầy đủ "K1_SHORT_PRICE"): thiếu khoá / giá trị lạ = 'shadow'.
 * Giá trị khác (undefined, null, chuỗi lạ) → 'shadow'.
 * @param {string|Record<string,string>|undefined|null} setting
 * @param {string} name  'K1' | 'K1b' | 'K3' | 'K4' | 'K5' (hay tên luật đầy đủ)
 * @returns {'on'|'shadow'|'off'}
 */
export function candidateRuleMode(setting, name) {
  if (typeof setting === 'string') return CANDIDATE_MODES.has(setting) ? setting : 'shadow';
  if (!setting || typeof setting !== 'object' || Array.isArray(setting)) return 'shadow';
  const key = CANDIDATE_KEYS[String(name || '')] || String(name || '');
  const found = Object.keys(setting).find(entry => entry.toLowerCase() === key.toLowerCase());
  const mode = found === undefined ? undefined : setting[found];
  return CANDIDATE_MODES.has(mode) ? mode : 'shadow';
}

/**
 * @param text  tin (đã gộp cụm) của khách
 * @param ctx   { source, botLastTemplateId, staffRepliedAfterBot, botLastAgeMin, hasBasket, lastWasOrderStep,
 *               orderAgeMin, livestream, contextProduct, bundleSize, commentBasket }
 * @returns null | { rule, value } | { rule, commentRule:true } | { rule, value, attention:true }
 *          | { rule, value, clearBasket:true } (CANCEL_BASKET / hủy rõ: engine xóa giỏ chờ)
 *          | { rule, value, keepBasket:true } (R13 — ORDER_POSTPONED chỉ hẹn dịp khác: engine GIỮ giỏ chờ, nên đánh dấu
 *            hoãn để không bám đuổi nhắc giỏ)
 *          | { rule:'QUANTITY_ONLY', value, setQuantity:N } (R13 — khách chỉ nêu số lượng khi đang giữ giỏ)
 *          value.values: số liệu điền thẳng vào mẫu ({ingredient} của NO_VARIANT, {cart} của ORDER_CUSTOM_BASKET…)
 */
export function ruleIntent(text, ctx = {}) {
  const raw = String(text || '').trim();
  if (!raw) return null;
  // Chuỗi so luật đi qua prep(): "ca cao" → "cacao", "socola/chocolate" → "nâu" (alias màu ở mọi luật).
  const s = core(prep(raw));
  // Bản bỏ dấu nhưng CHƯA cắt từ đệm cuối câu: core() cắt "bạn"/"hả"/"nhỉ" nên "nguyên bản" thành "nguyen",
  // "đúng hả" thành "dung".
  const sFull = foldVietnamese(prep(raw)).toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
  // R13: chữ CÒN DẤU dễ trùng khi bỏ dấu — "bơ" (bơ hạt điều) ≠ "bỏ", "quà" (quà tặng) ≠ "quả" — đổi trước khi bỏ dấu,
  // chỉ dùng cho luật NO_VARIANT.
  const sVariant = core(prep(raw.normalize('NFC').replace(/(?<![\p{L}])bơ(?![\p{L}])/giu, 'bow').replace(/(?<![\p{L}])quà(?![\p{L}])/giu, 'gift')));
  // Câu hỏi có/không: dấu "?" hay kết bằng "không/ko/k/hả/nhỉ" (sau khi bỏ lời gọi cuối câu "shop/em/ạ").
  const contentQuestion = raw.includes('?') || QUESTION_TAIL.test(sFull.replace(/(?: (?:em|e|shop|sop|chi|c|ban|b|nhe|nha|vay|v|oi|a|ah|ad))+$/, ''));
  const last = String(ctx.botLastTemplateId || '');
  const fresh =(SAFE_LAST.has(last) && !ctx.staffRepliedAfterBot) || Number(ctx.botLastAgeMin) > 1440;
  const orderAgeMin = Number.isFinite(ctx.orderAgeMin) ? ctx.orderAgeMin : Infinity;
  const phone = extractVietnamesePhone(raw);
  const isComment = ctx.source === 'comment';
  // R14 (ca …727620): kể hàng CHỖ KHÁC dở/hôi ("bữa mua một loại ở chổ khác mà về ăn ko ngon, bị hôi dầu") không phải than
  // hàng shop — không chặn luật đặt hàng (khách đang xin "1 túi dùng thử").
  const complaint = COMPLAINT.test(s) && !OTHER_SELLER.test(s);
  // Hỏi giá chung: bình luận → bảng giá của bài (luật bình luận); inbox → bảng giá sản phẩm ngữ cảnh / chung.
  const priceGeneral = rule => (isComment ? { rule, commentRule: true }
    : { rule, value: ctx.contextProduct ? { template_id: 'PRICE_QUOTE', Product_N1: ctx.contextProduct } : { template_id: 'GENERAL_INFO' } });
  // Đang nói về gói nhỏ (combo 10 gói) mà khách ghi "2 túi xanh": túi lớn hay combo gói nhỏ
  // chưa chắc, để mô hình đọc cả ngữ cảnh.
  // Vòng 12 (B3 #6): "loại có chia phần nhỏ nhỏ dùng 1 lần… túi vàng và túi xanh" hỏi gói nhỏ, không phải giỏ 2 túi zip.
  const smallPackAsk = INFO_RULES.find(([rule]) => rule === 'SMALL_PACK')[1].test(s) && !/\b(combo|hop) 10\b/.test(s) && !SMALL_PACK_ORDER(s);
  const basket = !complaint && !ctx.smallPackContext && !smallPackAsk && !TROPICAL_UNSURE.test(s) && orderAgeMin >= 60 && !PRICE.test(s) && !raw.includes('?') && !basketAmbiguous(raw) && typeof ctx.commentBasket === 'function'
    ? basketFrom(raw, ctx.commentBasket) : [];
  // Đang giữ giỏ & bot đang ở bước đơn: câu trả lời thông tin đi kèm nhắc giỏ (ORDER_ADDRESS + also).
  const heldStep = Boolean(ctx.hasBasket && (ctx.lastWasOrderStep || last === 'CONFIRM_YES'));
  const infoReply = (rule, templateId, extra = {}) => (heldStep
    ? { rule, value: { template_id: 'ORDER_ADDRESS', also: templateId }, ...extra }
    : { rule, value: { template_id: templateId }, ...extra });
  // Đơn còn mở (≤ 7 ngày, chưa hủy) để nói về hủy / khoan giao.
  const orderOpen = Boolean(ctx.hasRecentOrder) && orderAgeMin <= 7 * 24 * 60;
  // 03/10 (Mong Lý): "TN trước 1 túi xanh là 174.000₫ mà shop", "sao tin nhắn vừa rồi lại 189.000₫" — khách so giá túi
  // (bảng live) với tổng đã gồm ship → giải thích 174k + ship 15k = 189k, không phải "giá túi lẻ có điều chỉnh".
  const quoted = [...new Set([...sFull.matchAll(/\b(1[4-9]\d)(?: ?000|k)\b/g)].map(match => match[1]))];
  // R15 (inbox2 A5, ca …734430 "Đắt hơn túi zip à shop / Túi zip 450g mà 189.000(đã có ship)"): so giá GÓI NHỎ với túi zip lớn
  // ("gói nhỏ / túi zip / combo 10 / đắt hơn / rẻ hơn") không phải hỏi 174k + ship = 189k → không áp (để mô hình / nhân viên).
  if (!isComment && !phone && !complaint && quoted.length && sFull.length <= 120 && !/\b(shopee|tiktok|lazada|san|tren (nay|do|kia)|ben kia|cho khac)\b/.test(sFull)
    // R15 sửa (phản biện luật, THẤP): "đắt/mắc hơn" chỉ loại khi đi với gói nhỏ / túi zip / combo 10 (đã ở trên) — "174k mà
    // sao giờ 189k đắt hơn vậy" vẫn là hỏi 174k + ship.
    && !/\b(?:goi nho|tui zip|zip|combo 10|hop 10|10 goi)\b/.test(sFull)
    && (quoted.length >= 2 || /\b(truoc|vua roi|luc nay|hom qua|tin nhan|tn|khac|chenh|lech)\b|\bsao\b.*\blai\b|\bma\b/.test(sFull))) {
    return { rule: 'PRICE_SHIP_EXPLAIN', value: { template_id: 'PRICE_SHIP_EXPLAIN' } };
  }

  // ===== Vòng 12: luật đi trước mọi nhánh giỏ / luật thử =====
  // Sản phẩm chỉ CSKH bán (Siêu Hạt Premium 420g, granola hũ/lọ, hộp nhựa, mua hạt riêng — chủ shop 01/10): ghi nhận +
  // chuyển nhân viên (thẻ), không báo giá granola thay, không "mã gì" của live. Cả bình luận (tin riêng).
  const staffOnly = !complaint ? matchStaffOnlyProduct(raw) : null;
  if (staffOnly) return { rule: 'STAFF_ONLY', value: { template_id: 'STAFF_ONLY_PRODUCT', values: { product: staffOnly.name } }, attention: true };
  if (!isComment) {
    // Lo ngại hàng giả / nguồn gốc / hạn gần / "2 shop Giọt Nắng": người thật trả lời (CSKH, tắt bot → hết bám đuổi).
    if (TRUST_CONCERN.test(s) && !/\b(hang moi|date moi)\b/.test(s)) return { rule: 'TRUST_CONCERN', value: { template_id: 'CSKH_HANDOFF', warming: '1' }, attention: true };
    // Khách vừa nhận hàng mà nói tới vị/loại ("Chị vừa nhận hàg thấy 2 vị nguyên bản"): hỏi nhận đúng chưa, không lên đơn.
    // R16 (inbox3 A9, ca …8920916287 "Hạt mới và như quảng cáo mới nhận hàng nhé", chưa có đơn): "… MỚI nhận hàng" là ĐIỀU KIỆN nhận
    // hàng (đúng/như quảng cáo thì mới nhận) — không phải "vừa nhận hàng". Bỏ khi trước đó có từ điều kiện, hay khi chưa có đơn mà
    // "mới nhận hàng" đứng cuối câu kèm "nhé/nha".
    const receivedConditional = /\bmoi nhan (?:hang|hag|duoc hang|dc hang)\b/.test(s) && !/\bvua nhan\b/.test(s)
      && (/\b(?:neu|thi|nhu quang cao|nhu qc|giong quang cao|dung (?:hang|loai|nhu|mau)|phai|kiem tra|xem hang|dong kiem)\b.{0,40}\bmoi nhan\b/.test(s)
        || (!ctx.hasRecentOrder && /\bmoi nhan (?:hang|hag|duoc hang|dc hang)$/.test(s) && /\b(?:nhe|nha|nhen|nghe|nhak|nhe shop|nha shop)$/.test(sFull)));
    if (/\b(?:vua|moi) nhan (?:hang|hag|duoc hang|dc hang)\b/.test(s) && !phone && !receivedConditional) return { rule: 'RECEIVED_CHECK', value: { template_id: 'RECEIVED_CHECK' }, attention: true };
    // Hủy đơn / khoan giao khi có đơn còn mở: ≤ 60 phút bot hủy (ORDER_CANCEL tự kiểm còn hủy được không); lâu hơn,
    // hay kèm giỏ mới ("đặt loại 3 gói… hủy đơn 2 bịch"), hay khoan giao → ghi nhận + nhân viên (ghi chú vào đơn, thẻ).
    if (orderOpen && (CANCEL_ORDER.test(s) || HOLD_DELIVERY.test(s)) && !/\?|\b(?:duoc|dc) (?:khong|ko|k)\b/.test(s)) {
      if (HOLD_DELIVERY.test(s)) return { rule: 'ORDER_HOLD', value: { template_id: 'ORDER_HOLD_STAFF' }, attention: true, orderNote: 'Khách xin khoan giao / giữ đơn' };
      if (orderAgeMin <= 60 && !BASKET_MENTION.test(s.replace(/\b(?:huy|hy) don\b/, ' '))) return { rule: 'ORDER_CANCEL', value: { template_id: 'ORDER_CANCEL' }, attention: true };
      return { rule: 'ORDER_CANCEL_STAFF', value: { template_id: 'ORDER_CANCEL_STAFF' }, attention: true, orderNote: 'Khách xin hủy đơn' };
    }
    // Không có đơn trong hội thoại mà "hủy đơn" (đơn web/landing/POS) → nhân viên tra và hủy; "khoan giao" không giỏ → như trên.
    if (!orderOpen && !ctx.hasBasket && (/\b(?:huy|hy) don\b/.test(s) || HOLD_DELIVERY.test(s)) && !phone && !/\?/.test(raw)) {
      return { rule: HOLD_DELIVERY.test(s) ? 'ORDER_HOLD' : 'ORDER_CANCEL_STAFF', value: { template_id: HOLD_DELIVERY.test(s) ? 'ORDER_HOLD_STAFF' : 'ORDER_CANCEL_STAFF' }, attention: true };
    }
    // "khoan giao" khi chỉ đang giữ giỏ: hoãn (xóa giỏ) + thẻ, dừng bám đuổi.
    if (!orderOpen && ctx.hasBasket && HOLD_DELIVERY.test(s) && !phone) return { rule: 'ORDER_POSTPONED', value: { template_id: 'ORDER_POSTPONED' }, clearBasket: true, attention: true };
    // Ghi chú giao hàng cho đơn vừa đặt (< 24 giờ): ghi vào đơn (ORDER_NOTE → ORDER_NOTE_ADDED + noteOrderId).
    if (Number.isFinite(orderAgeMin) && orderAgeMin < 24 * 60 && DELIVERY_NOTE.test(s) && !phone && !/\?/.test(raw) && !/\b(huy|doi|them|bot|sua)\b/.test(s)) {
      return { rule: 'DELIVERY_NOTE', value: { template_id: 'ORDER_NOTE' } };
    }
    if (!phone) {
      // Câu hỏi đồng kiểm ("mua 3 gói có cho kiểm tra hàng trước khi thanh toán ko").
      if (/\b(?:kiem tra|kiem|dong kiem|xem) hang\b/.test(s) && !/\bdon\b/.test(s)) return infoReply('INSPECTION', 'INSPECTION_RETURN_POLICY');
      // "Liệu bóc ra có mùi hôi ko": câu HỎI (chưa nhận hàng) → trấn an + chính sách đổi; than có đơn thì để luồng khiếu nại.
      const smellAsk = /\b(?:mui hoi|hoi dau|bi hoi|co mui|mui la)\b/.test(s) && (POLICY_QUESTION.test(s) || QUESTION_TAIL.test(sFull) || /\b(lieu|co bi|co khi nao|co hay)\b/.test(s));
      // Hai câu hỏi một tin ("Bn gram 1túi và có bị hôi ko") để mô hình trả lời cả hai.
      if (smellAsk && !Number.isFinite(orderAgeMin) && !PRICE.test(s) && !/\b(gram|gam|gr|g|hsd|han)\b/.test(s)) return infoReply('OIL', 'OIL_SMELL_WARRANTY');
      // Đổi quà / không lấy quà ("Em kgg lấy quạt tặng em cái muỗng", "Ko lấy bát có trừ tiền ko"): GIFT_SWAP (quà thay 2 gói
      // nhỏ bất kỳ, không trừ tiền); engine ghi vào đơn đang mở + thẻ.
      // R13: "Mình mua 2b mà không lấy quà có được không" ("quà" còn dấu) cũng là GIFT_SWAP — trước đây ra NO_VARIANT.
      // R13 sửa (C1): giỏ/đơn đang xét KHÔNG có quà hiện vật (ctx.giftSwappable === false — giỏ 1–2 túi chỉ miễn ship) → không có
      // gì để đổi: nói chính sách quà (GIFT_POLICY), không hứa 2 gói nhỏ, không mở lượt chọn vị.
      if (GIFT_SWAP_ASK.test(s) || GIFT_DECLINE_RAW.test(raw.normalize('NFC'))) {
        return ctx.giftSwappable === false ? infoReply('GIFT_SWAP_NO_GIFT', 'GIFT_POLICY') : infoReply('GIFT_SWAP', 'GIFT_SWAP', { attention: true });
      }
      // Hỏi quà ("Bộ bát gì", "Tặng quạt jì", "quạt xem hình"): GIFT_POLICY theo ngữ cảnh (live/giỏ/ưu đãi) + ảnh quà (engine).
      if ((GIFT_QUESTION.test(s) || GIFT_PHOTO_RAW.test(raw.normalize('NFC'))) && !PRICE.test(s.replace(/\bbao nhieu (?:cai|bo|mon)\b/, ' '))) return infoReply('GIFT_QUESTION', 'GIFT_POLICY', { giftPhotos: true });
    }
  }

  // R14 (ca thật …958786, …195096): "Mình ko săn deal trên live" (phủ định), "Săn ntn ạh" (hỏi CÁCH săn), tin có giỏ
  // ("… / 1 xanh+1 nâu" — để luật giỏ / mô hình lên đơn) không phải "đã săn deal".
  if (ctx.livestream && !ctx.hasRecentOrder && !basket.length && !complaint && LIVE_DEAL.test(s) && !/\b(chua (nhan|thay|giao)|huy|khieu nai)\b/.test(s)
    && !LIVE_DEAL_NOT.test(s) && !BASKET_MENTION.test(s)) {
    return { rule: 'LIVE_DEAL', value: { template_id: 'LIVE_DEAL_CLAIMED' }, attention: true };
  }
  // Khiếu nại rõ (gọi không được, không ai gọi, bot "luyên thuyên", ăn phải sợ, thất vọng…): chuyển
  // người ngay, không để mô hình tra đơn hay giải thích sản phẩm (bộ chấm mẫu 26/09: 5 ca LLM chọn sai).
  // Câu hỏi chính sách ("có đổi trả không?") không phải khiếu nại.
  // Bỏ dấu thì "gói" (túi/gói hàng) trùng "gọi" (gọi điện) và "phần anh" trùng "phản ánh": đổi
  // "gói" trước gói nhỏ/lẻ/này/màu/số thành "túi", "gửi/cho/tặng phần anh" thành chữ khác, rồi mới so.
  const sComplaint = core(raw
    .replace(/gói/giu, 'tui')
    .replace(/\bgoi(?=\s+(?:nho|le|nay|xanh|vang|nau|mix|nhieu|\d))/giu, 'tui'));
  // R14 (quyết định 4, ca …377332 "Chị đã mua 1 lần nhưng ko đc như quảng cao / Mở ra bên trong toàn yến mạch là nhiều",
  // "Dỡ"): lời chê quảng cáo (chữ chen giữa) và "dở/dỡ" đứng riêng là khiếu nại → người thật.
  // R16: + chê hàng khác quảng cáo / ít hạt / toàn hạt gạo (AD_VS_REALITY).
  const adMismatch = AD_MISMATCH_COMPLAINT.test(sComplaint) || AD_VS_REALITY.test(sComplaint);
  const strongComplaint = STRONG_COMPLAINT.test(sComplaint) || adMismatch || COMPLAINT_REPORT.test(raw) || shortBadTaste(raw);
  // "phần anh xanh phần chị vàng", "mình rất sợ béo": có giỏ / không có từ khiếu nại rõ thì không phải khiếu nại.
  const basketNotComplaint = BASKET_MENTION.test(sComplaint) && !COMPLAINT_WORDS.test(sComplaint) && !adMismatch && !COMPLAINT_REPORT.test(raw);
  if (!isComment && strongComplaint && !basketNotComplaint && !POLICY_QUESTION.test(s)) {
    return { rule: 'COMPLAINT_HANDOFF', value: { template_id: 'CSKH_HANDOFF', warming: '1' }, attention: true };
  }
  // Khách hẹn dịp khác / rút ý định đặt ("bữa khác chốt", "thôi để sau", "xin lỗi shop, mình hủy"): đáp mềm,
  // engine xóa giỏ chờ (clearBasket). Đặt TRƯỚC ORDER_ASK (thử nghiệm) và trước luồng dùng thử của luật.
  // Đã có đơn thật thì "hủy" là hủy đơn → để mô hình / ORDER_CANCEL.
  // Vòng 10: rút giỏ đang giữ ("không lấy nữa", "xóa hết đó đi", "hủy giúp mình") khi chưa có đơn thật: cùng cách đáp.
  // Vòng 11 (P6): tin rút giỏ mà có nhắc màu/số túi ("xóa hết đi lấy 1 nâu thôi", "hủy túi xanh còn túi vàng",
  // "thôi không lấy vàng nữa") là ĐỔI giỏ, không xóa cả giỏ → để luật giỏ / mô hình.
  // R13 (inbox2 A3): (1) "Lần sau nếu ăn ngon mình sẽ mua ăn thường xuyên" / "lần sau mua tiếp" / "ủng hộ" không phải hoãn;
  // (2) chỉ HẸN dịp khác ("bữa khác chốt", "để sau") thì GIỮ giỏ (`keepBasket: true`, không `clearBasket`) để khách gửi
  // SĐT/địa chỉ là chốt được; có lời hủy rõ ("xin lỗi mình hủy", "không lấy nữa") mới xóa giỏ.
  // (Có lời hủy rõ — "xin lỗi mình hủy, lần sau ủng hộ shop" — thì vẫn là rút đơn.)
  const cancelAsk = raw.includes('?') || CANCEL_CONDITION.test(s);
  if (!isComment && !phone && CANCEL_BASKET.test(s) && CANCEL_GIFT.test(s) && !BASKET_MENTION.test(s)) return infoReply('GIFT_SWAP', 'GIFT_SWAP', { attention: true });
  const postponed = POSTPONED.test(s) && (!NOT_POSTPONED.test(s) || POSTPONE_CANCELS.test(s)) && !cancelAsk;
  if (!isComment && !ctx.hasRecentOrder && !ctx.trialOffer && !phone && (postponed || (ctx.hasBasket && s.length <= 60 && CANCEL_BASKET.test(s) && !cancelAsk && !BASKET_MENTION.test(s)))) {
    if (postponed && !POSTPONE_CANCELS.test(s)) return { rule: 'ORDER_POSTPONED', value: { template_id: 'ORDER_POSTPONED' }, keepBasket: true };
    return { rule: postponed ? 'ORDER_POSTPONED' : 'CANCEL_BASKET', value: { template_id: 'ORDER_POSTPONED' }, clearBasket: true };
  }
  // R13 (inbox2 B2): "nhầm" / "bấm nhầm" / "mình ấn nhầm thôi" khi đang giữ giỏ (giỏ Facebook Shop bấm nhầm — engine có thể
  // truyền ctx.shopCart khi giỏ Shop chưa thành pendingOrder): xóa giỏ + lời mềm (mẫu ORDER_POSTPONED), không mời lên đơn.
  if (!isComment && !ctx.hasRecentOrder && !phone && (ctx.hasBasket || ctx.shopCart) && s.length <= 60 && MISCLICK.test(s) && !BASKET_MENTION.test(s)
    && !/ăn\s+nhầm|nhận\s+nhầm|giao\s+nhầm|gửi\s+nhầm/iu.test(raw.normalize('NFC')) && !raw.includes('?')) {
    return { rule: 'CANCEL_BASKET_MISCLICK', value: { template_id: 'ORDER_POSTPONED' }, clearBasket: true };
  }
  // R15 (inbox3 A2, ca …659307 "Mình đặt của shop trên tiktok rồi"): khách báo ĐÃ đặt/mua trên sàn/web/app → cảm ơn ngắn
  // (BOUGHT_ON_MARKETPLACE), bỏ giỏ đang giữ, engine dừng bám đuổi; không xin SĐT tra đơn, không gắn thẻ. Đặt TRƯỚC ORDER_ASK.
  // Không áp: câu hỏi ("mua trên shopee được không", "?"), than đơn sàn chưa tới / hỏi giao tới đâu (ORDER_PLACED → ORDER_STATUS
  // như cũ), có SĐT, kể lần trước rồi muốn mua thêm ở đây ("lần trước mua shopee rồi, giờ lấy thêm…").
  // R15 sửa (phản biện luật #2): khiếu nại ("mua trên shopee rồi mà bị mốc") không thuộc luật này (ORDER_ASK + thẻ như cũ).
  if (!isComment && !phone && !raw.includes('?') && !complaint && !ctx.complaint && !strongComplaint) {
    const sBought = orderAskCore(raw);
    // ("Chị đặt ấp 3 rồi": "ấp" CÒN DẤU / "ap + số" là ấp — địa chỉ, không phải app.)
    const hamlet = /(?<![\p{L}])ấp(?![\p{L}])/iu.test(raw.normalize('NFC')) || /\bap \d/.test(sBought);
    if (!hamlet && BOUGHT_ELSEWHERE.test(sBought) && BOUGHT_ELSEWHERE_TAIL.test(sBought) && !ORDER_PLACED.test(sBought) && !BOUGHT_ELSEWHERE_NOT.test(sBought)) {
      return { rule: 'BOUGHT_ELSEWHERE', value: { template_id: 'BOUGHT_ON_MARKETPLACE' }, clearBasket: true };
    }
  }
  // --- Luật thử nghiệm: chỉ trả về khi ctx.experimentalRules === 'on'; còn lại các luật ổn định
  // vẫn chạy như cũ, kết quả thử được đính kèm ở `shadow` (engine ghi log so sánh).
  const experimental = (() => {
    if (!isComment && !complaint && !ctx.complaint && !phone && !ctx.trialOffer) {
      if (TERSE_HOW.test(s)) return { ...priceGeneral('TERSE_HOW'), experimental: true };
      // R14 (ca …727620): tin dài mà câu ĐẦU là xin dùng thử ("C lấy 1 túi đung thử đã nha. Vì c bữa mua một loại ở chổ khác
      // mà về ăn ko ngon…") → xét câu đầu, khi phần sau chỉ là lời kể (hàng chỗ khác / không hỏi, không giá, không giỏ).
      const trialText = s.length <= 60 ? s : trialHead(raw);
      const trialAsk = orderAgeMin >= 60 && !ctx.hasBasket && trialText && trialText.length <= 60 && (trialText.match(TRIAL_ASK) || trialText.match(TRIAL_ASK_B));
      if (trialAsk) {
        const colour = trialAsk[1] ? (trialAsk[1] === 'cacao' ? 'nau' : trialAsk[1]) : '';
        const product = colour ? colourSku(colour)?.name || '' : (productHintName(ctx.contextProduct) || quotedProductName(ctx.quotedProduct));
        return { rule: 'TRIAL_ASK', experimental: true, value: product ? { template_id: 'ORDER_ADDRESS', Product_N1: product, No_A: '1' } : { template_id: 'ASK_FLAVOR' } };
      }
    }
    // Hỏi đơn không SĐT ("chưa nhận được hàng" cũng là câu than → kèm thẻ cần người xem).
    // "đặt/mua/gửi" nằm trong chính câu hỏi ("đã đặt rồi sao chưa thấy") nên không loại theo ORDER_VERB.
    // R13 (inbox1 D4): "Em khong nhớ là em đặt hàng gì… gửi lại cho em xin mẫu" → tra đơn.
    // R14: so ORDER_ASK trên chuỗi đã bỏ "dạ" còn dấu ("Dạ mua 2 bich giá 189k thôi ạ" không phải "đã mua"); loại thêm
    // bịch/bit/hộp; đơn đặt trên app/web/sàn đang hỏi giao tới đâu (ORDER_PLACED) thì tra đơn dù tin dài / có số túi.
    const sOrder = orderAskCore(raw);
    const orderPlaced = ORDER_PLACED.test(sOrder) && !PRICE.test(sOrder);
    // R15 (inbox3 A2): "mua trên shopee được không" là HỎI có bán trên sàn không (chưa đặt) → không tra đơn.
    const marketplaceAsk = /\b(?:dat|mua) (?:tren|qua|o|bang) (?:app|ap|web|website|trang web|tiktok|tik tok|shopee|lazada|san)\b/.test(sOrder)
      && /\b(?:duoc|dc) (?:khong|ko|k|kg|hong)$|\b(?:duoc|dc) (?:khong|ko|k|kg|hong) (?:a|ah|shop|em|e|ban|b)$/.test(sOrder)
      && !/\b(?:da|roi|r|chua)\b/.test(sOrder);
    if (!isComment && !phone && !ctx.trialOffer && !marketplaceAsk && (orderPlaced || (s.length <= 70 && (ORDER_ASK.test(sOrder) || FORGOT_ORDER.test(s)) &&!/\b(lay|chot|cho (minh|em|e|chi|c) \d)\b/.test(s) && !/\b(xanh|vang|nau|cacao|combo|tui|goi|bich|bit|hop)\b/.test(s)))) {
      return { rule: 'ORDER_ASK', experimental: true, value: { template_id: 'ORDER_STATUS' }, ...(complaint || ctx.complaint ? { attention: true } : {}) };
    }
    // R16 (inbox5 A7, ca …2544865038 "Em ơi chưa rao cho chị à", đơn 30/09): "chưa giao/rao/gửi (hàng) cho chị (à/hả)" khi khách CÓ
    // đơn chưa hủy ≤ 14 ngày → tra đơn (ORDER_STATUS) + thẻ cần người xem; không có đơn thì để mô hình (có thể là đơn POS/web khác).
    if (!isComment && !phone && !ctx.trialOffer && ctx.hasRecentOrder && orderAgeMin <= 14 * 24 * 60 && s.length <= 60
      && /(?:^|\b)(?:(?:sao|sao lai|sao van|van|ma|the|vay|o|oi|em|e|shop) )*chua (?:giao|rao|gui|goi|ship|chuyen|thay giao)(?: (?:hang|don|do|hang hoa))?(?: (?:cho|toi|den|ve)(?: (?:chi|c|minh|em|e|toi|anh|a|co|chu|bac|nha))?)?(?: (?:a|ha|ah|ak|hả|sao|vay|nua|luon|the|ta))*$/.test(sOrder)
      && !/\b(?:xanh|vang|nau|cacao|combo|\d)\b/.test(s)) {
      return { rule: 'ORDER_NOT_DELIVERED', experimental: true, value: { template_id: 'ORDER_STATUS' }, attention: true };
    }
    // Luồng đơn tất định: chỉ SĐT / địa chỉ đủ / "địa chỉ cũ" khi bot đang xin thông tin và giỏ đã có
    // (order-flow.mjs) — bộ soạn đơn tự quyết bước tiếp, không cần mô hình.
    if (!complaint) {
      const flow = orderFlowStep(raw, { ...ctx, complaint: Boolean(ctx.complaint) });
      if (flow) return { ...flow, experimental: true };
    }
    return null;
  })();
  if (experimental && ctx.experimentalRules === 'on') return experimental;
  const stable = stableRules();
  if (experimental && stable) return { ...stable, shadow: experimental };
  if (experimental) return { ...experimental, shadowOnly: true };
  if (stable) return stable;
  // ===== R13 — luật ỨNG VIÊN K1/K1b/K3/K4/K5 (báo cáo mô hình quyết định, mục 3.B): đặt CUỐI chuỗi luật, chỉ xét khi không
  // luật nào ở trên bắt (ngay trước khi hỏi LLM). Cờ: ctx.candidateRules ('on' | 'shadow' | 'off') nếu engine truyền
  // (settings.candidateRules, mặc định nên là 'shadow'); engine CHƯA truyền thì theo cờ luật thử nghiệm hiện có
  // (ctx.experimentalRules). Không 'on' → trả `shadowOnly` (engine chỉ ghi log so với mô hình, vẫn hỏi LLM).
  // R15: cờ có thể là chuỗi (áp cho cả 5 luật) hay đối tượng theo từng luật ({ K1: 'on', K3: 'on', K4: 'on' } — thiếu khoá =
  // 'shadow'), xem candidateRuleMode.
  const candidateSetting = ctx.candidateRules ?? ctx.experimentalRules ?? 'shadow';
  if (candidateSetting === 'off') return null;
  const candidate = candidateRules();
  if (!candidate) return null;
  const candidateMode = candidateRuleMode(candidateSetting, CANDIDATE_KEYS[candidate.rule] || candidate.rule);
  if (candidateMode === 'off') return null;
  return candidateMode === 'on' ? { ...candidate, experimental: true, candidate: true } : { ...candidate, experimental: true, candidate: true, shadowOnly: true };

  function candidateRules() {
    if (complaint || ctx.complaint || ctx.trialOffer || phone || ctx.smallPackContext) return null;
    const recentOrder = Boolean(ctx.hasRecentOrder) && orderAgeMin < 60;
    // Nhân viên vừa nhắn sau bot (đang có người xử lý), hay bot vừa hỏi "cần bảng giá gói nhỏ không" (PACKAGING_INFO):
    // "xin giá" lúc đó không phải hỏi bảng giá chung → mô hình như cũ.
    // R15 (chủ shop 03/10 #12, inbox4 A4 "[ảnh] → Bn 1 túi này e ơi"): khách vừa gửi ảnh/tệp (bot vừa trả IMAGE_RECEIVED, hay
    // engine báo ctx.recentCustomerMedia) hoặc câu chỉ vào món cụ thể ("này / loại này / cái này") → hỏi giá MÓN trong ảnh,
    // không phải bảng giá chung: K1/K1b không bắt (mô hình đọc ảnh).
    const pointsAtItem = last === 'IMAGE_RECEIVED' || Boolean(ctx.recentCustomerMedia) || /\b(?:loai|cai|mau|tui|goi|bich|hop|sp|san pham|mon) nay\b/.test(sFull);
    const plainPrice = !pointsAtItem && !ctx.staffRepliedAfterBot && last !== 'PACKAGING_INFO' && s.length <= 40 && !SHORT_PRICE_OTHER.test(s) && !/\b[02-9]\b|\d{2,}/.test(s) && SHORT_PRICE.test(s);
    // K1 SHORT_PRICE: hỏi giá cụt KHÔNG cần ngữ cảnh "fresh" ("Giá sao", "Bn 1 túi e", "cho xin giá") khi không giỏ, không
    // đơn vừa đặt → bảng giá (sản phẩm ngữ cảnh / chung; bình luận → luật bình luận).
    if (plainPrice && !ctx.hasBasket && !recentOrder) return priceGeneral('K1_SHORT_PRICE');
    if (isComment) return null;
    // K1b: như trên khi ĐANG GIỮ GIỎ → cũng trả bảng giá; engine tự kèm câu nhắc giỏ đang giữ + tổng tiền + phần còn thiếu
    // (đã chạy thử: {ORDER_ADDRESS} trơn hay ý phụ GENERAL_INFO thì engine lại hỏi mô hình — không tiết kiệm được lượt nào).
    if (plainPrice && ctx.hasBasket && !recentOrder) return priceGeneral('K1B_SHORT_PRICE_HELD');
    // K3 QTY_HELD: đang giữ giỏ (một mã) mà khách chỉ nêu SỐ LƯỢNG ("Lấy 2 túi", "3 túi", "Số lượng là 2", "Chị lấy 2 mà",
    // "mình lấy tạm 1 túi thôi") → giữ bước đơn; bộ soạn đơn (chatbot-templates adjustOrderQuantities, dùng
    // quantityOnlyRequest) đặt lại số lượng cho mã đang giữ. Engine truyền ctx.basketCodeCount (số mã khác nhau trong giỏ):
    // khác 1 thì để mô hình hỏi lại vị nào; chưa truyền thì coi như một mã (giỏ nhiều mã: bộ soạn đơn giữ nguyên giỏ).
    if (ctx.hasBasket && !recentOrder && !raw.includes('?') && (ctx.basketCodeCount === undefined || Number(ctx.basketCodeCount) === 1)) {
      const quantity = quantityOnlyRequest(raw);
      if (quantity >= 1 && quantity <= 10) return { rule: 'K3_QTY_HELD', value: { template_id: 'ORDER_ADDRESS' }, setQuantity: quantity };
    }
    // K4 WANT_BUY+: "Mua", "Mua hàng", "mình muốn mua ngũ cốc" (không cần "fresh") khi không giỏ → bảng giá.
    // ("Mua đi" — lời giục, không rõ ý — vẫn để mô hình: core() đã cắt "đi" nên xét trên sFull.)
    if (!ctx.hasBasket && !recentOrder && !ctx.staffRepliedAfterBot && WANT_BUY_PLUS.test(s) && !/\bdi$/.test(sFull)) return priceGeneral('K4_WANT_BUY');
    // K5 FLAVOR_LIST khi ĐANG GIỮ GIỎ ("Có mấy vị", "Co loại j e", "Có mays lọi"): ở bước đơn → giữ bước đơn + kể 3 loại
    // (ý phụ BAG_COMPARISON — bảng giá chung GENERAL_INFO không đi kèm bước đơn được: engine đổi thành câu nhắc giỏ trơn /
    // ASK_TWO_BAGS); không ở bước đơn → bảng 3 vị. ("Xem mẫu" khi đang giữ giỏ là xin ảnh — luật PHOTOS.)
    if (ctx.hasBasket && !ctx.hasRecentOrder && FLAVOR_LIST.test(s) && !/mẫu/iu.test(raw.normalize('NFC'))) {
      return heldStep
        ? { rule: 'K5_FLAVOR_LIST_HELD', value: { template_id: 'ORDER_ADDRESS', also: 'BAG_COMPARISON' } }
        : { rule: 'K5_FLAVOR_LIST_HELD', value: { template_id: 'GENERAL_INFO', listAll: '1' } };
    }
    return null;
  }

  function stableRules() {
  // Đã có đơn cũ (> 60 phút, chưa hủy) mà khách "thêm … nữa": có thể là đơn mới hay sửa đơn cũ — không bắt
  // luật nào, để mô hình / ORDER_EXISTING_CONFIRM hỏi lại.
  if (ctx.hasRecentOrder && Number.isFinite(orderAgeMin) && orderAgeMin >= 60 && /\bthem\b.*\bnua\b|\bnua nhe\b/.test(s)) return null;
  // R15 (inbox1 A5 + quyết định chủ shop 03/10 #1): mặc cả / khách quen xin giảm ("3 tui ban cho e 400 c nha", "Khách quen có
  // giảm bớt k?", "Giảm thêm k", "bớt chút", "giảm giá cho chị") → không giảm giá; mẫu DISCOUNT_OATS_GIFT (giỏ ≥ 2 túi tặng yến
  // mạch, < 2 túi mời lên combo 2). Câu hỏi chương trình chung ("có chương trình giảm giá không", "có giảm giá không") vẫn
  // là DISCOUNT_POLICY (luật INFO bên dưới).
  // Câu nhắc quà ("không muốn lấy quà có được giảm giá thêm ko") để luật đổi quà / mô hình. Giỏ lớn (≥ 4 túi: "C mua 6 túi…
  // hỗ trợ giảm giá cho chị nha") thì kèm thẻ để nhân viên xem ưu đãi đơn lớn.
  // R15 sửa (phản biện luật #1): câu đọc được giỏ ("chị là khách quen, cho chị 2 túi xanh như cũ") để luật giỏ chạy — trừ khi
  // khách đưa giá ("bán cho e 400").
  if (!isComment && !phone && !complaint && !ctx.complaint && s.length <= 120 && isBargain(raw, s) && !/(?<![\p{L}])quà(?![\p{L}])/iu.test(raw.normalize('NFC')) && !CANCEL_GIFT.test(s)
    && !(basket.length && !BARGAIN_PRICE_OFFER.test(s))) {
    const bags = Number((s.match(/\b(\d{1,2}) (?:tui|bich|goi)\b/) || [])[1]) || 0;
    return { rule: 'DISCOUNT_ASK', value: { template_id: 'DISCOUNT_OATS_GIFT' }, ...(bags >= 4 ? { attention: true } : {}) };
  }
  // R15 (inbox4 A1, ca …068500 "Số lượng là 2" 2 phút sau đơn 1 Nâu — mô hình chọn ORDER_UNCHANGED "đơn đã lên rồi"): luật
  // K3b (ổn định, sửa lỗi — không qua cờ ứng viên). Đơn BOT tạo ≤ 60 phút, đơn MỘT mã, không giữ giỏ mới, khách chỉ nêu SỐ
  // LƯỢNG khác số trong đơn → ORDER_UPDATE + setQuantity (bộ soạn đơn đổi số lượng mã của đơn, adjustOrderQuantities).
  // Engine truyền ctx.recentOrderItems ([{ code|sku, quantity }] của đơn gần nhất) và ctx.recentOrderByBot (false = đơn nhân
  // viên/POS); thiếu recentOrderItems thì luật không chạy (như cũ).
  if (!isComment && !phone && !complaint && !ctx.complaint && ctx.hasRecentOrder && orderAgeMin < 60 && !ctx.hasBasket && ctx.recentOrderByBot !== false
    && Array.isArray(ctx.recentOrderItems) && ctx.recentOrderItems.length && !raw.includes('?')) {
    const codes = new Set(ctx.recentOrderItems.map(item => String(item?.code || item?.sku || '').toUpperCase()).filter(Boolean));
    const ordered = ctx.recentOrderItems.reduce((sum, item) => sum + (Number(item?.quantity) || 1), 0);
    const quantity = quantityOnlyRequest(raw);
    // R15 sửa (phản biện luật, THẤP): "Mua 2 túi shop ơi" / "đặt 3 túi" (động từ ĐẶT MỚI + số + đơn vị) có thể là đặt thêm — không
    // ghi đè số lượng đơn (để luồng đặt thêm / gộp-tách); "lấy 2 thôi", "số lượng là 2", "2 túi" vẫn là sửa số lượng. Đơn túi lớn
    // mà khách nói "gói" ("Mua 6 gói") là gói nhỏ → không áp.
    const sQty = core(raw);
    const newOrderVerb = /\b(?:mua|dat|lay)\b.{0,15}\b\d{1,2} ?(?:tui|goi|bich|bit|bi|cai)\b/.test(sQty) && !/\bthoi\b/.test(sQty) && !/\b(?:so luong|sl)\b/.test(sQty);
    const smallUnitOnBigOrder = /\bgoi\b/.test(sQty) && [...codes].every(code => /^GRA-/.test(code));
    if (codes.size === 1 && quantity >= 1 && quantity <= 10 && quantity !== ordered && !newOrderVerb && !smallUnitOnBigOrder) {
      return { rule: 'K3B_QTY_ORDER', value: { template_id: 'ORDER_UPDATE' }, setQuantity: quantity };
    }
  }
  // SĐT (± địa chỉ) khi CHƯA có giỏ và không nêu sản phẩm: khách bắt đầu đặt → ghi nhận, hỏi vị
  // (ORDER_INFO_ASK_FLAVOR). Ví dụ thật: "131/10B đường 6 linh Xuân thủ Đức tphcm <sdt>" sau ASK_FLAVOR
  // từng ra GENERAL_INFO. Ngoại lệ: sau WHOLESALE_CTV_CONTACT khách gửi số Zalo → WHOLESALE_RECEIVED + thẻ.
  if (!isComment && phone && !ctx.hasBasket && !ctx.trialOffer && !complaint && !ctx.complaint) {
    // Vòng 11: stripPhone giữ số nhà ngay sau SĐT ("0912345678 12 Lê Lợi…" không mất "12").
    const withoutPhone = stripPhone(raw);
    const phoneOnly = PHONE_ONLY.test(foldVietnamese(raw).toLowerCase())
      || core(withoutPhone).split(' ').filter(Boolean).every(word => /^(sdt|so|dt|dien|thoai|zalo|cua|minh|em|e|chi|c|anh|a|toi|day|la|ne|nay|nhe|nha|so zalo|lien|he|goi)$/.test(word));
    if (last === 'WHOLESALE_CTV_CONTACT' && phoneOnly) return { rule: 'WHOLESALE_RECEIVED', value: { template_id: 'WHOLESALE_RECEIVED' }, attention: true };
    const addressText = withoutPhone.replace(ADDRESS_LABELS, ' ').replace(/\s+/g, ' ').replace(/^[\s,.:;-]+|[\s,.:;-]+$/g, '').trim();
    const sAddress = core(addressText);
    const hasAddress = Boolean(addressText) && (ADDRESS_WORDS.test(sAddress) || Boolean(describeDeliveryAddress(addressText).resolved?.province));
    const asksOrder = ORDER_ASK.test(orderAskCore(raw)) ||/\b(don|kiem tra|tra giup|tra don|check|goi lai|goi cho)\b/.test(sAddress);
    if (hasAddress && !PRODUCT_MENTION.test(sAddress) && !asksOrder && orderAgeMin >= 60) {
      return { rule: 'ORDER_INFO', value: { template_id: 'ORDER_INFO_ASK_FLAVOR', Phone_Number: phone, Customer_Address: addressText } };
    }
    if (phoneOnly && SALES_LAST.has(last) && !ctx.hasRecentOrder && !ctx.staffRepliedAfterBot) {
      return { rule: 'ORDER_INFO', value: { template_id: 'ORDER_INFO_ASK_FLAVOR', Phone_Number: phone } };
    }
  }
  // R16 (inbox5 A5, ca …1420109502 "Gói mini có màu vàng kg e"; inbox2 M4, …0311942538 sau bảng giá Combo 10 gói "Trong video mình
  // thấy nhiều loại mà giờ chỉ có màu xanh thôi đúng k"): hỏi gói nhỏ / combo 10 gói có màu-vị nào → SMALL_PACK_FLAVOURS (mẫu vòng 15:
  // combo 10 gói nhỏ hiện chỉ còn vị Xanh). Câu có số (đặt hàng "1 hộp 10 gói xanh…") hay hỏi giá thì không.
  {
    const sPack = s.replace(/\b(?:(?:hop|combo|set|cb) ?10(?: goi)?(?: nho)?|10 goi(?: nho)?)\b/g, ' goi nho ');
    const packWord = /\b(?:goi nho|goi mini|tui mini|mini)\b/.test(sPack);
    const packContext = ctx.smallPackContext || last === 'PACKAGING_INFO' || (last === 'PRICE_QUOTE' && /combo 10|10 g[oó]i/iu.test(String(ctx.quotedProduct || '')));
    const asksColour = /\b(?:co|con|ban|lam) (?:(?:mau|vi|loai|goi|tui) )?(?:xanh|vang|nau|cacao)\b|\b(?:mau|vi) (?:xanh|vang|nau|cacao)\b.{0,12}\b(?:khong|ko|k|kg|hong|chua)\b|\b(?:may|nhung|cac) (?:mau|vi|loai)\b/.test(sPack);
    const onlyColour = /\bchi (?:co|con|ban) (?:(?:mau|vi|loai) )?(?:xanh|vang|nau|cacao)\b/.test(sPack);
    const asking = contentQuestion || CONFIRM_TAIL.test(sFull) || /\b(?:thoi|khong|ko|k|kg|hong|chua)$/.test(sFull);
    if (!isComment && !phone && !complaint && !PRICE.test(s) && !/\d/.test(sPack) && !ORDER_VERB.test(sPack) && asking && !/\b(?:quat|bat|muong|qua|tang)\b/.test(s)
      && ((packWord && (asksColour || onlyColour)) || (packContext && onlyColour))) {
      return { rule: 'SMALL_PACK_FLAVOURS', value: { template_id: 'SMALL_PACK_FLAVOURS' } };
    }
  }
  // R16 (inbox5 A4, ca …6592824143 "Combo 1 hộp 10 gói xanh và 1 túi vàng thì giá bao nhiêu"): hỏi giá GIỎ TRỘN (hộp/combo 10 gói +
  // túi lớn, có số lượng) → ORDER_ADDRESS với đủ các món: bộ soạn đơn tính tổng (328k miễn ship) và xin SĐT/địa chỉ — không gửi
  // bảng giá combo 10 gói (bỏ mất túi lớn) hay chuyển nhân viên.
  // (Chỉ Combo 10 gói Xanh — quyết định chủ shop 03/10 #6; khách ghi hộp màu khác thì để mô hình / nhân viên.)
  if (!isComment && !phone && !complaint && !ctx.hasBasket && PRICE.test(s) && orderAgeMin >= 60) {
    const packs = [...s.matchAll(/\b(\d{1,2}) (?:hop|combo|set) 10(?: goi)?(?: nho)?(?: (?:mau|vi))?(?: (xanh|vang|nau|cacao|cam|mix))?\b/g)];
    const bags = [...s.replace(/\b\d{1,2} (?:hop|combo|set) 10(?: goi)?/g, ' ').matchAll(/\b(\d{1,2}) (?:tui|bich|bit)(?: (?:mau|vi))? (xanh|vang|nau|cacao)\b/g)];
    const otherNumbers = s.replace(/\b\d{1,2} (?:hop|combo|set) 10(?: goi)?(?: nho)?(?: (?:mau|vi))?(?: (?:xanh|vang|nau|cacao|cam|mix))?\b/g, ' ')
      .replace(/\b\d{1,2} (?:tui|bich|bit)(?: (?:mau|vi))? (?:xanh|vang|nau|cacao)\b/g, ' ').match(/\d+/g);
    const pack = packs.length === 1 && (!packs[0][2] || packs[0][2] === 'xanh') ? getCatalogProducts().find(item => item.active !== false && /^CB10-XANH/i.test(String(item.sku || ''))) : null;
    const bag = bags.length === 1 ? colourSku(bags[0][2] === 'cacao' ? 'nau' : bags[0][2]) : null;
    if (pack && bag && !otherNumbers && !/\b(?:qua|tang|giam|uu dai|ship|sip|mien|free)\b/.test(s)) {
      return { rule: 'MIXED_PACK_PRICE', value: { template_id: 'ORDER_ADDRESS', Product_N1: pack.name, No_A: packs[0][1], Product_N2: bag.name, No_B: bags[0][1] } };
    }
  }
  // Sau PACKAGING_INFO ("cần em gửi bảng giá combo gói nhỏ không?") khách xin giá / "có" / hỏi combo 10,
  // hay bất kỳ lúc nào hỏi giá "combo 10 gói": bảng giá Combo 10 gói theo màu ngữ cảnh (mặc định Xanh).
  const smallPackFollowUp = last === 'PACKAGING_INFO' && !ctx.staffRepliedAfterBot && Number(ctx.botLastAgeMin) <= 720
    && !/\b(khong|ko|k|kg|hong|chua)\b/.test(s)
    && (PRICE.test(s) || /\b(combo 10|hop 10|10 goi|goi nho)\b/.test(s) || /^(co|ok|oke|okie|da|vang|u|uh|um|duoc|dc|gui|xem|can|co can)( (a|ah|em|e|shop|chi|c|nha|nhe|di|luon|xem|thu|minh|cho minh|giup|dum))*$/.test(s));
  if (!isComment && !phone && !ctx.hasBasket && (smallPackFollowUp || (/\b(combo|hop|set) 10( goi)?\b/.test(s) && PRICE.test(s)))) {
    const colour = /\b(nau|cacao)\b/.test(s) ? 'Nâu' : /\bcam\b/.test(s) ? 'Cam' : /\bmix\b/.test(s) ? 'Mix' : /\bxanh\b/.test(s) ? 'Xanh'
      : /nâu|cacao/i.test(String(ctx.contextProduct || '')) ? 'Nâu' : 'Xanh';
    // Vòng 11 (P3): PRICE_QUOTE + Product_N1 (như comboQuote của engine) — bộ soạn bảng giá tự chọn mẫu
    // PRICE_QUOTE_COMBO theo đơn vị "Combo" và điền giá; trả thẳng PRICE_QUOTE_COMBO thì bảng giá trống.
    return { rule: 'SMALL_PACK_PRICE', value: { template_id: 'PRICE_QUOTE', Product_N1: `Combo 10 gói ${colour}` } };
  }
  // R13 (inbox1 B1, inbox3 F5): "Gói cam bơ hạt điều. Bn e" — hỏi giá Gói Cam (vị bơ hạt điều) = Combo 10 gói Cam
  // (CB10-CAM-G30); trước đây "bơ hạt" bỏ dấu trùng "bỏ hạt" → NO_VARIANT. So trên chữ CÒN DẤU ("cảm ơn" ≠ "cam").
  // "túi cam lớn" (không có sản phẩm này) → để mô hình / nhân viên.
  if (!isComment && !phone && !complaint && PRICE.test(s) && s.length <= 60 && !/\b(xanh|vang|nau|cacao|mix|lon|to)\b/.test(s) && !/\b(?:[2-9]|1[1-9])\b/.test(s)
    && /(?<![\p{L}])(?:gói|goi|túi|tui|bịch|bich|vị|vi|loại|loai|granola|combo)\s+cam(?![\p{L}])|bơ\s+hạt\s+điều/iu.test(raw.normalize('NFC'))) {
    const cam = getCatalogProducts().find(item => item.active !== false && String(item.sku || '').toUpperCase() === 'CB10-CAM-G30');
    if (cam) return { rule: 'SMALL_PACK_PRICE', value: { template_id: 'PRICE_QUOTE', Product_N1: cam.name } };
    // R16 (chủ shop 03/10 #6: combo 10 gói chỉ còn Xanh — Gói Cam đã tắt trong danh mục): hỏi Gói Cam → báo combo gói nhỏ chỉ còn vị
    // Xanh (SMALL_PACK_FLAVOURS), không rơi sang LIVE_ONLY ("hạt điều") hay mô hình.
    return { rule: 'SMALL_PACK_FLAVOURS', value: { template_id: 'SMALL_PACK_FLAVOURS' } };
  }
  // R16 (inbox4 H4, ca …473537 "Cho mình giá của từng loại", "Đồng giá bằng nhau hả bạn?", …477320 "Có mấy loại organic ạ / Giá
  // sao ạ"): hỏi giá TỪNG/MỖI/CÁC loại, hay giá các loại có bằng nhau không → bảng 3 vị (GENERAL_INFO listAll — engine giữ nguyên
  // bảng 3 vị, không thay bằng bảng một túi). Không số, không màu, không gói nhỏ/hộp/Tropical/yến mạch/hạt (sản phẩm khác).
  if (!isComment && !phone && !complaint && !ctx.hasBasket && s.length <= 90 && !/\d/.test(s) && !/\b(?:xanh|vang|nau|cacao|mint|tropical|combo|hop|goi nho|nho|mini|yen mach|hat|nghe|bot|sua|kieng|calo|giam can|an kieng)\b/.test(s)
    && ((PRICE.test(s) && /\b(?:tung|moi|cac|tat ca(?: cac)?|may|nhung|bao nhieu) (?:loai|vi|mau|tui|sp|san pham|mat hang)\b/.test(s))
      || /\bdong gia\b|\bgia (?:co )?(?:bang nhau|nhu nhau|giong nhau|khac nhau)\b|\b(?:loai|vi|mau|tui) .{0,15}\bgia (?:co )?khac\b|\b(?:gia|tien) .{0,10}\bbang nhau\b/.test(s))) {
    return { rule: 'PRICE_EACH', value: { template_id: 'GENERAL_INFO', listAll: '1' } };
  }
  // R16 (inbox4 T1 "Lay 2 tui mà 2vị dc k ah", "2 túi 2 vị được ko e"): hỏi 2 túi 2 vị (chưa nêu màu) → hỏi vị (mix được), không
  // dựng giỏ 2 túi một vị. Có màu thì để luật giỏ / mô hình.
  // (Câu khẳng định "2 túi 2 vị", "lấy 2 túi khác vị" do luật TWO_FLAVOURS bên dưới — ở đây chỉ câu HỎI "… được không / ?".)
  if (!isComment && !phone && !complaint && !ctx.hasBasket && orderAgeMin >= 60 && !PRICE.test(s) && !/\b(?:xanh|vang|nau|cacao|mint|tropical)\b/.test(s)
    && (contentQuestion || /\b(?:duoc|dc) (?:khong|ko|k|kg|hong)\b|\b(?:duoc|dc) (?:khong|ko|k|kg|hong)?$/.test(sFull))
    && /\b(?:2|hai) (?:tui|goi|bich|bit)\b.{0,12}\b(?:2|hai) (?:vi|loai|mau)\b|\b(?:2|hai) (?:tui|goi|bich|bit) (?:(?:ma|nhung|la|thi|lay|chon|duoc|dc) )*(?:khac|mix) (?:vi|loai|mau|nhau)\b/.test(s)) {
    return { rule: 'TWO_FLAVOURS_ASK', value: { template_id: 'ASK_FLAVOR' } };
  }
  // R13 (inbox3 F5, inbox1 B3): hỏi giá + từ 2 vị túi lớn ("Giá của túi xanh và vàng", "Lấy tui vàng và nâu thi giá sao",
  // "2 gói 1 vàng 1 xanh giá bn e") → bảng giá mix túi lớn (PRICE_MIX_TUI_LON), không so sánh túi / không bảng một túi.
  // Chỉ khi mỗi vị không quá 1 túi (số trong câu chỉ là "1", hay "2 túi/gói" = số vị), không kèm giá tiền, gói nhỏ, hộp,
  // yến mạch, Tropical, miễn ship; tin là địa chỉ ("… Gia Lâm") thì không.
  {
    const sMix = core(prep(maskPlaceGia(raw)));
    const mixColours = new Set((sMix.match(/\b(xanh|vang|nau|cacao)\b/g) || []).map(colour => (colour === 'cacao' ? 'nau' : colour)));
    const restNumbers = sMix.replace(new RegExp(`\\b${mixColours.size} ?(?:tui|goi|bich|bit|loai|vi|mau)\\b|\\bcombo ${mixColours.size}\\b`, 'g'), ' ').match(/\d+/g) || [];
    if (!isComment && !phone && !complaint && !ctx.complaint && orderAgeMin >= 60 && mixColours.size >= 2 && sMix.length <= 90 && PRICE.test(sMix.replace(/\bgia dinh\b/g, ' '))
      // Đang ở bước đơn với giỏ đang giữ ("1 xanh 1 vàng tổng nhiêu em") → mô hình trả dòng giỏ + tổng như cũ; hỏi trọng
      // lượng ("Xanh 450 g vàng bao nhiêu g") không phải hỏi giá.
      && !(ctx.hasBasket && ctx.lastWasOrderStep) && !/\b(?:bao nhieu|bn|may|nhieu) ?(?:gam|gram|gr|g|kg|ky|calo|kcal)\b/.test(sMix)
      && restNumbers.every(number => number === '1') && !ctx.smallPackContext && !smallPackAsk && !TROPICAL_MENTION.test(sMix) && !FREESHIP_ANY.test(sMix)
      // Hai câu hỏi một tin ("1 túi xanh 1 túi vàng giá bn ạ / Đc quà gì ạ") để mô hình trả lời cả hai.
      && !/\bgoi nho\b|\b(hop|set|yen mach|cam|mint|hat dieu|sua|doi|thay|huy|qua|tang|giam|uu dai|khuyen mai|km|voucher)\b/.test(sMix) && !CONFIRM_TAIL.test(sFull) && !looksLikeAddressMessage(raw)) {
      return { rule: 'PRICE_MIX', value: { template_id: 'PRICE_MIX_TUI_LON' } };
    }
  }
  // "vị nguyên bản" / "truyền thống" khi đang chọn vị (sau ASK_FLAVOR, bước đơn, hay đang giữ giỏ): nguyên bản
  // có 2 túi (Xanh, Vàng) → hỏi tiếp, không gửi bảng giá.
  if (!isComment && /\b(nguyen ban|truyen thong)\b/.test(sFull) && !/\b(xanh|vang|nau|cacao)\b|\d|\bla (sao|gi)\b|khac/.test(sFull) && sFull.length <= 40
    && (ORDER_STEPS.has(last) || ctx.lastWasOrderStep || ctx.hasBasket)) {
    return { rule: 'NGUYENBAN', value: { template_id: 'ASK_FLAVOR_NGUYENBAN' } };
  }
  // "mua ở đâu / mua thế nào": đặt ngay tại đây (ORDER_HELP); nhắc sàn/link mới là ECOMMERCE_LINKS (luật LINKS).
  if (!isComment && HOW_TO_BUY.test(s) && !MARKETPLACE.test(s) && !phone) return { rule: 'HOW_TO_BUY', value: { template_id: 'ORDER_HELP' } };
  // Vòng 12 (B3 #5, chủ shop 01/10): "lấy 1 túi thử nếu miễn ship mình chốt" NGOÀI cửa sổ ưu đãi 36 giờ (trialOffer lo phần
  // trong cửa sổ): 1 túi vẫn tính phí ship, mời combo 2 túi miễn ship (FREESHIP_POLICY) — không tự cho miễn ship.
  if (!isComment && !phone && !ctx.trialOffer && FREESHIP_ANY.test(s) && /\b(?:1|mot) (?:tui|goi|bich)\b|\b(?:dung|an|lay|mua) thu\b/.test(s) && /\b(?:chot|lay|dat|mua|neu|thi|duoc|dc)\b/.test(s)) {
    return infoReply('TRIAL_CONDITION', 'FREESHIP_POLICY');
  }
  // Vòng 12 (B3 #14): so giá sàn ("Trên này bn có 159k mà", "shopee rẻ hơn") → PRICE_COMPARE (voucher/trợ giá sàn khác;
  // Page có combo miễn ship + quà riêng).
  if (!isComment && !phone && (/\b(?:shopee|tiktok|lazada|tren san|ben san|tren (?:nay|do|kia)|ben kia|cho khac)\b.{0,40}(?:\b\d{2,3} ?k\b|\b(?:re|mac|dat) hon\b|\bgia khac\b|\bchenh\b)/.test(s) || /\b(?:re|mac|dat) hon\b.{0,30}\b(?:shopee|tiktok|lazada|san|tren mang)\b/.test(s))) {
    return { rule: 'PRICE_COMPARE', value: { template_id: 'PRICE_COMPARE' } };
  }
  // Vòng 12 (B2 #12): "Lần trước ship toàn túi vàng" → hỏi lần này lấy loại nào, mấy túi (không chuyển CSKH).
  const reorder = s.match(/\blan truoc\b.{0,30}\btoan (?:tui |bich |goi )?(vang|xanh|nau|cacao)\b/);
  if (!isComment && !phone && reorder && !COMPLAINT_WORDS.test(s)) {
    const product = colourSku(reorder[1] === 'cacao' ? 'nau' : reorder[1]);
    return { rule: 'REORDER', value: { template_id: 'ASK_REORDER', values: { previous: product?.name || 'loại cũ' } } };
  }
  // Vòng 12 (B3 #30): "combo 2" / "lấy combo 3" không nêu vị → hỏi vị (không mặc định 2 Xanh).
  if (!isComment && !phone && !ctx.hasBasket && /^(?:(?:lay|cho|dat|mua|chot) (?:(?:em|minh|chi|c|e|anh|a|mk) )?)?combo ?(?:2|3|hai|ba)$/.test(s)) {
    return { rule: 'COMBO_NO_FLAVOR', value: { template_id: 'ASK_FLAVOR' } };
  }
  // Vòng 12 (B1 #12, B2 #11/#21, B3 #4): "3 túi bao nhiêu" → 447k + quà; "Lấy 4 túi có ưu đãi ko" → 596k (giá giỏ lớn của
  // bảng giá, BOT-C); "1 túi màu vàng giá như nào" → 1 túi + ship = tổng, mời lên 1 túi (engine giữ giỏ 1 túi).
  // Không áp khi kèm "miễn ship nữa hả" (câu hỏi điều kiện, để mô hình), gói nhỏ/hộp 10/set, hay nhiều màu.
  // R16 (inbox4 H4 "Mua 2g thì bn tiền"): "2g" (một chữ số + g, câu không nói gam/kg) là 2 gói.
  const sCount = /\b(?:gam|gram|gr|kg|ky|ki|can nang|trong luong)\b/.test(s) ? s : s.replace(/\b([1-9]) ?g\b/g, '$1 goi');
  const countMatch = sCount.match(/\b(\d{1,2}|hai|ba|bon|nam|sau) (?:tui|bich|goi)\b/);
  const askedCount = countMatch ? ({ hai: 2, ba: 3, bon: 4, nam: 5, sau: 6 }[countMatch[1]] || Number(countMatch[1])) : 0;
  const askedColours = [...new Set(s.match(/\b(xanh|vang|nau|cacao)\b/g) || [])].map(colour => (colour === 'cacao' ? 'nau' : colour));
  const sNoFamily = s.replace(/\bgia dinh\b/g, ' ');
  // R15 (inbox1 A5): xin giảm / mặc cả / khách quen không phải hỏi giá combo → không PRICE_COUNT (luật DISCOUNT_ASK ở trên).
  const bargain = isBargain(raw, s);
  const priceish = (PRICE.test(sNoFamily) || (askedCount >= 3 && /\b(uu dai|giam|khuyen mai|km|duoc gi|qua gi)\b/.test(s)))
    && !INFO_RULES.find(([rule]) => rule === 'COMBO3')[1].test(s) && !bargain;
  if (!isComment && !phone && priceish && askedCount >= 1 && askedColours.length <= 1 && !ctx.smallPackContext && !smallPackAsk && !TROPICAL_MENTION.test(s)
    && !/\b(10|muoi) goi\b|\bgoi nho\b|\b(hop|set|mix)\b/.test(s) && !FREESHIP_ANY.test(s) && (s.match(/\b\d{1,2} ?(?:tui|bich|goi)\b/g) || []).length <= 1) {
    if (askedCount === 1 && askedColours.length === 1) {
      const one = bagCountQuote(1, askedColours[0], Boolean(ctx.livestream));
      const two = bagCountQuote(2, askedColours[0], Boolean(ctx.livestream));
      if (one && two) {
        return { rule: 'PRICE_ONE_BAG', holdBasket: { product: one.product.name, quantity: 1 }, value: { template_id: 'PRICE_ONE_BAG', values: { product: one.product.name, price: money(one.priced.subtotal), ship: one.priced.shippingFee ? money(one.priced.shippingFee) : '', total: money(one.priced.total), two_total: money(two.priced.total) } } };
      }
    }
    // R16 (inbox3 A7, inbox4 H4: "2 túi giá sao e", "Mua hai gói ngũ cốc giá như nào", "Lấy 2 túi giá com bo", "Mua 2g thì bn"):
    // đúng 2 túi cũng báo giá combo 2 (298k miễn ship, nêu Nâu thì 288k; live có quà) và hỏi vị — không gửi cả bảng giá rồi hỏi lại
    // "2 túi hay 1 túi". Câu hỏi kèm trọng lượng ("2 túi trọng lượng bn và bn tiền") → ý phụ WEIGHT_EXPIRY.
    // Riêng 2 túi (luật mới, giữ nguyên hành vi ≥ 3 túi): không áp khi chữ giá chỉ là "tổng (cộng)" ("tổng cộng là 2 túi vàng" — xác
    // nhận giỏ), khi khách tự đưa giá khác giá combo ("Dạ mua 2 bịch giá 189k thôi ạ") hay câu còn hỏi ưu đãi/quà/giảm (hai ý → mô hình).
    const twoBagsOk = askedCount !== 2 || (PRICE.test(sNoFamily.replace(/\btong(?: cong)?\b/g, ' '))
      && !/\b(?:giam|uu dai|khuyen mai|km|qua|tang|voucher)\b/.test(s));
    if (askedCount >= 2 && askedCount <= 10 && twoBagsOk) {
      const quote = bagCountQuote(askedCount, askedColours[0] || 'xanh', Boolean(ctx.livestream));
      const quotedK = Math.round(Number(quote?.priced?.total || 0) / 1000);
      const otherPrice = askedCount === 2 && (s.match(/\b\d{3}(?= ?(?:k|nghin|ngan|000)\b|\b)/g) || []).some(value => value !== '000' && ![quotedK, 450, 350, 300].includes(Number(value)));
      if (quote && !otherPrice) {
        const gift = (quote.priced.gifts || []).filter(item => !isFreeShippingGift(item)).map(item => item.name).join(' + ');
        const values = { count: String(askedCount), total: money(quote.priced.total), ship: quote.priced.shippingFee ? money(quote.priced.shippingFee) : '', free: quote.priced.shippingFee ? '' : '1', gift, kind: askedColours.length ? quote.product.name : 'túi Xanh / Vàng mix tùy ý',
          // R15 (inbox1 A5): đã nêu màu → mẫu không hỏi lại "vị nào" (named); chưa nêu → hỏi vị (pick). Mẫu PRICE_COUNT dùng
          // [?named]…[/?][?pick]…[/?] (agent mẫu); mẫu cũ bỏ qua hai giá trị này.
          ...(askedColours.length ? { named: '1' } : { pick: '1' }) };
        const weight = /\btrong luong\b|\b(?:bao nhieu|bn|may|nhieu) ?(?:gam|gram|gr|g)\b|\bnang (?:bao nhieu|bn)\b/.test(s) ? { also: 'WEIGHT_EXPIRY' } : {};
        return { rule: 'PRICE_COUNT', value: { template_id: 'PRICE_COUNT', values, ...weight }, ...(quote.priced.giftNote ? { attention: true } : {}) };
      }
    }
  }
  // "4/5/6 túi giá bao nhiêu": ngoài bảng combo → ghi nhận, nhân viên tính ưu đãi (thẻ cần người xem).
  // R16 (inbox1 A2, ca …2228960004 "Vậy tổng là 5 túi, tặng 1 túi vàng + 1 bộ bát, thìa đúng ko shop" khi đang giữ giỏ): hỏi lại
  // tổng có đuôi xác nhận là xác nhận giỏ (CONFIRM_SUMMARY bên dưới), không dựng giỏ mới; màu đứng sau "tặng" là quà, không đếm.
  const confirmHeld = ctx.hasBasket && CONFIRM_TAIL.test(sFull);
  if (!isComment && !phone && PRICE.test(s) && BIG_BASKET.test(s) && !ctx.smallPackContext && !confirmHeld) {
    const [, count] = s.match(BIG_BASKET);
    const quantity = { bon: 4, nam: 5, sau: 6 }[count] || Number(count);
    const colours = [...new Set(s.replace(/\b(?:tang|qua)(?: (?:them|kem|cho))?(?: \d{1,2})?(?: (?:tui|goi|bich))?(?: (?:mau|vi))? (?:xanh|vang|nau|cacao)\b/g, ' ').match(/\b(xanh|vang|nau|cacao)\b/g) || [])].map(colour => (colour === 'cacao' ? 'nau' : colour));
    const product = colours.length === 1 ? colourSku(colours[0]) : null;
    const value = { template_id: 'ORDER_CUSTOM_BASKET', values: { cart: `${quantity} ${product ? product.name : 'túi'}` } };
    if (product) Object.assign(value, { Product_N1: product.name, No_A: String(quantity) });
    return { rule: 'BIG_BASKET', value, attention: true };
  }
  // Vừa đặt (< 60 phút) mà dặn "hàng mới"/"date mới": ghi chú vào đơn, không giải thích độ mới (FRESHNESS).
  if (!isComment && !phone && Number.isFinite(orderAgeMin) && orderAgeMin < 60 && /\b(hang|date) moi\b/.test(s) && s.length <= 60 && !/\?|\b(khong|ko|k)$/.test(s)) {
    return { rule: 'FRESH_NOTE', value: { template_id: 'ORDER_NOTE_ADDED', values: { note: 'hàng mới', fresh: '1' } } };
  }
  // "combo 2 túi" / "2 túi" / "M lấy 1 túi" / "Mình 3 túi nhé" không nêu vị: hỏi vị trước, không tự chốt 2 Xanh.
  // Đang giữ giỏ thì "1 túi thôi" có thể là bớt túi → mô hình. (Vòng 10 mở rộng từ TWO_BAGS_NO_FLAVOR.)
  // "1 túi miễn ship hả" là câu hỏi (FREESHIP_POLICY); "2 túi 298k miễn ship" là đặt.
  if (!isComment && !ctx.hasBasket && !phone && orderAgeMin >= 60 && !QUESTION_TAIL.test(sFull) && BAGS_NO_FLAVOR.test(s)
    && !(/^(?:\D*\b1 ?(?:tui|goi|bich|bit|bi|bao)\b)/.test(s) && FREESHIP_MENTION.test(s))) {
    // R16 (inbox1 A6, ca …3097056526 "Túi xanh" → bảng giá Xanh → "Ok lấy cho chị 2 túi nha"): tin khách NGAY TRƯỚC (≤ 15 phút) chỉ
    // chọn đúng MỘT màu → N túi màu đó, không hỏi lại vị. Engine truyền ctx.recentCustomerTexts (tin chữ gần nhất của khách, cũ → mới;
    // chuỗi hay { text, at|createdAt }); thiếu thì như cũ (hỏi vị).
    const named = previousNamedColour(ctx.recentCustomerTexts, raw);
    const bags = Number((s.match(/\b([1-3]) ?(?:tui|goi|bich|bit|bi|bao)\b/) || [])[1]) || 0;
    const product = named && bags ? colourSku(named) : null;
    if (product) return { rule: 'BAGS_NAMED_BEFORE', value: { template_id: 'ORDER_ADDRESS', Product_N1: product.name, No_A: String(bags) } };
    return { rule: 'BAGS_NO_FLAVOR', value: { template_id: 'ASK_FLAVOR' } };
  }
  // Vòng 10: "3 túi 3 vị" / "mỗi vị 1 túi" / "3 túi xanh vàng nâu" → 1 Xanh + 1 Vàng + 1 Nâu; "2 túi 2 vị" → hỏi vị.
  // Câu hỏi ("combo 3 túi khác nhau được không", "3 túi khác nhau thế nào") hay xin tư vấn ("tư vấn cả 3 vị") để
  // luật COMBO3 / RECOMMEND / mô hình.
  const politeAsk = ((POLICY_QUESTION.test(s) || QUESTION_TAIL.test(sFull)) && !ORDER_VERB.test(s)) || /\b(the nao|ntn|nhu nao|la sao|la gi|khac gi|ra sao|hay)\b/.test(s) || ADVICE_ASK.test(s);
  if (!isComment && !complaint && orderAgeMin >= 60 && !PRICE.test(s) && !raw.includes('?') && !politeAsk && s.length <= 80 && !BASKET_CHANGE.test(s)) {
    const three = THREE_FLAVOURS.test(s) || (s.match(THREE_COLOURS) && new Set(s.match(THREE_COLOURS).slice(1, 4)).size === 3);
    // R13 (models A2, ca …407413): "Vàng nhiều hạt và xanh nguyên bản / Mỗi loại 1 túi" — tin nêu ĐÚNG 2 màu và không có
    // "3/ba" → giỏ 2 túi (1 + 1 hai màu vừa nêu), không phải 3 túi 442k.
    const namedColours = [...new Set((s.match(/\b(xanh|vang|nau|cacao)\b/g) || []).map(colour => (colour === 'cacao' ? 'nau' : colour)))];
    if (three && namedColours.length === 2 && !/\b3\b|\bba\b/.test(s)) {
      const [first, second] = namedColours.map(colourSku);
      if (first && second) {
        const value = { template_id: 'ORDER_ADDRESS', Product_N1: first.name, No_A: '1', Product_N2: second.name, No_B: '1' };
        if (phone) value.Phone_Number = phone;
        return { rule: 'TWO_NAMED_FLAVOURS', value };
      }
    }
    if (three) {
      const [xanh, vang, nau] = ['xanh', 'vang', 'nau'].map(colourSku);
      if (xanh && vang && nau) {
        const value = { template_id: 'ORDER_ADDRESS', Product_N1: xanh.name, No_A: '1', Product_N2: vang.name, No_B: '1', Product_N3: nau.name, No_C: '1' };
        if (phone) value.Phone_Number = phone;
        return { rule: 'THREE_FLAVOURS', value };
      }
    }
    if (!phone && !ctx.hasBasket && TWO_FLAVOURS.test(s)) return { rule: 'TWO_FLAVOURS', value: { template_id: 'ASK_FLAVOR' } };
  }
  for (const [pattern, target] of ICEBREAKERS) {
    if (!pattern.test(s)) continue;
    if (target === 'price') return priceGeneral('ICEBREAKER');
    return { rule: 'ICEBREAKER', value: { template_id: target, ...(target === 'PRODUCT_PHOTOS' && ctx.contextProduct ? { Product_N1: ctx.contextProduct } : {}) } };
  }
  if (fresh && /^[\s.…,?!]+$/.test(raw)) return priceGeneral('DOTS');
  if (fresh && !phone && (TERSE_A.test(s) || TERSE_B.test(s) || TERSE_C.test(s))) return priceGeneral('TERSE_PRICE');
  // Vòng 12 (B5 #4): cùng các câu hỏi giá cụt nhưng có tiền tố ("Chị cho em xin giá", "alo giá sao") hay dạng TERSE_D.
  // "giá các mặt hàng / các sp" → liệt kê đủ các vị (engine không thay bằng bảng một túi).
  const sp = s.replace(PRICE_LEAD, '');
  if (fresh && !phone && sp && sp !== s && (TERSE_A.test(sp) || TERSE_B.test(sp) || TERSE_C.test(sp))) return priceGeneral('TERSE_PRICE');
  if (fresh && !phone && !/\b(xanh|vang|nau|cacao|combo|yen mach|mint|hat)\b/.test(s) && TERSE_D.test(sp)) {
    const general = priceGeneral('TERSE_PRICE_D');
    return /\bcac (?:mat hang|sp|san pham|loai)\b/.test(sp) && general.value ? { ...general, value: { template_id: 'GENERAL_INFO', listAll: '1' } } : general;
  }
  if (!isComment && fresh && GREETING.test(s)) return { rule: 'GREETING', value: { template_id: 'WELCOME' } };
  if (fresh && WANT_BUY.test(s)) return priceGeneral('WANT_BUY');
  // SĐT trơn khi đang chờ đơn: bộ soạn đơn tự đọc SĐT, gộp giỏ, đủ thì tự xác nhận.
  if (ctx.hasBasket && ctx.lastWasOrderStep && phone && PHONE_ONLY.test(foldVietnamese(raw).toLowerCase())) {
    return { rule: 'PHONE_ONLY', value: { template_id: 'ORDER_ADDRESS' } };
  }
  const basketValue = items => {
    const slots = ['Product_N1', 'No_A', 'Product_N2', 'No_B', 'Product_N3', 'No_C'];
    const value = { template_id: 'ORDER_ADDRESS' };
    items.slice(0, 3).forEach((item, index) => { value[slots[index * 2]] = item.product; value[slots[index * 2 + 1]] = String(item.quantity); });
    return value;
  };
  // Vòng 11 (P7): đang giữ giỏ mà khách "lấy thêm 1 túi nâu": món vừa nêu CỘNG vào giỏ đang giữ (add_to_basket,
  // bộ soạn đơn cộng dồn một lần), không thay giỏ. "đổi/thay/chỉ lấy/bớt" thì vẫn là giỏ mới.
  // Vòng 12 (B3 #6): hỏi loại chia phần nhỏ / dùng 1 lần → PACKAGING_INFO trước luật giỏ.
  if (!isComment && !phone && smallPackAsk && !PRICE.test(s) && !ctx.smallPackContext) return infoReply('SMALL_PACK', 'PACKAGING_INFO');
  if (basket.length) {
    const adds = ctx.hasBasket && /\b(them|cong them)\b/.test(s) && !/\b(doi|thay|chi lay|chi can|bot)\b/.test(s);
    return { rule: 'BASKET', value: { ...basketValue(basket), ...(adds ? { add_to_basket: '1' } : {}) } };
  }
  // Vòng 10: giỏ + địa chỉ (± SĐT) trong một tin ("1 túi xanh, 1 túi vàng Võ Thị Ngân tổ 13 ấp…", "Ship cho c 1 túi
  // xanh và 1 túi vàng. Hường- <sđt> HA02-17 Vinhomes…") → ORDER_ADDRESS đủ slot, bộ soạn đơn chốt hay hỏi phần thiếu.
  // Giỏ + "gửi địa chỉ cũ" → SĐT/địa chỉ lấy từ đơn trước ('0'); không có đơn trước thì để mô hình.
  if (!complaint && !isComment && orderAgeMin >= 60 && !ctx.smallPackContext && !raw.includes('?') && typeof ctx.commentBasket === 'function') {
    // Từ đổi/hủy chỉ xét ở phần giỏ: địa chỉ có thể chứa "Huy" (xã Dương Huy), "Bột"…
    const found = splitBasketAddress(raw);
    const split = found && !/\b(doi|huy|hy|bot|thay|khong lay|ko lay|k lay)\b/.test(core(prep(found.basket))) ? found : null;
    const sBasket = split ? core(prep(split.basket)) : '';
    const items = split && split.signal === 'colour' && !PRICE.test(sBasket) && !basketAmbiguous(split.basket) ? basketFrom(split.basket, ctx.commentBasket) : [];
    // Số túi không màu + địa chỉ ("bạn gửi cho mình 2 túi nhé. Thôn Đồng Tiến, xã Dương Huy…"): giữ địa chỉ (± SĐT)
    // vào giỏ chờ, bộ soạn đơn hỏi vị (ASK_FLAVOR vì tin có "2 túi"). Chỉ khi chưa giữ giỏ.
    // R14 (ca …603949): đơn đã đặt trên app/web/sàn đang hỏi giao tới đâu → không phải "N túi + địa chỉ".
    if (split && split.signal === 'count' && !ctx.hasBasket && BAGS_NO_FLAVOR.test(sBasket) && !ORDER_PLACED.test(orderAskCore(raw))) {
      const addressText = split.address.replace(ADDRESS_LABELS, ' ').replace(/\s+/g, ' ').replace(/^[\s,.:;-]+|[\s,.:;-]+$/g, '').trim();
      const sAddress = core(addressText);
      if (addressText && !PRICE.test(sAddress) && !ORDER_ASK.test(sAddress) && (ADDRESS_WORDS.test(sAddress) || Boolean(describeDeliveryAddress(addressText).resolved?.province))) {
        const value = { template_id: 'ORDER_ADDRESS', Customer_Address: addressText };
        if (phone) value.Phone_Number = phone;
        return { rule: 'BAGS_ADDRESS', value };
      }
    }
    if (items.length) {
      // So "địa chỉ cũ" TRƯỚC khi bỏ nhãn "địa chỉ:"/"đc:" (nhãn cũng là chữ "địa chỉ").
      // R15 (inbox4 A3): "chợ cũ/chợ củ" là tên chợ, không phải "chỗ cũ" (maskMarketWord đổi chữ "chợ" còn dấu).
      const sRest = core(maskMarketWord(split.address));
      const addressText = split.address.replace(ADDRESS_LABELS, ' ').replace(/\s+/g, ' ').replace(/^[\s,.:;-]+|[\s,.:;-]+$/g, '').trim();
      const sAddress = core(addressText);
      if (OLD_ADDRESS_TAIL.test(sRest) && OLD_ADDRESS_CORE.test(sRest)) {
        if (ctx.hasPreviousDelivery === false) return null;
        return { rule: 'BASKET_OLD_ADDRESS', value: { ...basketValue(items), Phone_Number: phone || '0', Customer_Address: '0' } };
      }
      const looksAddress = Boolean(addressText) && !PRICE.test(sAddress.replace(/\bgia (lam|binh|lai|nghia|rai|vien|loc|kiem|dinh|thuy|long|ray)\b/g, ' ')) && !ORDER_ASK.test(sAddress)
        && (ADDRESS_WORDS.test(sAddress) || Boolean(describeDeliveryAddress(addressText).resolved?.province));
      if (looksAddress) {
        const value = { ...basketValue(items), Customer_Address: addressText };
        if (phone) value.Phone_Number = phone;
        return { rule: 'BASKET_ADDRESS', value };
      }
    }
  }
  // Giỏ rõ + một câu hỏi thông tin ("Cho chị 1 bịch vàng. Bịch này ko có yến mạch?"): giữ giỏ,
  // xin SĐT/địa chỉ và trả lời câu hỏi bằng ý phụ — trước đây giỏ bị rơi, chỉ trả lời câu hỏi.
  if (!complaint && orderAgeMin >= 60 && !PRICE.test(s) && !ctx.smallPackContext && !basketAmbiguous(raw) && typeof ctx.commentBasket === 'function'
    && (ORDER_VERB.test(s) || /\b\d{1,2}\b/.test(s))) {
    const { items, leftover } = basketParts(raw, ctx.commentBasket);
    const info = items.length && leftover ? INFO_RULES.find(([rule, pattern, , exclude]) => !['FREESHIP', 'DISCOUNT', 'VOUCHER', 'GIFT', 'COMPARE', 'PAYMENT'].includes(rule) && pattern.test(leftover) && !(exclude && exclude(leftover, ctx)) && !(rule === 'VAT' && vatNotInvoice(raw))) : null;
    if (info) return { rule: 'BASKET_INFO', value: { ...basketValue(items), also: info[2] } };
    // R13: "Cho chị 1 bịch màu vàng. Bịch này ko có yến mạch phải ko ?" — câu HỎI có/không thành phần đi kèm giỏ.
    if (items.length && leftover && contentQuestion && /\b(?:khong|ko|k) co (?:yen mach|hanh nhan|dau phong|hat dieu|trai cay|qua say|nho kho)\b/.test(sVariant) && !NO_VARIANT_REQUEST.test(sVariant)) return { rule: 'BASKET_INFO', value: { ...basketValue(items), also: 'INGREDIENTS_ALLERGY' } };
  }
  // Xin bỏ một thành phần ("không yến mạch", "bỏ hạt", "không lấy quả"): công thức cố định → NO_VARIANT
  // (điền {ingredient} có dấu qua `values`) + thẻ cần người xem. Đặt sau luật giỏ để "cho chị 1 bịch vàng,
  // bịch này ko có yến mạch?" vẫn giữ giỏ; đặt trước LIVE_ONLY vì "hạt điều" cũng là hàng live.
  // R13 (inbox1 B1): so trên chuỗi đã tách chữ CÒN DẤU dễ trùng: "bơ" (Gói Cam bơ hạt điều) ≠ "bỏ", "quà" (quà tặng) ≠
  // "quả" — "Gói cam bơ hạt điều. Bn e" là hỏi giá Combo 10 gói Cam, "không lấy quà" là GIFT_SWAP (luật ở trên).
  // Câu HỎI có/không thành phần ("Túi này ko có yến mạch?", "có loại nào không có hạnh nhân không") → INGREDIENTS_ALLERGY,
  // không phải xin bỏ thành phần; lời xin rõ ("đừng bỏ nho khô được không", "không lấy quả được không") vẫn NO_VARIANT.
  const noEat = !isComment && !phone && !NO_EAT_NOT.test(sVariant) ? sVariant.match(NO_EAT) : null;
  if (!isComment && (NO_VARIANT.test(sVariant) || noEat)) {
    if (!noEat && contentQuestion && INGREDIENT_ABSENT.test(sVariant) && !NO_VARIANT_REQUEST.test(sVariant) && !phone) return infoReply('INGREDIENTS', 'INGREDIENTS_ALLERGY');
    const s = sVariant;
    const named = (noEat ? [null, noEat.slice(1).find(Boolean)] : null) || s.match(/\b(yen mach|hanh nhan|dau phong|hat dieu|trai cay|qua say|qua kho|nho kho)\b/) || s.match(/\bbo (hat|qua)\b|\bkhong lay (qua|hat)\b/);
    const key = named ? (named[1] || named[2] || '') : '';
    return { rule: 'NO_VARIANT', value: { template_id: 'NO_VARIANT', values: { ingredient: INGREDIENT_NAMES[key] || 'thành phần đó' } }, attention: true };
  }
  // Hàng chỉ bán trên live (sữa hạt, hũ hạt, túi Xanh dương/Xanh mint/Tropical, túi dâu): mẫu LIVE_ONLY_PRODUCT
  // + thẻ (engine đổi thành CSKH_HANDOFF cho khách hộp thư không từ live). Câu hỏi thành phần
  // ("có xoài không", "thành phần có hạt điều") thì để mô hình.
  // Vòng 11 (V10): câu hỏi thành phần có đuôi hỏi đã bị core() cắt ("túi xanh có xoài sấy hả", "trong túi vàng
  // có xoài à") hay dạng "có xoài / có hạt điều / có vị dâu" ("granola có xoài sấy", "có vị dâu không") → mô hình,
  // không phải hỏi mua hàng live (inbox thường sẽ bị chuyển người + tắt bot). "bên em có túi dâu không" vẫn là LIVE_ONLY.
  // Vòng 12 (B2 #15): "Túi xanh, túi vàng có hạt óc chó hạt bí xanh hả em" — "có … không/hả" về thành phần là câu hỏi
  // thành phần (INGREDIENTS_ALLERGY: không có óc chó), không phải hỏi mua hàng live.
  const ingredientAsk = (LIVE_INGREDIENT.test(s) || /\bvi dau\b/.test(s) || LIVE_ONLY.test(s) || /\b(oc cho|mac ?ca|hat chia)\b/.test(s)) && !/\b(ban|mua|lay|con hang|gia)\b/.test(s)
    && (POLICY_QUESTION.test(s) || QUESTION_TAIL.test(sFull) || /\b(a|ah|ha)$/.test(sFull) || /\b(thanh phan|di ung|gom)\b/.test(s) || /\bco (?:vi )?(xoai|hat dieu|dau say|dau)\b/.test(s)
      || /\bco\b.{2,60}\b(?:khong|ko|k|kg|hong|ha|a|ah)$/.test(sFull.replace(/(?: (?:em|e|shop|chi|c|ban|b|nhe|nha|nhi|vay|v|oi))+$/, '')));
  // Vòng 12: Granola Tropical (xanh biển/ngọc/min/da trời/dương, túi dâu…) là sản phẩm danh mục: báo giá / lên giỏ như túi
  // khác (giỏ có "mint" đã qua luật BASKET ở trên). "xanh nhạt" mơ hồ → hỏi lại kèm ảnh Tropical (không tự lên giỏ).
  if (!isComment && !phone && !ingredientAsk && TROPICAL_UNSURE.test(s) && !TROPICAL_MENTION.test(s)) {
    return { rule: 'TROPICAL_UNSURE', value: { template_id: 'TROPICAL_CONFIRM' } };
  }
  // R14 (ca …216841 "Loại màu nâu và xanh mịn là như nào e", …762063 "Thêm 1 túi màu xanh nhe em là 3 tui / Túi có dâu để
  // ăn thử"): câu SO SÁNH (có vị túi khác ngoài Tropical, "khác/so với/hơn") hay có Ý ĐẶT số túi/thêm túi (ngoài ca giỏ
  // Tropical rõ "lấy 2 túi dâu") → không trả bảng giá Tropical, để luật khác / mô hình.
  // R14 (ca thật 02/10 "Em kiểm tra lại tin nhắn a có đặt đơn 2 túi đâu" từng lên giỏ 2 Tropical): "túi ĐÂU" (đ — "có … đâu"
  // = phủ định / hỏi ở đâu) bỏ dấu trùng "túi dâu" → so trên chuỗi đã đổi "đâu" còn dấu.
  const sTropical = core(prep(raw.normalize('NFC').replace(/(?<![\p{L}])(túi|tui|gói|goi|bịch|bich|loại|loai|vị|vi|granola)(\s+có|\s+co)?\s+đâu(?![\p{L}])/giu, '$1 where')));
  const sTropicalRest = sTropical.replace(TROPICAL_MENTION_ALL, ' ');
  const tropicalCompare = /\b(?:xanh|vang|nau|cacao)\b/.test(sTropicalRest) || /\b(?:khac|so sanh|so voi|ngon hon|hay hon|hon)\b/.test(sTropicalRest);
  const tropicalBasketOnly = ORDER_VERB.test(s) && !PRICE.test(s) && askedCount >= 1 && askedColours.length === 0 && !/\bthem\b/.test(s);
  const tropicalOrderIntent = !tropicalBasketOnly && ((askedCount >= 1 && ORDER_VERB.test(s) && !PRICE.test(s)) || /\bthem\b/.test(s) || (s.match(/\b\d{1,2} ?(?:tui|goi|bich|bit)\b/g) || []).length >= 2);
  if (!isComment && !phone && !ingredientAsk && TROPICAL_MENTION.test(sTropical) && !tropicalCompare && !tropicalOrderIntent) {
    const tropical = colourSku('mint');
    if (tropical) {
      if (tropicalBasketOnly) return { rule: 'TROPICAL_BASKET', value: { template_id: 'ORDER_ADDRESS', Product_N1: tropical.name, No_A: String(askedCount) } };
      // R15 (inbox4 A5, ca …762063 "Túi có dâu để ăn thử" gửi riêng khi đang giữ 3 Xanh): không THAY giỏ đang giữ bằng 1 Tropical.
      // Có "thử/nữa/kèm/với" → THÊM 1 Tropical vào giỏ (add_to_basket, bộ soạn đơn cộng dồn); không có → chỉ báo giá Tropical
      // (PRICE_QUOTE: engine giữ giỏ cũ và kèm câu nhắc giỏ) để khách tự nói đổi hay thêm — không thay giỏ ngầm.
      if (ctx.hasBasket) {
        // R15 sửa (phản biện luật, THẤP): lời ĐỔI rõ ("đổi sang túi có dâu luôn", "chỉ lấy túi dâu", "Lấy túi dâu thôi") → giỏ
        // thành Tropical (ORDER_ADDRESS không add_to_basket: bộ soạn đơn thay giỏ), không bắt khách nói lại.
        if (/\b(?:doi|thay|chi lay|chi can|chi mua|chi dat)\b|\b(?:lay|mua|dat|chot) .{0,30}\bthoi$/.test(sTropical) && !/\b(?:them|nua|kem)\b/.test(sTropical)) {
          return { rule: 'TROPICAL_SWITCH', value: { template_id: 'ORDER_ADDRESS', Product_N1: tropical.name, No_A: String(askedCount || 1) } };
        }
        if (/\b(?:thu|nua|kem|voi)\b/.test(sTropicalRest)) return { rule: 'TROPICAL_ADD', value: { template_id: 'ORDER_ADDRESS', Product_N1: tropical.name, No_A: '1', add_to_basket: '1' } };
        return { rule: 'TROPICAL_HELD', value: { template_id: 'PRICE_QUOTE', Product_N1: tropical.name } };
      }
      return { rule: 'TROPICAL', value: { template_id: 'PRICE_QUOTE', Product_N1: tropical.name } };
    }
  }
  if (!isComment && !phone && LIVE_ONLY.test(s) && !ingredientAsk) {
    return { rule: 'LIVE_ONLY', value: { template_id: 'LIVE_ONLY_PRODUCT' }, attention: true };
  }
  // Đang giữ giỏ, khách tóm tắt xin xác nhận ("2 túi xanh 298k miễn ship đúng không"): CONFIRM_YES,
  // engine tự kèm dòng giỏ. Có ý đổi/thêm/bớt/hủy thì để mô hình.
  // R16 (inbox3 A2, ca …2603191069 "shop đó vẫn là bên em đúng không"): chỉ khi phần trước "đúng không" có nội dung giỏ (số, màu,
  // túi/gói, giá, ship, quà) — câu hỏi khác kết bằng "đúng không" không phải tóm tắt giỏ.
  // ("đúng hả", "đúng k?", "vậy là đúng không" trơn — hỏi lại tóm tắt bot vừa gửi — vẫn CONFIRM_YES.)
  const confirmBody = sFull.replace(CONFIRM_TAIL, ' ');
  if (!isComment && ctx.hasBasket && !phone && !BASKET_CHANGE.test(s) && CONFIRM_TAIL.test(sFull)
    && (/\d|\b(?:xanh|vang|nau|cacao|mint|tropical|tui|goi|bich|hop|combo|gia|tong|ship|sip|mien|free|freeship|qua|tang|bat|muong|quat|nghin|ngan)\b/.test(confirmBody)
      || !confirmBody.replace(/\b(?:vay|v|the|la|nhu vay|nhu the|the la|vay la|ok|oke|da|dạ|u|uh|a|ah|ak|shop|em|e|chi|c)\b/g, ' ').trim())) {
    return { rule: 'CONFIRM_SUMMARY', value: { template_id: 'CONFIRM_YES' } };
  }
  // Vòng 10: bot vừa hỏi vị, khách trả lời một màu ("Túi xanh", "Vàng nhiều hạt", "Nâu cacao ạ", "xanh") → 1 túi màu đó.
  if (!isComment && !phone && (FLAVOR_ASK_LAST.has(last) || (FLAVOR_MENU_LAST.has(last) && !contentQuestion && s.length <= 40)) && !ctx.staffRepliedAfterBot && Number(ctx.botLastAgeMin) <= 1440 && !PRICE.test(s) && !raw.includes('?')
    && !/\b(2|3|4|5|6|7|8|9)\b|\d{2}/.test(s) && !s.replace(FLAVOR_ANSWER_WORDS, ' ').trim()
    && !(!FLAVOR_ASK_LAST.has(last) && flavourQuestionTail(raw, s))) {
    const chosen = [...new Set(s.match(/\b(xanh|vang|nau|cacao)\b/g) || [])].map(colour => (colour === 'cacao' ? 'nau' : colour));
    const product = chosen.length === 1 ? colourSku(chosen[0]) : null;
    // Vòng 11 (P5): số túi khách nêu trước khi bot hỏi vị ("cho chị 2 túi" → ASK_FLAVOR → "vàng" = 2 túi vàng):
    // engine truyền ctx.askedBagCount; khách ghi rõ "1" trong câu trả lời thì theo khách. Khách đã nói nhiều vị
    // ("2 túi 2 vị") mà chỉ trả một màu: chưa rõ → mô hình.
    // R16: trả lời câu hỏi "nguyên bản là Xanh hay Vàng" (ASK_FLAVOR_NGUYENBAN) → số túi của PHẦN nguyên bản chưa rõ (giỏ chờ
    // nguyenBanAsk, engine truyền ctx.nguyenBanAsk), không phải tổng số túi khách nêu (askedBagCount).
    const nguyenBanOpen = last === 'ASK_FLAVOR_NGUYENBAN' ? Math.round(Number(ctx.nguyenBanAsk) || 0) : 0;
    const asked = nguyenBanOpen > 0 ? nguyenBanOpen : Math.round(Number(ctx.askedBagCount) || 0);
    const count = /\b1\b/.test(s) ? 1 : asked >= 1 && asked <= 9 ? asked : 1;
    if (product && !(ctx.askedMixedFlavours && !/\b1\b/.test(s))) return { rule: 'FLAVOR_ANSWER', value: { template_id: 'ORDER_ADDRESS', Product_N1: product.name, No_A: String(count) } };
  }
  // Vòng 10: "C đặt nhé" / "mình mua" / "Gửi cho mình" (chưa nêu vị, số) → hỏi vị; đang giữ giỏ và bot đang xin thông tin
  // ("ok chốt", "chị đặt nhé") → nhắc lại phần còn thiếu (bộ soạn đơn giữ giỏ). Đã có đơn thật thì để mô hình.
  if (!isComment && !phone && !ctx.hasRecentOrder && !ctx.trialOffer && !complaint && !ctx.complaint) {
    const holding = ctx.hasBasket && ctx.lastWasOrderStep && !['ORDER_CONFIRMATION', 'ORDER_UPDATE'].includes(last);
    // Vòng 11 (V9): bỏ dấu thì "vàng" (Túi Vàng) trùng "vâng": tin có chữ "vàng" CÒN DẤU là chọn màu → mô hình.
    const saysVang = /vàng/iu.test(raw.normalize('NFC'));
    if (holding && !saysVang && (OK_STEP.test(s) || DECIDE_BUY.test(s))) return { rule: 'OK_STEP', value: { template_id: 'ORDER_ADDRESS' } };
    if (!ctx.hasBasket && !saysVang && DECIDE_BUY.test(s)) return { rule: 'DECIDE_BUY', value: { template_id: 'ASK_FLAVOR' } };
    // Bộ chấm: "có mấy loại", "xem các vị" → bảng giá chung (liệt kê 3 vị kèm giá), không phải ASK_FLAVOR.
    // Vòng 12 (B2 #17, B3 #11): listAll → engine giữ nguyên bảng 3 vị (không thay bằng bảng giá một túi).
    // R13 (inbox1 B3): chịu lỗi gõ ("Có mays lọi"). Đang giữ giỏ → luật K5 (candidateRules, cuối chuỗi luật).
    if (!ctx.hasBasket && FLAVOR_LIST.test(s)) return { rule: 'FLAVOR_LIST', value: { template_id: 'GENERAL_INFO', listAll: '1' } };
  }
  // R13 (inbox3 F5): "Ch muốn mua cho người mắc tiểu đường ăn" — có "mua" (động từ đặt) nên luật INFO bên dưới bỏ qua.
  if (!isComment && !phone && !complaint && !ctx.complaint && s.length <= 100 && orderAgeMin >= 60 && INFO_RULES.find(([rule]) => rule === 'DIABETES')[1].test(s) && !/\d|\b(xanh|vang|nau|cacao)\b/.test(s)) {
    return infoReply('DIABETES', 'HEALTH_DIABETES');
  }
  // R14 (quyết định 11): bệnh lý khác ("mua cho bố bị cao huyết áp ăn được không") — có "mua" nên luật INFO bỏ qua: xét riêng.
  if (!isComment && !phone && !complaint && !ctx.complaint && s.length <= 100 && orderAgeMin >= 60 && HEALTH_CAUTION_RE.test(s) && !/\d|\b(xanh|vang|nau|cacao)\b/.test(s)) {
    return infoReply('HEALTH_CAUTION', 'HEALTH_CAUTION', { attention: true });
  }
  // Vòng 12 (B3 #12): "mua cho bệnh nhân nên hỏi kỹ" (có "mua") → HEALTH_CONDITION + thẻ, không im.
  if (!isComment && !phone && s.length <= 80 && INFO_RULES.find(([rule]) => rule === 'PATIENT')[1].test(s) && !/\d|\b(xanh|vang|nau|cacao)\b/.test(s)) {
    return infoReply('PATIENT', 'HEALTH_CONDITION', { attention: true });
  }
  // Vòng 12 (B1 #12): "Gửi hình e xem" — "gửi" là động từ đặt nên luật INFO bên dưới bỏ qua: xét riêng (không màu/số).
  if (!isComment && !phone && s.length <= 50 && !/\d|\b(xanh|vang|nau|cacao)\b/.test(s) && INFO_RULES.find(([rule]) => rule === 'PHOTOS')[1].test(s) && !/\b(ck|chuyen khoan|bill)\b/.test(s)) {
    return infoReply('PHOTOS', 'PRODUCT_PHOTOS');
  }
  // Xin gợi ý ("mới tập ăn thì lấy loại nào", "tư vấn c 1 túi"): có động từ đặt/số túi nhưng không phải giỏ
  // → RECOMMEND_BEGINNER (luật INFO bên dưới loại câu có động từ đặt nên xét riêng ở đây).
  if (!isComment && !phone && !complaint && !ctx.complaint && s.length <= 70 && !PRICE.test(s) && !RECOMMEND_NAMED.test(s) && INFO_RULES.find(([rule]) => rule === 'RECOMMEND')[1].test(s)) {
    return { rule: 'RECOMMEND', value: { template_id: 'RECOMMEND_BEGINNER' } };
  }
  // Chỉ nêu một túi, không số, không động từ đặt ("Túi xanh", "túi vàng giá sao"): báo giá túi đó.
  const colours = [...new Set(s.match(/\b(xanh|vang|nau|cacao)\b/g) || [])].map(colour => (colour === 'cacao' ? 'nau' : colour));
  if (fresh && orderAgeMin >= 60 && !ORDER_VERB.test(s) && !phone && !/\d/.test(s) && new Set(colours).size === 1 && !LIVE_ONLY.test(s)
    && !s.replace(/\b(xanh|vang|nau|cacao|la|cay|tui|goi|bich|granola|vi|gia|bao nhieu|bn|sao|the nao|ntn|nhieu|tien|cho|xin|hoi|loai)\b/g, '').trim()) {
    const product = colourSku(colours[0]);
    if (product) return { rule: 'PRICE_ONE', value: { template_id: 'PRICE_QUOTE', Product_N1: product.name } };
  }
  // Vòng 12 (B1 #12): "giá túi xanh và vàng" (giá + đúng 2 màu, không số) → bảng giá mix (báo cả hai), không so sánh túi.
  if (fresh && orderAgeMin >= 60 && !ORDER_VERB.test(s) && !phone && !/\d/.test(s) && new Set(colours).size === 2 && PRICE.test(s)
    && !s.replace(/\b(xanh|vang|nau|cacao|la|cay|tui|goi|bich|granola|vi|gia|bao nhieu|bn|sao|the nao|ntn|nhieu|tien|cho|xin|hoi|loai|va|voi|hay|vs|mau|moi|1|cua)\b/g, '').trim()) {
    return { rule: 'PRICE_TWO', value: { template_id: 'PRICE_MIX_TUI_LON' } };
  }
  if (/^(cam on|camon|thanks|thank you|tks|thank|cam on nhieu|da cam on)$/.test(s)) return { rule: 'THANKS', value: { template_id: 'THANK_YOU' } };
  // Câu hỏi thông tin: tin ngắn, một tin, không đặt hàng/SĐT/hàng live/khiếu nại, không ngay sau khi chốt.
  const info = s.length <= 70 && (ctx.bundleSize || 1) === 1 && !ORDER_VERB.test(s) && !phone && (!LIVE_ONLY.test(s) || ingredientAsk) && orderAgeMin >= 60 && !complaint && !ctx.complaint;
  if (!info) return null;
  for (const [rule, pattern, template, exclude] of INFO_RULES) {
    if (!pattern.test(s) || (exclude && exclude(s, ctx))) continue;
    if (rule === 'VAT' && vatNotInvoice(raw)) continue;
    let target = template;
    if (rule === 'COMPARE' && (/nhieu hat/.test(s) || (/\bxanh\b/.test(s) && /\bvang\b/.test(s) && !/\b(nau|cacao)\b/.test(s)))) target = 'BAG_COMPARISON_XANH_VANG';
    const value = { template_id: target, ...(target === 'PRODUCT_PHOTOS' && ctx.contextProduct ? { Product_N1: ctx.contextProduct } : {}) };
    // Đang ở bước lên đơn: giữ bước đơn, trả lời câu hỏi bằng ý phụ. Xin gợi ý ("tư vấn c 1 túi nữa")
    // thì trả lời thẳng: mẫu đã mời chọn 1 túi / combo 2, không tự cộng túi vào giỏ.
    // Vòng 11 (P1): sau CONFIRM_YES ("Dạ đúng rồi ạ, gửi em SĐT + địa chỉ") giỏ vẫn đang giữ → cùng cách
    // (engine trả lời câu hỏi + nhắc ngắn giỏ, không lưu lại giỏ).
    // Vòng 12: mua cho người bệnh / người già → thẻ cần người (nhân viên tư vấn kỹ).
    const flag = rule === 'PATIENT' || rule === 'HEALTH_CAUTION' ? { attention: true } : {};
    if (ctx.hasBasket && (ctx.lastWasOrderStep || last === 'CONFIRM_YES') && rule !== 'RECOMMEND') return { rule, value: { template_id: 'ORDER_ADDRESS', also: target }, ...flag };
    return { rule, value, ...flag };
  }
  return null;
  }
}

export { ORDER_STEPS as ruleOrderSteps, INFO_RULES as infoRules };
