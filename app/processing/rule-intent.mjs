// Luật nhận ý khách bằng code, chạy TRƯỚC mô hình: tin nào code nhận chắc chắn
// thì trả thẳng mẫu, không gọi Gemini (không tốn token, không chờ, không 429).
// Bộ luật đo trên 856 lượt tin thật 22–25/09 và kiểm lại trên 788 lượt tuần
// 16–22/09 (không dùng khi viết luật): bắt ~33–44% lượt, rà tay từng tin bắt
// được, ≥ 97% đúng. Tin dài, nhiều ý, phụ thuộc ngữ cảnh vẫn để mô hình.
import { foldVietnamese } from './auto-label.mjs';
import { extractVietnamesePhone } from './customer-info.mjs';
import { getCatalogProducts } from './catalog.mjs';
import { describeDeliveryAddress } from './locations.mjs';

/** Chuỗi chuẩn để so luật: bỏ dấu, bỏ dấu câu, bỏ lời gọi đầu câu và từ đệm cuối câu. */
import { orderFlowStep, stripPhone } from './order-flow.mjs';

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
const prep = raw => String(raw || '')
  .replace(/n[âa]u\s+(v[ịi]\s+)?ca\s*cao/giu, 'nâu').replace(/ca\s+cao/giu, 'cacao')
  .replace(/s[ôo]\s*-?\s*c[ôo]\s*-?\s*la|socola|chocolate|choco\b/giu, 'nâu')
  .replace(/(\d)(t[úu]i|g[óo]i|b[ịi]ch|b[ịi]t)\b/giu, '$1 $2')
  // \b không biết chữ có dấu ("vị", "hộp") → biên Unicode ở cuối.
  .replace(/\b(m[ộo]t|hai|ba)\s+(?=(?:t[úu]i|g[óo]i|b[ịi]ch|b[ịi]t|xanh|v[àa]ng|n[âa]u|cacao|combo|h[ộo]p|v[ịi]|lo[ạa]i)(?![\p{L}\p{N}]))/giu, (match, word) => `${NUMBER_WORDS[foldVietnamese(word).toLowerCase()] || word} `)
  .replace(/\b(xanh)\s+450\s*(?:g|gr|gam|gram)?\b/giu, '$1').replace(/\b(v[àa]ng|n[âa]u|cacao)\s+350\s*(?:g|gr|gam|gram)?\b/giu, '$1')
  .replace(/\b(t[úu]i|b[ịi]ch|g[óo]i)\s+450\s*(?:g|gr|gam|gram)?\b/giu, '$1 xanh').replace(/\b450\s*(?:g|gr|gam|gram)\b/giu, 'xanh').replace(/\b450\s+(?=granola|gran\b)/giu, 'xanh ');
// "xanh mint"/"xanh bạc hà" là túi Tropical (hàng live), không phải Túi Xanh: bỏ trước khi đếm màu
// (như đã bỏ "xanh dương"). Chỉ dùng cho phần đếm giỏ; chuỗi so luật vẫn giữ để bắt LIVE_ONLY.
const dropLiveColours = text => String(text || '').replace(/xanh\s+(mint|b[ạa]c\s+h[àa])/giu, ' ');
// "nhiêu" cuối câu là hỏi giá ("1 túi nhiêu"), trừ "hạt nhiều" ("lấy vàng, loại hạt nhiều").
const PRICE = /\b(gia|bn|bao nhieu|bnhiu|bao tien|nhieu tien|tong)\b|(?<!hat )nhieu$/;
const ORDER_VERB = /\b(lay|dat|mua|chot|gui|ship cho|cho (minh|em|e|chi|c|toi|tui|anh|a|mk|m|u) \d|giao)\b/;
// Hàng chỉ bán trên live (sữa hạt, hũ hạt, túi Xanh dương, túi Xanh mint/Tropical, túi dâu…).
const LIVE_ONLY = /(sua hat|hat dieu|hat bi|xoai|dau say|xanh duong|hu hat|xanh mint|\bmint\b|tropical|xanh bac ha|\b(tui|vi|goi|granola|loai) dau\b|\bdau tay\b)/;
// Từ live "xoài"/"hạt điều"/"đậu sấy" cũng là thành phần granola: câu hỏi có/không về thành phần để mô hình.
const LIVE_INGREDIENT = /\b(xoai|hat dieu|dau say)\b/;
const COMPLAINT = /\b(bi hoi|hoi dau|co mui|mui la|moc|qua cung|bi cung|di vat|bi hu|bi loi|hang loi|that vong|te qua|khong ngon|chua nhan|giao cham|nhan (dc|duoc) hang roi)\b/;
// Khiếu nại rõ ràng cần người thật (khác COMPLAINT ở trên chỉ dùng để chặn luật giỏ/thông tin).
// Vòng 9 (26–28/09) thêm: "mua bên khác", "k chốt đơn/giao", "người thật", "gặp người", "nói chuyện với
// người", "mở ra chủ yếu/toàn/ít…", "buôn bán kiểu gì".
const STRONG_COMPLAINT = /\b(goi .{0,14}(khong|ko|k|hong) (duoc|dc)|goi .{0,12}suot|(khong|ko|k|co) (thay )?ai goi|luyen thuyen|(qua cung|bi cung|cung qua).{0,30}\bso\b|an phai .{0,12}\bso\b|rat so (qua|luon|that|roi)|that vong|te qua|lua dao|thai do|vo ly|khieu nai|bao cao shop|lam an .{0,10}(vay|the)|mua ben khac|(k|ko|khong) chot (don|giao)|(nguoi|nhan vien) that|gap nguoi|noi chuyen voi nguoi|mo ra (chu yeu|toan|it)|buon ban kieu gi)\b/;
// "phản ánh" chỉ so trên chữ CÒN DẤU: bỏ dấu thì trùng "phần anh" ("phần anh 2 túi vàng, phần chị 1 túi xanh").
const COMPLAINT_REPORT = /phản ánh/iu;
// Câu nêu giỏ (số + túi/gói, hay màu túi) mà không có từ khiếu nại rõ: là đặt hàng, không chuyển người.
const BASKET_MENTION = /\b(\d{1,2} ?(tui|goi|bich)|xanh|vang|nau|cacao|combo)\b/;
const COMPLAINT_WORDS = /\b(khieu nai|that vong|te qua|lua dao|thai do|vo ly|luyen thuyen|bao cao shop|goi .{0,14}(khong|ko|k|hong) (duoc|dc)|(khong|ko|k) (thay )?ai goi|mua ben khac|(k|ko|khong) chot (don|giao)|(nguoi|nhan vien) that|gap nguoi|noi chuyen voi nguoi|mo ra (chu yeu|toan|it)|buon ban kieu gi)\b/;
// Khách hẹn dịp khác / xin hủy ý định đặt ("bữa khác chốt", "thôi để sau", "xin lỗi shop mình hủy"):
// đáp mềm, xóa giỏ chờ. Không dùng khi đã có đơn (hủy đơn thật đi luồng ORDER_CANCEL).
const POSTPONED = /\b(bua khac|hom khac|khi khac|de sau|lan sau|dot khac)\b.{0,25}\b(chot|dat|lay|mua)\b|\b(huy|hy|khong lay|thoi) .{0,20}\b(bua khac|sau|khi khac)\b|\bxin loi\b.{0,30}\b(huy|hy|khong lay)\b/;
// Khách xin bỏ một thành phần ("không yến mạch", "bỏ hạt", "không lấy quả"): công thức cố định, không có
// loại riêng → NO_VARIANT (điền {ingredient} có dấu) + nhờ người thật.
const NO_VARIANT = /\b(?:khong|ko|k) (?:co )?(yen mach|hanh nhan|dau phong|hat dieu|trai cay|qua say|nho kho)\b|\bbo (hat|trai cay|qua say|qua kho)\b|\bbo qua\b(?=.*\b(tui|goi|granola|hat|an)\b)|\b(tui|goi|granola|hat|an)\b.*\bbo qua\b|\bkhong lay (qua|hat)\b/;
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
const ADDRESS_WORDS = /\b(xa|phuong|huyen|thi tran|thi xa|thanh pho|tphcm|tp hcm|hcm|ha noi|da nang|ap|thon|khu pho|kp|ngo|hem|ngach|so nha|chung cu|duong)\b|\b(quan|q|p) ?\d{1,2}\b|\bquan (?!tam\b)[a-z]+/;
const ADDRESS_LABELS = /(?:^|\s)(?:s[đd]t|đt|dt|số điện thoại|so dien thoai|số đt|so dt|địa chỉ|dia chi|đ\/c|d\/c|dc)\s*[:.]?(?=\s|$)/giu;
const PRODUCT_MENTION = /\b(xanh|vang|nau|cacao|combo|tui|goi|bich|hop|set|granola|nghe lanh|hat an lanh|yen mach)\b|\b\d{1,2} ?(tui|goi|bich)\b/;
const POLICY_QUESTION = /\b(co|duoc|dc)\b.{0,40}\b(khong|ko|k|kg|hong)\s*(a|ạ|shop|e|em|b|ban|nhi)?\s*\??$|\?$/;
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
// ===== Luật thử nghiệm (vòng 6, đếm trên 1.678 tin 22–25/09): chạy ẩn so với mô hình cho tới khi
// settings.experimentalRules = 'on'. Kết quả trả về mang `experimental: true`.
// "Lấy c 1 túi dùng thử", "Mình lấy một túi xanh dung thử đã", "C.mua 1 túi ăn thử được không shop".
const TRIAL_ASK = /^(?:(?:cho|lay|mua|dat|gui)\s)?(?:(?:em|e|minh|m|mk|chi|c|toi|a|anh|to)\s)?(?:(?:mua|lay)\s)?(?:(?:1|mot)\s)?(?:(?:tui|goi|bich)\s)?(?:(xanh|vang|nau|cacao)\s)?(?:(?:nguyen ban|la)\s)?(?:dung|an|mua|lay) thu(?:\s(?:truoc|da|xem|duoc khong|dc ko|dc k|nha|nhe|coi|xem sao))?$/;
// "Mình chưa nhận được hàng ạ", "Bữa e đặt hàng sao chưa thấy đơn về" (không SĐT, không nêu sản phẩm).
const ORDER_ASK = /\b(da dat|dat roi|da mua|da chot|chua (thay|nhan)( duoc)? (hang|don)|don (toi|den) dau|gui hang chua|kiem tra don|tra don|sao chua thay|bao gio (nhan|toi|giao))\b/;
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
const FLAVOR_LIST = /^(?:(?:shop|ben (?:minh|em|ban|shop)|san pham|sp|granola|nha minh|minh|ben minh co|hien) )?(?:co )?(?:may|bao nhieu|bn|nhung|cac) (?:loai|vi|mau)(?: (?:gi|nao|vay|the|nhi|het|ta))?$|^(?:xin |cho |minh )?(?:xem|coi) (?:cac |nhung |thu )?(?:vi|loai|mau)(?: (?:nhu nao|gi|nao|the nao|ntn))?$|^(?:co )?(?:nhung|cac) (?:vi|loai) (?:gi|nao)$/;
// Rút giỏ đang giữ ("không lấy nữa", "hủy giúp mình", "xóa hết đó đi", "thôi không mua"): đáp mềm + xóa giỏ
// (ORDER_POSTPONED). Chỉ khi chưa có đơn thật — có đơn thì "hủy" là hủy đơn (mô hình / ORDER_CANCEL).
const CANCEL_BASKET = /^(?:thoi )?(?:(?:minh|em|e|chi|c|toi|m|mk|t|a|anh) )?(?:khong|ko|k|hong|chua) (?:lay|mua|dat|can|chot)(?: (?:nua|dau|gi|hang|don))*$|\b(?:huy|hy|xoa|bo) (?:don|het|gium|giup|dum|ho|cho (?:minh|em|e|chi|c|toi))\b|\bxoa het\b|\b(?:khong|ko|k) (?:lay|mua|dat|chot) nua\b|\bthoi (?:khong|ko|k) (?:lay|mua|dat)\b/;
// Bot vừa hỏi vị (không gồm COMBO3_FLAVOR: "xanh" sau đó là 3 túi xanh) mà khách trả lời một màu ("Túi xanh",
// "Vàng nhiều hạt", "Nâu cacao ạ"): chọn vị đó, 1 túi → bộ soạn đơn ghép với SĐT/địa chỉ đang giữ.
const FLAVOR_ASK_LAST = new Set(['ASK_FLAVOR', 'ORDER_INFO_ASK_FLAVOR', 'ASK_FLAVOR_NGUYENBAN', 'RECOMMEND_BEGINNER']);
const FLAVOR_ANSWER_WORDS = /\b(xanh|vang|nau|cacao|la|cay|tui|goi|bich|bit|mau|vi|loai|nguyen ban|nhieu hat|nhieu qua|it hat|1|minh|em|e|chi|c|m|mk|lay|cho|dat|mua|the|thi|vay|ok|oke|da|thoi|truoc|di|luon|cua|con)\b/g;

// Câu hỏi thông tin: [luật, regex trên core, mẫu, điều kiện loại trừ thêm].
const INFO_RULES = [
  // Mẹ sau sinh / cho con bú / ở cữ: cùng mẫu HEALTH_CONDITION (đặt trước KIDS vì "cho con bú" có "cho con").
  ['HEALTH', /\b(me bau|bau bi|dang bau|mang thai|thai ky|tieu duong|tieu dg|huyet ap|sau sinh|cho con bu|dang cho bu|o cu)\b/, 'HEALTH_CONDITION'],
  ['KIDS', /\b(cho be|be an|be \d+ tuoi|tre em|tre nho|con nho|cho con|nguoi lon tuoi)\b/, 'KIDS_FAMILY'],
  ['CALORIES', /(calo|kcal|giam can|an kieng|eat ?clean|tang can|\bbeo\b)/, 'CALORIES_DIET'],
  ['SUGAR', /(co ngot|ngot (lam|nhieu|khong|ko|k|kh)\b|(khong|ko|k) (co )?duong|it duong|co duong|loai nao (khong|ko|k) ngot)/, 'NO_ADDED_SUGAR'],
  ['CRUNCHY', /((hat|vien) (gion|tron)\b.*\b(la|lam tu|lam bang) (hat |gi|j)|hat tron nho la|co (chien|ngay)|(chien|dau an) (khong|ko|k)\b)/, 'CRUNCHY_CEREAL_INFO'],
  ['INGREDIENTS', /(thanh phan|gom (nhung |cac )?(gi|hat|loai)|(co|la) (nhung |cac )?(loai )?hat (gi|j|nao)|hat (gi|j)\b|di ung|(co|khong|ko) .*dau nanh|gluten)/, 'INGREDIENTS_ALLERGY', s => PRICE.test(s)],
  // "Hàng mới không em", "date mới không": hỏi độ mới, không phải trọng lượng/hạn dùng.
  // "Đúng hàng mới nhận" là điều kiện nhận hàng (đồng kiểm), không hỏi độ mới.
  ['FRESH', /\b(hang moi|date moi|han (dai|moi|xa)|moi san xuat|con han)\b|\bmoi (khong|ko|k|o|hong)\b/, 'FRESHNESS', s => /\bdung hang\b/.test(s)],
  ['WEIGHT_EXPIRY', /((bao nhieu|bn|may|nhieu) ?(gam|gram|gr|g)\b|han (su dung|dung|sd)|hsd|an (duoc|dc) (bao )?lau|an (duoc|dc) may bua|dung (duoc|dc) may bua|trong luong)/, 'WEIGHT_EXPIRY', s => /\bgia\b|date moi|hang moi/.test(s)],
  // Khách mới, xin gợi ý ("túi nào dễ ăn", "mới tập ăn", "tư vấn c 1 túi"): gợi ý Túi Xanh — đặt TRƯỚC
  // COMPARE vì "nào ngon" cũng nằm trong COMPARE.
  ['RECOMMEND', /\b(tui|loai|vi) nao (ok|ngon|hop|de an|nen (lay|mua|chon))\b|\bmoi (tap|bat dau) an\b|\bchua (duoc )?trai nghiem\b|\btu van (?:(?:giup|cho|dum|ho) )?(?:(?:c|e|minh|chi|anh|em|m|mk) )?(?:(?:1|mot) )?(?:tui|loai)\b/, 'RECOMMEND_BEGINNER', s => PRICE.test(s)],
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
  ['PHOTOS', /(xem (hinh|anh|mau|san pham)|chup (xem|hinh|anh|cho|minh|chi|em)|gui (hinh|anh|mau) xem|(anh|hinh) that|cho (xem|coi)|xem them anh)/, 'PRODUCT_PHOTOS'],
  ['SMALL_PACK', /\b(co|ban) (tui|goi) nho|hop 10 goi|chia (goi|nho)|goi le\b|\b(set|combo|hop|bich|tui) .{0,10}goi nho|nhieu goi nho|goi nho .{0,10}(nhieu vi|mix|may vi)/, 'PACKAGING_INFO', (s, ctx) => PRICE.test(s) || ctx.hasBasket],
  ['SHIP_TIME', /((bao lau|may ngay|bao nhieu ngay|bn ngay|khi nao|chung nao) (thi )?(nhan|giao|toi|den|co)|(giao|ship|nhan)( hang)? (mat )?(bao lau|may ngay|bn ngay)|may ngay giao|khoang chung nao)/, 'SHIPPING_POLICY'],
  ['LINKS', /((xin|gui|cho) .*(link|linh gian hang|gian hang)|(co|vo|ban) (tren|o) (shopee|tiktok|lazada))/, 'ECOMMERCE_LINKS'],
  ['WHOLESALE', /(\bsi\b|\bctv\b|cong tac vien|dai ly|lay buon)/, 'WHOLESALE_CTV_CONTACT', s => /(bac|tien|y|ca|nghe|thac) si/.test(s)],
  ['VAT', /\b(vat|xuat hoa don|hoa don (do|vat|gtgt|dien tu))\b/, 'VAT_INVOICE'],
  ['PAYMENT', /\b(cod|thanh toan|chuyen khoan|ck truoc|tra tien|thu tien|tra truoc|tra sau|nhan hang roi tra)\b/, 'PAYMENT_METHODS', s => PRICE.test(s) && !/\b(cod|chuyen khoan|ck)\b/.test(s)]
];

const ICEBREAKERS = [
  [/^lam cach nao de dat hang$/, 'price'],
  [/^(lam cach nao de xem san pham truoc|toi co the xem them anh ve mat hang nay khong)$/, 'PRODUCT_PHOTOS'],
  [/^(co chuong trinh giam gia nao khong|khuyen mai combo dung thu tiet kiem)$/, 'DISCOUNT_POLICY'],
  [/^get started$/, 'WELCOME']
];

const productHintName = value => (value && typeof value === 'string' ? value : '');
const quotedProductName = value => (value && typeof value === 'string' ? value : '');
const colourSku = colour => getCatalogProducts().find(item => item.active !== false && /^gra-/i.test(item.sku || '') && String(item.sku || '').toLowerCase().includes(`-${colour}-`));

/** Giỏ ghi mơ hồ ("combo xanh", "2 gói xanh vàng", "vàng 2 túi", "1 combo vàng"): để mô hình. */
function basketAmbiguous(raw) {
  const x = foldVietnamese(dropLiveColours(prep(raw))).replace(/\b\d{3} ?(g|gr|gram)\b/g, ' ').replace(/\+?\d{9,11}/g, ' ');
  const numbers = x.match(/\b\d{1,2}\b/g) || [];
  const colours = new Set(x.match(/\b(xanh|vang|nau|cacao)\b/g) || []);
  return (/\bcombo\b/.test(x) && !numbers.length)
    || (colours.size >= 2 && numbers.length === 1 && Number(numbers[0]) >= 2)
    || /\b(xanh|vang|nau|cacao)\b[^0-9]*\b\d{1,2}\b(?!.*\b(xanh|vang|nau|cacao)\b)/.test(x)
    || /\d\s*combo\b/.test(x);
}

// Sau khi bỏ mọi chữ nói về giỏ, còn chữ nào thì tin có ý khác: để mô hình.
const BASKET_WORDS = new Set(['xanh', 'vang', 'nau', 'cacao', 'la', 'cay', 'tui', 'tuy', 'goi', 'bich', 'bit', 'hop', 'combo', 'lay', 'dat', 'mua', 'chot', 'gui', 'ship', 'cho', 'muon', 'can', 'em', 'e', 'minh', 'mk', 'm', 'chi', 'c', 'toi', 'tui', 'anh', 'a', 'to', 'ban', 'b', 'shop', 'va', 'voi', 'them', 'moi', 'loai', 'nha', 'nhe', 'ha', 'luon', 'di', 'thu', 'dung', 'nguyen', 'nhieu', 'hat', 'x', 'vi', 'granola', 'sdt', 'dt', 'nhe', 'ak', 'ah', 'oi']);

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
const FREESHIP_MENTION = /\b(mien|free|miem) ?(phi )?(ship|sip|xip|van chuyen)\b|\bfreeship\b|\bfship\b/g;

function basketParts(raw, commentBasket) {
  const cleaned = dropLiveColours(prep(raw));
  if (ADVICE_ASK.test(core(cleaned))) return { items: [], leftover: '' };
  const items = commentBasket(cleaned);
  if (!items.length) return { items: [], leftover: '' };
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
  const tokens = stripPhone(raw).split(/\s+/).filter(Boolean);
  const folded = tokens.map(token => core(prep(token)).split(' ').filter(Boolean));
  const basketish = index => folded[index].every(word => isBasketPrefixWord(word) || word === 'mau');
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

/**
 * @param text  tin (đã gộp cụm) của khách
 * @param ctx   { source, botLastTemplateId, staffRepliedAfterBot, botLastAgeMin, hasBasket, lastWasOrderStep,
 *               orderAgeMin, livestream, contextProduct, bundleSize, commentBasket }
 * @returns null | { rule, value } | { rule, commentRule:true } | { rule, value, attention:true }
 *          | { rule, value, clearBasket:true } (ORDER_POSTPONED: engine xóa giỏ chờ)
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
  const last = String(ctx.botLastTemplateId || '');
  const fresh = (SAFE_LAST.has(last) && !ctx.staffRepliedAfterBot) || Number(ctx.botLastAgeMin) > 1440;
  const orderAgeMin = Number.isFinite(ctx.orderAgeMin) ? ctx.orderAgeMin : Infinity;
  const phone = extractVietnamesePhone(raw);
  const isComment = ctx.source === 'comment';
  const complaint = COMPLAINT.test(s);
  // Hỏi giá chung: bình luận → bảng giá của bài (luật bình luận); inbox → bảng giá sản phẩm ngữ cảnh / chung.
  const priceGeneral = rule => (isComment ? { rule, commentRule: true }
    : { rule, value: ctx.contextProduct ? { template_id: 'PRICE_QUOTE', Product_N1: ctx.contextProduct } : { template_id: 'GENERAL_INFO' } });
  // Đang nói về gói nhỏ (combo 10 gói) mà khách ghi "2 túi xanh": túi lớn hay combo gói nhỏ
  // chưa chắc, để mô hình đọc cả ngữ cảnh.
  const basket = !complaint && !ctx.smallPackContext && orderAgeMin >= 60 && !PRICE.test(s) && !raw.includes('?') && !basketAmbiguous(raw) && typeof ctx.commentBasket === 'function'
    ? basketFrom(raw, ctx.commentBasket) : [];

  if (ctx.livestream && !ctx.hasRecentOrder && !basket.length && !complaint && LIVE_DEAL.test(s) && !/\b(chua (nhan|thay|giao)|huy|khieu nai)\b/.test(s)) {
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
  const strongComplaint = STRONG_COMPLAINT.test(sComplaint) || COMPLAINT_REPORT.test(raw);
  // "phần anh xanh phần chị vàng", "mình rất sợ béo": có giỏ / không có từ khiếu nại rõ thì không phải khiếu nại.
  const basketNotComplaint = BASKET_MENTION.test(sComplaint) && !COMPLAINT_WORDS.test(sComplaint) && !COMPLAINT_REPORT.test(raw);
  if (!isComment && strongComplaint && !basketNotComplaint && !POLICY_QUESTION.test(s)) {
    return { rule: 'COMPLAINT_HANDOFF', value: { template_id: 'CSKH_HANDOFF', warming: '1' }, attention: true };
  }
  // Khách hẹn dịp khác / rút ý định đặt ("bữa khác chốt", "thôi để sau", "xin lỗi shop, mình hủy"): đáp mềm,
  // engine xóa giỏ chờ (clearBasket). Đặt TRƯỚC ORDER_ASK (thử nghiệm) và trước luồng dùng thử của luật.
  // Đã có đơn thật thì "hủy" là hủy đơn → để mô hình / ORDER_CANCEL.
  // Vòng 10: rút giỏ đang giữ ("không lấy nữa", "xóa hết đó đi", "hủy giúp mình") khi chưa có đơn thật: cùng cách đáp.
  // Vòng 11 (P6): tin rút giỏ mà có nhắc màu/số túi ("xóa hết đi lấy 1 nâu thôi", "hủy túi xanh còn túi vàng",
  // "thôi không lấy vàng nữa") là ĐỔI giỏ, không xóa cả giỏ → để luật giỏ / mô hình.
  if (!isComment && !ctx.hasRecentOrder && !ctx.trialOffer && !phone && (POSTPONED.test(s) || (ctx.hasBasket && s.length <= 60 && CANCEL_BASKET.test(s) && !BASKET_MENTION.test(s)))) {
    return { rule: POSTPONED.test(s) ? 'ORDER_POSTPONED' : 'CANCEL_BASKET', value: { template_id: 'ORDER_POSTPONED' }, clearBasket: true };
  }
  // --- Luật thử nghiệm: chỉ trả về khi ctx.experimentalRules === 'on'; còn lại các luật ổn định
  // vẫn chạy như cũ, kết quả thử được đính kèm ở `shadow` (engine ghi log so sánh).
  const experimental = (() => {
    if (!isComment && !complaint && !ctx.complaint && !phone && !ctx.trialOffer) {
      if (TERSE_HOW.test(s)) return { ...priceGeneral('TERSE_HOW'), experimental: true };
      const trialAsk = orderAgeMin >= 60 && !ctx.hasBasket && s.length <= 60 && (s.match(TRIAL_ASK) || s.match(TRIAL_ASK_B));
      if (trialAsk) {
        const colour = trialAsk[1] ? (trialAsk[1] === 'cacao' ? 'nau' : trialAsk[1]) : '';
        const product = colour ? colourSku(colour)?.name || '' : (productHintName(ctx.contextProduct) || quotedProductName(ctx.quotedProduct));
        return { rule: 'TRIAL_ASK', experimental: true, value: product ? { template_id: 'ORDER_ADDRESS', Product_N1: product, No_A: '1' } : { template_id: 'ASK_FLAVOR' } };
      }
    }
    // Hỏi đơn không SĐT ("chưa nhận được hàng" cũng là câu than → kèm thẻ cần người xem).
    // "đặt/mua/gửi" nằm trong chính câu hỏi ("đã đặt rồi sao chưa thấy") nên không loại theo ORDER_VERB.
    if (!isComment && !phone && !ctx.trialOffer && s.length <= 70 && ORDER_ASK.test(s) && !/\b(lay|chot|cho (minh|em|e|chi|c) \d)\b/.test(s) && !/\b(xanh|vang|nau|cacao|combo|tui|goi)\b/.test(s)) {
      return { rule: 'ORDER_ASK', experimental: true, value: { template_id: 'ORDER_STATUS' }, ...(complaint || ctx.complaint ? { attention: true } : {}) };
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
  return stable;

  function stableRules() {
  // Đã có đơn cũ (> 60 phút, chưa hủy) mà khách "thêm … nữa": có thể là đơn mới hay sửa đơn cũ — không bắt
  // luật nào, để mô hình / ORDER_EXISTING_CONFIRM hỏi lại.
  if (ctx.hasRecentOrder && Number.isFinite(orderAgeMin) && orderAgeMin >= 60 && /\bthem\b.*\bnua\b|\bnua nhe\b/.test(s)) return null;
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
    const asksOrder = ORDER_ASK.test(s) || /\b(don|kiem tra|tra giup|tra don|check|goi lai|goi cho)\b/.test(sAddress);
    if (hasAddress && !PRODUCT_MENTION.test(sAddress) && !asksOrder && orderAgeMin >= 60) {
      return { rule: 'ORDER_INFO', value: { template_id: 'ORDER_INFO_ASK_FLAVOR', Phone_Number: phone, Customer_Address: addressText } };
    }
    if (phoneOnly && SALES_LAST.has(last) && !ctx.hasRecentOrder && !ctx.staffRepliedAfterBot) {
      return { rule: 'ORDER_INFO', value: { template_id: 'ORDER_INFO_ASK_FLAVOR', Phone_Number: phone } };
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
  // "vị nguyên bản" / "truyền thống" khi đang chọn vị (sau ASK_FLAVOR, bước đơn, hay đang giữ giỏ): nguyên bản
  // có 2 túi (Xanh, Vàng) → hỏi tiếp, không gửi bảng giá.
  if (!isComment && /\b(nguyen ban|truyen thong)\b/.test(sFull) && !/\b(xanh|vang|nau|cacao)\b|\d|\bla (sao|gi)\b|khac/.test(sFull) && sFull.length <= 40
    && (ORDER_STEPS.has(last) || ctx.lastWasOrderStep || ctx.hasBasket)) {
    return { rule: 'NGUYENBAN', value: { template_id: 'ASK_FLAVOR_NGUYENBAN' } };
  }
  // "mua ở đâu / mua thế nào": đặt ngay tại đây (ORDER_HELP); nhắc sàn/link mới là ECOMMERCE_LINKS (luật LINKS).
  if (!isComment && HOW_TO_BUY.test(s) && !MARKETPLACE.test(s) && !phone) return { rule: 'HOW_TO_BUY', value: { template_id: 'ORDER_HELP' } };
  // "4/5/6 túi giá bao nhiêu": ngoài bảng combo → ghi nhận, nhân viên tính ưu đãi (thẻ cần người xem).
  if (!isComment && !phone && PRICE.test(s) && BIG_BASKET.test(s) && !ctx.smallPackContext) {
    const [, count] = s.match(BIG_BASKET);
    const quantity = { bon: 4, nam: 5, sau: 6 }[count] || Number(count);
    const colours = [...new Set(s.match(/\b(xanh|vang|nau|cacao)\b/g) || [])].map(colour => (colour === 'cacao' ? 'nau' : colour));
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
    && !(/^(?:\D*\b1 ?(?:tui|goi|bich|bit|bi|bao)\b)/.test(s) && FREESHIP_MENTION.test(s))) return { rule: 'BAGS_NO_FLAVOR', value: { template_id: 'ASK_FLAVOR' } };
  // Vòng 10: "3 túi 3 vị" / "mỗi vị 1 túi" / "3 túi xanh vàng nâu" → 1 Xanh + 1 Vàng + 1 Nâu; "2 túi 2 vị" → hỏi vị.
  // Câu hỏi ("combo 3 túi khác nhau được không", "3 túi khác nhau thế nào") hay xin tư vấn ("tư vấn cả 3 vị") để
  // luật COMBO3 / RECOMMEND / mô hình.
  const politeAsk = ((POLICY_QUESTION.test(s) || QUESTION_TAIL.test(sFull)) && !ORDER_VERB.test(s)) || /\b(the nao|ntn|nhu nao|la sao|la gi|khac gi|ra sao|hay)\b/.test(s) || ADVICE_ASK.test(s);
  if (!isComment && !complaint && orderAgeMin >= 60 && !PRICE.test(s) && !raw.includes('?') && !politeAsk && s.length <= 80 && !BASKET_CHANGE.test(s)) {
    const three = THREE_FLAVOURS.test(s) || (s.match(THREE_COLOURS) && new Set(s.match(THREE_COLOURS).slice(1, 4)).size === 3);
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
    if (split && split.signal === 'count' && !ctx.hasBasket && BAGS_NO_FLAVOR.test(sBasket)) {
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
      const sRest = core(split.address);
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
    const info = items.length && leftover ? INFO_RULES.find(([rule, pattern, , exclude]) => !['FREESHIP', 'DISCOUNT', 'VOUCHER', 'GIFT', 'COMPARE', 'PAYMENT'].includes(rule) && pattern.test(leftover) && !(exclude && exclude(leftover, ctx))) : null;
    if (info) return { rule: 'BASKET_INFO', value: { ...basketValue(items), also: info[2] } };
  }
  // Xin bỏ một thành phần ("không yến mạch", "bỏ hạt", "không lấy quả"): công thức cố định → NO_VARIANT
  // (điền {ingredient} có dấu qua `values`) + thẻ cần người xem. Đặt sau luật giỏ để "cho chị 1 bịch vàng,
  // bịch này ko có yến mạch?" vẫn giữ giỏ; đặt trước LIVE_ONLY vì "hạt điều" cũng là hàng live.
  if (!isComment && NO_VARIANT.test(s)) {
    const named = s.match(/\b(yen mach|hanh nhan|dau phong|hat dieu|trai cay|qua say|qua kho|nho kho)\b/) || s.match(/\bbo (hat|qua)\b|\bkhong lay (qua|hat)\b/);
    const key = named ? (named[1] || named[2] || '') : '';
    return { rule: 'NO_VARIANT', value: { template_id: 'NO_VARIANT', values: { ingredient: INGREDIENT_NAMES[key] || 'thành phần đó' } }, attention: true };
  }
  // Hàng chỉ bán trên live (sữa hạt, hũ hạt, túi Xanh dương/Xanh mint/Tropical, túi dâu): mẫu LIVE_ONLY_PRODUCT
  // + thẻ (engine đổi thành CSKH_HANDOFF cho khách hộp thư không từ live). Câu hỏi thành phần
  // ("có xoài không", "thành phần có hạt điều") thì để mô hình.
  // Vòng 11 (V10): câu hỏi thành phần có đuôi hỏi đã bị core() cắt ("túi xanh có xoài sấy hả", "trong túi vàng
  // có xoài à") hay dạng "có xoài / có hạt điều / có vị dâu" ("granola có xoài sấy", "có vị dâu không") → mô hình,
  // không phải hỏi mua hàng live (inbox thường sẽ bị chuyển người + tắt bot). "bên em có túi dâu không" vẫn là LIVE_ONLY.
  const ingredientAsk = (LIVE_INGREDIENT.test(s) || /\bvi dau\b/.test(s))
    && (POLICY_QUESTION.test(s) || QUESTION_TAIL.test(sFull) || /\b(a|ah|ha)$/.test(sFull) || /\b(thanh phan|di ung|gom)\b/.test(s) || /\bco (?:vi )?(xoai|hat dieu|dau say|dau)\b/.test(s));
  if (!isComment && !phone && LIVE_ONLY.test(s) && !ingredientAsk) {
    return { rule: 'LIVE_ONLY', value: { template_id: 'LIVE_ONLY_PRODUCT' }, attention: true };
  }
  // Đang giữ giỏ, khách tóm tắt xin xác nhận ("2 túi xanh 298k miễn ship đúng không"): CONFIRM_YES,
  // engine tự kèm dòng giỏ. Có ý đổi/thêm/bớt/hủy thì để mô hình.
  if (!isComment && ctx.hasBasket && !phone && !BASKET_CHANGE.test(s) && CONFIRM_TAIL.test(sFull)) {
    return { rule: 'CONFIRM_SUMMARY', value: { template_id: 'CONFIRM_YES' } };
  }
  // Vòng 10: bot vừa hỏi vị, khách trả lời một màu ("Túi xanh", "Vàng nhiều hạt", "Nâu cacao ạ", "xanh") → 1 túi màu đó.
  if (!isComment && !phone && FLAVOR_ASK_LAST.has(last) && !ctx.staffRepliedAfterBot && Number(ctx.botLastAgeMin) <= 1440 && !PRICE.test(s) && !raw.includes('?')
    && !/\b(2|3|4|5|6|7|8|9)\b|\d{2}/.test(s) && !s.replace(FLAVOR_ANSWER_WORDS, ' ').trim()) {
    const chosen = [...new Set(s.match(/\b(xanh|vang|nau|cacao)\b/g) || [])].map(colour => (colour === 'cacao' ? 'nau' : colour));
    const product = chosen.length === 1 ? colourSku(chosen[0]) : null;
    // Vòng 11 (P5): số túi khách nêu trước khi bot hỏi vị ("cho chị 2 túi" → ASK_FLAVOR → "vàng" = 2 túi vàng):
    // engine truyền ctx.askedBagCount; khách ghi rõ "1" trong câu trả lời thì theo khách. Khách đã nói nhiều vị
    // ("2 túi 2 vị") mà chỉ trả một màu: chưa rõ → mô hình.
    const asked = Math.round(Number(ctx.askedBagCount) || 0);
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
    if (!ctx.hasBasket && FLAVOR_LIST.test(s)) return { rule: 'FLAVOR_LIST', value: { template_id: 'GENERAL_INFO' } };
  }
  // Xin gợi ý ("mới tập ăn thì lấy loại nào", "tư vấn c 1 túi"): có động từ đặt/số túi nhưng không phải giỏ
  // → RECOMMEND_BEGINNER (luật INFO bên dưới loại câu có động từ đặt nên xét riêng ở đây).
  if (!isComment && !phone && !complaint && !ctx.complaint && s.length <= 70 && !PRICE.test(s) && INFO_RULES.find(([rule]) => rule === 'RECOMMEND')[1].test(s)) {
    return { rule: 'RECOMMEND', value: { template_id: 'RECOMMEND_BEGINNER' } };
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
    // Đang ở bước lên đơn: giữ bước đơn, trả lời câu hỏi bằng ý phụ. Xin gợi ý ("tư vấn c 1 túi nữa")
    // thì trả lời thẳng: mẫu đã mời chọn 1 túi / combo 2, không tự cộng túi vào giỏ.
    // Vòng 11 (P1): sau CONFIRM_YES ("Dạ đúng rồi ạ, gửi em SĐT + địa chỉ") giỏ vẫn đang giữ → cùng cách
    // (engine trả lời câu hỏi + nhắc ngắn giỏ, không lưu lại giỏ).
    if (ctx.hasBasket && (ctx.lastWasOrderStep || last === 'CONFIRM_YES') && rule !== 'RECOMMEND') return { rule, value: { template_id: 'ORDER_ADDRESS', also: target } };
    return { rule, value };
  }
  return null;
  }
}

export { ORDER_STEPS as ruleOrderSteps, INFO_RULES as infoRules };
