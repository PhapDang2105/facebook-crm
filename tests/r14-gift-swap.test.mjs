// Vòng 14 (03/10) — chủ shop: khách muốn đổi quà → bot ghi chú đơn, xin bộ phận phụ trách cho phép đổi sang quà khác và
// nhắn khách sau; KHÔNG hứa "2 gói nhỏ", không hỏi "lấy 2 gói vị nào". Câu khách thật 02/10: "C ko lấy set muỗng dừa nha e",
// "Sao k tặng đồ khác".
import assert from 'node:assert/strict';
import test from 'node:test';
import { Sim, XANH, basket, templates } from './helpers/r13-engine-sim.mjs';
import { ruleIntent } from '../app/processing/rule-intent.mjs';
import { renderChatbotReply } from '../app/chatbot-templates.mjs';

const MIN = 60 * 1000;

test('luật nhận câu đổi quà thật: "không lấy set muỗng", "sao không tặng đồ khác"', () => {
  for (const text of ['C ko lấy set muỗng dừa nha e', 'Sao k tặng đồ khác', 'Ko lấy bát có trừ tiền ko']) {
    assert.equal(ruleIntent(text, {})?.rule, 'GIFT_SWAP', text);
  }
  // Không bắt nhầm câu hỏi quà thường.
  assert.notEqual(ruleIntent('Tặng quạt gì vậy em', {})?.rule, 'GIFT_SWAP');
});

test('mẫu GIFT_SWAP: ghi chú đơn + xin bộ phận phụ trách, không còn hứa 2 gói nhỏ', () => {
  const text = renderChatbotReply({ template_id: 'GIFT_SWAP' }, templates, { customer: { gender: 'female' } }).messages.join(' ');
  assert.match(text, /ghi chú vào đơn hàng/);
  assert.match(text, /bộ phận phụ trách/);
  assert.doesNotMatch(text, /2 gói|vị nào/);
});

test('đang giữ giỏ, khách không lấy quà: ghi chú hồ sơ cho nhân viên + thẻ, không đặt mốc hỏi vị quà thay', async () => {
  const sim = new Sim();
  const inbox = sim.inbox({ gender: 'female', botGender: 'female', pendingOrder: basket([XANH(3)], 2 * MIN), botLastTemplateId: 'ORDER_ADDRESS', botLastReplyAt: Date.now() - 2 * MIN });
  const notes = [];
  const turn = await sim.send(inbox, 'C ko lấy set muỗng dừa nha e', { llm: { template_id: 'GIFT_POLICY' }, extra: { addStaffNote: async (_c, note) => { notes.push(note); } } });
  // Trả lời đổi quà rồi nhắc giỏ đang giữ (giỏ + tổng + xin SĐT/địa chỉ) — ca thật mất đơn 447k vì câu quà cụt.
  const texts = turn.sent.map(item => item.text);
  assert.match(texts[0], /bộ phận phụ trách/, JSON.stringify(texts));
  assert.match(texts.join(' '), /447\.000đ.*số điện thoại/);
  assert.ok(inbox.labels.includes('handoff'));
  assert.equal(notes.length, 1);
  assert.match(notes[0], /Khách muốn đổi quà.*set muỗng/);
  assert.ok(!(Number(inbox.giftSwapAskedAt) > 0), 'không chờ khách chọn vị quà thay');
});

test('khách đã có đơn (24 giờ): ghi chú vào đơn đó', async () => {
  const sim = new Sim();
  const order = { id: 'o-r14', createdAt: Date.now() - 30 * MIN, phone: '0912345678', address: '12 Lê Lợi, Quận 1, TP Hồ Chí Minh', products: [{ name: 'Granola Túi Xanh 450g', sku: 'GRA-XANH-Z450', quantity: 3 }], status: 'Mới' };
  const inbox = sim.inbox({ gender: 'female', botGender: 'female', customerOrders: [order], botLastTemplateId: 'ORDER_CONFIRMATION', botLastReplyAt: Date.now() - 30 * MIN });
  const turn = await sim.send(inbox, 'Sao k tặng đồ khác', { llm: { template_id: 'GIFT_POLICY' } });
  assert.equal(turn.notes.length, 1, JSON.stringify(turn.result));
  assert.equal(turn.notes[0].orderId, 'o-r14');
  assert.match(turn.notes[0].note, /chờ bộ phận phụ trách duyệt/);
});
