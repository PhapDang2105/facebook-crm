import { normalizeAliases, normalizeComboPrices } from './processing/catalog.mjs';

const maximumNameLength = 200;
const maximumSkuLength = 80;

function cleanText(value, maximumLength) {
  return String(value || '').trim().replace(/\s+/g, ' ').slice(0, maximumLength);
}

function cleanPrice(value, label) {
  const price = Number(value);
  if (!Number.isFinite(price) || price < 0 || !Number.isInteger(price)) {
    throw new Error(`${label} phải là số nguyên không âm.`);
  }
  return price;
}

export function normalizeSku(value) {
  return cleanText(value, maximumSkuLength).toUpperCase().replace(/\s+/g, '_');
}

/** Lower-case slug; products sharing one may be bought together in one order. */
export function normalizeMixGroup(value) {
  return cleanText(value, 60)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/đ/g, 'd')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

export function normalizeProduct(input = {}, existing = {}) {
  const name = cleanText(input.name ?? existing.name, maximumNameLength);
  const sku = normalizeSku(input.sku ?? existing.sku);
  if (!name) throw new Error('Vui lòng nhập tên sản phẩm.');
  if (!sku) throw new Error('Vui lòng nhập SKU.');

  const originalPrice = cleanPrice(input.originalPrice ?? existing.originalPrice ?? 0, 'Giá gốc');
  const salePrice = cleanPrice(input.salePrice ?? existing.salePrice ?? 0, 'Giá bán');
  const comboPrices = normalizeComboPrices(input.comboPrices ?? existing.comboPrices ?? {});
  for (const [quantity, price] of Object.entries(comboPrices)) {
    // A combo that costs more than buying singly is almost always a typo, and
    // the bot would quote it to customers as a deal.
    if (salePrice > 0 && price > salePrice * Number(quantity)) {
      throw new Error(`Giá combo ${quantity} sản phẩm (${price.toLocaleString('vi-VN')}đ) cao hơn mua lẻ ${quantity} × ${salePrice.toLocaleString('vi-VN')}đ.`);
    }
  }
  return {
    ...existing,
    name,
    sku,
    originalPrice,
    salePrice,
    comboPrices,
    mixGroup: normalizeMixGroup(input.mixGroup ?? existing.mixGroup ?? ''),
    aliases: normalizeAliases(input.aliases ?? existing.aliases ?? []),
    active: (input.active ?? existing.active) !== false,
    image: cleanText(input.image ?? existing.image, 500),
    updatedAt: Date.now()
  };
}

export function assertUniqueSku(products, sku, ignoredId = '') {
  const normalizedSku = normalizeSku(sku);
  if (products.some(product => product.id !== ignoredId && normalizeSku(product.sku) === normalizedSku)) {
    throw new Error(`SKU “${normalizedSku}” đã tồn tại.`);
  }
}

export function normalizeProductStore(value) {
  const items = Array.isArray(value) ? value : value?.items;
  return {
    items: Array.isArray(items) ? items.filter(item => item && item.id && item.name && item.sku) : [],
    updatedAt: Number(value?.updatedAt) || 0,
    // Survives every write so the starter catalogue is only ever laid down once.
    // Without it, emptying the catalogue on purpose would refill it on restart.
    seeded: value?.seeded === true
  };
}
