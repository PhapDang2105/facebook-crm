// Ghép vận đơn Sapo (app/sapo.mjs) vào đơn CRM và quyết định có nhắn mã vận đơn cho khách không.
//
// Đơn Facebook trên Sapo do nhân viên import tay từ file Pancake: không mang mã đơn Pancake/CRM,
// nên ghép theo SĐT người nhận (9 số cuối) + thời gian (đơn CRM tạo trước vận đơn tối đa 10 ngày).
// Ghi chú đơn Sapo chứa đúng mã đơn CRM / mã POS thì ghép theo mã (chắc chắn) — dùng khi nhân viên
// ghép cột "Mã đơn" của file Pancake vào ô Ghi chú lúc import.
// Một SĐT khớp đơn của HAI khách khác nhau (khác Page/psid): chỉ ghép khi đúng một đơn trùng tổng
// tiền, không thì bỏ — nhắn nhầm mã của người khác tệ hơn không nhắn.
import { isCancelledOrder, isIncompleteOrder } from './order-facts.mjs';
import { shipmentStatusLabel } from './sapo.mjs';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
export const shipmentMatchBeforeMs = 10 * DAY;
const shipmentMatchAfterMs = 2 * HOUR;
// Vận đơn tạo quá lâu thì không nhắn nữa (khách đã nhận/đã được nhân viên báo).
export const shipmentNoticeMaxAgeMs = 4 * DAY;
// Messenger: tin tự động chỉ gửi được khi khách nhắn hộp thư trong 24 giờ (chừa 1 giờ như bám đuổi).
export const shipmentNoticeWindowMs = 23 * HOUR;
const LATE_STATUSES = new Set(['delivered', 'returning', 'returned', 'cancelled']);

// Như honorific() của chatbot-templates (không import: chatbot-templates → order-notes → đây là vòng).
const honorific = gender => gender === 'male' ? 'anh' : gender === 'female' ? 'chị' : 'anh/chị';
const phoneKey = value => String(value || '').replace(/\D/g, '').slice(-9);
const usableOrder = order => Boolean(order) && order.status !== 'Hủy' && !isCancelledOrder(order) && !isIncompleteOrder(order);

/** Mã của đơn CRM có thể xuất hiện trong ghi chú đơn Sapo (mã CRM, mã POS, mã hệ thống POS). */
function orderCodes(order) {
  return [order.id, order.pos?.id, order.pos?.systemId, order.landing?.posId, ...(Array.isArray(order.landing?.posIds) ? order.landing.posIds : [])]
    .map(value => String(value || '').replace(/^pos/i, '').trim())
    .filter(value => value.length >= 4);
}

function noteMentions(note, code) {
  return new RegExp(`(?<![\\p{L}\\p{N}])(?:CRM-)?${code.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\p{L}\\p{N}])`, 'iu').test(note);
}

/**
 * Chọn đơn CRM cho một vận đơn. `candidates`: [{ order, owner }] — owner là khóa khách
 * (pageId:psid của hội thoại, hay "landing:<mã>"). Trả về { candidate, matchedBy } hoặc
 * { ambiguous: true } hoặc null.
 */
export function pickShipmentOrder(shipment, candidates) {
  const all = (Array.isArray(candidates) ? candidates : []).filter(item => item?.order);
  // Đã ghép từ lượt trước: giữ nguyên (chỉ cập nhật trạng thái giao).
  const linked = all.find(item => item.order.shipment?.trackingNumber === shipment.trackingNumber);
  if (linked) return { candidate: linked, matchedBy: linked.order.shipment.matchedBy || 'phone' };
  const note = String(shipment.note || '');
  if (note) {
    const byCode = all.filter(item => usableOrder(item.order) && orderCodes(item.order).some(code => noteMentions(note, code)));
    if (byCode.length === 1) return { candidate: byCode[0], matchedBy: 'note' };
  }
  const created = Number(shipment.createdAt) || 0;
  const open = all.filter(item => {
    const order = item.order;
    const at = Number(order.createdAt) || 0;
    return usableOrder(order) && !order.shipment?.trackingNumber && phoneKey(order.phone) === shipment.phoneKey
      && at >= created - shipmentMatchBeforeMs && at <= created + shipmentMatchAfterMs;
  });
  if (!open.length) return null;
  const sameTotal = open.filter(item => Number(item.order.total) > 0 && Number(item.order.total) === Number(shipment.total));
  const owners = new Set(open.map(item => item.owner));
  if (owners.size > 1) {
    return sameTotal.length === 1 ? { candidate: sameTotal[0], matchedBy: 'phone+total' } : { ambiguous: true };
  }
  const latest = list => [...list].sort((first, second) => (Number(second.order.createdAt) || 0) - (Number(first.order.createdAt) || 0))[0];
  return sameTotal.length ? { candidate: latest(sameTotal), matchedBy: 'phone+total' } : { candidate: latest(open), matchedBy: 'phone' };
}

/** Ghi/cập nhật order.shipment; trả về { isNew, statusChanged }. */
export function applyShipment(order, shipment, matchedBy, now = Date.now()) {
  const before = order.shipment && order.shipment.trackingNumber === shipment.trackingNumber ? order.shipment : null;
  const next = {
    ...(before || {}),
    provider: 'sapo',
    sapoId: shipment.sapoId,
    sapoName: shipment.sapoName,
    carrier: shipment.carrier,
    trackingNumber: shipment.trackingNumber,
    trackingUrl: shipment.trackingUrl,
    status: shipment.status,
    statusLabel: shipmentStatusLabel(shipment.status),
    createdAt: shipment.createdAt,
    deliveredAt: shipment.deliveredAt || 0,
    cancelled: shipment.cancelled,
    matchedBy: before?.matchedBy || matchedBy,
    matchedAt: before?.matchedAt || now
  };
  const statusChanged = Boolean(before) && (before.status !== next.status || Boolean(before.cancelled) !== Boolean(next.cancelled));
  const changed = !before || statusChanged || before.trackingUrl !== next.trackingUrl || before.carrier !== next.carrier;
  if (changed) order.shipment = { ...next, updatedAt: now };
  return { isNew: !before, statusChanged, changed };
}

/**
 * Ghép vận đơn vào đơn trong hội thoại (sửa `store` tại chỗ, chạy trong updateMessagingStore).
 * Trả về { changes: [{ conversationId, orderId, isNew, statusChanged }], ambiguous, unmatched: [shipment] }.
 */
export function attachShipmentsToConversations(store, shipments, { now = Date.now() } = {}) {
  const byPhone = new Map();
  for (const conversation of Array.isArray(store?.conversations) ? store.conversations : []) {
    for (const order of Array.isArray(conversation.customerOrders) ? conversation.customerOrders : []) {
      const keys = new Set([phoneKey(order.phone)]);
      const candidate = { order, conversation, owner: `${conversation.pageId}:${conversation.psid}` };
      for (const key of keys) {
        if (key.length !== 9) continue;
        if (!byPhone.has(key)) byPhone.set(key, []);
        byPhone.get(key).push(candidate);
      }
      // Đơn đã ghép trước đây mà SĐT bị sửa sau đó vẫn phải tìm lại được theo mã vận đơn.
      if (order.shipment?.trackingNumber) {
        const key = `tn:${order.shipment.trackingNumber}`;
        if (!byPhone.has(key)) byPhone.set(key, []);
        byPhone.get(key).push(candidate);
      }
    }
  }
  const result = { changes: [], ambiguous: 0, unmatched: [] };
  const taken = new Set();
  for (const shipment of shipments) {
    const pool = [...(byPhone.get(`tn:${shipment.trackingNumber}`) || []), ...(byPhone.get(shipment.phoneKey) || [])]
      .filter(item => !taken.has(item.order) || item.order.shipment?.trackingNumber === shipment.trackingNumber);
    const pick = pickShipmentOrder(shipment, pool);
    if (!pick) { result.unmatched.push(shipment); continue; }
    if (pick.ambiguous) { result.ambiguous += 1; continue; }
    const { order, conversation } = pick.candidate;
    taken.add(order);
    const outcome = applyShipment(order, shipment, pick.matchedBy, now);
    if (outcome.changed) result.changes.push({ conversationId: conversation.id, orderId: order.id, isNew: outcome.isNew, statusChanged: outcome.statusChanged });
  }
  return result;
}

/** Như trên cho đơn landing (không có hội thoại nên không nhắn khách; chỉ để nhân viên xem). */
export function attachShipmentsToLandingOrders(landingStore, shipments, { now = Date.now() } = {}) {
  const orders = Array.isArray(landingStore?.orders) ? landingStore.orders : [];
  const candidates = orders.map(order => ({ order, owner: `landing:${order.id}` }));
  let changed = 0;
  const taken = new Set();
  for (const shipment of shipments) {
    const pool = candidates.filter(item => !taken.has(item.order)
      && (item.order.shipment?.trackingNumber === shipment.trackingNumber || phoneKey(item.order.phone) === shipment.phoneKey));
    const pick = pickShipmentOrder(shipment, pool);
    if (!pick || pick.ambiguous) continue;
    taken.add(pick.candidate.order);
    if (applyShipment(pick.candidate.order, shipment, pick.matchedBy, now).changed) changed += 1;
  }
  return changed;
}

const sameCustomerInbox = (store, conversation) => conversation.source !== 'comment'
  ? conversation
  : (store.conversations || []).find(item => item.source !== 'comment' && item.pageId === conversation.pageId && item.psid === conversation.psid) || null;

function lastCustomerAt(store, inbox) {
  const messages = Array.isArray(store.messages?.[inbox.id]) ? store.messages[inbox.id] : [];
  const fromMessages = messages.reduce((latest, message) => message?.direction === 'incoming' ? Math.max(latest, Number(message.createdAt) || 0) : latest, 0);
  return Math.max(Number(inbox.lastCustomerMessageAt) || 0, fromMessages);
}

/**
 * Nhắn mã vận đơn cho đơn này không? { action: 'send', inbox } | { action: 'wait', reason }
 * (ngoài 24 giờ / giờ nghỉ: lượt sau xét lại, nhân viên thấy ghi chú) | { action: 'skip', reason }.
 */
export function shipmentNoticePlan(store, conversation, order, { now = Date.now(), quietHour = false } = {}) {
  const shipment = order?.shipment;
  if (!shipment?.trackingNumber) return { action: 'skip', reason: 'chưa có vận đơn' };
  if (shipment.noticeAt) return { action: 'skip', reason: 'đã báo khách' };
  if (shipment.cancelled || LATE_STATUSES.has(shipment.status)) return { action: 'skip', reason: `vận đơn ${shipmentStatusLabel(shipment.status).toLowerCase()}` };
  if (now - (Number(shipment.createdAt) || now) > shipmentNoticeMaxAgeMs) return { action: 'skip', reason: 'vận đơn đã cũ' };
  if (!usableOrder(order)) return { action: 'skip', reason: 'đơn CRM đã hủy' };
  const inbox = sameCustomerInbox(store, conversation);
  if (!inbox) return { action: 'wait', reason: 'khách chưa có hộp thư (chỉ bình luận)' };
  if (now - lastCustomerAt(store, inbox) > shipmentNoticeWindowMs) return { action: 'wait', reason: 'ngoài 24 giờ Messenger' };
  if (quietHour) return { action: 'wait', reason: 'giờ nghỉ (22h–7h)' };
  return { action: 'send', inbox };
}

/** Tin báo mã vận đơn. J&T hỏi 4 số cuối SĐT khi tra nên nhắc khách trước. */
export function renderShipmentNotice(shipment, gender = '') {
  const you = honorific(gender);
  const You = you.charAt(0).toUpperCase() + you.slice(1);
  const lines = [`Dạ đơn hàng của ${you} đã được giao cho ${shipment.carrier}, mã vận đơn: ${shipment.trackingNumber} ạ.`];
  if (shipment.trackingUrl) lines.push(`${You} theo dõi hành trình đơn tại: ${shipment.trackingUrl}`);
  if (/J&T/i.test(shipment.carrier)) lines.push(`(Trang J&T hỏi số điện thoại thì ${you} nhập 4 số cuối SĐT nhận hàng giúp em nhé.)`);
  lines.push(`Giọt Nắng cảm ơn ${you} đã ủng hộ ạ!`);
  return lines.join('\n');
}

/** Ghi chú cho bảng Đơn hàng: "ℹ J&T Express 8028… · Đang giao". */
export function shipmentNote(order) {
  const shipment = order?.shipment;
  if (!shipment?.trackingNumber) return '';
  const label = shipment.cancelled ? 'Vận đơn đã hủy' : shipment.statusLabel || shipmentStatusLabel(shipment.status);
  return `ℹ ${shipment.carrier} ${shipment.trackingNumber} · ${label}`;
}
