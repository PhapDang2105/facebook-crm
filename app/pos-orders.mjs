// Đẩy đơn của CRM (bot chốt hay nhân viên tạo trong hộp thư) sang Pancake POS
// bằng `POST /shops/{SHOP_ID}/orders` (tài liệu: integrations/pancake/openapi.json).
//
// - Mỗi dòng gửi `variation_id` = SKU của CRM (POS nhận SKU làm mã mẫu mã); quà
//   có SKU trong bảng quà (bát gáo dừa, muỗng dừa) đi kèm là sản phẩm tặng.
// - Giá gửi là giá niêm yết từng dòng, giảm combo và phí ship gửi riêng
//   (`discount`, `shipping_fee`, `is_free_shipping`) nên tổng POS bằng tổng CRM.
// - Địa chỉ gửi nguyên văn: POS tự tách tỉnh/quận/phường khi không có mã.
// - `custom_id` = "CRM-<mã đơn>" để đồng bộ POS → CRM (pos-sync) không kéo đơn
//   này về thành đơn landing lần nữa, và để tra chéo hai bên.
// - `page_id` + `conversation_id` của Pancake gắn đơn vào đúng hội thoại khách.
import { posConfig, posConfigured, posRequest } from './phone-warnings.mjs';
import { readMessagingStore, updateMessagingStore } from './messaging-store.mjs';
import { publishMessagingEvent } from './message-events.mjs';
import { comboKey, findProductBySku, giftsForKey, matchProduct } from './processing/catalog.mjs';

/**
 * SKU gửi POS cho một dòng đơn. Đơn cũ còn ghi SKU đã đổi trong danh mục
 * (CB10-XANH → CB10-XANH-G35): tra sản phẩm theo tên trong danh mục hiện tại
 * và gửi SKU mới, không để POS từ chối cả đơn.
 */
export function posSkuFor(item) {
  const sku = String(item?.sku || '').trim().toUpperCase();
  if (sku && findProductBySku(sku)) return sku;
  const byName = matchProduct(String(item?.name || ''));
  return String(byName?.sku || sku || '').trim().toUpperCase();
}

/** Bản sao các dòng đơn với SKU đã đối chiếu danh mục hiện tại. */
function withCurrentSkus(products) {
  return (Array.isArray(products) ? products : []).map(item => ({ ...item, sku: posSkuFor(item) }));
}

export const POS_ORDER_CUSTOM_PREFIX = 'CRM-';
const requestTimeoutMs = 20000;
const skuCacheTtlMs = 60 * 60 * 1000;
const warehouseCacheTtlMs = 24 * 60 * 60 * 1000;

let skuCache = { at: 0, skus: new Set() };
let warehouseCache = { at: 0, id: '' };

export function posOrderPushEnabled(config = posConfig()) {
  return posConfigured(config) && process.env.POS_PUSH_ORDERS !== '0';
}

/** Mọi SKU (display_id) đang có trong POS, nhớ một giờ. */
export async function posVariationSkus(config = posConfig(), fetchImpl = fetch) {
  if (skuCache.skus.size && Date.now() - skuCache.at < skuCacheTtlMs) return skuCache.skus;
  const skus = new Set();
  for (let page = 1; page <= 20; page += 1) {
    const data = await posRequest('/products/variations', { page_size: 100, page_number: page }, config, fetchImpl);
    const list = Array.isArray(data?.data) ? data.data : [];
    for (const item of list) {
      const sku = String(item?.display_id || '').trim().toUpperCase();
      if (sku && item?.is_removed !== true) skus.add(sku);
    }
    if (list.length < 100) break;
  }
  skuCache = { at: Date.now(), skus };
  return skus;
}

/** Kho để tạo đơn: POS_WAREHOUSE_ID nếu đặt, không thì kho đầu tiên cho phép tạo đơn và có địa chỉ. */
export async function posWarehouseId(config = posConfig(), fetchImpl = fetch) {
  if (process.env.POS_WAREHOUSE_ID) return String(process.env.POS_WAREHOUSE_ID);
  if (warehouseCache.id && Date.now() - warehouseCache.at < warehouseCacheTtlMs) return warehouseCache.id;
  const data = await posRequest('/warehouses', {}, config, fetchImpl);
  const list = Array.isArray(data?.data) ? data.data : Array.isArray(data) ? data : [];
  const usable = list.filter(item => item?.id && item.allow_create_order !== false);
  const chosen = usable.find(item => item.province_id) || usable[0];
  warehouseCache = { at: Date.now(), id: chosen ? String(chosen.id) : '' };
  return warehouseCache.id;
}

function money(value) {
  return Math.max(0, Math.round(Number(value) || 0));
}

// ===== Mã tỉnh/quận/phường của POS =====
//
// POS chỉ hiện địa chỉ trên thẻ xác nhận gửi khách (và giao vận) khi có mã ba
// cấp của POS; gửi địa chỉ chữ không thì POS để trống (đã gặp: thẻ receipt ghi
// city "-"). CRM đã tách ba cấp theo tên chuẩn, nên tra mã trong danh mục địa
// lý của POS (`/geo/provinces|districts|communes`), nhớ 24 giờ.
const geoCache = { provinces: { at: 0, list: [] }, districts: new Map(), communes: new Map() };

async function posGeoRequest(pathname, params, config, fetchImpl) {
  const url = new URL(`${config.baseUrl.replace(/\/+$/, '')}${pathname}`);
  url.searchParams.set('api_key', config.apiKey);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), requestTimeoutMs);
  try {
    const response = await fetchImpl(url, { signal: controller.signal, headers: { Accept: 'application/json' } });
    if (!response.ok) throw new Error(`Pancake POS trả về HTTP ${response.status}`);
    const body = await response.json();
    return Array.isArray(body?.data) ? body.data : Array.isArray(body) ? body : [];
  } finally {
    clearTimeout(timer);
  }
}

/** "Thành phố Phan Rang – Tháp Chàm" và "Thành phố Phan Rang-Tháp Chàm" là một. */
export function geoNameKey(value) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/đ/g, 'd')
    .replace(/[–—]/g, '-')
    .replace(/\s*-\s*/g, '-')
    .replace(/[^a-z0-9-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const geoPrefixes = /^(thanh pho|tinh|quan|huyen|thi xa|thi tran|phuong|xa)\s+/;
function findGeo(list, name) {
  const key = geoNameKey(name);
  if (!key) return null;
  const exact = list.find(item => geoNameKey(item.name) === key);
  if (exact) return exact;
  const loose = key.replace(geoPrefixes, '');
  return list.find(item => geoNameKey(item.name).replace(geoPrefixes, '') === loose) || null;
}

async function geoList(kind, params, cacheEntry, config, fetchImpl) {
  if (cacheEntry.list.length && Date.now() - cacheEntry.at < warehouseCacheTtlMs) return cacheEntry.list;
  cacheEntry.list = await posGeoRequest(`/geo/${kind}`, params, config, fetchImpl);
  cacheEntry.at = Date.now();
  return cacheEntry.list;
}

/** Mã POS của tỉnh/quận/phường trên đơn (thiếu cấp nào thì bỏ cấp đó và các cấp dưới). */
export async function resolvePosGeo(order, config = posConfig(), fetchImpl = fetch) {
  const result = {};
  if (!order?.province) return result;
  const province = findGeo(await geoList('provinces', {}, geoCache.provinces, config, fetchImpl), order.province);
  if (!province) return result;
  result.provinceId = String(province.id);
  if (!order.district) return result;
  if (!geoCache.districts.has(result.provinceId)) geoCache.districts.set(result.provinceId, { at: 0, list: [] });
  const district = findGeo(await geoList('districts', { province_id: result.provinceId }, geoCache.districts.get(result.provinceId), config, fetchImpl), order.district);
  if (!district) return result;
  result.districtId = String(district.id);
  if (!order.ward) return result;
  if (!geoCache.communes.has(result.districtId)) geoCache.communes.set(result.districtId, { at: 0, list: [] });
  const commune = findGeo(await geoList('communes', { district_id: result.districtId }, geoCache.communes.get(result.districtId), config, fetchImpl), order.ward);
  if (commune) result.communeId = String(commune.id);
  return result;
}

/**
 * Body tạo đơn POS từ đơn CRM. `posSkus` (nếu có) lọc quà: quà không có mẫu mã
 * trong POS thì bỏ qua thay vì làm POS từ chối cả đơn.
 */
export function buildPosOrderPayload(order, { conversation = {}, warehouseId = '', shopId = '', posSkus = null, geo = {} } = {}) {
  const products = withCurrentSkus(order.products);
  const items = products.filter(item => item.sku).map(item => ({
    variation_id: String(item.sku).trim().toUpperCase(),
    quantity: Math.max(1, Math.round(Number(item.quantity) || 1)),
    discount_each_product: 0,
    is_bonus_product: false,
    is_discount_percent: false,
    is_wholesale: false,
    variation_info: {
      name: String(item.name || ''),
      retail_price: money(item.price),
      weight: money(item.weight)
    }
  }));
  // Quà theo tổ hợp giỏ (bảng quà trong Cài đặt), như file xuất kho.
  const basketKey = comboKey(products.map(item => ({ sku: item.sku, quantity: item.quantity })));
  for (const gift of basketKey ? giftsForKey(basketKey) : []) {
    const sku = String(gift.sku || '').trim().toUpperCase();
    if (!sku || items.some(item => item.variation_id === sku)) continue;
    if (posSkus && !posSkus.has(sku)) continue;
    items.push({
      variation_id: sku,
      quantity: 1,
      discount_each_product: 0,
      is_bonus_product: true,
      is_discount_percent: false,
      is_wholesale: false,
      variation_info: { name: String(gift.name || ''), retail_price: 0, weight: money(gift.weight) }
    });
  }
  const address = String(order.address || '').trim();
  const noteParts = [`Đơn CRM #${order.id}`, order.employee ? `tạo bởi ${order.employee}` : '', order.gift ? `Quà: ${order.gift}` : '', order.note ? `Khách ghi: ${order.note}` : ''].filter(Boolean);
  return {
    ...(shopId ? { shop_id: Number(shopId) } : {}),
    custom_id: `${POS_ORDER_CUSTOM_PREFIX}${order.id}`,
    bill_full_name: String(order.name || ''),
    bill_phone_number: String(order.phone || ''),
    shipping_address: {
      full_name: String(order.name || ''),
      phone_number: String(order.phone || ''),
      // Số nhà/đường riêng khi đã có mã ba cấp (POS ghép lại), không thì cả địa chỉ chữ để POS tự tách.
      address: geo.communeId && order.street ? String(order.street) : address,
      full_address: address,
      ...(geo.provinceId ? { province_id: geo.provinceId } : {}),
      ...(geo.districtId ? { district_id: geo.districtId } : {}),
      ...(geo.communeId ? { commune_id: geo.communeId } : {}),
      ...(order.province ? { province_name: String(order.province) } : {}),
      ...(order.district ? { district_name: String(order.district) } : {}),
      ...(order.ward ? { commnue_name: String(order.ward) } : {})
    },
    items,
    shipping_fee: money(order.shippingFee),
    is_free_shipping: Boolean(order.freeShipping) || money(order.shippingFee) === 0,
    // POS tính lại total_discount từ `discount`; chỉ gửi total_discount khiến
    // đơn tạo qua API giữ giảm giá 0 dù CRM đã tính đúng giá combo.
    discount: money(order.discount),
    note: noteParts.join(' · '),
    received_at_shop: false,
    status: 0,
    ...(warehouseId ? { warehouse_id: warehouseId } : {}),
    ...(conversation.pageId ? { page_id: String(conversation.pageId) } : {}),
    ...(conversation.pancakeConversationId ? { conversation_id: String(conversation.pancakeConversationId) } : {})
  };
}

/** Gọi POS tạo đơn. Trả về { id, systemId, status } hoặc ném lỗi có lời tiếng Việt. */
export async function pushOrderToPos(order, { conversation = {}, config = posConfig(), fetchImpl = fetch } = {}) {
  if (!posOrderPushEnabled(config)) throw new Error('Chưa kết nối Pancake POS.');
  const products = withCurrentSkus(order.products);
  if (!products.length) throw new Error('Đơn chưa có sản phẩm.');
  const posSkus = await posVariationSkus(config, fetchImpl);
  const missing = products.filter(item => !item.sku || !posSkus.has(String(item.sku).trim().toUpperCase())).map(item => item.sku || item.name);
  if (missing.length) throw new Error(`POS không có mẫu mã: ${missing.join(', ')}.`);
  const warehouseId = await posWarehouseId(config, fetchImpl).catch(() => '');
  const geo = await resolvePosGeo(order, config, fetchImpl).catch(() => ({}));
  const payload = buildPosOrderPayload(order, { conversation, warehouseId, shopId: config.shopId, posSkus, geo });
  const url = new URL(`${config.baseUrl.replace(/\/+$/, '')}/shops/${encodeURIComponent(config.shopId)}/orders`);
  url.searchParams.set('api_key', config.apiKey);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), requestTimeoutMs);
  try {
    const response = await fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal
    });
    let body = {};
    try { body = await response.json(); } catch {}
    const data = body?.data && typeof body.data === 'object' ? body.data : body;
    if (!response.ok || body?.success === false || !data?.id) {
      throw new Error(`Pancake POS không nhận đơn (${response.status}): ${body?.message || body?.error || body?.errors?.[0]?.message || 'không rõ lý do'}`);
    }
    return { id: String(data.id), systemId: data.system_id ? String(data.system_id) : '', status: String(data.status_name || '') };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Cập nhật đơn đã có trên POS (`PUT /shops/{SHOP_ID}/orders/{ORDER_ID}`) sau khi
 * nhân viên sửa đơn trong CRM: sản phẩm, địa chỉ, phí, ghi chú. Trả về mã đơn.
 */
export async function updatePosOrder(order, { conversation = {}, config = posConfig(), fetchImpl = fetch } = {}) {
  if (!posOrderPushEnabled(config)) throw new Error('Chưa kết nối Pancake POS.');
  if (!order.pos?.id) throw new Error('Đơn chưa có trên POS.');
  const posSkus = await posVariationSkus(config, fetchImpl);
  const missing = withCurrentSkus(order.products).filter(item => !item.sku || !posSkus.has(String(item.sku).trim().toUpperCase())).map(item => item.sku || item.name);
  if (missing.length) throw new Error(`POS không có mẫu mã: ${missing.join(', ')}.`);
  const geo = await resolvePosGeo(order, config, fetchImpl).catch(() => ({}));
  const { shop_id, custom_id, status, received_at_shop, warehouse_id, page_id, conversation_id, ...payload } = buildPosOrderPayload(order, { conversation, posSkus, geo });
  const url = new URL(`${config.baseUrl.replace(/\/+$/, '')}/shops/${encodeURIComponent(config.shopId)}/orders/${encodeURIComponent(order.pos.id)}`);
  url.searchParams.set('api_key', config.apiKey);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), requestTimeoutMs);
  try {
    const response = await fetchImpl(url, { method: 'PUT', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(payload), signal: controller.signal });
    let body = {};
    try { body = await response.json(); } catch {}
    if (!response.ok || body?.success === false) throw new Error(`Pancake POS không nhận sửa đơn (${response.status}): ${body?.message || body?.error || 'không rõ lý do'}`);
    return { id: String(order.pos.id) };
  } finally {
    clearTimeout(timer);
  }
}

/** Hủy đơn trên POS (status 6 = đã hủy) khi khách hủy trong CRM/bot. Trả về mã đơn hoặc ném lỗi. */
export async function cancelPosOrder(order, { config = posConfig(), fetchImpl = fetch } = {}) {
  if (!posOrderPushEnabled(config)) throw new Error('Chưa kết nối Pancake POS.');
  if (!order.pos?.id) throw new Error('Đơn chưa có trên POS.');
  const url = new URL(`${config.baseUrl.replace(/\/+$/, '')}/shops/${encodeURIComponent(config.shopId)}/orders/${encodeURIComponent(order.pos.id)}`);
  url.searchParams.set('api_key', config.apiKey);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), requestTimeoutMs);
  try {
    const response = await fetchImpl(url, { method: 'PUT', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify({ status: 6, note: `Đơn CRM #${order.id} · khách hủy` }), signal: controller.signal });
    let body = {};
    try { body = await response.json(); } catch {}
    if (!response.ok || body?.success === false) throw new Error(`Pancake POS không nhận hủy đơn (${response.status}): ${body?.message || body?.error || 'không rõ lý do'}`);
    return { id: String(order.pos.id) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Đẩy một đơn trong hội thoại sang POS rồi ghi kết quả lên đơn (`order.pos`):
 * { id, systemId, at } khi được, { error, at } khi lỗi (nhân viên bấm đẩy lại
 * trong thẻ đơn). Đã có `pos.id` thì không đẩy lần hai.
 */
// Đang đẩy dở một đơn thì lệnh đẩy thứ hai (bot chốt xong và nhân viên bấm
// "đẩy lại" cùng lúc) dùng chung kết quả, không tạo hai đơn POS cho một đơn CRM.
const inFlight = new Map();

export function syncOrderToPos(conversationId, orderId, options = {}) {
  const key = `${conversationId}|${orderId}`;
  if (inFlight.has(key)) return inFlight.get(key);
  const pending = syncOrderToPosOnce(conversationId, orderId, options).finally(() => inFlight.delete(key));
  inFlight.set(key, pending);
  return pending;
}

async function syncOrderToPosOnce(conversationId, orderId, { config = posConfig(), fetchImpl = fetch, log = console.log } = {}) {
  if (!posOrderPushEnabled(config)) return null;
  const store = await readMessagingStore();
  const conversation = store.conversations.find(item => item.id === conversationId);
  const order = (Array.isArray(conversation?.customerOrders) ? conversation.customerOrders : []).find(item => item.id === orderId);
  if (!conversation || !order) return null;
  if (order.pos?.id) return order.pos;
  let outcome;
  try {
    const created = await pushOrderToPos(order, { conversation, config, fetchImpl });
    outcome = { ...created, at: Date.now() };
    log(`Đơn ${order.id} đã đẩy sang Pancake POS #${created.id}`);
  } catch (error) {
    outcome = { error: error.message, at: Date.now() };
    log(`Đơn ${order.id} chưa đẩy được sang Pancake POS: ${error.message}`);
  }
  await updateMessagingStore(current => {
    const item = current.conversations.find(entry => entry.id === conversationId);
    const target = (Array.isArray(item?.customerOrders) ? item.customerOrders : []).find(entry => entry.id === orderId);
    if (target) target.pos = outcome;
    return null;
  });
  publishMessagingEvent({ type: 'customer-panel', conversationId });
  return outcome;
}

/** Đơn POS do CRM đẩy sang (custom_id "CRM-…"): đồng bộ POS → CRM bỏ qua. */
export function isCrmPushedPosOrder(posOrder) {
  // POS lấy custom_id làm mã đơn (id) và không trả custom_id lại: kiểm cả hai.
  return [posOrder?.custom_id, posOrder?.id].some(value => String(value || '').startsWith(POS_ORDER_CUSTOM_PREFIX));
}
