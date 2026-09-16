import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

process.env.CUSTOMER_FILE_PATH = path.join(mkdtempSync(path.join(tmpdir(), 'customer-file-')), 'customer-file.json');
const { customersFromExport, recordExportedOrders, listExportedCustomers, orderedAtFromLabel } = await import('../app/customer-file.mjs');
const { buildCustomers } = await import('../app/customers.mjs');

const headers = ['Nguồn đơn', 'Ngày', 'Mã đơn hàng', 'Khách hàng', 'Số điện thoại', 'Nhà mạng', 'Địa chỉ', 'Tỉnh/Thành phố', 'Quận/Huyện', 'Phường/Xã', 'Sản phẩm', 'Mã mẫu mã', 'Số lượng', 'Đơn giá', 'Ghi chú'];
const exportedAt = new Date(2026, 8, 16, 15, 0).getTime();
const orderData = {
  headers,
  rows: [
    ['Landing page', '16/09 07:52', 'LP-aaa11111', 'Chị Mai', '0909 123 456', 'Mobifone', '12 Lê Lợi, Phường Bến Nghé, Quận 1, TP Hồ Chí Minh', 'TP Hồ Chí Minh', 'Quận 1', 'Phường Bến Nghé', 'Granola Túi Xanh 450g', 'GRA-XANH-Z450', '2', '149000', ''],
    ['Landing page', '16/09 07:52', 'LP-aaa11111', 'Chị Mai', '0909123456', 'Mobifone', '12 Lê Lợi, Phường Bến Nghé, Quận 1, TP Hồ Chí Minh', 'TP Hồ Chí Minh', 'Quận 1', 'Phường Bến Nghé', 'Granola Túi Vàng 350g', 'GRA-VANG-H350', '1', '149000', ''],
    ['Chatbot', '15/09 20:10', 'CB-bbb22222', 'Anh Dũng', '0385805790', 'Viettel', 'Xã Thanh Cao, Huyện Lương Sơn, Hòa Bình', 'Hòa Bình', 'Huyện Lương Sơn', 'Xã Thanh Cao', 'Granola Túi Xanh 450g', 'GRA-XANH-Z450', '1', '189000', ''],
    ['Import', '', '', 'Không số', '', '', 'Đâu đó', '', '', '', 'Granola Túi Xanh 450g', 'GRA-XANH-Z450', '1', '189000', '']
  ]
};

test('gom dòng xuất thành khách theo số điện thoại, mỗi đơn nhiều dòng sản phẩm; dòng không số bị bỏ', () => {
  const people = customersFromExport(orderData, exportedAt);
  assert.deepEqual(people.map(person => person.phone), ['0909123456', '0385805790']);
  const mai = people[0];
  assert.equal(mai.name, 'Chị Mai');
  assert.equal(mai.ward, 'Phường Bến Nghé');
  assert.equal(mai.orders.length, 1, 'hai dòng cùng mã là một đơn');
  assert.deepEqual(mai.orders[0].products.map(item => [item.sku, item.quantity, item.price]), [['GRA-XANH-Z450', 2, 149000], ['GRA-VANG-H350', 1, 149000]]);
  assert.equal(mai.orders[0].total, 447000);
  assert.equal(mai.orders[0].orderedAt, new Date(2026, 8, 16, 7, 52).getTime(), 'ngày đặt đọc từ cột Ngày, năm suy ra từ lúc xuất');
  assert.equal(orderedAtFromLabel('', exportedAt), exportedAt);
});

test('ghi tệp: xuất lại cùng đơn không nhân đôi, giữ mốc xuất lần đầu', async () => {
  const first = await recordExportedOrders(orderData, exportedAt);
  assert.deepEqual(first, { customers: 2, orders: 2 });
  await recordExportedOrders(orderData, exportedAt + 3600000);
  const people = await listExportedCustomers();
  assert.equal(people.length, 2);
  const mai = people.find(person => person.phone === '0909123456');
  assert.equal(mai.orders.length, 1);
  assert.equal(mai.orders[0].exportedAt, exportedAt, 'mốc xuất lần đầu được giữ');
  assert.equal(mai.lastExportedAt, exportedAt + 3600000);
});

test('màn Khách hàng: khách xuất khớp số với khách Facebook thì cộng đơn (không cộng lại đơn chatbot đã có), còn không thì là khách riêng', async () => {
  const page = '100000000000001';
  const store = {
    conversations: [
      { id: `${page}:77`, pageId: page, psid: '77', name: 'Trần Văn Hùng', source: 'inbox', labels: [], createdAt: 2000, lastMessageAt: 3000,
        customerOrders: [{ id: 'bbb22222', phone: '0385805790', address: 'Xã Thanh Cao', total: 189000, createdAt: 2500, products: [{ sku: 'GRA-XANH-Z450', name: 'Granola Túi Xanh 450g', quantity: 1 }] }] }
    ],
    messages: {}
  };
  const exported = await listExportedCustomers();
  const customers = buildCustomers(store, [{ id: page, name: 'Giọt Nắng' }], exported);
  const hung = customers.find(customer => customer.psid === '77');
  assert.equal(hung.orderCount, 1, 'đơn CB-bbb22222 đã có từ hội thoại, không cộng thêm');
  assert.ok(hung.sources.includes('export'));
  const mai = customers.find(customer => customer.phone === '0909123456');
  assert.ok(mai, 'khách landing chưa từng nhắn tin vẫn có mặt');
  assert.equal(mai.id, 'export:0909123456');
  assert.equal(mai.name, 'Chị Mai');
  assert.equal(mai.orderCount, 1);
  assert.equal(mai.orderTotal, 447000);
  assert.equal(mai.comboMax, 3);
  assert.deepEqual(mai.lastOrderProducts.map(item => item.sku), ['GRA-XANH-Z450', 'GRA-VANG-H350']);
  assert.deepEqual(mai.sources, ['export']);
});
