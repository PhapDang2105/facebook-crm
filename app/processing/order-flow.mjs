// Luồng đơn tất định: bot đang xin SĐT/địa chỉ (giỏ đã có, còn hạn) mà khách chỉ gửi SĐT, địa chỉ,
// cả hai, hay "gửi địa chỉ cũ" — không cần hỏi LLM. Trả về giá trị như LLM sẽ trả (template_id
// ORDER_ADDRESS + slot vừa nhận); bộ soạn đơn (renderOrder) tự ghép với giỏ đang giữ và quyết
// xin phần còn thiếu (ORDER_ADDRESS_PARTIAL/CLARIFY) hay chốt (ORDER_CONFIRMATION).
// Khách nhắc sản phẩm/số lượng/đổi/hủy hay đặt câu hỏi thì để LLM đọc.
import { extractVietnamesePhone } from './customer-info.mjs';
import { normalizeIntentText } from './intent-features.mjs';

const CHANGE = /\b(tui|goi|bich|xanh|vang|nau|cacao|combo|huy|doi|them|bot|nua|khong lay|ko lay|k lay|lay \d|\d (tui|goi|bich))\b/;
const ADMIN = /\b(xa|huyen|quan|phuong|thi tran|thi xa|tinh|tp|thanh pho|ap|thon|khu pho|kp)\b/g;
// "địa chỉ cũ", "đ/c như cũ", "địa chỉ vẫn thế", "dc đã gửi", "gửi dc cũ", "đã gửi địa chỉ", "gọi địa chỉ cũ"…
// "dc" cũng là "được" nên với "dc"/"d c" chỉ nhận vế rõ (cũ / như cũ / đã gửi / gửi rồi / lần trước / đơn trước),
// không nhận "dc trước" ("giao dc trước thứ 7") hay "dc vẫn thế".
const OLD_ADDRESS = /\b(dia chi cu|dia chi (nhu|giong) (lan|hom) truoc|nhu lan truoc|cho cu|gui cho cu|ve cho cu|dia chi lan truoc|nhu cu)\b|\b(dia chi|dia chi nhan)\s*(cu|nhu cu|van the|da gui|gui roi|truoc|lan truoc|don truoc|nhu (lan|don|hom) truoc)\b|\b(dc|d c)\s*(cu|nhu cu|da gui|gui roi|lan truoc|don truoc)\b|\bgui (dc|dia chi) (cu|truoc)\b|\bda gui (dc|dia chi)\b|\bgoi dia chi cu\b/;
const FILLER = new Set(['sdt', 'so', 'dien', 'thoai', 'dt', 'cua', 'minh', 'em', 'e', 'chi', 'c', 'anh', 'a', 'toi', 'day', 'la', 'nhe', 'nha', 'nghen', 'ok', 'oke', 'da', 'va', 'dc', 'duoc', 'roi', 'ne', 'shop', 'sop', 'gui', 'ship', 'giao', 've', 'cho', 'thi', 'ạ', 'nhen', 'nhá', 'sđt', 'zalo', 'lien', 'he', 'goi']);

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
    return null;
  }
  if (ctx.addressComplete) return { rule: 'ADDRESS_COMPLETE', value: { template_id: 'ORDER_ADDRESS', Customer_Address: address } };
  return null;
}
