import { comboKey, findProductBySku, getCatalogProducts, getGifts, getShippingFee, giftsForKey, isFreeShippingGift, listCombos, matchProduct, maxComboQuantity } from './catalog.mjs';

// The rule, as the business states it: one unit sells at the single price;
// from two units — of the same product or mixed with other mixable products —
// every unit sells at its own product's combo price. Checked against every
// row of the retired 34-line price table: the combo price per unit was
// constant from two upward (298.000/2 = 447.000/3 = 149.000), so one number
// per product is all the table ever encoded. Gifts and free shipping are
// ticked per basket combination in Cài đặt → Quà tặng.

function money(value) {
  return Math.max(0, Math.round(Number(value) || 0));
}

/** Per-unit price of a product inside a basket of `totalQuantity` units. */
export function unitPriceInBasket(product, totalQuantity) {
  if (!product) return 0;
  const combo = Math.round(Number(totalQuantity) || 1) >= 2;
  // A product with no combo price never gets an invented discount.
  return combo && product.comboPrice > 0 ? product.comboPrice : product.unitPrice;
}

/** Shipping charged on a basket: the configured fee unless its combination was given free shipping. */
export function shippingFeeForKey(key) {
  return giftsForKey(key).some(isFreeShippingGift) ? 0 : getShippingFee();
}

export function giftTextForKey(key) {
  return giftsForKey(key).map(gift => gift.name).join(' + ');
}

const comboIndex = () => new Set(listCombos().map(combo => combo.key));

const unpriceable = (reason, totalQuantity = 0) => ({ priceable: false, reason, total: 0, subtotal: 0, shippingFee: 0, gift: '', gifts: [], totalQuantity, lines: [] });

/**
 * Prices a basket of { sku | product | name, quantity }. Returns
 * { priceable, reason, total, gift, gifts, totalQuantity, lines }. A basket
 * that cannot be priced exactly is handed to a human rather than guessed at.
 */
export function priceBasket(items = []) {
  const lines = [];
  for (const item of Array.isArray(items) ? items : []) {
    const quantity = Math.round(Number(item?.quantity) || 0);
    const product = findProductBySku(item?.sku) || matchProduct(item?.product ?? item?.name);
    if (!product || !product.active) return unpriceable('unknown-product');
    if (quantity < 1) return unpriceable('bad-quantity');
    const existing = lines.find(line => line.sku === product.sku);
    if (existing) existing.quantity += quantity;
    else lines.push({ sku: product.sku, name: product.name, product, quantity });
  }
  if (!lines.length) return unpriceable('empty');
  const totalQuantity = lines.reduce((sum, line) => sum + line.quantity, 0);
  // Only a listed combination is auto-priced: a non-mixable product with
  // anything else, or more than maxComboQuantity units, goes to a person.
  const key = comboKey(lines);
  if (!comboIndex().has(key)) return unpriceable(totalQuantity > maxComboQuantity ? 'too-many' : 'not-a-combo', totalQuantity);

  let total = 0;
  const priced = lines.map(line => {
    const unit = unitPriceInBasket(line.product, totalQuantity);
    const lineTotal = money(unit * line.quantity);
    total += lineTotal;
    return {
      sku: line.sku,
      name: line.name,
      quantity: line.quantity,
      unitPrice: line.product.unitPrice,
      basketUnitPrice: unit,
      lineTotal,
      weight: line.product.weight
    };
  });
  if (!(total > 0)) return unpriceable('no-price', totalQuantity);
  const gifts = giftsForKey(key);
  const shippingFee = shippingFeeForKey(key);
  return {
    priceable: true,
    reason: '',
    key,
    subtotal: money(total),
    shippingFee,
    total: money(total + shippingFee),
    gift: gifts.map(gift => gift.name).join(' + '),
    gifts,
    totalQuantity,
    lines: priced
  };
}

/**
 * The catalogue as text for the model, appended to the system prompt on every
 * request: one line per product — its exact name and the words customers use
 * for it. No prices, no gifts: the model only names products and picks a
 * template; every figure is computed and written by the server. Kept this
 * short on purpose, because it is paid for on every single reply.
 */
export function buildCatalogPrompt() {
  const products = getCatalogProducts().filter(product => product.active);
  if (!products.length) return '';
  return [
    'SẢN PHẨM (tên chuẩn → cách khách gọi):',
    ...products.map(product => `- ${product.name}${product.aliases.length ? `: ${product.aliases.join(', ')}` : ''}`),
    `Tối đa ${maxComboQuantity} sản phẩm/đơn.`
  ].join('\n');
}

/**
 * The price ladder of one product for the quote: ×1, then ×2..×maxComboQuantity
 * when it has a combo price. Each rung carries what the template needs —
 * list price at the single rate, the price actually paid, shipping or free
 * shipping for that combination, gifts other than free shipping, total weight.
 */
export function quoteTiers(productText) {
  const product = matchProduct(productText);
  if (!product) return null;
  const tiers = [];
  const top = product.comboPrice > 0 ? maxComboQuantity : 1;
  for (let quantity = 1; quantity <= top; quantity += 1) {
    const key = comboKey([{ sku: product.sku, quantity }]);
    const gifts = giftsForKey(key);
    const shippingFee = shippingFeeForKey(key);
    tiers.push({
      quantity,
      listPrice: product.unitPrice * quantity,
      price: unitPriceInBasket(product, quantity) * quantity,
      shippingFee,
      freeShipping: gifts.some(isFreeShippingGift),
      gifts: gifts.filter(gift => !isFreeShippingGift(gift)).map(gift => gift.name),
      weight: product.weight * quantity
    });
  }
  return { product, tiers };
}

/**
 * The gift rules as text, one line per distinct rule: "- Miễn phí vận
 * chuyển: từ 2 sản phẩm" / "- Bộ bát gáo dừa + Muỗng dừa: từ 3 sản phẩm (trừ
 * Bột ngũ cốc Nghệ Lành hộp 14 gói, Hạt An Lành dạng hũ)".
 */
export function describeGiftTable() {
  const groups = new Map();
  for (const gift of getGifts().filter(gift => gift.active)) {
    const excluded = gift.excludedSkus.map(sku => findProductBySku(sku)?.name || sku);
    const rule = `từ ${gift.minQuantity} sản phẩm${excluded.length ? ` (trừ ${excluded.join(', ')})` : ''}`;
    groups.set(rule, [...(groups.get(rule) || []), gift.name]);
  }
  if (!groups.size) return ['- Hiện chưa có quà tặng.'];
  return [...groups.entries()].map(([rule, names]) => `- ${names.join(' + ')}: ${rule}`);
}
