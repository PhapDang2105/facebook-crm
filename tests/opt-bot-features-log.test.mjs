// Tối ưu chatbot (P8/P13): featuresOf nhớ theo đối tượng row (tính lại khi row đổi); nhật ký quyết định chỉ mkdir khi đổi
// ngày nhưng vẫn ghi được khi thư mục bị xoá giữa ngày.
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, readFileSync, rmSync, readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { featuresOf } from '../app/processing/intent-features.mjs';
import { appendDecisionLog, flushDecisionLog } from '../app/processing/decision-log.mjs';

test('P8: featuresOf cùng row → cùng tập (nhớ); row bị sửa → tính lại đúng', () => {
  const row = { text: '2 túi xanh, 0912345678', source: 'inbox', lastTemplate: 'ORDER_ADDRESS', hasBasket: true };
  const first = featuresOf(row);
  assert.equal(featuresOf(row), first);
  assert.deepEqual([...featuresOf({ ...row })].sort(), [...first].sort());
  row.hasBasket = false;
  const changed = featuresOf(row);
  assert.notEqual(changed, first);
  assert.ok(first.has('ctx:basket'));
  assert.ok(!changed.has('ctx:basket'));
  row.text = 'giá bao nhiêu';
  assert.ok(featuresOf(row).has('w:gia'));
});

test('P13: appendDecisionLog ghi nhiều dòng trong ngày; thư mục bị xoá giữa ngày vẫn ghi lại được', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'opt-bot-dlog-'));
  try {
    const now = Date.parse('2026-10-03T03:00:00Z');
    await appendDecisionLog({ templateId: 'A' }, { dir, now });
    await appendDecisionLog({ templateId: 'B' }, { dir, now: now + 1000 });
    rmSync(dir, { recursive: true, force: true });
    await appendDecisionLog({ templateId: 'C' }, { dir, now: now + 2000 });
    await flushDecisionLog(dir);
    const files = readdirSync(dir);
    assert.equal(files.length, 1);
    const lines = readFileSync(path.join(dir, files[0]), 'utf8').trim().split('\n').map(line => JSON.parse(line));
    assert.deepEqual(lines.map(line => line.templateId), ['C']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
