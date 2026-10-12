// Vòng 18 — gói D (inbox4 N7, cross R6): ca …86775734 hỏi 3 lần "Tc 10 gói nhỏ nhiêu gr vậy", "10 gói nhỏ nhiêu gr để chị biết tính
// toán ăn" → 3 lần "Túi Xanh nặng 450g, Túi Vàng và Túi Nâu 350g" (mẫu WEIGHT_EXPIRY không có khối lượng Combo 10 gói).
// Mẫu mới (seed; máy chủ áp qua settings-d.json) nêu Combo 10 gói Xanh 10 × 35g, Cam 10 × 30g (products.json: 350g / 300g).
import assert from 'node:assert/strict';
import test from 'node:test';
import { Sim, XANH, basket, templates } from './helpers/r13-engine-sim.mjs';
import { renderChatbotReply } from '../app/chatbot-templates.mjs';

const said = turn => turn.sent.map(item => item.text).join('\n');

test('R18 D inbox4 N7: WEIGHT_EXPIRY nêu khối lượng Combo 10 gói', () => {
  const text = renderChatbotReply({ template_id: 'WEIGHT_EXPIRY' }, templates, {}).messages.join('\n');
  assert.match(text, /Combo 10 gói Xanh gồm 10 gói nhỏ 35g \(350g\)/);
  assert.match(text, /Combo 10 gói Cam gồm 10 gói nhỏ 30g \(300g\)/);
  assert.match(text, /Túi Xanh nặng 450g/);
});

test('R18 D inbox4 N7 (…86775734 "Tc 10 gói nhỏ nhiêu gr vậy" khi đang giữ giỏ): câu trả lời có khối lượng gói nhỏ', async () => {
  const sim = new Sim({ psid: 'r18d-weight' });
  const inbox = sim.inbox({ botLastTemplateId: 'ORDER_ADDRESS', botLastReplyAt: Date.now() - 60000, pendingOrder: basket([XANH(1)], 60000) });
  const turn = await sim.send(inbox, 'Tc 10 gói nhỏ nhiêu gr vậy', { llm: { template_id: 'WEIGHT_EXPIRY' } });
  assert.match(said(turn), /10 gói nhỏ 35g/, said(turn));
});
