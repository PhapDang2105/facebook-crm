// Bám đuổi qua cầu nối Pancake (03/10, "Đã gửi 0/10, lỗi 1"): extension Pancake không tìm được ID Facebook thì khách
// KHÔNG bị bỏ khỏi hàng (không tính lần lỗi), được đánh dấu "cần gửi tay", 24 giờ mới nhờ tìm lại; lô mang tên / mốc /
// mã luồng Pancake cho cầu nối; fetchPancakeConversationInfo đọc các trường đó từ API tin nhắn Pancake.
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { tempDir } from './helpers/temp-dir.mjs';

const directory = tempDir('opt-bridge-fu-');
process.env.META_CONVERSATIONS_PATH = path.join(directory, 'meta-conversations.json');
process.env.FOLLOW_UPS_PATH = path.join(directory, 'follow-ups.json');
process.env.INBOX_SETTINGS_PATH = path.join(directory, 'inbox-settings.json');

const HOUR = 60 * 60 * 1000;
const now = Date.parse('2026-10-03T08:00:00Z');
const page = '110';
writeFileSync(process.env.META_CONVERSATIONS_PATH, JSON.stringify({
  conversations: ['a', 'b', 'c'].map(psid => ({ id: `${page}:${psid}`, pageId: page, psid, name: psid.toUpperCase(), source: 'inbox' })),
  messages: {},
  commentIndex: {}
}));
const entry = psid => ({ scenarioId: 'inbox-36h', conversationId: `${page}:${psid}`, name: psid.toUpperCase(), at: now - HOUR, repliedAt: now - 40 * HOUR, queued: true, text: 'Dạ chị ơi', pageId: page, psid });
writeFileSync(process.env.FOLLOW_UPS_PATH, JSON.stringify({ activatedAt: now - 72 * HOUR, sent: { 'inbox-36h:110:a': entry('a'), 'inbox-36h:110:b': entry('b'), 'inbox-36h:110:c': entry('c') } }));

const followUp = await import('../app/follow-up.mjs');
const { fetchPancakeConversationInfo } = await import('../app/pancake.mjs');

// a, b: Pancake chưa có ID Facebook; c: có ID.
const info = {
  a: { globalId: '', recentOrders: 0, canInbox: true, name: 'Ánh Pancake', updatedAt: now - 39 * HOUR, threadId: '', threadKey: 't_555' },
  b: { globalId: '', recentOrders: 0, canInbox: true, name: 'Bình Pancake', updatedAt: 0, threadId: '', threadKey: '' },
  c: { globalId: '1000999', recentOrders: 0, canInbox: true, name: 'C' }
};
const conversationInfo = async (pageId, conversationId) => info[conversationId.split('_')[1]];

test('lô: khách cần tìm ID mang tên / mốc / mã luồng Pancake; khách đã có ID thì không kèm', async () => {
  const batch = await followUp.buildFollowUpBatch({ limit: 10, conversationInfo, now });
  const byKey = Object.fromEntries(batch.items.map(item => [item.key, item]));
  assert.equal(byKey['inbox-36h:110:a'].pancakeName, 'Ánh Pancake');
  assert.equal(byKey['inbox-36h:110:a'].pancakeUpdatedAt, now - 39 * HOUR);
  assert.equal(byKey['inbox-36h:110:a'].threadKey, 't_555');
  assert.equal(byKey['inbox-36h:110:c'].pancakeName, undefined);
  assert.equal(batch.items.at(-1).needsGlobalId, true, 'khách cần tìm ID vẫn xếp cuối lô');
  await followUp.releaseFollowUpLeases();
});

test('hụt ID: không tính lần lỗi, không bỏ khỏi hàng, "cần gửi tay"; 24 giờ không nhờ tìm lại; sau 24 giờ tìm lại', async () => {
  const batch = await followUp.buildFollowUpBatch({ limit: 10, conversationInfo, now });
  const error = 'extension Pancake không tìm được ID Facebook của khách — Pancake báo: {"code":"NOT_FOUND"}';
  // Hai lần hụt liền (trước đây lần thứ hai là bỏ khách khỏi hàng mà chưa gửi gì).
  for (let round = 0; round < 3; round += 1) {
    const summary = await followUp.recordFollowUpBatchResults([{ key: 'inbox-36h:110:a', ok: false, error, lookupFailed: true }], { now, token: batch.token });
    assert.equal(summary.failed, 0);
    assert.equal(summary.dropped, 0);
    assert.equal(summary.lookupFailed, 1);
  }
  const state = await followUp.readFollowUpState();
  const stored = state.sent['inbox-36h:110:a'];
  assert.equal(stored.queued, true, 'vẫn trong hàng chờ');
  assert.equal(stored.attempts, undefined, 'không tính lần lỗi');
  assert.equal(stored.lookupFailedAt, now);
  assert.equal(stored.leasedUntil, undefined, 'trả chỗ ngay');
  const queue = await followUp.followUpQueue({ now });
  const queued = queue.find(item => item.key === 'inbox-36h:110:a');
  assert.equal(queued.needsManual, true);
  assert.match(queued.lastError, /cần gửi tay/);
  assert.match(queued.lastError, /NOT_FOUND/);
  await followUp.releaseFollowUpLeases();
  // Lô sau trong 24 giờ: a bị bỏ qua với lý do "cần gửi tay" và không chiếm suất tìm ID; b vẫn được tìm.
  const next = await followUp.buildFollowUpBatch({ limit: 10, conversationInfo, now: now + HOUR });
  assert.deepEqual(next.items.map(item => item.key).sort(), ['inbox-36h:110:b', 'inbox-36h:110:c']);
  assert.match(next.skipped.find(item => item.key === 'inbox-36h:110:a').reason, /cần gửi tay/);
  await followUp.releaseFollowUpLeases();
  // Quá 24 giờ: nhờ extension tìm lại.
  const later = await followUp.buildFollowUpBatch({ limit: 10, conversationInfo, now: now + 25 * HOUR });
  assert.ok(later.items.some(item => item.key === 'inbox-36h:110:a'));
  assert.equal((await followUp.followUpQueue({ now: now + 25 * HOUR })).find(item => item.key === 'inbox-36h:110:a').needsManual, false);
  // Lần sau tìm được ID (kể cả gửi lỗi): xoá dấu hụt.
  await followUp.recordFollowUpBatchResults([{ key: 'inbox-36h:110:a', ok: false, error: 'CAN NOT SEND', globalId: '1000777' }], { now: now + 25 * HOUR, token: later.token });
  const after = (await followUp.readFollowUpState()).sent['inbox-36h:110:a'];
  assert.equal(after.lookupFailedAt, undefined);
  assert.equal(after.globalId, '1000777');
  assert.equal(after.attempts, 1, 'lỗi gửi thật vẫn tính như cũ');
});

test('fetchPancakeConversationInfo: tên Pancake, mốc tin mới nhất (inserted_at), thread_id / thread_key nếu Pancake trả', async () => {
  const body = {
    conv_from: { id: '222', name: 'Tên conv_from' },
    customers: [{ name: '', global_id: null, thread_id: '9988' }],
    messages: [{ inserted_at: '2026-10-02T09:00:00' }, { inserted_at: '2026-10-01T09:00:00' }]
  };
  const fetchImpl = async () => ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) });
  const config = { pageId: '110', pageName: 'Test', pageAccessToken: 'pat', webhookToken: 'w', apiBase: 'https://pages.fm/api/public_api' };
  const result = await fetchPancakeConversationInfo('110', '110_222', config, fetchImpl);
  assert.equal(result.name, 'Tên conv_from');
  assert.equal(result.updatedAt, Date.parse('2026-10-02T09:00:00Z'));
  assert.equal(result.threadId, '9988');
  assert.equal(result.threadKey, '');
  assert.equal(result.globalId, '');
  const withKey = { ...body, thread_key: 't_1', updated_at: '2026-10-03T01:00:00Z' };
  const keyed = await fetchPancakeConversationInfo('110', '110_222', config, async () => ({ ok: true, status: 200, json: async () => withKey, text: async () => JSON.stringify(withKey) }));
  assert.equal(keyed.threadKey, 't_1');
  assert.equal(keyed.updatedAt, Date.parse('2026-10-03T01:00:00Z'));
});
