// Đồng bộ vận đơn Sapo → đơn CRM mỗi 10 phút, rồi báo khách hành trình đơn theo giai đoạn.
//
// Mỗi lượt: đọc đơn Sapo SỬA từ mốc lần trước (lùi 10 phút cho chắc) → ghép vận đơn vào đơn trong
// hội thoại / đơn landing (app/sapo-tracking.mjs) → tra hành trình SPX của vận đơn đang đi để biết
// "đang giao cho khách" / "đã giao" sớm hơn Sapo → báo khách:
//  - trong 24 giờ Messenger: máy chủ tự gửi (ngoài giờ nghỉ 22h–7h);
//  - ngoài 24 giờ: nằm trong hàng chờ (listShipmentNoticeQueue), trang CRM gửi qua cầu nối Pancake.
// Bật/tắt tự nhắn ở Vận chuyển (data/processed/sapo-settings.json); SAPO_NOTIFY_CUSTOMERS=0/1 trong
// .env thắng cài đặt. Lần chạy đầu lùi 1 ngày. Mốc lưu ở data/processed/sapo-sync.json.
// Lần đầu bật báo khách: vận đơn tạo trước đó hơn 24 giờ chỉ được ghi dấu (không nhắn dồn tin cũ).
import path from 'node:path';
import { projectRoot } from './config.mjs';
import { readJsonFile, writeJsonAtomic } from './json-store.mjs';
import { isSapoConfigured, listSapoOrdersModifiedSince, sapoConfig, sapoShipment } from './sapo.mjs';
import {
  applyCarrierStage, attachShipmentsToConversations, attachShipmentsToLandingOrders, markShipmentNotified,
  notifiedStage, renderShipmentNotice, sameCustomerInbox, shipmentNoticePlan, shipmentStage, shipmentStageLabel, stageFromSpxRecords
} from './sapo-tracking.mjs';

export const SAPO_SYNC_INTERVAL_MS = 10 * 60 * 1000;
// ~2.300 đơn/ngày (gần hết đơn sàn) + mỗi lần đổi trạng thái lại tính là "sửa": lùi 1 ngày ≈ 35 trang.
const FIRST_LOOKBACK_MS = 24 * 60 * 60 * 1000;
const OVERLAP_MS = 10 * 60 * 1000;
const BASELINE_AGE_MS = 24 * 60 * 60 * 1000;
const MAX_NOTICES_PER_RUN = 30;
// Tra hành trình SPX: mỗi vận đơn tối đa 30 phút/lần, tối đa 40 vận đơn mỗi lượt.
const CARRIER_RECHECK_MS = 30 * 60 * 1000;
const MAX_CARRIER_CHECKS = 40;
export const sapoStatePath = path.join(projectRoot, 'data', 'processed', 'sapo-sync.json');
export const sapoSettingsPath = path.join(projectRoot, 'data', 'processed', 'sapo-settings.json');

export const isQuietHourVN = now => { const hour = (new Date(now).getUTCHours() + 7) % 24; return hour >= 22 || hour < 7; };

const conversationOrders = store => (store.conversations || []).flatMap(conversation =>
  (Array.isArray(conversation.customerOrders) ? conversation.customerOrders : []).map(order => ({ conversation, order })));

const findOrder = (store, conversationId, orderId) => {
  const conversation = (store.conversations || []).find(item => item.id === conversationId);
  const order = conversation?.customerOrders?.find(item => String(item.id) === String(orderId));
  return conversation && order ? { conversation, order } : null;
};

// Cách báo khách được tính là "đã gửi mã vận đơn" (không tính ghi dấu baseline / quá lâu / mẫu tắt / bỏ qua).
const SENT_VIAS = new Set(['bot', 'pancake-bridge', 'manual', 'conversation']);

/**
 * Thẻ CRM tự động cho vận đơn (chỉ thẻ CRM, không đụng Pancake — như thẻ Đã mua hàng):
 *  - `sentLabels` (sự kiện shipment-sent): khách đã nhận mã / hành trình vận đơn;
 *  - `deliveredLabels` (sự kiện delivered): vận đơn giao thành công.
 * Gắn vào hộp thư của khách (đơn nằm ở luồng bình luận thì gắn cả luồng đó). Mỗi vận đơn gắn MỘT lần
 * (cờ trên vận đơn), nhân viên gỡ thẻ thì lượt sau không gắn lại. Sửa `store` tại chỗ; trả về các thay
 * đổi thẻ `{ conversation, before, after, reason }` để ghi nhật ký.
 */
export function applyShipmentLabels(store, { sentLabels = [], deliveredLabels = [] } = {}) {
  const changes = [];
  if (!sentLabels.length && !deliveredLabels.length) return changes;
  const label = (conversations, ids, reason) => {
    for (const conversation of conversations) {
      const before = Array.isArray(conversation.labels) ? conversation.labels : [];
      const after = [...new Set([...before, ...ids])];
      if (after.length === before.length) continue;
      conversation.labels = after;
      changes.push({ conversation: { id: conversation.id, name: conversation.name || '' }, before: [...before], after: [...after], reason });
    }
  };
  for (const { conversation, order } of conversationOrders(store)) {
    const shipment = order.shipment;
    if (!shipment?.trackingNumber) continue;
    const targets = [...new Set([sameCustomerInbox(store, conversation), conversation].filter(Boolean))];
    if (sentLabels.length && !shipment.sentLabeled && (shipment.notices || []).some(notice => SENT_VIAS.has(notice.via))) {
      shipment.sentLabeled = true;
      label(targets, sentLabels, `đã gửi mã vận đơn ${shipment.trackingNumber}`);
    }
    if (deliveredLabels.length && !shipment.deliveredLabeled && shipmentStage(shipment) === 'delivered') {
      shipment.deliveredLabeled = true;
      label(targets, deliveredLabels, `vận đơn ${shipment.trackingNumber} giao thành công`);
    }
  }
  return changes;
}

/**
 * Một lượt đồng bộ. Phụ thuộc truyền vào để kiểm thử được:
 * { listOrders(since), readMessagingStore, updateMessagingStore, readLandingStore, updateLandingStore,
 *   sendMessage(inbox, { text }), genderOf(conversation, messages), readTemplates(), trackSpx(number),
 *   labelIds() → { sent, delivered }, onLabelChanges(changes), notify, readState, writeState, onChanged(conversationId), now, log }
 */
export async function runSapoSync(deps) {
  const now = deps.now ?? Date.now();
  const log = deps.log || console.log;
  const state = (await deps.readState()) || {};
  const since = Number(state.cursor) ? Number(state.cursor) - OVERLAP_MS : now - FIRST_LOOKBACK_MS;
  const { orders, complete } = await deps.listOrders(since);
  const shipments = orders.map(sapoShipment).filter(Boolean);
  const summary = { fetched: orders.length, shipments: shipments.length, linked: 0, updated: 0, ambiguous: 0, unmatched: 0, landing: 0, carrierUpdated: 0, sent: 0, queued: 0, waiting: 0, failed: 0, marked: 0 };
  const changedConversations = new Set();

  if (shipments.length) {
    let attached = null;
    await deps.updateMessagingStore(store => {
      attached = attachShipmentsToConversations(store, shipments, { now });
      return null;
    }, { unchanged: () => !attached?.changes.length });
    summary.linked = attached.changes.filter(change => change.isNew).length;
    summary.updated = attached.changes.length - summary.linked;
    summary.ambiguous = attached.ambiguous;
    for (const change of attached.changes) changedConversations.add(change.conversationId);
    // Kho landing ghi cả tệp mỗi lần cập nhật: thử trên bản sao nông trước, chỉ ghi khi có đơn đổi.
    const landingPreview = attached.unmatched.length && deps.readLandingStore && deps.updateLandingStore
      ? attachShipmentsToLandingOrders({ orders: ((await deps.readLandingStore()).orders || []).map(order => ({ ...order })) }, attached.unmatched, { now })
      : 0;
    if (landingPreview) {
      await deps.updateLandingStore(store => {
        summary.landing = attachShipmentsToLandingOrders(store, attached.unmatched, { now });
        return null;
      });
    }
    summary.unmatched = attached.unmatched.length - summary.landing;
  }

  summary.carrierUpdated = await refreshCarrierStages(deps, { now, changedConversations });
  for (const conversationId of changedConversations) deps.onChanged?.(conversationId);

  let noticesFrom = Number(state.noticesFrom) || 0;
  if (deps.notify) {
    if (!noticesFrom) {
      noticesFrom = now;
      summary.marked += await markBaseline(deps, now);
    }
    await notifyCustomers(deps, { now, summary, log });
  }
  // Thẻ "Đã gửi mã vận đơn" / "Giao hàng thành công" (gắn cả khi tắt báo khách: giao thành công vẫn đúng).
  if (deps.labelIds) {
    const ids = await deps.labelIds();
    let labelChanges = [];
    await deps.updateMessagingStore(store => {
      labelChanges = applyShipmentLabels(store, { sentLabels: ids?.sent || [], deliveredLabels: ids?.delivered || [] });
      return null;
    }, { unchanged: () => !labelChanges.length });
    summary.labeled = labelChanges.length;
    if (labelChanges.length) deps.onLabelChanges?.(labelChanges);
  }
  // Chưa đọc hết (quá trần trang) vẫn tiến mốc: giữ mốc cũ thì lượt sau lại vấp đúng trần đó mãi.
  if (!complete) log(`Sapo: quá trần trang, bỏ qua một phần đơn sửa từ ${new Date(since).toISOString()}.`);
  await deps.writeState({ cursor: now, lastRunAt: now, lastSummary: summary, ...(noticesFrom ? { noticesFrom } : {}), ...(complete ? {} : { warning: 'Lượt này chưa đọc hết đơn Sapo (quá trần trang).' }) });
  return summary;
}

/** Vận đơn SPX đang đi: tra hành trình trên spx.vn để biết "đang giao cho khách" / "đã giao". */
async function refreshCarrierStages(deps, { now, changedConversations }) {
  if (!deps.trackSpx) return 0;
  const store = await deps.readMessagingStore();
  const due = conversationOrders(store).filter(({ order }) => {
    const shipment = order.shipment;
    const stage = shipmentStage(shipment);
    return shipment && /SPX/i.test(shipment.carrier || '') && ['picked_up', 'in_transit', 'out_for_delivery'].includes(stage)
      && now - (Number(shipment.carrierCheckedAt) || 0) >= CARRIER_RECHECK_MS;
  }).slice(0, MAX_CARRIER_CHECKS);
  const results = [];
  for (const { conversation, order } of due) {
    try {
      const tracking = await deps.trackSpx(order.shipment.trackingNumber);
      results.push({ conversationId: conversation.id, orderId: order.id, trackingNumber: order.shipment.trackingNumber, stage: stageFromSpxRecords(tracking?.records) });
    } catch {
      results.push({ conversationId: conversation.id, orderId: order.id, trackingNumber: order.shipment.trackingNumber, stage: '' });
    }
  }
  if (!results.length) return 0;
  let updated = 0;
  await deps.updateMessagingStore(current => {
    for (const result of results) {
      const found = findOrder(current, result.conversationId, result.orderId);
      if (found?.order.shipment?.trackingNumber !== result.trackingNumber) continue;
      if (!result.stage) { found.order.shipment.carrierCheckedAt = now; continue; }
      if (applyCarrierStage(found.order, result.stage, now)) { updated += 1; changedConversations.add(result.conversationId); }
    }
    return null;
  });
  return updated;
}

/** Lần đầu bật báo khách: vận đơn đã có từ trước hơn 24 giờ chỉ ghi dấu, không nhắn dồn. */
async function markBaseline(deps, now) {
  let marked = 0;
  await deps.updateMessagingStore(store => {
    for (const { order } of conversationOrders(store)) {
      const shipment = order.shipment;
      if (!shipment?.trackingNumber || notifiedStage(shipment)) continue;
      if (!shipment.stageAt) shipment.stageAt = Number(shipment.matchedAt) || now;
      if (now - (Number(shipment.createdAt) || now) <= BASELINE_AGE_MS) continue;
      const stage = shipmentStage(shipment);
      if (!stage) continue;
      markShipmentNotified(shipment, { stage, via: 'baseline', at: now });
      marked += 1;
    }
    return null;
  }, { unchanged: () => false });
  return marked;
}

async function readTemplatesSafe(deps) {
  try { return (await deps.readTemplates?.()) || {}; } catch { return {}; }
}

async function notifyCustomers(deps, { now, summary, log }) {
  const store = await deps.readMessagingStore();
  const quietHour = isQuietHourVN(now);
  const templates = await readTemplatesSafe(deps);
  const due = [];
  const marks = [];
  for (const { conversation, order } of conversationOrders(store)) {
    if (!order.shipment?.trackingNumber) continue;
    const plan = shipmentNoticePlan(store, conversation, order, { now, quietHour });
    // Lần tự gửi trước của đúng giai đoạn này đã lỗi: không thử lại mỗi 10 phút, để hàng chờ cho nhân viên.
    if (plan.action === 'send' && order.shipment.noticeErrorStage === plan.stage) summary.queued += 1;
    else if (plan.action === 'send') due.push({ conversation, order, plan });
    else if (plan.action === 'mark') marks.push({ conversationId: conversation.id, orderId: order.id, trackingNumber: order.shipment.trackingNumber, stage: plan.stage, via: plan.reason === 'đã gửi mã trong hội thoại' ? 'conversation' : 'stale' });
    else if (plan.action === 'queue') summary.queued += 1;
    else if (plan.action === 'wait') summary.waiting += 1;
  }
  if (marks.length) {
    await deps.updateMessagingStore(current => {
      for (const mark of marks) {
        const found = findOrder(current, mark.conversationId, mark.orderId);
        if (found?.order.shipment?.trackingNumber === mark.trackingNumber) markShipmentNotified(found.order.shipment, { stage: mark.stage, via: mark.via, at: now });
      }
      return null;
    }, { defer: true });
    summary.marked += marks.length;
  }
  // Mỗi vận đơn một tin mỗi lượt, tối đa MAX_NOTICES_PER_RUN tin.
  for (const { conversation, order, plan } of due.slice(0, MAX_NOTICES_PER_RUN)) {
    const messages = Array.isArray(store.messages?.[plan.inbox.id]) ? store.messages[plan.inbox.id] : [];
    const text = renderShipmentNotice(order.shipment, deps.genderOf ? deps.genderOf(plan.inbox, messages) : plan.inbox.gender, plan.templateId, templates);
    let mark;
    if (!text) {
      // Chủ shop để trống mẫu giai đoạn này = tắt: ghi dấu đã qua, không gửi.
      mark = { stage: plan.stage, via: 'disabled', at: now };
    } else {
      try {
        await deps.sendMessage(plan.inbox, { text, followUp: true });
        mark = { stage: plan.stage, via: 'bot', at: now };
        summary.sent += 1;
        log(`Sapo: đã báo "${shipmentStageLabel(plan.stage)}" (${order.shipment.trackingNumber}) cho ${plan.inbox.name || plan.inbox.id}`);
      } catch (error) {
        if (error?.unknownDelivery) {
          // INT-04: "không rõ đã gửi" (hết giờ chờ Pancake, gửi dở) = coi như đã báo: không vào hàng chờ có lỗi để
          // nhân viên gửi lại (khách nhận hai tin báo vận đơn).
          mark = { stage: plan.stage, via: 'bot', at: now, uncertain: true };
          summary.sent += 1;
          log(`Sapo: báo "${shipmentStageLabel(plan.stage)}" (${order.shipment.trackingNumber}) cho ${plan.inbox.name || plan.inbox.id} không rõ đã tới — coi như đã gửi: ${String(error.message || error).slice(0, 200)}`);
        } else {
          // Không thử lại ngay: ghi lỗi; vận đơn vào hàng chờ để nhân viên gửi qua Pancake.
          mark = { stage: plan.stage, via: 'bot', at: now, error: String(error.message || error) };
          summary.failed += 1;
          log(`Sapo: không báo được vận đơn ${order.shipment.trackingNumber} cho ${plan.inbox.name || plan.inbox.id}: ${mark.error.slice(0, 200)}`);
        }
      }
    }
    // Ghi dấu là việc sổ sách (tin gửi đi đã ghi ngay ở đường gửi): ghi gộp (INT-08). Lượt sau idempotent theo notifiedStage.
    await deps.updateMessagingStore(current => {
      const found = findOrder(current, conversation.id, order.id);
      if (found?.order.shipment?.trackingNumber === order.shipment.trackingNumber) markShipmentNotified(found.order.shipment, mark);
      return null;
    }, { defer: true });
  }
}

/**
 * Hàng chờ báo khách cho trang Vận chuyển: vận đơn cần báo mà máy chủ không tự gửi được (ngoài 24 giờ,
 * lần gửi trước lỗi) — kèm lời sẽ gửi. `key` = "<hội thoại>|<đơn>|<giai đoạn>".
 */
export function listShipmentNoticeQueue(store, { now = Date.now(), templates = {}, genderOf = null } = {}) {
  const items = [];
  for (const { conversation, order } of conversationOrders(store)) {
    const shipment = order.shipment;
    if (!shipment?.trackingNumber) continue;
    // Giờ nghỉ không chặn hàng chờ: nhân viên tự quyết lúc gửi.
    const plan = shipmentNoticePlan(store, conversation, order, { now, quietHour: false });
    // Trong 24 giờ máy chủ tự gửi ở lượt tới; vẫn liệt kê để nhân viên thấy và gửi ngay nếu muốn.
    if (plan.action !== 'queue' && plan.action !== 'send') continue;
    const inbox = plan.inbox;
    const messages = Array.isArray(store.messages?.[inbox.id]) ? store.messages[inbox.id] : [];
    const text = renderShipmentNotice(shipment, genderOf ? genderOf(inbox, messages) : inbox.gender, plan.templateId, templates);
    if (!text) continue;
    items.push({
      key: `${conversation.id}|${order.id}|${plan.stage}`,
      conversationId: inbox.id,
      orderConversationId: conversation.id,
      orderId: order.id,
      pageId: inbox.pageId,
      psid: inbox.psid,
      pancakeConversationId: inbox.pancakeConversationId || '',
      name: inbox.name || conversation.name || '',
      carrier: shipment.carrier,
      trackingNumber: shipment.trackingNumber,
      trackingUrl: shipment.trackingUrl || '',
      stage: plan.stage,
      stageLabel: shipmentStageLabel(plan.stage),
      stageAt: Number(shipment.stageAt) || 0,
      inWindow: plan.action === 'send',
      error: shipment.noticeErrorStage === plan.stage ? shipment.noticeError || '' : '',
      attempts: shipment.noticeErrorStage === plan.stage ? Number(shipment.noticeAttempts) || (shipment.noticeError ? 1 : 0) : 0,
      text
    });
  }
  return items.sort((first, second) => second.stageAt - first.stageAt);
}

/** Ghi kết quả gửi của một mục hàng chờ (nhân viên gửi qua cầu nối / gửi tay / bỏ qua). */
export function recordShipmentNoticeResult(store, key, { ok, via = 'pancake-bridge', error = '', now = Date.now() } = {}) {
  const [conversationId, orderId, stage] = String(key || '').split('|');
  const found = findOrder(store, conversationId, orderId);
  if (!found?.order.shipment?.trackingNumber || !stage) return false;
  markShipmentNotified(found.order.shipment, ok ? { stage, via, at: now } : { stage, via, at: now, error: error || 'gửi không thành công' });
  return true;
}

export async function readSapoState() {
  return readJsonFile(sapoStatePath, { fallback: {}, label: 'trạng thái đồng bộ Sapo' }).catch(() => ({}));
}

export function writeSapoState(value) {
  return writeJsonAtomic(sapoStatePath, value);
}

/** Cài đặt báo khách: { notifyCustomers } (mặc định bật — chủ shop 03/10); .env SAPO_NOTIFY_CUSTOMERS thắng. */
export async function readSapoSettings(config = sapoConfig) {
  const stored = await readJsonFile(sapoSettingsPath, { fallback: {}, label: 'cài đặt Sapo' }).catch(() => ({}));
  const forced = typeof config.notifyCustomers === 'boolean' ? config.notifyCustomers : null;
  return { notifyCustomers: forced ?? (stored.notifyCustomers !== false), lockedByEnv: forced !== null };
}

export async function writeSapoSettings(patch = {}) {
  const stored = await readJsonFile(sapoSettingsPath, { fallback: {}, label: 'cài đặt Sapo' }).catch(() => ({}));
  const next = { ...stored, ...(typeof patch.notifyCustomers === 'boolean' ? { notifyCustomers: patch.notifyCustomers } : {}) };
  await writeJsonAtomic(sapoSettingsPath, next);
  return next;
}

let timer = null;

/** Chạy 45 giây sau khởi động rồi mỗi 10 phút; không cấu hình Sapo thì không làm gì. */
export function startSapoSync(deps, config = sapoConfig) {
  if (timer || config.disabled || !isSapoConfigured(config)) return () => {};
  let running = false;
  const run = async () => {
    if (running) return;
    running = true;
    try {
      const settings = await readSapoSettings(config);
      const summary = await runSapoSync({
        listOrders: since => listSapoOrdersModifiedSince(since, { config, maxPages: 120 }),
        readState: readSapoState,
        writeState: writeSapoState,
        ...deps,
        notify: settings.notifyCustomers
      });
      if (summary.linked || summary.updated || summary.carrierUpdated || summary.sent || summary.failed || summary.ambiguous || summary.marked || summary.labeled) {
        (deps.log || console.log)(`Sapo: ${summary.shipments} vận đơn, ghép mới ${summary.linked}, cập nhật ${summary.updated}, hành trình hãng ${summary.carrierUpdated}, đơn landing ${summary.landing}, không chắc ${summary.ambiguous}, báo khách ${summary.sent}, gắn thẻ ${summary.labeled || 0}, hàng chờ ngoài 24h ${summary.queued}, chờ ${summary.waiting}, ghi dấu ${summary.marked}, lỗi ${summary.failed}${settings.notifyCustomers ? '' : ' (đang TẮT báo khách)'}`);
      }
    } catch (error) {
      (deps.log || console.log)(`Đồng bộ Sapo lỗi: ${error.message}`);
    } finally {
      running = false;
    }
  };
  setTimeout(run, 45 * 1000).unref?.();
  timer = setInterval(run, SAPO_SYNC_INTERVAL_MS);
  timer.unref?.();
  return () => { clearInterval(timer); timer = null; };
}
