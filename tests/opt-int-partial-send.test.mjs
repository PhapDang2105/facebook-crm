import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { tempDir } from './helpers/temp-dir.mjs';

// INT-03 (tin nhiều phần gửi dở), INT-04 (Sapo: không rõ đã gửi), INT-31 (chào QR gửi dở).
process.env.META_CONVERSATIONS_PATH = path.join(tempDir('opt-int-partial-'), 'meta-conversations.json');
process.env.FOLLOW_UPS_PATH = path.join(tempDir('opt-int-partial-fu-'), 'follow-ups.json');
process.env.QR_SCANS_PATH = path.join(tempDir('opt-int-partial-qr-'), 'qr-scans.json');

const { sendConversationMessageViaPancake } = await import('../app/pancake.mjs');
const { readMessagingStore, updateMessagingStore, saveMessage } = await import('../app/messaging-store.mjs');
const { runSapoSync, listShipmentNoticeQueue } = await import('../app/sapo-sync.mjs');
const { createQrGreeter } = await import('../app/qr-greeting.mjs');
const { registerQrCode } = await import('../app/qr-scans.mjs');

const config = { pageId: '110', pageName: 'Test', pageAccessToken: 'pat-1', webhookToken: 'hook-1', apiBase: 'https://pages.fm/api/public_api', botWhenAssigned: false };

test('INT-03: chữ dài cắt 2 tin, tin 1 tới khách, tin 2 bị Pancake từ chối → lưu phần đã gửi, lỗi partial + unknownDelivery', async () => {
  await updateMessagingStore(store => {
    const { conversation } = saveMessage(store, { pageId: '110', psid: '901', message: { id: 'in-1', direction: 'incoming', type: 'text', text: 'Hỏi', createdAt: Date.now() - 1000, status: 'received' } });
    conversation.pancakeConversationId = '110_901';
    return null;
  });
  const conversation = (await readMessagingStore()).conversations.find(item => item.id === '110:901');
  const posts = [];
  const fetchImpl = async (url, options) => {
    const body = JSON.parse(options.body);
    posts.push(body.message);
    if (posts.length === 1) return { ok: true, status: 200, json: async () => ({ success: true, id: 'pk-1' }) };
    return { ok: true, status: 200, json: async () => ({ success: false, message: 'Facebook từ chối' }) };
  };
  const first = 'Đoạn một. '.repeat(150).trim();
  const second = 'Đoạn hai. '.repeat(50).trim();
  const error = await sendConversationMessageViaPancake(conversation, { text: `${first}\n\n${second}` }, config, fetchImpl).then(() => null, failure => failure);
  assert.ok(error, 'phải báo lỗi');
  assert.equal(posts.length, 2);
  assert.equal(error.partial, true);
  assert.equal(error.unknownDelivery, true);
  assert.equal(error.sentParts, 1);
  const stored = (await readMessagingStore()).messages['110:901'].find(item => item.id === 'pk-1');
  assert.ok(stored, 'phần đã gửi được lưu');
  assert.equal(stored.text, first);
});

test('INT-03: tin 1 đã lỗi thì là lỗi thường (người gọi gửi lại được), không lưu gì', async () => {
  const conversation = (await readMessagingStore()).conversations.find(item => item.id === '110:901');
  const before = (await readMessagingStore()).messages['110:901'].length;
  const fetchImpl = async () => ({ ok: true, status: 200, json: async () => ({ success: false, message: 'Facebook từ chối' }) });
  const error = await sendConversationMessageViaPancake(conversation, { text: 'Ngắn' }, config, fetchImpl).then(() => null, failure => failure);
  assert.ok(error);
  assert.equal(error.partial, undefined);
  assert.equal(error.unknownDelivery, undefined);
  assert.equal((await readMessagingStore()).messages['110:901'].length, before);
});

test('INT-04 (Sapo): báo vận đơn hết giờ chờ (unknownDelivery) = đã báo, không vào hàng chờ có lỗi', async () => {
  const now = Date.parse('2026-10-03T03:00:00Z');
  const HOUR = 60 * 60 * 1000;
  const store = {
    conversations: [{ id: 'c1', pageId: 'p1', psid: 'c1', source: 'inbox', name: 'Khách', lastCustomerMessageAt: now - HOUR, gender: 'female', customerOrders: [{ id: 'A', phone: '0912345678', createdAt: now - 20 * HOUR, total: 298000, status: 'Mới', products: [{ sku: 'GRA-XANH' }] }] }],
    messages: {}
  };
  const order = {
    id: 1, name: 'SON1', source_name: 'facebook', tags: '', note: null, created_on: new Date(now - 2 * HOUR).toISOString(), status: 'open', total_price: 298000,
    phone: null, shipping_address: { phone: '0912345678' },
    fulfillments: [{ status: 'success', shipment_status: 'picked_up', tracking_info: { carrier: 'JNT_EXPRESS', tracking_number: '802835136377', tracking_url: 'https://jtexpress.vn/x' } }]
  };
  let state = { noticesFrom: now - HOUR };
  let calls = 0;
  const deps = {
    now, log: () => {}, notify: true,
    listOrders: async () => ({ orders: [order], complete: true }),
    readState: async () => state,
    writeState: async value => { state = value; },
    readMessagingStore: async () => store,
    updateMessagingStore: async mutate => mutate(store),
    sendMessage: async () => { calls += 1; throw Object.assign(new Error('Pancake không rõ đã nhận tin'), { unknownDelivery: true }); },
    genderOf: inbox => inbox.gender,
    readTemplates: async () => ({})
  };
  const summary = await runSapoSync(deps);
  assert.equal(summary.failed, 0);
  assert.equal(summary.sent, 1);
  const shipment = store.conversations[0].customerOrders[0].shipment;
  assert.equal(shipment.notifiedStage, 'picked_up');
  assert.equal(shipment.notices.at(-1).uncertain, true);
  assert.equal(listShipmentNoticeQueue(store, { now }).length, 0, 'không vào hàng chờ cho nhân viên gửi lại');
  await runSapoSync({ ...deps, now: now + HOUR });
  assert.equal(calls, 1);
});

test('INT-31: ảnh thẻ QR đã gửi mà phần chữ lỗi → vẫn ghi đã chào; quét lại trong thời gian chờ không gửi ảnh lần hai', async () => {
  await registerQrCode('tmdt-01');
  const sent = [];
  const saved = [];
  const g = createQrGreeter({
    offerMessage: async () => [{ type: 'image', url: 'https://x/card.png' }, { type: 'text', text: 'Ưu đãi' }],
    send: async (conversation, payload) => {
      if (payload.text) throw new Error('Pancake không nhận tin (400)');
      sent.push(payload);
    },
    greetedStore: { load: async () => [], save: async (conversation, at) => { saved.push([conversation.id, at]); } },
    delayMs: 10,
    cooldownMs: 60_000,
    log: () => {},
    logError: () => {}
  });
  const conversation = { id: '1:q', psid: 'q', pageId: '1', name: 'Khách Q' };
  const change = { type: 'referral', conversation, referral: { ref: 'tmdt-01', source: 'SHORTLINK' } };
  g.schedule([change]);
  const deadline = Date.now() + 10_000;
  while (!saved.length && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(sent.length, 1, 'ảnh đã gửi');
  assert.equal(saved.length, 1, 'mốc đã chào được lưu dù phần chữ lỗi');
  g.schedule([change]);
  await new Promise(resolve => setTimeout(resolve, 80));
  assert.equal(sent.length, 1, 'không gửi ảnh lần hai');
});
