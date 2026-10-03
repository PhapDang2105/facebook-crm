// Tối ưu chatbot (B3): đang giữ 2 Xanh, khách "thêm 1 túi nâu 1 túi nguyên bản" → hỏi Xanh/Vàng mà KHÔNG mất 1 Nâu;
// trả lời "xanh" → giỏ 3 Xanh + 1 Nâu. Giỏ chờ giữ các cờ khác của giỏ cũ.
import assert from 'node:assert/strict';
import test from 'node:test';
import { templates, XANH, NAU, basket } from './helpers/r13-engine-sim.mjs';
import { renderChatbotReply } from '../app/chatbot-templates.mjs';

const lines = items => (items || []).map(item => `${item.code}=${item.quantity}`).sort();

test('B3: thêm 1 Nâu + 1 nguyên bản vào giỏ 2 Xanh, trả lời "xanh" → Xanh×3 + Nâu×1', () => {
  const now = Date.now();
  const pending = basket([XANH(2)], 30000, { wantsPrevious: true, livestream: true, fromComment: true, staffCheck: 'soát', awaitingConfirm: true });
  const r1 = renderChatbotReply({ template_id: 'ORDER_ADDRESS', Product_N1: 'Granola Túi Nâu', No_A: '1' }, templates,
    { pendingOrder: pending, lastTemplateId: 'ORDER_ADDRESS', messageText: 'thêm 1 túi nâu 1 túi nguyên bản', now });
  assert.equal(r1.templateId, 'ASK_FLAVOR_NGUYENBAN');
  assert.deepEqual(lines(r1.pendingOrder.items), ['GRA-NAU-Z350=1', 'GRA-XANH-Z450=2']);
  assert.equal(r1.pendingOrder.nguyenBanAsk, 1);
  for (const flag of ['wantsPrevious', 'livestream', 'fromComment']) assert.equal(r1.pendingOrder[flag], true, flag);
  assert.equal(r1.pendingOrder.staffCheck, 'soát');
  assert.equal(r1.pendingOrder.awaitingConfirm, undefined);

  const r2 = renderChatbotReply({ template_id: 'ORDER_ADDRESS', Product_N1: 'Granola Túi Xanh', No_A: '1' }, templates,
    { pendingOrder: r1.pendingOrder, lastTemplateId: 'ASK_FLAVOR_NGUYENBAN', messageText: 'xanh', now });
  assert.deepEqual(lines(r2.pendingOrder.items), ['GRA-NAU-Z350=1', 'GRA-XANH-Z450=3']);
});

test('B3: không có "thêm" — giỏ chờ chỉ là phần đã nói rõ (như cũ)', () => {
  const now = Date.now();
  const r = renderChatbotReply({ template_id: 'ORDER_ADDRESS', Product_N1: 'Granola Túi Nâu', No_A: '1' }, templates,
    { pendingOrder: basket([XANH(2)]), lastTemplateId: 'ORDER_ADDRESS', messageText: '1 túi nâu 1 túi nguyên bản', now });
  assert.equal(r.templateId, 'ASK_FLAVOR_NGUYENBAN');
  assert.deepEqual(lines(r.pendingOrder.items), ['GRA-NAU-Z350=1']);
});

test('B3: thêm cùng mã đang giữ thì cộng số lượng', () => {
  const now = Date.now();
  const r = renderChatbotReply({ template_id: 'ORDER_ADDRESS', Product_N1: 'Granola Túi Nâu', No_A: '1' }, templates,
    { pendingOrder: basket([NAU(1)]), lastTemplateId: 'ORDER_ADDRESS', messageText: 'thêm 1 túi nâu 1 túi nguyên bản', now });
  assert.deepEqual(lines(r.pendingOrder.items), ['GRA-NAU-Z350=2']);
});
