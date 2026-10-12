// Vòng 18 (12/10) — GÓI A: quà trong giỏ — khách live không lấy quạt (kể cả "đổi quà khác", chữ "kh"), không tra đơn khi đang giữ giỏ.
// Câu khách thật trong S\r18\out-inbox3.md N2, out-inbox4.md N4, out-comment.md B9 (đã che tên/SĐT; SĐT giả PHONE).
import assert from 'node:assert/strict';
import test from 'node:test';
import { Sim, PHONE, XANH, VANG, NAU, basket } from './helpers/r13-engine-sim.mjs';
import { isFanToSpoonRequest } from '../app/processing/rule-intent.mjs';
import { FAN_DECLINE_GIFTS, fanToSpoonGifts } from '../app/chatbot-engine.mjs';

const MIN = 60000;
const said = turn => turn.sent.map(item => item.text).join('\n');
const skus = list => (list || []).map(item => `${item.quantity} ${item.sku}`).sort();

test('R18 A: isFanToSpoonRequest nhận "kh lấy quạt", "k lấy quạt. Đổi quà khác đc k", "đổi quạt lấy bát"; vẫn không nhận xin gói nhỏ / trừ tiền / bỏ cả bát', () => {
  for (const text of ['Chị kh lấy quạt đổi cho c bát gáo dừa đc ko', 'Chị k lấy quạt. Đổi quà khác đc k', 'Thêm cho c một bát gáo dừa nữa. C kh lấy quạt đc kh', 'đổi quạt lấy bát gáo dừa nha']) {
    assert.equal(isFanToSpoonRequest(text), true, text);
  }
  for (const text of ['ko lấy quạt, đổi 2 gói nhỏ nha', 'ko lấy quạt thì trừ tiền được ko', 'ko lấy bát và quạt', 'đổi quạt sang yến mạch được không']) {
    assert.equal(isFanToSpoonRequest(text), false, text);
  }
});

test('R18 A: quà sau khi bỏ quạt — hằng FAN_DECLINE_GIFTS (mặc định: combo 2 → 1 Bát; live 3 túi → Bát + Muỗng, không thêm bát)', () => {
  assert.deepEqual([...FAN_DECLINE_GIFTS.two], ['BGD']);
  assert.deepEqual([...FAN_DECLINE_GIFTS.threePlus], ['BGD', 'MUONG']);
  assert.deepEqual(skus(fanToSpoonGifts([], { bags: 2 })), ['1 BGD']);
  assert.deepEqual(skus(fanToSpoonGifts([], { bags: 3 })), ['1 BGD', '1 MUONG']);
});

test('R18 A inbox3 N2 / comment B9 (…0645476): live combo 2 Vàng + Nâu, "Chị k lấy quạt. Đổi quà khác đc k" → tự đổi 1 Bát gáo dừa; đơn chốt KHÔNG có Quạt', async () => {
  const sim = new Sim({ psid: 'r18a-quat2' });
  const inbox = sim.inbox({ labels: ['livestream'], botLastTemplateId: 'ORDER_ADDRESS', botLastReplyAt: Date.now() - MIN, pendingOrder: basket([VANG(1), NAU(1)], MIN, { livestream: true }) });
  const turn = await sim.send(inbox, 'Chị k lấy quạt. Đổi quà khác đc k', { llm: { template_id: 'GIFT_SWAP' } });
  assert.equal(turn.result.templateId, 'ORDER_ADDRESS_REMIND', said(turn));
  assert.match(said(turn), /Bộ bát gáo dừa/u);
  assert.deepEqual(skus(inbox.pendingOrder?.giftOverride), ['1 BGD']);
  const order = await sim.send(inbox, `${PHONE} 12 Lê Lợi, phường Bến Nghé, quận 1, TP Hồ Chí Minh`, { llm: { template_id: 'ORDER_CONFIRMATION', Phone_Number: PHONE, Customer_Address: '12 Lê Lợi, phường Bến Nghé, quận 1, TP Hồ Chí Minh' } });
  assert.equal(order.created.length, 1, said(order));
  const gift = JSON.stringify([order.created[0].gift, order.created[0].giftOverride]);
  assert.doesNotMatch(gift, /Quạt/u, gift);
  assert.match(gift, /bát gáo dừa/iu, gift);
});

test('R18 A inbox4 N4 (…31905717): live 3 túi, "Chị kh lấy quạt đổi cho c bát gáo dừa đc ko" → còn Bát + Muỗng (mặc định); nhắc lại "C kh lấy quạt đc kh" không ra "chưa thấy đơn"; SĐT là SĐT giao hàng', async () => {
  const sim = new Sim({ psid: 'r18a-quat3' });
  const inbox = sim.inbox({ labels: ['livestream'], botLastTemplateId: 'ORDER_ADDRESS', botLastReplyAt: Date.now() - MIN, pendingOrder: basket([XANH(2), VANG(1)], MIN, { livestream: true }) });
  const first = await sim.send(inbox, 'Chị kh lấy quạt đổi cho c bát gáo dừa đc ko', { llm: { template_id: 'GIFT_POLICY' } });
  assert.match(said(first), /đổi quạt/u, said(first));
  assert.deepEqual(skus(inbox.pendingOrder?.giftOverride), ['1 BGD', '1 MUONG']);
  const again = await sim.send(inbox, 'Thêm cho c một bát gáo dừa nữa. C kh lấy quạt đc kh', { llm: { template_id: 'ORDER_STATUS' } });
  assert.doesNotMatch(said(again), /chưa thấy đơn/u, said(again));
  // Câu nói lại quà trùng tin vừa gửi → bạn phụ trách (khách xin thêm bát — chờ chủ shop) hay nhắc quà; không tra đơn.
  assert.ok(['ORDER_ADDRESS_REMIND', 'STAFF_WAIT_OPEN', 'STAFF_WAIT_CLOSED'].includes(again.result.templateId), said(again));
  assert.deepEqual(skus(inbox.pendingOrder?.giftOverride), ['1 BGD', '1 MUONG']);
  const phone = await sim.send(inbox, PHONE, { llm: { template_id: 'ORDER_STATUS' }, extra: { findOrdersByPhone: async () => [] } });
  assert.notEqual(phone.result.templateId, 'ORDER_STATUS_CHECKING', said(phone));
  assert.doesNotMatch(said(phone), /chưa thấy đơn|kiểm tra lại đơn/u, said(phone));
});

test('R18 A inbox4 N4: giữ giỏ, chưa có đơn, mô hình chọn ORDER_STATUS cho câu không hỏi đơn → nhắc giỏ (không "chưa thấy đơn")', async () => {
  const sim = new Sim({ psid: 'r18a-st' });
  const inbox = sim.inbox({ botLastTemplateId: 'ORDER_ADDRESS', botLastReplyAt: Date.now() - MIN, pendingOrder: basket([XANH(2)], MIN) });
  const turn = await sim.send(inbox, 'Gói nhỏ là gì e', { llm: { template_id: 'ORDER_STATUS' } });
  assert.doesNotMatch(said(turn), /chưa thấy đơn/u, said(turn));
});
