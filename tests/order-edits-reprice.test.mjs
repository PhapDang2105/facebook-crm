import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
// Danh mục thử nạp TRƯỚC mọi thứ dưới app/ (catalog.mjs chốt đường dẫn lúc nạp).
import './helpers/seed-catalog.mjs';
import { applyCustomerOrderEdits } from '../app/order-edits.mjs';
import { normalizeChatbotOrder, normalizeCustomerOrder } from '../app/conversation-orders.mjs';
import { priceBasket } from '../app/processing/pricing.mjs';
import { reloadCatalog } from '../app/processing/catalog.mjs';

const ADDRESS = 'Số 12 Nguyễn Trãi, Phường Bến Thành, Quận 1, TP Hồ Chí Minh';
const XANH = 'GRA-XANH-Z450';

// Đơn bot như lúc chốt: giá niêm yết từng dòng, giảm combo một dòng riêng, paidPrice = giá khách trả.
function botOrder(items, { livestream = false, promo = '', trial = false } = {}) {
  const priced = priceBasket(items, { livestream });
  const shippingFee = trial ? 0 : priced.shippingFee;
  const input = {
    items: priced.lines.map(line => ({ code: line.sku, quantity: line.quantity })),
    phone: '0909123456', address: ADDRESS,
    total: priced.subtotal + shippingFee, shippingFee, gift: priced.gift,
    ...(promo ? { promoGift: promo } : {}), ...(trial ? { trial: true } : {})
  };
  const conversation = livestream ? { name: 'Khách', post: { message: 'Săn deal hời – live tối nay' } } : { name: 'Khách' };
  return normalizeChatbotOrder(input, conversation, { id: 'r1' });
}
const setQuantity = (order, quantity) => applyCustomerOrderEdits(order, { lines: [{ sku: XANH, name: order.products[0].name, quantity: String(quantity) }] });
const setPrice = (order, price) => applyCustomerOrderEdits(order, { lines: [{ sku: XANH, name: order.products[0].name, price: String(price) }] });
// Tổng khớp với chính các trường tiền của đơn (thứ POS nhận: giá dòng − giảm + ship).
const consistent = order => order.products.reduce((sum, item) => sum + item.price * item.quantity, 0) - order.discount + order.shippingFee;

test('N1 bảng: đơn bot 2 Xanh sửa SL 2→1 → 189.000 (giá lẻ + ship), không giữ giảm combo cũ', () => {
  const order = botOrder([{ sku: XANH, quantity: 2 }]);
  assert.equal(order.total, 298000);
  assert.deepEqual(setQuantity(order, 1), ['lines']);
  assert.equal(order.total, 189000);
  assert.equal(order.discount, 0);
  assert.equal(order.shippingFee, 15000);
  assert.equal(order.freeShipping, false);
  assert.equal(order.products[0].price, 174000);
  assert.equal(order.products[0].paidPrice, 189000, 'ô Đơn giá hiện giá khách trả gồm ship');
  assert.equal(order.gift, '');
  assert.equal(consistent(order), order.total);
});

test('N1 bảng: SL 2→3 → 447.000, giảm = niêm yết − combo, quà theo bảng quà', () => {
  const order = botOrder([{ sku: XANH, quantity: 2 }]);
  setQuantity(order, 3);
  assert.equal(order.total, 447000);
  assert.equal(order.discount, 3 * 174000 - 447000);
  assert.equal(order.shippingFee, 0);
  assert.equal(order.freeShipping, true);
  assert.equal(order.products[0].paidPrice, 149000);
  assert.match(order.gift, /Bộ bát gáo dừa/);
  assert.equal(consistent(order), order.total);
  // Hoàn tác (web chỉ gửi lại số lượng) → về đúng 298.000.
  setQuantity(order, 2);
  assert.equal(order.total, 298000);
  assert.equal(order.discount, 50000);
  assert.equal(consistent(order), order.total);
});

test('N1 bảng: gõ lại ô Đơn giá đúng giá đang hiện (149.000) không đổi gì; gõ giá khác = giá khách trả, không trừ giảm combo lần hai', () => {
  const order = botOrder([{ sku: XANH, quantity: 2 }]);
  assert.deepEqual(setPrice(order, '149.000'), [], 'đúng giá đang hiện thì không tính là sửa');
  assert.equal(order.total, 298000);
  assert.deepEqual(setPrice(order, 140000), ['lines']);
  assert.equal(order.products[0].price, 140000);
  assert.equal(order.products[0].paidPrice, 140000);
  assert.equal(order.discount, 0);
  assert.equal(order.total, 280000);
  assert.equal(consistent(order), order.total);
  // Giá gõ tay giữ qua lần sửa số lượng sau (dòng đó không có giảm combo).
  setQuantity(order, 3);
  assert.equal(order.total, 420000);
  assert.equal(consistent(order), order.total);
});

test('N1 bảng: 1 túi gõ Đơn giá (đã gồm ship) → tổng đúng số gõ, POS nhận giá dòng = gõ − ship', () => {
  const order = botOrder([{ sku: XANH, quantity: 1 }]);
  assert.equal(order.total, 189000);
  setPrice(order, 170000);
  assert.equal(order.total, 170000);
  assert.equal(order.products[0].price, 155000);
  assert.equal(order.shippingFee, 15000);
  assert.equal(consistent(order), order.total);
});

test('N1 bảng: đơn khách live giữ Quà Tặng LIVE khi tính lại; đơn thường thì không', () => {
  const original = readFileSync(process.env.GIFTS_PATH, 'utf8');
  const gifts = JSON.parse(original);
  gifts.items.push({ id: 'qua-tang-live', name: 'Quà Tặng LIVE', active: true, minQuantity: 2, maxQuantity: 2, livestreamOnly: true, excludedSkus: [], sku: 'QUA-TANG-LIVE', weight: 50 });
  writeFileSync(process.env.GIFTS_PATH, JSON.stringify(gifts));
  reloadCatalog();
  try {
    const live = botOrder([{ sku: XANH, quantity: 3 }], { livestream: true });
    assert.equal(live.livestream, true);
    setQuantity(live, 2);
    assert.match(live.gift, /Quà Tặng LIVE/);
    assert.equal(live.total, 298000);
    const normal = botOrder([{ sku: XANH, quantity: 3 }]);
    setQuantity(normal, 2);
    assert.doesNotMatch(normal.gift, /Quà Tặng LIVE/);
  } finally {
    writeFileSync(process.env.GIFTS_PATH, original);
    reloadCatalog();
  }
});

test('V3: quà bát gáo dừa bám đuổi (promoGift) bỏ khi giỏ khác 2 túi — cả bảng lẫn form', () => {
  const promo = 'Bộ bát gáo dừa – ưu đãi bám đuổi';
  const table = botOrder([{ sku: XANH, quantity: 2 }], { promo });
  assert.equal(table.promoGift, promo);
  setQuantity(table, 3);
  assert.equal(table.promoGift, undefined);
  assert.doesNotMatch(table.gift, /ưu đãi bám đuổi/);

  const form = botOrder([{ sku: XANH, quantity: 2 }], { promo });
  form.gift = `Miễn phí vận chuyển + ${promo}`;
  applyCustomerOrderEdits(form, { products: [{ name: 'Granola Túi Xanh 450g', sku: XANH, quantity: 1, price: 174000 }], freeShipping: false, shippingFee: 15000, discount: 0 });
  assert.equal(form.promoGift, undefined);
  assert.equal(form.gift, 'Miễn phí vận chuyển');

  // Vẫn 2 túi (đổi vị) → giữ quà.
  const keep = botOrder([{ sku: XANH, quantity: 2 }], { promo });
  applyCustomerOrderEdits(keep, { lines: [{ sku: XANH, product: 'GRA-VANG-H350' }] });
  assert.equal(keep.promoGift, promo);
  assert.match(keep.gift, /ưu đãi bám đuổi/);
});

test('N1: đơn dùng thử 1 túi miễn ship giữ miễn ship khi gõ lại giá', () => {
  const order = botOrder([{ sku: XANH, quantity: 1 }], { trial: true });
  assert.equal(order.total, 174000);
  setPrice(order, 170000);
  assert.equal(order.shippingFee, 0);
  assert.equal(order.total, 170000);
});

test('N1: giỏ có SKU ngoài danh mục → giữ cách cũ nhưng giỏ đổi thì bỏ giảm giá cũ', () => {
  const order = normalizeCustomerOrder({ name: 'A', phone: '0909123456', address: ADDRESS, source: 'POS',
    products: [{ name: 'Combo Vàng + Xanh + Nâu', sku: 'CB-VANGG+XANH+NAU', quantity: 1, price: 492000 }], discount: 50000, freeShipping: true }, { id: 'pos1' });
  assert.equal(order.total, 442000);
  applyCustomerOrderEdits(order, { lines: [{ sku: 'CB-VANGG+XANH+NAU', quantity: '2' }] });
  assert.equal(order.discount, 0);
  assert.equal(order.total, 984000);
});
