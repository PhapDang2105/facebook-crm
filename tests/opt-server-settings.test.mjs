// 03/10 (opt-server): cài đặt chatbot đọc/ghi an toàn (C1, C2, P3, D5), escapeXml dùng chung (B5), chặn cột XLSX quá XFD (B2).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync, existsSync, utimesSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import AdmZip from 'adm-zip';
import { tempDir } from './helpers/temp-dir.mjs';

const directory = tempDir('opt-server-settings-');
const { chatbotSettingsStore, readChatbotSettings } = await import('../app/chatbot-settings.mjs');
const { createWriteQueue, drainAllWrites, pendingWriteQueues } = await import('../app/json-store.mjs');
const { buildPlainXlsx, escapeXml, sheetNameXml } = await import('../app/xlsx-export.mjs');
const { fillTemplateSheet } = await import('../app/xlsx-template.mjs');
const { parseXlsx, XLSX_MAX_COLUMN_INDEX, columnIndex } = await import('../app/xlsx-import.mjs');

test('C1: lỗi đọc tệp cài đặt khác ENOENT thì NÉM, không trả mặc định; khởi động không ghi đè', async () => {
  const filePath = path.join(directory, 'as-directory.json');
  mkdirSync(filePath); // đọc một thư mục → EISDIR (giả lỗi đọc thật như EACCES/EBUSY)
  const store = chatbotSettingsStore(filePath);
  await assert.rejects(store.read(), /Không đọc được Cài đặt chatbot/);
  // Ghi qua update phải dừng ở bước đọc: không có gì bị ghi đè bằng mặc định + bản vá.
  await assert.rejects(store.update(current => ({ ...current, enabled: true })));
  assert.equal(await store.ensureFile(), false, 'tệp (ở đây là thư mục) đã có: không ghi mặc định');
});

test('C1: chưa có tệp → mặc định, ensureFile chỉ ghi khi ENOENT', async () => {
  const filePath = path.join(directory, 'fresh', 'chatbot-settings.json');
  const store = chatbotSettingsStore(filePath);
  assert.equal((await store.read()).enabled, false);
  assert.equal(await store.ensureFile(), true);
  assert.ok(existsSync(filePath));
  assert.equal(await store.ensureFile(), false);
});

test('C2: hai lượt update sát nhau (PUT cài đặt + công tắc bot) không làm mất thay đổi của nhau', async () => {
  const filePath = path.join(directory, 'race.json');
  writeFileSync(filePath, JSON.stringify({ enabled: false, systemPrompt: 'cũ' }));
  const store = chatbotSettingsStore(filePath);
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const first = store.update(async current => { await gate; return { ...current, systemPrompt: 'prompt mới' }; });
  const second = store.update(current => ({ ...current, enabled: true }));
  release();
  await Promise.all([first, second]);
  const saved = JSON.parse(readFileSync(filePath, 'utf8'));
  assert.equal(saved.systemPrompt, 'prompt mới');
  assert.equal(saved.enabled, true, 'lượt sau đọc bản đã có prompt mới, không ghi lại prompt cũ');
  const noop = await store.update(() => undefined);
  assert.equal(noop.changed, false);
});

test('P3: nhớ bản chuẩn hoá theo mốc sửa tệp; ghi hay sửa tệp ngoài là đọc lại; bản trả về là bản sao', async () => {
  const filePath = path.join(directory, 'cache.json');
  writeFileSync(filePath, JSON.stringify({ systemPrompt: 'một' }));
  const first = await readChatbotSettings(filePath);
  first.systemPrompt = 'người gọi sửa bản của mình';
  first.messageTemplates.X = 'y';
  const second = await readChatbotSettings(filePath);
  assert.equal(second.systemPrompt, 'một', 'sửa bản trả về không làm bẩn bộ nhớ đệm');
  assert.equal(second.messageTemplates.X, undefined);
  writeFileSync(filePath, JSON.stringify({ systemPrompt: 'hai, dài hơn' }));
  const future = new Date(Date.now() + 5000);
  utimesSync(filePath, future, future);
  assert.equal((await readChatbotSettings(filePath)).systemPrompt, 'hai, dài hơn');
  await chatbotSettingsStore(filePath).write({ systemPrompt: 'ba' });
  assert.equal((await readChatbotSettings(filePath)).systemPrompt, 'ba');
});

test('P3: tệp hỏng vẫn được cất .corrupt-* rồi dùng mặc định (như trước)', async () => {
  const filePath = path.join(directory, 'broken.json');
  writeFileSync(filePath, '{"systemPrompt": "cụt');
  assert.equal((await readChatbotSettings(filePath)).systemPrompt, '');
  assert.equal(existsSync(filePath), false);
});

test('D5: campaign-ai dùng bộ đọc chung (không còn bản đọc riêng nuốt lỗi)', async () => {
  const source = await readFile(new URL('../app/campaign-ai.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /readStoredChatbotSettings|JSON\.parse\(await readFile\(settingsPath/);
  assert.match(source, /import \{ readChatbotSettings \} from '\.\/chatbot-settings\.mjs';/);
});

test('C5: drainAllWrites chờ mọi hàng ghi xong, kể cả lượt xếp thêm từ trong lượt khác', async () => {
  const queueA = createWriteQueue();
  const queueB = createWriteQueue();
  const done = [];
  queueA(async () => {
    await new Promise(resolve => setTimeout(resolve, 20));
    done.push('a1');
    queueB(async () => { await new Promise(resolve => setTimeout(resolve, 20)); done.push('b-from-a'); });
  });
  queueB(() => { done.push('b1'); });
  queueA(() => Promise.reject(new Error('lỗi một lượt không chặn drain'))).catch(() => {});
  assert.equal(await drainAllWrites(), true);
  assert.deepEqual(done.sort(), ['a1', 'b-from-a', 'b1']);
  assert.equal(pendingWriteQueues(), 0);
});

test('B5: escapeXml dùng chung bỏ ký tự điều khiển XML 1.0; file kho (mẫu) và XLSX thuần đều mở được', () => {
  assert.equal(escapeXml('A\x00B\x07C\x0BD\tE\nF & <x> "q" \'s\''), 'ABCD\tE\nF &amp; &lt;x&gt; &quot;q&quot; &apos;s&apos;');
  const xml = '<worksheet><sheetData><row r="4"><c r="A4" s="3"/></row></sheetData></worksheet>';
  const filled = fillTemplateSheet(xml, [['Tên\x01 khách\x1F']]);
  assert.doesNotMatch(filled, /[\x00-\x08\x0B\x0C\x0E-\x1F]/);
  assert.match(filled, /Tên khách/);
  const buffer = buildPlainXlsx(['Cột'], [['bad\x02value']]);
  assert.equal(parseXlsx(buffer).rows[0][0], 'badvalue');
});

test('B5: tên sheet cắt 31 ký tự TRƯỚC khi thoát XML (không cắt đứt "&amp;")', () => {
  const name = `${'x'.repeat(29)}&&&`;
  const xml = sheetNameXml(name);
  assert.equal(xml, `${'x'.repeat(29)}&amp;&amp;`);
  const workbook = new AdmZip(buildPlainXlsx(['a'], [['b']], { sheetName: name })).readAsText('xl/workbook.xml');
  assert.match(workbook, /<sheet name="x{29}&amp;&amp;" sheetId/);
});

test('B2: ô có địa chỉ cột quá XFD bị bỏ qua (không cấp mảng hàng trăm triệu ô)', () => {
  assert.equal(columnIndex('XFD1'), XLSX_MAX_COLUMN_INDEX);
  const sheet = '<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Tên</t></is></c></row><row r="2"><c r="A2" t="inlineStr"><is><t>An</t></is></c><c r="ZZZZZZ2" t="inlineStr"><is><t>bom</t></is></c></row></sheetData></worksheet>';
  const zip = new AdmZip(buildPlainXlsx(['x'], [['y']]));
  zip.updateFile('xl/worksheets/sheet1.xml', Buffer.from(sheet, 'utf8'));
  const started = Date.now();
  const parsed = parseXlsx(zip.toBuffer());
  assert.ok(Date.now() - started < 2000);
  assert.deepEqual(parsed.headers, ['Tên']);
  assert.deepEqual(parsed.rows, [['An']]);
});
