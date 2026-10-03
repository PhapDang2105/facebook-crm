// Ghép vận đơn Sapo (app/sapo.mjs) vào đơn CRM và báo khách hành trình đơn theo từng giai đoạn.
//
// Đơn Facebook trên Sapo do nhân viên import tay từ file Pancake: không mang mã đơn Pancake/CRM,
// nên ghép theo SĐT người nhận (9 số cuối) + thời gian (đơn CRM tạo trước vận đơn tối đa 10 ngày).
// Ghi chú đơn Sapo chứa đúng mã đơn CRM / mã POS thì ghép theo mã (chắc chắn) — dùng khi nhân viên
// ghép cột "Mã đơn" của file Pancake vào ô Ghi chú lúc import.
// Một SĐT khớp đơn của HAI khách khác nhau (khác Page/psid): chỉ ghép khi đúng một đơn trùng tổng
// tiền, không thì bỏ — nhắn nhầm mã của người khác tệ hơn không nhắn.
//
// Giai đoạn (chủ shop 03/10): có mã vận đơn → đã lấy hàng → đang vận chuyển → đang giao cho khách →
// giao thành công (cảm ơn). Sapo chỉ có pending / picked_up / delivering / retry_delivery / delivered,
// nên "đang giao cho khách" lấy từ hành trình của hãng (SPX) hay retry_delivery. Tin đầu luôn kèm mã
// vận đơn + link tra + trạng thái hiện tại; sau đó mỗi giai đoạn mới một tin, nhảy cóc thì chỉ báo
// giai đoạn mới nhất. Trong 24 giờ Messenger: máy chủ tự gửi; ngoài 24 giờ: vào hàng chờ, trang CRM
// gửi qua cầu nối Pancake (tiện ích Pancake gửi được ngoài 24 giờ).
import { isCancelledOrder, isIncompleteOrder } from './order-facts.mjs';
import { SHIPMENT_STAGES, STAGE_TEMPLATES, shipmentStage, shipmentStageLabel } from './shipment-stage.mjs';
export * from './shipment-stage.mjs';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
export const shipmentMatchBeforeMs = 10 * DAY;
const shipmentMatchAfterMs = 2 * HOUR;
// Giai đoạn đã qua quá lâu thì không báo nữa (tin "đang giao" sau 2 ngày là sai sự thật).
export const shipmentStageNoticeMaxAgeMs = 2 * DAY;
// Messenger: tin tự động chỉ gửi được khi khách nhắn hộp thư trong 24 giờ (chừa 1 giờ như bám đuổi).
export const shipmentNoticeWindowMs = 23 * HOUR;


const phoneKey = value => String(value || '').replace(/\D/g, '').slice(-9);
const stageIndex = stage => SHIPMENT_STAGES.indexOf(stage);
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
    statusLabel: shipmentStageLabel(shipmentStage({ status: shipment.status, cancelled: shipment.cancelled }) || 'created'),
    carrierStage: before?.carrierStage || '',
    createdAt: shipment.createdAt,
    deliveredAt: shipment.deliveredAt || 0,
    cancelled: shipment.cancelled,
    matchedBy: before?.matchedBy || matchedBy,
    matchedAt: before?.matchedAt || now
  };
  const statusChanged = Boolean(before) && (before.status !== next.status || Boolean(before.cancelled) !== Boolean(next.cancelled));
  const changed = !before || statusChanged || before.trackingUrl !== next.trackingUrl || before.carrier !== next.carrier;
  if (changed) {
    const stage = shipmentStage(next) || '';
    if (stage !== (before?.stage || '') || !before) Object.assign(next, { stage, stageAt: now });
    order.shipment = { ...next, updatedAt: now };
  }
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

/** Hành trình của hãng (SPX) đổi giai đoạn: ghi carrierStage, tính lại stage. Trả về true nếu đổi. */
export function applyCarrierStage(order, carrierStage, now = Date.now()) {
  const shipment = order?.shipment;
  if (!shipment || !carrierStage) return false;
  shipment.carrierCheckedAt = now;
  if (shipment.carrierStage === carrierStage) return false;
  shipment.carrierStage = carrierStage;
  const stage = shipmentStage(shipment) || '';
  if (stage !== (shipment.stage || '')) Object.assign(shipment, { stage, stageAt: now });
  shipment.updatedAt = now;
  return true;
}

export const sameCustomerInbox = (store, conversation) => conversation.source !== 'comment'
  ? conversation
  : (store.conversations || []).find(item => item.source !== 'comment' && item.pageId === conversation.pageId && item.psid === conversation.psid) || null;

function lastCustomerAt(store, inbox) {
  const messages = Array.isArray(store.messages?.[inbox.id]) ? store.messages[inbox.id] : [];
  const fromMessages = messages.reduce((latest, message) => message?.direction === 'incoming' ? Math.max(latest, Number(message.createdAt) || 0) : latest, 0);
  return Math.max(Number(inbox.lastCustomerMessageAt) || 0, fromMessages);
}

export const notifiedStage = shipment => String(shipment?.notifiedStage || '');

/** Page (bot hay nhân viên) đã tự nhắn mã vận đơn này trong hội thoại chưa. */
function trackingSentInConversation(store, inbox, shipment) {
  const messages = Array.isArray(store.messages?.[inbox.id]) ? store.messages[inbox.id] : [];
  return messages.some(message => message?.direction === 'outgoing' && String(message.text || '').includes(shipment.trackingNumber));
}

/**
 * Báo khách giai đoạn nào của vận đơn này, qua đường nào:
 *  { action: 'send', inbox, stage, templateId }          trong 24 giờ Messenger → máy chủ tự gửi;
 *  { action: 'queue', inbox, stage, templateId, reason } ngoài 24 giờ → hàng chờ gửi qua cầu nối Pancake;
 *  { action: 'wait', reason }                             giờ nghỉ / chưa có hộp thư — lượt sau xét lại;
 *  { action: 'mark', stage, reason }                      đã báo cách khác / đã qua lâu → chỉ ghi dấu;
 *  { action: 'skip', reason }.
 */
export function shipmentNoticePlan(store, conversation, order, { now = Date.now(), quietHour = false } = {}) {
  const shipment = order?.shipment;
  if (!shipment?.trackingNumber) return { action: 'skip', reason: 'chưa có vận đơn' };
  const stage = shipmentStage(shipment);
  if (!stage) return { action: 'skip', reason: 'vận đơn hoàn/hủy' };
  const done = notifiedStage(shipment);
  if (done && stageIndex(stage) <= stageIndex(done)) return { action: 'skip', reason: 'đã báo giai đoạn này' };
  if (!usableOrder(order)) return { action: 'skip', reason: 'đơn CRM đã hủy' };
  if (now - (Number(shipment.stageAt) || now) > shipmentStageNoticeMaxAgeMs) return { action: 'mark', stage, reason: 'giai đoạn đã qua lâu' };
  const inbox = sameCustomerInbox(store, conversation);
  if (!inbox) return { action: 'wait', reason: 'khách chưa có hộp thư (chỉ bình luận)' };
  // Tin đầu: nhân viên/bot đã gửi mã trong hội thoại rồi thì coi như đã báo giai đoạn hiện tại.
  if (!done && stage !== 'delivered' && trackingSentInConversation(store, inbox, shipment)) return { action: 'mark', stage, reason: 'đã gửi mã trong hội thoại' };
  // Tin đầu (chưa báo gì) luôn là tin mã vận đơn, trừ khi đơn đã giao xong (chỉ còn lời cảm ơn).
  const templateId = !done && stage !== 'delivered' ? STAGE_TEMPLATES.created : STAGE_TEMPLATES[stage];
  if (quietHour) return { action: 'wait', reason: 'giờ nghỉ (22h–7h)' };
  if (now - lastCustomerAt(store, inbox) > shipmentNoticeWindowMs) return { action: 'queue', inbox, stage, templateId, reason: 'ngoài 24 giờ Messenger' };
  return { action: 'send', inbox, stage, templateId };
}

/** Ghi dấu đã báo một giai đoạn (lịch sử ngắn để nhân viên xem lại) hay lỗi gửi. */
export function markShipmentNotified(shipment, { stage, via, at = Date.now(), error = '', uncertain = false }) {
  if (!shipment) return;
  if (error) {
    // Đếm số lần lỗi của đúng giai đoạn này (giai đoạn mới thì đếm lại): tự gửi qua cầu nối dừng sau 2 lần.
    const attempts = (shipment.noticeErrorStage === stage ? Number(shipment.noticeAttempts) || 0 : 0) + 1;
    Object.assign(shipment, { noticeError: String(error).slice(0, 200), noticeErrorAt: at, noticeErrorStage: stage, noticeAttempts: attempts });
    return;
  }
  const history = Array.isArray(shipment.notices) ? shipment.notices : [];
  // `uncertain`: gửi hết giờ chờ, không rõ đã tới khách — vẫn tính là đã báo (không gửi lại).
  Object.assign(shipment, { notifiedStage: stage, notifiedAt: at, notices: [...history, { stage, via, at, ...(uncertain ? { uncertain: true } : {}) }].slice(-8) });
  delete shipment.noticeError;
  delete shipment.noticeErrorAt;
  delete shipment.noticeErrorStage;
  delete shipment.noticeAttempts;
}

