import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync, writeFileSync } from 'node:fs';
import './helpers/seed-catalog.mjs';
import { hasNewerCustomerMessage, processChatbotChanges, unansweredCustomerMessages } from '../app/chatbot-engine.mjs';
import { defaultMessageTemplates, renderChatbotReply } from '../app/chatbot-templates.mjs';
import { reloadCatalog } from '../app/processing/catalog.mjs';

const templates = Object.fromEntries(Object.entries(defaultMessageTemplates()).map(([id, text]) => [id, text.trim()]));
const settings = { enabled: true, responseMode: 'automatic', provider: 'vertex', directApiKey: 'secret', handoffKeywords: '', complaintKeywords: '', messageTemplates: templates };
const conversation = { id: 'page:user', pageId: 'page', psid: 'user', name: 'Khách', botEnabled: true };
const incoming = (id, text, createdAt) => ({ id, mid: id, direction: 'incoming', type: 'text', text, createdAt });
const change = message => ({ type: 'message', conversation, message });

test('tin khách chưa được trả lời gộp lại; tin mới hơn tin đang xử lý thì tin này nhường', () => {
  const a = incoming('a', 'C đặt 2 gói', 1000);
  const b = incoming('b', 'Giảm ko e', 3000);
  const reply = { id: 'r', direction: 'outgoing', type: 'text', text: 'Dạ', createdAt: 500 };
  assert.deepEqual(unansweredCustomerMessages([reply, a, b], b).map(item => item.id), ['a', 'b']);
  assert.deepEqual(unansweredCustomerMessages([a, reply, b], b).map(item => item.id), ['b'], 'tin trước câu trả lời gần nhất không gộp');
  assert.deepEqual(unansweredCustomerMessages([], b).map(item => item.id), ['b'], 'kho chưa có tin thì vẫn có tin đang xử lý');
  const old = incoming('o', 'hôm qua', 3000 - 11 * 60 * 1000);
  assert.deepEqual(unansweredCustomerMessages([old, a, b], b).map(item => item.id), ['a', 'b'], 'tin quá 10 phút không gộp');
  assert.equal(hasNewerCustomerMessage([a, b], a), true);
  assert.equal(hasNewerCustomerMessage([a, b], b), false);
  assert.equal(hasNewerCustomerMessage([a, b, reply], b), false, 'câu trả lời của Page không tính là tin khách');
});

test('hai tin liền nhau của khách: bot trả lời một lần cho cả hai, mô hình đọc cả hai câu', async () => {
  const a = incoming('a', 'C đặt 2 gói', 1000);
  const b = incoming('b', 'Giảm ko e', 3000);
  const asked = [];
  const sent = [];
  const results = await processChatbotChanges([change(a), change(b)], {
    readSettings: async () => settings,
    listMessages: async () => [a, b],
    sendMessage: async (_conversation, message) => sent.push(message.text),
    saveBotState: async () => {},
    requestReply: async ({ message, recentMessages }) => {
      asked.push({ text: message.text, history: recentMessages.map(item => item.id) });
      return { templateId: 'GENERAL_INFO', messages: ['Dạ nhà em có 3 vị ạ'], conversationId: '', handoff: false };
    }
  });
  assert.deepEqual(results.map(item => item.skipped || item.templateId), ['gộp với tin sau', 'GENERAL_INFO']);
  assert.equal(results[1].bundled, 2);
  assert.deepEqual(asked, [{ text: 'C đặt 2 gói\nGiảm ko e', history: [] }], 'hai tin gộp thành một câu hỏi, không lặp lại trong lịch sử');
  assert.deepEqual(sent, ['Dạ nhà em có 3 vị ạ']);
});

test('khách nhắn thêm trong lúc mô hình đang trả lời: câu trả lời đó bị bỏ, không gửi', async () => {
  const a = incoming('a', 'C đặt 2 gói', 1000);
  const b = incoming('b', 'Giảm ko e', 3000);
  let reads = 0;
  const sent = [];
  const results = await processChatbotChanges([change(a)], {
    readSettings: async () => settings,
    // Lần đọc đầu chỉ có tin A; sau khi mô hình trả lời, tin B đã vào kho.
    listMessages: async () => (reads++ === 0 ? [a] : [a, b]),
    sendMessage: async (_conversation, message) => sent.push(message.text),
    saveBotState: async () => {},
    requestReply: async () => ({ templateId: 'GENERAL_INFO', messages: ['Dạ nhà em có 3 vị ạ'], conversationId: '', handoff: false })
  });
  assert.deepEqual(results, [{ conversationId: 'page:user', skipped: 'gộp với tin sau' }]);
  assert.deepEqual(sent, []);
});

test('bot đọc lại hội thoại trước khi trả lời: nhân viên vừa tắt bot thì tin đang chờ không được trả lời', async () => {
  const sent = [];
  const results = await processChatbotChanges([change(incoming('a', 'xin chào', 1000))], {
    readSettings: async () => settings,
    getConversation: async () => ({ ...conversation, botEnabled: false }),
    listMessages: async () => [],
    sendMessage: async (_conversation, message) => sent.push(message.text),
    saveBotState: async () => {},
    requestReply: async () => ({ templateId: 'WELCOME', messages: ['Xin chào'], conversationId: '', handoff: false })
  });
  assert.deepEqual([results, sent], [[], []]);
});

test('muốn mua nhưng chưa nêu sản phẩm: bot giới thiệu sản phẩm, không xin số điện thoại và địa chỉ', () => {
  const reply = renderChatbotReply({ template_id: 'ORDER_ADDRESS', Product_N1: '0', No_A: '2', Phone_Number: '0', Customer_Address: '0' }, templates, {});
  assert.equal(reply.templateId, 'ASK_PRODUCT');
  assert.match(reply.messages[0], /sản phẩm/);
  assert.doesNotMatch(reply.messages.join(' '), /số điện thoại/);
  assert.equal(reply.pendingOrder, null);
  // SĐT khách lỡ đưa kèm được giữ lại cho lần chốt sau.
  const withPhone = renderChatbotReply({ template_id: 'ORDER_ADDRESS', Product_N1: '0', Phone_Number: '0909123456', Customer_Address: '0' }, templates, {});
  assert.equal(withPhone.templateId, 'ASK_PRODUCT');
  assert.equal(withPhone.pendingOrder.phone, '0909123456');
});

test('lời xin địa chỉ là một câu liền, không còn mảnh câu đứng riêng', () => {
  const reply = renderChatbotReply({ template_id: 'ORDER_ADDRESS', Product_N1: 'Granola Túi Xanh 450g', No_A: '2', Phone_Number: '0', Customer_Address: '0' }, templates, {});
  assert.equal(reply.templateId, 'ORDER_ADDRESS');
  assert.equal(reply.messages.length, 1);
  assert.match(reply.messages[0], /^Dạ để lên đơn đúng tuyến cho đơn vị vận chuyển, anh\/chị cho em xin số điện thoại và địa chỉ nhận hàng đầy đủ/);
});

test('DISCOUNT_POLICY: giá lẻ không bớt, ưu đãi là combo đọc từ danh mục', () => {
  const reply = renderChatbotReply({ template_id: 'DISCOUNT_POLICY', Product_N1: 'Granola Túi Xanh 450g' }, templates, {});
  assert.equal(reply.templateId, 'DISCOUNT_POLICY');
  assert.match(reply.messages[0], /giá lẻ bên em đang là giá tốt nhất/);
  assert.match(reply.messages[0], /2 Túi Granola Túi Xanh 450g: 298\.000đ/);
  assert.match(reply.messages[0], /giá gốc/);
  const all = renderChatbotReply({ template_id: 'DISCOUNT_POLICY' }, templates, {});
  assert.match(all.messages[0], /Granola Túi Xanh 450g[\s\S]*Granola Túi Vàng 350g/, 'chưa nêu loại thì liệt kê combo của mọi sản phẩm có giá combo');
});

test('PRODUCT_PHOTOS: gửi ảnh sản phẩm khách nêu; chưa sản phẩm nào có ảnh thì chuyển người thật', () => {
  const productsPath = process.env.PRODUCTS_PATH;
  const original = readFileSync(productsPath, 'utf8');
  try {
    const none = renderChatbotReply({ template_id: 'PRODUCT_PHOTOS', Product_N1: 'Granola Túi Xanh 450g' }, templates, {});
    assert.deepEqual([none.templateId, none.handoff], ['CSKH_HANDOFF', true]);
    const store = JSON.parse(original);
    store.items.find(item => item.id === 'seed-granola-xanh').image = '/product-images/xanh.png';
    writeFileSync(productsPath, JSON.stringify(store));
    reloadCatalog();
    const one = renderChatbotReply({ template_id: 'PRODUCT_PHOTOS', Product_N1: 'túi xanh' }, templates, {});
    assert.equal(one.templateId, 'PRODUCT_PHOTOS');
    assert.match(one.messages[0], /hình ảnh Granola Túi Xanh 450g nhà Giọt Nắng/);
    assert.equal(one.images.length, 1);
    assert.match(one.images[0], /\/product-images\/xanh\.png\?v=\d+$/);
    assert.equal(one.messages.length, 2, 'câu mở, ảnh, câu chốt: ảnh tách riêng khỏi chữ');
    const any = renderChatbotReply({ template_id: 'PRODUCT_PHOTOS' }, templates, {});
    assert.equal(any.images.length, 1, 'chưa nêu loại thì gửi ảnh của mọi sản phẩm có ảnh');
  } finally {
    writeFileSync(productsPath, original);
    reloadCatalog();
  }
});

test('"C đặt nhé" sau khi được báo giá: nêu loại mà không nói số thì tính là 1, hỏi tiếp SĐT và địa chỉ', () => {
  const reply = renderChatbotReply({ template_id: 'ORDER_ADDRESS', Product_N1: 'Granola Túi Xanh 450g', No_A: '0', Phone_Number: '0', Customer_Address: '0' }, templates, {});
  assert.equal(reply.templateId, 'ORDER_ADDRESS');
  assert.deepEqual(reply.pendingOrder.items.map(item => [item.product, item.quantity]), [['Granola Túi Xanh 450g', 1]]);
  assert.match(reply.messages[0], /số điện thoại và địa chỉ/);
});

test('thư viện ảnh: khách hỏi một sản phẩm thì 2–3 ảnh ngẫu nhiên đi TRƯỚC bảng giá, theo đúng thứ tự gửi', () => {
  const productsPath = process.env.PRODUCTS_PATH;
  const original = readFileSync(productsPath, 'utf8');
  try {
    const store = JSON.parse(original);
    const xanh = store.items.find(item => item.id === 'seed-granola-xanh');
    xanh.image = '/product-images/xanh-main.png';
    xanh.images = ['/product-images/xanh-1.png', '/product-images/xanh-2.png', '/product-images/xanh-3.png', '/product-images/xanh-4.png'];
    writeFileSync(productsPath, JSON.stringify(store));
    reloadCatalog();
    const two = renderChatbotReply({ template_id: 'PRICE_QUOTE', Product_N1: 'túi xanh' }, templates, { customer: { random: () => 0.1 } });
    assert.equal(two.images.length, 2, 'random < 0.5 → 2 ảnh');
    const three = renderChatbotReply({ template_id: 'PRICE_QUOTE', Product_N1: 'túi xanh' }, templates, { customer: { random: () => 0.9 } });
    assert.equal(three.images.length, 3, 'random ≥ 0.5 → 3 ảnh');
    assert.equal(new Set(three.images).size, 3, 'không lặp ảnh');
    assert.deepEqual(three.parts.map(part => part.type), ['image', 'image', 'image', 'text', 'text'], 'ảnh trước, bảng giá và câu chốt sau');
    assert.match(three.parts[3].text, /Bảng giá Granola Túi Xanh 450g/);
    // Chưa nêu loại: giới thiệu chung cũng mở đầu bằng ảnh trong thư viện.
    const general = renderChatbotReply({ template_id: 'GENERAL_INFO' }, templates, { customer: { random: () => 0.1 } });
    assert.equal(general.parts[0].type, 'image');
    assert.equal(general.images.length, 2);
    // Xin ảnh: 2–3 ảnh của loại khách nêu.
    const photos = renderChatbotReply({ template_id: 'PRODUCT_PHOTOS', Product_N1: 'túi xanh' }, templates, { customer: { random: () => 0.9 } });
    assert.equal(photos.images.length, 3);
    assert.deepEqual(photos.parts.map(part => part.type), ['text', 'image', 'image', 'image', 'text']);
  } finally {
    writeFileSync(productsPath, original);
    reloadCatalog();
  }
});

test('bot gửi theo dãy parts: ảnh trước rồi mới tới chữ khi mẫu đặt ảnh ở đầu', async () => {
  const sent = [];
  await processChatbotChanges([change(incoming('a', 'túi xanh giá sao', 1000))], {
    readSettings: async () => settings,
    listMessages: async () => [],
    sendMessage: async (_conversation, message) => sent.push(message.imageUrls ? `ảnh:${message.imageUrls.join('+')}` : message.imageUrl ? `ảnh:${message.imageUrl}` : `chữ:${message.text}`),
    saveBotState: async () => {},
    requestReply: async () => ({ templateId: 'PRICE_QUOTE', messages: ['Bảng giá'], images: ['https://x/1.png'], parts: [{ type: 'image', url: 'https://x/1.png' }, { type: 'text', text: 'Bảng giá' }], conversationId: '', handoff: false })
  });
  assert.deepEqual(sent, ['ảnh:https://x/1.png', 'chữ:Bảng giá']);
});

test('"lấy thêm 2 túi vàng" ngay sau khi chốt đơn túi xanh: đơn mới chỉ có túi vàng, không gộp món đã đặt', () => {
  const now = Date.now();
  const recentOrder = { id: 'o1', createdAt: now - 60 * 1000, products: [{ name: 'Granola Túi Xanh 450g', sku: 'GRA-XANH-Z450', quantity: 2, price: 149000 }] };
  const value = { template_id: 'ORDER_CONFIRMATION', Product_N1: 'Granola Túi Xanh 450g', No_A: '2', Product_N2: 'Granola Túi Vàng 350g', No_B: '2', Phone_Number: '0385805700', Customer_Address: '12 Lê Lợi, Phường Bến Nghé, Quận 1, TP.HCM' };
  const reply = renderChatbotReply(value, templates, { now, recentOrder });
  assert.equal(reply.templateId, 'ORDER_CONFIRMATION');
  assert.deepEqual(reply.order.items.map(item => [item.product, item.quantity]), [['Granola Túi Vàng 350g', 2]]);
  // Chỉ nhắc lại đúng món đã đặt thì giữ nguyên (đơn trùng do createOrder xử lý).
  const repeat = renderChatbotReply({ ...value, Product_N2: '0', No_B: '0' }, templates, { now, recentOrder });
  assert.deepEqual(repeat.order.items.map(item => item.product), ['Granola Túi Xanh 450g']);
  // Đơn đã lâu (hơn 2 giờ) thì không lọc: giỏ 4 túi gộp không có giá combo nên bot chuyển người (chính là lỗi trước đây).
  const old = renderChatbotReply(value, templates, { now, recentOrder: { ...recentOrder, createdAt: now - 3 * 60 * 60 * 1000 } });
  assert.equal(old.templateId, 'CSKH_HANDOFF');
});

test('ảnh không gửi được thì bỏ ảnh, chữ vẫn tới khách, lỗi ảnh ghi lại cho panel khách', async () => {
  const sent = [];
  const saved = [];
  const results = await processChatbotChanges([change(incoming('a', 'túi xanh giá sao', 1000))], {
    readSettings: async () => settings,
    listMessages: async () => [],
    sendMessage: async (_conversation, message) => { if (message.imageUrl || message.imageUrls) throw new Error('Pancake không nhận tin (200): invalid_upload_fb_attachments_result'); sent.push(message.text); },
    saveBotState: async (_id, state) => saved.push(state),
    requestReply: async () => ({ templateId: 'PRICE_QUOTE', messages: ['Bảng giá'], images: ['https://x/1.png'], parts: [{ type: 'image', url: 'https://x/1.png' }, { type: 'text', text: 'Bảng giá' }], conversationId: '', handoff: false })
  });
  assert.deepEqual(sent, ['Bảng giá']);
  assert.equal(results[0].templateId, 'PRICE_QUOTE');
  assert.match(saved[0].botLastError, /ảnh không gửi được/);
});

test('bình luận: nhắn riêng bảng giá (một tin), rồi ảnh sản phẩm gửi vào hộp thư như tin thường; ảnh bị chặn thì bỏ qua', async () => {
  const sent = [];
  const commentThread = { id: 'page:comment:user:post1', pageId: 'page', psid: 'user', source: 'comment', name: 'Khách', botEnabled: true, lastCommentId: 'c1' };
  const inboxThread = { id: 'page:user', pageId: 'page', psid: 'user', name: 'Khách' };
  const run = (failImages) => processChatbotChanges([{ type: 'message', conversation: commentThread, message: { id: 'c1', direction: 'incoming', type: 'text', text: 'túi xanh giá sao', createdAt: 1000, commentId: 'c1' } }], {
    readSettings: async () => settings,
    listMessages: async () => [],
    getConversation: async id => (id === 'page:user' ? inboxThread : commentThread),
    sendMessage: async (conversation, message) => {
      if ((message.imageUrl || message.imageUrls) && failImages) throw new Error('(#10) ngoài cửa sổ nhắn tin');
      sent.push(`${conversation.id}|${message.privateReply ? 'riêng' : message.imageUrls || message.imageUrl ? 'ảnh' : 'công khai'}|${(message.text || (message.imageUrls || [message.imageUrl]).join('+')).slice(0, 12)}`);
    },
    saveBotState: async () => {},
    moderateComment: async () => {},
    requestReply: async () => ({ templateId: 'PRICE_QUOTE', messages: ['Bảng giá'], images: ['https://x/1.png', 'https://x/2.png'], conversationId: '', handoff: false })
  });
  await run(false);
  // Câu công khai chọn ngẫu nhiên một biến thể nên chỉ so nơi gửi và loại tin.
  assert.deepEqual(sent.map(item => item.split('|').slice(0, 2).join('|')), [
    'page:comment:user:post1|riêng',
    'page:user|ảnh',
    'page:comment:user:post1|công khai'
  ], 'hai ảnh đi chung một tin');
  assert.match(sent[0], /Dạ em thấy a/);
  sent.length = 0;
  await run(true);
  assert.deepEqual(sent.map(item => item.split('|')[1]), ['riêng', 'công khai'], 'ảnh bị chặn thì bỏ qua, vẫn trả lời công khai');
});
