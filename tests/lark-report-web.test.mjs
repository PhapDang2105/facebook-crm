import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const html = (await readFile(new URL('../web/index.html', import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
const web = (await readFile(new URL('../web/app.js', import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
const server = (await readFile(new URL('../app/server.mjs', import.meta.url), 'utf8')).replace(/\r\n/g, '\n');

test('Cài đặt có Báo cáo Lark sau Nhân sự, form dán hội thoại và nút gửi', () => {
  assert.match(html, /data-settings-section="staff">Nhân sự<\/button>\s*<button[^>]+data-settings-section="lark-report">Báo cáo Lark<\/button>\s*<button[^>]+data-settings-section="audit"/);
  const at = html.indexOf('data-settings-panel="lark-report"');
  assert.ok(at > 0);
  const panel = html.slice(at, at + 3000);
  assert.match(panel, /id="lark-report-title-input"[^>]+maxlength="120"/);
  assert.match(panel, /id="lark-report-conversation"[^>]+maxlength="12000"[^>]+required/);
  assert.match(panel, /id="lark-report-send"[^>]+type="submit">Gửi qua Lark/);
});

test('giao diện POST nội dung tới máy chủ, xóa form khi thành công và khóa nhân viên thường', () => {
  assert.match(web, /fetch\('\/api\/reports\/lark\/conversation', \{[\s\S]{0,500}method: 'POST'[\s\S]{0,500}JSON\.stringify\(\{ title: larkReportTitleInput\?\.value \|\| '', conversation \}\)/);
  assert.match(web, /larkReportForm\.reset\(\);[\s\S]{0,200}Đã gửi thành công/);
  assert.match(web, /staffReadOnlySections = \[[^\]]*'lark-report'/);
});

test('route Lark giữ webhook phía máy chủ, có chốt quản lý, không ghi nội dung vào audit', () => {
  const at = server.indexOf("if (request.method === 'POST' && url.pathname === '/api/reports/lark/conversation') {");
  assert.ok(at > 0);
  const route = server.slice(at, at + 1800);
  assert.match(route, /if \(!\(await requireManager\(request, response\)\)\) return;/);
  assert.match(route, /normalizeLarkConversationReport\(payload\)/);
  assert.match(route, /sendLarkConversationReport\(conversationReport, \{ webhookUrl, reporter: actor\.name \}\)/);
  assert.match(route, /audit\(request, 'report\.lark_conversation'/);
  assert.doesNotMatch(route, /summary:.*conversationReport\.conversation(?!\.length)/);
});
