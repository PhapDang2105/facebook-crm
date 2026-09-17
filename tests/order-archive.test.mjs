import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Kho đặt ở thư mục tạm để kiểm thử không đụng data/processed.
const directory = mkdtempSync(path.join(os.tmpdir(), 'crm-archive-'));
process.env.ORDER_ARCHIVE_PATH = directory;
process.on('exit', () => rmSync(directory, { recursive: true, force: true }));

const { appendOrderToArchive, archiveRecord, readOrderArchive } = await import('../app/order-archive.mjs');

const order = (extra = {}) => ({
  id: 'LP-abc12345',
  createdAt: Date.parse('2026-09-16T03:00:00Z'),
  source: 'Landing page',
  name: 'Nguyễn Văn A',
  phone: '0912345678',
  address: '12 Lê Lợi, Phường Bến Nghé, Quận 1, TP Hồ Chí Minh',
  products: [{ name: 'Granola Túi Xanh 450g', sku: 'GRA-XANH-Z450', quantity: 2, price: 174000, paidPrice: 149000 }],
  total: 298000,
  ...extra
});

test('dòng lưu trữ chỉ giữ phần cần tra lại và dùng giá khách trả', () => {
  const record = archiveRecord(order());
  assert.deepEqual(record.items, [['GRA-XANH-Z450', 2, 149000]]);
  assert.equal(record.src, 'LP');
  assert.equal(record.phone, '0912345678');
  assert.equal(record.total, 298000);
  // Nhẹ: một đơn một dòng, dưới 300 byte.
  assert.ok(JSON.stringify(record).length < 300, 'dòng lưu trữ phải gọn');
});

test('ghi thêm dòng cho cùng một đơn thì bản sau cùng thắng', async () => {
  await appendOrderToArchive(order());
  await appendOrderToArchive(order({ name: 'Nguyễn Văn A (đã gọi)' }), { status: 'cancelled' });
  const { items, total } = await readOrderArchive({});
  assert.equal(total, 1, 'một mã đơn chỉ còn một bản');
  assert.equal(items[0].name, 'Nguyễn Văn A (đã gọi)');
  assert.equal(items[0].st, 'cancelled', 'đơn khách hủy vẫn giữ đủ dữ liệu');
});

test('đơn đã xóa vẫn tra lại được, tìm theo tên, số, địa chỉ hay SKU', async () => {
  await appendOrderToArchive(order({ id: 'CB-999', phone: '0909000111', name: 'Trần Thị B', source: 'Facebook' }), { status: 'deleted' });
  assert.equal((await readOrderArchive({ query: '0909000111' })).items[0].st, 'deleted');
  assert.equal((await readOrderArchive({ query: 'tran thi b' })).total, 1, 'tìm không dấu vẫn ra');
  assert.equal((await readOrderArchive({ query: 'GRA-XANH-Z450' })).total, 2);
  assert.equal((await readOrderArchive({ query: 'Bến Nghé' })).total, 2);
  assert.equal((await readOrderArchive({ query: 'không có ai' })).total, 0);
});

test('đơn thiếu mã hoặc số điện thoại thì không ghi, kho trống đọc ra rỗng', async () => {
  assert.equal(await appendOrderToArchive({ id: '', phone: '0912345678' }), null);
  assert.equal(await appendOrderToArchive({ id: 'LP-x', phone: '' }), null);
  process.env.ORDER_ARCHIVE_PATH = path.join(directory, 'chua-co');
  const fresh = await import(`../app/order-archive.mjs?fresh=${Date.now()}`);
  assert.deepEqual(await fresh.readOrderArchive({}), { items: [], total: 0 });
  process.env.ORDER_ARCHIVE_PATH = directory;
});
