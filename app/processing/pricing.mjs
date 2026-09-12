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

function formatMoney(value) {
  return `${money(value).toLocaleString('vi-VN')}đ`;
}

/** One product's prices as a sentence for the model and the price quote. */
export function describeProductPrices(product) {
  if (!product) return '';
  const ship = shippingFeeForKey(comboKey([{ sku: product.sku, quantity: 1 }]));
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
    const mix = product.mixable ? ' Ghép được với sản phẩm ghép khác trong cùng đơn.' : ' Chỉ bán riêng, không ghép với sản phẩm khác.';
    return `- ${product.name} (mã ${product.sku}): ${describeProductPrices(product)}.${mix}${aliases}`;
  });
  return [
    'DANH MỤC SẢN PHẨM (nguồn chính thức, tự cập nhật từ hệ thống — ưu tiên hơn mọi bảng giá khác trong hướng dẫn):',
    ...productLines,
    `Cách tính tiền: đơn có TỔNG từ 2 sản phẩm trở lên thì mỗi sản phẩm tính theo giá combo của chính nó; đơn 1 sản phẩm tính giá lẻ${getShippingFee() ? ` cộng phí vận chuyển ${formatMoney(getShippingFee())} trừ khi tổ hợp được miễn phí vận chuyển` : ''}. Tối đa ${maxComboQuantity} sản phẩm một đơn; nhiều hơn thì chuyển nhân viên.`,
    '',
    'QUÀ TẶNG THEO TỔ HỢP:',
    ...describeGiftTable(),
    '',
    'Khi trả về Product_N1/Product_N2/Product_N3 hãy dùng đúng tên sản phẩm trong danh mục. Khi khách hỏi giá một sản phẩm có trong danh mục, trả về template_id PRICE_QUOTE kèm Product_N1.'
  ].join('\n');
}

/** Reply text for PRICE_QUOTE: one product's prices and gifts, from the catalogue. */
export function renderPriceQuote(productText) {
  const product = matchProduct(productText);
  if (!product) return '';
  const single = comboKey([{ sku: product.sku, quantity: 1 }]);
  const ship = shippingFeeForKey(single);
  const singleGift = giftTextForKey(single);
  const parts = [`1 sản phẩm ${formatMoney(product.unitPrice)}${ship ? ` + ship ${formatMoney(ship)}` : ''}${singleGift ? ` (${singleGift})` : ''}`];
  if (product.comboPrice > 0) {
    for (let quantity = 2; quantity <= maxComboQuantity; quantity += 1) {
      const key = comboKey([{ sku: product.sku, quantity }]);
      const gift = giftTextForKey(key);
      parts.push(`combo ${quantity} sản phẩm ${formatMoney(product.comboPrice * quantity + shippingFeeForKey(key))}${gift ? ` (${gift})` : ''}`);
    }
    if (product.mixable) parts.push(`mua ghép với sản phẩm ghép khác cũng được giá combo ${formatMoney(product.comboPrice)}/sản phẩm`);
  }
  return `Dạ ${product.name}: ${parts.join('; ')} ạ.`;
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
  const groups = new Map();
  for (const combo of listCombos()) {
    const names = (assignments[combo.key] || []).map(id => active.get(id)).filter(Boolean);
    if (!names.length) continue;
    const label = names.join(' + ');
    groups.set(label, [...(groups.get(label) || []), describeComboKey(combo.key)]);
  }
  if (!groups.size) return ['- Hiện chưa có quà tặng.'];
  return [...groups.entries()].map(([label, combos]) => `- ${label}: ${combos.join('; ')}`);
}

