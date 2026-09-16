// Cảnh báo số điện thoại hay bom hàng (không nhận hàng).
//
// Ba nguồn gộp thành một mức cảnh báo cho mỗi số:
//   1. Pancake POS (khi có POS_API_KEY + POS_SHOP_ID): lịch sử đơn của số đó ở
//      shop — đơn hoàn/huỷ so với đơn giao thành công — và báo cáo theo số
//      điện thoại mà POS tự tính (`reports_by_phone`: order_fail,
//      order_success, warning), khách bị chặn (`is_block`) hay gắn thẻ hoàn.
//   2. Danh sách nhân viên tự đánh dấu trong Cài đặt → Cảnh báo SĐT (kèm lý do).
//   3. Đơn ghi nhận ngay trong CRM (bom / hoàn) qua cùng danh sách đó.
// Kết quả được ghim vào đơn chatbot và đơn landing lúc tạo, và bảng Đơn hàng
// tra lại mỗi lần mở để nhân viên gọi xác nhận trước khi giao.
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { projectRoot } from './config.mjs';
import { toLocalPhone } from './processing/customer-info.mjs';

const warningsPath = process.env.PHONE_WARNINGS_PATH
  || path.join(projectRoot, 'data', 'processed', 'phone-warnings.json');

export const LEVELS = Object.freeze({ block: 3, high: 2, watch: 1, none: 0 });
const LEVEL_LABELS = Object.freeze({
  block: 'Chặn: không giao, gọi xác nhận',
  high: 'Hay bom hàng, gọi xác nhận trước khi giao',
  watch: 'Từng không nhận hàng, nên gọi xác nhận',
  none: ''
});

// Mã trạng thái đơn của Pancake POS (Open API, filter_status).
export const POS_STATUS = Object.freeze({
  new: 0, confirmed: 1, sent: 2, received: 3, returning: 4, returned: 5, canceled: 6, removed: 7,
  packing: 8, waitingShipping: 9, waitingGoods: 11, waitingPrint: 12, printed: 13, partiallyReturned: 15,
  collected: 16, waitingConfirm: 17, ordered: 20
});
const FAILED_STATUSES = new Set([POS_STATUS.returning, POS_STATUS.returned, POS_STATUS.canceled, POS_STATUS.partiallyReturned]);
const SUCCESS_STATUSES = new Set([POS_STATUS.received, POS_STATUS.collected]);
const RETURN_TAG = /(hoan|bom|khong nhan|tra hang|boom)/;

const cacheTtlMs = 24 * 60 * 60 * 1000;
const requestTimeoutMs = 6000;

let cachedStore = null;
let writeQueue = Promise.resolve();

function emptyStore() {
  return { manual: {}, cache: {} };
}

function normalizeStore(value) {
  if (!value || typeof value !== 'object') return emptyStore();
  return {
    manual: value.manual && typeof value.manual === 'object' ? value.manual : {},
    cache: value.cache && typeof value.cache === 'object' ? value.cache : {}
  };
}

export async function readWarningStore() {
  if (cachedStore) return cachedStore;
  try {
    cachedStore = normalizeStore(JSON.parse(await readFile(warningsPath, 'utf8')));
  } catch {
    cachedStore = emptyStore();
  }
  return cachedStore;
}

export function updateWarningStore(mutate) {
  const operation = writeQueue.then(async () => {
    const store = await readWarningStore();
    const result = await mutate(store);
    await mkdir(path.dirname(warningsPath), { recursive: true });
    const temporaryPath = `${warningsPath}.tmp`;
    await writeFile(temporaryPath, JSON.stringify(store, null, 2), 'utf8');
    await rename(temporaryPath, warningsPath);
    return result;
  });
  writeQueue = operation.then(() => undefined, () => undefined);
  return operation;
}

export function resetWarningStoreCache() {
  cachedStore = null;
}

export function normalizeWarningPhone(value) {
  return toLocalPhone(value) || String(value ?? '').replace(/\D/g, '');
}

function foldText(value) {
  return String(value ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd');
}

// ===== Danh sách thủ công =====

export async function listManualWarnings() {
  const store = await readWarningStore();
  return Object.values(store.manual).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}

/** Thêm hoặc sửa một số: level 'block' | 'high' | 'watch'; lý do tự do. */
export async function setManualWarning({ phone, level = 'high', reason = '', by = '' }, now = Date.now()) {
  const key = normalizeWarningPhone(phone);
  if (!key || key.length < 9) throw new Error('Số điện thoại không hợp lệ.');
  const chosen = Object.hasOwn(LEVELS, level) && level !== 'none' ? level : 'high';
  return updateWarningStore(store => {
    const previous = store.manual[key] || {};
    store.manual[key] = {
      phone: key,
      level: chosen,
      reason: String(reason || '').trim().slice(0, 300),
      by: String(by || '').trim().slice(0, 80),
      createdAt: previous.createdAt || now,
      updatedAt: now,
      // Số lần nhân viên ghi nhận bom: mỗi lần lưu lại với lý do là một lần.
      incidents: (Number(previous.incidents) || 0) + 1
    };
    return store.manual[key];
  });
}

export async function removeManualWarning(phone) {
  const key = normalizeWarningPhone(phone);
  return updateWarningStore(store => {
    const removed = store.manual[key] || null;
    delete store.manual[key];
    return removed;
  });
}

// ===== Pancake POS =====

export function posConfigured(config = posConfig()) {
  return Boolean(config.apiKey && config.shopId);
}

export function posConfig() {
  return { apiKey: process.env.POS_API_KEY || '', shopId: process.env.POS_SHOP_ID || '', baseUrl: process.env.POS_API_BASE || 'https://pos.pages.fm/api/v1' };
}

async function posRequest(pathname, params, config, fetchImpl) {
  const url = new URL(`${config.baseUrl.replace(/\/+$/, '')}/shops/${encodeURIComponent(config.shopId)}${pathname}`);
  url.searchParams.set('api_key', config.apiKey);
  for (const [key, value] of Object.entries(params)) {
    if (Array.isArray(value)) value.forEach(item => url.searchParams.append(`${key}[]`, String(item)));
    else url.searchParams.set(key, String(value));
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), requestTimeoutMs);
  try {
    const response = await fetchImpl(url, { signal: controller.signal, headers: { Accept: 'application/json' } });
    if (!response.ok) throw new Error(`Pancake POS trả về HTTP ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Đọc lịch sử một số điện thoại ở Pancake POS: đếm đơn hoàn/huỷ và đơn giao
 * thành công của shop, lấy báo cáo theo số (`reports_by_phone`) do POS tính,
 * và trạng thái khách (chặn, thẻ). Lỗi mạng trả về null để không chặn việc lên đơn.
 */
export async function fetchPosPhoneReport(phone, { config = posConfig(), fetchImpl = fetch } = {}) {
  if (!posConfigured(config)) return null;
  const key = normalizeWarningPhone(phone);
  try {
    const [orders, customers] = await Promise.all([
      posRequest('/orders', { search: key, page_size: 100, extra_fields: ['return_rate'] }, config, fetchImpl),
      posRequest('/customers', { search: key, page_size: 5 }, config, fetchImpl)
    ]);
    const rows = (Array.isArray(orders?.data) ? orders.data : [])
      .filter(order => [order.bill_phone_number, order.shipping_address?.phone_number].some(value => normalizeWarningPhone(value) === key));
    const failed = rows.filter(order => FAILED_STATUSES.has(Number(order.status)) || order.partner?.first_undeliverable_at).length;
    const success = rows.filter(order => SUCCESS_STATUSES.has(Number(order.status))).length;
    // Báo cáo theo số điện thoại mà POS đính kèm đơn: order_fail/order_success/warning.
    let report = null;
    for (const order of rows) {
      const entry = order.reports_by_phone && Object.entries(order.reports_by_phone).find(([reportPhone]) => normalizeWarningPhone(reportPhone) === key);
      if (entry) { report = entry[1]; break; }
    }
    const customer = (Array.isArray(customers?.data) ? customers.data : [])
      .find(item => (item.phone_numbers || []).some(value => normalizeWarningPhone(value) === key)) || null;
    return {
      fetchedAt: Date.now(),
      orders: rows.length,
      failed,
      success,
      report: report ? { fail: Number(report.order_fail) || 0, success: Number(report.order_success) || 0, warning: Number(report.warning) || 0 } : null,
      customer: customer ? {
        id: customer.id,
        isBlock: Boolean(customer.is_block),
        tags: (Array.isArray(customer.tags) ? customer.tags : []).map(tag => String(tag?.name ?? tag)),
        orderCount: Number(customer.order_count) || 0,
        succeedOrderCount: Number(customer.succeed_order_count) || 0
      } : null
    };
  } catch (error) {
    return { fetchedAt: Date.now(), error: error.message };
  }
}

// ===== Gộp thành mức cảnh báo =====

/**
 * Mức cảnh báo từ mọi nguồn của một số. Quy tắc:
 * - Chặn ở POS hoặc nhân viên đánh dấu "chặn" → block.
 * - Từ 2 đơn bom/hoàn, hoặc tỷ lệ hoàn ≥ 50% khi có ≥ 2 đơn, hoặc POS cảnh báo → high.
 * - 1 đơn bom/hoàn, hoặc thẻ "hoàn" ở POS → watch.
 */
export function assessPhone({ manual = null, pos = null } = {}) {
  const sources = [];
  let level = 'none';
  const raise = (next, source) => {
    sources.push(source);
    if (LEVELS[next] > LEVELS[level]) level = next;
  };
  let failed = 0;
  let success = 0;
  if (manual) {
    failed += Number(manual.incidents) || 1;
    raise(manual.level || 'high', `Nhân viên đánh dấu${manual.reason ? `: ${manual.reason}` : ''}`);
  }
  if (pos && !pos.error) {
    const posFailed = Math.max(pos.failed || 0, pos.report?.fail || 0);
    const posSuccess = Math.max(pos.success || 0, pos.report?.success || 0, pos.customer?.succeedOrderCount || 0);
    failed += posFailed;
    success += posSuccess;
    if (pos.customer?.isBlock) raise('block', 'POS đã chặn khách này');
    if (pos.report?.warning > 0) raise('high', `POS cảnh báo: bom ${pos.report.fail}/${pos.report.fail + pos.report.success} đơn`);
    if (posFailed >= 2 || (posFailed >= 1 && posFailed + posSuccess >= 2 && posFailed / (posFailed + posSuccess) >= 0.5)) {
      raise('high', `POS: hoàn/huỷ ${posFailed} đơn, giao thành công ${posSuccess}`);
    } else if (posFailed === 1) {
      raise('watch', `POS: từng hoàn/huỷ 1 đơn, giao thành công ${posSuccess}`);
    }
    if ((pos.customer?.tags || []).some(tag => RETURN_TAG.test(foldText(tag)))) raise('watch', `POS gắn thẻ: ${pos.customer.tags.join(', ')}`);
  }
  if (manual && (Number(manual.incidents) || 1) >= 2 && LEVELS[level] < LEVELS.high) level = 'high';
  return {
    level,
    label: LEVEL_LABELS[level],
    failed,
    success,
    sources,
    posChecked: Boolean(pos && !pos.error),
    posError: pos?.error || ''
  };
}

/** Cảnh báo cho một số: danh sách thủ công + POS (có cache 24 giờ). */
export async function lookupPhone(phone, { force = false, fetchImpl = fetch, config = posConfig(), now = Date.now() } = {}) {
  const key = normalizeWarningPhone(phone);
  if (!key) return { phone: '', ...assessPhone() };
  const store = await readWarningStore();
  const manual = store.manual[key] || null;
  let pos = store.cache[key] || null;
  const stale = !pos || force || now - (Number(pos.fetchedAt) || 0) > cacheTtlMs || pos.error;
  if (stale && posConfigured(config)) {
    pos = await fetchPosPhoneReport(key, { config, fetchImpl });
    if (pos) {
      pos = { ...pos, fetchedAt: now };
      await updateWarningStore(current => { current.cache[key] = pos; });
    }
  }
  return { phone: key, ...assessPhone({ manual, pos }), pos: pos && !pos.error ? { failed: pos.failed, success: pos.success, report: pos.report, isBlock: pos.customer?.isBlock || false, tags: pos.customer?.tags || [] } : null };
}

/** Tra nhiều số một lượt, tối đa 5 yêu cầu POS song song. */
export async function lookupPhones(phones, options = {}) {
  const unique = [...new Set((Array.isArray(phones) ? phones : []).map(normalizeWarningPhone).filter(Boolean))].slice(0, 500);
  const results = {};
  let index = 0;
  const worker = async () => {
    while (index < unique.length) {
      const phone = unique[index++];
      results[phone] = await lookupPhone(phone, options);
    }
  };
  await Promise.all(Array.from({ length: Math.min(5, unique.length) }, worker));
  return results;
}

/** Gắn cảnh báo vào một đơn vừa tạo (chatbot/landing); không bao giờ ném lỗi. */
export async function attachPhoneWarning(order, options = {}) {
  try {
    const warning = await lookupPhone(order?.phone, options);
    if (warning.level !== 'none') {
      order.phoneWarning = { level: warning.level, label: warning.label, failed: warning.failed, success: warning.success, sources: warning.sources, checkedAt: Date.now() };
    }
  } catch {
    // Lỗi tra cứu không được chặn việc tạo đơn.
  }
  return order;
}
