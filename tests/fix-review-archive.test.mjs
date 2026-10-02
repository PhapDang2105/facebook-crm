// fix-review (02/10) lỗi 3 + 4:
// 3) Lần đọc kho lưu trữ landing ĐẦU TIÊN (bộ nhớ đệm còn trống) chạy song song với lần chuyển đơn quá trần có thể
//    đọc tệp tháng trước lần ghi → đơn vừa chuyển vắng khỏi báo cáo tới khi khởi động lại. Nay lần đọc đi qua hàng ghi.
// 4) /api/customer-orders (bảng Đơn hàng) chỉ lấy đơn ở kho chính; báo cáo/Tổng quan/Chiến dịch vẫn gồm lưu trữ.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tempDir } from './helpers/temp-dir.mjs';

const directory = tempDir('fix-review-archive-');
process.env.LANDING_ORDERS_PATH = path.join(directory, 'landing-orders.json');
process.env.ORDER_ARCHIVE_PATH = path.join(directory, 'order-archive');
process.env.PHONE_WARNINGS_PATH = path.join(directory, 'phone-warnings.json');
process.env.POS_CONFIG_PATH = path.join(directory, 'pos-config.json');
process.env.ADDRESS_AI_CACHE_PATH = path.join(directory, 'address-ai-cache.json');
delete process.env.LANDING_ARCHIVE_PATH;

const appDirectory = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'app');
const archiveDirectory = path.join(directory, 'landing-orders-archive');
const at = month => Date.UTC(2026, month - 1, 15, 3, 0);
const order = (id, month, extra = {}) => ({ id, phone: '0911000001', createdAt: at(month), total: 100000, source: 'Landing page', products: [], landing: {}, ...extra });

// Kho có sẵn trước khi "khởi động": 3 đơn ở kho chính, kho lưu trữ đã có vài tháng (lần đọc đầu phải đọc nhiều tệp).
writeFileSync(process.env.LANDING_ORDERS_PATH, JSON.stringify({ orders: [order('A3', 9), order('A2', 8), order('A1', 1)], recent: [] }));
mkdirSync(archiveDirectory, { recursive: true });
for (const month of [1, 2, 3, 4, 5, 6]) {
  const many = Array.from({ length: 200 }, (_, index) => order(`OLD-${month}-${index}`, month, { note: 'x'.repeat(200) }));
  writeFileSync(path.join(archiveDirectory, `2026-0${month}.json`), JSON.stringify({ orders: many }));
}

const { listLandingOrders, updateLandingStore, readLandingStore, setLandingActiveLimitForTest, LANDING_ACTIVE_LIMIT } = await import('../app/landing-orders.mjs');

test('lỗi 3: lần đọc kho lưu trữ đầu tiên trùng lúc chuyển đơn quá trần — không thiếu, không trùng đơn', async () => {
  await readLandingStore();
  setLandingActiveLimitForTest(2);
  try {
    // Cùng lúc: một lần ghi làm kho quá trần (A1 tháng 1 bị chuyển sang 2026-01.json) và lần liệt kê đầu tiên.
    const writing = updateLandingStore(store => { store.orders.unshift(order('NEW', 10)); });
    const listing = listLandingOrders();
    const [, listed] = await Promise.all([writing, listing]);
    const ids = listed.map(item => item.id);
    assert.equal(new Set(ids).size, ids.length, 'không trùng đơn');
    assert.ok(ids.includes('A1') && ids.includes('A2'), 'đơn vừa chuyển sang kho lưu trữ vẫn được liệt kê');
    assert.equal(listed.length, 4 + 6 * 200);
    // Các lần sau (đã nạp bộ nhớ đệm) cũng thấy đủ: trước đây đơn chuyển lúc đang nạp vắng tới khi khởi động lại.
    const again = (await listLandingOrders()).map(item => item.id);
    assert.ok(again.includes('A1') && again.includes('A2'));
    assert.equal(again.length, 4 + 6 * 200);
    assert.equal(new Set(again).size, again.length);
    const store = await readLandingStore();
    assert.deepEqual(store.orders.map(item => item.id), ['NEW', 'A3'], 'kho chính giữ đúng trần');
    const january = JSON.parse(readFileSync(path.join(archiveDirectory, '2026-01.json'), 'utf8')).orders;
    assert.ok(january.some(item => item.id === 'A1'));
    assert.equal(january.length, 201, 'tệp tháng cũ không bị ghi đè');
    // Chỉ kho chính (bảng Đơn hàng).
    assert.deepEqual((await listLandingOrders({ includeArchived: false })).map(item => item.id), ['NEW', 'A3']);
  } finally {
    setLandingActiveLimitForTest(LANDING_ACTIVE_LIMIT);
  }
});

test('lỗi 3 (đọc mã): readArchivedLandingOrders nạp kho lưu trữ bên trong hàng ghi', () => {
  const source = readFileSync(path.join(appDirectory, 'landing-orders.mjs'), 'utf8');
  const body = source.slice(source.indexOf('function readArchivedLandingOrders()'), source.indexOf('// ===== Xác thực ====='));
  assert.match(body, /return enqueueWrite\(async \(\) => \{/);
  assert.ok(body.indexOf('enqueueWrite(') < body.indexOf('readdir('), 'đọc thư mục lưu trữ nằm trong việc của hàng ghi');
});

test('lỗi 4 (đọc mã): /api/customer-orders chỉ lấy đơn landing ở kho chính; báo cáo, Tổng quan, Chiến dịch giữ cả lưu trữ', () => {
  const server = readFileSync(path.join(appDirectory, 'server.mjs'), 'utf8');
  const start = server.indexOf("url.pathname === '/api/customer-orders') {");
  assert.ok(start > 0);
  const route = server.slice(start, server.indexOf('sendJsonWithEtag', start));
  assert.match(route, /listLandingOrders\(\{ includeArchived: false \}\)/);
  assert.doesNotMatch(route, /listLandingOrders\(\)/);
  for (const file of ['reports.mjs', 'dashboard.mjs', 'campaigns.mjs']) {
    const source = readFileSync(path.join(appDirectory, file), 'utf8');
    assert.match(source, /listLandingOrders\(\)/, `${file} vẫn đọc cả kho lưu trữ`);
    assert.doesNotMatch(source, /includeArchived: false/, file);
  }
});
