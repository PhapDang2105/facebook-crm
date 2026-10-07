import assert from 'node:assert/strict';
import test from 'node:test';
import { backfillPurchaseLabels } from '../app/purchase-labels.mjs';

// 01/10: hội thoại có đơn mà thiếu thẻ "Đã mua hàng" trong CRM (chỉ thẻ CRM, không đụng Pancake).
const now = Date.UTC(2026, 9, 1, 8);
const HOUR = 60 * 60 * 1000;
const labels = ['customer'];
const order = (id, hoursAgo, extra = {}) => ({ id, createdAt: now - hoursAgo * HOUR, status: 'Mới', ...extra });

test('đơn đã có trong hội thoại mà chưa gắn (bot gửi tin lỗi, đơn CRM đẩy POS): gắn bù một lần; nhân viên gỡ thì không gắn lại', () => {
  const store = { conversations: [
    { id: 'p:1', pageId: 'p', psid: '1', labels: ['consulting'], customerOrders: [order('a', 3)] },
    { id: 'p:2', pageId: 'p', psid: '2', labels: [], customerOrders: [order('b', 3, { processingStatus: 'cancelled', status: 'Hủy' })] },
    { id: 'p:3', pageId: 'p', psid: '3', labels: [], customerOrders: [order('c', 40 * 24)] },
    { id: 'p:4', pageId: 'p', psid: '4', labels: [], customerOrders: [order('d', 0.01)] }
  ], messages: {} };
  const changes = backfillPurchaseLabels(store, { orderLabels: labels, now });
  assert.deepEqual(changes.map(change => change.conversation.id), ['p:1']);
  assert.deepEqual(store.conversations[0].labels, ['consulting', 'customer']);
  assert.equal(store.conversations[0].customerOrders[0].purchaseLabeled, true);
  assert.deepEqual(store.conversations[1].labels, [], 'đơn hủy không gắn');
  assert.deepEqual(store.conversations[2].labels, [], 'đơn quá 30 ngày không gắn bù');
  assert.deepEqual(store.conversations[3].labels, [], 'đơn bot vừa tạo: để luồng trả lời tự gắn');
  store.conversations[0].labels = ['consulting'];
  assert.deepEqual(backfillPurchaseLabels(store, { orderLabels: labels, now }), [], 'nhân viên gỡ thẻ: không gắn lại');
});

test('đơn landing: hội thoại có tin khách ghi đúng SĐT (kể cả viết cách/chấm) quanh lúc đặt thì gắn; SĐT khác hay quá xa thì không', () => {
  const store = { conversations: [
    { id: 'p:1', pageId: 'p', psid: '1', labels: [] },
    { id: 'p:2', pageId: 'p', psid: '2', labels: [] },
    { id: 'p:3', pageId: 'p', psid: '3', labels: [] }
  ], messages: {
    'p:1': [{ direction: 'incoming', text: 'sđt chị 0912.345.678 nha', createdAt: now - 4 * HOUR }],
    'p:2': [{ direction: 'outgoing', text: 'Dạ SĐT 0912345678', createdAt: now - 4 * HOUR }, { direction: 'incoming', text: '0987 654 321', createdAt: now - 4 * HOUR }],
    'p:3': [{ direction: 'incoming', text: '0911222333', createdAt: now - 20 * 24 * HOUR }]
  } };
  const landingOrders = [order('L1', 3, { phone: '0912345678' }), order('L2', 3, { phone: '0911222333' }), order('L3', 3, { phone: '0900000000', status: 'Hủy' })];
  const changes = backfillPurchaseLabels(store, { orderLabels: labels, landingOrders, now });
  assert.deepEqual(changes.map(change => change.conversation.id), ['p:1']);
  assert.deepEqual(store.conversations[0].landingLabeled, ['L1']);
  assert.deepEqual(store.conversations[1].labels, [], 'chỉ xét tin KHÁCH gửi; SĐT khác không gắn');
  assert.deepEqual(store.conversations[2].labels, [], 'tin ghi SĐT cách lúc đặt quá 7 ngày không gắn');
  assert.deepEqual(backfillPurchaseLabels(store, { orderLabels: labels, landingOrders, now }), [], 'mỗi đơn landing một lần');
});

test('luồng bình luận không được gắn thẻ (bình luận không cần gắn tag) và thẻ cũ bị xoá', () => {
  const store = { conversations: [
    { id: 'p:1', pageId: 'p', psid: '1', labels: ['customer'], customerOrders: [order('a', 3, { purchaseLabeled: true })] },
    { id: 'p:comment:1:post', source: 'comment', pageId: 'p', psid: '1', labels: ['customer'] },
    { id: 'q:comment:1:post', source: 'comment', pageId: 'q', psid: '1', labels: [] },
    { id: 'p:comment:9:post', source: 'comment', pageId: 'p', psid: '9', labels: [] }
  ], messages: {} };
  const changes = backfillPurchaseLabels(store, { orderLabels: labels, now });
  assert.deepEqual(changes, []);
  assert.deepEqual(store.conversations[1].labels, [], 'bình luận không gắn thẻ');
  assert.deepEqual(store.conversations[2].labels, []);
  assert.deepEqual(store.conversations[3].labels, []);
});

test('không có thẻ nào nhận sự kiện "order" thì không làm gì', () => {
  const store = { conversations: [{ id: 'p:1', labels: [], customerOrders: [order('a', 3)] }], messages: {} };
  assert.deepEqual(backfillPurchaseLabels(store, { orderLabels: [], now }), []);
  assert.equal(store.conversations[0].customerOrders[0].purchaseLabeled, undefined, 'không đánh dấu khi chưa gắn được');
});
