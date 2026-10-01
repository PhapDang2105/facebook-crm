import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { tempDir } from './helpers/temp-dir.mjs';

// Kho hội thoại tạm cho test: không đụng dữ liệu thật.
process.env.META_CONVERSATIONS_PATH = path.join(tempDir('crm-staff-'), 'store.json');

test('tin nhân viên gửi từ CRM mang cờ staff; bản dội về (không biết ai gửi) không xóa cờ', async () => {
  const { saveMessage } = await import('../app/messaging-store.mjs');
  const store = { conversations: [], messages: {}, commentIndex: {} };
  const base = { pageId: '110', psid: '555' };
  saveMessage(store, { ...base, message: { id: 'm1', mid: 'm1', direction: 'outgoing', type: 'text', text: 'Dạ em kiểm tra ạ', createdAt: 1000, status: 'sent', staff: true, staffName: 'CRM' } });
  // Echo từ Pancake: cùng mid, adminName "Public API" → staff false.
  const { message } = saveMessage(store, { ...base, message: { id: 'm1', mid: 'm1', direction: 'outgoing', type: 'text', text: 'Dạ em kiểm tra ạ', createdAt: 1000, status: 'delivered', staff: false } });
  assert.equal(message.staff, true);
  assert.equal(message.staffName, 'CRM');
  assert.equal(message.status, 'delivered');
});

test('gửi qua Pancake với staff: true → tin lưu có staff/staffName CRM; mặc định (bot) không có cờ', async () => {
  const { sendConversationMessageViaPancake } = await import('../app/pancake.mjs');
  const config = { pageId: '110', pageName: 'Test', pageAccessToken: 'pat-1', webhookToken: 'hook-1', apiBase: 'https://pages.fm/api/public_api', botWhenAssigned: false };
  let n = 0;
  const fetchMock = async (url, options = {}) => {
    const address = String(url);
    if (address.includes('/conversations/110_555/messages')) { n += 1; return { ok: true, status: 200, json: async () => ({ success: true, id: `m_${n}` }) }; }
    throw new Error(`gọi lạ: ${address}`);
  };
  const conversation = { pageId: '110', psid: '555', pancakeConversationId: '110_555' };
  const staffSent = await sendConversationMessageViaPancake(conversation, { text: 'Nhân viên trả lời', staff: true }, config, fetchMock);
  assert.equal(staffSent.message.staff, true);
  assert.equal(staffSent.message.staffName, 'CRM');
  const botSent = await sendConversationMessageViaPancake(conversation, { text: 'Bot trả lời' }, config, fetchMock);
  assert.equal(botSent.message.staff, undefined);
});
