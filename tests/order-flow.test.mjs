import assert from 'node:assert/strict';
import test from 'node:test';
import { orderFlowStep } from '../app/processing/order-flow.mjs';
import { ruleIntent } from '../app/processing/rule-intent.mjs';

const ctx = { hasBasket: true, lastWasOrderStep: true, source: 'inbox' };

test('luồng đơn: chỉ SĐT / SĐT + địa chỉ đủ / địa chỉ đủ / "địa chỉ cũ" khi đang xin thông tin và có giỏ → giá trị ORDER_ADDRESS, không hỏi LLM', () => {
  assert.deepEqual(orderFlowStep('0912345678', ctx), { rule: 'PHONE_ONLY', value: { template_id: 'ORDER_ADDRESS', Phone_Number: '0912345678' } });
  assert.equal(orderFlowStep('Sđt của em 0912 345 678 nhé shop', ctx)?.rule, 'PHONE_ONLY');
  assert.deepEqual(orderFlowStep('0912345678 Thôn 4 Hạ Bằng, Thạch Thất, Hà Nội', { ...ctx, addressComplete: true, addressText: 'Thôn 4 Hạ Bằng, Thạch Thất, Hà Nội' }).value, { template_id: 'ORDER_ADDRESS', Phone_Number: '0912345678', Customer_Address: 'Thôn 4 Hạ Bằng, Thạch Thất, Hà Nội' });
  assert.equal(orderFlowStep('Thôn 4 Hạ Bằng, Thạch Thất, Hà Nội', { ...ctx, addressComplete: true, addressText: 'Thôn 4 Hạ Bằng, Thạch Thất, Hà Nội' })?.rule, 'ADDRESS_COMPLETE');
  assert.equal(orderFlowStep('gửi về địa chỉ cũ nhé', ctx)?.rule, 'OLD_ADDRESS');
});

test('luồng đơn: để LLM đọc khi khách nhắc sản phẩm/số lượng/đổi/hủy, đặt câu hỏi, chưa có giỏ, bình luận, hay khiếu nại', () => {
  assert.equal(orderFlowStep('0912345678 lấy 2 túi xanh', ctx), null);
  assert.equal(orderFlowStep('0912345678 huỷ giúp mình', ctx), null);
  assert.equal(orderFlowStep('0912345678 giao mấy ngày?', ctx), null);
  assert.equal(orderFlowStep('0912345678', { ...ctx, hasBasket: false }), null);
  assert.equal(orderFlowStep('0912345678', { ...ctx, lastWasOrderStep: false }), null);
  assert.equal(orderFlowStep('0912345678', { ...ctx, source: 'comment' }), null);
  assert.equal(orderFlowStep('0912345678', { ...ctx, complaint: true }), null);
  assert.equal(orderFlowStep('Xã Vô Tranh, Phú Lương, Thái Nguyên', ctx), null, 'địa chỉ chưa xác định đủ (addressComplete=false) thì không tự quyết');
});

test('luồng đơn đi qua ruleIntent như luật thử nghiệm: shadow mặc định (đính kèm), bật thì trả về', () => {
  const base = { ...ctx, commentBasket: () => [], botLastTemplateId: 'ORDER_ADDRESS' };
  // SĐT trần: luật ổn định PHONE_ONLY (có sẵn) bắt trước; luồng đơn đính kèm ở shadow.
  const bare = ruleIntent('0912345678', base);
  assert.equal(bare?.rule, 'PHONE_ONLY');
  assert.equal(bare?.shadow?.rule, 'PHONE_ONLY');
  // SĐT kèm chữ đệm: chưa có luật ổn định → chỉ chạy ẩn (shadowOnly), bật thì trả về.
  const shadow = ruleIntent('Sđt của em 0912345678 nhé shop', base);
  assert.equal(shadow?.rule, 'PHONE_ONLY');
  assert.equal(shadow?.shadowOnly, true);
  const on = ruleIntent('Sđt của em 0912345678 nhé shop', { ...base, experimentalRules: 'on' });
  assert.deepEqual(on?.value, { template_id: 'ORDER_ADDRESS', Phone_Number: '0912345678' });
});
