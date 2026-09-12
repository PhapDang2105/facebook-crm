import { matchProduct, normalizeText } from './catalog.mjs';
import { priceBasket } from './pricing.mjs';

// The hard-coded product codes and mixing rules that used to live here now come
// from the catalogue. What remains is the canonical basket key, kept because
// the duplicate-order guard and the pending-basket memory compare on it.

export function normalizeProductText(value) {
  return normalizeText(value);
}

/** Maps free text to the product's SKU, or '' when the catalogue has no match. */
export function productCode(product) {
  return matchProduct(product)?.sku || '';
}

/**
 * Canonical key for a basket, e.g. "NAU=1|XANH=2". Empty when the basket
 * cannot be priced — unknown product, bad quantity, products that do not mix.
 */
export function orderKey(items = []) {
  const priced = priceBasket(items);
  if (!priced.priceable) return '';
  return priced.lines
    .map(line => `${line.sku}=${line.quantity}`)
    .sort()
    .join('|');
}

/** Normalises loose model output into the {product, code, quantity} shape. */
export function toPricedItems(rawItems = []) {
  return rawItems
    .map(item => ({
      product: String(item?.product ?? item?.name ?? '').trim(),
      code: productCode(item?.product ?? item?.name),
      quantity: Math.round(Number(item?.quantity) || 0)
    }))
    .filter(item => item.product || item.quantity > 0);
}
