// Luồng đơn tất định: bot đang xin SĐT/địa chỉ (giỏ đã có, còn hạn) mà khách chỉ gửi SĐT, địa chỉ,
// cả hai, hay "gửi địa chỉ cũ" — không cần hỏi LLM. Trả về giá trị như LLM sẽ trả (template_id
// ORDER_ADDRESS + slot vừa nhận); bộ soạn đơn (renderOrder) tự ghép với giỏ đang giữ và quyết
// xin phần còn thiếu (ORDER_ADDRESS_PARTIAL/CLARIFY) hay chốt (ORDER_CONFIRMATION).
// Khách nhắc sản phẩm/số lượng/đổi/hủy hay đặt câu hỏi thì để LLM đọc.
import { extractVietnamesePhone, toLocalPhone } from './customer-info.mjs';
import { ADDRESS_WORDS, normalizeIntentText } from './intent-features.mjs';
import { dedupeAddressSegments, describeDeliveryAddress } from './locations.mjs';

const CHANGE = /\b(tui|goi|bich|xanh|vang|nau|cacao|combo|huy|doi|them|bot|nua|khong lay|ko lay|k lay|lay \d|\d (tui|goi|bich))\b/;
const ADMIN = /\b(xa|huyen|quan|phuong|thi tran|thi xa|tinh|tp|thanh pho|ap|thon|khu pho|kp)\b/g;
// "địa chỉ cũ", "đ/c như cũ", "địa chỉ vẫn thế", "dc đã gửi", "gửi dc cũ", "đã gửi địa chỉ", "gọi địa chỉ cũ"…
// "dc" cũng là "được" nên với "dc"/"d c" chỉ nhận vế rõ (cũ / như cũ / đã gửi / gửi rồi / lần trước / đơn trước),
// không nhận "dc trước" ("giao dc trước thứ 7") hay "dc vẫn thế".
// Vòng 11 (N14): bỏ vế "cho cu" / "gui cho cu" — bỏ dấu trùng "gửi cho cụ" (người già nhận hàng), không phải "chỗ cũ".
// Dùng chung với renderOrder (chatbot-templates.mjs, wantsPrevious) qua mentionsOldAddress().
// Vòng 12 (inbox-3 #2): thêm "như mấy lần / như mọi lần / như các lần", "giống lần/đơn/hôm trước",
// "đơn cũ cho chị", "như/theo/giống đơn cũ", "dia chi cu" viết liền không dấu.
export const OLD_ADDRESS = /\b(dia chi cu|dia chi (nhu|giong) (lan|hom) truoc|nhu (lan|don) truoc|ve cho cu|dia chi lan truoc|nhu cu)\b|\b(dia chi|dia chi nhan)\s*(cu|nhu cu|van the|da gui|gui roi|truoc|lan truoc|don truoc|nhu (lan|don|hom) truoc)\b|\b(dc|d c)\s*(cu|nhu cu|da gui|gui roi|lan truoc|don truoc)\b|\bgui (dc|dia chi) (cu|truoc)\b|\bda gui (dc|dia chi)\b|\bgoi dia chi cu\b|\bnhu (may|moi|cac|nhung) lan( truoc)?\b|\bgiong (lan|don|hom|dot) truoc\b|\bdon cu cho\b|\b(nhu|theo|giong) don cu\b|\bdiachi cu\b/;
const FILLER = new Set(['sdt', 'so', 'dien', 'thoai', 'dt', 'cua', 'minh', 'em', 'e', 'chi', 'c', 'anh', 'a', 'toi', 'day', 'la', 'nhe', 'nha', 'nghen', 'ok', 'oke', 'da', 'va', 'dc', 'duoc', 'roi', 'ne', 'shop', 'sop', 'gui', 'ship', 'giao', 've', 'cho', 'thi', 'ạ', 'nhen', 'nhá', 'sđt', 'zalo', 'lien', 'he', 'goi']);
// Vòng 10: địa chỉ CHƯA đủ ba cấp ("270 Nguyễn Văn Cừ tp Vinh Nghệ An", "Na Hang", "Huyện Sơn Tịnh", "Số 17, đường 38,
// P. Thảo Điền") khi bot đang xin địa chỉ: vẫn đưa vào bộ soạn đơn — nó tự hỏi đúng cấp còn thiếu
// (ORDER_ADDRESS_CLARIFY), như mô hình vẫn làm. Không nhận câu hỏi/chính sách ("giao Hà Nội mấy ngày", "ship về
// Cà Mau được không", "có giao tận nơi không") hay chữ không giống địa chỉ ("để mình xem lại").
const NOT_ADDRESS = /\b(bao lau|may ngay|bn ngay|bao nhieu|bnhiu|bn|khi nao|chung nao|gia|phi|mien|free|tan noi|tan nha|co (giao|ship|toi|den|ve)|(giao|ship|toi|den|gui|van chuyen) (duoc|dc|ko|khong|k|toi|den|ve)|(duoc|dc) (khong|ko|k|kg|hong)|(xa|gan) (khong|ko|k|qua|lam)|the nao|ntn|ra sao|lam sao|o dau|noi khong|noi ko)\b/;
/**
 * Bỏ SĐT khỏi tin, giữ số đứng trước/sau nó: "quận 1 0912345678" (mẫu SĐT chung nuốt cả "1 "), "0912345678 12 Lê
 * Lợi…" (mẫu chung nuốt cả số nhà "12"). SĐT 10 số (0… / +84…, có thể cách bằng dấu cách/chấm/gạch) bỏ chính xác;
 * không thấy dạng đó thì dùng mẫu chung như cũ.
 */
export function stripPhone(raw) {
  const text = String(raw || '');
  const precise = text.replace(/(?<![\d])(?:\+?84[ .-]?|0)\d(?:[ .-]?\d){8}(?![\d])/g, ' ');
  if (precise !== text) return precise;
  return text.replace(/\+?\d[\d .-]{8,13}/g, match => {
    const lead = match.match(/^(\d{1,2})\s+(?=\d)/);
    return lead && /^(0|84)\d{8,9}$/.test(match.slice(lead[0].length).replace(/\D/g, '')) ? `${lead[1]} ` : ' ';
  });
}

/**
 * R13 (inbox1 A4): chuẩn hoá lỗi gõ màu/vị ("vag/vàg/vangf" → vàng, "1 túi vành" → vàng, "xah/xamh" → xanh,
 * "2ca cao"/"cá cao" → "2 cacao"). Xuất lại ở rule-intent.mjs (giao diện dùng chung với chatbot-templates).
 */
export function normalizeColourTypos(text) {
  return String(text || '').normalize('NFC')
    // R13 (basket): chữ CÒN DẤU không phải tên vị dù bỏ dấu trùng chữ — "vâng" (dạ vâng) ≠ Vàng → "dạ"; "nấu" (nấu sữa
    // hạt) ≠ Nâu → "pha". Khách gõ không dấu ("vang", "nau") thì vẫn hiểu là vị như cũ.
    // ("Túi vâng", "1 vâng": gõ nhầm dấu của "vàng" khi đứng ngay sau số hay túi/gói/bịch/màu/vị/loại.)
    .replace(/((?:\d|(?<![\p{L}])(?:túi|tui|gói|goi|bịch|bich|màu|mau|vị|vi|loại|loai))\s*)v[âấầẩẫậ]ng(?![\p{L}\p{N}])/giu, '$1vàng')
    .replace(/(?<![\p{L}\p{N}])(?:dạ\s+)?v[âấầẩẫậ]ng(?![\p{L}\p{N}])/giu, 'dạ')
    .replace(/(?<![\p{L}\p{N}])nấu(?![\p{L}\p{N}])/giu, 'pha')
    .replace(/(\d)\s*(?=c[aáà]\s*[ck]ao(?![\p{L}]))/giu, '$1 ')
    .replace(/(?<![\p{L}])(?:c[aáà]\s+[ck]ao|c[áà][ck]ao|cakao|cacoa|c[aâ]co|ca\s*cao)(?![\p{L}])/giu, 'cacao')
    // "ca cao 300g" là Granola Tropical vị Cacao 300g (GRA-MINT-Z300), không phải Túi Nâu cacao 350g.
    .replace(/(?<![\p{L}])cacao\s*300\s*(?:g|gr|gam|gram)?(?![\p{L}\p{N}])/giu, 'tropical')
    .replace(/(?<![\p{L}])(?:vag|vàg|vangf|vàngf|vangg|vàngg|vnag|vagf|vangd|vàngd)(?![\p{L}\p{N}])/giu, 'vàng')
    .replace(/(?<![\p{L}])(?:naau|nâuu|nauu)(?![\p{L}\p{N}])/giu, 'nâu')
    // R14 (…837888): "2 túi 1 xanh + lâu" — "lâu" ngay sau số, túi/gói/bịch/màu/vị hay dấu "+" là Nâu gõ sai ("để lâu" giữ nguyên).
    .replace(/((?:\d|\+|(?<![\p{L}])(?:túi|tui|gói|goi|bịch|bich|màu|mau|vị|vi))\s*)lâu(?![\p{L}\p{N}])/giu, '$1nâu')
    .replace(/((?:\d|(?<![\p{L}])(?:túi|tui|gói|goi|bịch|bich|màu|mau|vị|vi|loại|loai))\s*)vành(?![\p{L}])(?!\s+đai)/giu, '$1vàng')
    .replace(/(?<![\p{L}])(?:xah|xanhh+|xamh|xnah)(?=\d|(?![\p{L}]))/giu, 'xanh ')
    .replace(/xanh {2,}/g, 'xanh ');
}

/** Tin khách có nói "gửi về địa chỉ cũ / như lần trước / dc cũ…" không (cùng bộ từ với luồng đơn tất định). */
export function mentionsOldAddress(text) {
  return OLD_ADDRESS.test(normalizeIntentText(String(text || '')));
}
// fix-addr (01/10): câu hỏi/phủ định không phải địa chỉ ("Quà thay là gì ạ" từng thành Thị xã La Gi và thay địa chỉ đã
// lưu; "Không phải Tân An long an" là khách đính chính — để LLM đọc).
// Từ chỉ cấp/đơn vị địa chỉ rõ (đã bỏ dấu), đủ để coi là mảnh địa chỉ dù chưa đọc ra tỉnh ("xã Vô Tranh", "thôn Đông").
const STRONG_ADDRESS_WORDS = /\b(phuong|huyen|thi tran|thi xa|thon|khu pho|ngo|hem|ngach|so nha|chung cu|tinh|xom|to dan pho)\b|\bxa (?!(?:xa|lam|qua|khong|ko|k|dung|dum|giup|de|nhe|nha|ha|hon|roi|vay|the|ma|va|nhat|lac)\b)[a-z]{2,}/;
const NOT_ADDRESS_PHRASE =/\b(la gi|gi vay|gi the|gi a|khong phai|ko phai|k phai|kh phai|hong phai|chua phai|dau phai)\b/;
// Không có từ địa chỉ thì phải có chữ số (số nhà/ngõ) hoặc đọc ra đủ quận + tỉnh khách ghi: một tên quận/huyện đứng
// trơ trọi ("Ba túi ba vị" → Ba Vì, "La Gi") không đủ là địa chỉ.
const looksLikeAddress = (raw, normalizedText) => {
  // R13: "Gia Lai/Gia Lộc/xã Gia Ninh" bỏ dấu trùng "giá" (NOT_ADDRESS) — che địa danh trước khi dò từ hỏi giá.
  const normalized = maskPlaceGia(normalizedText);
  if (!raw || raw.length > 200 || NOT_ADDRESS.test(normalized) || NOT_ADDRESS_PHRASE.test(normalized)) return false;
  const resolved = describeDeliveryAddress(raw).resolved;
  // Từ địa chỉ kèm chữ số hay một cấp đọc ra được; "đường" (đường ăn), "xa" (date xa), "quán" một mình thì không.
  if (ADDRESS_WORDS.test(normalized)) return /\d/.test(raw) || Boolean(resolved?.province) || STRONG_ADDRESS_WORDS.test(normalized);
  if (!resolved?.province) return false;
  return /\d/.test(raw) || Boolean(resolved.ward || resolved.postMerger) || Boolean(resolved.district && provinceNamed(raw, resolved));
};

// ===== R13 (inbox1 A1): địa danh "Gia …" / "Tổng …" bỏ dấu trùng "giá" / "tổng" =====
// "huyện gia Lộc", "tỉnh gia lai", "ngõ 3 Gia Lâm", "xã gia ninh": chữ "gia" đứng trước tên địa danh hay ngay sau cấp
// hành chính là ĐỊA DANH, không phải hỏi giá. Nhận cả chữ còn dấu lẫn đã bỏ dấu; trả chuỗi đã đổi "gia" → "gja".
// ("giá" CÓ dấu sắc không bao giờ bị che: "tỉnh giá bao nhiêu" hiếm, và chữ có dấu thì khách đang hỏi giá thật.)
const GIA_PLACE_NEXT = 'lai|lâm|lam|lộc|loc|nghĩa|nghia|rai|viễn|vien|kiệm|kiem|ninh|thụy|thuy|định|dinh';
const GIA_BEFORE_PLACE = new RegExp(`(?<![\\p{L}\\p{N}])gia(?=\\s+(?:${GIA_PLACE_NEXT})(?![\\p{L}\\p{N}]))`, 'giu');
const GIA_AFTER_ADMIN = /((?<![\p{L}\p{N}])(?:huyện|huyen|xã|xa|phường|phuong|tỉnh|tinh|thị xã|thi xa|thị trấn|thi tran|tx|tt|tp|quận|quan)\s+)gia(?![\p{L}\p{N}])/giu;
export function maskPlaceGia(text) {
  return String(text || '').replace(GIA_BEFORE_PLACE, 'gja').replace(GIA_AFTER_ADMIN, '$1gja');
}
// Từ cấp hành chính / số nhà đủ rõ để coi tin là ĐỊA CHỈ (đã bỏ dấu). "xã" phải kèm tên ("ship xa không" thì không).
const ADDRESS_MESSAGE_WORDS = /\b(phuong|huyen|thi tran|thi xa|thon|xom|khu pho|to dan pho|tdp|ngo|hem|ngach|so nha|chung cu|tinh)\b|\bxa (?!(?:xa|lam|qua|khong|ko|k|dung|dum|giup|de|nhe|nha|ha|hon|roi|vay|the|ma|va|nhat|lac|thi|co|duoc|dc|xoi)\b)[a-z]{2,}|\b(?:to|ap|doi|khu|kp|q|p|quan) ?\d{1,2}\b|\bap (?!dung\b|luc\b|suat\b|vao\b|ma\b|gia\b)[a-z]{2,}/;
// Khách đang HỎI (giá/ship/thời gian) chứ không gửi địa chỉ — "giá" chỉ tính khi còn dấu (xem maskPlaceGia).
const ADDRESS_MESSAGE_ASK = /\b(bn|bao nhieu|bnhiu|bao tien|nhieu tien|bao lau|may ngay|khi nao|duoc khong|dc khong|dc ko|duoc ko|co (?:giao|ship)|ship (?:khong|ko|k))\b/;
/**
 * Tin của khách có phải là (mang) ĐỊA CHỈ giao hàng không: có từ cấp hành chính rõ, hay đọc ra được tỉnh + quận/huyện
 * hoặc phường/xã; đang ở bước đơn (`orderStep`) thì chỉ cần đọc ra tỉnh. Câu hỏi ("?", "bao nhiêu", "giá" còn dấu,
 * "bao lâu", "có giao … không") không phải địa chỉ. Dùng chung cho luồng dùng thử (trial-flow) và luật giỏ.
 */
export function looksLikeAddressMessage(raw, { orderStep = false } = {}) {
  const text = stripPhone(String(raw || '')).replace(/\s+/g, ' ').trim();
  if (text.length < 6 || text.length > 300 || text.includes('?')) return false;
  if (/(?<![\p{L}])(?:giá|gía)(?![\p{L}])/iu.test(text.normalize('NFC'))) return false;
  const s = normalizeIntentText(maskPlaceGia(text));
  if (ADDRESS_MESSAGE_ASK.test(s) || NOT_ADDRESS_PHRASE.test(s)) return false;
  if (ADDRESS_MESSAGE_WORDS.test(s)) return true;
  const resolved = describeDeliveryAddress(text).resolved;
  if (!resolved?.province) return false;
  return Boolean(resolved.district || resolved.ward || resolved.postMerger) || (orderStep && provinceNamedOnly(text, resolved));
}
// Bước đơn: khách chỉ ghi tên tỉnh/thành ("Gia Lai", "Hà Nội nha") — chữ tỉnh phải có trong tin.
function provinceNamedOnly(raw, resolved) {
  const province = normalizeIntentText(String(resolved.province?.name || '').replace(/^(?:tỉnh|thành phố|tp)\s+/iu, ''));
  return Boolean(province) && normalizeIntentText(raw).includes(province);
}

/** Khách tự ghi tên tỉnh (không phải máy suy ra từ một tên quận duy nhất cả nước). */
function provinceNamed(raw, resolved) {
  const district = String(resolved.district?.name || '');
  const province = normalizeIntentText(String(resolved.province?.name || '').replace(/^(?:tỉnh|thành phố|tp)\s+/iu, ''));
  const text = normalizeIntentText(raw);
  const districtBare = normalizeIntentText(district.replace(/^(?:quận|huyện|thị xã|thành phố)\s+/iu, ''));
  return Boolean(province) && text.includes(province) && province !== districtBare;
}

/**
 * @param {string} text tin khách
 * @param {{ hasBasket?: boolean, lastWasOrderStep?: boolean, source?: string, complaint?: boolean, addressComplete?: boolean, addressText?: string, trialOffer?: boolean, hasPreviousDelivery?: boolean }} ctx
 *   hasPreviousDelivery: engine truyền — có đơn cũ / địa chỉ giao lần trước để lấy lại không. Bỏ trống (undefined)
 *   thì coi như có (giữ hành vi cũ: bộ soạn đơn tự tra); `false` rõ ràng thì xin SĐT đã đặt lần trước.
 * @returns {{ rule: string, value: Record<string, string>, attention?: boolean } | null}
 */
export function orderFlowStep(text, ctx = {}) {
  if (!ctx.hasBasket || ctx.source === 'comment' || ctx.complaint) return null;
  const raw = String(text || '').trim();
  if (!raw || raw.includes('?')) return null;
  const s = normalizeIntentText(raw);
  // "gọi địa chỉ cũ": "gọi" bỏ dấu thành "gói" (từ đổi giỏ) — bỏ cụm này trước khi dò CHANGE.
  if (CHANGE.test(s.replace(ADMIN, ' ').replace(/\bgoi dia chi cu\b/g, ' '))) return null;
  // R13 (models A4, ca …068500): "2ca cao,<sđt>,79xom hạ…" / "2 t ap 4 hoa binh…" — phần chữ ngoài SĐT mang GIỎ viết sai
  // hay viết tắt (CHANGE không thấy "ca cao", "2 t"): không phải tin chỉ có SĐT/địa chỉ → trả null để luật giỏ + địa chỉ
  // (BASKET_ADDRESS) hay mô hình đọc cả giỏ; trước đây chốt đơn với số túi cũ và "2ca cao" nằm trong địa chỉ.
  if (CHANGE.test(normalizeIntentText(normalizeColourTypos(raw)).replace(ADMIN, ' ').replace(/\bgoi dia chi cu\b/g, ' '))) return null;
  if (LEADING_BASKET_SHORT.test(stripPhone(raw).replace(PHONE_LABEL, ' ').replace(/^[\s,.;:!\-–]+/u, ''))) return null;
  // Vòng 12 (inbox-3 #2): "địa chỉ cũ" khi đang giữ giỏ là đủ rõ, không cần bot vừa hỏi SĐT/địa chỉ.
  if (OLD_ADDRESS.test(s)) {
    // "Địa chỉ cũ" mà hệ thống không có đơn/địa chỉ giao trước của khách này: xin SĐT đã đặt lần trước
    // để tra (ORDER_ADDRESS_OLD_ASK_PHONE) + thẻ cần người xem.
    if (ctx.hasPreviousDelivery === false) return { rule: 'OLD_ADDRESS_ASK', value: { template_id: 'ORDER_ADDRESS_OLD_ASK_PHONE' }, attention: true };
    return { rule: 'OLD_ADDRESS', value: { template_id: 'ORDER_ADDRESS', Phone_Number: '0', Customer_Address: '0' } };
  }
  // R13 (inbox2 A3): khách vừa hẹn dịp khác (ORDER_POSTPONED, giỏ còn giữ) rồi gửi SĐT/địa chỉ → vẫn là bước đơn, chốt được.
  if (!ctx.lastWasOrderStep && ctx.botLastTemplateId !== 'ORDER_POSTPONED') return null;
  const phone = extractVietnamesePhone(raw);
  // Vòng 12: mọi nhánh (cả nhánh địa chỉ đủ) đều lọc nhãn "sđt/đc/Tên:/shop."… và chữ đệm cuối câu.
  const address = cleanAddressText(ctx.addressText || raw);
  // R13 sửa (phản biện L2): cleanAddressText cắt đuôi câu hỏi quà/ship ("… Sơn Động Bắc Giang có tặng quà phải k bạn") → câu hỏi
  // được trả lời cùng lượt bằng ý phụ (also GIFT_POLICY / FREESHIP_POLICY) thay vì bị bỏ.
  const alsoFor = trailingQuestionTopic(ctx.addressText || raw);
  const withAlso = value => (alsoFor ? { ...value, also: alsoFor } : value);
  if (phone && ctx.addressComplete) return { rule: 'PHONE_ADDRESS', value: withAlso({ template_id: 'ORDER_ADDRESS', Phone_Number: phone, Customer_Address: address }) };
  if (phone) {
    const leftover = s.replace(/<sdt>/g, ' ').split(' ').filter(Boolean);
    if (leftover.every(word => FILLER.has(word))) return { rule: 'PHONE_ONLY', value: { template_id: 'ORDER_ADDRESS', Phone_Number: phone } };
    // SĐT + địa chỉ chưa đủ cấp ("<sđt> Xóm 3 xã Vô Tranh Phú Lương"): vẫn đưa vào, bộ soạn đơn hỏi phần thiếu.
    if (looksLikeAddress(address, normalizeIntentText(address))) return { rule: 'PHONE_ADDRESS_PARTIAL', value: withAlso({ template_id: 'ORDER_ADDRESS', Phone_Number: phone, Customer_Address: address }) };
    return null;
  }
  if (ctx.addressComplete) return { rule: 'ADDRESS_COMPLETE', value: withAlso({ template_id: 'ORDER_ADDRESS', Customer_Address: address }) };
  if (looksLikeAddress(address, s)) return { rule: 'ADDRESS_PARTIAL', value: withAlso({ template_id: 'ORDER_ADDRESS', Customer_Address: address }) };
  return null;
}

// ===== Vòng 12: làm sạch chữ khách ghi trước khi lên phiếu =====

// Nhãn SĐT ở bất kỳ đâu (SĐT đã bỏ): "sđt", "Sdt:", "số đt", "zalo". "ĐT"/"Dt" chỉ là nhãn khi
// không có số đứng ngay sau ("ĐT 741" là đường tỉnh).
// R13: "S₫t." (gõ ₫ thay đ) cũng là nhãn SĐT.
const PHONE_LABEL = /(?<![\p{L}\p{N}])(?:s[đd₫]t|số\s*điện\s*thoại|so\s*dien\s*thoai|số\s*đt|so\s*dt|zalo|phone|tel)(?![\p{L}\p{N}])\s*[:：.]?|(?<![\p{L}\p{N}])(?:đt|dt)(?![\p{L}\p{N}])(?!\s*\d)\s*[:：.]?/giu;
// Nhãn/câu dẫn ở đầu: "đc", "địa chỉ:", "shop.", "Gửi về ĐC", "Mình ở", "Tên:", "Fb:".
const LEADING_LABELS = [
  /^\s*(?:shop|sop)\s*[.,:;!]+\s*/iu,
  /^\s*(?:tên|ten|fb|facebook|name|người nhận|nguoi nhan)\s*[:：]\s*/iu,
  /^\s*(?:địa\s*chỉ(?:\s*nhận(?:\s*hàng)?)?|dia\s*chi(?:\s*nhan(?:\s*hang)?)?|đ\/c|d\/c|đ\.c|đc|dc|đchi|dchi)(?![\p{L}\p{N}])\s*[:：.\-]?\s*/iu,
  // R13 (inbox2 C1): "Vui lòng giao đến địa chỉ 275/97/14…", "nhờ shop gửi về…" — thêm lời nhờ đứng trước.
  /^\s*(?:(?:vui\s+lòng|vui\s+long|làm\s+ơn|lam\s+on|nhờ|nho|phiền|phien)\s+)?(?:(?:shop|sop|em|e|bạn|ban)\s+)?(?:gửi|gởi|gui|ship|giao|chuyển|chuyen)\s+(?:(?:hàng|hang)\s+)?(?:(?:giúp|giup|giùm|dùm|cho)\s+(?:mình|minh|em|e|chị|chi|c|anh|a|tôi|toi)\s+)?(?:về|đến|tới|ve|den|toi|qua)\s*(?:(?:địa\s*chỉ|dia\s*chi|đc|dc|đ\/c)(?![\p{L}\p{N}])\s*[:：]?\s*)?/iu,
  // R13 (inbox2 A4/C1): "về, 12 Lê Lợi…", "về 83 hải phòng…" — chữ "về" trơ trọi đầu chuỗi (trước dấu phẩy hay số nhà).
  /^\s*(?:về|ve)\s*(?:[,:;]\s*|\s+(?=\d))/iu,
  // R14 (…049331): "gửi địa chỉ 158, thôn 8…", "ship đc: …" — động từ gửi + nhãn địa chỉ (không có "về/đến").
  /^\s*(?:gửi|gởi|gui|goi|ship|giao)\s+(?:(?:về|ve)\s+)?(?:địa\s*chỉ|dia\s*chi|đ\/c|d\/c|đc|dc)(?![\p{L}\p{N}])\s*[:：.\-]?\s*/iu,
  // R14 (…027555): "chỉ tổ dân phố…" — đuôi của chữ "Địa chỉ" (khách chép từ ảnh) đứng đầu, ngay trước cấp/số nhà.
  /^\s*chỉ\s*[:：.\-]?\s+(?=(?:tổ|to|thôn|thon|ấp|ap|xóm|xom|số|so|sn|khu|kp|tdp|đường|duong|ngõ|ngo|hẻm|hem|phường|phuong|xã|xa|\d))/iu,
  /^\s*(?:nhà\s+)?(?:mình|minh|em|e|chị|chi|c|anh|a|tôi|toi|t|cô|chú|bác)\s+ở\s+/iu,
  /^\s*ở\s+(?=\S)/iu
];
// "<Tên>:" ở đầu ("Linh:", "Nguyen Huong:", "Chị tâm Địa chỉ:"): tối đa 4 chữ, không số, không là cấp hành chính.
const NAME_COLON = /^\s*([\p{L}][\p{L}\s]{0,40}?)\s*[:：]\s*(?=\S)/u;
const ADMIN_OR_STREET = /(?<![\p{L}])(phường|xã|quận|huyện|tỉnh|thành phố|thị trấn|thị xã|thôn|ấp|xóm|tổ|khu|số|đường|ngõ|ngách|hẻm|kiệt|phố|tp|kp)(?![\p{L}])/iu;
// Người nhận chen giữa ("chuyển cho chị Ngân", "giao cho anh Tuấn").
const RECEIVER_PHRASE = /(?:^|[\s,.;])(?:chuyển|chuyen|gửi|gởi|gui|giao)\s+(?:cho|tới|toi)\s+(?:anh|chị|chi|em|cô|chú|bác|a|c|e|bạn)\s+\p{Lu}[\p{L}]*(?:\s+\p{Lu}[\p{L}]*)?(?=$|[\s,.;])/gu;
// R14 (…078679): lời giới thiệu tên người nhận lẫn trong khối địa chỉ ("e tên yến sdt …", "chị tên là Lan, số 5…"): bỏ cả
// cụm. Tên 1–4 chữ, không chữ nào là từ chỉ nơi chốn/cấp hành chính; sau tên phải là hết đoạn, dấu ngăn, số hay từ chỉ nơi chốn.
const NAME_INTRO_PLACE = '(?:thôn|thon|ấp|ap|xóm|xom|số|so|sn|tổ|to|khu|kp|đường|duong|phố|pho|ngõ|ngo|hẻm|hem|phường|phuong|xã|xa|quận|quan|huyện|huyen|tỉnh|tinh|tp|thành|thanh|thị|thi|trường|truong|chợ|cho|nhà|nha)(?![\\p{L}])';
const NAME_INTRO = new RegExp(`(?<![\\p{L}\\p{N}])(?:e|em|chị|chi|c|anh|a|mình|minh|tôi|toi|t|mk|cháu|chau)\\s+tên\\s+(?:là\\s+|la\\s+)?(?!${NAME_INTRO_PLACE})\\p{L}+(?:\\s+(?!${NAME_INTRO_PLACE})\\p{L}+){0,3}(?=\\s*(?:[,.;\\n]|$)|\\s+(?:${NAME_INTRO_PLACE}|\\d))`, 'giu');
// Ghi chú giao hàng nằm lẫn trong địa chỉ.
const DELIVERY_NOTE = /(?:giao|ship|gọi|goi)?\s*(?:trong\s+)?giờ\s+hành\s+chính|gio\s+hanh\s+chinh|gọi\s+trước\s+khi\s+giao|goi\s+truoc\s+khi\s+giao|tránh\s+(?:ngày\s+)?(?:chủ\s+nhật|cn|t7|thứ\s+7)|giao\s+(?:buổi\s+)?(?:sáng|chiều|tối)(?:\s+(?:thứ\s+\d|cn|chủ\s+nhật))?/giu;
// Chữ đệm cuối câu.
// fix-addr (01/10): chữ đệm phải là một từ riêng — "ạ" cuối "Láng Hạ" không phải chữ đệm ("phố Láng Hạ" từng thành "Láng H").
// R13 (basket): "… Quận 1 nhé b", "… Hà Nội nhé bạn", "… khu phố 3 nha c" — lời gọi một chữ chỉ cắt khi đứng ngay sau
// "nhé/nha" ("Khu B", "lô C" trơ trọi giữ nguyên).
const TRAILING_PARTICLES = /[\s,.;:!~-]*(?<![\p{L}\p{N}])(?:(?:(?:nhé|nhe|nha|nhá|nhen|nghen)\s+(?:b|bạn|ban|c|chị|chi|a|anh|ad)|nhé|nhe|nha|nhá|ạ|nhen|nghen|nhaa|nhaaa|shop|sop|giúp\s+em|giùm|dùm|với|e\s+nhé|em\s+nhé|em\s+nha|e\s+nha|em\s+ơi|e\s+ơi|ạ\s+shop)(?![\p{L}\p{N}])[\s,.;:!~-]*)+$/iu;
// Câu trả lời ngắn chen trước địa chỉ ("1 trước ạ.", "ok shop.", "vâng ạ."): bỏ khi không có chữ địa chỉ.
// fix-addr (01/10): chữ đệm cuối phải là một từ riêng ("88 Láng Hạ," không phải "… ạ,"), và đoạn có số nhà + tên
// đường ("12 Lê Lợi nha,") không phải câu trả lời ngắn — xem looksLikeHouseAndStreet.
const LEADING_REPLY = /^\s*([^.!?,;\n]{1,30}?(?<![\p{L}\p{N}])(?:ạ|nhé|nha|nhá|ha|shop|ok|oke|vâng|dạ))\s*(?:[.!]+[\s,;]*|[,;]\s*)(?=\S)/iu;
// Số nhà + ít nhất hai chữ tên đường ("12 Lê Lợi", "88 láng hạ"); "1 trước", "2 túi nha" thì không.
function looksLikeHouseAndStreet(reply) {
  const body = String(reply || '').replace(/(?<![\p{L}\p{N}])(?:ạ|nhé|nha|nhá|ha|shop|ok|oke|vâng|dạ)\s*$/iu, '').trim();
  return /\d/.test(body) && !/\d\s*(?:túi|tui|gói|goi|bịch|hộp|combo|set)(?![\p{L}])/iu.test(body)
    && /\d[\p{L}\d\/\-]*\s+\p{L}+\s+\p{L}+/u.test(body);
}

// ===== R13: rác quanh địa chỉ (inbox1 C1/C4, inbox2 C1, inbox3 F2) =====
const COLOUR_WORD = '(?:xanh|vàng|vang|nâu|nau|cacao|c[aáà]\\s*cao)';
const BAG_UNIT = '(?:túi|tui|gói|goi|bịch|bich)';
// "2ca cao, 79xom hạ…", "1 xanh 1 vàng, 12 Lê Lợi…": số + (túi) + MÀU rồi dấu ngăn. Màu bắt buộc → không đụng số nhà.
const LEADING_BASKET_COLOUR = new RegExp(`^\\s*(?:\\d{1,2}\\s*${BAG_UNIT}?\\s*${COLOUR_WORD}(?![\\p{L}])\\s*(?:và|va|\\+|,)?\\s*)+[,.;:\\-–]+\\s*(?=\\S)`, 'iu');
// "2 túi xanh 12 Lê Lợi…": có chữ túi/gói/bịch + màu thì không cần dấu ngăn.
const LEADING_BASKET_UNIT = new RegExp(`^\\s*(?:\\d{1,2}\\s*${BAG_UNIT}\\s+${COLOUR_WORD}(?![\\p{L}])\\s*(?:và|va|\\+|,)?\\s*)+(?=\\S)`, 'iu');
// "2 t ap 4 hoa binh…", "2 túi thôn 3…": số + t/túi/gói/bịch đứng ngay trước ấp/thôn/xóm/tổ/khu phố (các cấp này không
// mang số nhà đứng trước). Chữ tắt "t" chỉ nhận trước các cấp đó — "2 T Trần Phú" (số nhà 2T) giữ nguyên.
const LEADING_BASKET_SHORT = new RegExp(`^\\s*\\d{1,2}\\s*(?:t|${BAG_UNIT})\\s+(?=(?:ấp|ap|thôn|thon|xóm|xom|tổ|to|khu\\s+phố|khu\\s+pho|kp|tdp)(?![\\p{L}]))`, 'iu');
// Đuôi cảm ơn: "… TPHCM. Cảm ơn!", "… Thủ Đức cảm ơn em nhiều nha", "… HCM thanks shop".
const TRAILING_THANKS = /[\s,.;:!~-]*(?<![\p{L}\p{N}])(?:xin\s+)?(?:c[ảá]m\s+ơn|cam\s+on|thanks?|thank\s+you|thank\s+u|tks|thks)(?![\p{L}\p{N}])[^,\d\n]{0,25}$/iu;
// Đuôi câu hỏi: "… có tặng quà phải k bạn", "… có freeship không shop", "… được kiểm hàng ko ạ".
const TRAILING_QUESTION = /\s+(?:có|co|được|đc|dc|vậy|thì|mà|shop|cho\s+(?:mình|em|chị|c|e)\s+hỏi)\s+[^,\n]{2,45}?(?<![\p{L}])(?:không|ko|k|kg|hả|hông|hong|chưa|nhỉ|phải\s+k|phải\s+ko|phải\s+không)(?:\s+(?:bạn|ban|shop|em|e|ạ|a|nhỉ|vậy|ad))*\s*\??$/iu;
const TRAILING_QUESTION_TOPIC = /(?<![\p{L}])(?:tặng|quà|qua tang|ship|freeship|miễn|giảm|ưu đãi|khuyến mãi|kiểm|xem hàng|thanh toán|cod|giao|nhận|voucher|đổi|trả)(?![\p{L}])/iu;

/**
 * R13 sửa (L2): đuôi câu hỏi mà cleanAddressText sẽ cắt khỏi địa chỉ có chủ đề quà / miễn ship không → mã mẫu ý phụ để luật
 * địa chỉ trả lời cùng lượt ('' khi không có / chủ đề khác — để nguyên như trước).
 * @param {string} text tin khách (địa chỉ thô)
 * @returns {''|'GIFT_POLICY'|'FREESHIP_POLICY'}
 */
export function trailingQuestionTopic(text) {
  const question = String(text || '').match(TRAILING_QUESTION);
  if (!question || !TRAILING_QUESTION_TOPIC.test(question[0]) || ADMIN_OR_STREET.test(question[0]) || /\d/.test(question[0])) return '';
  const tail = question[0].normalize('NFC');
  if (/(?<![\p{L}])(?:tặng|quà|qua tang)(?![\p{L}])/iu.test(tail)) return 'GIFT_POLICY';
  if (/(?<![\p{L}])(?:ship|freeship|miễn)(?![\p{L}])/iu.test(tail)) return 'FREESHIP_POLICY';
  return '';
}
// Đuôi giỏ: "… Bình Thạnh Ngân Combo 2 tui", "… Hà Nội 2 túi xanh nhé", "… Đà Nẵng lấy 1 xanh 1 vàng".
const TRAILING_BASKET = new RegExp(`[\\s,.;:\\-–]+(?:(?:lấy|lay|đặt|dat|mua|ship|chốt|chot)\\s+)?(?:(?:cho\\s+)?(?:mình|minh|em|chị|chi)\\s+)?(?:combo\\s*\\d{1,2}(?:\\s*${BAG_UNIT})?(?:\\s+${COLOUR_WORD})?|(?:\\d{1,2}\\s*${BAG_UNIT}(?:\\s+${COLOUR_WORD})?|\\d{1,2}\\s+${COLOUR_WORD})(?:\\s*(?:,|và|va|\\+)?\\s*\\d{1,2}\\s*${BAG_UNIT}?\\s*${COLOUR_WORD})*)(?![\\p{L}\\p{N}])[\\s.!]*$`, 'iu');
/** Ngoặc mồ côi ("số 5 ngõ 2 (gần chợ, Hà Đông" / "Hà Đông) Hà Nội"): bỏ dấu ngoặc lẻ, giữ chữ. */
function dropOrphanBrackets(text) {
  const chars = [...String(text || '')];
  const open = [];
  const drop = new Set();
  chars.forEach((char, index) => {
    if (char === '(') open.push(index);
    else if (char === ')') { if (open.length) open.pop(); else drop.add(index); }
  });
  for (const index of open) drop.add(index);
  if (!drop.size) return String(text || '');
  return chars.map((char, index) => (drop.has(index) ? ' ' : char)).join('').replace(/\s{2,}/g, ' ').replace(/\s+,/g, ',').trim();
}
// Tên người viết thường đứng đầu, ngay trước một mốc ("Tâm đinh trường mầm non kiệt sơn…"): bỏ tên khi AN TOÀN — 1–3 chữ
// không số, chữ đầu viết hoa, không chữ nào là từ địa chỉ/vị trí ("gần", "cổng", "khu", "xóm"…), cụm đó không đọc ra địa
// danh nào, và phần còn lại vẫn còn chữ sau mốc.
const LANDMARK = '(?:trường|truong|ubnd|uỷ\\s+ban|ủy\\s+ban|công\\s+ty|cty|bệnh\\s+viện|nhà\\s+thuốc|ngân\\s+hàng|bưu\\s+điện|trạm\\s+y\\s+tế)';
const LEADING_NAME_BEFORE_LANDMARK = new RegExp(`^\\s*(\\p{Lu}[\\p{L}]*(?:\\s+[\\p{L}]+){0,2})\\s+(?=${LANDMARK}(?![\\p{L}])\\s+\\S)`, 'u');
const NOT_NAME_WORD = /^(?:gần|gan|đối|doi|diện|dien|cạnh|canh|sau|trước|truoc|cổng|cong|ngã|nga|kế|ke|bên|ben|tại|tai|ở|o|khu|xóm|xom|thôn|thon|ấp|ap|tổ|to|đội|số|so|nhà|nha|đường|duong|ngõ|ngo|hẻm|hem|kp|phố|pho|làng|lang|bản|ban|cầu|cau|chợ|cho|bến|sân|san|hội|hoi|đình|chùa|chua|quán|quan|cửa|cua|tiệm|tiem|shop|cty|công|cong|văn|phòng|phong|kho|xưởng|xuong|trạm|tram|điểm|diem|gửi|gui|giao|ship|nhận|nhan|về|ve|đến|den|tới|toi|và|va|xã|xa|phường|phuong|huyện|huyen|tỉnh|tinh|quận|thị|thi|tp|lô|lo|dãy|day|toà|tòa|toa|kiệt|kiet|ngách|ngach|đt|ql|tl|giáo|giao|viên|vien|cô|thầy|thay|gv|đối diện|mầm|mam|tiểu|tieu|cấp|cap|thcs|thpt)$/iu;
function stripLeadingLandmarkName(text) {
  const match = String(text || '').match(LEADING_NAME_BEFORE_LANDMARK);
  if (!match) return text;
  const words = match[1].trim().split(/\s+/);
  if (words.some(word => NOT_NAME_WORD.test(word))) return text;
  // Cụm đầu là ĐỊA DANH thật ("Tân Bình trường…") thì giữ: tên đơn vị đọc ra phải nằm nguyên trong cụm (bộ đọc địa chỉ
  // dò gần đúng — "Tâm đinh" ra "Nam Định" — nên không tin riêng kết quả đọc).
  const resolved = describeDeliveryAddress(match[1]).resolved;
  const lead = normalizeIntentText(match[1]);
  const named = [resolved?.province?.name, resolved?.district?.name, resolved?.ward?.name].filter(Boolean)
    .map(name => normalizeIntentText(String(name).replace(/^(?:tỉnh|thành phố|tp|quận|huyện|thị xã|thị trấn|phường|xã)\s+/iu, '')));
  if (named.some(name => name && lead.includes(name))) return text;
  return text.slice(match[0].length);
}

/** Ghi chú giao hàng khách ghi lẫn trong địa chỉ ("giao giờ hành chính"), '' nếu không có. */
export function extractDeliveryNote(text) {
  const notes = String(text || '').match(DELIVERY_NOTE) || [];
  return notes.map(note => note.replace(/\s+/g, ' ').trim()).filter(Boolean).join('; ');
}

/**
 * Chữ khách ghi → phần địa chỉ lên phiếu: bỏ SĐT và nhãn SĐT ở mọi chỗ, bỏ nhãn/câu dẫn ở đầu
 * ("đc", "shop.", "Linh:", "Tên:", "Gửi về ĐC", "Mình ở", "1 trước ạ."), bỏ người nhận chen giữa,
 * ghi chú giao hàng, chữ đệm cuối câu ("nhé/nha/ạ"), sửa từ gõ cụt "huyệ", và đoạn lặp.
 */
export function cleanAddressText(raw) {
  // R14 (…195669): "Hèm 120 ₫uông…" — ký hiệu tiền "₫" gõ thay chữ "đ", "Hèm" trước số nhà là "Hẻm".
  let text = stripPhone(String(raw || '').normalize('NFC').replace(/₫/g, 'đ')).replace(/\r/g, '');
  text = text.replace(/(?<![\p{L}\p{N}])H(?:è|e)m(?=\s+\d)/gu, 'Hẻm').replace(/(?<![\p{L}\p{N}])h(?:è|e)m(?=\s+\d)/gu, 'hẻm');
  text = text.replace(PHONE_LABEL, ' ');
  text = text.replace(NAME_INTRO, ' ');
  text = text.replace(RECEIVER_PHRASE, ' ');
  text = text.replace(DELIVERY_NOTE, ' ');
  text = text.replace(/(?<![\p{L}])huyệ(?![\p{L}])\.?/giu, 'huyện');
  text = text.replace(/[ \t]+/g, ' ').replace(/\s*\n+\s*/g, ', ').trim();
  for (let guard = 0; guard < 6; guard += 1) {
    const before = text;
    for (const pattern of LEADING_LABELS) text = text.replace(pattern, '');
    const reply = text.match(LEADING_REPLY);
    if (reply && !ADDRESS_WORDS.test(normalizeIntentText(reply[1])) && !ADMIN_OR_STREET.test(reply[1]) && !looksLikeHouseAndStreet(reply[1])) text = text.slice(reply[0].length);
    const named = text.match(NAME_COLON);
    if (named && named[1].trim().split(/\s+/).length <= 4 && !ADMIN_OR_STREET.test(named[1].replace(/(?:địa\s*chỉ|dia\s*chi)\s*$/iu, ''))) text = text.slice(named[0].length);
    // R13 (inbox1 C4): cụm giỏ đứng đầu địa chỉ ("2ca cao, 79xom hạ…", "2 t ap 4, …", "2 túi xanh 12 Lê Lợi").
    text = text.replace(LEADING_BASKET_COLOUR, '').replace(LEADING_BASKET_UNIT, '').replace(LEADING_BASKET_SHORT, '');
    text = stripLeadingLandmarkName(text);
    text = text.replace(/^[\s,.;:!\-–]+/u, '');
    if (text === before) break;
  }
  // R13 (inbox3 F2, inbox1 C1, inbox2 C1): đuôi không phải địa chỉ — lời cảm ơn, câu hỏi ("… Bắc Giang có tặng quà phải k
  // bạn"), cụm giỏ ("… Bình Thạnh Ngân Combo 2 tui"). Lặp vì các đuôi có thể nối nhau ("… 2 túi nha. Cảm ơn!").
  for (let guard = 0; guard < 4; guard += 1) {
    const before = text;
    text = text.replace(TRAILING_PARTICLES, '');
    const thanks = text.match(TRAILING_THANKS);
    if (thanks && thanks.index > 0 && !ADMIN_OR_STREET.test(thanks[0])) text = text.slice(0, thanks.index);
    const question = text.match(TRAILING_QUESTION);
    if (question && TRAILING_QUESTION_TOPIC.test(question[0]) && !ADMIN_OR_STREET.test(question[0]) && !/\d/.test(question[0])) text = text.slice(0, question.index);
    text = text.replace(TRAILING_BASKET, '').replace(/[\s,;:\-–]+$/u, '').replace(/\s+[.!]+$/u, '');
    // R14 (…838545): mã bưu chính 6 số cuối địa chỉ ("… Hồ Chí Minh 700000") — chỉ khi đứng sau một tên (chữ), không sau "số/ngõ".
    text = text.replace(/(?<=\p{L})(?<!(?<![\p{L}])(?:số|so|sn|ngõ|ngo|hẻm|hem|nhà|nha|lô|lo|kiệt|kiet))[\s,.\-–]+\d{6}[\s.]*$/u, '');
    if (text === before) break;
  }
  text = dropOrphanBrackets(text);
  text = text.replace(TRAILING_PARTICLES, '');
  text = text.replace(/\s*,(?:\s*,)+/g, ',').replace(/\s+,/g, ',').replace(/,(?=\S)/g, ', ').replace(/\s{2,}/g, ' ');
  text = text.replace(/^[\s,.;:!\-–]+|[\s,;:\-–]+$/gu, '').trim();
  return dedupeAddressSegments(text);
}

/** Tin thanh toán ("gửi stk", "ck", "chuyển khoản", "lên đơn 0đ", "đã chuyển"): không bao giờ là sửa đơn. */
export function isPaymentMessage(text) {
  const s = normalizeIntentText(text);
  return /\b(stk|so tai khoan|tai khoan|ck|chuyen khoan|chuyen tien|da chuyen|da ck|bank|banking|0d|0 d|0 dong|0đ|thanh toan truoc|tra truoc)\b/.test(s)
    || /(?<![\d.])0\s*(?:đ|d|vnd|dong)(?![\p{L}\d])/iu.test(String(text || ''));
}

// ===== Vòng 12: gom địa chỉ gửi thành nhiều tin liền =====

const BURST_PRODUCT = /\b(tui|goi|bich|hop|combo|xanh|vang|nau|cacao|mint|tropical|granola|yen mach|lay|dat|mua|chot|huy|doi|them|bot|gia|bao nhieu|bn)\b/;

/**
 * Các tin khách gửi liền nhau (cách nhau ≤ windowMs, mặc định 90 giây) ở cuối hội thoại mà từng tin
 * là mảnh địa chỉ/SĐT ("Tổ 6" / "Thôn ba dùi" / "Khánh Bình" / "Khánh Vĩnh" / "Khánh Hòa" / SĐT) →
 * một khối địa chỉ. Tin bot chen giữa (bot trả lời từng mảnh) không cắt khối. Dừng ở tin nhắc
 * sản phẩm/số lượng/câu hỏi hay khi cách quá windowMs.
 * @param {Array<{direction:string,text?:string,type?:string,createdAt?:number}>} messages lịch sử (cũ → mới)
 * @returns {{ text: string, phone: string, count: number } | null} null khi khối chỉ có ≤ 1 tin.
 */
export function collectAddressBurst(messages, { windowMs = 90 * 1000 } = {}) {
  const incoming = (Array.isArray(messages) ? messages : []).filter(item => item?.direction === 'incoming' && (!item.type || item.type === 'text') && String(item.text || '').trim());
  const picked = [];
  let newer = null;
  for (let index = incoming.length - 1; index >= 0; index -= 1) {
    const item = incoming[index];
    const at = Number(item.createdAt) || 0;
    if (newer && Math.abs((Number(newer.createdAt) || 0) - at) > windowMs) break;
    const raw = String(item.text).trim();
    const s = normalizeIntentText(raw);
    const phoneOnly = Boolean(extractVietnamesePhone(raw)) && !stripPhone(raw).replace(/[\s,.;:]+/g, '').replace(/s[đd]t|đt|dt/giu, '');
    if (!phoneOnly && (raw.includes('?') || raw.length > 160 || BURST_PRODUCT.test(s.replace(ADMIN, ' ')) || NOT_ADDRESS.test(s))) break;
    picked.unshift(raw);
    newer = item;
  }
  if (picked.length < 2) return null;
  const phone = picked.map(text => extractVietnamesePhone(text)).find(Boolean) || '';
  const text = cleanAddressText(picked.map(part => stripPhone(part).trim()).filter(Boolean).join(', '));
  return text || phone ? { text, phone, count: picked.length } : null;
}

// ===== Vòng 12: lấy lại "địa chỉ cũ" từ đơn đã có (CRM / landing / POS đã đồng bộ về máy) =====

/**
 * Đơn gần nhất có địa chỉ của đúng SĐT này trong các danh sách đơn đã có ở máy (customerOrders của
 * hội thoại, kho landing — gồm đơn POS đồng bộ về). Không gọi mạng. Trả { phone, address, at, source,
 * orderId } hoặc null (engine chuyển nhân viên, không hỏi từng cấp).
 */
export function pickPreviousAddress(phone, ...orderLists) {
  const key = toLocalPhone(phone) || String(phone || '').replace(/\D/g, '');
  if (!key) return null;
  let best = null;
  for (const list of orderLists) {
    for (const order of Array.isArray(list) ? list : []) {
      if (!order) continue;
      const orderPhone = toLocalPhone(order.phone) || String(order.phone || '').replace(/\D/g, '');
      if (orderPhone !== key) continue;
      const address = String(order.rawAddress || order.address || '').replace(/^\((?:live|freeship)\)\s*/i, '').trim();
      if (!address || /^chưa có địa chỉ$/i.test(address)) continue;
      if (order.landing?.incomplete && !order.landing?.posId) continue;
      const at = Number(order.createdAt) || 0;
      if (!best || at > best.at) best = { phone: key, address, at, source: String(order.source || ''), orderId: String(order.id || '') };
    }
  }
  return best;
}

/** pickPreviousAddress trên customerOrders + kho landing cục bộ (đọc tệp, không gọi mạng). */
export async function lookupPreviousAddress(phone, { customerOrders = [], landingStore = null } = {}) {
  let landing = [];
  if (typeof landingStore === 'function') {
    try { landing = (await landingStore())?.orders || []; } catch { landing = []; }
  } else if (landingStore && Array.isArray(landingStore.orders)) landing = landingStore.orders;
  return pickPreviousAddress(phone, customerOrders, landing);
}
