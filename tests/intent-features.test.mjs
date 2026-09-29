import assert from 'node:assert/strict';
import test from 'node:test';
import { ADDRESS_WORDS, askedSlotOf, canonicalTemplateId, countBags, countColours, decisionLabelOf, featuresOf, intentRowFromRecord, intentRowOf, isOrderStepContext, labelTemplateId, normalizeIntentText, orderContextOf, prevBotAsksOf } from '../app/processing/intent-features.mjs';
import { intentMatchMark } from '../app/chatbot-engine.mjs';
import { intentMatchMark as reportMatchMark } from '../tools-intent/shadow-report.mjs';

test('askedSlotOf: mã mẫu nói rõ thì theo mã; mẫu điền {missing} thì đọc câu bot; không có gì → rỗng', () => {
  assert.equal(askedSlotOf('Dạ để lên đơn đúng tuyến, chị cho em xin số điện thoại và địa chỉ trước sáp nhập', 'ORDER_ADDRESS'), 'phone_address');
  assert.equal(askedSlotOf('Dạ em đã nhận được SĐT của mình rồi ạ. Chị cho em xin địa chỉ để em lên đơn', 'ORDER_ADDRESS_PARTIAL'), 'address');
  assert.equal(askedSlotOf('Dạ em đã nhận được địa chỉ rồi ạ. Chị cho em xin số điện thoại để em lên đơn', 'ORDER_ADDRESS_PARTIAL'), 'phone');
  assert.equal(askedSlotOf('em ghi nhan dia chi roi, chi gui giup em sdt nha', ''), 'phone', 'không dấu, "sdt"');
  assert.equal(askedSlotOf('Chị muốn lấy vị nào và mỗi vị mấy túi ạ', ''), 'flavor', 'vị trước số lượng');
  assert.equal(askedSlotOf('Chị lấy mấy túi ạ', ''), 'quantity');
  assert.equal(askedSlotOf('2 túi xanh 298k đúng không ạ', ''), 'confirm');
  assert.equal(askedSlotOf('Dạ em đã nhận SĐT và địa chỉ của chị rồi ạ, chị lấy Túi Xanh hay Túi Nâu, mỗi loại mấy túi', 'ORDER_INFO_ASK_FLAVOR'), 'flavor', 'mã thắng chữ "SĐT và địa chỉ" đã nhận');
  assert.equal(askedSlotOf('', 'ASK_FLAVOR'), 'flavor');
  assert.equal(askedSlotOf('', 'ORDER_CONFIRMATION'), 'confirm');
  assert.equal(askedSlotOf('', 'CONFIRM_YES'), 'phone_address');
  assert.equal(askedSlotOf('', 'ORDER_ADDRESS'), 'phone_address', 'không có chữ → mặc định theo họ mẫu');
  assert.equal(askedSlotOf('', 'ORDER_ADDRESS_CLARIFY'), 'address');
  assert.equal(askedSlotOf('Dạ bảng giá bên em ạ', 'GENERAL_INFO'), '');
  assert.equal(askedSlotOf(undefined, undefined), '');
});

test('countBags / countColours / ADDRESS_WORDS', () => {
  assert.equal(countBags('2 túi xanh 1 túi nâu'), 3);
  assert.equal(countBags('hai túi xanh và 1 gói nâu'), 3);
  assert.equal(countBags('giá bao nhiêu'), 0);
  assert.equal(countColours('2 túi xanh 1 nâu và cacao'), 2, 'nâu = cacao');
  assert.equal(countColours('túi vàng'), 1);
  assert.ok(ADDRESS_WORDS.test(normalizeIntentText('12 Nguyễn Trãi phường 5 quận 3')));
  assert.ok(ADDRESS_WORDS.test(normalizeIntentText('ấp 4 xã Bình Mỹ huyện Củ Chi')));
  assert.ok(ADDRESS_WORDS.test(normalizeIntentText('45 đường Lê Lợi')));
  assert.ok(!ADDRESS_WORDS.test(normalizeIntentText('có đường không shop')), '"đường" ăn không phải địa chỉ');
  assert.ok(!ADDRESS_WORDS.test(normalizeIntentText('mình quan tâm túi xanh')), '"quan tam" không phải quận');
});

test('featuresOf: không có ctx v2 → chỉ đặc trưng cũ + đặc trưng suy từ chữ; có ctx v2 → thêm ask/ctx:order/giao', () => {
  const plain = featuresOf({ text: 'Túi xanh giá sao', source: 'inbox', lastTemplate: 'WELCOME' });
  assert.ok(plain.has('w:xanh') && plain.has('has:colour') && plain.has('last:WELCOME') && plain.has('src:inbox'), 'đặc trưng cũ giữ nguyên');
  assert.ok(plain.has('bag:0') && plain.has('colours:1'), 'đếm túi/màu suy từ chữ');
  assert.ok(![...plain].some(feature => /^(ask:|ctx:order|x:ask:|x:order\||x:basket\|)/.test(feature)), 'thiếu trường → không phát sinh đặc trưng ctx v2');
  assert.ok(!plain.has('has:addr'));

  const rich = featuresOf({ text: '2 túi xanh 1 túi nâu, 0909123456, 12 Nguyễn Trãi phường 5 quận 3', source: 'inbox', lastTemplate: 'ORDER_ADDRESS', lastWasOrderStep: true, hasBasket: true, prevBotAsks: 'phone_address', hasOrder: true, orderAgeMin: 30 });
  for (const feature of ['has:sdt', 'has:addr', 'bag:3', 'colours:2+', 'ctx:order', 'ctx:order<60m', 'ask:phone_address', 'x:ask:phone_address|has:sdt', 'x:ask:phone_address|has:addr', 'x:basket|bag:3', 'x:order|2', 'x:order|tui', 'ctx:basket', 'x:orderstep|sdt']) assert.ok(rich.has(feature), feature);
  assert.ok(![...rich].some(feature => feature.startsWith('x:order|') && feature.split('|')[1] === 'nguyen'), 'x:order chỉ giao 5 từ đầu');

  // prevBotAsks thiếu nhưng có prevBot → suy bằng askedSlotOf; phoneInText/addressInText/bagCount đưa vào thì ưu tiên.
  const derived = featuresOf({ text: 'ok', prevBot: 'Chị cho em xin số điện thoại để em lên đơn', lastTemplate: 'ORDER_ADDRESS_PARTIAL', phoneInText: '0909123456', addressInText: true, bagCount: 5 });
  assert.ok(derived.has('ask:phone') && derived.has('has:sdt') && derived.has('has:addr') && derived.has('bag:4+') && derived.has('x:ask:phone|has:sdt'));

  // Đơn cũ: orderAgeMin null (JSON không ghi Infinity) hay quá 60 phút → có ctx:order nhưng không "<60m".
  const oldOrder = featuresOf({ text: 'đơn em sao rồi', hasOrder: true, orderAgeMin: null });
  assert.ok(oldOrder.has('ctx:order') && !oldOrder.has('ctx:order<60m'));
  assert.ok(!featuresOf({ text: 'đơn em sao rồi', hasOrder: true, orderAgeMin: 600 }).has('ctx:order<60m'));
  assert.ok(!featuresOf({ text: 'đơn em sao rồi', hasOrder: false, orderAgeMin: 5 }).has('ctx:order'));
});

test('normalizeIntentText: che như nhật ký (maskPersonal) — SĐT/email/dãy số dài; giá "1.250.000" KHÔNG là <sdt>', () => {
  assert.equal(normalizeIntentText('tổng 1.250.000đ nha'), 'tong 1 250 000d nha');
  assert.ok(!normalizeIntentText('giá 174.000đ, 2 túi 348k').includes('<sdt>'));
  assert.equal(normalizeIntentText('gọi 0912 345 678 nhé'), 'goi <sdt> nhe');
  assert.equal(normalizeIntentText('mail a.b@gmail.com stk 123456789012'), 'mail <email> stk <so>');
  assert.equal(normalizeIntentText('<sdt>'), '<sdt>', 'chữ đã che giữ nguyên token');
  assert.equal(countBags('túi xanh x2 túi vàng x 1'), 3, 'số sau túi (như engine bagCountInText)');
  assert.equal(countBags('lấy combo 3'), 3);
  assert.equal(countBags('combo 3 túi'), 3, 'không đếm đôi');
});

test('canonicalTemplateId / isOrderStepContext / labelTemplateId: mã con → mã engine lưu; bước đơn như engine', () => {
  for (const id of ['ORDER_ADDRESS_PARTIAL', 'ORDER_ADDRESS_CLARIFY', 'ORDER_ADDRESS_CHOOSE', 'ORDER_CART_LINE', 'UPSELL_TWO_BAGS', 'ORDER_ADDRESS_REMIND']) assert.equal(canonicalTemplateId(id), 'ORDER_ADDRESS', id);
  assert.deepEqual([canonicalTemplateId('ORDER_UPDATED'), canonicalTemplateId('ORDER_CANCELLED'), canonicalTemplateId('PRICE_QUOTE'), canonicalTemplateId('')], ['ORDER_UPDATE', 'ORDER_CANCEL', 'PRICE_QUOTE', '']);
  for (const id of ['ORDER_ADDRESS', 'ORDER_PHONE', 'ORDER_CONFIRMATION', 'ORDER_UPDATE', 'ORDER_UPDATED', 'ASK_FLAVOR', 'ORDER_ADDRESS_REMIND', 'ORDER_CUSTOM_BASKET', 'ORDER_CART_LINE']) assert.ok(isOrderStepContext(id), id);
  for (const id of ['PRICE_QUOTE', 'GENERAL_INFO', 'ORDER_INFO_ASK_FLAVOR', 'ASK_PRODUCT', '']) assert.ok(!isOrderStepContext(id), id);
  assert.deepEqual([labelTemplateId('ORDER_UPDATE'), labelTemplateId('ORDER_CANCEL'), labelTemplateId('ORDER_NOTE'), labelTemplateId('GENERAL_INFO')], ['ORDER_UPDATED', 'ORDER_CANCELLED', 'ORDER_NOTE_ADDED', 'GENERAL_INFO']);
});

test('prevBotAsksOf: mã + giỏ như engine.prevBotAsks, không biết giỏ thì đọc chữ câu bot', () => {
  const pending = extra => ({ key: 'k', at: Date.now(), items: [{ product: 'Granola Túi Xanh 450g', quantity: 2 }], ...extra });
  assert.equal(prevBotAsksOf({ lastTemplateId: 'ORDER_ADDRESS', pendingOrder: pending() }), 'phone_address');
  assert.equal(prevBotAsksOf({ lastTemplateId: 'ORDER_ADDRESS', pendingOrder: pending({ phone: '0912345678' }) }), 'address');
  assert.equal(prevBotAsksOf({ lastTemplateId: 'ORDER_ADDRESS', pendingOrder: pending({ address: '12 Lê Lợi' }) }), 'phone');
  assert.equal(prevBotAsksOf({ lastTemplateId: 'ORDER_ADDRESS', pendingOrder: null }), 'phone_address', 'biết là không có giỏ → như engine');
  assert.equal(prevBotAsksOf({ lastTemplateId: 'ORDER_ADDRESS_PARTIAL', prevBotText: 'Dạ em đã nhận SĐT rồi ạ, chị cho em xin địa chỉ để lên đơn' }), 'address', 'ngoại tuyến: đọc {missing}');
  assert.equal(prevBotAsksOf({ lastTemplateId: 'ORDER_ADDRESS' }), 'phone_address');
  assert.equal(prevBotAsksOf({ lastTemplateId: 'ORDER_INFO_ASK_FLAVOR' }), 'flavor');
  assert.equal(prevBotAsksOf({ lastTemplateId: 'ORDER_ADDRESS_OLD_ASK_PHONE' }), 'phone');
  assert.equal(prevBotAsksOf({ lastTemplateId: 'ORDER_CONFIRMATION' }), 'confirm', 'engine rỗng → askedSlotOf theo mã');
  assert.equal(prevBotAsksOf({ lastTemplateId: '', prevBotText: 'Chị lấy mấy túi ạ' }), 'quantity', 'câu nhân viên: đọc chữ');
  assert.equal(prevBotAsksOf({ lastTemplateId: 'GENERAL_INFO', prevBotText: 'Dạ bảng giá bên em ạ' }), '');
});

test('orderContextOf / intentRowOf: MỘT định nghĩa row (đơn chưa hủy < 24 giờ, giỏ còn hạn, mã con quy về mã engine)', () => {
  const now = 1_800_000_000_000;
  const minute = 60_000;
  assert.deepEqual(orderContextOf([{ createdAt: now - 30 * minute }], now), { hasOrder: true, orderAgeMin: 30 });
  assert.deepEqual(orderContextOf([{ createdAt: now - 30 * minute, processingStatus: 'cancelled' }], now), { hasOrder: false, orderAgeMin: null }, 'đơn hủy không tính');
  assert.deepEqual(orderContextOf([{ createdAt: now - 25 * 60 * minute }], now), { hasOrder: false, orderAgeMin: 1500 }, 'quá 24 giờ: không hasOrder (vẫn biết tuổi)');
  assert.deepEqual(orderContextOf([{ createdAt: now + minute }], now), { hasOrder: false, orderAgeMin: null }, 'đơn đặt SAU tin không tính');
  // Engine: có pendingOrder + orders thật.
  const engineRow = intentRowOf({ text: '0912 345 678 12 Nguyễn Trãi phường 5 quận 3', lastTemplateId: 'ORDER_ADDRESS', pendingOrder: { key: 'k', at: now - 10 * minute, items: [{ product: 'Granola Túi Xanh 450g', quantity: 2 }] }, orders: [{ createdAt: now - 3 * 24 * 60 * minute }], now, source: 'inbox', phoneInText: '0912345678' });
  assert.deepEqual(engineRow, { text: '0912 345 678 12 Nguyễn Trãi phường 5 quận 3', source: 'inbox', lastTemplate: 'ORDER_ADDRESS', lastWasOrderStep: true, hasBasket: true, livestream: false, hasOrder: false, orderAgeMin: 4320, prevBotAsks: 'phone_address', phoneInText: true, addressInText: true, bagCount: 0 });
  assert.equal(intentRowOf({ text: 'ok', lastTemplateId: 'ORDER_ADDRESS', pendingOrder: { key: 'k', at: now - 3 * 60 * minute, items: [{ product: 'X', quantity: 1 }] }, now }).hasBasket, false, 'giỏ quá 2 giờ hết hạn');
  // Ngoại tuyến: mã con, hasBasket/hasOrder đưa vào; hasOrder chỉ khi < 24 giờ.
  const offline = intentRowOf({ text: '<sdt>', lastTemplateId: 'ORDER_CART_LINE', prevBotText: 'Dạ đơn của chị gồm 2 túi xanh, chị cho em xin số điện thoại và địa chỉ', hasBasket: true, hasOrder: true, orderAgeMin: 2000, now });
  assert.deepEqual([offline.lastTemplate, offline.lastWasOrderStep, offline.hasBasket, offline.hasOrder, offline.prevBotAsks, offline.phoneInText], ['ORDER_ADDRESS', true, true, false, 'phone_address', true]);
  assert.equal(intentRowOf({ text: 'x', prevBotAsks: 'address', lastTemplateId: 'ORDER_ADDRESS' }).prevBotAsks, 'address', 'giá trị engine đã tính (nhật ký) được giữ');
  // Dòng dataset v1 (mã con, lastWasOrderStep cũ sai, không prevBotAsks) → như lúc chạy; idempotent.
  const record = { id: 'r', label: 'ORDER_CONFIRMATION', labelSource: 'llm', weak: true, text: '<sdt>', prevBot: 'Dạ em đã nhận địa chỉ, chị cho em xin số điện thoại nha', lastTemplate: 'ORDER_ADDRESS_PARTIAL', lastWasOrderStep: false, hasBasket: true, hasOrder: true, orderAgeMin: 5000, at: now };
  const fixed = intentRowFromRecord(record);
  assert.deepEqual([fixed.label, fixed.weak, fixed.lastTemplate, fixed.lastWasOrderStep, fixed.prevBotAsks, fixed.hasOrder, fixed.orderAgeMin], ['ORDER_CONFIRMATION', true, 'ORDER_ADDRESS', true, 'phone', false, 5000]);
  assert.deepEqual(intentRowFromRecord(fixed), fixed, 'idempotent');
  assert.deepEqual([...featuresOf(fixed)].sort(), [...featuresOf(intentRowOf({ text: '<sdt>', lastTemplateId: 'ORDER_ADDRESS', prevBotText: record.prevBot, hasBasket: true, hasOrder: true, orderAgeMin: 5000, now }))].sort(), 'đặc trưng dữ liệu = đặc trưng lúc chạy');
});

test('decisionLabelOf / intentMatchMark (vòng 13): mẫu con ORDER_ADDRESS do bộ soạn chọn là cùng một quyết định', () => {
  for (const id of ['ORDER_ADDRESS_PARTIAL', 'ORDER_ADDRESS_CLARIFY', 'ORDER_ADDRESS_CHOOSE', 'ORDER_CART_LINE', 'UPSELL_TWO_BAGS', 'ORDER_ADDRESS_REMIND']) assert.equal(decisionLabelOf(id), 'ORDER_ADDRESS', id);
  for (const id of ['ORDER_ADDRESS', 'ORDER_CONFIRMATION', 'ASK_FLAVOR', 'ORDER_UPDATED', 'PRICE_QUOTE', '']) assert.equal(decisionLabelOf(id), id, 'mẫu khác giữ nguyên');
  for (const mark of [intentMatchMark, reportMatchMark]) {
    assert.equal(mark('ORDER_ADDRESS', 'ORDER_ADDRESS_PARTIAL'), '✓', 'engine và shadow-report cùng quy ước');
    assert.equal(mark('ORDER_CART_LINE', 'ORDER_ADDRESS_REMIND'), '✓');
    assert.equal(mark('ORDER_ADDRESS', 'ORDER_CONFIRMATION'), '✗');
    assert.equal(mark('PRICE_QUOTE', 'REPLY_ALREADY_SENT'), '~');
  }
});

test('featuresOf ô điền (vòng 13): bot xin gì × SĐT/địa chỉ trong tin × có giỏ — tách chỉ SĐT, đủ cả hai, chưa có món', () => {
  const base = { source: 'inbox', lastTemplate: 'ORDER_ADDRESS', lastWasOrderStep: true, prevBotAsks: 'phone_address' };
  assert.ok(featuresOf({ ...base, text: '<sdt>', hasBasket: true }).has('slot:phone_address|p|b'));
  assert.ok(featuresOf({ ...base, text: '<sdt> 12 lê lợi phường 5 quận 3', hasBasket: true }).has('slot:phone_address|pa|b'));
  assert.ok(featuresOf({ source: 'inbox', lastTemplate: 'PRICE_QUOTE', text: '<sdt> 12 lê lợi phường 5 quận 3', hasBasket: false }).has('slot:none|pa|nb'), 'SĐT/địa chỉ khi chưa có món');
  assert.ok(![...featuresOf({ source: 'inbox', text: 'giá bao nhiêu' })].some(feature => feature.startsWith('slot:')), 'không SĐT/địa chỉ → không có ô điền');
  assert.ok(featuresOf({ source: 'inbox', text: '2 túi xanh', hasBasket: false }).has('x:bags|colour|nb'));
});
