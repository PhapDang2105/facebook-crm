import assert from 'node:assert/strict';
import test from 'node:test';
import './helpers/seed-catalog.mjs';
import { commentBasket, processChatbotChanges } from '../app/chatbot-engine.mjs';
import { defaultMessageTemplates } from '../app/chatbot-templates.mjs';
import { ruleIntent } from '../app/processing/rule-intent.mjs';
import { normalizeChatbotOrder } from '../app/conversation-orders.mjs';

// Khách nhận tin bám đuổi "1 túi dùng thử miễn ship" rồi trả lời.
const templates = Object.fromEntries(Object.entries(defaultMessageTemplates()).map(([id, text]) => [id, text.trim()]));
const now = Date.now();
const offerConversation = extra => ({
  id: 'page:user', pageId: 'page', psid: 'user', name: 'Khách', botEnabled: true, gender: 'female',
  botLastTemplateId: 'PRICE_QUOTE', botLastReplyAt: now - 3 * 24 * 60 * 60 * 1000,
  promo: { freeShipping: true, until: now + 7 * 24 * 60 * 60 * 1000, scenarioId: 'inbox-trial-freeship', at: now - 60 * 60 * 1000 },
  ...extra
});

async function run(conversation, text, { reply } = {}) {
  const sent = [];
  const saved = [];
  let asked = false;
  const results = await processChatbotChanges([{
    type: 'message',
    conversation,
    message: { id: 'm-new', mid: 'm-new', direction: 'incoming', type: 'text', text, createdAt: Date.now() }
  }], {
    readSettings: async () => ({ enabled: true, responseMode: 'automatic', handoffKeywords: '', fragmentWaitMs: 1, ruleIntent: 'on', messageTemplates: templates }),
    listMessages: async () => [{ id: 'offer', direction: 'outgoing', type: 'text', text: templates.FOLLOW_UP_TRIAL_FREESHIP, createdAt: now - 60 * 60 * 1000 }],
    saveBotState: async (_id, state) => { saved.push(state); },
    sendMessage: async (_c, message) => { sent.push(message.text || '[ảnh]'); return { message: { mid: 'x' } }; },
    createOrder: async (_c, order) => ({ order: { id: 'new', ...order }, created: true }),
    requestReply: async () => { asked = true; return reply || { templateId: 'GENERAL_INFO', messages: ['Bảng giá chung'], handoff: false }; }
  });
  return { sent, saved, asked, results };
}

test('luật dùng thử: đồng ý / chọn túi / hỏi giá → hỏi SĐT, địa chỉ; từ chối, hỏi thông tin, tin có SĐT → để luồng thường', () => {
  const ctx = { trialOffer: true, commentBasket };
  assert.equal(ruleIntent('ok shop', ctx).rule, 'TRIAL_ACCEPT');
  assert.equal(ruleIntent('Lấy nha em', ctx).rule, 'TRIAL_ACCEPT');
  assert.equal(ruleIntent('muốn thử', ctx).rule, 'TRIAL_ACCEPT');
  assert.equal(ruleIntent('giá sao em', ctx).rule, 'TRIAL_ACCEPT');
  assert.match(ruleIntent('ok', ctx).value.values.bags, /Túi Xanh 450g 174\.000đ, Túi Vàng 350g .+ hay Túi Nâu/);
  const xanh = ruleIntent('xanh', ctx);
  assert.equal(xanh.rule, 'TRIAL_BASKET');
  assert.deepEqual([xanh.value.template_id, xanh.value.Product_N1, xanh.value.No_A], ['ORDER_ADDRESS', 'Granola Túi Xanh 450g', '1']);
  const two = ruleIntent('lấy 2 túi vàng', ctx);
  assert.deepEqual([two.value.Product_N1, two.value.No_A], ['Granola Túi Vàng 350g', '2']);
  assert.equal(ruleIntent('túi nâu cacao nha', ctx).value.Product_N1, 'Granola Túi Nâu vị cacao 350g');
  assert.equal(ruleIntent('thôi em ạ, để sau', ctx), null);
  assert.equal(ruleIntent('không cần đâu', ctx), null);
  assert.equal(ruleIntent('túi xanh có ngọt không?', ctx).rule, 'SUGAR', 'câu hỏi: trả lời câu hỏi, không coi là đồng ý');
  assert.equal(ruleIntent('xanh 0909123456 12 Lê Lợi Q1', ctx), null, 'có SĐT + địa chỉ: mô hình đọc đủ');
  // Không có ưu đãi: "xanh" vẫn là báo giá túi đó như cũ.
  assert.equal(ruleIntent('xanh', { commentBasket }).rule, 'PRICE_ONE');
});

test('khách nhận ưu đãi trả lời "ok": mời chọn túi + xin SĐT, địa chỉ, không gửi lại bảng giá, không hỏi mô hình', async () => {
  const out = await run(offerConversation(), 'ok em');
  assert.equal(out.asked, false);
  assert.equal(out.results[0].templateId, 'TRIAL_ACCEPT');
  assert.match(out.sent.join('\n'), /MIỄN PHÍ VẬN CHUYỂN em vẫn giữ cho chị/);
  assert.match(out.sent.join('\n'), /SĐT và địa chỉ/);
});

test('khách chọn "xanh": giỏ 1 túi Xanh miễn ship (không cộng ship, không mời mua 2 túi), xin SĐT + địa chỉ', async () => {
  const out = await run(offerConversation(), 'Xanh nhé');
  assert.equal(out.asked, false);
  assert.equal(out.results[0].templateId, 'ORDER_ADDRESS');
  const text = out.sent.join('\n');
  assert.match(text, /1 Granola Túi Xanh 450g, tổng 174\.000đ \(Miễn phí vận chuyển – ưu đãi dùng thử\)/);
  assert.doesNotMatch(text, /lấy 2 túi/, 'không mời mua 2 túi');
  assert.equal(out.saved.at(-1).pendingOrder.items[0].quantity, 1);
});

test('sau lời mời chọn túi, khách trả lời tên túi vẫn vào luồng dùng thử; hết hạn / đã đặt đơn thì thôi', async () => {
  const afterAccept = await run(offerConversation({ botLastTemplateId: 'TRIAL_ACCEPT', botLastReplyAt: now - 60 * 1000 }), 'vàng');
  assert.equal(afterAccept.results[0].templateId, 'ORDER_ADDRESS');
  assert.match(afterAccept.sent.join('\n'), /Túi Vàng 350g, tổng 174\.000đ \(Miễn phí vận chuyển/);
  const expired = await run(offerConversation({ promo: { freeShipping: true, until: now - 1000, at: now - 8 * 24 * 60 * 60 * 1000 } }), 'ok em');
  assert.notEqual(expired.results[0].templateId, 'TRIAL_ACCEPT');
  const ordered = await run(offerConversation({ customerOrders: [{ id: 'o1', createdAt: now - 10 * 60 * 1000, phone: '0909123456', products: [{ name: 'Granola Túi Xanh 450g', quantity: 1 }] }] }), 'ok em');
  assert.notEqual(ordered.results[0].templateId, 'TRIAL_ACCEPT');
});

test('mô hình định gửi lại bảng giá chung cho khách đang giữ ưu đãi: đổi thành lời mời chọn túi', async () => {
  const out = await run(offerConversation(), 'mình ở Hà Nội ship được không em', { reply: { template_id: 'GENERAL_INFO' } });
  assert.equal(out.results[0].templateId, 'TRIAL_ACCEPT');
});

test('đơn 1 túi miễn ship: địa chỉ mang đầu "(Freeship) "; đơn 1 túi thường thì không', () => {
  const conversation = { id: 'page:user', name: 'Khách' };
  const free = normalizeChatbotOrder({ items: [{ product: 'Granola Túi Xanh 450g', code: 'GRA-XANH-Z450', quantity: 1 }], phone: '0909123456', address: '12 Lê Lợi, Quận 1, TP Hồ Chí Minh', total: 174000, shippingFee: 0 }, conversation);
  assert.match(free.address, /^\(Freeship\) 12 Lê Lợi/);
  assert.equal(free.freeShipping, true);
  const paid = normalizeChatbotOrder({ items: [{ product: 'Granola Túi Xanh 450g', code: 'GRA-XANH-Z450', quantity: 1 }], phone: '0909123456', address: '12 Lê Lợi, Quận 1, TP Hồ Chí Minh', total: 189000, shippingFee: 15000 }, conversation);
  assert.doesNotMatch(paid.address, /Freeship/);
  const combo = normalizeChatbotOrder({ items: [{ product: 'Granola Túi Xanh 450g', code: 'GRA-XANH-Z450', quantity: 2 }], phone: '0909123456', address: '12 Lê Lợi, Quận 1, TP Hồ Chí Minh', total: 298000, shippingFee: 0 }, conversation);
  assert.doesNotMatch(combo.address, /Freeship/, 'combo 2 túi vốn miễn ship: không ghi');
});
