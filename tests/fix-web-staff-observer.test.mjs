import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Kiểm thử giao diện 02/10: nhân viên thường mở Cài đặt → Nhân sự làm trình duyệt gọi GET /api/staff
// ~100 lần/giây — bộ theo dõi lớp của bảng gọi load() mỗi khi BẤT KỲ lớp nào đổi, mà app.js thêm lại lớp
// is-staff-readonly sau mỗi lần vẽ. Chỉ được tải khi bảng chuyển từ ẩn sang hiện.
test('Nhân sự: bộ theo dõi chỉ tải danh sách khi bảng chuyển từ ẩn sang hiện', () => {
  const source = readFileSync(new URL('../web/staff.js', import.meta.url), 'utf8').replace(/\r/g, '');
  const observer = source.slice(source.indexOf('new MutationObserver'));
  assert.match(observer, /if \(wasHidden && !hidden\) load\(\);\n\s+wasHidden = hidden;/);
  assert.doesNotMatch(observer, /if \(!panel\.classList\.contains\('hidden'\)\) load\(\); \}\)/);
  // Mô phỏng: lớp khác đổi 50 lần khi bảng đang hiện → không tải lại; ẩn rồi hiện → tải đúng một lần.
  let loads = 0; let hiddenNow = false; let wasHidden = hiddenNow;
  const onMutation = () => { const hidden = hiddenNow; if (wasHidden && !hidden) loads += 1; wasHidden = hidden; };
  for (let i = 0; i < 50; i += 1) onMutation();
  assert.equal(loads, 0);
  hiddenNow = true; onMutation(); hiddenNow = false; onMutation(); onMutation();
  assert.equal(loads, 1);
});
