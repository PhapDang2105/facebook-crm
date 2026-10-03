import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

// Hàng chờ báo vận đơn qua cầu nối Pancake (web/shipping-notices.js + sendThroughBridge của app.js):
// hết giờ chờ ("chưa rõ") không được để lượt tự gửi 5 phút sau gửi lại; kết quả gửi được tới trễ phải
// báo về /api/shipping/notices/results (trước đây đi nhầm sang hàng bám đuổi với token rỗng).
const source = (await readFile(new URL('../web/shipping-notices.js', import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
const app = (await readFile(new URL('../web/app.js', import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
const tick = async (count = 5) => { for (let index = 0; index < count; index += 1) await new Promise(resolve => setImmediate(resolve)); };

function element(extra = {}) {
  const listeners = {};
  return {
    listeners,
    checked: false,
    disabled: false,
    textContent: '',
    innerHTML: '',
    title: '',
    dataset: {},
    classList: { contains: () => false },
    addEventListener: (type, handler) => { listeners[type] = handler; },
    ...extra
  };
}

function loadShipping({ queue }) {
  const requests = [];
  const intervals = [];
  const bridgeCalls = [];
  const storage = new Map([['crm-shipping-auto-bridge', '1']]);
  const parts = {
    '#shipping-notices-list': element(),
    '#shipping-notices-status': element(),
    '#shipping-notify-toggle': element(),
    '#shipping-auto-bridge': element(),
    '#shipping-notices-send-all': element(),
    '#shipping-notices-refresh': element()
  };
  const root = element({ querySelector: selector => parts[selector] || null });
  const context = {
    requests,
    intervals,
    bridgeCalls,
    console,
    JSON,
    Date,
    Math,
    Promise,
    Object,
    Number,
    String,
    Array,
    Set,
    Error,
    setTimeout: (callback) => { callback(); return 0; },
    setInterval: callback => { intervals.push(callback); return intervals.length; },
    alert: () => {},
    confirm: () => true,
    localStorage: {
      getItem: key => (storage.has(key) ? storage.get(key) : null),
      setItem: (key, value) => { storage.set(key, String(value)); }
    },
    escapeHtml: value => String(value).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]),
    document: {
      documentElement: { dataset: { gnBridge: '1' } },
      querySelector: selector => (selector === '#shipping-notices' ? root : selector === '#shipping-view' ? element({ classList: { contains: () => true } }) : null),
      querySelectorAll: () => []
    },
    fetch: async (path, options = {}) => {
      const body = options.body ? JSON.parse(options.body) : null;
      requests.push({ path, method: options.method || 'GET', body });
      const reply = path === '/api/shipping/notices' ? { configured: true, items: queue() }
        : path === '/api/shipping/notices/bridge-items' ? { items: body.keys.map(key => ({ key, pageId: 'p', convId: 'c', text: 't' })), skipped: [] }
        : { saved: true };
      return { ok: true, status: 200, json: async () => reply };
    },
    sendThroughBridge: async (item, token, options) => {
      bridgeCalls.push({ item, token, options });
      return { ok: false, error: 'timeout', unknown: true };
    }
  };
  vm.createContext(context);
  vm.runInContext(source, context);
  return { context, parts, storage };
}

test('B5: cầu nối hết giờ chờ → tính một lần thử trên máy chủ, giữ tin 1 giờ (tự gửi không gửi lại); gửi được trễ → báo đúng hàng chờ vận đơn', async () => {
  let pending = [{ key: 'conv|GN1|picked', name: 'Khách', inWindow: false, attempts: 0, text: 'Đơn đã giao cho bên vận chuyển', trackingNumber: 'SPX1', trackingUrl: 'https://spx.vn/t/SPX1' }];
  const { context, storage } = loadShipping({ queue: () => pending });
  assert.equal(context.intervals.length, 1);
  await context.intervals[0]();
  await tick();
  assert.equal(context.bridgeCalls.length, 1);
  assert.equal(typeof context.bridgeCalls[0].options?.onLate, 'function', 'gửi kèm chỗ báo kết quả trễ');
  const reported = context.requests.filter(request => request.path === '/api/shipping/notices/results');
  assert.equal(reported.length, 1, '"chưa rõ" được báo lên máy chủ như một lần thử');
  assert.equal(reported[0].body.results[0].ok, false);
  assert.match(reported[0].body.results[0].error, /chưa rõ/);
  assert.ok(JSON.parse(storage.get('crm-shipping-uncertain'))['conv|GN1|picked'] > Date.now());

  // Lượt tự gửi 5 phút sau: tin đang giữ "chưa rõ" không được gửi lại.
  pending = pending.map(item => ({ ...item, attempts: 1, error: 'Cầu nối không trả lời — chưa rõ đã gửi hay chưa' }));
  await context.intervals[0]();
  await tick();
  assert.equal(context.bridgeCalls.length, 1, 'không gửi lại');
  assert.equal(context.requests.filter(request => request.path === '/api/shipping/notices/bridge-items').length, 1);

  // Extension báo gửi được (trễ): ghi "đã gửi" vào hàng chờ vận đơn, bỏ giữ.
  pending = [];
  context.bridgeCalls[0].options.onLate({ ok: true, globalId: 'g' });
  await tick();
  const late = context.requests.filter(request => request.path === '/api/shipping/notices/results').at(-1);
  assert.equal(JSON.stringify(late.body), JSON.stringify({ results: [{ key: 'conv|GN1|picked', ok: true, via: 'pancake-bridge' }] }));
  assert.equal(JSON.parse(storage.get('crm-shipping-uncertain'))['conv|GN1|picked'], undefined);
});

test('X1: link hành trình chỉ nhận http(s) — "javascript:" chỉ hiện mã vận đơn, không thành link', async () => {
  const { context, parts } = loadShipping({ queue: () => [
    { key: 'a|1|picked', name: 'A', inWindow: true, trackingNumber: 'SAFE1', trackingUrl: 'https://track.example/SAFE1' },
    { key: 'b|2|picked', name: 'B', inWindow: true, trackingNumber: 'BAD2', trackingUrl: 'javascript:alert(1)' }
  ] });
  parts['#shipping-notices-refresh'].listeners.click();
  await tick();
  const html = parts['#shipping-notices-list'].innerHTML;
  assert.match(html, /<a href="https:\/\/track\.example\/SAFE1" target="_blank" rel="noopener">SAFE1<\/a>/);
  assert.doesNotMatch(html, /javascript:/);
  assert.match(html, /· BAD2/);
  assert.doesNotMatch(html, /undefined/, 'ô trống không hiện chữ "undefined"');
  assert.ok(context);
});

test('B5: kết quả trễ của cầu nối đi theo onLate của bên gọi; không có onLate mới là lô bám đuổi', () => {
  const at = app.indexOf("if (data.type !== 'GN_BRIDGE_RESULT') return;");
  const handler = app.slice(at, at + 1500);
  assert.match(handler, /if \(typeof late\.onLate === 'function'\) \{\n\s*try \{ late\.onLate\(data\); \}/);
  assert.ok(handler.indexOf('late.onLate(data)') < handler.indexOf("/api/chatbot/follow-ups/batch-results"));
  assert.match(app, /function sendThroughBridge\(item, token = '', \{ onLate = null \} = \{\}\) \{/);
  assert.match(app, /followUpBridgeLateResults\.set\(requestId, \{ key: item\.key, token, onLate \}\);/);
});
