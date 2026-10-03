// 02/10 — ca thật Nguyễn Tuyết (live): bình luận "1xanh la" rồi 70 giây sau "2xanh la"; bot nhắn riêng "đơn gồm 2 túi" nhưng giỏ
// hộp thư vẫn 1 túi (inboxBasketFresh chặn ghi đè) → khách gửi SĐT + địa chỉ là chốt đơn 1 túi 189k. Sau đó 83 phút khách nhắn
// "Lấy 2goi xanh chi" → bot mở đơn MỚI xin lại địa chỉ thay vì báo nhân viên sửa đơn.
import assert from 'node:assert/strict';
import test from 'node:test';
import { Sim, PHONE, XANH, basket } from './helpers/r13-engine-sim.mjs';

const MIN = 60 * 1000;
const LIVE_POST = { id: 'live-1', message: 'Săn deal cùng Giọt Nắng ạ' };
const ADDRESS = '647 Tôn Đức Thắng, phường Vĩnh Mỹ, TP Châu Đốc, An Giang';

test('bình luận "1xanh la" rồi "2xanh la": giỏ hộp thư thành 2 túi, khách gửi SĐT + địa chỉ → đơn 2 túi', async () => {
  const sim = new Sim();
  const inbox = sim.inbox({ post: { id: 'ad-1', message: 'Granola túi xanh giòn rụm' } });
  const first = sim.comment({ post: LIVE_POST }, 'c1');
  const one = await sim.send(first, '1xanh la', { llm: { template_id: 'ORDER_ADDRESS', Product_N1: 'Granola Túi Xanh 450g', No_A: '1' } });
  assert.equal(one.result.templateId, 'ORDER_ADDRESS', JSON.stringify(one.result));
  assert.deepEqual(inbox.pendingOrder.items.map(item => [item.code, item.quantity]), [['GRA-XANH-Z450', 1]]);
  assert.equal(inbox.pendingOrder.fromComment, true, 'giỏ hộp thư ghi dấu đến từ bình luận');
  const second = sim.comment({ post: LIVE_POST }, 'c2');
  const two = await sim.send(second, '2xanh la', { llm: { template_id: 'ORDER_ADDRESS', Product_N1: 'Granola Túi Xanh 450g', No_A: '2' } });
  assert.match(two.sent.map(item => item.text).join(' '), /2 Granola Túi Xanh/);
  assert.deepEqual(inbox.pendingOrder.items.map(item => [item.code, item.quantity]), [['GRA-XANH-Z450', 2]], 'bình luận mới hơn thay giỏ cũ do bình luận mang sang');
  const closed = await sim.send(inbox, `${ADDRESS} ${PHONE}`, { llm: { template_id: 'ORDER_CONFIRMATION', Phone_Number: PHONE, Customer_Address: ADDRESS } });
  assert.equal(closed.created.length, 1, JSON.stringify(closed.result));
  assert.deepEqual(closed.created[0].items.map(item => [item.code, item.quantity]), [['GRA-XANH-Z450', 2]]);
});

test('giỏ khách tự nêu TRONG hộp thư vẫn được giữ: bình luận sau đó không ghi đè', async () => {
  const sim = new Sim();
  const inbox = sim.inbox({ botLastTemplateId: 'ORDER_ADDRESS', botLastReplyAt: Date.now() - MIN, pendingOrder: basket([XANH(3)], MIN) });
  const thread = sim.comment({ post: LIVE_POST });
  await sim.send(thread, '1xanh la', { llm: { template_id: 'ORDER_ADDRESS', Product_N1: 'Granola Túi Xanh 450g', No_A: '1' } });
  assert.deepEqual(inbox.pendingOrder.items.map(item => [item.code, item.quantity]), [['GRA-XANH-Z450', 3]]);
});

test('"Lấy 2goi xanh chi" 83 phút sau đơn 1 túi chưa giao: xin đổi đơn → nhân viên (ghi chú + thẻ), không mở đơn mới xin lại địa chỉ', async () => {
  const sim = new Sim({ settings: { ruleIntent: 'off' } });
  const inbox = sim.inbox();
  const order = { id: 'o1', automatic: true, source: 'chatbot', createdAt: Date.now() - 83 * MIN, phone: PHONE, address: ADDRESS, total: 189000, products: [{ name: 'Granola Túi Xanh 450g', sku: 'GRA-XANH-Z450', quantity: 1 }], status: 'Mới' };
  inbox.customerOrders = [order];
  // Giỏ trơn "1 gói nhỏ" nêu sau đơn (không SĐT/địa chỉ riêng) không chặn đường báo nhân viên.
  inbox.pendingOrder = basket([{ product: 'Combo 10 gói Xanh', code: 'CB10-XANH-G35', quantity: 1 }], 2 * MIN);
  const turn = await sim.send(inbox, 'Lấy 2goi xanh chi', { llm: { template_id: 'ORDER_ADDRESS', Product_N1: 'Granola Túi Xanh 450g', No_A: '2' } });
  assert.equal(turn.result.templateId, 'ORDER_CHANGE_STAFF', JSON.stringify(turn.result));
  assert.equal(turn.created.length, 0);
  assert.ok(inbox.labels.includes('handoff'), JSON.stringify(inbox.labels));
  assert.equal(turn.notes.length, 1, JSON.stringify(turn.notes));
  assert.match(turn.notes[0].note, /2 Granola Túi Xanh/);
  // Đối chứng: khách nói rõ "đơn khác" → vẫn là đơn mới (xin địa chỉ).
  const other = new Sim({ settings: { ruleIntent: 'off' }, psid: 'khac' });
  const otherInbox = other.inbox();
  otherInbox.customerOrders = [{ ...order, id: 'o2' }];
  const sep = await other.send(otherInbox, 'Lấy 2 túi xanh đơn khác gửi cho mẹ', { llm: { template_id: 'ORDER_ADDRESS', Product_N1: 'Granola Túi Xanh 450g', No_A: '2' } });
  assert.equal(sep.result.templateId, 'ORDER_ADDRESS', JSON.stringify(sep.result));
});
