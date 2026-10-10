import assert from 'node:assert/strict';
import test from 'node:test';
import './helpers/seed-catalog.mjs';
import { commentBasket, isTagOnlyComment, processChatbotChanges, withFallbackTemplates } from '../app/chatbot-engine.mjs';
import { defaultMessageTemplates, renderChatbotReply } from '../app/chatbot-templates.mjs';
import { ruleIntent } from '../app/processing/rule-intent.mjs';
import { trialStep } from '../app/processing/trial-flow.mjs';
import { rowsFromDecisionLog } from '../tools-intent/build-dataset.mjs';
import { addEntry } from '../tools-intent/shadow-report.mjs';

// Vòng 12 (r12, rà hội thoại thật 28/09–01/10, SĐT là số giả): nhật ký trạng thái TRƯỚC lượt, không bỏ rơi khách,
// luật mới từ câu khách thật, sticker, quà/giá theo ngữ cảnh live, ảnh + chữ, bình luận.
const seed = Object.fromEntries(Object.entries(defaultMessageTemplates()).map(([id, text]) => [id, text.trim()]));
const templates = withFallbackTemplates(seed);
const XANH = quantity => ({ product: 'Granola Túi Xanh 450g', code: 'GRA-XANH-Z450', quantity });
const VANG = quantity => ({ product: 'Granola Túi Vàng 350g', code: 'GRA-VANG-H350', quantity });
const basket = (items, agoMs = 30000, extra = {}) => ({ items, key: items.map(item => `${item.code}=${item.quantity}`).sort().join('|'), at: Date.now() - agoMs, phone: '', address: '', addressAsks: 0, ...extra });
const inbox = extra => ({ source: 'inbox', botLastTemplateId: '', botLastAgeMin: Infinity, bundleSize: 1, commentBasket, ...extra });
const pick = (text, ctx = inbox()) => ruleIntent(text, ctx);
const settle = () => new Promise(resolve => setImmediate(resolve));

let counter = 0;
/** Hội thoại nhiều lượt. Như kho thật: getConversation trả CÙNG đối tượng mà saveBotState ghi đè (lỗi nhật ký vòng 11). */
class Sim {
  constructor(conversation = {}, settings = {}) {
    this.conversation = { id: 'page:user', pageId: 'page', psid: 'user', name: 'Khách', botEnabled: true, ...conversation };
    this.recent = [];
    this.records = [];
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
    const sent = [];
    const saved = [];
    const asked = [];
    const created = [];
    const notes = [];
    const moderated = [];
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
      addOrderNote: async (_c, orderId, note) => { notes.push({ orderId, note }); return { noted: true }; },
      moderateComment: async (_c, _m, options) => { moderated.push(options); },
      requestReply: async payload => {
        asked.push(payload);
        const answer = typeof llm === 'function' ? llm(payload, asked.length) : llm;
        if (!answer) return { templateId: 'LLM_CALLED', messages: ['[mô hình]'], handoff: false };
        return answer.template_id ? renderChatbotReply(answer, templates, payload.context || {}) : answer;
      },
      appendDecisionLog: record => { self.records.push(record); },
      ...this.extraDeps
    });
    await settle();
    return { result: results[0] || {}, sent, saved, asked, created, notes, moderated };
  }
}

// ===== 1. Nhật ký quyết định =====

test('1. nhật ký v2: prevBot/lastTemplate/prevBotAgeMin/prevBotAsks là trạng thái TRƯỚC lượt (kho trả cùng đối tượng), có receivedAt', async () => {
  const sim = new Sim({ botLastTemplateId: 'PRICE_QUOTE', botLastReplyAt: Date.now() - 5 * 60000 });
  sim.history('outgoing', 'Dạ, em gửi chị Bảng giá Granola Túi Xanh 450g để mình dễ tham khảo ạ', 5 * 60000);
  const out = await sim.send('Cho mình 1 xanh 1 vàng');
  assert.equal(out.result.templateId, 'ORDER_ADDRESS');
  assert.equal(sim.conversation.botLastTemplateId, 'ORDER_ADDRESS', 'kho đã ghi trạng thái mới');
  const row = sim.records.at(-1);
  assert.equal(row.v, 2);
  assert.equal(row.prevBot, 'PRICE_QUOTE', 'không phải mẫu vừa trả lời (lỗi rò đáp án vòng 11)');
  assert.equal(row.lastTemplate, 'PRICE_QUOTE');
  assert.ok(row.prevBotAgeMin >= 4.9 && row.prevBotAgeMin <= 5.2);
  assert.equal(row.prevBotAsks, '');
  assert.equal(row.final, 'ORDER_ADDRESS');
  assert.ok(Date.parse(row.receivedAt) <= Date.parse(row.at));
});

test('1b. build-dataset: bản ghi v1 không đọc prevBot/lastTemplate/prevBotAsks (ghi sau khi trả lời) — dựng lại từ prevBotText / lượt trước', () => {
  const t0 = Date.parse('2026-09-29T10:00:00+07:00');
  const ctx = { hasBasket: false, hasRecentOrder: false, orderAgeMin: null, lastWasOrderStep: false, livestream: false, phoneInText: false, addressInText: false, bagCount: 0 };
  const entries = [
    { v: 1, at: t0, conversationId: 'c1', source: 'inbox', mid: 'a', type: 'text', text: 'giá sao', prevBot: 'GENERAL_INFO', prevBotAsks: '', ctx, final: 'GENERAL_INFO' },
    { v: 1, at: t0 + 60000, conversationId: 'c1', source: 'inbox', mid: 'b', type: 'text', text: 'cho 2 túi xanh', prevBot: 'ORDER_ADDRESS', prevBotAsks: 'phone_address', prevBotAgeMin: 0, ctx, final: 'ORDER_ADDRESS' },
    { v: 2, at: t0 + 120000, conversationId: 'c1', source: 'inbox', mid: 'c', type: 'text', text: '0912345678', prevBot: 'ORDER_ADDRESS', prevBotAsks: 'phone_address', prevBotAgeMin: 1, ctx, final: 'ORDER_ADDRESS' }
  ];
  const stats = {};
  const rows = rowsFromDecisionLog(entries, { templates: {}, stats });
  const [first, second, third] = rows;
  assert.equal(stats.legacyPrev, 2);
  assert.equal(first.lastTemplate, '', 'v1 không có lượt trước, không prevBotText → rỗng (không rò GENERAL_INFO = final)');
  assert.equal(second.lastTemplate, 'GENERAL_INFO', 'v1: lấy final của lượt trước cùng hội thoại');
  assert.equal(second.prevBotAsks, '', 'v1: prevBotAsks bỏ trống');
  assert.equal(second.prevBotAgeMin, null);
  assert.deepEqual([third.lastTemplate, third.prevBotAsks, third.prevBotAgeMin], ['ORDER_ADDRESS', 'phone_address', 1], 'v2 đọc thẳng');
});

// ===== 2. Không bỏ rơi khách =====

test('2a. "2 túi này ak\\n<sđt>\\nĐc:… Bến Tre\\nĐc cũ" sau ASK_FLAVOR: không im vì "lặp" — ghi nhận SĐT, hỏi vị, thẻ cần người', async () => {
  const sim = new Sim({ botLastTemplateId: 'ASK_FLAVOR', botLastReplyAt: Date.now() - 60000 });
  const askFlavor = renderChatbotReply({ template_id: 'ASK_FLAVOR' }, templates, {}).messages[0];
  sim.history('incoming', '2 túi', 70000).history('outgoing', askFlavor, 60000);
  const out = await sim.send('2 túi này ak\n0912345678\nĐc: ấp 3 xã Phú Túc, Châu Thành, Bến Tre\nĐc cũ', { llm: { template_id: 'ASK_FLAVOR' } });
  assert.notEqual(out.result.skipped, 'lặp tin vừa gửi');
  assert.ok(out.sent.length >= 1, 'có trả lời');
  // Chủ shop 05/10: khách đã nêu số túi, gửi SĐT + địa chỉ mà chưa nêu vị sau câu hỏi vị → mặc định 2 Túi Xanh và lên đơn (trước
  // đây hỏi vị lần nữa + thẻ cần người — test cũ khẳng định ORDER_INFO_ASK_FLAVOR).
  assert.equal(out.result.templateId, 'ORDER_CONFIRMATION');
  assert.match(out.sent.join(' '), /em lên 2 Túi Xanh nguyên bản 450g/);
});

test('2b. thẻ handoff + nhân viên nhắn cuối 4,5 giờ trước: bot vẫn trả lời ("2 gói 1 vàng 1 xanh giá bn"); khiếu nại 24 giờ vẫn im', async () => {
  const sim = new Sim({ labels: ['handoff'], botLastTemplateId: 'GENERAL_INFO', botLastReplyAt: Date.now() - 6 * 3600000 });
  sim.history('outgoing', 'Dạ chị chờ em kiểm tra nha', 4.5 * 3600000, { staff: true });
  const out = await sim.send('2 gói 1 vàng 1 xanh giá bn', { llm: { template_id: 'PRICE_MIX_TUI_LON' } });
  assert.notEqual(out.result.skipped, 'nhân viên đang xử lý');
  assert.ok(out.sent.length >= 1);
  const complaint = new Sim({ labels: ['complaint'], botLastTemplateId: 'GENERAL_INFO', botLastReplyAt: Date.now() - 6 * 3600000 });
  complaint.history('outgoing', 'Dạ chị chờ em kiểm tra nha', 4.5 * 3600000, { staff: true });
  assert.equal((await complaint.send('giá bao nhiêu')).result.skipped, 'nhân viên đang xử lý');
});

test('2c. khách nhắn thêm ngay trước khi gọi mô hình: không gọi LLM, nhường tin sau', async () => {
  const sim = new Sim();
  let lists = 0;
  const later = { id: 'later', direction: 'incoming', type: 'text', text: 'à cho mình hỏi thêm', createdAt: Date.now() + 1000 };
  sim.extraDeps.listMessages = async () => { lists += 1; return lists >= 2 ? [...sim.recent, later] : [...sim.recent]; };
  const out = await sim.send('túi này người già ăn có tốt không, mua tặng bố mẹ thì lấy loại nào cho hợp với sức khỏe của ông bà');
  assert.equal(out.asked.length, 0, 'không tốn lượt LLM');
  assert.equal(out.result.skipped, 'gộp với tin sau');
});

test('2d. bình luận có SĐT: bot tắt ở luồng → vẫn ẩn; bị coi là lặp → gắn thẻ + ẩn', async () => {
  const off = new Sim({ id: 'page:comment:c1:p1', source: 'comment', botEnabled: false }, { commentHide: 'phone' });
  const hidden = await off.send('O972111222 lấy 2 túi');
  assert.deepEqual(hidden.moderated, [{ like: false, hide: true }]);
  assert.deepEqual(hidden.sent, []);
});

// ===== 3. Luật mới từ câu khách thật =====

test('3a. hỏi giá có tiền tố / TERSE_D → báo giá; "giá các mặt hàng", "có những loại nào" → bảng đủ vị (listAll); "hạt" không bắt', () => {
  for (const text of ['Chị cho em xin giá', 'alo giá thế nào ạ', 'Granola giá sao 1 túi', 'Bịch nhieu Zay chi', 'Xin giá các mặt hàng']) {
    assert.equal(pick(text)?.value?.template_id, 'GENERAL_INFO', text);
  }
  assert.equal(pick('Xin giá các mặt hàng')?.value?.listAll, '1');
  assert.equal(pick('Granola có những loại nào')?.value?.listAll, '1');
  assert.notEqual(pick('hạt giá bao nhiêu')?.value?.template_id, 'GENERAL_INFO', 'hạt: chỉ CSKH bán');
});

test('3b. hủy / khoan giao / ghi chú giao hàng theo đơn đang mở', () => {
  const order = extra => inbox({ hasRecentOrder: true, ...extra });
  assert.equal(pick('cho c xin huỷ đơn shop nhé', order({ orderAgeMin: 20 }))?.value?.template_id, 'ORDER_CANCEL');
  const late = pick('c xin huỷ e ui', order({ orderAgeMin: 200 }));
  assert.deepEqual([late?.value?.template_id, late?.attention, Boolean(late?.orderNote)], ['ORDER_CANCEL_STAFF', true, true]);
  const hold = pick('Đơn này khoan giao nha shop', order({ orderAgeMin: 300 }));
  assert.deepEqual([hold?.value?.template_id, hold?.attention], ['ORDER_HOLD_STAFF', true]);
  assert.equal(pick('Giao trong giờ hành chính em nhé', order({ orderAgeMin: 30 }))?.value?.template_id, 'ORDER_NOTE');
  const basketCancel = pick('xin hủy', inbox({ hasBasket: true, lastWasOrderStep: true, botLastTemplateId: 'ORDER_ADDRESS', botLastAgeMin: 2 }));
  assert.deepEqual([basketCancel?.rule, basketCancel?.clearBasket], ['CANCEL_BASKET', true]);
});

test('3c. thông tin nhỏ: đồng kiểm, mùi hôi, cách ăn, đổi quà, hỏi quà, bỏ nho khô, tăng cân, tiểu đường, chay, công dụng, chi nhánh, nơi SX, gửi hình', () => {
  const cases = [
    ['mua 3 gói có cho kiểm tra hàng trước khi thanh toán ko', 'INSPECTION_RETURN_POLICY'],
    ['Liệu bóc ra có mùi hôi ko', 'OIL_SMELL_WARRANTY'],
    ['Gói này ăn như thế nào', 'HOW_TO_USE_GRANOLA'],
    ['Ăn trực tiếp đc ko hay phải ngâm', 'HOW_TO_USE_GRANOLA'],
    ['Mỗi lần ăn dùng bao nhiêu', 'HOW_TO_USE_GRANOLA'],
    ['Em kgg lấy quạt tặng em cái muỗng', 'GIFT_SWAP'],
    ['Ko lấy bát có trừ tiền ko', 'GIFT_SWAP'],
    ['Bộ bát gì', 'GIFT_POLICY'],
    ['Tặng quạt jì', 'GIFT_POLICY'],
    ['đừng bỏ nho khô được không', 'NO_VARIANT'],
    ['A muốn tăng cân', 'WEIGHT_GAIN'],
    ['Ng đường hơi cao có ăn đc ko', 'HEALTH_DIABETES'],
    ['người ăn chay ăn được không', 'VEGAN_INFO'],
    ['Công dụng như nào', 'BENEFITS'],
    ['shop có chi nhánh ở Đà Nẵng không', 'STORE_ADDRESS'],
    ['Sx ở đâu vậy', 'PRODUCTION_PLACE'],
    ['Gửi hình e xem', 'PRODUCT_PHOTOS'],
    ['loại có chia phần nhỏ nhỏ dùng 1 lần không túi vàng và túi xanh', 'PACKAGING_INFO'],
    ['Trên này bn có 159k mà', 'PRICE_COMPARE'],
    ['Túi xanh, túi vàng có hạt óc chó hạt bí xanh hả em', 'INGREDIENTS_ALLERGY']
  ];
  for (const [text, id] of cases) assert.equal(pick(text)?.value?.template_id, id, text);
  assert.equal(pick('mua cho bệnh nhân nên hỏi kỹ')?.attention, true, 'người bệnh → thẻ');
  assert.equal(pick('Bn gram 1túi và có bị hôi ko'), null, 'hai câu hỏi → mô hình');
  assert.equal(pick('không lấy quả được không')?.value?.template_id, 'NO_VARIANT', '"quả" (trái cây) ≠ "quà"');
});

test('3d. giá: "3 túi bao nhiêu" 447k + quà, "Lấy 4 túi có ưu đãi ko" 596k, "1 túi màu vàng giá như nào" 189k + mời lên 1 túi, giá 2 màu → bảng mix, "combo 2" → hỏi vị', () => {
  const three = pick('3 túi bao nhiêu');
  assert.deepEqual([three?.value?.template_id, three?.value?.values?.total], ['PRICE_COUNT', '447.000đ']);
  assert.match(three.value.values.gift, /bát/i);
  assert.equal(pick('Lấy 4 túi có ưu đãi ko')?.value?.values?.total, '596.000đ');
  const one = pick('Mình lấy 1 túi màu vàng giá như nào');
  assert.deepEqual([one?.value?.template_id, one?.value?.values?.total, one?.holdBasket?.quantity], ['PRICE_ONE_BAG', '189.000đ', 1]);
  assert.equal(pick('giá túi xanh và vàng')?.value?.template_id, 'PRICE_MIX_TUI_LON');
  // Chủ shop 05/10: "combo 2" không vị → mặc định 2 Túi Xanh (trước đây hỏi vị).
  assert.deepEqual([pick('combo 2')?.value?.template_id, pick('combo 2')?.value?.Product_N1, pick('combo 2')?.value?.No_A], ['ORDER_ADDRESS', 'Granola Túi Xanh 450g', '2']);
  assert.equal(pick('Lần trước ship toàn túi vàng')?.value?.template_id, 'ASK_REORDER');
});

test('3e. sản phẩm chỉ CSKH bán / Tropical / "mã gì" / lo ngại nguồn gốc', () => {
  for (const text of ['Hộp nhựa là mã gì. Bn gram. Giá bn', 'Mình muốn mua hạt', 'loại đựng trong lọ']) {
    const ruled = pick(text, inbox({ livestream: true }));
    assert.deepEqual([ruled?.value?.template_id, ruled?.attention], ['STAFF_ONLY_PRODUCT', true], text);
  }
  assert.equal(pick('túi xanh biển nhạt giá sao')?.value?.Product_N1, 'Granola Tropical vị Cacao 300g');
  assert.equal(pick('lấy 2 túi xanh ngọc')?.value?.Product_N1, 'Granola Tropical vị Cacao 300g');
  assert.equal(pick('xanh nhạt còn không')?.value?.template_id, 'TROPICAL_CONFIRM');
  for (const text of ['Túi đó hsd gần quá', 'số nguồn gốc china', 'thấy có 2 giọt nắng này']) assert.equal(pick(text)?.value?.template_id, 'CSKH_HANDOFF', text);
});

test('3f. smallPackContext chỉ theo tin khách / giỏ: lời chào live có "gói nhỏ" không tắt luật giỏ', async () => {
  const sim = new Sim({ labels: ['livestream'], botLastTemplateId: 'LIVESTREAM_COMMENT', botLastReplyAt: Date.now() - 60000 });
  sim.history('outgoing', renderChatbotReply({ template_id: 'LIVESTREAM_COMMENT' }, templates, {}).messages[0], 60000);
  const out = await sim.send('1 tui vang va 1 tui xanh');
  assert.equal(out.asked.length, 0);
  assert.equal(out.result.templateId, 'ORDER_ADDRESS');
});

// ===== 4–5. Cảm ơn, bình luận, khách live =====

test('4a. THANK_YOU của mô hình cho tin không phải lời cảm ơn → hỏi lại mô hình; vẫn cảm ơn → im + thẻ', async () => {
  const sim = new Sim();
  const out = await sim.send('Lần này mà ko ok là chị nghỉ chơi', { llm: (_p, n) => (n === 1 ? { template_id: 'THANK_YOU' } : { template_id: 'FRESHNESS' }) });
  assert.equal(out.asked.length, 2);
  assert.equal(out.result.templateId, 'FRESHNESS');
  const stubborn = await new Sim().send('nhận hàng bận quá h mới bóc xem', { llm: { template_id: 'THANK_YOU' } });
  assert.equal(stubborn.result.skipped, 'mô hình cảm ơn tin không phải lời cảm ơn');
  assert.deepEqual(stubborn.sent, []);
  const thanks = await new Sim().send('cảm ơn shop nhiều', { llm: { template_id: 'THANK_YOU' } });
  assert.equal(thanks.result.templateId, 'THANK_YOU');
});

test('4b. bình luận: "Hok ngon nha" → xin lỗi công khai + thẻ (không cảm ơn); góp ý live → cảm ơn góp ý, không bảng giá; chỉ tag bạn → chỉ like', async () => {
  const comment = () => new Sim({ id: 'page:comment:c9:p1', source: 'comment', post: { message: 'Săn deal hời cùng Giọt Nắng' } }, { commentLike: true });
  const bad = await comment().send('Hok ngon nha', { llm: { template_id: 'THANK_YOU' } });
  assert.ok(bad.sent.some(text => /xin lỗi/i.test(text)));
  assert.ok(!bad.sent.some(text => /cảm ơn/i.test(text)));
  const feedback = await comment().send('nói chả nghe gì', { llm: { template_id: 'GENERAL_INFO' } });
  assert.ok(feedback.sent.some(text => /góp ý/.test(text)));
  assert.ok(!feedback.sent.some(text => /174\.000đ|Bảng giá/.test(text)));
  const tag = await comment().send('Nguyễn Thị Lan', { message: { messageTags: [{ name: 'Nguyễn Thị Lan' }] } });
  assert.equal(tag.result.skipped, 'bình luận chỉ tag bạn bè');
  assert.deepEqual(tag.sent, []);
  assert.equal(isTagOnlyComment({ text: 'Cho mình xin giá' }), false);
});

test('5. khách live: hỏi quà → Quạt (bỏ điều kiện từ khóa); hỏi giá túi → lời chào live; ảnh từ QC live → lời chào live', async () => {
  const live = () => new Sim({ labels: ['livestream'], botLastTemplateId: 'WELCOME', botLastReplyAt: Date.now() - 3600000 });
  const gift = await live().send('Nhớ tặng kèm quà nhe', { llm: { template_id: 'GIFT_POLICY' } });
  assert.equal(gift.result.templateId, 'GIFT_POLICY_LIVE');
  assert.match(gift.sent.join('\n'), /Quạt/);
  assert.doesNotMatch(gift.sent.join('\n'), /combo 3|từ 3 sản phẩm/);
  const price = await live().send('túi xanh giá sao', { llm: { template_id: 'PRICE_QUOTE', Product_N1: 'Granola Túi Xanh 450g' } });
  assert.equal(price.result.templateId, 'LIVESTREAM_COMMENT');
  const image = await live().send('', { type: 'image', message: { dataUrl: 'https://content.pancake.vn/x.jpg' } });
  assert.equal(image.result.templateId, 'LIVESTREAM_COMMENT');
});

test('5b. ưu đãi dùng thử: trong cửa sổ 36 giờ "lấy 1 túi xanh nếu miễn ship thì chốt" → chốt túi đó (miễn ship); ngoài cửa sổ → phí ship + mời combo 2', () => {
  const inside = trialStep({ text: 'lấy 1 túi xanh nếu miễn ship thì chốt', trial: { freeShipping: true, stage: 'offered', until: Date.now() + 86400000 } });
  assert.deepEqual([inside.value?.template_id, inside.value?.Product_N1, inside.value?.also], ['ORDER_ADDRESS', 'Granola Túi Xanh 450g', 'TRIAL_FREESHIP_INFO']);
  // R17 (gói C, inbox5 A9 / inbox3 A9): ngoài cửa sổ → PRICE_ONE_BAG (1 túi = giá + phí ship 15k, 2 túi 298k miễn ship) và GIỮ giỏ
  // 1 túi (trước: FREESHIP_POLICY "lấy 2 túi vị nào", khách xin 1 túi phải nói lại).
  const outside = pick('lấy 1 túi thử nếu miễn ship mình chốt');
  assert.equal(outside?.value?.template_id, 'PRICE_ONE_BAG');
  assert.deepEqual(outside.holdBasket, { product: 'Granola Túi Xanh 450g', quantity: 1 });
  const said = renderChatbotReply(outside.value, templates, {}).messages.join(' ');
  assert.match(said, /phí ship 15\.000đ = 189\.000đ/);
  assert.match(said, /298\.000đ, miễn phí vận chuyển/);
});

// ===== Sticker =====

test('sticker: 👍 sau "em lên 1 túi nha?" = đồng ý (lên bước đơn); sau xác nhận đơn → cảm ơn một lần; sticker khác / 👍 chỗ khác → im; nhật ký ghi cờ', async () => {
  const like = { type: 'image', message: { dataUrl: 'https://content.pancake.vn/2.1/stickers/369239263222822' } };
  const sim = new Sim();
  const quote = await sim.send('Mình lấy 1 túi màu vàng giá như nào');
  assert.equal(quote.result.templateId, 'PRICE_ONE_BAG');
  assert.match(quote.sent[0], /189\.000đ/);
  const agreed = await sim.send('', like);
  assert.ok(['ORDER_ADDRESS', 'ORDER_ADDRESS_REMIND'].includes(agreed.result.templateId), '👍 = đồng ý lên 1 túi');
  assert.match(agreed.sent.join('\n'), /số điện thoại/);
  assert.deepEqual(sim.records.at(-1).sticker, { id: '369239263222822', like: true });

  const closed = new Sim({ botLastTemplateId: 'ORDER_CONFIRMATION', botLastReplyAt: Date.now() - 60000 });
  const thanks = await closed.send('', like);
  assert.equal(thanks.result.templateId, 'THANK_YOU');
  assert.equal((await closed.send('', like)).result.skipped, 'like (không cần trả lời)', 'cảm ơn rồi thì thôi');

  const other = await new Sim({ botLastTemplateId: 'ORDER_CONFIRMATION', botLastReplyAt: Date.now() - 60000 }).send('', { type: 'image', message: { dataUrl: 'https://content.pancake.vn/2.1/stickers/126361874215276' } });
  assert.equal(other.result.skipped, 'sticker');
  const idle = await new Sim({ botLastTemplateId: 'GENERAL_INFO', botLastReplyAt: Date.now() - 60000 }).send('', like);
  assert.equal(idle.result.skipped, 'like (không cần trả lời)');
  assert.deepEqual(idle.sent, [], 'không chào lại bảng giá, không "đã nhận hình"');
});

// ===== 7. Ảnh + chữ =====

test('7. ảnh + chữ cùng đợt: "Mình chuyển khoản" + ảnh → báo đã nhận CK + thẻ; "Chị lấy 3 bịch này" + ảnh → báo giá 3 túi + hỏi vị + thẻ', async () => {
  const paid = new Sim();
  paid.history('incoming', 'Mình chuyển khoản rồi nha', 5000);
  const bill = await paid.send('', { type: 'image', message: { dataUrl: 'https://content.pancake.vn/bill.jpg' } });
  assert.equal(bill.result.templateId, 'PAYMENT_RECEIVED_CHECK');
  assert.ok(bill.saved.at(-1).addLabelEvents?.includes('handoff'));
  const three = new Sim();
  three.history('incoming', 'Chị lấy 3 bịch này', 4000);
  const out = await three.send('', { type: 'image', message: { dataUrl: 'https://content.pancake.vn/tui.jpg' } });
  assert.equal(out.result.templateId, 'PRICE_COUNT');
  assert.match(out.sent.join('\n'), /447\.000đ/);
  assert.ok(out.saved.at(-1).addLabelEvents?.includes('handoff'));
});

// ===== 11. Biên nhận trùng =====

test('11. không gửi biên nhận thứ hai khi đã có [order-receipt] trong 2 phút', async () => {
  const sim = new Sim({ botLastTemplateId: 'ORDER_ADDRESS', botLastReplyAt: Date.now() - 60000, pendingOrder: basket([XANH(1), VANG(1)], 60000, { address: '12 Lê Lợi, Phường Bến Nghé, Quận 1, TP Hồ Chí Minh' }) });
  sim.history('outgoing', 'Đã gửi xác nhận đơn hàng', 30000, { type: 'order-receipt' });
  let receipts = 0;
  sim.extraDeps.sendReceipt = async () => { receipts += 1; };
  const out = await sim.send('0912345678');
  assert.equal(out.result.templateId, 'ORDER_CONFIRMATION');
  assert.equal(receipts, 0);
});

// ===== 12. Công cụ đo =====

test('12. shadow-report: chỉ tính "nguy hiểm" khi tầng đoán nhóm được tự trả lời; bỏ lượt conversationId "test"', () => {
  const day = () => ({ turns: 0, skipped: {}, ruleStable: 0, rules: {}, llm: 0, llmTemplates: {}, intent: {}, cascade: { group: { n: 0, ok: 0, bad: 0, danger: 0 }, tpl: {}, byGroup: {} }, preGuard: {}, gate: {}, finals: {}, tokens: { input: [], cached: [], output: [], thinking: [] }, thinkingTurns: 0, handoff: 0, attention: 0, cost: 0 });
  const groupOf = id => (/^ORDER/.test(id) ? 'ORDER' : 'ANSWER');
  const supportGuess = day();
  addEntry(supportGuess, { llm: { templateId: 'ORDER_ADDRESS' }, chosen: 'ORDER_ADDRESS', final: 'ORDER_ADDRESS', cascade: { group: 'SUPPORT', templateId: 'CSKH_HANDOFF', p: 0.5 } }, undefined, { groupOf });
  assert.equal(supportGuess.cascade.group.danger, 0);
  const answerGuess = day();
  addEntry(answerGuess, { llm: { templateId: 'ORDER_ADDRESS' }, chosen: 'ORDER_ADDRESS', final: 'ORDER_ADDRESS', cascade: { group: 'ANSWER', templateId: 'GENERAL_INFO', p: 0.5 } }, undefined, { groupOf });
  assert.equal(answerGuess.cascade.group.danger, 1);
  const testTurn = day();
  addEntry(testTurn, { conversationId: 'test', final: 'GENERAL_INFO' });
  assert.equal(testTurn.turns, 0);
});

test('B3 #7 / #22: "Mình lấy 1 đơn thôi" khi đang hỏi đặt thêm = KHÔNG (không tạo đơn); nhân viên trả lời trong lúc bot soạn → không gửi chồng', async () => {
  const pending = basket([XANH(2)], 60000, { phone: '0912345678', address: '12 Lê Lợi, Phường Bến Nghé, Quận 1, TP Hồ Chí Minh', awaitingConfirm: true });
  const sim = new Sim({ botLastTemplateId: 'ORDER_EXISTING_CONFIRM', botLastReplyAt: Date.now() - 60000, pendingOrder: pending, customerOrders: [{ id: 'o1', createdAt: Date.now() - 3600000, products: [{ name: 'Granola Túi Xanh 450g', sku: 'GRA-XANH-Z450', quantity: 2 }], status: 'Mới' }] });
  const out = await sim.send('Mình lấy 1 đơn thôi');
  assert.equal(out.created.length, 0);
  // R15-fix4 (thiết kế gộp/tách mới, chủ shop 03/10): câu không rõ gộp hay tách → bạn phụ trách (trước: ORDER_STATUS kể đơn cũ).
  // R17 (gói B, inbox5 A3): "1 đơn thôi" là câu RÕ "không đặt thêm"; giỏ chờ trùng đúng món đơn đang có → kể đơn, bỏ giỏ.
  assert.equal(out.result.templateId, 'ORDER_STATUS');
  const busy = new Sim();
  busy.extraDeps.requestReply = async () => {
    busy.recent.push({ id: 'staff-1', direction: 'outgoing', type: 'text', text: 'Dạ chị ơi em báo giá ạ', staff: true, createdAt: Date.now() + 5 });
    return renderChatbotReply({ template_id: 'GENERAL_INFO' }, templates, {});
  };
  const quiet = await busy.send('à mà bên em làm việc tới mấy giờ thế');
  assert.equal(quiet.result.skipped, 'nhân viên vừa trả lời');
  assert.deepEqual(quiet.sent, []);
});

test('02/10: lời công khai dưới bình luận hết giờ chờ Pancake (PANCAKE_SEND_UNCERTAIN) → không báo "Bot chưa trả lời được", vẫn lưu trạng thái', async () => {
  const sim = new Sim({ id: 'page:comment:c10:p1', source: 'comment', post: { message: 'Săn deal cùng Giọt Nắng ạ' } });
  const sent = [];
  sim.extraDeps.sendMessage = async (_c, payload) => {
    sent.push(payload);
    if (!payload.privateReply) throw Object.assign(new Error('Pancake không rõ đã nhận tin (hết giờ chờ 15 giây) — không rõ đã gửi; không tự gửi lại, lần gửi sau sẽ kiểm tin trên Pancake trước.'), { code: 'PANCAKE_SEND_UNCERTAIN', unknownDelivery: true });
    return { message: { mid: 'x' } };
  };
  const turn = await sim.send('C gói nâu', { llm: { template_id: 'PRICE_QUOTE' } });
  assert.ok(sent.some(payload => !payload.privateReply), 'đã thử đăng lời công khai');
  assert.ok(!turn.result.error, `lượt không bị coi là lỗi: ${turn.result.error}`);
  assert.ok(turn.saved.some(state => state.botLastReplyAt && !state.botLastError), 'trạng thái bot được lưu, không ghi lỗi');
});

test('03/10: bảng giá live ghi rõ chưa gồm ship 15.000đ; khách so 174k với 189k → giải thích đã cộng ship, không "giá có điều chỉnh"', async () => {
  assert.match(seed.LIVESTREAM_COMMENT, /chưa gồm phí vận chuyển 15\.000đ/);
  for (const text of ['TN trước 1 túi xanh nguyên bản là 174.000₫ mà shop', 'Vậy sao tin nhắn vừa rồi lại 189.000₫']) {
    const sim = new Sim({ botLastTemplateId: 'LIVESTREAM_COMMENT', botLastReplyAt: Date.now() - 60000 }).history('outgoing', seed.LIVESTREAM_COMMENT.replace(/\{title\}/g, 'chị').replace(/\{Title\}/g, 'Chị'), 60000);
    const turn = await sim.send(text);
    assert.equal(turn.asked.length, 0, `không gọi mô hình: ${text}`);
    assert.ok(turn.sent.some(out => /174\.000đ \+ 15\.000đ = 189\.000đ/.test(out)), `${text} → ${turn.sent.join(' / ')}`);
    assert.ok(!turn.sent.some(out => /điều chỉnh/.test(out)));
  }
  assert.notEqual(pick('lấy 1 túi xanh 174k nhé')?.rule, 'PRICE_SHIP_EXPLAIN');
});
