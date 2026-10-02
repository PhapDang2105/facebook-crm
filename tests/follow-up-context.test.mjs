// Bám đuổi (01/10): #551 / ngoài 24 giờ không ăn trần mỗi lượt, tắt riêng bám đuổi bình luận, dọn hàng
// chờ quá 7 ngày, và tin bám đuổi theo ngữ cảnh khách (giỏ đang giữ, dừng/hủy, "OK bạn", yến mạch…).
import test from 'node:test';
import assert from 'node:assert/strict';
import { utimesSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tempDir } from './helpers/temp-dir.mjs';
import './helpers/seed-catalog.mjs';

const directory = tempDir('followup-ctx-');
process.env.META_CONVERSATIONS_PATH = path.join(directory, 'meta-conversations.json');
process.env.FOLLOW_UPS_PATH = path.join(directory, 'follow-ups.json');
process.env.INBOX_SETTINGS_PATH = path.join(directory, 'inbox-settings.json');

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
// 10:00 giờ VN (ngoài giờ yên tĩnh).
const now = Date.parse('2026-09-30T03:00:00Z');
const page = '110';
const message = (direction, createdAt, extra = {}) => ({ id: `m${createdAt}${direction}${extra.id || ''}`, mid: '', direction, type: 'text', text: 'x', createdAt, status: 'sent', ...extra });

writeFileSync(process.env.META_CONVERSATIONS_PATH, JSON.stringify({ conversations: [], messages: {}, commentIndex: {} }));
const { normalizeChatbotSettings } = await import('../app/chatbot-settings.mjs');
const { readMessagingStore } = await import('../app/messaging-store.mjs');
const followUp = await import('../app/follow-up.mjs');

// psid không rơi vào nhóm đối chứng 10% (nhóm đó không bao giờ được gửi).
const psids = Array.from({ length: 200 }, (_, index) => `u${index}`).filter(id => !followUp.isFollowUpHoldout(id));
let psidCursor = 0;
const nextPsid = () => psids[psidCursor++];

let seedCount = 0;
function seedStore(store) {
  writeFileSync(process.env.META_CONVERSATIONS_PATH, JSON.stringify({ messages: {}, commentIndex: {}, ...store }));
  // Mốc sửa khác hẳn mọi lần trước: kho trong bộ nhớ biết tệp vừa bị ghi từ ngoài và đọc lại.
  seedCount += 1;
  const at = new Date(Date.now() + 60_000 + seedCount * 1000);
  utimesSync(process.env.META_CONVERSATIONS_PATH, at, at);
}
const seedState = (state = {}) => writeFileSync(process.env.FOLLOW_UPS_PATH, JSON.stringify({ activatedAt: now - 48 * HOUR, sent: {}, ...state }));
let freshCount = 0;
const fresh = () => import(`../app/follow-up.mjs?ctx=${(freshCount += 1)}`);
const settingsWith = (scenarios, extra = {}) => normalizeChatbotSettings({ enabled: true, followUps: { enabled: true, scenarios, ...extra } });
const askScenario = { id: 'inbox-ask', name: 'Hộp thư im 3 giờ', trigger: 'inbox-no-reply', delayHours: 3, message: 'Dạ {title} còn cần em tư vấn thêm gì không ạ?' };
const inbox = (psid, extra = {}) => ({ id: `${page}:${psid}`, pageId: page, psid, name: `Khách ${psid}`, source: 'inbox', ...extra });

test('#551: khách không nhận được tin → bỏ qua vĩnh viễn (tới khi khách nhắn lại), KHÔNG tính vào trần mỗi lượt', async () => {
  const blocked = nextPsid();
  const ok = nextPsid();
  seedStore({
    conversations: [inbox(blocked), inbox(ok)],
    messages: {
      // Khách bị chặn im lâu hơn → xét trước, trước đây ăn hết trần maxPerRun = 1.
      [`${page}:${blocked}`]: [message('incoming', now - 7 * HOUR), message('outgoing', now - 6 * HOUR)],
      [`${page}:${ok}`]: [message('incoming', now - 5 * HOUR), message('outgoing', now - 4 * HOUR)]
    }
  });
  seedState();
  const module = await fresh();
  const sent = [];
  const sendMessage = async conversation => {
    if (conversation.psid === blocked) throw new Error("Pancake không nhận tin (200): (#551) This person isn't available right now.");
    sent.push(conversation.psid);
    return { message: { mid: 'x' } };
  };
  const first = await module.runFollowUps({ readSettings: async () => settingsWith([askScenario], { maxPerRun: 1 }), sendMessage, now, log: () => {} });
  assert.deepEqual(sent, [ok], 'khách gửi được vẫn nhận tin dù khách trước lỗi #551');
  assert.equal(first.sent, 1);
  assert.equal(first.failed, 0, '#551 không tính là lỗi ăn trần');
  assert.equal(first.undeliverable, 1);
  assert.equal(first.skipReasons.undeliverable, 1);
  const state = await module.readFollowUpState();
  assert.equal(state.undeliverable[`${page}:${blocked}`].scenarioId, 'inbox-ask');
  // Kịch bản khác, lượt sau: khách bị chặn bỏ qua ngay, không gọi gửi.
  const calls = [];
  const second = await module.runFollowUps({
    readSettings: async () => settingsWith([{ ...askScenario, id: 'inbox-ask-2', message: 'Dạ {title} ơi, em hỏi thăm ạ' }]),
    sendMessage: async conversation => { calls.push(conversation.psid); return { message: { mid: 'y' } }; },
    now: now + HOUR, log: () => {}
  });
  assert.deepEqual(calls, [ok]);
  assert.equal(second.skipReasons.undeliverable, 1);
  assert.equal(followUp.isUndeliverableError(new Error('Pancake không nhận tin (400): {"code":551,"message":"x"}')), true);
  assert.equal(followUp.isUndeliverableError(new Error('Pancake không nhận tin (500): Internal')), false, 'lỗi tạm thì không chặn vĩnh viễn');
});

test('bám đuổi bình luận: hộp thư chưa mở cửa sổ 24 giờ (chỉ có tin nhắn riêng của Page) và kịch bản không cho công khai → không gọi API, bỏ qua một lần; tắt riêng bám đuổi bình luận', async () => {
  const psid = nextPsid();
  const thread = { id: `${page}:comment:${psid}:p1`, pageId: page, psid, name: 'Chị Bình Luận', source: 'comment', lastCommentId: 'c1' };
  seedStore({
    conversations: [thread, inbox(psid, { name: 'Chị Bình Luận' })],
    messages: {
      [thread.id]: [message('incoming', now - 14 * HOUR)],
      [`${page}:${psid}`]: [message('outgoing', now - 13 * HOUR, { privateReply: true })]
    }
  });
  seedState();
  const comment = { id: 'comment-x', name: 'Bình luận im', trigger: 'comment-no-reply', delayHours: 12, publicFallback: false, message: 'Dạ {title} ơi, em gửi ưu đãi ạ' };
  const calls = [];
  const sendMessage = async conversation => { calls.push(conversation.id); return { message: { mid: 'z' } }; };
  const module = await fresh();
  const summary = await module.runFollowUps({ readSettings: async () => settingsWith([comment], { maxPerRun: 1 }), sendMessage, now, log: () => {} });
  assert.deepEqual(calls, [], 'không gửi vào hộp thư chắc chắn bị #551');
  assert.equal(summary.skipReasons.outsideWindow, 1);
  assert.equal(summary.failed, 0);
  assert.equal((await module.readFollowUpState()).sent[`comment-x:${page}:${psid}`].skipped, 'outsideWindow');
  // Khách nhắn hộp thư 2 giờ trước rồi Page trả lời bình luận: cửa sổ mở → được gửi riêng.
  assert.equal(followUp.inboxWindowOpen({ messages: { [`${page}:${psid}`]: [message('incoming', now - 2 * HOUR)] } }, inbox(psid), now), true);
  assert.equal(followUp.inboxWindowOpen({ messages: { [`${page}:${psid}`]: [message('outgoing', now - 2 * HOUR)] } }, inbox(psid), now), false);
  // Tắt riêng bám đuổi bình luận: kịch bản bình luận đứng yên, kịch bản hộp thư vẫn chạy.
  seedState();
  const off = await (await fresh()).runFollowUps({ readSettings: async () => settingsWith([comment], { commentEnabled: false }), sendMessage, now, log: () => {} });
  assert.equal(off.checked, 0);
  assert.equal(normalizeChatbotSettings({}).followUps.commentEnabled, true, 'mặc định giữ hành vi cũ');
  assert.equal(normalizeChatbotSettings({ followUps: { commentEnabled: false } }).followUps.commentEnabled, false);
});

test('hàng chờ ngoài 24 giờ: mục quá 7 ngày dọn mỗi lượt (kể cả khi bám đuổi tắt), mục mới và mục đang trong lô giữ nguyên', async () => {
  seedStore({ conversations: [], messages: {} });
  seedState({ sent: {
    'a:110:old': { queued: true, conversationId: '110:old', repliedAt: now - 8 * DAY, at: now - 8 * DAY, pageId: '110', psid: 'old', text: 'x' },
    'a:110:new': { queued: true, conversationId: '110:new', repliedAt: now - 2 * DAY, at: now - 2 * DAY, pageId: '110', psid: 'new', text: 'x' },
    'a:110:lease': { queued: true, conversationId: '110:lease', repliedAt: now - 9 * DAY, at: now - 9 * DAY, leasedUntil: now + HOUR, pageId: '110', psid: 'lease', text: 'x' },
    'a:110:done': { conversationId: '110:done', at: now - 20 * DAY }
  } });
  const module = await fresh();
  const summary = await module.runFollowUps({ readSettings: async () => normalizeChatbotSettings({ enabled: true, followUps: { enabled: false } }), sendMessage: async () => { throw new Error('không được gửi'); }, now, log: () => {} });
  assert.equal(summary.disabled, true);
  assert.equal(summary.expired, 1);
  const state = await module.readFollowUpState();
  assert.equal(state.sent['a:110:old'].queued, undefined);
  assert.equal(state.sent['a:110:old'].error, 'quá 7 ngày trong hàng chờ');
  assert.equal(state.sent['a:110:new'].queued, true);
  assert.equal(state.sent['a:110:lease'].queued, true, 'đang nằm trong lô của trạm gửi');
  assert.equal(await module.expireFollowUpQueue({ now }), 0, 'chạy lại không còn gì');
});

test('lý do không bám (01/10): tin cuối chỉ dấu câu/emoji, khách bảo khoan giao / hủy, "OK bạn" rồi Page cảm ơn; đang giữ giỏ thì thẻ cần người xử lý / attention không chặn, khiếu nại vẫn chặn', () => {
  const conversation = extra => ({ id: 'p:q', pageId: 'p', psid: 'q', source: 'inbox', ...extra });
  const candidate = extra => ({ conversation: conversation(extra), inbox: conversation(extra), thread: null });
  const storeOf = (...messages) => ({ conversations: [], messages: { 'p:q': messages } });
  const reason = (messages, extra = {}, options = {}) => followUp.followUpSkipReason(candidate(extra), storeOf(...messages), { now, ...options });
  for (const text of ['.', '..,', '👍', '😍😍', ' ? ']) {
    assert.equal(reason([message('incoming', now - 5 * HOUR, { text }), message('outgoing', now - 4 * HOUR)]), 'customerTrivial', text);
  }
  assert.equal(reason([message('incoming', now - 5 * HOUR, { text: 'ok 2 túi vàng nhé' }), message('outgoing', now - 4 * HOUR)]), '');
  for (const text of ['Khoan giao nha em', 'em hủy đơn giúp chị', 'thôi chị không lấy nữa', 'đừng gửi nhé']) {
    assert.equal(reason([message('incoming', now - 6 * HOUR, { text }), message('outgoing', now - 5 * HOUR), message('incoming', now - 5 * HOUR, { text: 'à mà shop ơi' }), message('outgoing', now - 4 * HOUR)]), 'customerDeclined', text);
  }
  assert.equal(reason([message('incoming', now - 5 * HOUR, { text: 'Anh Huy đặt giúp em 2 túi' }), message('outgoing', now - 4 * HOUR)]), '', 'tên "Huy" không phải "hủy"');
  // "OK bạn" → bot cảm ơn → không bám nữa (7 giờ sau từng bị bám).
  const closed = [message('incoming', now - 8 * HOUR, { text: 'OK bạn' }), message('outgoing', now - 7.9 * HOUR, { text: 'Dạ em cảm ơn chị nhiều ạ 💛' })];
  assert.equal(reason(closed), 'customerClosed');
  assert.equal(reason([message('incoming', now - 8 * HOUR, { text: 'ok' }), message('outgoing', now - 7.9 * HOUR, { text: 'Dạ vâng ạ' })], { botLastTemplateId: 'THANK_YOU' }), 'customerClosed');
  assert.equal(reason([message('incoming', now - 8 * HOUR, { text: 'ok' }), message('outgoing', now - 7.9 * HOUR, { text: 'Dạ chị cho em xin SĐT ạ' })]), '', 'ok chưa khép hội thoại');
  // Đang giữ giỏ: bot gắn "cần người xử lý" khi nhắc giỏ / attention → vẫn nhắc; khiếu nại thì không.
  const quiet = [message('incoming', now - 5 * HOUR, { text: 'lấy 2 túi vàng' }), message('outgoing', now - 4 * HOUR)];
  assert.equal(reason(quiet, { labels: ['consulting'], attention: true, botLastTemplateId: 'CSKH_HANDOFF' }), 'label', 'không giữ giỏ: như cũ');
  assert.equal(reason(quiet, { labels: ['consulting'], attention: true, botLastTemplateId: 'CSKH_HANDOFF' }, { basketHeld: true }), '');
  assert.equal(reason(quiet, { labels: ['complaint'] }, { basketHeld: true }), 'label');
  assert.equal(reason([...quiet, message('outgoing', now - 3 * HOUR, { staff: true })], {}, { basketHeld: true }), 'staffReplied', 'nhân viên đã trả lời thì thôi');
});

test('lời theo ngữ cảnh: khách hỏi yến mạch thì không bám bằng câu granola; xưng hô theo cách Page đang gọi khách', async () => {
  const psid = nextPsid();
  seedStore({
    conversations: [inbox(psid, { gender: '', botLastTemplateId: 'PRICE_YEN_MACH_UC_NGUYEN_CAM' })],
    messages: { [`${page}:${psid}`]: [message('incoming', now - 5 * HOUR, { text: 'Yến mạch úc giá sao shop' }), message('outgoing', now - 4 * HOUR, { text: 'Dạ yến mạch Úc nguyên cám giá … ạ' })] }
  });
  seedState();
  const granola = { id: 'inbox-granola', name: 'Mời granola', trigger: 'inbox-no-reply', delayHours: 3, templateId: 'FOLLOW_UP_INBOX_REMIND' };
  const calls = [];
  const summary = await (await fresh()).runFollowUps({ readSettings: async () => settingsWith([granola]), sendMessage: async conversation => { calls.push(conversation.id); return { message: { mid: 'g' } }; }, now, log: () => {} });
  assert.deepEqual(calls, []);
  assert.equal(summary.skipReasons.productMismatch, 1);
  assert.deepEqual([...followUp.productFamiliesIn('Granola túi vàng có yến mạch không')].sort(), ['granola', 'yenmach']);
  // Biến thể nói đúng dòng khách hỏi được chọn.
  const families = new Set(['yenmach']);
  assert.match(followUp.renderFollowUpMessage('Dạ {title} ơi, granola nhà em…###Dạ {title} ơi, yến mạch Úc nhà em…', {}, () => 0, { families }), /yến mạch/);
  // Xưng hô: Page đang gọi "chị" thì tin bám đuổi gọi "chị" dù chưa đoán được giới tính; botGender thắng.
  const pageCallsChi = [message('incoming', now - 5 * HOUR), message('outgoing', now - 4 * HOUR, { text: 'Dạ chị cần em tư vấn thêm gì không ạ' })];
  assert.match(followUp.renderFollowUpMessage('Dạ {title} ơi', {}, Math.random, { messages: pageCallsChi }), /^Dạ chị ơi/);
  assert.match(followUp.renderFollowUpMessage('Dạ {title} ơi', { botGender: 'male' }, Math.random, { messages: pageCallsChi }), /^Dạ anh ơi/);
  assert.equal(followUp.honorificFromPageMessages([message('outgoing', 1, { text: 'Dạ anh/chị cho em xin SĐT ạ' })]), '');
});

test('giỏ đang giữ: khách quen (thẻ Đã mua, đơn cũ) + thẻ cần người xử lý vẫn được nhắc giỏ, không tra Pancake/POS; nhắc xong giỏ được giữ thêm (pendingOrder.at = lúc nhắc)', async () => {
  const psid = nextPsid();
  const pending = { items: [{ product: 'Granola Túi Vàng 350g', code: 'GRA-VANG-H350', quantity: 2 }], key: 'GRA-VANG-H350=2', at: now - 5 * HOUR, phone: '', address: '' };
  seedStore({
    conversations: [inbox(psid, { gender: 'female', labels: ['customer', 'consulting'], attention: true, botLastTemplateId: 'ORDER_ADDRESS_REMIND', pendingOrder: pending,
      customerOrders: [{ id: 'old-1', createdAt: now - 40 * DAY, total: 298000, status: 'Đã giao' }] })],
    messages: { [`${page}:${psid}`]: [
      message('outgoing', now - 40 * DAY, { type: 'order-receipt', text: 'Đã gửi xác nhận đơn hàng' }),
      message('incoming', now - 5 * HOUR, { text: 'lấy 2 túi vàng' }),
      message('outgoing', now - 4 * HOUR, { text: 'Dạ chị cho em xin SĐT và địa chỉ ạ' })
    ] }
  });
  seedState();
  const sent = [];
  let lookups = 0;
  const summary = await (await fresh()).runFollowUps({
    readSettings: async () => settingsWith([{ id: 'inbox-remind', name: 'Nhắc', trigger: 'inbox-no-reply', delayHours: 3, templateId: 'FOLLOW_UP_INBOX_REMIND' }]),
    sendMessage: async (conversation, payload) => { sent.push(payload.text); return { message: { mid: 'r' } }; },
    conversationInfo: async () => { lookups += 1; return { succeedOrderCount: 3 }; },
    now, log: () => {}
  });
  assert.equal(summary.sent, 1, JSON.stringify(summary));
  assert.match(sent[0], /^Dạ em vẫn đang giữ đơn 2 Granola Túi Vàng 350g/);
  assert.match(sent[0], /cho chị/);
  assert.equal(lookups, 0, 'nhắc giỏ là chăm sóc đơn: không lọc khách quen');
  const stored = (await readMessagingStore()).conversations.find(item => item.id === `${page}:${psid}`);
  // touchPendingOrder: remindedAt = lúc nhắc → giỏ đã nhắc dùng được 24 giờ (giỏ thường chỉ 2 giờ từ `at`).
  assert.equal(stored.pendingOrder.remindedAt, now, 'giỏ giữ thêm từ lúc nhắc');
  const { pendingOrderExpiresAt } = await import('../app/processing/pending-order.mjs');
  assert.equal(pendingOrderExpiresAt(stored.pendingOrder), now + DAY);
  assert.equal(stored.pendingOrder.items[0].quantity, 2);
  // Giỏ cũ hơn đơn cuối (đơn vừa chốt sau khi chọn giỏ): không nhắc.
  assert.equal(followUp.basketAfterOrders({ pendingOrder: pending, customerOrders: [{ id: 'n', createdAt: now - HOUR }] }, [], now), false);
  assert.equal(followUp.basketAfterOrders({ pendingOrder: pending, customerOrders: [{ id: 'o', createdAt: now - 40 * DAY }] }, [], now), true);
});

test('tin nhắc giỏ: bot đã hỏi phường/xã một lần thì tin nhắc vẫn nêu đúng phần còn thiếu (R13: trước là lời nhắc chung)', () => {
  const templates = normalizeChatbotSettings({ enabled: true }).messageTemplates;
  const pending = { items: [{ product: 'Granola Túi Vàng 350g', code: 'GRA-VANG-H350', quantity: 2 }], key: 'k', at: now - HOUR, phone: '0909123456', address: '12 Lê Lợi, Hồ Chí Minh' };
  const first = followUp.orderRemindText({ gender: 'female', pendingOrder: { ...pending, addressAsks: 0 } }, templates, { now });
  assert.match(first, /phường\/xã/, 'chưa hỏi lần nào: nêu đúng phần thiếu');
  const again = followUp.orderRemindText({ gender: 'female', pendingOrder: { ...pending, addressAsks: 1 } }, templates, { now });
  assert.match(again, /^Dạ em vẫn đang giữ đơn 2 Granola Túi Vàng 350g/);
  // R13 (02/10, inbox2 C2) — sửa khẳng định cũ (không nêu phường/quận, chỉ "nhắn em khi tiện"): lời nhắc chung không cho
  // khách biết đơn chỉ còn thiếu đúng phường/xã, và khi bot đã hỏi hết lượt thì tin nhắc RỖNG (giỏ đủ SĐT + địa chỉ thiếu
  // phường không bao giờ được bám). Nay tin nhắc luôn nêu đúng phần còn thiếu.
  assert.match(again, /gửi giúp em .*phường\/xã/);
  assert.doesNotMatch(again, /nhắn em khi tiện/);
  // Thiếu SĐT (không phải phường/xã): vẫn xin SĐT như cũ.
  assert.match(followUp.orderRemindText({ gender: 'female', pendingOrder: { ...pending, phone: '', addressAsks: 1 } }, templates, { now }), /gửi giúp em số điện thoại/);
});

test('ưu đãi chỉ ở kịch bản 36 giờ (chủ shop 01/10): kịch bản 3h/12h không đặt promo/trial và không chào ưu đãi; kịch bản 36h vẫn như cũ', async () => {
  const templates = normalizeChatbotSettings({ enabled: true }).messageTemplates;
  // Kịch bản mặc định "bình luận 12 giờ" dùng mẫu miễn ship dùng thử → đổi sang lời nhắc.
  const [comment12] = normalizeChatbotSettings({ enabled: true, followUps: { enabled: true } }).followUps.scenarios;
  assert.equal(comment12.delayHours, 12);
  const commentPlan = followUp.followUpPlan(comment12, templates);
  assert.equal(commentPlan.scenario.freeShipDays, 0);
  assert.doesNotMatch(commentPlan.template, /miễn phí vận chuyển|ưu đãi|dùng thử/i);
  assert.match(commentPlan.template, /\{title\}/);
  // Hộp thư 3 giờ mang mẫu dùng thử + freeShipDays → lời nhắc hộp thư, không tặng ngày miễn ship nào.
  const inbox3 = followUp.followUpPlan({ id: 'x', trigger: 'inbox-no-reply', delayHours: 3, templateId: 'FOLLOW_UP_TRIAL_FREESHIP', freeShipDays: 7 }, templates);
  assert.equal(inbox3.scenario.freeShipDays, 0);
  assert.equal(inbox3.template, templates.FOLLOW_UP_INBOX_REMIND);
  // 36 giờ: giữ nguyên ưu đãi.
  const trial36 = followUp.followUpPlan({ id: 't', trigger: 'inbox-no-reply', delayHours: 36, templateId: 'FOLLOW_UP_TRIAL_FREESHIP', freeShipDays: 7, outsideWindow: true }, templates);
  assert.equal(trial36.scenario.freeShipDays, 7);
  assert.equal(trial36.template, templates.FOLLOW_UP_TRIAL_FREESHIP);
  assert.equal(followUp.scenarioOfferDays({ delayHours: 35, freeShipDays: 7 }), 0);
  assert.equal(followUp.scenarioOfferDays({ delayHours: 36, freeShipDays: 7 }), 7);

  // Chạy thật: khách bình luận 12 giờ (trả lời công khai) → không promo; hàng chờ 36 giờ "Đã gửi" → promo như cũ.
  const psid = nextPsid();
  const thread = { id: `${page}:comment:${psid}:p9`, pageId: page, psid, name: 'Chị Mười Hai', source: 'comment', lastCommentId: 'c9' };
  const later = nextPsid();
  seedStore({
    conversations: [thread, inbox(later, { name: 'Anh Ba Sáu' })],
    messages: {
      [thread.id]: [message('incoming', now - 14 * HOUR, { text: 'giá sao' }), message('outgoing', now - 13 * HOUR, { text: 'Dạ em ib chị ạ' })],
      [`${page}:${later}`]: [message('incoming', now - 40 * HOUR, { text: 'còn hàng không' }), message('outgoing', now - 39 * HOUR, { text: 'Dạ còn ạ' })]
    }
  });
  seedState();
  const sent = [];
  const module = await fresh();
  const settings = normalizeChatbotSettings({ enabled: true, followUps: { enabled: true, scenarios: [
    { ...comment12 },
    { id: 'trial-36', name: 'Dùng thử 36 giờ', trigger: 'inbox-no-reply', delayHours: 36, templateId: 'FOLLOW_UP_TRIAL_FREESHIP', outsideWindow: true, freeShipDays: 7 }
  ] } });
  const summary = await module.runFollowUps({ readSettings: async () => settings, sendMessage: async (conversation, payload) => { sent.push({ id: conversation.id, text: payload.text }); return { message: { mid: 'p' } }; }, now, log: () => {} });
  assert.deepEqual(sent.map(item => item.id), [thread.id], JSON.stringify(summary));
  assert.doesNotMatch(sent[0].text, /miễn phí vận chuyển|ưu đãi|dùng thử/i);
  let store = await readMessagingStore();
  assert.equal(store.conversations.find(item => item.id === thread.id).promo, undefined, 'kịch bản 12 giờ không đặt promo');
  assert.equal(summary.queued, 1, 'kịch bản 36 giờ xếp hàng chờ trạm gửi');
  const [queued] = await module.followUpQueue({ now });
  assert.match(queued.text, /ưu đãi riêng/);
  assert.equal(await module.resolveFollowUpQueueItem(queued.key, 'sent', { readSettings: async () => settings, now }), true);
  store = await readMessagingStore();
  const promo = store.conversations.find(item => item.id === `${page}:${later}`).promo;
  assert.equal(promo.freeShipping, true);
  assert.equal(promo.stage, 'offered');
  assert.equal(promo.until, now + 7 * DAY);
  // Tin xếp hàng từ bản cũ của một kịch bản 24 giờ (có ghi freeShipDays): "Đã gửi" không bật ưu đãi nữa.
  seedState({ sent: { 'old-24:110:zz': { scenarioId: 'old-24', conversationId: `${page}:${later}`, at: now, repliedAt: now - 30 * HOUR, queued: true, text: 'x', pageId: page, psid: later, freeShipDays: 7 } } });
  seedStore({ conversations: [inbox(later)], messages: {} });
  const legacy = await fresh();
  const old = normalizeChatbotSettings({ enabled: true, followUps: { enabled: true, scenarios: [{ id: 'old-24', name: 'Cũ', trigger: 'inbox-no-reply', delayHours: 24, templateId: 'FOLLOW_UP_TRIAL_FREESHIP', outsideWindow: true, freeShipDays: 7 }] } });
  assert.equal(await legacy.resolveFollowUpQueueItem('old-24:110:zz', 'sent', { readSettings: async () => old, now }), true);
  assert.equal((await readMessagingStore()).conversations.find(item => item.id === `${page}:${later}`).promo, undefined);
});

test('"bám đuổi thành công": đơn đã ghi nhận mà sau đó hủy / hoàn / bom thì không tính doanh thu (trừ khi còn đơn hợp lệ khác trong 14 ngày)', () => {
  const sentAt = now - 5 * DAY;
  const base = { followUps: [{ scenarioId: 's', at: sentAt, via: 'private' }], followUpWon: { orderId: 'o1', at: sentAt + DAY, total: 298000 } };
  assert.deepEqual(followUp.currentFollowUpWin({ ...base, customerOrders: [{ id: 'o1', createdAt: sentAt + DAY, total: 298000, status: 'Mới' }] }), { orderId: 'o1', total: 298000 });
  assert.equal(followUp.currentFollowUpWin({ ...base, customerOrders: [{ id: 'o1', createdAt: sentAt + DAY, total: 298000, processingStatus: 'cancelled' }] }), null);
  assert.equal(followUp.currentFollowUpWin({ ...base, customerOrders: [{ id: 'o1', createdAt: sentAt + DAY, total: 298000, status: 'Hoàn' }] }), null, 'đơn hoàn');
  assert.deepEqual(followUp.currentFollowUpWin({ ...base, customerOrders: [
    { id: 'o1', createdAt: sentAt + DAY, total: 298000, status: 'Hủy' },
    { id: 'o2', createdAt: sentAt + 2 * DAY, total: 174000, status: 'Mới' }
  ] }), { orderId: 'o2', total: 174000 });
  assert.deepEqual(followUp.currentFollowUpWin({ ...base, customerOrders: [] }), { orderId: 'o1', total: 298000 }, 'đơn không còn trong hội thoại (dữ liệu cũ): giữ như đã ghi');
});
