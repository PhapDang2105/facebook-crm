import test from 'node:test';
import assert from 'node:assert/strict';
import { assertUniqueSku, normalizeProduct, normalizeProductStore } from '../app/products.mjs';

test('chuẩn hóa dữ liệu sản phẩm dùng chung', () => {
  const product = normalizeProduct({
    name: '  Granola   Xanh  ',
    sku: ' gn-xanh-01 ',
    originalPrice: '120000',
    salePrice: 99000
  });
  assert.equal(product.name, 'Granola Xanh');
  assert.equal(product.sku, 'GN-XANH-01');
  assert.equal(product.originalPrice, 120000);
  assert.equal(product.salePrice, 99000);
});

test('không cho phép trùng SKU, không phân biệt chữ hoa thường', () => {
  const products = [{ id: 'one', sku: 'GN-01' }];
  assert.throws(() => assertUniqueSku(products, 'gn-01'), /đã tồn tại/);
  assert.doesNotThrow(() => assertUniqueSku(products, 'gn-01', 'one'));
});

test('loại bỏ bản ghi sản phẩm không hợp lệ khi đọc kho dữ liệu', () => {
  const store = normalizeProductStore({ items: [
    { id: 'one', name: 'Hợp lệ', sku: 'SP-01' },
    { id: '', name: 'Thiếu ID', sku: 'SP-02' }
  ] });
  assert.equal(store.items.length, 1);
});

test('thư viện ảnh gửi khách: chỉ giữ đường dẫn đã lưu, không trùng, tối đa 12', () => {
  const product = normalizeProduct({ name: 'Granola', sku: 'GN', images: ['/product-images/a-1.png', '/product-images/a-1.png', 'data:image/png;base64,AAAA', 'https://evil.example/x.png', { url: '/product-images/b-2.jpg' }] });
  assert.deepEqual(product.images, ['/product-images/a-1.png', '/product-images/b-2.jpg']);
  const many = normalizeProduct({ name: 'Granola', sku: 'GN', images: Array.from({ length: 15 }, (_, index) => `/product-images/p-${index}.png`) });
  assert.equal(many.images.length, 12);
  assert.deepEqual(normalizeProduct({ name: 'Granola', sku: 'GN' }, { images: ['/product-images/keep-1.png'] }).images, ['/product-images/keep-1.png'], 'không gửi images thì giữ thư viện cũ');
});
