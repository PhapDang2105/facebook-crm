import assert from 'node:assert/strict';
import test from 'node:test';
import './helpers/seed-catalog.mjs';
import { processChatbotChanges } from '../app/chatbot-engine.mjs';
import { defaultMessageTemplates, renderChatbotReply } from '../app/chatbot-templates.mjs';

// Chủ shop 26/09: khách Mai Tran có đơn 24/09 đang giao, hai ngày sau nhắn "cho 2 bịch xanh, địa chỉ cũ"
// → bot tạo luôn đơn thứ hai. Yêu cầu: báo khách đang có đơn, hỏi xác nhận đặt thêm rồi mới lên.
const templates = Object.fromEntries(Object.entries(defaultMessageTemplates()).map(([id, text]) => [id, text.trim()]));
// R15-fix4 (chủ shop 03/10, thiết kế gộp/tách mới): với lời seed (hỏi GỘP hay TÁCH) "đúng/ok" là mơ hồ → bạn phụ trách; lời cũ
// đang chạy trên máy chủ ("… nhắn "đúng" là em lên đơn liền") thì "đúng" vẫn lên đơn. Các ca "đúng → chốt" dưới đây chạy với LỜI CŨ;
// "không / đơn cũ / chuyện khác" khi đang chờ → bạn phụ trách (STAFF_WAIT_*), giữ giỏ, không kể đơn cũ (trước: ORDER_STATUS + bỏ giỏ).
const LEGACY_CONFIRM = 'Dạ {title} ơi, em thấy mình đang có đơn {existing_items} đặt lúc {existing_at}, hiện {existing_state} ạ 🌾 Mình muốn đặt THÊM một đơn mới gồm {cart} nữa đúng không ạ? {Title} nhắn "đúng" giúp em là em lên đơn liền; còn nếu là đơn cũ thì {title} cứ nhắn em kiểm tra cho mình nha ạ.';
const legacy = { messageTemplates: { ...templates, ORDER_EXISTING_CONFIRM: LEGACY_CONFIRM } };
const settings = extra => async () => ({ enabled: true, responseMode: 'automatic', handoffKeywords: '', fragmentWaitMs: 1, messageTemplates: templates, ...extra });
const twoDaysAgo = Date.now() - 2 * 24 * 60 * 60 * 1000;
const existing = { id: 'o-2409', createdAt: twoDaysAgo, total: 298000, status: 'đang giao', products: [{ name: 'Granola Túi Xanh 450g', quantity: 1 }, { name: 'Granola Túi Vàng 350g', quantity: 1 }] };

async function run(conversation, text, { reply, extraDeps = {}, extraSettings = {} } = {}) {
  const sent = [];
  const saved = [];
  const created = [];
  const results = await processChatbotChanges([{
    type: 'message',
    conversation: { id: 'page:user', pageId: 'page', psid: 'user', name: 'Mai', botEnabled: true, ...conversation },
    message: { id: `m-${Date.now()}-${Math.random()}`, mid: 'm', direction: 'incoming', type: 'text', text, createdAt: Date.now() }
  }], {
    readSettings: settings(extraSettings),
    listMessages: async () => [],
    saveBotState: async (_id, state) => { saved.push(state); },
    sendMessage: async (_c, message) => { sent.push(message.text || ''); return { message: { mid: 'x' } }; },
    createOrder: async (_c, order) => { created.push(order); return { order: { id: 'new', ...order }, created: true }; },
    requestReply: async () => reply,
    ...extraDeps
  });
  return { sent, saved, created, results };
}

test('đang có đơn trong 7 ngày mà mô hình chốt đơn mới: chưa tạo, kể đơn đang có và hỏi xác nhận đặt thêm; giỏ giữ lại với cờ chờ xác nhận', async () => {
  const confirmation = renderChatbotReply({ template_id: 'ORDER_CONFIRMATION', Product_N1: 'Granola Túi Xanh 450g', No_A: '2', Phone_Number: '0909123456', Customer_Address: '73 Sinh Trung, Phường Vạn Thạnh, Thành phố Nha Trang, Khánh Hòa' }, templates, {});
  assert.equal(confirmation.templateId, 'ORDER_CONFIRMATION');
  const out = await run({ customerOrders: [existing] }, 'Cho 2 bịch màu xanh, địa chỉ cũ', { reply: confirmation });
  assert.deepEqual(out.created, [], 'không tạo đơn thứ hai');
  assert.equal(out.results[0].templateId, 'ORDER_EXISTING_CONFIRM');
  assert.match(out.sent.join(' '), /đang có đơn Granola Túi Xanh 450g x1, Granola Túi Vàng 350g x1/);
  // R15 (chủ shop 03/10): mẫu seed hỏi GỘP vào đơn đang có hay TÁCH đơn mới (trước đây "đặt THÊM một đơn mới…").
  // R16 (inbox4 H1, quyết định 7 chỉ nói đơn < 24 giờ): đơn này 2 ngày, đang giao → không gộp được → lời cũ "đặt THÊM… đúng không"
  // (trước R16 test khẳng định câu hỏi gộp/tách cho cả đơn đang giao — chính là hồi quy ca …011918).
  assert.match(out.sent.join(' '), /đặt THÊM một đơn mới gồm 2 Granola Túi Xanh 450g – tổng 298\.000đ nữa đúng không/);
  assert.equal(out.saved.at(-1).pendingOrder.addOnlyAsk, true);
  const pending = out.saved.at(-1).pendingOrder;
  assert.equal(pending.awaitingConfirm, true);
  assert.deepEqual(pending.items, [{ product: 'Granola Túi Xanh 450g', code: 'GRA-XANH-Z450', quantity: 2 }]);
  assert.equal(pending.phone, '0909123456');

  // Khách xác nhận "đúng rồi": chốt giỏ đang giữ, tạo đơn, không hỏi mô hình.
  const yes = await run({ customerOrders: [existing], pendingOrder: pending, botLastTemplateId: 'ORDER_EXISTING_CONFIRM', botLastReplyAt: Date.now() - 60000 }, 'Đúng rồi e', { reply: { templateId: 'GENERAL_INFO', messages: ['không được hỏi mô hình'], handoff: false }, extraSettings: legacy });
  assert.equal(yes.results[0].templateId, 'ORDER_CONFIRMATION');
  assert.equal(yes.created.length, 1);
  assert.deepEqual(yes.created[0].items.map(item => [item.product, item.quantity]), [['Granola Túi Xanh 450g', 2]]);
  assert.equal(yes.created[0].phone, '0909123456');
  // R16: bot đã hỏi bằng lời cũ (cờ addOnlyAsk — đơn không gộp được) nên "Đúng rồi e" lên đơn cả khi mẫu seed hỏi gộp/tách.
  const viaFlag = await run({ customerOrders: [existing], pendingOrder: pending, botLastTemplateId: 'ORDER_EXISTING_CONFIRM', botLastReplyAt: Date.now() - 60000 }, 'Đúng rồi e', { reply: { templateId: 'GENERAL_INFO', messages: ['không được hỏi mô hình'], handoff: false } });
  assert.equal(viaFlag.created.length, 1);
  // Lời seed (gộp hay tách?) cho giỏ chờ KHÔNG có cờ addOnlyAsk: "Đúng rồi e" không trả lời được → bạn phụ trách, không tạo đơn, giữ giỏ.
  const vague = await run({ customerOrders: [existing], pendingOrder: { ...pending, addOnlyAsk: undefined }, botLastTemplateId: 'ORDER_EXISTING_CONFIRM', botLastReplyAt: Date.now() - 60000 }, 'Đúng rồi e', { reply: { templateId: 'GENERAL_INFO', messages: ['không được hỏi mô hình'], handoff: false } });
  assert.match(vague.results[0].templateId, /^STAFF_WAIT_(OPEN|CLOSED)$/);
  assert.deepEqual(vague.created, []);
  assert.equal(vague.saved.at(-1).pendingOrder.staffAsked, true);

  // Khách nói là đơn cũ (phủ định): bạn phụ trách + thẻ, giữ giỏ chờ, không tạo đơn.
  const no = await run({ customerOrders: [existing], pendingOrder: pending, botLastTemplateId: 'ORDER_EXISTING_CONFIRM', botLastReplyAt: Date.now() - 60000 }, 'Không, đơn cũ của chị á', { reply: { templateId: 'GENERAL_INFO', messages: ['không được hỏi mô hình'], handoff: false }, extraSettings: legacy });
  assert.match(no.results[0].templateId, /^STAFF_WAIT_(OPEN|CLOSED)$/);
  assert.deepEqual(no.created, []);
  assert.deepEqual(no.saved.at(-1).pendingOrder.items, pending.items);
  assert.ok(no.saved.at(-1).addLabelEvents.includes('handoff'));
});

const address = '73 Sinh Trung, Phường Vạn Thạnh, Thành phố Nha Trang, Khánh Hòa';
const waiting = { items: [{ product: 'Granola Túi Xanh 450g', code: 'GRA-XANH-Z450', quantity: 2 }], key: 'GRA-XANH-Z450=2', at: Date.now() - 5 * 60 * 1000, phone: '0909123456', address, addressAsks: 2, awaitingConfirm: true };
const asked = { customerOrders: [existing], pendingOrder: waiting, botLastTemplateId: 'ORDER_EXISTING_CONFIRM', botLastReplyAt: Date.now() - 60000 };

test('đang chờ xác nhận: "Dạ cảm ơn shop" / "Đã đặt rồi mà" không phải đồng ý — không tạo đơn', async () => {
  // R15-fix4: câu không phải trả lời rõ gộp/tách (kể cả lời cũ) → bạn phụ trách + thẻ, giữ giỏ (trước: THANK_YOU + bỏ cờ chờ).
  const thanks = await run(asked, 'Dạ cảm ơn shop', { reply: { templateId: 'THANK_YOU', messages: ['cảm ơn'], handoff: false }, extraSettings: legacy });
  assert.deepEqual(thanks.created, []);
  assert.match(thanks.results[0].templateId, /^STAFF_WAIT_(OPEN|CLOSED)$/);
  const already = await run(asked, 'Đã đặt rồi mà', { reply: { templateId: 'ORDER_STATUS', messages: ['x'], handoff: false }, extraSettings: legacy });
  assert.deepEqual(already.created, []);
  // R14 (chủ shop 03/10, inbox3 S1 ca …762063): trước đây bot vừa gửi mẫu khác thì "ok" không chốt — khách "Ok" sau khi bot
  // chen bảng giá Tropical nhận lời cảm ơn suông, mất đơn. Nay dựa vào cờ chờ xác nhận còn hạn 30 phút (hỏi 5 phút trước):
  // "Ok" là đồng ý, chốt giỏ đang giữ. Hỏi quá 30 phút (và mẫu cuối không phải câu hỏi) thì "ok" không chốt.
  const stale = await run({ ...asked, botLastTemplateId: 'SHIPPING_POLICY' }, 'Ok', { reply: { templateId: 'GENERAL_INFO', messages: ['x'], handoff: false }, extraSettings: legacy });
  assert.equal(stale.created.length, 1);
  const old = await run({ ...asked, botLastTemplateId: 'SHIPPING_POLICY', pendingOrder: { ...waiting, at: Date.now() - 40 * 60 * 1000 } }, 'Ok', { reply: { templateId: 'GENERAL_INFO', messages: ['x'], handoff: false }, extraSettings: legacy });
  assert.deepEqual(old.created, []);
});

test('đang chờ xác nhận mà khách nêu giỏ mới ("2 túi vàng nhé"): bạn phụ trách, giữ giỏ, không tạo; vừa hỏi < 30 phút thì không hỏi lại lần hai', async () => {
  // Vòng 8 (mục 18): đã hỏi "đặt thêm?" 5 phút trước → không gửi lại mẫu xác nhận (log: hỏi 2 lần trong 4 phút).
  // R15-fix4 (thiết kế gộp/tách mới): câu có tên món/số túi không phải trả lời rõ → STAFF_WAIT một lần + thẻ, giỏ chờ GIỮ NGUYÊN
  // (trước: im + đổi giỏ thành 2 Vàng); lượt sau trong lúc chờ: im + thẻ.
  const yellow = await run(asked, '2 túi vàng nhé', { reply: { templateId: 'GENERAL_INFO', messages: ['không được hỏi mô hình'], handoff: false }, extraSettings: { ruleIntent: 'on' } });
  assert.deepEqual(yellow.created, []);
  assert.match(yellow.results[0].templateId, /^STAFF_WAIT_(OPEN|CLOSED)$/);
  assert.doesNotMatch(yellow.sent.join(' '), /gộp|tách|đặt THÊM/, 'không hỏi lại trong 30 phút');
  const pending = yellow.saved.at(-1).pendingOrder;
  assert.equal(pending.awaitingConfirm, true);
  assert.deepEqual(pending.items.map(item => [item.product, item.quantity]), [['Granola Túi Xanh 450g', 2]]);
  assert.ok(yellow.saved.at(-1).addLabelEvents.includes('handoff'));
  const again = await run({ ...asked, pendingOrder: pending, botLastTemplateId: yellow.results[0].templateId }, '2 túi vàng nhé', { reply: { templateId: 'GENERAL_INFO', messages: ['x'], handoff: false }, extraSettings: { ruleIntent: 'on' } });
  assert.deepEqual(again.sent, [], 'STAFF_WAIT chỉ gửi một lần');
  assert.deepEqual(again.created, []);
  // Hỏi đã lâu (35 phút) và bot đã nói chuyện khác sau câu hỏi: hết chờ → hỏi với giỏ mới như cũ.
  // (R15-fix4: tin cuối của bot còn là câu hỏi gộp/tách thì vẫn đang chờ → câu có tên món là bạn phụ trách, như trên.)
  const later = await run({ ...asked, botLastTemplateId: 'SHIPPING_POLICY', pendingOrder: { ...waiting, at: Date.now() - 35 * 60 * 1000 } }, '2 túi vàng nhé', { reply: { templateId: 'GENERAL_INFO', messages: ['không được hỏi mô hình'], handoff: false }, extraSettings: { ruleIntent: 'on' } });
  assert.equal(later.results[0].templateId, 'ORDER_EXISTING_CONFIRM');
  // R16 (inbox4 H1): đơn đang có 2 ngày, đang giao → không gộp được → lời cũ "đặt THÊM… đúng không" (trước R16: gộp/tách).
  assert.match(later.sent.join(' '), /đặt THÊM một đơn mới gồm 2 Granola Túi Vàng 350g.*đúng không/);
  // Khách "đúng" sau câu hỏi lại (lời cũ "nhắn đúng"): chốt giỏ 2 Vàng, không hỏi lại phường/xã.
  const yes = await run({ ...asked, pendingOrder: later.saved.at(-1).pendingOrder }, 'Đúng rồi', { reply: { templateId: 'GENERAL_INFO', messages: ['x'], handoff: false }, extraSettings: legacy });
  assert.equal(yes.results[0].templateId, 'ORDER_CONFIRMATION');
  assert.deepEqual(yes.created.map(order => order.items.map(item => [item.product, item.quantity])), [[['Granola Túi Vàng 350g', 2]]]);
});

test('cờ chờ còn sót nhưng giỏ quá 2 giờ, khách nhắn đủ giỏ+SĐT+địa chỉ: vẫn hỏi, không tạo', async () => {
  const confirmation = renderChatbotReply({ template_id: 'ORDER_CONFIRMATION', Product_N1: 'Granola Túi Vàng 350g', No_A: '2', Phone_Number: '0909123456', Customer_Address: address }, templates, {});
  const out = await run({ ...asked, botLastTemplateId: 'SHIPPING_POLICY', pendingOrder: { ...waiting, at: Date.now() - 3 * 60 * 60 * 1000 } }, `cho 2 túi vàng, 0909123456, ${address}`, { reply: confirmation });
  assert.deepEqual(out.created, []);
  assert.equal(out.results[0].templateId, 'ORDER_EXISTING_CONFIRM');
});

test('đơn mới nhất đã hủy nhưng đơn 2 ngày trước còn giao: vẫn hỏi xác nhận đặt thêm', async () => {
  const cancelledYesterday = { id: 'c1', createdAt: Date.now() - 24 * 60 * 60 * 1000, status: 'Hủy', processingStatus: 'cancelled', total: 189000, products: [{ name: 'Granola Túi Xanh 450g', quantity: 1 }] };
  const confirmation = renderChatbotReply({ template_id: 'ORDER_CONFIRMATION', Product_N1: 'Granola Túi Vàng 350g', No_A: '2', Phone_Number: '0909123456', Customer_Address: address }, templates, {});
  const out = await run({ customerOrders: [existing, cancelledYesterday] }, '2 túi vàng', { reply: confirmation });
  assert.deepEqual(out.created, []);
  assert.equal(out.results[0].templateId, 'ORDER_EXISTING_CONFIRM');
  assert.match(out.sent.join(' '), /đang có đơn Granola Túi Xanh 450g x1, Granola Túi Vàng 350g x1/, 'kể đơn còn giao, không kể đơn đã hủy');
});

test('địa chỉ không khớp danh mục đã được chấp nhận sau 2 lần hỏi: khách "đúng" thì chốt luôn, không hỏi lại phường/xã', async () => {
  const oddAddress = 'Số 5 ngõ 12 khu Abc Xyz';
  const first = renderChatbotReply({ template_id: 'ORDER_CONFIRMATION', Phone_Number: '0909123456', Customer_Address: oddAddress }, templates, { pendingOrder: { ...waiting, awaitingConfirm: undefined, address: oddAddress } });
  assert.equal(first.templateId, 'ORDER_CONFIRMATION');
  const ask = await run({ customerOrders: [existing] }, 'đúng địa chỉ đó', { reply: first });
  assert.equal(ask.results[0].templateId, 'ORDER_EXISTING_CONFIRM');
  const yes = await run({ ...asked, pendingOrder: ask.saved.at(-1).pendingOrder }, 'đúng rồi', { reply: { templateId: 'GENERAL_INFO', messages: ['x'], handoff: false }, extraSettings: legacy });
  assert.equal(yes.results[0].templateId, 'ORDER_CONFIRMATION');
  assert.equal(yes.created.length, 1);
});

test('đơn vừa hủy không giữ món: hủy 1 Xanh rồi đặt "1 xanh 1 vàng" ra đủ hai túi; ORDER_STATUS kể đơn hủy là "đã hủy"', () => {
  const cancelled = { id: 'c1', createdAt: Date.now() - 30 * 60 * 1000, status: 'Hủy', processingStatus: 'cancelled', phone: '0909123456', address, products: [{ sku: 'GRA-XANH-Z450', name: 'Granola Túi Xanh 450g', quantity: 1 }], total: 189000 };
  const reply = renderChatbotReply({ template_id: 'ORDER_CONFIRMATION', Product_N1: 'Granola Túi Xanh 450g', No_A: '1', Product_N2: 'Granola Túi Vàng 350g', No_B: '1', Phone_Number: '0909123456', Customer_Address: address }, templates, { recentOrder: cancelled, messageText: 'vậy cho em 1 xanh 1 vàng' });
  assert.equal(reply.templateId, 'ORDER_CONFIRMATION');
  assert.deepEqual(reply.order.items.map(item => [item.product, item.quantity]), [['Granola Túi Xanh 450g', 1], ['Granola Túi Vàng 350g', 1]]);
  assert.equal(reply.order.total, 298000);
  const status = renderChatbotReply({ template_id: 'ORDER_STATUS' }, templates, { recentOrder: cancelled });
  assert.match(status.messages[0], /hiện đã hủy/);
  assert.doesNotMatch(status.messages[0], /kho đang chuẩn bị hàng/);
});

test('tắt tự động lên đơn (autoOrder=false): hủy đơn vẫn gọi cancelOrder thật', async () => {
  const recent = { id: 'abc', createdAt: Date.now() - 60000, status: 'Mới', products: [{ name: 'Granola Túi Xanh 450g', quantity: 1 }] };
  let cancelled = 0;
  const out = await run({ customerOrders: [recent] }, 'hủy đơn giúp mình nhé', {
    reply: renderChatbotReply({ template_id: 'ORDER_CANCEL' }, templates, { recentOrder: recent, now: Date.now() }),
    extraSettings: { autoOrder: false, ruleIntent: 'off' },
    extraDeps: { cancelOrder: async () => { cancelled += 1; return { cancelled: true, created: false }; } }
  });
  assert.equal(cancelled, 1);
  assert.deepEqual(out.created, []);
  assert.equal(out.results[0].templateId, 'ORDER_CANCEL');
});

test('đơn cũ đã hủy hoặc quá 7 ngày: lên đơn mới như thường', async () => {
  const confirmation = renderChatbotReply({ template_id: 'ORDER_CONFIRMATION', Product_N1: 'Granola Túi Xanh 450g', No_A: '2', Phone_Number: '0909123456', Customer_Address: '73 Sinh Trung, Phường Vạn Thạnh, Thành phố Nha Trang, Khánh Hòa' }, templates, {});
  const cancelled = await run({ customerOrders: [{ ...existing, processingStatus: 'cancelled' }] }, '2 túi xanh', { reply: confirmation });
  assert.equal(cancelled.results[0].templateId, 'ORDER_CONFIRMATION');
  assert.equal(cancelled.created.length, 1);
  const old = await run({ customerOrders: [{ ...existing, createdAt: Date.now() - 9 * 24 * 60 * 60 * 1000 }] }, '2 túi xanh', { reply: confirmation });
  assert.equal(old.results[0].templateId, 'ORDER_CONFIRMATION');
  assert.equal(old.created.length, 1);
});

test('vòng 8: "đúng" có dấu phẩy / "đúng r" / "đúng, đơn mới" vẫn là đồng ý → chốt giỏ đang giữ, không hỏi mô hình', async () => {
  for (const text of ['Đúng rồi, lên đơn giúp chị', 'đúng r', 'Dạ đúng, đơn mới ạ', 'đúng rồi nha em, chị đặt thêm']) {
    const out = await run(asked, text, { reply: { templateId: 'GENERAL_INFO', messages: ['không được hỏi mô hình'], handoff: false }, extraSettings: legacy });
    assert.equal(out.results[0].templateId, 'ORDER_CONFIRMATION', text);
    assert.equal(out.created.length, 1, text);
    assert.equal(out.saved.at(-1).pendingOrder, null, text);
  }
  // R15-fix4, lời seed (gộp hay tách?): "đơn mới" / "đặt thêm" là TÁCH rõ → lên đơn; "đúng rồi, lên đơn" / "đúng r" mơ hồ → bạn phụ trách.
  for (const [text, creates] of [['Dạ đúng, đơn mới ạ', true], ['đúng rồi nha em, chị đặt thêm', true], ['Đúng rồi, lên đơn giúp chị', false], ['đúng r', false]]) {
    const out = await run(asked, text, { reply: { templateId: 'GENERAL_INFO', messages: ['không được hỏi mô hình'], handoff: false } });
    assert.equal(out.created.length, creates ? 1 : 0, text);
    if (!creates) assert.match(out.results[0].templateId, /^STAFF_WAIT_(OPEN|CLOSED)$/, text);
  }
  // Câu có ý khác (giao sớm, số lượng, màu túi) vẫn để mô hình/luật đọc, không chốt ngầm.
  for (const text of ['Đúng rồi em, giao sớm nha', 'đúng, 2 túi vàng', 'dạ xanh nhé']) {
    const out = await run(asked, text, { reply: { templateId: 'THANK_YOU', messages: ['x'], handoff: false } });
    assert.deepEqual(out.created, [], text);
  }
});

test('khách giữ ưu đãi dùng thử mà có đơn cũ trong 7 ngày: "đúng rồi" sau câu hỏi đặt thêm → chốt luôn, không nhờ mô hình', async () => {
  const promo = { freeShipping: true, until: Date.now() + 7 * 24 * 60 * 60 * 1000, scenarioId: 'inbox-trial-freeship', at: Date.now() - 60 * 60 * 1000, stage: 'chosen', bag: 'Granola Túi Xanh 450g', lockedUntil: Date.now() + 24 * 60 * 60 * 1000 };
  const pending = { ...waiting, items: [{ product: 'Granola Túi Xanh 450g', code: 'GRA-XANH-Z450', quantity: 1 }], key: 'GRA-XANH-Z450=1' };
  const out = await run({ ...asked, promo, pendingOrder: pending }, 'Đúng rồi e', { reply: { templateId: 'THANK_YOU', messages: ['không được hỏi mô hình'], handoff: false }, extraSettings: legacy });
  assert.equal(out.results[0].templateId, 'ORDER_CONFIRMATION');
  assert.equal(out.created.length, 1);
  assert.equal(out.created[0].trial, true, '1 túi dùng thử vẫn miễn ship');
  // R15-fix4: phủ định khi đang chờ → bạn phụ trách, không tạo (trước: ORDER_STATUS kể đơn cũ).
  const no = await run({ ...asked, promo, pendingOrder: pending }, 'không, đơn cũ', { reply: { templateId: 'THANK_YOU', messages: ['x'], handoff: false }, extraSettings: legacy });
  assert.match(no.results[0].templateId, /^STAFF_WAIT_(OPEN|CLOSED)$/);
  assert.deepEqual(no.created, []);
});

test('"hủy đơn" lần hai ngay sau khi vừa hủy: không hủy tiếp đơn cũ hơn còn giao; đáp "đã hủy" đúng đơn vừa hủy, không "đơn đơn"', async () => {
  const older = { id: 'B', createdAt: Date.now() - 2 * 60 * 60 * 1000, status: 'Mới', automatic: true, products: [{ sku: 'GRA-XANH-Z450', name: 'Granola Túi Xanh 450g', quantity: 2 }], total: 298000 };
  const cancelledA = { id: 'A', createdAt: Date.now() - 10 * 60 * 1000, status: 'Hủy', processingStatus: 'cancelled', products: [{ sku: 'GRA-VANG-H350', name: 'Granola Túi Vàng 350g', quantity: 1 }], total: 189000 };
  const cancelled = [];
  const deps = {
    cancelOrder: async (_c, id) => { cancelled.push(id); return { cancelled: true, created: false }; },
    requestReply: async ({ context }) => renderChatbotReply({ template_id: 'ORDER_CANCEL' }, templates, context)
  };
  const again = await run({ customerOrders: [cancelledA, older], botLastTemplateId: 'ORDER_CANCEL', botLastReplyAt: Date.now() - 60000 }, 'hủy đơn giúp chị', { extraDeps: deps, extraSettings: { ruleIntent: 'off' } });
  assert.equal(again.results[0].templateId, 'ORDER_CANCEL');
  assert.deepEqual(cancelled, [], 'đơn B còn giao không bị hủy theo');
  assert.match(again.sent.join(' '), /đã hủy đơn Granola Túi Vàng 350g x1/);
  const only = await run({ customerOrders: [cancelledA], botLastTemplateId: 'THANK_YOU', botLastReplyAt: Date.now() - 60000 }, 'hủy đơn giúp chị', { extraDeps: deps, extraSettings: { ruleIntent: 'off' } });
  assert.deepEqual(cancelled, []);
  assert.doesNotMatch(only.sent.join(' '), /đơn đơn/);
  // Đơn hủy đã lâu (3 giờ), bot không vừa hủy: "hủy đơn" là hủy đơn B đang mở.
  // fix-bot C4 (01/10): đơn B để 30 phút (trước đây 60 phút — bot chỉ tự hủy trong 60 phút, quá thì ORDER_CANCEL_STAFF).
  const later = await run({ customerOrders: [{ ...cancelledA, createdAt: Date.now() - 3 * 60 * 60 * 1000 }, { ...older, createdAt: Date.now() - 30 * 60 * 1000 }],botLastTemplateId: 'THANK_YOU', botLastReplyAt: Date.now() - 60000 }, 'hủy đơn giúp chị', { extraDeps: deps, extraSettings: { ruleIntent: 'off' } });
  assert.equal(later.results[0].templateId, 'ORDER_CANCEL');
  assert.deepEqual(cancelled, ['B']);
});

test('ORDER_STATUS với đơn đã hủy: chỉ nêu "đã hủy", không nối đoạn thời gian giao / mã vận đơn', () => {
  const cancelled = { id: 'c1', createdAt: Date.now() - 30 * 60 * 1000, status: 'Hủy', processingStatus: 'cancelled', products: [{ sku: 'GRA-XANH-Z450', name: 'Granola Túi Xanh 450g', quantity: 1 }], total: 189000 };
  const status = renderChatbotReply({ template_id: 'ORDER_STATUS' }, templates, { recentOrder: cancelled });
  assert.match(status.messages.join(' '), /hiện đã hủy ạ/);
  assert.doesNotMatch(status.messages.join(' '), /Thời gian giao dự kiến|mã vận đơn/);
  const open = renderChatbotReply({ template_id: 'ORDER_STATUS' }, templates, { recentOrder: { ...cancelled, status: 'Mới', processingStatus: '' } });
  assert.match(open.messages.join(' '), /Thời gian giao dự kiến/);
});
