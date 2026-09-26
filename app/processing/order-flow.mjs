// Luồng đơn tất định: bot đang xin SĐT/địa chỉ (giỏ đã có, còn hạn) mà khách chỉ gửi SĐT, địa chỉ,
// cả hai, hay "gửi địa chỉ cũ" — không cần hỏi LLM. Trả về giá trị như LLM sẽ trả (template_id
// ORDER_ADDRESS + slot vừa nhận); bộ soạn đơn (renderOrder) tự ghép với giỏ đang giữ và quyết
// xin phần còn thiếu (ORDER_ADDRESS_PARTIAL/CLARIFY) hay chốt (ORDER_CONFIRMATION).
// Khách nhắc sản phẩm/số lượng/đổi/hủy hay đặt câu hỏi thì để LLM đọc.
import { extractVietnamesePhone } from './customer-info.mjs';
import { normalizeIntentText } from './intent-features.mjs';

const CHANGE = /\b(tui|goi|bich|xanh|vang|nau|cacao|combo|huy|doi|them|bot|nua|khong lay|ko lay|k lay|lay \d|\d (tui|goi|bich))\b/;
const ADMIN = /\b(xa|huyen|quan|phuong|thi tran|thi xa|tinh|tp|thanh pho|ap|thon|khu pho|kp)\b/g;
const OLD_ADDRESS = /\b(dia chi cu|dia chi (nhu|giong) (lan|hom) truoc|nhu lan truoc|cho cu|gui cho cu|ve cho cu|dia chi lan truoc|nhu cu)\b/;
const FILLER = new Set(['sdt', 'so', 'dien', 'thoai', 'dt', 'cua', 'minh', 'em', 'e', 'chi', 'c', 'anh', 'a', 'toi', 'day', 'la', 'nhe', 'nha', 'nghen', 'ok', 'oke', 'da', 'va', 'dc', 'duoc', 'roi', 'ne', 'shop', 'sop', 'gui', 'ship', 'giao', 've', 'cho', 'thi', 'ạ', 'nhen', 'nhá', 'sđt', 'zalo', 'lien', 'he', 'goi']);

/**
 * @param {string} text tin khách
 * @param {{ hasBasket?: boolean, lastWasOrderStep?: boolean, source?: string, complaint?: boolean, addressComplete?: boolean, addressText?: string, trialOffer?: boolean }} ctx
 * @returns {{ rule: string, value: Record<string, string> } | null}
 */
export function orderFlowStep(text, ctx = {}) {
  if (!ctx.hasBasket || !ctx.lastWasOrderStep || ctx.source === 'comment' || ctx.complaint) return null;
  const raw = String(text || '').trim();
  if (!raw || raw.includes('?')) return null;
  const s = normalizeIntentText(raw);
  if (CHANGE.test(s.replace(ADMIN, ' '))) return null;
  if (OLD_ADDRESS.test(s)) return { rule: 'OLD_ADDRESS', value: { template_id: 'ORDER_ADDRESS', Phone_Number: '0', Customer_Address: '0' } };
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
