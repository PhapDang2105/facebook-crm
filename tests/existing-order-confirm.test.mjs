import assert from 'node:assert/strict';
import test from 'node:test';
import './helpers/seed-catalog.mjs';
import { processChatbotChanges } from '../app/chatbot-engine.mjs';
import { defaultMessageTemplates, renderChatbotReply } from '../app/chatbot-templates.mjs';

// Chủ shop 26/09: khách Mai Tran có đơn 24/09 đang giao, hai ngày sau nhắn "cho 2 bịch xanh, địa chỉ cũ"
// → bot tạo luôn đơn thứ hai. Yêu cầu: báo khách đang có đơn, hỏi xác nhận đặt thêm rồi mới lên.
const templates = Object.fromEntries(Object.entries(defaultMessageTemplates()).map(([id, text]) => [id, text.trim()]));
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
  assert.match(out.sent.join(' '), /đặt THÊM một đơn mới gồm 2 Granola Túi Xanh 450g – tổng 298\.000đ/);
  const pending = out.saved.at(-1).pendingOrder;
  assert.equal(pending.awaitingConfirm, true);
  assert.deepEqual(pending.items, [{ product: 'Granola Túi Xanh 450g', code: 'GRA-XANH-Z450', quantity: 2 }]);
  assert.equal(pending.phone, '0909123456');

  // Khách xác nhận "đúng rồi": chốt giỏ đang giữ, tạo đơn, không hỏi mô hình.
  const yes = await run({ customerOrders: [existing], pendingOrder: pending, botLastTemplateId: 'ORDER_EXISTING_CONFIRM', botLastReplyAt: Date.now() - 60000 }, 'Đúng rồi e', { reply: { templateId: 'GENERAL_INFO', messages: ['không được hỏi mô hình'], handoff: false } });
  assert.equal(yes.results[0].templateId, 'ORDER_CONFIRMATION');
  assert.equal(yes.created.length, 1);
  assert.deepEqual(yes.created[0].items.map(item => [item.product, item.quantity]), [['Granola Túi Xanh 450g', 2]]);
  assert.equal(yes.created[0].phone, '0909123456');

  // Khách nói là đơn cũ: kể đơn đang có, gắn thẻ cho nhân viên, bỏ giỏ chờ.
  const no = await run({ customerOrders: [existing], pendingOrder: pending, botLastTemplateId: 'ORDER_EXISTING_CONFIRM', botLastReplyAt: Date.now() - 60000 }, 'Không, đơn cũ của chị á', { reply: { templateId: 'GENERAL_INFO', messages: ['không được hỏi mô hình'], handoff: false } });
  assert.equal(no.results[0].templateId, 'ORDER_STATUS');
  assert.deepEqual(no.created, []);
  assert.equal(no.saved.at(-1).pendingOrder, null);
});

const address = '73 Sinh Trung, Phường Vạn Thạnh, Thành phố Nha Trang, Khánh Hòa';
const waiting = { items: [{ product: 'Granola Túi Xanh 450g', code: 'GRA-XANH-Z450', quantity: 2 }], key: 'GRA-XANH-Z450=2', at: Date.now() - 5 * 60 * 1000, phone: '0909123456', address, addressAsks: 2, awaitingConfirm: true };
const asked = { customerOrders: [existing], pendingOrder: waiting, botLastTemplateId: 'ORDER_EXISTING_CONFIRM', botLastReplyAt: Date.now() - 60000 };

test('đang chờ xác nhận: "Dạ cảm ơn shop" / "Đã đặt rồi mà" không phải đồng ý — không tạo đơn, bỏ cờ chờ', async () => {
  const thanks = await run(asked, 'Dạ cảm ơn shop', { reply: { templateId: 'THANK_YOU', messages: ['cảm ơn'], handoff: false } });
  assert.deepEqual(thanks.created, []);
  assert.equal(thanks.results[0].templateId, 'THANK_YOU');
  assert.ok(!thanks.saved.at(-1).pendingOrder?.awaitingConfirm, 'khách nói chuyện khác thì bỏ cờ chờ xác nhận');
  const already = await run(asked, 'Đã đặt rồi mà', { reply: { templateId: 'ORDER_STATUS', messages: ['x'], handoff: false } });
  assert.deepEqual(already.created, []);
  // Bot vừa gửi mẫu khác (không phải câu hỏi xác nhận) thì "ok" không chốt giỏ đang giữ.
  const stale = await run({ ...asked, botLastTemplateId: 'SHIPPING_POLICY' }, 'Ok', { reply: { templateId: 'GENERAL_INFO', messages: ['x'], handoff: false } });
  assert.deepEqual(stale.created, []);
});

test('đang chờ xác nhận mà khách nêu giỏ mới ("2 túi vàng nhé"): hỏi lại với giỏ 2 Vàng, không tạo', async () => {
  const yellow = await run(asked, '2 túi vàng nhé', { reply: { templateId: 'GENERAL_INFO', messages: ['không được hỏi mô hình'], handoff: false }, extraSettings: { ruleIntent: 'on' } });
  assert.deepEqual(yellow.created, []);
  assert.equal(yellow.results[0].templateId, 'ORDER_EXISTING_CONFIRM');
  assert.match(yellow.sent.join(' '), /đặt THÊM một đơn mới gồm 2 Granola Túi Vàng 350g/);
  const pending = yellow.saved.at(-1).pendingOrder;
  assert.equal(pending.awaitingConfirm, true);
  assert.deepEqual(pending.items.map(item => [item.product, item.quantity]), [['Granola Túi Vàng 350g', 2]]);
  // Khách "đúng" sau đó: chốt giỏ 2 Vàng, không hỏi lại phường/xã.
  const yes = await run({ ...asked, pendingOrder: pending }, 'Đúng rồi', { reply: { templateId: 'GENERAL_INFO', messages: ['x'], handoff: false } });
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
  const yes = await run({ ...asked, pendingOrder: ask.saved.at(-1).pendingOrder }, 'đúng rồi', { reply: { templateId: 'GENERAL_INFO', messages: ['x'], handoff: false } });
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
    const out = await run(asked, text, { reply: { templateId: 'GENERAL_INFO', messages: ['không được hỏi mô hình'], handoff: false } });
    assert.equal(out.results[0].templateId, 'ORDER_CONFIRMATION', text);
    assert.equal(out.created.length, 1, text);
    assert.equal(out.saved.at(-1).pendingOrder, null, text);
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
  const out = await run({ ...asked, promo, pendingOrder: pending }, 'Đúng rồi e', { reply: { templateId: 'THANK_YOU', messages: ['không được hỏi mô hình'], handoff: false } });
  assert.equal(out.results[0].templateId, 'ORDER_CONFIRMATION');
  assert.equal(out.created.length, 1);
  assert.equal(out.created[0].trial, true, '1 túi dùng thử vẫn miễn ship');
  const no = await run({ ...asked, promo, pendingOrder: pending }, 'không, đơn cũ', { reply: { templateId: 'THANK_YOU', messages: ['x'], handoff: false } });
  assert.equal(no.results[0].templateId, 'ORDER_STATUS');
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
  const later = await run({ customerOrders: [{ ...cancelledA, createdAt: Date.now() - 3 * 60 * 60 * 1000 }, { ...older, createdAt: Date.now() - 60 * 60 * 1000 }], botLastTemplateId: 'THANK_YOU', botLastReplyAt: Date.now() - 60000 }, 'hủy đơn giúp chị', { extraDeps: deps, extraSettings: { ruleIntent: 'off' } });
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
