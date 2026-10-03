// Vòng 15 (03/10) — agent "rules": chạy qua engine thật (bộ giả lập r13) các luật mới của rule-intent.mjs.
// Câu khách thật 02–03/10 (r15 out-inbox2/4); không tên khách, không SĐT thật.
import assert from 'node:assert/strict';
import test from 'node:test';
import { Sim, PHONE, XANH, basket } from './helpers/r13-engine-sim.mjs';

const MIN = 60 * 1000;
const TROPICAL = /Tropical/;

test('đang giữ 3 Túi Xanh, "Túi có dâu để ăn thử" (…762063) → giỏ còn 3 Xanh và thêm 1 Tropical, không thay giỏ', async () => {
  const sim = new Sim({ psid: 'trop-add' });
  const inbox = sim.inbox({ botLastTemplateId: 'ORDER_ADDRESS', botLastReplyAt: Date.now() - 1 * MIN, pendingOrder: basket([XANH(3)], 2 * MIN) });
  sim.history(inbox, 'outgoing', 'Dạ đơn của chị gồm 3 Granola Túi Xanh 450g, tổng 447.000đ (Miễn phí vận chuyển) ạ 🌾 chị cho em xin số điện thoại và địa chỉ nha ạ.', 1 * MIN, { sender: 'bot' });
  const turn = await sim.send(inbox, 'Túi có dâu  để ăn thử', { llm: { template_id: 'PRICE_QUOTE', Product_N1: 'Granola Tropical vị Cacao 300g' } });
  const items = inbox.pendingOrder?.items || [];
  assert.equal(items.find(item => item.code === 'GRA-XANH-Z450')?.quantity, 3, JSON.stringify(items));
  assert.ok(items.some(item => TROPICAL.test(item.product) && item.quantity === 1), JSON.stringify(items));
  assert.equal(turn.asked.length, 0, 'luật trả lời, không hỏi mô hình');
});

test('đang giữ 3 Túi Xanh, "Túi có dâu" (không chữ thử/thêm) → báo giá Tropical, giỏ 3 Xanh giữ nguyên', async () => {
  const sim = new Sim({ psid: 'trop-quote' });
  const inbox = sim.inbox({ botLastTemplateId: 'ORDER_ADDRESS', botLastReplyAt: Date.now() - 1 * MIN, pendingOrder: basket([XANH(3)], 2 * MIN) });
  sim.history(inbox, 'outgoing', 'Dạ đơn của chị gồm 3 Granola Túi Xanh 450g, tổng 447.000đ (Miễn phí vận chuyển) ạ 🌾 chị cho em xin số điện thoại và địa chỉ nha ạ.', 1 * MIN, { sender: 'bot' });
  const turn = await sim.send(inbox, 'Túi có dâu', { llm: { template_id: 'PRICE_QUOTE', Product_N1: 'Granola Tropical vị Cacao 300g' } });
  const items = inbox.pendingOrder?.items || [];
  assert.deepEqual(items.map(item => [item.code, item.quantity]), [['GRA-XANH-Z450', 3]], JSON.stringify(turn.sent));
  assert.match(turn.sent.map(item => item.text).join(' '), TROPICAL);
});

test('lời chào live → "Túi xanh 450 g" (…111673) → lên giỏ 1 Túi Xanh, không gửi lại bảng giá live', async () => {
  const sim = new Sim({ psid: 'live-xanh' });
  const inbox = sim.inbox({ botLastTemplateId: 'LIVESTREAM_COMMENT', botLastReplyAt: Date.now() - 2 * MIN, labels: ['Livestream'] });
  sim.history(inbox, 'outgoing', 'Dạ chị ơi, phiên live nhà em có:\n💚 Túi Xanh nguyên bản 450g: 174.000đ\n💛 Túi Vàng nhiều hạt 350g: 174.000đ\n🤎 Túi Nâu cacao 350g: 164.000đ\nChị chọn loại và số lượng nhắn em ngay tại đây, em lên đơn liền cho mình nha ạ 🌾', 2 * MIN, { sender: 'bot' });
  const turn = await sim.send(inbox, 'Túi xanh 450 g', { llm: { template_id: 'LIVESTREAM_COMMENT' } });
  assert.deepEqual((inbox.pendingOrder?.items || []).map(item => [item.code, item.quantity]), [['GRA-XANH-Z450', 1]], JSON.stringify(turn.sent));
  assert.doesNotMatch(turn.sent.map(item => item.text).join(' '), /phiên live nhà em có/);
});

test('K3b phần bộ soạn đơn: đơn bot 1 Nâu 2 phút, "Số lượng là 2" + ORDER_UPDATE trơn (đúng giá trị luật K3b trả) → sửa đơn thành 2 Nâu', async () => {
  const sim = new Sim({ psid: 'k3b' });
  const inbox = sim.inbox({ botLastTemplateId: 'ORDER_CONFIRMATION', botLastReplyAt: Date.now() - 2 * MIN,
    customerOrders: [{ id: 'o1', createdAt: Date.now() - 2 * MIN, phone: PHONE, address: '79 xóm hạ, Xã Vĩnh Thái, Thành phố Nha Trang, Khánh Hòa', total: 179000, products: [{ name: 'Granola Túi Nâu vị cacao 350g', sku: 'GRA-NAU-Z350', quantity: 1 }], status: 'Mới', source: 'chatbot' }] });
  sim.history(inbox, 'outgoing', 'Dạ, em xin phép xác nhận lại thông tin đặt hàng của mình nha: 🌾 Granola Túi Nâu vị cacao 350g – Số lượng: 1 💰 Tổng tiền: 179.000đ', 2 * MIN, { sender: 'bot' });
  const turn = await sim.send(inbox, 'Số lượng là 2', { llm: { template_id: 'ORDER_UPDATE' } });
  const update = turn.created.find(item => item.update);
  assert.ok(update, JSON.stringify({ sent: turn.sent, result: turn.result }));
  assert.deepEqual(update.items.map(item => [item.code, item.quantity]), [['GRA-NAU-Z350', 2]]);
});
