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

async function run(conversation, text, { reply, extraDeps = {} } = {}) {
  const sent = [];
  const saved = [];
  const created = [];
  const results = await processChatbotChanges([{
    type: 'message',
    conversation: { id: 'page:user', pageId: 'page', psid: 'user', name: 'Mai', botEnabled: true, ...conversation },
    message: { id: `m-${Date.now()}-${Math.random()}`, mid: 'm', direction: 'incoming', type: 'text', text, createdAt: Date.now() }
  }], {
    readSettings: settings(),
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

test('đơn cũ đã hủy hoặc quá 7 ngày: lên đơn mới như thường', async () => {
  const confirmation = renderChatbotReply({ template_id: 'ORDER_CONFIRMATION', Product_N1: 'Granola Túi Xanh 450g', No_A: '2', Phone_Number: '0909123456', Customer_Address: '73 Sinh Trung, Phường Vạn Thạnh, Thành phố Nha Trang, Khánh Hòa' }, templates, {});
  const cancelled = await run({ customerOrders: [{ ...existing, processingStatus: 'cancelled' }] }, '2 túi xanh', { reply: confirmation });
  assert.equal(cancelled.results[0].templateId, 'ORDER_CONFIRMATION');
  assert.equal(cancelled.created.length, 1);
  const old = await run({ customerOrders: [{ ...existing, createdAt: Date.now() - 9 * 24 * 60 * 60 * 1000 }] }, '2 túi xanh', { reply: confirmation });
  assert.equal(old.results[0].templateId, 'ORDER_CONFIRMATION');
  assert.equal(old.created.length, 1);
});
