import test from 'node:test';
import assert from 'node:assert/strict';
import { ACTOR_CACHE_MS, MANAGER_ONLY_ERROR, actorOf, actorStamp, clearActorCache, clientIp, createRequireManager, isManager } from '../app/request-actor.mjs';

const request = ({ forwarded = '', remote = '127.0.0.1', user = '' } = {}) => ({
  headers: forwarded ? { 'x-forwarded-for': forwarded } : {},
  socket: { remoteAddress: remote },
  user
});
// auth giả: phiên lấy từ request.user (như cookie đã giải).
const auth = { enabled: true, session: req => (req.user ? { username: req.user } : null) };
const envLoginUsers = new Map([['huy', 'scrypt$x$y']]);

test('chưa bật đăng nhập: người "Không đăng nhập", vai trò anonymous (được xem nhật ký như quản trị)', async () => {
  const actor = await actorOf(request({ forwarded: '9.9.9.9' }), { auth: { enabled: false, session: () => ({ username: '' }) }, envLoginUsers });
  assert.deepEqual(actor, { username: '', name: 'Không đăng nhập', role: 'anonymous', roleName: 'Không đăng nhập', ip: '9.9.9.9' });
  assert.equal(isManager(actor), true);
});

test('chủ shop .env: role owner, roleName "Chủ shop", tên = tên đăng nhập', async () => {
  const actor = await actorOf(request({ user: 'huy' }), { auth, envLoginUsers, staffLookup: () => assert.fail('chủ shop không tra Nhân sự') });
  assert.deepEqual(actor, { username: 'huy', name: 'huy', role: 'owner', roleName: 'Chủ shop', ip: '127.0.0.1' });
  assert.equal(isManager(actor), true);
});

test('nhân viên: họ tên + vai trò từ Nhân sự, nhớ 30 giây; clearActorCache tra lại ngay', async () => {
  clearActorCache();
  let calls = 0;
  let member = { username: 'hang', name: 'Thúy Hằng', role: 'staff', roleName: 'Nhân viên' };
  const staffLookup = async username => { calls += 1; return username === 'hang' ? member : null; };
  const first = await actorOf(request({ user: 'hang' }), { auth, envLoginUsers, staffLookup, now: 1000 });
  assert.deepEqual(first, { username: 'hang', name: 'Thúy Hằng', role: 'staff', roleName: 'Nhân viên', ip: '127.0.0.1' });
  assert.equal(isManager(first), false);
  member = { ...member, name: 'Hằng', role: 'admin', roleName: 'Quản trị' };
  const cached = await actorOf(request({ user: 'hang' }), { auth, envLoginUsers, staffLookup, now: 1000 + ACTOR_CACHE_MS - 1 });
  assert.equal(cached.name, 'Thúy Hằng', 'trong 30 giây dùng bản nhớ');
  assert.equal(calls, 1);
  const refreshed = await actorOf(request({ user: 'hang' }), { auth, envLoginUsers, staffLookup, now: 1000 + ACTOR_CACHE_MS });
  assert.deepEqual([refreshed.name, refreshed.role, refreshed.roleName], ['Hằng', 'admin', 'Quản trị']);
  assert.equal(isManager(refreshed), true);
  assert.equal(calls, 2);
  member = { ...member, name: 'Hằng (mới)' };
  clearActorCache();
  assert.equal((await actorOf(request({ user: 'hang' }), { auth, envLoginUsers, staffLookup, now: 1000 + ACTOR_CACHE_MS })).name, 'Hằng (mới)');
});

test('phiên còn mà người không còn trong Nhân sự: giữ tên đăng nhập, vai trò nhân viên (không được quyền quản trị)', async () => {
  clearActorCache();
  const actor = await actorOf(request({ user: 'lan' }), { auth, envLoginUsers, staffLookup: async () => null });
  assert.deepEqual([actor.username, actor.name, actor.role], ['lan', 'lan', 'staff']);
  assert.equal(isManager(actor), false);
  const failing = await actorOf(request({ user: 'minh' }), { auth, envLoginUsers, staffLookup: async () => { throw new Error('hỏng đĩa'); } });
  assert.equal(failing.role, 'staff', 'lỗi đọc Nhân sự không làm hỏng request');
});

test('ip: X-Forwarded-For chỉ tin khi kết nối từ loopback (Caddy), lấy địa chỉ CUỐI; actorStamp chỉ giữ username + name', () => {
  // Caddy ghi địa chỉ thật của máy nối vào nó ở CUỐI chuỗi; phần đầu do khách tự khai (giả được).
  assert.equal(clientIp(request({ forwarded: ' 6.6.6.6 , 203.0.113.5' })), '203.0.113.5');
  assert.equal(clientIp(request({ forwarded: '203.0.113.5', remote: '::1' })), '203.0.113.5');
  assert.equal(clientIp(request({ forwarded: '203.0.113.5', remote: '::ffff:127.0.0.1' })), '203.0.113.5');
  assert.equal(clientIp(request({ remote: '::1' })), '::1');
  // Gọi thẳng cổng CRM từ máy khác: header bị bỏ qua, không né được khoá đăng nhập theo IP.
  assert.equal(clientIp(request({ forwarded: '1.2.3.4', remote: '198.51.100.7' })), '198.51.100.7');
  assert.equal(clientIp(request({ forwarded: '127.0.0.1', remote: '198.51.100.7' })), '198.51.100.7');
  assert.deepEqual(actorStamp({ username: 'hang', name: 'Thúy Hằng', role: 'staff', ip: '1.1.1.1' }), { username: 'hang', name: 'Thúy Hằng' });
  assert.deepEqual(actorStamp({ username: '', name: '' }), { username: '', name: 'Không đăng nhập' });
});

test('đăng nhập BẬT mà request không có phiên: vai trò guest, KHÔNG được coi là quản lý', async () => {
  const actor = await actorOf(request({}), { auth, envLoginUsers });
  assert.equal(actor.role, 'guest');
  assert.equal(isManager(actor), false);
});

test('requireManager: nhân viên thường bị 403 (tự trả lời), chủ shop / Quản trị / CRM chưa bật đăng nhập thì qua', async () => {
  const sent = [];
  const send = (response, status, body) => sent.push({ response, status, body });
  const guardFor = role => createRequireManager(async () => ({ username: 'x', role }), send);
  for (const role of ['owner', 'admin', 'anonymous']) {
    assert.equal(await guardFor(role)({}, 'res'), true, role);
  }
  assert.equal(sent.length, 0);
  for (const role of ['staff', 'guest', '', undefined]) {
    assert.equal(await guardFor(role)({}, 'res'), false, String(role));
  }
  assert.equal(sent.length, 4);
  assert.deepEqual(sent[0], { response: 'res', status: 403, body: { error: MANAGER_ONLY_ERROR } });
  assert.equal((await (async () => { sent.length = 0; await guardFor('staff')({}, 'r', 'Thông báo riêng'); return sent[0].body.error; })()), 'Thông báo riêng');
});
