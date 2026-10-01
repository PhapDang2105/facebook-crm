// C2 + TB-5 (01/10): đọc kho JSON lỗi KHÔNG được coi là kho rỗng rồi ghi đè dữ liệu thật.
// Quy tắc chung (app/json-store.mjs): chưa có tệp → mặc định; JSON hỏng → cất `.corrupt-*` rồi
// mặc định; lỗi đọc khác (ở đây giả bằng EISDIR: đường dẫn là thư mục) → ném, không nhớ kho rỗng.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tempDir } from './helpers/temp-dir.mjs';

const directory = tempDir('fix-store-json-');
const file = name => path.join(directory, name);
process.env.LANDING_ORDERS_PATH = file('landing-orders.json');
process.env.ORDER_ARCHIVE_PATH = file('order-archive');
process.env.CUSTOMER_FILE_PATH = file('customer-file.json');
process.env.CUSTOMER_EDITS_PATH = file('customer-edits.json');
process.env.PHONE_WARNINGS_PATH = file('phone-warnings.json');
process.env.POS_CONFIG_PATH = file('pos-config.json');
process.env.META_CHANNELS_PATH = file('meta-channels.json');
process.env.INBOX_SETTINGS_PATH = file('inbox-settings.json');
process.env.EXPORT_HISTORY_PATH = file('export-history.json');
process.env.EXPORT_FILES_DIR = file('exports');

const { readJsonFile, readJsonFileSync, writeJsonAtomic, createWriteQueue } = await import('../app/json-store.mjs');
const { updateLandingStore, listLandingOrders } = await import('../app/landing-orders.mjs');
const { recordExportedOrders, listExportedCustomers } = await import('../app/customer-file.mjs');
const { updateCustomerProfile, readCustomerEdits } = await import('../app/customer-edits.mjs');
const { updateWarningStore, readWarningStore, posConfig, disconnectPos } = await import('../app/phone-warnings.mjs');
const { readChannelStore, writeChannelStore } = await import('../app/channel-store.mjs');
const { readAdStore } = await import('../app/meta-ads.mjs');
const { readInboxSettings } = await import('../app/inbox-settings.mjs');
const { listExports, recordExport } = await import('../app/export-history.mjs');
const { readCampaignInsights, generateCampaignInsights } = await import('../app/campaign-ai.mjs');

const corruptCopies = target => readdirSync(path.dirname(target)).filter(name => name.startsWith(`${path.basename(target)}.corrupt-`));
const asDirectory = target => { rmSync(target, { recursive: true, force: true }); mkdirSync(target, { recursive: true }); };
const clear = target => rmSync(target, { recursive: true, force: true });

test('json-store: ENOENT → mặc định; hỏng → cất .corrupt-* nguyên văn; lỗi đọc khác → ném; ghi nguyên tử không để tệp tạm', async () => {
  const target = file('helper.json');
  assert.deepEqual(await readJsonFile(target, { fallback: () => ({ items: [] }) }), { items: [] });
  assert.deepEqual(corruptCopies(target), [], 'chưa có tệp thì không tạo bản .corrupt');
  writeFileSync(target, '{"items": [1, 2');
  assert.deepEqual(await readJsonFile(target, { fallback: () => ({ items: [] }) }), { items: [] });
  const [copy] = corruptCopies(target);
  assert.ok(copy, 'bản hỏng được cất');
  assert.equal(readFileSync(path.join(directory, copy), 'utf8'), '{"items": [1, 2', 'cất nguyên văn để còn cứu');
  assert.equal(existsSync(target), false);
  // JSON hợp lệ nhưng sai kiểu (null, mảng) cũng là hỏng.
  writeFileSync(target, 'null');
  assert.deepEqual(await readJsonFile(target, { fallback: {} }), {});
  // Lỗi đọc khác: ném, không trả mặc định.
  asDirectory(target);
  await assert.rejects(readJsonFile(target, { fallback: {} }), /Không đọc được/);
  assert.throws(() => readJsonFileSync(target, { fallback: {} }), /Không đọc được/);
  clear(target);
  // BOM của Notepad không làm hỏng tệp.
  writeFileSync(target, '﻿{"a":1}');
  assert.deepEqual(await readJsonFile(target), { a: 1 });
  await writeJsonAtomic(target, { b: 2 });
  assert.deepEqual(JSON.parse(readFileSync(target, 'utf8')), { b: 2 });
  assert.deepEqual(readdirSync(directory).filter(name => name.endsWith('.tmp')), [], 'không còn tệp tạm');
  const queue = createWriteQueue();
  const order = [];
  await Promise.all([
    queue(async () => { await new Promise(resolve => setTimeout(resolve, 20)); order.push(1); }),
    queue(async () => { throw new Error('lỗi lượt 2'); }).catch(() => order.push('x')),
    queue(async () => { order.push(3); })
  ]);
  assert.deepEqual(order, [1, 'x', 3], 'tuần tự, lỗi một lượt không chặn lượt sau');
});

test('kho đơn landing: lỗi đọc → ghi bị từ chối (không đè); JSON hỏng → cất bản hỏng, không mất đơn thật', async () => {
  const target = process.env.LANDING_ORDERS_PATH;
  asDirectory(target);
  await assert.rejects(updateLandingStore(store => { store.orders.push({ id: 'x' }); }));
  clear(target);
  // Repro v-c2: tệp có 1 đơn nhưng thiếu dấu } → trước đây lần ghi sau còn "orders": [].
  const broken = '{"orders":[{"id":"real1","phone":"0912345678","createdAt":1}],"recent":[]';
  writeFileSync(target, broken);
  await updateLandingStore(store => { store.orders.unshift({ id: 'new1', phone: '0987654321', createdAt: 2 }); });
  const [copy] = corruptCopies(target);
  assert.ok(copy);
  assert.equal(readFileSync(path.join(directory, copy), 'utf8'), broken, 'đơn thật còn trong bản cất');
  assert.deepEqual((await listLandingOrders()).map(order => order.id), ['new1']);
});

test('tệp khách hàng / sửa thông tin khách / cảnh báo SĐT: lỗi đọc thì ném và không nhớ kho rỗng', async () => {
  const orderData = { headers: ['Số điện thoại', 'Mã đơn hàng', 'Khách hàng'], rows: [['0912345678', 'A1', 'Lan']] };
  for (const [target, write, read] of [
    [process.env.CUSTOMER_FILE_PATH, () => recordExportedOrders(orderData, 1000), async () => (await listExportedCustomers()).length],
    [process.env.CUSTOMER_EDITS_PATH, () => updateCustomerProfile('0912345678', { name: 'Lan' }, 1000), async () => Object.keys(await readCustomerEdits()).length],
    [process.env.PHONE_WARNINGS_PATH, () => updateWarningStore(store => { store.cache['0912345678'] = { fetchedAt: 1 }; }), async () => Object.keys((await readWarningStore()).cache).length]
  ]) {
    asDirectory(target);
    await assert.rejects(write(), /Không đọc được/, path.basename(target));
    clear(target);
    writeFileSync(target, '{"broken":');
    await write();
    assert.equal(corruptCopies(target).length, 1, `${path.basename(target)}: bản hỏng được cất`);
    assert.equal(await read(), 1, `${path.basename(target)}: ghi tiếp bình thường sau khi cất`);
  }
});

test('khoá POS: tệp hỏng → cất .corrupt-*, ngắt kết nối ghi nguyên tử với quyền 600', async () => {
  const target = process.env.POS_CONFIG_PATH;
  writeFileSync(target, '{"apiKey": "abc", ');
  assert.equal(posConfig().apiKey, '');
  assert.equal(corruptCopies(target).length, 1);
  await disconnectPos();
  assert.equal(readFileSync(target, 'utf8'), '{}');
  if (process.platform !== 'win32') assert.equal(statSync(target).mode & 0o777, 0o600);
});

test('kho kênh, số liệu quảng cáo, cài đặt tin nhắn, lịch sử xuất kho, Cố vấn AI: cùng quy tắc', async () => {
  // Kênh Facebook.
  const channels = process.env.META_CHANNELS_PATH;
  asDirectory(channels);
  await assert.rejects(readChannelStore(), /Không đọc được/);
  clear(channels);
  writeFileSync(channels, '{"items":[{"id":"1"');
  assert.deepEqual(await readChannelStore(), { items: [] });
  assert.equal(corruptCopies(channels).length, 1);
  await writeChannelStore({ items: [{ id: '2' }] });
  assert.deepEqual((await readChannelStore()).items.map(item => item.id), ['2']);

  // Quảng cáo: trước đây lỗi đọc = kho rỗng → lượt đồng bộ kế tiếp ghi đè chỉ còn 7 ngày.
  const ads = file('ad-insights.json');
  asDirectory(ads);
  await assert.rejects(readAdStore(ads), /Không đọc được/);
  clear(ads);
  writeFileSync(ads, '{"syncedAt": 5, "daily": [');
  assert.equal((await readAdStore(ads)).syncedAt, null);
  assert.equal(corruptCopies(ads).length, 1);

  // Cài đặt tin nhắn: lỗi đọc không được nhớ bộ thẻ mặc định.
  const inbox = process.env.INBOX_SETTINGS_PATH;
  asDirectory(inbox);
  await assert.rejects(readInboxSettings(), /Không đọc được/);
  clear(inbox);
  writeFileSync(inbox, JSON.stringify({ labels: [{ id: 'rieng', name: 'Thẻ riêng', color: '#123456' }], quickReplies: [] }));
  assert.ok((await readInboxSettings()).labels.some(label => label.id === 'rieng'), 'đọc lại được bộ thẻ thật sau lỗi thoáng qua');

  // Lịch sử xuất kho.
  const history = process.env.EXPORT_HISTORY_PATH;
  asDirectory(history);
  await assert.rejects(listExports(), /Không đọc được/);
  clear(history);
  writeFileSync(history, '{"items": [{"id": "a"');
  await recordExport({ day: '2026-10-01', orders: 1, rows: 1 });
  assert.equal(corruptCopies(history).length, 1);
  assert.equal((await listExports()).length, 1);

  // Cố vấn AI chiến dịch.
  const insights = file('campaign-ai.json');
  asDirectory(insights);
  await assert.rejects(readCampaignInsights({ path: insights }), /Không đọc được/);
  await assert.rejects(generateCampaignInsights({}, { path: insights }), /Không đọc được/, 'lần lưu không đè lịch sử khi đọc lỗi');
  clear(insights);
  writeFileSync(insights, '{"runs": [');
  await generateCampaignInsights({}, { path: insights });
  assert.equal(corruptCopies(insights).length, 1);
  assert.ok(await readCampaignInsights({ path: insights }));
});
