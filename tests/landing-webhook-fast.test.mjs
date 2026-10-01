import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

// server.mjs khởi động máy chủ (đọc .env thật) ngay khi nạp, nên kiểm trên MÃ NGUỒN như audit-routes:
// webhook landing phải xác thực token, đọc thân, rồi trả 200 NGAY — tạo đơn (tự điền địa chỉ, tra cảnh
// báo SĐT trên POS, có thể > 5 giây) chạy ở nền. Trước 01/10 route chờ recordLandingOrder xong mới
// trả lời → Webcake thấy chậm hơn 5 giây và gửi lại.
const server = await readFile(new URL('../app/server.mjs', import.meta.url), 'utf8');

test('webhook landing: xác thực token trước, trả 200 trước khi tạo đơn, tạo đơn ở nền không chặn phản hồi', () => {
  const start = server.indexOf('if (url.pathname === landingConfig.path) {');
  assert.ok(start > 0, 'tìm thấy route landing');
  const block = server.slice(start, server.indexOf('\n    }', server.indexOf('processLandingWebhookInBackground(', start)) + 6);
  const tokenCheck = block.indexOf('isLandingTokenValid(');
  const reply = block.indexOf('sendJson(response, 200, { accepted: true, queued: true })');
  const background = block.indexOf('processLandingWebhookInBackground(payload, page)');
  assert.ok(tokenCheck > 0 && reply > tokenCheck, 'token được kiểm trước khi trả 200');
  assert.ok(background > reply, 'tạo đơn sau khi đã trả lời');
  assert.doesNotMatch(block, /await recordLandingOrder\(/, 'route không còn chờ tạo đơn');
  assert.doesNotMatch(block, /await processLandingWebhookInBackground/, 'không chờ việc nền');
  // Việc nền tự bắt lỗi (không thành promise bỏ rơi) và vẫn báo hộp thư khi có đơn.
  const helperStart = server.indexOf('function processLandingWebhookInBackground(');
  assert.ok(helperStart > 0);
  const body = server.slice(helperStart, server.indexOf('\n}', helperStart) + 2);
  assert.match(body, /recordLandingOrder\(payload, \{ page \}\)/);
  assert.match(body, /\.catch\(/);
  assert.match(body, /publishMessagingEvent\(\{ type: 'landing-order'/);
});
