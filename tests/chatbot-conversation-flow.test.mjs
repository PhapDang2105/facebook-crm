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
  // Bảng giá chung trong hộp thư luôn kèm bảng giá chi tiết Túi Xanh (1 túi / combo 2 / combo 3).
  assert.equal(sent[0], 'Dạ nhà em có 3 vị ạ');
  assert.match(sent.slice(1).join('\n'), /Bảng giá Granola Túi Xanh 450g/);
});

test('bảng giá chung (GENERAL_INFO) trong hộp thư: gửi kèm bảng giá Túi Xanh; đã gửi bảng Túi Xanh trong 30 phút, bình luận, hay khách đang giữ ưu đãi dùng thử thì không', async () => {
  const price = { templateId: 'GENERAL_INFO', messages: ['Dạ nhà em có 3 vị ạ'], handoff: false };
  const run = async (conversation, recent = []) => {
    const sent = [];
    const results = await processChatbotChanges([{ type: 'message', conversation: { id: 'p:u', pageId: 'p', psid: 'u', name: 'Khách', botEnabled: true, ...conversation }, message: { id: 'm1', mid: 'm1', direction: 'incoming', type: 'text', text: 'cho mình hỏi giá với ạ, mình đang phân vân', createdAt: Date.now() } }], {
      readSettings: async () => settings,
      listMessages: async () => recent,
      saveBotState: async () => {},
      sendMessage: async (_c, message) => { sent.push(message.text || '[ảnh]'); return { message: { mid: 'x' } }; },
      requestReply: async () => price
    });
    return { sent, results };
  };
  const inbox = await run({});
  assert.equal(inbox.results[0].templateId, 'GENERAL_INFO');
  assert.match(inbox.sent.join('\n'), /Bảng giá Granola Túi Xanh 450g/);
  const justSent = await run({}, [{ id: 'q', direction: 'outgoing', type: 'text', text: 'Dạ, em gửi anh/chị Bảng giá Granola Túi Xanh 450g để mình dễ tham khảo ạ: …', createdAt: Date.now() - 5 * 60 * 1000 }]);
  assert.doesNotMatch(justSent.sent.join('\n'), /Bảng giá Granola Túi Xanh/, 'vừa gửi trong 30 phút: không gửi lại');
  const trial = await run({ promo: { freeShipping: true, until: Date.now() + 86400000, at: Date.now() - 3600000, stage: 'offered' } });
  assert.doesNotMatch(trial.sent.join('\n'), /Combo 3|Gia Đình|Giá gốc/, "khách giữ ưu đãi dùng thử: luồng riêng, không bảng giá combo 3 của luồng chung (combo 2 tặng bát là ưu đãi riêng)");
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
  // Dòng đầu nêu lại giỏ và tổng tiền, rồi mới xin SĐT/địa chỉ (bỏ chữ "Dạ" thứ hai).
  const [cartLine, ask] = reply.messages[0].split('\n');
  assert.match(cartLine, /^Dạ đơn của anh\/chị gồm 2 Granola Túi Xanh 450g, tổng 298\.000đ/);
  assert.match(ask, /^Để lên đơn đúng tuyến cho đơn vị vận chuyển, anh\/chị cho em xin số điện thoại và địa chỉ nhận hàng đầy đủ/);
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
    // Ảnh của bảng giá chung là ảnh đại diện các túi chính (ghép combo được), không
    // lấy ngẫu nhiên trong thư viện mọi sản phẩm; ở kho thử chỉ Túi Xanh có ảnh.
    const general = renderChatbotReply({ template_id: 'GENERAL_INFO' }, templates, { customer: { random: () => 0.1 } });
    assert.equal(general.parts[0].type, 'image');
    assert.equal(general.images.length, 1);
    assert.match(general.images[0], /xanh-main\.png/);
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

test('ngay sau khi bot chốt đơn (dưới 60 phút): "thêm/nữa" gộp vào đơn cũ, đổi giỏ thì sửa đơn cũ, "đơn khác" mới là đơn mới', () => {
  const now = Date.now();
  const recentOrder = { id: 'o1', automatic: true, createdAt: now - 60 * 1000, phone: '0385805700', address: '12 Lê Lợi, Phường Bến Nghé, Quận 1, TP.HCM', products: [{ name: 'Granola Túi Xanh 450g', sku: 'GRA-XANH-Z450', quantity: 2, price: 149000 }] };
  const value = { template_id: 'ORDER_CONFIRMATION', Product_N1: 'Granola Túi Vàng 350g', No_A: '1', Phone_Number: '0', Customer_Address: '0' };
  // "lấy thêm 1 túi vàng nữa": gộp vào đơn cũ → Xanh 2 + Vàng 1, sửa đúng đơn o1.
  const added = renderChatbotReply(value, templates, { now, recentOrder, messageText: 'lấy thêm 1 túi vàng nữa nhé' });
  assert.equal(added.templateId, 'ORDER_UPDATE');
  assert.equal(added.order.updateOrderId, 'o1');
  assert.deepEqual(added.order.items.map(item => [item.product, item.quantity]).sort(), [['Granola Túi Vàng 350g', 1], ['Granola Túi Xanh 450g', 2]]);
  assert.equal(added.order.phone, '0385805700', 'SĐT/địa chỉ lấy từ đơn cũ');
  // Đổi ý ("ko phải, lấy 2 túi vàng"): thay giỏ của đơn cũ, không tạo đơn thứ hai.
  const changed = renderChatbotReply({ ...value, No_A: '2' }, templates, { now, recentOrder, messageText: 'ko phải, mình lấy 2 túi vàng' });
  assert.equal(changed.templateId, 'ORDER_UPDATE');
  assert.deepEqual(changed.order.items.map(item => [item.product, item.quantity]), [['Granola Túi Vàng 350g', 2]]);
  // Khách nói rõ đơn khác: đơn mới chỉ gồm món vừa nêu.
  const separate = renderChatbotReply({ ...value, Phone_Number: '0909123456', Customer_Address: '5 Nguyễn Huệ, Phường Bến Nghé, Quận 1, TP.HCM' }, templates, { now, recentOrder, messageText: 'lên đơn khác giúp mình 1 túi vàng gửi người khác' });
  assert.equal(separate.templateId, 'ORDER_CONFIRMATION');
  assert.deepEqual(separate.order.items.map(item => item.product), ['Granola Túi Vàng 350g']);
  // Quá 60 phút: không sửa đơn cũ.
  const late = renderChatbotReply({ ...value, Phone_Number: '0909123456', Customer_Address: '5 Nguyễn Huệ, Phường Bến Nghé, Quận 1, TP.HCM' }, templates, { now, recentOrder: { ...recentOrder, createdAt: now - 3 * 60 * 60 * 1000 }, messageText: 'lấy thêm 1 túi vàng' });
  assert.equal(late.templateId, 'ORDER_CONFIRMATION');
  assert.equal(late.order.updateOrderId, undefined);
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

test('bình luận: luồng chưa biết xưng hô thì bot mượn giới tính của hộp thư cùng khách (nhân viên đã chọn Anh)', async () => {
  const sent = [];
  const commentThread = { id: 'page:comment:u9:post1', pageId: 'page', psid: 'u9', source: 'comment', name: 'Khách', botEnabled: true, lastCommentId: 'c9' };
  const inboxThread = { id: 'page:u9', pageId: 'page', psid: 'u9', name: 'Khách', gender: 'male', genderSource: 'staff' };
  await processChatbotChanges([{ type: 'message', conversation: commentThread, message: { id: 'c9', direction: 'incoming', type: 'text', text: 'giá sao', createdAt: 1000, commentId: 'c9' } }], {
    readSettings: async () => settings,
    listMessages: async () => [],
    getConversation: async id => (id === 'page:u9' ? inboxThread : commentThread),
    sendMessage: async (_conversation, message) => sent.push(message.text || ''),
    saveBotState: async () => {},
    moderateComment: async () => {},
    requestReply: async ({ context }) => ({ templateId: 'WELCOME', messages: [`Dạ ${context.customer.gender === 'male' ? 'anh' : 'anh/chị'} ơi`], conversationId: '', handoff: false })
  });
  assert.match(sent[0], /^Dạ em thấy anh để lại bình luận/, 'lời chào nhắn riêng xưng "anh"');
  // WELCOME dưới bình luận nay được thay bằng bảng giá; xưng hô "anh" mượn từ hộp thư vẫn phải thấy ở câu mở đầu.
  assert.match(sent[0], /Dạ em thấy anh để lại bình luận/);
  assert.doesNotMatch(sent.join(' '), /anh\/chị/);
});

test('luật thử nghiệm mặc định chỉ chạy ẩn: "Mua sao e" vẫn hỏi mô hình, log so sánh; bật experimentalRules=on thì luật trả lời', async () => {
  const run = async extra => {
    const sent = [];
    let asked = false;
    const logs = [];
    const original = console.log;
    console.log = (...args) => { logs.push(args.join(' ')); };
    try {
      await processChatbotChanges([{ type: 'message', conversation: { id: 'p:u2', pageId: 'p', psid: 'u2', name: 'Khách', botEnabled: true }, message: { id: 'm9', mid: 'm9', direction: 'incoming', type: 'text', text: 'Mua sao e', createdAt: Date.now() } }], {
        readSettings: async () => ({ ...settings, ruleIntent: 'on', ...extra }),
        listMessages: async () => [], saveBotState: async () => {},
        sendMessage: async (_c, message) => { sent.push(message.text || '[ảnh]'); return { message: { mid: 'x' } }; },
        requestReply: async () => { asked = true; return { templateId: 'GENERAL_INFO', messages: ['Bảng giá từ mô hình'], handoff: false }; }
      });
    } finally { console.log = original; }
    return { sent, asked, logs };
  };
  const shadow = await run({});
  assert.equal(shadow.asked, true);
  assert.ok(shadow.logs.some(line => /Luật TERSE_HOW \(thử\): luật GENERAL_INFO \/ mô hình GENERAL_INFO ✓/.test(line)), shadow.logs.join('\n'));
  const on = await run({ experimentalRules: 'on' });
  assert.equal(on.asked, false);
  assert.match(on.sent[0], /nhà em đang có/);
});

test('vòng 7: khách lặp câu chỉ khác khoảng trắng → nhắc "ở trên"; mẫu live cho khách không live → mẫu thường; xưng hô không đổi vì "cho anh nhà mình"', async () => {
  const { genderFromMessage } = await import('../app/processing/customer-info.mjs');
  assert.equal(genderFromMessage('mình lấy cho anh nhà mình 1 túi'), '');
  assert.equal(genderFromMessage('chị lấy 2 túi'), 'female');
  const run = async (text, recent, reply) => {
    const sent = [];
    const results = await processChatbotChanges([{ type: 'message', conversation: { id: 'p:u7', pageId: 'p', psid: 'u7', name: 'Khách', botEnabled: true, botLastTemplateId: 'GENERAL_INFO', botLastReplyAt: Date.now() - 2 * 60 * 1000 }, message: { id: 'm7', mid: 'm7', direction: 'incoming', type: 'text', text, createdAt: Date.now() } }], {
      readSettings: async () => ({ ...settings, ruleIntent: 'off' }),
      listMessages: async () => recent, saveBotState: async () => {},
      sendMessage: async (_c, message) => { sent.push(message.text || '[ảnh]'); return { message: { mid: 'x' } }; },
      requestReply: async () => reply
    });
    return { sent, results };
  };
  const general = { templateId: 'GENERAL_INFO', messages: [templates.GENERAL_INFO ? 'Dạ, hiện tại nhà em đang có 10 sản phẩm ạ' : 'x'], handoff: false };
  const repeat = await run('Shop ơi  giá sao', [{ id: 'i', direction: 'incoming', type: 'text', text: 'shop oi gia sao', createdAt: Date.now() - 3 * 60 * 1000 }, { id: 'o', direction: 'outgoing', type: 'text', text: 'Dạ, hiện tại nhà em đang có 10 sản phẩm ạ', createdAt: Date.now() - 2 * 60 * 1000 }], general);
  assert.match(repeat.sent.join('\n'), /ngay trên|ở trên|phía trên/);
  const live = await run('có gì đặc biệt không', [], { templateId: 'LIVESTREAM_VOUCHER', messages: ['voucher live'], handoff: false });
  assert.equal(live.results[0].templateId, 'DISCOUNT_POLICY');
});
