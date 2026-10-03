// Cầu nối Pancake 1.1.3 (extensions/crm-pancake-bridge): nạp background.js / crm-bridge.js trong vm với chrome / window giả.
// Kiểm: tham số tìm ID ưu tiên dữ liệu Pancake, lỗi giữ lời Pancake, mọi lệnh chạy lần lượt, content script cũ báo
// "Cầu nối vừa cập nhật" khi extension đã tải lại.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const backgroundSource = readFileSync(new URL('../extensions/crm-pancake-bridge/background.js', import.meta.url), 'utf8');
const bridgeSource = readFileSync(new URL('../extensions/crm-pancake-bridge/crm-bridge.js', import.meta.url), 'utf8');
const manifest = JSON.parse(readFileSync(new URL('../extensions/crm-pancake-bridge/manifest.json', import.meta.url), 'utf8'));

/** Trang pancake.vn giả: `respond(data)` trả lời lệnh extension Pancake (null = im lặng). */
function fakePancakePage(respond, log = []) {
  const listeners = new Set();
  const window = {
    addEventListener: (type, listener) => { if (type === 'message') listeners.add(listener); },
    removeEventListener: (type, listener) => listeners.delete(listener),
    postMessage(data) {
      log.push({ at: 'post', type: data.type, data });
      const reply = respond(data);
      if (!reply) return;
      setTimeout(() => {
        log.push({ at: 'reply', type: reply.type });
        for (const listener of [...listeners]) listener({ source: window, data: { taskId: data.taskId, ...reply } });
      }, reply.delayMs || 5);
    }
  };
  return window;
}

function loadBackground(respond, log = []) {
  let onMessage = null;
  const started = [];
  const window = fakePancakePage(respond, log);
  const context = {
    console: { warn: () => {}, log: () => {}, error: () => {} },
    setTimeout, clearTimeout, Promise, JSON, Math, Date, Number, String, RegExp, Object, Boolean,
    window,
    document: { readyState: 'complete', body: { childElementCount: 3 } },
    location: { href: 'https://pancake.vn/' },
    chrome: {
      tabs: {
        query: async () => [{ id: 7, status: 'complete' }],
        get: async () => ({ id: 7, status: 'complete' }),
        create: async () => { throw new Error('không được mở tab mới trong test'); },
        sendMessage: async (tabId, message) => { started.push(message.requestId); }
      },
      scripting: { executeScript: async ({ func, args = [] }) => [{ result: await func(...args) }] },
      runtime: { onMessage: { addListener: listener => { onMessage = listener; } } }
    }
  };
  vm.createContext(context);
  vm.runInContext(backgroundSource, context);
  const send = (item, requestId = 'r1') => new Promise(resolve => {
    onMessage({ type: 'GN_SEND', requestId, item }, { url: 'https://fb.giotnang.vn/', tab: { id: 3 } }, resolve);
  });
  return { context, send, started };
}

const baseItem = { key: 'k1', pageId: '110000', convId: '110000_222222', globalUserId: '', needsGlobalId: true, updatedTime: 1700000000000, text: 'Dạ chị ơi', name: 'Tên CRM' };

test('manifest 1.1.3; validItem như cũ (lệnh hợp lệ / thiếu ID mà không xin tìm / chữ rỗng)', () => {
  assert.equal(manifest.version, '1.1.3');
  const { context } = loadBackground(() => null);
  assert.equal(context.validItem(baseItem), true);
  assert.equal(context.validItem({ ...baseItem, needsGlobalId: false }), false);
  assert.equal(context.validItem({ ...baseItem, globalUserId: '123456', needsGlobalId: false }), true);
  assert.equal(context.validItem({ ...baseItem, text: '  ' }), false);
  assert.equal(context.validItem({ ...baseItem, convId: '999999_222222' }), false);
});

test('tham số tìm ID: ưu tiên tên / mốc / mã luồng Pancake; thiếu thì lùi về PSID / tên CRM / mốc CRM', () => {
  const { context } = loadBackground(() => null);
  const fallback = context.lookupArgs(baseItem);
  assert.equal(fallback.threadId, '222222');
  assert.equal(fallback.customerName, 'Tên CRM');
  assert.equal(fallback.conversationUpdatedTime, 1700000000000);
  assert.equal(JSON.stringify(fallback.sources), JSON.stringify({ threadId: 'psid', customerName: 'crm', updatedTime: 'crm' }));
  const pancake = context.lookupArgs({ ...baseItem, pancakeName: 'Tên Pancake', pancakeUpdatedAt: 1700000999000, threadId: 't_98765', threadKey: 't_abc' });
  assert.equal(pancake.threadId, 't_98765');
  assert.equal(pancake.threadKey, 't_abc');
  assert.equal(pancake.customerName, 'Tên Pancake');
  assert.equal(pancake.conversationUpdatedTime, 1700000999000);
  // Chỉ có thread_key: dùng làm threadId; mã luồng lạ (ký tự đặc biệt) bị bỏ.
  assert.equal(context.lookupArgs({ ...baseItem, threadKey: 't_abc' }).threadId, 't_abc');
  assert.equal(context.lookupArgs({ ...baseItem, threadId: '<script>' }).threadId, '222222');
});

test('extension Pancake không tìm được ID: lỗi giữ nguyên lời Pancake (data.error), đánh dấu lookupFailed, không gửi tin', async () => {
  const log = [];
  const { send } = loadBackground(data => (data.type === 'GET_GLOBAL_ID_FOR_CONV'
    ? { type: 'GET_GLOBAL_ID_FOR_CONV_FAILURE', error: { code: 'NOT_FOUND', message: 'no thread matched' } }
    : { type: 'REPLY_INBOX_PHOTO_SUCCESS' }), log);
  const result = await send({ ...baseItem, pancakeName: 'Tên Pancake', threadId: 't_1' });
  assert.equal(result.ok, false);
  assert.equal(result.lookupFailed, true);
  assert.match(result.error, /không tìm được ID Facebook/);
  assert.match(result.error, /NOT_FOUND/);
  assert.match(result.error, /no thread matched/);
  const lookup = log.find(entry => entry.type === 'GET_GLOBAL_ID_FOR_CONV');
  assert.equal(lookup.data.customerName, 'Tên Pancake');
  assert.equal(lookup.data.threadId, 't_1');
  assert.equal(log.some(entry => entry.type === 'REPLY_INBOX_PHOTO'), false, 'không gửi khi không có ID');
  // SUCCESS mà không có ID: câu trả lời thô (bỏ taskId) đi kèm lỗi.
  const empty = loadBackground(data => (data.type === 'GET_GLOBAL_ID_FOR_CONV' ? { type: 'GET_GLOBAL_ID_FOR_CONV_SUCCESS', globalId: null, reason: 'searched 0' } : null));
  const second = await empty.send(baseItem);
  assert.equal(second.lookupFailed, true);
  assert.match(second.error, /searched 0/);
  assert.doesNotMatch(second.error, /taskId/);
});

test('tìm được ID rồi gửi: trả globalId; lỗi gửi giữ lời Pancake', async () => {
  const ok = loadBackground(data => (data.type === 'GET_GLOBAL_ID_FOR_CONV' ? { type: 'GET_GLOBAL_ID_FOR_CONV_SUCCESS', globalId: '100012345' } : { type: 'REPLY_INBOX_PHOTO_SUCCESS', messageId: 'm1' }));
  const sent = await ok.send(baseItem);
  assert.equal(sent.ok, true);
  assert.equal(sent.globalId, '100012345');
  assert.equal(sent.replyType, undefined, 'loại trả lời chỉ để ghi nhật ký');
  const failing = loadBackground(() => ({ type: 'REPLY_INBOX_PHOTO_FAILURE', error: { errorDescription: 'Bạn không thể gửi', fbErrorCode: 1545041 } }));
  const failed = await failing.send({ ...baseItem, globalUserId: '100012345', needsGlobalId: false });
  assert.equal(failed.ok, false);
  assert.equal(failed.lookupFailed, undefined);
  assert.match(failed.error, /1545041/);
});

test('mọi lệnh chạy lần lượt (bám đuổi + vận đơn không chồng nhau); báo trang CRM khi lệnh bắt đầu chạy', async () => {
  const log = [];
  const { send, started } = loadBackground(data => (data.type === 'REPLY_INBOX_PHOTO' ? { type: 'REPLY_INBOX_PHOTO_SUCCESS', delayMs: 40 } : null), log);
  const item = { ...baseItem, globalUserId: '100012345', needsGlobalId: false };
  const [first, second] = await Promise.all([send({ ...item, key: 'a' }, 'r-a'), send({ ...item, key: 'b' }, 'r-b')]);
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  const sequence = log.filter(entry => /REPLY_INBOX_PHOTO/.test(entry.type)).map(entry => `${entry.at}:${entry.type}`);
  assert.deepEqual(sequence, ['post:REPLY_INBOX_PHOTO', 'reply:REPLY_INBOX_PHOTO_SUCCESS', 'post:REPLY_INBOX_PHOTO', 'reply:REPLY_INBOX_PHOTO_SUCCESS'], 'lệnh sau chỉ gửi khi lệnh trước xong');
  assert.deepEqual(started, ['r-a', 'r-b']);
});

function loadBridge({ sendMessage }) {
  const posted = [];
  const listeners = [];
  const dataset = {};
  const window = {
    location: { origin: 'https://fb.giotnang.vn' },
    addEventListener: (type, listener) => listeners.push(listener),
    postMessage: data => posted.push(data)
  };
  const context = {
    window,
    location: { pathname: '/' },
    document: { documentElement: { dataset }, addEventListener: () => {} },
    chrome: { runtime: { id: 'x', getManifest: () => ({ version: '1.1.3' }), sendMessage, lastError: undefined, onMessage: { addListener: () => {} } } }
  };
  vm.createContext(context);
  vm.runInContext(bridgeSource, context);
  const fire = data => listeners.forEach(listener => listener({ source: window, origin: 'https://fb.giotnang.vn', data }));
  return { posted, dataset, fire, context };
}

test('crm-bridge: extension vừa tải lại (context invalidated) → trả lỗi "tải lại trang CRM", gỡ dấu cầu nối, thôi báo sẵn sàng', () => {
  const bridge = loadBridge({ sendMessage: () => { throw new Error('Extension context invalidated.'); } });
  assert.equal(bridge.dataset.gnBridge, '1.1.3');
  bridge.fire({ type: 'GN_BRIDGE_SEND', requestId: 'q1', item: { a: 1 } });
  const result = bridge.posted.find(item => item.type === 'GN_BRIDGE_RESULT');
  assert.equal(result.requestId, 'q1');
  assert.equal(result.ok, false);
  assert.equal(result.bridgeGone, true);
  assert.equal(result.error, 'Cầu nối vừa cập nhật — tải lại trang CRM');
  assert.equal(bridge.dataset.gnBridge, undefined, 'gỡ dấu: trang ẩn nút Gửi ngay');
  assert.ok(bridge.posted.some(item => item.type === 'GN_BRIDGE_GONE'));
  const readyBefore = bridge.posted.filter(item => item.type === 'GN_BRIDGE_READY').length;
  bridge.fire({ type: 'GN_BRIDGE_PING' });
  assert.equal(bridge.posted.filter(item => item.type === 'GN_BRIDGE_READY').length, readyBefore, 'không báo sẵn sàng nữa');
  // Lệnh sau: trả lỗi ngay, không gọi nền.
  bridge.fire({ type: 'GN_BRIDGE_SEND', requestId: 'q2', item: { a: 1 } });
  assert.equal(bridge.posted.filter(item => item.type === 'GN_BRIDGE_RESULT' && item.requestId === 'q2')[0].bridgeGone, true);
});

test('crm-bridge: lệnh chuyển requestId sang nền; lỗi lastError thường vẫn trả nguyên văn', () => {
  let message = null;
  const bridge = loadBridge({ sendMessage: (value, callback) => { message = value; callback({ ok: true, globalId: '1' }); } });
  bridge.fire({ type: 'GN_BRIDGE_SEND', requestId: 'q3', item: { a: 1 } });
  assert.equal(message.requestId, 'q3');
  assert.equal(bridge.posted.find(item => item.type === 'GN_BRIDGE_RESULT').ok, true);
  const other = loadBridge({ sendMessage: (value, callback) => { other.context.chrome.runtime.lastError = { message: 'Could not establish connection' }; callback(undefined); } });
  other.fire({ type: 'GN_BRIDGE_SEND', requestId: 'q4', item: { a: 1 } });
  const result = other.posted.find(item => item.type === 'GN_BRIDGE_RESULT');
  assert.equal(result.error, 'Could not establish connection');
  assert.equal(result.bridgeGone, undefined);
  assert.equal(other.dataset.gnBridge, '1.1.3');
});
