// Đồng bộ mã vận đơn Sapo → đơn CRM, mỗi 10 phút; tùy chọn nhắn mã vận đơn cho khách.
//
// Mỗi lượt đọc các đơn Sapo SỬA từ mốc lần trước (lùi 10 phút cho chắc), ghép vận đơn vào đơn trong
// hội thoại và đơn landing (app/sapo-tracking.mjs), rồi xét nhắn khách. Nhắn khách chỉ chạy khi
// SAPO_NOTIFY_CUSTOMERS=1; không bật thì chỉ ghi mã + log số tin LẼ RA đã gửi để chủ shop xem trước.
// Lần chạy đầu lùi 1 ngày. Mốc lưu ở data/processed/sapo-sync.json.
import path from 'node:path';
import { projectRoot } from './config.mjs';
import { readJsonFile, writeJsonAtomic } from './json-store.mjs';
import { isSapoConfigured, listSapoOrdersModifiedSince, sapoConfig, sapoShipment } from './sapo.mjs';
import { attachShipmentsToConversations, attachShipmentsToLandingOrders, renderShipmentNotice, shipmentNoticePlan } from './sapo-tracking.mjs';

export const SAPO_SYNC_INTERVAL_MS = 10 * 60 * 1000;
// ~2.300 đơn/ngày (gần hết đơn sàn) + mỗi lần đổi trạng thái lại tính là "sửa": lùi 1 ngày ≈ 35 trang.
const FIRST_LOOKBACK_MS = 24 * 60 * 60 * 1000;
const OVERLAP_MS = 10 * 60 * 1000;
const MAX_NOTICES_PER_RUN = 30;
export const sapoStatePath = path.join(projectRoot, 'data', 'processed', 'sapo-sync.json');

const isQuietHourVN = now => { const hour = (new Date(now).getUTCHours() + 7) % 24; return hour >= 22 || hour < 7; };

/**
 * Một lượt đồng bộ. Mọi phụ thuộc truyền vào để kiểm thử được:
 * { listOrders(since), readMessagingStore, updateMessagingStore, readLandingStore, updateLandingStore,
 *   sendMessage(inbox, { text }), genderOf(conversation, messages), notify, readState, writeState, now, log }
 */
export async function runSapoSync(deps) {
  const now = deps.now ?? Date.now();
  const log = deps.log || console.log;
  const state = (await deps.readState()) || {};
  const since = Number(state.cursor) ? Number(state.cursor) - OVERLAP_MS : now - FIRST_LOOKBACK_MS;
  const { orders, complete } = await deps.listOrders(since);
  const shipments = orders.map(sapoShipment).filter(Boolean);
  const summary = { fetched: orders.length, shipments: shipments.length, linked: 0, updated: 0, ambiguous: 0, unmatched: 0, landing: 0, sent: 0, wouldSend: 0, waiting: 0, failed: 0 };

  if (shipments.length) {
    let attached = null;
    await deps.updateMessagingStore(store => {
      attached = attachShipmentsToConversations(store, shipments, { now });
      return null;
    }, { unchanged: () => !attached?.changes.length });
    summary.linked = attached.changes.filter(change => change.isNew).length;
    summary.updated = attached.changes.length - summary.linked;
    summary.ambiguous = attached.ambiguous;
    for (const conversationId of new Set(attached.changes.map(change => change.conversationId))) deps.onChanged?.(conversationId);
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

  await notifyCustomers(deps, { now, summary, log });
  // Chưa đọc hết (quá trần trang) vẫn tiến mốc: giữ mốc cũ thì lượt sau lại vấp đúng trần đó mãi.
  if (!complete) log(`Sapo: quá trần trang, bỏ qua một phần đơn sửa từ ${new Date(since).toISOString()}.`);
  await deps.writeState({ cursor: now, lastRunAt: now, lastSummary: summary, ...(complete ? {} : { warning: 'Lượt này chưa đọc hết đơn Sapo (quá trần trang).' }) });
  return summary;
}

async function notifyCustomers(deps, { now, summary, log }) {
  const store = await deps.readMessagingStore();
  const quietHour = isQuietHourVN(now);
  const due = [];
  for (const conversation of store.conversations || []) {
    for (const order of Array.isArray(conversation.customerOrders) ? conversation.customerOrders : []) {
      if (!order.shipment?.trackingNumber || order.shipment.noticeAt) continue;
      const plan = shipmentNoticePlan(store, conversation, order, { now, quietHour });
      if (plan.action === 'send') due.push({ conversation, order, inbox: plan.inbox });
      else if (plan.action === 'wait') summary.waiting += 1;
    }
  }
  if (!due.length) return;
  if (!deps.notify) {
    summary.wouldSend = due.length;
    return;
  }
  // Một khách nhiều đơn cùng lúc: mỗi mã vận đơn một tin, tối đa MAX_NOTICES_PER_RUN tin mỗi lượt.
  for (const { conversation, order, inbox } of due.slice(0, MAX_NOTICES_PER_RUN)) {
    const messages = Array.isArray(store.messages?.[inbox.id]) ? store.messages[inbox.id] : [];
    const text = renderShipmentNotice(order.shipment, deps.genderOf ? deps.genderOf(inbox, messages) : inbox.gender);
    let mark;
    try {
      await deps.sendMessage(inbox, { text, followUp: true });
      mark = { noticeAt: now, noticeVia: 'bot' };
      summary.sent += 1;
      log(`Sapo: đã nhắn mã vận đơn ${order.shipment.trackingNumber} cho ${inbox.name || inbox.id}`);
    } catch (error) {
      // Không thử lại vô hạn: ghi lỗi, nhân viên thấy ở ghi chú đơn và gửi tay.
      mark = { noticeAt: now, noticeVia: 'failed', noticeError: String(error.message || error).slice(0, 200) };
      summary.failed += 1;
      log(`Sapo: không nhắn được mã vận đơn cho ${inbox.name || inbox.id}: ${mark.noticeError}`);
    }
    await deps.updateMessagingStore(current => {
      const target = (current.conversations || []).find(item => item.id === conversation.id);
      const saved = target?.customerOrders?.find(item => item.id === order.id);
      if (saved?.shipment?.trackingNumber === order.shipment.trackingNumber) Object.assign(saved.shipment, mark);
      return null;
    });
  }
}

export async function readSapoState() {
  return readJsonFile(sapoStatePath, { fallback: {}, label: 'trạng thái đồng bộ Sapo' }).catch(() => ({}));
}

export function writeSapoState(value) {
  return writeJsonAtomic(sapoStatePath, value);
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
      const summary = await runSapoSync({
        listOrders: since => listSapoOrdersModifiedSince(since, { config, maxPages: 120 }),
        readState: readSapoState,
        writeState: writeSapoState,
        ...deps,
        notify: config.notifyCustomers
      });
      if (summary.linked || summary.updated || summary.sent || summary.failed || summary.wouldSend || summary.ambiguous) {
        (deps.log || console.log)(`Sapo: ${summary.shipments} vận đơn, ghép mới ${summary.linked}, cập nhật ${summary.updated}, đơn landing ${summary.landing}, không chắc ${summary.ambiguous}, nhắn khách ${summary.sent}${summary.wouldSend ? `, lẽ ra nhắn ${summary.wouldSend} (chưa bật SAPO_NOTIFY_CUSTOMERS)` : ''}, chờ ${summary.waiting}, lỗi ${summary.failed}`);
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
