import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { tempDir } from './helpers/temp-dir.mjs';
// Danh mục sản phẩm tạm (giá giỏ cho lời nhắc ORDER_ADDRESS_REMIND), không đụng data/processed.
import './helpers/seed-catalog.mjs';

const directory = tempDir('followup-');
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
  // E (nhân viên tắt bot ở hộp thư) vẫn là ứng viên: vòng gửi bỏ qua và đếm lý do botOff.
  assert.deepEqual(commentCandidates.map(item => item.conversation.psid).sort(), ['a', 'b', 'e']);
  assert.equal(findFollowUpCandidates(store, comment, { now, activatedAt: now - 13.5 * HOUR }).map(item => item.conversation.psid).join(), 'a,e', 'B trả lời trước khi bật thì không xét');
  assert.deepEqual(findFollowUpCandidates(store, inbox, { now, activatedAt: now - 48 * HOUR }).map(item => item.conversation.psid), ['f']);
});

test('runFollowUps: nhắn riêng vào hộp thư, không có hộp thư thì công khai dưới bình luận; mỗi khách một lần; ghi trạng thái', async () => {
  const sent = [];
  const sendMessage = async (conversation, payload) => { sent.push({ id: conversation.id, ...payload }); return { message: { mid: `mid-${sent.length}` } }; };
  const first = await runFollowUps({ readSettings: async () => settings, sendMessage, now, log: () => {} });
  // activatedAt được ghi = now ở lượt đầu → không có ai đủ điều kiện (chỉ xét trả lời sau khi bật).
  assert.deepEqual(first, { checked: 0, sent: 0, failed: 0, skipped: 0, skipReasons: {}, disabled: false });
  // Giả lập đã bật từ 2 ngày trước.
  const { writeFileSync: write } = await import('node:fs');
  write(process.env.FOLLOW_UPS_PATH, JSON.stringify({ activatedAt: now - 48 * HOUR, sent: {} }));
  const fresh = await import(`../app/follow-up.mjs?reload=${Date.now()}`).catch(() => null);
  const run = fresh?.runFollowUps || runFollowUps;
  const second = await run({ readSettings: async () => settings, sendMessage, now, log: () => {} });
  // A: hộp thư chỉ có tin nhắn riêng của Page, khách CHƯA nhắn hộp thư → cửa sổ 24 giờ chưa mở, gửi vào
  // hộp thư là lỗi #551 (production 30/09: 100% thất bại). Không gọi hộp thư nữa, đi thẳng đường dự phòng
  // công khai của kịch bản (publicFallback, như trước đây sau khi gửi riêng lỗi).
  assert.equal(second.sent, 3, `A công khai, B công khai, F riêng: ${JSON.stringify(sent)}`);
  assert.deepEqual(second.skipReasons, { botOff: 1 }, 'E: nhân viên tắt bot ở hộp thư');
  const byId = Object.fromEntries(sent.map(item => [item.id, item]));
  assert.equal(byId[`${page}:a`], undefined, 'không gửi vào hộp thư chưa mở cửa sổ 24 giờ');
  assert.match(byId[`${page}:comment:a:p1`].text, /^Dạ chị ơi/, 'giới tính nữ → chị');
  assert.equal(byId[`${page}:comment:a:p1`].privateReply, false);
  assert.equal(byId[`${page}:comment:b:p1`].privateReply, false, 'khách chưa từng inbox: trả lời công khai');
  assert.match(byId[`${page}:f`].text, /anh còn cần em/);
  const third = await run({ readSettings: async () => settings, sendMessage, now: now + HOUR, log: () => {} });
  assert.equal(third.sent, 0);
  assert.equal(third.skipped, 4, 'đã gửi thì không gửi lại (+ E bot tắt)');
  assert.deepEqual(third.skipReasons, { alreadySent: 3, botOff: 1 });
  const status = await (fresh?.followUpStatus || followUpStatus)();
  assert.equal(status.sentTotal, 3);
  const store = await readMessagingStore();
  assert.equal(store.conversations.find(item => item.id === `${page}:a`).followUps[0].via, 'public');
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
  assert.match(followUpScenarioText(scenario, base.messageTemplates), /Miễn phí vận chuyển/i);
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
    // Ưu đãi chỉ ở kịch bản 36 giờ (chủ shop 01/10): G im từ lời Page 30 giờ trước → xét lúc +6 giờ (36 giờ).
    followUps: { enabled: true, scenarios: [{ id: 'trial', name: 'Dùng thử miễn ship', trigger: 'inbox-no-reply', delayHours: 36, templateId: 'FOLLOW_UP_TRIAL_FREESHIP', outsideWindow: true, freeShipDays: 7, backlogDays: 7 }] }
  });
  const at = now + 6 * HOUR;
  const scenario = trial.followUps.scenarios[0];
  assert.equal(scenario.outsideWindow, true);
  assert.equal(scenario.freeShipDays, 7);
  const write = (await import('node:fs')).writeFileSync;
  write(process.env.FOLLOW_UPS_PATH, JSON.stringify({ activatedAt: now, sent: {} }));
  const fresh = await import(`../app/follow-up.mjs?trial=${Date.now()}`);
  const summary = await fresh.runFollowUps({ readSettings: async () => trial, sendMessage: async () => { throw new Error('ngoài 24 giờ không được gọi API'); }, now: at, quietHours: false, log: () => {} });
  // G im 30 giờ (quá 24 giờ), backlogDays cho xét lùi dù bật từ bây giờ.
  assert.equal(summary.queued, 1);
  assert.equal(summary.sent, 0);
  const status = await fresh.followUpStatus();
  assert.equal(status.sentTotal, 0, 'tin còn trong hàng chờ chưa tính là đã gửi');
  assert.equal(status.queue.length, 1);
  const [item] = status.queue;
  assert.equal(item.conversationId, `${page}:g`);
  assert.equal(item.pancakeUrl, 'https://pancake.vn/110?c=110_g');
  assert.match(item.text, /Miễn phí vận chuyển/i);
  // Lượt sau không xếp lại.
  assert.equal((await fresh.runFollowUps({ readSettings: async () => trial, sendMessage: async () => { throw new Error('x'); }, now: at + HOUR, quietHours: false, log: () => {} })).queued, undefined);
  assert.equal(await fresh.resolveFollowUpQueueItem(item.key, 'sent', { readSettings: async () => trial, now: at + HOUR }), true);
  assert.equal(await fresh.resolveFollowUpQueueItem(item.key, 'sent', { readSettings: async () => trial }), false, 'đã xử lý thì không còn trong hàng');
  const after = await fresh.followUpStatus();
  assert.equal(after.queue.length, 0);
  assert.equal(after.sentTotal, 1);
  const conversation = (await readMessagingStore()).conversations.find(entry => entry.id === `${page}:g`);
  assert.ok(conversation.labels.includes('followup'), 'gắn thẻ Bám đuổi');
  assert.equal(conversation.promo.freeShipping, true);
  assert.equal(conversation.promo.until, at + HOUR + 7 * 24 * HOUR);
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
  // Khách chưa có ID Facebook vẫn vào lô (needsGlobalId): cầu nối nhờ extension tìm ID.
  assert.deepEqual(batch.items.map(item => [item.key, item.convId, item.globalUserId, item.needsGlobalId]), [['trial:110:g', '110_g', '1000123', false], ['trial:110:a', '110_a', '', true]]);
  assert.ok(batch.token);
  assert.deepEqual(batch.skipped.map(item => item.reason), ['khách cũ đã từng mua']);
  // Khách đã có đơn: rời hàng chờ. Khách trong lô: giữ chỗ, lô sau không lấy lại.
  const queue = await fresh.followUpQueue({ now });
  assert.deepEqual(queue.map(item => [item.key, item.leased, item.noGlobalId]), [['trial:110:g', true, false], ['trial:110:a', true, true]]);
  assert.equal((await fresh.buildFollowUpBatch({ limit: 10, conversationInfo, now: now + 60000 })).items.length, 0, 'đang giữ chỗ: lô sau không lấy lại');
  assert.equal(await fresh.releaseFollowUpLeases(['trial:110:a']), 1, 'Dừng giữa lô: trả chỗ');
  assert.equal((await fresh.followUpQueue({ now })).find(item => item.key === 'trial:110:a').leased, false);
  const third = await fresh.buildFollowUpBatch({ limit: 10, conversationInfo, now: now + 120000 });
  // Lỗi lần 1: trả lại hàng chờ; lỗi lần 2: bỏ, ghi lỗi.
  // Kết quả không mang mã lô: bị từ chối. Đúng mã: ghi nhận.
  assert.deepEqual(await fresh.recordFollowUpBatchResults([{ key: 'trial:110:g', ok: false, error: 'CAN NOT SEND' }], { now }), { sent: 0, failed: 0, dropped: 0, rejected: 1 });
  assert.deepEqual(await fresh.recordFollowUpBatchResults([{ key: 'trial:110:g', ok: false, error: 'CAN NOT SEND' }], { now, token: batch.token }), { sent: 0, failed: 1, dropped: 0 });
  const [again] = await fresh.followUpQueue({ now });
  assert.equal(again.leased, false);
  assert.equal(again.lastError, 'CAN NOT SEND');
  const second = await fresh.buildFollowUpBatch({ limit: 10, conversationInfo, now: now + 60000 });
  assert.deepEqual(second.items.map(item => item.key), ['trial:110:g'], 'lỗi lần 1 → trả lại hàng, lô sau lấy lại');
  assert.deepEqual(await fresh.recordFollowUpBatchResults([{ key: 'trial:110:g', ok: false, error: 'CAN NOT SEND' }], { now, token: second.token }), { sent: 0, failed: 1, dropped: 1 });
  // Extension tìm được ID cho a rồi gửi: ghi ID lại, khách rời hàng chờ.
  assert.deepEqual(await fresh.recordFollowUpBatchResults([{ key: 'trial:110:a', ok: true, globalId: '1000777' }], { now, token: third.token }), { sent: 1, failed: 0, dropped: 0 });
  assert.equal((await fresh.readFollowUpState()).sent['trial:110:a'].globalId, '1000777');
  assert.deepEqual((await fresh.followUpQueue({ now })).map(item => item.key), []);
});

test('ID Facebook extension tìm được (kể cả khi gửi lỗi) được dùng ở lô sau: không đánh dấu thiếu ID, không tìm lại', async () => {
  const write = (await import('node:fs')).writeFileSync;
  write(process.env.FOLLOW_UPS_PATH, JSON.stringify({ activatedAt: now - 48 * HOUR, sent: { 'trial:110:a': { scenarioId: 'trial', conversationId: `${page}:a`, name: 'A', at: now, repliedAt: now - 13 * HOUR, queued: true, text: 'Dạ chị ơi', pageId: page, psid: 'a', freeShipDays: 7 } } }));
  const fresh = await import(`../app/follow-up.mjs?globalid=${Date.now()}`);
  // Pancake vẫn chưa lưu ID Facebook của khách này.
  const conversationInfo = async () => ({ globalId: '', recentOrders: 0, canInbox: true });
  const first = await fresh.buildFollowUpBatch({ limit: 10, conversationInfo, now });
  assert.deepEqual(first.items.map(item => [item.globalUserId, item.needsGlobalId]), [['', true]]);
  // Extension tìm ra ID nhưng gửi lỗi: khách về hàng chờ, ID được ghi lại.
  assert.deepEqual(await fresh.recordFollowUpBatchResults([{ key: 'trial:110:a', ok: false, error: 'CAN NOT SEND', globalId: '1000888' }], { now, token: first.token }), { sent: 0, failed: 1, dropped: 0 });
  const [queued] = await fresh.followUpQueue({ now });
  assert.equal(queued.globalId, '1000888');
  assert.equal(queued.noGlobalId, false);
  const second = await fresh.buildFollowUpBatch({ limit: 10, conversationInfo, now: now + 60000 });
  assert.deepEqual(second.items.map(item => [item.globalUserId, item.needsGlobalId]), [['1000888', false]], 'lô sau mang ID đã tìm, không nhờ extension tìm lại');
  assert.equal((await fresh.readFollowUpState()).sent['trial:110:a'].noGlobalId, undefined, 'không bị đánh dấu thiếu ID lần nữa');
});

test('trạm gửi hết giờ chờ (unknown): giữ chỗ 45 phút, không tính lần lỗi; hết giữ chỗ thì về hàng chờ; tin đồng bộ về thì xác nhận; kết quả trễ sau đó bị từ chối', async () => {
  const write = (await import('node:fs')).writeFileSync;
  const text = 'Dạ chị ơi, Giọt Nắng gửi chị ưu đãi riêng: lấy 1 túi granola dùng thử vẫn được MIỄN PHÍ VẬN CHUYỂN ạ';
  const MIN = 60 * 1000;
  write(process.env.FOLLOW_UPS_PATH, JSON.stringify({ activatedAt: now - 48 * HOUR, sent: { 'trial:110:g': { scenarioId: 'trial', conversationId: `${page}:g`, name: 'Minh', at: now, repliedAt: now - 30 * HOUR, queued: true, text, pageId: page, psid: 'g', freeShipDays: 7 } } }));
  const fresh = await import(`../app/follow-up.mjs?unknown=${Date.now()}`);
  const conversationInfo = async () => ({ globalId: '1000123', recentOrders: 0, canInbox: true });
  const batch = await fresh.buildFollowUpBatch({ limit: 10, conversationInfo, now });
  assert.deepEqual(batch.items.map(item => item.key), ['trial:110:g']);
  // Cầu nối hết giờ: client báo unknown:true → không trả về hàng chờ ngay, không tăng attempts.
  const reported = now + 150 * 1000;
  assert.deepEqual(await fresh.recordFollowUpBatchResults([{ key: 'trial:110:g', ok: false, error: 'timeout', unknown: true }], { now: reported, token: batch.token }), { sent: 0, failed: 0, dropped: 0, unknown: 1 });
  const [held] = await fresh.followUpQueue({ now: reported + MIN });
  assert.equal(held.leased, true, 'vẫn giữ chỗ');
  assert.equal(held.attempts, 0, 'không tính là lần lỗi');
  assert.match(held.lastError, /chờ đồng bộ Pancake xác nhận/);
  assert.equal((await fresh.buildFollowUpBatch({ limit: 10, conversationInfo, now: reported + 44 * MIN })).items.length, 0, 'trong 45 phút: lô sau không lấy lại (không gửi trùng)');
  // Hết giữ chỗ mà không thấy tin đồng bộ về: khách về hàng chờ, lô sau lấy lại.
  const second = await fresh.buildFollowUpBatch({ limit: 10, conversationInfo, now: reported + 46 * MIN });
  assert.deepEqual(second.items.map(item => item.key), ['trial:110:g']);
  assert.equal((await fresh.readFollowUpState()).sent['trial:110:g'].attempts || 0, 0);
  // Lần này cũng hết giờ; sau đó Pancake đồng bộ lời bám đuổi về → tự xác nhận đã gửi.
  const reported2 = reported + 47 * MIN;
  assert.deepEqual(await fresh.recordFollowUpBatchResults([{ key: 'trial:110:g', ok: false, error: 'timeout', unknown: true }], { now: reported2, token: second.token }), { sent: 0, failed: 0, dropped: 0, unknown: 1 });
  const { updateMessagingStore } = await import('../app/messaging-store.mjs');
  await updateMessagingStore(current => { current.messages[`${page}:g`] = [...(current.messages[`${page}:g`] || []), message('outgoing', reported2 - 2 * MIN, { text: `${text} 🎁` })]; return null; });
  assert.equal(await fresh.reconcileFollowUpQueue(reported2 + MIN), 1);
  assert.equal((await fresh.followUpQueue({ now: reported2 + MIN })).length, 0);
  assert.ok((await readMessagingStore()).conversations.find(entry => entry.id === `${page}:g`).labels.includes('followup'));
  // Kết quả ok:true đến trễ sau khi đã xác nhận: không còn trong hàng → từ chối, không gửi/ghi gì thêm.
  assert.deepEqual(await fresh.recordFollowUpBatchResults([{ key: 'trial:110:g', ok: true }], { now: reported2 + 2 * MIN, token: second.token }), { sent: 0, failed: 0, dropped: 0, rejected: 1 });
  // unknown cho khách không trong lô (sai mã lô): từ chối như mọi kết quả khác.
  assert.deepEqual(await fresh.recordFollowUpBatchResults([{ key: 'trial:110:g', ok: false, unknown: true }], { now, token: 'sai' }), { sent: 0, failed: 0, dropped: 0, rejected: 1 });
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
  const readSettings = async () => normalizeChatbotSettings({ enabled: true, followUps: { enabled: true, scenarios: [{ id: 'inbox-trial-freeship', name: 'Dùng thử', trigger: 'inbox-no-reply', delayHours: 36, templateId: 'FOLLOW_UP_TRIAL_FREESHIP', outsideWindow: true, freeShipDays: 7 }] } });
  assert.deepEqual(await fresh.recordFollowUpBatchResults([{ key: 'inbox-trial-freeship:110:c', ok: true }], { now, readSettings }), { sent: 1, failed: 0, dropped: 0 });
  const conversation = (await readMessagingStore()).conversations.find(entry => entry.id === `${page}:c`);
  assert.equal(conversation.promo.freeShipping, true);
  assert.equal(conversation.promo.until, now + 7 * 24 * HOUR);
});

test('chỉ bám khách MỚI: khách đã từng mua (hồ sơ Pancake/POS, SĐT có đơn, thẻ) không được gửi / bị gỡ khỏi hàng chờ', async () => {
  const { returningCustomerReason } = await import('../app/follow-up.mjs');
  assert.equal(returningCustomerReason({ orderCount: 0, recentOrders: 0, tags: [] }), '');
  assert.equal(returningCustomerReason({ orderCount: 2 }), '', 'order_count gồm cả đơn bỏ dở: không tin');
  assert.match(returningCustomerReason({ succeedOrderCount: 1 }), /khách cũ/);
  assert.match(returningCustomerReason({ purchasedAmount: 174000 }), /khách cũ/);
  assert.match(returningCustomerReason({ lastOrderAt: '2026-05-01T00:00:00' }), /khách cũ/);
  assert.match(returningCustomerReason({ posOrders: 1 }), /SĐT đã có đơn trên POS/);
  assert.match(returningCustomerReason({ crmOrders: 1 }), /CRM/);
  assert.match(returningCustomerReason({ tags: ['Đã mua hàng'] }), /thẻ/);

  // Vòng bám đuổi: khách F (hộp thư im 4 giờ) là khách cũ trên POS → không gửi, ghi lý do.
  const { updateMessagingStore } = await import('../app/messaging-store.mjs');
  await updateMessagingStore(current => { const f = current.conversations.find(entry => entry.id === `${page}:f`); f.customerOrders = []; f.labels = []; delete f.promo; delete f.followUps; return null; });
  const write = (await import('node:fs')).writeFileSync;
  write(process.env.FOLLOW_UPS_PATH, JSON.stringify({ activatedAt: now - 48 * HOUR, sent: {} }));
  const fresh = await import(`../app/follow-up.mjs?returning=${Date.now()}`);
  const inboxOnly = normalizeChatbotSettings({ enabled: true, followUps: { enabled: true, scenarios: [{ id: 'inbox-3h', name: 'Hộp thư 3 giờ', trigger: 'inbox-no-reply', delayHours: 3, message: 'Dạ {title} còn cần em tư vấn thêm gì không ạ?' }] } });
  const sent = [];
  const summary = await fresh.runFollowUps({ readSettings: async () => inboxOnly, sendMessage: async (c, p) => { sent.push(c.id); return { message: { mid: 'x' } }; }, conversationInfo: async () => ({ succeedOrderCount: 1 }), now: now + 5 * HOUR, quietHours: false, log: () => {} });
  assert.equal(summary.sent, 0);
  assert.equal(summary.returning, 1);
  assert.deepEqual(sent, []);
  assert.match((await fresh.readFollowUpState()).sent['inbox-3h:110:f'].error, /khách cũ/);

  // Thẻ Đã mua hàng trên hội thoại: không vào danh sách ứng viên.
  const store = await readMessagingStore();
  const tagged = { ...store, conversations: store.conversations.map(entry => (entry.id === `${page}:f` ? { ...entry, labels: ['customer'] } : entry)) };
  assert.equal(findFollowUpCandidates(tagged, inboxOnly.followUps.scenarios[0], { now, activatedAt: now - 48 * HOUR }).length, 0);

  // Dọn hàng chờ: khách xếp hàng từ trước được tra lại, khách cũ bị gỡ, khách mới giữ (đánh dấu đã xét).
  write(process.env.FOLLOW_UPS_PATH, JSON.stringify({ activatedAt: now - 48 * HOUR, sent: {
    'trial:110:g': { scenarioId: 'trial', conversationId: `${page}:g`, name: 'G', at: now, repliedAt: now - 30 * HOUR, queued: true, text: 'x', pageId: page, psid: 'g' },
    'trial:110:a': { scenarioId: 'trial', conversationId: `${page}:a`, name: 'A', at: now, repliedAt: now - 13 * HOUR, queued: true, text: 'x', pageId: page, psid: 'a' }
  } }));
  const pruner = await import(`../app/follow-up.mjs?prune=${Date.now()}`);
  const info = { g: { succeedOrderCount: 3 }, a: { orderCount: 3 } };
  assert.deepEqual(await pruner.pruneReturningFromQueue({ conversationInfo: async (pageId, id) => info[id.split('_')[1]], now }), { checked: 2, removed: 1 });
  const state = await pruner.readFollowUpState();
  assert.equal(state.sent['trial:110:g'].queued, undefined);
  assert.equal(state.sent['trial:110:a'].checkedAt, now);
  assert.deepEqual(await pruner.pruneReturningFromQueue({ conversationInfo: async () => ({ succeedOrderCount: 9 }), now }), { checked: 0, removed: 0 }, 'đã xét thì không tra lại');
});

test('lô gửi chỉ lấy khách đã im đủ số giờ của kịch bản hiện tại (đổi 24 → 36 giờ sau lúc xếp hàng)', async () => {
  const write = (await import('node:fs')).writeFileSync;
  const entry = (psid, silentHours) => ({ scenarioId: 'inbox-trial-freeship', conversationId: `${page}:${psid}`, name: psid, at: now, repliedAt: now - silentHours * HOUR, queued: true, text: 'x', pageId: page, psid, checkedAt: now });
  write(process.env.FOLLOW_UPS_PATH, JSON.stringify({ activatedAt: now - 48 * HOUR, sent: { 'inbox-trial-freeship:110:g': entry('g', 30), 'inbox-trial-freeship:110:a': entry('a', 40) } }));
  const { updateMessagingStore } = await import('../app/messaging-store.mjs');
  await updateMessagingStore(current => { for (const id of [`${page}:g`, `${page}:a`]) { const c = current.conversations.find(item => item.id === id); c.labels = []; c.customerOrders = []; c.botEnabled = true; } return null; });
  const fresh = await import(`../app/follow-up.mjs?due=${Date.now()}`);
  const readSettings = async () => normalizeChatbotSettings({ enabled: true, followUps: { enabled: true, scenarios: [{ id: 'inbox-trial-freeship', name: 'Dùng thử', trigger: 'inbox-no-reply', delayHours: 36, templateId: 'FOLLOW_UP_TRIAL_FREESHIP', outsideWindow: true, freeShipDays: 7 }] } });
  const batch = await fresh.buildFollowUpBatch({ limit: 10, now, readSettings, conversationInfo: async () => ({ globalId: '1000999', canInbox: true }) });
  assert.deepEqual(batch.items.map(item => item.key), ['inbox-trial-freeship:110:a'], 'im 30 giờ: chưa tới lượt; im 40 giờ: gửi');
  assert.match(batch.items[0].text, /ưu đãi riêng trong 7 ngày/, 'lời dựng theo mẫu hiện tại');
});

test('vòng 7 (chủ shop 05/10: bắt đầu 8h thay 7h): giờ yên tĩnh 22h–8h VN; release([]) không thả gì; kết quả không mã lô bị từ chối', async () => {
  const { isQuietHourVN, releaseFollowUpLeases, recordFollowUpBatchResults } = await import('../app/follow-up.mjs');
  const vn = (h, m = 0) => Date.UTC(2026, 8, 25, (h - 7 + 24) % 24, m);
  assert.equal(isQuietHourVN(vn(21, 59)), false);
  assert.equal(isQuietHourVN(vn(22)), true);
  assert.equal(isQuietHourVN(vn(6, 59)), true);
  // Chủ shop 05/10: bám đuổi buổi sáng từ 8h (trước đây 7h — tin cả đêm dồn 12–15 tin lúc 7h).
  assert.equal(isQuietHourVN(vn(7)), true);
  assert.equal(isQuietHourVN(vn(7, 59)), true);
  assert.equal(isQuietHourVN(vn(8)), false);
  assert.equal(await releaseFollowUpLeases([]), 0);
  assert.deepEqual(await recordFollowUpBatchResults([{ key: 'khong:co:that', ok: true }], { token: '' }), { sent: 0, failed: 0, dropped: 0, rejected: 1 });
});

test('vòng 7: khách nói "đã nhận hàng rồi" / Page gửi phiếu đơn (order-receipt) → coi là đã mua, không bám đuổi', async () => {
  const { updateMessagingStore } = await import('../app/messaging-store.mjs');
  await updateMessagingStore(current => {
    const g = current.conversations.find(entry => entry.id === `${page}:g`);
    g.customerOrders = []; g.labels = []; g.botEnabled = true; delete g.promo; delete g.followUps;
    current.messages[`${page}:g`] = [message('incoming', now - 40 * HOUR, { text: 'shop ơi mình đã nhận hàng rồi nha, ngon lắm' }), message('outgoing', now - 39 * HOUR, { text: 'Dạ em cảm ơn chị ạ' })];
    const a = current.conversations.find(entry => entry.id === `${page}:a`);
    a.customerOrders = []; a.labels = []; delete a.promo; delete a.followUps;
    current.messages[`${page}:a`] = [message('incoming', now - 40 * HOUR, { text: 'ok' }), message('outgoing', now - 39 * HOUR, { type: 'order-receipt', text: 'Đã gửi xác nhận đơn hàng' })];
    return null;
  });
  const store = await readMessagingStore();
  const scenario = { id: 'trial', trigger: 'inbox-no-reply', delayHours: 36, outsideWindow: true, freeShipDays: 7 };
  const psids = findFollowUpCandidates(store, scenario, { now, activatedAt: now - 7 * 24 * HOUR }).map(item => item.conversation.psid);
  assert.ok(!psids.includes('g'), 'khách nói đã nhận hàng');
  assert.ok(!psids.includes('a'), 'Page đã gửi phiếu đơn');
});

test('nhóm đối chứng 10%: băm psid cố định, ~10% khách không được gửi, trạng thái báo lift', async () => {
  const { isFollowUpHoldout } = await import('../app/follow-up.mjs');
  const psids = Array.from({ length: 2000 }, (_, i) => String(28000000000000000 + i * 7919));
  const share = psids.filter(isFollowUpHoldout).length / psids.length;
  assert.ok(share > 0.07 && share < 0.13, `tỷ lệ đối chứng ${share}`);
  assert.equal(isFollowUpHoldout('x'), isFollowUpHoldout('x'), 'cố định theo khách');
  const status = await followUpStatus();
  assert.ok(status.lift && typeof status.lift.sent.n === 'number' && typeof status.lift.holdout.n === 'number');
});

// Kịch bản hộp thư 3 giờ đang chạy thật (inbox-remind, mẫu FOLLOW_UP_INBOX_REMIND).
const remindSettings = normalizeChatbotSettings({ enabled: true, followUps: { enabled: true, scenarios: [{ id: 'inbox-remind', name: 'Hộp thư im 3 giờ', trigger: 'inbox-no-reply', delayHours: 3, templateId: 'FOLLOW_UP_INBOX_REMIND' }] } });
const resetState = () => writeFileSync(process.env.FOLLOW_UPS_PATH, JSON.stringify({ activatedAt: now - 48 * HOUR, sent: {} }));
const silentSince = (conversationId, current, extra = {}) => { current.messages[conversationId] = [message('incoming', now - 5 * HOUR, extra), message('outgoing', now - 4 * HOUR)]; };

test('mục 1: khách đã chọn túi (pendingOrder < 24 giờ) → nhắc giỏ bằng ORDER_ADDRESS_REMIND; bot mới hỏi vị (ASK_FLAVOR) hay giỏ quá 24 giờ → lời kịch bản như cũ', async () => {
  const { orderRemindText } = await import('../app/follow-up.mjs');
  const templates = remindSettings.messageTemplates;
  const pending = { items: [{ product: 'Granola Túi Vàng 350g', code: 'GRA-VANG-H350', quantity: 2 }], key: 'GRA-VANG-H350=2', at: now - 5 * HOUR, phone: '', address: '' };
  const text = orderRemindText({ gender: 'male', name: 'Huy Hoang', pendingOrder: pending, botLastTemplateId: 'ORDER_ADDRESS' }, templates, { now });
  assert.match(text, /đang giữ đơn 2 Granola Túi Vàng 350g – tổng 298\.000đ cho anh/, text);
  assert.match(text, /Anh gửi giúp em số điện thoại và địa chỉ nhận hàng đầy đủ/);
  assert.doesNotMatch(text, /phân vân/);
  // Đã có SĐT: chỉ xin địa chỉ; giới tính nữ → chị.
  assert.match(orderRemindText({ gender: 'female', pendingOrder: { ...pending, phone: '0909123456' } }, templates, { now }), /cho chị ạ .* Chị gửi giúp em địa chỉ nhận hàng đầy đủ/);
  // Giỏ quá hạn 2 giờ của bot (5 giờ) vẫn nhắc; quá 24 giờ, không giỏ, mẫu tắt thì không.
  assert.equal(orderRemindText({ pendingOrder: { ...pending, at: now - 25 * HOUR } }, templates, { now }), '', 'giỏ quá 24 giờ');
  assert.equal(orderRemindText({ pendingOrder: { ...pending, items: [] } }, templates, { now }), '', 'không có giỏ');
  assert.equal(orderRemindText({ pendingOrder: pending }, { ...templates, ORDER_ADDRESS_REMIND: '' }, { now }), '', 'mẫu tắt');
  assert.equal(orderRemindText({ pendingOrder: null }, templates, { now }), '');

  // Vòng gửi: H đã chọn 2 túi vàng, im 4 giờ → nhắc giỏ; K bot vừa hỏi vị (ASK_FLAVOR), không giỏ → lời kịch bản.
  const { updateMessagingStore } = await import('../app/messaging-store.mjs');
  await updateMessagingStore(current => {
    current.conversations.push(
      { id: `${page}:h`, pageId: page, psid: 'h', name: 'Huy Hoang', source: 'inbox', gender: 'male', genderSource: 'name', botLastTemplateId: 'ORDER_ADDRESS', botLastReplyAt: now - 4 * HOUR, pendingOrder: pending },
      { id: `${page}:k`, pageId: page, psid: 'k', name: 'Kim Anh', source: 'inbox', gender: 'female', genderSource: 'name', botLastTemplateId: 'ASK_FLAVOR', botLastReplyAt: now - 4 * HOUR, pendingOrder: null }
    );
    silentSince(`${page}:h`, current, { text: 'lấy 2 túi vàng' });
    silentSince(`${page}:k`, current, { text: 'cho mình 1 túi' });
    return null;
  });
  resetState();
  const fresh = await import(`../app/follow-up.mjs?remind=${Date.now()}`);
  const sent = [];
  const summary = await fresh.runFollowUps({ readSettings: async () => remindSettings, sendMessage: async (c, p) => { sent.push({ id: c.id, text: p.text }); return { message: { mid: 'x' } }; }, now, quietHours: false, log: () => {} });
  const byId = Object.fromEntries(sent.map(item => [item.id, item.text]));
  assert.match(byId[`${page}:h`], /^Dạ em vẫn đang giữ đơn 2 Granola Túi Vàng 350g – tổng 298\.000đ cho anh/, JSON.stringify(sent));
  assert.doesNotMatch(byId[`${page}:h`], /phân vân/);
  assert.match(byId[`${page}:k`], /^Dạ chị ơi, em thấy mình đang quan tâm granola/);
  assert.ok(summary.sent >= 2);
  const state = await fresh.readFollowUpState();
  assert.equal(state.sent[`inbox-remind:110:h`].templateId, 'ORDER_ADDRESS_REMIND', 'ghi lại đã nhắc bằng mẫu giỏ');
  assert.equal(state.sent[`inbox-remind:110:k`].templateId, undefined);
});

test('mục 2: bỏ qua khách khiếu nại / bảo hành / cần người xử lý, attention mở, bot vừa chuyển người, nhân viên đã nhắn sau tin khách, bot tắt — đếm theo lý do trong summary.skipReasons', async () => {
  const { followUpSkipReason } = await import('../app/follow-up.mjs');
  const inbox = extra => ({ id: 'p:q', pageId: 'p', psid: 'q', source: 'inbox', ...extra });
  const storeOf = (messages = []) => ({ conversations: [], messages: { 'p:q': messages } });
  const candidate = extra => ({ conversation: inbox(extra), inbox: inbox(extra), thread: null });
  assert.equal(followUpSkipReason(candidate({}), storeOf()), '');
  assert.equal(followUpSkipReason(candidate({ botEnabled: false }), storeOf()), 'botOff');
  for (const label of ['complaint', 'warranty', 'consulting', 'handoff']) assert.equal(followUpSkipReason(candidate({ labels: [label] }), storeOf()), 'label', label);
  assert.equal(followUpSkipReason(candidate({ labels: ['khieu-nai-rieng'] }), storeOf(), { skipLabelIds: ['khieu-nai-rieng'] }), 'label', 'thẻ theo cài đặt');
  assert.equal(followUpSkipReason(candidate({ labels: ['followup'] }), storeOf()), '');
  assert.equal(followUpSkipReason(candidate({ attention: true }), storeOf()), 'attention');
  assert.equal(followUpSkipReason(candidate({ attention: { open: true, at: now } }), storeOf()), 'attention');
  assert.equal(followUpSkipReason(candidate({ attention: { at: now - HOUR, closedAt: now } }), storeOf()), '', 'attention đã đóng');
  for (const id of ['CSKH_HANDOFF', 'ORDER_STATUS_CHECKING', 'COMMENT_STAFF_FOLLOWUP']) assert.equal(followUpSkipReason(candidate({ botLastTemplateId: id }), storeOf()), 'handoffTemplate', id);
  assert.equal(followUpSkipReason(candidate({ botLastTemplateId: 'PRICE_QUOTE' }), storeOf()), '');
  assert.equal(followUpSkipReason(candidate({}), storeOf([message('incoming', now - 5 * HOUR), message('outgoing', now - 4 * HOUR, { staff: true, staffName: 'Lan' })])), 'staffReplied');
  assert.equal(followUpSkipReason(candidate({}), storeOf([message('outgoing', now - 6 * HOUR, { staff: true }), message('incoming', now - 5 * HOUR), message('outgoing', now - 4 * HOUR)])), '', 'nhân viên nhắn TRƯỚC tin khách, bot trả lời sau: vẫn bám');
  // Luồng bình luận: thẻ / bot tắt ở luồng bình luận cũng tính.
  assert.equal(followUpSkipReason({ conversation: inbox({}), inbox: inbox({}), thread: { id: 't', labels: ['complaint'] } }, storeOf()), 'label');
  assert.equal(followUpSkipReason({ conversation: { id: 't', botEnabled: false }, inbox: null, thread: { id: 't', botEnabled: false } }, storeOf()), 'botOff');

  // Vòng gửi: sáu hộp thư im 4 giờ, mỗi hộp một lý do → không gửi, đếm đúng loại.
  const { updateMessagingStore } = await import('../app/messaging-store.mjs');
  const cases = { p: { labels: ['complaint'] }, q: { labels: ['consulting'] }, r: { attention: true }, s: { botLastTemplateId: 'CSKH_HANDOFF' }, t: {}, u: { botEnabled: false } };
  await updateMessagingStore(current => {
    for (const [psid, extra] of Object.entries(cases)) {
      current.conversations.push({ id: `${page}:${psid}`, pageId: page, psid, name: `Khách ${psid.toUpperCase()}`, source: 'inbox', gender: 'female', ...extra });
      silentSince(`${page}:${psid}`, current);
    }
    current.messages[`${page}:t`] = [message('incoming', now - 5 * HOUR), message('outgoing', now - 4 * HOUR, { staff: true, staffName: 'Lan', text: 'Dạ em gọi chị nha' })];
    return null;
  });
  resetState();
  const fresh = await import(`../app/follow-up.mjs?skip=${Date.now()}`);
  const sent = [];
  const summary = await fresh.runFollowUps({ readSettings: async () => remindSettings, sendMessage: async c => { sent.push(c.id); return { message: { mid: 'x' } }; }, now, quietHours: false, log: () => {} });
  for (const psid of Object.keys(cases)) assert.ok(!sent.includes(`${page}:${psid}`), `không gửi cho ${psid}`);
  // R14: hộp thư của các bước trước trong test này vừa nhận tin bám đuổi (followUps[] trên hội thoại, trạng thái đã
  // reset) → giờ bỏ qua 'sameCustomer' (một khách một tin trong 12 giờ) thay vì gửi lại; không thuộc sáu ca đang xét.
  const { sameCustomer = 0, ...reasons } = summary.skipReasons;
  assert.deepEqual(reasons, { label: 2, attention: 1, handoffTemplate: 1, staffReplied: 1, botOff: 1 });
  assert.equal(summary.skipped, 6 + sameCustomer);
});

test('mục 3: xưng hô theo conversation.gender — nam "anh", nữ "chị", chưa rõ "anh/chị"; "anh/chị" viết sẵn trong mẫu cũng đổi (ca Huy Hoang: gender male → anh)', () => {
  const template = 'Dạ {title} ơi, {Title} còn phân vân không ạ? Em gửi anh/chị bảng giá, Anh/chị xem nha.';
  assert.equal(renderFollowUpMessage(template, { gender: 'male', genderSource: 'name', name: 'Huy Hoang' }), 'Dạ anh ơi, Anh còn phân vân không ạ? Em gửi anh bảng giá, Anh xem nha.');
  assert.equal(renderFollowUpMessage(template, { gender: 'female', genderSource: 'pancake', name: 'Huy Hoang' }), 'Dạ chị ơi, Chị còn phân vân không ạ? Em gửi chị bảng giá, Chị xem nha.');
  // gender undefined: KHÔNG được lấy giới tính khách trước còn trong trạng thái module chatbot-templates (lỗi từng ra "chị").
  for (const gender of ['', undefined, 'other']) assert.equal(renderFollowUpMessage(template, { gender }), 'Dạ anh/chị ơi, Anh/chị còn phân vân không ạ? Em gửi anh/chị bảng giá, Anh/chị xem nha.', `gender=${gender}`);
  // Mẫu FOLLOW_UP_INBOX_REMIND thật với khách nam.
  const live = remindSettings.messageTemplates.FOLLOW_UP_INBOX_REMIND;
  assert.match(renderFollowUpMessage(live, { gender: 'male' }), /^Dạ anh ơi, .* Anh còn phân vân/);
  assert.doesNotMatch(renderFollowUpMessage(live, { gender: 'male' }), /chị/);
});

test('mục 4: tra Pancake/POS lỗi → hoãn (không coi là chưa có đơn); đơn 14 ngày ở hội thoại chị em hay trùng tên → không gửi; kịch bản 3 giờ mang mẫu ưu đãi chỉ gửi lời nhắc, không đặt promo', async () => {
  const { recentOrderElsewhere } = await import('../app/follow-up.mjs');
  const DAY = 24 * HOUR;
  // Đơn ở luồng bình luận cùng khách (cùng Page + psid), đơn trùng tên (≥ 2 chữ), đơn hủy / quá 14 ngày / tên 1 chữ thì không.
  const me = { id: 'x:1', pageId: 'x', psid: '1', name: 'Phan Kim' };
  const storeWith = (...others) => ({ conversations: [me, ...others] });
  assert.match(recentOrderElsewhere(storeWith({ id: 'x:comment:1', pageId: 'x', psid: '1', customerOrders: [{ id: 'o', createdAt: now - 2 * DAY }] }), me, now), /hội thoại khác/);
  assert.equal(recentOrderElsewhere(storeWith({ id: 'x:comment:1', pageId: 'x', psid: '1', customerOrders: [{ id: 'o', createdAt: now - 2 * DAY, processingStatus: 'cancelled' }] }), me, now), '', 'đơn hủy');
  assert.equal(recentOrderElsewhere(storeWith({ id: 'x:comment:1', pageId: 'x', psid: '1', customerOrders: [{ id: 'o', createdAt: now - 20 * DAY }] }), me, now), '', 'quá 14 ngày');
  assert.match(recentOrderElsewhere(storeWith({ id: 'x:9', pageId: 'x', psid: '9', name: 'Ai đó', customerOrders: [{ id: 'o', name: 'phan  kim', createdAt: now - 3 * DAY }] }), me, now), /trùng tên/);
  assert.equal(recentOrderElsewhere(storeWith({ id: 'x:9', pageId: 'x', psid: '9', customerOrders: [{ id: 'o', name: 'Kim', createdAt: now - 3 * DAY }] }), { ...me, name: 'Kim' }, now), '', 'tên 1 chữ không so');
  assert.equal(recentOrderElsewhere(storeWith(), me, now), '');

  const trial = normalizeChatbotSettings({ enabled: true, followUps: { enabled: true, scenarios: [{ id: 'inbox-trial-freeship', name: 'Dùng thử', trigger: 'inbox-no-reply', delayHours: 3, templateId: 'FOLLOW_UP_TRIAL_FREESHIP', freeShipDays: 7 }] } });
  const { updateMessagingStore } = await import('../app/messaging-store.mjs');
  await updateMessagingStore(current => {
    // V: vừa mua 3 túi ở POS, đơn gắn vào luồng bình luận (không nằm trong hộp thư). W: đơn trùng tên ở hội thoại khác. Y: khách mới thật.
    current.conversations.push(
      { id: `${page}:v`, pageId: page, psid: 'v', name: 'Phan Kim', source: 'inbox', gender: 'female' },
      { id: `${page}:comment:v:p1`, pageId: page, psid: 'v', name: 'Phan Kim', source: 'comment', customerOrders: [{ id: 'pos1', name: 'Phan Kim', createdAt: now - 2 * DAY, total: 447000, source: 'POS' }] },
      { id: `${page}:w`, pageId: page, psid: 'w', name: 'Trần Thu Hà', source: 'inbox', gender: 'female' },
      { id: `${page}:z`, pageId: page, psid: 'z', name: 'Hà Trần', source: 'inbox', customerOrders: [{ id: 'ld1', name: 'Trần Thu Hà', createdAt: now - 3 * DAY, total: 298000 }] },
      { id: `${page}:y`, pageId: page, psid: 'y', name: 'Lê Văn Yên', source: 'inbox', gender: 'male' }
    );
    for (const psid of ['v', 'w', 'y']) silentSince(`${page}:${psid}`, current);
    return null;
  });
  resetState();
  const fresh = await import(`../app/follow-up.mjs?trial14=${Date.now()}`);
  const sent = [];
  const texts = {};
  const run = options => fresh.runFollowUps({ readSettings: async () => trial, sendMessage: async (c, payload) => { sent.push(c.id); texts[c.id] = payload.text; return { message: { mid: 'x' } }; }, now, quietHours: false, log: () => {}, ...options });
  // Chủ shop 01/10: ưu đãi chỉ ở kịch bản 36 giờ. Kịch bản 3 giờ mang mẫu ưu đãi + freeShipDays chỉ là
  // lời NHẮC: không chào ưu đãi, không đặt promo. (Kịch bản 36 giờ luôn quá 24 giờ của Messenger → đi hàng
  // chờ trạm gửi, tra Pancake/POS lúc lập lô — xem test "ngoài 24 giờ".)
  // 1) Tra Pancake/POS lỗi: không gửi mù (hoãn).
  const first = await run({ conversationInfo: async () => { throw new Error('Pancake 500'); } });
  // (Khách đang giữ giỏ của test trước vẫn được nhắc giỏ — nhắc giỏ không cần tra.)
  assert.ok(!sent.includes(`${page}:y`) && !sent.includes(`${page}:v`) && !sent.includes(`${page}:w`), JSON.stringify(sent));
  assert.ok(first.deferred >= 1, JSON.stringify(first));
  // Khách vừa mua (đơn ở luồng chị em / trùng tên) vẫn bị loại theo kho CRM.
  assert.equal(first.returning, 2);
  let state = await fresh.readFollowUpState();
  assert.match(state.sent['inbox-trial-freeship:110:v'].error, /hội thoại khác/);
  assert.match(state.sent['inbox-trial-freeship:110:w'].error, /trùng tên/);
  assert.equal(state.sent['inbox-trial-freeship:110:y'], undefined);
  // 2) Tra được, khách mới: gửi lời NHẮC (không phải lời ưu đãi), không đặt promo.
  const second = await run({ conversationInfo: async () => ({ succeedOrderCount: 0, recentOrders: 0, posOrders: 0, crmOrders: 0 }) });
  assert.ok(sent.includes(`${page}:y`), JSON.stringify({ second, sent }));
  assert.ok(!sent.includes(`${page}:v`) && !sent.includes(`${page}:w`));
  // Lời nhắc hộp thư (FOLLOW_UP_INBOX_REMIND: giá combo thường), không phải ưu đãi 1 túi dùng thử.
  assert.match(texts[`${page}:y`], /phân vân/);
  assert.doesNotMatch(texts[`${page}:y`], /ưu đãi|dùng thử|1 Túi/i, texts[`${page}:y`]);
  state = await fresh.readFollowUpState();
  assert.equal(state.sent['inbox-trial-freeship:110:y'].via, 'private');
  const y = (await readMessagingStore()).conversations.find(entry => entry.id === `${page}:y`);
  assert.equal(y.promo, undefined, 'kịch bản 3 giờ không đặt promo');
});
