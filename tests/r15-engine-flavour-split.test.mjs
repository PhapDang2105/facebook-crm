// Vòng 15 (03/10) — engine: khách nói "N túi" rồi nêu từng vị trong từng tin riêng (out-inbox1 A1, out-comments A1 — NGHIÊM TRỌNG).
// Ca thật …5962076080: "Chốt chị 2tui" + SĐT + địa chỉ → bot hỏi vị → "Ca cao" (đơn 2 Nâu) → 11 giây sau "Túi vàng" → mô hình
// ORDER_UPDATE sửa thành 1 Vàng 189k. Ca …9280803337: "Lây em 2 túi" → "Túi vàng nhiêu hat" → "Túi nâu cacao". Ý khách: 1 + 1.
import assert from 'node:assert/strict';
import test from 'node:test';
import { Sim, PHONE } from './helpers/r13-engine-sim.mjs';
import { singleFlavourOf } from '../app/chatbot-engine.mjs';

const addr = 'Thôn Trung toàn xã tam quang huyện núi thành tỉnh quang nam';
const codes = items => (items || []).map(item => `${item.quantity} ${item.code || item.sku}`).sort();

test('singleFlavourOf: chỉ nhận tin MỘT vị, không số / không đổi-bỏ-thêm / không câu hỏi / không Tropical', () => {
  assert.equal(singleFlavourOf('Ca cao'), 'nau');
  assert.equal(singleFlavourOf('Túi  vàng'), 'vang');
  assert.equal(singleFlavourOf('Túi vàng nhiêu hat'), 'vang');
  assert.equal(singleFlavourOf('Túi nâu cacao'), 'nau');
  assert.equal(singleFlavourOf('còn túi xanh lá nha'), 'xanh');
  for (const text of ['vâng ạ', 'đổi sang túi vàng', '2 túi vàng', 'túi vàng bao nhiêu', 'túi vàng?', 'thêm túi vàng', 'xanh dương', 'vàng với nâu', 'nguyên bản', 'túi vàng có ngọt không']) {
    assert.equal(singleFlavourOf(text), '', text);
  }
});

test('ca thật …5962076080: "Chốt chị 2tui"+SĐT+địa chỉ → "Ca cao" (đơn 2 Nâu) → "Túi vàng" 11 giây sau = SỬA ĐƠN 1 Nâu + 1 Vàng 293k, không 1 Vàng 189k', async () => {
  const sim = new Sim({ psid: 'r15split1' });
  const inbox = sim.inbox({ labels: ['livestream'] });
  const ask = await sim.send(inbox, `Chốt  chị  2tui\n${PHONE}\n${addr}`, { llm: { template_id: 'ASK_FLAVOR', No_A: '2', Phone_Number: PHONE, Customer_Address: addr } });
  assert.equal(ask.result.templateId, 'ASK_FLAVOR');
  // Số túi khách nêu không còn rơi mất khi mô hình trả ASK_FLAVOR không kèm giỏ chờ.
  assert.equal(inbox.pendingOrder.askedBagCount, 2);
  await sim.send(inbox, 'Hàng  chất  luọng  ok nhe\nCòn  tăng  quà  gì  nữa', { llm: { template_id: 'GIFT_POLICY' } });
  const first = await sim.send(inbox, 'Ca cao', { llm: { template_id: 'ORDER_CONFIRMATION', Product_N1: 'Granola Túi Nâu vị cacao 350g', No_A: '2', Phone_Number: PHONE, Customer_Address: addr } });
  assert.equal(first.result.templateId, 'ORDER_CONFIRMATION');
  assert.deepEqual(codes(first.created[0].items), ['2 GRA-NAU-Z350']);
  assert.equal(inbox.flavourFromCount.count, 2);
  const second = await sim.send(inbox, 'Túi  vàng', { llm: { template_id: 'ORDER_UPDATE', Product_N1: 'Granola Túi Vàng 350g', No_A: '1', Phone_Number: PHONE, Customer_Address: addr } });
  assert.equal(second.result.templateId, 'ORDER_UPDATE', JSON.stringify(second.result));
  assert.equal(second.created.length, 1);
  assert.ok(second.created[0].updateOrderId, 'sửa đúng đơn vừa chốt, không tạo đơn mới');
  assert.deepEqual(codes(second.created[0].items), ['1 GRA-NAU-Z350', '1 GRA-VANG-H350']);
  assert.equal(second.created[0].total, 293000);
  assert.equal(second.asked.length, 0, 'không cần hỏi mô hình');
  assert.doesNotMatch(second.sent.map(item => item.text).join('\n'), /189\.000đ/);
});

test('ca thật …9280803337: "Lây em 2 túi" → "Túi vàng nhiêu hat" → "Túi nâu cacao" = giỏ 1 Vàng + 1 Nâu (không 2 Nâu)', async () => {
  const sim = new Sim({ psid: 'r15split2' });
  const inbox = sim.inbox();
  await sim.send(inbox, 'Lây em 2 túi', { llm: { template_id: 'ASK_FLAVOR' } });
  // Chủ shop 05/10: "2 túi" không vị → mặc định 2 Túi Xanh (trước đây hỏi vị, giỏ chờ askedBagCount 2); vị khách nêu sau đó đổi
  // cả 2 túi (DEFAULT_FLAVOUR_SWAP), vị thứ hai trong 3 phút vẫn tách 1 + 1 như cũ.
  assert.deepEqual(codes(inbox.pendingOrder.items), ['2 GRA-XANH-Z450']);
  const first = await sim.send(inbox, 'Túi vàng nhiêu hat', { llm: { template_id: 'ORDER_ADDRESS', Product_N1: 'Granola Túi Vàng 350g', No_A: '2' } });
  assert.deepEqual(codes(inbox.pendingOrder.items), ['2 GRA-VANG-H350'], JSON.stringify(first.result));
  const second = await sim.send(inbox, 'Túi nâu cacao', { llm: { template_id: 'ORDER_ADDRESS', Product_N1: 'Granola Túi Nâu vị cacao 350g', No_A: '2' } });
  assert.equal(second.result.templateId, 'ORDER_ADDRESS');
  assert.deepEqual(codes(inbox.pendingOrder.items), ['1 GRA-NAU-Z350', '1 GRA-VANG-H350']);
  assert.match(second.sent.map(item => item.text).join('\n'), /1 Granola Túi Vàng 350g \+ 1 Granola Túi Nâu vị cacao 350g|1 Granola Túi Nâu vị cacao 350g \+ 1 Granola Túi Vàng 350g/);
});

test('N ≥ 3 ("3 túi" → "Ca cao" → "Túi vàng"): không đoán cách chia — hỏi lại vị từng túi, giỏ 3 Nâu giữ nguyên', async () => {
  const sim = new Sim({ psid: 'r15split3' });
  const inbox = sim.inbox();
  await sim.send(inbox, 'Cho chị 3 túi', { llm: { template_id: 'ASK_FLAVOR' } });
  await sim.send(inbox, 'Ca cao', { llm: { template_id: 'ORDER_ADDRESS', Product_N1: 'Granola Túi Nâu vị cacao 350g', No_A: '3' } });
  assert.deepEqual(codes(inbox.pendingOrder.items), ['3 GRA-NAU-Z350']);
  const again = await sim.send(inbox, 'Túi vàng', { llm: { template_id: 'ORDER_ADDRESS', Product_N1: 'Granola Túi Vàng 350g', No_A: '3' } });
  assert.equal(again.result.templateId, 'ASK_FLAVOR');
  assert.deepEqual(codes(inbox.pendingOrder.items), ['3 GRA-NAU-Z350']);
  assert.ok(inbox.labels.includes('handoff'));
});

test('quá 3 phút, hay tin có số / chữ đổi: không tách (khách đổi ý thật)', async () => {
  const sim = new Sim({ psid: 'r15split4' });
  const inbox = sim.inbox();
  await sim.send(inbox, 'Lây em 2 túi', { llm: { template_id: 'ASK_FLAVOR' } });
  await sim.send(inbox, 'Túi vàng nhiêu hat', { llm: { template_id: 'ORDER_ADDRESS', Product_N1: 'Granola Túi Vàng 350g', No_A: '2' } });
  const changed = await sim.send(inbox, 'đổi sang túi nâu hết nha', { llm: { template_id: 'ORDER_ADDRESS', Product_N1: 'Granola Túi Nâu vị cacao 350g', No_A: '2' } });
  assert.notEqual(changed.record?.flavourSplit, 'split');
  assert.deepEqual(codes(inbox.pendingOrder.items), ['2 GRA-NAU-Z350']);
  const late = new Sim({ psid: 'r15split5' });
  const box = late.inbox();
  await late.send(box, 'Lây em 2 túi', { llm: { template_id: 'ASK_FLAVOR' } });
  await late.send(box, 'Túi vàng nhiêu hat', { llm: { template_id: 'ORDER_ADDRESS', Product_N1: 'Granola Túi Vàng 350g', No_A: '2' } });
  box.flavourFromCount = { ...box.flavourFromCount, at: Date.now() - 4 * 60 * 1000 };
  await late.send(box, 'Túi nâu cacao', { llm: { template_id: 'ORDER_ADDRESS', Product_N1: 'Granola Túi Nâu vị cacao 350g', No_A: '2' } });
  assert.deepEqual(codes(box.pendingOrder.items), ['2 GRA-NAU-Z350']);
});

test('chặn chung: mô hình sửa đơn làm GIẢM số túi mà tin không có số / không nói bớt → không áp, hỏi lại (ORDER_WRONG) + thẻ', async () => {
  const sim = new Sim({ psid: 'r15guard' });
  const order = { id: 'ord-1', createdAt: Date.now() - 11000, phone: PHONE, address: 'Thôn Trung Toàn, Xã Tam Quang, Huyện Núi Thành, Quảng Nam', total: 288000, products: [{ name: 'Granola Túi Nâu vị cacao 350g', sku: 'GRA-NAU-Z350', quantity: 2 }], status: 'Mới', automatic: true };
  const inbox = sim.inbox({ botLastTemplateId: 'ORDER_CONFIRMATION', botLastReplyAt: Date.now() - 10000, customerOrders: [order] });
  const turn = await sim.send(inbox, 'Túi vàng', { llm: { template_id: 'ORDER_UPDATE', Product_N1: 'Granola Túi Vàng 350g', No_A: '1', Phone_Number: PHONE, Customer_Address: order.address } });
  assert.equal(turn.result.templateId, 'ORDER_WRONG');
  assert.deepEqual(turn.created, []);
  assert.ok(inbox.labels.includes('handoff'));
  // Khách nói rõ số lượng mới → vẫn sửa như thường.
  const sim2 = new Sim({ psid: 'r15guard2' });
  const inbox2 = sim2.inbox({ botLastTemplateId: 'ORDER_CONFIRMATION', botLastReplyAt: Date.now() - 10000, customerOrders: [{ ...order }] });
  const explicit = await sim2.send(inbox2, 'lấy 1 túi vàng thôi', { llm: { template_id: 'ORDER_UPDATE', Product_N1: 'Granola Túi Vàng 350g', No_A: '1', Phone_Number: PHONE, Customer_Address: order.address } });
  assert.equal(explicit.result.templateId, 'ORDER_UPDATE');
});
