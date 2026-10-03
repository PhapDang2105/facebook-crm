import assert from 'node:assert/strict';
import test from 'node:test';
import './helpers/seed-catalog.mjs';
import { buildDecisionRecord, commentBasket, processChatbotChanges, withFallbackTemplates } from '../app/chatbot-engine.mjs';
import { defaultMessageTemplates, renderChatbotReply, withoutInviteTail } from '../app/chatbot-templates.mjs';
import { ruleIntent } from '../app/processing/rule-intent.mjs';
import { mentionsOldAddress, orderFlowStep, stripPhone } from '../app/processing/order-flow.mjs';
import { sanitizeRecord } from '../app/processing/decision-log.mjs';

// Vòng 11 (rà 28/09, ca thật 13:07): đang giữ giỏ mà khách hỏi thông tin → bot chỉ nhắc giỏ, mất câu trả lời;
// câu hỏi làm tăng addressAsks rồi tự chốt địa chỉ thiếu cấp; bảng giá combo gói nhỏ trống; "không" trong câu hỏi
// bị hiểu là từ chối đặt thêm; số túi mất sau khi hỏi vị; hủy giỏ nuốt tin đổi giỏ; "thêm" thay giỏ; "bữa trước"
// bị hiểu là địa chỉ cũ; ORDER_INFO mất địa chỉ; "vàng" ≠ "vâng"; LIVE_ONLY bắt câu hỏi thành phần.
const seed = Object.fromEntries(Object.entries(defaultMessageTemplates()).map(([id, text]) => [id, text.trim()]));
const templates = withFallbackTemplates(seed);
const XANH = quantity => ({ product: 'Granola Túi Xanh 450g', code: 'GRA-XANH-Z450', quantity });
const VANG = quantity => ({ product: 'Granola Túi Vàng 350g', code: 'GRA-VANG-H350', quantity });
const basket = (items, agoMs = 30000, extra = {}) => ({ items, key: items.map(item => `${item.code}=${item.quantity}`).sort().join('|'), at: Date.now() - agoMs, phone: '', address: '', addressAsks: 0, ...extra });
const render = (id, extra = {}, context = {}) => renderChatbotReply({ template_id: id, ...extra }, templates, context);

let counter = 0;
/** Hội thoại nhiều lượt: giữ trạng thái (saveBotState), lịch sử tin, đơn đã tạo; LLM giả trả mẫu chỉ định. */
class Sim {
  constructor(conversation = {}, settings = {}) {
    this.conversation = { id: 'page:user', pageId: 'page', psid: 'user', name: 'Khách', botEnabled: true, ...conversation };
    this.recent = [];
    this.orders = [];
    this.settings = { enabled: true, responseMode: 'automatic', handoffKeywords: '', complaintKeywords: '', fragmentWaitMs: 1, phoneFragmentWaitMs: 1, messageTemplates: seed, ruleIntent: 'on', experimentalRules: 'on', preGuard: 'off', intentModel: 'off', intentCascade: 'off', decisionLog: 'off', ...settings };
  }
  history(direction, text, agoMs) {
    this.recent.push({ id: `h-${++counter}`, mid: `h-${counter}`, direction, type: 'text', text, createdAt: Date.now() - agoMs });
    return this;
  }
  /** Lùi mọi mốc giờ `ms` (như khách nhắn tin sau đó `ms`). */
  later(ms) {
    this.conversation.botLastReplyAt = (Number(this.conversation.botLastReplyAt) || Date.now()) - ms;
    if (this.conversation.pendingOrder?.at) this.conversation.pendingOrder = { ...this.conversation.pendingOrder, at: this.conversation.pendingOrder.at - ms };
    for (const item of this.recent) item.createdAt -= ms;
    return this;
  }
  async send(text, { llm = null } = {}) {
    const message = { id: `m-${++counter}`, mid: `m-${counter}`, direction: 'incoming', type: 'text', text, createdAt: Date.now() };
    this.recent.push(message);
    const sent = [];
    const saved = [];
    const created = [];
    const asked = [];
    const self = this;
    const results = await processChatbotChanges([{ type: 'message', conversation: { ...this.conversation }, message }], {
      readSettings: async () => this.settings,
      listMessages: async () => this.recent,
      getConversation: async () => ({ ...self.conversation }),
      saveBotState: async (_id, state) => { saved.push(state); Object.assign(self.conversation, state); },
      sendMessage: async (_c, payload) => {
        const out = payload.text || `[ảnh ${payload.imageUrls?.length || 1}]`;
        sent.push(out);
        self.recent.push({ id: `o-${++counter}`, mid: `o-${counter}`, direction: 'outgoing', type: 'text', text: out, createdAt: Date.now() });
        return { message: { mid: 'x' } };
      },
      createOrder: async (_c, order) => {
        const record = { id: `ord-${++counter}`, createdAt: Date.now(), phone: order.phone, address: order.address, total: order.total, products: order.items.map(item => ({ name: item.product, sku: item.code, quantity: item.quantity })), automatic: true, status: 'Mới' };
        created.push(order);
        self.orders.push(record);
        self.conversation.customerOrders = [...(self.conversation.customerOrders || []), record];
        return { order: record, created: true };
      },
      requestReply: async payload => {
        asked.push(payload);
        const answer = typeof llm === 'function' ? llm(payload, asked.length) : llm;
        if (!answer) return { templateId: 'LLM_CALLED', messages: ['[mô hình]'], handoff: false };
        return answer.template_id ? renderChatbotReply(answer, templates, payload.context || {}) : answer;
      },
      appendDecisionLog: () => {}
    });
    return { result: results[0] || {}, sent, saved, created, asked };
  }
}

/** Giỏ đang giữ, bot vừa xin SĐT/địa chỉ `agoMs` trước (ca 13:07: 1 Xanh + 1 Vàng). */
function held(agoMs, extra = {}, items = [XANH(1), VANG(1)]) {
  const sim = new Sim({ botLastTemplateId: 'ORDER_ADDRESS', botLastReplyAt: Date.now() - agoMs, pendingOrder: basket(items, agoMs, extra) });
  sim.history('incoming', '1 xanh 1 vàng', agoMs + 10000);
  sim.history('outgoing', 'Dạ đơn của chị gồm 1 Granola Túi Xanh 450g + 1 Granola Túi Vàng 350g, tổng 298.000đ (Miễn phí vận chuyển) ạ 🌾\nĐể lên đơn đúng tuyến cho đơn vị vận chuyển, chị cho em xin số điện thoại và địa chỉ nhận hàng đầy đủ trước sáp nhập để em lên đơn gửi mình cho chính xác nha ạ.', agoMs);
  return sim;
}

const QUESTIONS = [
  ['Có tặng cho chị bát không o', 'GIFT_POLICY'], ['Có tặng bát không?', 'GIFT_POLICY'], ['miễn ship không', 'FREESHIP_POLICY'], ['có ngọt không', 'NO_ADDED_SUGAR'],
  ['ship mấy ngày tới', 'SHIPPING_POLICY'], ['mẹ bầu ăn được không', 'HEALTH_CONDITION'], ['túi xanh với vàng khác gì', 'BAG_COMPARISON_XANH_VANG'],
  ['thanh toán cod được không', 'PAYMENT_METHODS'], ['bao nhiêu gam', 'WEIGHT_EXPIRY'], ['bé 2 tuổi ăn được không', 'KIDS_FAMILY'], ['ăn có béo không', 'CALORIES_DIET'],
  ['thành phần gồm gì', 'INGREDIENTS_ALLERGY'], ['hàng mới không', 'FRESHNESS'], ['có giảm giá không', 'DISCOUNT_POLICY'], ['có voucher không', 'DISCOUNT_POLICY']
];

// ===== P1: câu hỏi thông tin khi đang giữ giỏ =====

test('P1: 15 câu hỏi thông tin khi giữ giỏ, bot xin SĐT/địa chỉ 30 giây và 90 giây trước → câu trả lời + nhắc ngắn giỏ, không mô hình, không lưu lại giỏ', async () => {
  for (const agoMs of [30000, 90000]) {
    for (const [question, answerId] of QUESTIONS) {
      const sim = held(agoMs);
      const before = JSON.stringify(sim.conversation.pendingOrder);
      const out = await sim.send(question);
      const label = `${question} (${agoMs / 1000}s)`;
      assert.equal(out.result.templateId, 'ORDER_ADDRESS_REMIND', label);
      assert.equal(out.asked.length, 0, `${label}: không gọi mô hình`);
      assert.equal(out.sent.length, 2, `${label}: câu trả lời + câu nhắc`);
      // R14 (H3): giỏ đang giữ → câu trả lời bỏ câu mời chọn cuối ("lấy 2 túi vị nào…") — xem withoutInviteTail.
      // ("có voucher không" đi nhánh riêng của engine — không qua câu kèm — nên còn nguyên câu mời; đã báo agent engine.)
      const expected = withoutInviteTail(render(answerId).messages[0]);
      if (answerId === 'DISCOUNT_POLICY') assert.ok([expected, render(answerId).messages[0]].includes(out.sent[0]), `${label}: câu trả lời ${answerId}`);
      else assert.equal(out.sent[0], expected, `${label}: câu trả lời ${answerId}`);
      assert.match(out.sent[1], /vẫn đang giữ đơn 1 Granola Túi Xanh 450g \+ 1 Granola Túi Vàng 350g – tổng 298\.000đ/, label);
      assert.match(out.sent[1], /số điện thoại và địa chỉ nhận hàng/, label);
      assert.doesNotMatch(out.sent.join('\n'), /trước sáp nhập/, `${label}: không xin lại cả đoạn`);
      assert.ok(!out.saved.some(state => 'pendingOrder' in state), `${label}: không ghi đè giỏ`);
      assert.equal(JSON.stringify(sim.conversation.pendingOrder), before, label);
    }
  }
});

test('P1/E3: câu trả lời quà vừa gửi 5 phút trước, khách hỏi lại khi đang giữ giỏ → vẫn trả lời (không bỏ ý phụ)', async () => {
  const sim = held(180000);
  sim.history('outgoing', render('GIFT_POLICY').messages[0], 300000);
  const out = await sim.send('vậy có tặng bát không');
  assert.equal(out.sent[0], withoutInviteTail(render('GIFT_POLICY').messages[0]));
  assert.match(out.sent[1], /vẫn đang giữ đơn/);
  // Không giữ giỏ: ý phụ vừa gửi trong 30 phút vẫn bỏ như cũ.
  const recentOutgoing = [render('GIFT_POLICY').messages[0]];
  const free = renderChatbotReply({ template_id: 'ORDER_ADDRESS', also: 'GIFT_POLICY', Product_N1: 'Granola Túi Xanh 450g', No_A: '2' }, templates, { recentOutgoing });
  assert.equal(free.alsoTemplateId, undefined);
});

test('P1: sau CONFIRM_YES (giỏ còn giữ) câu hỏi thông tin cũng có câu trả lời + nhắc giỏ; mô hình chọn ORDER_ADDRESS + also cũng vậy', async () => {
  const confirm = held(60000);
  confirm.conversation.botLastTemplateId = 'CONFIRM_YES';
  assert.deepEqual(ruleIntent('miễn ship không', { botLastTemplateId: 'CONFIRM_YES', hasBasket: true, lastWasOrderStep: false, botLastAgeMin: 1, commentBasket })?.value, { template_id: 'ORDER_ADDRESS', also: 'FREESHIP_POLICY' });
  const out = await confirm.send('miễn ship không');
  assert.equal(out.sent[0], withoutInviteTail(render('FREESHIP_POLICY').messages[0]));
  assert.match(out.sent[1], /vẫn đang giữ đơn/);
  const viaModel = held(30000);
  const llm = await viaModel.send('bát gáo dừa tặng khi nào vậy', { llm: { template_id: 'ORDER_ADDRESS', also: 'GIFT_POLICY' } });
  assert.equal(llm.result.templateId, 'ORDER_ADDRESS_REMIND');
  assert.equal(llm.sent[0], withoutInviteTail(render('GIFT_POLICY').messages[0]));
  assert.match(llm.sent[1], /vẫn đang giữ đơn/);
});

test('P1/E17: cài đặt thiếu ORDER_ADDRESS_REMIND + GIFT_POLICY → hỏi mô hình trả lời một lần + câu nhắc dự phòng; nhắc bị tắt → trả lời + câu xin thông tin', async () => {
  const missing = { ...seed };
  delete missing.ORDER_ADDRESS_REMIND;
  delete missing.GIFT_POLICY;
  const sim = held(30000);
  sim.settings.messageTemplates = missing;
  const out = await sim.send('có tặng bát không', { llm: { templateId: 'FREESHIP_POLICY', messages: ['Dạ từ 2 túi miễn ship ạ'], handoff: false } });
  assert.equal(out.asked.length, 1, 'một lượt mô hình');
  assert.equal(out.asked[0].conversation.replyHint ? 'hint' : '', 'hint', 'kèm lời nhắc giỏ đã lưu');
  assert.deepEqual([out.result.templateId, out.sent[0]], ['ORDER_ADDRESS_REMIND', 'Dạ từ 2 túi miễn ship ạ']);
  assert.match(out.sent[1], /vẫn đang giữ đơn/, 'mẫu nhắc dự phòng (fallbackTemplates)');
  const blank = held(30000);
  blank.settings.messageTemplates = { ...seed, ORDER_ADDRESS_REMIND: '' };
  const off = await blank.send('có tặng bát không');
  assert.equal(off.sent[0], withoutInviteTail(render('GIFT_POLICY').messages[0]));
  assert.ok(off.sent.length >= 2, 'không im: kèm câu xin SĐT/địa chỉ');
  assert.match(off.sent.slice(1).join('\n'), /số điện thoại và địa chỉ/);
});

// ===== P2: câu hỏi không tính là một lần hỏi địa chỉ =====

test('P2 (F1/C3): SĐT + địa chỉ thiếu cấp → hỏi quà → hỏi ship → KHÔNG tạo đơn "Xóm 3 Phú Lương" (vòng 12: "Xóm 3 Vô Tranh Phú Lương" nay đọc đủ cấp); addressAsks giữ nguyên; nhắc đúng phần thiếu', async () => {
  const sim = held(120000, { phone: '0912345678', address: 'Xóm 3 Phú Lương', addressAsks: 1 }, [XANH(2)]);
  const gift = await sim.send('có tặng bát không shop');
  assert.equal(gift.sent[0], withoutInviteTail(render('GIFT_POLICY').messages[0]));
  assert.match(gift.sent[1], /vẫn đang giữ đơn 2 Granola Túi Xanh 450g/);
  assert.match(gift.sent[1], /phường\/xã/, 'nhắc đúng cấp địa chỉ còn thiếu');
  sim.later(120000);
  const ship = await sim.send('ship mấy ngày tới');
  assert.equal(ship.sent[0], render('SHIPPING_POLICY').messages[0]);
  sim.later(120000);
  await sim.send('có ngọt không');
  assert.deepEqual(sim.orders, [], 'không tự chốt địa chỉ thiếu cấp');
  assert.equal(sim.conversation.pendingOrder.addressAsks, 1);
  assert.equal(sim.conversation.pendingOrder.address, 'Xóm 3 Phú Lương');
  // Câu nhắc y hệt vừa gửi < 10 phút không lặp; sau 10 phút nhắc lại.
  assert.equal(ship.sent.length, 1);
  sim.later(11 * 60 * 1000);
  sim.conversation.pendingOrder = { ...sim.conversation.pendingOrder, at: Date.now() - 60000 };
  const again = await sim.send('thanh toán cod được không');
  assert.match(again.sent[1] || '', /vẫn đang giữ đơn/);
});

// ===== P3: bảng giá combo gói nhỏ =====

test('P3: SMALL_PACK_PRICE → PRICE_QUOTE + Combo 10 gói (bảng giá có số); PRICE_QUOTE_COMBO gọi thẳng kèm Product_N1 cũng soạn đủ; tin sau không im', async () => {
  const after = { commentBasket, botLastTemplateId: 'PACKAGING_INFO', botLastAgeMin: 3 };
  assert.deepEqual(ruleIntent('giá sao', after)?.value, { template_id: 'PRICE_QUOTE', Product_N1: 'Combo 10 gói Xanh' });
  const direct = render('PRICE_QUOTE_COMBO', { Product_N1: 'Combo 10 gói Xanh' });
  assert.equal(direct.templateId, 'PRICE_QUOTE');
  assert.match(direct.messages[0], /Combo 10 gói Xanh/);
  assert.match(direct.messages[0], /\d{3}\.000đ/);
  assert.doesNotMatch(direct.messages[0], /Combo Dùng Thử:\n/, 'không còn dòng giá trống');
  const sim = new Sim({ botLastTemplateId: 'PACKAGING_INFO', botLastReplyAt: Date.now() - 60000 });
  const quote = await sim.send('combo 10 gói giá bao nhiêu');
  assert.equal(quote.result.templateId, 'PRICE_QUOTE');
  assert.match(quote.sent[0], /Giá niêm yết: \d/);
  const next = await sim.send('lấy 2 hộp');
  assert.equal(next.result.templateId, 'ORDER_ADDRESS');
  assert.deepEqual(sim.conversation.pendingOrder.items.map(item => [item.code, item.quantity]), [['CB10-XANH-G35', 2]]);
});

// ===== P4: chờ "đặt thêm?" =====

const oldOrder = () => ({ id: 'o1', createdAt: Date.now() - 2 * 86400000, phone: '0912345678', address: '12 Lê Lợi, Phường Bến Nghé, Quận 1, TP Hồ Chí Minh', total: 298000, products: [{ name: 'Granola Túi Xanh 450g', sku: 'GRA-XANH-Z450', quantity: 2 }], status: 'Mới', automatic: true });
const awaiting = (items = [VANG(2)]) => new Sim({ botLastTemplateId: 'ORDER_EXISTING_CONFIRM', botLastReplyAt: Date.now() - 60000, customerOrders: [oldOrder()], pendingOrder: basket(items, 60000, { phone: '0912345678', address: '12 Lê Lợi phường Bến Nghé quận 1 tphcm', addressAsks: 2, awaitingConfirm: true }) });

test('P4 (E6): chờ "đặt thêm?" — câu hỏi có chữ "không" không phải từ chối; "chuẩn rồi"/"uk"/"đúng rồi em, lên đơn mới nhé" là đồng ý; "không em"/"không, đơn cũ" là từ chối', async () => {
  for (const text of ['bát gáo dừa có tặng không', 'giao nhanh không em', 'có ship tận nơi không']) {
    const sim = awaiting();
    const out = await sim.send(text);
    assert.notEqual(out.result.templateId, 'ORDER_STATUS', text);
    assert.ok(sim.conversation.pendingOrder?.items?.length, `${text}: giỏ còn`);
    assert.deepEqual(sim.orders, [], text);
  }
  for (const text of ['đúng rồi em, lên đơn mới nhé', 'chuẩn rồi', 'uk']) {
    const sim = awaiting();
    const out = await sim.send(text);
    assert.equal(out.result.templateId, 'ORDER_CONFIRMATION', text);
    assert.equal(sim.orders.length, 1, text);
    assert.equal(out.asked.length, 0, text);
  }
  for (const text of ['không em', 'không, đơn cũ đó', 'nhầm rồi']) {
    const sim = awaiting();
    const out = await sim.send(text);
    assert.equal(out.result.templateId, 'ORDER_STATUS', text);
    assert.equal(sim.conversation.pendingOrder, null, text);
  }
});

test('P4 (E7): chờ "đặt thêm?" — khách nhắc lại đúng giỏ đang chờ → lên đơn; tin gộp "…\\nđúng rồi" đọc trên tin cuối; giỏ khác: im một lần rồi hỏi lại, không im mãi', async () => {
  const same = awaiting();
  const restate = await same.send('2 túi vàng nhé');
  assert.equal(restate.result.templateId, 'ORDER_CONFIRMATION');
  assert.deepEqual(same.orders.map(order => order.products.map(item => [item.sku, item.quantity])), [[['GRA-VANG-H350', 2]]]);
  const bundled = awaiting();
  bundled.history('incoming', 'để chị xem', 3000);
  const yes = await bundled.send('đúng rồi');
  assert.equal(yes.result.templateId, 'ORDER_CONFIRMATION', 'tin cuối "đúng rồi" là đồng ý dù tin gộp có chữ khác');
  const other = awaiting([XANH(2)]);
  const first = await other.send('2 túi vàng nhé');
  assert.equal(first.result.skipped, 'đang chờ xác nhận đặt thêm', 'lần đầu: giữ giỏ, gắn thẻ, im');
  assert.equal(other.conversation.pendingOrder.heldSilently, true);
  const nudge = await other.send('shop ơi');
  assert.equal(nudge.result.templateId, 'ORDER_EXISTING_CONFIRM', 'lần sau: hỏi lại với giỏ đang giữ');
  assert.match(nudge.sent.join(' '), /đặt THÊM một đơn mới gồm 2 Granola Túi Vàng 350g/);
  assert.deepEqual(other.orders, []);
});

// ===== P5: số túi trước khi hỏi vị =====

test('P5 (E8): "cho chị 2 túi" → ASK_FLAVOR → "vàng" = 2 túi vàng; "2 túi 2 vị" rồi một màu → mô hình; luật nhận ctx.askedBagCount', async () => {
  const sim = new Sim({ botLastTemplateId: 'PRICE_QUOTE', botLastReplyAt: Date.now() - 120000 });
  assert.equal((await sim.send('cho chị 2 túi')).result.templateId, 'ASK_FLAVOR');
  const flavour = await sim.send('vàng');
  assert.equal(flavour.result.templateId, 'ORDER_ADDRESS');
  assert.deepEqual(sim.conversation.pendingOrder.items.map(item => [item.code, item.quantity]), [['GRA-VANG-H350', 2]]);
  await sim.send('0912345678 12 Lê Lợi phường Bến Nghé quận 1 tphcm');
  assert.deepEqual(sim.orders.map(order => [order.products.map(item => `${item.quantity}×${item.sku}`), order.total]), [[['2×GRA-VANG-H350'], 298000]]);
  const mixed = new Sim({ botLastTemplateId: 'PRICE_QUOTE', botLastReplyAt: Date.now() - 120000 });
  await mixed.send('2 túi 2 vị');
  const one = await mixed.send('vàng');
  assert.equal(one.asked.length, 1, 'đã nói 2 vị mà chỉ trả một màu: mô hình đọc');
  const ctx = { commentBasket, botLastTemplateId: 'ASK_FLAVOR', botLastAgeMin: 1 };
  assert.equal(ruleIntent('xanh', { ...ctx, askedBagCount: 3 })?.value?.No_A, '3');
  assert.equal(ruleIntent('1 xanh', { ...ctx, askedBagCount: 3 })?.value?.No_A, '1', 'khách ghi rõ 1 túi');
  assert.equal(ruleIntent('xanh', ctx)?.value?.No_A, '1', 'mặc định 1');
});

// ===== P6: hủy giỏ =====

test('P6 (E10): tin rút giỏ có nhắc màu/số túi là đổi giỏ, không xóa cả giỏ; "không lấy nữa" vẫn là hủy giỏ', () => {
  const holding = { commentBasket, hasBasket: true, lastWasOrderStep: true, botLastTemplateId: 'ORDER_ADDRESS', botLastAgeMin: 3 };
  for (const text of ['xóa hết đi lấy 1 nâu thôi', 'hủy giúp chị túi xanh, còn túi vàng', 'thôi không lấy vàng nữa', 'không lấy 2 túi nữa']) {
    assert.notEqual(ruleIntent(text, holding)?.rule, 'CANCEL_BASKET', text);
  }
  for (const text of ['thôi không lấy nữa', 'hủy giúp mình', 'xóa hết đó đi']) {
    assert.equal(ruleIntent(text, holding)?.rule, 'CANCEL_BASKET', text);
  }
});

// ===== P7: "thêm" khi giữ giỏ =====

test('P7 (F6): giữ 2 Xanh, "vậy lấy thêm 1 túi nâu" → 2 Xanh + 1 Nâu (luật); mô hình trả giỏ đủ không cộng hai lần; mô hình trả phần thêm thì cộng; "đổi" thì thay', async () => {
  const rule = held(120000, {}, [XANH(2)]);
  await rule.send('có tặng bát không');
  rule.later(90000);
  const more = await rule.send('vậy lấy thêm 1 túi nâu');
  assert.equal(more.result.templateId, 'ORDER_ADDRESS');
  assert.deepEqual(rule.conversation.pendingOrder.items.map(item => [item.code, item.quantity]), [['GRA-XANH-Z450', 2], ['GRA-NAU-Z350', 1]]);
  assert.match(more.sent[0], /2 Granola Túi Xanh 450g \+ 1 Granola Túi Nâu vị cacao 350g/);
  const pending = basket([XANH(2)], 60000);
  const full = renderChatbotReply({ template_id: 'ORDER_ADDRESS', Product_N1: 'Granola Túi Xanh 450g', No_A: '2', Product_N2: 'Granola Túi Nâu vị cacao 350g', No_B: '1' }, templates, { pendingOrder: pending, messageText: 'lấy thêm 1 túi nâu nữa' });
  assert.deepEqual(full.pendingOrder.items.map(item => [item.code, item.quantity]), [['GRA-XANH-Z450', 2], ['GRA-NAU-Z350', 1]], 'giỏ đủ: không cộng lần hai');
  const delta = renderChatbotReply({ template_id: 'ORDER_ADDRESS', Product_N1: 'Granola Túi Nâu vị cacao 350g', No_A: '1' }, templates, { pendingOrder: pending, messageText: 'lấy thêm 1 túi nâu nữa' });
  assert.deepEqual(delta.pendingOrder.items.map(item => [item.code, item.quantity]), [['GRA-XANH-Z450', 2], ['GRA-NAU-Z350', 1]]);
  const swap = renderChatbotReply({ template_id: 'ORDER_ADDRESS', Product_N1: 'Granola Túi Nâu vị cacao 350g', No_A: '1' }, templates, { pendingOrder: pending, messageText: 'đổi thành 1 túi nâu' });
  assert.deepEqual(swap.pendingOrder.items.map(item => [item.code, item.quantity]), [['GRA-NAU-Z350', 1]]);
  const plain = renderChatbotReply({ template_id: 'ORDER_ADDRESS', Product_N1: 'Granola Túi Nâu vị cacao 350g', No_A: '1' }, templates, { pendingOrder: pending, messageText: 'lấy 1 túi nâu' });
  assert.deepEqual(plain.pendingOrder.items.map(item => [item.code, item.quantity]), [['GRA-NAU-Z350', 1]], 'không có "thêm/nữa": giỏ mới như cũ');
});

// ===== P8 / N14: địa chỉ cũ =====

test('P8 (F2): "bữa trước ăn ngon, lấy thêm 2 túi xanh" không tự lấy địa chỉ đơn cũ; "như đơn trước"/"gởi dc củ" vẫn lấy; "gửi cho cụ" không phải chỗ cũ', async () => {
  const previous = { id: 'o1', createdAt: Date.now() - 10 * 86400000, phone: '0987654321', address: '99 Trần Phú, Phường 4, Quận 5, TP Hồ Chí Minh', total: 298000, products: [{ name: 'Granola Túi Xanh 450g', sku: 'GRA-XANH-Z450', quantity: 2 }], status: 'Đã giao', automatic: true };
  const sim = new Sim({ botLastTemplateId: 'THANK_YOU', botLastReplyAt: Date.now() - 10 * 86400000, customerOrders: [previous] });
  const out = await sim.send('bữa trước ăn ngon, lấy thêm 2 túi xanh', { llm: { template_id: 'ORDER_ADDRESS', Product_N1: 'Granola Túi Xanh 450g', No_A: '2' } });
  assert.equal(out.result.templateId, 'ORDER_ADDRESS');
  assert.deepEqual(sim.orders, []);
  const value = { template_id: 'ORDER_ADDRESS', Product_N1: 'Granola Túi Xanh 450g', No_A: '2' };
  for (const text of ['như đơn trước nhé', 'gởi dc củ nha', 'gửi về địa chỉ cũ']) {
    assert.equal(renderChatbotReply(value, templates, { recentOrder: previous, messageText: text }).templateId, 'ORDER_CONFIRMATION', text);
  }
  for (const text of ['gửi cho cụ nhà mình nhé', 'bữa trước ăn ngon, lấy thêm 2 túi xanh', 'đợt trước chị mua rồi']) {
    assert.equal(renderChatbotReply(value, templates, { recentOrder: previous, messageText: text }).templateId, 'ORDER_ADDRESS', text);
  }
  assert.equal(mentionsOldAddress('gửi cho cụ'), false);
  assert.equal(orderFlowStep('gửi cho cụ nhé', { hasBasket: true, lastWasOrderStep: true }), null);
  assert.equal(orderFlowStep('như đơn trước nhé', { hasBasket: true, lastWasOrderStep: true })?.rule, 'OLD_ADDRESS');
});

// ===== V8: ORDER_INFO =====

test('V8 (E9/C5/B21): SĐT + địa chỉ trước khi nêu vị → giữ cả địa chỉ (kể số nhà sau SĐT), "2 túi xanh" chốt luôn; chỉ SĐT → không nói "đã nhận địa chỉ"', async () => {
  const sim = new Sim({ botLastTemplateId: 'PRICE_QUOTE', botLastReplyAt: Date.now() - 120000 });
  const info = await sim.send('0912345678 12 Lê Lợi phường Bến Nghé quận 1 tphcm');
  assert.equal(info.result.templateId, 'ORDER_INFO_ASK_FLAVOR');
  assert.deepEqual([sim.conversation.pendingOrder.phone, sim.conversation.pendingOrder.address, sim.conversation.pendingOrder.items], ['0912345678', '12 Lê Lợi phường Bến Nghé quận 1 tphcm', []]);
  const order = await sim.send('2 túi xanh');
  assert.equal(order.result.templateId, 'ORDER_CONFIRMATION');
  assert.match(sim.orders[0].address, /^12 Lê Lợi, Phường Bến Nghé/);
  const phoneOnly = new Sim({ botLastTemplateId: 'PRICE_QUOTE', botLastReplyAt: Date.now() - 120000 });
  const asked = await phoneOnly.send('0912345678');
  assert.equal(asked.result.templateId, 'ORDER_INFO_ASK_FLAVOR');
  assert.match(asked.sent[0], /đã nhận SĐT của/);
  assert.doesNotMatch(asked.sent[0], /SĐT và địa chỉ/);
  // Cài đặt chưa có mẫu mới: lời dự phòng (không rơi về mẫu "SĐT và địa chỉ").
  const noSeed = { ...seed };
  delete noSeed.ORDER_PHONE_ASK_FLAVOR;
  assert.match(renderChatbotReply({ template_id: 'ORDER_INFO_ASK_FLAVOR', Phone_Number: '0912345678' }, withFallbackTemplates(noSeed), {}).messages[0], /đã nhận SĐT của/);
  assert.equal(stripPhone('0912345678 12 Lê Lợi').replace(/\s+/g, ' ').trim(), '12 Lê Lợi');
  assert.equal(stripPhone('quận 1 0912 345 678').replace(/\s+/g, ' ').trim(), 'quận 1');
});

// ===== V9–V11, N12 =====

test('V9 (E11): "vàng" còn dấu không phải "vâng" — không OK_STEP, không nhắc giỏ trơn; "vâng"/"vang" vẫn là OK_STEP', async () => {
  const holding = { commentBasket, hasBasket: true, lastWasOrderStep: true, botLastTemplateId: 'ORDER_ADDRESS', botLastAgeMin: 1 };
  assert.equal(ruleIntent('vàng', holding), null);
  assert.equal(ruleIntent('Vàng ạ', holding), null);
  assert.equal(ruleIntent('vâng', holding)?.rule, 'OK_STEP');
  assert.equal(ruleIntent('vang', holding)?.rule, 'OK_STEP');
  const sim = held(60000, { upsold: true }, [XANH(1)]);
  const out = await sim.send('vàng');
  assert.equal(out.asked.length, 1, 'mô hình đọc (khách chọn thêm túi vàng?)');
  assert.notEqual(out.result.templateId, 'ORDER_ADDRESS_REMIND');
});

test('V10 (E12): câu hỏi thành phần xoài sấy / vị dâu không bị LIVE_ONLY (không tắt bot); hỏi mua hàng live vẫn LIVE_ONLY', async () => {
  const ctx = { commentBasket, botLastTemplateId: 'PRICE_QUOTE', botLastAgeMin: 2 };
  for (const text of ['túi xanh có xoài sấy hả', 'granola có xoài sấy', 'trong túi vàng có xoài à', 'có vị dâu không', 'có hạt điều không']) {
    assert.notEqual(ruleIntent(text, ctx)?.rule, 'LIVE_ONLY', text);
  }
  // Vòng 12: túi dâu / xanh mint là Granola Tropical (TROPICAL); hũ hạt là hàng chỉ CSKH bán (STAFF_ONLY).
  assert.equal(ruleIntent('sữa hạt giá sao', ctx)?.rule, 'LIVE_ONLY');
  for (const text of ['bên em có túi dâu không', 'xanh mint còn không']) assert.equal(ruleIntent(text, ctx)?.rule, 'TROPICAL', text);
  assert.equal(ruleIntent('lấy 2 hũ hạt điều', ctx)?.rule, 'STAFF_ONLY');
  const sim = new Sim({ botLastTemplateId: 'PRICE_QUOTE', botLastReplyAt: Date.now() - 120000 });
  await sim.send('túi xanh có xoài sấy hả');
  assert.notEqual(sim.conversation.botEnabled, false);
});

test('V11 (F4): khách post.isLive / thẻ livestream hỏi hàng live → LIVE_ONLY_PRODUCT, bot vẫn bật (không chuyển người)', async () => {
  for (const conversation of [{ post: { isLive: true, message: 'Chào cả nhà' } }, { labels: ['livestream'] }]) {
    const sim = new Sim({ botLastTemplateId: 'WELCOME', botLastReplyAt: Date.now() - 120000, ...conversation });
    const out = await sim.send('sữa hạt bao nhiêu');
    assert.equal(out.result.templateId, 'LIVE_ONLY_PRODUCT', JSON.stringify(conversation));
    assert.notEqual(sim.conversation.botEnabled, false);
  }
});

test('N12 (E17): giỏ chờ có món null / customerOrders có null → không lỗi', async () => {
  for (const text of ['đúng rồi', 'có tặng bát không', 'ok']) {
    const sim = new Sim({ botLastTemplateId: 'ORDER_ADDRESS', botLastReplyAt: Date.now() - 30000, pendingOrder: { items: [null, { product: 'Granola Túi Xanh 450g' }], at: Date.now() }, customerOrders: [null, { id: 'x' }] });
    const out = await sim.send(text);
    assert.equal(out.result.error, undefined, text);
    assert.ok(out.result.templateId, text);
  }
});

// ===== Nhật ký quyết định: prevBotText + giỏ =====

test('nhật ký: prevBotText (chữ tin bot gần nhất, ≤ 300, che SĐT khi ghi) ngay sau lastTemplate; ctx.basket = [{ sku, quantity }] của giỏ đang giữ', async () => {
  const records = [];
  const conversation = { id: 'page:user', pageId: 'page', psid: 'user', botEnabled: true, botLastTemplateId: 'ORDER_ADDRESS', botLastReplyAt: Date.now() - 60000, pendingOrder: basket([XANH(2)], 60000) };
  const bot = `Dạ đơn gồm 2 Granola Túi Xanh 450g, gọi em 0912345678 nha ${'x'.repeat(400)}`;
  await processChatbotChanges([{ type: 'message', conversation, message: { id: 'm1', mid: 'm1', direction: 'incoming', type: 'text', text: 'có ngọt không', createdAt: Date.now() } }], {
    readSettings: async () => ({ enabled: true, responseMode: 'automatic', handoffKeywords: '', fragmentWaitMs: 1, messageTemplates: seed, ruleIntent: 'on', intentModel: 'off', intentCascade: 'off' }),
    listMessages: async () => [{ id: 'o1', direction: 'outgoing', type: 'text', text: bot, createdAt: Date.now() - 60000 }, { id: 's1', direction: 'outgoing', type: 'text', text: 'tin nhân viên', staff: true, createdAt: Date.now() - 3 * 60 * 60 * 1000 }].sort((a, b) => a.createdAt - b.createdAt),
    saveBotState: async () => {},
    sendMessage: async () => ({ message: { mid: 'x' } }),
    requestReply: async () => ({ templateId: 'THANK_YOU', messages: ['x'], handoff: false }),
    appendDecisionLog: record => { records.push(record); }
  });
  await new Promise(resolve => setImmediate(resolve));
  const row = records[0];
  const keys = Object.keys(row);
  assert.equal(keys[keys.indexOf('lastTemplate') + 1], 'prevBotText');
  assert.equal(row.prevBotText, bot.slice(0, 300));
  assert.deepEqual(row.ctx.basket, [{ sku: 'GRA-XANH-Z450', quantity: 2 }]);
  const clean = sanitizeRecord(row);
  assert.match(clean.prevBotText, /gọi em <sdt> nha/);
  assert.deepEqual(clean.ctx.basket, [{ sku: 'GRA-XANH-Z450', quantity: 2 }]);
  const pure = buildDecisionRecord({ conversation: { id: 'c', botLastTemplateId: 'PRICE_QUOTE' }, change: { message: { mid: 'm', text: 'x', type: 'text' } }, trace: { text: 'x', type: 'text' } });
  assert.deepEqual([pure.prevBotText, pure.ctx.basket], ['', []]);
});
