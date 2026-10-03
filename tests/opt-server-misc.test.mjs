// 03/10 (opt-server): nhật ký hoạt động nhớ mã theo ngày đã qua (P1), Nhân sự ghi qua json-store mà tệp hỏng vẫn NÉM (H5).
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tempDir } from './helpers/temp-dir.mjs';

const directory = tempDir('opt-server-misc-');
process.env.STAFF_PATH = path.join(directory, 'staff.json');
const auditDir = path.join(directory, 'audit');

const { appendAudit, queryAudit } = await import('../app/audit-log.mjs');
const { readStaffStore, saveStaffMember } = await import('../app/staff.mjs');

test('P1: lịch sử một hội thoại qua nhiều ngày đã qua vẫn đủ; ngày có thêm dòng (tệp đổi kích thước) được đọc lại', async () => {
  const day = 24 * 60 * 60 * 1000;
  const now = Date.now();
  await appendAudit({ actor: 'a', action: 'conversation.view', conversationId: 'c1', summary: 'xem 1' }, { dir: auditDir, now: now - 3 * day });
  await appendAudit({ actor: 'a', action: 'conversation.view', conversationId: 'c2', summary: 'khác' }, { dir: auditDir, now: now - 2 * day });
  await appendAudit({ actor: 'a', action: 'order.update', orderId: 'o1', conversationId: 'c1', summary: 'sửa' }, { dir: auditDir, now: now - day });
  assert.deepEqual((await queryAudit({ conversationId: 'c1' }, { dir: auditDir })).items.map(item => item.summary), ['sửa', 'xem 1']);
  assert.deepEqual((await queryAudit({ orderId: 'o1' }, { dir: auditDir })).items.map(item => item.summary), ['sửa']);
  // Ngày đã qua nhận thêm dòng của c1 (ghi bù): kích thước tệp đổi → không dùng tập mã cũ.
  await appendAudit({ actor: 'a', action: 'conversation.view', conversationId: 'c1', summary: 'ghi bù' }, { dir: auditDir, now: now - 2 * day });
  assert.deepEqual((await queryAudit({ conversationId: 'c1' }, { dir: auditDir })).items.map(item => item.summary), ['sửa', 'ghi bù', 'xem 1']);
});

test('H5: Nhân sự ghi nguyên tử qua json-store; tệp hỏng thì NÉM và giữ nguyên tệp (không thành danh sách rỗng)', async () => {
  await saveStaffMember({ name: 'Lan', username: 'lan.nv' });
  assert.equal((await readStaffStore()).items.length, 1);
  writeFileSync(process.env.STAFF_PATH, '{"items": [');
  await assert.rejects(readStaffStore(), /hỏng/);
  assert.ok(existsSync(process.env.STAFF_PATH), 'không cất tệp đi');
  await assert.rejects(saveStaffMember({ name: 'Mai', username: 'mai.nv' }));
  assert.equal(readFileSync(process.env.STAFF_PATH, 'utf8'), '{"items": [', 'không ghi đè tệp hỏng');
});

test('visionEnabled: false lưu được và đọc lại vẫn false (trước đây bị bỏ khi chuẩn hoá); mặc định true', async () => {
  const { chatbotSettingsStore, normalizeChatbotSettings } = await import('../app/chatbot-settings.mjs');
  assert.equal(normalizeChatbotSettings({}).visionEnabled, true);
  const store = chatbotSettingsStore(path.join(directory, 'vision.json'));
  await store.update(current => ({ ...current, visionEnabled: false }));
  assert.equal((await store.read()).visionEnabled, false);
  assert.equal(JSON.parse(readFileSync(path.join(directory, 'vision.json'), 'utf8')).visionEnabled, false);
});

test('Tin vận đơn qua cầu nối: mục đã giao cho một tab không giao cho tab khác tới khi hết hạn / có kết quả chắc chắn', async () => {
  const { createLeaseBook } = await import('../app/server-helpers.mjs');
  const leases = createLeaseBook(1000);
  assert.equal(leases.take('k', { now: 0 }), true);
  assert.equal(leases.take('k', { now: 500 }), false, 'tab thứ hai không lấy được');
  assert.equal(leases.take('k', { now: 500, force: true }), true, 'nhân viên xác nhận gửi lại');
  assert.equal(leases.take('k', { now: 1600 }), true, 'hết hạn thì giao lại');
  leases.release('k');
  assert.equal(leases.held('k'), false);
  const server = readFileSync(new URL('../app/server.mjs', import.meta.url), 'utf8');
  const bridge = server.slice(server.indexOf("url.pathname === '/api/shipping/notices/bridge-items'"), server.indexOf("url.pathname === '/api/shipping/notices/results'"));
  assert.match(bridge, /shipmentBridgeLeases\.take\(item\.key, \{ force: payload\.force === true \}\)/);
  assert.match(bridge, /const skip = \(key, reason\) => \{ shipmentBridgeLeases\.release\(key\);/);
  const results = server.slice(server.indexOf("url.pathname === '/api/shipping/notices/results'"), server.indexOf("url.pathname === '/api/shipping/notices/send'"));
  assert.match(results, /unknown: result\?\.ok !== true && \(result\?\.unknown === true \|\| \/chưa rõ\/i\.test/);
  assert.match(results, /if \(!result\.unknown\) shipmentBridgeLeases\.release\(result\.key\)/);
});
