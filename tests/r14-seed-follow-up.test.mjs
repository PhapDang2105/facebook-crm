// Vòng 14 (quyết định chủ shop 6): bám đuổi bỏ khách sỉ, khách nói đã mua trên sàn / web, khách đã có đơn landing cùng SĐT;
// hai kịch bản (bình luận 12h + hộp thư 3h) không gửi 2 tin y hệt cho cùng một khách (…039804).
import test from 'node:test';
import assert from 'node:assert/strict';
import { utimesSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tempDir } from './helpers/temp-dir.mjs';
import './helpers/seed-catalog.mjs';

const directory = tempDir('r14-seed-followup-');
process.env.META_CONVERSATIONS_PATH = path.join(directory, 'meta-conversations.json');
process.env.FOLLOW_UPS_PATH = path.join(directory, 'follow-ups.json');
process.env.INBOX_SETTINGS_PATH = path.join(directory, 'inbox-settings.json');

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
// 10:00 giờ VN (ngoài giờ yên tĩnh).
const now = Date.parse('2026-10-03T03:00:00Z');
const page = '120';
const PHONE = '0912345678';
const message = (direction, createdAt, extra = {}) => ({ id: `m${createdAt}${direction}${extra.id || ''}`, mid: '', direction, type: 'text', text: 'x', createdAt, status: 'sent', ...extra });

writeFileSync(process.env.META_CONVERSATIONS_PATH, JSON.stringify({ conversations: [], messages: {}, commentIndex: {} }));
const { normalizeChatbotSettings } = await import('../app/chatbot-settings.mjs');
const followUp = await import('../app/follow-up.mjs');

const psids = Array.from({ length: 200 }, (_, index) => `r${index}`).filter(id => !followUp.isFollowUpHoldout(id));
let cursor = 0;
const nextPsid = () => psids[cursor++];
let seedCount = 0;
function seedStore(store) {
  writeFileSync(process.env.META_CONVERSATIONS_PATH, JSON.stringify({ messages: {}, commentIndex: {}, ...store }));
  seedCount += 1;
  const at = new Date(Date.now() + 60_000 + seedCount * 1000);
  utimesSync(process.env.META_CONVERSATIONS_PATH, at, at);
}
const seedState = () => writeFileSync(process.env.FOLLOW_UPS_PATH, JSON.stringify({ activatedAt: now - 3 * DAY, sent: {} }));
let freshCount = 0;
const fresh = () => import(`../app/follow-up.mjs?r14seed=${(freshCount += 1)}`);
const inboxScenario = { id: 'inbox-3h', name: 'Hộp thư im 3 giờ', trigger: 'inbox-no-reply', delayHours: 3, message: 'Dạ {title} còn cần em tư vấn thêm gì không ạ?' };
const commentScenario = { id: 'comment-12h', name: 'Bình luận im 12 giờ', trigger: 'comment-no-reply', delayHours: 12, message: 'Dạ {title} ơi, em thấy {title} có quan tâm granola ạ' };
const settingsWith = scenarios => normalizeChatbotSettings({ enabled: true, followUps: { enabled: true, scenarios } });
const basket = at => ({ items: [{ product: 'Granola Túi Xanh 450g', code: 'GRA-XANH-Z450', quantity: 2 }], key: 'GRA-XANH-Z450=2', at, phone: '', address: '', addressAsks: 0 });

test('câu khách thật "đã mua ở kênh khác" / "mua 3 túi rồi" → coi là đã mua; câu hỏi / câu đặt hàng thì không', () => {
  for (const text of ['Mình đặt của shop trên tiktok rồi', 'Anh mua 3 túi rồi mà, hôm qua vừa giao hàng cho a', 'Anh đặt trên trang của mình 477k ddC tặng bát dừa', 'đặt shopee rồi nha', 'đã nhận được hàng rồi']) {
    assert.equal(followUp.customerBoughtText(text), true, text);
  }
  for (const text of ['Đặt trên shopee được không ạ', 'Mua trên tiktok có rẻ hơn không', 'Mua trên web rẻ hơn hả', 'Mua 2 túi rồi gửi về Hà Nội nha', 'Lấy 2 túi rồi ship giúp em', 'Cho mình 2 túi nhé', 'Giá bn ạ', 'shop có bán trên shopee ko']) {
    assert.equal(followUp.customerBoughtText(text), false, text);
  }
  assert.equal(followUp.boughtElsewhereText('Mình đặt của shop trên tiktok rồi'), true);
  assert.equal(followUp.boughtElsewhereText('Anh mua 3 túi rồi mà'), false, 'không phải kênh khác');
});

test('…659307: khách giữ giỏ 2 túi rồi nói "đặt của shop trên tiktok rồi" → không là ứng viên bám đuổi (không nhắc giỏ)', () => {
  const psid = nextPsid();
  const inbox = { id: `${page}:${psid}`, pageId: page, psid, name: 'Khách A', source: 'inbox', pendingOrder: basket(now - 4 * HOUR) };
  const store = {
    conversations: [inbox],
    messages: { [inbox.id]: [
      message('incoming', now - 4 * HOUR - 60_000, { text: 'Cho mình 2 túi nhé' }),
      message('outgoing', now - 4 * HOUR, { text: 'Dạ đơn của chị gồm 2 Granola Túi Xanh 450g…' }),
      message('incoming', now - 4 * HOUR + 4 * 60_000, { text: 'Mình đặt của shop trên tiktok rồi' }),
      message('outgoing', now - 4 * HOUR + 5 * 60_000, { text: 'Dạ em chưa thấy đơn nào…' })
    ] }
  };
  const reasons = [];
  const candidates = followUp.findFollowUpCandidates(store, inboxScenario, { now, activatedAt: now - DAY, onExcluded: (_inbox, reason) => reasons.push(reason) });
  assert.deepEqual(candidates, []);
  assert.deepEqual(reasons, ['đã có đơn / thẻ đã mua']);
  // Câu khác (chưa mua) thì vẫn là ứng viên — đối chứng.
  store.messages[inbox.id][2].text = 'Vị nào dễ ăn hơn ạ';
  assert.equal(followUp.findFollowUpCandidates(store, inboxScenario, { now, activatedAt: now - DAY }).length, 1);
});

test('…916619: khách mang thẻ Khách sỉ (wholesale) → không bám, kể cả khi đang giữ giỏ', () => {
  const inbox = { id: `${page}:w`, pageId: page, psid: 'w', source: 'inbox', labels: ['wholesale', 'followup'] };
  const store = { conversations: [inbox], messages: { [inbox.id]: [message('incoming', now - 7 * HOUR, { text: 'báo mình giá sỉ vs ạ' }), message('outgoing', now - 7 * HOUR, { text: 'Dạ chị cho em xin số Zalo…' })] } };
  const candidate = { conversation: inbox, inbox, thread: null };
  assert.equal(followUp.followUpSkipReason(candidate, store), 'label');
  assert.equal(followUp.followUpSkipReason(candidate, store, { basketHeld: true }), 'label');
});

test('đơn landing 14 ngày cùng SĐT: landingOrderReason (đơn hủy / bỏ dở / quá hạn / trước lúc chọn giỏ thì không)', () => {
  const phones = new Set([PHONE]);
  const order = extra => ({ id: 'l1', phone: '+84 912 345 678', createdAt: now - DAY, status: 'Mới', ...extra });
  assert.match(followUp.landingOrderReason([order()], phones, { now }), /landing/);
  assert.equal(followUp.landingOrderReason([order({ status: 'Hủy' })], phones, { now }), '');
  assert.equal(followUp.landingOrderReason([order({ status: 'Chưa hoàn tất' })], phones, { now }), '');
  assert.equal(followUp.landingOrderReason([order({ landing: { incomplete: true } })], phones, { now }), '');
  assert.equal(followUp.landingOrderReason([order({ createdAt: now - 20 * DAY })], phones, { now }), '');
  assert.equal(followUp.landingOrderReason([order()], phones, { now, since: now - HOUR }), '', 'đơn landing cũ hơn giỏ mới: vẫn nhắc giỏ');
  assert.equal(followUp.landingOrderReason([order({ phone: '0987654321' })], phones, { now }), '');
  assert.equal(followUp.phoneKey('84912345678'), PHONE);
});

test('…897712: khách đã có đơn landing (SĐT trong tin khách hay SĐT Pancake) → không gửi tin bám đuổi, ghi lý do khách cũ', async () => {
  const local = nextPsid();
  const viaPancake = nextPsid();
  const fresh1 = nextPsid();
  const silent = (psid, text = 'Giá bn ạ') => [message('incoming', now - 5 * HOUR, { text }), message('outgoing', now - 4 * HOUR, { text: 'Dạ bảng giá…' })];
  seedStore({
    conversations: [local, viaPancake, fresh1].map(psid => ({ id: `${page}:${psid}`, pageId: page, psid, name: `Khách ${psid}`, source: 'inbox' })),
    messages: { [`${page}:${local}`]: silent(local, `sđt mình ${PHONE}`), [`${page}:${viaPancake}`]: silent(viaPancake), [`${page}:${fresh1}`]: silent(fresh1) }
  });
  seedState();
  const module = await fresh();
  const sent = [];
  const summary = await module.runFollowUps({
    readSettings: async () => settingsWith([inboxScenario]),
    sendMessage: async conversation => { sent.push(conversation.psid); return { message: { mid: 'x' } }; },
    conversationInfo: async (_pageId, conversationId) => ({ phones: conversationId.endsWith(viaPancake) ? [PHONE] : [], tags: [] }),
    readLandingOrders: async () => ({ orders: [{ id: 'l1', phone: PHONE, createdAt: now - DAY, status: 'Mới', total: 477000 }] }),
    now, quietHours: false, log: () => {}
  });
  assert.deepEqual(sent, [fresh1]);
  assert.equal(summary.returning, 2);
  const state = await module.readFollowUpState();
  assert.match(state.sent[`inbox-3h:${page}:${local}`].error, /landing/);
  assert.match(state.sent[`inbox-3h:${page}:${viaPancake}`].error, /landing/);
});

test('…039804: kịch bản bình luận 12h + hộp thư 3h cùng nhắm một khách đang giữ giỏ → chỉ 1 tin; lượt sau không gửi tin thứ hai', async () => {
  const psid = nextPsid();
  const inbox = { id: `${page}:${psid}`, pageId: page, psid, name: 'Khách B', source: 'inbox', gender: 'female', pendingOrder: basket(now - 13 * HOUR) };
  const thread = { id: `${page}:comment:${psid}:p1`, pageId: page, psid, name: 'Khách B', source: 'comment', lastCommentId: 'c1' };
  seedStore({
    conversations: [inbox, thread],
    messages: {
      [inbox.id]: [message('incoming', now - 13 * HOUR, { text: 'Khách chọn mua từ Facebook Shop: Granola (CB2-XANH-Z450) — 298.000đ', id: 'a' }), message('outgoing', now - 13 * HOUR + 60_000, { text: 'Dạ đơn của chị gồm 2 Granola Túi Xanh 450g…', id: 'b' })],
      [thread.id]: [message('incoming', now - 13 * HOUR + 2 * 60_000, { text: 'Mua sao shop ơi', id: 'c' }), message('outgoing', now - 13 * HOUR + 3 * 60_000, { text: 'Dạ chị ơi, phiên live nhà em có…', id: 'd' })]
    }
  });
  seedState();
  const module = await fresh();
  const sent = [];
  const send = async (conversation, payload) => { sent.push({ id: conversation.id, text: payload.text }); return { message: { mid: `m${sent.length}` } }; };
  const settings = settingsWith([commentScenario, inboxScenario]);
  const first = await module.runFollowUps({ readSettings: async () => settings, sendMessage: send, now, quietHours: false, log: () => {} });
  assert.equal(sent.length, 1, `chỉ một tin: ${JSON.stringify(sent)}`);
  assert.equal(sent[0].id, inbox.id);
  assert.equal(first.skipReasons.sameCustomer, 1);
  // 15 phút sau, rồi 13 giờ sau: kịch bản còn lại đã ghi bỏ qua (lời nhắc thứ hai y hệt) → không gửi thêm.
  await module.runFollowUps({ readSettings: async () => settings, sendMessage: send, now: now + 15 * 60_000, quietHours: false, log: () => {} });
  await module.runFollowUps({ readSettings: async () => settings, sendMessage: send, now: now + 13 * HOUR, quietHours: false, log: () => {} });
  assert.equal(sent.length, 1);
  const state = await module.readFollowUpState();
  const skipped = Object.entries(state.sent).filter(([key]) => key.endsWith(`:${page}:${psid}`)).map(([, entry]) => entry.skipped || entry.via);
  assert.deepEqual(skipped.sort(), ['private', 'sameCustomer']);
});
