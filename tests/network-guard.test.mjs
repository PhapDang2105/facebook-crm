import test from 'node:test';
import assert from 'node:assert/strict';
import { assertPublicHost, isInternalHost, isPrivateAddress } from '../app/network-guard.mjs';

test('địa chỉ nội bộ, loopback, link-local và metadata bị coi là riêng tư', () => {
  for (const address of ['127.0.0.1', '10.1.2.3', '172.16.0.9', '192.168.1.1', '169.254.169.254', '0.0.0.0', '100.64.0.1', '::1', '::ffff:127.0.0.1', 'fd00::1', 'fe80::1']) {
    assert.equal(isPrivateAddress(address), true, address);
  }
  for (const address of ['8.8.8.8', '203.0.113.7', '2606:4700::1111']) {
    assert.equal(isPrivateAddress(address), false, address);
  }
  assert.equal(isPrivateAddress('khong-phai-ip'), true, 'chuỗi lạ không được coi là công khai');
});

test('tên máy nội bộ bị chặn ngay theo tên', () => {
  for (const host of ['localhost', 'api.localhost', 'metadata.internal', 'nas.local', '[::1]', '127.0.0.1']) {
    assert.equal(isInternalHost(host), true, host);
  }
  assert.equal(isInternalHost('cdn.example.com'), false);
});

test('assertPublicHost tra DNS: tên miền công khai trỏ về IP nội bộ vẫn bị chặn', async () => {
  const lookupImpl = async host => (host === 'evil.example' ? [{ address: '203.0.113.5' }, { address: '127.0.0.1' }] : [{ address: '203.0.113.5' }]);
  assert.equal(await assertPublicHost('cdn.example', { lookupImpl }), 'cdn.example');
  await assert.rejects(assertPublicHost('evil.example', { lookupImpl }), /nội bộ/);
  await assert.rejects(assertPublicHost('169.254.169.254', { lookupImpl }), /nội bộ/);
  await assert.rejects(assertPublicHost('no-such.example', { lookupImpl: async () => { throw new Error('ENOTFOUND'); } }), /phân giải/);
  assert.equal(await assertPublicHost('cdn.example', { resolve: false }), 'cdn.example', 'không tra DNS khi resolve=false');
  await assert.rejects(assertPublicHost('localhost', { resolve: false }), /nội bộ/);
});
