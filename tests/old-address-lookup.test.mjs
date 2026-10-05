import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import './helpers/seed-catalog.mjs';

// 05/10 (chủ shop, ca …610181452166): khách nhắn "Đc cũ" rồi gửi SĐT, bot trả "em chưa tìm thấy địa chỉ cũ theo số này" dù
// chính khách đã nhắn địa chỉ đủ cấp ngay sau tin SĐT ngày 14/09 trong CÙNG hội thoại, và đơn POS 51609 (nhân viên lên
// trên Pancake) có conversation_id đúng hội thoại. resolvePreviousAddress (processing/order-flow.mjs) thêm hai nguồn
// "của khách": tin khách trong hội thoại + đơn POS cùng conversation_id; đơn POS hội thoại khác vẫn là "đơn ngoài" (C2).
const directory = mkdtempSync(path.join(os.tmpdir(), 'crm-old-address-'));
process.env.ADDRESS_AI_CACHE_PATH = path.join(directory, 'address-ai-cache.json');
process.on('exit', () => rmSync(directory, { recursive: true, force: true }));

const { processChatbotChanges, withFallbackTemplates } = await import('../app/chatbot-engine.mjs');
const { defaultMessageTemplates, renderChatbotReply } = await import('../app/chatbot-templates.mjs');
const { addressFromCustomerMessages, pickPosOrderAddress, posOrderAddress, resolvePreviousAddress } = await import('../app/processing/order-flow.mjs');

const seed = Object.fromEntries(Object.entries(defaultMessageTemplates()).map(([id, text]) => [id, text.trim()]));
const templates = withFallbackTemplates(seed);
const XANH = quantity => ({ product: 'Granola Túi Xanh 450g', code: 'GRA-XANH-Z450', quantity });
const basket = (items, agoMs = 30000, extra = {}) => ({ items, key: items.map(item => `${item.code}=${item.quantity}`).sort().join('|'), at: Date.now() - agoMs, phone: '', address: '', addressAsks: 0, ...extra });
const settle = () => new Promise(resolve => setImmediate(resolve));
const MIN = 60 * 1000;
const DAY = 24 * 60 * MIN;
const PHONE = '0912345678';
const HUNG_YEN = 'Thôn Đông, xã Tân Tiến, huyện Văn Giang, tỉnh Hưng Yên';

let counter = 0;
/** Hội thoại nhiều lượt (bản chép lớp Sim của fix-bot-chatbot.test.mjs): engine thật, mô hình giả qua requestReply. */
class Sim {
  constructor(conversation = {}, settings = {}) {
    this.conversation = { id: 'page:user', pageId: 'page', psid: 'user', name: 'Khách', botEnabled: true, ...conversation };
    this.recent = [];
    this.settings = { enabled: true, responseMode: 'automatic', handoffKeywords: '', complaintKeywords: '', fragmentWaitMs: 0, phoneFragmentWaitMs: 0, messageTemplates: seed, ruleIntent: 'on', experimentalRules: 'on', preGuard: 'off', intentModel: 'off', intentCascade: 'off', ...settings };
    this.extraDeps = {};
    this.listLimits = [];
  }
  history(direction, text, agoMs, extra = {}) {
    this.recent.push({ id: `h-${++counter}`, mid: `h-${counter}`, direction, type: 'text', text, createdAt: Date.now() - agoMs, ...extra });
    return this;
  }
  async send(text, { llm = null } = {}) {
    const incoming = { id: `m-${++counter}`, mid: `m-${counter}`, direction: 'incoming', type: 'text', text, createdAt: Date.now() };
    this.recent.push(incoming);
    const sent = []; const saved = []; const created = []; const staffNotes = [];
    const self = this;
    const results = await processChatbotChanges([{ type: 'message', conversation: { ...this.conversation }, message: incoming }], {
      readSettings: async () => this.settings,
      // Giống máy chủ: mặc định 100 tin gần nhất, `limit` lớn hơn thì trả nhiều hơn.
      listMessages: async (_id, limit = 100) => { self.listLimits.push(limit); return self.recent.slice(-limit); },
      getConversation: async id => (id === self.conversation.id ? self.conversation : null),
      saveBotState: async (_id, state) => { saved.push(state); Object.assign(self.conversation, state); },
      sendMessage: async (_c, payload) => {
        const out = payload.text || `[ảnh ${payload.imageUrls?.length || 1}]`;
        sent.push(out);
        self.recent.push({ id: `o-${++counter}`, mid: `o-${counter}`, direction: 'outgoing', type: 'text', text: out, createdAt: Date.now() });
        return { message: { mid: 'x' } };
      },
      createOrder: async (_c, order) => {
        const record = { id: `ord-${++counter}`, createdAt: Date.now(), phone: order.phone, address: order.address, total: order.total, products: order.items.map(item => ({ name: item.product, sku: item.code, quantity: item.quantity })), status: 'Mới' };
        created.push(order);
        self.conversation.customerOrders = [...(self.conversation.customerOrders || []), record];
        return { order: record, created: true };
      },
      cancelOrder: async () => ({ cancelled: true, created: false }),
      addOrderNote: async () => ({ noted: true }),
      addStaffNote: async (_c, note) => { staffNotes.push(note); },
      requestReply: async payload => {
        const answer = typeof llm === 'function' ? llm(payload) : llm;
        if (!answer) return { templateId: 'LLM_CALLED', messages: ['[mô hình]'], handoff: false };
        return answer.template_id ? renderChatbotReply(answer, templates, payload.context || {}) : answer;
      },
      appendDecisionLog: () => {},
      ...this.extraDeps
    });
    await settle();
    return { result: results[0] || {}, sent, saved, created, staffNotes };
  }
}

/** Ca thật mô phỏng: 14/09 khách gửi SĐT, 2 phút sau gửi địa chỉ Hưng Yên; sau đó 150 tin khác (ngoài 100 tin gần nhất). */
function realCase(conversation = {}) {
  const sim = new Sim({ pancakeConversationId: 'page_user', ...conversation });
  sim.history('incoming', PHONE, 21 * DAY + 3 * MIN);
  sim.history('incoming', HUNG_YEN, 21 * DAY + 1 * MIN);
  sim.history('outgoing', 'Dạ em cảm ơn chị, em lên đơn cho chị ngay ạ', 21 * DAY);
  for (let index = 0; index < 150; index += 1) sim.history(index % 2 ? 'outgoing' : 'incoming', `tin trò chuyện ${index}`, 20 * DAY - index * MIN);
  return sim;
}
const ORDER_CONFIRMATION = { template_id: 'ORDER_CONFIRMATION', Product_N1: 'Granola Túi Xanh 450g', No_A: '2', Phone_Number: PHONE };
const posOrder = (extra = {}) => ({
  id: 51609, system_id: 51609, status: 3, inserted_at: '2026-09-14T03:40:00',
  bill_phone_number: PHONE,
  conversation_id: 'page_user',
  shipping_address: { phone_number: PHONE, address: 'Số 8 ngõ 2 thôn An Lạc', commune_name: 'Xã Liên Nghĩa', district_name: 'Huyện Văn Giang', province_name: 'Hưng Yên' },
  ...extra
});

// ===== Hàm tra (đơn vị) =====
test('addressFromCustomerMessages: địa chỉ đủ cấp trong ±30 phút quanh tin có đúng SĐT; tin xa SĐT / SĐT khác / thiếu cấp / quá 180 ngày → không', () => {
  const at = Date.UTC(2026, 8, 14, 3, 33);
  const messages = [
    { id: 'p', direction: 'incoming', type: 'text', text: '0912.345.678', createdAt: at },
    { id: 'a', direction: 'incoming', type: 'text', text: HUNG_YEN, createdAt: at + 2 * MIN },
    { id: 'z', direction: 'incoming', type: 'text', text: 'ok shop', createdAt: at + 3 * MIN }
  ];
  const found = addressFromCustomerMessages(PHONE, messages, { now: at + 21 * DAY });
  assert.equal(found?.address, HUNG_YEN);
  assert.equal(found.source, 'messages');
  assert.equal(found.messageId, 'a');
  assert.equal(addressFromCustomerMessages('0987654321', messages, { now: at + 21 * DAY }), null, 'SĐT khác: không');
  assert.equal(addressFromCustomerMessages(PHONE, messages, { now: at + 200 * DAY }), null, 'quá 180 ngày');
  const far = [messages[0], { ...messages[1], createdAt: at + 3 * 60 * MIN }];
  assert.equal(addressFromCustomerMessages(PHONE, far, { now: at + DAY }), null, 'cách tin SĐT 3 giờ, không có xác nhận');
  const partial = [messages[0], { ...messages[1], text: 'xã Tân Tiến nha' }];
  assert.equal(addressFromCustomerMessages(PHONE, partial, { now: at + DAY }), null, 'thiếu cấp');
  const otherPhone = [messages[0], { ...messages[1], text: `${HUNG_YEN} 0987654321` }];
  assert.equal(addressFromCustomerMessages(PHONE, otherPhone, { now: at + DAY }), null, 'tin ghi SĐT người khác');
  // Cùng tin có SĐT + địa chỉ: bỏ SĐT khỏi địa chỉ.
  const inline = addressFromCustomerMessages(PHONE, [{ id: 'x', direction: 'incoming', type: 'text', text: `${HUNG_YEN} ${PHONE}`, createdAt: at }], { now: at + DAY });
  assert.equal(inline?.address, HUNG_YEN);
  // Địa chỉ xa tin SĐT nhưng ngay sau là phiếu xác nhận của Page → của khách.
  const confirmed = [messages[0], { ...messages[1], createdAt: at + 5 * 60 * MIN }, { id: 'r', direction: 'outgoing', type: 'order-receipt', text: '', createdAt: at + 5 * 60 * MIN + MIN }];
  assert.equal(addressFromCustomerMessages(PHONE, confirmed, { now: at + DAY })?.messageId, 'a');
  // Tin Page (không phải khách) có địa chỉ: không tính.
  assert.equal(addressFromCustomerMessages(PHONE, [messages[0], { ...messages[1], direction: 'outgoing' }], { now: at + DAY }), null);
});

test('pickPosOrderAddress: cùng conversation_id + chưa hủy + đủ địa chỉ → của khách; hội thoại khác → đơn ngoài; hủy → bỏ', () => {
  assert.equal(posOrderAddress(posOrder()), 'Số 8 ngõ 2 thôn An Lạc, Xã Liên Nghĩa, Huyện Văn Giang, Hưng Yên');
  assert.equal(posOrderAddress(posOrder({ shipping_address: { address: 'Số 8, Xã Liên Nghĩa, Huyện Văn Giang, Hưng Yên', commune_name: 'Xã Liên Nghĩa', district_name: 'Huyện Văn Giang', province_name: 'Hưng Yên' } })), 'Số 8, Xã Liên Nghĩa, Huyện Văn Giang, Hưng Yên', 'không lặp phần đã có');
  const own = pickPosOrderAddress(PHONE, [posOrder()], 'page_user');
  assert.equal(own.own?.orderId, '51609');
  assert.equal(own.own.at, Date.UTC(2026, 8, 14, 3, 40));
  assert.equal(own.foreign, null);
  const foreign = pickPosOrderAddress(PHONE, [posOrder({ conversation_id: 'page_other' })], 'page_user');
  assert.equal(foreign.own, null);
  assert.equal(foreign.foreign?.orderId, '51609');
  assert.deepEqual(pickPosOrderAddress(PHONE, [posOrder({ status: 6 })], 'page_user'), { own: null, foreign: null }, 'đơn hủy');
  assert.deepEqual(pickPosOrderAddress('0987654321', [posOrder()], 'page_user'), { own: null, foreign: null }, 'SĐT khác');
  assert.equal(pickPosOrderAddress(PHONE, [posOrder()], '').own, null, 'hội thoại không có mã Pancake: không chứng minh được');
});

test('resolvePreviousAddress: thứ tự nguồn; POS lỗi mạng / quá giờ → bỏ qua, ghi log', async () => {
  const warnings = [];
  const log = { warn: message => warnings.push(message) };
  const at = Date.now() - 21 * DAY;
  const messages = [
    { id: 'p', direction: 'incoming', type: 'text', text: PHONE, createdAt: at },
    { id: 'a', direction: 'incoming', type: 'text', text: HUNG_YEN, createdAt: at + 2 * MIN }
  ];
  let posCalls = 0;
  const pos = async () => { posCalls += 1; return [posOrder()]; };
  const fromMessages = await resolvePreviousAddress(PHONE, { messages, findPosOrdersByPhone: pos, pancakeConversationId: 'page_user' });
  assert.equal(fromMessages.own.source, 'messages');
  assert.equal(posCalls, 0, 'đã có trong tin khách: không gọi POS');
  const fromPos = await resolvePreviousAddress(PHONE, { messages: [], findPosOrdersByPhone: pos, pancakeConversationId: 'page_user' });
  assert.equal(fromPos.own.source, 'pos');
  const failing = await resolvePreviousAddress(PHONE, { findPosOrdersByPhone: async () => { throw new Error('ECONNRESET'); }, pancakeConversationId: 'page_user', log });
  assert.deepEqual(failing, { own: null, foreign: null });
  assert.match(warnings.at(-1), /ECONNRESET/);
  const started = Date.now();
  const slow = await resolvePreviousAddress(PHONE, { findPosOrdersByPhone: () => new Promise(() => {}), pancakeConversationId: 'page_user', posTimeoutMs: 50, log });
  assert.deepEqual(slow, { own: null, foreign: null });
  assert.ok(Date.now() - started < 2000);
  assert.match(warnings.at(-1), /quá 50 ms/);
  const landing = await resolvePreviousAddress(PHONE, { landingStore: async () => ({ orders: [{ id: 'L9', phone: PHONE, address: '45 Trần Hưng Đạo, Phường Cầu Ông Lãnh, Quận 1, TP Hồ Chí Minh', createdAt: at, source: 'landing' }] }) });
  assert.equal(landing.own, null);
  assert.equal(landing.foreign?.orderId, 'L9');
});

// ===== Engine (ca thật mô phỏng) =====
test('ca thật: tin SĐT 14/09 + tin địa chỉ Hưng Yên 2 phút sau → "Đc cũ" → SĐT → bot dùng địa chỉ đó (không "chưa tìm thấy")', async () => {
  const sim = realCase({ pendingOrder: basket([XANH(2)], 2 * MIN) });
  const first = await sim.send('Đc cũ', { llm: { template_id: 'ORDER_ADDRESS', Product_N1: 'Granola Túi Xanh 450g', No_A: '2' } });
  assert.equal(first.result.templateId, 'ORDER_ADDRESS_OLD_ASK_PHONE', JSON.stringify(first.result));
  const second = await sim.send(PHONE, { llm: ORDER_CONFIRMATION });
  const text = second.sent.join(' ');
  assert.match(text, /Văn Giang/, JSON.stringify(second.result));
  assert.match(text, /Hưng Yên/);
  assert.doesNotMatch(text, /chưa tìm thấy/i);
  assert.deepEqual(second.staffNotes, []);
  assert.ok(sim.listLimits.some(limit => limit > 100), 'đọc cả lịch sử, không chỉ 100 tin gần nhất');
});

test('đơn POS (stub) cùng conversation_id → dùng địa chỉ đơn đó', async () => {
  const sim = new Sim({ pancakeConversationId: 'page_user', botLastTemplateId: 'ORDER_ADDRESS_OLD_ASK_PHONE', botLastReplyAt: Date.now() - MIN, pendingOrder: basket([XANH(2)], MIN, { wantsPrevious: true }) });
  sim.history('outgoing', 'Dạ chị cho em xin SĐT đã đặt lần trước ạ', MIN);
  const asked = [];
  sim.extraDeps.findPosOrdersByPhone = async phone => { asked.push(phone); return [posOrder()]; };
  sim.extraDeps.readLandingStore = async () => ({ orders: [] });
  const out = await sim.send(PHONE, { llm: ORDER_CONFIRMATION });
  assert.deepEqual(asked, [PHONE]);
  assert.match(out.sent.join(' '), /An Lạc|Liên Nghĩa/, JSON.stringify(out.result));
  assert.deepEqual(out.staffNotes, []);
});

test('đơn POS của hội thoại KHÁC → không tự điền, không nhắc địa chỉ; ghi chú cho nhân viên đối chiếu (C2)', async () => {
  const sim = new Sim({ pancakeConversationId: 'page_user', botLastTemplateId: 'ORDER_ADDRESS_OLD_ASK_PHONE', botLastReplyAt: Date.now() - MIN, pendingOrder: basket([XANH(2)], MIN, { wantsPrevious: true }) });
  sim.history('outgoing', 'Dạ chị cho em xin SĐT đã đặt lần trước ạ', MIN);
  sim.extraDeps.findPosOrdersByPhone = async () => [posOrder({ conversation_id: 'page_someone_else' })];
  sim.extraDeps.readLandingStore = async () => ({ orders: [] });
  const out = await sim.send(PHONE, { llm: ORDER_CONFIRMATION });
  assert.deepEqual(out.created, []);
  assert.doesNotMatch(out.sent.join(' '), /An Lạc|Liên Nghĩa/);
  assert.equal(out.staffNotes.length, 1);
  assert.match(out.staffNotes[0], /Pancake POS 51609/);
  assert.match(out.staffNotes[0], /không thuộc hội thoại/);
  assert.equal(sim.conversation.pendingOrder.address, '');
});

test('POS lỗi mạng → như cũ (giống hệt khi không có POS)', async () => {
  const run = async findPosOrdersByPhone => {
    const sim = new Sim({ pancakeConversationId: 'page_user', botLastTemplateId: 'ORDER_ADDRESS_OLD_ASK_PHONE', botLastReplyAt: Date.now() - MIN, pendingOrder: basket([XANH(2)], MIN, { wantsPrevious: true }) });
    sim.history('outgoing', 'Dạ chị cho em xin SĐT đã đặt lần trước ạ', MIN);
    if (findPosOrdersByPhone) sim.extraDeps.findPosOrdersByPhone = findPosOrdersByPhone;
    sim.extraDeps.readLandingStore = async () => ({ orders: [] });
    return sim.send(PHONE, { llm: ORDER_CONFIRMATION });
  };
  const failing = await run(async () => { throw new Error('getaddrinfo ENOTFOUND pos.pages.fm'); });
  const baseline = await run(null);
  assert.equal(failing.result.templateId, baseline.result.templateId);
  assert.deepEqual(failing.sent, baseline.sent);
  assert.deepEqual(failing.created, baseline.created);
  assert.deepEqual(failing.staffNotes, baseline.staffNotes);
});
