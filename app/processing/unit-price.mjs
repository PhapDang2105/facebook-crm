import { readFileSync } from 'node:fs';
import path from 'node:path';
import { projectRoot } from '../config.mjs';
import { productCode } from './order-key.mjs';
import { findPrice } from './price-master.mjs';

// One number per product, edited in Cài đặt → Sản phẩm. Before this module the
// unit price lived in two disconnected places: the product catalogue that staff
// use for manual orders, and the combo table the chatbot prices from. The same
// bag could be 189.000đ on a hand-made order and something else on a bot-made
// one, and nobody would see the difference until a customer did.
const productsPath = process.env.PRODUCTS_PATH
  || path.join(projectRoot, 'data', 'processed', 'products.json');

let cache = null;

function readCatalogPrices() {
  if (cache) return cache;
  try {
    const parsed = JSON.parse(readFileSync(productsPath, 'utf8'));
    const items = Array.isArray(parsed?.items) ? parsed.items : [];
    cache = new Map(items
      .map(item => [
        String(item?.sku ?? '').trim().toUpperCase(),
        Math.max(0, Math.round(Number(item?.salePrice) || 0))
      ])
      .filter(([sku, price]) => sku && price > 0));
  } catch {
    cache = new Map();
  }
  return cache;
}

/** Called after any write to the catalogue so pricing picks the change up. */
export function reloadUnitPrices() {
  cache = null;
  return readCatalogPrices();
}

/**
 * The catalogue is the source of truth. The single-unit row of the combo table
 * is only a fallback, for a pricing code nobody has entered as a product yet.
 */
export function unitPriceForCode(code) {
  const key = String(code ?? '').trim().toUpperCase();
  if (!key) return 0;
  const listed = readCatalogPrices().get(key);
  if (listed) return listed;
  return Math.max(0, Math.round(Number(findPrice(`${key}=1`)?.final_price) || 0));
}

/** Same lookup, starting from whatever free text names the product. */
export function unitPriceForProduct(name) {
  return unitPriceForCode(productCode(name));
}
