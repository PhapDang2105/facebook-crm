// Vòng 18 — Gói B: khách cũ / "địa chỉ cũ" / SĐT / đơn trùng giữa hai Page (out-inbox2 N4/V5, out-inbox3 N4 #11, out-inbox4 N6).
// Câu khách THẬT; SĐT là số giả, số nhà đổi bớt.
import assert from 'node:assert/strict';
import test from 'node:test';
import { Sim, PHONE, XANH, VANG, basket } from './helpers/r13-engine-sim.mjs';
import { clearExternalOrderCache } from '../app/chatbot-engine.mjs';

const MIN = 60 * 1000;
const DAY = 24 * 60 * MIN;
const said = turn => turn.sent.map(item => item.text).join('\n');
const noModel = () => { throw new Error('luật/code phải tự xử lý, không gọi mô hình'); };

test('R18-B V5 (inbox2, …138672): khách cũ "Giao mình 3 túi vàng nữa nhé" — phiếu cũ của nhân viên có chữ đậm *…* → hỏi xác nhận địa chỉ cũ, không xin lại', async () => {
  const sim = new Sim({ psid: 'r18b-v5a' });
  const inbox = sim.inbox({ botLastTemplateId: 'WELCOME', botLastReplyAt: Date.now() - MIN });
  sim.history(inbox, 'incoming', `12f đường 15 kp4 phường An khánh tphcm\n${PHONE}\nDũng`, 56 * DAY);
  sim.history(inbox, 'outgoing', `Dạ, em xin phép xác nhận lại thông tin đặt hàng của mình nha:\n🌾 Túi Vàng - Số lượng: 3\n📞 Số điện thoại: *${PHONE}*\n🏡 Địa chỉ nhận hàng: *12f đường 15 kp4 phường An khánh tphcm*\n💰 Tổng tiền: *447.000*đ`, 56 * DAY - MIN, { sender: 'staff' });
  const turn = await sim.send(inbox, 'Giao mình 3 túi vàng nữa nhé', { llm: { template_id: 'ORDER_ADDRESS', Product_N1: 'Granola Túi Vàng 350g', No_A: '3' } });
  assert.equal(turn.created.length, 0, said(turn));
  assert.match(said(turn), /địa chỉ cũ/u, said(turn));
  assert.match(said(turn), /An khánh/iu);
  assert.doesNotMatch(said(turn), /cho em xin số điện thoại/iu);
  assert.ok(inbox.pendingOrder?.oldAddressConfirm, JSON.stringify(inbox.pendingOrder));
});

test('R18-B V5 (inbox2, …423891): đơn cũ lên bằng phiếu POS (không chữ) — địa chỉ + SĐT khách tự nhắn → hỏi xác nhận địa chỉ cũ', async () => {
  const sim = new Sim({ psid: 'r18b-v5b' });
  const inbox = sim.inbox({ botLastTemplateId: 'PRICE_QUOTE', botLastReplyAt: Date.now() - 5 * MIN });
  sim.history(inbox, 'incoming', 'Mình lấy 1b vị nguyên bản', 27 * DAY);
  sim.history(inbox, 'incoming', `Số 25 , đinh công tráng, phường hắc dịch, brvt, ${PHONE}`, 27 * DAY - 10000);
  sim.history(inbox, 'outgoing', 'Đã gửi xác nhận đơn hàng', 27 * DAY - 8 * 60 * MIN, { type: 'order-receipt' });
  const turn = await sim.send(inbox, 'Gửi c 2 túi xanh nha e', { llm: noModel });
  assert.equal(turn.created.length, 0, said(turn));
  assert.match(said(turn), /địa chỉ cũ/u, said(turn));
  assert.match(said(turn), /hắc dịch/iu);
});

test('R18-B N4 #11 (inbox3, …3949494): "Giao DC củ nhe e" + "<sđt> Trang" → tra địa chỉ cũ theo SĐT vừa gửi, không đòi tỉnh/huyện/xã', async () => {
  const sim = new Sim({ psid: 'r18b-old1' });
  const inbox = sim.inbox({ botLastTemplateId: 'STAFF_WAIT_CLOSED', botLastReplyAt: Date.now() - 8 * DAY });
  sim.history(inbox, 'incoming', `12 Lê Lợi, Phường Bến Nghé, Quận 1, TP Hồ Chí Minh ${PHONE}`, 40 * DAY);
  const turn = await sim.send(inbox, `Giao DC củ nhe e\n${PHONE} Trang`, { llm: { template_id: 'ORDER_ADDRESS', Product_N1: 'Granola Túi Xanh 450g', No_A: '2', Product_N2: 'Granola Túi Vàng 350g', No_B: '1', Phone_Number: PHONE, Customer_Address: 'Trang' } });
  assert.doesNotMatch(said(turn), /xin thêm tỉnh|SĐT đã đặt lần trước/u, said(turn));
  const all = `${said(turn)}\n${turn.created.map(item => item.address).join('\n')}`;
  assert.match(all, /Lê Lợi/u, all);
  assert.doesNotMatch(turn.created.map(item => item.address).join('\n'), /Trang/u);
});

test('R18-B N4 #11: "DC củ e" khi SĐT đã gửi 6 phút trước (giỏ giữ SĐT) → không xin lại SĐT', async () => {
  const sim = new Sim({ psid: 'r18b-old2' });
  const inbox = sim.inbox({ botLastTemplateId: 'ORDER_ADDRESS', botLastReplyAt: Date.now() - 6 * MIN, pendingOrder: basket([XANH(2), VANG(1)], 6 * MIN, { phone: PHONE }) });
  sim.history(inbox, 'incoming', `${PHONE} Trang`, 6 * MIN);
  const turn = await sim.send(inbox, 'DC củ e', { llm: noModel });
  assert.doesNotMatch(said(turn), /xin SĐT|xin số điện thoại/iu, said(turn));
  assert.match(said(turn), /địa chỉ/u);
});

test('R18-B N6 (inbox4, …76253109): bot xin SĐT cũ, khách gửi 2 số (số sau đúng) → tra theo số CUỐI; phiếu không bao giờ in "Địa chỉ nhận hàng: cũ"', async () => {
  const sim = new Sim({ psid: 'r18b-n6' });
  const inbox = sim.inbox({ botLastTemplateId: 'ORDER_ADDRESS_OLD_ASK_PHONE', botLastReplyAt: Date.now() - MIN,
    pendingOrder: basket([{ product: 'Combo 10 gói Xanh', code: 'CB10-XANH-G35', quantity: 1 }], 2 * MIN, { wantsPrevious: true }) });
  sim.history(inbox, 'outgoing', `Dạ em xin phép xác nhận lại thông tin nhận hàng của mình ạ:\n– Địa chỉ: 31A/1 đường Lê Thị Trung, khu phố Bình Phước A, phường Bình Chuẩn, TP. Thuận An, tỉnh Bình Dương\n– SĐT: 0912 345 678\nDạ mình kiểm tra lại giúp em`, 170 * DAY, { sender: 'staff' });
  const turn = await sim.send(inbox, `0912345699\n${PHONE}`, { llm: noModel });
  const all = `${said(turn)}\n${JSON.stringify(turn.created)}`;
  assert.doesNotMatch(all, /0912345699/u, all);
  assert.match(all, /Bình Chuẩn/u, all);
  assert.doesNotMatch(said(turn), /Địa chỉ nhận hàng:\s*cũ/u);
});

test('R18-B N6: mô hình ghi Customer_Address "cũ" mà không tra ra → không in "cũ" lên phiếu, không lên đơn', async () => {
  const sim = new Sim({ psid: 'r18b-n6b' });
  const inbox = sim.inbox({ botLastTemplateId: 'ORDER_ADDRESS_OLD_NOT_FOUND', botLastReplyAt: Date.now() - MIN,
    pendingOrder: basket([{ product: 'Combo 10 gói Xanh', code: 'CB10-XANH-G35', quantity: 1 }], 2 * MIN, { phone: PHONE, addressAsks: 1 }) });
  const turn = await sim.send(inbox, 'Số sau đây e nha', { llm: { template_id: 'ORDER_CONFIRMATION', Product_N1: 'Combo 10 gói Xanh', No_A: '1', Phone_Number: PHONE, Customer_Address: 'cũ' } });
  assert.equal(turn.created.length, 0, said(turn));
  assert.doesNotMatch(said(turn), /Địa chỉ nhận hàng:\s*cũ/u, said(turn));
});

test('R18-B N4 (inbox2, Trần Thị Chung): cùng SĐT đã có đơn CRM ở Page kia 69 phút trước → hỏi xác nhận, không tạo đơn thứ hai', async () => {
  clearExternalOrderCache();
  const sim = new Sim({ psid: 'r18b-dup' });
  const inbox = sim.inbox({ botLastTemplateId: 'ORDER_ADDRESS_REMIND', botLastReplyAt: Date.now() - 2 * MIN, pendingOrder: basket([VANG(1)], 5 * MIN) });
  const otherPageOrder = { id: '0ae19045', createdAt: Date.now() - 69 * MIN, phone: PHONE, address: 'thôn gò mái, số nhà 3, Xã Hợp Tiến, Huyện Mỹ Đức, Hà Nội', total: 189000, status: 'Mới', products: [{ name: 'Granola Túi Vàng 350g', sku: 'GRA-VANG-H350', quantity: 1 }] };
  const turn = await sim.send(inbox, `Sđt  ${PHONE} thôn gò mái xã hợp tiến huyện mỹ đức tp hà nội số nhà 3`, {
    llm: noModel, extra: { findOrdersByPhone: async phone => (phone === PHONE ? [otherPageOrder] : []) }
  });
  assert.equal(turn.created.length, 0, said(turn));
  assert.match(said(turn), /đang có đơn|đã có một đơn/u, said(turn));
});

test('R18-B N4: đơn CRM cùng SĐT nhưng là của chính hội thoại / đã hủy → không tính là đơn ngoài', async () => {
  clearExternalOrderCache();
  const sim = new Sim({ psid: 'r18b-dup2' });
  const inbox = sim.inbox({ botLastTemplateId: 'ORDER_ADDRESS_REMIND', botLastReplyAt: Date.now() - 2 * MIN, pendingOrder: basket([VANG(1)], 5 * MIN) });
  const cancelled = { id: 'x-1', createdAt: Date.now() - 69 * MIN, phone: PHONE, address: 'Hà Nội', total: 189000, status: 'Hủy', processingStatus: 'cancelled', products: [] };
  const turn = await sim.send(inbox, `Sđt  ${PHONE} thôn gò mái xã hợp tiến huyện mỹ đức tp hà nội số nhà 3`, {
    llm: noModel, extra: { findOrdersByPhone: async () => [cancelled] }
  });
  assert.equal(turn.created.length, 1, said(turn));
});
