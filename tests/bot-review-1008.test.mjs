// 08/10 — rà nhật ký quyết định 01–07/10 (3.453 lượt): các câu khách thật bị bỏ lọt / bot im lặng.
// Không tên khách, không SĐT thật.
import assert from 'node:assert/strict';
import test from 'node:test';
import { commentBasket } from '../app/chatbot-engine.mjs';
import { isReceivedNotice, ruleIntent } from '../app/processing/rule-intent.mjs';

const inbox = extra => ({ source: 'inbox', botLastTemplateId: '', botLastAgeMin: Infinity, bundleSize: 1, commentBasket, experimentalRules: 'on', candidateRules: 'shadow', ...extra });
const shipped = extra => inbox({ botLastTemplateId: 'SHIPMENT_OUT_FOR_DELIVERY', botLastAgeMin: 600, hasRecentOrder: true, orderAgeMin: 3 * 24 * 60, ...extra });
const tpl = result => result?.value?.template_id || null;

test('khách báo đã nhận hàng → RECEIVED_CHECK (trước đây mô hình chọn THANK_YOU rồi bị chặn, bot im lặng)', () => {
  for (const text of ['Chị nhận rùi e', 'Mình nhận rồi nhé', 'Đã nhận nhé', 'C nhận rồi em', 'Mình nhận được hàng rồi nhé bạn', 'Nay mình đã nhận đc hàng', 'nhận rồi ạ cảm ơn shop']) {
    assert.equal(tpl(ruleIntent(text, shipped())), 'RECEIVED_CHECK', text);
    assert.equal(isReceivedNotice(text), true, text);
  }
  // Bot vừa báo giao (dù đơn không nằm trong hội thoại) cũng tính.
  assert.equal(tpl(ruleIntent('Chị nhận rùi e', inbox({ botLastTemplateId: 'SHIPMENT_OUT_FOR_DELIVERY', botLastAgeMin: 300 }))), 'RECEIVED_CHECK');
});

test('không nhầm báo đã nhận: chưa nhận, hỏi, than, không có đơn', () => {
  assert.equal(ruleIntent('Chị nhận rùi e', inbox()), null, 'không đơn, không báo giao → để mô hình');
  for (const text of ['nhận rồi mà bị mốc', 'Nhận hàng rồi nhưng thiếu quà', 'nhận được chưa em', 'em nhận được tin nhắn rồi', 'chị nhận 2 túi nhé', 'em nhận đơn giúp chị nhé', 'nhận rồi à?']) {
    assert.notEqual(ruleIntent(text, shipped())?.rule, 'RECEIVED_NOTICE', text);
    assert.equal(isReceivedNotice(text), false, text);
  }
  assert.equal(tpl(ruleIntent('chưa nhận được hàng', shipped())), 'ORDER_STATUS');
});

test('mua bên sàn: "rùi" như "rồi"; câu than / hỏi không tính', () => {
  for (const text of ['chốt bên tiktok rùi', 'E chốt bên tiktok rồi c', 'E vua mua ben titok roi']) assert.equal(tpl(ruleIntent(text, inbox())), 'BOUGHT_ON_MARKETPLACE', text);
  for (const text of ['mua bên tiktok rồi mà bị hôi', 'mua bên tiktok được không']) assert.notEqual(tpl(ruleIntent(text, inbox())), 'BOUGHT_ON_MARKETPLACE', text);
});

test('"Giá bán sao" vào luật ổn định (trước chỉ khớp luật ứng viên chạy ẩn → rơi xuống mô hình)', () => {
  const result = ruleIntent('Giá bán sao', inbox());
  assert.equal(result?.rule, 'TERSE_PRICE');
  assert.equal(tpl(result), 'GENERAL_INFO');
});

test('bầu / bảo quản / date / đồng kiểm', () => {
  for (const text of ['bầu ăn được không', 'có bầu dùng được ko', 'Chị đang có bầu ăn dc ko', 'bà bầu ăn được ko']) assert.equal(tpl(ruleIntent(text, inbox())), 'HEALTH_CONDITION', text);
  assert.equal(ruleIntent('Bầu Trời', inbox()), null);
  for (const text of ['bảo quản thế nào', 'mở túi để được bao lâu', 'cách bảo quản granola', 'Sản phẩm có thể để trg ngăn mát tủ lạnh đc kô', 'bỏ tủ lạnh được không', 'để ngăn mát', 'để tủ lạnh được không']) assert.equal(tpl(ruleIntent(text, inbox())), 'STORAGE', text);
  assert.notEqual(tpl(ruleIntent('bảo quản kỹ mà vẫn bị mốc', inbox())), 'STORAGE');
  for (const text of ['date bao lâu em', 'để được bao lâu shop']) assert.equal(tpl(ruleIntent(text, inbox())), 'WEIGHT_EXPIRY', text);
  for (const text of ['có được đồng kiểm không', 'được kiểm tra trước khi nhận không', 'cho xem hàng trước khi thanh toán ko']) assert.equal(tpl(ruleIntent(text, inbox())), 'INSPECTION_RETURN_POLICY', text);
  for (const text of ['shipper không cho kiểm tra hàng', 'ship ko cho đồng kiểm']) assert.notEqual(tpl(ruleIntent(text, inbox())), 'INSPECTION_RETURN_POLICY', text);
});

test('chuẩn hóa gõ tắt số lượng 2b / 2t', () => {
  const result = ruleIntent('2b xanh', inbox());
  assert.equal(result?.value?.template_id, 'ORDER_ADDRESS');
  assert.equal(result?.value?.No_A, '2');
});
