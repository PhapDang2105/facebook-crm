// 10/10 (chủ shop: "gì code xử lý được thì ưu tiên code, mô hình chỉ hỗ trợ"): các loại tin mô hình lớn đang trả lời mà luật
// làm được, đo trên 3.138 lượt nhật ký quyết định 01–10/10: 78 lượt mới bắt, khớp nhãn 78/78, không đổi/mất lượt cũ nào.
import assert from 'node:assert/strict';
import test from 'node:test';
import { ruleIntent } from '../app/processing/rule-intent.mjs';

const at = (text, ctx = {}) => {
  const ruled = ruleIntent(text, { source: 'inbox', botLastTemplateId: '', botLastAgeMin: 5, ...ctx });
  return ruled ? `${ruled.rule}:${ruled.value?.template_id || ''}` : null;
};

test('cảm ơn các kiểu → THANK_YOU ở mọi ngữ cảnh', () => {
  for (const text of ['Xin cảm ơn', 'c cảm ơn e', 'ok cam on', 'Cám ơn bạn nhiều nhé', 'OK cảm ơn shop rất nhiều!', 'thank you shop']) {
    assert.equal(at(text), 'THANKS:THANK_YOU', text);
  }
  assert.equal(at('Cám ơn nhé, loại này không phù hợp với chị'), null, 'câu dài có ý khác: để mô hình');
});

test('"ok / vâng / dạ" trơn sau tin đơn / trạng thái đơn → THANK_YOU; sau câu hỏi của bot thì không', () => {
  for (const last of ['ORDER_CONFIRMATION', 'ORDER_STATUS', 'ORDER_UPDATED', 'THANK_YOU']) {
    assert.equal(at('Ok', { botLastTemplateId: last, hasRecentOrder: true, orderAgeMin: 300 }), 'ACK_THANKS:THANK_YOU', last);
    assert.equal(at('OK em', { botLastTemplateId: last }), 'ACK_THANKS:THANK_YOU', last);
    assert.equal(at('Vâng ạ', { botLastTemplateId: last }), 'ACK_THANKS:THANK_YOU', last);
  }
  for (const last of ['ORDER_EXISTING_CONFIRM', 'ORDER_ADDRESS', 'PRICE_ONE_BAG', 'ORDER_STATUS_CHECKING']) {
    assert.notEqual(at('Ok', { botLastTemplateId: last }), 'ACK_THANKS:THANK_YOU', last);
  }
  assert.notEqual(at('Ok', { botLastTemplateId: 'ORDER_STATUS', hasBasket: true }), 'ACK_THANKS:THANK_YOU', 'đang giữ giỏ: ok có thể là chốt');
});

test('lời gọi trơn ("Em ơi", "Bạn ơi", "Alo") → WELCOME khi không giữ giỏ / không ở bước đơn', () => {
  for (const text of ['Em oi', 'Bạn ơi.', 'Alo', 'Allo ..', 'Giọt nắng ơi']) assert.equal(at(text), 'GREETING:WELCOME', text);
  assert.equal(at('Alo', { botLastTemplateId: 'ORDER_UNCHANGED', orderAgeMin: 600 }), 'GREETING:WELCOME');
  assert.notEqual(at('Em oi', { botLastTemplateId: 'ORDER_ADDRESS', hasBasket: true, lastWasOrderStep: true, botLastAgeMin: 3 }), 'GREETING:WELCOME');
});

test('hỏi gói nhỏ / chia gói → PACKAGING_INFO; nêu màu hay đang giữ giỏ thì không', () => {
  for (const text of ['Mình có từng gói nhỏ ko shop', 'Loại này có từng gói nhỏ không ạ', 'Có loại túi nhỏ ko bạn']) assert.equal(at(text), 'SMALL_PACK:PACKAGING_INFO', text);
  assert.notEqual(at('màu vàng e có loại từng gói nhỏ ko'), 'SMALL_PACK:PACKAGING_INFO');
  assert.notEqual(at('Bên mình có chia ra từng gói nhỏ ko ạ?', { botLastTemplateId: 'ORDER_ADDRESS', hasBasket: true, lastWasOrderStep: true }), 'SMALL_PACK:PACKAGING_INFO');
});

test('"có giảm không" → DISCOUNT_POLICY, "có giảm cân không" thì không', () => {
  assert.equal(at('Có giảm ko?'), 'DISCOUNT:DISCOUNT_POLICY');
  assert.notEqual(at('có giảm cân không'), 'DISCOUNT:DISCOUNT_POLICY');
});
