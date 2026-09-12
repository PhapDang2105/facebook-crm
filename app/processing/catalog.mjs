import { readFileSync } from 'node:fs';
import path from 'node:path';
import { projectRoot } from '../config.mjs';

// The catalogue IS the configuration. A product carries its single price, its
// combo price, its warehouse SKU and the words customers use for it; a gift
// carries the quantity it unlocks at and its warehouse SKU. Pricing, detection,
// the model prompt and the warehouse export all derive from here, so adding a
// product in Cài đặt → Sản phẩm is the whole job.
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
    minQuantity: Math.min(20, Math.max(1, Math.round(Number(item?.minQuantity) || 1))),
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
  return { items, updatedAt: Number(value?.updatedAt) || 0 };
}

export function getGifts() {
  if (!giftCache) {
    try {
      giftCache = normalizeGiftStore(JSON.parse(readFileSync(giftsPath, 'utf8'))).items;
    } catch {
      giftCache = [];
    }
  }
  return giftCache;
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
