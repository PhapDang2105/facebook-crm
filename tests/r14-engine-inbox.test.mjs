// Vòng 14 (03/10) — engine, hộp thư: câu khách thật 02–03/10 (out-inbox1/2/3, out-dl). SĐT giả 0912345678.
import assert from 'node:assert/strict';
import test from 'node:test';
import { Sim, XANH, VANG, NAU, basket, PHONE, templates } from './helpers/r13-engine-sim.mjs';
import { claimsLiveDeal, refusesPurchase, praisesAfterBuying, asksHowToHunt, complainsAboutProduct, shortDislike } from '../app/chatbot-engine.mjs';

const DAY = 24 * 60 * 60 * 1000;
const texts = turn => turn.sent.map(item => item.text).join('\n');

test('H1 (ca …216841): "…tỉnh gia lai" khi khách có đơn cũ trong 7 ngày → không bị đổi thành bảng giá', async () => {
  const old = { id: 'o1', phone: PHONE, address: 'cũ', createdAt: Date.now() - 3 * DAY, status: 'Đã giao', products: [{ name: 'Granola Túi Xanh 450g', quantity: 2 }], total: 298000 };
  const sim = new Sim();
  const inbox = sim.inbox({ customerOrders: [old], botLastTemplateId: 'ORDER_ADDRESS', botLastReplyAt: Date.now() - 60000, pendingOrder: basket([XANH(2)], 60000, { phone: PHONE }) });
  const turn = await sim.send(inbox, 'Hẻm 27 Lê đại hành, phường thống nhất, tỉnh gia lai', { llm: { template_id: 'ORDER_CONFIRMATION', Phone_Number: PHONE, Customer_Address: 'Hẻm 27 Lê đại hành, phường thống nhất, tỉnh gia lai' } });
  assert.notEqual(turn.result.templateId, 'PRICE_QUOTE', JSON.stringify(turn.result));
  assert.doesNotMatch(texts(turn), /Bảng giá/);
  // Câu hỏi giá thật vẫn là câu hỏi giá.
  const sim2 = new Sim({ psid: 'p2' });
  const inbox2 = sim2.inbox({ customerOrders: [old] });
  const ask = await sim2.send(inbox2, 'E mua 2 túi xanh giá bao nhiêu', { llm: { template_id: 'ORDER_CONFIRMATION', Product_N1: 'Granola Túi Xanh 450g', No_A: '2', Phone_Number: PHONE, Customer_Address: '12 Lê Lợi, Phường Bến Nghé, Quận 1, TP Hồ Chí Minh' } });
  assert.equal(ask.created.length, 0);
  assert.equal(ask.result.templateId, 'PRICE_QUOTE', JSON.stringify(ask.result));
});

test('săn deal: chỉ ghi nhận khi khách thật sự báo đã săn/đã đặt', () => {
  for (const text of ['Mình đã săn được rồi', 'chị đã đặt trên live rồi nha', 'Em chốt rồi nhé']) assert.equal(claimsLiveDeal(text), true, text);
  for (const text of ['Thôi dẹp khỏi mua', 'Kg có mua nhé', 'Săn ntn ạh', 'Mình đã mua, ăn ngon nha', 'Mình ko săn deal trên live', 'Dạ mua 2 bich giá 189k thôi ạ']) assert.equal(claimsLiveDeal(text), false, text);
  for (const text of ['Thôi dẹp khỏi mua', 'Kg có mua nhé', 'thôi ko lấy nữa']) assert.equal(refusesPurchase(text), true, text);
  for (const text of ['C ko lấy nữa thì có giảm tiền ko', 'Ko có túi nhỏ hả', 'không lấy túi vàng', 'k mua được à?']) assert.equal(refusesPurchase(text), false, text);
  assert.equal(praisesAfterBuying('Mình đã mua, ăn ngon nha'), true);
  assert.equal(praisesAfterBuying('đã mua rồi, lấy thêm 2 túi'), false);
  assert.equal(asksHowToHunt('Săn ntn ạh'), true);
});

test('M2 (ca …532401) / C2 (…958786): từ chối khi đang giữ giỏ → ORDER_POSTPONED và bỏ giỏ, không "em ghi nhận đã săn deal"', async () => {
  for (const [text, chosen] of [['Kg có mua nhé', 'ORDER_STATUS'], ['Thôi dẹp khỏi mua', 'ORDER_STATUS']]) {
    const sim = new Sim({ settings: { ruleIntent: 'off' } });
    const inbox = sim.inbox({ post: { id: 'live', message: 'Săn deal cùng Giọt Nắng ạ', isLive: true }, botLastTemplateId: 'ORDER_ADDRESS', botLastReplyAt: Date.now() - 60000, pendingOrder: basket([XANH(1), NAU(1)]) });
    const turn = await sim.send(inbox, text, { llm: { template_id: chosen } });
    assert.equal(turn.result.templateId, 'ORDER_POSTPONED', `${text}: ${JSON.stringify(turn.result)}`);
    assert.doesNotMatch(texts(turn), /săn deal/);
    assert.equal(inbox.pendingOrder, null, text);
  }
});

test('H4 (ca …017802): mô hình chuyển CSKH vì tin ngắn "Dỡ" → không tắt bot, xin lỗi + thẻ Khiếu nại; "gặp nhân viên" vẫn chuyển', async () => {
  assert.equal(shortDislike('Dỡ'), true);
  assert.equal(complainsAboutProduct('Dỡ'), true);
  const sim = new Sim({ settings: { ruleIntent: 'off' } });
  const inbox = sim.inbox();
  const turn = await sim.send(inbox, 'Dỡ', { llm: { template_id: 'CSKH_HANDOFF' } });
  assert.equal(turn.result.templateId, 'COMPLAINT_SORRY', JSON.stringify(turn.result));
  assert.notEqual(inbox.botEnabled, false);
  assert.ok(inbox.labels.includes('complaint'));
  assert.match(texts(turn), /xin lỗi/);
  // Tin ngắn khác (không chê): báo bạn phụ trách, bot vẫn bật.
  const other = new Sim({ psid: 'o', settings: { ruleIntent: 'off' } });
  const otherInbox = other.inbox();
  const short = await other.send(otherInbox, 'ủa vậy hả', { llm: { template_id: 'CSKH_HANDOFF' } });
  assert.match(short.result.templateId, /^STAFF_WAIT_/);
  assert.notEqual(otherInbox.botEnabled, false);
  // Khách tự đòi gặp người → chuyển như cũ.
  const human = new Sim({ psid: 'h', settings: { ruleIntent: 'off' } });
  const humanInbox = human.inbox();
  await human.send(humanInbox, 'gặp nhân viên', { llm: { template_id: 'CSKH_HANDOFF' } });
  assert.equal(humanInbox.botEnabled, false);
});

test('S1 (ca …762063): "Ok" sau ORDER_EXISTING_CONFIRM khi bot đã gửi tin khác xen giữa (cờ chờ còn hạn) → chốt giỏ đang giữ', async () => {
  const old = { id: 'o1', phone: PHONE, address: '12 Lê Lợi, Phường Bến Nghé, Quận 1, TP Hồ Chí Minh', createdAt: Date.now() - 2 * DAY, status: 'Đang giao', products: [{ name: 'Granola Túi Vàng 350g', quantity: 1 }], total: 189000 };
  const sim = new Sim({ settings: { ruleIntent: 'off' } });
  const inbox = sim.inbox({ customerOrders: [old], botLastTemplateId: 'PRICE_QUOTE', botLastReplyAt: Date.now() - 60000,
    pendingOrder: basket([XANH(3)], 4 * 60000, { phone: PHONE, address: old.address, addressAsks: 2, awaitingConfirm: true }) });
  const turn = await sim.send(inbox, 'Ok', { llm: { template_id: 'THANK_YOU' } });
  assert.equal(turn.result.templateId, 'ORDER_CONFIRMATION', JSON.stringify(turn.result));
  assert.equal(turn.created.length, 1);
  assert.deepEqual(turn.created[0].items.map(item => `${item.quantity} ${item.code}`), ['3 GRA-XANH-Z450']);
});

test('S1: giỏ còn món mà chưa có đơn → "Ok" không kết bằng lời cảm ơn suông (nhắc giỏ)', async () => {
  const sim = new Sim({ settings: { ruleIntent: 'off' } });
  const inbox = sim.inbox({ botLastTemplateId: 'PRICE_QUOTE', botLastReplyAt: Date.now() - 60000, pendingOrder: basket([XANH(2)], 5 * 60000) });
  const turn = await sim.send(inbox, 'Ok', { llm: { template_id: 'THANK_YOU' } });
  assert.equal(turn.result.templateId, 'ORDER_ADDRESS_REMIND', JSON.stringify(turn.result));
  assert.match(texts(turn), /2 Granola Túi Xanh 450g/);
});

test('S1: giỏ đã giữ im lặng một lần ("đang chờ xác nhận đặt thêm") → lượt sau hỏi lại "đặt thêm?" kèm câu trả lời', async () => {
  const old = { id: 'o1', phone: PHONE, address: '12 Lê Lợi, Phường Bến Nghé, Quận 1, TP Hồ Chí Minh', createdAt: Date.now() - 2 * DAY, status: 'Đang giao', products: [{ name: 'Granola Túi Vàng 350g', quantity: 1 }], total: 189000 };
  const sim = new Sim({ settings: { ruleIntent: 'off' } });
  const inbox = sim.inbox({ customerOrders: [old], botLastTemplateId: 'ORDER_EXISTING_CONFIRM', botLastReplyAt: Date.now() - 60000,
    pendingOrder: basket([XANH(3)], 3 * 60000, { phone: PHONE, address: old.address, addressAsks: 2, awaitingConfirm: true, heldSilently: true }) });
  const turn = await sim.send(inbox, 'Túi có dâu để ăn thử', { llm: { template_id: 'PRICE_QUOTE', Product_N1: 'Granola Tropical vị Cacao 300g' } });
  // R15: lời seed ORDER_EXISTING_CONFIRM mới hỏi gộp/tách (chủ shop 03/10) thay cho "đặt THÊM".
  assert.match(texts(turn), /THÊM|thêm|gộp .* vào đơn đang có/);
  assert.match(texts(turn), /3 Granola Túi Xanh 450g/);
  assert.equal(inbox.pendingOrder.awaitingConfirm, true);
  assert.equal(inbox.pendingOrder.heldSilently, false);
});

test('P9 (ca …764130): "Ok thông tin chuẩn r nhé" sau ORDER_CONFIRMATION → cảm ơn (trước đây im 14 giờ)', async () => {
  const order = { id: 'o9', phone: PHONE, createdAt: Date.now() - 60000, status: 'Mới', products: [{ name: 'Granola Túi Xanh 450g', quantity: 1 }], total: 298000 };
  const sim = new Sim({ settings: { ruleIntent: 'off' } });
  const inbox = sim.inbox({ customerOrders: [order], botLastTemplateId: 'ORDER_CONFIRMATION', botLastReplyAt: Date.now() - 30000 });
  const turn = await sim.send(inbox, 'Ok thông tin chuẩn r nhé', { llm: { template_id: 'THANK_YOU' } });
  assert.equal(turn.result.templateId, 'THANK_YOU', JSON.stringify(turn.result));
  assert.equal(turn.asked.length, 0, 'không cần hỏi mô hình');
});

test('C4 (ca …029290): "Cần e" sau PACKAGING_INFO = đồng ý nhận bảng giá combo gói nhỏ', async () => {
  const sim = new Sim({ settings: { ruleIntent: 'off' } });
  const inbox = sim.inbox({ botLastTemplateId: 'PACKAGING_INFO', botLastReplyAt: Date.now() - 60000 });
  const turn = await sim.send(inbox, 'Cần e', { llm: { template_id: 'ORDER_ADDRESS', Product_N1: 'Granola Túi Xanh 450g', No_A: '1' } });
  assert.equal(turn.result.templateId, 'PRICE_QUOTE', JSON.stringify(turn.result));
  assert.match(texts(turn), /Combo 10/);
});

test('M3 (ca …807322): ORDER_STATUS với đơn 5 ngày chưa giao / "mãi chưa nhận" → DELIVERY_DELAY + thẻ', async () => {
  const order = { id: 'o5', phone: PHONE, createdAt: Date.now() - 5 * DAY, status: 'Đang giao', products: [{ name: 'Granola Túi Xanh 450g', quantity: 2 }], total: 298000 };
  const sim = new Sim({ settings: { ruleIntent: 'off' } });
  const inbox = sim.inbox({ customerOrders: [order] });
  const turn = await sim.send(inbox, 'Đơn của chị sao chưa thấy giao vậy em', { llm: { template_id: 'ORDER_STATUS' } });
  assert.equal(turn.result.templateId, 'DELIVERY_DELAY', JSON.stringify(turn.result));
  assert.ok(inbox.labels.includes('handoff'));
  const fresh = { ...order, id: 'o6', createdAt: Date.now() - 1 * DAY };
  const sim2 = new Sim({ psid: 'p2', settings: { ruleIntent: 'off' } });
  const inbox2 = sim2.inbox({ customerOrders: [fresh] });
  const late = await sim2.send(inbox2, 'Sao mãi chưa nhận được hàng', { llm: { template_id: 'ORDER_STATUS' } });
  assert.equal(late.result.templateId, 'DELIVERY_DELAY');
  const sim3 = new Sim({ psid: 'p3', settings: { ruleIntent: 'off' } });
  const inbox3 = sim3.inbox({ customerOrders: [fresh] });
  const normal = await sim3.send(inbox3, 'Đơn của chị tới đâu rồi em', { llm: { template_id: 'ORDER_STATUS' } });
  assert.equal(normal.result.templateId, 'ORDER_STATUS', 'đơn mới 1 ngày, không than chậm → kể trạng thái như cũ');
});

test('L1 (inbox3, 4 ca): tin chỉ địa chỉ chờ gộp lâu như tin SĐT — SĐT tới sau 6 giây được gộp, không chen câu xin SĐT', async () => {
  const sim = new Sim({ settings: { ruleIntent: 'on', fragmentWaitMs: 40, phoneFragmentWaitMs: 200 } });
  const inbox = sim.inbox({ botLastTemplateId: 'ORDER_ADDRESS', botLastReplyAt: Date.now() - 60000, pendingOrder: basket([XANH(2)]) });
  const addressTurn = sim.send(inbox, 'Xóm 7, mai sơn, yên mô, ninh bình', { llm: { template_id: 'ORDER_ADDRESS' } });
  await new Promise(resolve => setTimeout(resolve, 100));
  sim.history(inbox, 'incoming', PHONE, 0);
  const turn = await addressTurn;
  assert.equal(turn.result.skipped, 'gộp với tin sau', JSON.stringify(turn.result));
  assert.equal(turn.sent.length, 0);
});

test('quyết định 10 (ca …929527): "gửi địa chỉ cũ" không tra được → xin SĐT MỘT lần, lần sau chuyển bạn phụ trách (thẻ), không xin lần 3', async () => {
  const notes = [];
  const sim = new Sim({ settings: { ruleIntent: 'off' } });
  const inbox = sim.inbox();
  const extra = { addStaffNote: async (_c, note) => { notes.push(note); } };
  const first = await sim.send(inbox, 'Cho em 1 túi xanh gởi theo địa chỉ cũ', { llm: { template_id: 'ORDER_ADDRESS', Product_N1: 'Granola Túi Xanh 450g', No_A: '1' }, extra });
  assert.equal(first.result.templateId, 'ORDER_ADDRESS_OLD_ASK_PHONE', JSON.stringify(first.result));
  assert.ok(Number(inbox.oldAddressAskedAt) > 0);
  assert.deepEqual(inbox.pendingOrder.items.map(item => item.code), ['GRA-XANH-Z450']);
  const second = await sim.send(inbox, 'E đã gởi địa chỉ bữa trước e cho đó', { llm: { template_id: 'ORDER_ADDRESS', Product_N1: 'Granola Túi Xanh 450g', No_A: '1' }, extra });
  // R15 — sửa khẳng định cũ theo quyết định chủ shop 03/10 (#8): không tra được địa chỉ cũ → bot HỎI THẲNG địa chỉ
  // (ORDER_ADDRESS_OLD_NOT_FOUND), không STAFF_WAIT, không thẻ; vẫn không xin SĐT lần hai, vẫn ghi chú cho nhân viên.
  assert.equal(second.result.templateId, 'ORDER_ADDRESS_OLD_NOT_FOUND', JSON.stringify(second.result));
  assert.doesNotMatch(texts(second), /số điện thoại/);
  assert.ok(!inbox.labels.includes('handoff'));
  assert.equal(notes.length, 1);
  assert.match(notes[0], /địa chỉ cũ/);
});

test('quyết định 12: giỏ khách live có hộp 10 gói → thẻ cần người (giá giữ nguyên cách tính)', async () => {
  const sim = new Sim({ settings: { ruleIntent: 'off' } });
  const inbox = sim.inbox({ labels: ['livestream'] });
  const turn = await sim.send(inbox, 'Hộp 10 gói và 1 túi xanh nguyên bản', { llm: { template_id: 'ORDER_ADDRESS', Product_N1: 'Combo 10 gói Xanh', No_A: '1', Product_N2: 'Granola Túi Xanh 450g', No_B: '1' } });
  assert.ok(inbox.labels.includes('handoff'), JSON.stringify(turn.result));
});

test('mẫu mới có lời dự phòng: HEALTH_CAUTION, COMPLAINT_SORRY', () => {
  assert.match(templates.HEALTH_CAUTION, /không phải thuốc hay thực phẩm chức năng/);
  assert.match(templates.COMPLAINT_SORRY, /xin lỗi/);
});
