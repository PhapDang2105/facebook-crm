import { normalizeAliases, normalizeSkuText } from './processing/catalog.mjs';

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
  return normalizeSkuText(cleanText(value, maximumSkuLength));
}

// Thư viện ảnh gửi khách: bot chọn ngẫu nhiên 2–3 ảnh mỗi lần tư vấn.
export const maximumGalleryImages = 12;
const storedImagePattern = /^\/product-images\/[A-Za-z0-9-]+\.(?:png|jpg|webp)$/;

/** Chỉ giữ đường dẫn ảnh đã lưu (`/product-images/…`), không trùng, tối đa 12. Ảnh mới (data:) do route lưu trước. */
export function normalizeGallery(value) {
  const images = [];
  for (const item of Array.isArray(value) ? value : []) {
    const source = typeof item === 'string' ? item.trim() : String(item?.url || item?.path || '').trim();
    if (storedImagePattern.test(source) && !images.includes(source)) images.push(source);
    if (images.length >= maximumGalleryImages) break;
  }
  return images;
}

export function normalizeProduct(input = {}, existing = {}) {
  const name = cleanText(input.name ?? existing.name, maximumNameLength);
  const sku = normalizeSku(input.sku ?? existing.sku);
  if (!name) throw new Error('Vui lòng nhập tên sản phẩm.');
  if (!sku) throw new Error('Vui lòng nhập SKU.');

  const originalPrice = cleanPrice(input.originalPrice ?? existing.originalPrice ?? 0, 'Giá gốc');
  const salePrice = cleanPrice(input.salePrice ?? existing.salePrice ?? 0, 'Giá bán');
  const comboPrice = cleanPrice(input.comboPrice ?? existing.comboPrice ?? 0, 'Giá combo');
  // A combo unit that costs more than a single is almost always a typo, and
  // the bot would quote it to customers as a deal.
  if (comboPrice > 0 && salePrice > 0 && comboPrice > salePrice) {
    throw new Error(`Giá combo (${comboPrice.toLocaleString('vi-VN')}đ) cao hơn giá bán lẻ (${salePrice.toLocaleString('vi-VN')}đ).`);
  }
  const weight = cleanPrice(input.weight ?? existing.weight ?? 0, 'Khối lượng');
  // The word the bot counts the product in: "Túi", "Hũ", "Hộp" — "Combo 2 Túi bán chạy".
  const unit = cleanText(input.unit ?? existing.unit, 30);
  return {
    ...existing,
    name,
    sku,
    originalPrice,
    salePrice,
    comboPrice,
    weight,
    unit,
    aliases: normalizeAliases(input.aliases ?? existing.aliases ?? []),
    mixable: (input.mixable ?? existing.mixable) === true,
    active: (input.active ?? existing.active) !== false,
    image: cleanText(input.image ?? existing.image, 500),
    images: normalizeGallery(input.images ?? existing.images ?? []),
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
