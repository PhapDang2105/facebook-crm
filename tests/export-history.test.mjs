import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const directory = mkdtempSync(path.join(tmpdir(), 'export-history-'));
process.env.EXPORT_HISTORY_PATH = path.join(directory, 'export-history.json');
process.env.EXPORT_FILES_DIR = path.join(directory, 'exports');
const { exportHistoryTtlMs, listExports, readExportFile, recordExport } = await import('../app/export-history.mjs');

test('ghi lần xuất kèm tệp, liệt kê mới nhất trước, tải lại được tệp', async () => {
  const now = Date.UTC(2026, 8, 19, 5, 0);
  const first = await recordExport({ day: '2026-09-19', orders: 27, rows: 60, fileName: 'don-hang-2026-09-19.xlsx', buffer: Buffer.from('PK-first') }, now);
  const second = await recordExport({ day: '2026-09-18', orders: 12, rows: 20, skippedInvalid: 1, fileName: 'don-hang-2026-09-18.xlsx', buffer: Buffer.from('PK-second') }, now + 60000);
  assert.deepEqual([first.orders, first.rows, first.hasFile], [27, 60, true]);
  const items = await listExports(now + 120000);
  assert.deepEqual(items.map(item => [item.day, item.orders, item.skippedInvalid]), [['2026-09-18', 12, 1], ['2026-09-19', 27, 0]]);
  assert.ok(!('file' in items[0]), 'đường dẫn tệp không lộ ra ngoài');
  const file = await readExportFile(second.id, now + 120000);
  assert.deepEqual([file.fileName, file.buffer.toString()], ['don-hang-2026-09-18.xlsx', 'PK-second']);
  assert.equal(await readExportFile('khong-co', now), null);
});

test('quá 14 ngày thì dòng và tệp tự biến mất', async () => {
  const now = Date.UTC(2026, 8, 19, 5, 0);
  const old = await recordExport({ day: '2026-09-01', orders: 3, rows: 3, fileName: 'cu.xlsx', buffer: Buffer.from('PK-old') }, now - exportHistoryTtlMs - 1000);
  assert.ok(existsSync(path.join(process.env.EXPORT_FILES_DIR, `${old.id}.xlsx`)));
  const items = await listExports(now + 200000);
  assert.ok(!items.some(item => item.id === old.id), 'dòng cũ bị bỏ');
  assert.equal(await readExportFile(old.id, now + 200000), null);
  assert.ok(!readdirSync(process.env.EXPORT_FILES_DIR).includes(`${old.id}.xlsx`), 'tệp cũ bị xoá');
});
