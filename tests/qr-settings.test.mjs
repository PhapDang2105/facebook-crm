import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

process.env.QR_SETTINGS_PATH = path.join(mkdtempSync(path.join(tmpdir(), 'qr-settings-')), 'qr-settings.json');
const { isAllowedZaloUrl, readQrSettings, writeQrSettings } = await import('../app/qr-settings.mjs');

test('chỉ nhận liên kết https trên zalo.me / zaloapp.com — trang đệm là trang công khai', () => {
  assert.equal(isAllowedZaloUrl('https://zalo.me/0901234567'), true);
  assert.equal(isAllowedZaloUrl('https://zalo.me/g/abcdef123'), true);
  assert.equal(isAllowedZaloUrl('https://oa.zalo.me/xyz'), true);
  assert.equal(isAllowedZaloUrl('http://zalo.me/0901234567'), false, 'không http');
  assert.equal(isAllowedZaloUrl('https://zalo.me.evil.com/x'), false);
  assert.equal(isAllowedZaloUrl('https://evil.com/?u=zalo.me'), false);
  assert.equal(isAllowedZaloUrl('zalo.me/0901234567'), false, 'thiếu giao thức thì không đoán');
  assert.equal(isAllowedZaloUrl(''), false);
});

test('lưu, đọc lại, xoá; liên kết lạ bị từ chối với lời tiếng Việt', async () => {
  assert.equal((await readQrSettings()).zaloUrl, '');
  const saved = await writeQrSettings({ zaloUrl: ' https://zalo.me/g/abcdef123 ' });
  assert.equal(saved.zaloUrl, 'https://zalo.me/g/abcdef123');
  assert.equal((await readQrSettings()).zaloUrl, 'https://zalo.me/g/abcdef123');
  await assert.rejects(writeQrSettings({ zaloUrl: 'https://example.com/x' }), /zalo\.me/);
  assert.equal((await readQrSettings()).zaloUrl, 'https://zalo.me/g/abcdef123', 'lưu hỏng thì giữ giá trị cũ');
  assert.equal((await writeQrSettings({ zaloUrl: '' })).zaloUrl, '');
});
