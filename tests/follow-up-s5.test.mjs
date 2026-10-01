import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { tempDir } from './helpers/temp-dir.mjs';
import './helpers/seed-catalog.mjs';

// Kho, trạng thái bám đuổi và thẻ tạm riêng cho tệp này.
const directory = tempDir('followup-s5-');
process.env.META_CONVERSATIONS_PATH = path.join(directory, 'meta-conversations.json');
process.env.FOLLOW_UPS_PATH = path.join(directory, 'follow-ups.json');
process.env.INBOX_SETTINGS_PATH = path.join(directory, 'inbox-settings.json');

const HOUR = 60 * 60 * 1000;
const now = Date.parse('2026-09-19T05:00:00Z'); // 12:00 giờ VN
const page = '110';
const msg = (direction, createdAt, extra = {}) => ({ id: `m${createdAt}${direction}${extra.id || ''}`, mid: '', direction, type: 'text', text: 'x', createdAt, status: 'sent', ...extra });

const { findFollowUpCandidates, isFollowUpHoldout, renderFollowUpMessage, followUpGender, runFollowUps, readFollowUpState } = await import('../app/follow-up.mjs');
const { normalizeChatbotSettings } = await import('../app/chatbot-settings.mjs');

// psid không rơi vào nhóm đối chứng 10% (nhóm đó không gửi).
const psids = [];
for (let index = 0; psids.length < 4; index += 1) if (!isFollowUpHoldout(`s5-${index}`)) psids.push(`s5-${index}`);
const [onlyComment, first, second, flagged] = psids;

writeFileSync(process.env.META_CONVERSATIONS_PATH, JSON.stringify({
  conversations: [
    // Khách chỉ bình luận, chưa có hộp thư.
    { id: `${page}:comment:${onlyComment}:p1`, pageId: page, psid: onlyComment, name: 'Chỉ Bình Luận', source: 'comment' },
    // Hai khách hộp thư im 4 giờ (trần 1 tin mỗi lượt).
    { id: `${page}:${first}`, pageId: page, psid: first, name: 'Khách Một', source: 'inbox' },
    { id: `${page}:${second}`, pageId: page, psid: second, name: 'Khách Hai', source: 'inbox' },
    // Khách đã nhận tin bám đuổi (cờ followUp trên tin, không có followUps[].at khớp giờ).
    { id: `${page}:${flagged}`, pageId: page, psid: flagged, name: 'Khách Ba', source: 'inbox', botEnabled: false }
  ],
  messages: {
    [`${page}:comment:${onlyComment}:p1`]: [msg('incoming', now - 14 * HOUR), msg('outgoing', now - 13 * HOUR)],
    [`${page}:${first}`]: [msg('incoming', now - 5 * HOUR), msg('outgoing', now - 4 * HOUR)],
    [`${page}:${second}`]: [msg('incoming', now - 5 * HOUR - 1000), msg('outgoing', now - 4 * HOUR - 1000)],
    [`${page}:${flagged}`]: [msg('incoming', now - 10 * HOUR), msg('outgoing', now - 9 * HOUR), msg('outgoing', now - HOUR, { followUp: true, id: 'f' })]
  },
  commentIndex: {}
}));
writeFileSync(process.env.FOLLOW_UPS_PATH, JSON.stringify({ activatedAt: now - 48 * HOUR, sent: {} }));

test('S5a: tin mang cờ followUp không tính là "Page trả lời" (mốc kịch bản tính từ lời Page thật)', async () => {
  const { readMessagingStore } = await import('../app/messaging-store.mjs');
  const scenario = { id: 'inbox-3h', trigger: 'inbox-no-reply', delayHours: 3 };
  const candidates = findFollowUpCandidates(await readMessagingStore(), scenario, { now, activatedAt: now - 48 * HOUR });
  const found = candidates.find(item => item.conversation.psid === flagged);
  assert.ok(found, 'tin bám đuổi 1 giờ trước không che mất lời Page 9 giờ trước');
  assert.equal(found.repliedAt, now - 9 * HOUR);
});

test('S5c: xưng hô dùng giới đã khóa của bot (botGender) trước giới đoán; nhân viên đặt tay vẫn thắng', () => {
  assert.equal(renderFollowUpMessage('Dạ {title} ơi', { gender: 'male', botGender: 'female' }), 'Dạ chị ơi');
  assert.equal(renderFollowUpMessage('Dạ {title} ơi', { gender: 'male', genderSource: 'staff', botGender: 'female' }), 'Dạ anh ơi');
  assert.equal(followUpGender({ gender: 'female' }), 'female');
  assert.equal(followUpGender({}), '');
});

test('S5b: kịch bản miễn ship với khách chỉ bình luận → bỏ qua "noInbox" MỘT lần (không hoãn mãi)', async () => {
  // Ưu đãi miễn ship chỉ ở kịch bản 36 giờ (chủ shop 01/10): kịch bản bình luận 36 giờ, xét lúc lời Page đã 37 giờ.
  const settings = normalizeChatbotSettings({ enabled: true, followUps: { enabled: true, scenarios: [{ id: 'comment-ship', name: 'Bình luận miễn ship', trigger: 'comment-no-reply', delayHours: 36, freeShipDays: 3, message: 'Dạ {title} ơi, shop tặng miễn ship ạ' }] } });
  const calls = [];
  const at = now + 24 * HOUR;
  const options = { readSettings: async () => settings, sendMessage: async () => { throw new Error('không được gửi'); }, conversationInfo: async (...args) => { calls.push(args); return {}; }, now: at, quietHours: false, log: () => {} };
  const summary = await runFollowUps(options);
  assert.equal(summary.skipReasons.noInbox, 1);
  assert.equal(summary.deferred, undefined, 'không đếm hoãn');
  assert.equal((await readFollowUpState()).sent[`comment-ship:${page}:${onlyComment}`].skipped, 'noInbox');
  const again = await runFollowUps({ ...options, now: at + 15 * 60 * 1000 });
  assert.deepEqual(again.skipReasons, { alreadySent: 1 }, 'lượt sau: đã ghi, không xét lại');
  assert.equal(calls.length, 0);
});

test('S5b: đủ maxPerRun thì hoãn TRƯỚC khi tra Pancake/POS; tin bám đuổi gửi đi mang followUp: true', async () => {
  const settings = normalizeChatbotSettings({ enabled: true, followUps: { enabled: true, maxPerRun: 1, scenarios: [{ id: 'inbox-3h', name: 'Hộp thư 3 giờ', trigger: 'inbox-no-reply', delayHours: 3, message: 'Dạ {title} còn cần em tư vấn gì không ạ?' }] } });
  const lookups = [];
  const sent = [];
  const summary = await runFollowUps({
    readSettings: async () => settings,
    sendMessage: async (conversation, payload) => { sent.push({ id: conversation.id, ...payload }); return { message: { mid: `mid-${sent.length}` } }; },
    conversationInfo: async (pageId, conversationId) => { lookups.push(conversationId); return {}; },
    now,
    quietHours: false,
    log: () => {}
  });
  assert.equal(summary.sent, 1);
  assert.equal(summary.deferred, 1);
  assert.equal(lookups.length, 1, 'khách thứ hai không tra Pancake/POS khi đã đủ trần');
  assert.equal(sent[0].followUp, true);
  const record = Object.values((await readFollowUpState()).sent).find(item => item.via === 'private');
  assert.equal(record.text, sent[0].text, 'lời đã gửi được lưu (đối chiếu tin dội về)');
});
