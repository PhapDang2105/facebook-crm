// Vòng 18 (12/10) — GÓI A: giỏ mới phải THAY giỏ đang giữ (không bị coi là "lặp tin vừa gửi"): "3 túi 3 vị" sau mặc định 3 Xanh,
// "Ok em" sau PRICE_COUNT đã nêu vị. Câu khách thật trong S\r18\out-inbox2.md N7, out-cross.md R4 (đã che tên/SĐT).
import assert from 'node:assert/strict';
import test from 'node:test';
import { Sim, XANH, basket } from './helpers/r13-engine-sim.mjs';
import { distinctKindsCount } from '../app/chatbot-templates.mjs';

const MIN = 60000;
const itemsOf = list => (list || []).map(item => `${item.quantity} ${item.code || item.sku}`).sort();
const said = turn => turn.sent.map(item => item.text).join('\n');
const TRIO = ['1 GRA-NAU-Z350', '1 GRA-VANG-H350', '1 GRA-XANH-Z450'];

test('R18 A inbox2 N7: distinctKindsCount hiểu "Ko chị 3 túi 3 vị", "Chị 3 túi 3 vị khác nhau"; câu hỏi vẫn 0', () => {
  assert.equal(distinctKindsCount('Ko chị 3 túi 3 vị'), 3);
  assert.equal(distinctKindsCount('Chị 3 túi 3 vị khác nhau'), 3);
  assert.equal(distinctKindsCount('3 vị khác nhau không em'), 0);
  assert.equal(distinctKindsCount('3 túi 2 vị nhé'), 0);
});

test('R18 A inbox2 N7 / cross R4 (…8007768513336): "Chị 3 túi" (mặc định 3 Xanh) → "Ko chị 3 túi 3 vị" → giỏ 1 Xanh + 1 Vàng + 1 Nâu, không nhắc giỏ 3 Xanh', async () => {
  const sim = new Sim({ psid: 'r18a-3v' });
  const inbox = sim.inbox({ labels: ['livestream'], botLastTemplateId: 'ASK_FLAVOR', botLastReplyAt: Date.now() - MIN });
  sim.history(inbox, 'incoming', 'Mình combo', 1.2 * MIN);
  sim.history(inbox, 'outgoing', 'Dạ bên em có 3 vị: … Anh muốn lấy vị nào và mỗi vị mấy túi để em lên đơn nha ạ?', MIN, { sender: 'bot' });
  await sim.send(inbox, 'Chị 3 túi');
  assert.deepEqual(itemsOf(inbox.pendingOrder?.items), ['3 GRA-XANH-Z450']);
  const turn = await sim.send(inbox, 'Ko chị 3 túi 3 vị', { llm: { template_id: 'ORDER_ADDRESS' } });
  assert.deepEqual(itemsOf(inbox.pendingOrder?.items), TRIO, said(turn));
  assert.doesNotMatch(said(turn), /3 Granola Túi Xanh/u, said(turn));
  assert.match(said(turn), /442\.000đ/u);
});

test('R18 A inbox2 N7 (…989673): giữ 1 Xanh, bot báo "2 túi … lấy luôn 2 Granola Túi Xanh 450g …?", khách "Ok em" → giỏ 2 Xanh 298k', async () => {
  const sim = new Sim({ psid: 'r18a-okpc' });
  const inbox = sim.inbox({ labels: ['livestream'], botLastTemplateId: 'PRICE_COUNT', botLastReplyAt: Date.now() - 0.5 * MIN, pendingOrder: basket([XANH(1)], 10 * MIN) });
  sim.history(inbox, 'incoming', '2 bịch xanh 450gr là bao nhiêu em?', MIN);
  sim.history(inbox, 'outgoing', 'Dạ 2 túi (Granola Túi Xanh 450g) giá 298.000đ, miễn phí vận chuyển, tặng Quạt ạ 🌾 Chị lấy luôn 2 Granola Túi Xanh 450g để em lên đơn liền cho mình nha?', 0.5 * MIN, { sender: 'bot' });
  const turn = await sim.send(inbox, 'Ok em', { llm: { template_id: 'THANK_YOU' } });
  assert.equal(turn.asked.length, 0, 'không gọi mô hình');
  assert.deepEqual(itemsOf(inbox.pendingOrder?.items), ['2 GRA-XANH-Z450'], said(turn));
  assert.match(said(turn), /298\.000đ/u, said(turn));
});
