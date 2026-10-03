import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

// D1/D2 (web/app.js): một luật ảnh sản phẩm cho bảng Đơn hàng và thẻ đơn trong khung chat; định dạng tiền dùng chung.
const web = (await readFile(new URL('../web/app.js', import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
const seed = JSON.parse(await readFile(new URL('../app/products.seed.json', import.meta.url), 'utf8'));
const fn = name => {
  const start = web.search(new RegExp(`\\n(async )?function ${name}\\(`));
  assert.ok(start >= 0, `không tìm thấy hàm ${name}`);
  const end = web.indexOf('\n}\n', start);
  return web.slice(start, end + 3);
};
const run = (names, context = {}) => {
  vm.createContext(context);
  vm.runInContext(names.map(fn).join('\n'), context);
  return context;
};

test('D1: ảnh mẫu đúng túi theo tên danh mục — gói nhỏ / combo 10 gói / Tropical không mượn ảnh túi lớn', () => {
  const context = run(['productImageFor', 'getCustomerOrderProductImage', 'normalizeColumnName'], { sharedProducts: [] });
  const names = (Array.isArray(seed) ? seed : seed.items || seed.products || []).map(item => item.name);
  const expected = {
    'Granola Túi Xanh 450g': 'product_green',
    'Granola Túi Vàng 350g': 'product_yellow',
    'Granola Túi Nâu vị cacao 350g': 'product_brown',
    'Granola Tropical vị Cacao 300g': '',
    'Combo 10 gói Xanh': '',
    'Combo 10 gói Nâu': '',
    'Combo 10 gói Cam': ''
  };
  for (const [name, key] of Object.entries(expected)) {
    assert.ok(names.includes(name), `danh mục mẫu còn "${name}"`);
    assert.equal(context.productImageFor(name)?.key || '', key, name);
    assert.equal(context.getCustomerOrderProductImage(name), key ? `/assets/logos/${key}.png` : '', `thẻ chat cùng luật: ${name}`);
  }
  assert.equal(context.productImageFor('Gói granola nhỏ Nâu 35g'), null);
  assert.equal(context.productImageFor('Gói granola nhỏ Xanh 35g'), null);
  assert.equal(context.productImageFor('Combo 2 Túi Xanh')?.key, 'combo2_green');
  assert.equal(context.productImageFor('Combo 3 túi vàng')?.key, 'combo3_yellow');
  assert.equal(context.productImageFor('1 Túi Xanh')?.key, 'product_green');
  assert.equal(context.productImageFor(''), null);
  context.sharedProducts = [{ name: 'Granola Túi Xanh 450g', image: '/uploads/xanh.webp' }];
  assert.equal(JSON.stringify(context.productImageFor('Granola Túi Xanh 450g')), JSON.stringify({ src: '/uploads/xanh.webp', key: '' }), 'ảnh tải trong danh mục đi trước');
  assert.equal(context.getCustomerOrderProductImage('Granola Túi Xanh 450g'), '/uploads/xanh.webp');
  assert.match(fn('renderPreviewCell'), /const image = productImageFor\(previewValue\);/);
});

test('D2: tiền viết gọn của trang Khách hàng trùng statShortMoney từ 1 triệu; dưới đó giữ "—" cho 0', () => {
  const context = run(['shortCustomerMoney', 'statShortMoney', 'statMoney', 'isBlankNumber', 'formatCustomerMoney', 'formatVnMoney'], {});
  for (const value of [1000000, 1043000, 12500000, 2300000000, -4500000]) assert.equal(context.shortCustomerMoney(value), context.statShortMoney(value));
  assert.equal(context.shortCustomerMoney(12500000), '12,5 triệu');
  assert.equal(context.shortCustomerMoney(0), '—');
  assert.equal(context.shortCustomerMoney(149000), '149.000đ');
  assert.equal(context.formatVnMoney(149000), '149.000đ');
  assert.equal(context.formatVnMoney(2500), '2.500đ', 'gọi lại dùng bộ định dạng đã giữ');
  assert.ok(context.formatVnMoney.format, 'bộ định dạng tạo một lần');
});
