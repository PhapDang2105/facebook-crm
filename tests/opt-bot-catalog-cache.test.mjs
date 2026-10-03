// Tối ưu chatbot (P2/P12): matchProduct dùng chỉ mục dựng một lần cho mỗi danh mục đã nạp; reloadCatalog làm mới chỉ mục.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync, writeFileSync } from 'node:fs';
import './helpers/seed-catalog.mjs';
import * as catalog from '../app/processing/catalog.mjs';

test('P2: matchProduct theo tên gọi/SKU ổn định qua nhiều lần gọi', () => {
  const first = catalog.matchProduct('cho mình 2 túi xanh');
  assert.ok(first, 'túi xanh');
  for (let index = 0; index < 5; index += 1) assert.equal(catalog.matchProduct('cho mình 2 túi xanh'), first);
  assert.equal(catalog.matchProduct(first.sku), first);
  assert.equal(catalog.matchProduct(first.sku.toLowerCase()), first);
  assert.equal(catalog.matchProduct(''), null);
  assert.equal(catalog.matchProduct('xin chào shop'), null);
});

test('P2: sửa danh mục + reloadCatalog → chỉ mục mới (tên gọi mới khớp, sản phẩm tắt không khớp)', () => {
  const original = readFileSync(process.env.PRODUCTS_PATH, 'utf8');
  try {
    const before = catalog.matchProduct('túi xanh');
    const products = JSON.parse(original);
    const target = products.items.find(item => item.sku === before.sku);
    target.aliases = [...(target.aliases || []), 'zebra granola thu nghiem'];
    writeFileSync(process.env.PRODUCTS_PATH, JSON.stringify(products));
    catalog.reloadCatalog();
    assert.equal(catalog.matchProduct('lấy zebra granola thu nghiem nha')?.sku, before.sku);
    target.active = false;
    writeFileSync(process.env.PRODUCTS_PATH, JSON.stringify(products));
    catalog.reloadCatalog();
    assert.notEqual(catalog.matchProduct('lấy zebra granola thu nghiem nha')?.sku, before.sku);
    assert.equal(catalog.matchProduct(before.sku), null);
  } finally {
    writeFileSync(process.env.PRODUCTS_PATH, original);
    catalog.reloadCatalog();
  }
});

test('P12: parseGiftSwapChoice cho cùng kết quả khi gọi lặp (mẫu dùng chung)', () => {
  const swap = catalog.getGiftSwap();
  if (!swap?.options?.length) return;
  const label = swap.options[0].label;
  const once = catalog.parseGiftSwapChoice(`2 gói ${label}`, swap);
  assert.ok(once.length > 0);
  assert.deepEqual(catalog.parseGiftSwapChoice(`2 gói ${label}`, swap), once);
  assert.deepEqual(catalog.parseGiftSwapChoice('cảm ơn shop', swap).filter(option => option.label === 'Cam'), []);
});
