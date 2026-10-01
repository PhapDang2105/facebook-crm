import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// Kho nhân sự tạm (kịch bản "production đang có Nhân sự có mật khẩu"): không đụng dữ liệu thật.
process.env.STAFF_PATH = path.join(mkdtempSync(path.join(tmpdir(), 'crm-sec-staff-')), 'staff.json');

const {
  HTML_CSP, allowedWithoutLoginSetup, createLogLimiter, debugFlagOn, installConsoleRedaction,
  loginGate, loginSetupPage, redactSecrets, safeNextPath, securityHeaders
} = await import('../app/security.mjs');
const { loginRequired } = await import('../app/config.mjs');
const { createAuth, hashPassword, isPublicPath } = await import('../app/auth.mjs');
const { staffLoginAccounts } = await import('../app/staff.mjs');
const { AI_KEY_REENTRY_ERROR, aiKeyReentryError, mergeChatbotSettingsPatch, normalizeChatbotSettings } = await import('../app/chatbot-settings.mjs');

const server = await readFile(new URL('../app/server.mjs', import.meta.url), 'utf8');

/* ---- 2. Fail-closed khi chưa có tài khoản ---- */

test('bắt buộc đăng nhập: https (máy chủ thật) hoặc CRM_REQUIRE_LOGIN=1; local http thì không; =0 tắt hẳn', () => {
  assert.equal(loginRequired({}, 'https://fb.giotnang.vn'), true);
  assert.equal(loginRequired({}, 'http://localhost:8080'), false);
  assert.equal(loginRequired({ CRM_REQUIRE_LOGIN: '1' }, 'http://localhost:8080'), true);
  assert.equal(loginRequired({ CRM_REQUIRE_LOGIN: 'true' }, 'http://localhost:8080'), true);
  assert.equal(loginRequired({ CRM_REQUIRE_LOGIN: '0' }, 'https://tunnel.example'), false);
});

test('cổng đăng nhập: chưa có tài khoản + bắt buộc → 503 (trừ webhook/QR/ảnh/privacy/health); local thì mở', () => {
  assert.equal(loginGate({ enabled: false, required: false }), 'open');
  assert.equal(loginGate({ enabled: false, required: true }), 'setup-required');
  assert.equal(loginGate({ enabled: true, required: true }), 'auth');
  assert.equal(loginGate({ enabled: true, required: false }), 'auth');
  for (const pathname of ['/api/health', '/privacy', '/q/the-01', '/product-images/a.png', '/assets/fonts/Roboto-Bold.ttf'])
    assert.equal(allowedWithoutLoginSetup(pathname), true, pathname);
  assert.equal(allowedWithoutLoginSetup('/webhooks/pancake', { isWebhook: true }), true);
  for (const pathname of ['/', '/index.html', '/app.js', '/api/customers', '/api/staff', '/api/auth/login', '/login', '/api/chatbot/settings'])
    assert.equal(allowedWithoutLoginSetup(pathname), false, pathname);
  assert.match(loginSetupPage(), /Chưa cấu hình đăng nhập/);
});

test('production hiện tại (staff.json có mật khẩu) KHÔNG bị khoá nhầm: đăng nhập bật, cổng = auth', async () => {
  writeFileSync(process.env.STAFF_PATH, JSON.stringify({ items: [
    { id: 'st_1', name: 'Quản trị', username: 'admin1', role: 'admin', active: true, passwordHash: await hashPassword('mat-khau-dai') },
    { id: 'st_2', name: 'Đã nghỉ', username: 'nghi', role: 'staff', active: false, passwordHash: await hashPassword('mat-khau-dai') }
  ] }));
  const users = new Map(await staffLoginAccounts());
  assert.deepEqual([...users.keys()], ['admin1']);
  const auth = createAuth({ users, secret: 's' });
  assert.equal(auth.enabled, true);
  assert.equal(loginGate({ enabled: auth.enabled, required: loginRequired({}, 'https://fb.giotnang.vn') }), 'auth');
  // Kho hỏng: staffLoginAccounts NÉM (server giữ danh sách cũ) thay vì trả rỗng (= tắt đăng nhập).
  writeFileSync(process.env.STAFF_PATH, '{hỏng');
  await assert.rejects(staffLoginAccounts());
});

test('server: cổng 503 + làm mới Nhân sự chạy đầu handleAuth; kho Nhân sự lỗi thì giữ danh sách cũ', () => {
  const handle = server.slice(server.indexOf('async function handleAuth('), server.indexOf("if (url.pathname === '/api/auth/session' && request.method === 'GET')"));
  assert.match(handle, /await refreshLoginUsersIfStale\(\)/);
  assert.match(handle, /loginGate\(\{ enabled: auth\.enabled, required: authConfig\.requireLogin \}\) === 'setup-required' && !allowedWithoutLoginSetup\(/);
  assert.match(handle, /sendJson\(response, 503/);
  assert.match(handle, /response\.writeHead\(503/);
  const refresh = server.slice(server.indexOf('async function refreshLoginUsers('), server.indexOf('const auth = createAuth('));
  assert.match(refresh, /staffLoginAccounts\(\)/);
  assert.doesNotMatch(refresh, /staffLoginUsers\(\)/, 'staffLoginUsers nuốt lỗi → trả rỗng → tắt đăng nhập');
  assert.match(refresh, /LOGIN_USERS_CACHE_MS = 15 \* 1000/);
});

/* ---- 6. Open redirect ---- */

test('safeNextPath (máy chủ) và safeNext (web/login.js) cho cùng kết quả, chặn open redirect', async () => {
  const source = await readFile(new URL('../web/login.js', import.meta.url), 'utf8');
  const safeNext = new Function(`${source.slice(source.indexOf('function safeNext('), source.indexOf('function nextPath('))}; return safeNext;`)();
  const cases = ['/', '/?view=orders', '/#settings', '/a/b?c=%2F', '//evil.example', '/\\evil', '/\t/evil.example', '/%09/evil.example',
    '/%0a/evil', '/%2f%2fevil', '/%5c/evil', 'https://evil.example', 'javascript:alert(1)', 'evil', '', null, undefined, '/x y', '/\u0000x', '/ '];
  for (const value of cases) assert.equal(safeNext(value), safeNextPath(value), JSON.stringify(value));
  for (const bad of ['//evil.example', '/\\evil', '/\t/evil.example', '/%09/evil.example', '/%2f%2fevil', 'https://evil.example', 'javascript:alert(1)'])
    assert.equal(safeNextPath(bad), '/', bad);
  assert.equal(safeNextPath('/?view=orders'), '/?view=orders');
  // Máy chủ chuyển người đã đăng nhập khỏi /login bằng safeNextPath, không dùng ?next= thô.
  assert.match(server, /Location: safeNextPath\(url\.searchParams\.get\('next'\)\)/);
});

/* ---- 7. Header bảo mật ---- */

test('header bảo mật: nosniff, DENY, same-origin; HSTS chỉ khi https', () => {
  assert.deepEqual(securityHeaders({ https: false }), { 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'same-origin' });
  assert.match(securityHeaders({ https: true })['Strict-Transport-Security'], /^max-age=\d{7,}/);
  const handler = server.slice(server.indexOf('const server = http.createServer('));
  const headersAt = handler.indexOf('applySecurityHeaders(response, { https: authConfig.https })');
  assert.ok(headersAt > 0 && headersAt < handler.indexOf('isSafeRequestTarget(request.url)'), 'đặt header trước mọi phản hồi (kể cả 400 đường dẫn xấu)');
});

test('CSP cho trang HTML: không script nội tuyến trong web/, chặn nhúng khung; trang đệm QR không bị gắn', async () => {
  assert.match(HTML_CSP, /script-src 'self'(;|$)/);
  assert.doesNotMatch(HTML_CSP, /script-src[^;]*unsafe/);
  assert.match(HTML_CSP, /frame-ancestors 'none'/);
  assert.match(HTML_CSP, /object-src 'none'/);
  for (const name of ['index.html', 'login.html', 'privacy.html']) {
    const html = await readFile(new URL(`../web/${name}`, import.meta.url), 'utf8');
    assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)[^>]*>/i, `${name}: có <script> nội tuyến → CSP sẽ chặn`);
    assert.doesNotMatch(html, /\son[a-z]+\s*=\s*["']/i, `${name}: có thuộc tính onclick=… → CSP sẽ chặn`);
    assert.doesNotMatch(html, /<script[^>]*src=["']https?:/i, `${name}: script ngoài`);
  }
  for (const name of ['app.js', 'login.js', 'staff.js', 'audit.js']) {
    const js = await readFile(new URL(`../web/${name}`, import.meta.url), 'utf8');
    assert.doesNotMatch(js, /\beval\(|new Function\(|setTimeout\(\s*['"`]/, `${name}: eval/new Function bị CSP chặn`);
    assert.doesNotMatch(js, /\son(?:click|load|error|change|submit|input)=["']/i, `${name}: HTML sinh ra có onclick=…`);
  }
  const serve = server.slice(server.indexOf('async function serveFile('), server.indexOf('await initializeStore();'));
  assert.match(serve, /if \(path\.extname\(filePath\) === '\.html'\) headers\['Content-Security-Policy'\] = HTML_CSP;/);
});

/* ---- 8. keep-alive sau Caddy ---- */

test('server: keepAliveTimeout 65 s, headersTimeout 66 s (lớn hơn keepalive 60 s của Caddy)', async () => {
  assert.match(server, /server\.keepAliveTimeout = 65000;/);
  assert.match(server, /server\.headersTimeout = 66000;/);
  const caddy = await readFile(new URL('../deploy/Caddyfile', import.meta.url), 'utf8');
  assert.match(caddy, /keepalive 60s/);
});

/* ---- 9. Log không lộ token ---- */

test('che bí mật trong log: access_token, page_access_token, api_key, token, Bearer', () => {
  const line = redactSecrets('GET https://graph.facebook.com/v23.0/me?fields=id&access_token=EAAB123abc&x=1 và https://pos.pages.fm/api/v1/shops?api_key=k-123 /webhooks/landing?token=bi-mat page_access_token=pat.9 Authorization: Bearer ya29.a0AfH6SMBxyz');
  for (const secret of ['EAAB123abc', 'k-123', 'bi-mat', 'pat.9', 'ya29.a0AfH6SMBxyz']) assert.ok(!line.includes(secret), secret);
  assert.match(line, /access_token=\*\*\*&x=1/);
  assert.match(line, /api_key=\*\*\*/);
  assert.match(line, /\?token=\*\*\*/);
  assert.match(line, /Bearer \*\*\*/);
  assert.equal(redactSecrets('Đồng bộ 12 hội thoại (page 1234)'), 'Đồng bộ 12 hội thoại (page 1234)', 'dòng thường giữ nguyên');
});

test('installConsoleRedaction: log của mọi mô-đun (cả Error kèm URL) đi qua bộ che; cài một lần', () => {
  const written = [];
  const fake = { log: (...args) => written.push(args.join(' ')), warn: (...args) => written.push(args.join(' ')), error: (...args) => written.push(args.join(' ')) };
  installConsoleRedaction(fake);
  installConsoleRedaction(fake);
  fake.log('Gọi %s', 'https://x.example/a?access_token=SECRET1');
  fake.error('Lỗi:', new Error('fetch https://pos.example/api?api_key=SECRET2 failed'));
  fake.warn({ url: '/webhooks/pancake?token=SECRET3' });
  assert.equal(written.length, 3);
  assert.ok(written.every(text => !/SECRET\d/.test(text)), written.join('\n'));
  assert.match(written[0], /^Gọi https:\/\/x\.example\/a\?access_token=\*\*\*$/);
  assert.match(server, /^installConsoleRedaction\(console\);$/m);
});

test('cờ chẩn đoán WEBHOOK_DEBUG_KEYS / PANCAKE_DEBUG_KEYS: mặc định tắt, chỉ "1" mới bật, có giới hạn tần suất', async () => {
  assert.equal(debugFlagOn('PANCAKE_DEBUG_KEYS', {}), false);
  assert.equal(debugFlagOn('PANCAKE_DEBUG_KEYS', { PANCAKE_DEBUG_KEYS: '0' }), false, 'trước đây "0" cũng bật');
  assert.equal(debugFlagOn('PANCAKE_DEBUG_KEYS', { PANCAKE_DEBUG_KEYS: '1' }), true);
  let clock = 0;
  const allowed = createLogLimiter({ max: 3, windowMs: 1000, now: () => clock });
  assert.deepEqual([allowed(), allowed(), allowed(), allowed()], [true, true, true, false]);
  clock = 1000;
  assert.equal(allowed(), true, 'sang phút mới thì ghi tiếp');
  assert.match(server, /if \(debugFlagOn\('PANCAKE_DEBUG_KEYS'\) && pancakeDebugAllowed\(\)\) console\.log\(describePancakePayload\(payload\)\);/);
  assert.doesNotMatch(server, /if \(process\.env\.PANCAKE_DEBUG_KEYS\)/);
  const webhook = await readFile(new URL('../app/meta-webhook.mjs', import.meta.url), 'utf8');
  assert.match(webhook, /debugFlagOn\('WEBHOOK_DEBUG_KEYS'\) && webhookDebugAllowed\(\)/);
  assert.doesNotMatch(webhook, /const shape = process\.env\.WEBHOOK_DEBUG_KEYS/);
});

/* ---- 4. Chặn trộm khóa AI ---- */

test('khóa AI: đổi endpoint (khác host hay khác đường dẫn) mà không nhập lại khóa → từ chối; giữ endpoint thì không hỏi lại', () => {
  const current = normalizeChatbotSettings({ provider: 'custom', directEndpoint: 'https://api.deepseek.com/chat/completions', directApiKey: 'sk-that', systemPrompt: 'x' });
  const next = patch => normalizeChatbotSettings({ ...mergeChatbotSettingsPatch(current, patch), directApiKey: current.directApiKey });
  const attack = { directEndpoint: 'https://ke-trom.example/v1/chat/completions' };
  assert.equal(aiKeyReentryError(current, next(attack), attack), AI_KEY_REENTRY_ERROR);
  const samehostOtherPath = { directEndpoint: 'https://api.deepseek.com/khac/chat/completions' };
  assert.equal(aiKeyReentryError(current, next(samehostOtherPath), samehostOtherPath), AI_KEY_REENTRY_ERROR);
  const blank = { directEndpoint: '' };
  // Endpoint trống rơi về endpoint mặc định của nhà cung cấp: khác endpoint cũ thì cũng phải nhập lại khóa.
  assert.equal(aiKeyReentryError(current, next(blank), blank), next(blank).directEndpoint === current.directEndpoint ? '' : AI_KEY_REENTRY_ERROR);
  const withKey = { ...attack, directApiKey: 'sk-moi' };
  assert.equal(aiKeyReentryError(current, next(withKey), withKey), '', 'nhập khóa mới cho endpoint mới thì được');
  for (const harmless of [{ systemPrompt: 'đổi prompt' }, { directEndpoint: 'https://api.deepseek.com/chat/completions' }, { directModel: 'deepseek-chat' }])
    assert.equal(aiKeyReentryError(current, next(harmless), harmless), '', JSON.stringify(harmless));
  const noKey = normalizeChatbotSettings({ provider: 'custom', directEndpoint: 'https://api.deepseek.com/chat/completions', systemPrompt: 'x' });
  assert.equal(aiKeyReentryError(noKey, next(attack), attack), '', 'chưa có khóa thì không có gì để lộ');
});

test('server: PUT /api/chatbot/settings kiểm khóa AI TRƯỚC khi ghi, sau chốt quản lý', () => {
  const route = server.slice(server.indexOf("if (request.method === 'PUT' && url.pathname === '/api/chatbot/settings') {"), server.indexOf("url.pathname === '/api/chatbot/master-switch'"));
  const guard = route.indexOf('await requireManager(request, response)');
  const check = route.indexOf('aiKeyReentryError(current, normalizeChatbotSettings(');
  const write = route.indexOf('await writeChatbotSettings(');
  assert.ok(guard > 0 && guard < check && check < write, `${guard} < ${check} < ${write}`);
  assert.match(route, /if \(keyReentryError\) return sendJson\(response, 400, \{ error: keyReentryError \}\);/);
});

/* ---- 10. Caddyfile khớp production ---- */

test('deploy/Caddyfile: không còn basic_auth, có header bảo mật, vẫn che ?token= trong log', async () => {
  const caddy = await readFile(new URL('../deploy/Caddyfile', import.meta.url), 'utf8');
  const code = caddy.split('\n').filter(line => !line.trim().startsWith('#')).join('\n');
  assert.doesNotMatch(code, /basic_auth|basicauth|<BCRYPT_HASH>|<USERNAME>/);
  for (const header of ['Strict-Transport-Security', 'X-Content-Type-Options', 'X-Frame-Options', 'Referrer-Policy']) assert.match(code, new RegExp(header));
  assert.match(code, /reverse_proxy 127\.0\.0\.1:8080/);
  assert.match(code, /flush_interval -1/);
  assert.match(code, /delete token/);
  const setup = await readFile(new URL('../deploy/setup-server.sh', import.meta.url), 'utf8');
  assert.doesNotMatch(setup, /caddy hash-password|<BCRYPT_HASH>/);
});

test('đường công khai không đổi: /login, webhook, QR, ảnh, privacy; còn lại cần phiên', () => {
  for (const pathname of ['/login', '/api/auth/login', '/q/abc', '/product-images/a.png', '/privacy'])
    assert.equal(isPublicPath(pathname), true, pathname);
  for (const pathname of ['/', '/api/staff', '/api/chatbot/settings'])
    assert.equal(isPublicPath(pathname), false, pathname);
});
