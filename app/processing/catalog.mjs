import { readFileSync } from 'node:fs';
import path from 'node:path';
import { projectRoot } from '../config.mjs';

// The catalogue IS the configuration. A product carries its single price, its
// combo price, its warehouse SKU, whether it may be bought together with other
// mixable products, and the words customers use for it. Gifts are ticked per
// basket combination (see listCombos). Pricing, detection, the model prompt
// and the warehouse export all derive from here, so adding a product in
// Cài đặt → Sản phẩm is the whole job.
const productsPath = process.env.PRODUCTS_PATH
  || path.join(projectRoot, 'data', 'processed', 'products.json');
const giftsPath = process.env.GIFTS_PATH
  || path.join(projectRoot, 'data', 'processed', 'gifts.json');

let productCache = null;
let giftCache = null;

export function normalizeText(value) {
  return String(value ?? '')
    .replace(/\\n/g, '\n')
    .replace(/\r/g, '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/đ/g, 'd')
    .replace(/\s+/g, ' ')
    .trim();
}

function money(value) {
  return Math.max(0, Math.round(Number(value) || 0));
}

export function normalizeSkuText(value) {
  return String(value ?? '').trim().toUpperCase().replace(/\s+/g, '_');
}

export function normalizeAliases(value) {
  const list = Array.isArray(value) ? value : String(value ?? '').split(/[\n,;]+/);
  const seen = new Set();
  const aliases = [];
  for (const item of list) {
    const alias = String(item ?? '').trim().replace(/\s+/g, ' ');
    const key = normalizeText(alias);
    if (!alias || !key || seen.has(key)) continue;
    seen.add(key);
    aliases.push(alias);
  }
  return aliases.slice(0, 40);
}

function normalizeCatalogProduct(item) {
  const sku = normalizeSkuText(item?.sku);
  const name = String(item?.name ?? '').trim();
  if (!sku || !name) return null;
  return {
    id: String(item?.id ?? ''),
    sku,
    name,
    unitPrice: money(item?.salePrice),
    comboPrice: money(item?.comboPrice),
    weight: money(item?.weight),
    unit: String(item?.unit ?? '').trim(),
    // The picture uploaded in Cài đặt → Sản phẩm: sent with the price quote and shown on the receipt.
    image: String(item?.image ?? '').trim(),
    // Thư viện ảnh gửi khách (Cài đặt → Sản phẩm): bot gửi ngẫu nhiên 2–3 ảnh mỗi lần tư vấn.
    images: Array.isArray(item?.images) ? item.images.map(value => String(value || '').trim()).filter(Boolean) : [],
    aliases: normalizeAliases(item?.aliases),
    // Mixable products (the granola bags) may share one order in any mix of up
    // to maxComboQuantity units; every other product is sold on its own.
    mixable: item?.mixable === true,
    // Nhóm ghép giỏ (01/10, chủ shop): mọi sản phẩm cùng nhóm ở chung một đơn, từ
    // 2 đơn vị mỗi món tính giá combo của nó (Tropical + Vàng = 174k + 149k; 2 Vàng
    // + 1 combo 10 gói Cam = 298k + 179k). Khác `mixable` (3 túi chủ lực trong bảng
    // mix/giảm giá): Tropical và combo 10 gói ghép đơn được mà không vào bảng đó.
    // Dữ liệu cũ không có trường: sản phẩm `mixable` thuộc nhóm "granola".
    mixGroup: normalizeText(item?.mixGroup).replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || (item?.mixable === true ? 'granola' : ''),
    // Chỉ nhân viên CSKH bán (01/10: Granola Siêu Hạt Premium, hàng dạng hũ/hạt):
    // vẫn tra được theo SKU/tên cho đơn nhân viên, nhưng bot không báo giá/chốt.
    staffOnly: item?.staffOnly === true,
    active: item?.active !== false
  };
}

export function getCatalogProducts() {
  if (!productCache) {
    try {
      const parsed = JSON.parse(readFileSync(productsPath, 'utf8'));
      const items = Array.isArray(parsed?.items) ? parsed.items : [];
      productCache = items.map(normalizeCatalogProduct).filter(Boolean);
    } catch {
      productCache = [];
    }
  }
  return productCache;
}

export function normalizeGift(item) {
  const name = String(item?.name ?? '').trim().replace(/\s+/g, ' ');
  if (!name) return null;
  return {
    id: String(item?.id ?? '').trim() || normalizeText(name).replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''),
    name: name.slice(0, 200),
    active: item?.active !== false,
    // The rule: earned once the order holds at least this many units of
    // anything, unless one of the excluded products is in the basket.
    minQuantity: Math.max(1, Math.round(Number(item?.minQuantity) || 1)),
    // Tối đa (túi): 0 = không giới hạn (dữ liệu cũ không có trường này). Quà Tặng
    // LIVE chỉ tặng đơn ĐÚNG 2 túi (min 2, max 2); đơn 3 túi nhận bát + muỗng.
    maxQuantity: Math.max(0, Math.round(Number(item?.maxQuantity) || 0)),
    excludedSkus: [...new Set((Array.isArray(item?.excludedSkus) ? item.excludedSkus : []).map(normalizeSkuText).filter(Boolean))].slice(0, 100),
    // Chỉ khách livestream: quà nhân viên thêm cho khách xem live (Quà Tặng LIVE),
    // không áp cho mọi đơn 2 túi. Dữ liệu cũ không có trường này = false.
    livestreamOnly: item?.livestreamOnly === true,
    // Warehouse SKU and weight so the export can list the gift as a shipped line.
    sku: normalizeSkuText(item?.sku).slice(0, 80),
    weight: money(item?.weight)
  };
}

export function normalizeGiftStore(value) {
  const list = Array.isArray(value) ? value : Array.isArray(value?.items) ? value.items : [];
  const seen = new Set();
  const items = [];
  for (const item of list) {
    const gift = normalizeGift(item);
    if (!gift || seen.has(gift.id)) continue;
    seen.add(gift.id);
    items.push(gift);
  }
  return {
    items,
    // Quà thay thế (GIFT_SWAP): khách không lấy bát/quạt → 2 gói granola nhỏ.
    swap: normalizeGiftSwap(value?.swap),
    // Charged on orders that have not earned free shipping. The business
    // quotes "174.000đ + ship 15.000đ" for one bag; 189.000đ is what the
    // customer pays and what the warehouse file must show.
    shippingFee: Math.max(0, Math.round(Number(value?.shippingFee ?? defaultShippingFee) || 0)),
    updatedAt: Number(value?.updatedAt) || 0
  };
}

/** Canonical basket key: "SKU=qty|SKU=qty" sorted by SKU, quantities merged. */
export function comboKey(items = []) {
  const counts = new Map();
  for (const item of Array.isArray(items) ? items : []) {
    const sku = normalizeSkuText(item?.sku);
    const quantity = Math.round(Number(item?.quantity) || 0);
    if (!sku || quantity < 1) continue;
    counts.set(sku, (counts.get(sku) || 0) + quantity);
  }
  return [...counts.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([sku, quantity]) => `${sku}=${quantity}`).join('|');
}

/** The largest basket the bot closes on its own; bigger ones are wholesale, handled by a person. */
export const maxComboQuantity = 3;

/**
 * Giỏ lớn nhất bot tự tính giá và chốt (01/10, chủ shop: 4, 5, 6, 9, 10 túi đều
 * tính theo giá combo từng túi). Vượt mức này là đơn sỉ, nhân viên lo.
 */
export const maxBasketQuantity = 20;

/** Nhóm ghép giỏ của sản phẩm ('' = chỉ bán riêng). */
export function mixGroupOf(product) {
  return product ? String(product.mixGroup || (product.mixable ? 'granola' : '')) : '';
}

/**
 * Các sản phẩm có ở chung một giỏ được không: một sản phẩm luôn được; từ hai
 * sản phẩm khác nhau thì tất cả phải cùng một nhóm ghép (mixGroup) khác rỗng.
 */
export function canShareBasket(products = []) {
  const list = (Array.isArray(products) ? products : []).filter(Boolean);
  const skus = new Set(list.map(product => product.sku));
  if (skus.size <= 1) return true;
  const groups = new Set(list.map(mixGroupOf));
  return groups.size === 1 && !groups.has('');
}

/**
 * Every basket combination the business sells: each non-mixable product on
 * its own at 1..max units, and every multiset of 1..max units drawn from the
 * mixable products. This is the row list of the gift table and the whole set
 * of baskets the chatbot may price — the old 34-line table, generated.
 */
export function listCombos() {
  const products = getCatalogProducts().filter(product => product.active);
  const combos = [];
  const push = items => {
    const key = comboKey(items);
    combos.push({
      key,
      items: items.map(item => ({ sku: item.sku, quantity: item.quantity, name: findProductBySku(item.sku)?.name || item.sku })),
      totalQuantity: items.reduce((sum, item) => sum + item.quantity, 0)
    });
  };
  for (const product of products.filter(product => !product.mixable)) {
    for (let quantity = 1; quantity <= maxComboQuantity; quantity += 1) push([{ sku: product.sku, quantity }]);
  }
  const mixable = products.filter(product => product.mixable).map(product => product.sku).sort((a, b) => a.localeCompare(b));
  const walk = (start, remaining, picked) => {
    if (picked.length) push(picked);
    if (remaining === 0) return;
    for (let index = start; index < mixable.length; index += 1) {
      const sku = mixable[index];
      const existing = picked.find(item => item.sku === sku);
      const next = existing
        ? picked.map(item => item.sku === sku ? { ...item, quantity: item.quantity + 1 } : item)
        : [...picked, { sku, quantity: 1 }];
      walk(index, remaining - 1, next);
    }
  };
  walk(0, maxComboQuantity, []);
  const seen = new Set();
  return combos
    .filter(combo => combo.key && !seen.has(combo.key) && seen.add(combo.key))
    .sort((a, b) => a.totalQuantity - b.totalQuantity || a.key.localeCompare(b.key));
}

/** The lines of a basket key: [{ sku, quantity }]. */
export function parseComboKey(key) {
  return String(key ?? '').split('|').map(part => {
    const [sku, quantity] = part.split('=');
    return { sku: normalizeSkuText(sku), quantity: Math.round(Number(quantity) || 0) };
  }).filter(item => item.sku && item.quantity > 0);
}

/**
 * Active gifts a basket earns under the rules in Cài đặt → Quà tặng: enough
 * units in total (and not more than maxQuantity when one is set), and none of
 * the gift's excluded products in the basket. Quà "chỉ khách livestream"
 * (livestreamOnly) chỉ trả khi gọi với { livestream: true } — khách đến từ
 * phiên live (isLivestreamCustomer); gọi một tham số như cũ = khách thường.
 */
export function giftsForKey(key, { livestream = false } = {}) {
  const lines = parseComboKey(key);
  if (!lines.length) return [];
  const total = lines.reduce((sum, line) => sum + line.quantity, 0);
  const earned = readGiftStoreSync().items.filter(gift => gift.active
    && (!gift.livestreamOnly || livestream === true)
    && total >= gift.minQuantity
    // maxQuantity > 0 là "tặng tới N túi": tổng túi vượt N thì không tặng nữa.
    && (!gift.maxQuantity || total <= gift.maxQuantity)
    && !lines.some(line => gift.excludedSkus.includes(line.sku)));
  return applyLiveGiftPolicy(earned, total);
}

/**
 * 01/10 (chủ shop): quà live và quà khuyến mãi KHÔNG cộng dồn (đơn từng bị tặng
 * hai bát: "Quạt + Bát gáo dừa" của live và bộ bát + muỗng). Đơn khách live đúng
 * 2 túi chỉ nhận quà live (bỏ quà hiện vật khác, giữ miễn ship); từ 3 túi chỉ nhận
 * quà khuyến mãi thường (bát + muỗng), không thêm quà live — kể cả khi bảng quà
 * trên máy chủ thiếu "Tối đa 2 túi" cho quà live.
 */
export function applyLiveGiftPolicy(gifts, totalQuantity) {
  const list = Array.isArray(gifts) ? gifts : [];
  if (!list.some(gift => gift?.livestreamOnly)) return list;
  if (Number(totalQuantity) >= 3) return list.filter(gift => !gift.livestreamOnly);
  // Quà hiện vật (có SKU) khác quà live bị bỏ; quà không hiện vật (miễn ship) giữ.
  return list.filter(gift => gift.livestreamOnly || !gift.sku);
}

/** Danh sách quà có quà chỉ khách live (Quà Tặng LIVE) không. */
export function hasLivestreamGift(gifts) {
  return (Array.isArray(gifts) ? gifts : []).some(gift => gift?.livestreamOnly);
}

/** SKU kho của các quà chỉ khách live trong bảng quà (vd. QUA-TANG-LIVE). */
export function livestreamGiftSkus() {
  return new Set(readGiftStoreSync().items.filter(gift => gift.livestreamOnly && gift.sku).map(gift => gift.sku));
}

/**
 * Quà tặng là một túi sản phẩm (đơn 5 túi tặng 1 Túi Vàng; 10 túi tặng thêm Túi
 * Nâu): SKU quà là SKU sản phẩm trong danh mục. Dòng POS/kho của nó là dòng tặng
 * giá 0 RIÊNG, không gộp với dòng hàng cùng SKU khách mua.
 */
export function isBonusProductGift(gift) {
  return Boolean(gift?.sku) && Boolean(findProductBySku(gift.sku));
}

/**
 * 01/10 (chủ shop): những đơn có số túi chủ shop chưa chốt quà riêng (6–9 túi,
 * hơn 10 túi) vẫn nhận quà theo bảng (bát + muỗng; từ 10 túi thêm Túi Vàng + Túi
 * Nâu) nhưng nhân viên cần xem lại. Trả câu ghi chú cho nhân viên, '' khi không cần.
 */
export const confirmedGiftQuantities = Object.freeze([1, 2, 3, 4, 5, 10]);
export function largeBasketGiftNote(totalQuantity) {
  const total = Math.round(Number(totalQuantity) || 0);
  if (total < 6 || confirmedGiftQuantities.includes(total)) return '';
  return `Đơn ${total} túi: quà theo bảng quà hiện hành; chủ shop chưa chốt quà riêng cho ${total} túi — nhân viên xem lại quà trước khi giao.`;
}

// ===== Quà thay thế (GIFT_SWAP) =====
// 01/10 (chủ shop): khách không lấy bát/quạt → tặng thay 2 gói granola nhỏ bất kỳ
// (Xanh, Cam, Nâu), KHÔNG trừ tiền. Mặc định ở đây; gifts.json có thể ghi đè bằng
// khoá `swap` (cùng dạng). Lưu ý: PUT /api/gifts hiện chỉ ghi items + shippingFee
// nên khoá `swap` ghi tay sẽ mất sau lần lưu từ màn hình → dùng mặc định này.
export const defaultGiftSwap = Object.freeze({
  text: '2 gói granola nhỏ bất kỳ (Xanh, Cam, Nâu)',
  quantity: 2,
  refund: 0,
  options: Object.freeze([
    Object.freeze({ id: 'xanh', label: 'Xanh', name: 'Gói granola nhỏ Xanh 35g', sku: 'GRA-XANH-G35', weight: 35 }),
    Object.freeze({ id: 'cam', label: 'Cam', name: 'Gói granola nhỏ Cam 30g', sku: 'GRA-CAM-G30', weight: 30 }),
    Object.freeze({ id: 'nau', label: 'Nâu', name: 'Gói granola nhỏ Nâu 35g', sku: 'GRA-NAU-G35', weight: 35 })
  ])
});

function normalizeGiftSwap(value) {
  if (!value || typeof value !== 'object') return null;
  const options = (Array.isArray(value.options) ? value.options : []).map(option => {
    const label = String(option?.label ?? '').trim().slice(0, 40);
    const sku = normalizeSkuText(option?.sku).slice(0, 80);
    if (!label || !sku) return null;
    return {
      id: String(option?.id ?? '').trim() || normalizeText(label).replace(/[^a-z0-9]+/g, '-'),
      label,
      name: String(option?.name ?? '').trim().slice(0, 200) || `Gói granola nhỏ ${label}`,
      sku,
      weight: money(option?.weight)
    };
  }).filter(Boolean);
  return {
    text: String(value.text ?? '').trim().slice(0, 300) || defaultGiftSwap.text,
    quantity: Math.max(1, Math.min(10, Math.round(Number(value.quantity) || defaultGiftSwap.quantity))),
    refund: money(value.refund),
    options: options.length ? options : defaultGiftSwap.options.map(option => ({ ...option }))
  };
}

/** Cấu hình quà thay thế đang dùng: { text, quantity, refund, options: [{ id, label, name, sku, weight }] }. */
export function getGiftSwap() {
  const stored = readGiftStoreSync().swap;
  return stored || normalizeGiftSwap(defaultGiftSwap);
}

/** Quà hiện vật đổi được (bát, muỗng, quạt + bát của live): có SKU, không phải miễn ship, không phải túi tặng. */
export function isSwappableGift(gift) {
  return Boolean(gift?.sku) && !isFreeShippingGift(gift) && !isBonusProductGift(gift);
}

/**
 * Vị khách chọn cho quà thay ("2 gói xanh", "1 xanh 1 cam", "cam với nâu"): danh
 * sách đúng `quantity` lựa chọn; khách chỉ nêu một vị không số → lấy vị đó cho cả
 * hai gói; không nêu vị → [] (bot hỏi lại hay để nhân viên chọn).
 */
export function parseGiftSwapChoice(text, swap = getGiftSwap()) {
  const content = normalizeText(text);
  const wanted = swap.quantity;
  const picks = [];
  for (const option of swap.options) {
    const word = normalizeText(option.label);
    // "cảm ơn" bỏ dấu cũng là "cam on": không phải vị Cam.
    const pattern = new RegExp(`(?:(\\d{1,2})\\s*(?:goi|tui|bich)?\\s*)?(?<![a-z])${word}(?![a-z])(?!\\s+on(?![a-z]))`, 'g');
    for (const match of content.matchAll(pattern)) {
      picks.push({ option, index: match.index, count: match[1] ? Number(match[1]) : 0 });
    }
  }
  if (!picks.length) return [];
  picks.sort((a, b) => a.index - b.index);
  const chosen = [];
  if (picks.length === 1 && !picks[0].count) {
    for (let index = 0; index < wanted; index += 1) chosen.push(picks[0].option);
  } else {
    for (const pick of picks) for (let index = 0; index < Math.max(1, pick.count); index += 1) chosen.push(pick.option);
  }
  return chosen.slice(0, wanted).map(option => ({ ...option }));
}

/**
 * Vòng 13: lựa chọn đổi quà đã lưu trên giỏ chờ (pendingOrder.giftSwap — kết quả parseGiftSwapChoice qua JSON) → các lựa
 * chọn hợp lệ theo cấu hình quà thay hiện tại (khớp id, SKU hay nhãn), tối đa `quantity` gói. Mục lạ bị bỏ.
 * @param {unknown} value
 * @returns {Array<{id:string,label:string,name:string,sku:string,weight:number}>}
 */
export function normalizeGiftSwapChoices(value, swap = getGiftSwap()) {
  const list = Array.isArray(value) ? value : [];
  const chosen = [];
  for (const entry of list) {
    const id = normalizeText(typeof entry === 'string' ? entry : entry?.id);
    const sku = normalizeSkuText(typeof entry === 'string' ? '' : entry?.sku);
    const label = normalizeText(typeof entry === 'string' ? entry : entry?.label);
    const option = swap.options.find(item => (id && normalizeText(item.id) === id) || (sku && item.sku === sku) || (label && normalizeText(item.label) === label));
    if (option) chosen.push({ ...option });
  }
  return chosen.slice(0, swap.quantity);
}

/**
 * Đổi quà: bỏ quà hiện vật (bát/muỗng/quạt), thêm `quantity` gói nhỏ theo vị đã
 * chọn (thiếu vị → để trống `sku`, nhân viên chọn). Tiền không đổi.
 * Trả { gifts, removed, added, text } — `gifts` là danh sách quà mới của đơn.
 */
export function applyGiftSwap(gifts, choices = [], swap = getGiftSwap()) {
  const list = Array.isArray(gifts) ? gifts : [];
  const removed = list.filter(isSwappableGift);
  if (!removed.length) return { gifts: list, removed: [], added: [], text: '' };
  const added = [];
  for (let index = 0; index < swap.quantity; index += 1) {
    const option = choices[index] || null;
    added.push(option
      ? { id: `swap-${option.id}-${index + 1}`, name: option.name, sku: option.sku, weight: option.weight, active: true, swap: true }
      : { id: `swap-any-${index + 1}`, name: 'Gói granola nhỏ (vị khách chọn)', sku: '', weight: 35, active: true, swap: true });
  }
  const counts = new Map();
  for (const item of added) counts.set(item.name, (counts.get(item.name) || 0) + 1);
  const text = [...counts.entries()].map(([name, count]) => `${count} ${name}`).join(' + ');
  return { gifts: [...list.filter(gift => !isSwappableGift(gift)), ...added], removed, added, text };
}

const giftNameKey = value => String(value || '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/gi, 'd').toLowerCase().replace(/\s+/g, ' ').trim();

/**
 * R13: kế hoạch dòng quà của ĐƠN ĐÃ ĐỔI QUÀ (`order.giftSwap = [{ name, sku, weight }]`, `order.giftSwapRemoved = [tên quà
 * bị thay]`) — dùng chung cho đẩy POS (pos-orders.mjs posGiftSwapPlan) và file xuất kho (order-export.mjs). null khi đơn
 * không đổi quà.
 * - `removes(gift)`: quà theo bảng quà này đã bị khách đổi (không lên dòng quà);
 * - `lines`: dòng quà thay thế [{ sku, name, weight, quantity }] (gộp theo SKU);
 * - `missing`: quà thay thế KHÔNG lên được dòng — chưa chọn vị (không có SKU) hay `knownSkus` (Set mã POS) không có mã đó.
 *   Không đoán mã khác: nơi gọi ghi chú cho nhân viên.
 */
export function giftSwapPlan(order, knownSkus = null) {
  const swap = (Array.isArray(order?.giftSwap) ? order.giftSwap : []).filter(item => item && typeof item === 'object');
  if (!swap.length) return null;
  const removedNames = new Set((Array.isArray(order.giftSwapRemoved) ? order.giftSwapRemoved : []).map(giftNameKey).filter(Boolean));
  // Không ghi quà nào bị thay (dữ liệu thiếu): coi như thay mọi quà hiện vật đổi được, như applyGiftSwap.
  const removes = gift => (removedNames.size ? removedNames.has(giftNameKey(gift?.name)) || removedNames.has(giftNameKey(gift?.sku)) : isSwappableGift(gift));
  const lines = new Map();
  const missing = [];
  for (const item of swap) {
    const sku = String(item.sku || '').trim().toUpperCase();
    const name = String(item.name || '').trim();
    if (!sku) { missing.push(name || 'quà thay thế (chưa chọn vị)'); continue; }
    if (knownSkus && !knownSkus.has(sku)) { missing.push(`${name || sku} (${sku})`); continue; }
    const line = lines.get(sku) || { sku, name, weight: Math.max(0, Math.round(Number(item.weight) || 0)), quantity: 0 };
    line.quantity += Math.max(1, Math.round(Number(item.quantity) || 1));
    lines.set(sku, line);
  }
  return { removes, lines: [...lines.values()], missing };
}

export const defaultShippingFee = 15000;

function readGiftStoreSync() {
  if (!giftCache) {
    try {
      giftCache = normalizeGiftStore(JSON.parse(readFileSync(giftsPath, 'utf8')));
    } catch {
      giftCache = { items: [], swap: null, shippingFee: defaultShippingFee, updatedAt: 0 };
    }
  }
  return giftCache;
}

export function getGifts() {
  return readGiftStoreSync().items;
}

export function getShippingFee() {
  return readGiftStoreSync().shippingFee;
}

const freeShippingPattern = /mien phi van chuyen|mien phi ship|mien ship|free ?ship/;

/** A gift named as free shipping waives the fee on the combinations it is ticked for. */
export function isFreeShippingGift(gift) {
  return freeShippingPattern.test(normalizeText(gift?.name));
}

/** Drops both caches. Called after every write so pricing sees the new data. */
export function reloadCatalog() {
  productCache = null;
  giftCache = null;
  return { products: getCatalogProducts(), gifts: getGifts() };
}

/**
 * Every phrase that names a product: the aliases staff entered and the name
 * itself with the weight stripped ("Granola Túi Xanh 450g" also matches
 * "granola túi xanh"). The SKU is deliberately not a text keyword — "XANH"
 * would match "bột chuối xanh" in an ingredient question — it only matches
 * when the whole text is the SKU. Longest first so "combo 10 gói xanh" is
 * tried before "túi xanh".
 */
export function productKeywords(product) {
  const keywords = new Set();
  const add = value => { const key = normalizeText(value); if (key.length >= 4) keywords.add(key); };
  add(product.name);
  add(product.name.replace(/\b\d+\s*(g|kg|gram|ml|l)\b/gi, ''));
  for (const alias of product.aliases) add(alias);
  return [...keywords].sort((a, b) => b.length - a.length);
}

function buildIndex(products) {
  return products
    .filter(product => product.active)
    .flatMap(product => productKeywords(product).map(keyword => ({ keyword, product })))
    .sort((a, b) => b.keyword.length - a.keyword.length);
}

/**
 * Finds the product a piece of text refers to. The longest matching keyword
 * across the whole catalogue wins, which is what keeps "combo 10 gói xanh"
 * from being read as a single "túi xanh".
 */
export function matchProduct(text) {
  const content = normalizeText(text);
  if (!content) return null;
  const products = getCatalogProducts();
  const bySku = products.find(product => product.active && normalizeText(product.sku) === content);
  if (bySku) return bySku;
  const hit = buildIndex(products).find(entry => keywordInText(content, entry.keyword));
  return hit ? hit.product : null;
}

/**
 * Tên gọi chữ phải đứng thành từ trọn ("túi dâu" không khớp "túi đâu tiên"/"túi
 * đầu", "dâu tây" không khớp trong từ khác); tên gọi có chữ số ("450g", "cacao
 * 300", "combo 10 gói") vẫn khớp chuỗi con như cũ ("450gr", "cacao 300g").
 * Trước con chữ số được phép ("2túi xanh").
 */
export function keywordInText(content, keyword) {
  if (!keyword) return false;
  if (/\d/.test(keyword) || keyword.startsWith('#')) return content.includes(keyword);
  for (let index = content.indexOf(keyword); index >= 0; index = content.indexOf(keyword, index + 1)) {
    const before = index > 0 ? content[index - 1] : ' ';
    const after = content[index + keyword.length] ?? ' ';
    if (!/[a-z]/.test(before) && !/[a-z]/.test(after)) return true;
  }
  return false;
}

export function findProductBySku(sku) {
  const key = normalizeSkuText(sku);
  if (!key) return null;
  return getCatalogProducts().find(product => product.sku === key) || null;
}

// ===== Sản phẩm chỉ nhân viên CSKH bán =====
// 01/10 (chủ shop): Granola Siêu Hạt Premium 420g, granola/hạt dạng hũ, lọ, hộp
// nhựa, mua hạt riêng: CHỈ CSKH bán, bot chưa được báo giá/chốt → bot ghi nhận và
// chuyển nhân viên. Cụm từ đặt ở đây (không phải bảng sản phẩm) vì phần lớn các
// sản phẩm này không có trong danh mục bot; sản phẩm danh mục có cờ `staffOnly`
// (Hạt An Lành dạng hũ) cũng tính, theo tên và tên gọi khác của nó.
export const STAFF_ONLY_PRODUCTS = Object.freeze([
  Object.freeze({ id: 'sieu-hat-premium', name: 'Granola Siêu Hạt Premium 420g', pattern: /\bsieu hat\b|\bhat premium\b|\bgranola premium\b(?! cacao)|\bpremium 420\b|(?<!\d)420 ?(?:g|gr|gram)\b/ }),
  Object.freeze({ id: 'hat-an-lanh', name: 'Hạt An Lành dạng hũ', pattern: /\bhat an lanh\b|\ban lanh dang hu\b/ }),
  // "đang lo"/"đừng lo" bỏ dấu là "dang lo"/"dung lo": lọ chỉ nhận "loại lọ", "đựng trong lọ", "granola lọ", "lọ hạt".
  // Hũ thuỷ tinh 300ml (quà yến mạch) và hũ sữa chua không phải hàng hũ.
  Object.freeze({ id: 'hu-lo', name: 'Granola/hạt dạng hũ, lọ', pattern: /(?:\b(?:granola|hat|loai|dang|dung trong) hu\b|\b(?:granola|loai|dung trong) lo\b|\b(?:hu|lo) (?:hat|granola|ngu coc)\b)(?! (?:thuy tinh|300 ?ml|sua chua))/ }),
  Object.freeze({ id: 'hop-nhua', name: 'Granola hộp nhựa', pattern: /\bhop nhua\b/ }),
  // "Mình muốn mua hạt", "chỉ mua các loại hạt", "bên em có bán hạt không" — không phải "mua túi nhiều hạt".
  Object.freeze({ id: 'mua-hat', name: 'Các loại hạt bán riêng', pattern: /\b(?:mua|ban) (?:cac loai |may loai |rieng |them )?hat(?= dinh duong| rieng| thoi| khong| ko| k\b| ?[?.!,]| ?$)(?!.*\b(?:tui|goi|granola|bich)\b)/ })
]);

/**
 * Tin khách nói tới sản phẩm chỉ CSKH bán? Trả { id, name, product } (product: sản
 * phẩm danh mục có cờ staffOnly nếu khớp tên gọi của nó) hay null. Chạy TRƯỚC
 * matchProduct trong bot: khớp thì ghi nhận + chuyển nhân viên, không báo giá
 * granola thay. "nhiều hạt" (Túi Vàng), "hạt gì", "có hạt óc chó không" không khớp.
 */
export function matchStaffOnlyProduct(text) {
  const content = normalizeText(text).replace(/[^a-z0-9 ?.!,]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!content) return null;
  const listed = getCatalogProducts().filter(product => product.active && product.staffOnly);
  for (const product of listed) {
    const keyword = productKeywords(product).find(item => keywordInText(content, item));
    if (keyword) return { id: normalizeText(product.sku).replace(/[^a-z0-9]+/g, '-'), name: product.name, product, keyword };
  }
  for (const entry of STAFF_ONLY_PRODUCTS) {
    const match = content.match(entry.pattern);
    if (match) return { id: entry.id, name: entry.name, product: null, keyword: match[0].trim() };
  }
  return null;
}

// ===== Giỏ Facebook Shop: mã SKU → sản phẩm danh mục =====
// Shop gửi mã combo POS: "CB2-XANH-Z450" (2 Túi Xanh), "CB-VANGG+NAU" (Vàng + Nâu),
// "CB3-XANH-Z450+BGD+M" (3 Túi Xanh, kèm bát + muỗng trong mã), "CB10-CAM-G30"
// (sản phẩm danh mục). Yến mạch ("CB2-HT-YM-T500" = 2 hộp 500g cán dẹt) không có
// trong danh mục bot: trả needsStaff để chuyển nhân viên lên đơn.
const cartGiftTokens = new Set(['BGD', 'M', 'MUONG', 'QUAT', 'QUA']);
const oatSkuPattern = /^CB(\d*)-(HT-YM|YM-VO)-T500$|^(HT-YM|YM-VO)-T500$|^CB-YM-DET\+VO$/;

// Vòng 13: KHÔNG đoán món khi mã lạ. Mảnh mã combo ("VANGG", "XANH-Z450", "MINT-Z300") chỉ ra sản phẩm khi:
// - có đuôi quy cách ("XANH-Z450") → phải có đúng mã GRA-<màu>-<đuôi> trong danh mục ("XANH-G35" không phải Túi Xanh 450g);
// - không đuôi ("VANGG", "XANH", "NAU") → túi GRA-<màu>-… duy nhất; hoặc sản phẩm DUY NHẤT có mã mở đầu bằng mảnh đó ("NGHE");
// - combo 10 ("CB10-XANH", không đuôi) là hộp 10 gói nhỏ: chỉ khớp sản phẩm CB10-<màu>…, không bao giờ thành 10 túi lớn.
function colourProduct(token, each = 1) {
  const parts = String(token || '').toUpperCase().split('-').filter(Boolean);
  const colour = String(parts[0] || '').replace(/^VANGG$/, 'VANG');
  if (!colour) return null;
  const products = getCatalogProducts().filter(product => product.active);
  if (parts.length > 1) return products.find(product => product.sku === `GRA-${[colour, ...parts.slice(1)].join('-')}`) || null;
  if (Number(each) === 10) {
    const boxes = products.filter(product => product.sku === `CB10-${colour}` || product.sku.startsWith(`CB10-${colour}-`));
    return boxes.length === 1 ? boxes[0] : null;
  }
  const bags = products.filter(product => /^GRA-/.test(product.sku) && product.sku.split('-')[1] === colour);
  if (bags.length === 1) return bags[0];
  if (bags.length > 1) return null;
  const prefixed = products.filter(product => product.sku.split('-')[0] === colour);
  return prefixed.length === 1 ? prefixed[0] : null;
}

/**
 * Chuẩn hoá MỘT mã SKU giỏ Shop. Trả
 * { sku, items: [{ sku, name, quantity }], gifts: ['BGD', 'MUONG'], needsStaff, reason, label, unknown, name }.
 * `quantity` là số dòng giỏ (khách bấm 2 lần combo 2 túi = 4 túi; Shop gửi 0 = 1).
 * reason: '' | 'oat' (yến mạch — nhân viên lên đơn) | 'unknown' (mã lạ).
 * Vòng 13: mã lạ → `unknown: true` + `name` (tên dòng giỏ Shop gửi kèm, không có thì chính mã) để engine gắn thẻ và
 * nêu đúng tên món cho nhân viên — không bao giờ đoán sang sản phẩm khác.
 */
export function parseCartSku(rawSku, quantity = 1, name = '') {
  const sku = normalizeSkuText(rawSku);
  const times = Math.max(1, Math.round(Number(quantity) || 1));
  const lineName = String(name ?? '').trim().replace(/\s+/g, ' ').slice(0, 200);
  const result = { sku, items: [], gifts: [], needsStaff: false, reason: '', label: '', unknown: false, name: lineName };
  const unknownLine = (extra = {}) => ({ ...result, ...extra, needsStaff: true, reason: 'unknown', unknown: true, name: lineName || sku });
  if (!sku) return unknownLine();
  const direct = findProductBySku(sku);
  // Sản phẩm danh mục đã tắt (ngừng bán) coi như mã lạ: nhân viên xem, bot không tự lên đơn.
  if (direct && !direct.active) return unknownLine();
  if (direct) return { ...result, items: [{ sku: direct.sku, name: direct.name, quantity: times }] };
  const oat = sku.match(oatSkuPattern);
  if (oat) {
    const boxes = sku === 'CB-YM-DET+VO' ? 2 : Math.max(1, Number(oat[1]) || 1);
    const kind = sku.includes('YM-VO') && sku !== 'CB-YM-DET+VO' ? 'cán vỡ' : sku === 'CB-YM-DET+VO' ? 'cán dẹt + cán vỡ' : 'cán dẹt';
    const kilograms = (boxes * 500 * times) / 1000;
    return { ...result, needsStaff: true, reason: 'oat', label: `Yến Mạch Úc Nguyên Cám ${kind} ${String(kilograms).replace('.', ',')}kg` };
  }
  const tokens = sku.split('+');
  const gifts = tokens.slice(1).filter(token => cartGiftTokens.has(token)).map(token => (token === 'M' ? 'MUONG' : token));
  const parts = [tokens[0], ...tokens.slice(1).filter(token => !cartGiftTokens.has(token))];
  const head = parts[0].match(/^CB(\d*)-(.+)$/);
  // Mã sản phẩm danh mục kèm đuôi quà ("GRA-XANH-Z450+BGD", "CB10-XANH-G35+BGD").
  const whole = parts.length === 1 ? findProductBySku(parts[0]) : null;
  if (whole?.active) return { ...result, gifts, items: [{ sku: whole.sku, name: whole.name, quantity: times }] };
  if (!head) return unknownLine({ gifts });
  const each = Math.max(1, Number(head[1]) || 1);
  const counts = new Map();
  for (const token of [head[2], ...parts.slice(1)]) {
    const exact = findProductBySku(token);
    const product = exact?.active ? exact : colourProduct(token, each);
    if (!product) return unknownLine({ gifts });
    // "CB10-XANH" khớp hộp 10 gói (một đơn vị bán), không nhân 10.
    const units = /^CB10-/.test(product.sku) ? 1 : each;
    const entry = counts.get(product.sku) || { sku: product.sku, name: product.name, quantity: 0 };
    entry.quantity += units * times;
    counts.set(product.sku, entry);
  }
  return { ...result, gifts, items: [...counts.values()] };
}

/**
 * Cả giỏ Shop [{ sku, quantity, name? }] → { items (gộp theo SKU), gifts, needsStaff, reasons, labels, unknownSkus,
 * unknown, name, unknownLines }. needsStaff = có dòng yến mạch/mã lạ: bot không tự chốt, chuyển nhân viên kèm `labels`
 * (vd. "Yến Mạch Úc Nguyên Cám cán dẹt 1kg"). Vòng 13: `unknown: true` khi có dòng mã lạ, `name` = tên các dòng lạ
 * (tên Shop gửi, không có thì mã) nối bằng " + ", `unknownLines: [{ sku, name, quantity }]`. Giỏ rỗng → unknown.
 * Engine gọi hàm này thay cho phần tự tách mã trong cartQuickReply; `items` đưa thẳng vào Product_N1…/No_A….
 */
export function parseShopCart(cart = []) {
  const counts = new Map();
  const gifts = new Set();
  const reasons = new Set();
  const labels = [];
  const unknownSkus = [];
  const unknownLines = [];
  const lines = Array.isArray(cart) ? cart : [];
  for (const line of lines) {
    const parsed = parseCartSku(line?.sku, line?.quantity, line?.name);
    parsed.gifts.forEach(gift => gifts.add(gift));
    if (parsed.needsStaff) {
      reasons.add(parsed.reason);
      if (parsed.label) labels.push(parsed.label);
      if (parsed.reason === 'unknown') {
        unknownSkus.push(parsed.sku);
        unknownLines.push({ sku: parsed.sku, name: parsed.name, quantity: Math.max(1, Math.round(Number(line?.quantity) || 1)) });
      }
    }
    for (const item of parsed.items) {
      const entry = counts.get(item.sku) || { ...item, quantity: 0 };
      entry.quantity += item.quantity;
      counts.set(item.sku, entry);
    }
  }
  if (!lines.length) reasons.add('unknown');
  const unknown = !lines.length || unknownLines.length > 0;
  return {
    items: [...counts.values()], gifts: [...gifts], needsStaff: reasons.size > 0, reasons: [...reasons], labels, unknownSkus,
    unknown, name: unknownLines.map(line => line.name).filter(Boolean).join(' + '), unknownLines
  };
}
