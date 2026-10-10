// Vòng 17 (10/10) — GÓI B: luồng engine (tin mất, đơn trùng/gộp-tách, khiếu nại, chuyển người, cảm ơn, bình luận ↔ hộp thư).
// Câu khách lấy đúng từ hội thoại thật (đã che; SĐT/địa chỉ giả khi không cần câu gốc). Mỗi test ghi mã ca rút gọn.
import assert from 'node:assert/strict';
import test from 'node:test';
import { Sim, PHONE, XANH, VANG, NAU, basket, templates } from './helpers/r13-engine-sim.mjs';
import { hasNewerCustomerMessage } from '../app/chatbot-engine.mjs';
import { renderChatbotReply } from '../app/chatbot-templates.mjs';

const MIN = 60 * 1000;
const DAY = 24 * 60 * MIN;
const X = 'Granola Túi Xanh 450g';
const V = 'Granola Túi Vàng 350g';
const codes = items => (items || []).map(item => `${item.quantity} ${item.code || item.sku}`).sort();
const texts = turn => turn.sent.map(item => item.text).join(' ‖ ');
const STAFF = /^STAFF_WAIT_(OPEN|CLOSED)$/;

// ---- B1. (inbox3 A2, ca …7090002988 / …9836559416 / …0161078186) tin trước tới muộn hơn tin sau đã được trả lời → không mất.
test('B1. hasNewerCustomerMessage: tin sau đã có lời bot (hay đã xử lý im) thì không nhường', () => {
  const t = Date.now();
  const a = { id: 'a', direction: 'incoming', type: 'text', text: 'Xin giá', createdAt: t - 2000 };
  const b = { id: 'b', direction: 'incoming', type: 'text', text: 'Loại ko đường', createdAt: t - 1000 };
  const reply = { id: 'r', direction: 'outgoing', type: 'text', text: 'Dạ granola có mật thốt nốt…', sender: 'bot', createdAt: t - 500 };
  assert.equal(hasNewerCustomerMessage([a, b], a), true, 'tin sau chưa trả lời → nhường như cũ');
  assert.equal(hasNewerCustomerMessage([a, b, reply], a), false, 'tin sau đã có lời bot → không nhường');
  assert.equal(hasNewerCustomerMessage([a, b], a, { handledId: 'b' }), false, 'tin sau đã xử lý im (botHandledMessageId) → không nhường');
  const staff = { ...reply, sender: undefined, staff: true };
  assert.equal(hasNewerCustomerMessage([a, b, staff], a), true, 'lời nhân viên: giữ như cũ');
  const c = { id: 'c', direction: 'incoming', type: 'text', text: 'Ship HN bao lâu', createdAt: t - 100 };
  assert.equal(hasNewerCustomerMessage([a, b, reply, c], a), true, 'còn tin mới hơn chưa trả lời → nhường');
});

test('B1. ca …7090002988: "Loại ko đường" được trả lời trước, "Xin giá" (giờ sớm hơn) tới sau → vẫn trả bảng giá', async () => {
  const sim = new Sim({ psid: 'r17b-1' });
  const inbox = sim.inbox({});
  const t = Date.now();
  const b = { id: 'mB', mid: 'mB', direction: 'incoming', type: 'text', text: 'Loại ko đường', createdAt: t - 1000 };
  sim.list(inbox.id).push(b);
  const first = await sim.send(inbox, '', { existing: b, llm: { template_id: 'NO_ADDED_SUGAR' } });
  assert.ok(first.sent.length > 0, 'lượt "Loại ko đường" có trả lời');
  const a = { id: 'mA', mid: 'mA', direction: 'incoming', type: 'text', text: 'Xin giá', createdAt: t - 2000 };
  sim.list(inbox.id).push(a);
  sim.list(inbox.id).sort((x, y) => x.createdAt - y.createdAt);
  const second = await sim.send(inbox, '', { existing: a, llm: { template_id: 'PRICE_QUOTE', Product_N1: X } });
  assert.notEqual(second.result.skipped, 'gộp với tin sau', JSON.stringify(second.result));
  assert.match(texts(second), /298\.000|189\.000|Bảng giá/i, texts(second));
});

// ---- B2. (inbox5 A3, ca …263420 / …457337; inbox2 M5 …0495079233) giỏ giữ đã thành đơn Shop/POS → không hỏi "đặt THÊM?".
const HOUR = 60 * MIN;
const posOrder = (agoMs, items, extra = {}) => ({ id: `pos${Math.round(agoMs / 1000)}`, createdAt: Date.now() - agoMs, total: 298000, status: 'Đã xác nhận', source: 'POS', phone: PHONE, address: 'thôn lạc thuận, xã tánh linh, tỉnh lâm đồng', products: items.map(item => ({ name: item.product, sku: item.code, quantity: item.quantity })), ...extra });

test('B2. ca …263420: giỏ Shop 2 Xanh = đơn Shop 2 Xanh (vào POS sau lúc giữ giỏ); khách gửi SĐT (+ địa chỉ) → kể đơn đã có, bỏ giỏ, không "đặt THÊM"', async () => {
  for (const text of [PHONE, `${PHONE} Số nhà 1/27 thôn lạc thuận xã tánh linh tỉnh lâm đồng`]) {
    const sim = new Sim({ psid: `r17b-2-${text.length}` });
    const inbox = sim.inbox({ labels: ['livestream'], botLastTemplateId: 'ORDER_ADDRESS_REMIND', botLastReplyAt: Date.now() - MIN, pendingOrder: basket([XANH(2)], 12 * HOUR, { livestream: true }), customerOrders: [posOrder(11 * HOUR, [XANH(2)])] });
    sim.history(inbox, 'outgoing', 'Dạ em vẫn đang giữ đơn 2 Granola Túi Xanh 450g – tổng 298.000đ …', MIN, { sender: 'bot' });
    const turn = await sim.send(inbox, text, { llm: { template_id: 'ORDER_CONFIRMATION', Product_N1: X, No_A: '2', Phone_Number: PHONE, Customer_Address: 'Số nhà 1/27 thôn lạc thuận xã tánh linh tỉnh lâm đồng' } });
    assert.equal(turn.result.templateId, 'ORDER_STATUS', `${text}: ${JSON.stringify(turn.result)}`);
    assert.doesNotMatch(texts(turn), /đặt THÊM|gộp/);
    assert.equal(turn.created.length, 0);
    assert.equal(inbox.pendingOrder, null);
  }
});

test('B2. giỏ giữ đã thành đơn nhưng khách gửi SĐT KHÁC → kể đơn + thẻ + ghi chú cho bạn phụ trách', async () => {
  const notes = [];
  const sim = new Sim({ psid: 'r17b-2c' });
  const inbox = sim.inbox({ botLastTemplateId: 'ORDER_ADDRESS', botLastReplyAt: Date.now() - MIN, pendingOrder: basket([XANH(2)], 30 * MIN), customerOrders: [posOrder(29 * MIN, [XANH(2)])] });
  const turn = await sim.send(inbox, '0987654321', { llm: { template_id: 'ORDER_ADDRESS', Product_N1: X, No_A: '2', Phone_Number: '0987654321' }, extra: { addStaffNote: async (_c, note) => { notes.push(note); } } });
  assert.equal(turn.result.templateId, 'ORDER_STATUS');
  assert.ok(inbox.labels.includes('handoff'), 'thẻ cần người');
  assert.match(notes.join(' '), /0987654321/);
});

test('B2. inbox2 M5 (ca …0495079233): giỏ Shop 1 Xanh đã thành đơn s…; "Ok, cho c 2 túi" → xin đổi đơn (ORDER_CHANGE_STAFF + ghi chú), không "đặt THÊM"', async () => {
  const sim = new Sim({ psid: 'r17b-2m5' });
  const inbox = sim.inbox({ botLastTemplateId: 'UPSELL_TWO_BAGS', botLastReplyAt: Date.now() - 60 * MIN, pendingOrder: basket([XANH(1)], 70 * MIN, { fromShop: true }), customerOrders: [posOrder(69 * MIN, [XANH(1)], { id: 's56790', total: 189000 })] });
  const turn = await sim.send(inbox, 'Ok, cho c 2 túi', { llm: { template_id: 'ORDER_ADDRESS', Product_N1: X, No_A: '2' } });
  assert.equal(turn.result.templateId, 'ORDER_CHANGE_STAFF', JSON.stringify(turn.result));
  assert.deepEqual(turn.notes.map(item => item.orderId), ['s56790']);
  assert.doesNotMatch(texts(turn), /đặt THÊM|gộp/);
});

test('B2. readMergeSplitReply: "1 đơn nha e" / "Chị mua 1 đơn thôi em nhé" = one; "thế thì thôi em ạ" / "không cần" = decline; câu khác giữ ""', async () => {
  const { readMergeSplitReply } = await import('../app/chatbot-engine.mjs');
  for (const text of ['1 đơn nha e', 'Chị mua 1 đơn thôi em nhé', 'chỉ 1 đơn thôi', 'một đơn thôi ạ']) assert.equal(readMergeSplitReply(text), 'one', text);
  for (const text of ['thế thì thôi em ạ', 'thôi', 'không cần em', 'vậy thôi nha', 'Dạ thôi ạ']) assert.equal(readMergeSplitReply(text), 'decline', text);
  for (const text of ['Chị đặt 1 đơn 2 túi', 'thôi khỏi gộp', 'thôi khỏi, không cần đơn khác', 'không mua thêm', 'không cần đâu']) assert.equal(readMergeSplitReply(text), '', text);
});

test('B2. ca …457337: đã hỏi "đặt THÊM?" với giỏ trùng đúng đơn trong hội thoại → "Chị mua 1 đơn thôi em nhé" kể đơn, bỏ giỏ, không STAFF_WAIT', async () => {
  for (const text of ['1 đơn nha e', 'Chị mua 1 đơn thôi em nhé']) {
    const sim = new Sim({ psid: `r17b-2d-${text.length}` });
    const order = posOrder(40 * MIN, [XANH(3)], { source: 'landing', total: 447000 });
    const inbox = sim.inbox({ botLastTemplateId: 'ORDER_EXISTING_CONFIRM', botLastReplyAt: Date.now() - MIN, customerOrders: [order], pendingOrder: basket([XANH(3)], MIN, { phone: PHONE, address: order.address, awaitingConfirm: true, addOnlyAsk: true }) });
    const turn = await sim.send(inbox, text, { llm: { template_id: 'ORDER_CONFIRMATION', Product_N1: X, No_A: '3' } });
    assert.equal(turn.result.templateId, 'ORDER_STATUS', `${text}: ${JSON.stringify(turn.result)}`);
    assert.equal(turn.created.length, 0);
    assert.equal(inbox.pendingOrder, null);
    assert.ok(!inbox.labels.includes('handoff'), text);
  }
  // Giỏ KHÁC đơn → bạn phụ trách như cũ.
  const sim = new Sim({ psid: 'r17b-2d-diff' });
  const inbox = sim.inbox({ botLastTemplateId: 'ORDER_EXISTING_CONFIRM', botLastReplyAt: Date.now() - MIN, customerOrders: [posOrder(40 * MIN, [XANH(3)], { source: 'landing' })], pendingOrder: basket([VANG(2)], MIN, { phone: PHONE, awaitingConfirm: true, addOnlyAsk: true }) });
  const turn = await sim.send(inbox, '1 đơn nha e', { llm: { template_id: 'ORDER_CONFIRMATION', Product_N1: V, No_A: '2' } });
  assert.match(String(turn.result.templateId || ''), STAFF);
});

// ---- B3. (inbox3 A4, ca …5625762756) đơn bot 2 Xanh; "cho chị 1 túi xanh và 1 túi vàng nhé" = ĐỔI đơn (cùng tổng túi), không đặt thêm 1 Vàng.
const botOrder = agoMs => ({ id: 'ob', createdAt: Date.now() - agoMs, automatic: true, total: 298000, status: 'Mới', phone: PHONE, address: '12 Lê Lợi, Phường Bến Nghé, Quận 1, TP Hồ Chí Minh', products: [{ name: X, sku: 'GRA-XANH-Z450', quantity: 2 }] });
test('B3. ca …5625762756: quá 60 phút → ORDER_CHANGE_STAFF "đổi đơn thành 1X + 1V" (ghi chú đơn), không hỏi gộp 1 Vàng; "chị lấy 2 túi xanh em nhé" → giữ nguyên đơn + ghi chú', async () => {
  const notes = [];
  const sim = new Sim({ psid: 'r17b-3' });
  const inbox = sim.inbox({ botLastTemplateId: 'ORDER_CONFIRMATION', botLastReplyAt: Date.now() - 70 * MIN, customerOrders: [botOrder(70 * MIN)] });
  const first = await sim.send(inbox, 'cho chị 1 túi xanh và 1 túi vàng nhé', { llm: { template_id: 'ORDER_ADDRESS', Product_N1: X, No_A: '1', Product_N2: V, No_B: '1' } });
  assert.equal(first.result.templateId, 'ORDER_CHANGE_STAFF', JSON.stringify(first.result));
  assert.match(texts(first), /1 Granola Túi Xanh 450g \+ 1 Granola Túi Vàng 350g/);
  assert.deepEqual(first.notes.map(item => item.orderId), ['ob']);
  const back = await sim.send(inbox, 'chị lấy 2 túi xanh em nhé', { llm: { template_id: 'ORDER_ADDRESS', Product_N1: X, No_A: '2' }, extra: { addStaffNote: async (_c, note) => { notes.push(note); } } });
  assert.equal(back.result.templateId, 'ORDER_STATUS', JSON.stringify(back.result));
  assert.doesNotMatch(texts(back), /gộp|tách/);
  assert.match(notes.join(' '), /GIỮ NGUYÊN/);
});

test('B3. trong 60 phút → sửa đơn thành 1X + 1V (ORDER_UPDATE), 298.000đ', async () => {
  const sim = new Sim({ psid: 'r17b-3b' });
  const inbox = sim.inbox({ botLastTemplateId: 'ORDER_CONFIRMATION', botLastReplyAt: Date.now() - 20 * MIN, customerOrders: [botOrder(20 * MIN)] });
  const turn = await sim.send(inbox, 'cho chị 1 túi xanh và 1 túi vàng nhé', { llm: { template_id: 'ORDER_ADDRESS', Product_N1: X, No_A: '1', Product_N2: V, No_B: '1' } });
  assert.equal(turn.created[0]?.update, 'ob', JSON.stringify(turn.result));
  assert.deepEqual(codes(turn.created[0].items), ['1 GRA-VANG-H350', '1 GRA-XANH-Z450']);
  assert.equal(turn.created[0].total, 298000);
});

test('B3. "thế thì thôi em ạ" sau câu hỏi gộp/tách (đơn trong hội thoại) → giữ nguyên đơn, bỏ giỏ thêm, không STAFF_WAIT', async () => {
  const sim = new Sim({ psid: 'r17b-3c' });
  const inbox = sim.inbox({ botLastTemplateId: 'ORDER_EXISTING_CONFIRM', botLastReplyAt: Date.now() - MIN, customerOrders: [botOrder(70 * MIN)], pendingOrder: basket([VANG(1)], MIN, { awaitingConfirm: true }) });
  const turn = await sim.send(inbox, 'thế thì thôi em ạ', { llm: { template_id: 'THANK_YOU' } });
  assert.equal(turn.result.templateId, 'ORDER_STATUS', JSON.stringify(turn.result));
  assert.equal(inbox.pendingOrder, null);
  assert.ok(!inbox.labels.includes('handoff'));
});

// ---- B4. (inbox5 A4 ca …099903; inbox1 A6 ca …5213896521; quyết định 7) đơn cũ chưa giao, khách giục.
const oldOrder = (agoMs, extra = {}) => ({ id: 'old1', createdAt: Date.now() - agoMs, total: 298000, status: 'Đã xác nhận', phone: PHONE, address: 'x', products: [{ name: V, sku: 'GRA-VANG-H350', quantity: 2 }], ...extra });
test('B4. ca …099903: đơn 18 ngày "Đã xác nhận" + "E ơi chưa chuyển hàng cho mình ạ" → CSKH (tắt bot, thẻ Khiếu nại), không "thời gian giao 1–3 ngày"', async () => {
  for (const tpl of ['ORDER_STATUS', 'SHIPPING_POLICY']) {
    const sim = new Sim({ psid: `r17b-4-${tpl}` });
    const inbox = sim.inbox({ customerOrders: [oldOrder(18 * DAY)] });
    const turn = await sim.send(inbox, 'E ơi chưa chuyển hàng cho mình ạ', { llm: { template_id: tpl } });
    assert.equal(turn.result.templateId, 'CSKH_HANDOFF', `${tpl}: ${JSON.stringify(turn.result)}`);
    assert.doesNotMatch(texts(turn), /1–3 ngày/);
    assert.ok(inbox.labels.includes('complaint') && inbox.labels.includes('handoff'), inbox.labels.join(','));
    assert.equal(inbox.botEnabled, false);
  }
});

test('B4. đơn 5 ngày chưa giao (≤ 7 ngày) → vẫn DELIVERY_DELAY + thẻ; đơn đã giao (Sapo delivered) "Có chot đơn chị chua" → không "xin lỗi giao chậm"', async () => {
  const sim = new Sim({ psid: 'r17b-4b' });
  const inbox = sim.inbox({ customerOrders: [oldOrder(5 * DAY)] });
  const turn = await sim.send(inbox, 'đơn chị tới đâu rồi em', { llm: { template_id: 'ORDER_STATUS' } });
  assert.equal(turn.result.templateId, 'DELIVERY_DELAY');
  assert.ok(inbox.labels.includes('handoff'));
  const sim2 = new Sim({ psid: 'r17b-4c' });
  const inbox2 = sim2.inbox({ customerOrders: [oldOrder(8 * DAY, { shipment: { carrier: 'SPX', trackingNumber: 'SPXVN1', status: 'delivered' } })] });
  const turn2 = await sim2.send(inbox2, 'Có chot đơn chị chua', { llm: { template_id: 'ORDER_STATUS' } });
  assert.notEqual(turn2.result.templateId, 'DELIVERY_DELAY', JSON.stringify(turn2.result));
  assert.notEqual(turn2.result.templateId, 'CSKH_HANDOFF');
});

// ---- B5. Khiếu nại nặng (quyết định 7): inbox1 A6, inbox4 H4, inbox2 M8, comments B3.
test('B5. khiếu nại nặng khi đã có đơn → CSKH ngay (tắt bot, thẻ Khiếu nại), không lập giỏ / bảng quà', async () => {
  const cases = [
    ['2 gói hàng 298k ship thu tóa 400k', 'ORDER_ADDRESS', { Product_N1: X, No_A: '2' }],
    ['Nay ship thu tớ 400k', 'GENERAL_INFO', {}],
    ['Sao hôm trước trong live bảo có quà tặng mà đơn về không thấy ạ.', 'GIFT_POLICY_LIVE', {}],
    ['nói tặng đồ mà có thấy gì đâu', 'COMPLAINT_SORRY', {}],
    ['Đặt từng gói nhỏ đi giao gói lớn', 'ORDER_ADDRESS', { Product_N1: 'Combo 10 gói', No_A: '1' }],
    ['sao shop lại giao đến tận Hà Đông vậy', 'STAFF_WAIT_OPEN', {}]
  ];
  for (const [text, tpl, fields] of cases) {
    const sim = new Sim({ psid: `r17b-5-${text.length}` });
    const inbox = sim.inbox({ labels: ['delivered'], customerOrders: [oldOrder(4 * DAY, { status: 'Đã giao hàng' })] });
    const turn = await sim.send(inbox, text, { llm: { template_id: tpl, ...fields } });
    assert.equal(turn.result.templateId, 'CSKH_HANDOFF', `${text}: ${JSON.stringify(turn.result)}`);
    assert.equal(turn.created.length, 0, text);
    assert.ok(inbox.labels.includes('complaint'), `${text}: ${inbox.labels.join(',')}`);
    assert.ok(!inbox.pendingOrder?.items?.length, `${text}: không lập giỏ`);
  }
});

test('B5. không có đơn / câu hỏi trước khi mua → không coi là khiếu nại', async () => {
  for (const [text, tpl] of [['Có giao đến tận nơi không em', 'SHIPPING_POLICY'], ['Mua 2 túi có tặng quạt không', 'GIFT_POLICY_LIVE'], ['ship thu bao nhiêu 1 túi', 'FREESHIP_POLICY']]) {
    const sim = new Sim({ psid: `r17b-5n-${text.length}` });
    const inbox = sim.inbox({});
    const turn = await sim.send(inbox, text, { llm: { template_id: tpl } });
    assert.notEqual(turn.result.templateId, 'CSKH_HANDOFF', text);
    assert.ok(!inbox.labels.includes('complaint'), text);
  }
});

test('B5. inbox4 H4 ca …0287576706: "Chị đã đăng kí mua rồi đấy" → tra đơn (ORDER_STATUS), không lập giỏ 1 Xanh', async () => {
  const sim = new Sim({ psid: 'r17b-5r' });
  const inbox = sim.inbox({});
  const turn = await sim.send(inbox, 'Chị đã đăng kí mua rồi đấy', { llm: { template_id: 'ORDER_ADDRESS', Product_N1: X, No_A: '1' } });
  assert.equal(turn.result.templateId, 'ORDER_STATUS', JSON.stringify(turn.result));
  assert.ok(!inbox.pendingOrder?.items?.length);
});

// ---- B6. (quyết định 6; comments B1 "Chị ck rồi nhé" ca …800681; inbox1 B3 "Minh ck trước") chuyển khoản → CSKH, không gửi STK.
test('B6. "Chị ck rồi nhé" / "Minh ck trước" / "cho chị xin stk" → CSKH (tắt bot + thẻ), không gửi số tài khoản, không im', async () => {
  for (const [text, tpl] of [['Chị ck rồi nhé', 'THANK_YOU'], ['Minh ck trước', 'PAYMENT_METHODS'], ['cho chị xin stk', 'BANK_TRANSFER'], ['ok em, mình chuyển khoản nhé', 'BANK_TRANSFER']]) {
    const sim = new Sim({ psid: `r17b-6-${text.length}` });
    const inbox = sim.inbox({ pendingOrder: basket([XANH(3)], 5 * MIN, { phone: PHONE }) });
    const turn = await sim.send(inbox, text, { llm: { template_id: tpl } });
    assert.equal(turn.result.templateId, 'CSKH_HANDOFF', `${text}: ${JSON.stringify(turn.result)}`);
    assert.doesNotMatch(texts(turn), /ACB|18066788|số tài khoản/i, text);
    assert.ok(inbox.labels.includes('handoff'), text);
  }
});

// ---- B8. (inbox4 H2, ca …8336154066) ảnh không chữ của khách có đơn đã gửi hãng → "đã nhận hình" + thẻ, không bước đơn / bảng giá.
test('B8. ca …8336154066: ảnh không chữ, đơn 4 ngày đã gửi hãng (có/không đọc ảnh) → IMAGE_RECEIVED + thẻ, không "đặt THÊM", không bảng giá live', async () => {
  for (const vision of [false, true]) {
    const sim = new Sim({ psid: `r17b-8-${vision}`, settings: vision ? { provider: 'vertex', visionEnabled: true } : {} });
    const inbox = sim.inbox({ labels: ['livestream', 'shipment-sent'], customerOrders: [oldOrder(4 * DAY, { products: [{ name: X, sku: 'GRA-XANH-Z450', quantity: 2 }] })] });
    const turn = await sim.send(inbox, '', { type: 'image', message: { images: ['https://example.test/a.jpg'], dataUrl: 'data:image/jpeg;base64,AAAA' }, llm: { template_id: 'ORDER_CONFIRMATION', Product_N1: X, No_A: '2', Phone_Number: PHONE, Customer_Address: 'x' } });
    assert.equal(turn.result.templateId, 'IMAGE_RECEIVED', `${vision}: ${JSON.stringify(turn.result)}`);
    assert.equal(turn.asked.length, 0);
    assert.doesNotMatch(texts(turn), /đặt THÊM|298\.000/);
    assert.ok(inbox.labels.includes('handoff'));
  }
  // Khách chưa mua: ảnh vẫn theo luồng cũ (lời chào live cho khách live).
  const sim = new Sim({ psid: 'r17b-8-new' });
  const inbox = sim.inbox({ labels: ['livestream'], livestreamCustomer: true });
  const turn = await sim.send(inbox, '', { type: 'image', message: { images: ['https://example.test/a.jpg'] } });
  assert.notEqual(turn.result.templateId, 'IMAGE_RECEIVED');
});

// ---- B9. (inbox2 C4 ca …5612586397, inbox4 H3 ca …7766508696 / …9616721859; quyết định 4) trùng tin vừa gửi khi giữ giỏ → câu thay thế.
test('B9. giữ 2 Túi Xanh, "Có dc tặng gáo dừa với muỗng kg em" lặp quà → quà của giỏ + mời thêm 1 túi (3 túi 447.000đ) để được Bộ bát + Muỗng, không STAFF_WAIT', async () => {
  for (const live of [false, true]) {
    const sim = new Sim({ psid: `r17b-9-${live}` });
    const inbox = sim.inbox({ ...(live ? { labels: ['livestream'], livestreamCustomer: true } : {}), botLastTemplateId: 'GIFT_POLICY', botLastReplyAt: Date.now() - MIN, pendingOrder: basket([XANH(2)], 5 * MIN, live ? { livestream: true } : {}) });
    const sent = renderChatbotReply({ template_id: live ? 'GIFT_POLICY_LIVE' : 'GIFT_POLICY' }, templates, { livestream: live }).messages.join('\n');
    sim.history(inbox, 'incoming', 'Có được tặng gáo dừa k ạ?', 1.2 * MIN);
    sim.history(inbox, 'outgoing', sent, MIN, { sender: 'bot' });
    const turn = await sim.send(inbox, live ? 'Không được tặng gáo hả c?' : 'Có dc tặng gáo dừa với muỗng kg em', { llm: { template_id: live ? 'GIFT_POLICY_LIVE' : 'GIFT_POLICY' } });
    assert.doesNotMatch(String(turn.result.templateId || ''), STAFF, `${live}: ${JSON.stringify(turn.result)}`);
    // Khách thường: GIFT_POLICY_UPSELL3 ("bộ bát + muỗng dừa tặng cho đơn từ 3 túi (3 túi 447.000đ)…"); khách live: quà của giỏ (Quạt)
    // + "lấy thêm 1 túi nữa (3 túi 447.000đ…) là được tặng <quà 3 túi>".
    assert.match(texts(turn), /3 túi 447\.000đ, miễn phí vận chuyển/, texts(turn));
    assert.match(texts(turn), /lấy thêm 1 túi/);
    assert.match(texts(turn), /[Bb]át/);
    if (live) assert.match(texts(turn), /Quạt/);
    assert.ok(turn.sent.length > 0);
  }
});

test('B9. lời mời 3 túi VỪA gửi, khách hỏi quà lần nữa → quà của giỏ + mời thêm 1 túi (câu khác), không STAFF_WAIT; ca …7338407078 so sánh túi lặp → mẫu cùng họ', async () => {
  const sim = new Sim({ psid: 'r17b-9u' });
  const inbox = sim.inbox({ botLastTemplateId: 'GIFT_POLICY', botLastReplyAt: Date.now() - MIN, pendingOrder: basket([XANH(2)], 5 * MIN) });
  const upsell = renderChatbotReply({ template_id: 'GIFT_POLICY_UPSELL3', values: { total3: '447.000đ' } }, templates, {}).messages.join('\n');
  sim.history(inbox, 'outgoing', upsell, MIN, { sender: 'bot' });
  const turn = await sim.send(inbox, 'Mua 2 túi k tặng muỗng hả em', { llm: { template_id: 'GIFT_POLICY' } });
  assert.doesNotMatch(String(turn.result.templateId || ''), STAFF, JSON.stringify(turn.result));
  assert.match(texts(turn), /lấy thêm 1 túi nữa \(3 túi 447\.000đ/, texts(turn));
  const sim2 = new Sim({ psid: 'r17b-9c' });
  const inbox2 = sim2.inbox({ botLastTemplateId: 'BAG_COMPARISON_XANH_VANG', botLastReplyAt: Date.now() - MIN });
  sim2.history(inbox2, 'outgoing', renderChatbotReply({ template_id: 'BAG_COMPARISON_XANH_VANG' }, templates, {}).messages.join('\n'), MIN, { sender: 'bot' });
  const turn2 = await sim2.send(inbox2, 'Nguyên bản là bit nào', { llm: { template_id: 'BAG_COMPARISON_XANH_VANG' } });
  assert.equal(turn2.result.templateId, 'BAG_COMPARISON', JSON.stringify(turn2.result));
});

test('B9. ca …9616721859: giữ 2 Túi Vàng (có SĐT), "Bao tiền" lặp bảng giá → nhắc giỏ + tổng + xin địa chỉ, không STAFF_WAIT', async () => {
  const sim = new Sim({ psid: 'r17b-9p' });
  const inbox = sim.inbox({ botLastTemplateId: 'PRICE_QUOTE', botLastReplyAt: Date.now() - MIN, pendingOrder: basket([VANG(2)], 10 * MIN, { phone: PHONE }) });
  const quote = renderChatbotReply({ template_id: 'PRICE_QUOTE', Product_N1: V }, templates, {}).messages.join('\n');
  sim.history(inbox, 'incoming', 'Túi to', 1.2 * MIN);
  sim.history(inbox, 'outgoing', quote, MIN, { sender: 'bot' });
  const turn = await sim.send(inbox, 'Bao tiền', { llm: { template_id: 'PRICE_QUOTE', Product_N1: V } });
  assert.doesNotMatch(String(turn.result.templateId || ''), STAFF, JSON.stringify(turn.result));
  assert.match(texts(turn), /đang giữ đơn 2 Granola Túi Vàng 350g/, texts(turn));
});

// ---- B7. (inbox1 A4 / bình luận A1, ca …8779324731) giỏ Shop 1 Tropical 14 phút trước; bình luận "1 vàng 1xanh" → giỏ hộp thư 1V + 1X.
test('B7. ca …8779324731: bình luận mới hơn giỏ Facebook Shop đã bấm → ghi đè giỏ hộp thư; giỏ khách tự gõ ở hộp thư vẫn giữ', async () => {
  const TROPICAL = { product: 'Granola Tropical vị Cacao 300g', code: 'GRA-MINT-Z300', quantity: 1 };
  const sim = new Sim({ psid: 'r17b-7' });
  const inbox = sim.inbox({ labels: ['livestream'], botLastTemplateId: 'ORDER_ADDRESS', botLastReplyAt: Date.now() - 14 * MIN, pendingOrder: basket([TROPICAL], 14 * MIN) });
  sim.history(inbox, 'incoming', 'Khách chọn mua từ Facebook Shop: Granola Tropical vị Cacao 300g (GRA-MINT-Z300) — 219.000đ', 14 * MIN, { cart: [{ sku: 'GRA-MINT-Z300', quantity: 1 }] });
  sim.history(inbox, 'outgoing', 'Dạ em đã nhận giỏ 1 Granola Tropical…', 14 * MIN, { sender: 'bot' });
  const thread = sim.comment({ post: { id: 'live-1', message: 'Săn deal cùng Giọt Nắng ạ' } });
  const turn = await sim.send(thread, '1 vàng 1xanh', { llm: { template_id: 'ORDER_ADDRESS', Product_N1: V, No_A: '1', Product_N2: X, No_B: '1' } });
  assert.match(texts(turn), /Vàng/);
  assert.deepEqual(codes(inbox.pendingOrder.items), ['1 GRA-VANG-H350', '1 GRA-XANH-Z450'], JSON.stringify(inbox.pendingOrder));
});

// ---- B11. Bình luận: A2 "mộc" ≠ "mốc", A3 lời chê có "mua"/chữ số, A5 "Có bán cái tô…", A6 "Cho mình hỏi bịch màu vàng".
test('B11. A2 ca …229538: "Hũ hạnh nhân sấy mộc có ko e" / "Granola vị mộc có ngọt không" không phải khiếu nại; "bị mốc" vẫn là khiếu nại', async () => {
  const { isComplaint, autoLabelEventsFor } = await import('../app/processing/auto-label.mjs');
  for (const text of ['Hũ hạnh nhân sấy mộc có ko e', 'Granola vị mộc có ngọt không', 'VỊ NGUYÊN BẢN – MỘC MẠC']) {
    assert.equal(isComplaint({ text }), false, text);
    assert.ok(!autoLabelEventsFor({ text }).includes('warranty'), text);
  }
  for (const text of ['Hàng bị mốc rồi shop', 'mở ra thấy mốc']) assert.equal(isComplaint({ text }), true, text);
  const sim = new Sim({ psid: 'r17b-11a' });
  const thread = sim.comment({ post: { id: 'live-1', message: 'Săn deal cùng Giọt Nắng ạ' } });
  const turn = await sim.send(thread, 'Hũ hạnh nhân sấy mộc có ko e', { llm: { template_id: 'STAFF_ONLY_PRODUCT' } });
  assert.doesNotMatch(texts(turn), /xin lỗi/i, texts(turn));
  assert.ok(!thread.labels.includes('complaint'), thread.labels.join(','));
});

test('B11. A3 ca …643673 / …644292: lời chê có "mua"/chữ số → xin lỗi công khai + thẻ, không bảng giá', async () => {
  for (const text of ['Hàng dở tệ. Mua lần 1 ko bao giờ có lần 2', 'Nhìn vậy chứ mua về k thấy hạt nhiều như vậy.']) {
    const sim = new Sim({ psid: `r17b-11c-${text.length}` });
    const thread = sim.comment();
    const turn = await sim.send(thread, text, { llm: { template_id: 'CSKH_HANDOFF' } });
    assert.doesNotMatch(texts(turn), /Bảng giá|298\.000|189\.000/, `${text}: ${texts(turn)}`);
    assert.match(texts(turn), /xin lỗi/i, `${text}: ${texts(turn)}`);
  }
});

test('B11. A5 ca …930924 "Có bán cái tô em cầm không" → có trả lời (không chỉ like); A6 ca …985385 "Cho mình hỏi bịch màu vàng" → không lập giỏ hộp thư', async () => {
  const sim = new Sim({ psid: 'r17b-11e' });
  const live = sim.comment({ post: { id: 'live-1', message: 'Săn deal cùng Giọt Nắng ạ' } }, 'l1');
  const bowl = await sim.send(live, 'Có bán cái tô em cầm không', { llm: { template_id: 'GIFT_POLICY_LIVE' } });
  assert.notEqual(bowl.result.skipped, 'bình luận đùa/không liên quan (chỉ like)', JSON.stringify(bowl.result));
  assert.ok(bowl.sent.length > 0);
  const sim2 = new Sim({ psid: 'r17b-11f' });
  const ask = await sim2.send(sim2.comment(), 'Cho mình hỏi bịch màu vàng', { llm: { template_id: 'PRICE_QUOTE', Product_N1: V } });
  assert.ok(ask.sent.length > 0);
  assert.ok(!sim2.inbox().pendingOrder?.items?.length, JSON.stringify(sim2.inbox().pendingOrder));
});

test('B11. A4 ca …349146 / …324731: hộp thư giữ giỏ 1 Xanh, bình luận hỏi mã giảm / "sao phải mua 2 gói" → trả lời câu hỏi + nhắc giỏ đúng 1 túi', async () => {
  for (const [text, tpl] of [['Không thay mã giảm vay chi', 'LIVESTREAM_VOUCHER'], ['Sao phải mua 2 gói mới được giá 174 hả shop', 'DISCOUNT_POLICY']]) {
    const sim = new Sim({ psid: `r17b-11g-${text.length}` });
    sim.inbox({ botLastTemplateId: 'ORDER_ADDRESS', botLastReplyAt: Date.now() - 10 * MIN, pendingOrder: basket([XANH(1)], 10 * MIN) });
    const answer = renderChatbotReply({ template_id: tpl }, templates, {}).messages[0];
    // (Dưới bài LIVE, DISCOUNT_POLICY bị ép về lời chào live — điều kiện ép thuộc gói C; ở đây bài thường.)
    const post = tpl === 'LIVESTREAM_VOUCHER' ? { id: 'live-1', message: 'Săn deal cùng Giọt Nắng ạ' } : { id: 'p-1', message: 'Granola Giọt Nắng giòn rụm' };
    const turn = await sim.send(sim.comment({ post }), text, { llm: { template_id: tpl } });
    const privateText = turn.sent.filter(item => item.privateReply).map(item => item.text).join(' ‖ ');
    assert.ok(privateText.includes(answer.slice(0, 30)), `${text}: ${privateText}`);
    assert.match(privateText, /đang giữ đơn 1 Granola Túi Xanh/, `${text}: ${privateText}`);
    assert.doesNotMatch(privateText, /2 Granola Túi Xanh/);
  }
});

// ---- B12. (bình luận B1 / hộp thư, ca …095756 "ăn ngon lắm", …615973) lời khen / hứa mua tiếp → cảm ơn, không im, không thẻ.
test('B12. "ăn ngon lắm" / "Ăn ngon em sẽ mua thường xuyên ạ" / "Ngon bua sau mua tiep" (mô hình chọn THANK_YOU) → cảm ơn, không thẻ cần người', async () => {
  for (const text of ['ăn ngon lắm', 'Ăn ngon em sẽ mua thường xuyên ạ', 'Ngon bua sau mua tiep']) {
    const sim = new Sim({ psid: `r17b-12-${text.length}` });
    const inbox = sim.inbox({ customerOrders: [oldOrder(5 * DAY, { status: 'Đã giao hàng' })] });
    const turn = await sim.send(inbox, text, { llm: { template_id: 'THANK_YOU' } });
    assert.equal(turn.result.templateId, 'THANK_YOU', `${text}: ${JSON.stringify(turn.result)}`);
    assert.ok(turn.sent.length > 0);
    assert.ok(!inbox.labels.includes('handoff'), text);
  }
});
