import test from 'node:test';
import assert from 'node:assert/strict';
import './helpers/seed-catalog.mjs';
import { buildCustomerOrderConfirmation, normalizeChatbotOrder, normalizeCustomerOrder } from '../app/conversation-orders.mjs';

const input = {
  id: 'QA-1001',
  name: 'Khách kiểm thử',
  phone: '0900 000 000',
  address: 'Địa chỉ kiểm thử',
  products: [{ name: 'Granola Xanh', quantity: 2, price: 149000 }],
  shippingFee: 30000,
  discount: 10000,
  payment: 'COD'
};

test('chuẩn hóa số điện thoại và tự tính tổng đơn', () => {
  const order = normalizeCustomerOrder(input, { now: 1000 });
  assert.equal(order.phone, '0900000000');
  assert.equal(order.total, 318000);
  assert.equal(order.createdAt, 1000);
});

test('không tin tổng tiền do trình duyệt gửi lên', () => {
  const order = normalizeCustomerOrder({ ...input, total: 1 }, { now: 1000 });
  assert.equal(order.total, 318000);
});

test('từ chối số điện thoại sai trước khi gửi Messenger', () => {
  assert.throws(() => normalizeCustomerOrder({ ...input, phone: '0900000000090009000000' }), /Số điện thoại không hợp lệ/);
});

test('nội dung xác nhận có đủ thông tin người nhận và sản phẩm', () => {
  const message = buildCustomerOrderConfirmation(normalizeCustomerOrder(input, { now: 1000 }));
  assert.match(message, /QA-1001/);
  assert.match(message, /Granola Xanh/);
  assert.match(message, /0900000000/);
  assert.match(message, /318\.000đ/);
});

test('chuyển xác nhận chatbot thành đơn tự động', () => {
  const order = normalizeChatbotOrder({
    items: [{ product: 'Túi Xanh', quantity: 2 }],
    phone: '0909 123 456',
    address: 'Quận 12, TP.HCM',
    total: 298000
  }, { name: 'Lan Anh' }, {
    now: 2000,
    id: 'AUTO-01',
    sourceMessageId: 'mid.customer.1',
    deliveryMessageId: 'mid.bot.1'
  });
  assert.equal(order.id, 'AUTO-01');
  assert.equal(order.name, 'Lan Anh');
  assert.equal(order.products[0].sku, 'GRA-XANH-Z450');
  assert.equal(order.products[0].price, 174000, 'dòng đơn ghi giá lẻ từ danh mục');
  assert.equal(order.products[0].paidPrice, 149000, 'giá khách trả là giá combo');
  assert.equal(order.discount, 2 * 174000 - 298000);
  assert.equal(order.shippingFee, 0);
  assert.equal(order.total, 298000);
  assert.equal(order.chatbotSourceMessageId, 'mid.customer.1');
  assert.equal(order.delivery.messageId, 'mid.bot.1');
  assert.equal(order.automatic, true);
});
