// Chủ shop 10/10: "khách đã mua hàng thì bot không cần hỏi lại số điện thoại hay địa chỉ nữa". Khách cũ chỉ nêu giỏ (gõ hay bấm
// giỏ Facebook Shop) → bot lấy SĐT + địa chỉ của đơn trước, hỏi xác nhận một câu; "ok" thì lên đơn. Không bao giờ tự lên đơn.
import assert from 'node:assert/strict';
import test from 'node:test';
import { Sim, PHONE } from './helpers/r13-engine-sim.mjs';

const DAY = 24 * 60 * 60 * 1000;
const OLD = '12 Lê Lợi, Phường Bến Nghé, Quận 1, TP Hồ Chí Minh';
const said = turn => turn.sent.map(item => item.text).join('\n');
const itemsOf = list => (list || []).map(item => `${item.quantity} ${item.code || item.sku}`).sort();
const noModel = () => { throw new Error('luật/code phải tự xử lý, không gọi mô hình'); };
const pastOrder = (agoDays, extra = {}) => ({
  id: `old-${agoDays}`, automatic: true, createdAt: Date.now() - agoDays * DAY, phone: PHONE, address: OLD, total: 298000,
  products: [{ name: 'Granola Túi Xanh 450g', sku: 'GRA-XANH-Z450', quantity: 2 }], status: 'Đã giao', ...extra
});

test('khách cũ (đơn 20 ngày trước) chỉ nêu giỏ: bot hỏi xác nhận SĐT + địa chỉ cũ, không xin lại, chưa lên đơn; "ok" → lên đơn đúng địa chỉ', async () => {
  const sim = new Sim({ psid: 'ret-1' });
  const inbox = sim.inbox({ customerOrders: [pastOrder(20)], botLastTemplateId: 'PRICE_QUOTE', botLastReplyAt: Date.now() - 5 * 60 * 1000 });
  const ask = await sim.send(inbox, 'Cho chị 2 túi xanh nhé', { llm: noModel });
  assert.equal(ask.created.length, 0, said(ask));
  assert.match(said(ask), /địa chỉ cũ/u, said(ask));
  assert.match(said(ask), /Lê Lợi/u);
  assert.doesNotMatch(said(ask), /cho em xin (số điện thoại|sđt)/iu);
  assert.ok(inbox.pendingOrder?.oldAddressConfirm);
  const yes = await sim.send(inbox, 'ok em', { llm: noModel });
  assert.equal(yes.created.length, 1, said(yes));
  assert.deepEqual(itemsOf(yes.created[0].items), ['2 GRA-XANH-Z450']);
  assert.match(yes.created[0].address, /Lê Lợi/u);
});

test('khách cũ gửi địa chỉ mới thay vì "ok": lên đơn theo địa chỉ mới', async () => {
  const sim = new Sim({ psid: 'ret-2' });
  const inbox = sim.inbox({ customerOrders: [pastOrder(30)], botLastTemplateId: 'PRICE_QUOTE', botLastReplyAt: Date.now() - 5 * 60 * 1000 });
  await sim.send(inbox, 'Lấy 2 túi xanh', { llm: noModel });
  assert.ok(inbox.pendingOrder?.oldAddressConfirm);
  const fresh = '45 Nguyễn Huệ, Phường Bến Nghé, Quận 1, TP Hồ Chí Minh';
  const turn = await sim.send(inbox, `Gửi về ${fresh} giúp chị`, { llm: { template_id: 'ORDER_CONFIRMATION', Customer_Address: fresh } });
  assert.equal(turn.created.length, 1, said(turn));
  assert.match(turn.created[0].address, /Nguyễn Huệ/u);
});

test('khách mới (chưa có đơn) vẫn được xin SĐT + địa chỉ như cũ', async () => {
  const sim = new Sim({ psid: 'ret-3' });
  const inbox = sim.inbox({ botLastTemplateId: 'PRICE_QUOTE', botLastReplyAt: Date.now() - 5 * 60 * 1000 });
  const turn = await sim.send(inbox, 'Cho chị 2 túi xanh nhé', { llm: noModel });
  assert.equal(turn.created.length, 0);
  assert.doesNotMatch(said(turn), /địa chỉ cũ/u);
  assert.match(said(turn), /số điện thoại|SĐT|địa chỉ/iu);
});

test('đơn trước mới 3 ngày, chưa hủy: không dùng nhánh địa chỉ cũ (luồng "đặt thêm / gộp hay tách" lo), không tự lên đơn', async () => {
  const sim = new Sim({ psid: 'ret-4' });
  const inbox = sim.inbox({ customerOrders: [pastOrder(3, { status: 'Mới' })], botLastTemplateId: 'ORDER_STATUS', botLastReplyAt: Date.now() - 60 * 60 * 1000 });
  const turn = await sim.send(inbox, 'Cho chị thêm 2 túi xanh', { llm: { template_id: 'ORDER_ADDRESS', Product_N1: 'Granola Túi Xanh 450g', No_A: '2' } });
  assert.equal(turn.created.length, 0, said(turn));
  assert.ok(!inbox.pendingOrder?.oldAddressConfirm, said(turn));
});

test('khách cũ bấm giỏ Facebook Shop: bot xác nhận địa chỉ cũ thay vì xin SĐT + địa chỉ', async () => {
  const shopName = 'Granola Mới Ngũ Cốc Ăn Sáng Healthy Lành Mạnh Với Hạt Dinh Dưỡng Trái Cây Từ Giọt Nắng';
  const sim = new Sim({ psid: 'ret-5', settings: { shopOrderFollowUpMs: [] } });
  const inbox = sim.inbox({ customerOrders: [pastOrder(25)] });
  const turn = await sim.send(inbox, `Khách chọn mua từ Facebook Shop: ${shopName} (CB-VANGG+XANH) × 1 — 298.000đ`, {
    message: { cart: [{ name: shopName, sku: 'CB-VANGG+XANH', quantity: 1, image: '' }] }, llm: noModel
  });
  assert.equal(turn.created.length, 0, said(turn));
  assert.match(said(turn), /địa chỉ cũ/u, said(turn));
  assert.match(said(turn), /Lê Lợi/u);
  assert.ok(inbox.pendingOrder?.oldAddressConfirm);
});
