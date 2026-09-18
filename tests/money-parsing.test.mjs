import test from 'node:test';
import assert from 'node:assert/strict';
import './helpers/seed-catalog.mjs';
import { normalizeCustomerOrder } from '../app/conversation-orders.mjs';

// Giá tiền VND hay đi kèm dấu chấm ngăn nghìn. Number('149.000') ra 149 chứ
// không phải NaN, nên lỗi này không bao giờ tự lộ ra: đơn vẫn tạo được, chỉ là
// đơn giá tụt xuống một phần nghìn.

test('đọc được chuỗi tiền có dấu chấm ngăn nghìn', () => {
  const order = normalizeCustomerOrder({
    name: 'Chị Mai',
    phone: '0909123456',
    address: 'Số 1, Phường 2, Quận 3, TP Hồ Chí Minh',
    products: [{ name: 'Granola Túi Xanh 450g', quantity: 2, price: '149.000' }]
  }, { now: 1_700_000_000_000, id: 'TEST01' });

  assert.equal(order.products[0].price, 149000, '149.000 phải là một trăm bốn chín nghìn');
  assert.equal(order.total, 298000);
});

test('số nguyên vẫn giữ nguyên, số âm về 0', () => {
  const order = normalizeCustomerOrder({
    name: 'Anh Dũng',
    phone: '0912345678',
    address: 'Số 2, Phường 3, Quận 4, TP Hồ Chí Minh',
    products: [
      { name: 'A', quantity: 1, price: 189000 },
      { name: 'B', quantity: 1, price: -5000 }
    ]
  }, { now: 1_700_000_000_000, id: 'TEST02' });

  assert.equal(order.products[0].price, 189000);
  assert.equal(order.products[1].price, 0, 'giá âm không có nghĩa, kẹp về 0');
});

test('chuỗi rác thành 0 chứ không thành NaN', () => {
  const order = normalizeCustomerOrder({
    name: 'Chị Lan',
    phone: '0987654321',
    address: 'Số 3, Phường 4, Quận 5, TP Hồ Chí Minh',
    products: [{ name: 'C', quantity: 1, price: 'chưa chốt giá' }]
  }, { now: 1_700_000_000_000, id: 'TEST03' });

  assert.equal(order.products[0].price, 0);
  assert.equal(Number.isNaN(order.total), false);
});
