// Vòng 13 (02/10): giỏ Facebook Shop, số lượng/vị theo lời khách, sửa đơn vừa chốt, đổi quà trong giỏ chờ, quà của đơn đã có.
// Mọi câu khách là câu THẬT trong báo cáo r13 (out-inbox1 A2/A4, out-inbox2 A1/A4/B1/B3/B6/B7); SĐT là số giả 09000000xx.
import assert from 'node:assert/strict';
import test from 'node:test';
import './helpers/seed-catalog.mjs';

const { processChatbotChanges, withFallbackTemplates } = await import('../app/chatbot-engine.mjs');
const { adjustOrderQuantities, colourCountsInText, defaultMessageTemplates, heldGiftSwap, isShopCartText, renderChatbotReply, renderOrderGiftReply, withGiftSwap } = await import('../app/chatbot-templates.mjs');
const catalog = await import('../app/processing/catalog.mjs');
const { priceBasket } = await import('../app/processing/pricing.mjs');

const seed = Object.fromEntries(Object.entries(defaultMessageTemplates()).map(([id, text]) => [id, text.trim()]));
const templates = withFallbackTemplates(seed);
const PHONE = '0900000001';
const XANH_SKU = 'GRA-XANH-Z450';
const VANG_SKU = 'GRA-VANG-H350';
const NAU_SKU = 'GRA-NAU-Z350';
const XANH = (quantity = 1) => ({ product: 'Granola Túi Xanh 450g', code: XANH_SKU, quantity });
const VANG = (quantity = 1) => ({ product: 'Granola Túi Vàng 350g', code: VANG_SKU, quantity });
const NAU = (quantity = 1) => ({ product: 'Granola Túi Nâu vị cacao 350g', code: NAU_SKU, quantity });
const basket = (items, extra = {}) => ({ items, key: items.map(item => `${item.code}=${item.quantity}`).sort().join('|'), at: Date.now() - 60000, phone: '', address: '', addressAsks: 0, ...extra });
const lines = items => (items || []).map(item => [item.code, item.quantity]);
// Chữ CRM tự sinh cho tin giỏ Shop (pancake.mjs), đúng tên sản phẩm của Shop trong hội thoại thật.
const SHOP_NAME = 'Granola Mới Ngũ Cốc Ăn Sáng Healthy Lành Mạnh Với Hạt Dinh Dưỡng Trái Cây Từ Giọt Nắng';
const cartText = (sku, price = '298.000đ', name = SHOP_NAME) => `Khách chọn mua từ Facebook Shop: ${name} (${sku}) — ${price}`;
const cartValue = items => {
  const value = { template_id: 'ORDER_ADDRESS' };
  const slots = ['Product_N1', 'No_A', 'Product_N2', 'No_B', 'Product_N3', 'No_C'];
  items.forEach((item, index) => { value[slots[index * 2]] = item.product; value[slots[index * 2 + 1]] = String(item.quantity); });
  return value;
};

// ===== 1. Giỏ Facebook Shop: không lọc/đếm theo chữ tự sinh =====

test('r13 #1: giỏ Shop CB-VANGG+XANH (298k) giữ đủ Vàng + Xanh — chữ "(CB-VANGG+XANH)" không làm giỏ còn 1 Túi Xanh 189k', () => {
  assert.ok(isShopCartText(cartText('CB-VANGG+XANH')));
  assert.ok(!isShopCartText('Cho chị 1 xanh + 1 túi vành'));
  // Engine chưa truyền fromCart: bộ soạn tự nhận ra theo tiền tố chữ.
  const byPrefix = renderChatbotReply(cartValue([VANG(1), XANH(1)]), templates, { messageText: cartText('CB-VANGG+XANH'), now: Date.now() });
  assert.equal(byPrefix.templateId, 'ORDER_ADDRESS');
  assert.deepEqual(lines(byPrefix.pendingOrder.items), [[VANG_SKU, 1], [XANH_SKU, 1]]);
  assert.match(byPrefix.messages.join('\n'), /1 Granola Túi Vàng 350g \+ 1 Granola Túi Xanh 450g, tổng 298\.000đ/);
  assert.doesNotMatch(byPrefix.messages.join('\n'), /lấy 2 túi thì giá chỉ còn|189\.000đ/, 'không mời 2 túi cho giỏ đã 2 túi');
  // Engine truyền fromCart: đúng cả khi chữ tin không mang tiền tố.
  const byFlag = renderChatbotReply(cartValue([VANG(1), XANH(1)]), templates, { fromCart: true, messageText: '(CB-VANGG+XANH)', now: Date.now() });
  assert.deepEqual(lines(byFlag.pendingOrder.items), [[VANG_SKU, 1], [XANH_SKU, 1]]);
  // CB-VANGG+NAU: chữ chỉ khớp "NAU".
  const brown = renderChatbotReply(cartValue([VANG(1), NAU(1)]), templates, { messageText: cartText('CB-VANGG+NAU', '293.000đ'), now: Date.now() });
  assert.deepEqual(lines(brown.pendingOrder.items), [[VANG_SKU, 1], [NAU_SKU, 1]]);
  assert.match(brown.messages.join('\n'), /tổng 293\.000đ/);
  // Tên sản phẩm của Shop có chữ "Túi Vàng Nhiều Hạt…" mà giỏ là 2 Xanh: không lọc theo tên.
  const named = renderChatbotReply(cartValue([XANH(2)]), templates, { messageText: cartText('CB2-XANH-Z450', '298.000đ', 'Granola Mới Túi Vàng Nhiều Hạt Ngon Giòn Với Viên Yến Mạch Trái Cây Mới Từ Giọt Nắng'), now: Date.now() });
  assert.deepEqual(lines(named.pendingOrder.items), [[XANH_SKU, 2]]);
});

test('r13 #1: lượt sau giỏ Shop (khách gửi SĐT/địa chỉ) — chữ giỏ trong các tin gần đây không mở khoá giỏ đang giữ; đơn đủ 2 món 298k', () => {
  const held = basket([VANG(1), XANH(1)]);
  const recentCustomerTexts = [cartText('CB-VANGG+XANH'), PHONE];
  // Mô hình đọc nhầm chữ giỏ thành 1 Túi Xanh: giỏ đang giữ (từ mã Shop) mới là giỏ đúng.
  const phoneTurn = renderChatbotReply({ template_id: 'ORDER_ADDRESS', Product_N1: 'Granola Túi Xanh 450g', No_A: '1', Phone_Number: PHONE }, templates, { messageText: PHONE, pendingOrder: held, recentCustomerTexts, now: Date.now() });
  assert.deepEqual(lines(phoneTurn.pendingOrder.items), [[VANG_SKU, 1], [XANH_SKU, 1]]);
  const close = renderChatbotReply({ template_id: 'ORDER_CONFIRMATION', Phone_Number: PHONE, Customer_Address: 'số 12 Lê Lợi, phường Bến Nghé, quận 1, TP HCM' }, templates,
    { messageText: `${PHONE} số 12 Lê Lợi, phường Bến Nghé, quận 1, TP HCM`, pendingOrder: held, recentCustomerTexts: [cartText('CB-VANGG+XANH')], now: Date.now() });
  assert.equal(close.templateId, 'ORDER_CONFIRMATION');
  assert.deepEqual(lines(close.order.items), [[VANG_SKU, 1], [XANH_SKU, 1]]);
  assert.equal(close.order.total, 298000);
  // Hàm sửa số lượng gọi thẳng với chữ giỏ: trả nguyên giỏ đưa vào.
  assert.deepEqual(lines(adjustOrderQuantities([VANG(1), XANH(1)], { messageText: cartText('CB-VANGG+XANH') })), [[VANG_SKU, 1], [XANH_SKU, 1]]);
});

let counter = 0;
const settle = () => new Promise(resolve => setImmediate(resolve));
/** Hội thoại nhiều lượt qua engine thật (bản rút gọn lớp Sim của round12-engine.test.mjs), mô hình giả. */
class Sim {
  constructor(conversation = {}) {
    this.conversation = { id: 'page:user-r13-basket', pageId: 'page', psid: 'user-r13-basket', name: 'Khách', botEnabled: true, ...conversation };
    this.recent = [];
    this.settings = { enabled: true, autoOrder: true, responseMode: 'automatic', handoffKeywords: '', complaintKeywords: '', fragmentWaitMs: 0, phoneFragmentWaitMs: 0, shopOrderWaitMs: 0, messageTemplates: seed, ruleIntent: 'on', experimentalRules: 'on', preGuard: 'off', intentModel: 'off', intentCascade: 'off', addressAi: false };
  }
  async send(text, { llm = null, message = {} } = {}) {
    const incoming = { id: `rb-${++counter}`, mid: `rb-${counter}`, direction: 'incoming', type: 'text', text, createdAt: Date.now(), ...message };
    this.recent.push(incoming);
    const sent = []; const created = []; const asked = [];
    const self = this;
    const results = await processChatbotChanges([{ type: 'message', conversation: { ...this.conversation }, message: incoming }], {
      readSettings: async () => this.settings,
      listMessages: async () => [...this.recent],
      getConversation: async id => (id === self.conversation.id ? self.conversation : null),
      saveBotState: async (_id, state) => { Object.assign(self.conversation, state); },
      sendMessage: async (_conversation, payload) => {
        const out = payload.text || '[ảnh]';
        sent.push(out);
        self.recent.push({ id: `ro-${++counter}`, mid: `ro-${counter}`, direction: 'outgoing', type: 'text', text: out, createdAt: Date.now() });
        return { message: { mid: 'x' } };
      },
      createOrder: async (_conversation, order) => {
        const record = { id: `ord-${++counter}`, createdAt: Date.now(), phone: order.phone, address: order.address, total: order.total, products: order.items.map(item => ({ name: item.product, sku: item.code, quantity: item.quantity })), status: 'Mới', automatic: true };
        created.push(order);
        self.conversation.customerOrders = [...(self.conversation.customerOrders || []), record];
        return { order: record, created: true };
      },
      updateOrder: async (_conversation, id, order) => { created.push({ update: id, ...order }); return { order: { id, ...order }, updated: true }; },
      addOrderNote: async () => ({ noted: true }),
      moderateComment: async () => {},
      requestReply: async payload => { asked.push(payload); const answer = typeof llm === 'function' ? llm(payload) : llm; return answer?.template_id ? renderChatbotReply(answer, templates, payload.context || {}) : (answer || { templateId: 'GENERAL_INFO', messages: ['[mô hình]'], handoff: false }); },
      appendDecisionLog: () => {}
    });
    await settle();
    return { result: results[0] || {}, sent, created, asked };
  }
}
const shopCart = sku => ({ text: cartText(sku), message: { cart: [{ name: SHOP_NAME, sku, quantity: 0, price: 298000 }] } });

test('r13 #1 (qua engine): bấm giỏ Shop CB-VANGG+XANH rồi gửi SĐT + địa chỉ → đơn 1 Vàng + 1 Xanh, 298.000đ', async () => {
  const sim = new Sim();
  const cart = shopCart('CB-VANGG+XANH');
  const first = await sim.send(cart.text, { message: cart.message });
  assert.equal(first.result.templateId, 'ORDER_ADDRESS');
  assert.equal(first.asked.length, 0, 'giỏ Shop không cần mô hình');
  assert.deepEqual(lines(sim.conversation.pendingOrder?.items), [[VANG_SKU, 1], [XANH_SKU, 1]]);
  assert.match(first.sent.join('\n'), /tổng 298\.000đ/);
  assert.doesNotMatch(first.sent.join('\n'), /189\.000đ/);
  const second = await sim.send(`${PHONE} số 12 Lê Lợi, phường Bến Nghé, quận 1, TP HCM`);
  assert.equal(second.result.templateId, 'ORDER_CONFIRMATION');
  assert.equal(second.created.length, 1);
  assert.deepEqual(lines(second.created[0].items), [[VANG_SKU, 1], [XANH_SKU, 1]]);
  assert.equal(second.created[0].total, 298000);
});

// ===== 2. parseCartSku / parseShopCart =====

test('r13 #2: mã giỏ Shop thật — combo màu, đuôi quà, hộp 10 gói, yến mạch (oat), mã lạ → unknown + tên, không đoán món', () => {
  const cart = (sku, quantity = 0, name = '') => catalog.parseShopCart([{ sku, quantity, name }]);
  const skus = parsed => parsed.items.map(item => [item.sku, item.quantity]);
  assert.deepEqual(skus(cart('CB-VANGG+XANH')), [[VANG_SKU, 1], [XANH_SKU, 1]]);
  assert.deepEqual(skus(cart('CB-XANH+NAU')), [[XANH_SKU, 1], [NAU_SKU, 1]]);
  assert.deepEqual(skus(cart('CB2-VANGG')), [[VANG_SKU, 2]]);
  assert.deepEqual(skus(cart('CB2-NAU-Z350')), [[NAU_SKU, 2]]);
  const gifted = cart('CB3-VANGG+BGD+M');
  assert.deepEqual([skus(gifted), gifted.gifts, gifted.needsStaff, gifted.unknown], [[[VANG_SKU, 3]], ['BGD', 'MUONG'], false, false]);
  // Chủ shop 05/10: Combo 10 gói Mix (và Nâu) đã tắt → mã lạ, nhân viên xử lý (SHOP_CART_STAFF/UNKNOWN). Trước đây test
  // khẳng định CB10-MIX còn bán.
  assert.deepEqual([skus(cart('CB10-MIX')), cart('CB10-MIX').unknown], [[], true]);
  assert.deepEqual([skus(cart('CB10-NAU-G35')), cart('CB10-NAU-G35').unknown], [[], true]);
  // R16: Combo 10 gói Cam đã tắt (chủ shop 03/10) → mã lạ, nhân viên xử lý.
  assert.deepEqual([skus(cart('CB10-CAM-G30')), cart('CB10-CAM-G30').unknown], [[], true]);
  assert.deepEqual(skus(cart('CB10-XANH-G35', 2)), [['CB10-XANH-G35', 2]]);
  assert.deepEqual(skus(cart('CB10-XANH-G35+BGD')), [['CB10-XANH-G35', 1]], 'mã danh mục kèm đuôi quà');
  // Yến mạch: nhân viên lên đơn, có nhãn đúng món.
  const oat = cart('CB2-HT-YM-T500', 0, 'Yến Mạch Cán Dẹt Úc Nguyên Cám');
  assert.deepEqual([oat.items, oat.needsStaff, oat.reasons, oat.unknown, oat.labels], [[], true, ['oat'], false, ['Yến Mạch Úc Nguyên Cám cán dẹt 1kg']]);
  // Mã lạ: unknown + tên dòng giỏ; không có tên thì chính mã.
  const strange = cart('LA-XYZ', 1, 'Combo Granola Điều Lành');
  assert.deepEqual([strange.items, strange.needsStaff, strange.unknown, strange.name, strange.unknownSkus], [[], true, true, 'Combo Granola Điều Lành', ['LA-XYZ']]);
  assert.deepEqual(strange.unknownLines, [{ sku: 'LA-XYZ', name: 'Combo Granola Điều Lành', quantity: 1 }]);
  const single = catalog.parseCartSku('LA-XYZ');
  assert.deepEqual([single.unknown, single.reason, single.name], [true, 'unknown', 'LA-XYZ']);
  // Không đoán: "CB10-XANH" là hộp 10 gói Xanh (một đơn vị), không phải 10 Túi Xanh 450g; "CB2-XANH-G35" (gói 35g) không phải
  // 2 Túi Xanh 450g; vị không có trong danh mục → unknown.
  assert.deepEqual(skus(cart('CB10-XANH')), [['CB10-XANH-G35', 1]]);
  assert.equal(cart('CB2-XANH-G35').unknown, true);
  assert.equal(cart('CB10-DAU').unknown, true);
  assert.equal(cart('CB2-MIX').unknown, true);
  assert.equal(catalog.parseShopCart([]).unknown, true, 'giỏ rỗng không tự lên đơn');
  // Giỏ lẫn dòng đọc được và dòng lạ: vẫn unknown (bot không tự chốt phần đọc được).
  const mixed = catalog.parseShopCart([{ sku: 'CB2-XANH-Z450', quantity: 1 }, { sku: 'LA-XYZ', quantity: 1, name: 'Món lạ' }]);
  assert.deepEqual([skus(mixed), mixed.unknown, mixed.name], [[[XANH_SKU, 2]], true, 'Món lạ']);
});

// ===== 3. Số lượng / vị theo đúng lời khách =====

test('r13 #3: colourCountsInText — lỗi gõ ("túi vành", "2ca cao", "vangd"), chữ đệm giữa đơn vị và màu ("2 túi hạt vàng")', () => {
  assert.deepEqual(colourCountsInText('Cho chị 1 xanh + 1 túi vành').counts, { XANH: 1, VANG: 1 });
  assert.deepEqual(colourCountsInText(`2ca cao,${PHONE},79xom hạ Vĩnh Thái nha trang khánh hòa`).counts, { NAU: 2 });
  assert.deepEqual(colourCountsInText('2 túi cá cao').counts, { NAU: 2 });
  assert.deepEqual(colourCountsInText('2 túi hạt vàng').counts, { VANG: 2 });
  assert.deepEqual(colourCountsInText('lấy 2 túi hạt vàng nhé').counts, { VANG: 2 });
  assert.deepEqual(colourCountsInText('Hai túi hạt vàng').counts, { VANG: 2 });
  assert.deepEqual(colourCountsInText('1 xanh\n1 vangd').counts, { XANH: 1, VANG: 1 });
  assert.deepEqual(colourCountsInText('Gửi mk 1 túi xanh và 1 túi ca cao').counts, { XANH: 1, NAU: 1 });
  // Không bắt nhầm.
  assert.deepEqual(colourCountsInText('đường vành đai 3').mentioned, []);
  assert.deepEqual(colourCountsInText('Vâng ạ đúng rồi').mentioned, [], '"vâng" không phải vị Vàng');
  assert.deepEqual(colourCountsInText('Có hạt điều nấu sữa ko ạ.').mentioned, [], '"nấu" không phải vị Nâu');
  assert.deepEqual(colourCountsInText('Mình lấy 1 xanh 1 ca cao 300g').counts, { XANH: 1 }, '"ca cao 300g" là Tropical, không phải Túi Nâu');
  assert.deepEqual(colourCountsInText('Vậy thôi đừng lấy ca cao nha mà lấy chị 2 túi xanh+ 1 túi vàng combo3 túi tặng chén muỗng').mentioned, ['XANH', 'VANG'], 'vị khách nói không lấy không tính');
  assert.deepEqual(colourCountsInText('2 loại xanh và vàng').counts, {}, 'hai loại, không phải 2 túi Xanh');
  assert.deepEqual(colourCountsInText('2 túi xanh mint').counts, {}, 'xanh mint là Tropical');
});

test('r13 #3: adjustOrderQuantities — "Chị lấy 2 mà" / "lấy 2 nha" / "Số lượng là 2" đổi số lượng giỏ một mã; vị thiếu vì lỗi gõ được thêm lại', () => {
  const q = items => items.map(item => [item.code, item.quantity]);
  assert.deepEqual(q(adjustOrderQuantities([XANH(1)], { messageText: 'Chị lấy 2 mà', heldItems: [XANH(1)] })), [[XANH_SKU, 2]]);
  assert.deepEqual(q(adjustOrderQuantities([], { messageText: 'Chị lấy 2 mà', heldItems: [XANH(1)] })), [[XANH_SKU, 2]]);
  assert.deepEqual(q(adjustOrderQuantities([VANG(1)], { messageText: 'lấy 2 nha', heldItems: [VANG(1)] })), [[VANG_SKU, 2]]);
  assert.deepEqual(q(adjustOrderQuantities([NAU(1)], { messageText: 'Số lượng là 2', recentItems: [NAU(1)] })), [[NAU_SKU, 2]], 'đơn vừa chốt 1 Nâu → 2 Nâu');
  const combo = { product: 'Combo 10 gói Xanh', code: 'CB10-XANH-G35', quantity: 1 };
  assert.deepEqual(q(adjustOrderQuantities([], { messageText: 'lấy 2 nha', heldItems: [combo] })), [['CB10-XANH-G35', 2]], 'giỏ một mã bất kỳ');
  // Giỏ nhiều mã: không đoán mã nào đổi số lượng — giữ giỏ.
  assert.deepEqual(q(adjustOrderQuantities([XANH(1)], { messageText: 'Chị lấy 2 mà', heldItems: [XANH(1), VANG(1)] })), [[XANH_SKU, 1], [VANG_SKU, 1]]);
  // Chữ đệm "hạt": giỏ luật đọc 1 Vàng → 2 Vàng.
  assert.deepEqual(q(adjustOrderQuantities([VANG(1)], { messageText: '2 túi hạt vàng', heldItems: [VANG(1)] })), [[VANG_SKU, 2]]);
  assert.deepEqual(q(adjustOrderQuantities([NAU(1)], { messageText: `2ca cao,${PHONE},79xom hạ Vĩnh Thái nha trang khánh hòa` })), [[NAU_SKU, 2]]);
  // "vành" không ai đọc ra → giỏ luật chỉ có 1 Xanh: thêm lại 1 Vàng theo đúng lời khách.
  assert.deepEqual(q(adjustOrderQuantities([XANH(1)], { messageText: 'Cho chị 1 xanh + 1 túi vành' })), [[XANH_SKU, 1], [VANG_SKU, 1]]);
  // Có ý đổi/bỏ thì không tự thêm.
  assert.deepEqual(q(adjustOrderQuantities([VANG(1)], { messageText: 'đổi 1 xanh thành 1 vàng nha' })), [[VANG_SKU, 1]]);
  // "ca cao 300g" (Tropical) không thành Túi Nâu.
  assert.deepEqual(q(adjustOrderQuantities([XANH(1)], { messageText: 'Mình lấy 1 xanh 1 ca cao 300g' })), [[XANH_SKU, 1]]);
});

test('r13 #3: câu HỎI không đổi giỏ — "Cho mix vị được không?" giữ giỏ đang có / không lập giỏ; lời đặt lịch sự có nêu món vẫn là đặt', () => {
  const q = items => items.map(item => [item.code, item.quantity]);
  assert.deepEqual(q(adjustOrderQuantities([XANH(1), VANG(1)], { messageText: 'Cho mix vị được không?', heldItems: [XANH(2)] })), [[XANH_SKU, 2]]);
  assert.deepEqual(q(adjustOrderQuantities([XANH(1), VANG(1)], { messageText: 'Cho mix vị được không?' })), []);
  assert.deepEqual(q(adjustOrderQuantities([XANH(1), VANG(1)], { messageText: 'Cho mix vị được không?', recentItems: [VANG(2)] })), [[VANG_SKU, 2]], 'đơn vừa chốt giữ nguyên');
  assert.deepEqual(q(adjustOrderQuantities([XANH(1)], { messageText: 'cho mình túi xanh được không' })), [[XANH_SKU, 1]]);
  // "Vâng" (bỏ dấu trùng "vàng") không phải nhắc vị Vàng: giữ giỏ đang có, không trả giỏ rỗng.
  assert.deepEqual(q(adjustOrderQuantities([], { messageText: 'Vâng ạ đúng rồi', heldItems: [XANH(1), VANG(1)] })), [[XANH_SKU, 1], [VANG_SKU, 1]]);
  // Qua bộ soạn: mô hình chọn ORDER_ADDRESS với giỏ mix → giỏ đang giữ không đổi.
  const reply = renderChatbotReply({ template_id: 'ORDER_ADDRESS', Product_N1: 'Granola Túi Xanh 450g', No_A: '1', Product_N2: 'Granola Túi Vàng 350g', No_B: '1' }, templates, { messageText: 'Cho mix vị được không?', pendingOrder: basket([XANH(2)]), now: Date.now() });
  assert.deepEqual(lines(reply.pendingOrder.items), [[XANH_SKU, 2]]);
});

test('r13 #3: "Cho mình 2 túi nhé" → (SĐT) → "Túi vàng nhiều hạt nhé" = 2 Túi Vàng dù lượt SĐT làm mất askedBagCount của giỏ chờ', () => {
  const value = { template_id: 'ORDER_ADDRESS', Product_N1: 'Granola Túi Vàng 350g', No_A: '1' };
  // Giỏ chờ sau lượt SĐT (engine ghi đè: chỉ còn SĐT, không còn askedBagCount).
  const pendingOrder = { items: [], key: '', at: Date.now() - 30000, phone: PHONE, address: '', addressAsks: 0 };
  const recentCustomerTexts = ['Cho mình 2 túi nhé', PHONE, 'Túi vàng nhiều hạt nhé'];
  const reply = renderChatbotReply(value, templates, { messageText: 'Túi vàng nhiều hạt nhé', lastTemplateId: 'ORDER_INFO_ASK_FLAVOR', pendingOrder, recentCustomerTexts, now: Date.now() });
  assert.deepEqual(lines(reply.pendingOrder.items), [[VANG_SKU, 2]]);
  assert.match(reply.messages.join('\n'), /2 Granola Túi Vàng 350g, tổng 298\.000đ/);
  // askedBagCount còn trong giỏ chờ thì dùng nó.
  const kept = renderChatbotReply(value, templates, { messageText: 'Túi vàng nhiều hạt nhé', lastTemplateId: 'ASK_FLAVOR', pendingOrder: { ...pendingOrder, askedBagCount: 3 }, recentCustomerTexts, now: Date.now() });
  assert.deepEqual(lines(kept.pendingOrder.items), [[VANG_SKU, 3]]);
  // Bot không vừa hỏi vị (tin "2 túi" cũ không liên quan) → 1 túi như lời khách.
  const unrelated = renderChatbotReply(value, templates, { messageText: 'Túi vàng nhiều hạt nhé', lastTemplateId: 'PRICE_QUOTE', pendingOrder, recentCustomerTexts, now: Date.now() });
  assert.deepEqual(lines(unrelated.pendingOrder.items), [[VANG_SKU, 1]]);
  // Tin trước đã nêu vị ("2 túi xanh") không phải "số túi chưa chọn vị".
  const flavoured = renderChatbotReply(value, templates, { messageText: 'Túi vàng nhiều hạt nhé', lastTemplateId: 'ASK_FLAVOR', pendingOrder, recentCustomerTexts: ['2 túi xanh giá sao', 'Túi vàng nhiều hạt nhé'], now: Date.now() });
  assert.deepEqual(lines(flavoured.pendingOrder.items), [[VANG_SKU, 1]]);
});

test('r13 #3 (qua engine): "Cho mình 2 túi nhé" → SĐT → "Túi vàng nhiều hạt nhé" giữ 2 Vàng; giỏ 1 Vàng + "2 túi hạt vàng" → 2 Vàng', async () => {
  const sim = new Sim({ id: 'page:user-r13-b', psid: 'user-r13-b' });
  await sim.send('Cho mình 2 túi nhé');
  await sim.send(PHONE);
  await sim.send('Túi vàng nhiều hạt nhé', { llm: { template_id: 'ORDER_ADDRESS', Product_N1: 'Granola Túi Vàng 350g', No_A: '1' } });
  assert.deepEqual(lines(sim.conversation.pendingOrder?.items), [[VANG_SKU, 2]]);
  const held = new Sim({ id: 'page:user-r13-c', psid: 'user-r13-c', pendingOrder: basket([VANG(1)], { upsold: true }), botLastTemplateId: 'ORDER_ADDRESS', botLastReplyAt: Date.now() - 60000 });
  await held.send('2 túi hạt vàng', { llm: { template_id: 'ORDER_ADDRESS', Product_N1: 'Granola Túi Vàng 350g', No_A: '1' } });
  assert.deepEqual(lines(held.conversation.pendingOrder?.items), [[VANG_SKU, 2]]);
});

// ===== 4. Sửa đơn vừa chốt: giữ món, cập nhật số nhà/đường =====

const orderOf = (extra = {}) => ({
  id: 'o-r13', createdAt: Date.now() - 3 * 60 * 1000, automatic: true, phone: PHONE, status: 'Mới', total: 442000,
  address: 'LKB 52MB 3830 khu ĐTM, An Hoạch - An Hưng, Huyện Đông Sơn, Thanh Hóa', rawAddress: 'LKB 52MB 3830 khu ĐTM Đông Sơn, An Hoạch - An Hưng Thanh Hoá',
  products: [{ name: 'Granola Túi Xanh 450g', sku: XANH_SKU, quantity: 1 }, { name: 'Granola Túi Vàng 350g', sku: VANG_SKU, quantity: 1 }, { name: 'Granola Túi Nâu vị cacao 350g', sku: NAU_SKU, quantity: 1 }],
  ...extra
});

test('r13 #4: ORDER_UPDATE khi tin chỉ nói địa chỉ ("Khu Đô Thị Mới Đông Sơn") giữ đủ 3 túi của đơn — không thành 1 Túi Xanh', () => {
  const order = orderOf();
  for (const value of [
    { template_id: 'ORDER_UPDATE', Product_N1: 'Granola Túi Xanh 450g', No_A: '1' },
    { template_id: 'ORDER_UPDATE', Product_N1: 'Granola Túi Xanh 450g', No_A: '1', Customer_Address: 'Khu Đô Thị Mới Đông Sơn' }
  ]) {
    const reply = renderChatbotReply(value, templates, { messageText: 'Khu Đô Thị Mới Đông Sơn', recentOrder: order, now: Date.now() });
    const items = reply.order?.items || reply.pendingOrder?.items || null;
    if (items) assert.deepEqual(lines(items), [[XANH_SKU, 1], [VANG_SKU, 1], [NAU_SKU, 1]]);
    else assert.equal(reply.templateId, 'ORDER_UNCHANGED');
    const text = reply.messages.join('\n');
    assert.match(text, /Túi Xanh 450g – Số lượng: 1/);
    assert.match(text, /Túi Vàng 350g – Số lượng: 1/);
    assert.match(text, /Túi Nâu vị cacao 350g – Số lượng: 1/);
    assert.match(text, /442\.000đ/);
    assert.ok(!reply.order || reply.order.total === 442000);
  }
});

test('r13 #4: tin có địa chỉ + SĐT trong 60 phút sau đơn thêm số nhà → sửa địa chỉ đơn (ORDER_UPDATE), không trả "đơn đã lên rồi"', () => {
  // Ca thật: đơn đã sửa còn "Khu Đô Thị Mới Đông Sơn, Phường An Hưng…"; khách gửi lại đủ số nhà "LK B52 MB 3830 …".
  const real = orderOf({ address: 'Khu Đô Thị Mới Đông Sơn, Phường An Hưng, Thành phố Thanh Hóa, Thanh Hóa', rawAddress: 'Khu Đô Thị Mới Đông Sơn, An Hưng, Thanh Hoá' });
  const typed = 'LK B52 MB 3830 Khu Đô Thị Mới Đông Sơn- An Hưng- Thanh Hoá nhé b';
  const reply = renderChatbotReply({ template_id: 'ORDER_CONFIRMATION', Phone_Number: PHONE, Customer_Address: typed }, templates, { messageText: `${typed}\n${PHONE}`, recentOrder: real, now: Date.now() });
  assert.notEqual(reply.templateId, 'ORDER_UNCHANGED');
  const address = reply.order?.address || reply.pendingOrder?.address || '';
  assert.match(address, /LK B52 MB 3830/);
  assert.doesNotMatch(address, /nhé b\s*$/i, 'đuôi lời dặn không lên phiếu');
  assert.deepEqual(lines(reply.order?.items || reply.pendingOrder?.items), [[XANH_SKU, 1], [VANG_SKU, 1], [NAU_SKU, 1]]);
  // Địa chỉ chuẩn: đơn thiếu số nhà, khách gửi đủ → ORDER_UPDATE đúng đơn đó, giữ món.
  const plain = orderOf({ address: 'Lê Lợi, Phường Bến Nghé, Quận 1, TP Hồ Chí Minh', rawAddress: 'Lê Lợi, phường Bến Nghé, quận 1, TP HCM' });
  const updated = renderChatbotReply({ template_id: 'ORDER_CONFIRMATION', Phone_Number: PHONE, Customer_Address: 'số 12 Lê Lợi, phường Bến Nghé, quận 1, TP HCM' }, templates, { messageText: `số 12 Lê Lợi, phường Bến Nghé, quận 1, TP HCM ${PHONE}`, recentOrder: plain, now: Date.now() });
  assert.equal(updated.templateId, 'ORDER_UPDATE');
  assert.equal(updated.order.updateOrderId, 'o-r13');
  assert.match(updated.order.address, /^số 12 Lê Lợi, Phường Bến Nghé, Quận 1/);
  assert.deepEqual(lines(updated.order.items), [[XANH_SKU, 1], [VANG_SKU, 1], [NAU_SKU, 1]]);
  // Gửi lại ĐÚNG địa chỉ của đơn (không thêm gì): vẫn là "đơn đã lên rồi", không hỏi lại phường/xã.
  const same = renderChatbotReply({ template_id: 'ORDER_CONFIRMATION', Phone_Number: PHONE, Customer_Address: 'Lê Lợi, phường Bến Nghé, quận 1, TP HCM' }, templates, { messageText: `Lê Lợi, phường Bến Nghé, quận 1, TP HCM ${PHONE}`, recentOrder: plain, now: Date.now() });
  assert.equal(same.templateId, 'ORDER_UNCHANGED');
  // Mảnh bổ sung số nhà cho đơn chưa có số nhà: ghép vào địa chỉ đơn, không thay cả địa chỉ.
  const fragment = renderChatbotReply({ template_id: 'ORDER_UPDATE', Customer_Address: 'số nhà 12' }, templates, { messageText: 'số nhà 12', recentOrder: plain, now: Date.now() });
  assert.equal(fragment.templateId, 'ORDER_UPDATE');
  assert.match(fragment.order.address, /số nhà 12/);
  assert.match(fragment.order.address, /Bến Nghé/);
});

// ===== 5. Đổi quà trong giỏ chờ =====

test('r13 #5: pendingOrder.giftSwap — tin giỏ / xác nhận đơn / chữ quà của đơn dùng 2 gói nhỏ thay bát + muỗng; tiền không đổi; trường đi theo giỏ', () => {
  const choice = catalog.parseGiftSwapChoice('xanh với cam');
  const held = basket([XANH(1), VANG(1), NAU(1)], { giftSwap: JSON.parse(JSON.stringify(choice)) });
  const ask = renderChatbotReply({ template_id: 'ORDER_ADDRESS' }, templates, { messageText: 'xanh với cam', pendingOrder: held, now: Date.now() });
  assert.match(ask.messages.join('\n'), /tổng 442\.000đ.*tặng 1 Gói granola nhỏ Xanh 35g \+ 1 Gói granola nhỏ Cam 30g/s);
  assert.doesNotMatch(ask.messages.join('\n'), /bát gáo dừa|Muỗng dừa/i);
  assert.deepEqual(ask.pendingOrder.giftSwap.map(option => option.sku), ['GRA-XANH-G35', 'GRA-CAM-G30'], 'lựa chọn không rơi khi lưu lại giỏ');
  // Đổi món/số túi: lựa chọn đổi quà vẫn đi theo giỏ.
  const changed = renderChatbotReply({ template_id: 'ORDER_ADDRESS', Product_N1: 'Granola Túi Xanh 450g', No_A: '3' }, templates, { messageText: 'lấy 3 túi xanh', pendingOrder: held, now: Date.now() });
  assert.deepEqual(lines(changed.pendingOrder.items), [[XANH_SKU, 3]]);
  assert.equal(changed.pendingOrder.giftSwap.length, 2);
  const close = renderChatbotReply({ template_id: 'ORDER_CONFIRMATION', Phone_Number: PHONE, Customer_Address: 'số 12 Lê Lợi, phường Bến Nghé, quận 1, TP HCM' }, templates, { messageText: `${PHONE} số 12 Lê Lợi, phường Bến Nghé, quận 1, TP HCM`, pendingOrder: held, now: Date.now() });
  assert.equal(close.templateId, 'ORDER_CONFIRMATION');
  assert.match(close.messages[0], /Tặng kèm: 1 Gói granola nhỏ Xanh 35g \+ 1 Gói granola nhỏ Cam 30g/);
  assert.doesNotMatch(close.messages[0], /bát gáo dừa/i);
  assert.equal(close.order.total, 442000, 'đổi quà không trừ tiền');
  assert.equal(close.order.gift, 'Miễn phí vận chuyển + 1 Gói granola nhỏ Xanh 35g + 1 Gói granola nhỏ Cam 30g (đổi quà: thay Bộ bát gáo dừa + Muỗng dừa)');
  assert.deepEqual(close.order.giftSwap.map(gift => gift.sku), ['GRA-XANH-G35', 'GRA-CAM-G30']);
  assert.deepEqual(close.order.giftSwapRemoved, ['Bộ bát gáo dừa', 'Muỗng dừa']);
  assert.equal(close.attention, true, 'nhân viên soát dòng quà');
  // Khách xin đổi nhưng chưa nêu vị (mảng rỗng): 2 gói nhỏ, vị nhân viên/khách chọn sau.
  const unspecified = renderChatbotReply({ template_id: 'ORDER_ADDRESS' }, templates, { messageText: 'ok', pendingOrder: basket([XANH(3)], { giftSwap: [] }), now: Date.now() });
  assert.match(unspecified.messages.join('\n'), /tặng 2 Gói granola nhỏ \(vị khách chọn\)/);
  // Giỏ không có quà hiện vật (2 túi khách thường): không bịa quà, vẫn giữ lựa chọn.
  const two = renderChatbotReply({ template_id: 'ORDER_ADDRESS' }, templates, { messageText: 'ok', pendingOrder: basket([XANH(2)], { giftSwap: catalog.parseGiftSwapChoice('2 gói nâu') }), now: Date.now() });
  assert.doesNotMatch(two.messages.join('\n'), /Gói granola nhỏ/);
  assert.equal(two.pendingOrder.giftSwap.length, 2);
  // Không có trường giftSwap: như cũ.
  const normal = renderChatbotReply({ template_id: 'ORDER_ADDRESS' }, templates, { messageText: 'ok', pendingOrder: basket([XANH(3)]), now: Date.now() });
  assert.match(normal.messages.join('\n'), /tặng Bộ bát gáo dừa \+ Muỗng dừa/);
  assert.equal(normal.pendingOrder.giftSwap, undefined);
});

test('r13 #5: heldGiftSwap / withGiftSwap / normalizeGiftSwapChoices — quà live "Quạt + Bát gáo dừa" đổi thành 2 gói nhỏ, giữ miễn ship', () => {
  assert.equal(heldGiftSwap({ items: [] }), null);
  assert.deepEqual(heldGiftSwap({ giftSwap: true }), []);
  assert.deepEqual(heldGiftSwap({ giftSwap: [{ id: 'xanh' }, { sku: 'gra-nau-g35' }, { id: 'lạ' }, 'Cam'] }).map(option => option.sku), ['GRA-XANH-G35', 'GRA-NAU-G35']);
  assert.deepEqual(catalog.normalizeGiftSwapChoices(['cam', 'cam', 'cam']).map(option => option.id), ['cam', 'cam'], 'tối đa 2 gói');
  const live = { priceable: true, total: 298000, gift: 'Miễn phí vận chuyển + Quạt + Bát gáo dừa', gifts: [{ id: 'freeship', name: 'Miễn phí vận chuyển', sku: '' }, { id: 'live', name: 'Quạt + Bát gáo dừa', sku: 'QUA-TANG-LIVE', livestreamOnly: true }] };
  const swapped = withGiftSwap(live, catalog.parseGiftSwapChoice('2 gói xanh'));
  assert.equal(swapped.gift, 'Miễn phí vận chuyển + 2 Gói granola nhỏ Xanh 35g');
  assert.equal(swapped.total, 298000);
  assert.deepEqual(swapped.giftSwap.removed, ['Quạt + Bát gáo dừa']);
  assert.deepEqual(swapped.giftSwap.added.map(gift => gift.sku), ['GRA-XANH-G35', 'GRA-XANH-G35']);
  assert.equal(withGiftSwap(live, null), live, 'không có lựa chọn → không đổi');
  assert.equal(withGiftSwap({ ...live, gifts: [live.gifts[0]] }, []).giftSwap, undefined, 'không có quà hiện vật → không đổi');
});

// ===== 6. Khách đã có đơn hỏi quà =====

test('r13 #6: khách đã có đơn hỏi quà — GIFT_POLICY_LIVE không mời "lấy 2 túi vị nào để em lên đơn"; nói quà của chính đơn đó', () => {
  const order = orderOf();
  const context = { messageText: 'Quà tặng là gì vậy shop', recentOrder: order, livestream: true, customer: { gender: 'female' }, now: Date.now() };
  const reply = renderChatbotReply({ template_id: 'GIFT_POLICY_LIVE' }, templates, context);
  assert.equal(reply.templateId, 'GIFT_POLICY_LIVE', 'giữ mã engine đã gọi');
  assert.equal(reply.variant, 'GIFT_POLICY_ORDER');
  assert.equal(reply.messages[0], 'Dạ đơn 1 Granola Túi Xanh 450g + 1 Granola Túi Vàng 350g + 1 Granola Túi Nâu vị cacao 350g của chị đã có quà tặng kèm Bộ bát gáo dừa + Muỗng dừa rồi ạ 🎁 Bên em gửi quà cùng đơn cho mình nha 💛');
  assert.doesNotMatch(reply.messages.join('\n'), /để em lên đơn|lấy 2 túi vị nào/);
  // Quà đã ghi trên đơn (quà live, kể cả quà đã đổi) được dùng nguyên văn; miễn ship không tính là quà hiện vật.
  const liveOrder = orderOf({ products: [{ name: 'Granola Túi Vàng 350g', sku: VANG_SKU, quantity: 2 }], gift: 'Miễn phí vận chuyển + Quạt + Bát gáo dừa', livestream: true });
  assert.match(renderChatbotReply({ template_id: 'GIFT_POLICY_LIVE' }, templates, { ...context, recentOrder: liveOrder }).messages[0], /đơn 2 Granola Túi Vàng 350g của chị đã có quà tặng kèm Quạt \+ Bát gáo dừa rồi ạ/);
  const swappedOrder = orderOf({ gift: 'Miễn phí vận chuyển + 2 Gói granola nhỏ Xanh 35g (đổi quà: thay Bộ bát gáo dừa + Muỗng dừa)' });
  assert.match(renderOrderGiftReply(templates, { recentOrder: swappedOrder }).messages[0], /đã có quà tặng kèm 2 Gói granola nhỏ Xanh 35g rồi ạ/);
  // Đơn 1 túi không có quà hiện vật: nêu đơn + bảng quà, vẫn không mời đặt.
  const one = renderChatbotReply({ template_id: 'GIFT_POLICY_LIVE' }, templates, { ...context, recentOrder: orderOf({ products: [{ name: 'Granola Túi Xanh 450g', sku: XANH_SKU, quantity: 1 }] }) });
  assert.equal(one.variant, 'GIFT_POLICY_ORDER_NONE');
  assert.match(one.messages[0], /đơn 1 Granola Túi Xanh 450g của chị.*chưa kèm quà tặng hiện vật/s);
  assert.match(one.messages[0], /Bộ bát gáo dừa \+ Muỗng dừa: từ 3 sản phẩm/);
  assert.doesNotMatch(one.messages.join('\n'), /để em lên đơn/);
  // Mẫu mời khác (PROMO/UPSELL3) cũng vậy; engine nói rõ hasOrder: false (đơn cũ quá hạn) thì dùng mẫu gốc.
  assert.equal(renderChatbotReply({ template_id: 'GIFT_POLICY_PROMO' }, templates, context).variant, 'GIFT_POLICY_ORDER');
  assert.equal(renderChatbotReply({ template_id: 'GIFT_POLICY_UPSELL3', values: { total3: '447.000đ' } }, templates, context).variant, 'GIFT_POLICY_ORDER');
  const explicit = renderChatbotReply({ template_id: 'GIFT_POLICY_LIVE' }, templates, { ...context, hasOrder: false });
  assert.match(explicit.messages[0], /lấy 2 túi vị nào để em lên đơn liền nha/);
  // Chưa có đơn / đơn đã hủy / đơn quá 24 giờ: mẫu mời như cũ.
  for (const recentOrder of [null, orderOf({ processingStatus: 'cancelled' }), orderOf({ createdAt: Date.now() - 25 * 60 * 60 * 1000 })]) {
    const invite = renderChatbotReply({ template_id: 'GIFT_POLICY_LIVE' }, templates, { ...context, recentOrder });
    assert.equal(invite.variant, undefined);
    assert.match(invite.messages[0], /lấy 2 túi vị nào để em lên đơn liền nha/);
  }
  // Engine gọi thẳng: mã riêng GIFT_POLICY_ORDER; không có đơn → null. Mẫu trong Cài đặt (nếu có) được dùng.
  assert.equal(renderOrderGiftReply(templates, { recentOrder: order }).templateId, 'GIFT_POLICY_ORDER');
  assert.equal(renderOrderGiftReply(templates, {}), null);
  assert.equal(renderOrderGiftReply({ ...templates, GIFT_POLICY_ORDER: 'Đơn {items} có quà {gift} ạ' }, { recentOrder: liveOrder }).messages[0], 'Đơn 2 Granola Túi Vàng 350g có quà Quạt + Bát gáo dừa ạ');
});

// ===== 7. Giá giỏ Shop và giỏ từ 4 túi =====

test('r13 #7: priceBasket khớp giá Shop cho các mã giỏ thật; giỏ 4/5/6/9/10 túi tính giá combo từng túi, miễn ship', () => {
  const totalOf = sku => { const priced = priceBasket(catalog.parseShopCart([{ sku, quantity: 0 }]).items); return [priced.priceable, priced.total, priced.shippingFee]; };
  // Giá Shop ghi trong tin giỏ thật: 298k / 293k / 447k / 204k / 189k.
  assert.deepEqual(totalOf('CB-VANGG+XANH'), [true, 298000, 0]);
  assert.deepEqual(totalOf('CB2-XANH-Z450'), [true, 298000, 0]);
  assert.deepEqual(totalOf('CB2-VANGG'), [true, 298000, 0]);
  assert.deepEqual(totalOf('CB-XANH+NAU'), [true, 293000, 0]);
  assert.deepEqual(totalOf('CB-VANGG+NAU'), [true, 293000, 0]);
  assert.deepEqual(totalOf('CB2-NAU-Z350'), [true, 288000, 0]);
  assert.deepEqual(totalOf('CB3-VANGG+BGD+M'), [true, 447000, 0]);
  // Chủ shop 05/10: Combo 10 gói Mix tắt → không tự tính giá; combo Xanh cùng giá.
  assert.deepEqual(totalOf('CB10-MIX'), [false, 0, 0]);
  assert.deepEqual(totalOf('CB10-XANH-G35'), [true, 204000, 15000]);
  // R16: Combo 10 gói Cam đã tắt (chủ shop 03/10) → không tự tính giá.
  assert.deepEqual(totalOf('CB10-CAM-G30'), [false, 0, 0]);
  assert.deepEqual(totalOf('GRA-XANH-Z450'), [true, 189000, 15000]);
  assert.match(priceBasket(catalog.parseShopCart([{ sku: 'CB3-VANGG+BGD+M' }]).items).gift, /Bộ bát gáo dừa \+ Muỗng dừa/, 'quà theo bảng quà khớp đuôi +BGD+M của mã');
  for (const [quantity, total] of [[4, 596000], [5, 745000], [6, 894000], [9, 1341000], [10, 1490000]]) {
    const priced = priceBasket([{ sku: XANH_SKU, quantity }]);
    assert.deepEqual([priced.priceable, priced.total, priced.shippingFee], [true, total, 0], `${quantity} túi`);
  }
  const mixed = priceBasket([{ sku: XANH_SKU, quantity: 2 }, { sku: VANG_SKU, quantity: 1 }, { sku: NAU_SKU, quantity: 1 }]);
  assert.deepEqual([mixed.total, mixed.totalQuantity], [149000 * 3 + 144000, 4]);
});
