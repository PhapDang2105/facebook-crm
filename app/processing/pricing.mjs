import { findProductBySku, getCatalogProducts, getGifts, matchProduct, productKeywords } from './catalog.mjs';

// Verified against every row of the old 34-line price table before the table
// was retired: each unit costs its product's per-unit price at the tier equal
// to the basket's TOTAL quantity. Two bags of different colours therefore get
// the two-bag price of each, and the whole table collapses to three numbers
// per product. Gifts unlock by total quantity the same way.

// Baskets larger than this go to a human — wholesale is negotiated, not
// auto-priced — unless a product has an explicit tier for that quantity.
export const maximumAutoQuantity = 5;

function money(value) {
  return Math.max(0, Math.round(Number(value) || 0));
}

/** Per-unit price of one product when the basket holds `totalQuantity` units. */
export function unitPriceAtTier(product, totalQuantity) {
  if (!product) return 0;
  const quantity = Math.max(1, Math.round(Number(totalQuantity) || 1));
  const tier = product.comboPrices?.[String(quantity)];
  if (tier) return tier / quantity;
  // No combo price for this size: full unit price, never a guessed discount.
  return product.unitPrice;
}

/** The single-unit price, for order lines and the manual order form. */
export function unitPriceForProduct(name) {
  return money(matchProduct(name)?.unitPrice);
}

export function giftsFor(totalQuantity) {
  const quantity = Math.max(0, Math.round(Number(totalQuantity) || 0));
  return getGifts()
    .filter(gift => gift.active && gift.minQuantity <= quantity)
    .sort((a, b) => a.minQuantity - b.minQuantity);
}

export function giftTextFor(totalQuantity) {
  return giftsFor(totalQuantity).map(gift => gift.name).join(' + ');
}

/**
 * Prices a basket of { sku | product | name, quantity }. Returns
 * { priceable, reason, total, gift, totalQuantity, lines }. A basket that
 * cannot be priced exactly is handed to a human rather than guessed at.
 */
export function priceBasket(items = []) {
  const lines = [];
  for (const item of Array.isArray(items) ? items : []) {
    const quantity = Math.round(Number(item?.quantity) || 0);
    const product = findProductBySku(item?.sku) || matchProduct(item?.product ?? item?.name);
    if (!product || !product.active) return { priceable: false, reason: 'unknown-product', total: 0, gift: '', totalQuantity: 0, lines: [] };
    if (quantity < 1) return { priceable: false, reason: 'bad-quantity', total: 0, gift: '', totalQuantity: 0, lines: [] };
    const existing = lines.find(line => line.sku === product.sku);
    if (existing) existing.quantity += quantity;
    else lines.push({ sku: product.sku, name: product.name, product, quantity });
  }
  if (!lines.length) return { priceable: false, reason: 'empty', total: 0, gift: '', totalQuantity: 0, lines: [] };

  // Products only combine inside a mix group; a standalone product must be
  // the whole basket.
  const groups = new Set(lines.map(line => line.product.mixGroup || `solo:${line.sku}`));
  if (groups.size > 1) return { priceable: false, reason: 'cannot-mix', total: 0, gift: '', totalQuantity: 0, lines: [] };

  const totalQuantity = lines.reduce((sum, line) => sum + line.quantity, 0);
  const hasExplicitTier = lines.every(line => line.product.comboPrices?.[String(totalQuantity)]);
  if (totalQuantity > maximumAutoQuantity && !hasExplicitTier) {
    return { priceable: false, reason: 'too-many', total: 0, gift: '', totalQuantity, lines: [] };
  }

  let total = 0;
  const priced = lines.map(line => {
    const unit = unitPriceAtTier(line.product, totalQuantity);
    const lineTotal = money(unit * line.quantity);
    total += lineTotal;
    return { sku: line.sku, name: line.name, quantity: line.quantity, unitPrice: line.product.unitPrice, lineTotal };
  });
  if (!(total > 0)) return { priceable: false, reason: 'no-price', total: 0, gift: '', totalQuantity, lines: [] };
  return { priceable: true, reason: '', total: money(total), gift: giftTextFor(totalQuantity), totalQuantity, lines: priced };
}

function formatMoney(value) {
  return `${money(value).toLocaleString('vi-VN')}đ`;
}

/** Price tiers of one product as a sentence: "1 túi 189.000đ; 2 túi 298.000đ; 3 túi 447.000đ". */
export function describeProductPrices(product) {
  if (!product) return '';
  const tiers = [`1 sản phẩm ${formatMoney(product.unitPrice)}`];
  for (const [quantity, price] of Object.entries(product.comboPrices || {}).sort((a, b) => Number(a[0]) - Number(b[0]))) {
    tiers.push(`${quantity} sản phẩm ${formatMoney(price)}`);
  }
  return tiers.join('; ');
}

/**
 * The catalogue as text for the model, appended to the system prompt on every
 * request. This is what makes a product added in settings known to the bot
 * immediately, with no prompt edit.
 */
export function buildCatalogPrompt() {
  const products = getCatalogProducts().filter(product => product.active);
  if (!products.length) return '';
  const productLines = products.map(product => {
    const aliases = product.aliases.length ? ` Tên gọi khác: ${product.aliases.join(', ')}.` : '';
    const mix = product.mixGroup ? ' Có thể mua ghép với sản phẩm cùng nhóm.' : ' Không ghép với sản phẩm khác.';
    return `- ${product.name} (mã ${product.sku}): ${describeProductPrices(product)}.${mix}${aliases}`;
  });
  const gifts = getGifts().filter(gift => gift.active).sort((a, b) => a.minQuantity - b.minQuantity);
  const giftLines = gifts.length
    ? gifts.map(gift => `- Từ ${gift.minQuantity} sản phẩm: ${gift.name}`)
    : ['- Hiện chưa có quà tặng.'];
  return [
    'DANH MỤC SẢN PHẨM (nguồn chính thức, tự cập nhật từ hệ thống — ưu tiên hơn mọi bảng giá khác trong hướng dẫn):',
    ...productLines,
    'Đơn ghép nhiều sản phẩm cùng nhóm: mỗi sản phẩm tính theo giá bậc tương ứng với TỔNG số lượng của cả đơn.',
    '',
    'QUÀ TẶNG THEO TỔNG SỐ LƯỢNG (cộng dồn):',
    ...giftLines,
    '',
    'Khi trả về Product_N1/Product_N2/Product_N3 hãy dùng đúng tên sản phẩm trong danh mục. Khi khách hỏi giá một sản phẩm có trong danh mục, trả về template_id PRICE_QUOTE kèm Product_N1.'
  ].join('\n');
}

/** Reply text for PRICE_QUOTE: the tiers and gifts of one product, from the catalogue. */
export function renderPriceQuote(productText) {
  const product = matchProduct(productText);
  if (!product) return '';
  const tiers = [`1 sản phẩm ${formatMoney(product.unitPrice)}`];
  for (const [quantity, price] of Object.entries(product.comboPrices || {}).sort((a, b) => Number(a[0]) - Number(b[0]))) {
    const gift = giftTextFor(Number(quantity));
    tiers.push(`combo ${quantity} sản phẩm ${formatMoney(price)}${gift ? ` (${gift})` : ''}`);
  }
  return `Dạ ${product.name}: ${tiers.join('; ')} ạ.`;
}

export { productKeywords };
