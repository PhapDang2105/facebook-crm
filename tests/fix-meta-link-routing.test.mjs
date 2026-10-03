// "Định tuyến liên kết" của Meta: link m.me/<Page>?ref=tmdt-01 giao luồng cho app CRM, app mặc định vẫn là
// Pancake. Chỉ app đang giữ luồng gửi được tin, nên:
//  - khách cũ (hội thoại có pancakeConversationId): TRẢ luồng trước → gửi ưu đãi qua Pancake; Pancake lỗi → Send API Meta;
//  - khách mới: gửi qua Send API Meta trước → trả luồng.
// Chạy mã thật (webhook Meta → kho → bộ chào → meta-sync / pancake / meta-graph), chỉ thay fetch.
import test from 'node:test';
import assert from 'node:assert/strict';

const pageId = '103549382215599';
process.env.META_GRAPH_VERSION = 'v21.0';
process.env.META_APP_SECRET = 'test-app-secret';
process.env.META_REFERRAL_ONLY_PAGES = pageId;
process.env.PANCAKE_PAGE_ID = pageId;
process.env.PANCAKE_PAGE_NAME = 'Giọt Nắng';
process.env.PANCAKE_PAGE_ACCESS_TOKEN = 'PANCAKE_TOKEN';

const { processWebhookPayload } = await import('../app/meta-webhook.mjs');
const { updateMessagingStore, readMessagingStore } = await import('../app/messaging-store.mjs');
const { encryptToken, writeChannelStore } = await import('../app/channel-store.mjs');
const { sendConversationMessage } = await import('../app/meta-sync.mjs');
const { releaseThreadControl } = await import('../app/meta-graph.mjs');
const { getPageAccessToken } = await import('../app/channel-store.mjs');
const { isReferralOnlyPage } = await import('../app/config.mjs');
const { createLinkRoutedQrFlow, createQrGreeter, createThreadReleaser } = await import('../app/qr-greeting.mjs');
const { registerQrCode } = await import('../app/qr-scans.mjs');

await registerQrCode('tmdt-01');
await writeChannelStore({ items: [{ id: pageId, name: 'Giọt Nắng', token: encryptToken('META_PAGE_TOKEN') }] });

const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
// Pancake giãn nhịp giữa các lần gọi (giới hạn 5 lần/giây mỗi Page) nên không đợi theo giờ cố định: chờ tới khi
// bộ chào ghi dòng kết thúc của hội thoại đó (đã gửi / KHÔNG gửi / không chào), rồi nán thêm cho bước trả luồng.
async function until(condition, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && !condition()) await pause(10);
}
// Chờ dòng log kết thúc, rồi chờ ĐỦ số lời gọi mong đợi (bước trả luồng sau khi gửi), rồi nán ngắn để bắt lời gọi thừa.
async function settled(w, marker, expectedCalls = 0) {
  await until(() => w.logs.some(line => marker.test(line)));
  await until(() => w.calls.length >= expectedCalls);
  await pause(60);
}
let clock = 1_790_100_000_000;
const referralPayload = (psid, channel = 'messaging') => ({
  object: 'page',
  entry: [{ id: pageId, time: (clock += 1000), [channel]: [{ sender: { id: psid }, recipient: { id: pageId }, timestamp: clock, referral: { ref: 'tmdt-01', source: 'SHORTLINK', type: 'OPEN_THREAD' } }] }]
});

async function seedPancakeCustomer(psid) {
  await updateMessagingStore(store => {
    store.conversations.push({ id: `${pageId}:${psid}`, pageId, psid, name: `Khách cũ ${psid}`, source: 'inbox', pancakeConversationId: `${pageId}_${psid}`, profileResolvedAt: Date.now() });
    store.messages[`${pageId}:${psid}`] = [];
    return null;
  });
}

// Móc y như app/server.mjs (route webhook Meta), với fetch giả ghi lại thứ tự gọi ra ngoài.
function wiring({ pancake = 'ok', release = 'ok', metaSend = 'ok' } = {}) {
  const calls = [];
  const logs = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input, options = {}) => {
    const url = String(input);
    if (url.includes('/release_thread_control')) {
      calls.push('release');
      if (release === 'fail') return { ok: false, status: 400, json: async () => ({ error: { message: '(#10) App is not thread owner' } }) };
      return { ok: true, status: 200, json: async () => ({ success: true }) };
    }
    if (url.startsWith('https://graph.facebook.com/') && url.endsWith(`/${pageId}/messages`)) {
      calls.push('meta-send');
      if (metaSend === 'fail') return { ok: false, status: 400, json: async () => ({ error: { message: '(#10) outside allowed window' } }) };
      return { ok: true, status: 200, json: async () => ({ message_id: `m_meta_${calls.length}` }) };
    }
    if (url.includes('/conversations/') && url.includes('/messages') && (options.method || 'GET') === 'POST') {
      calls.push('pancake-send');
      const reply = body => ({ ok: true, status: 200, headers: { get: () => 'application/json' }, json: async () => body, text: async () => JSON.stringify(body) });
      if (pancake === 'fail') return reply({ success: false, message: 'Tin nhắn bị Facebook từ chối' });
      if (pancake === 'gateway') return { ok: false, status: 502, headers: { get: () => 'text/html' }, json: async () => ({}), text: async () => '' };
      return reply({ success: true, id: `m_pancake_${calls.length}` });
    }
    // Tra ảnh đại diện khách mới (resolveMissingProfiles): không liên quan thứ tự gửi.
    if (url.startsWith('https://graph.facebook.com/')) return { ok: true, status: 200, json: async () => ({}) };
    throw new Error(`gọi lạ: ${url}`);
  };
  const greeter = createQrGreeter({
    offerMessage: async () => [{ type: 'text', text: 'Ưu đãi QR phần 1' }, { type: 'text', text: 'Ưu đãi QR phần 2' }],
    send: (conversation, payload) => sendConversationMessage(conversation, payload),
    delayMs: 30,
    cooldownMs: 60_000,
    log: line => logs.push(line),
    logError: line => logs.push(`ERR ${line}`)
  });
  const shouldRelease = change => !change.standby && isReferralOnlyPage(change.conversation?.pageId);
  const releaseThread = createThreadReleaser({ release: releaseThreadControl, getToken: getPageAccessToken, shouldRelease, log: line => logs.push(line), logError: line => logs.push(`ERR ${line}`) });
  const handle = createLinkRoutedQrFlow({
    schedule: (changes, options) => greeter.schedule(changes, options),
    releaseThread,
    shouldRelease,
    sendPrimary: (conversation, payload) => sendConversationMessage(conversation, payload),
    sendViaMeta: (conversation, payload) => sendConversationMessage({ ...conversation, pancakeConversationId: '' }, payload),
    log: line => logs.push(line),
    logError: line => logs.push(`ERR ${line}`)
  });
  return { calls, logs, handle, greeter, restore: async () => { await greeter.flush({ timeoutMs: 3000 }).catch(() => {}); await pause(30); globalThis.fetch = realFetch; } };
}

const storedTexts = async psid => ((await readMessagingStore()).messages[`${pageId}:${psid}`] || []).filter(item => item.direction === 'outgoing').map(item => item.text);

test('khách cũ (có hội thoại Pancake): trả luồng NGAY khi nhận referral, rồi mới gửi ưu đãi qua Pancake; không trả luồng lần hai', async () => {
  await seedPancakeCustomer('cu-1');
  const w = wiring();
  try {
    w.handle(await processWebhookPayload(referralPayload('cu-1')));
    await until(() => w.calls.length >= 1);
    assert.equal(w.calls[0], 'release', 'trả luồng trước mọi lời gửi');
    await settled(w, /đã gửi ưu đãi cho Khách cũ cu-1/, 3);
    assert.deepEqual(w.calls, ['release', 'pancake-send', 'pancake-send']);
    assert.deepEqual(await storedTexts('cu-1'), ['Ưu đãi QR phần 1', 'Ưu đãi QR phần 2']);
    assert.equal(w.logs.filter(line => line === 'QR: đã trả luồng về app mặc định — Khách cũ cu-1').length, 1);
    assert.equal(w.logs.filter(line => line === 'QR: ưu đãi gửi qua Pancake (sau khi trả luồng) — Khách cũ cu-1').length, 1);
    assert.ok(w.logs.some(line => /QR: đã gửi ưu đãi cho Khách cũ cu-1 \(chữ\+chữ\)/.test(line)));
  } finally {
    await w.restore();
  }
});

test('khách cũ, Pancake từ chối: thử Send API Meta một lần, các phần sau đi tiếp đường Meta; log nói rõ đường nào thành công', async () => {
  await seedPancakeCustomer('cu-2');
  const w = wiring({ pancake: 'fail' });
  try {
    w.handle(await processWebhookPayload(referralPayload('cu-2')));
    await settled(w, /đã gửi ưu đãi cho Khách cũ cu-2/, 4);
    assert.deepEqual(w.calls, ['release', 'pancake-send', 'meta-send', 'meta-send'], 'Pancake chỉ bị thử một lần');
    assert.deepEqual(await storedTexts('cu-2'), ['Ưu đãi QR phần 1', 'Ưu đãi QR phần 2']);
    assert.ok(w.logs.some(line => /^ERR QR: gửi ưu đãi qua Pancake lỗi \(Pancake không nhận tin .*Tin nhắn bị Facebook từ chối\), thử Send API Meta — Khách cũ cu-2$/.test(line)), w.logs.join('\n'));
    assert.equal(w.logs.filter(line => line === 'QR: ưu đãi gửi qua Send API Meta (dự phòng, Pancake lỗi) — Khách cũ cu-2').length, 1);
    assert.ok(!w.logs.some(line => /gửi qua Pancake \(sau khi trả luồng\)/.test(line)));
  } finally {
    await w.restore();
  }
});

test('khách cũ, trả luồng lỗi: vẫn thử gửi qua Pancake, gửi xong thử trả luồng lần nữa', async () => {
  await seedPancakeCustomer('cu-3');
  const w = wiring({ release: 'fail' });
  try {
    w.handle(await processWebhookPayload(referralPayload('cu-3')));
    await settled(w, /đã gửi ưu đãi cho Khách cũ cu-3/, 4);
    assert.deepEqual(w.calls, ['release', 'pancake-send', 'pancake-send', 'release']);
    assert.deepEqual(await storedTexts('cu-3'), ['Ưu đãi QR phần 1', 'Ưu đãi QR phần 2']);
    assert.ok(w.logs.some(line => /^ERR QR: không trả được quyền giữ luồng cho Khách cũ cu-3: .*not thread owner/.test(line)));
    assert.ok(!w.logs.some(line => /đã trả luồng về app mặc định/.test(line)));
  } finally {
    await w.restore();
  }
});

test('khách cũ, cả Pancake lẫn Send API Meta đều lỗi: ghi "KHÔNG gửi được", luồng đã trả từ đầu; Pancake "không rõ đã gửi" (502) thì không gửi thêm qua Meta', async () => {
  await seedPancakeCustomer('cu-4');
  const both = wiring({ pancake: 'fail', metaSend: 'fail' });
  try {
    both.handle(await processWebhookPayload(referralPayload('cu-4')));
    await settled(both, /KHÔNG gửi được ưu đãi cho Khách cũ cu-4/, 3);
    assert.deepEqual(both.calls, ['release', 'pancake-send', 'meta-send']);
    assert.ok(both.logs.some(line => /^ERR QR: KHÔNG gửi được ưu đãi cho Khách cũ cu-4: /.test(line)));
    assert.deepEqual(await storedTexts('cu-4'), []);
  } finally {
    await both.restore();
  }
  await seedPancakeCustomer('cu-5');
  const gateway = wiring({ pancake: 'gateway' });
  try {
    gateway.handle(await processWebhookPayload(referralPayload('cu-5')));
    // INT-31 (opt-integrations): "không rõ đã gửi" = có thể đã tới khách → coi như đã chào (ghi mốc), log nói rõ.
    await settled(gateway, /ưu đãi cho Khách cũ cu-5 gửi dở \/ không rõ đã tới/, 2);
    assert.deepEqual(gateway.calls, ['release', 'pancake-send'], 'tin có thể đã tới khách: không gửi lần hai qua Meta');
    assert.ok(gateway.logs.some(line => /^ERR QR: ưu đãi cho Khách cũ cu-5 gửi dở \/ không rõ đã tới .*không rõ đã gửi.* — coi như đã chào$/.test(line)), gateway.logs.join('\n'));
  } finally {
    await gateway.restore();
  }
});

test('khách mới (chưa có hội thoại Pancake): gửi qua Send API Meta TRƯỚC, rồi mới trả luồng', async () => {
  const w = wiring();
  try {
    w.handle(await processWebhookPayload(referralPayload('moi-1')));
    await settled(w, /đã gửi ưu đãi cho /, 3);
    assert.deepEqual(w.calls, ['meta-send', 'meta-send', 'release']);
    assert.deepEqual(await storedTexts('moi-1'), ['Ưu đãi QR phần 1', 'Ưu đãi QR phần 2']);
    assert.equal(w.logs.filter(line => /^QR: ưu đãi gửi qua Send API Meta \(CRM đang giữ luồng\) — /.test(line)).length, 1);
    assert.equal(w.logs.filter(line => /^QR: đã trả luồng về app mặc định — /.test(line)).length, 1);
  } finally {
    await w.restore();
  }
});

test('luôn trả luồng khi không chào: quét lại trong thời gian chờ, nhân viên vừa nhắn, sự kiện không phải lượt quét thẻ; standby thì không gọi trả luồng', async () => {
  await seedPancakeCustomer('cu-6');
  const w = wiring();
  try {
    w.handle(await processWebhookPayload(referralPayload('cu-6')));
    await settled(w, /đã gửi ưu đãi cho Khách cũ cu-6/, 3);
    w.calls.length = 0;
    // Quét lại trong cooldown: không gửi nữa nhưng vẫn trả luồng (Meta lại giao luồng cho CRM khi khách mở link).
    w.handle(await processWebhookPayload(referralPayload('cu-6')));
    await until(() => w.calls.length >= 1);
    await pause(60);
    assert.deepEqual(w.calls, ['release']);
    assert.equal(w.logs.filter(line => /đã trả luồng về app mặc định — Khách cũ cu-6/.test(line)).length, 1, 'dòng log chỉ ghi lần đầu của mỗi hội thoại');
    // Referral không phải mã thẻ (ref lạ) trên Page chỉ nghe referral: CRM không trả lời, trả luồng ngay.
    w.calls.length = 0;
    const strange = referralPayload('cu-6');
    strange.entry[0].messaging[0].referral.ref = 'chien-dich-khac';
    w.handle(await processWebhookPayload(strange));
    await until(() => w.calls.length >= 1);
    await pause(60);
    assert.deepEqual(w.calls, ['release']);
    // Standby: CRM không giữ luồng → không gọi release, ưu đãi đi đường cũ (Pancake).
    await seedPancakeCustomer('cu-7');
    w.calls.length = 0;
    w.handle(await processWebhookPayload(referralPayload('cu-7', 'standby')));
    await settled(w, /đã gửi ưu đãi cho Khách cũ cu-7/, 2);
    assert.deepEqual(w.calls, ['pancake-send', 'pancake-send']);
  } finally {
    await w.restore();
  }
  // Nhân viên vừa nhắn: không chào, vẫn trả luồng (khách mới → trả sau khi quyết định không gửi).
  const busyLogs = [];
  const released = [];
  const busyGreeter = createQrGreeter({ offerMessage: async () => 'Ưu đãi', send: async () => { throw new Error('không được gửi'); }, delayMs: 20, staffLastMessageAt: async () => Date.now() - 60_000, log: line => busyLogs.push(line), logError: line => busyLogs.push(`ERR ${line}`) });
  const busyFlow = createLinkRoutedQrFlow({
    schedule: (changes, options) => busyGreeter.schedule(changes, options),
    releaseThread: async change => { released.push(change.conversation.id); return true; },
    shouldRelease: () => true,
    sendPrimary: async () => { throw new Error('không được gửi'); },
    sendViaMeta: async () => { throw new Error('không được gửi'); }
  });
  const scan = (id, extra = {}) => ({ type: 'referral', conversation: { id, psid: id.split(':')[1], pageId, name: id, ...extra }, referral: { ref: 'tmdt-01', source: 'SHORTLINK' } });
  busyFlow([scan(`${pageId}:ban-1`), scan(`${pageId}:ban-2`, { pancakeConversationId: 'x' })]);
  await until(() => released.length >= 2 && busyLogs.filter(line => /nhân viên vừa nhắn 1 phút trước/.test(line)).length >= 2);
  assert.deepEqual(released.sort(), [`${pageId}:ban-1`, `${pageId}:ban-2`], 'mỗi lượt trả luồng đúng một lần');
  assert.equal(busyLogs.filter(line => /nhân viên vừa nhắn 1 phút trước/.test(line)).length, 2);
});
