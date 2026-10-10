// 10/10 (ca Van Do): khách chốt 2 Combo 10 gói Xanh bằng tin nhắn (đơn 358.000đ miễn ship), rồi Facebook gửi lại tin giỏ
// Shop cũ "CB10-XANH-G35 × 1" → bot SỬA đơn về 1 combo 204.000đ. Giỏ Shop sau khi đã chốt đơn không được tự sửa đơn: giữ
// nguyên, kể lại đơn, gắn thẻ cần người.
import assert from 'node:assert/strict';
import test from 'node:test';
import { Sim } from './helpers/r13-engine-sim.mjs';

const shopName = 'Granola Mới Ngũ Cốc Ăn Sáng Healthy Lành Mạnh Với Hạt Dinh Dưỡng Trái Cây Từ Giọt Nắng';
const cartText = (sku, price) => `Khách chọn mua từ Facebook Shop: ${shopName} (${sku}) × 1 — ${price.toLocaleString('vi-VN')}đ`;
const cartLine = sku => ({ name: shopName, sku, quantity: 1, image: '' });
const noModel = () => { throw new Error('không được gọi mô hình cho tin giỏ Shop'); };

test('giỏ Shop "×1" về sau khi đã chốt đơn 2 combo bằng tin nhắn: không sửa đơn, kể lại đơn, cần người xử lý', async () => {
  const sim = new Sim({ settings: { shopOrderFollowUpMs: [] } });
  const order = {
    id: 'vando01', createdAt: Date.now() - 60 * 1000, status: 'Mới', phone: '0978270574',
    address: 'Trường mầm non Tam Hưng 1, khu Hưng Giáo, Xã Tam Hưng, Huyện Thanh Oai, Hà Nội', total: 358000, freeShipping: true,
    products: [{ name: 'Combo 10 gói Xanh', sku: 'CB10-XANH-G35', quantity: 2 }]
  };
  const inbox = sim.inbox({ gender: 'female', botGender: 'female', customerOrders: [order], botLastTemplateId: 'ORDER_CONFIRM', botLastReplyAt: Date.now() - 50 * 1000 });
  sim.history(inbox, 'incoming', '2 combo cũng được bạn nhé', 120000);
  sim.history(inbox, 'outgoing', 'Dạ đơn của chị em đã lên rồi ạ: 🌾 Combo 10 gói Xanh – Số lượng: 2 💰 Tổng tiền: 358.000đ (Miễn phí vận chuyển)', 50000);
  const turn = await sim.send(inbox, cartText('CB10-XANH-G35', 204000), { message: { cart: [cartLine('CB10-XANH-G35')] }, llm: noModel });
  assert.equal(turn.created.filter(item => item.update).length, 0, 'không sửa đơn theo giỏ Shop');
  assert.equal(turn.created.length, 0, 'không tạo đơn mới');
  const said = turn.sent.map(item => item.text || '').join('\n');
  assert.doesNotMatch(said, /sửa lại đơn/);
  assert.match(said, /2 Combo 10 gói Xanh|Combo 10 gói Xanh.*2/, `kể lại đơn đang có: ${said}`);
});
