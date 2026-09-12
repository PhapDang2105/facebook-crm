import { comboKey, findProductBySku, getCatalogProducts, getGiftAssignments, getGifts, getShippingFee, giftsForKey, isFreeShippingGift, listCombos, matchProduct, maxComboQuantity } from './catalog.mjs';

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

/** Human-readable name of a basket key: "2 × Granola Túi Xanh 450g + 1 × Granola Túi Nâu". */
export function describeComboKey(key) {
  return String(key || '').split('|').filter(Boolean).map(part => {
    const [sku, quantity] = part.split('=');
    return `${quantity} × ${findProductBySku(sku)?.name || sku}`;
  }).join(' + ');
}

/**
 * The gift table as text, grouped so the model reads one line per distinct
 * gift set: "- Miễn phí vận chuyển: 2 × Túi Xanh, 1 × Túi Xanh + 1 × Túi Nâu, ...".
 */
export function describeGiftTable() {
  const assignments = getGiftAssignments();
  const active = new Map(getGifts().filter(gift => gift.active).map(gift => [gift.id, gift.name]));
  const combos = listCombos();
  const groups = new Map();
  for (const combo of combos) {
    const names = (assignments[combo.key] || []).map(id => active.get(id)).filter(Boolean);
    if (!names.length) continue;
    const label = names.join(' + ');
    groups.set(label, [...(groups.get(label) || []), combo]);
  }
  if (!groups.size) return ['- Hiện chưa có quà tặng.'];
  // When a gift set covers every combination of N units it is said once as
  // "mọi đơn N sản phẩm"; only the exceptions are spelled out.
  const byTotal = new Map();
  for (const combo of combos) byTotal.set(combo.totalQuantity, (byTotal.get(combo.totalQuantity) || 0) + 1);
  return [...groups.entries()].map(([label, list]) => {
    const parts = [];
    let rest = list;
    for (const [total, count] of [...byTotal.entries()].sort((a, b) => a[0] - b[0])) {
      const mine = list.filter(combo => combo.totalQuantity === total);
      if (mine.length === count) {
        parts.push(`mọi đơn ${total} sản phẩm`);
        rest = rest.filter(combo => combo.totalQuantity !== total);
      }
    }
    return `- ${label}: ${[...parts, ...rest.map(combo => describeComboKey(combo.key))].join('; ')}`;
  });
}

