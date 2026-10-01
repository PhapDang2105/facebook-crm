import assert from 'node:assert/strict';
import test from 'node:test';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tempDir as createTempDir } from './helpers/temp-dir.mjs';
import { appendDecisionLog, flushDecisionLog, maskPhones, sanitizeRecord, vnDateKey } from '../app/processing/decision-log.mjs';

// Thư mục tạm tự xoá khi tiến trình test thoát (trước đây để lại decision-log-* trong %TEMP% mỗi lần chạy).
const tempDir = async () => createTempDir('decision-log-');
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

test('khóa định danh giữ nguyên (conversationId, mid, mã mẫu, tên luật); chuỗi tự do che SĐT +84 có dấu cách, email, dãy ≥ 9 số', () => {
  const clean = sanitizeRecord({
    v: 1,
    at: '2026-09-28T10:00:00.000Z',
    conversationId: '103549382215599:25084123456789012',
    mid: 'm_1045678901234567',
    source: 'inbox',
    type: 'text',
    prevBot: 'PRICE_QUOTE',
    lastTemplate: 'PRICE_QUOTE',
    text: 'sdt +84 912 345 678, 84912345678, 0912.345.678, stk 19036681234012 Techcombank, email chi.lan@gmail.com, giá 298.000 hay 298k, 12 ngõ 5',
    ctx: { orderAgeMin: 1234567890, note: 'psid 7012345678901234' },
    rule: { name: 'ORDER_ASK', templateId: 'ORDER_ADDRESS' },
    shadow: [{ name: 'TRIAL_ASK', templateId: 'TRIAL_OFFER' }],
    cascade: { group: 'ANSWER', subGroup: 'PRICE', templateId: 'PRICE_QUOTE', path: 'ANSWER>PRICE', topK: [{ templateId: 'PRICE_QUOTE', p: 0.9 }] },
    fewShot: ['ORDER_ADDRESS'],
    chosen: 'ORDER_ADDRESS', final: 'ORDER_ADDRESS'
  });
  assert.equal(clean.conversationId, '103549382215599:25084123456789012', 'conversationId không bị che');
  assert.equal(clean.mid, 'm_1045678901234567');
  assert.equal(clean.at, '2026-09-28T10:00:00.000Z');
  assert.deepEqual(clean.rule, { name: 'ORDER_ASK', templateId: 'ORDER_ADDRESS' });
  assert.equal(clean.cascade.path, 'ANSWER>PRICE');
  assert.equal(clean.ctx.orderAgeMin, 1234567890, 'số (không phải chuỗi) giữ nguyên');
  assert.equal(clean.ctx.note, 'psid <so>');
  assert.equal(clean.text, 'sdt <sdt>, <sdt>, <sdt>, stk <so> Techcombank, email <email>, giá 298.000 hay 298k, 12 ngõ 5');
});

test('maskPhones: (+84) có ngoặc, nhiều dấu cách liền, nhóm 2 số; không che số tiền 1.250.000 / 298k / đuôi số tiền lớn', () => {
  assert.equal(maskPhones('gọi (+84) 912-345-678 nhé'), 'gọi <sdt> nhé');
  assert.equal(maskPhones('sdt 0912  345  678'), 'sdt <sdt>');
  assert.equal(maskPhones('sdt 0912 34 56 78 ạ'), 'sdt <sdt> ạ', 'không cắt dở thành "<sdt>8"');
  assert.equal(maskPhones('Lan,0912345678'), 'Lan,<sdt>');
  assert.equal(maskPhones('tổng 1.250.000đ, 298k, 12.090.000.000đ'), 'tổng 1.250.000đ, 298k, 12.090.000.000đ');
  assert.equal(maskPhones('psid 25084123456789012'), 'psid 25084123456789012', 'không che giữa dãy số dài (việc của maskPersonal)');
});

test('che SĐT không nuốt số lượng ngay sau SĐT (28/09)', async () => {
  const { maskPersonal, maskPhones } = await import('../app/processing/decision-log.mjs');
  assert.equal(maskPhones('0912 345 678 1 túi xanh'), '<sdt> 1 túi xanh');
  assert.equal(maskPhones('Lan,0912345678 2 túi'), 'Lan,<sdt> 2 túi');
  assert.equal(maskPhones('024 3826 1234 gọi'), '<sdt> gọi');
  assert.equal(maskPersonal('giá 1.250.000'), 'giá 1.250.000');
});
