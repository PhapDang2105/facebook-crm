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
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { projectRoot } from './config.mjs';
import { posConfig, posConfigured, posRequest } from './phone-warnings.mjs';
import { readMessagingStore, updateMessagingStore } from './messaging-store.mjs';
import { publishMessagingEvent } from './message-events.mjs';
import { comboKey, findProductBySku, getGifts, giftsForKey, giftSwapPlan, hasLivestreamGift, matchProduct } from './processing/catalog.mjs';
import { isLivestreamOrder } from './conversation-orders.mjs';
import { addProcessingFlag, removeProcessingFlag } from './order-edits.mjs';

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

let skuCache = { at: 0, skus: new Set(), ids: new Map() };
let warehouseCache = { at: 0, id: '' };

export function posOrderPushEnabled(config = posConfig()) {
  return posConfigured(config) && process.env.POS_PUSH_ORDERS !== '0';
}

async function loadVariations(config, fetchImpl) {
  if (skuCache.skus.size && Date.now() - skuCache.at < skuCacheTtlMs) return skuCache;
  const skus = new Set();
  const ids = new Map();
  for (let page = 1; page <= 20; page += 1) {
    const data = await posRequest('/products/variations', { page_size: 100, page_number: page }, config, fetchImpl);
    const list = Array.isArray(data?.data) ? data.data : [];
    for (const item of list) {
      const sku = String(item?.display_id || '').trim().toUpperCase();
      if (!sku || item?.is_removed === true) continue;
      skus.add(sku);
      if (item.id) ids.set(sku, { id: String(item.id), productId: item.product_id ? String(item.product_id) : '', retailPrice: Math.round(Number(item.retail_price) || 0) });
    }
    if (list.length < 100) break;
  }
  skuCache = { at: Date.now(), skus, ids };
  return skuCache;
}

/** Mọi SKU (display_id) đang có trong POS, nhớ một giờ. */
export async function posVariationSkus(config = posConfig(), fetchImpl = fetch) {
  return (await loadVariations(config, fetchImpl)).skus;
}

/** Dòng đơn gửi POS: SKU chữ → mã mẫu mã nội bộ (UUID) + mã sản phẩm; SKU POS không biết thì giữ nguyên. */
export function withPosVariationIds(items, ids) {
  return (Array.isArray(items) ? items : []).map(item => {
    const known = ids?.get(String(item.variation_id).toUpperCase());
    return known ? { ...item, variation_id: known.id, ...(known.productId ? { product_id: known.productId } : {}) } : item;
  });
}

/** SKU → mã mẫu mã nội bộ của POS (UUID) và mã sản phẩm, nhớ cùng bộ đệm SKU. */
export async function posVariationIds(config = posConfig(), fetchImpl = fetch) {
  return (await loadVariations(config, fetchImpl)).ids;
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

function formatVnd(value) {
  return `${new Intl.NumberFormat('vi-VN').format(money(value))}đ`;
}

/** Phương thức thanh toán là chuyển khoản ("Chuyển khoản", "chuyen khoan", "Bank transfer"). */
export function isBankTransferPayment(value) {
  const folded = String(value || '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/gi, 'd').toLowerCase();
  return /chuyen khoan|bank|transfer/.test(folded);
}

/**
 * Số tiền khách đã trả trước bằng chuyển khoản: `order.prepaid` (đặt cọc, chuyển
 * một phần) nếu có, không thì cả tổng đơn khi phương thức là "Chuyển khoản";
 * đơn COD = 0. Không vượt tổng đơn.
 */
export function posPrepaidAmount(order = {}) {
  const total = money(order?.total);
  const explicit = money(order?.prepaid);
  if (explicit > 0) return Math.min(explicit, total);
  return isBankTransferPayment(order?.payment) ? total : 0;
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

// "TP Hồ Chí Minh" (tên CRM) ↔ "Hồ Chí Minh" / "Thành phố Hồ Chí Minh" (POS): "tp" cũng là tiền tố.
const geoPrefixes = /^(thanh pho|tp|tinh|quan|huyen|thi xa|thi tran|phuong|xa)\s+/;
export function findGeo(list, name) {
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
 * 28/09 (chủ shop): nhân viên lên đơn POS bằng MÃ COMBO (CB2-XANH-Z450, CB-VANGG+XANH, CB3-…+BGD+M…),
 * còn bot đẩy từng túi lẻ + giảm giá → báo cáo POS lệch. Bảng giỏ (comboKey) → mẫu mã combo trên POS.
 * `includesGifts`: combo đã gồm bát + muỗng dừa trong mã, không thêm dòng quà riêng.
 * Có thể ghi đè/bổ sung bằng data/processed/pos-combos.json: { "<comboKey>": { "sku": "…", "includesGifts": true } }.
 */
export const POS_COMBO_SKUS = Object.freeze({
  'GRA-XANH-Z450=2': { sku: 'CB2-XANH-Z450' },
  'GRA-VANG-H350=2': { sku: 'CB2-VANGG' },
  'GRA-NAU-Z350=2': { sku: 'CB2-NAU-Z350' },
  'GRA-MINT-Z300=2': { sku: 'CB2-MINT-Z300' },
  'GRA-VANG-H350=1|GRA-XANH-Z450=1': { sku: 'CB-VANGG+XANH' },
  'GRA-NAU-Z350=1|GRA-VANG-H350=1': { sku: 'CB-VANGG+NAU' },
  'GRA-NAU-Z350=1|GRA-XANH-Z450=1': { sku: 'CB-XANH+NAU' },
  'GRA-XANH-Z450=3': { sku: 'CB3-XANH-Z450+BGD+M', includesGifts: true },
  'GRA-VANG-H350=3': { sku: 'CB3-VANGG+BGD+M', includesGifts: true },
  'GRA-NAU-Z350=3': { sku: 'CB3-NAU-Z350+BGD+M', includesGifts: true },
  'GRA-MINT-Z300=3': { sku: 'CB3-MINT-Z300', includesGifts: true },
  'GRA-NAU-Z350=1|GRA-VANG-H350=1|GRA-XANH-Z450=1': { sku: 'CB-VANGG+XANH+NAU' },
  'NGHE-H350=2': { sku: 'CB2-NGHE-H350' },
  'NGHE-H350=3': { sku: 'CB3-NGHE-H350' }
});

const posCombosPath = process.env.POS_COMBOS_PATH || path.join(projectRoot, 'data', 'processed', 'pos-combos.json');
let posCombosCache = { at: 0, map: null };
function posComboOverrides() {
  if (posCombosCache.map && Date.now() - posCombosCache.at < 5 * 60 * 1000) return posCombosCache.map;
  let map = {};
  try {
    const raw = JSON.parse(readFileSync(posCombosPath, 'utf8'));
    for (const [key, value] of Object.entries(raw && typeof raw === 'object' ? raw : {})) {
      const sku = String(value?.sku || '').trim().toUpperCase();
      if (sku) map[String(key).trim().toUpperCase()] = { sku, includesGifts: value?.includesGifts === true };
    }
  } catch { map = {}; }
  posCombosCache = { at: Date.now(), map };
  return map;
}

/** Mẫu mã combo POS cho giỏ (nếu có và POS đang có mã đó). */
export function posComboFor(products, posSkus = null) {
  const key = comboKey((products || []).map(item => ({ sku: item.sku, quantity: item.quantity })));
  if (!key) return null;
  const entry = posComboOverrides()[key] || POS_COMBO_SKUS[key] || null;
  if (!entry) return null;
  if (posSkus && !posSkus.has(entry.sku)) return null;
  return { key, ...entry };
}

/** Ngược lại: mẫu mã combo POS ("CB3-XANH-Z450+BGD+M") → các túi trong giỏ [{ sku, quantity }], không phải combo thì null. */
export function posComboBasket(sku) {
  const wanted = String(sku || '').trim().toUpperCase();
  if (!wanted) return null;
  const entries = { ...POS_COMBO_SKUS, ...posComboOverrides() };
  const key = Object.keys(entries).find(item => entries[item]?.sku === wanted);
  if (!key) return null;
  return key.split('|').map(part => {
    const [bag, quantity] = part.split('=');
    return { sku: bag, quantity: Math.max(1, Math.round(Number(quantity) || 1)) };
  });
}

/**
 * Có đẩy giỏ bằng một dòng combo POS không, và giá của nó. Giỏ khớp combo POS →
 * một dòng combo (như nhân viên), giá hàng = tổng CRM trừ phí ship; POS niêm yết
 * cao hơn thì phần chênh thành giảm giá để COD đúng bằng CRM. Không dùng combo khi
 * tổng hàng 0 (đơn lỗi/chưa có giá) hay khi giá hàng CRM CAO HƠN giá niêm yết
 * combo POS (POS không nhận giảm giá âm → COD thiếu): quay về đẩy từng túi + giảm giá.
 */
export function posComboPlan(order, { posSkus = null, posPrices = null, products = withCurrentSkus(order?.products), warn = true } = {}) {
  const goods = Math.max(0, money(order?.total) - (order?.freeShipping || money(order?.shippingFee) === 0 ? 0 : money(order?.shippingFee)));
  const combo = posComboFor(products, posSkus);
  if (!combo || goods <= 0) return { combo: null, goods, comboRetail: 0 };
  const listed = money(posPrices?.get?.(combo.sku)?.retailPrice ?? posPrices?.get?.(combo.sku));
  if (listed && goods > listed) {
    if (warn) console.warn(`POS: đơn ${order?.id || ''} giá hàng CRM ${goods} cao hơn giá niêm yết combo ${combo.sku} trên POS (${listed}) — đẩy từng túi thay vì mã combo.`);
    return { combo: null, goods, comboRetail: 0 };
  }
  return { combo, goods, comboRetail: listed || goods };
}

/**
 * Body tạo đơn POS từ đơn CRM. `posSkus` (nếu có) lọc quà: quà không có mẫu mã
 * trong POS thì bỏ qua thay vì làm POS từ chối cả đơn. `posPrices` (Map mã → giá
 * niêm yết POS) để tính giảm giá khi đẩy dòng combo.
 */
/* ===== R13: đơn khách ĐỔI QUÀ (bát/muỗng/quạt → 2 gói granola nhỏ) =====
 * Bộ soạn đơn ghi `order.giftSwap = [{ name, sku, weight }]` (mỗi gói một mục; `sku` rỗng = khách chưa chọn vị) và
 * `order.giftSwapRemoved = [tên quà bị thay]`. Trước đây dòng quà đẩy POS dựng thẳng từ bảng quà (giftsForKey) nên
 * đơn đã đổi quà vẫn lên bát + muỗng. Đơn KHÔNG có giftSwap chạy y như cũ.
 */
/**
 * Kế hoạch dòng quà của đơn đổi quà; null khi đơn không đổi quà.
 * - `removes(gift)`: quà theo bảng quà này đã bị khách đổi (không đẩy lên POS);
 * - `lines`: dòng quà thay thế đẩy được [{ sku, name, weight, quantity }] (gộp theo SKU);
 * - `missing`: quà thay thế KHÔNG đẩy được — chưa chọn vị (không có SKU) hay POS chưa có mẫu mã đó. Không đoán mã
 *   khác: nơi gọi ghi vào ghi chú đơn POS và gắn ghi chú xử lý cho nhân viên.
 * R13 (gộp): phần tính nằm ở giftSwapPlan (processing/catalog.mjs) — dùng chung với file xuất kho (order-export.mjs).
 */
export function posGiftSwapPlan(order, posSkus = null) {
  return giftSwapPlan(order, posSkus);
}

/** Câu ghi chú xử lý cho nhân viên khi quà thay thế không đẩy được lên POS. */
export function posGiftSwapFlag(missing = []) {
  return `⚠ Đổi quà: POS chưa có ${[...new Set(missing)].join(', ')} — nhân viên thêm quà thay thế trên POS`.slice(0, 160);
}

/**
 * R13 (gộp): đặt lại ghi chú xử lý "Đổi quà: POS chưa có …" của đơn theo kết quả lần đẩy/sửa POS gần nhất — bỏ ghi chú
 * đổi quà cũ (giỏ/quà đã đổi), gắn ghi chú mới khi còn quà thay thế chưa lên được POS. Trả true nếu đơn có thay đổi.
 */
export function applyGiftSwapFlag(order, missing = []) {
  if (!order || typeof order !== 'object') return false;
  const list = (Array.isArray(missing) ? missing : []).filter(Boolean);
  const flag = list.length ? posGiftSwapFlag(list) : '';
  const removed = removeProcessingFlag(order, item => String(item).startsWith('⚠ Đổi quà: POS chưa có') && item !== flag);
  const added = flag ? addProcessingFlag(order, flag) : false;
  return removed || added;
}

/** Đơn đổi quà bỏ bát/muỗng mà mã combo POS đã GỒM bát + muỗng (…+BGD+M): không dùng mã combo đó. */
function giftSwapDropsBundledGifts(order) {
  const plan = posGiftSwapPlan(order);
  if (!plan) return false;
  return (getGifts() || []).some(gift => ['BGD', 'MUONG'].includes(String(gift?.sku || '').trim().toUpperCase()) && plan.removes(gift));
}

/** posComboPlan cho đơn thật: thêm luật đổi quà (không dùng combo gồm sẵn quà khách đã đổi → đẩy từng túi + giảm giá). */
function comboPlanForOrder(order, options) {
  const plan = posComboPlan(order, options);
  if (plan.combo?.includesGifts && giftSwapDropsBundledGifts(order)) return { ...plan, combo: null, comboRetail: 0 };
  return plan;
}

export function buildPosOrderPayload(order, { conversation = {}, warehouseId = '', shopId = '', posSkus = null, posPrices = null, geo = {} } = {}) {
  const products = withCurrentSkus(order.products);
  const { combo, goods, comboRetail } = comboPlanForOrder(order, { posSkus, posPrices, products });
  const giftSwap = posGiftSwapPlan(order, posSkus);
  const comboItems = combo ? [{
    variation_id: combo.sku,
    quantity: 1,
    discount_each_product: 0,
    is_bonus_product: false,
    is_discount_percent: false,
    is_wholesale: false,
    variation_info: {
      name: products.map(item => `${item.quantity} ${item.name || item.sku}`).join(' + '),
      retail_price: comboRetail,
      weight: money(products.reduce((sum, item) => sum + money(item.weight) * (Number(item.quantity) || 1), 0))
    }
  }] : null;
  const items = comboItems || products.filter(item => item.sku).map(item => ({
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
  // Quà theo tổ hợp giỏ (bảng quà trong Cài đặt), như file xuất kho. Quà chỉ khách
  // livestream (Quà Tặng LIVE) chỉ vào đơn khách live (order.livestream / "(Live) ").
  const basketKey = comboKey(products.map(item => ({ sku: item.sku, quantity: item.quantity })));
  const basketGifts = basketKey ? giftsForKey(basketKey, { livestream: isLivestreamOrder(order) }) : [];
  for (const gift of basketGifts) {
    const sku = String(gift.sku || '').trim().toUpperCase();
    // R13: khách đã đổi quà này (bát/muỗng/quạt → gói nhỏ): không đẩy; quà thay thế thêm ở dưới.
    if (giftSwap?.removes(gift)) continue;
    // Chỉ bỏ khi đã có DÒNG QUÀ cùng mã: túi tặng (đơn 5 Túi Vàng tặng thêm 1 Túi Vàng) trùng SKU dòng hàng vẫn phải đẩy.
    if (!sku || items.some(item => item.variation_id === sku && item.is_bonus_product)) continue;
    // Combo POS đã gồm bát + muỗng dừa trong mã (…+BGD+M): không thêm dòng quà trùng.
    if (combo?.includesGifts && ['BGD', 'MUONG'].includes(sku)) continue;
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
  // Quà ưu đãi bám đuổi (bộ bát gáo dừa cho combo 2): không nằm trong bảng quà theo giỏ, đẩy thêm một dòng quà.
  // Chỉ khi giỏ đúng 2 túi (đơn sửa sang 1/3 túi mà cờ còn sót thì bỏ) và combo POS chưa gồm bát trong mã.
  const bagCount = products.reduce((sum, item) => sum + Math.max(0, Math.round(Number(item.quantity) || 0)), 0);
  // Đơn live đúng 2 túi đã có "Quạt + Bát gáo dừa": không thêm bát ưu đãi bám đuổi (tặng hai bát).
  if (order.promoGift && bagCount === 2 && !combo?.includesGifts && !hasLivestreamGift(basketGifts)) {
    const sku = 'BGD';
    const bowl = (getGifts() || []).find(gift => String(gift.sku || '').trim().toUpperCase() === sku);
    // R13: khách đã đổi bát lấy gói nhỏ thì bát ưu đãi bám đuổi cũng không đẩy.
    const swapped = Boolean(giftSwap) && (giftSwap.removes({ name: order.promoGift, sku }) || (bowl && giftSwap.removes(bowl)));
    if (!swapped && !items.some(item => item.variation_id === sku) && (!posSkus || posSkus.has(sku))) {
      items.push({ variation_id: sku, quantity: 1, discount_each_product: 0, is_bonus_product: true, is_discount_percent: false, is_wholesale: false, variation_info: { name: String(order.promoGift), retail_price: 0, weight: money(bowl?.weight || 10) } });
    }
  }
  // R13: quà thay thế khách chọn (gói granola nhỏ) → dòng tặng riêng giá 0. Mã POS chưa có / chưa chọn vị thì KHÔNG
  // đoán mã khác: ghi rõ trong ghi chú đơn POS, nơi đẩy gắn thêm ghi chú xử lý cho nhân viên (posGiftSwapFlag).
  for (const line of giftSwap?.lines || []) {
    items.push({ variation_id: line.sku, quantity: line.quantity, discount_each_product: 0, is_bonus_product: true, is_discount_percent: false, is_wholesale: false, variation_info: { name: line.name, retail_price: 0, weight: line.weight } });
  }
  const address = String(order.address || '').trim();
  // Khách đã chuyển khoản (đủ hay đặt cọc): POS chỉ thu hộ phần còn lại.
  const prepaid = posPrepaidAmount(order);
  const codAmount = Math.max(0, money(order.total) - prepaid);
  const paymentNote = prepaid <= 0 ? '' : codAmount > 0
    ? `Đã chuyển khoản ${formatVnd(prepaid)} (đặt cọc), thu COD ${formatVnd(codAmount)}`
    : `Đã chuyển khoản ${formatVnd(prepaid)}, KHÔNG thu COD`;
  const swapNote = giftSwap?.missing.length ? `⚠ Đổi quà: chưa có mã POS cho ${[...new Set(giftSwap.missing)].join(', ')} — nhân viên thêm quà thay thế` : '';
  const noteParts = [`Đơn CRM #${order.id}`, order.employee ? `tạo bởi ${order.employee}` : '', paymentNote, order.gift ? `Quà: ${order.gift}` : '', swapNote, order.note ? `Khách ghi: ${order.note}` : '',
    // Vòng 12: ghi chú giao hàng khách ghi lẫn trong địa chỉ và cảnh báo địa chỉ bot nhận cần soát.
    order.deliveryNote ? `Giao: ${order.deliveryNote}` : '', order.addressCheck ? `⚠ ${order.addressCheck}` : ''].filter(Boolean);
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
    discount: combo ? Math.max(0, comboRetail - goods) : money(order.discount),
    // `transfer_money` (tiền khách chuyển khoản) là trường POS trừ khỏi tiền thu hộ;
    // gửi kèm `cod` = phần còn lại để đơn chuyển khoản đủ không bị thu COD lần nữa.
    ...(prepaid > 0 ? { transfer_money: prepaid, cod: codAmount } : {}),
    note: noteParts.join(' · '),
    received_at_shop: false,
    status: 0,
    ...(warehouseId ? { warehouse_id: warehouseId } : {}),
    ...(conversation.pageId ? { page_id: String(conversation.pageId) } : {}),
    ...(conversation.pancakeConversationId ? { conversation_id: String(conversation.pancakeConversationId) } : {})
  };
}

/**
 * Mẫu mã POS còn thiếu để đẩy đơn: giỏ đi bằng mã combo thì chỉ cần mã combo có
 * trên POS (posComboFor đã kiểm), không đòi từng túi lẻ; không thì mọi SKU dòng.
 */
function missingPosSkus(order, products, posSkus, posPrices) {
  if (comboPlanForOrder(order, { posSkus, posPrices, products, warn: false }).combo) return [];
  return products.filter(item => !item.sku || !posSkus.has(String(item.sku).trim().toUpperCase())).map(item => item.sku || item.name);
}

/**
 * Đơn CRM tự tạo rồi đẩy sang POS (bot chốt, nhân viên tạo trong hộp thư) — sửa
 * trong CRM thì mới PUT sang POS. Đơn nhân viên/Shop lên trên POS rồi kéo về CRM
 * (source 'POS', mã "pos…", pos.importedAt) thì POS là bản gốc: PUT từ CRM sẽ đè
 * giỏ/quà/ghi chú nhân viên trên POS.
 */
export function isCrmOwnedPosOrder(order) {
  if (!order?.pos?.id) return false;
  if (String(order.pos.id).startsWith(POS_ORDER_CUSTOM_PREFIX)) return true;
  if (String(order.source || '') === 'POS' || order.pos.importedAt) return false;
  return !/^pos/i.test(String(order.id || ''));
}

/** Gọi POS tạo đơn. Trả về { id, systemId, status } hoặc ném lỗi có lời tiếng Việt. */
export async function pushOrderToPos(order, { conversation = {}, config = posConfig(), fetchImpl = fetch } = {}) {
  if (!posOrderPushEnabled(config)) throw new Error('Chưa kết nối Pancake POS.');
  const products = withCurrentSkus(order.products);
  if (!products.length) throw new Error('Đơn chưa có sản phẩm.');
  const posSkus = await posVariationSkus(config, fetchImpl);
  const posPrices = await posVariationIds(config, fetchImpl);
  const missing = missingPosSkus(order, products, posSkus, posPrices);
  if (missing.length) throw new Error(`POS không có mẫu mã: ${missing.join(', ')}.`);
  const warehouseId = await posWarehouseId(config, fetchImpl).catch(() => '');
  const geo = await resolvePosGeo(order, config, fetchImpl).catch(() => ({}));
  const payload = buildPosOrderPayload(order, { conversation, warehouseId, shopId: config.shopId, posSkus, posPrices, geo });
  // Tạo đơn bằng SKU chữ: POS nhận dòng hàng thường nhưng BỎ ÂM THẦM dòng tặng
  // (bát gáo dừa, muỗng dừa) — mọi đơn combo 3 của bot lên POS thiếu quà. Gửi mã
  // mẫu mã nội bộ (UUID) như khi sửa đơn thì dòng tặng được giữ.
  payload.items = withPosVariationIds(payload.items, await posVariationIds(config, fetchImpl));
  const url = new URL(`${config.baseUrl.replace(/\/+$/, '')}/shops/${encodeURIComponent(config.shopId)}/orders`);
  url.searchParams.set('api_key', config.apiKey);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), requestTimeoutMs);
  try {
    let response;
    try {
      response = await fetchImpl(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(payload),
        signal: controller.signal
      });
    } catch (error) {
      // Hết giờ / đứt mạng SAU KHI đã gửi POST: POS có thể đã tạo đơn. Đánh dấu
      // "chưa chắc" để lần đẩy lại kiểm POS trước, không đẩy mù thành hai đơn.
      throw uncertainPosError(error.name === 'AbortError'
        ? `Pancake POS không phản hồi trong ${Math.round(requestTimeoutMs / 1000)} giây — đơn có thể đã lên POS, CRM sẽ kiểm trên POS trước khi đẩy lại.`
        : `Mất kết nối khi gửi đơn sang Pancake POS (${error.message}) — CRM sẽ kiểm trên POS trước khi đẩy lại.`);
    }
    let body = {};
    let bodyUnreadable = false;
    try { body = await response.json(); } catch { bodyUnreadable = true; }
    const data = body?.data && typeof body.data === 'object' ? body.data : body;
    if (response.ok && body?.success !== false && !data?.id) {
      // POS trả 2xx (đã nhận, có thể đã tạo đơn) nhưng thân phản hồi cắt dở / hết giờ lúc đọc /
      // không có mã đơn: KHÔNG coi là "POS từ chối" — lần đẩy lại phải kiểm POS trước.
      throw uncertainPosError(bodyUnreadable
        ? `Pancake POS trả ${response.status} nhưng không đọc được phản hồi — đơn có thể đã lên POS, CRM sẽ kiểm trên POS trước khi đẩy lại.`
        : `Pancake POS trả ${response.status} nhưng không có mã đơn — đơn có thể đã lên POS, CRM sẽ kiểm trên POS trước khi đẩy lại.`);
    }
    if (!response.ok || body?.success === false || !data?.id) {
      const failure = new Error(`Pancake POS không nhận đơn (${response.status}): ${body?.message || body?.error || body?.errors?.[0]?.message || 'không rõ lý do'}`);
      // Lỗi máy chủ/cổng (5xx) cũng có thể xảy ra sau khi POS đã ghi đơn.
      if (Number(response.status) >= 500) failure.uncertain = true;
      throw failure;
    }
    // R13: quà thay thế không đẩy được (POS chưa có mã / chưa chọn vị) đi kèm kết quả để nơi gọi gắn ghi chú xử lý.
    const swapMissing = posGiftSwapPlan(order, posSkus)?.missing || [];
    const created = { id: String(data.id), systemId: data.system_id ? String(data.system_id) : '', status: String(data.status_name || ''), ...(swapMissing.length ? { giftSwapMissing: [...new Set(swapMissing)] } : {}) };
    // 26/09: POS vẫn BỎ dòng tặng lúc tạo đơn (đủ UUID, is_bonus_product) — đơn combo 3 của bot lên POS không
    // có bát/muỗng dừa dù CRM ghi quà. Sửa đơn (PUT) thì POS giữ dòng tặng: đọc lại đơn vừa tạo, thiếu quà thì
    // gửi PUT cùng giỏ để bổ sung. Lỗi ở bước này không làm hỏng việc tạo đơn (chỉ ghi log).
    try {
      const added = await ensurePosGiftLines(created.id, payload, config, fetchImpl);
      if (added) console.log(`POS: bổ sung ${added} dòng quà cho đơn ${created.id} (POS bỏ dòng tặng lúc tạo).`);
    } catch (error) {
      console.warn(`POS: không bổ sung được dòng quà cho đơn ${created.id}: ${error.message}`);
    }
    return created;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Đọc đơn vừa tạo trên POS; nếu thiếu dòng tặng (is_bonus_product) có trong body thì PUT lại giỏ.
 * Trả về số dòng quà đã bổ sung (0 = đã đủ / không có quà).
 */
export async function ensurePosGiftLines(posOrderId, payload, config = posConfig(), fetchImpl = fetch) {
  const gifts = (payload.items || []).filter(item => item.is_bonus_product);
  if (!gifts.length) return 0;
  const fetched = await posRequest(`/orders/${encodeURIComponent(posOrderId)}`, {}, config, fetchImpl);
  const existing = fetched?.data && typeof fetched.data === 'object' ? fetched.data : fetched;
  const have = new Set((existing?.items || []).map(item => String(item.variation_id || item.variation_info?.id || '')));
  const missing = gifts.filter(item => !have.has(String(item.variation_id)));
  if (!missing.length) return 0;
  // Chỉ gửi giỏ + giá: gửi cả đơn (địa chỉ, ghi chú) có thể đè phần nhân viên vừa sửa trên POS và POS gửi lại phiếu.
  const update = { items: payload.items, discount: payload.discount, shipping_fee: payload.shipping_fee, is_free_shipping: payload.is_free_shipping, ...(payload.transfer_money ? { transfer_money: payload.transfer_money, cod: payload.cod } : {}) };
  const url = new URL(`${config.baseUrl.replace(/\/+$/, '')}/shops/${encodeURIComponent(config.shopId)}/orders/${encodeURIComponent(posOrderId)}`);
  url.searchParams.set('api_key', config.apiKey);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), requestTimeoutMs);
  try {
    const response = await fetchImpl(url, { method: 'PUT', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(update), signal: controller.signal });
    let body = {};
    try { body = await response.json(); } catch {}
    if (!response.ok || body?.success === false) throw new Error(`POS không nhận bổ sung quà (${response.status}): ${body?.message || body?.error || 'không rõ lý do'}`);
    return missing.length;
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
  // Cùng giá niêm yết POS như lúc tạo đơn: sửa và tạo ra cùng một công thức combo/giảm giá.
  const posPrices = await posVariationIds(config, fetchImpl);
  const missing = missingPosSkus(order, withCurrentSkus(order.products), posSkus, posPrices);
  if (missing.length) throw new Error(`POS không có mẫu mã: ${missing.join(', ')}.`);
  const geo = await resolvePosGeo(order, config, fetchImpl).catch(() => ({}));
  const { shop_id, custom_id, status, received_at_shop, warehouse_id, page_id, conversation_id, ...payload } = buildPosOrderPayload(order, { conversation, posSkus, posPrices, geo });
  // Tạo đơn thì POS nhận SKU (display_id) làm variation_id, nhưng sửa đơn thì
  // không: gửi SKU chữ khiến POS trả 400 "Server internal error" và đơn trên POS
  // giữ nguyên giỏ, phí ship cũ. Sửa đơn gửi mã mẫu mã nội bộ (UUID) của POS.
  payload.items = withPosVariationIds(payload.items, posPrices);
  const url = new URL(`${config.baseUrl.replace(/\/+$/, '')}/shops/${encodeURIComponent(config.shopId)}/orders/${encodeURIComponent(order.pos.id)}`);
  url.searchParams.set('api_key', config.apiKey);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), requestTimeoutMs);
  try {
    const response = await fetchImpl(url, { method: 'PUT', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(payload), signal: controller.signal });
    let body = {};
    try { body = await response.json(); } catch {}
    if (!response.ok || body?.success === false) throw new Error(`Pancake POS không nhận sửa đơn (${response.status}): ${body?.message || body?.error || 'không rõ lý do'}`);
    // R13 (gộp): như đường tạo đơn — quà thay thế không lên được POS (chưa có mã / chưa chọn vị) đi kèm kết quả để nơi
    // gọi gắn ghi chú xử lý (applyGiftSwapFlag). Đơn không đổi quà: kết quả y như cũ ({ id }).
    const swapMissing = posGiftSwapPlan(order, posSkus)?.missing || [];
    return { id: String(order.pos.id), ...(swapMissing.length ? { giftSwapMissing: [...new Set(swapMissing)] } : {}) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Chỉ sửa GHI CHÚ đơn trên POS (khách dặn thêm): không gửi lại giỏ/địa chỉ/phí —
 * gửi cả đơn thì đè lên những gì nhân viên đã sửa trên POS và POS gửi lại phiếu.
 */
export async function updatePosOrderNote(order, { config = posConfig(), fetchImpl = fetch } = {}) {
  if (!posOrderPushEnabled(config)) throw new Error('Chưa kết nối Pancake POS.');
  if (!order.pos?.id) throw new Error('Đơn chưa có trên POS.');
  const { note } = buildPosOrderPayload(order);
  const url = new URL(`${config.baseUrl.replace(/\/+$/, '')}/shops/${encodeURIComponent(config.shopId)}/orders/${encodeURIComponent(order.pos.id)}`);
  url.searchParams.set('api_key', config.apiKey);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), requestTimeoutMs);
  try {
    const response = await fetchImpl(url, { method: 'PUT', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify({ note }), signal: controller.signal });
    let body = {};
    try { body = await response.json(); } catch {}
    if (!response.ok || body?.success === false) throw new Error(`Pancake POS không nhận ghi chú (${response.status}): ${body?.message || body?.error || 'không rõ lý do'}`);
    return { id: String(order.pos.id) };
  } finally {
    clearTimeout(timer);
  }
}

/** Hủy đơn trên POS (status 6 = đã hủy) khi khách hủy trong CRM/bot. Trả về mã đơn hoặc ném lỗi. */
export async function cancelPosOrder(order, { config = posConfig(), fetchImpl = fetch } = {}) {
  if (!posOrderPushEnabled(config)) throw new Error('Chưa kết nối Pancake POS.');
  if (!order.pos?.id) throw new Error('Đơn chưa có trên POS.');
  // Nối lời hủy vào ghi chú đang có trên POS (ghi chú nhân viên, "Quà: …"), không ghi đè.
  // Đọc đơn POS lỗi thì ghi như cũ.
  const cancelText = `Đơn CRM #${order.id} · khách hủy`;
  let note = cancelText;
  try {
    const fetched = await posRequest(`/orders/${encodeURIComponent(order.pos.id)}`, {}, config, fetchImpl);
    const current = String((fetched?.data && typeof fetched.data === 'object' ? fetched.data : fetched)?.note || '').trim();
    if (current) note = current.includes('khách hủy') ? current : `${current} · khách hủy (CRM)`;
  } catch {}
  const url = new URL(`${config.baseUrl.replace(/\/+$/, '')}/shops/${encodeURIComponent(config.shopId)}/orders/${encodeURIComponent(order.pos.id)}`);
  url.searchParams.set('api_key', config.apiKey);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), requestTimeoutMs);
  try {
    const response = await fetchImpl(url, { method: 'PUT', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify({ status: 6, note }), signal: controller.signal });
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

/** Lỗi đẩy POS mà không biết POS đã tạo đơn hay chưa (hết giờ, đứt mạng, 5xx). */
function uncertainPosError(message) {
  const error = new Error(message);
  error.uncertain = true;
  return error;
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Đơn CRM đã có trên POS chưa (sau một lần đẩy hết giờ): tìm đơn POS theo SĐT
 * khách (POS tìm cả trong ghi chú) rồi khớp đúng mã — custom_id/mã đơn
 * "CRM-<mã>" hay ghi chú "Đơn CRM #<mã>". Bỏ qua đơn đã xóa trên POS (status 7).
 * Trả về { id, systemId, status } hoặc null; lỗi mạng thì ném.
 */
export async function findExistingPosOrder(order, config = posConfig(), fetchImpl = fetch) {
  const orderId = String(order?.id || '').trim();
  if (!orderId) return null;
  const customId = `${POS_ORDER_CUSTOM_PREFIX}${orderId}`;
  const marker = new RegExp(`Đơn CRM #${escapeRegExp(orderId)}(?![\\w-])`);
  const phone = String(order?.phone || '').replace(/\D/g, '');
  const data = await posRequest('/orders', { search: phone || `Đơn CRM #${orderId}`, page_size: 50 }, config, fetchImpl);
  const list = Array.isArray(data?.data) ? data.data : [];
  const found = list.find(item => item && Number(item.status) !== 7 && (
    String(item.custom_id || '') === customId
    || String(item.id || '') === customId
    || marker.test(String(item.note || ''))
  ));
  return found ? { id: String(found.id), systemId: found.system_id ? String(found.system_id) : '', status: String(found.status_name || '') } : null;
}

async function syncOrderToPosOnce(conversationId, orderId, { config = posConfig(), fetchImpl = fetch, log = console.log } = {}) {
  if (!posOrderPushEnabled(config)) return null;
  const store = await readMessagingStore();
  const conversation = store.conversations.find(item => item.id === conversationId);
  const order = (Array.isArray(conversation?.customerOrders) ? conversation.customerOrders : []).find(item => item.id === orderId);
  if (!conversation || !order) return null;
  if (order.pos?.id) return order.pos;
  const previouslyUncertain = Boolean(order.pos?.uncertain);
  let outcome;
  try {
    // Mọi lần ĐẨY LẠI (đã có lần trước lỗi): kiểm POS trước — có rồi thì nhận mã đó, không
    // POST lần hai. Lần trước "chưa chắc" (hết giờ, đứt mạng, 5xx, 2xx không đọc được) mà
    // không kiểm được thì KHÔNG đẩy mù — giữ lỗi để thử lại sau. Lần trước bị POS từ chối rõ
    // ràng mà không kiểm được thì đẩy như cũ (POS chưa có đơn).
    if (order.pos && (previouslyUncertain || order.pos.error)) {
      let existing = null;
      try {
        existing = await findExistingPosOrder(order, config, fetchImpl);
      } catch (error) {
        if (previouslyUncertain) throw uncertainPosError(`Chưa kiểm được đơn trên Pancake POS (${error.message}) — chưa đẩy lại để tránh tạo hai đơn, thử lại sau.`);
      }
      if (existing) {
        outcome = { ...existing, at: Date.now(), recovered: true };
        log(`Đơn ${order.id} đã có trên Pancake POS #${existing.id} (lần đẩy trước báo lỗi), không đẩy lại.`);
      }
    }
    if (!outcome) {
      const created = await pushOrderToPos(order, { conversation, config, fetchImpl });
      outcome = { ...created, at: Date.now() };
      log(`Đơn ${order.id} đã đẩy sang Pancake POS #${created.id}`);
    }
  } catch (error) {
    outcome = { error: error.message, at: Date.now(), ...(error.uncertain ? { uncertain: true } : {}) };
    if (error.uncertain) {
      // Hỏi lại POS ngay một lần: đơn đã lên (POS chậm trả lời) thì ghi mã luôn.
      const existing = await findExistingPosOrder(order, config, fetchImpl).catch(() => null);
      if (existing) outcome = { ...existing, at: Date.now(), recovered: true };
    }
    if (outcome.id) log(`Đơn ${order.id} đã có trên Pancake POS #${outcome.id} dù lần gửi báo lỗi: ${error.message}`);
    else log(`Đơn ${order.id} chưa đẩy được sang Pancake POS: ${error.message}`);
  }
  // Lần trước "chưa chắc" mà lần này vẫn chưa có mã: giữ cờ — lỗi rõ ràng của lần này (ví dụ POS
  // từ chối vì trùng mã CRM-…) không chứng minh được POS chưa có đơn của lần trước.
  if (previouslyUncertain && !outcome.id) outcome.uncertain = true;
  await updateMessagingStore(current => {
    const item = current.conversations.find(entry => entry.id === conversationId);
    const target = (Array.isArray(item?.customerOrders) ? item.customerOrders : []).find(entry => entry.id === orderId);
    // Đơn đã nhận mã POS ở đường khác trong lúc chờ: không đè mã bằng lỗi.
    if (target && !(target.pos?.id && !outcome.id)) target.pos = outcome;
    // R13: đơn đổi quà mà quà thay thế chưa lên được POS → ghi chú xử lý cho nhân viên (bảng Đơn hàng).
    if (target && outcome.giftSwapMissing?.length) addProcessingFlag(target, posGiftSwapFlag(outcome.giftSwapMissing));
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
