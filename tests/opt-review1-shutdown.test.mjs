// R1-04: tắt máy chủ — prepare (chào QR, các kho nhỏ, nhật ký) chậm không được ăn hết giờ của kho hội thoại:
// quá prepareTimeoutMs thì bỏ chờ, ghi kho hội thoại rồi thoát 0. Mặc định đủ rộng (30 giây, prepare 4 giây).
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFileSync, writeFileSync } from 'node:fs';
import { tempDir } from './helpers/temp-dir.mjs';

process.env.META_CONVERSATIONS_PATH = path.join(tempDir('opt-review1-shutdown-'), 'meta-conversations.json');
const messaging = await import('../app/messaging-store.mjs');

test('R1-04: prepare treo → sau prepareTimeoutMs vẫn ghi kho hội thoại và thoát 0 trước hạn tổng', async () => {
  writeFileSync(process.env.META_CONVERSATIONS_PATH, JSON.stringify({ conversations: [], messages: {} }));
  const order = [];
  let exitCode = null;
  const startedAt = Date.now();
  const exited = new Promise(resolve => {
    messaging.installMessagingStoreShutdownFlush({
      signals: ['opt-review1-shutdown'],
      timeoutMs: 2000,
      prepareTimeoutMs: 100,
      prepare: async () => { order.push('prepare'); await new Promise(() => {}); },
      exit: code => { exitCode = code; order.push('exit'); resolve(); }
    });
  });
  await messaging.updateMessagingStore(store => { messaging.ensureConversation(store, { pageId: 'p', psid: '1' }); }, { defer: true });
  process.emit('opt-review1-shutdown');
  await exited;
  assert.equal(exitCode, 0);
  assert.deepEqual(order, ['prepare', 'exit']);
  assert.ok(Date.now() - startedAt < 2000, 'không đợi tới hạn tổng');
  const onDisk = JSON.parse(readFileSync(process.env.META_CONVERSATIONS_PATH, 'utf8'));
  assert.deepEqual(onDisk.conversations.map(item => item.id), ['p:1']);
});

test('R1-04: mặc định tổng 30 giây, prepare 4 giây (systemd chờ 90 giây)', () => {
  const source = readFileSync(new URL('../app/messaging-store.mjs', import.meta.url), 'utf8');
  assert.match(source, /installMessagingStoreShutdownFlush\(\{ signals = \['SIGTERM', 'SIGINT'\], timeoutMs = 30000, prepareTimeoutMs = 4000,/);
  assert.doesNotMatch(readFileSync(new URL('../deploy/facebook-crm.service', import.meta.url), 'utf8'), /TimeoutStopSec=([0-9]|[12][0-9]|30)s?\s*$/m);
});
