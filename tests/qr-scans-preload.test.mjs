import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Kho lớn để lượt đọc nạp sẵn lúc import còn đang chạy khi lượt tạo mã đầu tiên tới.
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'qr-preload-'));
const storePath = path.join(directory, 'qr-scans.json');
const codes = {};
for (let index = 0; index < 400; index += 1) {
  codes[`seed-${index}`] = { code: `seed-${index}`, scans: 0, opens: 0, firstAt: Date.now(), lastAt: Date.now(), platforms: {}, browsers: {}, modes: {}, days: {} };
}
fs.writeFileSync(storePath, JSON.stringify({ codes, recent: [] }));
process.env.QR_SCANS_PATH = storePath;

test('mã QR tạo ngay sau khi nạp module không bị lượt đọc nạp sẵn đè mất', async () => {
  const { registerQrCode, isKnownQrCode } = await import('../app/qr-scans.mjs?preload-race');
  await registerQrCode('ma-moi-1');
  // Chờ lượt đọc nạp sẵn chắc chắn xong; nếu nó đè kho trong bộ nhớ thì mã thứ hai ghi ra sẽ thiếu mã thứ nhất.
  await new Promise(resolve => setTimeout(resolve, 300));
  await registerQrCode('ma-moi-2');
  assert.equal(isKnownQrCode('ma-moi-1'), true);
  assert.equal(isKnownQrCode('seed-0'), true);
  const saved = JSON.parse(fs.readFileSync(storePath, 'utf8'));
  assert.ok(saved.codes['ma-moi-1'], 'mã tạo đầu tiên phải còn trong tệp');
  assert.ok(saved.codes['ma-moi-2']);
});
