// Vòng 13 (02/10) — hồi quy luồng dùng thử (trial-flow.mjs) và luồng đơn / làm sạch địa chỉ (order-flow.mjs).
// Câu khách nguyên văn từ hội thoại 30/09–02/10 (out-inbox1/2/3, out-models); SĐT giả, không tên khách thật.
import assert from 'node:assert/strict';
import test from 'node:test';
import './helpers/seed-catalog.mjs';
import { commentBasket } from '../app/chatbot-engine.mjs';
import { cleanAddressText, looksLikeAddressMessage, maskPlaceGia, orderFlowStep } from '../app/processing/order-flow.mjs';
import { ruleIntent } from '../app/processing/rule-intent.mjs';
import { trialStep } from '../app/processing/trial-flow.mjs';
import { houseNumbersOf, lostHouseNumbers } from '../app/processing/locations.mjs';

const offered = { freeShipping: true, stage: 'offered', until: Date.now() + 86400000 };
const chosen = { freeShipping: true, stage: 'chosen', bag: 'Granola Túi Xanh 450g', until: Date.now() + 86400000 };
const outcome = step => (step.exit ? `exit:${step.exit}` : step.delegate ? 'delegate' : step.value.template_id);

test('r13 #1 [nghiêm trọng]: địa chỉ có "Gia…/Tổng…" không còn ra TRIAL_PRICE — nhờ luồng đơn đọc địa chỉ', () => {
  for (const text of [
    'Thôn phong lâm xã hoàng diệu huyện gia Lộc tỉnh Hải Dương',
    'To 3 phuong tay son tppleiku tinh gia lai',
    '22 Nguyễn Tất Thành, phường Diên Hồng, Pleiku, Gia Lai',
    'ngõ 3 Gia Lâm Hà Nội',
    'Tổng 2 thôn Đông xã Vĩnh An huyện Sơn Động Bắc Giang',
    '0912345678 Thôn phú lộc xã gia ninh huyện quảng ninh tỉnh quảng bình',
    '15/32 lô C chung cư Miếu Nổi, P.Gia Định, TPHCM',
    'km 5 quốc lộ 14, xã Hoà Thuận, Buôn Ma Thuột'
  ]) {
    for (const trial of [offered, chosen]) assert.equal(outcome(trialStep({ text, trial, lastTemplateId: trial === chosen ? 'ORDER_ADDRESS' : '' })), 'delegate', text);
  }
  // Bước đơn: chỉ ghi tỉnh có chữ "Gia" cũng là địa chỉ.
  assert.equal(outcome(trialStep({ text: 'Gia Lai', trial: chosen, lastTemplateId: 'ORDER_ADDRESS' })), 'delegate');
  // Giỏ 2 túi + địa chỉ Gia Lâm: đúng combo 2, không phải hỏi giá.
  assert.equal(outcome(trialStep({ text: 'Ship cho c 1 túi xanh và 1 túi vàng. 0912345678 HA02-17- Vinhomes Ocean Park - Gia Lâm - Hà Nội.', trial: offered })), 'exit:combo2');
  // "Hoà Vang" không phải Túi Vàng.
  const hoaVang = trialStep({ text: '102 kha vạn cân, hoà châu, hoà vang, đà nẵng\n0912345678', trial: chosen, lastTemplateId: 'ORDER_ADDRESS' });
  assert.deepEqual([hoaVang.delegate, hoaVang.patch], [true, undefined], 'không đổi túi đã chọn sang Vàng');
  // Hỏi giá thật vẫn là TRIAL_PRICE.
  for (const text of ['giá sao em', 'Xin gia', 'Tui xanh gia bn', 'có giảm giá không', 'tổng bao nhiêu em', 'ship về xã Hoà Thuận Gia Lai giá bao nhiêu', 'gửi về Gia Lai bn tiền']) {
    assert.equal(outcome(trialStep({ text, trial: offered })), 'TRIAL_PRICE', text);
  }
});

test('r13 #1: maskPlaceGia / looksLikeAddressMessage', () => {
  assert.equal(maskPlaceGia('huyện gia Lộc'), 'huyện gja Lộc');
  assert.equal(maskPlaceGia('tinh gia lai'), 'tinh gja lai');
  assert.equal(maskPlaceGia('xin gia'), 'xin gia', '"gia" trơ trọi vẫn là hỏi giá');
  assert.equal(maskPlaceGia('giá bao nhiêu'), 'giá bao nhiêu');
  assert.equal(looksLikeAddressMessage('Thôn phong lâm xã hoàng diệu huyện gia Lộc tỉnh Hải Dương'), true);
  assert.equal(looksLikeAddressMessage('ngõ 3 Gia Lâm Hà Nội'), true);
  assert.equal(looksLikeAddressMessage('Gia Lai'), false, 'chỉ tên tỉnh: chưa đủ (trừ khi đang ở bước đơn)');
  assert.equal(looksLikeAddressMessage('Gia Lai', { orderStep: true }), true);
  for (const text of ['ship về Đà Nẵng bao nhiêu', 'xã Hoà Thuận giá bao nhiêu', 'có giao về huyện Gia Lộc không', 'Thôn 5 xã A được không?', 'C đặt trên messenger đc áp dụng k e']) assert.equal(looksLikeAddressMessage(text), false, text);
});

test('r13 #1: luồng đơn tất định nhận địa chỉ có "Gia …" (trước đây chữ "gia" bị coi là hỏi giá)', () => {
  const step = { hasBasket: true, lastWasOrderStep: true, source: 'inbox' };
  assert.equal(orderFlowStep('To 3 phuong tay son tppleiku tinh gia lai', step)?.rule, 'ADDRESS_PARTIAL');
  assert.equal(orderFlowStep('0912345678 Thôn phú lộc xã gia ninh huyện quảng ninh tỉnh quảng bình', step)?.rule, 'PHONE_ADDRESS_PARTIAL');
  assert.equal(orderFlowStep('giá bao nhiêu em', step), null);
  assert.equal(orderFlowStep('xã Hoà Thuận giá ship bao nhiêu', step), null);
});

test('r13 (models A4): "2ca cao,<sđt>,79xom hạ…" khi đang giữ giỏ 1 Nâu → giỏ 2 Nâu + địa chỉ sạch, không còn "2ca cao" trong địa chỉ', () => {
  const text = '2ca cao,0912345678,79xom hạ Vĩnh Thái nha trang khánh hòa';
  const step = { hasBasket: true, lastWasOrderStep: true, source: 'inbox' };
  assert.equal(orderFlowStep(text, step), null, 'luồng SĐT/địa chỉ không nhận tin mang giỏ');
  assert.equal(orderFlowStep('2 t ap 4 hoa binh xuyen moc ba ria vung tau 0912345678', step), null, '"2 t" = 2 túi: để mô hình đọc số lượng');
  const ruled = ruleIntent(text, { source: 'inbox', botLastTemplateId: 'ORDER_ADDRESS', botLastAgeMin: 3, hasBasket: true, lastWasOrderStep: true, bundleSize: 1, commentBasket, experimentalRules: 'on', hasPreviousDelivery: false });
  assert.deepEqual([ruled.rule, ruled.value.template_id, ruled.value.Product_N1, ruled.value.No_A, ruled.value.Phone_Number, ruled.value.Customer_Address],
    ['BASKET_ADDRESS', 'ORDER_ADDRESS', 'Granola Túi Nâu vị cacao 350g', '2', '0912345678', '79xom hạ Vĩnh Thái nha trang khánh hòa']);
  // Tin chỉ có SĐT + địa chỉ vẫn đi luồng tất định như cũ.
  assert.equal(orderFlowStep('0912345678 79 xóm hạ Vĩnh Thái nha trang khánh hòa', step)?.rule, 'PHONE_ADDRESS_PARTIAL');
});

test('r13 #10: cleanAddressText cắt đuôi câu hỏi / giỏ / cảm ơn, tiền tố "vui lòng giao đến", "về,", cụm giỏ đầu, nhãn S₫t, ngoặc mồ côi, tên trước mốc', () => {
  const cases = [
    ['Thôn Mặn. Vĩnh An. Sơn động Bắc Giang có tặng quà phải k bạn', 'Thôn Mặn. Vĩnh An. Sơn động Bắc Giang'],
    ['ship ve 19A huỳnh đình Hai, p14, Bình Thạnh 0912345678 Ngân Combo 2 tui', '19A huỳnh đình Hai, p14, Bình Thạnh Ngân'],
    ['Vui lòng giao đến địa chỉ 275/97/14 Quang Trung, p10, Gò Vấp, TPHCM 0912345678. Cảm ơn!', '275/97/14 Quang Trung, p10, Gò Vấp, TPHCM'],
    ['về, 12 Lê Lợi, phường Bến Nghé, Quận 1', '12 Lê Lợi, phường Bến Nghé, Quận 1'],
    ['về 83 hải phòng, phường Thạch Thang, Đà Nẵng', '83 hải phòng, phường Thạch Thang, Đà Nẵng'],
    ['12 Lê Lợi, P. Bến Nghé, Q1, HCM thanks shop', '12 Lê Lợi, P. Bến Nghé, Q1, HCM'],
    ['Vinhomes Grand Park, Thủ Đức cảm ơn em nhiều nha', 'Vinhomes Grand Park, Thủ Đức'],
    ['2ca cao,0912345678,79xom hạ Vĩnh Thái nha trang khánh hòa', '79xom hạ Vĩnh Thái nha trang khánh hòa'],
    ['2 t ap 4 hoa binh xuyen moc ba ria vung tau 0912345678', 'ap 4 hoa binh xuyen moc ba ria vung tau'],
    ['2 túi xanh 12 Lê Lợi, phường Bến Nghé, Quận 1', '12 Lê Lợi, phường Bến Nghé, Quận 1'],
    ['1 xanh, 1 vàng nhé\n114 Hào Nam, phường Ô Chợ Dừa, HN\n0912345678', '114 Hào Nam, phường Ô Chợ Dừa, HN'],
    ['Số 44 ngõ 11 thanh lân Vĩnh Hưng hn\n0912345678\nCho mình 2 túi', 'Số 44 ngõ 11 thanh lân Vĩnh Hưng hn'],
    ['S₫t.0912345678 chợ củ tinh Biên ang giang', 'chợ củ tinh Biên ang giang'],
    ['số 5 ngõ 2 (gần chợ, Hà Đông, Hà Nội', 'số 5 ngõ 2 gần chợ, Hà Đông, Hà Nội'],
    ['Tâm đinh trường mầm non kiệt sơn tân sơn phú thọ', 'trường mầm non kiệt sơn tân sơn phú thọ']
  ];
  for (const [raw, expected] of cases) assert.equal(cleanAddressText(raw), expected, raw);
});

test('r13 (basket): đuôi "… nhé b" / "nha shop ạ" / "nhé bạn" sau địa chỉ bị cắt; "Khu B", "lô C" giữ nguyên', () => {
  assert.equal(cleanAddressText('12 Lê Lợi, phường Bến Nghé, Quận 1 nhé b'), '12 Lê Lợi, phường Bến Nghé, Quận 1');
  assert.equal(cleanAddressText('12 Lê Lợi, phường Bến Nghé, Quận 1 nha shop ạ'), '12 Lê Lợi, phường Bến Nghé, Quận 1');
  assert.equal(cleanAddressText('Thôn 4 Hạ Bằng, Thạch Thất, Hà Nội nhé bạn'), 'Thôn 4 Hạ Bằng, Thạch Thất, Hà Nội');
  assert.equal(cleanAddressText('tổ 5 khu phố 3, Biên Hoà nha c'), 'tổ 5 khu phố 3, Biên Hoà');
  assert.equal(cleanAddressText('Khu B, lô C'), 'Khu B, lô C');
  assert.equal(cleanAddressText('79 xóm hạ Vĩnh Thái nha trang khánh hòa'), '79 xóm hạ Vĩnh Thái nha trang khánh hòa', '"Nha Trang" không phải chữ đệm');
});

test('r13 (basket): giỏ chờ giữ giftSwap ([] hợp lệ), askedBagCount, livestream, postponed khi chuẩn hoá', async () => {
  const { normalizePendingOrder, usablePendingOrder } = await import('../app/processing/pending-order.mjs');
  const items = [{ product: 'Granola Túi Xanh 450g', code: 'GRA-XANH-Z450', quantity: 2 }];
  const swap = [{ id: 'xanh', label: 'Xanh', name: 'Gói nhỏ Xanh', sku: 'G-XANH', weight: 35, extra: 'x' }, 'cam'];
  const full = normalizePendingOrder({ items, key: 'k', at: Date.now(), giftSwap: swap, askedBagCount: 2, livestream: true, postponed: true });
  assert.deepEqual(full.giftSwap, [{ id: 'xanh', label: 'Xanh', name: 'Gói nhỏ Xanh', sku: 'G-XANH', weight: 35 }, 'cam']);
  assert.deepEqual([full.askedBagCount, full.livestream, full.postponed], [2, true, true]);
  assert.deepEqual(normalizePendingOrder({ items, at: Date.now(), giftSwap: [] }).giftSwap, [], '[] = xin đổi quà, chưa nêu vị');
  assert.deepEqual(normalizePendingOrder({ items, at: Date.now(), giftSwap: true }).giftSwap, []);
  const plain = normalizePendingOrder({ items, at: Date.now() });
  assert.deepEqual(['giftSwap' in plain, 'livestream' in plain, 'postponed' in plain], [false, false, false], 'không có thì không thêm trường');
  assert.equal('livestream' in normalizePendingOrder({ items, at: Date.now(), livestream: 'yes' }), false, 'chỉ nhận đúng true');
  const usable = usablePendingOrder({ items, at: Date.now(), giftSwap: [], livestream: true }, { templateId: 'ORDER_ADDRESS' });
  assert.deepEqual([usable.giftSwap, usable.livestream], [[], true]);
});

test('r13 (basket): normalizeColourTypos gộp "vangd/naau/câco/cá cao"; "vâng" ≠ Vàng, "nấu" ≠ Nâu, "ca cao 300g" là Tropical', async () => {
  const { normalizeColourTypos } = await import('../app/processing/rule-intent.mjs');
  const inbox = { source: 'inbox', botLastTemplateId: '', botLastAgeMin: 5, bundleSize: 1, commentBasket, experimentalRules: 'on' };
  assert.equal(normalizeColourTypos('1 xanh\n1 vangd'), '1 xanh\n1 vàng');
  assert.equal(normalizeColourTypos('lấy 2 naau'), 'lấy 2 nâu');
  assert.equal(normalizeColourTypos('2 câco'), '2 cacao');
  assert.equal(normalizeColourTypos('1 túi cá cao'), '1 túi cacao');
  assert.ok(!/v[aàâ]ng/iu.test(normalizeColourTypos('Dạ vâng, lấy 2 túi xanh')), '"vâng" không còn là chữ đếm thành Vàng');
  assert.ok(!/n[aâấ]u/iu.test(normalizeColourTypos('mua về nấu sữa hạt')), '"nấu" không còn là chữ đếm thành Nâu');
  assert.equal(normalizeColourTypos('lấy 1 túi ca cao 300g'), 'lấy 1 túi tropical');
  assert.equal(normalizeColourTypos('túi cacao 350g'), 'túi cacao 350g', 'Túi Nâu 350g giữ nguyên');
  // Luật: "vâng lấy 2 túi xanh" là 2 Xanh (trước đây 1 Vàng + 1 Xanh); "vâng" trơ trọi không còn ra bảng giá Túi Vàng.
  const two = ruleIntent('vâng lấy 2 túi xanh', inbox);
  assert.deepEqual([two.rule, two.value.Product_N1, two.value.No_A, two.value.Product_N2], ['BASKET', 'Granola Túi Xanh 450g', '2', undefined]);
  assert.notEqual(ruleIntent('vâng', inbox)?.value?.Product_N1, 'Granola Túi Vàng 350g');
  assert.equal(ruleIntent('vâng ạ', { ...inbox, hasBasket: true, lastWasOrderStep: true, botLastTemplateId: 'ORDER_ADDRESS' })?.rule, 'OK_STEP', '"vâng" vẫn là lời đồng ý');
  assert.equal(ruleIntent('dạ vâng', { ...inbox, hasBasket: true, lastWasOrderStep: true, botLastTemplateId: 'ORDER_ADDRESS' })?.rule, 'OK_STEP');
  const typo = ruleIntent('1 xanh\n1 vangd', inbox);
  assert.deepEqual([typo.rule, typo.value.Product_N1, typo.value.Product_N2], ['BASKET', 'Granola Túi Xanh 450g', 'Granola Túi Vàng 350g']);
  const tropical = ruleIntent('lấy 1 túi ca cao 300g', inbox);
  assert.equal(tropical.value.Product_N1, 'Granola Tropical vị Cacao 300g', '"ca cao 300g" không phải Túi Nâu');
  assert.equal(ruleIntent('lấy 2 naau', inbox).value.Product_N1, 'Granola Túi Nâu vị cacao 350g');
  // "Túi vâng" ngay sau khi bot hỏi vị: gõ nhầm dấu của "vàng" (đứng sau chữ túi) → vẫn là Túi Vàng.
  assert.equal(normalizeColourTypos('Túi vâng'), 'Túi vàng');
  assert.equal(ruleIntent('Túi vâng', { ...inbox, botLastTemplateId: 'ASK_FLAVOR' })?.value?.Product_N1, 'Granola Túi Vàng 350g');
  // Giỏ có Tropical ghi "ca cao 300g" vẫn lên đủ hai món.
  const mixed = ruleIntent('Mình lấy 1 xanh 1 ca cao 300g', inbox);
  assert.deepEqual([mixed.rule, mixed.value.Product_N1, mixed.value.Product_N2], ['BASKET', 'Granola Túi Xanh 450g', 'Granola Tropical vị Cacao 300g']);
});

test('r13 #10: không mất số nhà, không cắt nhầm địa chỉ thật', () => {
  const keep = [
    '2 Trần Phú, phường 4, Đà Lạt',
    '2T Trần Phú, phường 4, Đà Lạt',
    '5 Vàng Danh, Uông Bí, Quảng Ninh',
    '12 tổ 2 ấp 4, xã Hoà Bình, Xuyên Mộc',
    'số 5 đường Vành Đai 2, Hà Nội',
    'Sau trường tiểu học Kim Đồng, xã Ea Kao',
    'Tân Bình trường tiểu học Lê Văn Sĩ, phường 1',
    'Gần chợ Có, xã Trung Sơn, Bắc Giang',
    'số 9 (ngõ 12) Láng Hạ, Đống Đa, Hà Nội',
    '88 Láng Hạ, Đống Đa, Hà Nội',
    'Xóm Cảm Ơn, xã Tân Lập, Thái Nguyên'
  ];
  for (const raw of keep) {
    assert.equal(cleanAddressText(raw), raw, raw);
    assert.deepEqual(lostHouseNumbers(raw, cleanAddressText(raw)), [], raw);
  }
  // Mọi ca làm sạch ở test trên: số nhà trong phần địa chỉ còn nguyên.
  for (const [raw, house] of [['về 83 hải phòng, phường Thạch Thang, Đà Nẵng', '83'], ['Vui lòng giao đến địa chỉ 275/97/14 Quang Trung, p10, Gò Vấp, TPHCM. Cảm ơn!', '275/97/14'], ['2 túi xanh 12 Lê Lợi, phường Bến Nghé, Quận 1', '12'], ['ship ve 19A huỳnh đình Hai, p14, Bình Thạnh Ngân Combo 2 tui', '19A']]) {
    assert.ok(houseNumbersOf(cleanAddressText(raw)).some(number => String(number).toLowerCase() === house.toLowerCase()), `${raw} → ${cleanAddressText(raw)}`);
  }
});
