// Đẩy đơn của CRM (bot chốt hay nhân viên tạo trong hộp thư) sang Pancake POS
// bằng `POST /shops/{SHOP_ID}/orders` (tài liệu: integrations/pancake/openapi.json).
//
// - Mỗi dòng gửi `variation_id` = SKU của CRM (POS nhận SKU làm mã mẫu mã); quà
//   có SKU trong bảng quà (bát gáo dừa, muỗng dừa) đi kèm là sản phẩm tặng.
// - Giá gửi là giá niêm yết từng dòng, giảm combo và phí ship gửi riêng
//   (`total_discount`, `shipping_fee`, `is_free_shipping`) nên tổng POS bằng tổng CRM.
// - Địa chỉ gửi nguyên văn: POS tự tách tỉnh/quận/phường khi không có mã.
// - `custom_id` = "CRM-<mã đơn>" để đồng bộ POS → CRM (pos-sync) không kéo đơn
//   này về thành đơn landing lần nữa, và để tra chéo hai bên.
// - `page_id` + `conversation_id` của Pancake gắn đơn vào đúng hội thoại khách.
import { posConfig, posConfigured, posRequest } from './phone-warnings.mjs';
import { readMessagingStore, updateMessagingStore } from './messaging-store.mjs';
import { publishMessagingEvent } from './message-events.mjs';
import { comboKey, giftsForKey } from './processing/catalog.mjs';

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

/**
 * Body tạo đơn POS từ đơn CRM. `posSkus` (nếu có) lọc quà: quà không có mẫu mã
 * trong POS thì bỏ qua thay vì làm POS từ chối cả đơn.
 */
export function buildPosOrderPayload(order, { conversation = {}, warehouseId = '', shopId = '', posSkus = null } = {}) {
  const products = Array.isArray(order.products) ? order.products : [];
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
      address,
      full_address: address,
      ...(order.province ? { province_name: String(order.province) } : {}),
      ...(order.district ? { district_name: String(order.district) } : {}),
      ...(order.ward ? { commnue_name: String(order.ward) } : {})
    },
    items,
    shipping_fee: money(order.shippingFee),
    is_free_shipping: Boolean(order.freeShipping) || money(order.shippingFee) === 0,
    total_discount: money(order.discount),
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
  const products = Array.isArray(order.products) ? order.products : [];
  if (!products.length) throw new Error('Đơn chưa có sản phẩm.');
  const posSkus = await posVariationSkus(config, fetchImpl);
  const missing = products.filter(item => !item.sku || !posSkus.has(String(item.sku).trim().toUpperCase())).map(item => item.sku || item.name);
  if (missing.length) throw new Error(`POS không có mẫu mã: ${missing.join(', ')}.`);
  const warehouseId = await posWarehouseId(config, fetchImpl).catch(() => '');
  const payload = buildPosOrderPayload(order, { conversation, warehouseId, shopId: config.shopId, posSkus });
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
 * Đẩy một đơn trong hội thoại sang POS rồi ghi kết quả lên đơn (`order.pos`):
 * { id, systemId, at } khi được, { error, at } khi lỗi (nhân viên bấm đẩy lại
 * trong thẻ đơn). Đã có `pos.id` thì không đẩy lần hai.
 */
export async function syncOrderToPos(conversationId, orderId, { config = posConfig(), fetchImpl = fetch, log = console.log } = {}) {
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
  return String(posOrder?.custom_id || '').startsWith(POS_ORDER_CUSTOM_PREFIX);
}
