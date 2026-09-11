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
