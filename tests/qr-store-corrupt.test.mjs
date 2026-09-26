// Kho lượt quét / cài đặt QR hỏng (ghi dở, không phải JSON object) phải được
// cất sang .corrupt-<mốc> rồi bắt đầu kho mới — không âm thầm đè mất số liệu.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const directory = mkdtempSync(path.join(tmpdir(), 'qr-corrupt-'));
process.env.QR_SCANS_PATH = path.join(directory, 'qr-scans.json');
process.env.QR_SETTINGS_PATH = path.join(directory, 'qr-settings.json');
writeFileSync(process.env.QR_SCANS_PATH, '{"codes": {"tmdt-01": {"code":"tmdt-01","scans":7', 'utf8');
writeFileSync(process.env.QR_SETTINGS_PATH, '[]', 'utf8');

const originalError = console.error;
const errors = [];
console.error = (...parts) => errors.push(parts.join(' '));

const { listQrScans, registerQrCode } = await import('../app/qr-scans.mjs');
const { readQrSettings, writeQrSettings } = await import('../app/qr-settings.mjs');

test('kho lượt quét hỏng: cách ly nguyên văn sang .corrupt-*, kho mới rỗng, ghi tiếp không đụng bản cách ly', async () => {
  assert.deepEqual((await listQrScans()).codes, []);
  const quarantined = readdirSync(directory).filter(name => name.startsWith('qr-scans.json.corrupt-'));
  assert.equal(quarantined.length, 1);
  assert.match(readFileSync(path.join(directory, quarantined[0]), 'utf8'), /"scans":7$/, 'giữ nguyên nội dung hỏng để còn cứu');
  assert.ok(errors.some(line => /Kho lượt quét QR hỏng/.test(line)));
  await registerQrCode('tmdt-02');
  assert.equal(JSON.parse(readFileSync(process.env.QR_SCANS_PATH, 'utf8')).codes['tmdt-02'].code, 'tmdt-02');
  assert.equal(readdirSync(directory).filter(name => name.startsWith('qr-scans.json.corrupt-')).length, 1);
});

test('cài đặt QR không phải object JSON: cách ly, dùng mặc định, lưu lại được', async () => {
  assert.deepEqual(await readQrSettings(), { zaloUrl: '', prefillText: '', updatedAt: 0 });
  assert.equal(readdirSync(directory).filter(name => name.startsWith('qr-settings.json.corrupt-')).length, 1);
  assert.ok(errors.some(line => /Cài đặt mã QR hỏng/.test(line)));
  assert.equal((await writeQrSettings({ zaloUrl: 'https://zalo.me/g/abc' })).zaloUrl, 'https://zalo.me/g/abc');
  console.error = originalError;
});
