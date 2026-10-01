// Vòng r12 (01/10, chủ shop): giỏ lớn/mix tự tính giá, quà 5/10 túi, quà thay thế,
// alias Tropical, sản phẩm chỉ CSKH bán, mã giỏ Facebook Shop, câu tóm tắt đơn.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import './helpers/seed-catalog.mjs';

const catalog = await import('../app/processing/catalog.mjs');
const pricing = await import('../app/processing/pricing.mjs');
const { buildExportRows } = await import('../app/order-export.mjs');

const basket = (...items) => pricing.priceBasket(items.map(([sku, quantity]) => ({ sku, quantity })));
const giftNames = priced => priced.gifts.map(gift => gift.name);
const XANH = 'GRA-XANH-Z450';
const VANG = 'GRA-VANG-H350';
const NAU = 'GRA-NAU-Z350';
const TROPICAL = 'GRA-MINT-Z300';
const LIVE_GIFT = { id: 'qua-tang-live', name: 'Quạt + Bát gáo dừa', active: true, minQuantity: 2, maxQuantity: 2, livestreamOnly: true, excludedSkus: [], sku: 'QUA-TANG-LIVE', weight: 50 };

function withGifts(edit, run) {
  const original = readFileSync(process.env.GIFTS_PATH, 'utf8');
  const gifts = JSON.parse(original);
  edit(gifts);
  writeFileSync(process.env.GIFTS_PATH, JSON.stringify(gifts));
  catalog.reloadCatalog();
  try {
    return run();
  } finally {
    writeFileSync(process.env.GIFTS_PATH, original);
    catalog.reloadCatalog();
  }
}

test('giỏ lớn: từ 2 túi mỗi túi giá combo (Xanh/Vàng 149k, Nâu 144k) cho mọi số lượng, miễn ship; 9 túi = 3 × 447k', () => {
  assert.equal(basket([XANH, 4]).total, 596000);
  assert.equal(basket([XANH, 2], [VANG, 2]).total, 596000);
  // 5 túi: 5 Xanh/Vàng 745k; 4 Xanh/Vàng + 1 Nâu 740k (con số nhân viên báo).
  assert.equal(basket([XANH, 5]).total, 745000);
  assert.equal(basket([XANH, 2], [VANG, 2], [NAU, 1]).total, 740000);
  assert.equal(basket([VANG, 6]).total, 894000);
  assert.equal(basket([XANH, 9]).total, 3 * 447000);
  assert.equal(basket([XANH, 10]).total, 1490000);
  for (const quantity of [4, 5, 6, 9, 10, 20]) {
    const priced = basket([XANH, quantity]);
    assert.equal(priced.priceable, true, `${quantity} túi`);
    assert.equal(priced.shippingFee, 0, `${quantity} túi miễn ship`);
  }
  // Tổng giá gốc (giá lẻ) và phần ưu đãi cho câu tóm tắt.
  const four = basket([XANH, 4]);
  assert.deepEqual([four.listSubtotal, four.subtotal, four.discount], [696000, 596000, 100000]);
  assert.equal(basket([XANH, 21]).reason, 'too-many');
  assert.equal(catalog.maxBasketQuantity, 20);
});

test('combo 10 gói ×n 179k/combo; ghép với túi lớn: 2 Vàng + 1 combo Cam = 477k miễn ship + bát + muỗng', () => {
  assert.equal(basket(['CB10-XANH-G35', 2]).total, 358000);
  assert.equal(basket(['CB10-CAM-G30', 4]).total, 4 * 179000);
  const mixed = basket([VANG, 2], ['CB10-CAM-G30', 1]);
  assert.equal(mixed.total, 477000);
  assert.equal(mixed.shippingFee, 0);
  assert.deepEqual(giftNames(mixed), ['Miễn phí vận chuyển', 'Bộ bát gáo dừa', 'Muỗng dừa']);
  // Nghệ Lành không cùng nhóm ghép: chuyển nhân viên.
  assert.equal(basket(['NGHE-H350', 1], [XANH, 1]).reason, 'not-a-combo');
  assert.equal(basket(['NGHE-H350', 4]).total, 4 * 149000);
});

test('Granola Tropical vị Cacao 300g: 1 túi 204k + ship, 2 túi 348k, 3 túi 522k + bát muỗng; mix với túi lớn (Tropical + Vàng 323k)', () => {
  assert.deepEqual([basket([TROPICAL, 1]).subtotal, basket([TROPICAL, 1]).shippingFee], [204000, 15000]);
  assert.equal(basket([TROPICAL, 2]).total, 348000);
  const three = basket([TROPICAL, 3]);
  assert.equal(three.total, 522000);
  assert.deepEqual(giftNames(three), ['Miễn phí vận chuyển', 'Bộ bát gáo dừa', 'Muỗng dừa']);
  const mix = basket([TROPICAL, 1], [VANG, 1]);
  assert.equal(mix.total, 323000);
  assert.equal(mix.shippingFee, 0);
  // Không vào bảng mix 3 túi chủ lực (mixable vẫn false), nhưng cùng nhóm ghép "granola".
  const tropical = catalog.findProductBySku(TROPICAL);
  assert.equal(tropical.name, 'Granola Tropical vị Cacao 300g');
  assert.deepEqual([tropical.mixable, tropical.mixGroup], [false, 'granola']);
  assert.equal(catalog.canShareBasket([tropical, catalog.findProductBySku(VANG)]), true);
  assert.equal(catalog.canShareBasket([tropical, catalog.findProductBySku('NGHE-H350')]), false);
  // Dữ liệu cũ không có mixGroup: sản phẩm mixable thuộc "granola", còn lại bán riêng.
  assert.equal(catalog.mixGroupOf({ mixable: true }), 'granola');
  assert.equal(catalog.mixGroupOf({ mixable: false }), '');
});

test('quà theo số túi: 3–4 bát + muỗng; 5 túi thêm 1 Túi Vàng; 10 túi thêm Túi Vàng + Túi Nâu; 6–9 giữ bát + muỗng kèm ghi chú nhân viên', () => {
  const base = ['Miễn phí vận chuyển', 'Bộ bát gáo dừa', 'Muỗng dừa'];
  assert.deepEqual(giftNames(basket([XANH, 3])), base);
  assert.deepEqual(giftNames(basket([XANH, 4])), base);
  assert.deepEqual(giftNames(basket([XANH, 5])), [...base, '1 Túi Vàng 350g']);
  for (const quantity of [6, 7, 8, 9]) {
    const priced = basket([XANH, quantity]);
    assert.deepEqual(giftNames(priced), base, `${quantity} túi`);
    assert.match(priced.giftNote, new RegExp(`Đơn ${quantity} túi.*nhân viên xem lại`));
  }
  const ten = basket([XANH, 4], [VANG, 3], [NAU, 3]);
  assert.deepEqual(giftNames(ten), [...base, '1 Túi Vàng 350g', '1 Túi Nâu 350g']);
  assert.equal(ten.gift, 'Miễn phí vận chuyển + Bộ bát gáo dừa + Muỗng dừa + 1 Túi Vàng 350g + 1 Túi Nâu 350g');
  assert.equal(ten.giftNote, '');
  assert.equal(basket([XANH, 5]).giftNote, '');
  assert.match(basket([XANH, 12]).giftNote, /Đơn 12 túi/);
  // Quà túi là SKU sản phẩm danh mục (dòng tặng giá 0 riêng trên POS/kho), không phải quà đổi được.
  const vang = basket([XANH, 5]).gifts.find(gift => gift.name === '1 Túi Vàng 350g');
  assert.deepEqual([vang.sku, vang.weight, catalog.isBonusProductGift(vang), catalog.isSwappableGift(vang)], [VANG, 350, true, false]);
  // File xuất kho: túi tặng là dòng giá 0 riêng, kể cả khi khách mua đúng túi đó (5 Vàng + 1 Vàng tặng).
  const headers = ['Mã đơn hàng', 'Khách hàng', 'Số điện thoại', 'Địa chỉ', 'Sản phẩm', 'Mã mẫu mã', 'Số lượng', 'Đơn giá'];
  const exported = sku => buildExportRows({ headers, rows: [['X-' + sku, 'A', '0385805790', '12 Lê Lợi', sku, sku, '5', '149000']] }).map(row => `${row[19]}x${row[21]}@${row[22]}`);
  assert.deepEqual(exported(VANG), [`${VANG}x5@149000`, 'BGDx1@0', 'MUONGx1@0', `${VANG}x1@0`]);
  assert.deepEqual(exported(XANH), [`${XANH}x5@149000`, 'BGDx1@0', 'MUONGx1@0', `${VANG}x1@0`]);
  // Không áp cho Nghệ Lành / Hạt An Lành (loại trừ như bát + muỗng).
  assert.deepEqual(giftNames(basket(['NGHE-H350', 5])), ['Miễn phí vận chuyển']);
  // Bảng quà gửi khách/mô hình ghi đúng mốc.
  const table = pricing.describeGiftTable();
  assert.ok(table.some(line => line.startsWith('- 1 Túi Vàng 350g: đúng 5 sản phẩm')), table.join('\n'));
  assert.ok(table.some(line => line.startsWith('- 1 Túi Vàng 350g + 1 Túi Nâu 350g: từ 10 sản phẩm')), table.join('\n'));
});

test('quà live: khách live đúng 2 túi chỉ "Quạt + Bát gáo dừa"; từ 3 túi không thêm quà live; khách thường không bao giờ thấy quà live (bảng giá cũng vậy)', () => {
  withGifts(gifts => gifts.items.push(LIVE_GIFT), () => {
    const live = { livestream: true };
    assert.deepEqual(giftNames(pricing.priceBasket([{ sku: XANH, quantity: 2 }], live)), ['Miễn phí vận chuyển', 'Quạt + Bát gáo dừa']);
    assert.deepEqual(giftNames(pricing.priceBasket([{ sku: XANH, quantity: 3 }], live)), ['Miễn phí vận chuyển', 'Bộ bát gáo dừa', 'Muỗng dừa']);
    assert.deepEqual(giftNames(pricing.priceBasket([{ sku: XANH, quantity: 5 }], live)), ['Miễn phí vận chuyển', 'Bộ bát gáo dừa', 'Muỗng dừa', '1 Túi Vàng 350g']);
    // Mint (Tropical) + Xanh khách live: 323k, quà live.
    const mint = pricing.priceBasket([{ product: 'Xanh Mint 300g', quantity: 1 }, { sku: XANH, quantity: 1 }], live);
    assert.deepEqual([mint.total, mint.gift], [323000, 'Miễn phí vận chuyển + Quạt + Bát gáo dừa']);
    // Khách thường: không quà live ở đơn lẫn bảng giá.
    assert.deepEqual(giftNames(basket([XANH, 2])), ['Miễn phí vận chuyển']);
    for (const tier of pricing.quoteTiers('túi xanh').tiers) assert.ok(!tier.gifts.includes('Quạt + Bát gáo dừa'), `bậc ${tier.quantity}`);
    assert.ok(catalog.getGifts().find(gift => gift.id === 'qua-tang-live').livestreamOnly);
  });
});

test('quà thay thế (GIFT_SWAP): không lấy bát/quạt → 2 gói granola nhỏ (Xanh, Cam, Nâu), không trừ tiền', () => {
  const swap = catalog.getGiftSwap();
  assert.equal(swap.text, '2 gói granola nhỏ bất kỳ (Xanh, Cam, Nâu)');
  assert.deepEqual([swap.quantity, swap.refund], [2, 0]);
  assert.deepEqual(swap.options.map(option => [option.label, option.sku]), [['Xanh', 'GRA-XANH-G35'], ['Cam', 'GRA-CAM-G30'], ['Nâu', 'GRA-NAU-G35']]);
  // Chọn vị từ tin khách.
  const labels = text => catalog.parseGiftSwapChoice(text).map(option => option.label);
  assert.deepEqual(labels('1 xanh 1 nâu'), ['Xanh', 'Nâu']);
  assert.deepEqual(labels('2 gói cam'), ['Cam', 'Cam']);
  assert.deepEqual(labels('nâu'), ['Nâu', 'Nâu']);
  assert.deepEqual(labels('dạ cảm ơn em, lấy xanh với nâu nha'), ['Xanh', 'Nâu']);
  assert.deepEqual(labels('ok em'), []);
  // Đổi quà đơn 3 túi: bỏ bát + muỗng, thêm 2 gói; miễn ship giữ nguyên.
  const priced = basket([XANH, 3]);
  const swapped = catalog.applyGiftSwap(priced.gifts, catalog.parseGiftSwapChoice('xanh với cam'));
  assert.deepEqual(swapped.removed.map(gift => gift.sku), ['BGD', 'MUONG']);
  assert.deepEqual(swapped.gifts.map(gift => gift.name), ['Miễn phí vận chuyển', 'Gói granola nhỏ Xanh 35g', 'Gói granola nhỏ Cam 30g']);
  assert.equal(swapped.text, '1 Gói granola nhỏ Xanh 35g + 1 Gói granola nhỏ Cam 30g');
  // Chưa chọn vị: 2 dòng trống SKU để nhân viên chọn.
  assert.deepEqual(catalog.applyGiftSwap(priced.gifts).added.map(gift => gift.sku), ['', '']);
  // Quạt + Bát của live đổi được; quà túi (đơn 5 túi) giữ nguyên.
  assert.equal(catalog.isSwappableGift(LIVE_GIFT), true);
  const five = catalog.applyGiftSwap(basket([XANH, 5]).gifts, catalog.parseGiftSwapChoice('2 xanh'));
  assert.ok(five.gifts.some(gift => gift.name === '1 Túi Vàng 350g'));
  // Không có quà hiện vật: không đổi gì.
  assert.deepEqual(catalog.applyGiftSwap(basket([XANH, 2]).gifts).added, []);
  // Câu tóm tắt dùng được danh sách quà sau khi đổi; tiền không đổi.
  const summary = pricing.formatOrderSummary(priced, { gifts: swapped.gifts });
  assert.match(summary, /🎉 Ưu đãi còn: 447\.000đ/);
  assert.match(summary, /🎁 Tặng kèm Gói granola nhỏ Xanh 35g \+ Gói granola nhỏ Cam 30g$/);
  // gifts.json có khoá `swap` riêng thì dùng.
  withGifts(gifts => { gifts.swap = { text: '1 hũ thủy tinh', quantity: 1, options: [{ label: 'Hũ', sku: 'HU-300ML', weight: 10 }] }; }, () => {
    assert.deepEqual([catalog.getGiftSwap().text, catalog.getGiftSwap().quantity, catalog.getGiftSwap().options[0].sku], ['1 hũ thủy tinh', 1, 'HU-300ML']);
  });
});

test('danh mục: alias Tropical (xanh mint/min/nhạt/biển/ngọc/da trời/dương, dâu tây, xoài dâu, loại mới, nhiệt đới, premium cacao); "túi xanh"/"xanh lá"/"450g" vẫn là Túi Xanh', () => {
  const name = text => catalog.matchProduct(text)?.name || null;
  for (const text of ['xanh mint', 'túi xanh mint', 'Xanh Mint 300g', 'xanh min', 'lấy 1 túi xanh nhạt có dâu tây', 'xanh biển nhạt', 'túi xanh ngọc', 'xanh da trời', 'túi xanh dương', 'túi dâu tây', 'loại có dâu', 'xoài dâu', 'có loại mới không', 'nhiệt đới', 'premium cacao', 'tropical', 'granola tropical', 'Granola Tropical Cacao 300g', 'mint']) {
    assert.equal(name(text), 'Granola Tropical vị Cacao 300g', text);
  }
  for (const text of ['túi xanh', 'cho chị 2 túi xanh', '2túi xanh', 'xanh lá', 'túi xanh lá cây', 'granola xanh', 'C muốn mua loại 450g á', 'loại 450']) {
    assert.equal(name(text), 'Granola Túi Xanh 450g', text);
  }
  // "xanh" trơn / màu trong từ khác: không đoán; "350g" (Vàng hay Nâu) phải hỏi lại.
  assert.equal(name('xanh'), null);
  assert.equal(name('bột chuối xanh có tốt không'), null);
  assert.equal(name('350g'), null);
  // Tên gọi chữ phải là từ trọn: "túi đâu" không phải túi dâu.
  assert.equal(name('túi đâu rồi em'), null);
  assert.equal(catalog.keywordInText('tui dau tay', 'dau tay'), true);
  assert.equal(catalog.keywordInText('xdau tay', 'dau tay'), false);
  assert.equal(catalog.keywordInText('loai 450gr', '450g'), true);
  assert.equal(name('granola cacao'), 'Granola Túi Nâu vị cacao 350g');
  // Bản danh mục gửi mô hình không còn sản phẩm chỉ CSKH bán.
  assert.doesNotMatch(pricing.buildCatalogPrompt({ compact: true }), /Hạt An Lành/);
  assert.match(pricing.buildCatalogPrompt({ compact: true }), /Granola Tropical vị Cacao 300g/);
});

test('sản phẩm chỉ CSKH bán (Siêu Hạt Premium, hũ/lọ, hộp nhựa, Hạt An Lành, mua hạt): nhận ra để chuyển nhân viên; câu về túi granola không bị bắt nhầm', () => {
  const id = text => catalog.matchStaffOnlyProduct(text)?.id || null;
  assert.equal(id('Granola Siêu Hạt Premium 420g giá sao'), 'sieu-hat-premium');
  assert.equal(id('hộp hạt premium như hình'), 'sieu-hat-premium');
  assert.equal(id('loại đựng trong lọ'), 'hu-lo');
  assert.equal(id('granola dạng hũ có không'), 'hu-lo');
  assert.equal(id('Hộp nhựa là mã gì. Bn gram. Giá bn'), 'hop-nhua');
  assert.equal(id('Mình muốn mua hạt'), 'mua-hat');
  assert.equal(id('chỉ mua các loại hạt thôi'), 'mua-hat');
  assert.equal(id('hũ hạt an lành'), 'mix5-h420');
  assert.equal(catalog.matchStaffOnlyProduct('hạt an lành').product.sku, 'MIX5-H420');
  for (const text of ['túi nào nhiều hạt', 'có hạt óc chó không', 'em đang lo quá', 'chị đừng lo', 'hũ thủy tinh 300ml là gì', 'mua túi nhiều hạt', 'Hủ đậu gì vậy phải sữa chua không', 'cho chị 2 túi vàng', 'premium cacao']) {
    assert.equal(id(text), null, text);
  }
  // Hạt An Lành vẫn tra được theo SKU (đơn nhân viên/landing), cờ staffOnly đi kèm.
  assert.equal(catalog.findProductBySku('MIX5-H420').staffOnly, true);
  assert.equal(catalog.findProductBySku(XANH).staffOnly, false);
});

test('giỏ Facebook Shop: bỏ đuôi quà "+BGD+M", combo màu → túi, yến mạch → cần nhân viên', () => {
  const parsed = catalog.parseCartSku('CB3-XANH-Z450+BGD+M');
  assert.deepEqual(parsed.items.map(item => [item.sku, item.quantity]), [[XANH, 3]]);
  assert.deepEqual([parsed.gifts, parsed.needsStaff], [['BGD', 'MUONG'], false]);
  assert.deepEqual(catalog.parseCartSku('CB3-VANGG+BGD+M').items.map(item => [item.sku, item.quantity]), [[VANG, 3]]);
  assert.deepEqual(catalog.parseCartSku('CB-VANGG+XANH').items.map(item => [item.sku, item.quantity]), [[VANG, 1], [XANH, 1]]);
  assert.deepEqual(catalog.parseCartSku('CB2-MINT-Z300', 2).items.map(item => [item.sku, item.quantity]), [[TROPICAL, 4]]);
  assert.deepEqual(catalog.parseCartSku('cb10-cam-g30').items.map(item => [item.sku, item.quantity]), [['CB10-CAM-G30', 1]]);
  assert.deepEqual(catalog.parseCartSku('GRA-NAU-Z350+BGD').items.map(item => [item.sku, item.quantity]), [[NAU, 1]]);
  const oat = catalog.parseCartSku('CB2-HT-YM-T500');
  assert.deepEqual([oat.needsStaff, oat.reason, oat.label, oat.items.length], [true, 'oat', 'Yến Mạch Úc Nguyên Cám cán dẹt 1kg', 0]);
  assert.equal(catalog.parseCartSku('CB4-YM-VO-T500').label, 'Yến Mạch Úc Nguyên Cám cán vỡ 2kg');
  assert.deepEqual([catalog.parseCartSku('LA-XYZ').needsStaff, catalog.parseCartSku('LA-XYZ').reason], [true, 'unknown']);
  // Cả giỏ: gộp theo SKU; có yến mạch → needsStaff kèm nhãn, phần granola vẫn đọc được.
  const cart = catalog.parseShopCart([{ sku: 'CB2-XANH-Z450', quantity: 1 }, { sku: 'GRA-XANH-Z450', quantity: 1 }, { sku: 'CB2-HT-YM-T500', quantity: 1 }]);
  assert.deepEqual(cart.items.map(item => [item.sku, item.quantity]), [[XANH, 3]]);
  assert.deepEqual([cart.needsStaff, cart.reasons, cart.labels], [true, ['oat'], ['Yến Mạch Úc Nguyên Cám cán dẹt 1kg']]);
  const plain = catalog.parseShopCart([{ sku: 'CB3-XANH-Z450+BGD+M', quantity: 1 }]);
  assert.equal(plain.needsStaff, false);
  assert.equal(pricing.priceBasket(plain.items).total, 447000);
});

test('câu tóm tắt đơn kiểu nhân viên: món, Tổng giá, Ưu đãi còn, Miễn phí vận chuyển, Tặng kèm', () => {
  assert.equal(pricing.formatOrderSummary([{ sku: VANG, quantity: 2 }, { sku: 'CB10-CAM-G30', quantity: 1 }]), [
    'Dạ đơn hàng của mình gồm:',
    '• 2 Granola Túi Vàng 350g',
    '• 1 Combo 10 gói Cam',
    'Tổng giá: 537.000đ',
    '🎉 Ưu đãi còn: 477.000đ',
    '✅ Miễn phí vận chuyển',
    '🎁 Tặng kèm Bộ bát gáo dừa + Muỗng dừa'
  ].join('\n'));
  // 1 túi: không ưu đãi, có phí ship và tổng thanh toán, không quà.
  assert.equal(pricing.formatOrderSummary([{ product: 'túi xanh', quantity: 1 }]), [
    'Dạ đơn hàng của mình gồm:',
    '• 1 Granola Túi Xanh 450g',
    'Tổng giá: 174.000đ',
    '🚚 Phí vận chuyển: 15.000đ',
    '💰 Tổng thanh toán: 189.000đ'
  ].join('\n'));
  // 5 túi: quà túi hiện trong câu; nhận cả kết quả priceBasket.
  const five = pricing.formatOrderSummary(basket([XANH, 5]));
  assert.match(five, /Tổng giá: 870\.000đ\n🎉 Ưu đãi còn: 745\.000đ\n✅ Miễn phí vận chuyển\n🎁 Tặng kèm Bộ bát gáo dừa \+ Muỗng dừa \+ 1 Túi Vàng 350g$/);
  // 2 túi: chỉ miễn ship, không dòng quà; câu mở đầu đổi được.
  assert.equal(pricing.formatOrderSummary([{ sku: XANH, quantity: 2 }], { intro: 'Dạ em tóm tắt đơn:' }).split('\n')[0], 'Dạ em tóm tắt đơn:');
  assert.doesNotMatch(pricing.formatOrderSummary([{ sku: XANH, quantity: 2 }]), /Tặng kèm/);
  // Giỏ không tính được: ''.
  assert.equal(pricing.formatOrderSummary([{ sku: 'NGHE-H350', quantity: 1 }, { sku: XANH, quantity: 1 }]), '');
});
