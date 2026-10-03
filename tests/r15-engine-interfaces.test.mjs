// Vòng 15 (03/10) — engine: giao diện với agent luật / mẫu (đã mua trên sàn → không bám; cờ luật ứng viên theo từng luật;
// chạy lại giỏ Shop sau khởi động).
import assert from 'node:assert/strict';
import test from 'node:test';
import { Sim, PHONE, XANH, basket } from './helpers/r13-engine-sim.mjs';
import { followUpSkipReason, orderRemindText, boughtOnMarketplace } from '../app/follow-up.mjs';
import { normalizeChatbotSettings, normalizeCandidateRules, mergeChatbotSettingsPatch } from '../app/chatbot-settings.mjs';
import { backlogBotChanges } from '../app/pancake.mjs';
import { candidateModeOf } from '../app/chatbot-engine.mjs';
import { templates } from './helpers/r13-engine-sim.mjs';

const MIN = 60 * 1000;

test('giao diện 1 (inbox3 A2, ca …659307 "Mình đặt của shop trên tiktok rồi"): BOUGHT_ON_MARKETPLACE bỏ giỏ + mốc; bám đuổi không nhắc giỏ, không bám', async () => {
  const sim = new Sim({ psid: 'r15bought' });
  const inbox = sim.inbox({ botLastTemplateId: 'ORDER_ADDRESS', botLastReplyAt: Date.now() - 5 * MIN, pendingOrder: basket([XANH(2)], 5 * MIN) });
  const turn = await sim.send(inbox, 'Mình đặt của shop trên tiktok rồi', { llm: { template_id: 'BOUGHT_ON_MARKETPLACE' } });
  assert.equal(turn.result.templateId, 'BOUGHT_ON_MARKETPLACE');
  assert.equal(inbox.pendingOrder, null);
  assert.ok(Number(inbox.boughtElsewhereAt) > 0);
  const now = Date.now() + 3 * 60 * MIN;
  assert.equal(boughtOnMarketplace(inbox, now), true);
  assert.equal(followUpSkipReason({ inbox, conversation: inbox }, { messages: {} }, { basketHeld: true, now }), 'boughtElsewhere');
  // Giỏ còn sót (luật cũ không bỏ giỏ) cũng không nhắc.
  assert.equal(orderRemindText({ ...inbox, pendingOrder: basket([XANH(2)], 60 * MIN) }, templates, { now: Date.now() }), '');
  // Khách quay lại hỏi mua (bot trả lời chuyện khác sau mốc) → bám đuổi bình thường.
  assert.equal(boughtOnMarketplace({ boughtElsewhereAt: Date.now() - 2 * 60 * MIN, botLastReplyAt: Date.now() - 10 * MIN, botLastTemplateId: 'PRICE_QUOTE' }), false);
});

test('giao diện 3: candidateRules chuỗi HOẶC đối tượng theo từng luật — chuẩn hoá, gộp bản vá, engine truyền nguyên giá trị', async () => {
  assert.equal(normalizeCandidateRules('on'), 'on');
  assert.equal(normalizeCandidateRules('bật'), 'shadow');
  assert.equal(normalizeCandidateRules(undefined), 'shadow');
  assert.deepEqual(normalizeCandidateRules({ K1: 'on', K3: 'on', K4: 'on', K9: 'on', K5: 'bật' }), { K1: 'on', K1b: 'shadow', K3: 'on', K4: 'on', K5: 'shadow' });
  assert.equal(normalizeCandidateRules({ K9: 'on' }), 'shadow');
  assert.equal(normalizeChatbotSettings({}).candidateRules, 'shadow');
  assert.deepEqual(normalizeChatbotSettings({ candidateRules: { K1: 'on' } }).candidateRules, { K1: 'on', K1b: 'shadow', K3: 'shadow', K4: 'shadow', K5: 'shadow' });
  const merged = mergeChatbotSettingsPatch({ candidateRules: { K1: 'on', K1b: 'shadow', K3: 'on', K4: 'shadow', K5: 'shadow' } }, { candidateRules: { K4: 'on' } });
  assert.deepEqual(normalizeChatbotSettings(merged).candidateRules, { K1: 'on', K1b: 'shadow', K3: 'on', K4: 'on', K5: 'shadow' });
  assert.equal(candidateModeOf({ K1: 'on', K1b: 'off' }, 'K1B_SHORT_PRICE_HELD'), 'off');
  assert.equal(candidateModeOf({ K1: 'on' }, 'K1_SHORT_PRICE'), 'on');
  assert.equal(candidateModeOf('on', 'K4_WANT_BUY'), 'on');
  const seen = [];
  const object = { K1: 'on', K1b: 'shadow', K3: 'on', K4: 'on', K5: 'shadow' };
  const sim = new Sim({ psid: 'r15cand', settings: { candidateRules: object } });
  await sim.send(sim.inbox(), 'Bao nhieu tien', { extra: { ruleIntent: (text, ctx) => { seen.push(ctx.candidateRules); return null; } } });
  assert.deepEqual(seen[0], object);
});

test('mục 14 (inbox1 A9): backlog sau khởi động đưa lại tin giỏ Shop (resumeShopCart) khi còn mốc ack < 30 phút và tin cuối là tin ack của bot', () => {
  const now = Date.now();
  const cart = { id: 'm-cart', direction: 'incoming', type: 'text', text: 'Khách chọn mua từ Facebook Shop: Granola (CB-VANGG+XANH) — 298.000đ', cart: [{ sku: 'CB-VANGG+XANH', quantity: 1 }], createdAt: now - 21000 };
  const ack = { id: 'o-ack', direction: 'outgoing', type: 'text', text: 'Dạ em đã nhận giỏ…', sender: 'bot', createdAt: now - 20000 };
  const conversation = { id: 'page:u', pageId: 'page', psid: 'u', botEnabled: true, shopCartAckPendingAt: now - 20000, shopCartAckMessageId: 'm-cart' };
  const changes = backlogBotChanges({ conversations: [conversation], messages: { 'page:u': [cart, ack] } }, { now });
  assert.equal(changes.length, 1);
  assert.equal(changes[0].message.id, 'm-cart');
  assert.equal(changes[0].resumeShopCart, true);
  // Mốc cũ (> 30 phút) hay đã xoá: không đưa lại.
  assert.equal(backlogBotChanges({ conversations: [{ ...conversation, shopCartAckPendingAt: now - 40 * MIN }], messages: { 'page:u': [cart, ack] } }, { now }).length, 0);
  assert.equal(backlogBotChanges({ conversations: [{ ...conversation, shopCartAckPendingAt: 0 }], messages: { 'page:u': [cart, ack] } }, { now }).length, 0);
  // Nhân viên đã nhắn sau giỏ: không đưa lại.
  assert.equal(backlogBotChanges({ conversations: [conversation], messages: { 'page:u': [cart, ack, { id: 's', direction: 'outgoing', type: 'text', text: 'chị ơi', staff: true, createdAt: now - 1000 }] } }, { now }).length, 0);
  assert.ok(PHONE);
});
