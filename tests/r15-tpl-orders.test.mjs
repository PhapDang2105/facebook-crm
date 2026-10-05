// Vòng 15 (03/10) — bộ soạn đơn (chatbot-templates.mjs), câu khách thật trong báo cáo r15:
// - inbox1 A2 (…8166458357, 11:50 03/10): "Cho mình 1 túi nguyên bản và 1 túi vàng nhiều hạt nhé" → bot hỏi lại "nguyên bản là gì";
//   mã cũ còn có thể chốt THIẾU túi (giỏ chờ 1 Vàng + nguyenBanAsk, khách gửi địa chỉ + SĐT mà mô hình không điền món → đơn 1 Vàng 189k).
// - inbox3 A5 (…787176 "đt <sdt>" ngay sau phiếu): mô hình chọn ORDER_UNCHANGED → SĐT mới bị bỏ.
import assert from 'node:assert/strict';
import test from 'node:test';
import { Sim, PHONE, VANG, NAU, basket, templates } from './helpers/r13-engine-sim.mjs';
import { contactDiffersFromOrder, nguyenBanMeansXanh, renderChatbotReply, sanitizeModelAnswer } from '../app/chatbot-templates.mjs';

const MIN = 60000;
const ADDR = 'Thị trấn Thứ, Kim Đính, Kim Thành, Hải Dương';
const NEW_PHONE = '0987654321';
const ASK_FLAVOR_TEXT = 'Dạ bên em có 3 vị: Túi Xanh nguyên bản 450g, Túi Vàng nhiều hạt 350g và Túi Nâu cacao 350g; mix vị nào cũng được giá combo. Chị muốn lấy vị nào và mỗi vị mấy túi để em lên đơn nha ạ?';
const itemsOf = list => (list || []).map(item => `${item.quantity} ${item.code}`).sort();

test('A2: "nguyên bản" + một món Vàng nêu riêng → nguyên bản là Xanh (hàm thuần)', () => {
  assert.equal(nguyenBanMeansXanh('Cho mình 1 túi nguyên bản và 1 túi vàng nhiều hạt nhé'), 1);
  assert.equal(nguyenBanMeansXanh('2 túi nguyên bản 1 túi vàng'), 2);
  // R14 giữ nguyên: không có Vàng nêu riêng → vẫn hỏi lại; đã nói rõ Xanh/Vàng nguyên bản → không đổi gì.
  assert.equal(nguyenBanMeansXanh('1 túi nâu 1 túi nguyên bản'), 0);
  assert.equal(nguyenBanMeansXanh('1 túi vàng nguyên bản'), 0);
  assert.equal(nguyenBanMeansXanh('nguyên bản là gì vậy, 1 túi vàng bao nhiêu?'), 0);
  assert.equal(nguyenBanMeansXanh('1 túi xanh 1 túi vàng'), 0);
});

for (const withItems of [false, true]) {
  test(`A2 (ca thật): "Cho mình 1 túi nguyên bản và 1 túi vàng nhiều hạt nhé" → giỏ 1 Xanh + 1 Vàng; địa chỉ + SĐT (mô hình ${withItems ? 'có' : 'không'} điền món) → đơn 298k đủ 2 túi`, async () => {
    const sim = new Sim({ psid: `a2-${withItems}` });
    const inbox = sim.inbox({ gender: 'female', botLastTemplateId: 'ASK_FLAVOR', botLastReplyAt: Date.now() - 10 * MIN });
    sim.history(inbox, 'incoming', 'Cho mình 2 túi nhé.', 11 * MIN);
    sim.history(inbox, 'outgoing', ASK_FLAVOR_TEXT, 10 * MIN, { sender: 'bot' });
    const first = await sim.send(inbox, 'Cho mình 1 túi nguyên bản và 1 túi vàng nhiều hạt nhé', { llm: { template_id: 'ASK_FLAVOR_NGUYENBAN' } });
    assert.notEqual(first.result.templateId, 'ASK_FLAVOR_NGUYENBAN', JSON.stringify(first.result));
    assert.deepEqual(itemsOf(inbox.pendingOrder?.items), ['1 GRA-VANG-H350', '1 GRA-XANH-Z450']);
    const llm = withItems
      ? { template_id: 'ORDER_CONFIRMATION', Product_N1: 'Granola Túi Xanh 450g', No_A: '1', Product_N2: 'Granola Túi Vàng 350g', No_B: '1', Phone_Number: PHONE, Customer_Address: ADDR }
      : { template_id: 'ORDER_CONFIRMATION', Phone_Number: PHONE, Customer_Address: ADDR };
    const second = await sim.send(inbox, `Ngô Thị Thoa. ${ADDR}. ${PHONE}`, { llm });
    assert.equal(second.created.length, 1, JSON.stringify(second.result));
    assert.deepEqual(itemsOf(second.created[0].items), ['1 GRA-VANG-H350', '1 GRA-XANH-Z450']);
    assert.equal(second.created[0].total, 298000);
  });
}

test('A2 (b): giỏ chờ còn nguyenBanAsk (1 Vàng) + khách gửi địa chỉ + SĐT, mô hình không điền món → KHÔNG tạo đơn 1 Vàng; hỏi lại phần nguyên bản, giữ SĐT/địa chỉ', () => {
  const now = Date.now();
  const pendingOrder = { ...basket([VANG(1)], 60000), askedBagCount: 1, nguyenBanAsk: 1 };
  const reply = renderChatbotReply({ template_id: 'ORDER_CONFIRMATION', Phone_Number: PHONE, Customer_Address: ADDR }, templates, {
    now, pendingOrder, lastTemplateId: 'ASK_FLAVOR_NGUYENBAN', messageText: `Ngô Thị Thoa. ${ADDR}. ${PHONE}`, customer: { gender: 'female' }
  });
  assert.equal(reply.templateId, 'ASK_FLAVOR_NGUYENBAN', JSON.stringify(reply));
  assert.equal(reply.order, undefined);
  assert.equal(reply.pendingOrder.phone, PHONE);
  assert.ok(reply.pendingOrder.address);
  assert.equal(reply.pendingOrder.nguyenBanAsk, 1);
  assert.deepEqual(itemsOf(reply.pendingOrder.items), ['1 GRA-VANG-H350']);
  // Mô hình chép lại đúng giỏ đang giữ (1 Vàng) cũng không chốt thiếu túi.
  const copied = renderChatbotReply({ template_id: 'ORDER_CONFIRMATION', Product_N1: 'Granola Túi Vàng 350g', No_A: '1', Phone_Number: PHONE, Customer_Address: ADDR }, templates, {
    now, pendingOrder, lastTemplateId: 'ASK_FLAVOR_NGUYENBAN', messageText: `${ADDR} ${PHONE}`, customer: { gender: 'female' }
  });
  assert.equal(copied.templateId, 'ASK_FLAVOR_NGUYENBAN', JSON.stringify(copied));
  // Khách trả lời vị → đơn đủ 2 túi.
  const answered = renderChatbotReply({ template_id: 'ORDER_CONFIRMATION', Product_N1: 'Granola Túi Xanh 450g', No_A: '1', Phone_Number: PHONE, Customer_Address: ADDR }, templates, {
    now, pendingOrder: { ...pendingOrder, phone: PHONE, address: ADDR }, lastTemplateId: 'ASK_FLAVOR_NGUYENBAN', messageText: 'Túi xanh', customer: { gender: 'female' }
  });
  assert.equal(answered.templateId, 'ORDER_CONFIRMATION', JSON.stringify(answered));
  assert.deepEqual(itemsOf(answered.order.items), ['1 GRA-VANG-H350', '1 GRA-XANH-Z450']);
});

test('A2 (b) qua engine: "1 túi nâu 1 túi nguyên bản" (R14 vẫn hỏi lại) → địa chỉ + SĐT không kèm món → không lên đơn 1 Nâu', async () => {
  const sim = new Sim({ psid: 'a2b' });
  const inbox = sim.inbox({ gender: 'female' });
  const first = await sim.send(inbox, '1 túi nâu 1 túi nguyên bản', { llm: { template_id: 'ORDER_ADDRESS', Product_N1: 'Granola Túi Nâu vị cacao 350g', No_A: '1' } });
  assert.equal(first.result.templateId, 'ASK_FLAVOR_NGUYENBAN');
  const second = await sim.send(inbox, `${ADDR} ${PHONE}`, { llm: { template_id: 'ORDER_CONFIRMATION', Phone_Number: PHONE, Customer_Address: ADDR } });
  assert.equal(second.created.length, 0, JSON.stringify(second.created));
  assert.equal(second.result.templateId, 'ASK_FLAVOR_NGUYENBAN');
  assert.equal(inbox.pendingOrder?.phone, PHONE);
});

const order = (extra = {}) => ({
  id: 'o1', createdAt: Date.now() - 5 * MIN, phone: PHONE, address: 'số 19 đg D13 võ thị sáu, Phường Thống Nhất, Thành phố Biên Hòa, Đồng Nai',
  products: [{ name: 'Granola Túi Xanh 450g', sku: 'GRA-XANH-Z450', quantity: 2 }], automatic: true, status: 'Mới', ...extra
});

test('A5: contactDiffersFromOrder — SĐT khác / cùng SĐT / địa chỉ mô hình chép từ lịch sử', () => {
  assert.equal(contactDiffersFromOrder(order(), `đt ${NEW_PHONE}`), true);
  assert.equal(contactDiffersFromOrder(order(), `đt ${PHONE}`), false);
  assert.equal(contactDiffersFromOrder(order(), 'ok em', 'số 5 Lê Lợi, Phường Bến Nghé, Quận 1, TP.HCM'), false);
  assert.equal(contactDiffersFromOrder(order(), 'gửi giúp chị về số 5 Lê Lợi, Phường Bến Nghé, Quận 1, TP.HCM nhé', 'số 5 Lê Lợi, Phường Bến Nghé, Quận 1, TP.HCM'), true);
  assert.equal(contactDiffersFromOrder(null, `đt ${NEW_PHONE}`), false);
});

test('A5 (ca thật "đt <sdt>"): mô hình chọn ORDER_UNCHANGED (đã qua sanitize) mà SĐT khác đơn ≤60 phút → sửa đơn sang SĐT mới', () => {
  const clean = sanitizeModelAnswer({ template_id: 'ORDER_UNCHANGED' });
  assert.equal(clean.template_id, 'GENERAL_INFO');
  const context = { now: Date.now(), recentOrder: order(), messageText: `đt ${NEW_PHONE}`, customer: { gender: 'female' } };
  const reply = renderChatbotReply(clean, templates, context);
  assert.equal(reply.templateId, 'ORDER_UPDATE', JSON.stringify(reply));
  assert.equal(reply.order.updateOrderId, 'o1');
  assert.equal(reply.order.phone, NEW_PHONE);
  assert.deepEqual(itemsOf(reply.order.items), ['2 GRA-XANH-Z450']);
  // Mã thô ORDER_UNCHANGED (bộ giả lập không qua sanitize) cũng vậy.
  assert.equal(renderChatbotReply({ template_id: 'ORDER_UNCHANGED' }, templates, context).templateId, 'ORDER_UPDATE');
  // ORDER_UPDATE không kèm món, chỉ có SĐT mới → sửa SĐT (trước đây ORDER_WRONG hỏi lại).
  const update = renderChatbotReply({ template_id: 'ORDER_UPDATE', Phone_Number: NEW_PHONE }, templates, context);
  assert.equal(update.templateId, 'ORDER_UPDATE');
  assert.equal(update.order.phone, NEW_PHONE);
  // Mô hình chép SĐT CŨ vào Phone_Number nhưng tin khách là SĐT mới → SĐT trong tin thắng.
  const copied = renderChatbotReply({ template_id: 'ORDER_CONFIRMATION', Product_N1: 'Granola Túi Xanh 450g', No_A: '2', Phone_Number: PHONE }, templates, context);
  assert.equal(copied.templateId, 'ORDER_UPDATE', JSON.stringify(copied));
  assert.equal(copied.order.phone, NEW_PHONE);
});

test('A5: cùng SĐT, đơn quá 60 phút, đơn nhân viên (POS) → không tự sửa', () => {
  const same = renderChatbotReply(sanitizeModelAnswer({ template_id: 'ORDER_UNCHANGED' }), templates, { now: Date.now(), recentOrder: order(), messageText: `đt ${PHONE}` });
  assert.equal(same.order?.updateOrderId, undefined);
  const old = renderChatbotReply({ template_id: 'ORDER_UNCHANGED' }, templates, { now: Date.now(), recentOrder: order({ createdAt: Date.now() - 90 * MIN }), messageText: `đt ${NEW_PHONE}` });
  assert.equal(old.order?.updateOrderId, undefined);
  const pos = renderChatbotReply({ template_id: 'ORDER_UNCHANGED' }, templates, { now: Date.now(), recentOrder: order({ source: 'POS', automatic: false }), messageText: `đt ${NEW_PHONE}` });
  assert.equal(pos.order?.updateOrderId, undefined);
});

test('A5 qua engine (bộ giả lập work-inbox3 PH): đơn SĐT A rồi "đt 0987654321" (mô hình ORDER_UNCHANGED) → đơn sửa sang SĐT mới', async () => {
  const sim = new Sim({ psid: 'a5' });
  const inbox = sim.inbox({ gender: 'female' });
  await sim.send(inbox, '2 túi xanh', { llm: { template_id: 'ORDER_ADDRESS' } });
  const placed = await sim.send(inbox, `số 19 đg D13 võ thị sáu thống nhất biên hoà đồng nai ${PHONE}`, { llm: { template_id: 'ORDER_CONFIRMATION', Phone_Number: PHONE, Customer_Address: 'số 19 đg D13 võ thị sáu thống nhất biên hoà đồng nai' } });
  assert.equal(placed.created.length, 1);
  const turn = await sim.send(inbox, `đt ${NEW_PHONE}`, { llm: { template_id: 'ORDER_UNCHANGED' } });
  assert.equal(turn.result.templateId, 'ORDER_UPDATE', JSON.stringify(turn.result));
  assert.equal(turn.created.at(-1)?.phone, NEW_PHONE);
});

test('nhắc lại: R14 "1 túi nâu 1 túi nguyên bản" vẫn hỏi lại, giỏ giữ 1 Nâu', () => {
  const reply = renderChatbotReply({ template_id: 'ORDER_ADDRESS', Product_N1: 'Granola Túi Nâu vị cacao 350g', No_A: '1' }, templates, { now: Date.now(), messageText: '1 túi nâu 1 túi nguyên bản' });
  assert.equal(reply.templateId, 'ASK_FLAVOR_NGUYENBAN');
  assert.deepEqual(itemsOf(reply.pendingOrder.items), itemsOf([NAU(1)]));
});
