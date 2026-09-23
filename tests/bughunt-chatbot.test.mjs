import assert from 'node:assert/strict';
import test from 'node:test';
import './helpers/seed-catalog.mjs';
import { parseModelAnswer, processChatbotChanges } from '../app/chatbot-engine.mjs';
import { defaultMessageTemplates, renderChatbotReply } from '../app/chatbot-templates.mjs';

const templates = Object.fromEntries(Object.entries(defaultMessageTemplates()).map(([id, text]) => [id, text.trim()]));
const fullAddress = '176/1A KP1, An Phú Đông, Quận 12, TP.HCM';
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

test('mô hình trả JSON không phải object (null, mảng): không văng lỗi, gửi bảng giá chung', () => {
  assert.equal(parseModelAnswer('null').template_id, 'GENERAL_INFO');
  assert.equal(parseModelAnswer('[{"template_id":"WELCOME"}]').template_id, 'GENERAL_INFO');
  assert.equal(parseModelAnswer('"WELCOME"').template_id, 'GENERAL_INFO');
  assert.equal(renderChatbotReply(parseModelAnswer('null'), templates).templateId, 'GENERAL_INFO');
});

test('gợi ý 2 túi: miễn ship không bị lặp thành quà tặng ("miễn phí vận chuyển, tặng Miễn phí vận chuyển")', () => {
  const reply = renderChatbotReply({ template_id: 'ORDER_CONFIRMATION', Product_N1: 'Túi Xanh', No_A: '1' }, templates, { customer: { gender: 'female' } });
  assert.equal(reply.templateId, 'ORDER_ADDRESS');
  assert.match(reply.messages[1], /miễn phí vận chuyển/);
  assert.doesNotMatch(reply.messages[1], /tặng Miễn phí vận chuyển/);
  assert.equal((reply.messages[1].match(/miễn phí vận chuyển/gi) || []).length, 1);
});

test('gợi ý 2 túi chỉ một lần cho mỗi giỏ, kể cả khi bot phải hỏi thông tin tới lần thứ ba', () => {
  const first = renderChatbotReply({ template_id: 'ORDER_CONFIRMATION', Product_N1: 'Túi Xanh', No_A: '1' }, templates, { customer: { gender: 'female' } });
  assert.equal(first.pendingOrder.upsold, true);
  const second = renderChatbotReply({ template_id: 'ORDER_ADDRESS', Phone_Number: '0909123456' }, templates, { customer: { gender: 'female' }, pendingOrder: first.pendingOrder });
  assert.equal(second.messages.length, 1);
  assert.equal(second.pendingOrder.upsold, true, 'cờ đã gợi ý phải đi theo giỏ');
  const third = renderChatbotReply({ template_id: 'ORDER_ADDRESS', Customer_Address: 'Quận 12' }, templates, { customer: { gender: 'female' }, pendingOrder: second.pendingOrder });
  assert.equal(third.messages.length, 1, 'không gợi ý lại lần ba');
});

test('đã hỏi một lần, khách trả lời địa chỉ có "xã" (chữ có dấu ở cuối từ): vẫn được nhận như "huyện"/"phường"', () => {
  const pending = { items: [{ product: 'Túi Xanh', quantity: 2 }], key: 'GRA-XANH-Z450=2', at: Date.now(), phone: '0909123456', address: 'Long An', addressAsks: 1 };
  const reply = renderChatbotReply({ template_id: 'ORDER_ADDRESS', Customer_Address: 'ấp 3, xã Abcxyz, Long An' }, templates, { pendingOrder: pending });
  assert.equal(reply.templateId, 'ORDER_CONFIRMATION');
  assert.match(reply.order.address, /xã Abcxyz/);
});

test('đang xin SĐT/địa chỉ mà khách đổi sang số lượng không tính được giá: hỏi vị/số lượng, không chốt giỏ cũ', () => {
  const pending = { items: [{ product: 'Granola Túi Xanh 450g', code: 'GRA-XANH-Z450', quantity: 1 }], key: 'GRA-XANH-Z450=1', at: Date.now(), phone: '', address: '', addressAsks: 0 };
  const reply = renderChatbotReply({ template_id: 'ORDER_ADDRESS', Product_N1: 'Túi Xanh', No_A: '5', Phone_Number: '0909123456' }, templates, { pendingOrder: pending });
  assert.equal(reply.templateId, 'ASK_FLAVOR');
  assert.equal(reply.order, undefined);
  assert.equal(reply.pendingOrder.phone, '0909123456', 'SĐT vừa gửi vẫn được giữ');
  // Khách trả lời xong số lượng hợp lệ thì tiếp tục xin địa chỉ với giỏ mới.
  const next = renderChatbotReply({ template_id: 'ORDER_ADDRESS', Product_N1: 'Túi Xanh', No_A: '3' }, templates, { pendingOrder: reply.pendingOrder });
  assert.equal(next.templateId, 'ORDER_ADDRESS');
  assert.deepEqual(next.pendingOrder.items.map(item => item.quantity), [3]);
});

test('bot vừa hỏi số túi/SĐT: khách trả lời "1" không bị hiểu là xin bảng giá', async () => {
  const log = [];
  const result = await processChatbotChanges([{
    type: 'message',
    conversation: {
      id: 'page:one', psid: 'one', name: 'Khách', botEnabled: true, botLastTemplateId: 'ORDER_ADDRESS',
      pendingOrder: { items: [{ product: 'Granola Túi Xanh 450g', code: 'GRA-XANH-Z450', quantity: 1 }], key: 'GRA-XANH-Z450=1', at: Date.now(), phone: '', address: '' },
      post: { message: 'GRANOLA TÚI XANH 450g giòn rụm' }
    },
    message: { id: 'mid.one.1', mid: 'mid.one.1', direction: 'incoming', type: 'text', text: '1' }
  }], {
    readSettings: async () => ({ enabled: true, responseMode: 'automatic', handoffKeywords: '', fragmentWaitMs: 0, messageTemplates: templates }),
    listMessages: async () => [],
    sendMessage: async (_conversation, message) => { log.push(message.text || '[ảnh]'); return { message: { mid: 'mid.bot' } }; },
    saveBotState: async () => {},
    requestReply: async () => ({ templateId: 'ORDER_ADDRESS', messages: ['Dạ cho em xin địa chỉ ạ'], handoff: false })
  });
  assert.equal(result[0].templateId, 'ORDER_ADDRESS');
  assert.deepEqual(log, ['Dạ cho em xin địa chỉ ạ']);
});

test('tin riêng đã gửi trong 24 giờ chỉ khác khoảng trắng: vẫn tính là đã gửi, không nhắn riêng lại', async () => {
  const log = [];
  const privateText = 'Dạ em thấy anh/chị để lại bình luận ạ\n\nDạ nhà em có 3 vị ạ';
  const inboxMessages = [{ id: 'p1', direction: 'outgoing', type: 'text', text: privateText.replace('\n\n', ' \n\n '), createdAt: Date.now() - 60000 }];
  const result = await processChatbotChanges([{
    type: 'message',
    conversation: { id: 'page:comment:c2:p1', pageId: 'page', psid: 'user', source: 'comment', name: 'Tiên', botEnabled: true },
    message: { id: 'c2', mid: 'c2', direction: 'incoming', type: 'text', text: 'combo đó mấy gói em', createdAt: Date.now() }
  }], {
    readSettings: async () => ({ enabled: true, responseMode: 'automatic', handoffKeywords: '', messageTemplates: { ...templates, COMMENT_PRIVATE_REPLY: 'Dạ em thấy {title} để lại bình luận ạ', COMMENT_PUBLIC_REPLY: 'Dạ em vừa ib cho mình rồi ạ', COMMENT_PUBLIC_REPEAT: 'Dạ em đã gửi trong tin nhắn rồi ạ' } }),
    listMessages: async id => (id === 'page:user' ? inboxMessages : []),
    getConversation: async id => (id === 'page:user' ? { id: 'page:user', pageId: 'page', psid: 'user', botEnabled: true } : null),
    saveBotState: async () => {},
    sendMessage: async (_conversation, message) => { log.push(`${message.privateReply ? 'riêng' : 'công khai'}:${message.text}`); return { message: { mid: 'm' } }; },
    requestReply: async () => ({ templateId: 'GENERAL_INFO', messages: ['Dạ nhà em có 3 vị ạ'], handoff: false })
  });
  assert.equal(result[0].privateSkipped, true);
  assert.deepEqual(log, ['công khai:Dạ em đã gửi trong tin nhắn rồi ạ']);
});

test('hẹn chạy lại sau khi hết hạn mức: lúc chạy lại bot đã bị tắt trong Cài đặt thì không trả lời', async () => {
  const log = [];
  let enabled = true;
  let failures = 1;
  const result = await processChatbotChanges([{
    type: 'message',
    conversation: { id: 'page:off', psid: 'off', name: 'Khách', botEnabled: true },
    message: { id: 'mid.off.1', mid: 'mid.off.1', direction: 'incoming', type: 'text', text: 'giá sao', createdAt: 1000 }
  }], {
    readSettings: async () => ({ enabled, responseMode: 'automatic', handoffKeywords: '', capacityRetryDelayMs: 30 }),
    listMessages: async () => [],
    sendMessage: async (_conversation, message) => { log.push(`send:${message.text}`); return { message: { mid: 'mid.bot' } }; },
    saveBotState: async () => {},
    requestReply: async () => {
      if (failures-- > 0) throw Object.assign(new Error('Resource exhausted'), { status: 429 });
      return { templateId: 'WELCOME', messages: ['Dạ em đây ạ'], handoff: false };
    }
  });
  assert.equal(result[0].retryLater, true);
  enabled = false;
  await wait(120);
  assert.deepEqual(log, [], 'bot đã tắt thì lần chạy lại không gửi gì');
});

// ===== Cải tiến sau đánh giá hội thoại 23/09 =====
import { cartQuickReply, processChatbotChanges as runChanges } from '../app/chatbot-engine.mjs';
import { resolveConversationProduct } from '../app/processing/product-detect.mjs';
import { splitLongText } from '../app/pancake.mjs';

test('giỏ Facebook Shop: 1 SKU → bảng giá; SKU combo CB2-XANH / CB-VANGG+NAU → xin SĐT/địa chỉ với đúng giỏ; SKU lạ → để model', () => {
  const t = templates;
  // Bấm "Mua" 1 sản phẩm: đi thẳng bước xin SĐT/địa chỉ, giỏ 1 túi được giữ (kèm gợi ý 2 túi).
  const one = cartQuickReply([{ sku: 'GRA-VANG-H350', quantity: 0 }], t, {});
  assert.equal(one.templateId, 'ORDER_ADDRESS');
  assert.deepEqual(one.pendingOrder.items.map(i => `${i.product} x${i.quantity}`), ['Granola Túi Vàng 350g x1']);
  const two = cartQuickReply([{ sku: 'CB2-XANH-Z450', quantity: 0 }], t, {});
  assert.equal(two.templateId, 'ORDER_ADDRESS');
  assert.deepEqual(two.pendingOrder.items.map(i => `${i.product} x${i.quantity}`), ['Granola Túi Xanh 450g x2']);
  const mix = cartQuickReply([{ sku: 'CB-VANGG+NAU', quantity: 0 }], t, {});
  assert.deepEqual(mix.pendingOrder.items.map(i => `${i.product} x${i.quantity}`).sort(), ['Granola Túi Nâu vị cacao 350g x1', 'Granola Túi Vàng 350g x1']);
  assert.equal(cartQuickReply([{ sku: 'XYZ-123', quantity: 1 }], t, {}), null);
});

test('tên quảng cáo nội bộ "qc mess 2504 · mess Xanh" / "xanh mes" nhận ra Túi Xanh', () => {
  assert.equal(resolveConversationProduct({ adTitle: 'qc mess 2504 · mess Xanh' }).product, 'Granola Túi Xanh 450g');
  assert.equal(resolveConversationProduct({ adTitle: 'Quảng cáo 5,6,11/12 · xanh mes' }).product, 'Granola Túi Xanh 450g');
  assert.equal(resolveConversationProduct({ adTitle: 'Săn deal hời' }).product, 'Không xác định');
});

test('chữ dài hơn 1900 ký tự cắt theo đoạn, mỗi tin không quá giới hạn', () => {
  const paragraph = 'Dạ em gửi bảng giá chi tiết cho mình ạ. '.repeat(30).trim();
  const text = [paragraph, paragraph, paragraph].join('\n\n');
  const chunks = splitLongText(text, 1900);
  assert.ok(chunks.length >= 2);
  assert.ok(chunks.every(chunk => chunk.length <= 1900 && chunk.trim()));
  assert.equal(chunks.join(' ').replace(/\s+/g, ' '), text.replace(/\s+/g, ' '));
  assert.deepEqual(splitLongText('ngắn'), ['ngắn']);
});

test('bình luận "1 xanh 1 vàng": giỏ đi theo khách sang hộp thư; model lỗi hạn mức dưới bình luận thì trả lời theo luật; công khai không lặp trong 10 phút', async () => {
  const saved = {};
  const log = [];
  const post = { id: 'p1', message: 'Granola túi xanh giảm giá' };
  const deps = (requestReply, recent = []) => ({
    readSettings: async () => ({ enabled: true, responseMode: 'automatic', handoffKeywords: '', fragmentWaitMs: 5, messageTemplates: { ...templates, COMMENT_PRIVATE_REPLY: 'Dạ em thấy {title} để lại bình luận ạ', COMMENT_PUBLIC_REPLY: 'Dạ em vừa ib ạ', COMMENT_PUBLIC_REPEAT: 'Dạ em đã gửi rồi ạ' } }),
    listMessages: async id => (id === 'page:comment:c1:p1' ? recent : []),
    getConversation: async id => (id === 'page:user' ? { id: 'page:user', pageId: 'page', psid: 'user', botEnabled: true } : null),
    saveBotState: async (id, state) => { saved[id] = { ...(saved[id] || {}), ...state }; },
    sendMessage: async (_c, message) => { log.push(`${message.privateReply ? 'riêng' : 'công khai'}:${String(message.text).slice(0, 40)}`); return { message: { mid: 'm' } }; },
    requestReply
  });
  const comment = (id, text, createdAt) => ({ type: 'message', conversation: { id: 'page:comment:c1:p1', pageId: 'page', psid: 'user', source: 'comment', name: 'Khách', botEnabled: true, post }, message: { id, mid: id, direction: 'incoming', type: 'text', text, createdAt } });
  // 1. Giỏ từ bình luận được lưu sang hộp thư page:user.
  await runChanges([comment('c1', '1 xanh 1 vàng', Date.now())], deps(async () => renderChatbotReply({ template_id: 'ORDER_ADDRESS', Product_N1: 'Granola Túi Xanh 450g', No_A: '1', Product_N2: 'Granola Túi Vàng 350g', No_B: '1' }, templates, {})));
  assert.ok(log[0].startsWith('riêng:'));
  assert.deepEqual(saved['page:user']?.pendingOrder?.items?.map(i => `${i.product} x${i.quantity}`), ['Granola Túi Xanh 450g x1', 'Granola Túi Vàng 350g x1']);
  // 2. Model hết hạn mức dưới bình luận: bảng giá sản phẩm của bài, không rơi.
  log.length = 0;
  await runChanges([comment('c2', 'giá sao', Date.now())], deps(async () => { throw Object.assign(new Error('Resource exhausted'), { status: 429 }); }));
  assert.equal(log.length, 2, JSON.stringify(log));
  assert.ok(log[0].startsWith('riêng:') && log[1].startsWith('công khai:'), 'tin riêng theo luật vẫn đi, rồi công khai');
  // 3. Tin riêng trùng + đã trả lời công khai 1 phút trước: im, không đăng thêm.
  log.length = 0;
  const recent = [{ id: 'c2', direction: 'incoming', type: 'text', text: 'giá sao', createdAt: Date.now() - 60000 }, { id: 'pub', direction: 'outgoing', type: 'text', text: 'Dạ em vừa ib ạ', createdAt: Date.now() - 50000 }];
  const inboxMessages = [{ id: 'priv', direction: 'outgoing', type: 'text', text: 'Dạ em thấy anh/chị để lại bình luận ạ\n\nBảng giá ạ', createdAt: Date.now() - 50000 }];
  const d = deps(async () => ({ templateId: 'PRICE_QUOTE', messages: ['Bảng giá ạ'], handoff: false }), recent);
  d.listMessages = async id => (id === 'page:user' ? inboxMessages : recent);
  await runChanges([comment('c3', 'giá bn', Date.now())], d);
  assert.deepEqual(log, []);
});

test('khách quen "gửi về địa chỉ cũ": SĐT và địa chỉ lấy từ đơn gần nhất, chốt luôn', () => {
  const reply = renderChatbotReply({ template_id: 'ORDER_ADDRESS', Product_N1: 'Granola Túi Vàng 350g', No_A: '1' }, templates, {
    messageText: 'Gửi mình 1 túi vàng địa chỉ cũ nhé shop', now: Date.now(),
    recentOrder: { phone: '0909123456', address: '12 Lê Lợi, Phường Bến Nghé, Quận 1, Hồ Chí Minh', createdAt: Date.now() - 86400000 }
  });
  assert.equal(reply.templateId, 'ORDER_CONFIRMATION');
  assert.match(reply.messages.join(' '), /0909123456/);
});

test('khách sửa đơn vừa chốt (ORDER_UPDATE): giỏ mới thay giỏ cũ, SĐT/địa chỉ lấy từ đơn cũ, không tạo đơn mới, không gửi lại phiếu; đoạn chính sách y hệt trong 24h không gửi lại', async () => {
  const recentOrder = { id: 'e0c3eba0', automatic: true, createdAt: Date.now() - 10 * 60 * 1000, phone: '0978480043', address: '13 ngách 3/114 Trần Hưng Đạo, Phường Quỳnh Lâm, Thành phố Hòa Bình, Hòa Bình', products: [{ sku: 'GRA-XANH-Z450', quantity: 3 }] };
  const rendered = renderChatbotReply({ template_id: 'ORDER_UPDATE', Product_N1: 'Granola Túi Xanh 450g', No_A: '1', Product_N2: 'Granola Túi Vàng 350g', No_B: '1', Product_N3: 'Granola Túi Nâu vị cacao 350g', No_C: '1' }, templates, { recentOrder, now: Date.now(), messageText: 'Mình lấy 3 gói nhưng khác vị' });
  assert.equal(rendered.templateId, 'ORDER_UPDATE');
  assert.equal(rendered.order.updateOrderId, 'e0c3eba0');
  assert.deepEqual(rendered.order.items.map(i => `${i.product} x${i.quantity}`), ['Granola Túi Xanh 450g x1', 'Granola Túi Vàng 350g x1', 'Granola Túi Nâu vị cacao 350g x1']);
  assert.equal(rendered.order.phone, '0978480043');
  assert.equal(rendered.messages.length, 1, 'chỉ một tin sửa đơn, không kèm chính sách giao/đổi trả');
  assert.match(rendered.messages[0], /đã sửa lại đơn/);
  // Đơn cũ quá 60 phút hay "ko phải" không nêu giỏ → ORDER_WRONG (hỏi lại), không bịa giỏ.
  const wrong = renderChatbotReply({ template_id: 'ORDER_UPDATE', Product_N1: '0' }, templates, { recentOrder, now: Date.now(), messageText: 'Ko phải' });
  assert.equal(wrong.templateId, 'ORDER_WRONG');
  assert.equal(wrong.order, undefined);
  // Engine: gọi updateOrder, không createOrder, không sendReceipt; đoạn chính sách đã gửi hôm nay bị bỏ.
  const log = [];
  const policy = 'Dạ thời gian giao dự kiến: TP.HCM và tỉnh lân cận 1–3 ngày ạ.';
  await processChatbotChanges([{
    type: 'message',
    conversation: { id: 'page:user', pageId: 'page', psid: 'user', name: 'Khách', botEnabled: true, customerOrders: [recentOrder] },
    message: { id: 'm9', mid: 'm9', direction: 'incoming', type: 'text', text: 'Mình lấy 3 gói nhưng khác vị', createdAt: Date.now() }
  }], {
    readSettings: async () => ({ enabled: true, responseMode: 'automatic', handoffKeywords: '', fragmentWaitMs: 5 }),
    listMessages: async () => [{ id: 'old', direction: 'outgoing', type: 'text', text: policy, createdAt: Date.now() - 5 * 60 * 1000 }],
    saveBotState: async () => {},
    sendMessage: async (_c, message) => { log.push(`text:${String(message.text).slice(0, 30)}`); return { message: { mid: 'x' } }; },
    sendReceipt: async () => { log.push('receipt'); },
    createOrder: async () => { log.push('create'); return { order: { id: 'new' }, created: true }; },
    updateOrder: async (_c, id, order) => { log.push(`update:${id}:${order.items.length}`); return { order: { ...recentOrder, ...order }, updated: true, created: false }; },
    requestReply: async () => ({ templateId: 'ORDER_UPDATE', messages: ['Dạ em đã sửa lại đơn ạ', policy], handoff: false, order: { ...rendered.order } })
  });
  assert.deepEqual(log, ['update:e0c3eba0:3', 'text:Dạ em đã sửa lại đơn ạ']);
});

test('khách hủy đơn vừa đặt (ORDER_CANCEL): hủy đúng đơn đó qua cancelOrder, không tạo đơn, không phiếu; đơn quá 24h → chuyển nhân viên', async () => {
  const recentOrder = { id: 'abc12345', automatic: true, createdAt: Date.now() - 30 * 60 * 1000, phone: '0909123456', address: 'Q1', products: [{ name: 'Granola Túi Xanh 450g', sku: 'GRA-XANH-Z450', quantity: 2 }] };
  const rendered = renderChatbotReply({ template_id: 'ORDER_CANCEL' }, templates, { recentOrder, now: Date.now() });
  assert.equal(rendered.templateId, 'ORDER_CANCEL');
  assert.equal(rendered.order.cancelOrderId, 'abc12345');
  assert.match(rendered.messages[0], /đã hủy đơn Granola Túi Xanh 450g x2/);
  const old = renderChatbotReply({ template_id: 'ORDER_CANCEL' }, templates, { recentOrder: { ...recentOrder, createdAt: Date.now() - 2 * 24 * 60 * 60 * 1000 }, now: Date.now() });
  assert.equal(old.templateId, 'CSKH_HANDOFF');
  const log = [];
  await processChatbotChanges([{
    type: 'message',
    conversation: { id: 'page:user', pageId: 'page', psid: 'user', name: 'Khách', botEnabled: true, customerOrders: [recentOrder] },
    message: { id: 'm1', mid: 'm1', direction: 'incoming', type: 'text', text: 'Cho mình hủy đơn nhé', createdAt: Date.now() }
  }], {
    readSettings: async () => ({ enabled: true, responseMode: 'automatic', handoffKeywords: '', fragmentWaitMs: 5 }),
    listMessages: async () => [],
    saveBotState: async (_id, state) => { if (state.labels) log.push(`labels:${state.labels.join(',')}`); },
    sendMessage: async (_c, message) => { log.push(`text:${String(message.text).slice(0, 20)}`); return { message: { mid: 'x' } }; },
    sendReceipt: async () => { log.push('receipt'); },
    createOrder: async () => { log.push('create'); return { order: { id: 'new' }, created: true }; },
    cancelOrder: async (_c, id) => { log.push(`cancel:${id}`); return { order: { ...recentOrder, processingStatus: 'cancelled' }, cancelled: true, created: false }; },
    requestReply: async () => rendered
  });
  assert.deepEqual(log.filter(item => !item.startsWith('labels:')), ['cancel:abc12345', 'text:Dạ em đã hủy đơn Gra']);
});

test('lời gợi ý lấy 2 túi nằm trong parts (engine gửi theo parts) chứ không chỉ trong messages', () => {
  const reply = renderChatbotReply({ template_id: 'ORDER_ADDRESS', Product_N1: 'Túi Xanh', No_A: '1' }, templates, {});
  assert.equal(reply.pendingOrder.upsold, true);
  const texts = reply.parts.filter(part => part.type === 'text').map(part => part.text);
  assert.ok(texts.some(text => /2 túi/.test(text)), JSON.stringify(texts));
  assert.equal(texts.length, reply.messages.length);
});

test('vòng 2: #10900 không đăng "ib cho Page"; bình luận hủy/khiếu nại → nhắn nhân viên kiểm tra; hộp thư biết mẫu vừa gửi riêng; hỏi tiếp mà sắp lặp bảng giá → nhắc ngắn', async () => {
  const tpl = { ...templates, COMMENT_PRIVATE_REPLY: 'Dạ em thấy {title} để lại bình luận dưới bài viết của Giọt Nắng ạ 💛', COMMENT_PUBLIC_REPLY: 'Dạ em vừa ib ạ', COMMENT_PUBLIC_REPEAT: 'Dạ em đã gửi trong tin nhắn rồi ạ', COMMENT_PUBLIC_FALLBACK: 'Dạ mình ib cho Page giúp em ạ' };
  const comment = (id, text) => ({ type: 'message', conversation: { id: 'page:comment:c1:p1', pageId: 'page', psid: 'user', source: 'comment', name: 'Khách', botEnabled: true, post: { message: 'Granola túi xanh' } }, message: { id, mid: id, direction: 'incoming', type: 'text', text, createdAt: Date.now() } });
  const saved = {};
  const base = (sendMessage, requestReply, inbox = { id: 'page:user', pageId: 'page', psid: 'user', botEnabled: true }) => ({
    readSettings: async () => ({ enabled: true, responseMode: 'automatic', handoffKeywords: '', fragmentWaitMs: 1, messageTemplates: tpl }),
    listMessages: async () => [],
    getConversation: async id => (id === 'page:user' ? inbox : null),
    saveBotState: async (id, state) => { saved[id] = { ...(saved[id] || {}), ...state }; },
    sendMessage, requestReply
  });
  // 1. #10900: không có câu "ib cho Page".
  const log1 = [];
  await processChatbotChanges([comment('c1', 'giá sao')], base(async (_c, m) => { if (m.privateReply) throw new Error('Pancake không nhận tin (200): (#10900) Activity already replied to'); log1.push(m.text); return { message: { mid: 'x' } }; }, async () => ({ templateId: 'PRICE_QUOTE', messages: ['Bảng giá ạ'], handoff: false })));
  assert.deepEqual(log1, ['Dạ em đã gửi trong tin nhắn rồi ạ']);
  // 2. Bình luận "hủy đơn" → tin riêng nhân viên kiểm tra, không chào hàng.
  const log2 = [];
  await processChatbotChanges([comment('c2', 'C hủy đơn 2 gói nhá')], base(async (_c, m) => { log2.push(`${m.privateReply ? 'riêng' : 'cc'}:${m.text}`); return { message: { mid: 'x' } }; }, async () => ({ templateId: 'CSKH_HANDOFF', messages: ['x'], handoff: true })));
  assert.match(log2[0], /^riêng:.*chuyển bạn phụ trách đơn hàng kiểm tra/s);
  // 3. Sau tin riêng thành công, hộp thư ghi mẫu vừa gửi.
  await processChatbotChanges([comment('c3', 'giá bn')], base(async () => ({ message: { mid: 'x' } }), async () => ({ templateId: 'PRICE_QUOTE', messages: ['Bảng giá ạ'], handoff: false })));
  assert.equal(saved['page:user'].botLastTemplateId, 'PRICE_QUOTE');
  // 4. Hộp thư: khách hỏi câu mới mà model sắp gửi lại đúng bảng giá vừa gửi riêng → nhắc ngắn thay vì im lặng.
  const price = 'Dạ, em gửi anh/chị Bảng giá Granola Túi Xanh 450g để mình dễ tham khảo ạ: 1 túi 174.000đ';
  const log4 = [];
  await processChatbotChanges([{ type: 'message', conversation: { id: 'page:user', pageId: 'page', psid: 'user', name: 'Khách', botEnabled: true }, message: { id: 'm9', mid: 'm9', direction: 'incoming', type: 'text', text: '150 mà e', createdAt: Date.now() } }], {
    readSettings: async () => ({ enabled: true, responseMode: 'automatic', handoffKeywords: '', fragmentWaitMs: 1, messageTemplates: tpl }),
    listMessages: async () => [{ id: 'p', direction: 'outgoing', type: 'text', text: `Dạ em thấy anh/chị để lại bình luận dưới bài viết của Giọt Nắng ạ 💛\n\n${price}`, createdAt: Date.now() - 60000 }],
    saveBotState: async () => {},
    sendMessage: async (_c, m) => { log4.push(m.text); return { message: { mid: 'x' } }; },
    requestReply: async () => ({ templateId: 'PRICE_QUOTE', messages: [price], handoff: false })
  });
  assert.equal(log4.length, 1);
  assert.match(log4[0], /thông tin em gửi ngay tin phía trên/);
});

test('hỏi giảm giá chưa nêu loại: chỉ 3 túi chủ lực, mỗi túi một dòng; không liệt kê Tropical, Combo 10 gói…', () => {
  const reply = renderChatbotReply({ template_id: 'DISCOUNT_POLICY' }, templates, {});
  const text = reply.messages.join('\n');
  assert.equal((text.match(/🔥/g) || []).length, 3);
  assert.match(text, /Túi Xanh 450g: 2 túi 298\.000đ · 3 túi 447\.000đ/);
  assert.doesNotMatch(text, /Tropical|Combo 10 gói|Nghệ Lành|An Lành/);
});
