import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tempDir } from './helpers/temp-dir.mjs';
import './helpers/seed-catalog.mjs';

// INT-04 / INT-14: gửi "không rõ đã tới" (hết giờ chờ Pancake, gửi dở) coi như đã gửi; cắt lịch sử không xoá mục còn chờ.
const directory = tempDir('opt-int-uncertain-');
process.env.META_CONVERSATIONS_PATH = path.join(directory, 'meta-conversations.json');
process.env.FOLLOW_UPS_PATH = path.join(directory, 'follow-ups.json');
process.env.INBOX_SETTINGS_PATH = path.join(directory, 'inbox-settings.json');

const HOUR = 60 * 60 * 1000;
const now = Date.parse('2026-09-19T12:00:00Z');
const page = '110';
const message = (direction, createdAt) => ({ id: `m${createdAt}${direction}`, mid: '', direction, type: 'text', text: 'x', createdAt, status: 'sent' });

writeFileSync(process.env.META_CONVERSATIONS_PATH, JSON.stringify({
  conversations: [{ id: `${page}:f`, pageId: page, psid: 'f', name: 'Hùng Phạm', source: 'inbox', gender: 'male', genderSource: 'name', pancakeConversationId: '110_f' }],
  messages: { [`${page}:f`]: [message('incoming', now - 5 * HOUR), message('outgoing', now - 4 * HOUR)] },
  commentIndex: {}
}));
// Lịch sử bám đuổi đã đầy (5000 mục cũ đã xử lý) + một mục còn chờ ngoài 24 giờ có khoá đứng ĐẦU.
const sent = { 'queued:first': { scenarioId: 's', conversationId: `${page}:q`, at: now - 100 * HOUR, queued: true, text: 'chờ', pageId: page, psid: 'q' } };
for (let index = 0; index < 5000; index += 1) sent[`old:${index}`] = { scenarioId: 's', conversationId: `${page}:o${index}`, at: now - 200 * HOUR + index, via: 'private', text: 'cũ' };
writeFileSync(process.env.FOLLOW_UPS_PATH, JSON.stringify({ activatedAt: now - 48 * HOUR, sent }));

const { runFollowUps } = await import('../app/follow-up.mjs');
const { normalizeChatbotSettings } = await import('../app/chatbot-settings.mjs');
const { readMessagingStore } = await import('../app/messaging-store.mjs');

const settings = normalizeChatbotSettings({
  enabled: true,
  followUps: { enabled: true, scenarios: [{ id: 'inbox-3h', name: 'Hộp thư im 3 giờ', trigger: 'inbox-no-reply', delayHours: 3, message: 'Dạ {title} còn cần em tư vấn thêm gì không ạ?' }] }
});

test('bám đuổi: lỗi unknownDelivery = đã gửi (ghi lời, gắn mốc bám đuổi, không đếm lỗi); lượt sau không gửi lại', async () => {
  let calls = 0;
  const sendMessage = async () => {
    calls += 1;
    throw Object.assign(new Error('Pancake không rõ đã nhận tin (hết giờ chờ 15 giây)'), { code: 'PANCAKE_SEND_UNCERTAIN', unknownDelivery: true });
  };
  const summary = await runFollowUps({ readSettings: async () => settings, sendMessage, now, log: () => {} });
  assert.equal(calls, 1);
  assert.equal(summary.sent, 1);
  assert.equal(summary.failed, 0);
  const state = JSON.parse(readFileSync(process.env.FOLLOW_UPS_PATH, 'utf8'));
  const entry = Object.values(state.sent).find(item => item.conversationId === `${page}:f`);
  assert.equal(entry.via, 'private');
  assert.equal(entry.uncertain, true);
  assert.match(entry.text, /anh còn cần em/);
  assert.equal(entry.error, undefined);
  const inbox = (await readMessagingStore()).conversations.find(item => item.id === `${page}:f`);
  assert.equal(inbox.followUps.at(-1).scenarioId, 'inbox-3h');
  const again = await runFollowUps({ readSettings: async () => settings, sendMessage, now: now + HOUR, log: () => {} });
  assert.equal(calls, 1, 'không gửi lại');
  assert.equal(again.sent, 0);
});

test('INT-14: lịch sử quá 5000 mục thì bỏ mục đã xử lý cũ nhất, mục còn chờ (queued) giữ nguyên', () => {
  const state = JSON.parse(readFileSync(process.env.FOLLOW_UPS_PATH, 'utf8'));
  assert.ok(state.sent['queued:first']?.queued, 'mục còn chờ không bị xoá');
  assert.equal(Object.keys(state.sent).length, 5000);
  assert.equal(state.sent['old:0'], undefined, 'mục cũ nhất bị bỏ');
  assert.ok(state.sent['old:4999']);
});
