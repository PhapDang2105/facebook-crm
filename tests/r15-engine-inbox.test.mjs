// Vòng 15 (03/10) — engine, hộp thư: các lỗi còn ở mã 29a4af4 (out-inbox1..4) + quyết định chủ shop 03/10 chiều. Câu khách thật.
import assert from 'node:assert/strict';
import test from 'node:test';
import { Sim, PHONE, XANH, VANG, NAU, basket } from './helpers/r13-engine-sim.mjs';
import { saysOldAddress } from '../app/chatbot-engine.mjs';
import { ruleIntent } from '../app/processing/rule-intent.mjs';

const MIN = 60 * 1000;
const codes = items => (items || []).map(item => `${item.quantity} ${item.code || item.sku}`).sort();
const said = turn => turn.sent.map(item => item.text).join('\n');
const shopName = 'Granola Mới Ngũ Cốc Ăn Sáng Healthy Lành Mạnh Với Hạt Dinh Dưỡng Trái Cây Từ Giọt Nắng';
const cart = (sku, price) => ({ text: `Khách chọn mua từ Facebook Shop: ${shopName} (${sku}) — ${price.toLocaleString('vi-VN')}đ`, message: { cart: [{ name: shopName, sku, quantity: 1, price, image: '' }] } });
const noModel = () => { throw new Error('không được gọi mô hình'); };
const ADDRESS = 'Thôn Trung Toàn, Xã Tam Quang, Huyện Núi Thành, Quảng Nam';
const botOrder = (products, agoMs, extra = {}) => ({ id: `o-${agoMs}`, createdAt: Date.now() - agoMs, phone: PHONE, address: ADDRESS, rawAddress: ADDRESS, total: 0, products, status: 'Mới', automatic: true, ...extra });

test('mục 2 (inbox2 A2, ca …111673): giữ 1 Xanh + 1 Vàng, "Lấy 2 bịt xanh được ko" là ĐỔI GIỎ → 2 Xanh, không nhắc giỏ cũ', async () => {
  const sim = new Sim({ psid: 'r15m2' });
  const inbox = sim.inbox({ botLastTemplateId: 'ORDER_ADDRESS', botLastReplyAt: Date.now() - 2 * MIN, pendingOrder: basket([XANH(1), VANG(1)], 2 * MIN), labels: ['livestream'] });
  sim.history(inbox, 'outgoing', 'Dạ đơn của chị gồm 1 Granola Túi Xanh 450g + 1 Granola Túi Vàng 350g, tổng 298.000đ (Miễn phí vận chuyển) ạ 🌾 Chị cho em xin số điện thoại và địa chỉ', 2 * MIN, { sender: 'bot' });
  const turn = await sim.send(inbox, 'Lấy 2 bịt xanh được ko', { llm: { template_id: 'ORDER_ADDRESS', Product_N1: 'Granola Túi Xanh 450g', No_A: '2' } });
  assert.equal(turn.result.templateId, 'ORDER_ADDRESS');
  assert.deepEqual(codes(inbox.pendingOrder.items), ['2 GRA-XANH-Z450']);
  assert.match(said(turn), /2 Granola Túi Xanh 450g/);
  assert.doesNotMatch(said(turn), /vẫn đang giữ đơn 1 Granola Túi Xanh/);
});

test('mục 3 (inbox2 A1): số túi khách nêu trước câu miễn ship / bảng giá chung được đếm (askedBagCount) — "2 túi miễn ship k ạ" → "Mình có vị gì ạ" → "Túi xanh 450g"', async () => {
  const seen = [];
  const spy = (text, ctx) => { seen.push(ctx.askedBagCount); return ruleIntent(text, ctx); };
  const sim = new Sim({ psid: 'r15m3' });
  const inbox = sim.inbox({ botLastTemplateId: 'GENERAL_INFO', botLastReplyAt: Date.now() - 1 * MIN });
  sim.history(inbox, 'incoming', '2 túi miễn ship k ạ', 4 * MIN);
  sim.history(inbox, 'outgoing', 'Dạ đơn từ 2 túi bên em miễn phí vận chuyển ạ. Chị lấy 2 túi vị nào để em lên đơn miễn ship cho mình nha 🌾', 3.5 * MIN, { sender: 'bot' });
  sim.history(inbox, 'incoming', 'Mình có vị gì ạ', 2 * MIN);
  sim.history(inbox, 'outgoing', 'Dạ hiện tại nhà em có 3 vị chính ạ: Túi Xanh, Túi Vàng, Túi Nâu. Chị lấy 2 túi vị nào để em lên đơn ạ?', 1 * MIN, { sender: 'bot' });
  await sim.send(inbox, 'Túi xanh 450g', { extra: { ruleIntent: spy } });
  assert.equal(seen[0], 2);
  // Sau câu miễn ship (FREESHIP_POLICY) ngay sau "2 túi…".
  const seen2 = [];
  const sim2 = new Sim({ psid: 'r15m3b' });
  const box = sim2.inbox({ botLastTemplateId: 'FREESHIP_POLICY', botLastReplyAt: Date.now() - 1 * MIN });
  sim2.history(box, 'incoming', '2 túi miễn ship k ạ', 2 * MIN);
  sim2.history(box, 'outgoing', 'Dạ đơn từ 2 túi bên em miễn phí vận chuyển ạ. Chị lấy 2 túi vị nào để em lên đơn miễn ship cho mình nha 🌾', 1 * MIN, { sender: 'bot' });
  await sim2.send(box, 'Túi xanh 450g', { extra: { ruleIntent: (text, ctx) => { seen2.push(ctx.askedBagCount); return ruleIntent(text, ctx); } } });
  assert.equal(seen2[0], 2);
});

test('mục 4 (inbox4 A2, ca …195669): bấm lại CÙNG giỏ Shop lần 3 → không STAFF_WAIT "đã ghi nhận câu hỏi", không thẻ cần người', async () => {
  const sim = new Sim({ psid: 'r15m4', settings: { shopOrderFollowUpMs: [] } });
  const inbox = sim.inbox({ pancakeConversationId: 'page_user', gender: 'female' });
  const click = cart('CB-XANH+NAU', 293000);
  const extra = { findShopOrder: async () => null };
  const age = ms => { for (const item of sim.list(inbox.id)) item.createdAt -= ms; inbox.botLastReplyAt -= ms; if (inbox.pendingOrder) inbox.pendingOrder.at -= ms; };
  const first = await sim.send(inbox, click.text, { message: click.message, llm: noModel, extra });
  assert.equal(first.result.templateId, 'ORDER_ADDRESS');
  age(2 * MIN);
  const second = await sim.send(inbox, click.text, { message: click.message, llm: noModel, extra });
  assert.equal(second.result.templateId, 'ORDER_ADDRESS_REMIND');
  age(1 * MIN);
  const third = await sim.send(inbox, click.text, { message: click.message, llm: noModel, extra });
  assert.ok(!/^STAFF_WAIT/.test(String(third.result.templateId || '')), JSON.stringify(third.result));
  assert.equal(third.sent.length, 0);
  assert.ok(!inbox.labels.includes('handoff'));
});

test('mục 5 (inbox4 A3, ca …434300): "chợ củ / chợ cũ" là tên chợ, không phải "địa chỉ cũ"', async () => {
  assert.equal(saysOldAddress('S₫t.0912345678 chợ củ tinh Biên ang giang'), false);
  assert.equal(saysOldAddress('giao chợ cũ phường 3'), false);
  assert.equal(saysOldAddress('gửi về chỗ cũ nha'), true);
  assert.equal(saysOldAddress('Gửi dc cũ cho c'), true);
  assert.equal(saysOldAddress('như cũ nhé'), true);
  const sim = new Sim({ psid: 'r15m5' });
  const inbox = sim.inbox({ botLastTemplateId: 'ORDER_ADDRESS', botLastReplyAt: Date.now() - 2 * MIN, pendingOrder: basket([XANH(2)], 2 * MIN) });
  const turn = await sim.send(inbox, `S₫t.${PHONE} chợ củ tinh Biên ang giang`, { llm: { template_id: 'ORDER_ADDRESS', Phone_Number: PHONE, Customer_Address: 'chợ củ tinh Biên ang giang' } });
  assert.ok(!['ORDER_ADDRESS_OLD_ASK_PHONE', 'STAFF_WAIT_OPEN', 'STAFF_WAIT_CLOSED', 'ORDER_ADDRESS_OLD_NOT_FOUND'].includes(turn.result.templateId), turn.result.templateId);
});

test('mục 6 (inbox4 A4, ca …905690): [Tệp đính kèm] rồi 11 giây sau "Giá bao nhiêu vậy?" → bỏ lượt tệp, trả lời theo chữ (kèm ngữ cảnh ảnh + thẻ)', async () => {
  const sim = new Sim({ psid: 'r15m6', settings: { mediaWaitMs: 40 } });
  const inbox = sim.inbox();
  const pending = sim.send(inbox, '[Tệp đính kèm]', { type: 'file', llm: { template_id: 'IMAGE_RECEIVED' } });
  await new Promise(resolve => setTimeout(resolve, 5));
  const text = { id: 'r15-text', mid: 'r15-text', direction: 'incoming', type: 'text', text: 'Giá bao nhiêu vậy?', createdAt: Date.now() };
  sim.list(inbox.id).push(text);
  const media = await pending;
  assert.equal(media.result.skipped, 'gộp với tin sau');
  assert.equal(media.sent.length, 0);
  const turn = await sim.send(inbox, 'Giá bao nhiêu vậy?', { existing: text, llm: { template_id: 'GENERAL_INFO' } });
  assert.notEqual(turn.result.templateId, 'IMAGE_RECEIVED');
  assert.doesNotMatch(said(turn), /cần hỗ trợ gì về hình/);
  assert.ok(inbox.labels.includes('handoff'), 'thẻ để nhân viên xem tệp');
});

test('mục 10 (inbox3 A3, ca …027555): bình luận live "Hai xanh lá <sđt>" rồi Facebook đẩy đúng câu đó vào hộp thư → lượt hộp thư không gửi lại, không thẻ', async () => {
  const sim = new Sim({ psid: 'r15m10' });
  const inbox = sim.inbox();
  const thread = sim.comment({ post: { id: 'live-1', message: 'Săn deal cùng Giọt Nắng ạ', isLive: true } });
  const comment = await sim.send(thread, `Hai xanh lá ${PHONE}`, { llm: { template_id: 'ORDER_ADDRESS', Product_N1: 'Granola Túi Xanh 450g', No_A: '2', Phone_Number: PHONE } });
  assert.ok(comment.sent.some(item => item.privateReply));
  const labelsBefore = [...(inbox.labels || [])];
  const echo = await sim.send(inbox, `Hai xanh lá ${PHONE}`, { llm: { template_id: 'ORDER_ADDRESS', Product_N1: 'Granola Túi Xanh 450g', No_A: '2', Phone_Number: PHONE } });
  assert.equal(echo.sent.length, 0, JSON.stringify(echo.result));
  assert.deepEqual(inbox.labels || [], labelsBefore);
  // SĐT KHÁC giỏ vẫn là thông tin mới.
  const other = await sim.send(inbox, 'sđt 0987654321', { llm: { template_id: 'ORDER_ADDRESS', Phone_Number: '0987654321' } });
  assert.ok(other.sent.length > 0);
});

test('mục 11 (inbox2 A6, ca …990595): "Goi nho du vi ko" → mẫu bao bì → "Goi nho du vi" = câu trước chưa đúng ý → STAFF_WAIT_*, không "em vừa gửi ở tin ngay trên"', async () => {
  const sim = new Sim({ psid: 'r15m11', settings: { ruleIntent: 'off' } });
  const inbox = sim.inbox({ botLastTemplateId: 'ORDER_ADDRESS', botLastReplyAt: Date.now() - MIN, pendingOrder: basket([{ product: 'Combo 10 gói Xanh', code: 'CB10-XANH-G35', quantity: 1 }], MIN, { phone: PHONE }) });
  await sim.send(inbox, 'Goi nho du vi ko', { llm: { template_id: 'PACKAGING_INFO' } });
  const again = await sim.send(inbox, 'Goi nho du vi', { llm: { template_id: 'PACKAGING_INFO' } });
  assert.match(again.result.templateId, /^STAFF_WAIT_(OPEN|CLOSED)$/);
  assert.doesNotMatch(said(again), /vừa gửi ở tin ngay trên/);
});

test('mục 12 (inbox4 A6, ca …653811): bảng giá Túi Vàng bot ĐOÁN từ ảnh → "1 túi" không tự lên 1 Vàng; "Tiu xanh" → 1 Xanh', async () => {
  const sim = new Sim({ psid: 'r15m12' });
  const inbox = sim.inbox({ botLastTemplateId: 'PRICE_QUOTE', botLastReplyAt: Date.now() - 2 * MIN });
  sim.history(inbox, 'incoming', '', 2.2 * MIN, { type: 'image' });
  sim.history(inbox, 'outgoing', 'Dạ, em gửi chị Bảng giá Granola Túi Vàng 350g để mình dễ tham khảo ạ:\n🌿 1 Túi dùng thử (350g)', 2 * MIN, { sender: 'bot' });
  const one = await sim.send(inbox, '1 túi', { llm: { template_id: 'ASK_FLAVOR' } });
  assert.ok(!(inbox.pendingOrder?.items || []).some(item => item.code === 'GRA-VANG-H350'), JSON.stringify(inbox.pendingOrder));
  assert.equal(one.result.templateId, 'ASK_FLAVOR');
  await sim.send(inbox, 'Tiu xanh', { llm: { template_id: 'ORDER_ADDRESS', Product_N1: 'Granola Túi Xanh 450g', No_A: '1' } });
  assert.deepEqual(codes(inbox.pendingOrder.items), ['1 GRA-XANH-Z450']);
  // Bảng giá trả lời TIN CHỮ thì "1 túi" vẫn chọn đúng loại vừa báo (như 29a4af4).
  const sim2 = new Sim({ psid: 'r15m12b' });
  const box = sim2.inbox({ botLastTemplateId: 'PRICE_QUOTE', botLastReplyAt: Date.now() - 2 * MIN });
  sim2.history(box, 'incoming', 'túi vàng giá sao em', 2.2 * MIN);
  sim2.history(box, 'outgoing', 'Dạ, em gửi chị Bảng giá Granola Túi Vàng 350g để mình dễ tham khảo ạ:\n🌿 1 Túi dùng thử (350g)', 2 * MIN, { sender: 'bot' });
  await sim2.send(box, '1 túi', { llm: noModel });
  assert.deepEqual(codes(box.pendingOrder.items), ['1 GRA-VANG-H350']);
});

test('mục 13 (inbox3 A8): đang giữ giỏ, tin chỉ địa chỉ chờ lâu hơn (1,5 × mức chờ SĐT) để gộp SĐT tới sau', async () => {
  const sim = new Sim({ psid: 'r15m13', settings: { phoneFragmentWaitMs: 60 } });
  const inbox = sim.inbox({ botLastTemplateId: 'ORDER_ADDRESS', botLastReplyAt: Date.now() - MIN, pendingOrder: basket([XANH(2)], MIN) });
  const pending = sim.send(inbox, 'Thôn Trung toàn xã tam quang huyện núi thành', { llm: { template_id: 'ORDER_ADDRESS' } });
  await new Promise(resolve => setTimeout(resolve, 75));
  sim.list(inbox.id).push({ id: 'r15-phone', mid: 'r15-phone', direction: 'incoming', type: 'text', text: PHONE, createdAt: Date.now() });
  const turn = await pending;
  assert.equal(turn.result.skipped, 'gộp với tin sau', 'tin SĐT tới sau 75ms (> 60ms, < 90ms) vẫn được gộp');
});

test('mục 14 (inbox1 A9, ca …3756388949): khởi động lại giữa lúc chờ kiểm đơn sau SHOP_CART_ACK → chạy lại bước xin SĐT, không ack lần hai', async () => {
  const sim = new Sim({ psid: 'r15m14', settings: { shopOrderFollowUpMs: [] } });
  const click = cart('CB-VANGG+XANH', 298000);
  const inbox = sim.inbox({ pancakeConversationId: 'page_user', botLastTemplateId: 'ORDER_ADDRESS', botLastReplyAt: Date.now() - 20000, shopCartAckPendingAt: Date.now() - 20000, pendingOrder: basket([VANG(1), XANH(1)], 20000) });
  const cartMessage = sim.history(inbox, 'incoming', click.text, 21000, click.message);
  sim.history(inbox, 'outgoing', 'Dạ em đã nhận giỏ 1 Granola Túi Vàng 350g + 1 Granola Túi Xanh 450g của mình rồi ạ, chị chờ em ít phút để em kiểm tra đơn nha 🌾', 20000, { sender: 'bot' });
  const turn = await sim.send(inbox, click.text, { existing: cartMessage, change: { late: true, resumeShopCart: true }, llm: noModel, extra: { findShopOrder: async () => null } });
  assert.equal(turn.result.templateId, 'ORDER_ADDRESS', JSON.stringify(turn.result));
  assert.equal(turn.sent.length, 1);
  assert.doesNotMatch(said(turn), /đã nhận giỏ/);
  assert.match(said(turn), /số điện thoại/);
  assert.equal(inbox.shopCartAckPendingAt, 0);
});

test('giao diện K3b (inbox4 A1, ca …068500 "Số lượng là 2"): luật ORDER_UPDATE + setQuantity → SỬA đơn bot tạo (1 Nâu → 2 Nâu), ctx có recentOrderItems', async () => {
  const seen = [];
  const k3b = (text, ctx) => { seen.push(ctx.recentOrderItems); return { rule: 'K3B_QTY_ORDER', value: { template_id: 'ORDER_UPDATE' }, setQuantity: 2 }; };
  const sim = new Sim({ psid: 'r15k3b' });
  const inbox = sim.inbox({ botLastTemplateId: 'ORDER_CONFIRMATION', botLastReplyAt: Date.now() - 2 * MIN, customerOrders: [botOrder([{ name: 'Granola Túi Nâu vị cacao 350g', sku: 'GRA-NAU-Z350', quantity: 1 }], 2 * MIN, { total: 179000 })] });
  const turn = await sim.send(inbox, 'Số lượng là 2', { llm: noModel, extra: { ruleIntent: k3b } });
  assert.deepEqual(seen[0], [{ code: 'GRA-NAU-Z350', quantity: 1 }]);
  assert.equal(turn.result.templateId, 'ORDER_UPDATE');
  assert.equal(turn.created.length, 1);
  assert.ok(turn.created[0].updateOrderId);
  assert.deepEqual(codes(turn.created[0].items), ['2 GRA-NAU-Z350']);
});

test('quyết định C (đặt thêm khi có đơn < 24 giờ): giỏ mới → hỏi gộp/tách; "gộp" → cộng vào đơn ≤ 60 phút; "tách" → đơn mới dùng lại SĐT + địa chỉ; "ok" mơ hồ → bạn phụ trách', async () => {
  const order = botOrder([{ name: 'Granola Túi Xanh 450g', sku: 'GRA-XANH-Z450', quantity: 2 }], 90 * MIN, { total: 298000 });
  // Giỏ mới 80–90 phút sau đơn, chưa có SĐT/địa chỉ (ca …990595 "1goi nho" bị xin lại địa chỉ).
  const sim = new Sim({ psid: 'r15c1' });
  const inbox = sim.inbox({ botLastTemplateId: 'ORDER_CONFIRMATION', botLastReplyAt: Date.now() - 80 * MIN, customerOrders: [order] });
  const ask = await sim.send(inbox, 'lấy thêm 1 túi vàng nữa', { llm: { template_id: 'ORDER_ADDRESS', Product_N1: 'Granola Túi Vàng 350g', No_A: '1' } });
  assert.equal(ask.result.templateId, 'ORDER_EXISTING_CONFIRM', JSON.stringify(ask.result));
  assert.equal(inbox.pendingOrder.awaitingConfirm, true);
  // "tách đơn riêng" → đơn mới, SĐT + địa chỉ của đơn cũ.
  const split = await sim.send(inbox, 'tách đơn riêng nha', { llm: noModel });
  assert.equal(split.result.templateId, 'ORDER_CONFIRMATION', JSON.stringify(split.result));
  assert.equal(split.created.length, 1);
  assert.equal(split.created[0].phone, PHONE);
  assert.ok(!split.created[0].updateOrderId);
  assert.deepEqual(codes(split.created[0].items), ['1 GRA-VANG-H350']);
  // "gộp vào đơn" với đơn ≤ 60 phút → sửa đơn cũ (cộng món).
  const sim2 = new Sim({ psid: 'r15c2' });
  const recent = botOrder([{ name: 'Granola Túi Xanh 450g', sku: 'GRA-XANH-Z450', quantity: 2 }], 30 * MIN, { total: 298000 });
  const box = sim2.inbox({ botLastTemplateId: 'ORDER_EXISTING_CONFIRM', botLastReplyAt: Date.now() - MIN, customerOrders: [recent], pendingOrder: { ...basket([VANG(1)], MIN), awaitingConfirm: true } });
  const merge = await sim2.send(box, 'gộp chung vào đơn đó luôn em', { llm: noModel });
  assert.equal(merge.result.templateId, 'ORDER_UPDATE', JSON.stringify(merge.result));
  assert.deepEqual(codes(merge.created[0].items), ['1 GRA-VANG-H350', '2 GRA-XANH-Z450']);
  // "ok" với câu hỏi gộp/tách (đơn < 24 giờ) → bạn phụ trách, không tạo đơn.
  const sim3 = new Sim({ psid: 'r15c3' });
  const box3 = sim3.inbox({ botLastTemplateId: 'ORDER_EXISTING_CONFIRM', botLastReplyAt: Date.now() - MIN, customerOrders: [{ ...order }], pendingOrder: { ...basket([VANG(1)], MIN), awaitingConfirm: true } });
  const ok = await sim3.send(box3, 'ok em', { llm: noModel });
  assert.match(ok.result.templateId, /^STAFF_WAIT_(OPEN|CLOSED)$/);
  assert.deepEqual(ok.created, []);
  assert.ok(box3.labels.includes('handoff'));
});

test('quyết định D (inbox1 A4, ca …3002593259): không tra được địa chỉ cũ theo SĐT → hỏi thẳng địa chỉ (ORDER_ADDRESS_OLD_NOT_FOUND), không STAFF_WAIT, không thẻ', async () => {
  const sim = new Sim({ psid: 'r15d' });
  const inbox = sim.inbox({ botLastTemplateId: 'ORDER_ADDRESS_OLD_ASK_PHONE', botLastReplyAt: Date.now() - MIN, oldAddressAskedAt: Date.now() - MIN, pendingOrder: { ...basket([XANH(1), NAU(1)], 2 * MIN), wantsPrevious: true } });
  const turn = await sim.send(inbox, PHONE, { llm: { template_id: 'ORDER_ADDRESS', Phone_Number: PHONE } });
  assert.equal(turn.result.templateId, 'ORDER_ADDRESS_OLD_NOT_FOUND', JSON.stringify(turn.result));
  assert.ok(!inbox.labels.includes('handoff'));
  assert.deepEqual(codes(inbox.pendingOrder.items), ['1 GRA-NAU-Z350', '1 GRA-XANH-Z450']);
  assert.equal(inbox.pendingOrder.phone, PHONE);
});

test('SĐT thiếu số (inbox2 A7, ca …766850 "Dt. 090259563"): báo khách kiểm tra lại số (PHONE_LOOKS_SHORT), không xin SĐT chung chung', async () => {
  const sim = new Sim({ psid: 'r15short' });
  const inbox = sim.inbox({ botLastTemplateId: 'PRODUCT_PHOTOS', botLastReplyAt: Date.now() - 5 * MIN });
  const turn = await sim.send(inbox, '2 bịch túi xanh\nXn 20/26đoàn văn bơ q9 q4\nDt. 090259563:', { llm: { template_id: 'ORDER_ADDRESS', Product_N1: 'Granola Túi Xanh 450g', No_A: '2', Customer_Address: '20/26 đoàn văn bơ q4' } });
  assert.equal(turn.result.templateId, 'PHONE_LOOKS_SHORT', JSON.stringify(turn.result));
  assert.match(said(turn), /090259563/);
  assert.deepEqual(codes(inbox.pendingOrder.items), ['2 GRA-XANH-Z450']);
});

test('quyết định A (mặc cả, inbox1 A5): DISCOUNT_OATS_GIFT khi giữ giỏ ≥ 2 túi → giỏ mang oatsGift; đơn bot ≤ 60 phút → sửa đơn + ghi chú ⚠ cho POS', async () => {
  const sim = new Sim({ psid: 'r15oats' });
  const inbox = sim.inbox({ botLastTemplateId: 'ORDER_ADDRESS', botLastReplyAt: Date.now() - MIN, pendingOrder: basket([VANG(3)], MIN) });
  const turn = await sim.send(inbox, '3 tui ban cho e 400 c nha', { llm: { template_id: 'DISCOUNT_OATS_GIFT' }, extra: { ruleIntent: () => ({ rule: 'DISCOUNT_ASK', value: { template_id: 'DISCOUNT_OATS_GIFT' } }) } });
  assert.equal(turn.result.templateId, 'DISCOUNT_OATS_GIFT');
  assert.equal(inbox.pendingOrder.oatsGift, true);
  assert.deepEqual(codes(inbox.pendingOrder.items), ['3 GRA-VANG-H350']);
  const sim2 = new Sim({ psid: 'r15oats2' });
  const box = sim2.inbox({ botLastTemplateId: 'ORDER_CONFIRMATION', botLastReplyAt: Date.now() - 5 * MIN, customerOrders: [botOrder([{ name: 'Granola Túi Xanh 450g', sku: 'GRA-XANH-Z450', quantity: 3 }], 5 * MIN, { total: 447000 })] });
  const after = await sim2.send(box, 'Khách quen có giảm bớt k?', { llm: noModel, extra: { ruleIntent: () => ({ rule: 'DISCOUNT_ASK', value: { template_id: 'DISCOUNT_OATS_GIFT' } }) } });
  assert.equal(after.result.templateId, 'DISCOUNT_OATS_GIFT');
  assert.equal(after.created.length, 1);
  assert.ok(after.created[0].updateOrderId || after.notes.length);
  const noted = after.created[0].addressCheck || after.notes.map(item => item.note).join(' ');
  assert.match(noted, /Tặng yến mạch khách mặc cả/);
});

test('quyết định B (inbox3 A4, ca …734014): khách LIVE hỏi hạt điều → STAFF_ONLY_PRODUCT + thẻ, không "giữ giá live"', async () => {
  const sim = new Sim({ psid: 'r15nuts' });
  const inbox = sim.inbox({ labels: ['livestream'] });
  const turn = await sim.send(inbox, 'Dạ em thấy bên mình live Granola thôi, vậy bên mình có hạt điều ko shop?', { llm: { template_id: 'LIVE_ONLY_PRODUCT' } });
  assert.equal(turn.result.templateId, 'STAFF_ONLY_PRODUCT', JSON.stringify(turn.result));
  assert.doesNotMatch(said(turn), /giữ giá live/);
  assert.ok(inbox.labels.includes('handoff'));
});
