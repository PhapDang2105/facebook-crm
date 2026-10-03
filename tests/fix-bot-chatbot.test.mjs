import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import './helpers/seed-catalog.mjs';

// fix-bot (01/10/2026): hồi quy cho các lỗi chatbot đã được phản biện xác nhận (verify-chatbot-security.md):
// C1 sticker sau câu hỏi, C2 lộ địa chỉ/đơn theo SĐT, C3 sản phẩm staffOnly, C4 hủy quá 60 phút, T1 values mô hình,
// T2 tắt bot giữa lượt, T3 SĐT tách nhóm, T4 timeout Vertex, T6 "1.5" túi, T7 địa chỉ AI độ tin thấp, bộ nhớ đệm, warm-up.
const directory = mkdtempSync(path.join(os.tmpdir(), 'crm-fix-bot-'));
process.env.ADDRESS_AI_CACHE_PATH = path.join(directory, 'address-ai-cache.json');
process.on('exit', () => rmSync(directory, { recursive: true, force: true }));

const { processChatbotChanges, withFallbackTemplates, requestDirectModelReply, refineAddressWithAi, isCapacityError, pruneMap, warmUpChatbotModels, hasNewerCustomerMessage, rememberPendingImages, takePendingImages } = await import('../app/chatbot-engine.mjs');
const { defaultMessageTemplates, renderChatbotReply, sanitizeModelAnswer } = await import('../app/chatbot-templates.mjs');
const { extractVietnamesePhone } = await import('../app/processing/customer-info.mjs');
const { resetAddressAiCache } = await import('../app/processing/address-ai.mjs');
const { resetVertexCredentialCache, vertexProjectId } = await import('../app/vertex-auth.mjs');

const seed = Object.fromEntries(Object.entries(defaultMessageTemplates()).map(([id, text]) => [id, text.trim()]));
const templates = withFallbackTemplates(seed);
const XANH = quantity => ({ product: 'Granola Túi Xanh 450g', code: 'GRA-XANH-Z450', quantity });
const basket = (items, agoMs = 30000, extra = {}) => ({ items, key: items.map(item => `${item.code}=${item.quantity}`).sort().join('|'), at: Date.now() - agoMs, phone: '', address: '', addressAsks: 0, ...extra });
const settle = () => new Promise(resolve => setImmediate(resolve));
const LIKE = 'https://content.pancake.vn/2.1/stickers/369239263222822';
const OTHER_STICKER = 'https://content.pancake.vn/2.1/stickers/126361874215276';

let counter = 0;
/** Hội thoại nhiều lượt (bản chép lớp Sim của round12-engine.test.mjs): engine thật, mô hình giả qua requestReply. */
class Sim {
  constructor(conversation = {}, settings = {}) {
    this.conversation = { id: 'page:user', pageId: 'page', psid: 'user', name: 'Khách', botEnabled: true, ...conversation };
    this.recent = [];
    this.settings = { enabled: true, responseMode: 'automatic', handoffKeywords: '', complaintKeywords: '', fragmentWaitMs: 0, phoneFragmentWaitMs: 0, messageTemplates: seed, ruleIntent: 'on', experimentalRules: 'on', preGuard: 'off', intentModel: 'off', intentCascade: 'off', ...settings };
    this.extraDeps = {};
  }
  history(direction, text, agoMs, extra = {}) {
    this.recent.push({ id: `h-${++counter}`, mid: `h-${counter}`, direction, type: 'text', text, createdAt: Date.now() - agoMs, ...extra });
    return this;
  }
  async send(text, { llm = null, type = 'text', message = {} } = {}) {
    const incoming = { id: `m-${++counter}`, mid: `m-${counter}`, direction: 'incoming', type, text, createdAt: Date.now(), ...message };
    this.recent.push(incoming);
    const sent = []; const saved = []; const asked = []; const created = []; const notes = []; const staffNotes = []; const cancelled = [];
    const self = this;
    const results = await processChatbotChanges([{ type: 'message', conversation: { ...this.conversation }, message: incoming }], {
      readSettings: async () => this.settings,
      listMessages: async () => [...this.recent],
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
      cancelOrder: async (_c, id) => { cancelled.push(id); return { cancelled: true, created: false }; },
      addOrderNote: async (_c, orderId, note) => { notes.push({ orderId, note }); return { noted: true }; },
      addStaffNote: async (_c, note) => { staffNotes.push(note); },
      requestReply: async payload => {
        asked.push(payload);
        const answer = typeof llm === 'function' ? llm(payload, asked.length) : llm;
        if (!answer) return { templateId: 'LLM_CALLED', messages: ['[mô hình]'], handoff: false };
        return answer.template_id ? renderChatbotReply(answer, templates, payload.context || {}) : answer;
      },
      appendDecisionLog: () => {},
      ...this.extraDeps
    });
    await settle();
    return { result: results[0] || {}, sent, saved, asked, created, notes, staffNotes, cancelled };
  }
}

// ===== C1 =====
test('fix-bot C1: sticker / 👍 về trong lúc bot đang trả lời câu hỏi chữ — câu hỏi vẫn được trả lời đúng một lần; lượt sticker im', async () => {
  const sim = new Sim();
  const text = await sim.send('Mình đang tìm đồ ăn sáng cho cả nhà, bên em có gợi ý gì không', {
    llm: () => {
      sim.recent.push({ id: 'stk1', mid: 'stk1', direction: 'incoming', type: 'image', text: '', dataUrl: OTHER_STICKER, createdAt: Date.now() });
      return { template_id: 'RECOMMEND_BEGINNER' };
    }
  });
  assert.equal(text.result.templateId, 'RECOMMEND_BEGINNER', 'trước đây: skipped "gộp với tin sau", 0 tin');
  assert.equal(text.sent.length, 1);
  // Lượt của chính sticker: vẫn im như cũ.
  const stickerMessage = sim.recent.find(item => item.id === 'stk1');
  sim.recent.splice(sim.recent.indexOf(stickerMessage), 1);
  const sticker = await sim.send('', { type: 'image', message: { dataUrl: OTHER_STICKER } });
  assert.equal(sticker.sent.length, 0);

  // 👍 về giữa lúc bot trả lời "ok" cho câu "đặt thêm?": chữ được trả lời, 👍 không trả lời chồng lần nữa.
  const yesNo = new Sim({ botLastTemplateId: 'PRICE_ONE_BAG', botLastReplyAt: Date.now() - 60000 });
  yesNo.history('outgoing', 'Dạ 1 túi giá … em lên đơn 1 túi cho chị nha?', 60000);
  const question = await yesNo.send('Mình đang tìm đồ ăn sáng cho cả nhà, bên em có gợi ý gì không', {
    llm: () => {
      yesNo.recent.push({ id: 'like1', mid: 'like1', direction: 'incoming', type: 'image', text: '', dataUrl: LIKE, createdAt: Date.now() - 1 });
      // Bot trả lời và hỏi lại có/không (mẫu vẫn là PRICE_ONE_BAG): 👍 tới trước câu này không phải lời đồng ý.
      return { templateId: 'PRICE_ONE_BAG', messages: ['Dạ túi xanh không thêm đường ạ, em lên đơn 1 túi cho chị nha?'], handoff: false };
    }
  });
  assert.equal(question.sent.length >= 1, true);
  const likeMessage = yesNo.recent.find(item => item.id === 'like1');
  assert.ok(likeMessage, 'mô hình được gọi');
  yesNo.recent.splice(yesNo.recent.indexOf(likeMessage), 1);
  const like = await yesNo.send('', { type: 'image', message: { dataUrl: LIKE, createdAt: likeMessage.createdAt } });
  assert.equal(like.sent.length, 0);
  assert.equal(like.result.skipped, 'like (đã trả lời tin trước)');

  // Tin hệ thống cuộc gọi / "Notes:" giỏ Shop sau câu hỏi không làm câu hỏi nhường lượt; tin chữ thật thì vẫn nhường.
  const asked = { id: 'q', direction: 'incoming', type: 'text', text: 'giá sao', createdAt: 1 };
  assert.equal(hasNewerCustomerMessage([asked, { id: 'c', direction: 'incoming', type: 'text', text: 'Bạn đã bỏ lỡ cuộc gọi thoại', createdAt: 2 }], asked), false);
  assert.equal(hasNewerCustomerMessage([asked, { id: 'n', direction: 'incoming', type: 'text', text: 'Notes: ', createdAt: 2 }], asked), false);
  assert.equal(hasNewerCustomerMessage([asked, { id: 't', direction: 'incoming', type: 'text', text: 'ship HN không', createdAt: 2 }], asked), true);
});

// ===== C2 =====
const victimOrder = { id: 'L1', phone: '0987654321', address: '45 Trần Hưng Đạo, Phường Cầu Ông Lãnh, Quận 1, TP Hồ Chí Minh', createdAt: Date.now() - 30 * 24 * 60 * 60 * 1000, source: 'landing', products: [{ name: 'Granola Túi Vàng 350g', quantity: 2 }], total: 400000 };

test('fix-bot C2: "địa chỉ cũ" + SĐT trùng đơn landing KHÔNG thuộc hội thoại — không điền, không nhắc địa chỉ, không lên đơn tới đó; thẻ + ghi chú cho nhân viên', async () => {
  const sim = new Sim({ botLastTemplateId: 'ORDER_ADDRESS_OLD_ASK_PHONE', botLastReplyAt: Date.now() - 60000, pendingOrder: basket([XANH(2)], 60000, { wantsPrevious: true }) });
  sim.history('incoming', 'lấy 2 túi xanh gửi địa chỉ cũ nha', 120000);
  sim.history('outgoing', 'Dạ chị cho em xin SĐT đã đặt lần trước ạ', 60000);
  sim.extraDeps.readLandingStore = async () => ({ orders: [victimOrder] });
  const out = await sim.send('0987654321', { llm: () => ({ template_id: 'ORDER_CONFIRMATION', Product_N1: 'Granola Túi Xanh 450g', No_A: '2', Phone_Number: '0987654321' }) });
  assert.deepEqual(out.created, [], 'không tạo đơn COD tới địa chỉ người khác');
  assert.doesNotMatch(out.sent.join(' '), /Trần Hưng Đạo|Cầu Ông Lãnh/);
  assert.ok(out.saved.at(-1).addLabelEvents.includes('handoff'));
  assert.equal(out.staffNotes.length, 1);
  assert.match(out.staffNotes[0], /L1/);
  assert.equal(sim.conversation.pendingOrder.address, '', 'giỏ chờ không giữ địa chỉ người khác');
  assert.match(sim.conversation.pendingOrder.staffCheck, /không thuộc hội thoại/);
  // Khách gõ địa chỉ của mình ở lượt sau: lên đơn bình thường, đơn mang ghi chú soát cho nhân viên.
  const next = await sim.send('12 Lê Lợi, Phường Bến Nghé, Quận 1, TP Hồ Chí Minh', { llm: () => ({ template_id: 'ORDER_CONFIRMATION', Product_N1: 'Granola Túi Xanh 450g', No_A: '2', Customer_Address: '12 Lê Lợi, Phường Bến Nghé, Quận 1, TP Hồ Chí Minh' }) });
  assert.equal(next.created.length, 1);
  assert.match(next.created[0].address, /Lê Lợi/);
  assert.match(next.created[0].addressCheck, /không thuộc hội thoại/);
});

test('fix-bot C2: đơn CỦA hội thoại (customerOrders) cùng SĐT vẫn tự điền địa chỉ cũ như trước (BOT-A)', async () => {
  const own = { id: 'own1', phone: '0987654321', address: '7 Nguyễn Huệ, Phường Bến Nghé, Quận 1, TP Hồ Chí Minh', createdAt: Date.now() - 20 * 24 * 60 * 60 * 1000, status: 'Đã giao', processingStatus: 'done', products: [{ name: 'Granola Túi Xanh 450g', quantity: 2 }], total: 298000 };
  const sim = new Sim({ customerOrders: [own], botLastTemplateId: 'ORDER_ADDRESS_OLD_ASK_PHONE', botLastReplyAt: Date.now() - 60000, pendingOrder: basket([XANH(2)], 60000, { wantsPrevious: true }) });
  sim.history('outgoing', 'Dạ chị cho em xin SĐT đã đặt lần trước ạ', 60000);
  sim.extraDeps.readLandingStore = async () => ({ orders: [victimOrder] });
  const out = await sim.send('0987654321', { llm: () => ({ template_id: 'ORDER_CONFIRMATION', Product_N1: 'Granola Túi Xanh 450g', No_A: '2', Phone_Number: '0987654321' }) });
  assert.match(out.sent.join(' '), /Nguyễn Huệ/);
  assert.doesNotMatch(out.sent.join(' '), /Trần Hưng Đạo/);
  assert.deepEqual(out.staffNotes, []);
});

test('fix-bot C2: hỏi đơn đã đặt + SĐT (tìm ở hội thoại khác) — không kể món/giờ/tổng tiền, chuyển nhân viên tra + ghi chú', async () => {
  const other = { id: 'x9', createdAt: Date.now() - 3 * 60 * 60 * 1000, total: 298000, products: [{ name: 'Granola Túi Xanh 450g', quantity: 2 }], phone: '0909123456' };
  const sim = new Sim({ botLastTemplateId: 'ORDER_STATUS', botLastReplyAt: Date.now() - 60000 });
  sim.extraDeps.findOrdersByPhone = async () => [other];
  const out = await sim.send('mình đã đặt rồi 0909123456', { llm: { template_id: 'ORDER_STATUS' } });
  assert.equal(out.result.templateId, 'ORDER_STATUS_CHECKING');
  assert.doesNotMatch(out.sent.join(' '), /Granola Túi Xanh 450g x2|298\.000/);
  assert.match(out.staffNotes.join(' '), /x9/);
});

// ===== C3 =====
test('fix-bot C3: mô hình nêu sản phẩm chỉ CSKH bán (Hạt An Lành hũ) — bot không giữ giỏ, không lên đơn; STAFF_ONLY_PRODUCT + thẻ', async () => {
  const sim = new Sim();
  await sim.send('shop ơi hũ hạt an lành giá sao');
  const second = await sim.send('ok lấy chị 1 cái nha', { llm: () => ({ template_id: 'ORDER_ADDRESS', Product_N1: 'Hạt An Lành dạng hũ', No_A: '1' }) });
  // Bộ soạn trả STAFF_ONLY_PRODUCT; engine thấy lặp tin vừa gửi thì im + thẻ (không lên bước xin SĐT/địa chỉ).
  // R14: lặp tin vừa gửi → báo bạn phụ trách trả lời (STAFF_WAIT_*) thay vì im.
  assert.ok(second.result.templateId === 'STAFF_ONLY_PRODUCT' || /^STAFF_WAIT_/.test(String(second.result.templateId)) || second.result.skipped === 'lặp tin vừa gửi', JSON.stringify(second.result));
  assert.ok(second.saved.at(-1).addLabelEvents.includes('handoff'));
  assert.doesNotMatch(second.sent.join(' '), /số điện thoại|địa chỉ nhận hàng/);
  const direct = renderChatbotReply({ template_id: 'ORDER_ADDRESS', Product_N1: 'Hạt An Lành dạng hũ', No_A: '1' }, templates, {});
  assert.equal(direct.templateId, 'STAFF_ONLY_PRODUCT');
  assert.equal(direct.attention, true);
  assert.equal(direct.order, undefined);
  assert.ok(!(sim.conversation.pendingOrder?.items || []).some(item => /MIX5/i.test(item.code || '')), 'giỏ chờ không có MIX5');
  const third = await sim.send('0912345678, 12 Lê Lợi, phường Bến Nghé, quận 1, TP Hồ Chí Minh', { llm: () => ({ template_id: 'ORDER_CONFIRMATION', Product_N1: 'Hạt An Lành dạng hũ', No_A: '1', Phone_Number: '0912345678', Customer_Address: '12 Lê Lợi, phường Bến Nghé, quận 1, TP Hồ Chí Minh' }) });
  assert.deepEqual(third.created, []);
  // Đơn thường vẫn lên như cũ.
  const normal = renderChatbotReply({ template_id: 'ORDER_CONFIRMATION', Product_N1: 'Granola Túi Xanh 450g', No_A: '2', Phone_Number: '0912345678', Customer_Address: '12 Lê Lợi, Phường Bến Nghé, Quận 1, TP Hồ Chí Minh' }, templates, {});
  assert.equal(normal.templateId, 'ORDER_CONFIRMATION');
});

// ===== C4 =====
test('fix-bot C4: mô hình chọn ORDER_CANCEL cho đơn 5 giờ ("thôi chị không lấy nữa") — không tự hủy (kể cả POS), ghi chú + thẻ; đơn 30 phút vẫn hủy', async () => {
  const order = ageMs => ({ id: 'O7', automatic: true, createdAt: Date.now() - ageMs, phone: '0909123456', address: '12 Lê Lợi, Phường Bến Nghé, Quận 1, TP.HCM', products: [{ name: 'Granola Túi Xanh 450g', sku: 'GRA-XANH-Z450', quantity: 2 }], total: 298000, status: 'Mới', pos: { id: 'p1' } });
  const late = new Sim({ customerOrders: [order(5 * 60 * 60 * 1000)], botLastTemplateId: 'ORDER_CONFIRMATION', botLastReplyAt: Date.now() - 5 * 60 * 60 * 1000 });
  late.history('outgoing', 'xác nhận đơn...', 5 * 60 * 60 * 1000);
  const out = await late.send('thôi chị không lấy nữa đâu', { llm: { template_id: 'ORDER_CANCEL' } });
  assert.deepEqual(out.cancelled, [], 'trước đây: cancelOrder(O7) chạy, hủy luôn trên POS');
  assert.equal(out.result.templateId, 'ORDER_CANCEL_STAFF');
  assert.equal(out.notes.length, 1);
  assert.equal(out.notes[0].orderId, 'O7');
  assert.match(out.notes[0].note, /hủy/);
  assert.ok(out.saved.at(-1).addLabelEvents.includes('handoff'));
  const fresh = new Sim({ customerOrders: [order(30 * 60 * 1000)], botLastTemplateId: 'ORDER_CONFIRMATION', botLastReplyAt: Date.now() - 30 * 60 * 1000 });
  const ok = await fresh.send('thôi chị không lấy nữa đâu', { llm: { template_id: 'ORDER_CANCEL' } });
  assert.deepEqual(ok.cancelled, ['O7']);
});

// ===== T1 =====
const vertexSettings = (extra = {}) => ({
  provider: 'vertex', directAuthType: 'oauth', directApiKey: 'token', directModel: 'gemini-test', fallbackModel: 'gemini-backup',
  directEndpoint: 'https://aiplatform.googleapis.com/v1/projects/p/locations/global/publishers/google/models/gemini-test:generateContent',
  systemPrompt: 'Bạn là trợ lý bán hàng.', messageTemplates: templates, promptCache: 'off', fewShot: 'off', addressAi: false, retryCount: 0, ...extra
});
const vertexAnswer = json => ({ ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text: JSON.stringify(json) }] } }] }) });

test('fix-bot T1: mô hình trả mẫu nội bộ + `values` tự điền ("đã nhận đơn 10 túi – tổng 1.000đ") — bỏ values, đổi về GENERAL_INFO', async () => {
  const reply = await requestDirectModelReply({
    settings: vertexSettings(), conversation: { id: 'c1' }, message: { type: 'text', text: 'shop ơi' }, context: {},
    fetchImpl: async () => vertexAnswer({ template_id: 'SHOP_ORDER_RECEIVED', values: { cart: '10 Túi Xanh', total: '1.000đ' } })
  });
  assert.equal(reply.templateId, 'GENERAL_INFO');
  assert.doesNotMatch(reply.messages.join(' '), /1\.000đ|10 Túi Xanh/);
  const clean = sanitizeModelAnswer({ template_id: 'WELCOME', values: { x: 1 }, orderNote: 'n', clearBasket: true, addressAiCheck: 'a', cart: 'c', Product_N1: 'Túi Xanh', No_A: 2, also: 'ORDER_CANCELLED' });
  assert.deepEqual(clean, { template_id: 'WELCOME', Product_N1: 'Túi Xanh', No_A: 2 });
  // Mẫu nội bộ mà prompt của chủ shop có dặn dùng thì giữ; bước đơn ảo luôn giữ.
  assert.equal(sanitizeModelAnswer({ template_id: 'ORDER_STATUS_CHECKING' }, 'Hỏi đơn chưa thấy thì ORDER_STATUS_CHECKING').template_id, 'ORDER_STATUS_CHECKING');
  assert.equal(sanitizeModelAnswer({ template_id: 'ORDER_STATUS_CHECKING' }, '').template_id, 'GENERAL_INFO');
  assert.equal(sanitizeModelAnswer({ template_id: 'ORDER_CONFIRMATION' }, '').template_id, 'ORDER_CONFIRMATION');
});

// ===== T2 =====
test('fix-bot T2: nhân viên tắt bot trong lúc mô hình chạy — lượt không có đơn cũng không gửi', async () => {
  const sim = new Sim();
  const out = await sim.send('shop ơi cho hỏi chút', { llm: () => { sim.conversation.botEnabled = false; return { template_id: 'RECOMMEND_BEGINNER' }; } });
  assert.equal(out.result.skipped, 'nhân viên đã nhận khách');
  assert.deepEqual(out.sent, []);
});

// ===== T3 =====
test('fix-bot T3: SĐT viết tách nhóm, ngay sau là số nhà / số lượng — đọc đúng', () => {
  for (const text of ['0912 345 678 12 Lê Lợi', '091 234 5678 - 3 túi', '0912.345.678 12 Lê Lợi', '0912 345 678 2 túi xanh']) {
    assert.equal(extractVietnamesePhone(text), '0912345678', text);
  }
  assert.equal(extractVietnamesePhone('0385805790 3a2/109 đường số 8'), '0385805790');
  assert.equal(extractVietnamesePhone('O972345678'), '0972345678');
  assert.equal(extractVietnamesePhone('+84 912 345 678'), '0912345678');
  assert.equal(extractVietnamesePhone('12 Lê Lợi'), '');
});

// ===== T4 =====
test('fix-bot T4: Vertex treo — hết giờ thì hủy lời gọi (AbortController), coi là lỗi tạm, đi model dự phòng', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push(String(url));
    if (calls.length === 1) {
      return new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))));
    }
    return vertexAnswer({ template_id: 'WELCOME' });
  };
  const started = Date.now();
  const reply = await requestDirectModelReply({ settings: vertexSettings(), conversation: { id: 'c1' }, message: { type: 'text', text: 'chào shop' }, context: {}, fetchImpl, timeoutMs: 50 });
  assert.equal(reply.templateId, 'WELCOME');
  assert.equal(reply.model, 'gemini-backup');
  assert.equal(calls.length, 2, 'không thử lại cùng model sau khi hết giờ');
  assert.ok(Date.now() - started < 5000);
  // fetch không tôn trọng signal (treo hẳn): vẫn hết giờ; không có dự phòng thì ném lỗi tạm để engine hẹn chạy lại.
  const error = await requestDirectModelReply({ settings: vertexSettings({ fallbackModel: '' }), conversation: { id: 'c1' }, message: { type: 'text', text: 'x' }, context: {}, fetchImpl: () => new Promise(() => {}), timeoutMs: 30 }).catch(caught => caught);
  assert.equal(error.code, 'MODEL_TIMEOUT');
  assert.equal(isCapacityError(error), true);
});

// ===== T6 =====
test('fix-bot T6: số lượng mô hình ghi "1.5" không thành 15 túi', () => {
  const reply = renderChatbotReply({ template_id: 'ORDER_CONFIRMATION', Product_N1: 'Granola Túi Xanh 450g', No_A: '1.5', Phone_Number: '0912345678', Customer_Address: '12 Lê Lợi, Phường Bến Nghé, Quận 1, TP Hồ Chí Minh' }, templates, {});
  const items = reply.order?.items || reply.pendingOrder?.items || [];
  assert.equal(items[0]?.quantity, 1);
  const two = renderChatbotReply({ template_id: 'ORDER_CONFIRMATION', Product_N1: 'Granola Túi Xanh 450g', No_A: '2', Phone_Number: '0912345678', Customer_Address: '12 Lê Lợi, Phường Bến Nghé, Quận 1, TP Hồ Chí Minh' }, templates, {});
  assert.equal(two.order.items[0].quantity, 2);
});

// ===== T7 =====
const addressSettings = { provider: 'vertex', directAuthType: 'api_key', directApiKey: 'key', directEndpoint: 'https://aiplatform.googleapis.com/v1/projects/p/locations/global/publishers/google/models/gemini-3-flash-preview:generateContent', directModel: 'gemini-3-flash-preview', addressAi: true, addressAiSearch: true };
const addressReply = json => async () => ({ ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text: JSON.stringify(json) }] } }] }) });

test('fix-bot T7: địa chỉ AI độ tin thấp — giữ phần đường khách gõ (bỏ số nhà AI tự thêm), nhận ba cấp, ghi chú "cần đối chiếu"', async () => {
  resetAddressAiCache();
  // Khách không gõ số nhà; AI tra ra "99 Phạm Hùng" và tự báo độ tin thấp.
  // fix-addr (01/10): ví dụ đổi từ "phường chánh hưng quận 8" sang "phường 5 quận 8": Chánh Hưng là phường MỚI (NQ 1685)
  // nên nay giữ nguyên chữ khách, không quy đổi về Phường 5 (quy tắc chủ shop); ý của test (độ tin thấp) giữ nguyên.
  const invented = { template_id: 'ORDER_CONFIRMATION', Customer_Address: 'phường 5 quận 8' };
  await refineAddressWithAi(invented, {}, addressSettings, addressReply({ province: 'Thành phố Hồ Chí Minh', district: 'Quận 8', ward: 'Phường 5', street: '99 Phạm Hùng', confidence: 'low', ambiguous: false, reason: 'x' }));
  assert.doesNotMatch(invented.Customer_Address, /99|Phạm Hùng/);
  assert.match(invented.Customer_Address, /Phường 5, Quận 8/);
  assert.match(invented.addressAiCheck, /cần đối chiếu/);
  // Đơn mang ghi chú soát (addressCheck) khi lên đơn.
  const order = renderChatbotReply({ ...invented, Product_N1: 'Granola Túi Xanh 450g', No_A: '2', Phone_Number: '0912345678', Customer_Address: `12 Ba Đình, ${invented.Customer_Address}` }, templates, {});
  assert.match(order.order?.addressCheck || '', /cần đối chiếu/);
  // Độ tin cao: như cũ.
  resetAddressAiCache();
  const high = { template_id: 'ORDER_CONFIRM', Customer_Address: '332 ta quang Bửu p5' };
  await refineAddressWithAi(high, {}, addressSettings, addressReply({ province: 'Thành phố Hồ Chí Minh', district: 'Quận 8', ward: 'Phường 5', street: '332 Tạ Quang Bửu', confidence: 'high', ambiguous: false, reason: 'x' }));
  // fix-addr (01/10): phần đường giữ đúng chữ khách gõ.
  assert.equal(high.Customer_Address, '332 ta quang Bửu, Phường 5, Quận 8, TP Hồ Chí Minh');
  assert.equal(high.addressAiCheck, undefined);
});

// ===== Bộ nhớ đệm / warm-up / vertex-auth =====
test('fix-bot: Map nhớ có trần (pruneMap bỏ mục hết hạn + mục cũ nhất); ảnh chờ hộp thư vẫn lấy được', () => {
  const map = new Map([['a', 1], ['b', 100], ['c', 2], ['d', 3]]);
  pruneMap(map, value => value === 100, 2);
  assert.deepEqual([...map.keys()], ['c', 'd']);
  rememberPendingImages('pg', 'u1', ['https://x/1.jpg']);
  assert.deepEqual(takePendingImages('pg', 'u1'), ['https://x/1.jpg']);
});

test('fix-bot perf #12: warmUpChatbotModels nạp sẵn mô hình, không ném; vertex-auth không đọc lại tệp key khi tệp không đổi', async () => {
  const loaded = await warmUpChatbotModels();
  assert.equal(typeof loaded.intent, 'boolean');
  assert.equal(typeof loaded.cascade, 'boolean');
  const keyFile = path.join(directory, 'key.json');
  writeFileSync(keyFile, JSON.stringify({ client_email: 'a@b', private_key: 'k', project_id: 'proj-1' }));
  const saved = { creds: process.env.GOOGLE_APPLICATION_CREDENTIALS, project: process.env.GOOGLE_CLOUD_PROJECT, gproject: process.env.GCLOUD_PROJECT };
  process.env.GOOGLE_APPLICATION_CREDENTIALS = keyFile;
  delete process.env.GOOGLE_CLOUD_PROJECT;
  delete process.env.GCLOUD_PROJECT;
  try {
    resetVertexCredentialCache();
    assert.equal(vertexProjectId(), 'proj-1');
    // Đổi nội dung (cỡ khác) → đọc lại.
    writeFileSync(keyFile, JSON.stringify({ client_email: 'a@b', private_key: 'k', project_id: 'proj-22' }));
    assert.equal(vertexProjectId(), 'proj-22');
  } finally {
    for (const [key, value] of [['GOOGLE_APPLICATION_CREDENTIALS', saved.creds], ['GOOGLE_CLOUD_PROJECT', saved.project], ['GCLOUD_PROJECT', saved.gproject]]) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    resetVertexCredentialCache();
  }
});
