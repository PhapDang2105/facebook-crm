// Chủ shop 03/10: bot im vì "nhân viên đang xử lý" (nhân viên nhắn sau lượt bot, hay thẻ cần người + nhân viên nhắn trong
// 2 giờ) mà khách vừa gửi tin ĐẶT HÀNG (SĐT, địa chỉ, số túi "E 2 túi") và sau đó không ai của Page nhắn gì trong 5 phút →
// bot nhận đơn như thường (lên đơn / hỏi thông tin còn thiếu). Ca thật: thẻ Livestream + Số điện thoại, nhân viên gửi bảng giá
// 13:59, khách 15:50 gửi "E 2 túi" rồi tên + SĐT + địa chỉ, bot bỏ qua, không ai trả lời.
//
// Mô-đun này chỉ giữ phần hẹn giờ (một lượt kiểm lại đang chờ cho mỗi hội thoại, hẹn giờ unref, xoá được khi tắt máy) và
// phép nhận "tin có ý đặt hàng". Việc kiểm lại (đọc lại tin, chạy luồng trả lời thường) nằm ở chatbot-engine.
// Lưu ý: hẹn giờ chỉ nằm trong bộ nhớ — khởi động lại máy chủ trong 5 phút chờ thì lượt kiểm lại đó mất (chấp nhận được).
import { extractVietnamesePhone } from './customer-info.mjs';
import { looksLikeAddressMessage } from './order-flow.mjs';
import { foldVietnamese } from './auto-label.mjs';

export const DEFAULT_STAFF_IDLE_MS = 5 * 60 * 1000;

/** CHATBOT_STAFF_IDLE_MS (mili giây); trống → 5 phút; 0 → tắt. */
export function staffIdleDelayMs(env = process.env) {
  const raw = env?.CHATBOT_STAFF_IDLE_MS;
  if (raw === undefined || String(raw).trim() === '') return DEFAULT_STAFF_IDLE_MS;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : DEFAULT_STAFF_IDLE_MS;
}

/** Lý do ghi vào nhật ký quyết định / kết quả lượt. */
export function staffIdleReason(delayMs = DEFAULT_STAFF_IDLE_MS) {
  const minutes = Math.max(1, Math.round((Number(delayMs) || DEFAULT_STAFF_IDLE_MS) / 60000));
  return `nhân viên im ${minutes} phút — bot nhận đơn`;
}

/**
 * Tin chữ của khách có ý đặt hàng: có SĐT, là địa chỉ giao hàng, hay ghi số túi/gói/bịch ("E 2 túi", "lấy 3 gói").
 * (Giỏ theo vị "1 xanh 1 vàng" engine bổ sung bằng commentBasket.) Câu hỏi giá suông không tính.
 */
export function isOrderishText(text) {
  const raw = String(text || '');
  if (!raw.trim()) return false;
  if (extractVietnamesePhone(raw)) return true;
  if (looksLikeAddressMessage(raw, { orderStep: true })) return true;
  return /(?<![\d])\d{1,2} ?(?:tui|goi|bich)\b/.test(foldVietnamese(raw));
}

const pending = new Map();
const running = new Set();

/**
 * Hẹn một lượt kiểm lại cho `key` (mã hội thoại) sau `delayMs`. Đã có lượt đang chờ cho key đó → giữ lượt cũ, trả false.
 * `delayMs` ≤ 0 → tắt, trả false. `run` chạy một lần; lỗi chỉ ghi log.
 */
export function scheduleStaffIdleRecheck(key, delayMs, run) {
  const id = String(key || '');
  const delay = Number(delayMs) || 0;
  if (!id || delay <= 0 || typeof run !== 'function' || pending.has(id)) return false;
  const timer = setTimeout(() => {
    pending.delete(id);
    const task = Promise.resolve().then(run).catch(error => console.warn(`Kiểm lại "nhân viên im" lỗi (${id}): ${error?.message || error}`));
    running.add(task);
    task.finally(() => running.delete(task));
  }, delay);
  timer.unref?.();
  pending.set(id, { timer, dueAt: Date.now() + delay });
  return true;
}

export function cancelStaffIdleRecheck(key) {
  const entry = pending.get(String(key || ''));
  if (!entry) return false;
  clearTimeout(entry.timer);
  pending.delete(String(key || ''));
  return true;
}

/** Tắt máy: bỏ mọi lượt kiểm lại đang chờ. */
export function clearStaffIdleRechecks() {
  for (const entry of pending.values()) clearTimeout(entry.timer);
  pending.clear();
}

export function hasStaffIdleRecheck(key) {
  return pending.has(String(key || ''));
}

/** Test: chờ các lượt kiểm lại đang chạy xong. */
export async function settleStaffIdleRechecks() {
  while (running.size) await Promise.all([...running]);
}
