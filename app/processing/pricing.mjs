import { canShareBasket, comboKey, findProductBySku, getCatalogProducts, getGifts, getShippingFee, giftsForKey, isFreeShippingGift, largeBasketGiftNote, matchProduct, maxBasketQuantity, maxComboQuantity, normalizeText } from './catalog.mjs';

// The rule, as the business states it: one unit sells at the single price;
// from two units — of the same product or mixed with other products of the
// same mix group — every unit sells at its own product's combo price. Checked
// against every row of the retired 34-line price table: the combo price per
// unit was constant from two upward (298.000/2 = 447.000/3 = 149.000), so one
// number per product is all the table ever encoded. 01/10 (chủ shop): the same
// rule holds for ANY basket size up to maxBasketQuantity — 4 túi 596k, 5 túi
// 740k, 9 túi 1.341k, 2 Vàng + 1 combo 10 gói Cam 477k, Tropical + Vàng 323k —
// so the bot quotes and closes big/mixed baskets itself. Gifts and free
// shipping follow the rules in Cài đặt → Quà tặng.

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

// Ngữ cảnh quà: { livestream } — khách đến từ phiên live mới nhận quà "chỉ khách
// livestream" (catalog.giftsForKey). Mọi hàm tính giỏ/quà dưới đây nhận cùng tuỳ chọn.
/** Shipping charged on a basket: the configured fee unless its combination was given free shipping. */
export function shippingFeeForKey(key, { livestream = false } = {}) {
  return giftsForKey(key, { livestream }).some(isFreeShippingGift) ? 0 : getShippingFee();
}

const unpriceable = (reason, totalQuantity = 0) => ({ priceable: false, reason, total: 0, subtotal: 0, listSubtotal: 0, discount: 0, shippingFee: 0, gift: '', gifts: [], giftNote: '', totalQuantity, lines: [] });

/**
 * Prices a basket of { sku | product | name, quantity }. Returns
 * { priceable, reason, key, subtotal, listSubtotal, discount, shippingFee,
 * total, gift, gifts, giftNote, totalQuantity, lines }. A basket that cannot
 * be priced exactly is handed to a human rather than guessed at:
 * 'unknown-product' / 'bad-quantity' / 'empty' / 'no-price', 'not-a-combo'
 * (products of different mix groups, or a sold-alone product with anything
 * else) and 'too-many' (more than maxBasketQuantity units — wholesale).
 * `listSubtotal` is every unit at its single price ("Tổng giá" of the staff
 * summary), `discount` its gap to `subtotal`; `giftNote` is a staff-only note
 * for basket sizes whose gifts the owner has not confirmed (6–9, >10 units).
 * `livestream: true` (khách từ phiên live) mới tính quà chỉ dành cho khách live.
 */
export function priceBasket(items = [], { livestream = false } = {}) {
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
  // Any size up to maxBasketQuantity is priced; products of different mix
  // groups (Nghệ Lành with a granola bag…) go to a person.
  const key = comboKey(lines);
  if (totalQuantity > maxBasketQuantity) return unpriceable('too-many', totalQuantity);
  if (!canShareBasket(lines.map(line => line.product))) return unpriceable('not-a-combo', totalQuantity);

  let total = 0;
  let listSubtotal = 0;
  const priced = lines.map(line => {
    const unit = unitPriceInBasket(line.product, totalQuantity);
    const lineTotal = money(unit * line.quantity);
    total += lineTotal;
    listSubtotal += money(line.product.unitPrice * line.quantity);
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
  const gifts = giftsForKey(key, { livestream });
  const shippingFee = shippingFeeForKey(key, { livestream });
  return {
    priceable: true,
    reason: '',
    key,
    subtotal: money(total),
    listSubtotal: money(Math.max(listSubtotal, total)),
    discount: money(Math.max(listSubtotal, total) - total),
    shippingFee,
    total: money(total + shippingFee),
    gift: gifts.map(gift => gift.name).join(' + '),
    gifts,
    giftNote: largeBasketGiftNote(totalQuantity),
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
export function buildCatalogPrompt({ compact = false } = {}) {
  // Sản phẩm chỉ CSKH bán (staffOnly) không vào danh mục của mô hình: bot không bán.
  const products = getCatalogProducts().filter(product => product.active && !product.staffOnly);
  if (!products.length) return '';
  // Bản cũ (mặc định): tối đa 6 tên gọi khác, bỏ hashtag, kèm dòng tối đa sản phẩm/đơn.
  if (!compact) {
    return [
      'SẢN PHẨM (tên chuẩn → cách khách gọi):',
      ...products.map(product => {
        const aliases = product.aliases.filter(alias => !alias.startsWith('#')).slice(0, 6);
        return `- ${product.name}${aliases.length ? `: ${aliases.join(', ')}` : ''}`;
      }),
      `Tối đa ${maxBasketQuantity} sản phẩm/đơn.`
    ].join('\n');
  }
  // Chỉ giữ cách gọi MANG THÊM thông tin so với tên chuẩn ("nguyên bản", "nhiều
  // hạt", "gói nhỏ"): cách gọi mà mọi chữ đã có trong tên (+ granola/vị/túi) hay
  // chứa trọn một cách gọi đã giữ thì bỏ; tối đa 4, bỏ hashtag. Không ghi "tối đa
  // N sản phẩm/đơn": giỏ lớn code tự xử lý (ORDER_CUSTOM_BASKET), dòng này chỉ
  // khiến mô hình tự bớt số túi khách đặt.
  const words = value => normalizeText(value).replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter(Boolean);
  return [
    'SẢN PHẨM (tên chuẩn: cách gọi khác):',
    ...products.map(product => {
      const filler = new Set(['granola', 'vi', 'tui']);
      const nameWords = new Set([...words(product.name), ...filler]);
      // So cả dạng viết liền: "ca cao" trong tên "cacao" là cùng một chữ.
      const compact = value => words(value).filter(word => !filler.has(word)).join('');
      const nameCompact = words(product.name).join('');
      const kept = [];
      for (const alias of product.aliases.filter(item => !String(item).startsWith('#'))) {
        const aliasWords = words(alias);
        const aliasCompact = compact(alias);
        if (!aliasWords.length || !aliasCompact || aliasWords.every(word => nameWords.has(word)) || nameCompact.includes(aliasCompact)) continue;
        if (kept.some(previous => aliasCompact.includes(compact(previous)) || compact(previous).includes(aliasCompact))) continue;
        kept.push(alias);
        if (kept.length >= 4) break;
      }
      return `- ${product.name}${kept.length ? `: ${kept.join(', ')}` : ''}`;
    })
  ].join('\n');
}

/**
 * The price ladder of one product for the quote: ×1, then ×2..×maxComboQuantity
 * when it has a combo price. Each rung carries what the template needs —
 * list price at the single rate, the price actually paid, shipping or free
 * shipping for that combination, gifts other than free shipping, total weight.
 */
export function quoteTiers(productText, { livestream = false } = {}) {
  const product = matchProduct(productText);
  // Sản phẩm chỉ CSKH bán: bot không báo giá (mẫu rơi về hỏi sản phẩm; engine chuyển nhân viên trước).
  if (!product || product.staffOnly) return null;
  const tiers = [];
  const top = product.comboPrice > 0 ? maxComboQuantity : 1;
  for (let quantity = 1; quantity <= top; quantity += 1) {
    const key = comboKey([{ sku: product.sku, quantity }]);
    const gifts = giftsForKey(key, { livestream });
    const shippingFee = shippingFeeForKey(key, { livestream });
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
    // Quà có trần số lượng (Quà Tặng LIVE chỉ cho đúng 2 túi): ghi "đúng N" / "từ N đến M" cho mô hình khỏi hiểu là "từ N trở lên".
    const range = gift.maxQuantity && gift.maxQuantity === gift.minQuantity ? `đúng ${gift.minQuantity} sản phẩm`
      : gift.maxQuantity && gift.maxQuantity > gift.minQuantity ? `từ ${gift.minQuantity} đến ${gift.maxQuantity} sản phẩm`
      : `từ ${gift.minQuantity} sản phẩm`;
    // Quà chỉ khách livestream: ghi rõ cho mô hình/GIFT_POLICY, khỏi hứa quà live với khách thường.
    const rule = `${range}${excluded.length ? ` (trừ ${excluded.join(', ')})` : ''}${gift.livestreamOnly ? ' (chỉ khách livestream)' : ''}`;
    groups.set(rule, [...(groups.get(rule) || []), gift.name]);
  }
  if (!groups.size) return ['- Hiện chưa có quà tặng.'];
  return [...groups.entries()].map(([rule, names]) => `- ${names.join(' + ')}: ${rule}`);
}
