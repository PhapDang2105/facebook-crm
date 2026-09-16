import { seed } from './helpers/temp-messaging-store.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { buildCustomers, customersToCsv, filterCustomers } from '../app/customers.mjs';

const page = '100000000000001';
const store = {
  conversations: [
    { id: `${page}:55`, pageId: page, psid: '55', name: 'Nguyễn Thị Lan', picture: 'p.jpg', source: 'inbox', gender: 'female', genderSource: 'name', labels: ['new'], createdAt: 1000, lastMessageAt: 5000, lastCustomerMessageAt: 4000, lastMessagePreview: 'ok', referral: { adId: 'ad1', adTitle: 'Granola giảm 20%' }, customerOrders: [{ phone: '0909123456', address: 'Q12', total: 298000 }], customerNotes: [{}], botEnabled: false },
    { id: `${page}:comment:55:${page}_9`, pageId: page, psid: '55', name: 'Lan', source: 'comment', gender: 'female', genderSource: 'staff', labels: ['consulting'], createdAt: 500, lastMessageAt: 9000, lastCustomerMessageAt: 9000, lastMessagePreview: 'giá sao', botEnabled: true },
    { id: `${page}:77`, pageId: page, psid: '77', name: 'Trần Văn Hùng', source: 'inbox', labels: [], createdAt: 2000, lastMessageAt: 3000, lastCustomerMessageAt: 3000, pendingOrder: { phone: '0385805790' } },
    { id: `${page}:${page}`, pageId: page, psid: page, name: 'Trang', source: 'inbox', labels: [], createdAt: 1, lastMessageAt: 1 }
  ],
  messages: { [`${page}:55`]: [{ direction: 'outgoing', createdAt: 900 }, { direction: 'incoming', createdAt: 1200 }] }
};

test('gộp mọi luồng của một người thành một khách hàng, bỏ chính Page', () => {
  const customers = buildCustomers(store, [{ id: page, name: 'Giọt Nắng' }]);
  assert.equal(customers.length, 2);
  const lan = customers[0];
  assert.equal(lan.id, `${page}:55`);
  assert.equal(lan.name, 'Nguyễn Thị Lan', 'inbox name beats the comment name');
  assert.equal(lan.channelName, 'Giọt Nắng');
  assert.deepEqual(lan.sources, ['ads', 'comment']);
  assert.equal(lan.gender, 'female');
  assert.equal(lan.genderSource, 'staff', 'the strongest gender source wins');
  assert.equal(lan.firstContactAt, 500);
  assert.equal(lan.lastMessageAt, 9000);
  assert.equal(lan.lastCustomerMessageAt, 9000);
  assert.equal(lan.phone, '0909123456');
  assert.equal(lan.orderCount, 1);
  assert.equal(lan.orderTotal, 298000);
  assert.deepEqual(lan.labels, ['new', 'consulting']);
  assert.equal(lan.botEnabled, true);
  assert.equal(lan.conversations.length, 2);
  const hung = customers[1];
  assert.equal(hung.phone, '0385805790', 'the basket the bot collected supplies the phone');
  assert.equal(hung.firstContactAt, 2000);
});

test('lọc theo từ khóa không dấu, nguồn, giới tính, thẻ, kênh và số ngày tương tác', () => {
  const customers = buildCustomers(store);
  assert.equal(filterCustomers(customers, { q: 'lan' }).length, 1);
  assert.equal(filterCustomers(customers, { q: '0385' }).length, 1);
  assert.equal(filterCustomers(customers, { q: 'tran van' }).length, 1);
  assert.equal(filterCustomers(customers, { source: 'comment' }).length, 1);
  assert.equal(filterCustomers(customers, { gender: 'female' }).length, 1);
  assert.equal(filterCustomers(customers, { label: 'customer' }).length, 0);
  assert.equal(filterCustomers(customers, { channelId: 'other' }).length, 0);
  // lastMessageAt của hai khách là 9000 và 3000; mốc "now" giả định là 9000.
  assert.equal(filterCustomers(customers, { activeWithin: 1 }, 9000 + 86400000).length, 1);
  assert.equal(filterCustomers(customers, { activeWithin: 1 }, 9000).length, 2);
  assert.equal(filterCustomers(customers, { activeWithin: 0 }, 9000).length, 2, 'bỏ trống thì không lọc');
});

test('CSV cho Excel: BOM, tiêu đề tiếng Việt, ô có dấu phẩy được bọc', () => {
  const csv = customersToCsv(buildCustomers(store));
  assert.ok(csv.startsWith('﻿Tên,ID Facebook,Giới tính'));
  assert.match(csv, /"Quảng cáo, Bình luận"/);
  assert.match(csv, /Nguyễn Thị Lan,55,Nữ/);
});

// --- Remarketing: ai đã mua gì, mua khi nào, mua combo mấy túi ---
const now = Date.UTC(2026, 8, 15);
const day = 86400000;
const shopPage = '100000000000002';
const remarketingStore = {
  conversations: [
    {
      id: `${shopPage}:1`, pageId: shopPage, psid: '1', name: 'Chị Mai', source: 'inbox', labels: [],
      createdAt: 1, lastMessageAt: now - day,
      customerOrders: [
        { createdAt: now - 3 * day, phone: '0909123456', address: 'Quận 7', total: 398000, products: [{ name: 'Granola Nguyên Bản', sku: 'GRA-01', quantity: 2 }] }
      ]
    },
    {
      id: `${shopPage}:2`, pageId: shopPage, psid: '2', name: 'Anh Dũng', source: 'inbox', labels: [],
      createdAt: 1, lastMessageAt: now - day,
      customerOrders: [
        { createdAt: now - 40 * day, phone: '0912345678', address: 'Hà Nội', total: 199000, products: [{ name: 'Yến Mạch Úc', sku: 'YMU-01', quantity: 1 }] },
        { createdAt: now - 60 * day, phone: '0912345678', address: 'Hà Nội', total: 597000, products: [{ name: 'Granola Nguyên Bản', sku: 'GRA-01', quantity: 3 }] }
      ]
    },
    { id: `${shopPage}:3`, pageId: shopPage, psid: '3', name: 'Khách hỏi giá', source: 'inbox', labels: [], createdAt: 1, lastMessageAt: now - day }
  ],
  messages: {}
};

test('gộp sản phẩm đã mua, ngày mua và combo lớn nhất của từng khách', () => {
  const [mai, dung, hoi] = buildCustomers(remarketingStore, []);
  assert.equal(mai.lastOrderAt, now - 3 * day);
  assert.equal(mai.comboMax, 2, 'combo tính theo tổng số túi trong một đơn');
  assert.deepEqual(mai.products.map(item => [item.sku, item.quantity]), [['GRA-01', 2]]);
  assert.equal(dung.comboMax, 3);
  assert.equal(dung.firstOrderAt, now - 60 * day);
  assert.equal(dung.lastOrderAt, now - 40 * day);
  assert.deepEqual(dung.products.map(item => item.sku), ['YMU-01', 'GRA-01'], 'mua gần nhất đứng trước');
  // Cột "Sản phẩm đã mua" trên bảng chỉ lấy đơn gần nhất, không cộng dồn.
  assert.deepEqual(dung.lastOrderProducts.map(item => [item.sku, item.quantity]), [['YMU-01', 1]]);
  assert.equal(dung.lastOrderCombo, 1, 'combo hiển thị theo đơn gần nhất');
  assert.equal(dung.comboMax, 3, 'còn bộ lọc combo vẫn xét mọi đơn');
  assert.deepEqual(mai.lastOrderProducts.map(item => [item.sku, item.quantity]), [['GRA-01', 2]]);
  assert.deepEqual(hoi.lastOrderProducts, []);
  assert.equal(hoi.comboMax, 0);
  assert.deepEqual(hoi.products, []);
});

test('lọc remarketing: mua trong N ngày, theo sản phẩm, theo combo, theo số lần mua', () => {
  const all = buildCustomers(remarketingStore, []);
  const names = filters => filterCustomers(all, filters, now).map(item => item.name);
  assert.deepEqual(names({ orderedWithin: '7' }), ['Chị Mai'], 'chốt đơn trong 7 ngày trước');
  assert.deepEqual(names({ orderedWithin: '90' }), ['Chị Mai', 'Anh Dũng']);
  assert.deepEqual(names({ combo: '2' }), ['Chị Mai', 'Anh Dũng'], 'combo 2 là từ 2 túi trở lên');
  assert.deepEqual(names({ combo: '3' }), ['Anh Dũng']);
  assert.deepEqual(names({ product: 'YMU-01' }), ['Anh Dũng']);
  assert.deepEqual(names({ product: 'granola' }), ['Chị Mai', 'Anh Dũng'], 'khớp cả tên không dấu');
  assert.deepEqual(names({ minOrders: '2' }), ['Anh Dũng']);
  assert.deepEqual(names({ orderedWithin: '7', combo: '3' }), [], 'các bộ lọc cộng dồn');
  assert.deepEqual(names({ q: 'yen mach' }), ['Anh Dũng'], 'tìm kiếm chạm cả sản phẩm đã mua');
});

test('danh sách remarketing đổi số về dạng 84 và bỏ khách chưa có số', async () => {
  const { customersToAudienceCsv } = await import('../app/customers.mjs');
  const csv = customersToAudienceCsv(buildCustomers(remarketingStore, []));
  const lines = csv.replace('﻿', '').trim().split('\r\n');
  assert.deepEqual(lines, ['phone,fn,country', '84909123456,Chị Mai,VN', '84912345678,Anh Dũng,VN']);
});

test('màn Khách hàng chỉ gồm người đã mua, khách mới hỏi giá không lọt vào', async () => {
  const { listCustomers } = await import('../app/customers.mjs');
  seed(remarketingStore);
  const result = await listCustomers({});
  assert.deepEqual(result.items.map(item => item.name), ['Chị Mai', 'Anh Dũng']);
  assert.equal(result.total, 2, 'tổng số cũng chỉ đếm người đã mua');
  assert.ok(buildCustomers(remarketingStore, []).some(customer => customer.orderCount === 0),
    'buildCustomers vẫn giữ cả người chưa mua cho các nơi khác dùng');
});
