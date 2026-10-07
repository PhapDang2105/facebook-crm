// Gắn bù thẻ "Đã mua hàng" (thẻ nhận sự kiện 'order') trong CRM — chỉ thẻ CRM, không đụng thẻ Pancake.
// 01/10: rà 24/09–01/10 thấy hội thoại có đơn mà thiếu thẻ ở ba chỗ:
//  1. đơn đã lưu trong hội thoại nhưng chưa từng được gắn (bot lên đơn rồi gửi tin lỗi → bước gắn thẻ
//     sau khi gửi không chạy; đơn CRM đẩy POS bị đồng bộ POS bỏ qua nên không ai gắn bù);
//  2. khách đặt qua landing (Webcake) rồi nhắn Page: đơn landing không nối với hội thoại;
//  3. luồng bình luận của khách đã mua (cùng Page, cùng khách) không bao giờ được gắn.
// Mỗi đơn/luồng chỉ gắn MỘT lần (cờ), để nhân viên gỡ thẻ thì lượt sau không gắn lại.
import { isCancelledOrder, isIncompleteOrder } from './order-facts.mjs';

const DAY = 24 * 60 * 60 * 1000;
// Chỉ xét đơn gần đây: không gắn lại hàng loạt cho lịch sử cũ.
export const purchaseBackfillWindowMs = 30 * DAY;
// Đơn landing chỉ nối với hội thoại có tin khách ghi đúng SĐT trong khoảng này quanh lúc đặt.
const landingMatchWindowMs = 7 * DAY;
// Đơn bot vừa tạo: để luồng trả lời tự gắn trước, lượt bù chỉ nhặt đơn đã qua chút thời gian.
const settleMs = 2 * 60 * 1000;

// Đơn còn hiệu lực: không hủy/hoàn (khách hủy, trạng thái POS 4/5/6/7…) và không phải form landing
// khách bỏ dở (chưa là đơn, trừ khi nhân viên đã gọi xác nhận) — cùng định nghĩa với báo cáo.
const activeOrder = order => Boolean(order) && order.status !== 'Hủy' && !isCancelledOrder(order) && !isIncompleteOrder(order);
const phoneKey = value => String(value || '').replace(/\D/g, '').slice(-9);
// SĐT trong tin khách (kể cả viết cách "0912 345 678", "0912.345.678") → 9 số cuối. Đúng 9 chữ số sau
// 0/84, chỉ nối qua dấu cách/chấm/gạch trên CÙNG dòng, và không được dính liền chữ số khác: tin
// "0912345678 5 Lê Lợi" hay "0912345678" + xuống dòng + "12 Nguyễn Huệ" không nuốt số nhà vào SĐT.
export function phoneKeysInText(text) {
  const keys = new Set();
  for (const match of String(text || '').matchAll(/(?<!\d)(?:\+?84|0)(?:[ .-]?\d){9}(?!\d)/g)) {
    const key = phoneKey(match[0]);
    if (key.length === 9) keys.add(key);
  }
  return keys;
}

function addLabels(conversation, labelIds) {
  const before = Array.isArray(conversation.labels) ? conversation.labels : [];
  const merged = [...new Set([...before, ...labelIds])];
  if (merged.length === before.length) return null;
  conversation.labels = merged;
  return { conversation: { id: conversation.id, name: conversation.name || '' }, before: [...before], after: [...merged] };
}

/**
 * Chạy trong updateMessagingStore (sửa `store` tại chỗ). Trả về danh sách thay đổi thẻ
 * `{ conversation, before, after, reason }` để ghi nhật ký và phát sự kiện.
 */
export function backfillPurchaseLabels(store, { orderLabels = [], deliveredLabels = [], landingOrders = [], now = Date.now() } = {}) {
  const labels = (Array.isArray(orderLabels) ? orderLabels : []).filter(Boolean);
  if (!labels.length || !Array.isArray(store?.conversations)) return [];
  const deliveredSet = new Set(Array.isArray(deliveredLabels) ? deliveredLabels : []);
  const changes = [];
  const record = (change, reason) => { if (change) changes.push({ ...change, reason }); };
  const recent = order => {
    const at = Number(order?.createdAt) || 0;
    return at > now - purchaseBackfillWindowMs && at < now - settleMs;
  };
  const inbox = store.conversations.filter(item => item.source !== 'comment');
  const buyers = new Set();

  // 1. Đơn đã nằm trong hội thoại mà chưa được gắn.
  for (const conversation of inbox) {
    const orders = Array.isArray(conversation.customerOrders) ? conversation.customerOrders : [];
    let bought = false;
    const hasDelivered = deliveredSet.size > 0 && (Array.isArray(conversation.labels) ? conversation.labels : []).some(id => deliveredSet.has(id));
    for (const order of orders) {
      if (!activeOrder(order) || !recent(order)) continue;
      bought = true;
      if (order.purchaseLabeled) continue;
      order.purchaseLabeled = true;
      if (!hasDelivered) record(addLabels(conversation, labels), 'gắn bù cho đơn đã có trong hội thoại');
    }
    if (bought) buyers.add(conversation);
  }

  // 2. Đơn landing: nối với hội thoại hộp thư có tin khách ghi đúng SĐT quanh lúc đặt.
  const landing = (Array.isArray(landingOrders) ? landingOrders : [])
    .filter(order => activeOrder(order) && recent(order) && phoneKey(order.phone).length === 9);
  if (landing.length) {
    const wanted = new Map();
    for (const order of landing) {
      const key = phoneKey(order.phone);
      if (!wanted.has(key)) wanted.set(key, []);
      wanted.get(key).push(order);
    }
    for (const conversation of inbox) {
      const messages = Array.isArray(store.messages?.[conversation.id]) ? store.messages[conversation.id] : [];
      const seen = new Map();
      for (const message of messages) {
        if (message?.direction !== 'incoming') continue;
        for (const key of phoneKeysInText(message.text)) if (wanted.has(key) && !seen.has(key)) seen.set(key, Number(message.createdAt) || 0);
      }
      for (const [key, at] of seen) {
        for (const order of wanted.get(key)) {
          if (Math.abs(at - (Number(order.createdAt) || 0)) > landingMatchWindowMs) continue;
          const done = Array.isArray(conversation.landingLabeled) ? conversation.landingLabeled : [];
          if (done.includes(String(order.id))) continue;
          conversation.landingLabeled = [...done, String(order.id)].slice(-50);
          const hasDelivered = deliveredSet.size > 0 && (Array.isArray(conversation.labels) ? conversation.labels : []).some(id => deliveredSet.has(id));
          if (!hasDelivered) record(addLabels(conversation, labels), 'gắn cho khách đặt qua landing (khớp SĐT)');
          buyers.add(conversation);
        }
      }
    }
  }

  // Bình luận không gắn thẻ: đảm bảo mọi luồng bình luận không mang thẻ
  for (const conversation of store.conversations) {
    if (conversation?.source === 'comment' && Array.isArray(conversation.labels) && conversation.labels.length) {
      conversation.labels = [];
    }
  }
  return changes;
}
