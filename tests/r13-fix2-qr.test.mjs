// R13 fix2 (03/10) — phản biện QR khách mới (scratchpad/r13/review-qr-addr.md, mục A1–A6).
// Kiểm ở mức hàm với bộ khớp thật (app/qr-greeting.mjs createBridgeClickMatcher) và kiểm mã nguồn server.mjs cho
// các đoạn nối (HEAD, beacon → noteClick, referral Meta → noteReferral). Dòng chữ thật trong ca: tin Botcake
// "Em gửi Anh/Chị thẻ ưu đãi cho những đơn hàng sau ạ 💛\nMã thẻ: #tmdt-01", tin đầu "Cho chị xem sản phẩm mới".
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const { createBridgeClickMatcher, bridgeSourceMarker, isSourceNotice } = await import('../app/qr-greeting.mjs');
const { isLinkPreviewBot, classifyUserAgent } = await import('../app/qr-bridge.mjs');

const PAGE = '103549382215599';
const known = code => code === 'tmdt-01';
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate, label, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() > deadline) assert.fail(`hết giờ chờ: ${label}`);
    await pause(10);
  }
}

/** Thế giới nhỏ: kho hội thoại trong RAM, bộ khớp thật, greet ghi lại. */
function world(options = {}) {
  const store = { conversations: [], messages: {} };
  const logs = [];
  const greeted = [];
  const matcher = createBridgeClickMatcher({
    windowMs: 5000, ambiguityMs: 10, greetDelayMs: 0, maxBotWaitMs: 300, pageId: PAGE, known,
    inspect: async change => ({ conversation: store.conversations.find(item => item.id === change.conversation.id) || change.conversation, messages: store.messages[change.conversation.id] || [], commentAt: 0 }),
    greet: (change, extra) => greeted.push({ id: change.conversation.id, ...extra }),
    log: line => logs.push(line),
    logError: line => logs.push(`ERR ${line}`),
    ...options
  });
  let sequence = 0;
  const ensure = id => {
    let conversation = store.conversations.find(item => item.id === id);
    if (!conversation) { conversation = { id, pageId: PAGE, psid: id, name: id, pancakeConversationId: `${PAGE}_${id}` }; store.conversations.push(conversation); }
    return conversation;
  };
  const incoming = (id, text = 'Cho chị xem sản phẩm mới', extra = {}) => {
    const conversation = ensure(id);
    const message = { id: `m${++sequence}`, direction: 'incoming', type: 'text', text, createdAt: Date.now(), ...extra };
    (store.messages[id] ||= []).push(message);
    return { type: 'message', conversation, message };
  };
  const pageMessage = (id, text, extra = {}) => {
    const conversation = ensure(id);
    const message = { id: `m${++sequence}`, direction: 'outgoing', type: 'text', text, createdAt: Date.now(), ...extra };
    (store.messages[id] ||= []).push(message);
    return { type: 'message', conversation, message };
  };
  /** Tin Botcake "Mã thẻ: #tmdt-01" về qua webhook Pancake: change mang referral BOTCAKE_OPTIN, và kho ghi qrReferrals. */
  const botcake = id => {
    const change = pageMessage(id, 'Em gửi Anh/Chị thẻ ưu đãi cho những đơn hàng sau ạ 💛\nMã thẻ: #tmdt-01');
    change.referral = { ref: 'tmdt-01', source: 'SHORTLINK', type: 'BOTCAKE_OPTIN' };
    change.conversation.qrReferrals = [{ ...change.referral, at: Date.now() }];
    return change;
  };
  const settle = async ids => { matcher.botDone(ids); await pause(60); };
  return { store, logs, greeted, matcher, incoming, pageMessage, botcake, settle };
}

test('A1: Botcake chào khách CŨ (có lịch sử) → lượt bấm còn treo bị tiêu; khách lạ nhắn ngay sau KHÔNG được chào', async () => {
  const w = world();
  w.incoming('KHACH-CU', 'Shop ơi cho hỏi'); // khách cũ đã có tin trong kho
  assert.equal(w.matcher.noteClick({ code: 'tmdt-01', visitor: 'may-khach-cu' }), true);
  assert.equal(w.matcher.pendingClicks(), 1);
  // Botcake chào khách cũ (tin Page mang referral BOTCAKE_OPTIN) về qua webhook → consider nhận cả change này.
  await w.matcher.consider([w.botcake('KHACH-CU')]);
  assert.equal(w.matcher.pendingClicks(), 0, 'lượt bấm của khách cũ được tiêu ngay khi referral thẻ về');
  assert.ok(w.logs.some(line => /tiêu lượt bấm tmdt-01 đang chờ \(referral thẻ BOTCAKE_OPTIN/.test(line)), w.logs.join('\n'));
  const held = await w.matcher.consider([w.incoming('KHACH-LA', 'Xin giá')]);
  assert.deepEqual(held, [], 'khách lạ không khớp được lượt nào');
  await w.settle(held);
  assert.equal(w.greeted.length, 0);
});

test('A1: Botcake chào khách cũ KHÔNG có lịch sử trong kho (tin khách về trước, đang giữ) → huỷ khớp + tiêu lượt; khách lạ không ăn', async () => {
  const w = world({ ambiguityMs: 400 });
  w.matcher.noteClick({ code: 'tmdt-01', visitor: 'may-1' });
  const held = await w.matcher.consider([w.incoming('OLD', 'Bắt đầu')]);
  assert.deepEqual(held, ['OLD']);
  assert.equal(w.matcher.stateOf('OLD'), 'held');
  await w.matcher.consider([w.botcake('OLD')]);
  assert.equal(w.matcher.stateOf('OLD'), 'dropped');
  assert.equal(w.matcher.pendingClicks(), 0, 'lượt bấm đang giữ được tiêu, không trả về hàng chờ');
  assert.ok(w.logs.some(line => /referral thẻ tmdt-01 \(BOTCAKE_OPTIN\) về cho OLD .* chính hội thoại này đang giữ lượt bấm — huỷ khớp, tiêu lượt bấm/.test(line)), w.logs.join('\n'));
  await w.settle(held);
  const strangerHeld = await w.matcher.consider([w.incoming('STRANGER', 'Xin giá')]);
  assert.deepEqual(strangerHeld, []);
  await w.settle(strangerHeld);
  assert.equal(w.greeted.length, 0);
});

test('A1: khách LẠ đang giữ lượt bấm, Botcake chào khách cũ (hội thoại khác) cùng mã trong cửa sổ → khách lạ bị bỏ khớp, lượt tiêu', async () => {
  const w = world({ ambiguityMs: 400 });
  w.incoming('KHACH-CU', 'Shop ơi cho hỏi');
  w.matcher.noteClick({ code: 'tmdt-01', visitor: 'may-2' });
  const held = await w.matcher.consider([w.incoming('STRANGER', 'Xin giá')]);
  assert.deepEqual(held, ['STRANGER']);
  await w.matcher.consider([w.botcake('KHACH-CU')]);
  assert.equal(w.matcher.stateOf('STRANGER'), 'dropped');
  assert.equal(w.matcher.pendingClicks(), 0);
  await w.settle(held);
  assert.equal(w.greeted.length, 0);
});

test('A1: lúc chốt chào thấy "đã có referral thẻ QR" (Botcake về trong lúc giữ, ghi vào kho) → bỏ khớp VÀ tiêu lượt bấm (trước đây còn treo)', async () => {
  const w = world({ ambiguityMs: 150 });
  w.matcher.noteClick({ code: 'tmdt-01', visitor: 'may-3' });
  const held = await w.matcher.consider([w.incoming('OLD2', 'Bắt đầu')]);
  // Kho ghi referral Botcake nhưng change của nó không đi qua consider (ví dụ đồng bộ ghi thẳng).
  const conversation = w.store.conversations.find(item => item.id === 'OLD2');
  conversation.qrReferrals = [{ ref: 'tmdt-01', source: 'SHORTLINK', type: 'BOTCAKE_OPTIN', at: Date.now() }];
  w.matcher.botDone(held);
  await until(() => w.matcher.stateOf('OLD2') === 'dropped', 'bộ khớp bỏ khớp OLD2');
  assert.ok(w.logs.some(line => /bỏ khớp lượt bấm tmdt-01 với OLD2 .*: đã có referral thẻ QR/.test(line)), w.logs.join('\n'));
  assert.equal(w.matcher.pendingClicks(), 0, 'lượt bấm không còn treo 90 giây cho khách lạ');
  const strangerHeld = await w.matcher.consider([w.incoming('STRANGER2', 'Xin giá')]);
  assert.deepEqual(strangerHeld, []);
  assert.equal(w.greeted.length, 0);
});

test('A1: noteReferral riêng (đường webhook Meta): referral SHORTLINK mã thẻ về → tiêu lượt bấm; mã lạ / Page khác không đụng', async () => {
  const w = world();
  w.matcher.noteClick({ code: 'tmdt-01', visitor: 'may-4' });
  const conversation = { id: `${PAGE}:555`, pageId: PAGE, psid: '555', name: 'Khách Meta' };
  assert.equal(await w.matcher.noteReferral([{ type: 'referral', conversation: { ...conversation, pageId: '999' }, referral: { ref: 'tmdt-01', source: 'SHORTLINK' }, timestamp: Date.now() }]), 0, 'Page khác');
  assert.equal(await w.matcher.noteReferral([{ type: 'referral', conversation, referral: { ref: 'tmdt-99', source: 'SHORTLINK' }, timestamp: Date.now() }]), 0, 'mã chưa tạo');
  assert.equal(await w.matcher.noteReferral([{ type: 'referral', conversation, referral: { ref: 'abc', source: 'ADS' }, timestamp: Date.now() }]), 0, 'quảng cáo');
  assert.equal(w.matcher.pendingClicks(), 1);
  assert.equal(await w.matcher.noteReferral([{ type: 'referral', conversation, referral: { ref: 'tmdt-01', source: 'SHORTLINK' }, timestamp: Date.now() }]), 1);
  assert.equal(w.matcher.pendingClicks(), 0);
});

test('A2: HEAD /q/<mã> không đếm, không tạo lượt chờ; không còn 302 Android; crawler UA Android (GoogleOther, AdsBot, InspectionTool, Lighthouse…) là máy', () => {
  const source = readFileSync(new URL('../app/server.mjs', import.meta.url), 'utf8').replace(/\r/g, '');
  assert.match(source, /const headRequest = request\.method === 'HEAD';/);
  const route = source.slice(source.indexOf("if (request.method !== 'GET') return sendJson(response, 405, { error: 'Chỉ nhận GET.' });"), source.indexOf("// Đối chiếu lượt quét với số referral Messenger"));
  assert.match(route, /if \(headRequest\) \{\s*console\.log\(`QR: bỏ qua đếm \$\{code\}: HEAD/);
  assert.doesNotMatch(route, /noteClick/, 'đường GET /q/<mã> không còn ghi lượt bấm chờ khớp (chỉ beacon)');
  assert.doesNotMatch(route, /writeHead\(302/, 'không còn chuyển hướng 302 thẳng sang m.me');
  assert.doesNotMatch(route, /shouldRedirectDirectly\(/, 'không còn gọi shouldRedirectDirectly (chỉ còn nhắc trong chú thích)');
  assert.match(route, /recordQrScan\(code, \{ userAgent, mode: 'page' \}\)/);
  const androidChrome = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.6478.71 Mobile Safari/537.36';
  const crawlers = [
    'Mozilla/5.0 (Linux; Android 6.0.1; Nexus 5X Build/MMB29P) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36 (compatible; GoogleOther)',
    'Mozilla/5.0 (Linux; Android 6.0.1; Nexus 5X Build/MMB29P) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36 (compatible; AdsBot-Google-Mobile; +http://www.google.com/mobile/adsbot.html)',
    'Mozilla/5.0 (Linux; Android 6.0.1; Nexus 5X Build/MMB29P) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36 (compatible; Google-InspectionTool/1.0;)',
    'Mozilla/5.0 (Linux; Android 11; moto g power (2022)) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36 Chrome-Lighthouse',
    'Mozilla/5.0 (Linux; Android 6.0.1; Nexus 5X Build/MMB29P) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
    'Mozilla/5.0 (Linux; Android 6.0.1; Nexus 5X Build/MMB29P) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)',
    'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)',
    'WhatsApp/2.23.20.0 A', 'TelegramBot (like TwitterBot)', 'Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)',
    'Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)', 'Twitterbot/1.0', 'LinkedInBot/1.0 (compatible; Mozilla/5.0; Apache-HttpClient +http://www.linkedin.com)',
    'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36 Zalo-Preview', 'ZaloPC-win32-24v473 ZaloCrawler'
  ];
  for (const ua of crawlers) assert.equal(isLinkPreviewBot(ua), true, ua);
  // Điện thoại thật vẫn là lượt quét.
  for (const ua of [androidChrome, 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_3 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.3 Mobile/15E148 Safari/604.1',
    'Mozilla/5.0 (Linux; Android 12; 2201117TG Build/SKQ1.211103.001) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/109.0.5414.117 Mobile Safari/537.36 Zalo android/12100676 ZaloTheme/dark ZaloLanguage/vi']) {
    assert.equal(isLinkPreviewBot(ua), false, ua);
  }
});

test('A3: cùng máy bấm lại khi lượt trước đang giữ / đã dùng → không sinh lượt thứ hai; chưa giữ thì chỉ dời mốc', async () => {
  // Nới giới hạn tốc độ (A4) để ca này bấm 4 lần cùng máy trong vài trăm ms.
  const w = world({ ambiguityMs: 400, clickRateLimit: { max: 10, windowMs: 60_000 } });
  assert.equal(w.matcher.noteClick({ code: 'tmdt-01', visitor: 'may-5' }), true);
  assert.equal(w.matcher.noteClick({ code: 'tmdt-01', visitor: 'may-5' }), true);
  assert.equal(w.matcher.pendingClicks(), 1, 'chưa giữ: dời mốc, vẫn một lượt');
  const held = await w.matcher.consider([w.incoming('QUET', 'Bắt đầu')]);
  assert.deepEqual(held, ['QUET']);
  assert.equal(w.matcher.noteClick({ code: 'tmdt-01', visitor: 'may-5' }), true, 'bấm đúp trong lúc đang giữ');
  assert.equal(w.matcher.pendingClicks(), 0, 'không thêm lượt chờ khớp');
  assert.ok(w.logs.some(line => /lượt bấm tmdt-01 của cùng một máy, lượt trước đang giữ cho một hội thoại — bỏ qua/.test(line)), w.logs.join('\n'));
  w.matcher.botDone(held);
  await until(() => w.greeted.length === 1, 'người quét được chào');
  assert.equal(w.matcher.noteClick({ code: 'tmdt-01', visitor: 'may-5' }), true, 'bấm lại sau khi đã được chào');
  assert.equal(w.matcher.pendingClicks(), 0, 'lượt đã dùng: không mở cửa sổ mới cho khách lạ');
  const strangerHeld = await w.matcher.consider([w.incoming('STRANGER3', 'Alo shop')]);
  assert.deepEqual(strangerHeld, []);
});

test('A4: giới hạn tốc độ theo máy / IP (băm): quá 3 lượt/phút thì không ghi, một dòng log mỗi phút; beacon chỉ thành lượt chờ khi recordQrOpen ghép được', () => {
  const w = world();
  for (let index = 0; index < 3; index += 1) assert.equal(w.matcher.noteClick({ code: 'tmdt-01', visitor: `v${index}`, ip: 'ip-A' }), true);
  assert.equal(w.matcher.noteClick({ code: 'tmdt-01', visitor: 'v3', ip: 'ip-A' }), false, 'lượt thứ 4 cùng IP trong một phút');
  assert.equal(w.matcher.noteClick({ code: 'tmdt-01', visitor: 'v4', ip: 'ip-A' }), false);
  assert.equal(w.matcher.pendingClicks(), 3);
  assert.equal(w.logs.filter(line => /bỏ qua lượt bấm tmdt-01: cùng máy\/IP gửi quá 3 lượt trong 60s/.test(line)).length, 1, 'log một dòng mỗi phút');
  assert.equal(w.matcher.noteClick({ code: 'tmdt-01', visitor: 'v5', ip: 'ip-B' }), true, 'IP khác không bị ảnh hưởng');
  // Tắt giới hạn khi cần (max 0).
  const open = world({ clickRateLimit: { max: 0 } });
  for (let index = 0; index < 5; index += 1) assert.equal(open.matcher.noteClick({ code: 'tmdt-01', visitor: `o${index}`, ip: 'ip-A' }), true);
  // server.mjs: noteClick chỉ trong .then của recordQrOpen (ghép được với lượt trang đệm), kèm IP băm.
  const source = readFileSync(new URL('../app/server.mjs', import.meta.url), 'utf8').replace(/\r/g, '');
  const beacon = source.slice(source.indexOf('if (isOpenBeacon) {'), source.indexOf("if (request.method !== 'GET') return sendJson(response, 405, { error: 'Chỉ nhận GET.' });"));
  assert.match(beacon, /recordQrOpen\(code, \{ target, visitor \}\)\s*\.then\(entry => \{\s*if \(entry && target === 'messenger'\) qrBridgeMatcher\.noteClick\(\{ code, visitor, ip: qrVisitorKey\(clientIp\(request\), ''\) \}\);/);
  assert.equal((beacon.match(/noteClick/g) || []).length, 1);
});

test('A5: mọi tin Page mang cờ system là dấu nguồn; "đã trả lời một quảng cáo" / "replied to an ad"; dòng về trong lúc giữ → huỷ khớp; chờ thêm 20 s khi Pancake vừa có dòng hệ thống', async () => {
  const now = Date.now();
  const message = { id: 'm1', direction: 'incoming', type: 'text', text: 'Xin giá', createdAt: now };
  const conversation = { id: 'P:1', pageId: PAGE, psid: '1' };
  const page = (text, extra = {}) => ({ id: 'p1', direction: 'outgoing', type: 'text', text, createdAt: now + 1000, ...extra });
  assert.equal(bridgeSourceMarker({ conversation, message, phase: 'resolve', messages: [message, page('Lan đã trả lời một quảng cáo.')] }), 'nhắn riêng từ bình luận');
  assert.equal(bridgeSourceMarker({ conversation, message, phase: 'resolve', messages: [message, page('Lan replied to an ad.')] }), 'nhắn riêng từ bình luận');
  assert.equal(bridgeSourceMarker({ conversation, message, phase: 'resolve', messages: [message, page('Lan đã trả lời tin của bạn', { system: true })] }), 'tin hệ thống của Page (khách vào từ nguồn khác)');
  assert.equal(bridgeSourceMarker({ conversation, message, phase: 'resolve', messages: [message, page('Dạ em chào chị', { staff: true })] }), '', 'nhân viên nhắn không phải dấu nguồn');
  assert.equal(isSourceNotice({ direction: 'outgoing', text: 'x', system: true }), true);
  assert.equal(isSourceNotice({ direction: 'incoming', text: 'Lan đã trả lời về một bài viết' }), false);
  // Dòng hệ thống về SAU tin khách, trong lúc đang giữ → huỷ khớp ngay, trả lại lượt bấm.
  const w = world({ ambiguityMs: 400, lateMarkerExtraMs: 0 });
  w.matcher.noteClick({ code: 'tmdt-01', visitor: 'may-6' });
  const held = await w.matcher.consider([w.incoming('BAI-VIET', 'Mua')]);
  assert.deepEqual(held, ['BAI-VIET']);
  await w.matcher.consider([w.pageMessage('BAI-VIET', 'Khách đã trả lời về một bài viết. Xem bài viết(https://www.facebook.com/x/posts/1)', { system: true })]);
  assert.equal(w.matcher.stateOf('BAI-VIET'), 'dropped');
  assert.equal(w.matcher.pendingClicks(), 1, 'lượt bấm trả về cho người quét thật');
  assert.ok(w.logs.some(line => /huỷ khớp lượt bấm tmdt-01 với BAI-VIET .*: dấu nguồn về muộn/.test(line)), w.logs.join('\n'));
  await w.settle(held);
  assert.equal(w.greeted.length, 0);
  // Pancake vừa có dòng hệ thống (hội thoại khác) → hội thoại đang giữ chờ thêm lateMarkerExtraMs rồi mới chốt.
  const late = world({ ambiguityMs: 20, lateMarkerExtraMs: 150, lateMarkerWindowMs: 60_000 });
  late.incoming('KHAC', 'Mua');
  await late.matcher.consider([late.pageMessage('KHAC', 'Khách đã trả lời về một bài viết. Xem bài viết', { system: true })]);
  late.matcher.noteClick({ code: 'tmdt-01', visitor: 'may-7' });
  const heldLate = await late.matcher.consider([late.incoming('MOI', 'Xin giá')]);
  late.matcher.botDone(heldLate);
  await pause(90);
  assert.equal(late.matcher.stateOf('MOI'), 'held', 'chưa chốt trong quãng chờ thêm');
  assert.ok(late.logs.some(line => /chờ thêm 0s trước khi chốt chào MOI|chờ thêm \d+s trước khi chốt chào MOI/.test(line)), late.logs.join('\n'));
  await until(() => late.matcher.stateOf('MOI') === 'greeted', 'hết quãng chờ thêm thì chào');
  assert.equal(late.greeted.length, 1);
});

test('A6: lịch sử Pancake có tin cũ hơn lượt bấm → 10/10 vẫn khớp (khách cũ nhận thẻ cảm ơn), tắt acceptReturningCustomers thì bỏ khớp như cũ; lỗi / quá 5 s → vẫn khớp', async () => {
  const calls = [];
  const olderHistory = async conversation => { calls.push(conversation.pancakeConversationId); return [{ createdAt: Date.now() - 3 * 86_400_000 }, { createdAt: Date.now() }]; };
  const old = world({ history: olderHistory });
  old.matcher.noteClick({ code: 'tmdt-01', visitor: 'may-8' });
  const heldOld = await old.matcher.consider([old.incoming('CU', 'Bắt đầu')]);
  old.matcher.botDone(heldOld);
  await until(() => old.greeted.length === 1, 'khách cũ duy nhất trong cửa sổ vẫn được chào');
  assert.deepEqual(calls, [`${PAGE}_CU`]);
  assert.ok(old.logs.some(line => /CU .*là khách cũ .Pancake có tin từ .*vẫn khớp lượt bấm tmdt-01/.test(line)), old.logs.join('\n'));
  // Tắt tuỳ chọn: như trước 10/10 — bỏ khớp, trả lượt bấm.
  const strict = world({ history: olderHistory, acceptReturningCustomers: false });
  strict.matcher.noteClick({ code: 'tmdt-01', visitor: 'may-8b' });
  strict.matcher.botDone(await strict.matcher.consider([strict.incoming('CU2', 'Shop ơi đơn của mình tới đâu rồi')]));
  await until(() => strict.matcher.stateOf('CU2') === 'dropped', 'bỏ khớp vì Pancake có tin cũ');
  assert.ok(strict.logs.some(line => /bỏ khớp lượt bấm tmdt-01 với CU2 .*: Pancake có tin từ .*trước lượt bấm/.test(line)), strict.logs.join('\n'));
  assert.equal(strict.matcher.pendingClicks(), 1, 'lượt bấm trả lại hàng chờ');
  assert.equal(strict.greeted.length, 0);
  // Pancake chỉ có chính tin vừa về → chào.
  const fresh = world({ history: async () => [{ createdAt: Date.now() }] });
  fresh.matcher.noteClick({ code: 'tmdt-01', visitor: 'may-9' });
  fresh.matcher.botDone(await fresh.matcher.consider([fresh.incoming('MOI2', 'Bắt đầu')]));
  await until(() => fresh.greeted.length === 1, 'khách mới vẫn được chào');
  // Lỗi mạng → vẫn khớp, có log lỗi.
  const failing = world({ history: async () => { throw new Error('ECONNREFUSED'); } });
  failing.matcher.noteClick({ code: 'tmdt-01', visitor: 'may-10' });
  failing.matcher.botDone(await failing.matcher.consider([failing.incoming('MOI3', 'Bắt đầu')]));
  await until(() => failing.greeted.length === 1, 'lỗi mạng vẫn chào theo kho CRM');
  assert.ok(failing.logs.some(line => /ERR QR: không đọc được lịch sử Pancake của MOI3 .*ECONNREFUSED.*vẫn khớp theo kho CRM/.test(line)), failing.logs.join('\n'));
  // Quá thời gian chờ (historyTimeoutMs) → vẫn khớp.
  const slow = world({ historyTimeoutMs: 40, history: () => new Promise(resolve => setTimeout(() => resolve([{ createdAt: 1 }]), 400)) });
  slow.matcher.noteClick({ code: 'tmdt-01', visitor: 'may-11' });
  slow.matcher.botDone(await slow.matcher.consider([slow.incoming('MOI4', 'Bắt đầu')]));
  await until(() => slow.greeted.length === 1, 'quá 40ms thì không chờ Pancake nữa');
  assert.ok(slow.logs.some(line => /không đọc được lịch sử Pancake của MOI4 .*\(quá 0s\) — vẫn khớp theo kho CRM/.test(line)), slow.logs.join('\n'));
  // server.mjs nối history qua fetchPancakeMessages + getPancakePageConfig, và webhook Meta gọi noteReferral.
  const source = readFileSync(new URL('../app/server.mjs', import.meta.url), 'utf8').replace(/\r/g, '');
  assert.match(source, /history: async conversation => \{\s*const conversationId = String\(conversation\?\.pancakeConversationId \|\| ''\);\s*if \(!conversationId\) return \[\];\s*const messages = await fetchPancakeMessages\(conversationId, \{ pages: 1 \}, getPancakePageConfig\(conversation\.pageId\)\);/);
  assert.match(source, /handleMetaQrChanges\(changes\);\s*\/\/[^\n]*\n\s*qrBridgeMatcher\.noteReferral\(changes\)\.catch\(/);
});
