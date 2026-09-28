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
  // Vòng 10: địa chỉ chưa đủ cấp vẫn đưa vào bộ soạn đơn (nó hỏi cấp còn thiếu) — xem test bên dưới.
  assert.equal(orderFlowStep('để mình xem lại đã', ctx), null, 'chữ không giống địa chỉ: không tự quyết');
  assert.equal(orderFlowStep('giao về Hà Nội mấy ngày', ctx), null, 'câu hỏi thời gian giao: để mô hình');
  assert.equal(orderFlowStep('ship về Cà Mau được không', ctx), null, 'hỏi có giao tới không: để mô hình');
});

test('vòng 10: địa chỉ CHƯA đủ cấp (SĐT hay không) khi bot đang xin → ORDER_ADDRESS + Customer_Address, bộ soạn đơn hỏi cấp thiếu (CLARIFY)', () => {
  for (const text of ['Xã Vô Tranh, Phú Lương, Thái Nguyên', '270 nguyễn văn cừ thành phố vinh nghệ an phường hưng phúc nhé', 'Huyện Sơn Tịnh', 'Số 17, đường 38, P. Thảo Điền', 'Tổ 10 thị trấn Na Hang', 'Đc 19/1 thanh vị, Sơn Lộc, Sơn Tây, Hà Nội']) {
    const ruled = orderFlowStep(text, ctx);
    assert.equal(ruled?.rule, 'ADDRESS_PARTIAL', text);
    assert.equal(ruled?.value?.template_id, 'ORDER_ADDRESS', text);
    assert.ok(ruled?.value?.Customer_Address && !/^đc\b/i.test(ruled.value.Customer_Address), text);
  }
  const both = orderFlowStep('0912345678 Xóm thống nhất 3 xã vô tranh huyện Phú lương', ctx);
  assert.deepEqual([both?.rule, both?.value?.Phone_Number, both?.value?.Customer_Address], ['PHONE_ADDRESS_PARTIAL', '0912345678', 'Xóm thống nhất 3 xã vô tranh huyện Phú lương']);
  assert.equal(orderFlowStep('Sđt: 0912345678, đ/c: 12 Lê Lợi phường 5', ctx)?.value?.Customer_Address, '12 Lê Lợi phường 5', 'bỏ nhãn "sđt"/"đ/c"');
  // Kèm đổi giỏ / câu hỏi / chưa có giỏ thì vẫn để mô hình.
  assert.equal(orderFlowStep('Huyện Sơn Tịnh, đổi sang 2 túi vàng', ctx), null);
  assert.equal(orderFlowStep('Huyện Sơn Tịnh có giao không?', ctx), null);
  assert.equal(orderFlowStep('Huyện Sơn Tịnh', { ...ctx, hasBasket: false }), null);
  // Qua ruleIntent (luật thử nghiệm bật): giá trị đi thẳng, không cần mô hình.
  const on = ruleIntent('Huyện Sơn Tịnh', { ...ctx, commentBasket: () => [], botLastTemplateId: 'ORDER_ADDRESS', botLastAgeMin: 3, experimentalRules: 'on' });
  assert.deepEqual([on?.rule, on?.value?.template_id, on?.value?.Customer_Address], ['ADDRESS_PARTIAL', 'ORDER_ADDRESS', 'Huyện Sơn Tịnh']);
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

test('vòng 9: "địa chỉ cũ" viết nhiều kiểu (đ/c như cũ, dc đã gửi, địa chỉ vẫn thế, gọi địa chỉ cũ…) → OLD_ADDRESS; không có đơn cũ (hasPreviousDelivery=false) → xin SĐT đã đặt + thẻ', () => {
  for (const text of ['gửi về địa chỉ cũ nhé', 'đ/c như cũ', 'địa chỉ vẫn thế', 'gửi dc cũ', 'đã gửi địa chỉ rồi', 'gọi địa chỉ cũ', 'dc đã gửi', 'địa chỉ nhận như đơn trước', 'gửi địa chỉ trước nha']) {
    assert.equal(orderFlowStep(text, ctx)?.rule, 'OLD_ADDRESS', text);
    assert.deepEqual(orderFlowStep(text, { ...ctx, hasPreviousDelivery: false }), { rule: 'OLD_ADDRESS_ASK', value: { template_id: 'ORDER_ADDRESS_OLD_ASK_PHONE' }, attention: true }, text);
    assert.equal(orderFlowStep(text, { ...ctx, hasPreviousDelivery: true })?.rule, 'OLD_ADDRESS', text);
  }
  // "dc" cũng là "được": "giao dc trước thứ 7" không phải địa chỉ cũ.
  assert.equal(orderFlowStep('giao dc trước thứ 7', ctx), null);
  assert.equal(orderFlowStep('gửi địa chỉ cũ, thêm 1 túi vàng', ctx), null, 'kèm đổi giỏ: để mô hình');
  // Qua ruleIntent (luật thử nghiệm, bật): giá trị + thẻ đi cùng.
  const on = ruleIntent('đ/c như cũ', { ...ctx, commentBasket: () => [], botLastTemplateId: 'ORDER_ADDRESS', experimentalRules: 'on', hasPreviousDelivery: false });
  assert.deepEqual([on?.rule, on?.value?.template_id, on?.attention], ['OLD_ADDRESS_ASK', 'ORDER_ADDRESS_OLD_ASK_PHONE', true]);
});
