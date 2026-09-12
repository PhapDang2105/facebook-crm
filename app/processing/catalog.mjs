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

/**
 * What the warehouse ships for one unit of this product. Accepts the array
 * form or text such as "GRA-XANH-G35 x10" / "GRA-NAU-G35 x3, GRA-XANH-G35 x4".
 * Empty means one unit of the product's own SKU.
 */
export function normalizeComponents(value) {
  const list = Array.isArray(value)
    ? value
    : String(value ?? '').split(/[\n,;]+/).map(part => {
        const match = part.trim().match(/^([A-Za-z0-9_\-+.]+)\s*(?:[x×*]\s*(\d+))?$/);
        return match ? { sku: match[1], quantity: match[2] || 1 } : null;
      });
  const components = [];
  for (const item of list) {
    const sku = normalizeSkuText(item?.sku);
    const quantity = Math.max(1, Math.round(Number(item?.quantity) || 1));
    if (!sku) continue;
    const existing = components.find(component => component.sku === sku);
    if (existing) existing.quantity += quantity;
    else components.push({ sku, quantity });
  }
  return components.slice(0, 20);
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
    aliases: normalizeAliases(item?.aliases),
    components: normalizeComponents(item?.components),
    // Mixable products (the granola bags) may share one order in any mix of up
    // to maxComboQuantity units; every other product is sold on its own.
    mixable: item?.mixable === true,
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
  const giftIds = new Set(items.map(gift => gift.id));
  // Which gifts each basket combination earns, keyed by the canonical basket
  // key ("GRA-NAU-Z350=1|GRA-XANH-Z450=2"). Unknown gift ids are dropped.
  const assignments = {};
  for (const [key, ids] of Object.entries(value?.assignments && typeof value.assignments === 'object' ? value.assignments : {})) {
    const cleanKey = normalizeComboKey(key);
    const list = (Array.isArray(ids) ? ids : []).map(id => String(id ?? '').trim()).filter(id => giftIds.has(id));
    if (cleanKey && list.length) assignments[cleanKey] = [...new Set(list)];
  }
  return {
    items,
    assignments,
    // Charged on orders whose combination has not been given free shipping.
    // The business quotes "174.000đ + ship 15.000đ" for one bag; 189.000đ is
    // what the customer pays and what the warehouse file must show.
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

function normalizeComboKey(key) {
  return comboKey(String(key ?? '').split('|').map(part => {
    const [sku, quantity] = part.split('=');
    return { sku, quantity };
  }));
}

/** The largest basket the bot closes on its own; bigger ones are wholesale, handled by a person. */
export const maxComboQuantity = 3;

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

/** Active gifts ticked for a basket key; empty when the key is not a listed combination. */
export function giftsForKey(key) {
  const store = readGiftStoreSync();
  const ids = store.assignments[normalizeComboKey(key)] || [];
  return store.items.filter(gift => gift.active && ids.includes(gift.id));
}

export function getGiftAssignments() {
  return readGiftStoreSync().assignments;
}

export const defaultShippingFee = 15000;

function readGiftStoreSync() {
  if (!giftCache) {
    try {
      giftCache = normalizeGiftStore(JSON.parse(readFileSync(giftsPath, 'utf8')));
    } catch {
      giftCache = { items: [], assignments: {}, shippingFee: defaultShippingFee, updatedAt: 0 };
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
  const hit = buildIndex(products).find(entry => content.includes(entry.keyword));
  return hit ? hit.product : null;
}

export function findProductBySku(sku) {
  const key = normalizeSkuText(sku);
  if (!key) return null;
  return getCatalogProducts().find(product => product.sku === key) || null;
}
