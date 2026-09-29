import assert from 'node:assert/strict';
import test from 'node:test';
import './helpers/seed-catalog.mjs';
import { processChatbotChanges, withFallbackTemplates } from '../app/chatbot-engine.mjs';
import { defaultMessageTemplates, isGiftSwapRequest, renderChatbotReply } from '../app/chatbot-templates.mjs';

// 29/09: rà các ca "đổi sản phẩm" / "đổi quà" thật 30 ngày qua. Khách xin đổi đơn sau 60 phút
// (hay đơn nhân viên/POS lên, đơn đang giao) bị coi là đơn MỚI: bot hỏi lại SĐT/địa chỉ và mời thêm
// túi. Khách xin đổi quà thì bot kể lại bảng quà.
const seed = Object.fromEntries(Object.entries(defaultMessageTemplates()).map(([id, text]) => [id, text.trim()]));
const templates = withFallbackTemplates(seed);
const now = Date.now();
const order = (ageMin, extra = {}) => ({ id: 'o1', automatic: true, source: 'chatbot', createdAt: now - ageMin * 60000, phone: '0932009039', address: '48/45 Phạm Văn Xảo, Phường Phú Thọ Hòa, Quận Tân Phú, TP.HCM', products: [{ name: 'Granola Túi Xanh 450g', sku: 'GRA-XANH-Z450', quantity: 2 }], status: 'Mới', ...extra });
const xanhVang = template => ({ template_id: template, Product_N1: 'Granola Túi Xanh 450g', No_A: '1', Product_N2: 'Granola Túi Vàng 350g', No_B: '1', Phone_Number: '0', Customer_Address: '0' });

test('đổi đơn quá 60 phút: không coi là đơn mới — ghi giỏ khách muốn vào đơn, gắn thẻ cho nhân viên', () => {
  for (const template of ['ORDER_UPDATE', 'ORDER_CONFIRMATION', 'ORDER_ADDRESS']) {
    const reply = renderChatbotReply(xanhVang(template), templates, { now, recentOrder: order(120), messageText: 'Đổi lại 1 xanh,1vang đc kg shop' });
    assert.equal(reply.templateId, 'ORDER_CHANGE_STAFF', template);
    assert.equal(reply.attention, true);
    assert.equal(reply.orderChange, true);
    assert.equal(reply.order.noteOrderId, 'o1');
    assert.match(reply.order.note, /1 Granola Túi Xanh 450g \+ 1 Granola Túi Vàng 350g/);
    assert.equal(reply.order.updateOrderId, undefined);
    assert.doesNotMatch(reply.messages.join('\n'), /số điện thoại|địa chỉ/i, 'không hỏi lại SĐT/địa chỉ');
  }
});

test('đổi đơn: đơn nhân viên lên trên POS, hay đơn đang giao → nhân viên sửa; dưới 60 phút → bot tự sửa như cũ', () => {
  const pos = renderChatbotReply({ template_id: 'ORDER_UPDATE', Product_N1: 'Granola Túi Vàng 350g', No_A: '2', Phone_Number: '0', Customer_Address: '0' }, templates, { now, recentOrder: order(10, { source: 'POS', automatic: false }), messageText: 'cho chị đổi sang 2 túi vàng nhé' });
  assert.equal(pos.templateId, 'ORDER_CHANGE_STAFF');
  const shipping = renderChatbotReply({ template_id: 'ORDER_UPDATE', Product_N1: 'Granola Túi Nâu vị cacao 350g', No_A: '2', Phone_Number: '0', Customer_Address: '0' }, templates, { now, recentOrder: order(26 * 60, { status: 'Đang giao' }), messageText: 'đổi cho c sang túi nâu được k' });
  assert.equal(shipping.templateId, 'ORDER_CHANGE_STAFF');
  for (const text of ['Shop oi minh đổi lại lấy 1 túi xanh va 1 túi vàng nhe', 'Chị đặt nhầm, sửa đơn cho chị 1 com bo vàng+ xanh thôi nhá']) {
    const quick = renderChatbotReply(xanhVang('ORDER_UPDATE'), templates, { now, recentOrder: order(20), messageText: text });
    assert.equal(quick.templateId, 'ORDER_UPDATE', text);
    assert.equal(quick.order.updateOrderId, 'o1');
  }
});

test('đổi đơn: không cướp đơn mới — không có chữ đổi, "đơn khác", đơn đã giao xong, đơn quá 3 ngày, đang giữ giỏ mới hơn', () => {
  const fresh = { template_id: 'ORDER_CONFIRMATION', Product_N1: 'Granola Túi Vàng 350g', No_A: '2', Phone_Number: '0', Customer_Address: '0' };
  const cases = [
    [order(120), 'cho chị 2 túi vàng nhé'],
    [order(120), 'đổi sang túi vàng, lên đơn khác gửi mẹ chị nhé'],
    [order(120, { status: 'Đã giao' }), 'lần này đổi sang 2 túi vàng nha'],
    [order(5 * 24 * 60), 'lần này đổi sang 2 túi vàng nha']
  ];
  for (const [recentOrder, messageText] of cases) {
    const reply = renderChatbotReply(fresh, templates, { now, recentOrder, messageText });
    assert.notEqual(reply.templateId, 'ORDER_CHANGE_STAFF', messageText);
    assert.equal(reply.order?.noteOrderId, undefined, messageText);
  }
  const held = { items: [{ product: 'Granola Túi Vàng 350g', code: 'GRA-VANG-Z350', quantity: 1 }], key: 'GRA-VANG-Z350=1', at: now - 60000 };
  const reply = renderChatbotReply(fresh, templates, { now, recentOrder: order(120), pendingOrder: held, messageText: 'đổi sang 2 túi vàng nha' });
  assert.notEqual(reply.templateId, 'ORDER_CHANGE_STAFF', 'khách đang đặt đơn mới: "đổi" là sửa giỏ đang giữ');
});

test('nhận ra lời xin đổi quà (câu khách thật), không lẫn với đổi sản phẩm hay hỏi quà', () => {
  for (const text of ['Mình xin đổi quà tặng đc không', 'đổi quà tặng khác đc ko vì bác gáo dừa có rồi', 'Nếu ko lấy bát muỗn thì có bớt nữa ko ạ. Or đổi quà khác', 'Ko có đổi quà khác hả shop. Ko muốn cái đó', 'C không lấy bộ gáo dừa, tặng c khác dc kg', 'Ý chị hỏi là: thay quà khác đc ko?', 'Chị định lấy combo 3 túi. Tuy nhiên, có quà gì thay cho bát và muỗng ko? Vì chị mua 2 lần trước đều đc tặng quà này rồi', 'Bát gáo dừa nhà mình có rồi']) {
    assert.ok(isGiftSwapRequest(text), text);
  }
  for (const text of ['có quà tặng gì không shop', 'đổi qua túi vàng nha', 'quà tặng là gì vậy', 'đổi lại 1 xanh 1 vàng', 'mua 3 túi được tặng gì']) {
    assert.ok(!isGiftSwapRequest(text), text);
  }
});

test('đổi quà: mô hình chọn GIFT_POLICY → nhận yêu cầu + thẻ cho nhân viên, ghi vào đơn đang mở; hỏi quà thường vẫn là bảng quà', () => {
  const swap = renderChatbotReply({ template_id: 'GIFT_POLICY' }, templates, { now, recentOrder: order(30), messageText: 'C không lấy bộ gáo dừa, tặng c khác dc kg' });
  assert.equal(swap.templateId, 'GIFT_SWAP');
  assert.equal(swap.attention, true);
  assert.equal(swap.order.noteOrderId, 'o1');
  assert.match(swap.order.note, /Khách xin đổi quà: C không lấy bộ gáo dừa/);
  assert.equal(swap.pendingOrder, undefined, 'giỏ đang giữ không bị bỏ');
  const noOrder = renderChatbotReply({ template_id: 'GIFT_POLICY' }, templates, { now, messageText: 'Mình xin đổi quà tặng đc không' });
  assert.equal(noOrder.templateId, 'GIFT_SWAP');
  assert.equal(noOrder.order, undefined);
  const plain = renderChatbotReply({ template_id: 'GIFT_POLICY' }, templates, { now, messageText: 'mua 3 túi có quà gì không' });
  assert.equal(plain.templateId, 'GIFT_POLICY');
});

test('engine: xin đổi đơn quá 60 phút → ghi chú vào đúng đơn, không tạo/sửa đơn, gắn thẻ Đổi sản phẩm + Cần người xử lý, bot vẫn bật', async () => {
  const created = []; const updated = []; const notes = []; const states = [];
  await processChatbotChanges([{
    type: 'message',
    conversation: { id: 'page:user', pageId: 'page', psid: 'user', name: 'Khách', botEnabled: true, botLastTemplateId: 'ORDER_CONFIRMATION', customerOrders: [order(120)] },
    message: { id: 'm1', mid: 'm1', direction: 'incoming', type: 'text', text: 'Đổi lại 1 xanh,1vang đc kg shop', createdAt: now }
  }], {
    readSettings: async () => ({ enabled: true, responseMode: 'automatic', handoffKeywords: '', fragmentWaitMs: 1, messageTemplates: seed }),
    listMessages: async () => [],
    saveBotState: async (_id, state) => { states.push(state); },
    sendMessage: async () => ({ message: { mid: 'x' } }),
    createOrder: async (_c, o) => { created.push(o); return { order: { id: 'new', ...o }, created: true }; },
    updateOrder: async (_c, id, o) => { updated.push(id); return { order: { id, ...o }, updated: true }; },
    addOrderNote: async (_c, id, note) => { notes.push([id, note]); return { noted: true, order: { id } }; },
    requestReply: async payload => renderChatbotReply(xanhVang('ORDER_UPDATE'), templates, payload.context)
  });
  assert.deepEqual(created, []);
  assert.deepEqual(updated, []);
  assert.equal(notes.length, 1);
  assert.equal(notes[0][0], 'o1');
  const events = states.at(-1).addLabelEvents || [];
  assert.ok(events.includes('update'), 'thẻ Đổi sản phẩm');
  assert.ok(events.includes('handoff'), 'thẻ Cần người xử lý');
  assert.notEqual(states.at(-1).botEnabled, false, 'bot không bị tắt');
});
