import assert from 'node:assert/strict';
import test from 'node:test';
import { ADDRESS_WORDS, askedSlotOf, countBags, countColours, featuresOf, normalizeIntentText } from '../app/processing/intent-features.mjs';

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
