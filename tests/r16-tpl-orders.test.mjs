// Vòng 16 (05/10) — bộ soạn đơn / mẫu (chatbot-templates.mjs), câu khách thật trong báo cáo r16 (không tên, không SĐT thật):
// - inbox1 A1 (…9387140891, 04/10 10:09) "Mua 2 túi nâu xanh" → đơn 2 Nâu + 1 Xanh 437k (khách muốn 1 + 1).
// - inbox1 A2 (…2228960004, 05/10 08:02) giữ 3 Xanh + "Mình lấy 3 màu" → 3X + 1V + 1N 740k; "Vậy tổng là 5 túi, tặng 1 túi
//   vàng + 1 bộ bát, thìa đúng ko shop" (màu sau "tặng" là quà).
// - inbox1 A7 (…9053175659) "Bộ bát + muỗng dừa chị ko lấy đâu" → bảng quà, đơn vẫn kèm bát.
// - inbox1 A8 (…8040193418) "1 vị ca cao, 1 ngủ cốc" → bot coi là 1 túi; "01 túi hạt ngũ cốc" → Túi Vàng.
// - inbox3 A4 (…8987226913) địa chỉ đã gửi ở tin trước, bot xin "kèm địa chỉ nhận hàng đầy đủ".
// - inbox5 A8 (…2228921202) đổi địa chỉ đơn live → câu "em đã sửa lại đơn" bỏ dòng quà.
import assert from 'node:assert/strict';
import test from 'node:test';
import { Sim, PHONE, XANH, VANG, NAU, basket, templates } from './helpers/r13-engine-sim.mjs';
import { colourCountsInText, distinctKindsCount, flavourSplitAsk, ambiguousCerealBags, isGiftSwapRequest, adjustOrderQuantities, renderChatbotReply } from '../app/chatbot-templates.mjs';

const MIN = 60000;
const X = 'Granola Túi Xanh 450g', V = 'Granola Túi Vàng 350g', N = 'Granola Túi Nâu vị cacao 350g';
const itemsOf = list => (list || []).map(item => `${item.quantity} ${item.code}`).sort();
const countsOf = text => Object.fromEntries(Object.entries(colourCountsInText(text).counts).sort());
const ADDR_A1 = 'Ấp 7 phú lập tân phú đồng nai ấp 2 núi tượng củ';
// Mẫu ORDER_UPDATED / ORDER_PHONE_ASK_FLAVOR / ORDER_INFO_ASK_FLAVOR ĐANG CHẠY trên máy chủ (r16/settings.json, 05/10).
const LIVE_ORDER_UPDATED = 'Dạ em đã sửa lại đơn cho mình như sau ạ:\n\n[[items]]🌾 {product} – Số lượng: {quantity}[[/items]]\n━━━━━━━━━━━━\n📞 Số điện thoại: {phone}\n🏡 Địa chỉ nhận hàng: {address}\n💰 Tổng tiền: {total}[?free_ship] ({free_ship})[/?]\n\nĐúng rồi thì mình không cần trả lời thêm, có gì chưa đúng {title} nhắn em sửa tiếp nha ạ.';

// ===== A1: "N túi" + danh sách màu =====

test('A1 (hàm thuần): "N túi" trước danh sách ≥ 2 màu không kèm số → N = số màu thì mỗi màu 1; khác thì không chia (splitAsk)', () => {
  assert.deepEqual(countsOf('Mua 2 túi nâu xanh'), { NAU: 1, XANH: 1 });
  assert.deepEqual(countsOf(`Mua 2 túi nâu xanh\n${ADDR_A1}\n${PHONE}`), { NAU: 1, XANH: 1 });
  assert.deepEqual(countsOf('2 túi xanh vàng'), { VANG: 1, XANH: 1 });
  assert.deepEqual(countsOf('lấy 2 túi nâu và xanh'), { NAU: 1, XANH: 1 });
  assert.deepEqual(countsOf('3 túi xanh vàng nâu'), { NAU: 1, VANG: 1, XANH: 1 });
  assert.deepEqual(countsOf('3 túi vàng, xanh, nâu'), { NAU: 1, VANG: 1, XANH: 1 });
  assert.deepEqual(countsOf('Cho c combo 2 túi ( xanh + vàng )'), { VANG: 1, XANH: 1 });
  // Một màu: số túi là của màu đó.
  assert.deepEqual(countsOf('2 túi xanh'), { XANH: 2 });
  // Màu có số riêng giữ nguyên ("2 túi xanh 1 vàng" là 2 + 1).
  assert.deepEqual(countsOf('2 túi xanh 1 túi vàng'), { VANG: 1, XANH: 2 });
  assert.deepEqual(countsOf('2 túi xanh vàng mỗi loại 1'), { VANG: 1, XANH: 1 });
  // Số túi khác số màu → không tự chia, không gán 3 cho màu đầu.
  const odd = colourCountsInText('3 túi xanh vàng');
  assert.equal(odd.splitAsk, 3);
  assert.notEqual(odd.counts.XANH, 3);
  assert.equal(flavourSplitAsk('3 túi xanh vàng'), 3);
  assert.equal(flavourSplitAsk('Mua 2 túi nâu xanh'), 0);
});

for (const [label, llm] of [['mô hình 1N+1X', { No_A: '1' }], ['mô hình 2N+1X', { No_A: '2' }]]) {
  test(`A1 (ca thật, ${label}): "Mua 2 túi nâu xanh" + địa chỉ + SĐT → đơn 1 Nâu + 1 Xanh 293k (không 2 Nâu + 1 Xanh 437k)`, async () => {
    const sim = new Sim({ psid: `r16-a1-${llm.No_A}` });
    const inbox = sim.inbox();
    const turn = await sim.send(inbox, `Mua 2 túi nâu xanh\n${ADDR_A1}\n${PHONE}`, { llm: { template_id: 'ORDER_CONFIRMATION', Product_N1: N, Product_N2: X, No_B: '1', Phone_Number: PHONE, Customer_Address: ADDR_A1, ...llm } });
    assert.equal(turn.created.length, 1, JSON.stringify(turn.result));
    assert.deepEqual(itemsOf(turn.created[0].items), ['1 GRA-NAU-Z350', '1 GRA-XANH-Z450']);
    assert.equal(turn.created[0].total, 293000);
  });
}

test('A1: "3 túi xanh vàng" (số túi khác số màu) → hỏi lại vị (ASK_FLAVOR), giữ 3 túi + SĐT, không lên đơn/giỏ theo mô hình đoán', () => {
  const reply = renderChatbotReply({ template_id: 'ORDER_ADDRESS', Product_N1: X, No_A: '2', Product_N2: V, No_B: '1', Phone_Number: PHONE }, templates, {
    now: Date.now(), messageText: `3 túi xanh vàng ${PHONE}`, customer: { gender: 'female' }
  });
  assert.equal(reply.templateId, 'ASK_FLAVOR', JSON.stringify(reply));
  assert.equal(reply.order, undefined);
  assert.equal(reply.pendingOrder.askedBagCount, 3);
  assert.deepEqual(reply.pendingOrder.items, []);
  assert.equal(reply.pendingOrder.phone, PHONE);
});

// ===== A2: "Mình lấy 3 màu", "tặng 1 túi vàng", câu hỏi lại tổng =====

test('A2 (hàm thuần): "N màu/vị/loại" không nêu màu = N vị; câu hỏi, "2 mẫu", số túi khác N thì không', () => {
  assert.equal(distinctKindsCount('Mình lấy 3 màu'), 3);
  assert.equal(distinctKindsCount('Cho chị 3 vị này nhé.'), 3);
  assert.equal(distinctKindsCount('c lấy 3 gói grano 3 vị đó nhé'), 3);
  assert.equal(distinctKindsCount('Mình lấy 2 màu'), 2);
  assert.equal(distinctKindsCount('Gửi hình ảnh 2 mẫu mình xem'), 0);
  assert.equal(distinctKindsCount('Lấy 2túi mà 2 vị dc k ah'), 0);
  assert.equal(distinctKindsCount('bên em có mấy vị'), 0);
  assert.equal(distinctKindsCount('3 vị khác nhau không shop'), 0);
  assert.equal(distinctKindsCount('lấy 3 túi 2 màu'), 0);
  assert.equal(distinctKindsCount('lấy 3 vị mỗi vị 2 túi'), 0);
  assert.equal(distinctKindsCount('có 3 loại hạt à'), 0);
  // "tặng 1 túi vàng" là quà: không đếm, không là vị được nhắc.
  const gift = colourCountsInText('Vậy tổng là 5 túi, tặng 1 túi vàng + 1 bộ bát, thìa đúng ko shop');
  assert.deepEqual([gift.counts, gift.mentioned], [{}, []]);
});

for (const [label, llm] of [['mô hình 1X1V1N', { No_A: '1' }], ['mô hình 3X1V1N', { No_A: '3' }], ['mô hình chỉ 3X', { No_A: '3', Product_N2: '0', No_B: '0', Product_N3: '0', No_C: '0' }]]) {
  test(`A2 (ca thật, ${label}): đang giữ 3 Xanh + "Mình lấy 3 màu" → 1 Xanh + 1 Vàng + 1 Nâu 442k (không 5 túi 740k)`, async () => {
    const sim = new Sim({ psid: `r16-a2-${label.length}` });
    const inbox = sim.inbox({ pendingOrder: basket([XANH(3)]), botLastTemplateId: 'ORDER_ADDRESS' });
    await sim.send(inbox, 'Mình lấy 3 màu', { llm: { template_id: 'ORDER_ADDRESS', Product_N1: X, Product_N2: V, No_B: '1', Product_N3: N, No_C: '1', ...llm } });
    assert.deepEqual(itemsOf(inbox.pendingOrder?.items), ['1 GRA-NAU-Z350', '1 GRA-VANG-H350', '1 GRA-XANH-Z450']);
  });
}

test('A2: đang giữ 2 Xanh + "Mình lấy 2 màu" → hỏi vị (giữ 2 túi); "2 loại" ngay sau tin đã nêu 2 vị → không hỏi lại', () => {
  const now = Date.now();
  const asked = renderChatbotReply({ template_id: 'ORDER_ADDRESS', Product_N1: X, No_A: '1', Product_N2: V, No_B: '1' }, templates, {
    now, pendingOrder: basket([XANH(2)]), lastTemplateId: 'ORDER_ADDRESS', messageText: 'Mình lấy 2 màu', customer: { gender: 'female' }
  });
  assert.equal(asked.templateId, 'ASK_FLAVOR', JSON.stringify(asked));
  assert.equal(asked.pendingOrder.askedBagCount, 2);
  // Ca thật r13 (…01/10 11:22): "Lấy mình túi xanh và túi vàng ko đc à" rồi "2 loại" → bot lên giỏ 1 Xanh + 1 Vàng (đúng), giữ nguyên.
  const named = renderChatbotReply({ template_id: 'ORDER_ADDRESS', Product_N1: X, No_A: '1', Product_N2: V, No_B: '1' }, templates, {
    now, messageText: '2 loại', recentCustomerTexts: ['Lấy mình túi xanh và túi vàng ko đc à', '2 loại'], customer: { gender: 'female' }
  });
  assert.equal(named.templateId, 'ORDER_ADDRESS', JSON.stringify(named));
  assert.deepEqual(itemsOf(named.pendingOrder?.items), ['1 GRA-VANG-H350', '1 GRA-XANH-Z450']);
});

test('A2: giữ 3X1V1N + "Vậy tổng là 5 túi, tặng 1 túi vàng + 1 bộ bát, thìa đúng ko shop" → giỏ không đổi (mô hình trả 5 Vàng cũng vậy)', () => {
  const held = [XANH(3), VANG(1), NAU(1)];
  const text = 'Vậy tổng là 5 túi, tặng 1 túi vàng + 1 bộ bát, thìa đúng ko shop';
  assert.deepEqual(itemsOf(adjustOrderQuantities([{ product: V, code: 'GRA-VANG-H350', quantity: 5 }], { messageText: text, heldItems: held })), itemsOf(held));
  const reply = renderChatbotReply({ template_id: 'ORDER_ADDRESS', Product_N1: V, No_A: '5' }, templates, {
    now: Date.now(), pendingOrder: basket(held), lastTemplateId: 'ORDER_ADDRESS', messageText: text, customer: { gender: 'female' }
  });
  assert.deepEqual(itemsOf(reply.pendingOrder?.items), itemsOf(held));
  assert.match(reply.messages.join('\n'), /740\.000đ/);
  // Tổng khác giỏ (giỏ 3 Xanh, khách hỏi "tổng là 5 túi … đúng ko") → vẫn không đổi giỏ theo con số trong câu hỏi.
  assert.deepEqual(itemsOf(adjustOrderQuantities([{ product: X, code: 'GRA-XANH-Z450', quantity: 5 }], { messageText: text, heldItems: [XANH(3)] })), ['3 GRA-XANH-Z450']);
});

// ===== A7: phủ định đứng sau món quà =====

test('A7: "Bộ bát + muỗng dừa chị ko lấy đâu" là xin đổi/bỏ quà; "bắt đầu", "không lấy thêm" thì không', async () => {
  assert.equal(isGiftSwapRequest('Bộ bát + muỗng dừa chị ko lấy đâu'), true);
  assert.equal(isGiftSwapRequest('bát gáo dừa thì mình k cần'), true);
  assert.equal(isGiftSwapRequest('không lấy bát'), true, 'kiểu cũ vẫn bắt');
  assert.equal(isGiftSwapRequest('bắt đầu từ mai không cần gửi nữa'), false);
  assert.equal(isGiftSwapRequest('bộ bát đẹp quá, mình không lấy thêm đâu'), false);
  assert.equal(isGiftSwapRequest('lấy 2 túi xanh'), false);
  const sim = new Sim({ psid: 'r16-a7' });
  const inbox = sim.inbox({ pendingOrder: basket([XANH(2), VANG(2)]), botLastTemplateId: 'ORDER_ADDRESS' });
  const turn = await sim.send(inbox, 'Bộ bát + muỗng dừa chị ko lấy đâu', { llm: { template_id: 'GIFT_POLICY' } });
  assert.equal(turn.result.templateId, 'GIFT_SWAP', JSON.stringify(turn.result));
});

// ===== A8: "ngũ cốc" không phải tên vị =====

test('A8 (hàm thuần): "1 ngủ cốc" / "01 túi hạt ngũ cốc" chưa rõ vị; có màu, bột ngũ cốc, hỏi giá, kèm yến mạch thì không', () => {
  assert.equal(ambiguousCerealBags('1 vị ca cao, 1 ngủ cốc'), 1);
  assert.equal(ambiguousCerealBags('1 túi vị ca cao, 01 túi hạt ngũ cốc'), 1);
  assert.equal(ambiguousCerealBags('Đặt mua 2 gói Ngũ cốc ăn sáng màu xanh'), 0);
  assert.equal(ambiguousCerealBags('1 hộp bột ngũ cốc Nghệ Lành'), 0);
  assert.equal(ambiguousCerealBags('Mua hai gói ngũ cốc giá như nào an'), 0);
  assert.equal(ambiguousCerealBags('Mình lấy 1 ngũ cốc 1 yến mạch miễn síp ko b'), 0);
  assert.equal(ambiguousCerealBags('E đóng gói 1kg cùng 2 túi ngũ cốc nhé'), 0);
});

for (const [text, llm] of [['1 vị ca cao, 1 ngủ cốc', { Product_N1: N, No_A: '1' }], ['1 túi vị ca cao, 01 túi hạt ngũ cốc', { Product_N1: N, No_A: '1', Product_N2: V, No_B: '1' }]]) {
  test(`A8 (ca thật): "${text}" → hỏi vị phần ngũ cốc, giữ 1 Nâu (không 1 túi + mời 2 túi, không tự thành Túi Vàng)`, async () => {
    const sim = new Sim({ psid: `r16-a8-${text.length}` });
    const inbox = sim.inbox();
    const turn = await sim.send(inbox, text, { llm: { template_id: 'ORDER_ADDRESS', ...llm } });
    assert.equal(turn.result.templateId, 'ASK_FLAVOR_NGUYENBAN', JSON.stringify(turn.result));
    assert.deepEqual(itemsOf(inbox.pendingOrder?.items), ['1 GRA-NAU-Z350']);
    assert.equal(inbox.pendingOrder?.nguyenBanAsk, 1);
    assert.doesNotMatch(turn.sent.map(item => item.text).join('\n'), /2 túi thì giá/);
    // Khách trả lời vị → cộng vào giỏ: 1 Nâu + 1 Xanh 293k.
    await sim.send(inbox, 'Túi xanh nhé', { llm: { template_id: 'ORDER_ADDRESS', Product_N1: X, No_A: '1' } });
    assert.deepEqual(itemsOf(inbox.pendingOrder?.items), ['1 GRA-NAU-Z350', '1 GRA-XANH-Z450']);
  });
}

test('A8 kèm theo: trả lời vị cho phần "nguyên bản" ("1 túi nâu 1 túi nguyên bản" → "Túi xanh nhé") = 1 Xanh (luật FLAVOR_ANSWER đếm 2 túi của tin trước → trước đây 1 Nâu + 3 Xanh)', async () => {
  const sim = new Sim({ psid: 'r16-nb' });
  const inbox = sim.inbox();
  const first = await sim.send(inbox, '1 túi nâu 1 túi nguyên bản', { llm: { template_id: 'ORDER_ADDRESS', Product_N1: N, No_A: '1' } });
  assert.equal(first.result.templateId, 'ASK_FLAVOR_NGUYENBAN');
  await sim.send(inbox, 'Túi xanh nhé', { llm: { template_id: 'ORDER_ADDRESS', Product_N1: X, No_A: '1' } });
  assert.deepEqual(itemsOf(inbox.pendingOrder?.items), ['1 GRA-NAU-Z350', '1 GRA-XANH-Z450']);
  // Khách nêu số rõ thì theo khách.
  const sim2 = new Sim({ psid: 'r16-nb2' });
  const inbox2 = sim2.inbox();
  await sim2.send(inbox2, '1 túi nâu 1 túi nguyên bản', { llm: { template_id: 'ORDER_ADDRESS', Product_N1: N, No_A: '1' } });
  await sim2.send(inbox2, '2 túi xanh nhé', { llm: { template_id: 'ORDER_ADDRESS', Product_N1: X, No_A: '2' } });
  assert.deepEqual(itemsOf(inbox2.pendingOrder?.items), ['1 GRA-NAU-Z350', '2 GRA-XANH-Z450']);
});

// ===== inbox3 A4: hỏi vị không xin lại địa chỉ đã có =====

test('inbox3 A4: giỏ chờ đã có địa chỉ (hay tin trước có địa chỉ) + khách gửi SĐT → hỏi vị KHÔNG xin lại địa chỉ', () => {
  const ADDR = 'Số nhà 14 ngách 211/85 Khương trung thanh Xuân';
  const withPending = renderChatbotReply({ template_id: 'ORDER_INFO_ASK_FLAVOR', Phone_Number: PHONE }, templates, {
    now: Date.now(), pendingOrder: { items: [], key: '', at: Date.now(), phone: '', address: ADDR, addressAsks: 0, askedBagCount: 2 }, lastTemplateId: 'ASK_FLAVOR', messageText: PHONE, customer: { gender: 'female' }
  });
  assert.equal(withPending.templateId, 'ORDER_INFO_ASK_FLAVOR');
  assert.doesNotMatch(withPending.messages.join('\n'), /địa chỉ nhận hàng đầy đủ/);
  const fromHistory = renderChatbotReply({ template_id: 'ORDER_INFO_ASK_FLAVOR', Phone_Number: PHONE }, templates, {
    now: Date.now(), lastTemplateId: 'ASK_FLAVOR', messageText: PHONE, recentCustomerTexts: [`Cho mình 2 túi nhé. ${ADDR} nhé`, PHONE], customer: { gender: 'female' }
  });
  assert.doesNotMatch(fromHistory.messages.join('\n'), /địa chỉ nhận hàng đầy đủ/);
  // Chưa có địa chỉ ở đâu → vẫn xin kèm địa chỉ như cũ.
  const none = renderChatbotReply({ template_id: 'ORDER_INFO_ASK_FLAVOR', Phone_Number: PHONE }, templates, {
    now: Date.now(), lastTemplateId: 'ASK_FLAVOR', messageText: PHONE, recentCustomerTexts: ['Cho mình 2 túi nhé', PHONE], customer: { gender: 'female' }
  });
  assert.match(none.messages.join('\n'), /địa chỉ nhận hàng đầy đủ/);
});

test('inbox3 A4 (chuỗi ca thật): "Cho mình 2 túi nhé. <địa chỉ>" → SĐT → bot hỏi vị không nhắc "kèm địa chỉ"', async () => {
  const sim = new Sim({ psid: 'r16-c8987' });
  const inbox = sim.inbox({ botLastTemplateId: 'PRICE_QUOTE', botLastReplyAt: Date.now() - 2 * MIN });
  await sim.send(inbox, 'Cho mình 2 túi nhé. Số nhà 14 ngách 211/85 Khương trung thanh Xuân nhé', { llm: null });
  const turn = await sim.send(inbox, '0912345678', { llm: null });
  const said = turn.sent.map(item => item.text).join('\n');
  assert.ok(said, JSON.stringify(turn.result));
  assert.doesNotMatch(said, /địa chỉ nhận hàng đầy đủ/);
});

// ===== inbox5 A8: sửa đơn giữ dòng quà =====

test('inbox5 A8: đổi địa chỉ đơn live (mẫu ORDER_UPDATED đang chạy, không có {gift}) → câu "đã sửa lại đơn" vẫn có dòng Tặng kèm', async () => {
  const sim = new Sim({ psid: 'r16-upd', settings: { messageTemplates: { ...templates, ORDER_UPDATED: LIVE_ORDER_UPDATED } } });
  const inbox = sim.inbox({ pendingOrder: basket([XANH(1), VANG(1), NAU(1)]), botLastTemplateId: 'ORDER_ADDRESS' });
  const first = await sim.send(inbox, `590 nguyễn thị định phường thạnh mỹ lợi quận 2 tphcm ${PHONE}`, { llm: { template_id: 'ORDER_CONFIRMATION', Phone_Number: PHONE, Customer_Address: '590 nguyễn thị định phường thạnh mỹ lợi quận 2 tphcm' } });
  assert.equal(first.created.length, 1, JSON.stringify(first.result));
  const turn = await sim.send(inbox, 'E giao địa chỉ này cho nè : 159 đường 6 phường bình trưng tây quận 2 tphcm dùm nhé', { llm: { template_id: 'ORDER_UPDATE', Customer_Address: '159 đường 6 phường bình trưng tây quận 2 tphcm' } });
  assert.equal(turn.result.templateId, 'ORDER_UPDATE', JSON.stringify(turn.result));
  const said = turn.sent.map(item => item.text).join('\n');
  assert.match(said, /Tổng tiền: 442\.000đ[^\n]*\n🎁 Tặng kèm: Bộ bát gáo dừa \+ Muỗng dừa/);
  // Địa chỉ mới qua chuẩn hoá phường/quận như đơn mới.
  assert.match(said, /Phường Bình Trưng Tây/);
});

test('inbox5 A8: đơn không có quà hiện vật → không thêm dòng Tặng kèm trống', () => {
  const recentOrder = { id: 'o-r16', createdAt: Date.now() - 5 * MIN, automatic: true, phone: PHONE, address: '12 Lê Lợi, Phường Bến Nghé, Quận 1, TP Hồ Chí Minh', products: [{ name: X, sku: 'GRA-XANH-Z450', quantity: 1 }], status: 'Mới' };
  const reply = renderChatbotReply({ template_id: 'ORDER_UPDATE', Product_N1: X, No_A: '2', Phone_Number: PHONE }, { ...templates, ORDER_UPDATED: LIVE_ORDER_UPDATED }, {
    now: Date.now(), recentOrder, messageText: 'đổi thành 2 túi xanh nha', customer: { gender: 'female' }
  });
  assert.equal(reply.templateId, 'ORDER_UPDATE', JSON.stringify(reply));
  assert.doesNotMatch(reply.messages.join('\n'), /Tặng kèm/);
});
