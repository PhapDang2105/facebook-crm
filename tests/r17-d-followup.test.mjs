// Vòng 17 — gói D: bám đuổi (out-inbox1 B7, out-comments B4a/B4b, out-inbox4 T1; quyết định chủ shop 10/10 mục 7).
// Kho tạm, không đụng data/processed; không gọi dịch vụ thật (sendMessage là stub).
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { tempDir } from './helpers/temp-dir.mjs';
import './helpers/seed-catalog.mjs';

const directory = tempDir('r17d-followup-');
process.env.META_CONVERSATIONS_PATH = path.join(directory, 'meta-conversations.json');
process.env.FOLLOW_UPS_PATH = path.join(directory, 'follow-ups.json');
process.env.INBOX_SETTINGS_PATH = path.join(directory, 'inbox-settings.json');

const HOUR = 60 * 60 * 1000;
const now = Date.parse('2026-10-10T01:13:00Z');
const page = '103';
const message = (direction, createdAt, extra = {}) => ({ id: `m${createdAt}${direction}${extra.text || ''}`.slice(0, 60), mid: '', direction, type: 'text', text: 'x', createdAt, status: 'sent', ...extra });
const pending = { items: [{ product: 'Granola Túi Xanh 450g', code: 'GRA-XANH-Z450', quantity: 1 }], key: 'GRA-XANH-Z450=1', at: now - 6 * HOUR, phone: '', address: '' };
// Câu nhắc giỏ bot gửi thật (ca …242125 / …349146, che tên): đúng lời ORDER_ADDRESS_REMIND của seed.
const REMIND = 'Dạ em vẫn đang giữ đơn 1 Granola Túi Xanh 450g – tổng 189.000đ cho anh ạ 🌾 Anh gửi giúp em số điện thoại và địa chỉ nhận hàng đầy đủ là em lên đơn liền nha.';
const SHOP_CART = 'Khách chọn mua từ Facebook Shop: Granola Mới Ngũ Cốc Ăn Sáng (GRA-XANH-Z450) — 189.000đ 🛒GRA-XANH-Z450';

writeFileSync(process.env.META_CONVERSATIONS_PATH, JSON.stringify({
  conversations: [
    // …242125: bấm giỏ Shop, bot nhắc giỏ ngay (tin bot cuối = câu nhắc), khách im → không gửi lại y hệt.
    { id: `${page}:dup`, pageId: page, psid: 'dup', name: 'Khách …242125', source: 'inbox', gender: 'male', genderSource: 'name', botLastTemplateId: 'ORDER_ADDRESS_REMIND', botLastReplyAt: now - 5 * HOUR, pendingOrder: pending },
    // Đối chứng: cùng giỏ, tin bot cuối là câu khác → nhắc giỏ như cũ.
    { id: `${page}:ok`, pageId: page, psid: 'ok', name: 'Khách đối chứng', source: 'inbox', gender: 'male', genderSource: 'name', botLastTemplateId: 'ORDER_ADDRESS', botLastReplyAt: now - 5 * HOUR, pendingOrder: pending },
    // …6160490970: "Giao rồi mà" → SĐT → ORDER_STATUS_CHECKING ("em chuyển bạn phụ trách đơn hàng tra ngay") khi còn giỏ → không nhắc giỏ.
    { id: `${page}:chk`, pageId: page, psid: 'chk', name: 'Khách …490970', source: 'inbox', gender: 'female', genderSource: 'name', botLastTemplateId: 'ORDER_STATUS_CHECKING', botLastReplyAt: now - 5 * HOUR, pendingOrder: pending }
  ],
  messages: {
    [`${page}:dup`]: [message('incoming', now - 5 * HOUR - 60000, { text: SHOP_CART }), message('outgoing', now - 5 * HOUR, { text: REMIND, sender: 'bot' })],
    [`${page}:ok`]: [message('incoming', now - 5 * HOUR - 60000, { text: 'lấy 1 túi xanh' }), message('outgoing', now - 5 * HOUR, { text: 'Dạ anh cho em xin số điện thoại và địa chỉ trước sáp nhập nha ạ.', sender: 'bot' })],
    [`${page}:chk`]: [message('incoming', now - 5 * HOUR - 60000, { text: '0912xxxxxx' }), message('outgoing', now - 5 * HOUR, { text: 'Dạ em đã nhận số điện thoại của chị ạ. Em chuyển bạn phụ trách đơn hàng tra ngay và nhắn lại chị trong tin này nha, chị chờ em ít phút ạ 💛', sender: 'bot' })]
  },
  commentIndex: {}
}));
writeFileSync(process.env.FOLLOW_UPS_PATH, JSON.stringify({ activatedAt: now - 48 * HOUR, sent: {} }));

const { runFollowUps, remindAlreadySent, followUpSkipReason } = await import('../app/follow-up.mjs');
const { normalizeChatbotSettings } = await import('../app/chatbot-settings.mjs');
const settings = normalizeChatbotSettings({ enabled: true, followUps: { enabled: true, scenarios: [{ id: 'inbox-remind', name: 'Hộp thư im 3 giờ', trigger: 'inbox-no-reply', delayHours: 3, templateId: 'FOLLOW_UP_INBOX_REMIND' }] } });

test('R17 B7/B4b (…242125, …349146): câu nhắc giỏ trùng nguyên văn tin Page trong 24 giờ → không gửi lại; khác câu / quá 24 giờ / tin nhân viên → không tính', () => {
  const sent = [message('outgoing', now - 15 * HOUR, { text: `Dạ em thấy anh để lại bình luận dưới bài viết của Giọt Nắng ạ 💛\n\n${REMIND}` })];
  assert.equal(remindAlreadySent(sent, REMIND, now), true, 'nằm trong tin ghép của bình luận');
  assert.equal(remindAlreadySent([message('outgoing', now - 3 * HOUR, { text: REMIND.replace(/ /g, '  ') })], REMIND, now), true, 'khác khoảng trắng');
  assert.equal(remindAlreadySent([message('outgoing', now - 25 * HOUR, { text: REMIND })], REMIND, now), false, 'quá 24 giờ');
  assert.equal(remindAlreadySent([message('incoming', now - HOUR, { text: REMIND })], REMIND, now), false, 'tin khách');
  assert.equal(remindAlreadySent([message('outgoing', now - HOUR, { text: REMIND, staff: true })], REMIND, now), false, 'tin nhân viên');
  assert.equal(remindAlreadySent([message('outgoing', now - HOUR, { text: REMIND.replace('1 Granola', '2 Granola') })], REMIND, now), false, 'giỏ khác');
});

test('R17 B4a/T1 (…6160490970 "Giao rồi mà" → tra đơn; chủ shop 10/10 mục 7): tin bot cuối ORDER_STATUS_CHECKING / WAITING_STAFF / CSKH_HANDOFF → không nhắc giỏ dù đang giữ giỏ', () => {
  const inbox = extra => ({ id: 'p:q', pageId: 'p', psid: 'q', source: 'inbox', ...extra });
  const store = { conversations: [], messages: { 'p:q': [message('incoming', now - 5 * HOUR, { text: 'Giao rồi mà' }), message('outgoing', now - 4 * HOUR)] } };
  for (const id of ['ORDER_STATUS_CHECKING', 'WAITING_STAFF', 'CSKH_HANDOFF']) {
    assert.equal(followUpSkipReason({ conversation: inbox({ botLastTemplateId: id }), inbox: inbox({ botLastTemplateId: id }), thread: null }, store, { basketHeld: true }), 'waitingStaff', id);
  }
  assert.equal(followUpSkipReason({ conversation: inbox({ botLastTemplateId: 'ORDER_ADDRESS' }), inbox: inbox({ botLastTemplateId: 'ORDER_ADDRESS' }), thread: null }, store, { basketHeld: true }), '');
  // Khiếu nại nặng (gói B gắn thẻ complaint) → dừng hẳn, kể cả giữ giỏ.
  assert.equal(followUpSkipReason({ conversation: inbox({ labels: ['complaint'] }), inbox: inbox({ labels: ['complaint'] }), thread: null }, store, { basketHeld: true }), 'label');
});

test('R17 vòng bám đuổi thật: giỏ vừa được nhắc nguyên văn → bỏ qua (duplicateRemind); đang tra đơn → waitingStaff; đối chứng vẫn được nhắc giỏ', async () => {
  const sent = [];
  const summary = await runFollowUps({ readSettings: async () => settings, sendMessage: async (c, p) => { sent.push({ id: c.id, text: p.text }); return { message: { mid: 'x' } }; }, now, quietHours: false, log: () => {} });
  const ids = sent.map(item => item.id);
  assert.deepEqual(ids, [`${page}:ok`], JSON.stringify({ sent, reasons: summary.skipReasons }));
  assert.match(sent[0].text, /^Dạ em vẫn đang giữ đơn 1 Granola Túi Xanh 450g/);
  assert.equal(summary.skipReasons.duplicateRemind, 1, JSON.stringify(summary.skipReasons));
  assert.equal(summary.skipReasons.waitingStaff, 1, JSON.stringify(summary.skipReasons));
});
