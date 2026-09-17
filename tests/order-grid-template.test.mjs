// Bảng đơn hàng là một CSS grid, bề rộng cột do web/app.js sinh ra rồi đổ vào
// biến --preview-template. Chỉ cần một giá trị sai cú pháp là trình duyệt bỏ cả
// dòng grid-template-columns, bảng sập còn một cột và màn Đơn hàng coi như hỏng.
// Bài này canh đúng chỗ đó: fit-content() không được phép nằm trong minmax().
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../web/app.js', import.meta.url), 'utf8');

test('bề rộng cột bảng đơn hàng không dùng cú pháp grid sai', () => {
  const templates = [...source.matchAll(/'(?:dia chi|ghi chu|ghi chu xu ly|san pham|khach hang|so dien thoai)':\s*'([^']+)'/g)]
    .map(match => match[1]);
  assert.ok(templates.length >= 6, 'phải tìm thấy đủ các cột đã đặt bề rộng');
  for (const template of templates) {
    assert.doesNotMatch(
      template,
      /minmax\([^)]*fit-content\(/,
      `fit-content() không dùng được làm cận của minmax(): ${template}`
    );
    assert.match(
      template,
      /^(max-content|min-content|auto|fit-content\(\s*\d+(?:px|%)\s*\)|minmax\(\s*[^,]+,\s*[^)]+\s*\))$/,
      `giá trị bề rộng cột không hợp lệ: ${template}`
    );
  }
});
