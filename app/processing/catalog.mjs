import { readFileSync } from 'node:fs';
import path from 'node:path';
import { projectRoot } from '../config.mjs';

// The catalogue IS the configuration. Products carry their own tier prices,
// grouping and keywords; gifts carry the quantity they unlock at. Every other
// module derives what it needs from here, so adding a product in Cài đặt →
// Sản phẩm is the whole job — no keyword table, no price row, no prompt edit.
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

/** Tier prices keyed by quantity: { "2": 298000, "3": 447000 }. */
export function normalizeComboPrices(value) {
  const source = value && typeof value === 'object' ? value : {};
  const result = {};
  for (const [key, price] of Object.entries(source)) {
    const quantity = Math.round(Number(key));
    const amount = money(price);
    if (quantity >= 2 && quantity <= 20 && amount > 0) result[String(quantity)] = amount;
  }
  return result;
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
  const sku = String(item?.sku ?? '').trim().toUpperCase();
  const name = String(item?.name ?? '').trim();
  if (!sku || !name) return null;
  return {
    id: String(item?.id ?? ''),
    sku,
    name,
    unitPrice: money(item?.salePrice),
    comboPrices: normalizeComboPrices(item?.comboPrices),
    mixGroup: String(item?.mixGroup ?? '').trim().toLowerCase(),
    aliases: normalizeAliases(item?.aliases),
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
    active: item?.active !== false
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
 * itself with the weight stripped ("Granola Túi Xanh 350g" also matches
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
  const key = String(sku ?? '').trim().toUpperCase();
  if (!key) return null;
  return getCatalogProducts().find(product => product.sku === key) || null;
}
