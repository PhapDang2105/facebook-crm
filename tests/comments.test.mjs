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
  assert.equal(conversation.botEnabled, true, 'a comment thread starts with the bot on');
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
  assert.deepEqual(sent[0], { text: 'Xác nhận đơn\n\nCảm ơn mình', privateReply: true });
  assert.equal(sent[1].text, templates.COMMENT_PUBLIC_REPLY);
  assert.equal(sent[1].privateReply, undefined);
});
