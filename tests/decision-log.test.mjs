import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { appendDecisionLog, flushDecisionLog, maskPhones, sanitizeRecord, vnDateKey } from '../app/processing/decision-log.mjs';

const tempDir = () => mkdtemp(path.join(os.tmpdir(), 'decision-log-'));
const record = (extra = {}) => ({
  v: 1, at: new Date().toISOString(), conversationId: 'page:user', source: 'inbox', mid: 'm1', text: 'Cho em 2 túi xanh, sđt 0385805790 nhé', type: 'text',
  prevBot: 'PRICE_QUOTE', prevBotAgeMin: 1.5, prevBotAsks: '', ctx: { hasBasket: false, phoneInText: true, bagCount: 2 }, rule: null, shadow: [], intent: { templateId: 'ORDER_ADDRESS', p: 0.9, margin: 0.5, topK: [] },
  llm: { templateId: 'ORDER_ADDRESS', retried: false, hint: '', usage: { input: 2300, cached: 2200, output: 40, thinking: 0 } }, fewShot: ['ORDER_ADDRESS'],
  chosen: 'ORDER_ADDRESS', final: 'ORDER_ADDRESS', also: null, skipped: null, guards: { preGuard: null, gate: { agree: true, reason: 'intent-top1' } }, attention: false, handoff: false, ms: 12,
  ...extra
});

test('ghi 2 dòng JSONL vào tệp theo ngày VN, đọc lại đúng schema, SĐT bị che ở mọi chuỗi, text cắt 400 ký tự', async () => {
  const dir = await tempDir();
  const now = Date.UTC(2026, 8, 28, 18, 30); // 01:30 ngày 29/09 giờ VN → tệp 2026-09-29
  await appendDecisionLog(record(), { dir, now });
  await appendDecisionLog(record({ mid: 'm2', text: `${'a'.repeat(500)} +84 385 805 790`, ctx: { note: 'gọi 0912.345.678 nhé' } }), { dir, now });
  await flushDecisionLog(dir);
  assert.deepEqual(await readdir(dir), ['2026-09-29.jsonl']);
  assert.equal(vnDateKey(now), '2026-09-29');
  const lines = (await readFile(path.join(dir, '2026-09-29.jsonl'), 'utf8')).trim().split('\n');
  assert.equal(lines.length, 2);
  const rows = lines.map(line => JSON.parse(line));
  assert.deepEqual(Object.keys(rows[0]), ['v', 'at', 'conversationId', 'source', 'mid', 'text', 'type', 'prevBot', 'prevBotAgeMin', 'prevBotAsks', 'ctx', 'rule', 'shadow', 'intent', 'llm', 'fewShot', 'chosen', 'final', 'also', 'skipped', 'guards', 'attention', 'handoff', 'ms']);
  assert.equal(rows[0].text, 'Cho em 2 túi xanh, sđt <sdt> nhé');
  assert.equal(rows[0].llm.usage.cached, 2200);
  assert.equal(rows[1].mid, 'm2');
  assert.equal(rows[1].text.length, 400, 'text cắt còn 400 ký tự');
  assert.equal(rows[1].ctx.note, 'gọi <sdt> nhé', 'SĐT che ở chuỗi lồng trong ctx');
  assert.doesNotMatch(lines.join('\n'), /0385805790|385 805 790|0912/);
});

test('lần ghi đầu ngày xóa tệp cũ hơn 45 ngày, giữ tệp trong hạn; lỗi ghi chỉ cảnh báo', async () => {
  const dir = await tempDir();
  const now = Date.UTC(2026, 8, 28, 3, 0);
  await writeFile(path.join(dir, '2026-07-01.jsonl'), '{}\n');
  await writeFile(path.join(dir, '2026-09-01.jsonl'), '{}\n');
  await writeFile(path.join(dir, 'ghi-chu.txt'), 'không đụng');
  await appendDecisionLog(record(), { dir, now });
  await flushDecisionLog(dir);
  assert.deepEqual((await readdir(dir)).sort(), ['2026-09-01.jsonl', '2026-09-28.jsonl', 'ghi-chu.txt']);
  // Thư mục không tạo được (đường dẫn là một tệp): không ném, chỉ console.warn.
  const warnings = [];
  const original = console.warn;
  console.warn = message => warnings.push(String(message));
  try {
    await appendDecisionLog(record(), { dir: path.join(dir, 'ghi-chu.txt'), now });
  } finally { console.warn = original; }
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /Nhật ký quyết định/);
});

test('maskPhones / sanitizeRecord: che 0xxx và +84, Infinity → null, undefined → null', () => {
  assert.equal(maskPhones('gọi 0385 805 790 hoặc +84385805790'), 'gọi <sdt> hoặc <sdt>');
  assert.equal(maskPhones('giá 174.000đ, 2 túi 348k'), 'giá 174.000đ, 2 túi 348k', 'số tiền không bị che');
  assert.deepEqual(sanitizeRecord({ a: Infinity, b: undefined, list: ['0912345678'] }), { a: null, b: null, list: ['<sdt>'] });
});
