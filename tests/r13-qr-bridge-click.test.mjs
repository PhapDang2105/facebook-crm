// Vòng 13 (02/10): khách MỚI quét thẻ — Meta không báo mã cho CRM/Botcake, tin đầu của họ về qua webhook
// Pancake như một hội thoại mới bình thường. CRM khớp lượt bấm nút "Mở Messenger" trên trang đệm (beacon
// POST /q/<mã>/open) với tin đầu của hội thoại hộp thư mới không dấu nguồn, rồi gửi ưu đãi SAU câu trả lời
// của bot. Test đầu-cuối: gói webhook Pancake giả + lượt bấm giả, kho hội thoại tạm, đường gửi Pancake thật
// với fetch giả. Ca thật: hội thoại …895462, tin đầu "Cho chị xem sản phẩm mới" 49 giây sau lượt bấm.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { tempDir } from './helpers/temp-dir.mjs';

const directory = tempDir('r13-qr-bridge-');
process.env.META_CONVERSATIONS_PATH = path.join(directory, 'conv.json');
process.env.QR_SETTINGS_PATH = path.join(directory, 'qr-settings.json');
process.env.QR_SCANS_PATH = path.join(directory, 'qr-scans.json');
process.env.FOLLOW_UPS_PATH = path.join(directory, 'follow-ups.json');
process.env.STAFF_PATH = path.join(directory, 'staff.json');
process.env.AUDIT_LOG_DIR = path.join(directory, 'audit-log');
process.env.PUBLIC_BASE_URL = 'https://crm.example.com';
process.env.PANCAKE_PAGE_ID = '103549382215599';
process.env.PANCAKE_PAGE_NAME = 'Giọt Nắng';
process.env.PANCAKE_PAGE_ACCESS_TOKEN = 't';
process.env.PANCAKE_WEBHOOK_TOKEN = 'w';

const { createBridgeClickMatcher, createQrGreeter, bridgeSourceMarker, isCardScan, lastStaffMessageAt, withOfferCardImage } = await import('../app/qr-greeting.mjs');
const { handlePancakeWebhook, sendConversationMessageViaPancake } = await import('../app/pancake.mjs');
const { readMessagingStore, updateMessagingStore, saveMessage } = await import('../app/messaging-store.mjs');
const { applyWebhookEvents, attachReferral } = await import('../app/meta-webhook.mjs');
const { registerQrCode, countQrReferrals } = await import('../app/qr-scans.mjs');

const { configurePancakeRateLimit } = await import('../app/pancake-rate-limit.mjs');

await registerQrCode('tmdt-01');
// Hàng đợi giới hạn tốc độ Pancake (4 lần gọi/giây) không được làm test chờ cả giây: nới cho test.
configurePancakeRateLimit({ perSecond: 1000, maxConcurrent: 50 });

const PAGE = '103549382215599';
const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
// r13-glue (ổn định test): KHÔNG chờ một quãng cố định rồi khẳng định 'đã gửi' — máy bận (nhiều tệp test chạy song song) thì
// hẹn giờ + ghi kho + gửi tin giả trễ hơn quãng chờ và test đỏ ngẫu nhiên. Chờ tới khi điều kiện đúng (tối đa 15 giây);
// quãng chờ cố định chỉ còn dùng cho khẳng định 'KHÔNG gửi gì' (trễ không làm sai kết quả).
async function until(predicate, label, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() > deadline) assert.fail('hết giờ chờ: ' + label);
    await pause(15);
  }
}
const cardPng = readFileSync(new URL('../assets/branding/offers/the-uu-dai.png', import.meta.url));

// Đồng hồ giả: "49 giây sau" = dời đồng hồ, không chờ thật. Hẹn giờ (15 giây chờ mơ hồ, 10 giây chào) rút còn vài chục ms.
let skew = 0;
const clock = () => Date.now() + skew;
let sequence = 0;

/** Gói webhook `messaging` của Pancake (cùng dạng gói thật). */
function webhook({ psid, text = '', at = clock(), name = 'Khách Mới', fromPage = false, adminName = '', ads = null, attachments = null }) {
  sequence += 1;
  return {
    event_type: 'messaging',
    page_id: PAGE,
    data: {
      conversation: { id: `${PAGE}_${psid}`, type: 'INBOX', from: { id: psid, name }, ...(ads ? { ads } : {}) },
      message: {
        id: `m_${psid}_${sequence}`,
        message: text,
        type: 'INBOX',
        from: fromPage ? { id: PAGE, name: 'Giọt Nắng', ...(adminName ? { admin_name: adminName } : {}) } : { id: psid, name },
        inserted_at: new Date(at).toISOString().replace('Z', ''),
        ...(attachments ? { attachments } : {})
      }
    }
  };
}

/** Dựng luồng như app/server.mjs: bộ chào + bộ khớp lượt bấm + móc trước bot của webhook Pancake. */
function createFlow({ windowMs = 90_000, ambiguityMs = 80, delayMs = 40, offerText = 'Em gửi Anh/Chị thẻ ưu đãi cho những đơn hàng sau ạ 💛' } = {}) {
  const logs = [];
  const events = []; // thứ tự việc khách thấy: 'bot:<tin>', 'offer-image', 'offer-text'
  const posted = []; // thân các lần gọi Pancake gửi tin
  const fetchImpl = async (target, init = {}) => {
    const url = String(target);
    if (url.includes('/q/brand/offer-card.png')) return new Response(cardPng, { status: 200, headers: { 'content-type': 'image/png', 'content-length': String(cardPng.length) } });
    if (url.includes('/upload_contents')) return new Response(JSON.stringify({ success: true, id: `content-${posted.length + 1}` }), { status: 200, headers: { 'content-type': 'application/json' } });
    if (url.includes('/messages') && init.method === 'POST') {
      const body = JSON.parse(init.body);
      posted.push({ conversation: url.match(/conversations\/([^/]+)\/messages/)?.[1] || '', ...body });
      events.push(body.content_ids ? 'offer-image' : 'offer-text');
      return new Response(JSON.stringify({ success: true, id: `sent-${posted.length}-${sequence}` }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const greeter = createQrGreeter({
    offerMessage: async () => withOfferCardImage([{ type: 'text', text: offerText }], { baseUrl: process.env.PUBLIC_BASE_URL, available: true }),
    send: (conversation, payload) => sendConversationMessageViaPancake(conversation, payload, undefined, fetchImpl),
    delayMs,
    now: clock,
    staffLastMessageAt: async conversation => lastStaffMessageAt((await readMessagingStore()).messages?.[conversation.id]),
    greetedStore: {
      load: async () => (await readMessagingStore()).conversations.filter(item => Number(item.qrGreetedAt) > 0).map(item => [item.id, Number(item.qrGreetedAt)]),
      save: (conversation, at) => updateMessagingStore(store => {
        const stored = store.conversations.find(item => item.id === conversation.id);
        if (stored) stored.qrGreetedAt = at;
      }, { defer: true })
    },
    recentOrderAt: async conversation => Math.max(0, ...(await readMessagingStore()).conversations
      .filter(item => item.pageId === conversation.pageId && item.psid === conversation.psid)
      .flatMap(item => (item.customerOrders || []).map(order => Number(order.createdAt) || 0))),
    log: line => logs.push(line),
    logError: line => logs.push(`ERR ${line}`)
  });
  const matcher = createBridgeClickMatcher({
    windowMs,
    ambiguityMs,
    greetDelayMs: delayMs,
    now: clock,
    pageId: async () => PAGE,
    inspect: async change => {
      const store = await readMessagingStore();
      const conversation = store.conversations.find(item => item.id === change.conversation.id) || change.conversation;
      const commentAt = Math.max(0, ...store.conversations.filter(item => item.source === 'comment' && item.pageId === conversation.pageId && item.psid === conversation.psid).map(item => Number(item.lastMessageAt) || 0));
      return { conversation, messages: store.messages?.[conversation.id] || [], commentAt };
    },
    greet: (change, options) => {
      updateMessagingStore(store => {
        const stored = store.conversations.find(item => item.id === change.conversation.id);
        if (stored) attachReferral(stored, change.referral, { messageId: change.message?.id, at: change.message?.createdAt });
      }, { defer: true });
      greeter.schedule([change], options);
    },
    log: line => logs.push(line),
    logError: line => logs.push(`ERR ${line}`)
  });
  // Bot giả: trả lời mọi tin khách (ghi một tin Page mang dấu bot vào kho), mất ~20 ms.
  const bot = async changes => {
    for (const change of changes) {
      if (change.type !== 'message' || change.message?.direction !== 'incoming') continue;
      await pause(20);
      events.push(`bot:${change.message.text}`);
      await updateMessagingStore(store => saveMessage(store, { pageId: PAGE, psid: change.conversation.psid, message: { id: `bot-${change.message.id}`, direction: 'outgoing', type: 'text', text: 'Dạ em gửi chị hình ảnh sản phẩm ạ', sender: 'bot', createdAt: clock(), status: 'sent' } }), { defer: true });
    }
  };
  async function deliver(payload) {
    let held = [];
    try {
      return await handlePancakeWebhook(payload, {
        processChatbotChanges: bot,
        chatbotDependencies: {},
        now: clock(),
        fetchImpl,
        beforeBot: async changes => {
          greeter.schedule(changes);
          held = await matcher.consider(changes);
          return changes.filter(change => !isCardScan(change));
        }
      });
    } finally {
      matcher.botDone(held);
    }
  }
  return { greeter, matcher, deliver, logs, events, posted };
}

const conversationOf = async psid => (await readMessagingStore()).conversations.find(item => item.id === `${PAGE}:${psid}`);
const messagesOf = async psid => (await readMessagingStore()).messages?.[`${PAGE}:${psid}`] || [];
const offersTo = (flow, psid) => flow.posted.filter(item => item.conversation === `${PAGE}_${psid}`);

test('ca thật …895462: bấm nút trang đệm → 49 giây sau tin đầu "Cho chị xem sản phẩm mới" → bot trả lời trước, rồi CRM gửi ẢNH THẺ + chữ', async () => {
  // Quãng chờ mơ hồ 1 giây (thật): đủ dài để hai khẳng định "đang giữ / chưa gửi" ngay sau deliver không phụ thuộc máy nhanh chậm.
  const flow = createFlow({ ambiguityMs: 1000 });
  const psid = '28074385268895462';
  assert.equal(flow.matcher.noteClick({ code: 'tmdt-01', visitor: 'may-khach-1' }), true);
  skew += 49_000;
  // Pancake kèm mục quảng cáo CŨ của khách (bấm từ 27 ngày trước) — như gói thật; không phải nguồn của lượt này.
  const staleAd = [{ ad_id: '120249089346230380', post_id: `${PAGE}_880565357839886`, inserted_at: new Date(clock() - 27 * 24 * 60 * 60 * 1000).toISOString().replace('Z', '') }];
  const summary = await flow.deliver(webhook({ psid, text: 'Cho chị xem sản phẩm mới', name: 'Khách Thẻ', ads: staleAd }));
  assert.equal(summary.bot, 1, 'bot vẫn nhận tin đầu của khách (khác đường tin soạn sẵn #mã)');
  assert.deepEqual(flow.events, ['bot:Cho chị xem sản phẩm mới'], 'chưa gửi ưu đãi ngay — chờ xem có hội thoại mới khác và chờ bot xong');
  assert.equal(flow.matcher.stateOf(`${PAGE}:${psid}`), 'held');
  assert.ok(flow.logs.some(line => /^QR: khớp lượt bấm tmdt-01 với hội thoại mới Khách Thẻ \(…895462\) \(sau 49s\)/.test(line)), flow.logs.join('\n'));
  await until(() => flow.logs.some(line => /QR: đã gửi ưu đãi cho Khách Thẻ \(ảnh\+chữ\)/.test(line)), 'ưu đãi (ảnh + chữ) gửi cho Khách Thẻ');
  assert.deepEqual(flow.events, ['bot:Cho chị xem sản phẩm mới', 'offer-image', 'offer-text'], 'ưu đãi đi SAU câu trả lời của bot, ảnh thẻ trước chữ');
  const sent = offersTo(flow, psid);
  assert.equal(sent.length, 2);
  assert.ok(Array.isArray(sent[0].content_ids) && sent[0].content_ids.length === 1, 'tin đầu là ảnh thẻ (tải lên Pancake)');
  assert.match(sent[1].message, /thẻ ưu đãi/);
  assert.ok(flow.logs.some(line => /QR: đã gửi ưu đãi cho Khách Thẻ \(ảnh\+chữ\)/.test(line)), flow.logs.join('\n'));
  // Mốc đã chào + tin ưu đãi ghi kho theo đường ghi gộp (defer): chờ kho có đủ rồi mới soát.
  await until(async () => Number((await conversationOf(psid))?.qrGreetedAt) > 0 && (await messagesOf(psid)).filter(item => String(item.id).startsWith('sent-')).length === 2, 'kho lưu 2 tin ưu đãi + mốc đã chào');
  // Việc 4: tin ưu đãi lưu mang dấu bot, KHÔNG mang cờ nhân viên.
  const stored = (await messagesOf(psid)).filter(item => item.direction === 'outgoing' && String(item.id).startsWith('sent-'));
  assert.equal(stored.length, 2);
  for (const message of stored) {
    assert.equal(message.sender, 'bot');
    assert.equal(message.staff, undefined);
    assert.equal(message.staffName, undefined);
  }
  assert.equal(lastStaffMessageAt(await messagesOf(psid)), 0, 'tin ưu đãi không được tính là "nhân viên vừa nhắn"');
  // Thống kê QR + mốc đã chào lưu trên hội thoại.
  const conversation = await conversationOf(psid);
  assert.deepEqual(conversation.qrReferrals.map(item => [item.ref, item.source, item.type]), [['tmdt-01', 'SHORTLINK', 'BRIDGE_CLICK']]);
  assert.equal(countQrReferrals([conversation])['tmdt-01'], 1);
  assert.ok(Number(conversation.qrGreetedAt) > 0, 'mốc đã chào lưu bền trên hội thoại');
  assert.equal(conversation.referral?.source, 'ADS', 'referral quảng cáo cũ của hội thoại giữ nguyên');
  assert.equal(flow.matcher.pendingClicks(), 0, 'lượt bấm đã tiêu');
  // Tin thứ hai của cùng khách: không chào lần hai.
  await flow.deliver(webhook({ psid, text: 'Chị ko lấy bát gáo dừa, lấy quạt thôi', name: 'Khách Thẻ' }));
  await pause(250);
  assert.equal(offersTo(flow, psid).length, 2);
});

test('quá cửa sổ 90 giây: tin đầu đến 91 giây sau lượt bấm → không chào, có dòng log', async () => {
  const flow = createFlow();
  const psid = '9100000000000001';
  flow.matcher.noteClick({ code: 'tmdt-01', visitor: 'may-khach-2' });
  skew += 91_000;
  await flow.deliver(webhook({ psid, text: 'Xin giá' }));
  await pause(300);
  assert.equal(offersTo(flow, psid).length, 0);
  assert.deepEqual(flow.events, ['bot:Xin giá']);
  assert.ok(flow.logs.some(line => /không khớp lượt bấm nào \(lượt bấm tmdt-01 gần nhất cách 91s, quá cửa sổ 90s\)/.test(line)), flow.logs.join('\n'));
  assert.equal((await conversationOf(psid)).qrReferrals, undefined);
});

test('hội thoại mới từ BÌNH LUẬN: tin nhắn riêng của Page đến trước, hay tin hệ thống "Bạn đang phản hồi bình luận…" về trước lúc chào → không chào', async () => {
  // (a) Page nhắn riêng cho người bình luận trước, khách trả lời sau.
  const first = createFlow();
  first.matcher.noteClick({ code: 'tmdt-01', visitor: 'may-khach-3' });
  await first.deliver(webhook({ psid: '9200000000000001', fromPage: true, adminName: 'Public API', text: 'Dạ em thấy chị để lại bình luận dưới bài viết của Giọt Nắng ạ 💛 Dạ chị cần em tư vấn loại nào ạ' }));
  await first.deliver(webhook({ psid: '9200000000000001', text: 'Bao nhiều một gói ngũ cốc' }));
  await pause(300);
  assert.equal(offersTo(first, '9200000000000001').length, 0);
  assert.equal(first.matcher.pendingClicks(), 1, 'lượt bấm còn nguyên cho khách quét thẻ thật');
  // (b) Tin khách về trước, tin hệ thống của Messenger về ngay sau (trước lúc chào).
  // Quãng chờ mơ hồ 1,5 giây (thật): tin hệ thống phải về TRƯỚC khi hết quãng chờ dù máy đang bận.
  const second = createFlow({ ambiguityMs: 1500 });
  second.matcher.noteClick({ code: 'tmdt-01', visitor: 'may-khach-4' });
  await second.deliver(webhook({ psid: '9200000000000002', text: '1 bịch nâu và 1 bịch xanh' }));
  assert.equal(second.matcher.stateOf(`${PAGE}:9200000000000002`), 'held');
  await second.deliver(webhook({ psid: '9200000000000002', fromPage: true, text: 'Bạn đang phản hồi bình luận của người dùng về bài viết trên Trang của mình. Xem bình luận.(https://facebook.com/giotnang.healthy/videos/1/?comment_id=2)' }));
  await until(() => second.matcher.stateOf(`${PAGE}:9200000000000002`) !== 'held' && second.matcher.stateOf(`${PAGE}:9200000000000002`) !== 'resolving', 'bộ khớp xét xong hội thoại (b)');
  await pause(150);
  assert.equal(offersTo(second, '9200000000000002').length, 0);
  assert.ok(second.logs.some(line => /QR: bỏ khớp lượt bấm tmdt-01 với .*: nhắn riêng từ bình luận/.test(line)), second.logs.join('\n'));
  assert.equal(second.matcher.pendingClicks(), 1, 'bỏ khớp thì trả lại lượt bấm');
  // (c) "X đã trả lời về một bài viết" / "replied to a post" (tin hệ thống) đến trước tin khách.
  const third = createFlow();
  third.matcher.noteClick({ code: 'tmdt-01', visitor: 'may-khach-5' });
  await third.deliver(webhook({ psid: '9200000000000003', fromPage: true, text: 'Khách đã trả lời về một bài viết. Xem bài viết(https://www.facebook.com/1)' }));
  await third.deliver(webhook({ psid: '9200000000000003', text: 'Xin giá' }));
  await pause(300);
  assert.equal(offersTo(third, '9200000000000003').length, 0);
});

test('hội thoại mới từ QUẢNG CÁO: Pancake kèm mục quảng cáo vừa bấm, hoặc tin ad_click → không chào', async () => {
  const flow = createFlow();
  flow.matcher.noteClick({ code: 'tmdt-01', visitor: 'may-khach-6' });
  const freshAd = [{ ad_id: '120249089346230380', post_id: `${PAGE}_880565357839886`, inserted_at: new Date(clock() - 60_000).toISOString().replace('Z', '') }];
  await flow.deliver(webhook({ psid: '9300000000000001', text: 'Xin giá', ads: freshAd }));
  await pause(300);
  assert.equal(offersTo(flow, '9300000000000001').length, 0);
  assert.ok(flow.logs.some(line => /không tính là quét thẻ: referral quảng cáo \(bấm 1 phút trước\)/.test(line)), flow.logs.join('\n'));
  // Tin ad_click về trước tin khách: hội thoại đã có tin → không phải hội thoại mới.
  await flow.deliver(webhook({ psid: '9300000000000002', fromPage: true, attachments: [{ type: 'ad_click', ad_id: '1202', url: `https://facebook.com/${PAGE}_88`, post_attachments: [{ description: 'Granola Túi Xanh' }] }] }));
  await flow.deliver(webhook({ psid: '9300000000000002', text: 'Tư vấn' }));
  await pause(300);
  assert.equal(offersTo(flow, '9300000000000002').length, 0);
  assert.equal(flow.matcher.pendingClicks(), 1);
});

test('hội thoại mới từ giỏ Facebook Shop ("Khách chọn mua từ Facebook Shop…") → không chào', async () => {
  const flow = createFlow();
  flow.matcher.noteClick({ code: 'tmdt-01', visitor: 'may-khach-7' });
  const cart = [{ type: 'cart_order', order: { items: [{ quantity: 1, variation_info: { name: 'Granola Túi Xanh 450g', retailer_id: 'GX450', retail_price: 189000 } }] } }];
  await flow.deliver(webhook({ psid: '9400000000000001', text: 'm_send_cart:1', attachments: cart }));
  await pause(300);
  assert.equal(offersTo(flow, '9400000000000001').length, 0);
  assert.ok(flow.logs.some(line => /không tính là quét thẻ: giỏ Facebook Shop/.test(line)), flow.logs.join('\n'));
  assert.equal(flow.matcher.pendingClicks(), 1);
});

test('MƠ HỒ: một lượt bấm, hai hội thoại mới cùng lúc → không chào ai, lượt bấm bị tiêu', async () => {
  // Quãng chờ mơ hồ 3 giây (thật): tin của Khách B phải tới khi Khách A còn đang giữ lượt bấm, kể cả lúc máy bận. Không làm
  // test chậm: B tới là A bị bỏ ngay (không ai chờ hết 3 giây).
  const flow = createFlow({ ambiguityMs: 3000 });
  flow.matcher.noteClick({ code: 'tmdt-01', visitor: 'may-khach-8' });
  skew += 20_000;
  await flow.deliver(webhook({ psid: '9500000000000001', text: 'Alo shop', name: 'Khách A' }));
  await flow.deliver(webhook({ psid: '9500000000000002', text: 'Hi', name: 'Khách B' }));
  await until(() => flow.matcher.stateOf(`${PAGE}:9500000000000001`) === 'dropped', 'Khách A bị bỏ khớp vì mơ hồ');
  await pause(300);
  assert.equal(flow.posted.length, 0, 'không ai nhận ưu đãi');
  assert.deepEqual(flow.events, ['bot:Alo shop', 'bot:Hi'], 'bot vẫn trả lời cả hai như thường');
  assert.ok(flow.logs.some(line => /^QR: lượt bấm tmdt-01 có 2 hội thoại mới cùng lúc, không chào để tránh nhầm — Khách A .* và Khách B/.test(line)), flow.logs.join('\n'));
  assert.equal(flow.matcher.pendingClicks(), 0);
  // Hội thoại mới thứ ba đến sau cũng không được dùng lại lượt bấm đó.
  await flow.deliver(webhook({ psid: '9500000000000003', text: 'Ib', name: 'Khách C' }));
  await pause(400);
  assert.equal(flow.posted.length, 0);
});

test('khớp 1–1 theo thứ tự thời gian: 2 lượt bấm + 2 hội thoại mới → cả hai được chào; 1 lượt bấm + hội thoại thứ hai đến sau 15 giây → chỉ người đầu', async () => {
  const flow = createFlow();
  flow.matcher.noteClick({ code: 'tmdt-01', visitor: 'may-khach-9' });
  flow.matcher.noteClick({ code: 'tmdt-01', visitor: 'may-khach-10' });
  await flow.deliver(webhook({ psid: '9600000000000001', text: 'Bắt đầu', name: 'Khách D' }));
  await flow.deliver(webhook({ psid: '9600000000000002', text: 'Xin giá', name: 'Khách E' }));
  await until(() => offersTo(flow, '9600000000000001').length >= 2 && offersTo(flow, '9600000000000002').length >= 2, 'cả Khách D và Khách E nhận ưu đãi');
  await pause(100);
  assert.equal(offersTo(flow, '9600000000000001').length, 2);
  assert.equal(offersTo(flow, '9600000000000002').length, 2);
  // Một lượt bấm; hội thoại thứ hai đến sau quãng mơ hồ: người đầu được chào, người sau không.
  const later = createFlow({ ambiguityMs: 60 });
  later.matcher.noteClick({ code: 'tmdt-01', visitor: 'may-khach-11' });
  await later.deliver(webhook({ psid: '9600000000000003', text: 'Alo e', name: 'Khách F' }));
  await until(() => offersTo(later, '9600000000000003').length >= 2, 'Khách F nhận ưu đãi trước khi Khách G nhắn');
  skew += 20_000;
  await later.deliver(webhook({ psid: '9600000000000004', text: '.', name: 'Khách G' }));
  await pause(300);
  assert.equal(offersTo(later, '9600000000000003').length, 2);
  assert.equal(offersTo(later, '9600000000000004').length, 0);
});

test('khách CŨ có referral Meta: chào như cũ (không qua bộ khớp); tin khách gửi ngay sau đó không làm chào lần hai', async () => {
  const flow = createFlow();
  const psid = '9700000000000001';
  // Hội thoại đã có từ hôm trước.
  await flow.deliver(webhook({ psid, text: 'Cho mình 2 túi', name: 'Khách Cũ', at: clock() - 3 * 24 * 60 * 60 * 1000 }));
  flow.events.length = 0;
  flow.matcher.noteClick({ code: 'tmdt-01', visitor: 'may-khach-12' });
  const changes = await updateMessagingStore(store => applyWebhookEvents(store, [{ type: 'referral', pageId: PAGE, psid, timestamp: clock(), referral: { ref: 'tmdt-01', source: 'SHORTLINK', type: 'OPEN_THREAD' } }]), { defer: true });
  flow.greeter.schedule(changes);
  await flow.deliver(webhook({ psid, text: 'Alo e', name: 'Khách Cũ' }));
  await until(() => offersTo(flow, psid).length >= 2, 'Khách Cũ nhận ưu đãi');
  await pause(200);
  assert.equal(offersTo(flow, psid).length, 2, 'đúng một lượt ưu đãi (ảnh + chữ)');
  assert.ok(flow.logs.some(line => /QR: khách quét ref="tmdt-01", sẽ chào sau/.test(line)));
  assert.ok(!flow.logs.some(line => /khớp lượt bấm/.test(line)), 'khách cũ không đi qua bộ khớp lượt bấm');
  assert.equal(flow.matcher.pendingClicks(), 1);
});

test('đường tin soạn sẵn #mã giữ nguyên: bot không nhận tin đó, bộ khớp không đụng tới, chỉ một lượt ưu đãi', async () => {
  const flow = createFlow();
  const psid = '9800000000000001';
  flow.matcher.noteClick({ code: 'tmdt-01', visitor: 'may-khach-13' });
  const summary = await flow.deliver(webhook({ psid, text: 'Mình vừa quét thẻ cảm ơn Giọt Nắng 💛 #tmdt-01' }));
  assert.equal(summary.bot, 0);
  await until(() => offersTo(flow, psid).length >= 2, 'khách gửi tin soạn sẵn #mã nhận ưu đãi');
  await pause(200);
  assert.equal(offersTo(flow, psid).length, 2);
  assert.equal(flow.matcher.pendingClicks(), 1, 'lượt bấm không bị tiêu bởi đường #mã');
});

test('khởi động lại (dựng bộ chào mới): mốc đã chào đọc lại từ kho → không chào lần hai; hội thoại có đơn trong 6 giờ → không chào', async () => {
  // Hội thoại của test đầu (…895462) đã được chào và mốc nằm trong kho.
  const psid = '28074385268895462';
  const restarted = createFlow();
  await restarted.greeter.ready;
  assert.ok(restarted.logs.some(line => /QR: đọc lại \d+ mốc đã chào còn hiệu lực từ kho/.test(line)), restarted.logs.join('\n'));
  const conversation = await conversationOf(psid);
  // Bản public (không mang qrGreetedAt) để chắc mốc lấy từ lần đọc kho, không chỉ từ trường trên hội thoại.
  const bare = { id: conversation.id, pageId: conversation.pageId, psid: conversation.psid, name: conversation.name, pancakeConversationId: conversation.pancakeConversationId };
  restarted.greeter.schedule([{ type: 'referral', conversation: bare, referral: { ref: 'tmdt-01', source: 'SHORTLINK' } }]);
  await until(() => restarted.logs.some(line => /QR: bỏ qua chào Khách Thẻ/.test(line)), 'bộ chào mới bỏ qua khách đã chào');
  await pause(100);
  assert.equal(restarted.posted.length, 0, 'khách đã nhận ưu đãi trước khi khởi động lại: không gửi lần hai');
  assert.ok(restarted.logs.some(line => /QR: bỏ qua chào Khách Thẻ/.test(line)), restarted.logs.join('\n'));
  // Hội thoại vừa chốt đơn (ca 02/10 10:42): quét thẻ không gửi ưu đãi.
  const ordered = '9900000000000001';
  await restarted.deliver(webhook({ psid: ordered, text: 'Chốt đơn giúp chị', name: 'Khách Đã Chốt', at: clock() - 2 * 60 * 60 * 1000 }));
  await updateMessagingStore(store => {
    store.conversations.find(item => item.id === `${PAGE}:${ordered}`).customerOrders = [{ id: 'pos55059', createdAt: clock() - 30 * 60 * 1000 }];
  }, { defer: true });
  const changes = await updateMessagingStore(store => applyWebhookEvents(store, [{ type: 'referral', pageId: PAGE, psid: ordered, timestamp: clock(), referral: { ref: 'tmdt-01', source: 'SHORTLINK', type: 'OPEN_THREAD' } }]), { defer: true });
  restarted.greeter.schedule(changes);
  await until(() => restarted.logs.some(line => /QR: không chào Khách Đã Chốt/.test(line)), 'bộ chào xét xong hội thoại vừa chốt đơn');
  await pause(100);
  assert.equal(offersTo(restarted, ordered).length, 0);
  assert.ok(restarted.logs.some(line => /QR: không chào Khách Đã Chốt \(hội thoại có đơn tạo 30 phút trước\)/.test(line)), restarted.logs.join('\n'));
});

test('bridgeSourceMarker: từng dấu nguồn và ngưỡng "còn mới" 24 giờ', () => {
  const at = 1_790_000_000_000;
  const message = { id: 'm1', direction: 'incoming', type: 'text', text: 'Cho chị xem sản phẩm mới', createdAt: at };
  const conversation = { id: '1:2', pageId: '1', psid: '2' };
  const marker = extra => bridgeSourceMarker({ conversation, messages: [message], message, ...extra });
  assert.equal(marker(), '');
  assert.equal(marker({ conversation: { ...conversation, source: 'comment' } }), 'luồng bình luận');
  assert.equal(marker({ message: { ...message, direction: 'outgoing' } }), 'không phải tin khách');
  assert.equal(marker({ messages: [{ id: 'm0', direction: 'incoming', text: 'hi', createdAt: at - 1000 }, message] }), 'hội thoại đã có tin trước đó');
  assert.equal(marker({ messages: [message, { id: 'b1', direction: 'outgoing', text: 'Dạ em chào chị', sender: 'bot', createdAt: at + 1000 }], phase: 'resolve' }), '', 'lúc sắp chào: câu trả lời của bot không phải dấu nguồn');
  assert.equal(marker({ messages: [message, { id: 'a1', direction: 'outgoing', type: 'ad', text: 'Khách bấm vào quảng cáo', createdAt: at + 1000 }], phase: 'resolve' }), 'khách bấm quảng cáo');
  assert.match(marker({ conversation: { ...conversation, referral: { source: 'ADS', adId: '1', lastAt: at - 5 * 60_000 } } }), /^referral quảng cáo \(bấm 5 phút trước\)/);
  assert.equal(marker({ conversation: { ...conversation, referral: { source: 'ADS', adId: '1', firstAt: at - 27 * 86_400_000, lastAt: at - 27 * 86_400_000 } } }), '', 'quảng cáo bấm từ 27 ngày trước (ca thật) không phải nguồn của lượt này');
  assert.equal(marker({ conversation: { ...conversation, referral: { source: 'ADS', adId: '1' } } }), 'referral quảng cáo (không rõ giờ bấm)');
  assert.equal(marker({ message: { ...message, text: 'Khách chọn mua từ Facebook Shop: Granola Túi Xanh 450g' }, messages: [] }), 'giỏ Facebook Shop');
  assert.equal(marker({ message: { ...message, cart: [{ name: 'Granola' }] }, messages: [] }), 'giỏ Facebook Shop');
  for (const text of ['Dạ em thấy chị để lại bình luận dưới bài viết của Giọt Nắng ạ 💛', 'Bạn đang phản hồi bình luận của người dùng về bài viết trên Trang của mình.', 'Khách đã trả lời về một bài viết. Xem bài viết', 'Khách replied to a post']) {
    assert.equal(marker({ messages: [message, { id: 'p1', direction: 'outgoing', text, createdAt: at + 2000 }], phase: 'resolve' }), 'nhắn riêng từ bình luận', text);
  }
  assert.equal(marker({ commentAt: at - 60_000 }), 'khách vừa bình luận dưới bài viết');
  assert.equal(marker({ commentAt: at - 30 * 86_400_000 }), '', 'bình luận từ tháng trước không tính');
  assert.equal(marker({ conversation: { ...conversation, qrReferrals: [{ ref: 'tmdt-01', source: 'SHORTLINK', at: at - 10_000 }] } }), 'đã có referral thẻ QR (đường khác xử lý)');
});

test('lượt bấm chờ khớp: mã lạ không ghi; cùng máy bấm lại chỉ là một lượt; cửa sổ 0 = tắt; Page khác không khớp', async () => {
  const logs = [];
  const greeted = [];
  let current = 1_790_000_000_000;
  const build = (options = {}) => createBridgeClickMatcher({
    greet: change => greeted.push(change),
    inspect: async change => ({ conversation: change.conversation, messages: [change.message], commentAt: 0 }),
    pageId: PAGE,
    ambiguityMs: 10,
    now: () => current,
    log: line => logs.push(line),
    ...options
  });
  const matcher = build();
  assert.equal(matcher.noteClick({ code: 'tmdt-99', visitor: 'a' }), false, 'mã chưa tạo ở Cài đặt → Mã QR');
  assert.equal(matcher.noteClick({ code: 'tmdt-01', visitor: 'a' }), true);
  current += 30_000;
  assert.equal(matcher.noteClick({ code: 'tmdt-01', visitor: 'a' }), true);
  assert.equal(matcher.pendingClicks(), 1, 'cùng máy bấm lại: một lượt, mốc dời về lần bấm sau');
  current += 80_000;
  const change = (psid, pageId = PAGE) => ({ type: 'message', conversation: { id: `${pageId}:${psid}`, pageId, psid, name: 'K' }, message: { id: `m-${psid}`, direction: 'incoming', text: 'Xin giá', createdAt: current } });
  assert.deepEqual(await matcher.consider([change('1', '999')]), [], 'hội thoại của Page khác');
  assert.deepEqual(await matcher.consider([change('2')]), [`${PAGE}:2`], '80 giây sau lần bấm SAU (110 giây sau lần đầu) vẫn trong cửa sổ');
  matcher.botDone([`${PAGE}:2`]);
  await until(() => greeted.length >= 1, 'bộ khớp gọi greet');
  assert.equal(greeted.length, 1);
  assert.deepEqual(greeted[0].referral, { ref: 'tmdt-01', source: 'SHORTLINK', type: 'BRIDGE_CLICK' });
  const off = build({ windowMs: 0 });
  assert.equal(off.noteClick({ code: 'tmdt-01', visitor: 'b' }), false);
  assert.deepEqual(await off.consider([change('3')]), []);
});

test('server.mjs: beacon máy nhân viên không ghi lượt bấm chờ khớp; webhook Pancake gọi bộ khớp trước bot và báo bot xong ở finally', () => {
  const source = readFileSync(new URL('../app/server.mjs', import.meta.url), 'utf8').replace(/\r/g, '');
  const beacon = source.slice(source.indexOf('if (isOpenBeacon) {'), source.indexOf("if (request.method !== 'GET') return sendJson(response, 405, { error: 'Chỉ nhận GET.' });"));
  const staffBranch = beacon.slice(beacon.indexOf('if (staffScan) {'), beacon.indexOf('} else {'));
  assert.ok(staffBranch.includes('bỏ đếm lượt bấm') && !staffBranch.includes('noteClick'), 'máy đã đăng nhập CRM: không ghi lượt bấm chờ khớp');
  assert.match(beacon.slice(beacon.indexOf('} else {')), /if \(target === 'messenger'\) qrBridgeMatcher\.noteClick\(\{ code, visitor \}\);/);
  assert.match(source, /qrBridgeHeld = await considerQrBridgeClicks\(changes\);\n\s+return changes\.filter\(change => !isCardScan\(change\)\);/);
  assert.match(source, /\} finally \{\n\s+qrBridgeMatcher\.botDone\(qrBridgeHeld\);/);
  assert.match(source, /windowMs: qrBridgeEnvMs\('QR_BRIDGE_MATCH_WINDOW_MS', 90_000\)/);
});
