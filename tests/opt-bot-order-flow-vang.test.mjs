// Tối ưu chatbot (B2): "Dạ vâng <SĐT>" ở bước xin SĐT/địa chỉ là tin chỉ có SĐT (luật tất định), không phải đổi sang vị Vàng.
import assert from 'node:assert/strict';
import test from 'node:test';
import './helpers/seed-catalog.mjs';
import { orderFlowStep } from '../app/processing/order-flow.mjs';
import { ruleIntent } from '../app/processing/rule-intent.mjs';

const ctx = { hasBasket: true, lastWasOrderStep: true, source: 'inbox', botLastTemplateId: 'ORDER_ADDRESS', botLastAgeMin: 2, experimentalRules: 'on' };

test('B2: "Dạ vâng 0912345678" → PHONE_ONLY như "0912345678"', () => {
  for (const text of ['Dạ vâng 0912345678', 'vâng sđt mình 0912345678 nha', '0912345678']) {
    const step = orderFlowStep(text, ctx);
    assert.equal(step?.rule, 'PHONE_ONLY', text);
    assert.equal(step.value.Phone_Number, '0912345678');
    assert.equal(ruleIntent(text, { ...ctx, addressText: text })?.rule, 'PHONE_ONLY', text);
  }
});

test('B2: tin nhắc vị/giỏ vẫn để luật giỏ/mô hình đọc (null)', () => {
  for (const text of ['0912345678 vàng', '0912345678 lấy 2 túi xanh', 'thêm 1 vang 0912345678', '0912345678 vâng', 'cacao 300g 0912345678', '0912345678 1 vag']) {
    assert.equal(orderFlowStep(text, ctx), null, text);
  }
});
