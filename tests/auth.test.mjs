import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { LOGIN_LIMITS, accountOf, createAttemptLimiter, createAuth, hashPassword, isPublicPath, parseUsers, verifyPassword, SESSION_COOKIE } from '../app/auth.mjs';

const requestWith = cookie => ({ headers: cookie ? { cookie } : {} });
const tokenFrom = setCookie => setCookie.split(';')[0];

test('auth: băm scrypt khớp đúng mật khẩu, chuỗi hỏng thì từ chối', async () => {
  const hash = await hashPassword('mat-khau-dai');
  assert.match(hash, /^scrypt\$[\w-]+\$[\w-]+$/);
  assert.equal(await verifyPassword('mat-khau-dai', hash), true);
  assert.equal(await verifyPassword('sai', hash), false);
  assert.equal(await verifyPassword('x', 'md5$abc'), false);
});

test('auth: CRM_LOGIN_USERS tách theo dấu phẩy, tên không phân biệt hoa thường', () => {
  const users = parseUsers(' Huy:scrypt$a$b , lan:scrypt$c$d,hong,');
  assert.deepEqual([...users.keys()], ['huy', 'lan']);
  assert.equal(users.get('huy'), 'scrypt$a$b');
});

test('auth: chưa khai tài khoản thì không hỏi đăng nhập', () => {
  const auth = createAuth();
  assert.equal(auth.enabled, false);
  assert.deepEqual(auth.session(requestWith('')), { username: '' });
});

test('auth: đăng nhập đúng cấp cookie HttpOnly dùng được, sai mật khẩu thì 401', async () => {
  const users = new Map([['huy', await hashPassword('mat-khau-dai')]]);
  const auth = createAuth({ users, secret: 's', secure: true });
  assert.equal(auth.session(requestWith('')), null);
  const wrong = await auth.login({ username: 'huy', password: 'sai-roi' });
  assert.equal(wrong.status, 401);
  const unknown = await auth.login({ username: 'ai-do', password: 'mat-khau-dai' });
  assert.equal(unknown.error, wrong.error, 'không lộ tên tài khoản nào có thật');
  const ok = await auth.login({ username: ' HUY ', password: 'mat-khau-dai' });
  assert.equal(ok.ok, true);
  assert.match(ok.cookie, new RegExp(`^${SESSION_COOKIE}=.+; Path=/; HttpOnly; SameSite=Lax; Max-Age=\\d+; Secure$`));
  assert.deepEqual(auth.session(requestWith(`theme=dark; ${tokenFrom(ok.cookie)}`)), { username: 'huy' });
  assert.match(auth.logoutCookie(), /Max-Age=0/);
});

test('auth: cookie bị sửa, hết hạn, ký khoá khác hay sau khi đổi mật khẩu đều vô hiệu', async () => {
  let clock = 1_000_000;
  const users = new Map([['huy', await hashPassword('mat-khau-dai')]]);
  const auth = createAuth({ users, secret: 's', now: () => clock });
  const cookie = tokenFrom((await auth.login({ username: 'huy', password: 'mat-khau-dai' })).cookie);
  assert.ok(auth.session(requestWith(cookie)));
  assert.equal(auth.session(requestWith(cookie.replace(/.$/, c => (c === 'A' ? 'B' : 'A')))), null);
  assert.equal(createAuth({ users, secret: 'khac' }).session(requestWith(cookie)), null);
  const renewed = createAuth({ users: new Map([['huy', await hashPassword('mat-khau-moi')]]), secret: 's', now: () => clock });
  assert.equal(renewed.session(requestWith(cookie)), null, 'đổi mật khẩu thì phiên cũ hết hiệu lực');
  clock += 31 * 86400000;
  assert.equal(auth.session(requestWith(cookie)), null);
});

test('auth: sai 10 lần trong 15 phút thì khoá theo địa chỉ', async () => {
  const users = new Map([['huy', await hashPassword('mat-khau-dai')]]);
  const auth = createAuth({ users, secret: 's' });
  for (let index = 0; index < 10; index += 1) await auth.login({ username: 'huy', password: 'sai', clientId: '1.2.3.4' });
  assert.equal((await auth.login({ username: 'huy', password: 'mat-khau-dai', clientId: '1.2.3.4' })).status, 429);
  assert.equal((await auth.login({ username: 'huy', password: 'mat-khau-dai', clientId: '5.6.7.8' })).ok, true);
});

test('auth: chỉ trang đăng nhập, QR, ảnh sản phẩm, chính sách và health đi thẳng', () => {
  for (const pathname of ['/login', '/login.css', '/login.js', '/api/auth/login', '/api/health', '/privacy', '/q/abc', '/product-images/a.png', '/assets/fonts/Roboto-Bold.ttf', '/assets/login/hero.webp'])
    assert.equal(isPublicPath(pathname), true, pathname);
  for (const pathname of ['/', '/index.html', '/app.js', '/api/customers', '/api/messaging/stream', '/assets/icons/settings.png', '/qx', '/login/../app.js'])
    assert.equal(isPublicPath(pathname), false, pathname);
});

test('server: chặn đăng nhập chạy trước mọi route, sau bước chặn đường dẫn "//"', async () => {
  const server = (await readFile(new URL('../app/server.mjs', import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
  const gate = server.indexOf('if (await handleAuth(request, response, url, isWebhook)) return;');
  assert.ok(gate > server.indexOf('isSafeRequestTarget(request.url)'));
  assert.ok(gate < server.indexOf("url.pathname === '/api/health'"));
  assert.ok(gate < server.indexOf('const qrBrandFiles'));
});

test('login.js: ?next= chỉ nhận đường dẫn nội bộ (kể cả /%09/…, //…, /\\…)', async () => {
  const source = (await readFile(new URL('../web/login.js', import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
  const body = source.slice(source.indexOf('function safeNext('), source.indexOf('function nextPath('));
  const safeNext = new Function(`${body}; return safeNext;`)();
  for (const good of ['/', '/?view=orders', '/#settings', '/orders/123?tab=a%2Fb']) assert.equal(safeNext(good), good, good);
  for (const bad of ['//evil.example', '/\\evil.example', '/\tevil', '/\t/evil.example', '/\n/evil.example', '/%09/evil.example', '/%2F/evil.example', '/%5Cevil.example',
    'https://evil.example', 'javascript:alert(1)', ' /x', '', null, '/ /evil'])
    assert.equal(safeNext(bad), '/', JSON.stringify(bad));
});

test('auth: yêu cầu song song không vượt được khoá — đếm (giữ chỗ) TRƯỚC khi chờ scrypt', async () => {
  const users = new Map([['huy', await hashPassword('mat-khau-dai')]]);
  const auth = createAuth({ users, secret: 's' });
  const results = await Promise.all(Array.from({ length: 40 }, () => auth.login({ username: 'huy', password: 'doan-mo', clientId: '9.9.9.9' })));
  assert.equal(results.filter(item => item.status === 401).length, LOGIN_LIMITS.perIp, 'chỉ đúng 10 lần được chấm mật khẩu');
  assert.equal(results.filter(item => item.status === 429).length, 40 - LOGIN_LIMITS.perIp);
  assert.equal((await auth.login({ username: 'huy', password: 'mat-khau-dai', clientId: '9.9.9.9' })).status, 429, 'đúng mật khẩu cũng chờ hết khoá');
});

test('auth: khoá theo tên đăng nhập — đổi IP liên tục cũng chỉ được 20 lần / 15 phút', async () => {
  let clock = 5_000_000;
  const users = new Map([['huy', await hashPassword('mat-khau-dai')]]);
  const auth = createAuth({ users, secret: 's', now: () => clock });
  const attempts = await Promise.all(Array.from({ length: 30 }, (_, index) => auth.login({ username: 'HUY', password: 'sai', clientId: `10.0.0.${index}` })));
  assert.equal(attempts.filter(item => item.status === 401).length, LOGIN_LIMITS.perUser);
  assert.equal((await auth.login({ username: 'huy', password: 'mat-khau-dai', clientId: '10.9.9.9' })).status, 429);
  assert.equal((await auth.login({ username: 'lan', password: 'x', clientId: '10.9.9.9' })).status, 401, 'tên khác không bị vạ lây');
  clock += LOGIN_LIMITS.windowMs;
  assert.equal((await auth.login({ username: 'huy', password: 'mat-khau-dai', clientId: '10.9.9.9' })).ok, true, 'hết 15 phút thì mở');
});

test('auth: đăng nhập đúng chỉ trả lại lượt vừa giữ, không xoá các lần sai trước', async () => {
  const limiter = createAttemptLimiter({ max: 3, windowMs: 1000, now: () => 0 });
  assert.equal(limiter.reserve('a'), true);
  assert.equal(limiter.reserve('a'), true);
  limiter.release('a');
  assert.equal(limiter.count('a'), 1);
  assert.equal(limiter.reserve('a') && limiter.reserve('a'), true);
  assert.equal(limiter.reserve('a'), false);
  assert.equal(limiter.blocked('a'), true);
});

test('auth: phiên mang sessionVersion — tăng phiên bản (đổi mật khẩu / cho nghỉ) là phiên cũ vô hiệu', async () => {
  const hash = await hashPassword('mat-khau-dai');
  const users = new Map([['hang', { hash, version: 2 }], ['huy', hash]]);
  const auth = createAuth({ users, secret: 's' });
  const cookie = tokenFrom((await auth.login({ username: 'hang', password: 'mat-khau-dai' })).cookie);
  assert.deepEqual(auth.session(requestWith(cookie)), { username: 'hang' });
  users.set('hang', { hash, version: 3 });
  assert.equal(auth.session(requestWith(cookie)), null, 'cùng mật khẩu nhưng phiên bản mới → phiên cũ hết hiệu lực');
  users.delete('hang');
  users.set('hang', { hash, version: 2 });
  assert.ok(auth.session(requestWith(cookie)), 'phiên bản khớp lại thì còn (dùng cho hiểu cơ chế)');
  users.delete('hang');
  assert.equal(auth.session(requestWith(cookie)), null, 'không còn trong danh sách (nghỉ) → hết phiên');
  // Tài khoản .env (chuỗi băm trơn) và cookie cũ không có "v" vẫn dùng được sau khi nâng cấp.
  const owner = tokenFrom((await auth.login({ username: 'huy', password: 'mat-khau-dai' })).cookie);
  assert.deepEqual(auth.session(requestWith(owner)), { username: 'huy' });
  assert.deepEqual(accountOf('scrypt$a$b'), { hash: 'scrypt$a$b', version: 0 });
  assert.deepEqual(accountOf({ hash: 'h', version: '4' }), { hash: 'h', version: 4 });
});
