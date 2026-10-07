// Thẻ "Số điện thoại" (thẻ nhận sự kiện 'phone') — chỉ thẻ CRM, không đụng thẻ Pancake.
// 02/10: chủ shop muốn thấy ngay trong hộp thư hội thoại nào khách đã để lại SĐT (tin nhắn hay
// bình luận). Gắn ngay khi tin khách về (server nghe sự kiện hộp thư) và quét bù mỗi 5 phút cho tin
// lọt (đồng bộ Pancake ghi gộp, tiến trình khởi động lại…).
// Mỗi hội thoại chỉ gắn MỘT lần (cờ phoneLabeled): nhân viên gỡ thẻ thì không gắn lại.
import { phoneKeysInText } from './purchase-labels.mjs';

const DAY = 24 * 60 * 60 * 1000;
// Quét bù chỉ xét tin gần đây: không gắn hàng loạt cho lịch sử cũ.
export const phoneLabelWindowMs = 30 * DAY;

/** Tin khách (không phải tin Page/bot/nhân viên) có ghi số điện thoại không. */
export function messageHasPhone(message) {
  return message?.direction === 'incoming' && phoneKeysInText(message.text).size > 0;
}

/**
 * Chạy trong updateMessagingStore (sửa `store` tại chỗ). `conversationIds`: chỉ xét các hội thoại
 * này (gắn ngay khi tin về); bỏ trống = quét mọi hội thoại (lượt bù). Trả về
 * `{ changes: [{ conversation, before, after }], flagged }` — `flagged` đếm cả hội thoại chỉ đặt cờ
 * (đã có thẻ sẵn) để bên gọi biết có cần ghi kho không.
 */
export function applyPhoneLabels(store, { phoneLabels = [], conversationIds = null, now = Date.now() } = {}) {
  const labels = (Array.isArray(phoneLabels) ? phoneLabels : []).filter(Boolean);
  const result = { changes: [], flagged: 0 };
  if (!labels.length || !Array.isArray(store?.conversations)) return result;
  const only = conversationIds ? new Set(conversationIds) : null;
  for (const conversation of store.conversations) {
    if (!conversation || conversation.phoneLabeled || conversation.source === 'comment') continue;
    if (only && !only.has(conversation.id)) continue;
    const messages = Array.isArray(store.messages?.[conversation.id]) ? store.messages[conversation.id] : [];
    const found = messages.some(message => messageHasPhone(message) && (Number(message.createdAt) || 0) > now - phoneLabelWindowMs);
    if (!found) continue;
    conversation.phoneLabeled = true;
    result.flagged += 1;
    const before = Array.isArray(conversation.labels) ? conversation.labels : [];
    const merged = [...new Set([...before, ...labels])];
    if (merged.length === before.length) continue;
    conversation.labels = merged;
    result.changes.push({ conversation: { id: conversation.id, name: conversation.name || '' }, before: [...before], after: [...merged] });
  }
  return result;
}
