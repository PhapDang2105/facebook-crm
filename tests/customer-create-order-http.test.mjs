// 12/10 (chủ shop): nút "Tạo đơn" trong hộp chi tiết khách — nhân viên gọi điện xong lên đơn luôn. Khách KHÔNG có
// hội thoại (khách landing, khách tệp xuất kho) tạo qua POST /api/customers/:id/orders: đơn vào kho đơn không gắn hội
// thoại (kho landing), có trong bảng Đơn hàng, chống bấm đúp, ghi nhật ký; nút "Đẩy sang POS" tìm thấy đơn này.
// Chạy máy chủ thật trên kho tạm (quiet-console) và kiểm qua HTTP.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = 21000 + Math.floor(Math.random() * 20000);
const baseUrl = `http://127.0.0.1:${port}`;
const auditDir = process.env.AUDIT_LOG_DIR;
const storePath = process.env.META_CONVERSATIONS_PATH;
const landingPath = process.env.LANDING_ORDERS_PATH;

mkdirSync(path.dirname(storePath), { recursive: true });
mkdirSync(path.dirname(landingPath), { recursive: true });
writeFileSync(storePath, JSON.stringify({ conversations: [], messages: {}, commentIndex: {} }));
// Khách chỉ có một đơn landing cũ (không hội thoại) — như "Nghĩa Thành" trong ảnh chủ shop gửi.
writeFileSync(landingPath, JSON.stringify({
  orders: [{
    id: 'lp0001', name: 'Nghĩa Thành', phone: '0908527342', address: 'Ấp 4 Hiệp Phước, Nhơn Trạch, Đồng Nai',
    products: [{ name: 'Granola Túi Xanh 450g', sku: 'GRA-XANH-Z450', quantity: 1, price: 189000 }],
    total: 189000, status: 'Mới', source: 'Landing page', createdAt: Date.now() - 23 * 86400000,
    landing: { externalId: 'x1', page: 'giotnang.vn', campaign: '', posId: '9001' }
  }],
  recent: []
}));

const child = spawn(process.execPath, [path.join(projectRoot, 'app', 'server.mjs'), String(port)], {
  cwd: projectRoot,
  env: {
    ...process.env,
    NODE_TEST_CONTEXT: '',
    CRM_SKIP_ENV_FILE: '1',
    CRM_REQUIRE_LOGIN: '0',
    CRM_LOGIN_USERS: '',
    PUBLIC_BASE_URL: baseUrl,
    META_APP_SECRET: 'customer-order-secret',
    POS_SYNC_DISABLED: '1',
    PANCAKE_PAGE_ID: '',
    PANCAKE_PAGES: '',
    PANCAKE_PAGE_ACCESS_TOKEN: '',
    LANDING_WEBHOOK_TOKEN: '',
    META_ADS_SYNC_DISABLED: '1'
  },
  stdio: ['ignore', 'ignore', 'ignore']
});
test.after(() => { child.kill(); });

async function waitForServer() {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try { if ((await fetch(`${baseUrl}/api/health`)).ok) return; } catch { /* đang khởi động */ }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Máy chủ không khởi động kịp.');
}

const auditLines = () => (existsSync(auditDir) ? readdirSync(auditDir).filter(name => name.endsWith('.jsonl')).flatMap(name => readFileSync(path.join(auditDir, name), 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line))) : []);
const settle = () => new Promise(resolve => setTimeout(resolve, 300));
const json = (method, body) => ({ method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const draft = (overrides = {}) => ({
  id: '77777', name: 'Nghĩa Thành', phone: '0908527342', address: 'Ấp 4 Hiệp Phước, Nhơn Trạch, Đồng Nai',
  products: [{ name: 'Granola Túi Xanh 450g', sku: 'GRA-XANH-Z450', quantity: 2, price: 149000 }],
  source: 'Gọi điện', payment: 'COD', freeShipping: true, shippingFee: 0, discount: 0, total: 298000, note: 'Gọi trước khi giao',
  ...overrides
});

test('tạo đơn từ hồ sơ khách không có hội thoại: lưu kho đơn, hiện ở bảng Đơn hàng, chống bấm đúp, nhật ký, đẩy POS tìm được', { timeout: 30000 }, async () => {
  await waitForServer();
  const customerId = 'landing:0908527342';
  const create = (order, extra = {}) => fetch(`${baseUrl}/api/customers/${encodeURIComponent(customerId)}/orders`, json('POST', { order, ...extra }));

  const first = await create(draft());
  assert.equal(first.status, 201);
  const created = await first.json();
  assert.equal(created.createdOrderId, '77777');
  assert.equal(created.pos, null, 'chưa kết nối POS: không đẩy, không lỗi');
  assert.equal(created.order.source, 'Re-marketing');

  const stored = JSON.parse(readFileSync(landingPath, 'utf8')).orders.find(order => order.id === '77777');
  assert.ok(stored, 'đơn nằm ở kho đơn không gắn hội thoại');
  assert.equal(stored.landing, undefined, 'không phải đơn landing kéo từ POS');
  assert.equal(stored.customerId, customerId);
  assert.equal(stored.status, 'Mới');
  assert.equal(stored.total, 298000);
  assert.equal(stored.history?.[0]?.action, 'order.create');
  assert.match(stored.history[0].summary, /^Tạo đơn từ hồ sơ khách: 2 Granola Túi Xanh 450g, tổng 298\.000đ\.$/);

  const table = await (await fetch(`${baseUrl}/api/customer-orders`)).json();
  assert.ok(table.items.some(order => order.id === '77777' && order.conversationId === ''), 'bảng Đơn hàng có đơn mới');

  // Bấm đúp (cùng SĐT, cùng giỏ, cùng tổng trong 2 phút) → 409 hỏi lại; đồng ý thì tạo đơn mã khác.
  const again = await create(draft({ id: '77778' }));
  assert.equal(again.status, 409);
  const conflict = await again.json();
  assert.equal(conflict.duplicate, true);
  assert.equal(conflict.duplicateOrderId, '77777');
  const forced = await create(draft({ id: '77777' }), { force: true });
  assert.equal(forced.status, 201);
  assert.notEqual((await forced.json()).createdOrderId, '77777', 'mã trùng được thêm hậu tố');

  // Quà đơn gọi điện nhân viên chọn (giftOverride): món có mã POS + món chưa có mã → chữ quà dựng từ danh sách,
  // bảng Đơn hàng có ghi chú "chưa có mã POS … nhân viên thêm trên POS".
  const withGift = await create(draft({
    id: '77790', products: [{ name: 'Granola Túi Vàng 350g', sku: 'GRA-VANG-H350', quantity: 2, price: 149000 }],
    giftOverride: [{ name: 'Túi Granola Nâu', sku: 'GRA-NAU-Z350', quantity: 1, weight: 400 }, { name: 'Tâm Lành', sku: '', quantity: 2, weight: 0 }]
  }));
  assert.equal(withGift.status, 201);
  const giftOrder = (await (await fetch(`${baseUrl}/api/customer-orders`)).json()).items.find(order => order.id === '77790');
  assert.equal(giftOrder.gift, 'Miễn phí vận chuyển + Túi Granola Nâu + 2 Tâm Lành');
  assert.deepEqual(giftOrder.giftOverride.map(item => [item.sku, item.quantity]), [['GRA-NAU-Z350', 1], ['', 2]]);
  assert.ok(giftOrder.processingNotes.some(note => /chưa có mã POS: 2 Tâm Lành/.test(note)));

  assert.equal((await create(draft({ products: [] }))).status, 400, 'đơn không sản phẩm bị từ chối');
  assert.equal((await fetch(`${baseUrl}/api/customers/landing%3A0999999999/orders`, json('POST', { order: draft() }))).status, 404);

  // "Đẩy sang POS" ở bảng Đơn hàng: tìm thấy đơn (không còn "không tìm thấy trong hội thoại nào"), báo chưa kết nối POS.
  const push = await fetch(`${baseUrl}/api/customer-orders/77777/pos`, { method: 'POST' });
  assert.equal(push.status, 400);
  assert.match((await push.json()).error, /Chưa kết nối Pancake POS/);
  // Đơn landing kéo từ POS không đi đường này.
  assert.equal((await fetch(`${baseUrl}/api/customer-orders/lp0001/pos`, { method: 'POST' })).status, 404);

  await settle();
  const lines = auditLines().filter(line => line.action === 'order.create');
  assert.equal(lines.length, 3);
  assert.match(lines[0].summary, /^Tạo đơn #77777 cho Nghĩa Thành từ hồ sơ khách: 2 Granola Túi Xanh 450g, tổng 298\.000đ\.$/);
});
