// Trạng thái MỚI NHẤT của đơn trên Pancake POS, chép về đơn CRM tương ứng để
// báo cáo biết đơn đã hủy / đang hoàn / đã hoàn (bom) — kể cả khi việc đó xảy ra
// nhiều ngày sau lúc đặt (trước đây chỉ đơn CRM bị hủy trong 48 giờ đầu mới được
// CRM hủy theo, nên đơn bom/hoàn về sau vẫn nằm trong doanh thu).
//
// Chỉ ghi `order.posStatus = { code, name, at }`; không đổi processingStatus,
// lịch sử hay updatedAt của đơn. isCancelledOrder (order-facts.mjs) đọc trường này.

/** Một đơn POS (GET /orders) → bản cập nhật trạng thái. */
export function posStatusUpdate(posOrder, now = Date.now()) {
  const code = Number(posOrder?.status);
  return {
    posId: String(posOrder?.id ?? ''),
    systemId: String(posOrder?.system_id ?? ''),
    customId: String(posOrder?.custom_id ?? ''),
    code: Number.isFinite(code) ? code : null,
    name: String(posOrder?.status_name || ''),
    at: now
  };
}

/** Chỉ mục các bản cập nhật theo mã POS, mã hệ thống và mã đơn CRM (custom_id "CRM-…"). */
export function indexPosStatuses(updates = []) {
  const byPosId = new Map();
  const bySystemId = new Map();
  const byCrmId = new Map();
  for (const update of updates) {
    if (!update || update.code === null || update.code === undefined) continue;
    if (update.posId) byPosId.set(update.posId, update);
    if (update.systemId) bySystemId.set(update.systemId, update);
    if (/^CRM-/i.test(update.customId)) byCrmId.set(update.customId.replace(/^CRM-/i, ''), update);
  }
  return { byPosId, bySystemId, byCrmId };
}

/** Bản cập nhật POS khớp với một đơn CRM (đơn landing, đơn CRM đã đẩy, đơn POS kéo về hội thoại). */
export function matchPosStatus(order, index) {
  if (!order || !index) return null;
  const posIds = [order.pos?.id, order.landing?.posId, ...(Array.isArray(order.landing?.posIds) ? order.landing.posIds : [])]
    .filter(Boolean).map(String);
  for (const posId of posIds) if (index.byPosId.has(posId)) return index.byPosId.get(posId);
  const systemId = String(order.pos?.systemId || '');
  if (systemId && index.bySystemId.has(systemId)) return index.bySystemId.get(systemId);
  const id = String(order.id || '');
  if (id && index.byCrmId.has(id)) return index.byCrmId.get(id);
  // Đơn POS kéo về hội thoại mang mã cố định `pos<system_id>` (cũ: `pos<id>`).
  const pulled = id.match(/^pos(.+)$/);
  if (pulled) return index.bySystemId.get(pulled[1]) || index.byPosId.get(pulled[1]) || null;
  return null;
}

/** Ghi trạng thái POS mới lên đơn; trả về true nếu có đổi. */
export function applyPosStatus(order, update) {
  if (!order || !update || update.code === null || update.code === undefined) return false;
  if (order.posStatus && Number(order.posStatus.code) === Number(update.code) && String(order.posStatus.name || '') === update.name) return false;
  order.posStatus = { code: update.code, name: update.name, at: update.at };
  return true;
}

/** Áp các bản cập nhật lên một danh sách đơn. Trả về số đơn đã đổi. */
export function applyPosStatusesToOrders(orders = [], updates = [], index = indexPosStatuses(updates)) {
  let changed = 0;
  for (const order of Array.isArray(orders) ? orders : []) {
    if (applyPosStatus(order, matchPosStatus(order, index))) changed += 1;
  }
  return changed;
}

/** Áp lên đơn trong hội thoại (kho tin nhắn). Trả về số đơn đã đổi. */
export async function applyPosStatusesToConversations(updates = []) {
  if (!updates.length) return 0;
  const index = indexPosStatuses(updates);
  if (!index.byPosId.size) return 0;
  const { updateMessagingStore } = await import('./messaging-store.mjs');
  // Không đơn nào đổi trạng thái thì không ghi lại kho (vòng đồng bộ chạy 5 phút một lần).
  return updateMessagingStore(store => {
    let changed = 0;
    for (const conversation of store.conversations || []) {
      changed += applyPosStatusesToOrders(conversation.customerOrders, updates, index);
    }
    return changed;
  }, { unchanged: changed => !changed });
}
