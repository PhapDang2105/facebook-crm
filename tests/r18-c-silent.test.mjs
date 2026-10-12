// Vòng 18 (12/10) — gói C: bot im sai ("nhận đc đồ", hỏi đơn vị vận chuyển). Câu khách thật 10–11/10 (đã che).
import assert from 'node:assert/strict';
import test from 'node:test';
import { Sim, templates } from './helpers/r13-engine-sim.mjs';
import { commentBasket } from '../app/chatbot-engine.mjs';
import { ruleIntent } from '../app/processing/rule-intent.mjs';
import { renderChatbotReply } from '../app/chatbot-templates.mjs';

const MIN = 60 * 1000;
const bot = { sender: 'bot' };
const said = turn => turn.sent.map(item => item.text || '').join('\n');
const inbox = extra => ({ source: 'inbox', botLastTemplateId: '', botLastAgeMin: Infinity, commentBasket, experimentalRules: 'on', ...extra });

test('cross 1.4 (…87024636): "Nay mới nhận đc đồ của shop" → RECEIVED_CHECK, không im vì mô hình chọn cảm ơn', async () => {
  assert.equal(ruleIntent('Nay mới nhận đc đồ của shop', inbox())?.rule, 'RECEIVED_CHECK');
  const sim = new Sim({ psid: 'r18c-87024636' });
  const box = sim.inbox({ labels: ['livestream', 'delivered'], botLastTemplateId: 'ORDER_POSTPONED', botLastReplyAt: Date.now() - 10e3 });
  sim.history(box, 'outgoing', 'Dạ không sao đâu chị 💛 Khi nào tiện chị nhắn em, em lên đơn liền ạ.', 10e3, bot);
  const turn = await sim.send(box, 'Nay mới nhận đc đồ của shop', { llm: { template_id: 'THANK_YOU' } });
  assert.equal(turn.result.templateId, 'RECEIVED_CHECK', JSON.stringify(turn.result));
  assert.ok(turn.sent.length > 0);
});

test('cross R1 (…57714699): "ở thủ đức mấy ngày mới nhận được hàng vậy shop" là hỏi thời gian giao, không RECEIVED_CHECK', () => {
  assert.notEqual(ruleIntent('ở thủ đức mấy ngày mới nhận được hàng vậy shop', inbox())?.rule, 'RECEIVED_CHECK');
  assert.equal(ruleIntent('Chị vừa nhận hàng thấy 2 vị nguyên bản', inbox())?.rule, 'RECEIVED_CHECK');
});

test('inbox3 N4 / cross 1.2 (…4104505): "E gửi qua bên nào nhỉ" sau bảng thời gian giao → SHIPPING_CARRIER (SPX Express), không im', async () => {
  for (const text of ['E gửi qua bên nào nhỉ', 'Ship hãng nào vậy shop', 'đơn vị vận chuyển nào ạ', 'Có gửi GHN không']) assert.equal(ruleIntent(text, inbox())?.rule, 'SHIPPING_CARRIER', text);
  assert.equal(ruleIntent('chị ngại bưu điện và GHN, các dịch vụ khác thì ok', inbox())?.attention, true);
  for (const text of ['Ship Hải phòng bn ngày', 'ship bao nhiêu tiền']) assert.notEqual(ruleIntent(text, inbox())?.rule, 'SHIPPING_CARRIER', text);
  const sim = new Sim({ psid: 'r18c-4104505' });
  const box = sim.inbox({ botLastTemplateId: 'SHIPPING_POLICY', botLastReplyAt: Date.now() - MIN });
  const policy = renderChatbotReply({ template_id: 'SHIPPING_POLICY' }, templates, {});
  sim.history(box, 'incoming', 'Ship Hải phòng bn ngày', 2 * MIN);
  sim.history(box, 'outgoing', policy.messages.join('\n'), MIN, bot);
  const turn = await sim.send(box, 'E gửi qua bên nào nhỉ', { llm: { template_id: 'SHIPPING_POLICY' } });
  assert.equal(turn.result.templateId, 'SHIPPING_CARRIER', JSON.stringify(turn.result));
  assert.match(said(turn), /SPX Express/);
  assert.doesNotMatch(said(turn), /J&T/);
});

test('cross 1.4 (…926962142): tin dài có nội dung mà mô hình hai lần vẫn chỉ "cảm ơn" → STAFF_WAIT + thẻ, không im; tin ngắn vẫn im', async () => {
  const sim = new Sim({ psid: 'r18c-926962142' });
  const box = sim.inbox({ botLastTemplateId: 'WELCOME', botLastReplyAt: Date.now() - 30 * MIN });
  const long = await sim.send(box, 'Ok cảm ơn em. Thật lòng chị thấy mình ghi nhầm địa chỉ và điện thoại chị cũng áy náy lắm, em xem bù tiền ship giúp chị', { llm: { template_id: 'THANK_YOU' } });
  assert.match(String(long.result.templateId || ''), /^STAFF_WAIT_/, JSON.stringify(long.result));
  assert.ok(box.labels.includes('handoff'));
  const sim2 = new Sim({ psid: 'r18c-short' });
  const box2 = sim2.inbox({ botLastTemplateId: 'WELCOME', botLastReplyAt: Date.now() - 30 * MIN });
  const short = await sim2.send(box2, 'Ăn rồi', { llm: { template_id: 'THANK_YOU' } });
  assert.equal(short.result.skipped, 'mô hình cảm ơn tin không phải lời cảm ơn', JSON.stringify(short.result));
});
