import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { tempDir } from './helpers/temp-dir.mjs';

// Kho hội thoại, trạng thái bám đuổi, thẻ và mã QR tạm: không đụng dữ liệu thật.
const directory = tempDir('pancake-relay-');
process.env.META_CONVERSATIONS_PATH = path.join(directory, 'meta-conversations.json');
process.env.FOLLOW_UPS_PATH = path.join(directory, 'follow-ups.json');
process.env.INBOX_SETTINGS_PATH = path.join(directory, 'inbox-settings.json');
process.env.QR_SCANS_PATH = path.join(directory, 'qr-scans.json');
process.env.PANCAKE_PAGE_ID = '110';
process.env.PANCAKE_PAGE_ACCESS_TOKEN = 'pat-1';

const HOUR = 60 * 60 * 1000;
const now = Date.now();
const iso = at => new Date(at).toISOString().replace('Z', '');
const followUpText = 'Dạ chị ơi, Giọt Nắng gửi chị ưu đãi riêng: miễn ship 3 ngày cho đơn đầu ạ';

writeFileSync(process.env.META_CONVERSATIONS_PATH, JSON.stringify({ conversations: [], messages: {}, commentIndex: {} }));
// Tin bám đuổi ngoài 24 giờ đang trong lô của trạm gửi (extension Pancake gửi dưới tên nhân viên).
writeFileSync(process.env.FOLLOW_UPS_PATH, JSON.stringify({
  activatedAt: now - 72 * HOUR,
  sent: {
    'inbox-24h:110:555': { scenarioId: 'inbox-24h', conversationId: '110:555', name: 'Khách A', at: now - 30 * HOUR, repliedAt: now - 40 * HOUR, queued: true, text: followUpText, pageId: '110', psid: '555', leasedUntil: now + HOUR, batchedAt: now - 5 * 60 * 1000 }
  }
}));

const { isPancakeConfigured, isStaffAdmin, missedBotChanges, backlogBotChanges, normalizePancakeWebhook, pancakeMessageEvent, sendConversationMessageViaPancake, storePancakeEvents } = await import('../app/pancake.mjs');
const { matchesFollowUpText } = await import('../app/follow-up.mjs');
const { getConversation, listMessages, updateMessagingStore } = await import('../app/messaging-store.mjs');
const { sendConversationMessage } = await import('../app/meta-sync.mjs');

const config = { pageId: '110', pageName: 'Test', pageAccessToken: 'pat-1', webhookToken: '', pages: [], apiBase: 'https://pages.fm/api/public_api', botWhenAssigned: false };
const inboxPayload = (id, text, at, admin = '') => ({
  event_type: 'messaging',
  page_id: '110',
  data: {
    conversation: { id: '110_555', from: { id: '555', name: 'Khách A' } },
    message: { id, message: text, from: admin ? { id: '110', name: 'Test Page', admin_name: admin } : { id: '555', name: 'Khách A' }, inserted_at: iso(at) }
  }
});
const store = events => storePancakeEvents(events, { fromWebhook: true });

test('S1: tin trạm gửi trùng lời bám đuổi dưới tên nhân viên → không gắn staff, gắn followUp, bot không tắt; tin khác của cùng admin → staff, bot tắt', async () => {
  await store(normalizePancakeWebhook(inboxPayload('c1', 'alo shop', now - 40 * HOUR), config, now));
  // Pancake bọc HTML và xuống dòng khác bản gốc: so sau chuẩn hóa khoảng trắng.
  const relayHtml = '<div>Dạ chị ơi,  Giọt Nắng gửi chị ưu đãi riêng:</div><div>miễn ship 3 ngày cho đơn đầu ạ</div>';
  const relay = normalizePancakeWebhook(inboxPayload('r1', relayHtml, now - 60 * 1000, 'Nguyễn Hồng Vy'), config, now);
  assert.equal(relay[0].message.staff, true, 'trước khi đối chiếu, tên người = nhân viên');
  await store(relay);
  const stored = (await listMessages('110:555')).find(item => item.id === 'r1');
  assert.equal(stored.staff, undefined, 'tin bám đuổi của trạm gửi không phải nhân viên');
  assert.equal(stored.followUp, true);
  assert.notEqual((await getConversation('110:555')).botEnabled, false, 'khách trả lời bám đuổi thì bot vẫn trả lời');

  // Cùng nhân viên gõ tin khác: vẫn là nhân viên → bot đứng ngoài.
  await store(normalizePancakeWebhook(inboxPayload('s1', 'Dạ chị cho em xin địa chỉ ạ', now - 30 * 1000, 'Nguyễn Hồng Vy'), config, now));
  const typed = (await listMessages('110:555')).find(item => item.id === 's1');
  assert.equal(typed.staff, true);
  assert.equal(typed.staffName, 'Nguyễn Hồng Vy');
  assert.equal(typed.followUp, undefined);
  const conversation = await getConversation('110:555');
  assert.equal(conversation.botEnabled, false);
  assert.equal(conversation.botPausedBy, 'Nguyễn Hồng Vy');
});

test('S1: lời bám đuổi đã gửi quá 24 giờ không còn khớp; hàng chờ còn giữ thì khớp bất kể lúc xếp', () => {
  const text = 'dạ chị ơi ưu đãi';
  assert.equal(matchesFollowUpText([{ text, at: now - 2 * HOUR, queued: false }], { text: 'Dạ  chị ơi\nưu đãi', createdAt: now }), true);
  assert.equal(matchesFollowUpText([{ text, at: now - 30 * HOUR, queued: false }], { text: 'Dạ chị ơi ưu đãi', createdAt: now }), false);
  assert.equal(matchesFollowUpText([{ text, at: now - 30 * HOUR, queued: true }], { text: 'Dạ chị ơi ưu đãi', createdAt: now }), true);
  assert.equal(matchesFollowUpText([{ text, at: now, queued: true }], { text: 'Dạ chị ơi ưu đãi nhé', createdAt: now }), false, 'phải trùng nguyên văn');
});

test('S1: admin tự động (Public API, POS, Botcake, Pancake Bot, Chatbot — mọi kiểu hoa thường) và lời chào QR "Mã thẻ: #…" không phải nhân viên', () => {
  for (const name of ['Public API', 'POS', 'pos', 'Botcake', 'BOTCAKE', 'Pancake Bot', 'chatbot']) assert.equal(isStaffAdmin(name, 'Dạ em chào chị'), false, name);
  assert.equal(isStaffAdmin('Nguyễn Hồng Vy', 'Dạ em chào chị'), true);
  assert.equal(isStaffAdmin('Nguyễn Hồng Vy', 'Chào bạn! Mã thẻ: #abc123'), false, 'lời chào QR');
  assert.equal(isStaffAdmin('', 'x'), false);
  const event = pancakeMessageEvent('110', { id: '110_556', from: { id: '556' } }, { id: 'b1', message: 'Cảm ơn bạn đã quét mã! Mã thẻ: #zz9', from: { id: '110', admin_name: 'Nguyễn Hồng Vy' }, inserted_at: iso(now) }, now);
  assert.equal(event.message.staff, undefined);
  assert.equal(event.pancake.staff, false);
  const botcake = pancakeMessageEvent('110', { id: '110_556', from: { id: '556' } }, { id: 'b2', message: 'Xin chào', from: { id: '110', admin_name: 'Botcake' }, inserted_at: iso(now) }, now);
  assert.equal(botcake.pancake.staff, false);
});

test('S2: trả lời bình luận từ CRM (công khai và nhắn riêng) mang cờ staff; tin bám đuổi mang followUp', async () => {
  let n = 0;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async url => {
    if (String(url).includes('/conversations/777_9/messages')) { n += 1; return { ok: true, status: 200, json: async () => ({ success: true, id: `cm_${n}` }) }; }
    throw new Error(`gọi lạ: ${url}`);
  };
  try {
    await updateMessagingStore(current => {
      current.conversations.push({ id: '110:comment:901:110_777', pageId: '110', psid: '901', name: 'Anh Long', source: 'comment', lastCommentId: '777_9', pancakeConversationId: '777_9', post: { id: '110_777', message: 'Bài' } });
      current.messages['110:comment:901:110_777'] = [];
      return null;
    });
    const thread = await getConversation('110:comment:901:110_777');
    const publicReply = await sendConversationMessage(thread, { text: 'Dạ em inbox anh ạ', staff: true });
    assert.equal(publicReply.message.staff, true);
    assert.equal(publicReply.message.staffName, 'CRM');
    assert.equal(publicReply.message.commentId, 'cm_1');
    const privateReply = await sendConversationMessage(thread, { text: 'Dạ giá 174k ạ', privateReply: true, staff: true });
    assert.equal(privateReply.message.staff, true);
    assert.equal(privateReply.message.privateReply, true);
    assert.equal((await listMessages('110:901')).find(item => item.id === 'cm_2').staff, true, 'tin nhắn riêng lưu ở hộp thư mang cờ staff');
    // Bot trả lời bình luận (không staff): không có cờ.
    const bot = await sendConversationMessageViaPancake(thread, { text: 'Dạ shop gửi giá ạ' }, config, globalThis.fetch);
    assert.equal(bot.message.staff, undefined);
    const followUp = await sendConversationMessage(thread, { text: 'Dạ anh ơi ưu đãi', privateReply: false, followUp: true });
    assert.equal(followUp.message.followUp, true);
    assert.equal(followUp.message.staff, undefined);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('S6: isPancakeConfigured nhận token webhook riêng từng Page (không cần token chung)', () => {
  const page = { pageId: '1', pageAccessToken: 't' };
  assert.equal(isPancakeConfigured({ pages: [page], webhookToken: '' }), false);
  assert.equal(isPancakeConfigured({ pages: [page], webhookToken: 'chung' }), true);
  assert.equal(isPancakeConfigured({ pages: [{ ...page, webhookToken: 'rieng' }, { pageId: '2', pageAccessToken: 'u' }], webhookToken: '' }), true);
  assert.equal(isPancakeConfigured({ pages: [], pageId: '', webhookToken: 'chung' }), false);
});

test('S6: đồng bộ tin lỡ — tin nhân viên cuối trước tin khách chỉ chặn bot trong 2 giờ', () => {
  const conversation = { id: '110:600', botEnabled: true };
  const makeStore = staffAt => ({ messages: { '110:600': [
    { id: 'o1', direction: 'outgoing', staff: true, createdAt: staffAt },
    { id: 'i1', direction: 'incoming', type: 'text', createdAt: now - 10 * 60 * 1000 }
  ] } });
  const change = { type: 'message', conversation, message: { id: 'i1', direction: 'incoming', createdAt: now - 10 * 60 * 1000 } };
  // Nhân viên nhắn 90 phút trước (ngoài 60 phút của staffRepliedRecently, trong 2 giờ): chặn.
  assert.equal(missedBotChanges([change], makeStore(now - 90 * 60 * 1000), { now }).length, 0);
  // Nhân viên nhắn từ hôm qua: khách nhắn lại hôm nay → bot trả lời (trước đây chặn vĩnh viễn).
  assert.equal(missedBotChanges([change], makeStore(now - 26 * HOUR), { now }).length, 1);
  const backlogStore = staffAt => ({ conversations: [conversation], ...makeStore(staffAt) });
  assert.equal(backlogBotChanges(backlogStore(now - 90 * 60 * 1000), { now }).length, 0);
  assert.equal(backlogBotChanges(backlogStore(now - 26 * HOUR), { now }).length, 1);
});
