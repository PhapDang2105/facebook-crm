// Vòng 18 (12/10) — gói C: đường cứu trước STAFF_WAIT (inbox4 N1). Câu khách thật 11/10 tối (đã che), mã ca rút gọn 8 số cuối.
import assert from 'node:assert/strict';
import test from 'node:test';
import { Sim, templates } from './helpers/r13-engine-sim.mjs';
import { readMergeSplitReply } from '../app/chatbot-engine.mjs';
import { renderChatbotReply } from '../app/chatbot-templates.mjs';

const MIN = 60 * 1000;
const bot = { sender: 'bot' };
const said = turn => turn.sent.map(item => item.text || '').join('\n');

test('inbox4 N1 (…86621283): "Có một loại hay nhiều loại ạ" sau bảng Túi Xanh → bảng 3 vị, không STAFF_WAIT', async () => {
  const sim = new Sim({ psid: 'r18c-86621283' });
  const box = sim.inbox({ botLastTemplateId: 'PRICE_QUOTE', botLastReplyAt: Date.now() - 90e3 });
  const quote = renderChatbotReply({ template_id: 'PRICE_QUOTE', Product_N1: 'Granola Túi Xanh 450g' }, templates, {});
  sim.history(box, 'outgoing', `Dạ em thấy anh/chị để lại bình luận dưới bài viết của Giọt Nắng ạ 💛 ${quote.messages.join('\n')}`, 90e3, bot);
  const turn = await sim.send(box, 'Có một loại hay nhiều loại ạ', { llm: { template_id: 'GENERAL_INFO' } });
  assert.doesNotMatch(String(turn.result.templateId || turn.result.skipped), /STAFF_WAIT|lặp/, JSON.stringify(turn.result));
  assert.equal(turn.result.templateId, 'GENERAL_INFO');
  assert.match(said(turn), /Túi Vàng/);
  assert.match(said(turn), /Túi Nâu/);
});

test('inbox4 N1 (…56145677, khách live): "C mua 2 túi dc tặng bộ bát ko??" ngay sau bảng quà live → quà combo 2 (Quạt) + bát/muỗng từ 3 túi', async () => {
  const sim = new Sim({ psid: 'r18c-56145677' });
  const box = sim.inbox({ labels: ['livestream'], botLastTemplateId: 'GIFT_POLICY_LIVE', botLastReplyAt: Date.now() - MIN });
  const live = renderChatbotReply({ template_id: 'GIFT_POLICY_LIVE' }, templates, { livestream: true, customer: { gender: 'female' } });
  sim.history(box, 'outgoing', live.messages.join('\n'), MIN, bot);
  const turn = await sim.send(box, 'C mua 2 túi dc tặng bộ bát ko??', { llm: { template_id: 'GIFT_POLICY_LIVE' } });
  assert.equal(turn.result.templateId, 'GIFT_POLICY_UPSELL3', JSON.stringify(turn.result));
  assert.match(said(turn), /combo 2 túi .*Quạt/);
  assert.match(said(turn), /từ 3 túi/);
  assert.doesNotMatch(said(turn), /8h|bạn phụ trách/);
});

test('inbox4 N1 (…15103300): "Đơn kia lấy rồi", "Mua thêm" sau câu hỏi đặt thêm → tách đơn mới; gộp / phủ định / câu hỏi thì không', () => {
  for (const text of ['Đơn kia lấy rồi', 'Đơn kia lấy rồi\nĂn rồi\nMua thêm', 'đơn cũ nhận rồi em', 'Mua thêm', 'Đơn trước chị nhận rồi, mua thêm nha']) assert.equal(readMergeSplitReply(text), 'split', text);
  for (const text of ['Ăn rồi', 'không mua thêm', 'gộp vào đơn kia', 'đơn kia nhận rồi hay sao', 'đơn kia chưa nhận']) assert.notEqual(readMergeSplitReply(text), 'split', text);
  assert.equal(readMergeSplitReply('gộp vào đơn kia'), 'merge');
});

test('inbox1 N1 (…28300147, khách live): "Chị xem live chương trình 10/10 voucher thế nào em?" trùng câu voucher vừa gửi → bảng ưu đãi live, không STAFF_WAIT', async () => {
  const sim = new Sim({ psid: 'r18c-28300147', settings: { ruleIntent: 'off' } });
  const box = sim.inbox({ labels: ['livestream'], gender: 'female', botGender: 'female' });
  const first = await sim.send(box, 'Bên mik có voucher j ko chị', { llm: { template_id: 'LIVESTREAM_VOUCHER' } });
  assert.equal(first.result.templateId, 'LIVESTREAM_VOUCHER', JSON.stringify(first.result));
  const again = await sim.send(box, 'Chị xem live chương trình 10/10 voucher thế nào em?', { llm: { template_id: 'LIVESTREAM_VOUCHER' } });
  assert.equal(again.result.templateId, 'GIFT_POLICY_LIVE', JSON.stringify(again.result));
  assert.match(said(again), /Quạt/);
});
