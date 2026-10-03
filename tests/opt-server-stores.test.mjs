// 03/10 (opt-server): kho lưu trữ đơn có chỉ mục (P2), tra khách trong tệp khách (P13), kho landing không ghi khi
// không đổi (P2) và bỏ bản sửa dở (C6), tắt máy chủ ghi hết (C5), đồng bộ POS một lượt chạy + đủ móc (INT-10).
import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tempDir } from './helpers/temp-dir.mjs';

const directory = tempDir('opt-server-stores-');
process.env.ORDER_ARCHIVE_PATH = path.join(directory, 'order-archive');
process.env.LANDING_ORDERS_PATH = path.join(directory, 'landing-orders.json');
process.env.LANDING_ARCHIVE_PATH = path.join(directory, 'landing-archive');
process.env.CUSTOMER_FILE_PATH = path.join(directory, 'customer-file.json');
process.env.META_CONVERSATIONS_PATH = path.join(directory, 'meta-conversations.json');
await import('./helpers/seed-catalog.mjs');

const archive = await import('../app/order-archive.mjs');
const { findExportedCustomer, listExportedCustomers } = await import('../app/customer-file.mjs');
const { readLandingStore, updateLandingStore } = await import('../app/landing-orders.mjs');
const messaging = await import('../app/messaging-store.mjs');
const { createWriteQueue } = await import('../app/json-store.mjs');
const posSync = await import('../app/pos-sync.mjs');

const order = (extra = {}) => ({ id: 'CB-1', createdAt: Date.parse('2026-09-20T03:00:00Z'), source: 'Facebook', name: 'An', phone: '0912345678', products: [{ sku: 'GRA-XANH-Z450', quantity: 1, price: 174000 }], total: 174000, ...extra });

test('P2: kho lưu trữ đơn — chỉ mục theo SĐT cập nhật ngay khi ghi nối, dòng sau cùng thắng, không đọc lại cả kho', async () => {
  await archive.appendOrderToArchive(order());
  assert.equal((await archive.findArchiveByPhone('0912345678')).length, 1);
  // Đã nạp chỉ mục: ghi tiếp chỉ cập nhật tại chỗ.
  await archive.appendOrderToArchive(order({ name: 'An (sửa)' }), { status: 'cancelled' });
  await archive.appendOrderToArchive(order({ id: 'CB-2', createdAt: Date.parse('2026-09-25T03:00:00Z') }));
  await archive.appendOrderToArchive(order({ id: 'LP-9', phone: '0988000111' }));
  const found = await archive.findArchiveByPhone('84912345678');
  assert.deepEqual(found.map(record => record.id), ['CB-2', 'CB-1'], 'mới nhất trước; +84 / 0 cùng một khách');
  assert.equal(found[1].name, 'An (sửa)');
  assert.equal(found[1].st, 'cancelled');
  assert.equal(found[1].file, undefined, 'không lộ tên tệp tháng');
  const all = await archive.readOrderArchive({ limit: 2 });
  assert.equal(all.total, 3);
  assert.equal(all.items.length, 2);
  assert.ok((await archive.archiveOrderIds()).has('LP-9'));
  // Đơn sửa đổi SĐT: không còn nằm dưới SĐT cũ.
  await archive.appendOrderToArchive(order({ id: 'CB-2', phone: '0977000222', createdAt: Date.parse('2026-09-25T03:00:00Z') }));
  assert.deepEqual((await archive.findArchiveByPhone('0912345678')).map(record => record.id), ['CB-1']);
  assert.deepEqual((await archive.findArchiveByPhone('0977000222')).map(record => record.id), ['CB-2']);
});

test('P2: dòng do tiến trình khác ghi thêm vào tệp tháng được nhận ra (so kích thước tệp) ở lần kiểm sau', async () => {
  const fresh = await import(`../app/order-archive.mjs?external=${Date.now()}`);
  assert.equal((await fresh.findArchiveByPhone('0911222333')).length, 0);
  const file = path.join(process.env.ORDER_ARCHIVE_PATH, '2026-09.ndjson');
  appendFileSync(file, `${JSON.stringify({ id: 'EXT-1', at: Date.parse('2026-09-21T03:00:00Z'), phone: '0911222333', name: 'Ngoài' })}\n`);
  // Lượt kiểm kích thước chạy tối đa 30 giây một lần: giả đồng hồ trôi.
  const realNow = Date.now;
  Date.now = () => realNow() + 60 * 1000;
  try {
    assert.deepEqual((await fresh.findArchiveByPhone('0911222333')).map(record => record.id), ['EXT-1']);
  } finally {
    Date.now = realNow;
  }
});

test('P13: findExportedCustomer tra thẳng theo khoá SĐT, khoá cũ lệch dạng vẫn tìm ra', async () => {
  writeFileSync(process.env.CUSTOMER_FILE_PATH, JSON.stringify({ customers: {
    '0912345678': { phone: '0912345678', name: 'An', orders: { a: { id: 'a', orderedAt: 1 }, b: { id: 'b', orderedAt: 5 } } },
    '988777666': { phone: '988777666', name: 'Bình', orders: {} }
  } }));
  const fresh = await import(`../app/customer-file.mjs?find=${Date.now()}`);
  const an = await fresh.findExportedCustomer('+84 912 345 678');
  assert.equal(an.name, 'An');
  assert.deepEqual(an.orders.map(item => item.id), ['b', 'a']);
  assert.equal((await fresh.findExportedCustomer('0988777666')).name, 'Bình');
  assert.equal(await fresh.findExportedCustomer('0900000000'), null);
  assert.equal(typeof listExportedCustomers, 'function');
  assert.equal(typeof findExportedCustomer, 'function');
});

test('P2 + C6: kho landing — không đổi thì không ghi lại tệp; mutate ném giữa chừng thì bỏ bản sửa dở trong bộ nhớ', async () => {
  await updateLandingStore(store => { store.orders.push({ id: 'LP-1', name: 'A', total: 1 }); });
  const before = statSync(process.env.LANDING_ORDERS_PATH).mtimeMs;
  await new Promise(resolve => setTimeout(resolve, 20));
  const result = await updateLandingStore(() => 0, { unchanged: count => !count });
  assert.equal(result, 0);
  assert.equal(statSync(process.env.LANDING_ORDERS_PATH).mtimeMs, before, 'không ghi lại cả kho');
  await assert.rejects(updateLandingStore(store => {
    store.orders[0].name = 'sửa dở';
    throw new Error('lỗi giữa chừng');
  }));
  assert.equal((await readLandingStore()).orders[0].name, 'A', 'bản sửa dở không còn trong bộ nhớ');
  await updateLandingStore(store => { store.orders[0].total = 2; });
  assert.equal(JSON.parse(readFileSync(process.env.LANDING_ORDERS_PATH, 'utf8')).orders[0].name, 'A');
});

test('C5: tắt máy chủ — prepare chạy trước, lượt sửa còn xếp hàng (kể cả ghi gộp) được ghi xong rồi mới thoát', async () => {
  writeFileSync(process.env.META_CONVERSATIONS_PATH, JSON.stringify({ conversations: [], messages: {} }));
  const order = [];
  const queue = createWriteQueue();
  let exitCode = null;
  const exited = new Promise(resolve => {
    messaging.installMessagingStoreShutdownFlush({
      signals: ['opt-server-shutdown'],
      prepare: async () => {
        order.push('prepare');
        await queue(async () => { await new Promise(resolve => setTimeout(resolve, 20)); order.push('small-store'); });
      },
      exit: code => { exitCode = code; order.push('exit'); resolve(); }
    });
  });
  // Một lượt sửa ghi gộp (defer) và một lượt đang xếp hàng ngay lúc nhận tín hiệu.
  await messaging.updateMessagingStore(store => { messaging.ensureConversation(store, { pageId: 'p', psid: '1' }); }, { defer: true });
  process.emit('opt-server-shutdown');
  messaging.updateMessagingStore(store => { messaging.ensureConversation(store, { pageId: 'p', psid: '2' }); }, { defer: true });
  await exited;
  assert.equal(exitCode, 0);
  assert.deepEqual(order, ['prepare', 'small-store', 'exit']);
  const onDisk = JSON.parse(readFileSync(process.env.META_CONVERSATIONS_PATH, 'utf8'));
  assert.deepEqual(onDisk.conversations.map(item => item.id).sort(), ['p:1', 'p:2']);
});

test('INT-10: runPosSync dùng móc đã đặt và chỉ một lượt chạy một lúc (lượt bấm tay chờ lượt đang chạy)', async () => {
  const config = { baseUrl: 'http://pos.stub', apiKey: 'k', shopId: '1' };
  const conversationOrder = { id: '777', system_id: '777', conversation_id: 'conv-1', status: 0, inserted_at: '2026-10-01T03:00:00.000000', order_sources_name: 'Facebook' };
  let active = 0;
  let peak = 0;
  const fetchImpl = async () => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise(resolve => setTimeout(resolve, 15));
    active -= 1;
    return { ok: true, status: 200, json: async () => ({ success: true, data: [conversationOrder], total_pages: 1 }) };
  };
  const seen = [];
  posSync.configurePosSync({ onPosConversationOrders: async orders => { seen.push(orders.length); return orders.length; }, onPosStatuses: async () => 0 });
  const [first, second] = await Promise.all([posSync.runPosSync({ config, fetchImpl }), posSync.runPosSync({ config, fetchImpl, sinceHours: 720 })]);
  assert.equal(peak, 1, 'hai lượt không chạy chồng');
  assert.equal(first.conversationOrders, 1);
  assert.equal(second.conversationOrders, 1);
  assert.deepEqual(seen, [1, 1], 'lượt bấm tay cũng chạy móc đơn POS của hội thoại');
  assert.equal(posSync.posSyncRunning(), false);
});
