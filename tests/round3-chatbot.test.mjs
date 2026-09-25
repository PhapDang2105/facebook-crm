import assert from 'node:assert/strict';
import test from 'node:test';
import './helpers/seed-catalog.mjs';
import { commentBasket, processChatbotChanges } from '../app/chatbot-engine.mjs';
import { defaultMessageTemplates, renderChatbotReply } from '../app/chatbot-templates.mjs';

// Các tình huống lấy từ đợt đọc 537 hội thoại ngày 25/09 (vòng 3).
const templates = Object.fromEntries(Object.entries(defaultMessageTemplates()).map(([id, text]) => [id, text.trim()]));
const settings = extra => async () => ({ enabled: true, responseMode: 'automatic', handoffKeywords: '', fragmentWaitMs: 1, messageTemplates: templates, ...extra });

async function run(conversation, text, { reply, recent = [], extraDeps = {}, type = 'text' } = {}) {
  const sent = [];
  const saved = [];
  let asked = false;
  const results = await processChatbotChanges([{
    type: 'message',
    conversation: { id: 'page:user', pageId: 'page', psid: 'user', name: 'Khách', botEnabled: true, ...conversation },
    message: { id: 'm-new', mid: 'm-new', direction: 'incoming', type, text, createdAt: Date.now() }
  }], {
    readSettings: settings(),
    listMessages: async () => recent,
    saveBotState: async (_id, state) => { saved.push(state); },
    sendMessage: async (_c, message) => { sent.push(message.text || `[ảnh ${message.imageUrls?.length || 1}]`); return { message: { mid: 'x' } }; },
    createOrder: async (_c, order) => ({ order: { id: 'new', ...order }, created: true }),
    requestReply: async () => { asked = true; return typeof reply === 'function' ? reply() : reply; },
    ...extraDeps
  });
  return { sent, saved, asked, results };
}

test('ngay sau bảng giá, "dùng thử" / "combo 2 túi" là khách đã chọn: xin SĐT/địa chỉ đúng sản phẩm, không hỏi mô hình', async () => {
  const quote = { id: 'q', direction: 'outgoing', type: 'text', text: 'Dạ, em gửi chị Bảng giá Granola Túi Vàng 350g để mình dễ tham khảo ạ: …', createdAt: Date.now() - 60 * 1000 };
  const conversation = { botLastTemplateId: 'PRICE_QUOTE', botLastReplyAt: Date.now() - 60 * 1000 };
  const trial = await run(conversation, 'Dùng thử', { recent: [quote], reply: { templateId: 'PRICE_QUOTE', messages: ['Bảng giá lại'], handoff: false } });
  assert.equal(trial.asked, false);
  assert.equal(trial.results[0].templateId, 'ORDER_ADDRESS');
  assert.equal(trial.saved.at(-1).pendingOrder.items[0].product, 'Granola Túi Vàng 350g');
  assert.equal(trial.saved.at(-1).pendingOrder.items[0].quantity, 1);
  const combo = await run(conversation, 'cho em lấy combo 2 túi nha', { recent: [quote], reply: { templateId: 'PRICE_QUOTE', messages: ['Bảng giá lại'], handoff: false } });
  assert.equal(combo.asked, false);
  assert.equal(combo.saved.at(-1).pendingOrder.items[0].quantity, 2);
  assert.match(combo.sent[0], /tổng 298\.000đ/, 'nêu lại giỏ và tổng tiền trước câu xin SĐT');
});

test('chống lặp không nuốt tin đổi giỏ: "Vàng và xanh" sau khi bot vừa xin SĐT cho 2 túi xanh vẫn được trả lời với giỏ mới', async () => {
  const pending = { items: [{ product: 'Granola Túi Xanh 450g', code: 'GRA-XANH-Z450', quantity: 2 }], key: 'GRA-XANH-Z450=2', at: Date.now(), phone: '', address: '' };
  const before = renderChatbotReply({ template_id: 'ORDER_ADDRESS', Product_N1: 'Granola Túi Xanh 450g', No_A: '2' }, templates, {});
  const recent = [{ id: 'b', direction: 'outgoing', type: 'text', text: before.messages[0], createdAt: Date.now() - 2 * 60 * 1000 }];
  const changed = renderChatbotReply({ template_id: 'ORDER_ADDRESS', Product_N1: 'Granola Túi Vàng 350g', No_A: '1', Product_N2: 'Granola Túi Xanh 450g', No_B: '1' }, templates, { pendingOrder: pending });
  const out = await run({ botLastTemplateId: 'ORDER_ADDRESS', botLastReplyAt: Date.now() - 2 * 60 * 1000, pendingOrder: pending }, 'Vàng và xanh', { recent, reply: changed });
  assert.equal(out.sent.length, 1);
  assert.match(out.sent[0], /1 Granola Túi Vàng 350g \+ 1 Granola Túi Xanh 450g/);
  assert.equal(out.saved.at(-1).pendingOrder.key, changed.pendingOrder.key, 'giỏ mới được lưu');
});

test('khách nhắn có nội dung mà bot sắp gửi lại y câu xin SĐT/địa chỉ: nhắc ngắn giỏ + tổng + phần thiếu (trước đây im lặng)', async () => {
  const same = renderChatbotReply({ template_id: 'ORDER_ADDRESS', Product_N1: 'Granola Túi Xanh 450g', No_A: '2' }, templates, {});
  const recent = [{ id: 'b', direction: 'outgoing', type: 'text', text: same.messages[0], createdAt: Date.now() - 60 * 1000 }];
  const out = await run({ botLastTemplateId: 'ORDER_ADDRESS', botLastReplyAt: Date.now() - 60 * 1000, pendingOrder: same.pendingOrder }, 'Lấy túi đó nha shop', { recent, reply: same });
  assert.equal(out.sent.length, 1);
  assert.match(out.sent[0], /vẫn đang giữ đơn 2 Granola Túi Xanh 450g – tổng 298\.000đ/);
  assert.equal(out.results[0].templateId, 'ORDER_ADDRESS_REMIND');
  // Lần thứ hai vẫn lặp: im, nhưng gắn thẻ cho nhân viên và giữ giỏ.
  const again = await run({ botLastTemplateId: 'ORDER_ADDRESS_REMIND', botLastReplyAt: Date.now() - 30 * 1000, pendingOrder: same.pendingOrder }, 'sao em không trả lời', { recent, reply: same });
  assert.deepEqual(again.sent, []);
  assert.deepEqual(again.saved.at(-1).addLabelEvents, ['handoff']);
  // "ok" thì vẫn im, không gắn thẻ.
  const ack = await run({ botLastTemplateId: 'ORDER_ADDRESS', botLastReplyAt: Date.now() - 30 * 1000, pendingOrder: same.pendingOrder }, 'ok', { recent, reply: same });
  assert.deepEqual(ack.sent, []);
  assert.equal(ack.saved.at(-1)?.addLabelEvents, undefined);
});

test('"luôn" không phải cộng thêm: đơn 1 túi, "gửi e 2 túi luôn c nha" → sửa thành 2 túi (298k), không phải 3 túi', () => {
  const now = Date.now();
  const recentOrder = { id: 'o1', automatic: true, createdAt: now - 2 * 60 * 1000, phone: '0909123456', address: '12 Lê Lợi, Phường Bến Nghé, Quận 1, TP.HCM', products: [{ name: 'Granola Túi Xanh 450g', sku: 'GRA-XANH-Z450', quantity: 1 }] };
  const reply = renderChatbotReply({ template_id: 'ORDER_CONFIRMATION', Product_N1: 'Granola Túi Xanh 450g', No_A: '2' }, templates, { now, recentOrder, messageText: 'Gui e 2 túi luon c nha' });
  assert.equal(reply.templateId, 'ORDER_UPDATE');
  assert.deepEqual(reply.order.items.map(item => item.quantity), [2]);
  assert.equal(reply.order.total, 298000);
  // Mô hình trả giỏ ĐẦY ĐỦ kèm chữ "thêm": không cộng lần nữa.
  const full = renderChatbotReply({ template_id: 'ORDER_CONFIRMATION', Product_N1: 'Granola Túi Xanh 450g', No_A: '1', Product_N2: 'Granola Túi Vàng 350g', No_B: '1' }, templates, { now, recentOrder, messageText: 'lấy thêm 1 túi vàng' });
  assert.deepEqual(full.order.items.map(item => [item.code, item.quantity]).sort(), [['GRA-VANG-H350', 1], ['GRA-XANH-Z450', 1]]);
  // "ghép đơn" 4 giờ sau vẫn gộp vào đơn cũ (chưa giao), không đơn mới có ship.
  const later = renderChatbotReply({ template_id: 'ORDER_CONFIRMATION', Product_N1: 'Granola Túi Vàng 350g', No_A: '1' }, templates, { now, recentOrder: { ...recentOrder, createdAt: now - 4 * 60 * 60 * 1000 }, messageText: 'lấy thêm 1 túi vàng ghép đơn nhé' });
  assert.equal(later.templateId, 'ORDER_UPDATE');
  assert.equal(later.order.updateOrderId, 'o1');
  assert.equal(later.order.shippingFee, 0);
});

test('tin vừa đặt vừa hỏi ("also"): trả lời câu hỏi rồi mới xin SĐT/địa chỉ', () => {
  const reply = renderChatbotReply({ template_id: 'ORDER_ADDRESS', Product_N1: 'Granola Túi Vàng 350g', No_A: '2', also: 'WEIGHT_EXPIRY' }, templates, {});
  assert.equal(reply.templateId, 'ORDER_ADDRESS');
  assert.equal(reply.alsoTemplateId, 'WEIGHT_EXPIRY');
  assert.match(reply.messages[0], /Hạn sử dụng 6 tháng/);
  assert.match(reply.messages[1], /xin số điện thoại/);
  // Ý phụ không được là bước đơn hay chuyển người.
  assert.equal(renderChatbotReply({ template_id: 'PRICE_QUOTE', Product_N1: 'Granola Túi Vàng 350g', also: 'CSKH_HANDOFF' }, templates, {}).alsoTemplateId, undefined);
  assert.equal(renderChatbotReply({ template_id: 'PRICE_QUOTE', Product_N1: 'Granola Túi Vàng 350g', also: 'ORDER_CONFIRMATION' }, templates, {}).alsoTemplateId, undefined);
});

test('khách hỏi đơn đã đặt rồi gửi SĐT: tra theo SĐT ở mọi hội thoại; không thấy thì báo nhân viên tra, không coi là đơn mới', async () => {
  const found = { id: 'x1', createdAt: Date.now() - 3 * 60 * 60 * 1000, total: 298000, products: [{ name: 'Granola Túi Xanh 450g', quantity: 2 }], phone: '0909123456' };
  const hit = await run({ botLastTemplateId: 'ORDER_STATUS' }, '0909123456', { reply: { templateId: 'ORDER_ADDRESS', messages: ['xin địa chỉ'], handoff: false }, extraDeps: { findOrdersByPhone: async () => [found] } });
  assert.equal(hit.asked, false);
  assert.match(hit.sent[0], /Granola Túi Xanh 450g x2/);
  const miss = await run({ botLastTemplateId: 'ORDER_STATUS' }, 'mình đã đặt rồi 0909123456', { reply: { templateId: 'ORDER_ADDRESS', messages: ['xin địa chỉ'], handoff: false }, extraDeps: { findOrdersByPhone: async () => [] } });
  assert.equal(miss.results[0].templateId, 'ORDER_STATUS_CHECKING');
  assert.ok(miss.saved.at(-1).addLabelEvents.includes('handoff'));
});

test('giỏ ghi trong bình luận: nhận ra túi và số lượng, cần ý mua; "xanh dương" và "nấu" không phải túi', () => {
  assert.deepEqual(commentBasket('C 2 túi vàng'), [{ product: 'Granola Túi Vàng 350g', quantity: 2 }]);
  assert.deepEqual(commentBasket('Túi vàng với túi xanh lá cây').map(item => item.quantity), [1, 1]);
  assert.deepEqual(commentBasket('2 xanh 1 nâu').map(item => [item.product, item.quantity]), [['Granola Túi Xanh 450g', 2], ['Granola Túi Nâu vị cacao 350g', 1]]);
  assert.deepEqual(commentBasket('Túi vàng'), [], 'chỉ nêu một màu, không ý mua: để model báo giá');
  assert.deepEqual(commentBasket('lấy 1 túi xanh dương'), []);
  assert.deepEqual(commentBasket('hạt này nấu sữa được không, lấy 2 hũ'), []);
});

test('bình luận live "Đã săn 290k" khi chưa có đơn: ghi nhận, xin loại/SL/SĐT/địa chỉ, gắn thẻ — không "chưa thấy đơn"', async () => {
  const sent = [];
  let labels = [];
  await processChatbotChanges([{
    type: 'message',
    conversation: { id: 'page:comment:c1:p1', pageId: 'page', psid: 'user', source: 'comment', name: 'Linh', botEnabled: true, post: { message: 'Săn deal hời cùng Giọt Nắng' } },
    message: { id: 'c1', mid: 'c1', direction: 'incoming', type: 'text', text: 'Đã săn 290k', createdAt: Date.now() }
  }], {
    readSettings: settings(),
    listMessages: async () => [],
    getConversation: async () => null,
    saveBotState: async (_id, state) => { if (state.addLabelEvents) labels = state.addLabelEvents; },
    sendMessage: async (_c, message) => { sent.push(`${message.privateReply ? 'riêng' : 'công khai'}:${message.text}`); return { message: { mid: 'x' } }; },
    requestReply: async () => ({ templateId: 'ORDER_STATUS', messages: ['Dạ em chưa thấy đơn nào…'], handoff: false })
  });
  assert.match(sent[0], /^riêng:.*đã săn deal trên live/s);
  assert.doesNotMatch(sent.join(' '), /chưa thấy đơn/);
  assert.ok(labels.includes('handoff'));
});

test('bình luận liên tiếp trên cùng luồng: chỉ một lời "em đã ib" công khai trong 10 phút', async () => {
  const sent = [];
  await processChatbotChanges([{
    type: 'message',
    conversation: { id: 'page:comment:c2:p1', pageId: 'page', psid: 'user', source: 'comment', name: 'Mai', botEnabled: true },
    message: { id: 'c2', mid: 'c2', direction: 'incoming', type: 'text', text: 'giá túi xanh sao', createdAt: Date.now() }
  }], {
    readSettings: settings(),
    listMessages: async id => (id === 'page:comment:c2:p1' ? [{ id: 'pub', direction: 'outgoing', type: 'text', text: 'Dạ em đã ib cho chị rồi ạ', createdAt: Date.now() - 3 * 60 * 1000 }] : []),
    getConversation: async () => null,
    saveBotState: async () => {},
    sendMessage: async (_c, message) => { sent.push(message.privateReply ? 'riêng' : 'công khai'); return { message: { mid: 'x' } }; },
    requestReply: async () => ({ templateId: 'PRICE_QUOTE', messages: ['Bảng giá túi xanh'], handoff: false })
  });
  assert.deepEqual(sent, ['riêng']);
});

test('ảnh khách gửi từ quảng cáo một sản phẩm, model không đọc được: gửi bảng giá sản phẩm của quảng cáo (vẫn gắn thẻ)', async () => {
  const out = await run({ referral: { adTitle: 'Granola Túi Xanh 450g giòn rụm' } }, '', { type: 'image' });
  assert.match(out.sent.join(' '), /Bảng giá Granola Túi Xanh 450g/);
  assert.ok(out.saved.at(-1).addLabelEvents.includes('handoff'));
});
