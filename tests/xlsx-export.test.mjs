import test from 'node:test';
import assert from 'node:assert/strict';
import AdmZip from 'adm-zip';
import { buildPlainXlsx, excelColumnName } from '../app/xlsx-export.mjs';
import { parseXlsx } from '../app/xlsx-import.mjs';

test('XLSX thuần: tiêu đề in đậm, chữ có dấu và ký tự đặc biệt giữ nguyên, đọc lại được bằng bộ nhập', async () => {
  const headers = ['Nguồn đơn', 'Khách hàng', 'Ghi chú', 'Số lượng'];
  const rows = [['Landing page', 'Nguyễn Thị Hồng', 'Thiếu số nhà & phường "5" <trùng>', 2], ['Chatbot', 'Mai Thư', '', 1]];
  const buffer = buildPlainXlsx(headers, rows);
  const zip = new AdmZip(buffer);
  const sheet = zip.readAsText('xl/worksheets/sheet1.xml');
  assert.match(sheet, /<row r="1"><c r="A1" t="inlineStr" s="1">/);
  assert.match(sheet, /Thiếu số nhà &amp; phường &quot;5&quot; &lt;trùng&gt;/);
  assert.match(sheet, /<c r="D2"><v>2<\/v><\/c>/);
  assert.ok(zip.getEntry('[Content_Types].xml') && zip.getEntry('xl/styles.xml'));
  const parsed = await parseXlsx(buffer);
  assert.deepEqual(parsed.headers, headers);
  assert.equal(parsed.rows.length, 2);
  assert.equal(parsed.rows[0][1], 'Nguyễn Thị Hồng');
  assert.equal(excelColumnName(27), 'AB');
});
