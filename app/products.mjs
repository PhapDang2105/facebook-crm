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
  return cleanText(value, maximumSkuLength).toUpperCase();
}

export function normalizeProduct(input = {}, existing = {}) {
  const name = cleanText(input.name ?? existing.name, maximumNameLength);
  const sku = normalizeSku(input.sku ?? existing.sku);
  if (!name) throw new Error('Vui lòng nhập tên sản phẩm.');
  if (!sku) throw new Error('Vui lòng nhập SKU.');

  const originalPrice = cleanPrice(input.originalPrice ?? existing.originalPrice ?? 0, 'Giá gốc');
  const salePrice = cleanPrice(input.salePrice ?? existing.salePrice ?? 0, 'Giá bán');
  return {
    ...existing,
    name,
    sku,
    originalPrice,
    salePrice,
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
    updatedAt: Number(value?.updatedAt) || 0
  };
}
