// 03/10 (opt-server): chạy máy chủ thật (kho trong thư mục tạm của quiet-console) và kiểm vài lỗi đã sửa qua HTTP:
// B7 (/q/%E0 → trang báo, không JSON thô), B6 (HEAD không ghi nhật ký / "đã xem"), B4 (đếm hội thoại đổi của công tắc
// bot), C2 (PUT cài đặt và công tắc bot sát nhau không mất thay đổi).
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
const settingsPath = process.env.CHATBOT_SETTINGS_PATH;

mkdirSync(path.dirname(storePath), { recursive: true });
writeFileSync(storePath, JSON.stringify({
  conversations: [
    { id: 'p:1', pageId: 'p', psid: '1', name: 'Khách Một', botEnabled: false, lastMessageAt: 1 },
    { id: 'p:2', pageId: 'p', psid: '2', name: 'Khách Hai', botEnabled: false, lastMessageAt: 2 }
  ],
  messages: { 'p:1': [], 'p:2': [] },
  commentIndex: {}
}));
writeFileSync(settingsPath, JSON.stringify({ enabled: false, systemPrompt: 'prompt ban đầu' }));

const child = spawn(process.execPath, [path.join(projectRoot, 'app', 'server.mjs'), String(port)], {
  cwd: projectRoot,
  env: {
    ...process.env,
    NODE_TEST_CONTEXT: '',
    CRM_SKIP_ENV_FILE: '1',
    CRM_REQUIRE_LOGIN: '0',
    CRM_LOGIN_USERS: '',
    PUBLIC_BASE_URL: baseUrl,
    META_APP_SECRET: 'opt-server-secret',
    POS_SYNC_DISABLED: '1',
    PANCAKE_PAGE_ID: '',
    PANCAKE_PAGES: '',
    PANCAKE_PAGE_ACCESS_TOKEN: '',
    LANDING_WEBHOOK_TOKEN: '',
    META_ADS_SYNC_DISABLED: '1'
  },
  stdio: ['ignore', 'ignore', 'ignore']
});

async function waitForServer() {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try { if ((await fetch(`${baseUrl}/api/health`)).ok) return; } catch { /* đang khởi động */ }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Máy chủ không khởi động kịp.');
}

const auditLines = () => (existsSync(auditDir) ? readdirSync(auditDir).filter(name => name.endsWith('.jsonl')).flatMap(name => readFileSync(path.join(auditDir, name), 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line))) : []);
const settle = () => new Promise(resolve => setTimeout(resolve, 300));

test.after(() => { child.kill(); });

test('máy chủ chạy với kho tạm', { timeout: 20000 }, async () => {
  await waitForServer();
});

test('B7: /q/%E0 (mã hỏng) trả trang HTML báo mã sai, không phải JSON thô', async () => {
  const response = await fetch(`${baseUrl}/q/%E0`);
  assert.equal(response.status, 404);
  assert.match(response.headers.get('content-type'), /text\/html/);
  assert.match(await response.text(), /Mã QR/);
});

test('B6: HEAD không ghi nhật ký hoạt động và không ghi "ai đã xem"', async () => {
  const before = auditLines().length;
  const head = await fetch(`${baseUrl}/api/messaging/conversations/${encodeURIComponent('p:1')}/messages`, { method: 'HEAD' });
  assert.equal(head.status, 200);
  const report = await fetch(`${baseUrl}/api/reports/export.csv`, { method: 'HEAD' });
  assert.equal(report.status, 200);
  await settle();
  assert.equal(auditLines().length, before, 'HEAD không thêm dòng nhật ký');
  // GET thật thì vẫn ghi nhật ký tải CSV.
  await (await fetch(`${baseUrl}/api/reports/export.csv`)).text();
  await settle();
  assert.ok(auditLines().some(line => line.action === 'report.export'));
});

test('B4: công tắc bot đếm đúng số hội thoại thật sự đổi', async () => {
  const off = await (await fetch(`${baseUrl}/api/chatbot/master-switch`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: false }) })).json();
  assert.equal(off.conversations, 2);
  assert.equal(off.changed, 0, 'đã tắt sẵn cả hai: không hội thoại nào đổi');
  const on = await (await fetch(`${baseUrl}/api/chatbot/master-switch`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: true }) })).json();
  assert.equal(on.changed, 2);
});

test('C2: PUT cài đặt và công tắc bot gửi cùng lúc: cả hai thay đổi đều còn trong tệp', async () => {
  const put = fetch(`${baseUrl}/api/chatbot/settings`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ systemPrompt: 'prompt mới' }) });
  const toggle = fetch(`${baseUrl}/api/chatbot/master-switch`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: false }) });
  const [putResponse, toggleResponse] = await Promise.all([put, toggle]);
  assert.equal(putResponse.status, 200);
  assert.equal(toggleResponse.status, 200);
  const saved = JSON.parse(readFileSync(settingsPath, 'utf8'));
  assert.equal(saved.systemPrompt, 'prompt mới');
  assert.equal(saved.enabled, false);
  const read = await (await fetch(`${baseUrl}/api/chatbot/settings`)).json();
  assert.equal(read.systemPrompt, 'prompt mới');
});
