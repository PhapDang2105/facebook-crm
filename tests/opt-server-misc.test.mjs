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
