// R13 — sửa theo phản biện chatbot (scratchpad/r13/review-bot.md): C1 đổi quà khi giỏ không có quà hiện vật, C2 plainBasketTurn
// (regex SĐT mất dấu `\`, đơn THÊM, cửa sổ), T1 botAlreadyHandled / botHandledMessageId, T2 gọi lại mô hình no-repeat, T3 ack giỏ
// Shop hai lần, T4 "tổ 2 Vàng Anh", L2 đuôi câu hỏi quà trong địa chỉ, L3 bình luận "Còn Hàng". Câu khách là câu thật trong báo cáo
// (không tên, không SĐT thật).
import assert from 'node:assert/strict';
import test from 'node:test';
import { Sim, PHONE, XANH, NAU, basket, templates } from './helpers/r13-engine-sim.mjs';
import { colourCountsInText, renderChatbotReply } from '../app/chatbot-templates.mjs';
import { commentBasket, isTagOnlyComment } from '../app/chatbot-engine.mjs';
import { ruleIntent } from '../app/processing/rule-intent.mjs';
import { orderFlowStep, trailingQuestionTopic } from '../app/processing/order-flow.mjs';
import { backlogBotChanges, commentReplyCovers, missedBotChanges } from '../app/pancake.mjs';

const MIN = 60 * 1000;
const ADDRESS = '12 Lê Lợi, Phường Bến Nghé, Quận 1, TP Hồ Chí Minh';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const oneXanh = ageMin => ({ id: 'o1', automatic: true, source: 'chatbot', createdAt: Date.now() - ageMin * MIN, phone: PHONE, address: ADDRESS, total: 189000, gift: '', products: [{ name: 'Granola Túi Xanh 450g', sku: 'GRA-XANH-Z450', quantity: 1 }], status: 'Mới' });
const twoXanh = extra => ({ template_id: 'ORDER_ADDRESS', Product_N1: 'Granola Túi Xanh 450g', No_A: '2', ...extra });

// ===== C2 =====
test('C2: đơn 1 Xanh — tin có SĐT / đặt THÊM / 20 giờ sau không còn bị coi là "đổi số lượng" (ORDER_CHANGE_STAFF); ca thật 83 phút vẫn báo nhân viên', () => {
  const render = (ageMin, messageText, value = twoXanh()) => renderChatbotReply(value, templates, { now: Date.now(), recentOrder: oneXanh(ageMin), latestOrder: oneXanh(ageMin), lastTemplateId: 'ORDER_CONFIRMATION', messageText, recentCustomerTexts: [], customer: { gender: 'female', name: 'Khách' } });
  // Mô hình bỏ sót SĐT nằm trong tin: trước đây regex /d{9,}/ (mất `\`) không chặn → ORDER_CHANGE_STAFF, SĐT/địa chỉ mới bị bỏ.
  for (const text of ['2 túi xanh 0987654321 5 Nguyễn Huệ Quận 1', '2 túi xanh, sđt 0987654321']) {
    const reply = render(300, text);
    assert.notEqual(reply.templateId, 'ORDER_CHANGE_STAFF', text);
    assert.equal(reply.order?.noteOrderId, undefined, text);
  }
  // Đặt THÊM về địa chỉ cũ (3 giờ sau): không phải đổi đơn thành 2 — hỏi đặt thêm như trước R13.
  const adding = render(180, 'cho mình 2 túi xanh nữa gửi về địa chỉ cũ nhé', twoXanh({ Phone_Number: '0', Customer_Address: '0' }));
  assert.notEqual(adding.templateId, 'ORDER_CHANGE_STAFF');
  assert.equal(adding.orderChange, undefined);
  // Đơn 20 giờ trước + "Mình lấy 2 túi xanh": đơn mới hôm sau (bước xin SĐT/địa chỉ), không ghi chú đổi đơn.
  const nextDay = render(20 * 60, 'Mình lấy 2 túi xanh');
  assert.equal(nextDay.templateId, 'ORDER_ADDRESS', JSON.stringify(nextDay.messages));
  // Ca thật 02/10 (83 phút, cùng món, không SĐT/địa chỉ) vẫn là xin đổi số lượng → nhân viên.
  const real = render(83, 'Lấy 2goi xanh chi');
  assert.equal(real.templateId, 'ORDER_CHANGE_STAFF');
  assert.match(real.order.note, /2 Granola Túi Xanh/);
});

// ===== C1 =====
test('C1: giỏ 2 Xanh (chỉ miễn ship) — "không lấy quà có được không" → chính sách quà, không hứa 2 gói nhỏ, không mở lượt chọn vị; "đổi sang nâu" là đổi vị túi', async () => {
  const sim = new Sim();
  const inbox = sim.inbox({ botLastTemplateId: 'ORDER_ADDRESS', botLastReplyAt: Date.now() - MIN, pendingOrder: basket([XANH(2)], MIN) });
  sim.history(inbox, 'outgoing', 'Dạ đơn của chị gồm 2 Granola Túi Xanh 450g…', MIN, { sender: 'bot' });
  const ask = await sim.send(inbox, 'Mình không lấy quà có được không');
  const askText = ask.sent.map(item => item.text).join('\n');
  assert.notEqual(ask.result.templateId, 'GIFT_SWAP', JSON.stringify(ask.result));
  assert.doesNotMatch(askText, /2 gói granola nhỏ|gói vị nào/i, askText);
  assert.ok(!Number(inbox.giftSwapAskedAt), 'không đặt mốc chọn vị quà thay');
  assert.equal(ask.notes.length, 0);
  const swap = await sim.send(inbox, 'cho chị đổi sang nâu nhé', { llm: { template_id: 'ORDER_ADDRESS', Product_N1: 'Granola Túi Nâu vị cacao 350g', No_A: '2' } });
  assert.notEqual(swap.result.templateId, 'GIFT_SWAP_NOTED', JSON.stringify(swap.result));
  assert.deepEqual(inbox.pendingOrder.items.map(item => [item.code, item.quantity]), [['GRA-NAU-Z350', 2]], 'đổi VỊ TÚI lớn');
  assert.equal(inbox.pendingOrder.giftSwap, undefined);
  const close = await sim.send(inbox, `${PHONE} ${ADDRESS}`, { llm: { template_id: 'ORDER_CONFIRMATION', Product_N1: 'Granola Túi Nâu vị cacao 350g', No_A: '2', Phone_Number: PHONE, Customer_Address: ADDRESS } });
  assert.equal(close.created.length, 1, JSON.stringify(close.result));
  assert.equal(close.created[0].giftSwap, undefined, 'đơn không mang gói nhỏ thay quà');
});

test('C1 đối chứng: giỏ 3 Xanh (bát + muỗng) — "Không lấy bát đâu em" vẫn hỏi vị quà thay, "2 gói nâu" ghi nhận vào giỏ', async () => {
  const sim = new Sim();
  const inbox = sim.inbox({ botLastTemplateId: 'ORDER_ADDRESS', botLastReplyAt: Date.now() - MIN, pendingOrder: basket([XANH(3)], MIN) });
  sim.history(inbox, 'outgoing', 'Dạ đơn của chị gồm 3 Granola Túi Xanh 450g…', MIN, { sender: 'bot' });
  const ask = await sim.send(inbox, 'Không lấy bát đâu em');
  assert.ok(ask.result.templateId === 'GIFT_SWAP' || ask.result.templateId === 'ORDER_ADDRESS_REMIND', JSON.stringify(ask.result));
  assert.ok(Number(inbox.giftSwapAskedAt) > 0);
  const choice = await sim.send(inbox, '2 gói nâu');
  assert.ok(Array.isArray(inbox.pendingOrder.giftSwap) && inbox.pendingOrder.giftSwap.length === 2, JSON.stringify(inbox.pendingOrder));
  assert.match(choice.sent.map(item => item.text).join('\n'), /ghi nhận thay quà/);
});

// ===== T1 =====
const mk = (id, direction, text, at, extra = {}) => ({ id, mid: id, direction, type: 'text', text, createdAt: at, ...extra });
test('T1: commentReplyCovers — tin trước tin đã xử lý là đã gộp; bình luận mới tới trong lúc bot soạn / bài khác / lệch giờ 2 giây → chưa xử lý', () => {
  const T0 = Date.now() - 10 * MIN;
  const conv = extra => ({ id: 'page:comment:u1:p1', pageId: 'page', psid: 'u1', source: 'comment', ...extra });
  const a = mk('cA', 'incoming', 'xin giá', T0);
  const b = mk('cB', 'incoming', 'ship về Đà Nẵng mấy ngày shop', T0 + 20000);
  // Dữ liệu mới: engine ghi botHandledMessageId = bình luận vừa trả lời.
  assert.equal(commentReplyCovers(conv({ botHandledMessageId: 'cA', botLastReplyAt: T0 + 40000 }), b, [a, b]), false, 'bình luận thứ hai tới trong lúc bot soạn → chưa xử lý');
  assert.equal(commentReplyCovers(conv({ botHandledMessageId: 'cB', botLastReplyAt: T0 + 40000 }), a, [a, b]), true, 'tin cũ hơn tin đã xử lý = đã gộp');
  // Dữ liệu cũ (chỉ có botLastReplyAt): ca thật 02/10 — bình luận duy nhất, đã nhắn riêng → vẫn bỏ.
  assert.equal(commentReplyCovers(conv({ botLastReplyAt: T0 + 30000 }), a, [a]), true);
  // Ca B dữ liệu cũ: còn bình luận khác chưa trả lời trước nó → không biết bot trả lời tin nào → đưa bot.
  assert.equal(commentReplyCovers(conv({ botLastReplyAt: T0 + 40000 }), b, [a, b]), false);
  // Ca G: giờ Pancake sớm hơn mốc trả lời 2 giây (khách gõ ngay sau khi bot trả lời xong) → đưa bot.
  const g = mk('cG', 'incoming', '2 túi xanh nha shop', T0 + 38000);
  assert.equal(commentReplyCovers(conv({ botLastReplyAt: T0 + 40000 }), g, [a, g]), false);
  // Ca D: luồng bài KHÁC chưa có lượt trả lời nào → đưa bot (không nhìn tin riêng ở hộp thư nữa).
  const other = { id: 'page:comment:u1:p2', pageId: 'page', psid: 'u1', source: 'comment' };
  const d = mk('cD', 'incoming', 'túi nâu có ngọt không shop', T0 + 10000);
  assert.equal(commentReplyCovers(other, d, [d]), false);
  const store = { conversations: [conv({ botLastReplyAt: T0 + 36000 }), other, { id: 'page:u1', pageId: 'page', psid: 'u1', source: 'inbox' }], messages: { 'page:comment:u1:p1': [a], 'page:comment:u1:p2': [d], 'page:u1': [mk('pr1', 'outgoing', 'Dạ em thấy chị để lại bình luận…', T0 + 35000, { privateReply: true, sender: 'bot' })] } };
  assert.deepEqual(backlogBotChanges(store, { now: Date.now() }).map(change => change.message.id), ['cD']);
  assert.deepEqual(missedBotChanges([{ type: 'message', conversation: other, message: d }], store, { now: Date.now() }).map(change => change.message.id), ['cD']);
});

test('T1: lượt trả lời bình luận ghi botHandledMessageId; bình luận thứ hai tới trong lúc bot soạn vẫn được trả lời trên đường muộn', async () => {
  const sim = new Sim({ psid: 'u1' });
  const thread = sim.comment({});
  const first = await sim.send(thread, 'xin giá', { llm: { template_id: 'PRICE_QUOTE', Product_N1: 'Granola Túi Xanh 450g' } });
  assert.ok(first.sent.length > 0, JSON.stringify(first.result));
  assert.equal(thread.botHandledMessageId, first.incoming.id, 'mã bình luận vừa trả lời được ghi');
  // Ca B mức engine (như t2-handled của phản biện): bình luận 1 đã được nhắn riêng (chỉ tin riêng ở hộp thư, không lời công khai),
  // bình luận 2 có giờ TRƯỚC mốc trả lời (tới lúc bot đang soạn), nay đến qua backlog (late) → phải trả lời.
  const other = new Sim({ psid: 'u2' });
  const c = other.comment({ botLastReplyAt: Date.now() - 20000, botLastTemplateId: 'PRICE_QUOTE', botHandledMessageId: 'cA' });
  other.inbox({ botLastReplyAt: Date.now() - 20000, botLastTemplateId: 'PRICE_QUOTE' });
  other.history(c, 'incoming', 'xin giá', 60000, { id: 'cA', mid: 'cA' });
  other.history(other.inbox(), 'outgoing', 'Dạ em thấy chị để lại bình luận… bảng giá', 22000, { privateReply: true, sender: 'bot' });
  const late = other.history(c, 'incoming', 'ship về Đà Nẵng mấy ngày shop', 40000);
  const second = await other.send(c, '', { existing: late, change: { late: true }, llm: { template_id: 'SHIPPING_POLICY' } });
  assert.equal(second.result.templateId, 'SHIPPING_POLICY', JSON.stringify(second.result));
  // Dữ liệu cũ (không botHandledMessageId) cùng ca → cũng đưa bot.
  const legacy = new Sim({ psid: 'u3' });
  const l = legacy.comment({ botLastReplyAt: Date.now() - 20000, botLastTemplateId: 'PRICE_QUOTE' });
  legacy.inbox({ botLastReplyAt: Date.now() - 20000 });
  legacy.history(l, 'incoming', 'xin giá', 60000);
  legacy.history(legacy.inbox(), 'outgoing', 'Dạ em thấy chị để lại bình luận… bảng giá', 22000, { privateReply: true, sender: 'bot' });
  const lateLegacy = legacy.history(l, 'incoming', 'ship về Đà Nẵng mấy ngày shop', 40000);
  const third = await legacy.send(l, '', { existing: lateLegacy, change: { late: true }, llm: { template_id: 'SHIPPING_POLICY' } });
  assert.equal(third.result.templateId, 'SHIPPING_POLICY', JSON.stringify(third.result));
  // Ca thật 02/10: bình luận DUY NHẤT đã nhắn riêng, đến lại sau khởi động → vẫn bỏ.
  const real = new Sim({ psid: 'u4' });
  const r = real.comment({ botLastReplyAt: Date.now() - 20000, botLastTemplateId: 'PRICE_QUOTE' });
  real.inbox({ botLastReplyAt: Date.now() - 20000 });
  const only = real.history(r, 'incoming', '.', 60000);
  real.history(real.inbox(), 'outgoing', 'Dạ em thấy chị để lại bình luận… bảng giá', 22000, { privateReply: true, sender: 'bot' });
  const again = await real.send(r, '', { existing: only, change: { late: true }, llm: { template_id: 'PRICE_QUOTE' } });
  assert.equal(again.result.skipped, 'đã xử lý trước khi khởi động lại', JSON.stringify(again.result));
});

// ===== T2 =====
test('T2: gọi lại mô hình "no-repeat" — lần hai trả LIVESTREAM_COMMENT cho khách hộp thư KHÔNG live thì không gửi lời live', async () => {
  const sim = new Sim({ settings: { ruleIntent: 'off' } });
  const shipping = renderChatbotReply({ template_id: 'SHIPPING_POLICY' }, templates, {});
  const inbox = sim.inbox({ botLastTemplateId: 'SHIPPING_POLICY', botLastReplyAt: Date.now() - 2 * MIN });
  sim.history(inbox, 'incoming', 'ship mấy ngày tới', 3 * MIN);
  for (const text of shipping.messages) sim.history(inbox, 'outgoing', text, 2 * MIN, { sender: 'bot' });
  const turn = await sim.send(inbox, 'Còn trái cây có sấy dòn không', { llm: (_payload, n) => (n === 1 ? { template_id: 'SHIPPING_POLICY' } : { template_id: 'LIVESTREAM_COMMENT' }) });
  const sent = turn.sent.map(item => item.text).join('\n');
  assert.equal(turn.asked.length, 2, `có gọi lại mô hình (no-repeat): ${JSON.stringify(turn.result)}`);
  assert.notEqual(turn.result.templateId, 'LIVESTREAM_COMMENT', JSON.stringify(turn.result));
  assert.doesNotMatch(sent, /phiên live/i, sent);
});

// ===== T3 =====
test('T3: khách bấm "Mua" hai lần liền trên Facebook Shop → một tin ghi nhận giỏ, đúng giỏ cuối', async () => {
  const shopName = 'Granola Mới Ngũ Cốc Ăn Sáng Healthy Lành Mạnh Với Hạt Dinh Dưỡng Trái Cây Từ Giọt Nắng';
  const cart = sku => ({ text: `Khách chọn mua từ Facebook Shop: ${shopName} (${sku}) — 298.000đ`, message: { cart: [{ name: shopName, sku, quantity: 1, price: 298000, image: '' }] } });
  const sim = new Sim({ settings: { shopOrderWaitMs: 300, shopOrderFollowUpMs: [50] } });
  const inbox = sim.inbox({ pancakeConversationId: 'pc1' });
  const a = cart('CB2-XANH-Z450');
  const b = cart('CB-VANGG+XANH');
  const extra = { findShopOrder: async () => null };
  const p1 = sim.send(inbox, a.text, { message: a.message, extra });
  await sleep(50);
  const p2 = sim.send(inbox, b.text, { message: b.message, extra });
  const [r1, r2] = await Promise.all([p1, p2]);
  const acks = [...r1.sent, ...r2.sent].filter(item => /đã nhận giỏ hàng/i.test(item.text));
  assert.equal(acks.length, 1, JSON.stringify([r1.sent, r2.sent]));
  assert.match(acks[0].text, /1 Granola Túi Vàng 350g \+ 1 Granola Túi Xanh 450g/);
  assert.equal(r1.result.skipped, 'gộp với tin sau');
  await sleep(200);
});

// ===== T4 =====
test('T4: "tổ 2 Vàng Anh" / "số 2 Vàng Danh" là địa danh — không đếm là túi Vàng, địa chỉ giữ nguyên; "2 túi xanh 12 Lê Lợi" vẫn là giỏ', () => {
  assert.deepEqual(colourCountsInText(`${PHONE} tổ 2 Vàng Anh, thị trấn Chũ, Lục Ngạn, Bắc Giang`).counts, {});
  assert.deepEqual(colourCountsInText(`${PHONE}, số 2 Vàng Danh, Uông Bí, Quảng Ninh`).counts, {});
  assert.deepEqual(colourCountsInText('2 túi xanh 12 Lê Lợi').counts, { XANH: 2 });
  const ctx = { source: 'inbox', botLastTemplateId: 'ORDER_ADDRESS', hasBasket: true, lastWasOrderStep: true, orderAgeMin: Infinity, commentBasket, experimentalRules: 'on', candidateRules: 'shadow', hasPreviousDelivery: false };
  const place = ruleIntent(`${PHONE} tổ 2 Vàng Anh, thị trấn Chũ, Lục Ngạn, Bắc Giang`, ctx);
  assert.notEqual(place?.rule, 'BASKET_ADDRESS', JSON.stringify(place));
  if (place?.value?.Customer_Address) assert.match(place.value.Customer_Address, /tổ 2 Vàng Anh/);
  const real = ruleIntent(`2 túi xanh ${PHONE} ${ADDRESS}`, ctx);
  assert.equal(real?.rule, 'BASKET_ADDRESS', JSON.stringify(real));
  assert.equal(real.value.Product_N1, 'Granola Túi Xanh 450g');
  assert.equal(String(real.value.No_A), '2');
});

// ===== L2 =====
test('L2: địa chỉ kèm câu hỏi quà ("… Sơn động Bắc Giang có tặng quà phải k bạn") → địa chỉ sạch + ý phụ GIFT_POLICY trả lời cùng lượt', () => {
  const text = 'Thôn Mặn. Vĩnh An. Sơn động Bắc Giang có tặng quà phải k bạn';
  const step = orderFlowStep(text, { hasBasket: true, lastWasOrderStep: true, addressComplete: true });
  assert.equal(step?.rule, 'ADDRESS_COMPLETE', JSON.stringify(step));
  assert.equal(step.value.also, 'GIFT_POLICY');
  assert.doesNotMatch(step.value.Customer_Address, /tặng quà/);
  assert.equal(trailingQuestionTopic('12 Lê Lợi, Quận 1, HCM có được miễn ship không shop'), 'FREESHIP_POLICY');
  assert.equal(trailingQuestionTopic('12 Lê Lợi, Quận 1, HCM'), '');
  const reply = renderChatbotReply(step.value, templates, { pendingOrder: basket([XANH(2)], MIN, { phone: PHONE }), now: Date.now(), messageText: text, recentOutgoing: [], recentCustomerTexts: [] });
  assert.match(reply.messages.join('\n'), /quà|bát|muỗng/i, 'câu hỏi quà được trả lời');
});

// ===== L3 =====
test('L3: "Còn Hàng", "Hết Hàng", "Đặt Hàng", "Tư Vấn", "Hàng Về Chưa" là câu nói (bot trả lời), "Nguyễn Minh Anh" là tên (chỉ like)', () => {
  for (const text of ['Còn Hàng', 'Hết Hàng', 'Đặt Hàng', 'Tư Vấn', 'Hàng Về Chưa']) assert.equal(isTagOnlyComment({ type: 'text', text }), false, text);
  assert.equal(isTagOnlyComment({ type: 'text', text: 'Nguyễn Minh Anh' }), true);
});
