// 05/10: GET /api/messaging/search qua HTTP trên máy chủ thật (kho tạm của quiet-console): cần đăng nhập như các API hộp
// thư (chưa đăng nhập → 401), đăng nhập rồi thì tìm được SĐT trong tin cũ / chữ không dấu trên toàn bộ kho. Chỉ mục
// soát lại khi kho đổi: xem search-messages.test.mjs (không gửi webhook thật ở đây để không chạm mạng).
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hashPassword } from '../app/auth.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = 21000 + Math.floor(Math.random() * 20000);
const baseUrl = `http://127.0.0.1:${port}`;
const storePath = process.env.META_CONVERSATIONS_PATH;
const now = Date.now();
const DAY = 24 * 60 * 60 * 1000;

const oldMessages = [
  { id: 'm-0', direction: 'incoming', type: 'text', text: 'sdt e 0912 345 678', createdAt: now - 20 * DAY },
  { id: 'm-1', direction: 'incoming', type: 'text', text: 'Thôn Đông, xã Tân Tiến, huyện Văn Giang, tỉnh Hưng Yên', createdAt: now - 20 * DAY + 60000 },
  ...Array.from({ length: 150 }, (_, index) => ({ id: `m-${index + 2}`, direction: index % 2 ? 'outgoing' : 'incoming', type: 'text', text: `tin ${index}`, createdAt: now - 10 * DAY + index * 1000 }))
];
mkdirSync(path.dirname(storePath), { recursive: true });
writeFileSync(storePath, JSON.stringify({
  conversations: [
    { id: 'p:1', pageId: 'p', psid: '1', name: 'Khách Một', botEnabled: false, lastMessageAt: now - 10 * DAY + 150000 },
    { id: 'p:2', pageId: 'p', psid: '2', name: 'Khách Hai', botEnabled: false, lastMessageAt: now - DAY }
  ],
  messages: { 'p:1': oldMessages, 'p:2': [{ id: 'n-0', direction: 'incoming', type: 'text', text: 'hỏi giá', createdAt: now - DAY }] },
  commentIndex: {}
}));

const password = 'mat-khau-tim-kiem';
const child = spawn(process.execPath, [path.join(projectRoot, 'app', 'server.mjs'), String(port)], {
  cwd: projectRoot,
  env: {
    ...process.env,
    NODE_TEST_CONTEXT: '',
    CRM_SKIP_ENV_FILE: '1',
    CRM_LOGIN_USERS: `chu:${await hashPassword(password)}`,
    CRM_SESSION_SECRET: 'search-test-secret',
    PUBLIC_BASE_URL: baseUrl,
    META_APP_SECRET: 'search-test-secret',
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
  for (let attempt = 0; attempt < 150; attempt += 1) {
    try { if ((await fetch(`${baseUrl}/api/health`)).ok) return; } catch { /* đang khởi động */ }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Máy chủ không khởi động kịp.');
}

let cookie = '';
const search = (query, headers = { cookie }) => fetch(`${baseUrl}/api/messaging/search?q=${encodeURIComponent(query)}`, { headers });

test('máy chủ chạy, chưa đăng nhập → 401 (cùng quyền với xem hội thoại)', { timeout: 30000 }, async () => {
  await waitForServer();
  const anonymous = await search('0912345678', {});
  assert.equal(anonymous.status, 401);
  const conversations = await fetch(`${baseUrl}/api/messaging/conversations`);
  assert.equal(conversations.status, 401, 'API hộp thư cũng 401 — cùng một cổng');
  const login = await fetch(`${baseUrl}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'chu', password }) });
  assert.equal(login.status, 200);
  cookie = String(login.headers.get('set-cookie') || '').split(';')[0];
  assert.ok(cookie);
});

test('đăng nhập rồi: SĐT trong tin cũ (gõ có dấu chấm / +84 / 4 số cuối) và chữ không dấu', async () => {
  for (const query of ['0912.345.678', '+84 912 345 678', '5678']) {
    const response = await search(query);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.deepEqual(body.items.map(item => [item.id, item.reason, item.messageId]), [['p:1', 'phone', 'm-0']], query);
    assert.equal(body.items[0].position, 152);
    assert.equal(typeof body.tookMs, 'number');
  }
  const text = await (await search('tinh HUNG yen')).json();
  assert.deepEqual(text.items.map(item => [item.id, item.messageId]), [['p:1', 'm-1']]);
  assert.match(text.items[0].snippet, /Văn Giang, tỉnh Hưng Yên/);
  const empty = await (await search('')).json();
  assert.deepEqual(empty.items, []);
});
