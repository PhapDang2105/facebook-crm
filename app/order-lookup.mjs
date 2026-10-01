// Tra cứu đơn dùng chung cho máy chủ: mọi đơn hệ thống (đơn trong hội thoại —
// bot, nhân viên tạo tay, kéo từ POS — và đơn landing) và các mã đơn đã dùng.
import { readMessagingStore } from './messaging-store.mjs';
import { readLandingStore } from './landing-orders.mjs';
import { readOrderArchive } from './order-archive.mjs';

/** Mọi đơn hệ thống, như danh sách /api/customer-orders (chưa thêm ghi chú xử lý). */
export async function listAllSystemOrders() {
  const messagingStore = await readMessagingStore();
  const landing = await readLandingStore();
  return [
    ...messagingStore.conversations.flatMap(conversation => (Array.isArray(conversation.customerOrders) ? conversation.customerOrders : [])),
    ...(Array.isArray(landing.orders) ? landing.orders : [])
  ];
}

/**
 * Mã đơn đã dùng: đơn đang có (hội thoại, landing) và đơn trong kho lưu trữ (kể
 * cả đơn đã xóa) — mã đơn đi sang POS thành custom_id "CRM-<mã>", dùng lại mã cũ
 * là đụng đơn POS cũ.
 */
export async function takenOrderIds() {
  const ids = new Set((await listAllSystemOrders()).map(order => String(order?.id || '')).filter(Boolean));
  try {
    for (const record of (await readOrderArchive({ limit: 0 })).items) if (record?.id) ids.add(String(record.id));
  } catch {
    // Kho lưu trữ hỏng/không đọc được: vẫn kiểm theo đơn đang có.
  }
  return ids;
}

/**
 * Mã đơn không trùng: giữ nguyên mã ngắn nếu chưa dùng, trùng thì thêm hậu tố
 * "-2", "-3"… (vẫn ngắn, đọc được qua điện thoại). `taken` là Set mã đã dùng.
 */
export function uniqueOrderId(baseId, taken) {
  const used = taken instanceof Set ? taken : new Set(taken || []);
  const stem = String(baseId || '').trim() || String(Date.now()).slice(-5);
  if (!used.has(stem)) return stem;
  for (let suffix = 2; suffix < 10000; suffix += 1) {
    const candidate = `${stem}-${suffix}`;
    if (!used.has(candidate)) return candidate;
  }
  return `${stem}-${Date.now().toString(36)}`;
}

/**
 * Kiểm lại mã đơn ngay trong lượt ghi kho tin nhắn (updateMessagingStore): hai
 * nhân viên tạo đơn cùng lúc cùng qua bước kiểm trước đó thì đơn sau đổi mã.
 * Đổi `order.id` tại chỗ; trả về mã cuối cùng.
 */
export function reserveOrderIdInStore(order, store) {
  const ids = new Set((store?.conversations || []).flatMap(entry => (Array.isArray(entry.customerOrders) ? entry.customerOrders : []).map(existing => String(existing.id))));
  if (ids.has(String(order.id))) order.id = uniqueOrderId(order.id, ids);
  return order.id;
}
