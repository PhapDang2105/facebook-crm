// Vòng 18 (12/10) — GÓI A: đếm túi — "2 túi lớn vàng", "5b" (viết tắt bịch) khi mặc định Túi Xanh.
// Câu khách thật trong S\r18\out-inbox2.md N1 (đã che tên/SĐT/địa chỉ; SĐT giả PHONE).
import assert from 'node:assert/strict';
import test from 'node:test';
import { Sim, PHONE } from './helpers/r13-engine-sim.mjs';
import { bagCountInText, commentBasket } from '../app/chatbot-engine.mjs';

const MIN = 60000;
const itemsOf = list => (list || []).map(item => `${item.quantity} ${item.code || item.sku}`).sort();
const said = turn => turn.sent.map(item => item.text).join('\n');

test('R18 A inbox2 N1: bộ đọc giỏ / đếm túi hiểu "2 túi lớn vàng", "2 túi to xanh", "5b", "6t"', () => {
  assert.deepEqual(commentBasket('Lấy 2 túi lớn vàng 298k'), [{ product: 'Granola Túi Vàng 350g', quantity: 2 }]);
  assert.deepEqual(commentBasket('cho chị 2 túi to xanh'), [{ product: 'Granola Túi Xanh 450g', quantity: 2 }]);
  assert.equal(bagCountInText('Gửi c 5b nha e'), 5);
  assert.equal(bagCountInText('6t nha'), 6);
  assert.equal(bagCountInText('2 túi xanh'), 2);
});

test('R18 A inbox2 N1 (…770718): khách live "Lấy 2 túi lớn vàng 298k" → giỏ 2 Túi Vàng 298k (không 1 túi 189k)', async () => {
  const sim = new Sim({ psid: 'r18a-lon' });
  const inbox = sim.inbox({ labels: ['livestream'], botLastTemplateId: 'GIFT_POLICY_LIVE', botLastReplyAt: Date.now() - MIN });
  const turn = await sim.send(inbox, 'Lấy 2 túi lớn vàng 298k');
  assert.deepEqual(itemsOf(inbox.pendingOrder?.items), ['2 GRA-VANG-H350'], said(turn));
  assert.match(said(turn), /298\.000đ/u);
});

test('R18 A inbox2 N1 (…423891): sau câu hỏi vị, khách cũ "Gửi c 5b nha e" (mô hình lên đơn) → mặc định 5 Túi Xanh, không 1 túi', async () => {
  const sim = new Sim({ psid: 'r18a-5b' });
  const inbox = sim.inbox({ botLastTemplateId: 'ASK_FLAVOR', botLastReplyAt: Date.now() - 9 * 60 * MIN });
  sim.history(inbox, 'incoming', 'Gửi c 1b nữa nha e', 9 * 60 * MIN + 1000);
  sim.history(inbox, 'outgoing', 'Dạ bên em có 3 vị: Túi Xanh nguyên bản 450g, Túi Vàng nhiều hạt 350g và Túi Nâu cacao 350g; … Chị muốn lấy vị nào và mỗi vị mấy túi để em lên đơn nha ạ?', 9 * 60 * MIN, { sender: 'bot' });
  const turn = await sim.send(inbox, 'Gửi c 5b nha e', { llm: { template_id: 'ORDER_CONFIRMATION', Product_N1: 'Granola Túi Xanh 450g', No_A: '1', Phone_Number: PHONE, Customer_Address: 'Số 52 đường A, phường Hắc Dịch, Bà Rịa - Vũng Tàu' } });
  assert.deepEqual(itemsOf(turn.created[0]?.items || inbox.pendingOrder?.items), ['5 GRA-XANH-Z450'], said(turn));
  assert.match(said(turn), /em lên 5 Túi Xanh/u);
});
