import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const directory = mkdtempSync(path.join(tmpdir(), 'followup-'));
process.env.META_CONVERSATIONS_PATH = path.join(directory, 'meta-conversations.json');
process.env.FOLLOW_UPS_PATH = path.join(directory, 'follow-ups.json');
process.env.INBOX_SETTINGS_PATH = path.join(directory, 'inbox-settings.json');

const HOUR = 60 * 60 * 1000;
const now = Date.parse('2026-09-19T12:00:00Z');
const page = '110';
const message = (direction, createdAt, extra = {}) => ({ id: `m${createdAt}${direction}`, mid: '', direction, type: 'text', text: 'x', createdAt, status: 'sent', ...extra });

// Kho: bốn khách bình luận với các tình huống khác nhau, một khách hộp thư.
writeFileSync(process.env.META_CONVERSATIONS_PATH, JSON.stringify({
  conversations: [
    // A: bình luận, Page nhắn riêng 13 giờ trước, khách im → bám (riêng).
    { id: `${page}:comment:a:p1`, pageId: page, psid: 'a', name: 'Nhung Vũ', source: 'comment', gender: 'female', genderSource: 'name' },
    { id: `${page}:a`, pageId: page, psid: 'a', name: 'Nhung Vũ', source: 'inbox', gender: 'female', genderSource: 'name', pancakeConversationId: '110_a' },
    // B: bình luận, Page trả lời công khai 14 giờ trước, khách chưa từng inbox → bám công khai.
    { id: `${page}:comment:b:p1`, pageId: page, psid: 'b', name: 'Tuấn Lê', source: 'comment' },
    // C: bình luận, Page trả lời 13 giờ trước nhưng khách đã nhắn lại 2 giờ trước → không bám.
    { id: `${page}:comment:c:p1`, pageId: page, psid: 'c', name: 'Cẩm Loan', source: 'comment' },
    { id: `${page}:c`, pageId: page, psid: 'c', name: 'Cẩm Loan', source: 'inbox' },
    // D: bình luận, Page trả lời 5 giờ trước → chưa tới 12 giờ.
    { id: `${page}:comment:d:p1`, pageId: page, psid: 'd', name: 'Sơn', source: 'comment' },
    // E: bình luận, Page trả lời 13 giờ trước nhưng nhân viên đã tắt bot ở hộp thư → không bám.
    { id: `${page}:comment:e:p1`, pageId: page, psid: 'e', name: 'Hương', source: 'comment' },
    { id: `${page}:e`, pageId: page, psid: 'e', name: 'Hương', source: 'inbox', botEnabled: false },
    // F: khách hộp thư hỏi, Page trả lời 4 giờ trước, khách im → kịch bản hộp thư 3 giờ.
    { id: `${page}:f`, pageId: page, psid: 'f', name: 'Hùng Phạm', source: 'inbox', gender: 'male', genderSource: 'name' },
    // G: khách nhắn 31 giờ trước (quá hạn 24 giờ của Messenger) → gửi chắc chắn bị từ chối, không xét.
    { id: `${page}:g`, pageId: page, psid: 'g', name: 'Minh', source: 'inbox' }
  ],
  messages: {
    [`${page}:comment:a:p1`]: [message('incoming', now - 14 * HOUR)],
    [`${page}:a`]: [message('outgoing', now - 13 * HOUR, { privateReply: true })],
    [`${page}:comment:b:p1`]: [message('incoming', now - 15 * HOUR), message('outgoing', now - 14 * HOUR)],
    [`${page}:comment:c:p1`]: [message('incoming', now - 14 * HOUR), message('outgoing', now - 13 * HOUR)],
    [`${page}:c`]: [message('incoming', now - 2 * HOUR)],
    [`${page}:comment:d:p1`]: [message('incoming', now - 6 * HOUR), message('outgoing', now - 5 * HOUR)],
    [`${page}:comment:e:p1`]: [message('incoming', now - 14 * HOUR), message('outgoing', now - 13 * HOUR)],
    [`${page}:f`]: [message('incoming', now - 5 * HOUR), message('outgoing', now - 4 * HOUR)],
    [`${page}:g`]: [message('incoming', now - 31 * HOUR), message('outgoing', now - 30 * HOUR)]
  },
  commentIndex: {}
}));

const { runFollowUps, findFollowUpCandidates, renderFollowUpMessage, followUpStatus } = await import('../app/follow-up.mjs');
const { normalizeChatbotSettings, defaultFollowUpScenarios } = await import('../app/chatbot-settings.mjs');
const { readMessagingStore } = await import('../app/messaging-store.mjs');

const settings = normalizeChatbotSettings({
  enabled: true,
  followUps: { enabled: true, scenarios: [...defaultFollowUpScenarios(), { id: 'inbox-3h', name: 'Hộp thư im 3 giờ', trigger: 'inbox-no-reply', delayHours: 3, message: 'Dạ {title} còn cần em tư vấn thêm gì không ạ?' }] }
});

test('cài đặt bám đuổi: mặc định tắt, kịch bản mẫu tặng miễn ship sau 12 giờ; kịch bản không có lời thì bỏ', () => {
  assert.equal(normalizeChatbotSettings({}).followUps.enabled, false);
  assert.equal(normalizeChatbotSettings({}).followUps.scenarios[0].trigger, 'comment-no-reply');
  assert.equal(normalizeChatbotSettings({}).followUps.scenarios[0].delayHours, 12);
  assert.deepEqual(normalizeChatbotSettings({ followUps: { enabled: true, scenarios: [{ name: 'trống', message: '' }] } }).followUps.scenarios, []);
  assert.equal(renderFollowUpMessage('Dạ {title} ơi, {Title} nhé {name}', { gender: 'female', name: 'Lan' }), 'Dạ chị ơi, Chị nhé Lan');
  assert.equal(renderFollowUpMessage('Dạ {title} ơi', {}), 'Dạ anh/chị ơi');
});

test('ứng viên: chỉ khách im lặng đủ giờ, Page đã trả lời sau khi bật; khách trả lời lại, chưa đủ giờ, bot tắt thì không', async () => {
  const store = await readMessagingStore();
  const [comment, inbox] = settings.followUps.scenarios;
  const commentCandidates = findFollowUpCandidates(store, comment, { now, activatedAt: now - 48 * HOUR });
  assert.deepEqual(commentCandidates.map(item => item.conversation.psid).sort(), ['a', 'b']);
  assert.equal(findFollowUpCandidates(store, comment, { now, activatedAt: now - 13.5 * HOUR }).map(item => item.conversation.psid).join(), 'a', 'B trả lời trước khi bật thì không xét');
  assert.deepEqual(findFollowUpCandidates(store, inbox, { now, activatedAt: now - 48 * HOUR }).map(item => item.conversation.psid), ['f']);
});

test('runFollowUps: nhắn riêng vào hộp thư, không có hộp thư thì công khai dưới bình luận; mỗi khách một lần; ghi trạng thái', async () => {
  const sent = [];
  const sendMessage = async (conversation, payload) => { sent.push({ id: conversation.id, ...payload }); return { message: { mid: `mid-${sent.length}` } }; };
  const first = await runFollowUps({ readSettings: async () => settings, sendMessage, now, log: () => {} });
  // activatedAt được ghi = now ở lượt đầu → không có ai đủ điều kiện (chỉ xét trả lời sau khi bật).
  assert.deepEqual(first, { checked: 0, sent: 0, failed: 0, skipped: 0, disabled: false });
  // Giả lập đã bật từ 2 ngày trước.
  const { writeFileSync: write } = await import('node:fs');
  write(process.env.FOLLOW_UPS_PATH, JSON.stringify({ activatedAt: now - 48 * HOUR, sent: {} }));
  const fresh = await import(`../app/follow-up.mjs?reload=${Date.now()}`).catch(() => null);
  const run = fresh?.runFollowUps || runFollowUps;
  const second = await run({ readSettings: async () => settings, sendMessage, now, log: () => {} });
  assert.equal(second.sent, 3, `A riêng, B công khai, F riêng: ${JSON.stringify(sent)}`);
  const byId = Object.fromEntries(sent.map(item => [item.id, item]));
  assert.match(byId[`${page}:a`].text, /^Dạ chị ơi/, 'giới tính nữ → chị');
  assert.equal(byId[`${page}:a`].privateReply, undefined);
  assert.equal(byId[`${page}:comment:b:p1`].privateReply, false, 'khách chưa từng inbox: trả lời công khai');
  assert.match(byId[`${page}:f`].text, /anh còn cần em/);
  const third = await run({ readSettings: async () => settings, sendMessage, now: now + HOUR, log: () => {} });
  assert.equal(third.sent, 0);
  assert.equal(third.skipped, 3, 'đã gửi thì không gửi lại');
  const status = await (fresh?.followUpStatus || followUpStatus)();
  assert.equal(status.sentTotal, 3);
  const store = await readMessagingStore();
  assert.equal(store.conversations.find(item => item.id === `${page}:a`).followUps[0].via, 'private');
});

test('bám đuổi tắt (hoặc chatbot tắt) thì không gửi gì', async () => {
  const off = normalizeChatbotSettings({ enabled: true, followUps: { enabled: false } });
  assert.equal((await runFollowUps({ readSettings: async () => off, sendMessage: async () => { throw new Error('không được gọi'); }, now })).disabled, true);
  const botOff = normalizeChatbotSettings({ enabled: false, followUps: { enabled: true } });
  assert.equal((await runFollowUps({ readSettings: async () => botOff, sendMessage: async () => { throw new Error('không được gọi'); }, now })).disabled, true);
});

test('lời kịch bản lấy từ mẫu FOLLOW_UP_… trong Thiết lập tin nhắn; mẫu tắt thì kịch bản không gửi; nhiều biến thể ### chọn một', async () => {
  const { followUpScenarioText } = await import('../app/follow-up.mjs');
  const base = normalizeChatbotSettings({ enabled: true, followUps: { enabled: true } });
  const scenario = base.followUps.scenarios[0];
  assert.equal(scenario.templateId, 'FOLLOW_UP_COMMENT_FREESHIP');
  assert.match(followUpScenarioText(scenario, base.messageTemplates), /MIỄN PHÍ VẬN CHUYỂN/);
  const off = normalizeChatbotSettings({ enabled: true, followUps: { enabled: true }, messageTemplates: { FOLLOW_UP_COMMENT_FREESHIP: '' } });
  assert.equal(followUpScenarioText(off.followUps.scenarios[0], off.messageTemplates), '');
  const sent = [];
  const write = (await import('node:fs')).writeFileSync;
  write(process.env.FOLLOW_UPS_PATH, JSON.stringify({ activatedAt: now - 48 * HOUR, sent: {} }));
  const fresh = await import(`../app/follow-up.mjs?off=${Date.now()}`);
  const summary = await fresh.runFollowUps({ readSettings: async () => off, sendMessage: async (c, p) => { sent.push(p); return { message: { mid: 'x' } }; }, now, log: () => {} });
  assert.equal(summary.sent, 0, 'mẫu tắt: không gửi');
  assert.equal(sent.length, 0);
  assert.equal(renderFollowUpMessage('A {title}###B {title}', { gender: 'male' }, () => 0.9), 'B anh');
  assert.equal(renderFollowUpMessage('A {title}###B {title}', { gender: 'male' }, () => 0), 'A anh');
  // Mẫu bám đuổi không nằm trong danh sách mẫu đưa cho mô hình.
  const { buildTemplatePrompt } = await import('../app/chatbot-templates.mjs');
  assert.doesNotMatch(buildTemplatePrompt(base.messageTemplates), /FOLLOW_UP_/);
});

test('ngoài 24 giờ: không gọi API mà xếp hàng chờ gửi qua Pancake; "Đã gửi" gắn thẻ Bám đuổi và bật ưu đãi miễn ship', async () => {
  const trial = normalizeChatbotSettings({
    enabled: true,
    followUps: { enabled: true, scenarios: [{ id: 'trial', name: 'Dùng thử miễn ship', trigger: 'inbox-no-reply', delayHours: 24, templateId: 'FOLLOW_UP_TRIAL_FREESHIP', outsideWindow: true, freeShipDays: 7, backlogDays: 7 }] }
  });
  const scenario = trial.followUps.scenarios[0];
  assert.equal(scenario.outsideWindow, true);
  assert.equal(scenario.freeShipDays, 7);
  const write = (await import('node:fs')).writeFileSync;
  write(process.env.FOLLOW_UPS_PATH, JSON.stringify({ activatedAt: now, sent: {} }));
  const fresh = await import(`../app/follow-up.mjs?trial=${Date.now()}`);
  const summary = await fresh.runFollowUps({ readSettings: async () => trial, sendMessage: async () => { throw new Error('ngoài 24 giờ không được gọi API'); }, now, log: () => {} });
  // G im 30 giờ (quá 24 giờ), backlogDays cho xét lùi dù bật từ bây giờ.
  assert.equal(summary.queued, 1);
  assert.equal(summary.sent, 0);
  const status = await fresh.followUpStatus();
  assert.equal(status.sentTotal, 0, 'tin còn trong hàng chờ chưa tính là đã gửi');
  assert.equal(status.queue.length, 1);
  const [item] = status.queue;
  assert.equal(item.conversationId, `${page}:g`);
  assert.equal(item.pancakeUrl, 'https://pancake.vn/110?c=110_g');
  assert.match(item.text, /MIỄN PHÍ VẬN CHUYỂN/);
  // Lượt sau không xếp lại.
  assert.equal((await fresh.runFollowUps({ readSettings: async () => trial, sendMessage: async () => { throw new Error('x'); }, now: now + HOUR, log: () => {} })).queued, undefined);
  assert.equal(await fresh.resolveFollowUpQueueItem(item.key, 'sent', { readSettings: async () => trial, now: now + HOUR }), true);
  assert.equal(await fresh.resolveFollowUpQueueItem(item.key, 'sent', { readSettings: async () => trial }), false, 'đã xử lý thì không còn trong hàng');
  const after = await fresh.followUpStatus();
  assert.equal(after.queue.length, 0);
  assert.equal(after.sentTotal, 1);
  const conversation = (await readMessagingStore()).conversations.find(entry => entry.id === `${page}:g`);
  assert.ok(conversation.labels.includes('followup'), 'gắn thẻ Bám đuổi');
  assert.equal(conversation.promo.freeShipping, true);
  assert.equal(conversation.promo.until, now + HOUR + 7 * 24 * HOUR);
});

test('trạm gửi Pancake: lô hỏi lại Pancake (bỏ khách đã có đơn / không có ID), giữ chỗ, kết quả lỗi 2 lần thì bỏ; tin đồng bộ về thì tự xác nhận', async () => {
  const write = (await import('node:fs')).writeFileSync;
  const entry = (psid, repliedAt) => ({ scenarioId: 'trial', conversationId: `${page}:${psid}`, name: psid.toUpperCase(), at: now, repliedAt, queued: true, text: 'Dạ chị ơi, Giọt Nắng gửi chị ưu đãi riêng: 1 túi miễn ship', pageId: page, psid, freeShipDays: 7 });
  write(process.env.FOLLOW_UPS_PATH, JSON.stringify({ activatedAt: now - 48 * HOUR, sent: { 'trial:110:g': entry('g', now - 30 * HOUR), 'trial:110:f': entry('f', now - 4 * HOUR), 'trial:110:a': entry('a', now - 13 * HOUR) } }));
  const fresh = await import(`../app/follow-up.mjs?relay=${Date.now()}`);
  const info = { g: { globalId: '1000123', recentOrders: 0, canInbox: true }, f: { globalId: '1000456', recentOrders: 1, canInbox: true }, a: { globalId: '', recentOrders: 0, canInbox: true } };
  const conversationInfo = async (pageId, conversationId) => info[conversationId.split('_')[1]];
  const batch = await fresh.buildFollowUpBatch({ limit: 10, conversationInfo, now });
  assert.equal(batch.kind, 'GIOTNANG_FOLLOWUP');
  assert.deepEqual(batch.items.map(item => [item.key, item.convId, item.globalUserId]), [['trial:110:g', '110_g', '1000123']]);
  assert.deepEqual(batch.skipped.map(item => item.reason).sort(), ['chưa có ID Facebook (gửi tay trong Pancake)', 'đã có đơn trên Pancake']);
  // Khách đã có đơn: rời hàng chờ. Chưa có ID Facebook: vẫn chờ (gửi tay), không vào lô.
  // Khách trong lô: giữ chỗ, lô sau không lấy lại.
  const queue = await fresh.followUpQueue({ now });
  assert.deepEqual(queue.map(item => [item.key, item.leased, item.noGlobalId]), [['trial:110:g', true, false], ['trial:110:a', false, true]]);
  assert.equal((await fresh.buildFollowUpBatch({ limit: 10, conversationInfo, now: now + 60000 })).items.length, 0);
  // Lỗi lần 1: trả lại hàng chờ; lỗi lần 2: bỏ, ghi lỗi.
  assert.deepEqual(await fresh.recordFollowUpBatchResults([{ key: 'trial:110:g', ok: false, error: 'CAN NOT SEND' }], { now }), { sent: 0, failed: 1, dropped: 0 });
  const [again] = await fresh.followUpQueue({ now });
  assert.equal(again.leased, false);
  assert.equal(again.lastError, 'CAN NOT SEND');
  assert.deepEqual(await fresh.recordFollowUpBatchResults([{ key: 'trial:110:g', ok: false, error: 'CAN NOT SEND' }], { now }), { sent: 0, failed: 1, dropped: 1 });
  assert.deepEqual((await fresh.followUpQueue({ now })).map(item => item.key), ['trial:110:a']);
});

test('hàng chờ tự xác nhận khi lời bám đuổi (gửi tay trong Pancake) đồng bộ về CRM; tin khác của nhân viên thì không tính', async () => {
  const write = (await import('node:fs')).writeFileSync;
  const text = 'Dạ anh ơi, Giọt Nắng gửi anh ưu đãi riêng: lấy 1 túi granola dùng thử vẫn được MIỄN PHÍ VẬN CHUYỂN ạ';
  write(process.env.FOLLOW_UPS_PATH, JSON.stringify({ activatedAt: now - 48 * HOUR, sent: { 'trial:110:f': { scenarioId: 'trial', conversationId: `${page}:f`, name: 'Hùng', at: now, repliedAt: now - 4 * HOUR, queued: true, text, pageId: page, psid: 'f', freeShipDays: 7 } } }));
  const fresh = await import(`../app/follow-up.mjs?reconcile=${Date.now()}`);
  const { updateMessagingStore } = await import('../app/messaging-store.mjs');
  const push = (message) => updateMessagingStore(current => { current.messages[`${page}:f`] = [...(current.messages[`${page}:f`] || []), message]; return null; });
  await push(message('outgoing', now + 60000, { text: 'Dạ em gửi anh bảng giá ạ' }));
  assert.equal(await fresh.reconcileFollowUpQueue(now + 120000), 0, 'tin khác không phải lời bám đuổi');
  await push(message('outgoing', now + 180000, { text: `${text} 🎁 Ưu đãi dành cho anh trong 7 ngày` }));
  assert.equal(await fresh.reconcileFollowUpQueue(now + 240000), 1);
  assert.equal((await fresh.followUpQueue({ now: now + 240000 })).length, 0);
  const conversation = (await readMessagingStore()).conversations.find(entry => entry.id === `${page}:f`);
  assert.ok(conversation.labels.includes('followup'));
  assert.equal(conversation.promo.freeShipping, true, 'ưu đãi lấy theo freeShipDays ghi lúc xếp hàng');
});

test('khách được bám đuổi chốt đơn trong 14 ngày: thẻ "Bám đuổi thành công", đếm đơn; đơn hủy hay trước tin bám đuổi thì không', async () => {
  const fresh = await import(`../app/follow-up.mjs?won=${Date.now()}`);
  const { updateMessagingStore } = await import('../app/messaging-store.mjs');
  await updateMessagingStore(current => {
    const add = (id, followUpAt, orders) => {
      const conversation = current.conversations.find(entry => entry.id === id);
      conversation.followUps = [{ scenarioId: 'trial', at: followUpAt, via: 'pancake' }];
      conversation.customerOrders = orders;
      delete conversation.followUpWon;
    };
    add(`${page}:f`, now, [{ id: 'won1', createdAt: now + 2 * HOUR, total: 174000 }]);
    add(`${page}:c`, now, [{ id: 'old', createdAt: now - HOUR, total: 298000 }, { id: 'cx', createdAt: now + HOUR, total: 174000, processingStatus: 'cancelled' }]);
    return null;
  });
  assert.equal(await fresh.markFollowUpWins(now + 3 * HOUR), 1);
  assert.equal(await fresh.markFollowUpWins(now + 4 * HOUR), 0, 'ghi một lần');
  const store = await readMessagingStore();
  const won = store.conversations.find(entry => entry.id === `${page}:f`);
  assert.ok(won.labels.includes('followup-won'));
  assert.equal(won.followUpWon.orderId, 'won1');
  assert.ok(!(store.conversations.find(entry => entry.id === `${page}:c`).labels || []).includes('followup-won'));
  const status = await fresh.followUpStatus();
  assert.equal(status.wonTotal, 1);
  assert.equal(status.wonAmount, 174000);
});

test('kết quả trạm gửi: ưu đãi miễn ship lấy theo kịch bản trong cài đặt (tin xếp hàng từ bản cũ không ghi số ngày)', async () => {
  const write = (await import('node:fs')).writeFileSync;
  write(process.env.FOLLOW_UPS_PATH, JSON.stringify({ activatedAt: now - 48 * HOUR, sent: { 'inbox-trial-freeship:110:c': { scenarioId: 'inbox-trial-freeship', conversationId: `${page}:c`, name: 'Cẩm Loan', at: now, repliedAt: now - 30 * HOUR, queued: true, text: 'Dạ chị ơi ưu đãi', pageId: page, psid: 'c' } } }));
  const fresh = await import(`../app/follow-up.mjs?legacy=${Date.now()}`);
  const readSettings = async () => normalizeChatbotSettings({ enabled: true, followUps: { enabled: true, scenarios: [{ id: 'inbox-trial-freeship', name: 'Dùng thử', trigger: 'inbox-no-reply', delayHours: 24, templateId: 'FOLLOW_UP_TRIAL_FREESHIP', outsideWindow: true, freeShipDays: 7 }] } });
  assert.deepEqual(await fresh.recordFollowUpBatchResults([{ key: 'inbox-trial-freeship:110:c', ok: true }], { now, readSettings }), { sent: 1, failed: 0, dropped: 0 });
  const conversation = (await readMessagingStore()).conversations.find(entry => entry.id === `${page}:c`);
  assert.equal(conversation.promo.freeShipping, true);
  assert.equal(conversation.promo.until, now + 7 * 24 * HOUR);
});
