// Cảnh báo số điện thoại hay bom hàng (không nhận hàng).
//
// Nguồn duy nhất là Pancake POS (Cài đặt → Kênh): với mỗi số điện thoại, POS
// trả về báo cáo toàn hệ thống Pancake (`reports_by_phone`: order_fail,
// order_success và cờ `warning` do POS tự chấm), lịch sử đơn của số đó ở
// chính shop mình, và trạng thái khách (chặn, thẻ "thường xuyên hoàn"). Kết
// quả được ghim vào đơn chatbot/landing lúc tạo và bảng Đơn hàng tra lại khi
// mở, để nhân viên gọi xác nhận trước khi giao — không có gì phải nhập tay.
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
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
  return { cache: {} };
}

function normalizeStore(value) {
  if (!value || typeof value !== 'object') return emptyStore();
  return { cache: value.cache && typeof value.cache === 'object' ? value.cache : {} };
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

// ===== Pancake POS =====

export function posConfigured(config = posConfig()) {
  return Boolean(config.apiKey && config.shopId);
}

// Khoá POS: ưu tiên bản nhân viên dán trong Cài đặt → Cảnh báo SĐT (lưu ở
// data/processed/pos-config.json, quyền 600), rồi mới đến biến môi trường.
const posConfigPath = process.env.POS_CONFIG_PATH || path.join(projectRoot, 'data', 'processed', 'pos-config.json');
let savedPosConfig = null;

function loadSavedPosConfig() {
  if (savedPosConfig) return savedPosConfig;
  try {
    const parsed = JSON.parse(readFileSyncSafe(posConfigPath));
    savedPosConfig = parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    savedPosConfig = {};
  }
  return savedPosConfig;
}

function readFileSyncSafe(filePath) {
  // fs/promises is used elsewhere; the config is tiny and read on demand.
  return readFileSync(filePath, 'utf8');
}

export function posConfig() {
  const saved = loadSavedPosConfig();
  return {
    apiKey: saved.apiKey || process.env.POS_API_KEY || '',
    shopId: String(saved.shopId || process.env.POS_SHOP_ID || ''),
    shopName: saved.shopName || '',
    baseUrl: process.env.POS_API_BASE || 'https://pos.pages.fm/api/v1'
  };
}

/** Trạng thái để hiển thị: không bao giờ trả khoá đầy đủ. */
export function posStatus() {
  const config = posConfig();
  return {
    configured: posConfigured(config),
    shopId: config.shopId,
    shopName: config.shopName,
    keyHint: config.apiKey ? `${config.apiKey.slice(0, 4)}…${config.apiKey.slice(-4)}` : '',
    source: loadSavedPosConfig().apiKey ? 'settings' : (process.env.POS_API_KEY ? 'env' : '')
  };
}

/** Kiểm tra khoá bằng GET /shops, chọn shop (theo id nếu đưa, không thì shop đầu tiên) rồi lưu. */
export async function connectPos({ apiKey, shopId = '' }, { fetchImpl = fetch } = {}) {
  const key = String(apiKey || '').trim();
  if (!key) throw new Error('Chưa có khoá API.');
  const base = posConfig().baseUrl.replace(/\/+$/, '');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), requestTimeoutMs);
  let payload;
  try {
    const response = await fetchImpl(`${base}/shops?api_key=${encodeURIComponent(key)}`, { signal: controller.signal, headers: { Accept: 'application/json' } });
    payload = await response.json().catch(() => ({}));
    if (!response.ok || payload?.success === false) throw new Error(payload?.message || `Pancake POS từ chối khoá này (HTTP ${response.status}).`);
  } finally {
    clearTimeout(timer);
  }
  const shops = Array.isArray(payload?.shops) ? payload.shops : [];
  if (!shops.length) throw new Error('Khoá hợp lệ nhưng không thấy shop nào. Tạo khoá trong đúng shop cần tra.');
  const chosen = shops.find(shop => String(shop.id) === String(shopId)) || shops[0];
  savedPosConfig = { apiKey: key, shopId: String(chosen.id), shopName: String(chosen.name || ''), savedAt: Date.now() };
  await mkdir(path.dirname(posConfigPath), { recursive: true });
  await writeFile(posConfigPath, JSON.stringify(savedPosConfig, null, 2), { encoding: 'utf8', mode: 0o600 });
  return { ...posStatus(), shops: shops.map(shop => ({ id: String(shop.id), name: String(shop.name || '') })) };
}

export async function disconnectPos() {
  savedPosConfig = {};
  await mkdir(path.dirname(posConfigPath), { recursive: true });
  await writeFile(posConfigPath, '{}', { encoding: 'utf8', mode: 0o600 });
  return posStatus();
}

export async function posRequest(pathname, params, config, fetchImpl) {
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
/**
 * Địa chỉ đã lưu của một số điện thoại ở Pancake POS, mới nhất trước: địa chỉ
 * trong hồ sơ khách và địa chỉ giao của các đơn trước. Dùng để điền cho đơn
 * landing khách bỏ dở. Lỗi mạng trả về mảng rỗng.
 */
export async function fetchPosCustomerAddresses(phone, { config = posConfig(), fetchImpl = fetch } = {}) {
  if (!posConfigured(config)) return [];
  const key = normalizeWarningPhone(phone);
  try {
    const [orders, customers] = await Promise.all([
      posRequest('/orders', { search: key, page_size: 20 }, config, fetchImpl),
      posRequest('/customers', { search: key, page_size: 5 }, config, fetchImpl)
    ]);
    const fromOrders = (Array.isArray(orders?.data) ? orders.data : [])
      .filter(order => normalizeWarningPhone(order.bill_phone_number || order.shipping_address?.phone_number) === key)
      .sort((a, b) => String(b.inserted_at || '').localeCompare(String(a.inserted_at || '')))
      .map(order => String(order.shipping_address?.full_address || ''));
    const fromCustomers = (Array.isArray(customers?.data) ? customers.data : [])
      .filter(customer => (customer.phone_numbers || []).some(value => normalizeWarningPhone(value) === key))
      .flatMap(customer => (customer.shop_customer_address || []).map(address => String(address.full_address || '')));
    return [...new Set([...fromOrders, ...fromCustomers].map(value => value.trim()).filter(Boolean))];
  } catch {
    return [];
  }
}

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
 * Mức cảnh báo của một số từ dữ liệu POS. `reports_by_phone` là lịch sử toàn
 * hệ thống Pancake nên xét theo tỷ lệ; đơn hoàn ở chính shop mình thì tính
 * từng đơn; cờ `warning` do POS chấm được lấy làm chuẩn.
 * - block: POS đã chặn khách.
 * - high: POS warning ≥ 2; hệ thống bom ≥ 3 đơn và ≥ 30%; shop mình hoàn ≥ 2
 *   đơn, hoặc hoàn 1 trong ≤ 2 đơn.
 * - watch: POS warning = 1; hệ thống bom ≥ 2 đơn và ≥ 15%; shop mình hoàn 1
 *   đơn; hoặc POS gắn thẻ hoàn.
 */
export function assessPhone({ pos = null } = {}) {
  const sources = [];
  let level = 'none';
  const raise = (next, source) => {
    sources.push(source);
    if (LEVELS[next] > LEVELS[level]) level = next;
  };
  const shopFailed = Number(pos?.failed) || 0;
  const shopSuccess = Number(pos?.success) || 0;
  const report = pos?.report || null;
  const netFailed = Number(report?.fail) || 0;
  const netSuccess = Number(report?.success) || 0;
  const netTotal = netFailed + netSuccess;
  const netRate = netTotal ? netFailed / netTotal : 0;
  const percent = Math.round(netRate * 100);
  if (pos && !pos.error) {
    if (pos.customer?.isBlock) raise('block', 'POS đã chặn khách này');
    const warning = Number(report?.warning) || 0;
    if (warning >= 2) raise('high', `POS cảnh báo mức ${warning}: bom ${netFailed}/${netTotal} đơn trên hệ thống (${percent}%)`);
    else if (warning === 1) raise('watch', `POS cảnh báo: bom ${netFailed}/${netTotal} đơn trên hệ thống (${percent}%)`);
    if (netFailed >= 3 && netRate >= 0.3) raise('high', `Hệ thống Pancake: bom ${netFailed}/${netTotal} đơn (${percent}%)`);
    else if (netFailed >= 2 && netRate >= 0.15) raise('watch', `Hệ thống Pancake: bom ${netFailed}/${netTotal} đơn (${percent}%)`);
    if (shopFailed >= 2 || (shopFailed >= 1 && shopFailed + shopSuccess <= 2)) raise('high', `Shop mình: hoàn/huỷ ${shopFailed} đơn, giao thành công ${shopSuccess}`);
    else if (shopFailed === 1) raise('watch', `Shop mình: từng hoàn/huỷ 1 đơn, giao thành công ${shopSuccess}`);
    if ((pos.customer?.tags || []).some(tag => RETURN_TAG.test(foldText(tag)))) raise('watch', `POS gắn thẻ: ${pos.customer.tags.join(', ')}`);
  }
  return {
    level,
    label: LEVEL_LABELS[level],
    failed: Math.max(shopFailed, netFailed),
    success: Math.max(shopSuccess, netSuccess),
    rate: percent,
    sources,
    posChecked: Boolean(pos && !pos.error),
    posError: pos?.error || ''
  };
}

/** Cảnh báo cho một số từ POS, cache 24 giờ. */
export async function lookupPhone(phone, { force = false, fetchImpl = fetch, config = posConfig(), now = Date.now() } = {}) {
  const key = normalizeWarningPhone(phone);
  if (!key) return { phone: '', ...assessPhone() };
  const store = await readWarningStore();
  let pos = store.cache[key] || null;
  const stale = !pos || force || now - (Number(pos.fetchedAt) || 0) > cacheTtlMs || pos.error;
  if (stale && posConfigured(config)) {
    pos = await fetchPosPhoneReport(key, { config, fetchImpl });
    if (pos) {
      pos = { ...pos, fetchedAt: now };
      await updateWarningStore(current => { current.cache[key] = pos; });
    }
  }
  return { phone: key, ...assessPhone({ pos }), pos: pos && !pos.error ? { failed: pos.failed, success: pos.success, report: pos.report, isBlock: pos.customer?.isBlock || false, tags: pos.customer?.tags || [] } : null };
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
      order.phoneWarning = { level: warning.level, label: warning.label, failed: warning.failed, success: warning.success, rate: warning.rate, sources: warning.sources, checkedAt: Date.now() };
    }
  } catch {
    // Lỗi tra cứu không được chặn việc tạo đơn.
  }
  return order;
}
