import assert from 'node:assert/strict';
import test from 'node:test';
import './helpers/seed-catalog.mjs';
import { applyWebhookEvents, collectWebhookEvents, normalizeCommentEvent } from '../app/meta-webhook.mjs';
import { commentConversationId, publicConversation } from '../app/messaging-store.mjs';
import { processChatbotChanges } from '../app/chatbot-engine.mjs';
import { defaultMessageTemplates } from '../app/chatbot-templates.mjs';

const pageId = '100000000000001';
const userId = '5566778899';
const postId = `${pageId}_444`;

function feedChange(value) {
  return { field: 'feed', value: { item: 'comment', verb: 'add', post_id: postId, created_time: 1757390000, ...value } };
}

function emptyStore() {
  return { conversations: [], messages: {}, commentIndex: {} };
}

test('chỉ giữ bình luận mới hoặc sửa từ webhook feed', () => {
  assert.equal(normalizeCommentEvent({ field: 'feed', value: { item: 'like', verb: 'add' } }, pageId), null);
  assert.equal(normalizeCommentEvent(feedChange({ verb: 'remove', comment_id: 'c1', from: { id: userId } }), pageId), null);
  const event = normalizeCommentEvent(feedChange({ comment_id: `${postId}_1`, parent_id: postId, from: { id: userId, name: 'Minh Quân' }, message: 'Túi xanh giá sao ạ?' }), pageId);
  assert.equal(event.type, 'comment');
  assert.equal(event.fromPage, false);
  assert.equal(event.text, 'Túi xanh giá sao ạ?');
  assert.equal(event.createdAt, 1757390000000);
  const events = collectWebhookEvents({ object: 'page', entry: [{ id: pageId, changes: [feedChange({ comment_id: 'c9', from: { id: userId } })] }] });
  assert.equal(events.length, 1);
});

test('bình luận của khách mở hội thoại riêng theo bài viết, gắn nhãn comment', () => {
  const store = emptyStore();
  const changes = applyWebhookEvents(store, [
    normalizeCommentEvent(feedChange({ comment_id: `${postId}_1`, parent_id: postId, from: { id: userId, name: 'Minh Quân' }, message: 'Giá sao ạ?' }), pageId)
  ]);
  assert.equal(changes.length, 1);
  const conversation = changes[0].conversation;
  assert.equal(conversation.id, commentConversationId(pageId, userId, postId));
  assert.equal(conversation.source, 'comment');
  assert.notEqual(conversation.botEnabled, false, 'a new thread starts with the bot on');
  assert.equal(conversation.lastCommentId, `${postId}_1`);
  assert.equal(conversation.unread, true);
  const view = publicConversation(conversation);
  assert.equal(view.source, 'comment');
  assert.equal(view.canReply, true, 'comments have no 24h window');
  assert.deepEqual(view.post, { id: postId });

  // Our reply, echoed back by the feed webhook, joins the same thread.
  const echoed = applyWebhookEvents(store, [
    normalizeCommentEvent(feedChange({ comment_id: `${postId}_2`, parent_id: `${postId}_1`, from: { id: pageId, name: 'Giọt Nắng' }, message: 'Dạ em đã nhắn riêng ạ' }), pageId)
  ]);
  assert.equal(echoed[0].conversation.id, conversation.id);
  assert.equal(echoed[0].message.direction, 'outgoing');

  // The customer answering under our reply stays in their thread; a stranger
  // answering there gets their own.
  const replies = applyWebhookEvents(store, [
    normalizeCommentEvent(feedChange({ comment_id: `${postId}_3`, parent_id: `${postId}_2`, from: { id: userId }, message: 'ok em' }), pageId),
    normalizeCommentEvent(feedChange({ comment_id: `${postId}_4`, parent_id: `${postId}_2`, from: { id: '999', name: 'Người khác' }, message: 'cho mình hỏi với' }), pageId)
  ]);
  assert.equal(replies[0].conversation.id, conversation.id);
  assert.equal(replies[1].conversation.id, commentConversationId(pageId, '999', postId));
  assert.equal(store.conversations.length, 2);
  // A Page comment nobody asked for opens nothing.
  assert.deepEqual(applyWebhookEvents(store, [normalizeCommentEvent(feedChange({ comment_id: 'orphan', parent_id: postId, from: { id: pageId } }), pageId)]), []);
});

test('bot trả lời bình luận: nhắn riêng nội dung, công khai một câu mời inbox, không tạo đơn', async () => {
  const sent = [];
  const templates = defaultMessageTemplates();
  const result = await processChatbotChanges([{
    type: 'message',
    conversation: { id: commentConversationId(pageId, userId, postId), psid: userId, name: 'Minh Quân', source: 'comment', botEnabled: true, lastCommentId: 'c1' },
    message: { id: 'c1', mid: 'c1', direction: 'incoming', type: 'text', text: 'chốt 2 túi, 0909123456, 12 Lê Lợi' }
  }], {
    readSettings: async () => ({ enabled: true, responseMode: 'automatic', handoffKeywords: '', messageTemplates: templates }),
    listMessages: async () => [],
    sendMessage: async (_conversation, message) => { sent.push(message); return { message: { mid: 'x' } }; },
    createOrder: async () => { throw new Error('không được tạo đơn từ bình luận'); },
    saveBotState: async () => {},
    requestReply: async () => ({
      templateId: 'ORDER_CONFIRMATION', messages: ['Xác nhận đơn', 'Cảm ơn mình'], images: ['https://x/y.jpg'], handoff: false,
      order: { items: [], phone: '0909123456', address: '12 Lê Lợi', total: 0, shippingFee: 0 }, pendingOrder: null
    })
  });
  assert.equal(result[0].templateId, 'ORDER_CONFIRMATION');
  assert.equal(result[0].orderId, undefined);
  assert.equal(sent.length, 2);
  // The private message opens with the COMMENT_PRIVATE_REPLY intro, then the answer the model chose.
  assert.deepEqual(sent[0], { text: `${templates.COMMENT_PRIVATE_REPLY.replaceAll('{title}', 'anh/chị')}\n\nXác nhận đơn\n\nCảm ơn mình`, privateReply: true });
  // The public line is one of the ### variants, addressed by name.
  assert.equal(sent[1].privateReply, undefined);
  assert.equal(templates.COMMENT_PUBLIC_REPLY.split('###').length, 3);
  assert.ok(/Minh Quân|anh\/chị/.test(sent[1].text), sent[1].text);
  assert.ok(!/[{}#]/.test(sent[1].text), 'placeholders, spintax and separators are all resolved');
});

test('bình luận: chọn ngẫu nhiên một mẫu, {Dạ|Hi} xoay chữ, thích và ẩn bình luận có số điện thoại', async () => {
  const { pickVariant, spin } = await import('../app/chatbot-templates.mjs');
  assert.deepEqual(pickVariant({ messages: ['a', 'b', 'c'] }, () => 0.99), ['c']);
  assert.deepEqual(pickVariant({ messages: ['a', 'b', 'c'] }, () => 0), ['a']);
  assert.deepEqual(pickVariant({ messages: ['solo'] }), ['solo']);
  assert.equal(spin('{Dạ|Hi} {name} ơi', () => 0.6), 'Hi {name} ơi', 'spintax resolves, {name} stays for fill');
  const moderated = [];
  const sent = [];
  const run = (text, commentHide) => processChatbotChanges([{
    type: 'message',
    conversation: { id: 'c', psid: userId, name: 'Minh Quân', source: 'comment', lastCommentId: 'c1' },
    message: { id: 'c1', mid: 'c1', direction: 'incoming', type: 'text', text, commentId: 'c1' }
  }], {
    readSettings: async () => ({ enabled: true, responseMode: 'automatic', handoffKeywords: '', commentLike: true, commentHide, messageTemplates: defaultMessageTemplates() }),
    listMessages: async () => [],
    sendMessage: async (_c, message) => { sent.push(message); return {}; },
    moderateComment: async (_c, message, actions) => { moderated.push({ id: message.commentId, ...actions }); },
    saveBotState: async () => {},
    requestReply: async () => ({ templateId: 'WELCOME', messages: ['Chào'], handoff: false })
  });
  await run('ib 0909123456', 'phone');
  await run('ib', 'phone');
  await run('ib', 'all');
  assert.deepEqual(moderated, [
    { id: 'c1', like: true, hide: true },
    { id: 'c1', like: true, hide: false },
    { id: 'c1', like: true, hide: true }
  ]);
});

test('{title} xưng anh/chị theo giới tính Messenger, trung tính khi không biết', async () => {
  const { renderChatbotReply, honorific } = await import('../app/chatbot-templates.mjs');
  const templates = { WELCOME: '{Title} ơi, {title} cần gì ạ?', CSKH_HANDOFF: 'x' };
  assert.equal(honorific('female'), 'chị');
  assert.equal(renderChatbotReply({ template_id: 'WELCOME' }, templates, { customer: { gender: 'male' } }).messages[0], 'Anh ơi, anh cần gì ạ?');
  assert.equal(renderChatbotReply({ template_id: 'WELCOME' }, templates, {}).messages[0], 'Anh/chị ơi, anh/chị cần gì ạ?');
});

test('giới tính đoán từ tên và cách khách tự xưng; nhân viên đặt tay thắng mọi phỏng đoán', async () => {
  const { genderFromName, genderFromMessage } = await import('../app/processing/customer-info.mjs');
  const { applyGenderGuess } = await import('../app/messaging-store.mjs');
  assert.equal(genderFromName('Nguyễn Thị Lan Anh'), 'female');
  assert.equal(genderFromName('Trần Văn Hoàng'), 'male');
  assert.equal(genderFromName('Lan Anh'), '', 'no middle name, no guess');
  assert.equal(genderFromName('Thị'), '');
  assert.equal(genderFromMessage('chị muốn đặt 2 túi xanh'), 'female');
  assert.equal(genderFromMessage('Anh cần giao về Q12'), 'male');
  assert.equal(genderFromMessage('chị ơi cho em hỏi giá'), '', 'addressing the shop is not a self-reference');
  assert.equal(genderFromMessage('Lấy c 2 túi'), 'female', 'c is shorthand for chị');
  assert.equal(genderFromMessage('cô không ăn ngọt được'), 'female');
  assert.equal(genderFromMessage('Cho anh hỏi túi vàng bao nhiêu'), 'male');
  assert.equal(genderFromMessage('gửi cho chị 2 túi nâu nhé'), 'female');
  assert.equal(genderFromMessage('a ơi còn hàng không'), '', 'a ơi calls the shop');
  assert.equal(genderFromMessage('anh ơi anh muốn lấy 2 túi'), '', 'the word used to call the shop is not trusted');
  assert.equal(genderFromMessage('bác muốn mua 2 túi'), '', 'bác does not tell gender');
  assert.equal(genderFromMessage('1 túi bao nhiêu a'), '');
  const conversation = { name: 'Trần Văn Hoàng' };
  assert.equal(applyGenderGuess(conversation, genderFromName(conversation.name), 'name'), true);
  assert.equal(applyGenderGuess(conversation, 'female', 'message'), true, 'self-reference beats the name');
  assert.equal(applyGenderGuess(conversation, 'male', 'name'), false, 'a weaker source never overwrites');
  conversation.gender = 'male'; conversation.genderSource = 'staff';
  assert.equal(applyGenderGuess(conversation, 'female', 'message'), false, 'staff choice is final');
  assert.equal(conversation.gender, 'male');
});

test('bài viết của Trang là nguồn nhận diện sản phẩm; luồng Messenger kế thừa bài từ luồng bình luận', async () => {
  const { resolveConversationProduct } = await import('../app/processing/product-detect.mjs');
  const { normalizeWebhookEvent } = await import('../app/meta-webhook.mjs');
  const post = 'GRANOLA TÚI VÀNG GIỌT NẮNG – HẠT NHIỀU HƠN, GIÒN THƠM, ĂN VUI MIỆNG NGAY TỪ MUỖNG ĐẦU!';
  assert.equal(resolveConversationProduct({ messageText: 'giá sao ạ', postText: post }).source, 'post');
  assert.match(resolveConversationProduct({ messageText: 'giá sao ạ', postText: post }).product, /Túi Vàng/);
  assert.equal(resolveConversationProduct({ messageText: 'cho em túi xanh', postText: post }).source, 'message', 'what the customer names wins');
  assert.equal(resolveConversationProduct({ messageText: 'ib', adTitle: 'Granola túi xanh', postText: post }).source, 'ad', 'the ad beats the post');

  const store = emptyStore();
  applyWebhookEvents(store, [normalizeCommentEvent(feedChange({ comment_id: `${postId}_1`, parent_id: postId, from: { id: userId, name: 'Minh Quân' }, message: 'ib' }), pageId)]);
  store.conversations[0].post = { id: postId, message: post, permalink: 'https://facebook.com/x' };
  const [change] = applyWebhookEvents(store, [normalizeWebhookEvent({ sender: { id: userId }, recipient: { id: pageId }, timestamp: 1757390100000, message: { mid: 'm1', text: 'giá sao ạ' } }, pageId)]);
  assert.equal(change.conversation.source, 'inbox');
  assert.equal(change.conversation.post.message, post, 'the Messenger thread carries the post the customer commented under');
  assert.equal(change.conversation.post.inheritedFrom, store.conversations[0].id);
});

test('bot bật cho mọi hội thoại; chỉ im lặng khi nhân viên tắt', async () => {
  const run = botEnabled => processChatbotChanges([{
    type: 'message',
    conversation: { id: 'c', psid: userId, name: 'Khách', ...(botEnabled === undefined ? {} : { botEnabled }) },
    message: { id: 'm', mid: 'm', direction: 'incoming', type: 'text', text: 'hi' }
  }], {
    readSettings: async () => ({ enabled: true, responseMode: 'automatic', handoffKeywords: '', messageTemplates: defaultMessageTemplates() }),
    listMessages: async () => [], sendMessage: async () => ({}), saveBotState: async () => {},
    requestReply: async () => ({ templateId: 'WELCOME', messages: ['Chào'], handoff: false })
  });
  assert.equal((await run(undefined)).length, 1, 'a thread nobody touched is answered');
  assert.equal((await run(true)).length, 1);
  assert.equal((await run(false)).length, 0, 'staff switched the bot off');
});
