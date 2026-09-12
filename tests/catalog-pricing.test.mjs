import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import './helpers/seed-catalog.mjs';

const catalog = await import('../app/processing/catalog.mjs');
const pricing = await import('../app/processing/pricing.mjs');
const { detectProduct } = await import('../app/processing/product-detect.mjs');
const { orderKey } = await import('../app/processing/order-key.mjs');
const { renderChatbotReply, listDynamicTemplates, defaultMessageTemplates } = await import('../app/chatbot-templates.mjs');
const { normalizeChatbotOrder, buildOrderReceiptPayload } = await import('../app/conversation-orders.mjs');
const { buildExportRows, splitSkuForExport } = await import('../app/order-export.mjs');
const { normalizeProduct } = await import('../app/products.mjs');

const basket = (...items) => pricing.priceBasket(items);
const gift3 = 'Miễn phí vận chuyển + Bộ bát gáo dừa + Muỗng dừa';
const templates = defaultMessageTemplates();

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

test('file xuất kho: bung thành phần, gộp ship vào giá đơn lẻ, thêm quà có SKU', () => {
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
    'GRA-XANH-Z450x1@189000/500',
    // 2 xanh + 1 nâu là tổ hợp có quà: giá combo, miễn ship, quà có SKU thành dòng xuất kho.
    'GRA-XANH-Z450x2@149000/500', 'GRA-NAU-Z350x1@144000/400', 'BGDx1@0/10', 'MUONGx1@0/10',
    // 1 combo 10 gói: (189.000 + 15.000 ship) chia đều 10 gói thành phần.
    'GRA-NAU-G35x3@20400/35', 'GRA-XANH-G35x4@20400/35', 'GRA-CAM-G30x3@20400/30',
    // 2 combo 10 gói: giá combo, miễn ship theo bảng quà.
    'GRA-NAU-G35x6@17900/35', 'GRA-XANH-G35x8@17900/35', 'GRA-CAM-G30x6@17900/30'
  ]);
  // Pancake-era symbols still follow the legacy mapping.
  assert.deepEqual(splitSkuForExport('CB2-XANH', 1, 298000, true).map(item => item.sku), ['GRA-XANH-Z450']);
});

test('mẫu tin giá và quà chỉ tồn tại ở dạng động, soạn từ danh mục', () => {
  for (const id of ['GENERAL_INFO', 'GIFT_POLICY', 'PRICE_TUI_XANH', 'PRICE_QUOTE', 'PRICE_ADJUSTMENT', 'PRICE_MIX_TUI_LON']) {
    assert.equal(templates[id], undefined, `${id} không được là text tĩnh`);
    assert.ok(listDynamicTemplates(templates)[id], `${id} phải là mẫu động`);
  }
  assert.match(renderChatbotReply({ template_id: 'PRICE_TUI_NAU_NHO' }, templates).messages[0], /Combo 10 gói Nâu: 1 sản phẩm 189\.000đ \+ ship 15\.000đ/);
  const policy = renderChatbotReply({ template_id: 'GIFT_POLICY' }, templates).messages[0];
  assert.match(policy, /• Miễn phí vận chuyển: .*2 × Granola Túi Xanh 450g/);
  assert.match(policy, /• Miễn phí vận chuyển \+ Bộ bát gáo dừa \+ Muỗng dừa: .*3 × Granola Túi Xanh 450g/);
  assert.match(pricing.renderPriceQuote('túi xanh'), /1 sản phẩm 174\.000đ \+ ship 15\.000đ; combo 2 sản phẩm 298\.000đ \(Miễn phí vận chuyển\); combo 3 sản phẩm 447\.000đ \(Miễn phí vận chuyển \+ Bộ bát gáo dừa \+ Muỗng dừa\)/);
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
  assert.match(pricing.buildCatalogPrompt(), /Granola Túi Xanh 450g \(mã GRA-XANH-Z450\): mua lẻ 1 sản phẩm 199\.000đ \+ phí vận chuyển 20\.000đ/);
});

test('giá combo cao hơn giá lẻ bị từ chối; thành phần xuất kho đọc từ chữ', () => {
  assert.throws(() => normalizeProduct({ name: 'X', sku: 'X', salePrice: 100000, comboPrice: 120000 }), /cao hơn giá bán lẻ/);
  const product = normalizeProduct({ name: 'X', sku: 'cb10 x', salePrice: 189000, comboPrice: 179000, components: 'gra-xanh-g35 x10', aliases: 'a, b,, a' });
  assert.equal(product.sku, 'CB10_X');
  assert.deepEqual(product.components, [{ sku: 'GRA-XANH-G35', quantity: 10 }]);
  assert.deepEqual(product.aliases, ['a', 'b']);
});
