// 03/10: bảng Nhân sự hiện 2 hàng tiêu đề — staff.js tự vẽ hàng tiêu đề, index.html không được có thêm hàng tĩnh.
// Bản sửa 9d6f38b từng bị mất khi gộp nhánh (0e82706); test này giữ cho nó không quay lại.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

test('bảng Nhân sự: index.html không có hàng tiêu đề tĩnh (staff.js tự vẽ)', () => {
  const html = readFileSync(new URL('../web/index.html', import.meta.url), 'utf8');
  const table = html.slice(html.indexOf('class="staff-table"'), html.indexOf('id="staff-rows"'));
  assert.doesNotMatch(table, /staff-table-head/);
  const script = readFileSync(new URL('../web/staff.js', import.meta.url), 'utf8');
  assert.match(script, /staff-table-head/, 'staff.js vẫn vẽ một hàng tiêu đề');
});
