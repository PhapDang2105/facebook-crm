import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { tempDir } from './helpers/temp-dir.mjs';

const directory = tempDir('poscontent-');
process.env.POS_COMBOS_PATH = path.join(directory, 'pos-combos.json');

await import('./helpers/seed-catalog.mjs');
const { applyPosContent, applyPosContentToOrders, indexPosOrders, needsPosContent, posItemsToProducts, posPaidTotal } = await import('../app/pos-content-sync.mjs');

const posOrder = (overrides = {}) => ({
  id: 'CRM-ab12', system_id: 777, status: 1, custom_id: 'CRM-ab12',
  inserted_at: '2026-10-01T01:00:00.000000', updated_at: '2026-10-01T01:00:30.000000',
  bill_full_name: 'Nga Nguyen', bill_phone_number: '0904636274',
  shipping_address: { address: '12 Lò Lu', commune_name: 'Phường Trường Thạnh', district_name: 'Thành phố Thủ Đức', province_name: 'TP Hồ Chí Minh', full_address: '12 Lò Lu, Phường Trường Thạnh, Thành phố Thủ Đức, TP Hồ Chí Minh' },
  items: [
    { quantity: 1, variation_info: { display_id: 'CB3-XANH-Z450+BGD+M', name: '3 Granola Xanh', retail_price: 447000 } }
  ],
  shipping_fee: 0, is_free_shipping: true, cod: 447000, total_price: 447000, total_discount: 0,
  ...overrides
});

const crmOrder = (overrides = {}) => ({
  id: 'ab12', name: 'Nga Nguyen', phone: '0904636274', address: '12 Lò Lu, Phường Trường Thạnh, Thành phố Thủ Đức, TP Hồ Chí Minh',
  products: [{ name: 'Granola Xanh', sku: 'GRA-XANH-Z450', quantity: 3, price: 149000 }],
  shippingFee: 0, freeShipping: true, discount: 0, total: 447000,
  createdAt: Date.parse('2026-10-01T01:00:00Z'), updatedAt: Date.parse('2026-10-01T01:00:00Z'),
  pos: { id: 'CRM-ab12', systemId: '777', at: Date.parse('2026-10-01T01:00:05Z') },
  ...overrides
});

test('lần đầu gặp đơn: chỉ ghi dấu nội dung POS, không đè đơn CRM (giỏ túi lẻ ↔ mã combo khác cách ghi)', () => {
  const order = crmOrder();
  const result = applyPosContent(order, posOrder(), { now: 1 });
  assert.deepEqual(result.changed, []);
  assert.equal(result.marked, true);
  assert.equal(order.products[0].sku, 'GRA-XANH-Z450');
  assert.ok(order.posContent?.info && order.posContent?.items);
});

test('lần đầu gặp mà SĐT trên POS đã khác: chép thông tin khách', () => {
  const order = crmOrder();
  const result = applyPosContent(order, posOrder({ bill_phone_number: '0912345678', updated_at: '2026-10-01T03:00:00.000000' }), { now: 1 });
  assert.ok(result.changed.includes('SĐT'));
  assert.equal(order.phone, '0912345678');
});

test('nhân viên sửa trên POS (sau khi đã ghi dấu): SĐT, địa chỉ, giỏ, quà, tổng tiền chép về CRM, có lịch sử', () => {
  const order = crmOrder();
  applyPosContent(order, posOrder(), { now: 1 });
  const edited = posOrder({
    updated_at: '2026-10-01T05:00:00.000000',
    bill_phone_number: '0912345678',
    shipping_address: { address: '99 Võ Văn Ngân', commune_name: 'Phường Linh Chiểu', district_name: 'Thành phố Thủ Đức', province_name: 'TP Hồ Chí Minh', full_address: '99 Võ Văn Ngân, Phường Linh Chiểu, Thành phố Thủ Đức, TP Hồ Chí Minh' },
    items: [
      { quantity: 1, variation_info: { display_id: 'CB2-XANH-Z450', name: '2 Granola Xanh', retail_price: 298000 } },
      { quantity: 1, is_bonus_product: true, variation_info: { display_id: 'BGD', name: 'Bát gáo dừa', retail_price: 0 } }
    ],
    shipping_fee: 20000, is_free_shipping: false, cod: 318000, total_price: 298000
  });
  const result = applyPosContent(order, edited, { now: 2 });
  assert.ok(result.changed.includes('SĐT'));
  assert.ok(result.changed.includes('địa chỉ'));
  assert.ok(result.changed.includes('phí ship'));
  assert.ok(result.changed.some(item => item.startsWith('sản phẩm')));
  assert.equal(order.phone, '0912345678');
  assert.match(order.address, /^99 Võ Văn Ngân/);
  assert.deepEqual(order.products.map(item => [item.sku, item.quantity]), [['GRA-XANH-Z450', 2]], 'mã combo POS tách lại thành túi lẻ');
  assert.equal(order.gift, 'Bát gáo dừa');
  assert.deepEqual(order.giftItems, [{ sku: 'BGD', name: 'Bát gáo dừa', quantity: 1 }]);
  assert.equal(order.shippingFee, 20000);
  assert.equal(order.freeShipping, false);
  assert.equal(order.total, 318000);
  assert.equal(order.history.at(-1).by.name, 'Pancake POS');
  assert.match(order.history.at(-1).summary, /^Sửa trên Pancake POS: /);
  // Lượt sau POS không đổi gì thêm: không chép lại.
  assert.deepEqual(applyPosContent(order, edited, { now: 3 }).changed, []);
});

test('POS đổi ngay sau khi nhân viên sửa trong CRM (CRM vừa PUT sang): chỉ ghi dấu mới, không chép ngược', () => {
  const order = crmOrder();
  applyPosContent(order, posOrder(), { now: 1 });
  order.editedByStaffAt = Date.parse('2026-10-01T05:00:00Z');
  order.phone = '0912345678';
  const pushed = posOrder({ updated_at: '2026-10-01T05:00:10.000000', bill_phone_number: '0912345678', items: [{ quantity: 1, variation_info: { display_id: 'CB2-XANH-Z450', retail_price: 298000 } }], cod: 298000 });
  const result = applyPosContent(order, pushed, { now: 2 });
  assert.deepEqual(result.changed, []);
  assert.equal(result.marked, true);
  assert.equal(order.products[0].quantity, 3, 'giỏ CRM giữ nguyên cách ghi túi lẻ');
});

test('đơn kéo về từ POS (nguồn POS): sửa trên POS ngay sau khi tạo vẫn chép về', () => {
  const order = crmOrder({ id: 'pos777', source: 'POS', pos: { id: '555', systemId: '777', importedAt: 1 } });
  const original = posOrder({ id: '555', custom_id: '' });
  applyPosContent(order, original, { now: 1 });
  const result = applyPosContent(order, posOrder({ id: '555', custom_id: '', updated_at: '2026-10-01T01:01:00.000000', bill_full_name: 'Nga Nguyễn' }), { now: 2 });
  assert.deepEqual(result.changed, ['tên']);
});

test('đơn đã hủy trên POS: không chép nội dung (đồng bộ trạng thái lo)', () => {
  const order = crmOrder();
  assert.deepEqual(applyPosContent(order, posOrder({ status: 6, bill_phone_number: '0912345678' })), { changed: [], marked: false });
});

test('khớp đơn POS ↔ đơn CRM theo mã POS / mã CRM; needsPosContent báo khi chưa có dấu hay dấu khác', () => {
  const orders = [crmOrder(), crmOrder({ id: 'zz', pos: { id: 'CRM-zz' } })];
  const index = indexPosOrders([posOrder()]);
  assert.equal(needsPosContent(orders[0], index), true);
  assert.equal(needsPosContent(orders[1], index), false, 'không có đơn POS khớp');
  const { changedOrders, marked } = applyPosContentToOrders(orders, index);
  assert.equal(changedOrders.length, 0);
  assert.equal(marked, 1);
  assert.equal(needsPosContent(orders[0], index), false);
});

test('tiền khách trả: thu hộ + chuyển khoản; giỏ lẻ giữ giá POS', () => {
  assert.equal(posPaidTotal({ cod: 100000, transfer_money: 200000 }), 300000);
  assert.equal(posPaidTotal({ total_price: 300000, total_discount: 10000, shipping_fee: 20000 }), 310000);
  assert.deepEqual(posItemsToProducts({ items: [{ quantity: 2, variation_info: { display_id: 'GRA-NAU-Z350', name: 'Nâu', retail_price: 150000 } }] }).map(item => [item.sku, item.quantity, item.price]), [['GRA-NAU-Z350', 2, 150000]]);
});
