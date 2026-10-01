import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createAuth, hashPassword, isPublicPath, parseUsers, verifyPassword, SESSION_COOKIE } from '../app/auth.mjs';

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
  const server = await readFile(new URL('../app/server.mjs', import.meta.url), 'utf8');
  const gate = server.indexOf('if (await handleAuth(request, response, url, isWebhook)) return;');
  assert.ok(gate > server.indexOf('isSafeRequestTarget(request.url)'));
  assert.ok(gate < server.indexOf("url.pathname === '/api/health'"));
  assert.ok(gate < server.indexOf('const qrBrandFiles'));
});

test('login.js: ?next= chỉ nhận đường dẫn nội bộ', async () => {
  const source = await readFile(new URL('../web/login.js', import.meta.url), 'utf8');
  const pattern = new RegExp(source.match(/return (\/\^.+?\/)\.test\(next\)/)[1].slice(1, -1));
  assert.equal(pattern.test('/?view=orders'), true);
  for (const bad of ['//evil.example', '/\\evil.example', 'https://evil.example']) assert.equal(pattern.test(bad), false, bad);
});
