// Cửa sổ 24 giờ của Messenger (INT-15): Page chỉ được tự nhắn khách trong 24 giờ kể từ tin cuối của KHÁCH ở
// hộp thư. Trước đây bốn nơi tính bốn kiểu (chỉ tin đã lưu / cả mốc lastCustomerMessageAt; chừa 1 giờ hay không).
// Mọi nơi dùng chung hàm này: mốc khách = max(lastCustomerMessageAt của hộp thư, tin khách mới nhất đã lưu),
// mặc định chừa 1 giờ an toàn (tin đi lúc 23 giờ 59 có thể bị Meta từ chối vì lệch giờ / xếp hàng).
export const MESSENGER_WINDOW_MS = 24 * 60 * 60 * 1000;
export const MESSENGER_WINDOW_MARGIN_MS = 60 * 60 * 1000;

/** Mốc tin cuối của khách ở hộp thư (0 = chưa có): trường trên hội thoại và tin đã lưu, lấy cái mới hơn. */
export function lastCustomerMessageAt(store, inbox) {
  if (!inbox) return 0;
  const messages = Array.isArray(store?.messages?.[inbox.id]) ? store.messages[inbox.id] : [];
  let latest = Number(inbox.lastCustomerMessageAt) || 0;
  for (const message of messages) {
    if (message?.direction === 'incoming') latest = Math.max(latest, Number(message.createdAt) || 0);
  }
  return latest;
}

/** Cửa sổ còn mở: khách nhắn hộp thư trong (24 giờ − `marginMs`). */
export function messengerWindowOpen(store, inbox, { now = Date.now(), marginMs = MESSENGER_WINDOW_MARGIN_MS } = {}) {
  const at = lastCustomerMessageAt(store, inbox);
  return at > 0 && now - at <= MESSENGER_WINDOW_MS - marginMs;
}
