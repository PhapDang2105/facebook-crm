// Vòng 18 (12/10) — GÓI A: "Dạ đúng rồi ạ" (CONFIRM_YES) chỉ khi điều khách nói khớp giỏ; không CONFIRM_YES khi không có giỏ.
// Câu khách thật trong S\r18\out-inbox1.md N2 (đã che tên/SĐT).
import assert from 'node:assert/strict';
import test from 'node:test';
import { Sim, XANH, NAU, basket } from './helpers/r13-engine-sim.mjs';

const MIN = 60000;
const said = turn => turn.sent.map(item => item.text).join('\n');
const itemsOf = list => (list || []).map(item => `${item.quantity} ${item.code || item.sku}`).sort();

test('R18 A inbox1 N2 (…28434895759505949 Hoà Lê): giỏ 1 Xanh + 1 Nâu, "Có tặng bát dừa đúng ko ạ" → KHÔNG "Dạ đúng rồi ạ"; nói quà của giỏ (miễn ship) + mời 3 túi có bát', async () => {
  const sim = new Sim({ psid: 'r18a-bat' });
  const inbox = sim.inbox({ botLastTemplateId: 'ORDER_ADDRESS_REMIND', botLastReplyAt: Date.now() - 0.5 * MIN, pendingOrder: basket([XANH(1), NAU(1)], 2 * MIN) });
  const turn = await sim.send(inbox, 'Có tặng bát dừa đúng ko ạ');
  assert.notEqual(turn.record?.rule?.name, 'CONFIRM_SUMMARY');
  assert.doesNotMatch(said(turn), /đúng rồi/u, said(turn));
  assert.match(said(turn), /thêm 1 túi|3 túi/u, said(turn));
  assert.deepEqual(itemsOf(inbox.pendingOrder?.items), ['1 GRA-NAU-Z350', '1 GRA-XANH-Z450']);
});

test('R18 A inbox1 N2: tóm tắt khớp giỏ vẫn "Dạ đúng rồi ạ"; sai tổng tiền / số túi → nhắc đúng giỏ', async () => {
  const ok = new Sim({ psid: 'r18a-ok' });
  const box = ok.inbox({ botLastTemplateId: 'ORDER_ADDRESS', botLastReplyAt: Date.now() - MIN, pendingOrder: basket([XANH(1), NAU(1)], 2 * MIN) });
  const yes = await ok.send(box, '1 xanh 1 nâu 293k miễn ship đúng không');
  assert.equal(yes.record?.rule?.name, 'CONFIRM_SUMMARY');
  assert.match(said(yes), /đúng rồi/u);
  const wrong = new Sim({ psid: 'r18a-wrong' });
  const box2 = wrong.inbox({ botLastTemplateId: 'ORDER_ADDRESS', botLastReplyAt: Date.now() - MIN, pendingOrder: basket([XANH(1), NAU(1)], 2 * MIN) });
  const no = await wrong.send(box2, '3 túi 298k đúng không em');
  assert.doesNotMatch(said(no), /đúng rồi/u, said(no));
  assert.match(said(no), /293\.000đ/u, said(no));
});

test('R18 A inbox1 N2 (…29061089686837574 "Cũng như nhau chứ" sau so giá Shopee): KHÔNG giữ giỏ mà mô hình chọn CONFIRM_YES → gọi lại, không "đúng rồi … gửi SĐT"', async () => {
  const sim = new Sim({ psid: 'r18a-nhau' });
  const inbox = sim.inbox({ botLastTemplateId: 'PRICE_COMPARE', botLastReplyAt: Date.now() - MIN });
  const turn = await sim.send(inbox, 'Cũng như nhau chứ', { llm: (_payload, call) => (call === 1 ? { template_id: 'CONFIRM_YES' } : { template_id: 'PRICE_COMPARE' }) });
  assert.equal(turn.asked.length, 2, 'gọi lại mô hình một lần');
  assert.notEqual(turn.result.templateId, 'CONFIRM_YES', said(turn));
  assert.doesNotMatch(said(turn), /đúng rồi/u, said(turn));
  // Gọi lại vẫn CONFIRM_YES → báo bạn phụ trách, không "đúng rồi".
  const sim2 = new Sim({ psid: 'r18a-nhau2' });
  const box = sim2.inbox({ botLastTemplateId: 'PRICE_COMPARE', botLastReplyAt: Date.now() - MIN });
  const stuck = await sim2.send(box, 'Cũng như nhau chứ', { llm: { template_id: 'CONFIRM_YES' } });
  assert.doesNotMatch(said(stuck), /đúng rồi/u, said(stuck));
  assert.match(String(stuck.result.templateId), /^STAFF_WAIT/u);
});
