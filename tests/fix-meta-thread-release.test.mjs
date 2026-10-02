// Handover Protocol: khi Meta giao luồng cho app CRM (định tuyến liên kết m.me) trên Page vận hành ở Pancake,
// CRM gửi xong ưu đãi QR thì trả quyền giữ luồng về app mặc định (POST /{page-id}/release_thread_control).
// Không gọi Meta thật: fetch giả.
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.META_GRAPH_VERSION = 'v21.0';
process.env.META_APP_SECRET = 'test-app-secret';

const { releaseThreadControl } = await import('../app/meta-graph.mjs');
const { createQrGreeter, createThreadReleaser } = await import('../app/qr-greeting.mjs');
const { registerQrCode } = await import('../app/qr-scans.mjs');

await registerQrCode('tmdt-01');

const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const conversation = (id, extra = {}) => ({ id, psid: id.split(':')[1], pageId: id.split(':')[0], name: `Khách ${id}`, ...extra });
const scan = (conv, extra = {}) => ({ type: 'referral', conversation: conv, referral: { ref: 'tmdt-01', source: 'SHORTLINK' }, ...extra });

async function withFakeFetch(handler, run) {
  const realFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), method: options.method, body: Object.fromEntries(new URLSearchParams(options.body || '')) });
    return handler(calls.length);
  };
  try {
    return await run(calls);
  } finally {
    globalThis.fetch = realFetch;
  }
}

test('releaseThreadControl: POST /{page-id}/release_thread_control với recipient.id = PSID, token Page và appsecret_proof', async () => {
  await withFakeFetch(() => ({ ok: true, status: 200, json: async () => ({ success: true }) }), async calls => {
    const result = await releaseThreadControl({ pageId: '103549382215599', psid: '777', pageAccessToken: 'PAGE_TOKEN', metadata: 'crm-qr' });
    assert.deepEqual(result, { success: true });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://graph.facebook.com/v21.0/103549382215599/release_thread_control');
    assert.equal(calls[0].method, 'POST');
    assert.deepEqual(JSON.parse(calls[0].body.recipient), { id: '777' });
    assert.equal(calls[0].body.metadata, 'crm-qr');
    assert.equal(calls[0].body.access_token, 'PAGE_TOKEN');
    assert.match(calls[0].body.appsecret_proof, /^[0-9a-f]{64}$/);
  });
  // Meta từ chối (app không giữ luồng): ném lỗi có lời của Meta để nơi gọi ghi log.
  await withFakeFetch(() => ({ ok: false, status: 400, json: async () => ({ error: { message: '(#10) App is not thread owner' } }) }), async () => {
    await assert.rejects(releaseThreadControl({ pageId: '1', psid: '2', pageAccessToken: 'T' }), /not thread owner/);
  });
});

test('createThreadReleaser: chỉ trả luồng khi shouldRelease cho phép; lỗi bị nuốt, cùng lý do chỉ ghi một dòng mỗi 10 phút', async () => {
  const released = [];
  const logs = [];
  let clock = 5_000_000;
  let fail = '';
  const releaser = createThreadReleaser({
    release: async payload => { if (fail) throw new Error(fail); released.push(payload); },
    getToken: async pageId => `token-${pageId}`,
    // Như app/server.mjs: Page chỉ nghe referral, sự kiện không đến qua standby.
    shouldRelease: change => !change.standby && change.conversation.pageId === '103549382215599',
    now: () => clock,
    log: line => logs.push(line),
    logError: line => logs.push(`ERR ${line}`)
  });
  assert.equal(await releaser(scan(conversation('103549382215599:a'))), true);
  assert.deepEqual(released, [{ pageId: '103549382215599', psid: 'a', pageAccessToken: 'token-103549382215599', metadata: 'crm-qr' }]);
  // Sửa 02/10: dòng log đổi thành "QR: đã trả luồng về app mặc định — <khách>", chỉ ghi lần thành công đầu
  // của mỗi hội thoại (chủ shop kiểm trên máy chủ).
  assert.deepEqual(logs, ['QR: đã trả luồng về app mặc định — Khách 103549382215599:a']);
  assert.equal(await releaser(scan(conversation('103549382215599:a'))), true);
  assert.equal(released.length, 2, 'lần sau vẫn trả luồng');
  assert.equal(logs.length, 1, 'nhưng không ghi thêm dòng cho cùng hội thoại');
  released.pop();
  // Standby (CRM không giữ luồng), Page CRM tự vận hành, change không có hội thoại: không gọi Meta.
  assert.equal(await releaser(scan(conversation('103549382215599:b'), { standby: true })), false);
  assert.equal(await releaser(scan(conversation('200000000000002:c'))), false);
  assert.equal(await releaser({ type: 'status', conversationId: '103549382215599:a' }), false);
  assert.equal(await releaser(null), false);
  assert.equal(released.length, 1);
  // Lỗi (chưa bật định tuyến liên kết nên CRM không giữ luồng; token hỏng…): nuốt, ghi một dòng.
  fail = '(#10) App is not thread owner';
  for (let index = 0; index < 20; index += 1) assert.equal(await releaser(scan(conversation(`103549382215599:e${index}`))), false);
  assert.equal(logs.filter(line => line.startsWith('ERR ')).length, 1);
  assert.match(logs.at(-1), /^ERR QR: không trả được quyền giữ luồng cho Khách 103549382215599:e0: \(#10\) App is not thread owner$/);
  clock += 11 * 60 * 1000;
  await releaser(scan(conversation('103549382215599:f')));
  assert.equal(logs.filter(line => line.startsWith('ERR ')).length, 2);
  // Không lấy được token Page cũng chỉ là một dòng lỗi, không ném ra ngoài.
  const noToken = createThreadReleaser({ release: async () => {}, getToken: async () => { throw new Error('Facebook Page này chưa được kết nối trong CRM.'); }, log: () => {}, logError: line => logs.push(`ERR ${line}`) });
  assert.equal(await noToken(scan(conversation('103549382215599:g'))), false);
  assert.match(logs.at(-1), /chưa được kết nối/);
});

function greeter(overrides = {}) {
  const sent = [];
  const logs = [];
  const finished = [];
  const instance = createQrGreeter({
    offerMessage: async () => 'Ưu đãi QR',
    send: async (conv, payload) => { sent.push({ id: conv.id, ...payload }); },
    delayMs: 30,
    cooldownMs: 10_000,
    log: line => logs.push(line),
    logError: line => logs.push(`ERR ${line}`),
    ...overrides
  });
  const afterGreeting = change => { finished.push({ id: change.conversation.id, sentBefore: sent.length }); };
  return { ...instance, sent, logs, finished, afterGreeting };
}

test('bộ chào gọi afterGreeting SAU khi gửi ưu đãi — đúng một lần cho mỗi lượt quét; không truyền thì chạy như cũ', async () => {
  const g = greeter();
  const conv = conversation('103549382215599:h');
  g.schedule([scan(conv)], { afterGreeting: g.afterGreeting });
  await pause(10);
  assert.deepEqual(g.finished, [], 'chưa gửi ưu đãi thì chưa trả luồng');
  await pause(80);
  assert.equal(g.sent.length, 1);
  assert.deepEqual(g.finished, [{ id: conv.id, sentBefore: 1 }]);
  // Đường Pancake / đồng bộ không truyền afterGreeting.
  const plain = greeter();
  plain.schedule([scan(conversation('103549382215599:i'))]);
  await pause(80);
  assert.equal(plain.sent.length, 1);
  assert.deepEqual(plain.finished, []);
});

// Sửa 02/10: "bot tắt / nhân viên đang nhận" không còn là lý do bỏ chào (quyết định chủ shop) — thay bằng
// "nhân viên vừa nhắn"; lượt bị bỏ vì lý do đó vẫn phải trả luồng.
test('afterGreeting vẫn chạy khi CRM không chào (nhân viên vừa nhắn, vừa chào, mẫu trống, gửi lỗi, hẹn bị hủy) — CRM không được giữ luồng mãi', async () => {
  const busy = greeter({ staffLastMessageAt: async () => Date.now() - 60_000 });
  busy.schedule([scan(conversation('103549382215599:nv'))], { afterGreeting: busy.afterGreeting });
  await pause(80);
  assert.deepEqual(busy.finished.map(item => item.id), ['103549382215599:nv']);
  assert.equal(busy.sent.length, 0);
  const g = greeter();
  // Quét lại trong thời gian chờ: không chào lại nhưng vẫn trả luồng cho lượt đó.
  const again = conversation('103549382215599:lai');
  g.schedule([scan(again)], { afterGreeting: g.afterGreeting });
  await pause(80);
  g.schedule([scan(again)], { afterGreeting: g.afterGreeting });
  await pause(5);
  assert.equal(g.finished.filter(item => item.id === again.id).length, 2);
  assert.equal(g.sent.filter(item => item.id === again.id).length, 1);

  const empty = greeter({ offerMessage: async () => '' });
  empty.schedule([scan(conversation('103549382215599:trong'))], { afterGreeting: empty.afterGreeting });
  const failing = greeter({ send: async () => { throw new Error('ngoài cửa sổ 24h'); } });
  failing.schedule([scan(conversation('103549382215599:loi'))], { afterGreeting: failing.afterGreeting });
  await pause(80);
  assert.deepEqual(empty.finished.map(item => item.id), ['103549382215599:trong']);
  assert.deepEqual(failing.finished.map(item => item.id), ['103549382215599:loi']);
  assert.ok(failing.logs.some(line => /KHÔNG gửi được ưu đãi/.test(line)));

  // Botcake chào trong lúc CRM đang hẹn: hẹn bị hủy, lượt Meta đang chờ vẫn được trả luồng.
  const cancelled = greeter();
  const conv = conversation('103549382215599:huy');
  cancelled.schedule([scan(conv)], { afterGreeting: cancelled.afterGreeting });
  cancelled.schedule([{ type: 'message', conversation: conv, referral: { ref: 'tmdt-01', source: 'SHORTLINK', type: 'BOTCAKE_OPTIN' }, message: { direction: 'outgoing', text: 'Mã thẻ: #tmdt-01' } }]);
  await pause(80);
  assert.equal(cancelled.sent.length, 0);
  assert.deepEqual(cancelled.finished.map(item => item.id), [conv.id]);

  // afterGreeting ném lỗi: bị nuốt, ghi log, không làm hỏng bộ chào.
  const throwing = greeter();
  throwing.schedule([scan(conversation('103549382215599:nem'))], { afterGreeting: () => { throw new Error('hỏng'); } });
  await pause(80);
  assert.equal(throwing.sent.length, 1);
  assert.ok(throwing.logs.some(line => /ERR QR: lỗi sau khi chào: hỏng/.test(line)));
});
