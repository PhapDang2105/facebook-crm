import { findProductBySku, freeShippingFrom, getCatalogProducts, getGifts, getShippingFee, matchProduct, productKeywords } from './catalog.mjs';

// The rule, as the business states it: one unit sells at the single price;
// from two units — of the same product or mixed with any other — every unit
// sells at its own product's combo price. Checked against every row of the
// retired 34-line price table: the combo price per unit was constant from two
// upward (298.000/2 = 447.000/3 = 149.000), so one number per product is all
// the table ever encoded. Gifts unlock by the same total quantity.

// Beyond this a basket is wholesale, negotiated by a person, not auto-priced.
export const maximumAutoQuantity = 20;

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

/** Shipping charged on a basket of this size: the configured fee until the free-shipping gift kicks in. */
export function shippingFeeFor(totalQuantity) {
  const quantity = Math.max(0, Math.round(Number(totalQuantity) || 0));
  return quantity >= freeShippingFrom() ? 0 : getShippingFee();
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
  if (totalQuantity > maximumAutoQuantity) return unpriceable('too-many', totalQuantity);

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
  const gifts = giftsFor(totalQuantity);
  const shippingFee = shippingFeeFor(totalQuantity);
  return {
    priceable: true,
    reason: '',
    subtotal: money(total),
    shippingFee,
    total: money(total + shippingFee),
    gift: gifts.map(gift => gift.name).join(' + '),
    gifts,
    totalQuantity,
    lines: priced
  };
}

function formatMoney(value) {
  return `${money(value).toLocaleString('vi-VN')}đ`;
}

/** One product's prices as a sentence for the model and the price quote. */
export function describeProductPrices(product) {
  if (!product) return '';
  const ship = shippingFeeFor(1);
  const single = ship
    ? `mua lẻ 1 sản phẩm ${formatMoney(product.unitPrice)} + phí vận chuyển ${formatMoney(ship)} = ${formatMoney(product.unitPrice + ship)}`
    : `mua lẻ 1 sản phẩm ${formatMoney(product.unitPrice)}`;
  const parts = [single];
  if (product.comboPrice > 0) parts.push(`từ 2 sản phẩm hoặc mua kèm sản phẩm khác ${formatMoney(product.comboPrice)}/sản phẩm`);
  return parts.join('; ');
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
    return `- ${product.name} (mã ${product.sku}): ${describeProductPrices(product)}.${aliases}`;
  });
  const gifts = getGifts().filter(gift => gift.active).sort((a, b) => a.minQuantity - b.minQuantity);
  const giftLines = gifts.length
    ? gifts.map(gift => `- Từ ${gift.minQuantity} sản phẩm: ${gift.name}`)
    : ['- Hiện chưa có quà tặng.'];
  return [
    'DANH MỤC SẢN PHẨM (nguồn chính thức, tự cập nhật từ hệ thống — ưu tiên hơn mọi bảng giá khác trong hướng dẫn):',
    ...productLines,
    `Cách tính tiền: đơn có TỔNG từ 2 sản phẩm trở lên (cùng loại hay khác loại đều được) thì mỗi sản phẩm tính theo giá combo của chính nó; đơn 1 sản phẩm tính giá lẻ${getShippingFee() ? ` cộng phí vận chuyển ${formatMoney(getShippingFee())}` : ''}. ${Number.isFinite(freeShippingFrom()) ? `Miễn phí vận chuyển từ ${freeShippingFrom()} sản phẩm.` : ''}`,
    '',
    'QUÀ TẶNG THEO TỔNG SỐ LƯỢNG (cộng dồn):',
    ...giftLines,
    '',
    'Khi trả về Product_N1/Product_N2/Product_N3 hãy dùng đúng tên sản phẩm trong danh mục. Khi khách hỏi giá một sản phẩm có trong danh mục, trả về template_id PRICE_QUOTE kèm Product_N1.'
  ].join('\n');
}

/** Reply text for PRICE_QUOTE: one product's prices and gifts, from the catalogue. */
export function renderPriceQuote(productText) {
  const product = matchProduct(productText);
  if (!product) return '';
  const ship = shippingFeeFor(1);
  const parts = [ship ? `1 sản phẩm ${formatMoney(product.unitPrice)} + ship ${formatMoney(ship)}` : `1 sản phẩm ${formatMoney(product.unitPrice)}`];
  if (product.comboPrice > 0) {
    for (const quantity of [2, 3]) {
      const gift = giftTextFor(quantity);
      const comboShip = shippingFeeFor(quantity);
      parts.push(`combo ${quantity} sản phẩm ${formatMoney(product.comboPrice * quantity + comboShip)}${gift ? ` (${gift})` : ''}`);
    }
    parts.push(`mua kèm sản phẩm khác cũng được giá combo ${formatMoney(product.comboPrice)}/sản phẩm`);
  }
  return `Dạ ${product.name}: ${parts.join('; ')} ạ.`;
}

/**
 * What the warehouse ships for a priced basket: each product expanded to its
 * components (or itself), then one line per unlocked gift that has a SKU.
 * Prices on product lines are the basket price; gift lines are free.
 */
export function warehouseLines(priced) {
  if (!priced?.priceable) return [];
  const lines = [];
  // Shipping is folded into the product price on the warehouse file — one bag
  // goes out at 189.000đ, not 174.000đ plus a fee line — spread across the
  // shipped units of the first product when there is a fee at all.
  let shippingLeft = priced.shippingFee || 0;
  for (const line of priced.lines) {
    const product = findProductBySku(line.sku);
    const components = product?.components?.length ? product.components : [{ sku: line.sku, quantity: 1 }];
    const unitsPerProduct = components.reduce((sum, component) => sum + component.quantity, 0) || 1;
    for (const component of components) {
      const quantity = component.quantity * line.quantity;
      const part = findProductBySku(component.sku);
      const shipShare = shippingLeft ? money(shippingLeft / quantity) : 0;
      shippingLeft = 0;
      lines.push({
        sku: component.sku,
        quantity,
        // The product's basket price spread evenly over its shipped units.
        price: money((line.basketUnitPrice * line.quantity) / (unitsPerProduct * line.quantity)) + shipShare,
        weight: part?.weight || (component.sku === line.sku ? line.weight : 0)
      });
    }
  }
  for (const gift of priced.gifts) {
    if (!gift.sku) continue;
    lines.push({ sku: gift.sku, quantity: 1, price: 0, weight: gift.weight, gift: true });
  }
  return lines;
}

export { productKeywords };
