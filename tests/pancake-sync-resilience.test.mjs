// Đồng bộ tin Pancake bền hơn (01/10): lỗi giữa chừng không làm mất phần đã đồng bộ, kho ghi gộp,
// giới hạn tốc độ gọi Pancake, gửi hết giờ không gửi trùng, referral QR không đếm trùng.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';
import { storePath, seed } from './helpers/temp-messaging-store.mjs';
import { tempDir } from './helpers/temp-dir.mjs';
import path from 'node:path';

process.env.FOLLOW_UPS_PATH = path.join(tempDir('sync-fu-'), 'follow-ups.json');

const store = await import('../app/messaging-store.mjs');
const pancake = await import('../app/pancake.mjs');
const limiter = await import('../app/pancake-rate-limit.mjs');
const { applyWebhookEvents } = await import('../app/meta-webhook.mjs');
const { countQrReferrals, countQrReferralsByDay } = await import('../app/qr-scans.mjs');

const config = { pageId: '110', pageName: 'Test', pageAccessToken: 'pat-1', webhookToken: 'hook-1', apiBase: 'https://pages.fm/api/public_api', botWhenAssigned: false };
const json = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
// Giờ Pancake (UTC, không múi giờ) của một mốc.
const pancakeAt = at => new Date(at).toISOString().replace('Z', '');
const onDisk = () => JSON.parse(readFileSync(storePath, 'utf8'));

test('đồng bộ: Pancake trả 500 ở một hội thoại và hủy giữa chừng ở danh sách bình luận — tin đã đồng bộ vẫn ghi kho và vẫn tới bot', async () => {
  seed({ conversations: [], messages: {} });
  const recent = Date.now() - 60 * 1000;
  const fetchMock = async url => {
    const address = String(url);
    if (address.includes('/conversations?') || address.includes('/conversations&') || /\/v2\/pages\/110\/conversations/.test(address)) {
      if (address.includes('type=COMMENT')) throw Object.assign(new Error('This operation was aborted'), { name: 'AbortError' });
      return json(200, { success: true, conversations: [
        { id: '110_701', type: 'INBOX', from: { id: '701', name: 'Chị Hoa' }, assignee_ids: [] },
        { id: '110_702', type: 'INBOX', from: { id: '702', name: 'Anh Tú' }, assignee_ids: [] }
      ] });
    }
    if (address.includes('/conversations/110_701/messages')) {
      return json(200, { success: true, messages: [{ id: 'm_701', type: 'INBOX', message: 'Còn túi xanh không shop?', inserted_at: pancakeAt(recent), from: { id: '701', name: 'Chị Hoa' } }] });
    }
    if (address.includes('/conversations/110_702/messages')) return json(500, { success: false, message: 'Internal Server Error' });
    return json(404, { success: false, message: 'không có' });
  };
  const toBot = [];
  const summary = await pancake.syncPancakeConversations({ limit: 60, messagePages: 1, commentLimit: 10, processChatbotChanges: async changes => { toBot.push(...changes); } }, config, fetchMock);
  assert.equal(summary.messages, 1, 'tin của hội thoại lành vẫn được ghi');
  assert.equal(summary.bot, 1);
  assert.deepEqual(toBot.map(change => change.message.id), ['m_701'], 'bot nhận tin khách dù bước sau lỗi');
  assert.equal(summary.failures.length, 2, JSON.stringify(summary.failures));
  assert.ok(summary.failures.some(item => item.startsWith('110_702:') && /500/.test(item)));
  assert.ok(summary.failures.some(item => /bình luận/.test(item) && /aborted/.test(item)));
  // Ghi gộp cuối lượt: tệp đã có tin, không còn gì treo trong bộ nhớ.
  assert.equal(store.messagingStoreHasPendingWrites(), false);
  assert.deepEqual(onDisk().messages['110:701'].map(item => item.id), ['m_701']);
});

test('đồng bộ: danh sách hội thoại lỗi hẳn thì trả tóm tắt có lỗi, không ném ra (vòng 10 phút không chết)', async () => {
  const fetchMock = async () => json(500, { success: false, message: 'Bad Gateway' });
  const summary = await pancake.syncPancakeConversations({ limit: 5, commentLimit: 5 }, config, fetchMock);
  assert.equal(summary.conversations, 0);
  assert.equal(summary.messages, 0);
  assert.equal(summary.failures.length, 2);
});

test('kho ghi gộp: 40 lần sửa hoãn ghi chỉ nằm trong bộ nhớ tới khi flush; flush ghi một lần, định dạng tệp như cũ', async () => {
  seed({ conversations: [], messages: {} });
  await store.readMessagingStore();
  const before = statSync(storePath).mtimeMs;
  for (let index = 0; index < 40; index += 1) {
    await store.updateMessagingStore(current => {
      store.ensureConversation(current, { pageId: '120', psid: String(index) });
    }, { defer: true });
  }
  assert.equal(store.messagingStoreHasPendingWrites(), true);
  assert.equal(statSync(storePath).mtimeMs, before, 'chưa ghi tệp lần nào');
  assert.equal((await store.readMessagingStore()).conversations.length, 40, 'người đọc trong tiến trình thấy ngay');
  await store.flushMessagingStore();
  assert.equal(store.messagingStoreHasPendingWrites(), false);
  const text = readFileSync(storePath, 'utf8');
  assert.equal(JSON.parse(text).conversations.length, 40);
  // 01/10: kho ghi JSON gọn (không thụt dòng) — nhỏ hơn ~26%, ghi nhanh hơn; nội dung vẫn đúng bản trong bộ nhớ.
  assert.equal(text, JSON.stringify(await store.readMessagingStore()), 'tệp là JSON gọn của đúng kho trong bộ nhớ');
  // Không còn gì mới: flush lần nữa không ghi.
  const written = statSync(storePath).mtimeMs;
  await store.flushMessagingStore();
  assert.equal(statSync(storePath).mtimeMs, written);
});

test('kho ghi gộp: 25 lời gọi thường đồng thời đều trả về sau khi đã nằm trên đĩa, không mất lần nào', async () => {
  seed({ conversations: [], messages: {} });
  const results = await Promise.all(Array.from({ length: 25 }, (_, index) => store.updateMessagingStore(current => {
    store.ensureConversation(current, { pageId: '130', psid: String(index) });
    return index;
  })));
  assert.deepEqual(results, Array.from({ length: 25 }, (_, index) => index));
  assert.equal(onDisk().conversations.length, 25);
});

test('kho: mutate không đổi gì (unchanged) và đồng bộ lại đúng tin đã có thì không ghi tệp', async () => {
  seed({ conversations: [], messages: {} });
  const event = pancake.pancakeMessageEvent('110', { id: '110_801', type: 'INBOX', from: { id: '801', name: 'Chị Lan' }, assignee_ids: [] },
    { id: 'm_801', type: 'INBOX', message: 'Shop ơi', inserted_at: pancakeAt(Date.now() - 3 * 60 * 60 * 1000), from: { id: '801', name: 'Chị Lan' } });
  await pancake.storePancakeEvents([structuredClone(event)]);
  const written = statSync(storePath).mtimeMs;
  const again = await pancake.storePancakeEvents([structuredClone(event)]);
  assert.deepEqual(again, []);
  assert.equal(statSync(storePath).mtimeMs, written, 'tin đã có: không ghi lại 19 MB');
  assert.equal(await store.updateMessagingStore(() => 'không đổi', { unchanged: () => true }), 'không đổi');
  assert.equal(statSync(storePath).mtimeMs, written);
  assert.equal(store.messagingStoreHasPendingWrites(), false);
});

test('tắt tiến trình (SIGTERM): thay đổi còn trong bộ nhớ được ghi xong rồi mới thoát', async () => {
  seed({ conversations: [], messages: {} });
  await store.updateMessagingStore(current => { store.ensureConversation(current, { pageId: '140', psid: '1' }); }, { defer: true });
  assert.equal(store.messagingStoreHasPendingWrites(), true);
  let exitCode = null;
  const exited = new Promise(resolve => {
    store.installMessagingStoreShutdownFlush({ signals: ['crm-test-shutdown'], exit: code => { exitCode = code; resolve(); } });
  });
  process.emit('crm-test-shutdown');
  await exited;
  assert.equal(exitCode, 0);
  assert.deepEqual(onDisk().conversations.map(item => item.id), ['140:1']);
});

test('giới hạn tốc độ Pancake: không quá N yêu cầu cùng lúc, không quá M lần bắt đầu mỗi cửa sổ; 429 làm cả Page lùi lại', async () => {
  const previous = limiter.configurePancakeRateLimit({});
  limiter.configurePancakeRateLimit({ perSecond: 2, maxConcurrent: 1, windowMs: 120 });
  try {
    const starts = [];
    let active = 0;
    let peak = 0;
    const task = async () => {
      starts.push(Date.now());
      active += 1;
      peak = Math.max(peak, active);
      await new Promise(resolve => setTimeout(resolve, 5));
      active -= 1;
    };
    await Promise.all(Array.from({ length: 6 }, () => limiter.withPancakeSlot('rl-test', task)));
    assert.equal(peak, 1, 'tối đa một yêu cầu cùng lúc');
    for (let index = 2; index < starts.length; index += 1) {
      assert.ok(starts[index] - starts[index - 2] >= 115, `lần ${index}: ba lần bắt đầu liên tiếp phải trải ≥ một cửa sổ (${starts[index] - starts[index - 2]} ms)`);
    }
    limiter.backoffPancake('rl-test-2', 150);
    const asked = Date.now();
    await limiter.withPancakeSlot('rl-test-2', async () => {});
    assert.ok(Date.now() - asked >= 140, 'đang lùi sau 429 thì chờ hết mốc');
  } finally {
    limiter.configurePancakeRateLimit(previous);
  }
});

test('gửi tin hết giờ chờ: không gửi lại mù — lần gửi lại kiểm tin trên Pancake trước, thấy tin rồi thì không gửi nữa', async () => {
  const posts = [];
  let pancakeHasIt = false;
  const fetchMock = async (url, init = {}) => {
    const address = String(url);
    if (init.method === 'POST') {
      posts.push(JSON.parse(init.body));
      // Pancake nhận tin nhưng trả lời chậm quá 15 giây: phía CRM bị hủy.
      pancakeHasIt = true;
      throw Object.assign(new Error('This operation was aborted'), { name: 'AbortError' });
    }
    if (address.includes('/conversations/110_901/messages')) {
      return json(200, { success: true, messages: pancakeHasIt ? [{ id: 'm_real_901', message: '<div>Dạ  em gửi chị bảng giá ạ</div>', inserted_at: pancakeAt(Date.now()), from: { id: '110', admin_name: 'Public API' } }] : [] });
    }
    return json(404, {});
  };
  const target = { pageId: '110', conversationId: '110_901', text: 'Dạ em gửi chị bảng giá ạ' };
  await assert.rejects(pancake.sendPancakeMessage(target, config, fetchMock), error => error.code === 'PANCAKE_SEND_UNCERTAIN' && error.unknownDelivery === true && /không rõ đã gửi/.test(error.message));
  // Bot thử lại sau 3 giây (chatbot-engine): CRM kiểm tin trên Pancake, thấy tin của Page khớp chữ → trả về, KHÔNG gửi lần hai.
  const again = await pancake.sendPancakeMessage(target, config, fetchMock);
  assert.deepEqual(again, { id: 'm_real_901', recovered: true });
  assert.equal(posts.length, 1, 'khách chỉ nhận một tin');
  // Đã giải xong: lần gửi sau (tin mới) đi bình thường.
  const fetchOk = async (url, init = {}) => (init.method === 'POST' ? json(200, { success: true, id: 'm_next' }) : json(404, {}));
  assert.deepEqual(await pancake.sendPancakeMessage(target, config, fetchOk), { id: 'm_next' });
});

test('gửi tin hết giờ chờ: Pancake chưa hiện tin (còn trong thời gian chờ) hay không kiểm được thì báo "không rõ đã gửi", không gửi lại; quá thời gian chờ mới gửi lại', async t => {
  const posts = [];
  let listing = 'empty';
  const fetchMock = async (url, init = {}) => {
    if (init.method === 'POST') {
      posts.push(init.body);
      if (posts.length === 1) throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'UND_ERR_SOCKET', message: 'other side closed' } });
      return json(200, { success: true, id: 'm_retry' });
    }
    if (listing === 'error') return json(500, { success: false, message: 'Internal' });
    return json(200, { success: true, messages: [] });
  };
  const target = { pageId: '110', conversationId: '110_902', text: 'Dạ chị cho em xin địa chỉ ạ' };
  await assert.rejects(pancake.sendPancakeMessage(target, config, fetchMock), { code: 'PANCAKE_SEND_UNCERTAIN' });
  await assert.rejects(pancake.sendPancakeMessage(target, config, fetchMock), /không gửi lại/);
  listing = 'error';
  await assert.rejects(pancake.sendPancakeMessage(target, config, fetchMock), /chưa kiểm được/);
  assert.equal(posts.length, 1, 'chưa chắc thì không gửi lại');
  // Quá 30 giây mà Pancake vẫn không có tin: lần trước không tới, gửi lại được.
  listing = 'empty';
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() + 31 * 1000 });
  try {
    assert.deepEqual(await pancake.sendPancakeMessage(target, config, fetchMock), { id: 'm_retry' });
  } finally {
    t.mock.timers.reset();
  }
  assert.equal(posts.length, 2);
  // Không kết nối được (DNS / từ chối kết nối) = chắc chắn chưa gửi: lỗi thường, không đánh dấu.
  const refused = async () => { throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } }); };
  await assert.rejects(pancake.sendPancakeMessage({ ...target, text: 'tin khác' }, config, refused), error => error.code !== 'PANCAKE_SEND_UNCERTAIN');
});

test('bấm quảng cáo (Pancake): mốc là giờ tin/giờ bấm, không phải lúc đồng bộ; tên đến sau không thêm lần bấm; bấm lại thì thêm mốc mới, giữ mốc đầu', () => {
  const firstClick = Date.UTC(2026, 8, 25, 2, 0);
  const secondClick = Date.UTC(2026, 8, 28, 9, 30);
  const conversation = { id: '110:777', pageId: '110', psid: '777' };
  const click = (at, extra = {}) => ({ timestamp: at, message: { id: `ad_${at}`, type: 'ad', createdAt: at }, pancake: { ad: { adId: 'ad-9', postId: '110_9', adTitle: '', photoUrl: '', ...extra } } });
  assert.equal(pancake.applyPancakeAdReferral(conversation, click(firstClick)), true);
  assert.deepEqual(conversation.referrals.map(item => item.at), [firstClick]);
  assert.equal(conversation.referral.firstAt, firstClick);
  // Tin thường sau đó mang quảng cáo của hội thoại (kèm tên): điền tên, KHÔNG thêm lần bấm.
  const later = { timestamp: firstClick + 60_000, message: { id: 'm_text', type: 'text', createdAt: firstClick + 60_000 }, pancake: { ad: { adId: 'ad-9', postId: '110_9', adTitle: 'Túi Xanh - Video 3' } } };
  assert.equal(pancake.applyPancakeAdReferral(conversation, later), true);
  assert.equal(conversation.referrals.length, 1);
  assert.equal(conversation.referral.adTitle, 'Túi Xanh - Video 3');
  assert.equal(conversation.referrals[0].adTitle, 'Túi Xanh - Video 3');
  // Đồng bộ kéo lại đúng tin bấm cũ: không đổi gì.
  assert.equal(pancake.applyPancakeAdReferral(conversation, click(firstClick), { inserted: false }), false);
  assert.equal(pancake.applyPancakeAdReferral(conversation, later, { inserted: false }), false);
  // Khách bấm lại cùng quảng cáo 3 ngày sau.
  assert.equal(pancake.applyPancakeAdReferral(conversation, click(secondClick)), true);
  assert.deepEqual(conversation.referrals.map(item => item.at), [firstClick, secondClick]);
  assert.equal(conversation.referral.firstAt, firstClick, 'giữ mốc lần đầu');
  assert.equal(conversation.referral.lastAt, secondClick, 'mốc mới nhất');
  // Mục quảng cáo của hội thoại (ads[].inserted_at) báo cùng lần bấm đó: không ghi trùng.
  assert.equal(pancake.applyPancakeAdReferral(conversation, { timestamp: secondClick + 5000, message: { id: 'm_x', type: 'text', createdAt: secondClick + 5000 }, pancake: { ad: { adId: 'ad-9', postId: '110_9', at: secondClick } } }), false);
  assert.equal(conversation.referrals.length, 2);
  // Hội thoại Pancake: mốc bấm lấy từ ads[].inserted_at.
  const event = pancake.pancakeMessageEvent('110', { id: '110_778', type: 'INBOX', from: { id: '778' }, ads: [{ ad_id: 'ad-5', post_id: '110_5', inserted_at: '2026-09-20T01:00:00' }] },
    { id: 'm_778', type: 'INBOX', message: 'Giá sao', inserted_at: '2026-09-29T08:00:00', from: { id: '778' } });
  assert.equal(event.pancake.ad.at, Date.UTC(2026, 8, 20, 1, 0));
});

test('nhãn dán (sticker): Pancake gửi như ảnh /stickers/<id> → vẫn vẽ ảnh nhưng tin mang sticker/stickerId, nút 👍 thêm like; webhook Meta (sticker_id) gắn y như vậy; tin cũ đã lưu cũng nhận ra', async () => {
  const { normalizeWebhookMessage } = await import('../app/meta-webhook.mjs');
  const conversation = { id: '110_990', type: 'INBOX', from: { id: '990', name: 'Chị Na' } };
  const like = pancake.pancakeMessageEvent('110', conversation, { id: 'm_like', type: 'INBOX', message: '', inserted_at: '2026-09-30T02:00:00', from: { id: '990' },
    attachments: [{ type: 'sticker', url: 'https://content.pancake.vn/2.1/stickers/369239263222822' }] });
  assert.equal(like.message.type, 'image', 'hộp thư vẫn vẽ ảnh');
  assert.equal(like.message.dataUrl, 'https://content.pancake.vn/2.1/stickers/369239263222822');
  assert.equal(like.message.sticker, true);
  assert.equal(like.message.stickerId, '369239263222822');
  assert.equal(like.message.like, true);
  // Sticker khác (không phải nút like), Pancake ghi type 'photo' nhưng URL /stickers/.
  const other = pancake.pancakeMessageEvent('110', conversation, { id: 'm_st', type: 'INBOX', message: '', inserted_at: '2026-09-30T02:00:00', from: { id: '990' },
    attachments: [{ type: 'photo', url: 'https://content.pancake.vn/2.1/stickers/123456789' }] });
  assert.equal(other.message.sticker, true);
  assert.equal(other.message.stickerId, '123456789');
  assert.equal(other.message.like, undefined);
  // Ảnh thật: không phải sticker.
  const photo = pancake.pancakeMessageEvent('110', conversation, { id: 'm_ph', type: 'INBOX', message: '', inserted_at: '2026-09-30T02:00:00', from: { id: '990' },
    attachments: [{ type: 'photo', url: 'https://content.pancake.vn/2.1/s/abc.jpg' }] });
  assert.equal(photo.message.sticker, undefined);
  // Webhook Meta: nút like cỡ lớn.
  const meta = normalizeWebhookMessage({ timestamp: 1, message: { mid: 'mid.1', sticker_id: 369239383222810, attachments: [{ type: 'image', payload: { url: 'https://scontent.xx/sticker.png', sticker_id: 369239383222810 } }] } });
  assert.equal(meta.type, 'image');
  assert.deepEqual([meta.sticker, meta.stickerId, meta.like], [true, '369239383222810', true]);
  // Dùng chung cho engine: tin cũ đã lưu (chưa có cờ) vẫn nhận ra qua dataUrl.
  assert.deepEqual(pancake.stickerInfo({ type: 'image', dataUrl: 'https://content.pancake.vn/2.1/stickers/369239343222814' }), { sticker: true, stickerId: '369239343222814', like: true });
  assert.equal(pancake.stickerInfo({ type: 'image', dataUrl: 'https://cdn/anh.jpg' }), null);
  assert.equal(pancake.stickerInfo({ type: 'image', name: 'sticker', dataUrl: 'https://scontent/x.png' }).sticker, true);
});

test('giới tính: khách tự xưng trong tin ("Lấy chị 1 túi vàng") thắng hồ sơ Pancake ghi nam; nhân viên chọn tay vẫn thắng tất cả', async () => {
  const { GENDER_SOURCE_RANK } = await import('../app/processing/customer-info.mjs');
  assert.deepEqual({ ...store.genderRank }, { ...GENDER_SOURCE_RANK });
  assert.ok(store.genderRank.staff > store.genderRank.message && store.genderRank.message > store.genderRank.pancake && store.genderRank.pancake > store.genderRank.name);
  const fromPancake = { gender: 'male', genderSource: 'pancake' };
  assert.equal(store.applyGenderGuess(fromPancake, 'female', 'message'), true);
  assert.equal(fromPancake.gender, 'female');
  assert.equal(store.applyGenderGuess(fromPancake, 'male', 'pancake'), false, 'Pancake không đè lời khách tự xưng');
  const byStaff = { gender: 'male', genderSource: 'staff' };
  assert.equal(store.applyGenderGuess(byStaff, 'female', 'message'), false);

  seed({ conversations: [], messages: {} });
  const conversation = { id: '110_880', type: 'INBOX', from: { id: '880', name: 'Lê Minh' }, page_customer: { gender: 'male' }, assignee_ids: [] };
  const event = pancake.pancakeMessageEvent('110', conversation, { id: 'm_880', type: 'INBOX', message: 'Lấy chị 1 túi vàng', inserted_at: pancakeAt(Date.now() - 60_000), from: { id: '880', name: 'Lê Minh' } });
  assert.equal(event.pancake.gender, 'male');
  await pancake.storePancakeEvents([event], { fromWebhook: true });
  const stored = (await store.readMessagingStore()).conversations.find(item => item.id === '110:880');
  assert.deepEqual([stored.gender, stored.genderSource], ['female', 'message']);
  // Tin sau (không tự xưng) mang hồ sơ Pancake nam: không đổi lại.
  await pancake.storePancakeEvents([pancake.pancakeMessageEvent('110', conversation, { id: 'm_881', type: 'INBOX', message: 'ship về Thủ Đức nhé', inserted_at: pancakeAt(Date.now()), from: { id: '880' } })], { fromWebhook: true });
  assert.equal((await store.readMessagingStore()).conversations.find(item => item.id === '110:880').gender, 'female');
});

test('referral QR: đồng bộ kéo lại cùng tin Botcake nhiều lần (nhiều ngày) chỉ ghi MỘT referral, mốc là giờ của tin', () => {
  const day = 24 * 60 * 60 * 1000;
  const sentAt = Date.UTC(2026, 8, 20, 3, 0);
  const working = { conversations: [], messages: {}, commentIndex: {} };
  const event = () => ({
    pageId: '110', psid: '555', type: 'message', timestamp: sentAt,
    referral: { ref: 'tmdt-01', source: 'SHORTLINK', type: 'BOTCAKE_OPTIN' },
    message: { id: 'm_botcake', mid: 'm_botcake', direction: 'outgoing', type: 'text', text: 'Chào chị! Mã thẻ: #tmdt-01', createdAt: sentAt, status: 'sent' }
  });
  applyWebhookEvents(working, [event()]);
  // Đồng bộ 10 phút một lần, nhiều ngày liền, cùng tin đó.
  for (let index = 0; index < 5; index += 1) applyWebhookEvents(working, [event()]);
  const conversation = working.conversations.find(item => item.id === '110:555');
  assert.equal(conversation.qrReferrals.length, 1);
  assert.equal(conversation.qrReferrals[0].at, sentAt);
  assert.equal(conversation.qrReferrals[0].messageId, 'm_botcake');
  assert.deepEqual(countQrReferrals(working.conversations), { 'tmdt-01': 1 });
  // Khách quét lại hôm sau: tin Botcake MỚI (mã khác) → lượt mới, như trước.
  applyWebhookEvents(working, [{ ...event(), message: { ...event().message, id: 'm_botcake_2', mid: 'm_botcake_2', createdAt: sentAt + day } }]);
  assert.deepEqual(countQrReferrals(working.conversations), { 'tmdt-01': 2 });
  assert.deepEqual(countQrReferralsByDay(working.conversations), { 'tmdt-01': { '2026-09-20': 1, '2026-09-21': 1 } });
});
