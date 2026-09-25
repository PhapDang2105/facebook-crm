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

test('giỏ Facebook Shop: trả lời ngay (không bắt khách chờ); POS có đơn Shop sau đó thì nhắn "đã nhận đơn, không cần gửi lại" và bỏ giỏ chờ', async () => {
  const sent = [];
  let saved = null;
  let calls = 0;
  await processChatbotChanges([{
    type: 'message',
    conversation: { id: 'page:user', pageId: 'page', psid: 'user', name: 'Khách', botEnabled: true, pancakeConversationId: 'pc1' },
    message: { id: 'cart1', mid: 'cart1', direction: 'incoming', type: 'text', text: 'Khách chọn mua từ Facebook Shop', cart: [{ sku: 'CB-VANGG+XANH', quantity: 1 }], createdAt: Date.now() }
  }], {
    readSettings: settings({ shopOrderFollowUpMs: [5, 5] }),
    listMessages: async () => [],
    saveBotState: async (_id, state) => { saved = state; },
    sendMessage: async (_c, message) => { sent.push(message.text); return { message: { mid: 'x' } }; },
    requestReply: async () => { throw new Error('không gọi mô hình'); },
    findShopOrder: async () => { calls += 1; return calls < 2 ? null : { id: '53462', total: 298000, items: [] }; }
  });
  assert.equal(calls, 1, 'tra một lần ngay, không chờ');
  assert.match(sent[0], /xin số điện thoại/, 'chưa thấy đơn Shop: xin thông tin như thường, ngay lập tức');
  await new Promise(resolve => setTimeout(resolve, 80));
  assert.equal(calls, 2, 'tra lại ở nền');
  assert.match(sent.at(-1), /đã nhận đơn 1 Granola Túi Vàng 350g \+ 1 Granola Túi Xanh 450g – tổng 298\.000đ/);
  assert.equal(saved.pendingOrder, null);
});

test('sắp tự lên đơn mà hội thoại đã có đơn POS trong giờ qua (Shop / nhân viên vừa lên): không tạo đơn trùng', async () => {
  const created = [];
  const confirmation = renderChatbotReply({ template_id: 'ORDER_CONFIRMATION', Product_N1: 'Granola Túi Xanh 450g', No_A: '2', Phone_Number: '0909123456', Customer_Address: '12 Lê Lợi, Phường Bến Nghé, Quận 1, TP.HCM' }, templates, {});
  assert.equal(confirmation.templateId, 'ORDER_CONFIRMATION');
  const out = await run({ pancakeConversationId: 'pc2' }, '0909123456 12 Lê Lợi Q1', {
    reply: confirmation,
    extraDeps: {
      createOrder: async (_c, order) => { created.push(order); return { order: { id: 'dup', ...order }, created: true }; },
      findShopOrder: async () => ({ id: '53570', total: 298000, phone: '0909123456', items: [{ name: 'Granola Túi Xanh', sku: 'GRA-XANH-Z450', quantity: 2 }] })
    }
  });
  assert.deepEqual(created, []);
  assert.equal(out.results[0].templateId, 'SHOP_ORDER_RECEIVED');
  // Khách nói rõ đơn thêm/đơn khác: vẫn lên đơn, gắn thẻ để nhân viên soát.
  const other = await run({ pancakeConversationId: 'pc2' }, 'làm thêm 1 đơn gửi mẹ 0909123456 12 Lê Lợi Q1', {
    reply: confirmation,
    extraDeps: {
      createOrder: async (_c, order) => { created.push(order); return { order: { id: 'new2', ...order }, created: true }; },
      findShopOrder: async () => ({ id: '53570', total: 298000, phone: '0909123456', items: [] })
    }
  });
  assert.equal(created.length, 1);
  assert.equal(other.results[0].templateId, 'ORDER_CONFIRMATION');
  assert.ok(other.saved.at(-1).addLabelEvents.includes('handoff'));
});

test('địa chỉ ghi phường/xã MỚI sau sáp nhập, tỉnh khớp, có số nhà: nhận luôn, không hỏi lại cấp khách đã ghi', () => {
  const reply = renderChatbotReply({ template_id: 'ORDER_CONFIRMATION', Product_N1: 'Granola Túi Xanh 450g', No_A: '2', Phone_Number: '0909123456', Customer_Address: '16/44 Lê Hoàn, phường Hạc Thành, Thanh Hóa' }, templates, {});
  assert.equal(reply.templateId, 'ORDER_CONFIRMATION');
  assert.match(reply.order.address, /Hạc Thành/);
  // Không ghi phường/xã thì vẫn hỏi như cũ.
  const vague = renderChatbotReply({ template_id: 'ORDER_CONFIRMATION', Product_N1: 'Granola Túi Xanh 450g', No_A: '2', Phone_Number: '0909123456', Customer_Address: '16/44 Lê Hoàn, Thanh Hóa' }, templates, {});
  assert.equal(vague.templateId, 'ORDER_ADDRESS');
});

test('tên người nhận ghi đầu địa chỉ được tách ra; tên đường mang tên người thì giữ nguyên', async () => {
  const { stripReceiverName } = await import('../app/chatbot-templates.mjs');
  assert.equal(stripReceiverName('Nguyễn thị hằng Thôn 4, xã Đông Hòa, Đông Sơn, Thanh Hóa'), 'Thôn 4, xã Đông Hòa, Đông Sơn, Thanh Hóa');
  assert.equal(stripReceiverName('Nguyễn Thị Hồng, 12 Lê Lợi, Quận 1'), '12 Lê Lợi, Quận 1');
  assert.equal(stripReceiverName('Nguyễn Trãi 123, Phường 5, Quận 5'), 'Nguyễn Trãi 123, Phường 5, Quận 5');
  assert.equal(stripReceiverName('Lê Lợi, Phường Bến Nghé, Quận 1'), 'Lê Lợi, Phường Bến Nghé, Quận 1');
  assert.equal(stripReceiverName('12 Lê Lợi, Quận 1'), '12 Lê Lợi, Quận 1');
});

test('vừa chốt đơn, khách dặn "Gửi hàng mới cho mình nhé shop": ghi chú vào đơn, trả lời ngắn — không gửi lại trạng thái đơn', async () => {
  const recentOrder = { id: 'tb1', automatic: true, createdAt: Date.now() - 4 * 60 * 1000, phone: '0969000970', address: 'Cần Thơ', products: [{ name: 'Granola Túi Xanh 450g', sku: 'GRA-XANH-Z450', quantity: 2 }] };
  const notes = [];
  const out = await run({ customerOrders: [recentOrder], botLastTemplateId: 'ORDER_CONFIRMATION', botLastReplyAt: Date.now() - 4 * 60 * 1000 }, 'Gửi hàng mới cho mình nhé shop', {
    reply: { templateId: 'ORDER_STATUS', messages: ['Dạ em kiểm tra thấy đơn của mình gồm…'], handoff: false },
    extraDeps: { addOrderNote: async (_c, id, note) => { notes.push([id, note]); return { order: recentOrder, noted: true, created: false }; } }
  });
  assert.equal(out.asked, false, 'không cần hỏi mô hình');
  assert.deepEqual(notes, [['tb1', 'Gửi hàng mới cho mình nhé shop']]);
  assert.equal(out.sent.length, 1);
  assert.match(out.sent[0], /ghi chú yêu cầu của anh\/chị vào đơn/);
  assert.match(out.sent[0], /hạn dùng mới nhất/);
  assert.doesNotMatch(out.sent[0], /đặt lúc/);
  // Chưa có đơn: không ghi chú gì, để mô hình trả lời như thường.
  const none = await run({}, 'Gửi hàng mới cho mình nhé shop', { reply: { templateId: 'GENERAL_INFO', messages: ['bảng giá'], handoff: false } });
  assert.equal(none.asked, true);
});

test('lời chào live (kèm quà live) chỉ dưới bài livestream: khách từng bấm quảng cáo "Săn deal hời" mà bình luận bài thường thì không', async () => {
  const { isLivestreamPost } = await import('../app/chatbot-engine.mjs');
  const normalPost = { source: 'comment', post: { message: '🌳 GRANOLA NHÀ LÀM GIÒN RỤM, CÀNG NHAI CÀNG CUỐN 🔥' }, referral: { adTitle: 'Săn deal hời' } };
  assert.equal(isLivestreamPost(normalPost), false);
  assert.equal(isLivestreamPost({ source: 'comment', post: { message: 'Săn deal hời' } }), true);
  assert.equal(isLivestreamPost({ post: { message: 'Phát trực tiếp của Nông Sản Giọt Nắng' } }), true);
  assert.equal(isLivestreamPost({ referral: { adTitle: 'Săn deal hời' } }), true, 'không có bài viết: dựa vào quảng cáo');
  assert.equal(isLivestreamPost({ referral: { adTitle: 'Quảng cáo video trực tiếp - 08:46 21/9/26' } }), true);
  const sent = [];
  await processChatbotChanges([{
    type: 'message',
    conversation: { id: 'page:comment:c9:p9', pageId: 'page', psid: 'user', name: 'Lan', botEnabled: true, ...normalPost },
    message: { id: 'c9', mid: 'c9', direction: 'incoming', type: 'text', text: 'giá sao shop', createdAt: Date.now() }
  }], {
    readSettings: settings(),
    listMessages: async () => [],
    getConversation: async () => null,
    saveBotState: async () => {},
    sendMessage: async (_c, message) => { if (message.privateReply) sent.push(message.text); return { message: { mid: 'x' } }; },
    requestReply: async () => ({ templateId: 'GENERAL_INFO', messages: ['Dạ hiện tại nhà em có 3 vị chính ạ'], handoff: false })
  });
  assert.doesNotMatch(sent.join(' '), /phiên live|quà live/);
});

test('soát lỗi vòng 4: luật "lời dặn" không nuốt tin sửa địa chỉ / đặt thêm / câu hỏi; lời dặn thứ hai vẫn được ghi', async () => {
  const recentOrder = { id: 'o4', automatic: true, createdAt: Date.now() - 10 * 60 * 1000, phone: '0909123456', address: 'Q1', products: [{ name: 'Granola Túi Xanh 450g', sku: 'GRA-XANH-Z450', quantity: 2 }] };
  const base = { customerOrders: [recentOrder], botLastTemplateId: 'ORDER_CONFIRMATION', botLastReplyAt: Date.now() - 10 * 60 * 1000 };
  for (const text of ['Sửa lại địa chỉ giúp chị: 45 Trần Phú, Phường 4, Quận 5, giao giờ hành chính nhé', 'giao sau 5h chiều nhé, sdt người nhận 0912000111', 'khi nào giao vậy em, giao buổi chiều được không', 'Chị lấy 2 túi vàng nữa, giao buổi sáng giúp chị']) {
    const out = await run(base, text, { reply: { templateId: 'ORDER_UPDATE', messages: ['mô hình'], handoff: false }, extraDeps: { addOrderNote: async () => { throw new Error('không được ghi chú: ' + text); } } });
    assert.equal(out.asked, true, text);
  }
  const notes = [];
  const note = await run({ ...base, botLastTemplateId: 'ORDER_NOTE', botLastReplyAt: Date.now() - 60 * 1000 }, 'à nhớ gọi trước khi giao nha em', {
    recent: [{ id: 'n1', direction: 'outgoing', type: 'text', text: 'Dạ vâng ạ, em đã ghi chú yêu cầu của anh/chị vào đơn và báo kho rồi ạ 💛', createdAt: Date.now() - 60 * 1000 }],
    extraDeps: { addOrderNote: async (_c, id, text) => { notes.push(text); return { order: recentOrder, noted: true, created: false }; } }
  });
  assert.equal(notes.length, 1, 'lời dặn thứ hai không bị chống lặp nuốt');
  assert.equal(note.sent.length, 1);
});

test('soát lỗi vòng 4: có SĐT nhưng tin là ĐẶT đơn ("xác nhận đơn: 2 túi xanh…", "mua rồi, lấy thêm") thì không tra đơn cũ', async () => {
  let looked = 0;
  for (const text of ['Xác nhận đơn giúp chị: 2 túi xanh, 0909123456, 12 Lê Lợi Q1', 'Chị mua rồi thấy ngon, lấy thêm 2 túi xanh 0909123456']) {
    const out = await run({ botLastTemplateId: 'ORDER_STATUS' }, text, { reply: { templateId: 'ORDER_ADDRESS', messages: ['mô hình'], handoff: false }, extraDeps: { findOrdersByPhone: async () => { looked += 1; return []; } } });
    assert.equal(out.asked, true, text);
  }
  assert.equal(looked, 0);
});

test('soát lỗi vòng 4: bình luận "hủy đơn" không được nhắn "đã hủy" (bot không hủy được dưới bình luận) — báo nhân viên', async () => {
  const sent = [];
  let cancelled = 0;
  const recentOrder = { id: 'o5', automatic: true, createdAt: Date.now() - 30 * 60 * 1000, phone: '0909123456', address: 'Q1', products: [{ name: 'Granola Túi Xanh 450g', sku: 'GRA-XANH-Z450', quantity: 2 }] };
  await processChatbotChanges([{
    type: 'message',
    conversation: { id: 'page:comment:c5:p5', pageId: 'page', psid: 'user', source: 'comment', name: 'Hoa', botEnabled: true, customerOrders: [recentOrder] },
    message: { id: 'c5', mid: 'c5', direction: 'incoming', type: 'text', text: 'hủy đơn giúp c nha', createdAt: Date.now() }
  }], {
    readSettings: settings(),
    listMessages: async () => [],
    getConversation: async () => null,
    saveBotState: async () => {},
    cancelOrder: async () => { cancelled += 1; return { cancelled: true }; },
    sendMessage: async (_c, message) => { if (message.privateReply) sent.push(message.text); return { message: { mid: 'x' } }; },
    requestReply: async () => renderChatbotReply({ template_id: 'ORDER_CANCEL' }, templates, { recentOrder, now: Date.now() })
  });
  assert.equal(cancelled, 0);
  assert.ok(!sent.join(' ').includes('đã hủy đơn'));
  assert.ok(sent.join(' ').includes('nhận được tin'));
});

test('soát lỗi vòng 4: dưới bài live, khiếu nại "chưa nhận được hàng" không bị trả mẫu "đã săn deal"', async () => {
  const sent = [];
  await processChatbotChanges([{
    type: 'message',
    conversation: { id: 'page:comment:c6:p6', pageId: 'page', psid: 'user', source: 'comment', name: 'Lan', botEnabled: true, post: { message: 'Săn deal hời' } },
    message: { id: 'c6', mid: 'c6', direction: 'incoming', type: 'text', text: 'Chị đã mua trên live tuần trước mà giờ chưa nhận được hàng', createdAt: Date.now() }
  }], {
    readSettings: settings(),
    listMessages: async () => [],
    getConversation: async () => null,
    saveBotState: async () => {},
    sendMessage: async (_c, message) => { if (message.privateReply) sent.push(message.text); return { message: { mid: 'x' } }; },
    requestReply: async () => ({ templateId: 'ORDER_STATUS', messages: ['Dạ em chưa thấy đơn nào'], handoff: false })
  });
  assert.ok(!sent.join(' ').includes('săn deal'));
});

test('soát lỗi vòng 4: "also" không gửi lại mẫu vừa gửi trong 30 phút; "12 Xã Đàn" là tên đường, không phải phường mới', () => {
  const quote = renderChatbotReply({ template_id: 'PRICE_QUOTE', Product_N1: 'Granola Túi Xanh 450g' }, templates, {});
  const withAlso = renderChatbotReply({ template_id: 'ORDER_ADDRESS', Product_N1: 'Granola Túi Xanh 450g', No_A: '1', also: 'PRICE_QUOTE' }, templates, { recentOutgoing: [quote.messages[0]] });
  assert.equal(withAlso.alsoTemplateId, undefined);
  const street = renderChatbotReply({ template_id: 'ORDER_CONFIRMATION', Product_N1: 'Granola Túi Xanh 450g', No_A: '2', Phone_Number: '0909123456', Customer_Address: '12 Xã Đàn, Hà Nội' }, templates, {});
  assert.equal(street.templateId, 'ORDER_ADDRESS');
});

test('đơn nhân viên/Facebook Shop tạo trên POS (source POS): bot không tự sửa hay hủy — chuyển nhân viên', () => {
  const posOrder = { id: 'pos53462', source: 'POS', automatic: false, createdAt: Date.now() - 20 * 60 * 1000, phone: '0909123456', address: 'Q1', products: [{ name: 'Granola Túi Xanh 450g', sku: 'GRA-XANH-Z450', quantity: 2 }] };
  const cancel = renderChatbotReply({ template_id: 'ORDER_CANCEL' }, templates, { recentOrder: posOrder, now: Date.now() });
  assert.equal(cancel.templateId, 'CSKH_HANDOFF');
  assert.equal(cancel.order, undefined);
  const update = renderChatbotReply({ template_id: 'ORDER_UPDATE', Product_N1: 'Granola Túi Vàng 350g', No_A: '2' }, templates, { recentOrder: posOrder, now: Date.now(), messageText: 'đổi sang 2 túi vàng' });
  assert.equal(update.order?.updateOrderId, undefined);
});

test('luồng dùng thử đặt context.trial: đơn 1 túi không cộng ship; không có ưu đãi thì cộng ship', () => {
  const value = { template_id: 'ORDER_CONFIRMATION', Product_N1: 'Granola Túi Xanh 450g', No_A: '1', Phone_Number: '0909123456', Customer_Address: '12 Lê Lợi, Phường Bến Nghé, Quận 1, TP.HCM' };
  const now = Date.now();
  const plain = renderChatbotReply(value, templates, { now });
  assert.ok(plain.order.shippingFee > 0);
  const promo = renderChatbotReply(value, templates, { now, trial: { freeShipping: true, until: now + 60000, stage: 'offered' } });
  assert.equal(promo.order.shippingFee, 0);
  assert.equal(promo.order.total, plain.order.total - plain.order.shippingFee);
  assert.match(promo.messages[0], /Miễn phí vận chuyển – ưu đãi dùng thử/);
  assert.doesNotMatch(promo.messages[0], /Phí vận chuyển:/);
  const expired = renderChatbotReply(value, templates, { now, trial: null });
  assert.equal(expired.order.shippingFee, plain.order.shippingFee);
});
