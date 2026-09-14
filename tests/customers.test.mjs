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

test('lọc theo từ khóa không dấu, nguồn, giới tính, thẻ, kênh và khoảng thời gian', () => {
  const customers = buildCustomers(store);
  assert.equal(filterCustomers(customers, { q: 'lan' }).length, 1);
  assert.equal(filterCustomers(customers, { q: '0385' }).length, 1);
  assert.equal(filterCustomers(customers, { q: 'tran van' }).length, 1);
  assert.equal(filterCustomers(customers, { source: 'comment' }).length, 1);
  assert.equal(filterCustomers(customers, { gender: 'female' }).length, 1);
  assert.equal(filterCustomers(customers, { label: 'customer' }).length, 0);
  assert.equal(filterCustomers(customers, { channelId: 'other' }).length, 0);
  assert.equal(filterCustomers(customers, { from: 4000 }).length, 1);
  assert.equal(filterCustomers(customers, { to: 4000 }).length, 1);
});

test('CSV cho Excel: BOM, tiêu đề tiếng Việt, ô có dấu phẩy được bọc', () => {
  const csv = customersToCsv(buildCustomers(store));
  assert.ok(csv.startsWith('﻿Tên,ID Facebook,Giới tính'));
  assert.match(csv, /"Quảng cáo, Bình luận"/);
  assert.match(csv, /Nguyễn Thị Lan,55,Nữ/);
});
