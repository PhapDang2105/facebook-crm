// Vòng 13 (02/10) — giỏ Facebook Shop (out-inbox2 A1/B6/B7, out-inbox1 B4/B5/C8): giỏ combo bị đọc sai món, mã lạ để mô
// hình đoán, yến mạch bị mời granola, "đã nhận đơn" lấy tổng của đơn cũ, chờ 60 giây im lặng.
import assert from 'node:assert/strict';
import test from 'node:test';
import { Sim, PHONE, templates } from './helpers/r13-engine-sim.mjs';
import { cartQuickReply } from '../app/chatbot-engine.mjs';

const shopName = 'Granola Mới Ngũ Cốc Ăn Sáng Healthy Lành Mạnh Với Hạt Dinh Dưỡng Trái Cây Từ Giọt Nắng';
/** Tin giỏ như pancakeMessageEvent ghi: chữ tự sinh kèm mã SKU + mảng cart. */
const cartMessage = (sku, price, quantity = 1) => ({
  text: `Khách chọn mua từ Facebook Shop: ${shopName} (${sku}) — ${price.toLocaleString('vi-VN')}đ`,
  message: { cart: [{ name: shopName, sku, quantity, price, image: '' }] }
});
const shopSim = (settings = {}) => {
  const sim = new Sim({ settings: { shopOrderFollowUpMs: [], ...settings } });
  const inbox = sim.inbox({ pancakeConversationId: 'page_user', gender: 'female', botGender: 'female' });
  return { sim, inbox };
};
const noModel = () => { throw new Error('không được gọi mô hình cho tin giỏ Shop'); };

test('giỏ combo CB-VANGG+XANH (298k): giỏ là 1 Vàng + 1 Xanh, không bị chữ tin giỏ "…(CB-VANGG+XANH)" đổi thành 1 Túi Xanh 189k', async () => {
  const { sim, inbox } = shopSim();
  const cart = cartMessage('CB-VANGG+XANH', 298000);
  const turn = await sim.send(inbox, cart.text, { message: cart.message, llm: noModel });
  assert.equal(turn.result.templateId, 'ORDER_ADDRESS');
  assert.deepEqual(inbox.pendingOrder.items.map(item => `${item.quantity} ${item.code}`).sort(), ['1 GRA-VANG-H350', '1 GRA-XANH-Z450']);
  const said = turn.sent.map(item => item.text).join('\n');
  assert.match(said, /1 Granola Túi Vàng 350g \+ 1 Granola Túi Xanh 450g/);
  assert.match(said, /298\.000đ/);
  assert.doesNotMatch(said, /189\.000đ/, 'không báo giá 1 túi');
  // Hàm soạn nhanh: ngữ cảnh mang chữ tin giỏ và tin cũ của khách vẫn ra đúng giỏ.
  const direct = cartQuickReply(cart.message.cart, templates, { messageText: cart.text, recentCustomerTexts: [cart.text, 'cho chị 1 túi xanh'], customer: { gender: 'female' } });
  assert.deepEqual(direct.pendingOrder.items.map(item => `${item.quantity} ${item.code}`).sort(), ['1 GRA-VANG-H350', '1 GRA-XANH-Z450']);
  // Chốt tiếp bằng SĐT + địa chỉ: đơn đúng 2 món, 298k.
  const closed = await sim.send(inbox, `${PHONE} 12 Nguyễn Trãi, phường Bến Thành, Quận 1, TP HCM`, { llm: { template_id: 'ORDER_CONFIRMATION', Phone_Number: PHONE, Customer_Address: '12 Nguyễn Trãi, phường Bến Thành, Quận 1, TP HCM' } });
  assert.equal(closed.created.length, 1, JSON.stringify(closed.result));
  assert.deepEqual(closed.created[0].items.map(item => `${item.quantity} ${item.code}`).sort(), ['1 GRA-VANG-H350', '1 GRA-XANH-Z450']);
  assert.equal(closed.created[0].total, 298000);
});

test('giỏ có mã lạ: mẫu ghi nhận + thẻ Cần người xử lý, KHÔNG giao mô hình đoán; khách gửi SĐT sau đó không bị hỏi vị', async () => {
  const { sim, inbox } = shopSim();
  const cart = cartMessage('CB10-KHONGCO', 189000);
  const turn = await sim.send(inbox, cart.text, { message: cart.message, llm: noModel });
  assert.equal(turn.result.templateId, 'SHOP_CART_UNKNOWN');
  assert.equal(turn.asked.length, 0);
  assert.ok(inbox.labels.includes('handoff'));
  assert.equal(inbox.pendingOrder, undefined, 'không dựng giỏ từ mã lạ');
  assert.doesNotMatch(turn.sent.map(item => item.text).join(' '), /Combo 10 gói|Túi Xanh|Túi Vàng/);
  const phone = await sim.send(inbox, PHONE, { llm: noModel });
  assert.equal(phone.result.templateId, 'WAITING_STAFF', JSON.stringify(phone.result));
});

test('giỏ yến mạch CB2-HT-YM-T500: ghi nhận đúng tên món + xin SĐT/địa chỉ + thẻ, không mời "2 túi granola"', async () => {
  const { sim, inbox } = shopSim();
  const cart = cartMessage('CB2-HT-YM-T500', 131000);
  const turn = await sim.send(inbox, cart.text, { message: cart.message, llm: noModel });
  assert.equal(turn.result.templateId, 'SHOP_CART_STAFF');
  const said = turn.sent.map(item => item.text).join('\n');
  assert.match(said, /Yến Mạch Úc Nguyên Cám/);
  assert.match(said, /số điện thoại và địa chỉ/);
  assert.doesNotMatch(said, /2 túi|Túi Xanh|granola/i);
  assert.ok(inbox.labels.includes('handoff'));
  assert.equal(turn.asked.length, 0);
});

test('"đã nhận đơn …" lấy món và tổng từ CÙNG đơn POS; giỏ bấm sau đó không nhận lại đơn đã báo', async () => {
  const { sim, inbox } = shopSim();
  const posOrder = { id: 'S54883', total: 298000, phone: PHONE, items: [{ name: shopName, sku: 'CB-VANGG+XANH', quantity: 1 }] };
  const first = cartMessage('CB-VANGG+XANH', 298000);
  const received = await sim.send(inbox, first.text, { message: first.message, llm: noModel, extra: { findShopOrder: async () => posOrder } });
  assert.equal(received.result.templateId, 'SHOP_ORDER_RECEIVED');
  assert.match(received.sent[0].text, /1 Granola Túi Vàng 350g \+ 1 Granola Túi Xanh 450g – tổng 298\.000đ/);
  assert.equal(inbox.shopOrderAck.id, 'S54883');
  // Ca thật 01/10 12:41: 2 phút sau khách bấm giỏ 1 Túi Xanh (189k); POS vẫn chỉ có đơn 298k cũ → trước đây bot báo
  // "đã nhận đơn 1 Granola Túi Xanh 450g – tổng 298.000đ". Nay đơn đã báo không tính là đơn của giỏ mới.
  const second = cartMessage('GRA-XANH-Z450', 189000);
  const next = await sim.send(inbox, second.text, { message: second.message, llm: noModel, extra: { findShopOrder: async () => posOrder } });
  assert.notEqual(next.result.templateId, 'SHOP_ORDER_RECEIVED');
  assert.equal(next.result.templateId, 'ORDER_ADDRESS');
  assert.doesNotMatch(next.sent.map(item => item.text).join('\n'), /đã nhận đơn/);
  assert.deepEqual(inbox.pendingOrder.items.map(item => `${item.quantity} ${item.code}`), ['1 GRA-XANH-Z450']);
  // Đơn POS MỚI (mã khác) cho giỏ mới thì báo nhận, món + tổng theo đơn đó.
  const third = await sim.send(inbox, second.text, { message: second.message, llm: noModel, extra: { findShopOrder: async () => ({ id: 'S54999', total: 189000, phone: PHONE, items: [{ name: shopName, sku: 'GRA-XANH-Z450', quantity: 1 }] }) } });
  assert.equal(third.result.templateId, 'SHOP_ORDER_RECEIVED');
  assert.match(third.sent[0].text, /1 Granola Túi Xanh 450g – tổng 189\.000đ/);
  assert.equal(inbox.shopOrderAck.id, 'S54999');
});

test('chờ kiểm đơn Shop: gửi NGAY tin ghi nhận giỏ rồi mới chờ; có đơn → chỉ báo đã nhận (không có cặp "xin SĐT" rồi "không cần gửi lại")', async () => {
  const { sim, inbox } = shopSim({ shopOrderWaitMs: 40 });
  const cart = cartMessage('CB2-XANH-Z450', 298000);
  let lookups = 0;
  const findShopOrder = async () => { lookups += 1; return lookups >= 2 ? { id: 'S1', total: 298000, phone: PHONE, items: [{ name: shopName, sku: 'CB2-XANH-Z450', quantity: 1 }] } : null; };
  const turn = await sim.send(inbox, cart.text, { message: cart.message, llm: noModel, extra: { findShopOrder } });
  assert.equal(turn.result.templateId, 'SHOP_ORDER_RECEIVED');
  assert.equal(turn.sent.length, 2);
  assert.match(turn.sent[0].text, /đã nhận giỏ hàng 2 Granola Túi Xanh 450g/);
  assert.match(turn.sent[1].text, /đã nhận đơn 2 Granola Túi Xanh 450g – tổng 298\.000đ/);
  assert.doesNotMatch(turn.sent.map(item => item.text).join('\n'), /cho em xin số điện thoại/);
  assert.equal(inbox.pendingOrder, null, 'đơn đã có trên POS: bỏ giỏ chờ');
});

test('chờ kiểm đơn Shop mà không có đơn: tin ghi nhận → xin SĐT/địa chỉ (không bị coi là lặp); giỏ được giữ từ lúc ghi nhận', async () => {
  const { sim, inbox } = shopSim({ shopOrderWaitMs: 40 });
  const cart = cartMessage('CB-VANGG+NAU', 293000);
  const savedDuringWait = [];
  const turn = await sim.send(inbox, cart.text, { message: cart.message, llm: noModel, extra: { findShopOrder: async () => { savedDuringWait.push(inbox.pendingOrder?.items?.length || 0); return null; } } });
  assert.equal(turn.result.templateId, 'ORDER_ADDRESS', JSON.stringify(turn.result));
  assert.match(turn.sent[0].text, /đã nhận giỏ hàng 1 Granola Túi Vàng 350g \+ 1 Granola Túi Nâu vị cacao 350g/);
  assert.match(turn.sent.slice(1).map(item => item.text).join('\n'), /số điện thoại/);
  assert.ok(savedDuringWait.slice(1).every(count => count === 2), 'giỏ đã lưu trong lúc chờ (khách gửi SĐT lúc này không bị hỏi lại vị)');
  // Không có đường tra đơn Shop (Page không qua Pancake / test thường): không gửi tin ghi nhận, trả lời như cũ.
  const plain = new Sim();
  const plainInbox = plain.inbox();
  const direct = await plain.send(plainInbox, cart.text, { message: cart.message, llm: noModel });
  assert.equal(direct.result.templateId, 'ORDER_ADDRESS');
  assert.doesNotMatch(direct.sent[0].text, /đã nhận giỏ hàng/);
});
