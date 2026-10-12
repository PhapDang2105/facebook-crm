// Vòng 18 (12/10) — GÓI A: bình luận chỉ nêu số túi / chỉ hỏi giá KHÔNG ghi đè giỏ hộp thư (giỏ Shop) đã có vị.
// Câu khách thật trong S\r18\out-inbox1.md N6, out-cross.md 4.2, out-comment.md B6 (đã che tên/SĐT).
import assert from 'node:assert/strict';
import test from 'node:test';
import { Sim, XANH, NAU, basket } from './helpers/r13-engine-sim.mjs';

const MIN = 60000;
const X = 'Granola Túi Xanh 450g';
const codes = list => (list || []).map(item => `${item.quantity} ${item.code || item.sku}`).sort();
const texts = turn => turn.sent.map(item => item.text).join('\n');
const LIVE = { id: 'live-1', message: 'Săn Sale 10/10 cùng Giọt Nắng', isLive: true };
const shopCart = (sim, inbox, agoMs) => {
  sim.history(inbox, 'incoming', 'Khách chọn mua từ Facebook Shop: Combo Xanh + Nâu (CB-XANH+NAU) — 293.000đ', agoMs, { cart: [{ sku: 'GRA-XANH-Z450', quantity: 1 }, { sku: 'GRA-NAU-Z350', quantity: 1 }] });
  sim.history(inbox, 'outgoing', 'Dạ đơn của chị gồm 1 Granola Túi Xanh 450g + 1 Granola Túi Nâu vị cacao 350g, tổng 293.000đ …', agoMs - 1000, { sender: 'bot' });
};

test('R18 A inbox1 N6 / cross 4.2 (…2152070455858): giỏ Shop Xanh + Nâu trong hộp thư, bình luận "Cho chị 2 túi" → không "2 Túi Xanh"; giỏ hộp thư giữ Xanh + Nâu', async () => {
  const sim = new Sim({ psid: 'r18a-cmt2' });
  const inbox = sim.inbox({ labels: ['livestream'], botLastTemplateId: 'ORDER_ADDRESS', botLastReplyAt: Date.now() - 7 * MIN, pendingOrder: basket([XANH(1), NAU(1)], 7 * MIN) });
  shopCart(sim, inbox, 7 * MIN);
  const thread = sim.comment({ post: LIVE });
  const turn = await sim.send(thread, 'Cho chị 2 túi', { llm: { template_id: 'ORDER_ADDRESS', Product_N1: X, No_A: '2' } });
  assert.doesNotMatch(texts(turn), /2 Granola Túi Xanh/u, texts(turn));
  assert.deepEqual(codes(inbox.pendingOrder?.items), ['1 GRA-NAU-Z350', '1 GRA-XANH-Z450'], JSON.stringify(inbox.pendingOrder));
});

test('R18 A inbox1 N6 (…9102204765853): giỏ Shop Xanh + Nâu, bình luận "2xanh lá bao nhiêu ạ" (chỉ hỏi giá) → giỏ hộp thư không đổi', async () => {
  const sim = new Sim({ psid: 'r18a-cmtgia' });
  const inbox = sim.inbox({ labels: ['livestream'], botLastTemplateId: 'ORDER_ADDRESS', botLastReplyAt: Date.now() - 5 * MIN, pendingOrder: basket([XANH(1), NAU(1)], 5 * MIN) });
  shopCart(sim, inbox, 5 * MIN);
  const thread = sim.comment({ post: LIVE });
  await sim.send(thread, '2xanh lá bao nhiêu ạ', { llm: { template_id: 'PRICE_QUOTE', Product_N1: X } });
  assert.deepEqual(codes(inbox.pendingOrder?.items), ['1 GRA-NAU-Z350', '1 GRA-XANH-Z450'], JSON.stringify(inbox.pendingOrder));
});

test('R18 A: bình luận NÊU VỊ mới ("1 vàng 1xanh") vẫn ghi đè giỏ Shop cũ hơn như R17 B7', async () => {
  const sim = new Sim({ psid: 'r18a-cmtnew' });
  const inbox = sim.inbox({ labels: ['livestream'], botLastTemplateId: 'ORDER_ADDRESS', botLastReplyAt: Date.now() - 7 * MIN, pendingOrder: basket([XANH(1), NAU(1)], 7 * MIN) });
  shopCart(sim, inbox, 7 * MIN);
  const thread = sim.comment({ post: LIVE });
  await sim.send(thread, '1 vàng 1xanh', { llm: { template_id: 'ORDER_ADDRESS', Product_N1: 'Granola Túi Vàng 350g', No_A: '1', Product_N2: X, No_B: '1' } });
  assert.deepEqual(codes(inbox.pendingOrder?.items), ['1 GRA-VANG-H350', '1 GRA-XANH-Z450']);
});
