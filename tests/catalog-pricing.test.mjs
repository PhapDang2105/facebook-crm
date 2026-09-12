import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import './helpers/seed-catalog.mjs';

const catalog = await import('../app/processing/catalog.mjs');
const pricing = await import('../app/processing/pricing.mjs');
const { detectProduct } = await import('../app/processing/product-detect.mjs');
const { orderKey } = await import('../app/processing/order-key.mjs');
const { renderChatbotReply, defaultMessageTemplates, isProductQuoteId } = await import('../app/chatbot-templates.mjs');
const { normalizeChatbotOrder, buildOrderReceiptPayload } = await import('../app/conversation-orders.mjs');
const { buildExportRows, splitSkuForExport } = await import('../app/order-export.mjs');
const { normalizeProduct } = await import('../app/products.mjs');

const basket = (...items) => pricing.priceBasket(items);
const gift3 = 'Miễn phí vận chuyển + Bộ bát gáo dừa + Muỗng dừa';
// Trimmed exactly as the server stores them, so spacing bugs cannot hide in the seed.
const templates = Object.fromEntries(Object.entries(defaultMessageTemplates()).map(([id, text]) => [id, text.trim()]));

test('giá lẻ + ship cho 1 sản phẩm, giá combo và miễn ship từ 2 — khớp bảng giá gốc', () => {
  const rows = [
    [[['GRA-XANH-Z450', 1]], 189000, ''], [[['GRA-XANH-Z450', 2]], 298000, 'Miễn phí vận chuyển'], [[['GRA-XANH-Z450', 3]], 447000, gift3],
    [[['GRA-NAU-Z350', 1]], 179000, ''], [[['GRA-NAU-Z350', 2]], 288000, 'Miễn phí vận chuyển'], [[['GRA-NAU-Z350', 3]], 432000, gift3],
    [[['GRA-XANH-Z450', 1], ['GRA-NAU-Z350', 1]], 293000, 'Miễn phí vận chuyển'],
    [[['GRA-XANH-Z450', 1], ['GRA-NAU-Z350', 2]], 437000, gift3],
    [[['GRA-XANH-Z450', 1], ['GRA-VANG-H350', 1], ['GRA-NAU-Z350', 1]], 442000, gift3],
    [[['CB10-MIX', 1]], 204000, ''], [[['CB10-MIX', 2]], 358000, 'Miễn phí vận chuyển'], [[['CB10-MIX', 3]], 537000, gift3],
    [[['GRA-TROPICAL-300', 1]], 219000, ''], [[['GRA-TROPICAL-300', 3]], 522000, gift3]
  ];
  for (const [items, total, gift] of rows) {
    const priced = basket(...items.map(([sku, quantity]) => ({ sku, quantity })));
    assert.equal(priced.total, total, items.map(([s, q]) => `${s}=${q}`).join('|'));
    assert.equal(priced.gift, gift);
  }
  assert.equal(basket({ sku: 'GRA-XANH-Z450', quantity: 1 }).shippingFee, 15000);
  assert.equal(basket({ sku: 'GRA-XANH-Z450', quantity: 2 }).shippingFee, 0);
});

test('chỉ tổ hợp có trong bảng quà mới được tự tính; túi ghép được, combo 10 gói không; lạ hoặc quá 3 thì chuyển nhân viên', () => {
  assert.equal(basket({ sku: 'GRA-XANH-Z450', quantity: 1 }, { sku: 'GRA-VANG-H350', quantity: 1 }).key, 'GRA-VANG-H350=1|GRA-XANH-Z450=1');
  assert.equal(basket({ sku: 'CB10-MIX', quantity: 1 }, { sku: 'GRA-XANH-Z450', quantity: 1 }).reason, 'not-a-combo');
  assert.equal(basket({ product: 'Set quà Tết', quantity: 1 }).reason, 'unknown-product');
  assert.equal(basket({ sku: 'GRA-XANH-Z450', quantity: 4 }).reason, 'too-many');
  assert.equal(basket({ sku: 'GRA-XANH-Z450', quantity: 21 }).reason, 'too-many');
  // 3 túi lẻ ×1..3 + mọi bộ ghép ≤3 của 3 túi trộn được + 7 sản phẩm còn lại ×1..3.
  const combos = catalog.listCombos();
  assert.equal(combos.length, 7 * 3 + 19);
  assert.equal(new Set(combos.map(combo => combo.key)).size, combos.length);
  assert.ok(Object.keys(catalog.getGiftAssignments()).every(key => combos.some(combo => combo.key === key)), 'mọi key trong gifts.seed phải là tổ hợp hợp lệ');
  assert.equal(orderKey([{ product: 'Túi Nâu', quantity: 1 }, { product: 'Túi Xanh', quantity: 2 }]), 'GRA-NAU-Z350=1|GRA-XANH-Z450=2');
});

test('nhận diện theo tên và tên gọi khác, không nhận màu đơn lẻ', () => {
  assert.equal(detectProduct('cho em 2 túi xanh'), 'Granola Túi Xanh 450g');
  assert.equal(detectProduct('granola cacao'), 'Granola Túi Nâu vị cacao 350g');
  assert.equal(detectProduct('combo 10 gói xanh'), 'Combo 10 gói Xanh');
  assert.equal(detectProduct('bột chuối xanh có tốt không'), 'Không xác định');
  assert.equal(detectProduct('GRA-XANH-Z450'), 'Granola Túi Xanh 450g');
});

test('đơn chatbot mang SKU, giá lẻ, giá khách trả, ship và giảm giá combo; receipt cộng khớp', () => {
  const one = normalizeChatbotOrder({ phone: '0385805790', address: '12 Lê Lợi, Quận 1, TP.HCM', items: [{ name: 'Túi Xanh', quantity: 1 }], total: 189000 }, { name: 'A' });
  assert.equal(one.products[0].sku, 'GRA-XANH-Z450');
  assert.equal(one.products[0].image, '');
  assert.equal(one.products[0].price, 174000);
  assert.equal(one.products[0].paidPrice, 189000);
  assert.equal(one.shippingFee, 15000);
  assert.equal(one.total, 189000);
  const receipt = buildOrderReceiptPayload(one);
  assert.equal(receipt.summary.subtotal + receipt.summary.shipping_cost, receipt.summary.total_cost);

  const two = normalizeChatbotOrder({ phone: '0385805790', address: '12 Lê Lợi, Quận 1, TP.HCM', items: [{ name: 'Túi Xanh', quantity: 1 }, { name: 'Túi Nâu', quantity: 1 }], total: 293000 }, { name: 'A' });
  assert.equal(two.shippingFee, 0);
  assert.equal(two.discount, 174000 + 164000 - 293000);
  assert.deepEqual(two.products.map(item => item.paidPrice), [149000, 144000]);
});

test('file xuất kho: mỗi sản phẩm một mã, gộp ship vào giá đơn lẻ, thêm quà có SKU', () => {
  const headers = ['Mã đơn hàng', 'Khách hàng', 'Số điện thoại', 'Địa chỉ', 'Sản phẩm', 'Mã mẫu mã', 'Số lượng', 'Đơn giá'];
  const rows = [
    ['CB-1', 'A', '0385805790', '12 Lê Lợi', 'Granola Túi Xanh 450g', 'GRA-XANH-Z450', '1', '189000'],
    ['CB-2', 'B', '0912345678', '5 Trần Phú', 'Granola Túi Xanh 450g', 'GRA-XANH-Z450', '2', '149000'],
    ['CB-2', 'B', '0912345678', '5 Trần Phú', 'Granola Túi Nâu', 'GRA-NAU-Z350', '1', '144000'],
    ['CB-3', 'C', '0912345679', '6 Trần Phú', 'Combo 10 gói Mix', 'CB10-MIX', '1', '204000'],
    ['CB-4', 'D', '0912345670', '7 Trần Phú', 'Combo 10 gói Mix', 'CB10-MIX', '2', '179000']
  ];
  const out = buildExportRows({ headers, rows }).map(row => `${row[19]}x${row[21]}@${row[22]}/${row[24]}`);
  assert.deepEqual(out, [
    // 1 túi: giá lẻ + ship gộp vào đơn giá.
    'GRA-XANH-Z450x1@189000/450',
    // 2 xanh + 1 nâu là tổ hợp có quà: giá combo, miễn ship, quà có SKU thành dòng xuất kho.
    'GRA-XANH-Z450x2@149000/450', 'GRA-NAU-Z350x1@144000/350', 'BGDx1@0/10', 'MUONGx1@0/10',
    // 1 combo 10 gói: giá lẻ + ship, một dòng đúng mã SKU của nó.
    'CB10-MIXx1@204000/335',
    // 2 combo 10 gói: giá combo, miễn ship theo bảng quà.
    'CB10-MIXx2@179000/335'
  ]);
  // Pancake-era symbols still follow the legacy mapping.
  assert.deepEqual(splitSkuForExport('CB2-XANH', 1, 298000, true).map(item => item.sku), ['GRA-XANH-Z450']);
});

test('mẫu giá và quà là một mẫu sửa được, số liệu điền từ danh mục lúc trả lời', () => {
  for (const id of ['GENERAL_INFO', 'GIFT_POLICY', 'PRICE_QUOTE', 'PRICE_QUOTE_COMBO', 'PRICE_MIX_TUI_LON']) {
    assert.ok(templates[id], `${id} phải có mẫu để sửa`);
    assert.doesNotMatch(templates[id], /\d{3}\.\d{3}đ/, `${id} không được chứa giá cứng`);
  }
  // PRICE_TUI_XANH kiểu cũ là báo giá của sản phẩm "túi xanh", không có mẫu riêng.
  assert.equal(isProductQuoteId('PRICE_TUI_XANH'), true);
  assert.equal(isProductQuoteId('PRICE_YEN_MACH_UC_NGUYEN_CAM'), false);
  assert.equal(isProductQuoteId('PRICE_QUOTE_COMBO'), false);
  // Đơn vị "Combo" dùng mẫu PRICE_QUOTE_COMBO.
  assert.match(renderChatbotReply({ template_id: 'PRICE_TUI_NAU_NHO' }, templates).messages[0], /Bảng giá Combo 10 gói Nâu.*\n🌿 Combo Dùng Thử \(350g\):\n🏷️ Giá niêm yết: 189\.000đ \+ Phí vận chuyển 15\.000đ\n━+\n🔥 2 Combo Tiện Lợi \(700g\):/);
  const policy = renderChatbotReply({ template_id: 'GIFT_POLICY' }, templates).messages[0];
  // Quà phủ hết mọi tổ hợp cùng tổng số lượng thì nói gọn "mọi đơn N sản phẩm"; ngoại lệ liệt kê riêng.
  assert.match(policy, /• Miễn phí vận chuyển: mọi đơn 2 sản phẩm; 3 × Hạt An Lành dạng hũ; 3 × Bột ngũ cốc Nghệ Lành hộp 14 gói/);
  assert.match(policy, /• Miễn phí vận chuyển \+ Bộ bát gáo dừa \+ Muỗng dừa: .*3 × Granola Túi Xanh 450g/);
  const strike = text => [...text].map(char => `${char}\u0336`).join('');
  const quote = renderChatbotReply({ template_id: 'PRICE_QUOTE', Product_N1: 'túi xanh' }, templates);
  assert.equal(quote.messages[0], [
    'Dạ, em gửi anh/chị Bảng giá Granola Túi Xanh 450g để mình dễ tham khảo ạ:',
    '🌿 1 Túi dùng thử (450g):',
    '🏷️ Giá niêm yết: 174.000đ + Phí vận chuyển 15.000đ',
    '━━━━━━━━━━━━',
    '🔥 Combo 2 Túi bán chạy (900g):',
    `🏷️ Giá gốc: ${strike('348.000đ')}`,
    '✨ Giảm còn: 298.000đ (Miễn phí vận chuyển)',
    '━━━━━━━━━━━━',
    '👨‍👩‍👧‍👦 Combo 3 Túi Gia Đình (1.35kg):',
    `🏷️ Giá gốc: ${strike('522.000đ')}`,
    '✨ Giảm còn: 447.000đ (Miễn phí vận chuyển)',
    '🎁 Tặng kèm: Bộ bát gáo dừa + Muỗng dừa ạ.'
  ].join('\n'));
  // Tin thứ hai là lời mời hỏi thêm; sản phẩm chưa có ảnh thì không có tin thứ ba và không gửi ảnh.
  assert.equal(quote.messages.length, 2);
  assert.deepEqual(quote.images, []);
  // Ảnh viết kiểu ![tên](url) trong mẫu được tách ra gửi riêng.
  const withImage = renderChatbotReply({ template_id: 'STORE_ADDRESS' }, { ...templates, STORE_ADDRESS: 'Địa chỉ ạ###![Bản đồ](https://example.com/map.png)' });
  assert.deepEqual(withImage, { templateId: 'STORE_ADDRESS', messages: ['Địa chỉ ạ'], images: ['https://example.com/map.png'], handoff: false });
  // Bảng mix: từng cặp túi ghép và trọn bộ, giá + ship + quà theo bảng tổ hợp.
  const mix = renderChatbotReply({ template_id: 'PRICE_MIX_TUI_LON' }, templates).messages[0];
  assert.match(mix, /• Granola Túi Xanh 450g \+ Granola Túi Vàng nhiều hạt quả 350g: 298\.000đ \(Miễn phí vận chuyển\)/);
  assert.match(mix, /• Granola Túi Xanh 450g \+ Granola Túi Nâu vị cacao 350g: 293\.000đ \(Miễn phí vận chuyển\)/);
  assert.match(mix, /🎁 Trọn bộ 3 túi \(.*\): 442\.000đ \(Miễn phí vận chuyển\) \+ tặng Bộ bát gáo dừa \+ Muỗng dừa/);
  // Sản phẩm không có giá combo chỉ còn bậc 1; các bậc trống và dòng kẻ thừa tự rụng.
  const single = { ...templates, PRICE_QUOTE: templates.PRICE_QUOTE };
  const solo = renderChatbotReply({ template_id: 'PRICE_QUOTE', Product_N1: 'yến mạch' }, { ...single, PRICE_QUOTE: templates.PRICE_QUOTE });
  assert.equal(solo.messages[0], templates.ASK_PRODUCT);
  assert.deepEqual(pricing.quoteTiers('hạt an lành').tiers.map(tier => [tier.price, tier.freeShipping, tier.gifts.length]), [[269000, false, 0], [528000, true, 0], [792000, true, 0]]);
});

test('tin xác nhận đơn: 2 túi ghép — không dòng ship, miễn ship ghi cạnh tổng tiền, không dòng quà', () => {
  const reply = renderChatbotReply({ template_id: 'ORDER_CONFIRMATION', Product_N1: 'Túi Xanh', No_A: '1', Product_N2: 'Túi Nâu', No_B: '1', Phone_Number: '0385805700', Customer_Address: 'kp6 Đông Hải, pr-tc, Ninh Thuận' }, templates);
  assert.equal(reply.messages[0], [
    'Dạ, em xin phép xác nhận lại thông tin đặt hàng của mình nha:',
    '',
    '🌾 Granola Túi Xanh 450g – Số lượng: 1',
    '🌾 Granola Túi Nâu vị cacao 350g – Số lượng: 1',
    '━━━━━━━━━━━━',
    '📞 Số điện thoại: 0385805700',
    '━━━━━━━━━━━━',
    '🏡 Địa chỉ nhận hàng: kp6 Đông Hải, pr-tc, Ninh Thuận',
    '━━━━━━━━━━━━',
    '💰 Tổng tiền: 293.000đ (Miễn phí vận chuyển)',
    '',
    'Em cảm ơn anh/ chị đã ủng hộ Giọt Nắng, nếu có gì sai sót, anh/ chị nhắn cho em biết nhé ạ.'
  ].join('\n'));
  const single = renderChatbotReply({ template_id: 'ORDER_CONFIRMATION', Product_N1: 'Túi Xanh', No_A: '1', Phone_Number: '0385805700', Customer_Address: 'Q12' }, templates).messages[0];
  assert.match(single, /🚚 Phí vận chuyển: 15\.000đ\n━+\n💰 Tổng tiền: 189\.000đ\n\nEm cảm ơn/);
});

test('ảnh sản phẩm ở Cài đặt → Sản phẩm đi vào đơn chatbot, receipt và bảng giá', () => {
  const products = JSON.parse(readFileSync(process.env.PRODUCTS_PATH, 'utf8'));
  products.items[0].image = '/product-images/xanh.jpg';
  writeFileSync(process.env.PRODUCTS_PATH, JSON.stringify(products));
  catalog.reloadCatalog();
  const order = normalizeChatbotOrder({ phone: '0385805790', address: '12 Lê Lợi, Quận 1', items: [{ name: 'Túi Xanh', quantity: 2 }], total: 298000 }, { name: 'A' });
  assert.equal(order.products[0].image, '/product-images/xanh.jpg');
  const element = buildOrderReceiptPayload(order, { baseUrl: 'https://fb.example.vn' }).elements[0];
  assert.match(element.image_url, /^https:\/\/fb\.example\.vn\/product-images\/xanh\.jpg\?v=\d+$/);
  // Messenger chỉ vẽ tiêu đề từng dòng, nên số lượng và đơn giá nằm luôn trong tiêu đề.
  assert.equal(element.title, 'Granola Túi Xanh 450g · SL 2 · 174.000đ');
  assert.equal(element.quantity, 2);
  const quote = renderChatbotReply({ template_id: 'PRICE_QUOTE', Product_N1: 'túi xanh' }, templates);
  assert.equal(quote.images.length, 1);
  assert.match(quote.images[0], /\/product-images\/xanh\.jpg\?v=\d+$/);
});

test('sửa giá, tắt quà, bỏ tick tổ hợp, đổi phí ship có hiệu lực ngay sau khi lưu', () => {
  const products = JSON.parse(readFileSync(process.env.PRODUCTS_PATH, 'utf8'));
  products.items[0].salePrice = 199000;
  writeFileSync(process.env.PRODUCTS_PATH, JSON.stringify(products));
  const gifts = JSON.parse(readFileSync(process.env.GIFTS_PATH, 'utf8'));
  gifts.items[2].active = false;
  gifts.shippingFee = 20000;
  gifts.assignments['GRA-XANH-Z450=2'] = [];
  writeFileSync(process.env.GIFTS_PATH, JSON.stringify(gifts));
  catalog.reloadCatalog();
  assert.equal(basket({ sku: 'GRA-XANH-Z450', quantity: 1 }).total, 219000);
  assert.equal(pricing.giftTextForKey('GRA-XANH-Z450=3'), 'Miễn phí vận chuyển + Bộ bát gáo dừa');
  // Bỏ tick miễn ship cho 2 túi xanh → combo 2 túi lại chịu phí ship mới.
  assert.equal(basket({ sku: 'GRA-XANH-Z450', quantity: 2 }).total, 298000 + 20000);
  // Khối gửi model chỉ có tên và cách gọi — không giá, không quà — để tiết kiệm token; giá mới vẫn vào báo giá.
  assert.doesNotMatch(pricing.buildCatalogPrompt(), /\d{3}\.\d{3}đ/);
  assert.match(renderChatbotReply({ template_id: 'PRICE_QUOTE', Product_N1: 'túi xanh' }, templates).messages[0], /Giá niêm yết: 199\.000đ \+ Phí vận chuyển 20\.000đ/);
});

test('giá combo cao hơn giá lẻ bị từ chối; SKU và tên gọi khác được chuẩn hóa', () => {
  assert.throws(() => normalizeProduct({ name: 'X', sku: 'X', salePrice: 100000, comboPrice: 120000 }), /cao hơn giá bán lẻ/);
  const product = normalizeProduct({ name: 'X', sku: 'cb10 x', salePrice: 189000, comboPrice: 179000, unit: ' Hũ ', aliases: 'a, b,, a' });
  assert.equal(product.sku, 'CB10_X');
  assert.equal(product.unit, 'Hũ');
  assert.deepEqual(product.aliases, ['a', 'b']);
});
