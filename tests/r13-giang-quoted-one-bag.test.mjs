// 03/10 — ca thật Giáng Hương: bình luận "Xin giá" → bot nhắn riêng bảng giá Túi Xanh 450g → khách "1 goi" → bot hỏi lại vị
// (luật BAGS_NO_FLAVOR) → khách gửi địa chỉ + SĐT → bot vẫn hỏi vị, không lên đơn. Ngay sau bảng giá MỘT sản phẩm, "1 gói/1 túi"
// là chọn 1 túi đúng loại vừa báo (như "dùng thử" / "2 túi" / "3 túi" vốn đã được nhận).
import assert from 'node:assert/strict';
import test from 'node:test';
import { Sim, PHONE } from './helpers/r13-engine-sim.mjs';

const MIN = 60 * 1000;
const ADDRESS = '63/1 Gia Yên, Gia Tân 3, huyện Thống Nhất, tỉnh Đồng Nai';
const QUOTE = 'Dạ, em gửi chị Bảng giá Granola Túi Xanh 450g để mình dễ tham khảo ạ:\n🌿 1 Túi dùng thử (450g):\n🏷️ Giá niêm yết: 174.000đ + Phí vận chuyển 15.000đ';

test('bảng giá Túi Xanh vừa gửi → "1 goi" lên giỏ 1 Túi Xanh; gửi địa chỉ + SĐT → chốt đơn 1 Túi Xanh', async () => {
  const sim = new Sim();
  const inbox = sim.inbox({ botLastTemplateId: 'PRICE_QUOTE', botLastReplyAt: Date.now() - 2 * MIN });
  sim.history(inbox, 'outgoing', QUOTE, 2 * MIN, { sender: 'bot' });
  const one = await sim.send(inbox, '1 goi', { llm: { template_id: 'ASK_FLAVOR' } });
  assert.equal(one.result.templateId, 'ORDER_ADDRESS', JSON.stringify(one.result));
  assert.deepEqual(inbox.pendingOrder.items.map(item => [item.code, item.quantity]), [['GRA-XANH-Z450', 1]]);
  assert.doesNotMatch(one.sent.map(item => item.text).join(' '), /vị nào/);
  const closed = await sim.send(inbox, `${ADDRESS}.${PHONE}`, { llm: { template_id: 'ORDER_CONFIRMATION', Phone_Number: PHONE, Customer_Address: ADDRESS } });
  assert.equal(closed.created.length, 1, JSON.stringify(closed.result));
  assert.deepEqual(closed.created[0].items.map(item => [item.code, item.quantity]), [['GRA-XANH-Z450', 1]]);
});

test('"1 túi" KHÔNG sau bảng giá một sản phẩm → vẫn hỏi vị như cũ; "1 gói nhỏ" không bị nhận là 1 túi lớn', async () => {
  const sim = new Sim();
  const inbox = sim.inbox({ botLastTemplateId: 'WELCOME', botLastReplyAt: Date.now() - 2 * MIN });
  const turn = await sim.send(inbox, '1 tui', { llm: { template_id: 'ASK_FLAVOR' } });
  assert.notEqual(turn.result.templateId, 'ORDER_ADDRESS', JSON.stringify(turn.result));
  assert.equal(inbox.pendingOrder?.items?.length || 0, 0);
  const small = new Sim({ psid: 'nho' });
  const smallInbox = small.inbox({ botLastTemplateId: 'PRICE_QUOTE', botLastReplyAt: Date.now() - 2 * MIN });
  small.history(smallInbox, 'outgoing', QUOTE, 2 * MIN, { sender: 'bot' });
  const nho = await small.send(smallInbox, '1 goi nho', { llm: { template_id: 'PACKAGING_INFO' } });
  assert.ok(!(smallInbox.pendingOrder?.items || []).some(item => item.code === 'GRA-XANH-Z450'), JSON.stringify(nho.result));
});
