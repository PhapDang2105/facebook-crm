// Luồng đơn tất định: bot đang xin SĐT/địa chỉ (giỏ đã có, còn hạn) mà khách chỉ gửi SĐT, địa chỉ,
// cả hai, hay "gửi địa chỉ cũ" — không cần hỏi LLM. Trả về giá trị như LLM sẽ trả (template_id
// ORDER_ADDRESS + slot vừa nhận); bộ soạn đơn (renderOrder) tự ghép với giỏ đang giữ và quyết
// xin phần còn thiếu (ORDER_ADDRESS_PARTIAL/CLARIFY) hay chốt (ORDER_CONFIRMATION).
// Khách nhắc sản phẩm/số lượng/đổi/hủy hay đặt câu hỏi thì để LLM đọc.
import { extractVietnamesePhone } from './customer-info.mjs';
import { ADDRESS_WORDS, normalizeIntentText } from './intent-features.mjs';
import { describeDeliveryAddress } from './locations.mjs';

const CHANGE = /\b(tui|goi|bich|xanh|vang|nau|cacao|combo|huy|doi|them|bot|nua|khong lay|ko lay|k lay|lay \d|\d (tui|goi|bich))\b/;
const ADMIN = /\b(xa|huyen|quan|phuong|thi tran|thi xa|tinh|tp|thanh pho|ap|thon|khu pho|kp)\b/g;
// "địa chỉ cũ", "đ/c như cũ", "địa chỉ vẫn thế", "dc đã gửi", "gửi dc cũ", "đã gửi địa chỉ", "gọi địa chỉ cũ"…
// "dc" cũng là "được" nên với "dc"/"d c" chỉ nhận vế rõ (cũ / như cũ / đã gửi / gửi rồi / lần trước / đơn trước),
// không nhận "dc trước" ("giao dc trước thứ 7") hay "dc vẫn thế".
const OLD_ADDRESS = /\b(dia chi cu|dia chi (nhu|giong) (lan|hom) truoc|nhu lan truoc|cho cu|gui cho cu|ve cho cu|dia chi lan truoc|nhu cu)\b|\b(dia chi|dia chi nhan)\s*(cu|nhu cu|van the|da gui|gui roi|truoc|lan truoc|don truoc|nhu (lan|don|hom) truoc)\b|\b(dc|d c)\s*(cu|nhu cu|da gui|gui roi|lan truoc|don truoc)\b|\bgui (dc|dia chi) (cu|truoc)\b|\bda gui (dc|dia chi)\b|\bgoi dia chi cu\b/;
const FILLER = new Set(['sdt', 'so', 'dien', 'thoai', 'dt', 'cua', 'minh', 'em', 'e', 'chi', 'c', 'anh', 'a', 'toi', 'day', 'la', 'nhe', 'nha', 'nghen', 'ok', 'oke', 'da', 'va', 'dc', 'duoc', 'roi', 'ne', 'shop', 'sop', 'gui', 'ship', 'giao', 've', 'cho', 'thi', 'ạ', 'nhen', 'nhá', 'sđt', 'zalo', 'lien', 'he', 'goi']);
// Vòng 10: địa chỉ CHƯA đủ ba cấp ("270 Nguyễn Văn Cừ tp Vinh Nghệ An", "Na Hang", "Huyện Sơn Tịnh", "Số 17, đường 38,
// P. Thảo Điền") khi bot đang xin địa chỉ: vẫn đưa vào bộ soạn đơn — nó tự hỏi đúng cấp còn thiếu
// (ORDER_ADDRESS_CLARIFY), như mô hình vẫn làm. Không nhận câu hỏi/chính sách ("giao Hà Nội mấy ngày", "ship về
// Cà Mau được không", "có giao tận nơi không") hay chữ không giống địa chỉ ("để mình xem lại").
const NOT_ADDRESS = /\b(bao lau|may ngay|bn ngay|bao nhieu|bnhiu|bn|khi nao|chung nao|gia|phi|mien|free|tan noi|tan nha|co (giao|ship|toi|den|ve)|(giao|ship|toi|den|gui|van chuyen) (duoc|dc|ko|khong|k|toi|den|ve)|(duoc|dc) (khong|ko|k|kg|hong)|(xa|gan) (khong|ko|k|qua|lam)|the nao|ntn|ra sao|lam sao|o dau|noi khong|noi ko)\b/;
const looksLikeAddress = (raw, normalized) => Boolean(raw) && raw.length <= 200 && !NOT_ADDRESS.test(normalized)
  && (ADDRESS_WORDS.test(normalized) || Boolean(describeDeliveryAddress(raw).resolved?.province));

/**
 * @param {string} text tin khách
 * @param {{ hasBasket?: boolean, lastWasOrderStep?: boolean, source?: string, complaint?: boolean, addressComplete?: boolean, addressText?: string, trialOffer?: boolean, hasPreviousDelivery?: boolean }} ctx
 *   hasPreviousDelivery: engine truyền — có đơn cũ / địa chỉ giao lần trước để lấy lại không. Bỏ trống (undefined)
 *   thì coi như có (giữ hành vi cũ: bộ soạn đơn tự tra); `false` rõ ràng thì xin SĐT đã đặt lần trước.
 * @returns {{ rule: string, value: Record<string, string>, attention?: boolean } | null}
 */
export function orderFlowStep(text, ctx = {}) {
  if (!ctx.hasBasket || !ctx.lastWasOrderStep || ctx.source === 'comment' || ctx.complaint) return null;
  const raw = String(text || '').trim();
  if (!raw || raw.includes('?')) return null;
  const s = normalizeIntentText(raw);
  // "gọi địa chỉ cũ": "gọi" bỏ dấu thành "gói" (từ đổi giỏ) — bỏ cụm này trước khi dò CHANGE.
  if (CHANGE.test(s.replace(ADMIN, ' ').replace(/\bgoi dia chi cu\b/g, ' '))) return null;
  if (OLD_ADDRESS.test(s)) {
    // "Địa chỉ cũ" mà hệ thống không có đơn/địa chỉ giao trước của khách này: xin SĐT đã đặt lần trước
    // để tra (ORDER_ADDRESS_OLD_ASK_PHONE) + thẻ cần người xem.
    if (ctx.hasPreviousDelivery === false) return { rule: 'OLD_ADDRESS_ASK', value: { template_id: 'ORDER_ADDRESS_OLD_ASK_PHONE' }, attention: true };
    return { rule: 'OLD_ADDRESS', value: { template_id: 'ORDER_ADDRESS', Phone_Number: '0', Customer_Address: '0' } };
  }
  const phone = extractVietnamesePhone(raw);
  const address = String(ctx.addressText || raw.replace(/\+?\d[\d .-]{8,13}/g, ' ')).replace(/\s+/g, ' ').trim();
  if (phone && ctx.addressComplete) return { rule: 'PHONE_ADDRESS', value: { template_id: 'ORDER_ADDRESS', Phone_Number: phone, Customer_Address: address } };
  if (phone) {
    const leftover = s.replace(/<sdt>/g, ' ').split(' ').filter(Boolean);
    if (leftover.every(word => FILLER.has(word))) return { rule: 'PHONE_ONLY', value: { template_id: 'ORDER_ADDRESS', Phone_Number: phone } };
    // SĐT + địa chỉ chưa đủ cấp ("<sđt> Xóm 3 xã Vô Tranh Phú Lương"): vẫn đưa vào, bộ soạn đơn hỏi phần thiếu.
    const addressPart = address.replace(/(?:^|\s)(?:s[đd]t|đt|dt|số điện thoại|so dien thoai|số đt|so dt|địa chỉ|dia chi|đ\/c|d\/c|dc)\s*[:.]?(?=\s|$)/giu, ' ').replace(/\s+/g, ' ').replace(/^[\s,.:;-]+|[\s,.:;-]+$/g, '').trim();
    if (looksLikeAddress(addressPart, normalizeIntentText(addressPart))) return { rule: 'PHONE_ADDRESS_PARTIAL', value: { template_id: 'ORDER_ADDRESS', Phone_Number: phone, Customer_Address: addressPart } };
    return null;
  }
  if (ctx.addressComplete) return { rule: 'ADDRESS_COMPLETE', value: { template_id: 'ORDER_ADDRESS', Customer_Address: address } };
  const addressPart = address.replace(/(?:^|\s)(?:địa chỉ|dia chi|đ\/c|d\/c|dc|đc)\s*[:.]?(?=\s|$)/giu, ' ').replace(/\s+/g, ' ').replace(/^[\s,.:;-]+|[\s,.:;-]+$/g, '').trim();
  if (looksLikeAddress(addressPart, s)) return { rule: 'ADDRESS_PARTIAL', value: { template_id: 'ORDER_ADDRESS', Customer_Address: addressPart } };
  return null;
}
