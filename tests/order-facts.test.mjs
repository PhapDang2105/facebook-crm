import test from 'node:test';
import assert from 'node:assert/strict';
import {
  collectOrderFacts, customerKeyOf, daySpan, isCancelledOrder, isDayString, isIncompleteOrder, isValidFact,
  normalizeDayRange, orderSourceKey, shiftDay, sourceLabel, vietnamDayStartMs
} from '../app/order-facts.mjs';
import { isCancelledOrder as campaignsIsCancelled } from '../app/campaigns.mjs';

const at = (date, hour = 10) => Date.parse(`${date}T00:00:00Z`) + (hour - 7) * 60 * 60 * 1000;
const line = (sku, quantity, price, extra = {}) => ({ sku, name: `Túi ${sku}`, quantity, price, ...extra });

test('nguồn đơn: landing, POS, chatbot, nhập tay; nhãn tiếng Việt', () => {
  assert.equal(orderSourceKey({ source: 'Landing page' }), 'landing');
  assert.equal(orderSourceKey({ source: 'Facebook', landing: { page: 'x' } }), 'landing');
  assert.equal(orderSourceKey({ source: 'POS' }), 'pos');
  assert.equal(orderSourceKey({ source: 'Facebook', automatic: true, employee: 'Chatbot AI' }), 'chatbot');
  assert.equal(orderSourceKey({ source: 'Facebook', employee: 'Chatbot AI' }), 'chatbot');
  assert.equal(orderSourceKey({ source: 'Facebook', employee: 'Lan' }), 'import');
  assert.equal(orderSourceKey({ source: 'Shopee' }), 'shopee');
  assert.deepEqual(['chatbot', 'landing', 'pos', 'import'].map(sourceLabel), ['Chatbot', 'Landing page', 'POS', 'Nhập tay']);
  assert.equal(sourceLabel('shopee'), 'shopee');
});

test('luật hủy / bỏ dở dùng chung với Chiến dịch', () => {
  assert.equal(campaignsIsCancelled, isCancelledOrder, 'campaigns.mjs dùng lại đúng hàm này');
  assert.equal(isCancelledOrder({ status: 'Huỷ' }), true);
  assert.equal(isCancelledOrder({ status: 'Form hoàn tất' }), false);
  assert.equal(isIncompleteOrder({ status: 'Chưa hoàn tất' }), true);
  assert.equal(isIncompleteOrder({ landing: { incomplete: true } }), true);
  assert.equal(isIncompleteOrder({ landing: { incomplete: true }, processingStatus: 'confirmed' }), false, 'nhân viên đã gọi xác nhận');
});

test('gom đơn: hội thoại + landing, khử trùng theo mã (giữ bản sửa sau), ngày theo giờ Việt Nam, cũ trước', () => {
  const conversations = [
    { id: 'p:1', pageId: 'p', psid: '1', customerOrders: [
      { id: 'o1', createdAt: at('2026-09-28'), updatedAt: 1, total: 298000, status: 'Mới', source: 'Facebook', automatic: true, employee: 'Chatbot AI', phone: '+84912345678', products: [line('X', 2, 149000)] },
      // 23:30 giờ Việt Nam ngày 27 = 16:30Z: vẫn là ngày 27.
      { id: 'o2', createdAt: at('2026-09-27', 23) + 30 * 60 * 1000, total: 100000, status: 'Hủy', source: 'POS', employee: 'Lan', phone: '0987654321', products: [line('V', 1, 100000)] }
    ] },
    // Cùng mã o1 ở hội thoại khác, bản sửa mới hơn: giữ bản này.
    { id: 'p:2', pageId: 'p', psid: '2', customerOrders: [
      { id: 'o1', createdAt: at('2026-09-28'), updatedAt: 5, total: 447000, status: 'Mới', source: 'Facebook', automatic: true, employee: 'Chatbot AI', phone: '0912345678', products: [line('X', 3, 149000)] }
    ] },
    { id: 'p:3', pageId: 'p', psid: '3' }
  ];
  const landingOrders = [
    { id: 'l1', createdAt: at('2026-09-29', 8), total: 150000, status: 'Chưa hoàn tất', source: 'Landing page', employee: 'Landing page', phone: '84912345678', products: [line('X', 1, 149000)], landing: { incomplete: true, campaign: 'utm_campaign=c1' } },
    { id: 'l2', createdAt: 0, total: 1, products: [] }
  ];
  const facts = collectOrderFacts({ conversations, landingOrders });
  assert.deepEqual(facts.map(fact => fact.id), ['o2', 'o1', 'l1'], 'đơn không có giờ tạo bị bỏ');
  const [o2, o1, l1] = facts;
  assert.equal(o2.dateVN, '2026-09-27');
  assert.equal(o2.cancelled, true);
  assert.equal(o2.source, 'pos');
  assert.equal(o1.total, 447000);
  assert.equal(o1.conversationId, 'p:2');
  assert.equal(o1.source, 'chatbot');
  assert.equal(o1.employee, 'Chatbot AI');
  assert.equal(o1.customerKey, 'phone:0912345678');
  assert.equal(l1.customerKey, 'phone:0912345678', '84… và +84… về cùng một khách');
  assert.equal(l1.incomplete, true);
  assert.equal(l1.utmCampaign, 'c1');
  assert.equal(l1.conversationId, '');
  assert.deepEqual(facts.filter(isValidFact).map(fact => fact.id), ['o1']);
});

test('doanh thu từng dòng chia theo giá khách trả, cộng lại đúng tổng đơn', () => {
  const [fact] = collectOrderFacts({ conversations: [{ id: 'c', customerOrders: [{
    id: 'o', createdAt: at('2026-09-28'), total: 400000, products: [line('X', 2, 149000, { paidPrice: 140000 }), line('V', 1, 159000, { paidPrice: 120000 })]
  }] }] });
  assert.deepEqual(fact.products.map(item => [item.sku, item.quantity]), [['X', 2], ['V', 1]]);
  assert.equal(fact.products.reduce((sum, item) => sum + item.revenue, 0), 400000);
  assert.equal(fact.products[0].revenue, 280000);
  // Không có giá nào: chia theo số lượng.
  const [noPrice] = collectOrderFacts({ landingOrders: [{ id: 'n', createdAt: at('2026-09-28'), total: 100, products: [{ name: 'A', quantity: 1 }, { name: 'B', quantity: 3 }] }] });
  assert.deepEqual(noPrice.products.map(item => item.revenue), [25, 75]);
});

test('khóa khách: SĐT, rồi hội thoại, rồi mã đơn', () => {
  assert.equal(customerKeyOf('0912 345 678'), 'phone:0912345678');
  assert.equal(customerKeyOf('', { pageId: 'p', psid: '9' }, 'o'), 'psid:p:9');
  assert.equal(customerKeyOf('', null, 'o'), 'order:o');
});

test('quy chiến dịch qua callback → campaignId', () => {
  const facts = collectOrderFacts({
    landingOrders: [{ id: 'l', createdAt: at('2026-09-28'), total: 1, source: 'Landing page', landing: { campaign: 'utm_campaign=c9' } }],
    attribute: (order, conversation, fact) => (fact.utmCampaign === 'c9' ? 'c9' : null)
  });
  assert.equal(facts[0].campaignId, 'c9');
});

test('khoảng ngày: kiểm lịch, đổi chỗ khi đảo, cắt khi quá dài', () => {
  assert.equal(isDayString('2026-02-30'), false);
  assert.equal(isDayString('2026-09-29'), true);
  assert.equal(shiftDay('2026-03-01', -1), '2026-02-28');
  assert.equal(daySpan('2026-09-23', '2026-09-29'), 7);
  assert.deepEqual(normalizeDayRange('2026-09-29', '2026-09-01'), { since: '2026-09-01', until: '2026-09-29', days: 29 });
  assert.deepEqual(normalizeDayRange('2020-01-01', '2026-09-29', { maxDays: 366 }), { since: '2025-09-29', until: '2026-09-29', days: 366 });
  assert.equal(normalizeDayRange('x', '2026-09-29'), null);
  assert.equal(vietnamDayStartMs('2026-09-29'), Date.parse('2026-09-28T17:00:00Z'));
});
