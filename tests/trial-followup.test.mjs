import assert from 'node:assert/strict';
import test from 'node:test';
import './helpers/seed-catalog.mjs';
import { processChatbotChanges } from '../app/chatbot-engine.mjs';
import { defaultMessageTemplates, renderChatbotReply } from '../app/chatbot-templates.mjs';
import { normalizeChatbotOrder } from '../app/conversation-orders.mjs';
import { activeTrial, filterTrialReply, trialStep } from '../app/processing/trial-flow.mjs';

// Luồng riêng cho khách nhận tin bám đuổi "1 túi dùng thử miễn ship" (processing/trial-flow.mjs).
const templates = Object.fromEntries(Object.entries(defaultMessageTemplates()).map(([id, text]) => [id, text.trim()]));
const now = Date.now();
const DAY = 24 * 60 * 60 * 1000;
const offer = extra => ({ freeShipping: true, until: now + 7 * DAY, scenarioId: 'inbox-trial-freeship', at: now - 60 * 60 * 1000, stage: 'offered', ...extra });
const offerConversation = extra => ({
  id: 'page:user', pageId: 'page', psid: 'user', name: 'Khách', botEnabled: true, gender: 'female',
  botLastTemplateId: 'PRICE_QUOTE', botLastReplyAt: now - 3 * DAY,
  promo: offer(),
  ...extra
});

async function run(conversation, text, { reply, ruleIntent = 'on', type = 'text' } = {}) {
  const sent = [];
  const saved = [];
  const created = [];
  let asked = false;
  const results = await processChatbotChanges([{
    type: 'message',
    conversation,
    message: { id: 'm-new', mid: 'm-new', direction: 'incoming', type, text, createdAt: Date.now() }
  }], {
    readSettings: async () => ({ enabled: true, responseMode: 'automatic', handoffKeywords: '', fragmentWaitMs: 1, ruleIntent, messageTemplates: templates }),
    listMessages: async () => [{ id: 'offer', direction: 'outgoing', type: 'text', text: templates.FOLLOW_UP_TRIAL_FREESHIP, createdAt: now - 60 * 60 * 1000 }],
    saveBotState: async (_id, state) => { saved.push(state); },
    sendMessage: async (_c, message) => { sent.push(message.text || '[ảnh]'); return { message: { mid: 'x' } }; },
    createOrder: async (_c, order) => { created.push(order); return { order: { id: 'new', ...normalizeChatbotOrder(order, conversation) }, created: true }; },
    // Mô hình thật dựng câu trả lời bằng ngữ cảnh của engine (context.trial…): làm y như vậy.
    requestReply: async ({ context }) => { asked = true; const value = reply || { template_id: 'GENERAL_INFO' }; return renderChatbotReply(value, templates, context); }
  });
  const promo = saved.map(state => state.promo).filter(Boolean).at(-1) || null;
  return { sent, saved, asked, results, created, promo, text: sent.join('\n') };
}

test('activeTrial: chỉ hộp thư, còn hạn (hay giữ thêm 24 giờ khi đã chọn túi), chưa đặt đơn sau ưu đãi', () => {
  assert.ok(activeTrial(offerConversation()));
  assert.equal(activeTrial(offerConversation({ source: 'comment' })), null);
  assert.equal(activeTrial(offerConversation({ promo: offer({ until: now - 1 }) })), null);
  assert.ok(activeTrial(offerConversation({ promo: offer({ until: now - 1, stage: 'chosen', lockedUntil: now + 60000 }) })), 'đã chọn túi: giữ thêm');
  assert.equal(activeTrial(offerConversation({ promo: offer({ stage: 'ordered' }) })), null);
  assert.equal(activeTrial(offerConversation({ customerOrders: [{ id: 'o', createdAt: now - 1000 }] })), null);
});

test('trialStep: đồng ý / chọn 1 túi / hỏi giá, freeship / từ chối / ≥2 túi → luồng thường', () => {
  const trial = offer();
  assert.equal(trialStep({ text: 'ok em', trial }).value.template_id, 'TRIAL_ACCEPT');
  assert.equal(trialStep({ text: 'ok em', trial: { ...trial, accepted: true } }).value.template_id, 'TRIAL_REMIND');
  const xanh = trialStep({ text: 'Vàng nha', trial, now });
  assert.deepEqual([xanh.value.template_id, xanh.value.Product_N1, xanh.value.No_A], ['ORDER_ADDRESS', 'Granola Túi Vàng 350g', '1']);
  assert.equal(xanh.patch.stage, 'chosen');
  assert.equal(xanh.patch.lockedUntil, Math.max(trial.until, now + DAY));
  assert.equal(trialStep({ text: 'Vàng nhiều hạt', trial }).value.Product_N1, 'Granola Túi Vàng 350g');
  assert.equal(trialStep({ text: 'freeship không em', trial }).value.template_id, 'TRIAL_FREESHIP_INFO');
  assert.equal(trialStep({ text: 'có giảm giá không', trial }).value.template_id, 'TRIAL_PRICE');
  assert.equal(trialStep({ text: 'giá sao em', trial }).value.template_id, 'TRIAL_PRICE');
  const declined = trialStep({ text: 'thôi em ạ, để sau', trial });
  assert.equal(declined.value.template_id, 'TRIAL_DECLINED');
  assert.equal(declined.patch.stage, 'declined');
  assert.equal(trialStep({ text: 'lấy 2 túi vàng', trial }).exit, 'combo2', 'đúng 2 túi: giữ ưu đãi combo 2 (bát gáo dừa)');
  assert.equal(trialStep({ text: '1 xanh 1 vàng', trial }).exit, 'combo2');
  assert.equal(trialStep({ text: 'lấy 3 túi xanh', trial }).exit, 'converted', 'từ 3 túi: đơn thường');
  // Câu hỏi thông tin: trả lời + mời bước tiếp (không bảng giá).
  const sugar = trialStep({ text: 'có ngọt không em', trial }).value;
  assert.deepEqual([sugar.template_id, sugar.also], ['NO_ADDED_SUGAR', 'TRIAL_NEXT_STEP']);
  // Đã chọn túi, gửi SĐT: bước đơn với đúng túi đã chọn.
  const chosen = { ...trial, stage: 'chosen', bag: 'Granola Túi Xanh 450g' };
  assert.deepEqual([trialStep({ text: '0909123456', trial: chosen }).value.template_id, trialStep({ text: '0909123456', trial: chosen }).value.Product_N1], ['ORDER_ADDRESS', 'Granola Túi Xanh 450g']);
  assert.equal(trialStep({ text: '12 Lê Lợi, Phường Bến Nghé, Quận 1, TP Hồ Chí Minh nha em', trial: chosen }).delegate, true, 'địa chỉ: mô hình đọc');
});

test('filterTrialReply: mẫu luồng chung (bảng giá, combo, freeship chung) đổi sang mẫu dùng thử', () => {
  const trial = offer();
  assert.equal(filterTrialReply({ templateId: 'GENERAL_INFO' }, trial).template_id, 'TRIAL_PRICE');
  assert.equal(filterTrialReply({ templateId: 'DISCOUNT_POLICY' }, trial).template_id, 'TRIAL_PRICE');
  assert.equal(filterTrialReply({ templateId: 'FREESHIP_POLICY' }, trial).template_id, 'TRIAL_FREESHIP_INFO');
  assert.deepEqual([filterTrialReply({ templateId: 'SHIPPING_POLICY', alsoTemplateId: 'FREESHIP_POLICY' }, trial).template_id, filterTrialReply({ templateId: 'SHIPPING_POLICY', alsoTemplateId: 'FREESHIP_POLICY' }, trial).also], ['SHIPPING_POLICY', 'TRIAL_NEXT_STEP'], 'câu chính giữ, ý phụ đổi');
  assert.equal(filterTrialReply({ templateId: 'PRICE_XANH' }, trial, id => id.startsWith('PRICE_')).template_id, 'TRIAL_PRICE');
  assert.equal(filterTrialReply({ templateId: 'ASK_FLAVOR' }, { ...trial, stage: 'chosen', bag: 'Granola Túi Xanh 450g' }).template_id, 'ORDER_ADDRESS');
  assert.equal(filterTrialReply({ templateId: 'SHIPPING_POLICY' }, trial), null);
});

test('khách trả lời "Vàng nha" (lỗi thật 25/09: bot gửi bảng giá có ship 15k): giỏ 1 túi miễn ship, không mời 2 túi, không hỏi mô hình', async () => {
  const out = await run(offerConversation(), 'Vàng nha');
  assert.equal(out.asked, false);
  assert.equal(out.results[0].templateId, 'ORDER_ADDRESS');
  assert.match(out.text, /1 Granola Túi Vàng 350g, tổng 174\.000đ \(Miễn phí vận chuyển – ưu đãi dùng thử\)/);
  assert.doesNotMatch(out.text, /15\.000|lấy 2|Combo/);
  assert.equal(out.promo.stage, 'chosen');
  assert.equal(out.promo.bag, 'Granola Túi Vàng 350g');
});

test('"ok" → mời chọn túi (kèm giá từng túi); chạy cả khi luật nhận ý đang tắt', async () => {
  for (const mode of ['on', 'off']) {
    const out = await run(offerConversation(), 'ok em', { ruleIntent: mode });
    assert.equal(out.results[0].templateId, 'TRIAL_ACCEPT', mode);
    assert.match(out.text, /Túi Xanh 450g 174\.000đ/);
    assert.equal(out.asked, false);
  }
});

test('đã chọn túi, gửi SĐT + địa chỉ (mô hình đọc): xác nhận đơn 1 túi 174.000đ miễn ship; đơn ghi (Freeship), ưu đãi đóng lại', async () => {
  const conversation = offerConversation({ promo: offer({ stage: 'chosen', bag: 'Granola Túi Xanh 450g', lockedUntil: now + DAY }), botLastTemplateId: 'ORDER_ADDRESS', botLastReplyAt: now - 60000, pendingOrder: { items: [{ product: 'Granola Túi Xanh 450g', code: 'GRA-XANH-Z450', quantity: 1 }], key: 'GRA-XANH-Z450=1', at: now - 60000 } });
  const out = await run(conversation, '0909123456, 12 Lê Lợi, Phường Bến Nghé, Quận 1, TP Hồ Chí Minh', {
    reply: { template_id: 'ORDER_CONFIRMATION', Product_N1: 'Granola Túi Xanh 450g', No_A: '1', Phone_Number: '0909123456', Customer_Address: '12 Lê Lợi, Phường Bến Nghé, Quận 1, TP Hồ Chí Minh' }
  });
  assert.equal(out.asked, true);
  assert.equal(out.results[0].templateId, 'ORDER_CONFIRMATION');
  assert.match(out.text, /Tổng tiền: 174\.000đ/);
  assert.doesNotMatch(out.text, /Phí vận chuyển: 15/);
  assert.equal(out.created.length, 1);
  assert.equal(out.created[0].trial, true);
  assert.equal(out.created[0].shippingFee, 0);
  assert.equal(out.promo.stage, 'ordered');
  const order = normalizeChatbotOrder(out.created[0], conversation);
  assert.match(order.address, /^\(Freeship\) /);
  assert.match(order.note, /Ưu đãi dùng thử bám đuổi/);
});

test('mô hình định gửi bảng giá / combo cho khách đang giữ ưu đãi: đổi thành mẫu dùng thử', async () => {
  const out = await run(offerConversation(), 'chị đang cân nhắc mua cho cả nhà cùng dùng, em tư vấn thêm giúp chị với', { reply: { template_id: 'DISCOUNT_POLICY' } });
  assert.equal(out.asked, true);
  assert.equal(out.results[0].templateId, 'TRIAL_PRICE');
  assert.doesNotMatch(out.text, /Combo 3|Gia Đình|Giá gốc/);
});

test('chính sách 36 giờ (26/09): khách lấy combo 2 túi → rời luồng 1 túi, giá combo miễn ship + tặng bát gáo dừa; đơn ghi quà và ghi chú, không ghi (Freeship)', async () => {
  const out = await run(offerConversation(), 'lấy 2 túi vàng nha', { reply: { template_id: 'ORDER_ADDRESS', Product_N1: 'Granola Túi Vàng 350g', No_A: '2' } });
  assert.equal(out.promo.stage, 'converted');
  assert.equal(out.promo.combo2, true);
  assert.match(out.text, /tổng 298\.000đ/);
  assert.match(out.text, /Bát gáo dừa/);
  assert.doesNotMatch(out.text, /ưu đãi dùng thử/);
  // Lượt sau (ưu đãi đã chuyển sang combo 2, còn cửa sổ): SĐT + địa chỉ → chốt đơn có quà, đẩy POS có dòng quà.
  const conversation = offerConversation({ promo: { ...offer(), stage: 'converted', combo2: true, lockedUntil: now + DAY }, pendingOrder: out.saved.at(-1).pendingOrder, botLastTemplateId: 'ORDER_ADDRESS', botLastReplyAt: now });
  const done = await run(conversation, '0909123456, 12 Lê Lợi, Phường Bến Nghé, Quận 1, TP.HCM', { reply: { template_id: 'ORDER_CONFIRMATION', Product_N1: 'Granola Túi Vàng 350g', No_A: '2', Phone_Number: '0909123456', Customer_Address: '12 Lê Lợi, Phường Bến Nghé, Quận 1, TP.HCM' } });
  assert.equal(done.created.length, 1);
  assert.equal(done.created[0].promoGift, 'Bát gáo dừa – ưu đãi bám đuổi');
  assert.match(done.created[0].gift, /Bát gáo dừa/);
  assert.equal(done.created[0].total, 298000);
  const order = normalizeChatbotOrder(done.created[0], conversation);
  assert.match(order.note, /tặng Bát gáo dừa/);
  assert.doesNotMatch(order.address, /^\(Freeship\)/);
  // 3 túi: đơn thường theo bảng quà chung, không có quà bám đuổi.
  const three = await run(offerConversation(), 'lấy 3 túi xanh', { reply: { template_id: 'ORDER_ADDRESS', Product_N1: 'Granola Túi Xanh 450g', No_A: '3' } });
  assert.equal(three.promo.stage, 'converted');
  assert.notEqual(three.promo.combo2, true);
  assert.doesNotMatch(three.text, /ưu đãi bám đuổi/);
});

test('promoBowlActive: còn cửa sổ và chưa đặt đơn sau ưu đãi (offered/chosen/converted+combo2) → đúng; từ chối, hết hạn, đã đặt, converted không combo2 → sai', async () => {
  const { promoBowlActive } = await import('../app/processing/trial-flow.mjs');
  assert.equal(promoBowlActive(offerConversation()), true);
  assert.equal(promoBowlActive(offerConversation({ promo: { ...offer(), stage: 'converted', combo2: true, lockedUntil: now + DAY } })), true);
  assert.equal(promoBowlActive(offerConversation({ promo: { ...offer(), stage: 'converted' } })), false);
  assert.equal(promoBowlActive(offerConversation({ promo: { ...offer(), stage: 'declined' } })), false);
  assert.equal(promoBowlActive(offerConversation({ promo: { ...offer(), until: now - 1 } })), false);
  assert.equal(promoBowlActive(offerConversation({ customerOrders: [{ id: 'o', createdAt: now, total: 298000 }] })), false);
  assert.equal(promoBowlActive({ ...offerConversation(), source: 'comment' }), false);
});

test('hết hạn (chưa chọn túi) hay đã đặt đơn sau ưu đãi: về luồng thường; đơn 1 túi thường không ghi (Freeship)', async () => {
  const expired = await run(offerConversation({ promo: offer({ until: now - 1000 }) }), 'ok em');
  assert.notEqual(expired.results[0].templateId, 'TRIAL_ACCEPT');
  const conversation = { id: 'page:user', name: 'Khách' };
  const paid = normalizeChatbotOrder({ items: [{ product: 'Granola Túi Xanh 450g', code: 'GRA-XANH-Z450', quantity: 1 }], phone: '0909123456', address: '12 Lê Lợi, Quận 1, TP Hồ Chí Minh', total: 174000, shippingFee: 0 }, conversation);
  assert.doesNotMatch(paid.address, /Freeship/, 'không có cờ dùng thử thì không suy đoán');
});

test('lỗi thật 25/09 (Voc Nguyen): khách hỏi gói nhỏ → rời luồng dùng thử; "2 túi xanh" lúc đang nói gói nhỏ không tự hiểu là túi lớn; ưu đãi chỉ cho túi lớn', async () => {
  const trial = offer();
  assert.equal(trialStep({ text: 'Có loại chia gói nhỏ ăn tung bữa ko', trial }).exit, 'converted');
  assert.equal(trialStep({ text: 'Có a', trial, lastTemplateId: 'PACKAGING_INFO' }).exit, 'converted');
  const { ruleIntent } = await import('../app/processing/rule-intent.mjs');
  const { commentBasket } = await import('../app/chatbot-engine.mjs');
  assert.equal(ruleIntent('Cho m 2 túi xanh', { commentBasket })?.rule, 'BASKET', 'bình thường: giỏ túi lớn');
  assert.notEqual(ruleIntent('Cho m 2 túi xanh', { commentBasket, smallPackContext: true })?.rule, 'BASKET', 'đang nói gói nhỏ: để mô hình');
  // Ưu đãi không áp cho sản phẩm khác túi Xanh/Vàng/Nâu (Tropical 300g vẫn cộng ship).
  const value = { template_id: 'ORDER_CONFIRMATION', Product_N1: 'Granola Tropical Cacao 300g', No_A: '1', Phone_Number: '0909123456', Customer_Address: '12 Lê Lợi, Phường Bến Nghé, Quận 1, TP.HCM' };
  const other = renderChatbotReply(value, templates, { now, trial });
  assert.ok(other.order.shippingFee > 0);
  assert.equal(other.order.trial, undefined);
});

test('rà soát 25/09: "không"/"ko"/khiếu nại không phải đồng ý; "lấy 1 túi thôi" là chọn; câu hỏi có màu không phải chọn; so sánh 2 túi trả lời chứ không thoát; ý phụ bị cấm chỉ đổi ý phụ', async () => {
  const trial = offer();
  for (const text of ['không', 'ko', 'k', 'không nhé', 'thôi để sau']) assert.equal(trialStep({ text, trial }).value?.template_id, 'TRIAL_DECLINED', text);
  for (const text of ['hàng bị mốc', 'chưa nhận được hàng', 'mua rồi', 'đã đặt rồi', 'hủy đơn']) assert.equal(trialStep({ text, trial }).delegate, true, text);
  const one = trialStep({ text: 'lấy 1 túi xanh thôi em', trial, now });
  assert.deepEqual([one.value?.template_id, one.patch?.stage], ['ORDER_ADDRESS', 'chosen']);
  assert.equal(trialStep({ text: '1 túi thôi', trial }).value?.template_id, 'TRIAL_ACCEPT', 'chưa nêu màu: mời chọn túi');
  assert.equal(trialStep({ text: 'túi xanh có ngọt không?', trial }).value?.template_id, 'NO_ADDED_SUGAR');
  assert.equal(trialStep({ text: 'túi xanh bao nhiêu gam', trial }).value?.template_id, 'WEIGHT_EXPIRY');
  const compare = trialStep({ text: 'xanh với vàng khác nhau gì', trial });
  assert.deepEqual([compare.value?.template_id, compare.value?.also, compare.exit], ['BAG_COMPARISON', 'TRIAL_NEXT_STEP', undefined]);
  assert.equal(trialStep({ text: '0909123456', trial }).delegate, true, 'SĐT trước khi chọn túi: mô hình đọc');
  assert.equal(trialStep({ text: 'ok\n0909123456', trial }).delegate, true);
  assert.equal(filterTrialReply({ templateId: 'NO_ADDED_SUGAR', alsoTemplateId: 'PRICE_QUOTE' }, trial, id => id.startsWith('PRICE_'))?.template_id, 'NO_ADDED_SUGAR');
  assert.equal(filterTrialReply({ templateId: 'NO_ADDED_SUGAR', alsoTemplateId: 'PRICE_QUOTE' }, trial, id => id.startsWith('PRICE_'))?.also, 'TRIAL_NEXT_STEP');
});

test('rà soát vòng 7: "Dạ lấy túi xanh" là chọn (không nhầm "đã lấy"); câu hỏi dài có "được/có" không phải đồng ý', () => {
  const trial = offer();
  const xanh = trialStep({ text: 'Dạ lấy túi xanh', trial, now });
  assert.deepEqual([xanh.value?.template_id, xanh.patch?.stage], ['ORDER_ADDRESS', 'chosen']);
  assert.equal(trialStep({ text: 'Dạ nhận', trial }).value?.template_id, 'TRIAL_ACCEPT');
  assert.equal(trialStep({ text: 'dạ mua 1 túi vàng', trial }).value?.Product_N1, 'Granola Túi Vàng 350g');
  assert.equal(trialStep({ text: 'đã lấy rồi em', trial }).delegate, true);
  for (const text of ['Mình đang ở Hà Nội có giao được không', 'em ở Cần Thơ ship lâu ko', 'ship về Đà Nẵng bao lâu vậy', 'để mình hỏi chồng đã', 'thôi để mình xem đã']) {
    assert.notEqual(trialStep({ text, trial }).value?.template_id, 'TRIAL_ACCEPT', text);
  }
});
