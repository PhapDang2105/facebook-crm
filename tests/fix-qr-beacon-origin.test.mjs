import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// 02/10: trang đệm QR đặt Referrer-Policy no-referrer nên beacon POST /q/<mã>/open mang `Origin: null`
// và bị luật chống CSRF trả 403 (Caddy ghi 403, log không bao giờ có "QR: bấm nút") → số "Mở Messenger" = 0.
test('beacon mở Messenger của trang đệm QR được miễn luật Origin; các lệnh ghi khác vẫn bị kiểm', () => {
  const source = readFileSync(new URL('../app/server.mjs', import.meta.url), 'utf8').replace(/\r/g, '');
  const pattern = source.match(/const isQrBeacon = request\.method === 'POST' && (\/.+?\/)\.test\(url\.pathname\);/);
  assert.ok(pattern, 'thiếu khai báo isQrBeacon');
  assert.match(source, /if \(!isWebhook && !isQrBeacon && isCrossSiteWrite\(request\)\)/);
  const beacon = new RegExp(pattern[1].slice(1, -1));
  assert.equal(beacon.test('/q/tmdt-01/open'), true);
  for (const path of ['/q/tmdt-01', '/q/tmdt-01/open/x', '/api/qr/codes', '/api/q/x/open', '/q//open']) assert.equal(beacon.test(path), false, path);
});
