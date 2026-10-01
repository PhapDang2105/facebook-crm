import test from 'node:test';
import assert from 'node:assert/strict';
import './helpers/seed-catalog.mjs';
import { normalizeChatbotOrder, normalizeCustomerOrder } from '../app/conversation-orders.mjs';
import {
  ORDER_HISTORY_LIMIT, applyCustomerOrderEdits, describeOrderEdits, orderEditAction, recordOrderHistory, stampOrderCreated
} from '../app/order-edits.mjs';

const hang = { username: 'hang', name: 'Thúy Hằng' };
const manualOrder = () => normalizeCustomerOrder({
  name: 'Chị Mai', phone: '0909123456', address: '12 Lê Lợi, Phường Bến Nghé, Quận 1, TP.HCM',
  products: [{ name: 'Túi Xanh', sku: 'XANH', quantity: 2, price: 149000 }], shippingFee: 30000
}, { now: 1000, id: 'M1' });

test('đơn tạo tay: createdBy = người tạo, lịch sử bắt đầu bằng order.create; không đè người tạo đã có', () => {
  const order = stampOrderCreated(manualOrder(), hang, { at: 1000, summary: 'Tạo đơn tay' });
  assert.deepEqual(order.createdBy, hang);
  assert.deepEqual(order.history, [{ at: 1000, by: hang, action: 'order.create', summary: 'Tạo đơn tay' }]);
  stampOrderCreated(order, { username: 'lan', name: 'Lan' });
  assert.deepEqual(order.createdBy, hang);
  assert.equal(order.history.length, 1);
});

test('đơn bot: createdBy { bot, Chatbot AI } và mục lịch sử tạo đơn', () => {
  const order = normalizeChatbotOrder({ items: [{ product: 'Túi Xanh', quantity: 2 }], phone: '0909 123 456', address: 'Quận 12, TP.HCM', total: 298000 }, { name: 'Lan Anh' }, { now: 2000, id: 'AUTO-01' });
  assert.deepEqual(order.createdBy, { username: 'bot', name: 'Chatbot AI' });
  assert.equal(order.history[0].action, 'order.create');
  assert.deepEqual(order.history[0].by, { username: 'bot', name: 'Chatbot AI' });
});

test('sửa đơn: updatedBy + history; đổi trạng thái → order.status, hủy → order.cancel, sửa giỏ → order.update kèm tóm tắt', () => {
  const order = manualOrder();
  const before = structuredClone(order);
  const changed = applyCustomerOrderEdits(order, { processingStatus: 'confirmed' }, 2000);
  assert.equal(orderEditAction(changed, order), 'order.status');
  assert.equal(describeOrderEdits(before, order, changed), 'trạng thái: Chưa xử lý → Đã xác nhận');
  recordOrderHistory(order, { by: hang, action: orderEditAction(changed, order), summary: describeOrderEdits(before, order, changed), at: 2000 });
  assert.deepEqual(order.updatedBy, hang);
  assert.deepEqual(order.history, [{ at: 2000, by: hang, action: 'order.status', summary: 'trạng thái: Chưa xử lý → Đã xác nhận' }]);

  const beforeCancel = structuredClone(order);
  const cancel = applyCustomerOrderEdits(order, { processingStatus: 'cancelled' }, 3000);
  assert.equal(orderEditAction(cancel, order), 'order.cancel');
  assert.match(describeOrderEdits(beforeCancel, order, cancel), /Đã xác nhận → Khách hủy/);

  const beforeEdit = structuredClone(order);
  const edit = applyCustomerOrderEdits(order, { phone: '0912345678', lines: [{ sku: 'XANH', quantity: 3 }], staffNote: 'gọi lại chiều' }, 4000);
  assert.equal(orderEditAction(edit, order), 'order.update');
  const summary = describeOrderEdits(beforeEdit, order, edit);
  assert.match(summary, /giỏ: 2 .+ → 3 /);
  assert.match(summary, /SĐT/);
  assert.match(summary, /ghi chú xử lý/);
  assert.match(summary, /tổng .+ → /);
  assert.doesNotMatch(summary, /0912345678/, 'không chép SĐT vào lịch sử');
  assert.ok(summary.length <= 200);

  const hide = applyCustomerOrderEdits(order, { hiddenFromTable: true }, 5000);
  assert.equal(orderEditAction(hide, order), 'order.hide');
});

test('lịch sử tối đa 50 mục (giữ mới nhất); đơn cũ không có history vẫn ghi được', () => {
  const legacy = { id: 'OLD', name: 'Khách cũ', total: 100 };
  recordOrderHistory(legacy, { by: hang, action: 'order.update', summary: 'lần 0', at: 0 });
  assert.equal(legacy.history.length, 1);
  for (let index = 1; index < 60; index += 1) recordOrderHistory(legacy, { by: index % 2 ? hang : { username: 'lan', name: 'Lan' }, action: 'order.update', summary: `lần ${index}`, at: index });
  assert.equal(legacy.history.length, ORDER_HISTORY_LIMIT);
  assert.equal(legacy.history[0].summary, 'lần 10');
  assert.equal(legacy.history.at(-1).summary, 'lần 59');
  assert.deepEqual(legacy.updatedBy, hang);
  assert.equal(recordOrderHistory(null, { by: hang }), null);
});
