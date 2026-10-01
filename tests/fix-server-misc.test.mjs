// Việc bổ sung 01/10 phía server: doanh thu sản phẩm không gồm ship, trạng thái đồng bộ Page Pancake,
// ETag nội dung, dấu vết máy bấm QR.
import test from 'node:test';
import assert from 'node:assert/strict';
import { orderFact } from '../app/order-facts.mjs';
import { notePancakePageSync, pancakeSyncStatusFor } from '../app/pancake.mjs';
import { contentEtag, etagMatches, qrVisitorKey } from '../app/server-helpers.mjs';

const order = (extra = {}) => ({ id: 'A1', createdAt: Date.UTC(2026, 9, 1), phone: '0912345678', total: 189000, shippingFee: 15000, products: [{ sku: 'GRA-XANH-Z450', name: 'Túi Xanh', quantity: 1, price: 174000 }], ...extra });

test('doanh thu theo sản phẩm chia tiền hàng (tổng − ship khách trả); tổng đơn giữ nguyên gồm ship', () => {
  const fact = orderFact(order());
  assert.equal(fact.total, 189000);
  assert.deepEqual(fact.products.map(line => line.revenue), [174000]);
  // Miễn ship: không trừ gì.
  assert.deepEqual(orderFact(order({ total: 174000, freeShipping: true })).products.map(line => line.revenue), [174000]);
  // Hai dòng: chia theo giá × số lượng trên phần tiền hàng, cộng lại đúng bằng tổng − ship.
  const two = orderFact(order({ total: 462000, shippingFee: 15000, products: [{ sku: 'X', quantity: 2, price: 149000 }, { sku: 'V', quantity: 1, price: 149000 }] }));
  assert.equal(two.products.reduce((sum, line) => sum + line.revenue, 0), 447000);
  // Phí ship lớn hơn tổng (dữ liệu lạ): không âm.
  assert.deepEqual(orderFact(order({ total: 10000, shippingFee: 30000 })).products.map(line => line.revenue), [0]);
});

test('trạng thái đồng bộ Page Pancake: lỗi khi không lấy được danh sách hay mọi hội thoại đều lỗi; lượt tốt xoá lỗi', () => {
  assert.equal(pancakeSyncStatusFor('p-new'), null);
  const ok = notePancakePageSync('p1', { attempted: 60, fetchedOk: 58, failures: ['c1: 404', 'c2: 500'] }, Date.UTC(2026, 9, 1, 3));
  assert.deepEqual(ok, { syncedAt: '2026-10-01T03:00:00.000Z', syncError: '', syncErrorAt: 0 });
  const listFailed = notePancakePageSync('p1', { listFailed: true, failures: ['p1 danh sách hội thoại: Pancake 401 token hết hạn'] }, Date.UTC(2026, 9, 1, 4));
  assert.equal(listFailed.syncedAt, '2026-10-01T03:00:00.000Z', 'giữ mốc lần tốt gần nhất');
  assert.equal(listFailed.syncErrorAt, Date.UTC(2026, 9, 1, 4));
  assert.match(listFailed.syncError, /không lấy được danh sách hội thoại \(Pancake 401 token hết hạn\)/);
  assert.match(notePancakePageSync('p1', { attempted: 3, fetchedOk: 0, failures: ['c1: fetch failed'] }).syncError, /3 hội thoại đều không tải được tin \(c1: fetch failed\)/);
  assert.equal(notePancakePageSync('p1', { attempted: 0, fetchedOk: 0 }).syncError, '', 'Page chưa có hội thoại nào không phải lỗi');
  assert.deepEqual(Object.keys(pancakeSyncStatusFor('p1')).sort(), ['syncError', 'syncErrorAt', 'syncedAt']);
});

test('ETag nội dung: cùng nội dung cùng thẻ; khớp W/, danh sách, *, hậu tố nén của proxy', () => {
  const etag = contentEtag('{"items":[]}');
  assert.match(etag, /^W\/"[A-Za-z0-9_-]+"$/);
  assert.equal(contentEtag('{"items":[]}'), etag);
  assert.notEqual(contentEtag('{"items":[1]}'), etag);
  const core = etag.slice(3, -1);
  for (const header of [etag, `"${core}"`, `W/"${core}-gzip"`, `"x", ${etag}`, '*', `W/"${core}-zstd"`]) assert.equal(etagMatches(header, etag), true, header);
  for (const header of ['', undefined, '"khac"', `W/"${core}x"`]) assert.equal(etagMatches(header, etag), false, String(header));
});

test('dấu vết máy bấm QR: ổn định trong tiến trình, khác theo IP/UA, không chứa IP', () => {
  const key = qrVisitorKey('1.2.3.4', 'Mozilla/5.0 iPhone');
  assert.equal(qrVisitorKey('1.2.3.4', 'Mozilla/5.0 iPhone'), key);
  assert.notEqual(qrVisitorKey('1.2.3.5', 'Mozilla/5.0 iPhone'), key);
  assert.notEqual(qrVisitorKey('1.2.3.4', 'Mozilla/5.0 Android'), key);
  assert.doesNotMatch(key, /1\.2\.3\.4/);
  assert.equal(key.length, 22);
});
