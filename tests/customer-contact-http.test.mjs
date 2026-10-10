// 10/10 (chủ shop): màn Khách hàng thêm cột "Liên hệ" (Chưa liên hệ / Đã gọi điện / Không gọi được / Đã gửi ưu đãi)
// và cột "Ghi chú". Chạy máy chủ thật trên kho tạm (quiet-console) và kiểm qua HTTP: chọn trạng thái, viết ghi chú,
// danh sách khách trả đúng, trạng thái lạ bị từ chối, nhật ký hoạt động ghi "Liên hệ khách: trước → sau".
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

mkdirSync(path.dirname(storePath), { recursive: true });
writeFileSync(storePath, JSON.stringify({
  conversations: [{
    id: 'p:1', pageId: 'p', psid: '1', name: 'Chị Ngọc', source: 'inbox', botEnabled: false, lastMessageAt: 1,
    customerOrders: [{ id: 'o1', createdAt: Date.now() - 86400000, phone: '0909000111', address: '12 Lê Lợi, Phường Bến Nghé, Quận 1, TP Hồ Chí Minh', total: 298000, products: [{ name: 'Granola Túi Xanh 450g', sku: 'GRA-XANH-Z450', quantity: 2 }] }]
  }],
  messages: { 'p:1': [] },
  commentIndex: {}
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
    META_APP_SECRET: 'customer-contact-secret',
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

test('cột Liên hệ và Ghi chú màn Khách hàng: lưu ở máy chủ, danh sách trả đúng, ghi nhật ký', { timeout: 30000 }, async () => {
  await waitForServer();
  const list = async () => (await (await fetch(`${baseUrl}/api/customers`)).json()).items;
  const [customer] = await list();
  assert.ok(customer, 'khách đã mua có trong danh sách');
  assert.equal(customer.contactStatus, undefined, 'chưa ai chọn');
  const contact = status => fetch(`${baseUrl}/api/customers/${encodeURIComponent(customer.id)}/contact`, json('PUT', { status }));

  const saved = await contact('called');
  assert.equal(saved.status, 200);
  const fresh = await saved.json();
  assert.equal(fresh.contactStatus, 'called');
  assert.ok(fresh.contactStatusAt > 0);
  assert.equal((await list())[0].contactStatus, 'called', 'danh sách thấy ngay, không đợi bộ nhớ tạm');

  const bad = await contact('blocked');
  assert.equal(bad.status, 400);
  assert.match((await bad.json()).error, /không hợp lệ/);
  assert.equal((await contact('called')).status, 200, 'chọn lại đúng trạng thái cũ: không lỗi');

  const note = await fetch(`${baseUrl}/api/customers/${encodeURIComponent(customer.id)}/notes`, json('POST', { text: 'Khách hẹn gọi lại thứ 2' }));
  assert.equal(note.status, 200);
  const shown = (await list())[0];
  assert.equal(shown.lastNote.text, 'Khách hẹn gọi lại thứ 2');
  assert.equal(shown.contactStatus, 'called', 'ghi chú không đụng trạng thái');

  assert.equal((await contact('none')).status, 200);
  assert.equal((await list())[0].contactStatus, undefined, 'về Chưa liên hệ');
  assert.equal((await fetch(`${baseUrl}/api/customers/khong-co/contact`, json('PUT', { status: 'called' }))).status, 404);

  await settle();
  const lines = auditLines().filter(line => line.action === 'customer.contact');
  assert.deepEqual(lines.map(line => line.summary), ['Liên hệ khách: Chưa liên hệ → Đã gọi điện.', 'Liên hệ khách: Đã gọi điện → Chưa liên hệ.'], 'chọn lại trạng thái cũ không ghi thêm dòng');
  assert.equal(lines[0].target.id, customer.id);
});
