import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// Hộp thư thử riêng: storePancakeEvents ghi vào messaging-store.
process.env.META_CONVERSATIONS_PATH = path.join(mkdtempSync(path.join(tmpdir(), 'pancake-')), 'meta-conversations.json');
const {
  handlePancakeWebhook, isPancakeWebhookTokenValid, normalizePancakeWebhook, pancakeMessageText, pancakeTime, sendPancakeMessage
} = await import('../app/pancake.mjs');

const config = { pageId: '110', pageName: 'Test', pageAccessToken: 'pat-1', webhookToken: 'hook-1', apiBase: 'https://pages.fm/api/public_api', botWhenAssigned: false };
const incoming = (overrides = {}) => ({
  page_id: '110',
  event_type: 'messaging',
  data: {
    conversation: { id: '110_555', type: 'INBOX', from: { id: '555', name: 'Chị Mai' }, assignee_ids: [], ...(overrides.conversation || {}) },
    message: {
      id: 'm_abc', conversation_id: '110_555', page_id: '110', type: 'INBOX',
      message: '<div>Shop còn <b>Granola Xanh</b> không?</div>', original_message: '<div>Shop còn <b>Granola Xanh</b> không?</div>',
      inserted_at: '2026-09-19T02:30:00.000000', from: { id: '555', name: 'Chị Mai', page_customer_id: 'pc-1' }, attachments: [],
      ...(overrides.message || {})
    }
  }
});

test('tin inbox của khách → sự kiện cùng dạng webhook Meta: chữ sạch HTML, giờ UTC, mã hội thoại Pancake', () => {
  const [event] = normalizePancakeWebhook(incoming(), config, 1);
  assert.equal(event.pageId, '110');
  assert.equal(event.psid, '555');
  assert.equal(event.message.direction, 'incoming');
  assert.equal(event.message.text, 'Shop còn Granola Xanh không?');
  assert.equal(event.message.type, 'text');
  assert.equal(event.message.id, 'm_abc');
  assert.equal(event.message.createdAt, Date.UTC(2026, 8, 19, 2, 30));
  assert.deepEqual(event.pancake, { conversationId: '110_555', customerName: 'Chị Mai', pageCustomerId: 'pc-1', assigned: false });
});

test('tin do Page gửi (nhân viên trả lời trong Pancake) là tin đi; bình luận, Page khác, sự kiện khác bị bỏ', () => {
  const [staff] = normalizePancakeWebhook(incoming({ message: { id: 'm_2', from: { id: '110', name: 'Giọt Nắng' }, message: 'Dạ còn ạ' } }), config);
  assert.equal(staff.message.direction, 'outgoing');
  assert.equal(staff.psid, '555', 'khách vẫn là người bên kia của hội thoại');
  assert.deepEqual(normalizePancakeWebhook(incoming({ message: { type: 'COMMENT' } }), config), []);
  assert.deepEqual(normalizePancakeWebhook({ ...incoming(), page_id: '999' }, config), []);
  assert.deepEqual(normalizePancakeWebhook({ ...incoming(), event_type: 'conversation' }, config), []);
  const [attachmentOnly] = normalizePancakeWebhook(incoming({ message: { message: '', original_message: '', attachments: [{ type: 'photo' }] } }), config);
  assert.equal(attachmentOnly.message.type, 'attachment');
  assert.equal(attachmentOnly.message.text, '[Tệp đính kèm]');
});

test('chữ và giờ: bỏ thẻ HTML, giữ xuống dòng; giờ không múi giờ đọc là UTC', () => {
  assert.equal(pancakeMessageText({ message: '<div>Dòng 1</div><div>Dòng 2&nbsp;&amp; 3</div>' }), 'Dòng 1\nDòng 2 & 3');
  assert.equal(pancakeTime('2024-12-25T11:06:07.000000', 0), Date.UTC(2024, 11, 25, 11, 6, 7));
  assert.equal(pancakeTime('2024-12-25T18:06:07+07:00', 0), Date.UTC(2024, 11, 25, 11, 6, 7));
  assert.equal(pancakeTime('', 42), 42);
});

test('token webhook: so sánh an toàn, token trống là tắt', () => {
  assert.equal(isPancakeWebhookTokenValid('hook-1', 'hook-1'), true);
  assert.equal(isPancakeWebhookTokenValid('hook-2', 'hook-1'), false);
  assert.equal(isPancakeWebhookTokenValid('', ''), false);
});

test('gửi tin: đúng URL v1, token trên query, body reply_inbox; lỗi của Pancake được nêu rõ', async () => {
  const calls = [];
  const fetchOk = async (url, options) => { calls.push({ url, options }); return { ok: true, status: 200, json: async () => ({ success: true, id: 'm_sent' }) }; };
  const sent = await sendPancakeMessage({ pageId: '110', conversationId: '110_555', text: 'Dạ còn ạ' }, config, fetchOk);
  assert.equal(sent.id, 'm_sent');
  assert.equal(calls[0].url, 'https://pages.fm/api/public_api/v1/pages/110/conversations/110_555/messages?page_access_token=pat-1');
  assert.deepEqual(JSON.parse(calls[0].options.body), { action: 'reply_inbox', message: 'Dạ còn ạ' });
  const fetchFail = async () => ({ ok: false, status: 401, json: async () => ({ success: false, message: 'Invalid access_token' }) });
  await assert.rejects(sendPancakeMessage({ pageId: '110', conversationId: '110_555', text: 'x' }, config, fetchFail), /Invalid access_token/);
  await assert.rejects(sendPancakeMessage({ pageId: '110', conversationId: '', text: 'x' }, config, fetchOk), /chưa có mã Pancake/);
});

test('webhook đầu tới cuối: ghi hộp thư, đưa bot; hội thoại đã có nhân viên nhận thì bot đứng ngoài; gửi lặp không ghi hai lần', async () => {
  const botCalls = [];
  const processChatbotChanges = async changes => { botCalls.push(changes); };
  const first = await handlePancakeWebhook(incoming(), { processChatbotChanges, chatbotDependencies: {}, config });
  assert.deepEqual(first, { stored: 1, bot: 1 });
  assert.equal(botCalls[0][0].conversation.pancakeConversationId, '110_555');
  assert.equal(botCalls[0][0].conversation.name, 'Chị Mai');
  assert.equal(botCalls[0][0].message.text, 'Shop còn Granola Xanh không?');
  // Pancake gửi lại cùng tin (cập nhật): không ghi thêm, không gọi bot lần nữa.
  const again = await handlePancakeWebhook(incoming(), { processChatbotChanges, chatbotDependencies: {}, config });
  assert.deepEqual(again, { stored: 0, bot: 0 });
  // Nhân viên đã nhận hội thoại: tin mới vẫn ghi nhưng bot không trả lời.
  const assigned = await handlePancakeWebhook(incoming({ message: { id: 'm_3', message: 'Cho em hỏi giá' }, conversation: { assignee_ids: ['staff-1'] } }), { processChatbotChanges, chatbotDependencies: {}, config });
  assert.deepEqual(assigned, { stored: 1, bot: 0 });
  assert.equal(botCalls.length, 1);
  // Cho phép bot nói cả khi đã gán.
  const allowed = await handlePancakeWebhook(incoming({ message: { id: 'm_4', message: 'Còn không ạ' }, conversation: { assignee_ids: ['staff-1'] } }), { processChatbotChanges, chatbotDependencies: {}, config: { ...config, botWhenAssigned: true } });
  assert.deepEqual(allowed, { stored: 1, bot: 1 });
});
