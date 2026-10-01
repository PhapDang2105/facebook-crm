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
const looksLikeAddress = (raw, normalized) => {
  if (!raw || raw.length > 200 || NOT_ADDRESS.test(normalized) || NOT_ADDRESS_PHRASE.test(normalized)) return false;
  const resolved = describeDeliveryAddress(raw).resolved;
  // Từ địa chỉ kèm chữ số hay một cấp đọc ra được; "đường" (đường ăn), "xa" (date xa), "quán" một mình thì không.
  if (ADDRESS_WORDS.test(normalized)) return /\d/.test(raw) || Boolean(resolved?.province) || STRONG_ADDRESS_WORDS.test(normalized);
  if (!resolved?.province) return false;
  return /\d/.test(raw) || Boolean(resolved.ward || resolved.postMerger) || Boolean(resolved.district && provinceNamed(raw, resolved));
};

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
  // Vòng 12 (inbox-3 #2): "địa chỉ cũ" khi đang giữ giỏ là đủ rõ, không cần bot vừa hỏi SĐT/địa chỉ.
  if (OLD_ADDRESS.test(s)) {
    // "Địa chỉ cũ" mà hệ thống không có đơn/địa chỉ giao trước của khách này: xin SĐT đã đặt lần trước
    // để tra (ORDER_ADDRESS_OLD_ASK_PHONE) + thẻ cần người xem.
    if (ctx.hasPreviousDelivery === false) return { rule: 'OLD_ADDRESS_ASK', value: { template_id: 'ORDER_ADDRESS_OLD_ASK_PHONE' }, attention: true };
    return { rule: 'OLD_ADDRESS', value: { template_id: 'ORDER_ADDRESS', Phone_Number: '0', Customer_Address: '0' } };
  }
  if (!ctx.lastWasOrderStep) return null;
  const phone = extractVietnamesePhone(raw);
  // Vòng 12: mọi nhánh (cả nhánh địa chỉ đủ) đều lọc nhãn "sđt/đc/Tên:/shop."… và chữ đệm cuối câu.
  const address = cleanAddressText(ctx.addressText || raw);
  if (phone && ctx.addressComplete) return { rule: 'PHONE_ADDRESS', value: { template_id: 'ORDER_ADDRESS', Phone_Number: phone, Customer_Address: address } };
  if (phone) {
    const leftover = s.replace(/<sdt>/g, ' ').split(' ').filter(Boolean);
    if (leftover.every(word => FILLER.has(word))) return { rule: 'PHONE_ONLY', value: { template_id: 'ORDER_ADDRESS', Phone_Number: phone } };
    // SĐT + địa chỉ chưa đủ cấp ("<sđt> Xóm 3 xã Vô Tranh Phú Lương"): vẫn đưa vào, bộ soạn đơn hỏi phần thiếu.
    if (looksLikeAddress(address, normalizeIntentText(address))) return { rule: 'PHONE_ADDRESS_PARTIAL', value: { template_id: 'ORDER_ADDRESS', Phone_Number: phone, Customer_Address: address } };
    return null;
  }
  if (ctx.addressComplete) return { rule: 'ADDRESS_COMPLETE', value: { template_id: 'ORDER_ADDRESS', Customer_Address: address } };
  if (looksLikeAddress(address, s)) return { rule: 'ADDRESS_PARTIAL', value: { template_id: 'ORDER_ADDRESS', Customer_Address: address } };
  return null;
}

// ===== Vòng 12: làm sạch chữ khách ghi trước khi lên phiếu =====

// Nhãn SĐT ở bất kỳ đâu (SĐT đã bỏ): "sđt", "Sdt:", "số đt", "zalo". "ĐT"/"Dt" chỉ là nhãn khi
// không có số đứng ngay sau ("ĐT 741" là đường tỉnh).
const PHONE_LABEL = /(?<![\p{L}\p{N}])(?:s[đd]t|số\s*điện\s*thoại|so\s*dien\s*thoai|số\s*đt|so\s*dt|zalo|phone|tel)(?![\p{L}\p{N}])\s*[:：.]?|(?<![\p{L}\p{N}])(?:đt|dt)(?![\p{L}\p{N}])(?!\s*\d)\s*[:：.]?/giu;
// Nhãn/câu dẫn ở đầu: "đc", "địa chỉ:", "shop.", "Gửi về ĐC", "Mình ở", "Tên:", "Fb:".
const LEADING_LABELS = [
  /^\s*(?:shop|sop)\s*[.,:;!]+\s*/iu,
  /^\s*(?:tên|ten|fb|facebook|name|người nhận|nguoi nhan)\s*[:：]\s*/iu,
  /^\s*(?:địa\s*chỉ(?:\s*nhận(?:\s*hàng)?)?|dia\s*chi(?:\s*nhan(?:\s*hang)?)?|đ\/c|d\/c|đ\.c|đc|dc|đchi|dchi)(?![\p{L}\p{N}])\s*[:：.\-]?\s*/iu,
  /^\s*(?:gửi|gởi|gui|ship|giao|chuyển|chuyen)\s+(?:hàng\s+)?(?:về|đến|tới|ve|den|toi|qua)\s*(?:(?:địa\s*chỉ|đc|dc|đ\/c)(?![\p{L}\p{N}])\s*[:：]?\s*)?/iu,
  /^\s*(?:nhà\s+)?(?:mình|minh|em|e|chị|chi|c|anh|a|tôi|toi|t|cô|chú|bác)\s+ở\s+/iu,
  /^\s*ở\s+(?=\S)/iu
];
// "<Tên>:" ở đầu ("Linh:", "Nguyen Huong:", "Chị tâm Địa chỉ:"): tối đa 4 chữ, không số, không là cấp hành chính.
const NAME_COLON = /^\s*([\p{L}][\p{L}\s]{0,40}?)\s*[:：]\s*(?=\S)/u;
const ADMIN_OR_STREET = /(?<![\p{L}])(phường|xã|quận|huyện|tỉnh|thành phố|thị trấn|thị xã|thôn|ấp|xóm|tổ|khu|số|đường|ngõ|ngách|hẻm|kiệt|phố|tp|kp)(?![\p{L}])/iu;
// Người nhận chen giữa ("chuyển cho chị Ngân", "giao cho anh Tuấn").
const RECEIVER_PHRASE = /(?:^|[\s,.;])(?:chuyển|chuyen|gửi|gởi|gui|giao)\s+(?:cho|tới|toi)\s+(?:anh|chị|chi|em|cô|chú|bác|a|c|e|bạn)\s+\p{Lu}[\p{L}]*(?:\s+\p{Lu}[\p{L}]*)?(?=$|[\s,.;])/gu;
// Ghi chú giao hàng nằm lẫn trong địa chỉ.
const DELIVERY_NOTE = /(?:giao|ship|gọi|goi)?\s*(?:trong\s+)?giờ\s+hành\s+chính|gio\s+hanh\s+chinh|gọi\s+trước\s+khi\s+giao|goi\s+truoc\s+khi\s+giao|tránh\s+(?:ngày\s+)?(?:chủ\s+nhật|cn|t7|thứ\s+7)|giao\s+(?:buổi\s+)?(?:sáng|chiều|tối)(?:\s+(?:thứ\s+\d|cn|chủ\s+nhật))?/giu;
// Chữ đệm cuối câu.
// fix-addr (01/10): chữ đệm phải là một từ riêng — "ạ" cuối "Láng Hạ" không phải chữ đệm ("phố Láng Hạ" từng thành "Láng H").
const TRAILING_PARTICLES = /[\s,.;:!~-]*(?<![\p{L}\p{N}])(?:(?:nhé|nhe|nha|nhá|ạ|nhen|nghen|nhaa|nhaaa|shop|sop|giúp\s+em|giùm|dùm|với|e\s+nhé|em\s+nhé|em\s+nha|e\s+nha|em\s+ơi|e\s+ơi|ạ\s+shop)(?![\p{L}\p{N}])[\s,.;:!~-]*)+$/iu;
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
  let text = stripPhone(String(raw || '')).replace(/\r/g, '');
  text = text.replace(PHONE_LABEL, ' ');
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
    text = text.replace(/^[\s,.;:!\-–]+/u, '');
    if (text === before) break;
  }
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
