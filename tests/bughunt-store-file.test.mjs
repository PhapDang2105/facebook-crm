import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, utimesSync } from 'node:fs';
import { storePath } from './helpers/temp-messaging-store.mjs';
import { readMessagingStore, updateMessagingStore } from '../app/messaging-store.mjs';

test('tệp kho bị tiến trình khác chạm trong lúc mutate đang chờ: thay đổi vừa ghi không bị bản đọc lại đè mất', async () => {
  await readMessagingStore();
  let release;
  let started;
  const gate = new Promise(resolve => { release = resolve; });
  const mutateStarted = new Promise(resolve => { started = resolve; });
  const pending = updateMessagingStore(async store => {
    started();
    await gate;
    store.conversations.push({ id: '110:9', pageId: '110', psid: '9', name: 'Khách 9', source: 'inbox' });
    store.messages['110:9'] = [];
    return 'done';
  });
  await mutateStarted;
  // Tiến trình khác ghi tệp (mốc sửa đổi) trong lúc mutate còn chờ; một lượt đọc
  // thường (HTTP GET) thấy mốc mới nên nạp lại tệp vào cache.
  writeFileSync(storePath, JSON.stringify({ conversations: [], messages: {}, commentIndex: {} }));
  const later = new Date(Date.now() + 5000);
  utimesSync(storePath, later, later);
  const reloaded = await readMessagingStore();
  assert.equal(reloaded.conversations.length, 0, 'lượt đọc thấy bản bên ngoài');
  release();
  assert.equal(await pending, 'done');
  const onDisk = JSON.parse(readFileSync(storePath, 'utf8'));
  assert.equal(onDisk.conversations.some(item => item.id === '110:9'), true, 'tệp đã có thay đổi');
  const current = await readMessagingStore();
  assert.equal(current.conversations.some(item => item.id === '110:9'), true, 'cache trong bộ nhớ khớp tệp vừa ghi');
  // Lượt ghi kế tiếp không được xoá mất hội thoại 110:9.
  await updateMessagingStore(store => { store.conversations.push({ id: '110:10', pageId: '110', psid: '10', name: 'Khách 10', source: 'inbox' }); });
  const after = JSON.parse(readFileSync(storePath, 'utf8'));
  assert.deepEqual(after.conversations.map(item => item.id), ['110:9', '110:10']);
});

test('tệp kho hỏng (JSON lỗi) không bị lượt ghi kế tiếp đè thành kho rỗng: bản hỏng được cất sang tệp .corrupt-*', async () => {
  const { existsSync, readdirSync } = await import('node:fs');
  const path = await import('node:path');
  const garbage = '{"conversations":[{"id":"110:1"}' ; // tệp bị cắt dở
  writeFileSync(storePath, garbage);
  const later = new Date(Date.now() + 10_000);
  utimesSync(storePath, later, later);
  const store = await readMessagingStore();
  assert.equal(store.conversations.length, 0, 'không đọc được thì làm việc với kho rỗng để server vẫn chạy');
  await updateMessagingStore(current => { current.conversations.push({ id: '110:2', pageId: '110', psid: '2', name: 'Khách 2', source: 'inbox' }); current.messages['110:2'] = []; });
  const directory = path.dirname(storePath);
  const backups = readdirSync(directory).filter(name => name.startsWith(`${path.basename(storePath)}.corrupt-`));
  assert.equal(backups.length, 1, 'bản hỏng được giữ lại để khôi phục tay');
  assert.equal(readFileSync(path.join(directory, backups[0]), 'utf8'), garbage);
  assert.equal(existsSync(storePath), true);
  assert.deepEqual(JSON.parse(readFileSync(storePath, 'utf8')).conversations.map(item => item.id), ['110:2']);
});

test('chưa có tệp kho (lần chạy đầu) thì là kho rỗng bình thường, không tạo tệp .corrupt-*', async () => {
  const { readdirSync, rmSync } = await import('node:fs');
  const path = await import('node:path');
  const directory = path.dirname(storePath);
  const before = readdirSync(directory).filter(name => name.includes('.corrupt-')).length;
  rmSync(storePath, { force: true });
  const store = await readMessagingStore();
  assert.equal(store.conversations.length, 0);
  assert.equal(readdirSync(directory).filter(name => name.includes('.corrupt-')).length, before);
});
