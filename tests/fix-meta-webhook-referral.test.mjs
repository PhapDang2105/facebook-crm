// Đầu-cuối: gói webhook Meta (m.me?ref=tmdt-01 từ thẻ cảm ơn) → processWebhookPayload → change → bộ chào QR.
// Bốn dạng gói: (a) messaging_referrals của khách cũ, (b) postback "Bắt đầu" kèm referral của khách mới,
// (c) tin đầu tiên mang message.referral, (d) cả ba nằm trong `entry.standby` (Handover Protocol: app khác —
// Pancake — là Primary Receiver). Không gọi dịch vụ thật: kho kênh trống nên không có lượt tra Graph nào.
import test from 'node:test';
import assert from 'node:assert/strict';

// Page Giọt Nắng vận hành ở Pancake, app Meta của CRM chỉ nghe referral.
const referralOnlyPage = '103549382215599';
const ownPage = '200000000000002';
process.env.META_REFERRAL_ONLY_PAGES = referralOnlyPage;

const { collectWebhookEvents, describeWebhookPayload, processWebhookPayload } = await import('../app/meta-webhook.mjs');
const { readMessagingStore } = await import('../app/messaging-store.mjs');
const { createQrGreeter, isCardScan } = await import('../app/qr-greeting.mjs');
const { registerQrCode } = await import('../app/qr-scans.mjs');

await registerQrCode('tmdt-01');

const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const shortlink = { ref: 'tmdt-01', source: 'SHORTLINK', type: 'OPEN_THREAD' };
let clock = 1_790_000_000_000;
const tick = () => (clock += 1000);

// Ba dạng sự kiện theo tài liệu Meta (m.me Links, messaging_referrals, messaging_postbacks).
const referralEvent = (pageId, psid) => ({ sender: { id: psid }, recipient: { id: pageId }, timestamp: tick(), referral: { ...shortlink } });
const getStartedEvent = (pageId, psid, { payload = 'GET_STARTED' } = {}) => ({
  sender: { id: psid },
  recipient: { id: pageId },
  timestamp: tick(),
  // Trong standby Meta không gửi `payload` của postback, chỉ còn tiêu đề nút.
  postback: { mid: `m_postback_${psid}`, title: 'Bắt đầu', ...(payload ? { payload } : {}), referral: { ...shortlink } }
});
const firstMessageEvent = (pageId, psid) => ({
  sender: { id: psid },
  recipient: { id: pageId },
  timestamp: tick(),
  message: { mid: `m_first_${psid}`, text: 'Cho mình nhận ưu đãi', referral: { ...shortlink } }
});
const plainMessageEvent = (pageId, psid, text = 'Shop ơi') => ({ sender: { id: psid }, recipient: { id: pageId }, timestamp: tick(), message: { mid: `m_plain_${psid}_${clock}`, text } });
const payloadOf = (pageId, channel, events) => ({ object: 'page', entry: [{ id: pageId, time: clock, [channel]: events }] });

function greeter() {
  const sent = [];
  const logs = [];
  const instance = createQrGreeter({
    offerMessage: async () => 'Ưu đãi QR',
    send: async (conversation, payload) => { sent.push({ id: conversation.id, ...payload }); },
    delayMs: 20,
    cooldownMs: 60_000,
    log: line => logs.push(line),
    logError: line => logs.push(`ERR ${line}`)
  });
  return { ...instance, sent, logs };
}

test('messaging: (a) referral trần của khách cũ, (b) postback Bắt đầu kèm referral, (c) tin đầu mang message.referral — cả ba ra change có referral SHORTLINK và được chào', async () => {
  const changes = await processWebhookPayload(payloadOf(ownPage, 'messaging', [
    referralEvent(ownPage, 'cu-1'),
    getStartedEvent(ownPage, 'moi-1'),
    firstMessageEvent(ownPage, 'moi-2')
  ]));
  assert.equal(changes.length, 3);
  assert.deepEqual(changes.map(change => change.type), ['referral', 'message', 'message']);
  for (const change of changes) {
    assert.equal(change.referral.source, 'SHORTLINK');
    assert.equal(change.referral.ref, 'tmdt-01');
    assert.equal(change.standby, undefined, 'sự kiện ở messaging không mang cờ standby');
    assert.equal(isCardScan(change), true);
  }
  assert.equal(changes[1].message.text, 'Bắt đầu');
  assert.equal(changes[2].message.text, 'Cho mình nhận ưu đãi');
  const store = await readMessagingStore();
  for (const psid of ['cu-1', 'moi-1', 'moi-2']) {
    const conversation = store.conversations.find(item => item.id === `${ownPage}:${psid}`);
    assert.equal(conversation.qrReferrals.length, 1, `${psid}: referral QR ghi vào ô qrReferrals`);
    assert.equal(conversation.referral, undefined, 'không đè lên referral quảng cáo');
  }
  const g = greeter();
  g.schedule(changes);
  await pause(80);
  assert.deepEqual(g.sent.map(item => item.id).sort(), [`${ownPage}:cu-1`, `${ownPage}:moi-1`, `${ownPage}:moi-2`]);
});

test('standby, Page chỉ nghe referral (Pancake giữ luồng): referral + postback được nhận với standby=true; tin đầu mang referral chỉ lấy referral; tin thường / đã giao / đã xem bỏ qua', async () => {
  const payload = payloadOf(referralOnlyPage, 'standby', [
    referralEvent(referralOnlyPage, 'cu-2'),
    getStartedEvent(referralOnlyPage, 'moi-3', { payload: '' }),
    firstMessageEvent(referralOnlyPage, 'moi-4'),
    plainMessageEvent(referralOnlyPage, 'cu-2'),
    { sender: { id: 'cu-2' }, recipient: { id: referralOnlyPage }, timestamp: tick(), delivery: { watermark: clock, mids: ['m_x'] } },
    { sender: { id: 'cu-2' }, recipient: { id: referralOnlyPage }, timestamp: tick(), read: { watermark: clock } }
  ]);
  const events = collectWebhookEvents(payload);
  assert.deepEqual(events.map(event => event.type), ['referral', 'message', 'referral']);
  assert.ok(events.every(event => event.standby === true));
  assert.match(describeWebhookPayload(payload, events), /^Webhook Meta: 3 sự kiện xử lý \(referral, message, referral\), standby=6$/);

  const changes = await processWebhookPayload(payload);
  assert.deepEqual(changes.map(change => change.type), ['referral', 'message', 'referral']);
  for (const change of changes) {
    assert.equal(change.standby, true, 'đánh dấu để bot không trả lời');
    assert.equal(change.referral.source, 'SHORTLINK');
    assert.equal(isCardScan(change), true);
  }
  const store = await readMessagingStore();
  // Tin của khách đã về qua webhook Pancake: không ghi thêm bản Meta vào hộp thư.
  assert.deepEqual((store.messages[`${referralOnlyPage}:moi-4`] || []).length, 0);
  assert.deepEqual((store.messages[`${referralOnlyPage}:cu-2`] || []).length, 0);
  assert.equal(store.messages[`${referralOnlyPage}:moi-3`].length, 1, 'postback Bắt đầu vẫn ghi như ở messaging');
  assert.equal(store.messages[`${referralOnlyPage}:moi-3`][0].text, 'Bắt đầu');
  assert.equal(store.conversations.find(item => item.id === `${referralOnlyPage}:moi-4`).qrReferrals.length, 1);

  // Bộ chào vẫn chạy cho sự kiện standby; bot thì không (nơi gọi lọc theo change.standby).
  const g = greeter();
  g.schedule(changes);
  await pause(80);
  assert.deepEqual(g.sent.map(item => item.id).sort(), [`${referralOnlyPage}:cu-2`, `${referralOnlyPage}:moi-3`, `${referralOnlyPage}:moi-4`]);
  assert.deepEqual(changes.filter(change => !change.standby), [], 'không change nào tới bot');
});

test('standby, Page CRM tự vận hành: cả ba dạng và tin thường được ghi nhận như messaging nhưng mang standby=true', async () => {
  const payload = payloadOf(ownPage, 'standby', [
    referralEvent(ownPage, 'cu-5'),
    getStartedEvent(ownPage, 'moi-6', { payload: '' }),
    firstMessageEvent(ownPage, 'moi-7'),
    plainMessageEvent(ownPage, 'cu-5', 'Còn hàng không shop')
  ]);
  const changes = await processWebhookPayload(payload);
  assert.deepEqual(changes.map(change => change.type), ['referral', 'message', 'message', 'message']);
  assert.ok(changes.every(change => change.standby === true));
  assert.deepEqual(changes.slice(0, 3).map(change => change.referral.source), ['SHORTLINK', 'SHORTLINK', 'SHORTLINK']);
  assert.equal(changes[3].referral, undefined);
  const store = await readMessagingStore();
  assert.equal(store.messages[`${ownPage}:moi-7`][0].text, 'Cho mình nhận ưu đãi');
  assert.equal(store.messages[`${ownPage}:cu-5`][0].text, 'Còn hàng không shop');
  assert.equal(store.conversations.find(item => item.id === `${ownPage}:cu-5`).unread, true);
});

test('gói vừa có messaging vừa có standby: đếm riêng trong dòng log; gói không phải Page hay standby rỗng không sinh sự kiện', () => {
  const payload = { object: 'page', entry: [{ id: ownPage, messaging: [referralEvent(ownPage, 'x-1')], standby: [referralEvent(ownPage, 'x-2')] }] };
  const events = collectWebhookEvents(payload);
  assert.deepEqual(events.map(event => [event.psid, Boolean(event.standby)]), [['x-1', false], ['x-2', true]]);
  assert.match(describeWebhookPayload(payload, events), /messaging=1, standby=1/);
  assert.deepEqual(collectWebhookEvents({ object: 'page', entry: [{ id: ownPage, standby: [] }] }), []);
  assert.deepEqual(collectWebhookEvents({ object: 'page', entry: [{ id: ownPage, standby: [{ sender: { id: 'x-3' }, recipient: { id: ownPage } }] }] }), [], 'sự kiện standby không có nội dung nhận biết được');
  assert.doesNotMatch(describeWebhookPayload({ object: 'page', entry: [{ id: ownPage, messaging: [] }] }, []), /standby=/);
  // Cờ Page chỉ nghe referral truyền vào được (mặc định đọc META_REFERRAL_ONLY_PAGES).
  const plain = { object: 'page', entry: [{ id: ownPage, standby: [plainMessageEvent(ownPage, 'x-4')] }] };
  assert.equal(collectWebhookEvents(plain).length, 1);
  assert.equal(collectWebhookEvents(plain, { referralOnly: () => true }).length, 0);
});
