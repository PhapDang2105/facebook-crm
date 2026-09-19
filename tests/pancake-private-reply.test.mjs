import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// Hộp thư thử riêng. Đi qua sendConversationMessage của meta-sync (đường bot
// và nhân viên dùng) để chắc cờ privateReply tới được Pancake.
process.env.META_CONVERSATIONS_PATH = path.join(mkdtempSync(path.join(tmpdir(), 'pancake-private-')), 'meta-conversations.json');
process.env.PANCAKE_PAGE_ID = '110';
process.env.PANCAKE_PAGE_ACCESS_TOKEN = 'pat-1';
process.env.PANCAKE_WEBHOOK_TOKEN = 'hook-1';
const { sendConversationMessage } = await import('../app/meta-sync.mjs');
const { handlePancakeWebhook } = await import('../app/pancake.mjs');
const { getConversation, listMessages } = await import('../app/messaging-store.mjs');

test('nhắn riêng từ luồng bình luận Pancake đi bằng private_replies, không thành bình luận công khai; bản dội lại không ghi vào luồng bình luận', async () => {
  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), body: options.body ? JSON.parse(options.body) : null });
    return { ok: true, status: 200, json: async () => ({ success: true, id: 'm_private_1' }) };
  };
  try {
    const payload = {
      page_id: '110',
      event_type: 'messaging',
      data: {
        conversation: { id: '777_5001', type: 'COMMENT', post_id: '110_777', from: { id: '901', name: 'Anh Long' }, assignee_ids: [] },
        message: { id: '777_5001', conversation_id: '777_5001', type: 'COMMENT', message: 'Giá sao', from: { id: '901', name: 'Anh Long' }, parent_id: '777_5001', is_parent: true, inserted_at: '2026-09-19T00:54:16.000000', attachments: [] },
        post: { id: '110_777', message: 'Bài Túi Vàng' }
      }
    };
    await handlePancakeWebhook(payload, { processChatbotChanges: async () => {}, chatbotDependencies: {}, fetchImpl: async () => ({ ok: false, status: 404, json: async () => ({}) }) });
    const thread = await getConversation('110:comment:901:110_777');
    await sendConversationMessage(thread, { text: 'Dạ em gửi bảng giá qua đây ạ', privateReply: true });
    const send = calls.find(call => call.url.includes('/conversations/777_5001/messages'));
    assert.equal(send.body.action, 'private_replies', 'nhắn riêng phải là private_replies');
    assert.deepEqual([send.body.post_id, send.body.message_id, send.body.from_id], ['110_777', '777_5001', '901']);
    assert.deepEqual((await listMessages('110:901')).map(item => [item.text, item.privateReply]), [['Dạ em gửi bảng giá qua đây ạ', true]]);
    assert.equal((await listMessages(thread.id)).length, 1, 'luồng bình luận chỉ có bình luận của khách');
    // Pancake dội lại tin nhắn riêng trong luồng bình luận (cùng mã): không ghi thành bình luận của Page.
    const echo = { ...payload, data: { ...payload.data, message: { id: 'm_private_1', conversation_id: '777_5001', type: 'COMMENT', message: 'Dạ em gửi bảng giá qua đây ạ', from: { id: '110', name: 'Test', admin_name: 'Public API' }, parent_id: '777_5001', is_parent: false, inserted_at: '2026-09-19T00:55:00.000000', private_reply_conversation: { id: 'x' } } } };
    const result = await handlePancakeWebhook(echo, { processChatbotChanges: async () => {}, chatbotDependencies: {}, fetchImpl: async () => ({ ok: false, status: 404, json: async () => ({}) }) });
    assert.deepEqual(result, { stored: 0, bot: 0 });
    assert.equal((await listMessages(thread.id)).length, 1);
  } finally {
    globalThis.fetch = realFetch;
  }
});
