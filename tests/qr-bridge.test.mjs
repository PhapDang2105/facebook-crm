import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

process.env.QR_SCANS_PATH = path.join(mkdtempSync(path.join(tmpdir(), 'qr-')), 'qr-scans.json');

const { classifyUserAgent, isLinkPreviewBot, renderBridgePage, shouldRedirectDirectly } = await import('../app/qr-bridge.mjs');
const { recordQrScan, recordQrOpen, listQrScans, isValidQrCode, isKnownQrCode, registerQrCode, deleteQrCode, countQrReferrals } = await import('../app/qr-scans.mjs');

const agents = {
  iosSafari: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
  iosChrome: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/126.0.6478.54 Mobile/15E148 Safari/604.1',
  iosWebview: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148',
  androidChrome: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.6478.71 Mobile Safari/537.36',
  androidWebview: 'Mozilla/5.0 (Linux; Android 14; Pixel 8 Build/AP1A; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/126.0.6478.71 Mobile Safari/537.36',
  androidSamsung: 'Mozilla/5.0 (Linux; Android 14; SAMSUNG SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/25.0 Chrome/121.0.0.0 Mobile Safari/537.36',
  zaloAndroid: 'Mozilla/5.0 (Linux; Android 12; 2201117TG Build/SKQ1.211103.001) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/109.0.5414.117 Mobile Safari/537.36 Zalo android/12100676 ZaloTheme/dark ZaloLanguage/vi',
  zaloIos: 'Mozilla/5.0 (iPhone; CPU iPhone OS 15_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Zalo iOS/470 ZaloTheme/light ZaloLanguage/vn',
  facebookIos: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 [FBAN/FBIOS;FBAV/470.0.0.35.108;FBBV/611437296;FBDV/iPhone15,3;FBMD/iPhone;FBSN/iOS;FBSV/17.5;FBSS/3;FBID/phone;FBLC/vi_VN;FBOP/5]',
  facebookAndroid: 'Mozilla/5.0 (Linux; Android 14; Pixel 8 Build/AP1A; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/126.0.6478.71 Mobile Safari/537.36 [FB_IAB/FB4A;FBAV/470.0.0.40.108;]',
  instagram: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Instagram 335.0.0.34.98 (iPhone15,3; iOS 17_5; vi_VN; vi; scale=3.00; 1179x2556; 600258567)',
  tiktok: 'Mozilla/5.0 (Linux; Android 14; Pixel 8 Build/AP1A; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/126.0.6478.71 Mobile Safari/537.36 trill_2023507030 JsSdk/1.0 NetType/WIFI Channel/googleplay AppName/musical_ly app_version/35.7.3 ByteLocale/vi Region/VN',
  desktopChrome: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
};

test('nhận diện máy và trình duyệt: Zalo, Facebook, Instagram, TikTok, WebView là "trong app"', () => {
  assert.deepEqual(classifyUserAgent(agents.iosSafari), { platform: 'ios', browser: 'safari', inApp: false });
  assert.deepEqual(classifyUserAgent(agents.iosChrome), { platform: 'ios', browser: 'chrome', inApp: false });
  assert.deepEqual(classifyUserAgent(agents.iosWebview), { platform: 'ios', browser: 'webview', inApp: true });
  assert.deepEqual(classifyUserAgent(agents.androidChrome), { platform: 'android', browser: 'chrome', inApp: false });
  assert.deepEqual(classifyUserAgent(agents.androidWebview), { platform: 'android', browser: 'webview', inApp: true });
  assert.deepEqual(classifyUserAgent(agents.androidSamsung), { platform: 'android', browser: 'samsung', inApp: false });
  assert.deepEqual(classifyUserAgent(agents.zaloAndroid), { platform: 'android', browser: 'zalo', inApp: true });
  assert.deepEqual(classifyUserAgent(agents.zaloIos), { platform: 'ios', browser: 'zalo', inApp: true });
  assert.deepEqual(classifyUserAgent(agents.facebookIos), { platform: 'ios', browser: 'facebook', inApp: true });
  assert.deepEqual(classifyUserAgent(agents.facebookAndroid), { platform: 'android', browser: 'facebook', inApp: true });
  assert.deepEqual(classifyUserAgent(agents.instagram), { platform: 'ios', browser: 'instagram', inApp: true });
  assert.deepEqual(classifyUserAgent(agents.tiktok), { platform: 'android', browser: 'tiktok', inApp: true });
  assert.deepEqual(classifyUserAgent(agents.desktopChrome), { platform: 'may tinh', browser: 'chrome', inApp: false });
  assert.deepEqual(classifyUserAgent(''), { platform: 'khac', browser: 'khac', inApp: false });
});

test('chỉ Chrome hệ thống trên Android được chuyển hướng 302 thẳng', () => {
  assert.equal(shouldRedirectDirectly(classifyUserAgent(agents.androidChrome)), true);
  for (const key of Object.keys(agents).filter(name => name !== 'androidChrome')) {
    assert.equal(shouldRedirectDirectly(classifyUserAgent(agents[key])), false, `${key} phải nhận trang đệm`);
  }
});

const render = (userAgent, extra = {}) => renderBridgePage({
  code: 'tmdt-01',
  destination: 'https://m.me/123456?ref=tmdt-01',
  pageName: 'Nông Sản Giọt Nắng',
  fallbackUrl: 'https://www.facebook.com/123456',
  classification: classifyUserAgent(userAgent),
  ...extra
});

test('trang đệm: nút Mở Messenger là thẻ <a> trỏ thẳng m.me?ref, không tài nguyên ngoài, không tự chuyển hướng', () => {
  const html = render(agents.iosSafari);
  assert.match(html, /<a class="btn" id="open" href="https:\/\/m\.me\/123456\?ref=tmdt-01"/);
  assert.match(html, /Nông Sản Giọt Nắng/);
  assert.match(html, /href="https:\/\/www\.facebook\.com\/123456"/);
  assert.match(html, /\/q\/tmdt-01\/open/);
  assert.doesNotMatch(html, /src=|<link|@import|url\(/, 'không được tải tài nguyên ngoài: /assets nằm sau mật khẩu');
  assert.doesNotMatch(html, /http-equiv="refresh"|location\.(href|replace|assign)/, 'không tự chuyển hướng: iOS chỉ mở app khi khách tự bấm');
  assert.doesNotMatch(html, /fb-messenger:|intent:/, 'không dùng scheme không có tài liệu');
  assert.ok(Buffer.byteLength(html, 'utf8') < 15_000, 'trang phải nhẹ');
  // Safari hệ thống thì không cần hướng dẫn mở bằng trình duyệt.
  assert.doesNotMatch(html, /class="hint"/);
});

test('trang đệm: trong app thì có hướng dẫn đúng app', () => {
  assert.match(render(agents.zaloAndroid), /Bạn đang mở trong Zalo/);
  assert.match(render(agents.zaloIos), /Mở bằng trình duyệt/);
  assert.match(render(agents.facebookIos), /ứng dụng Facebook/);
  assert.match(render(agents.instagram), /Instagram/);
  assert.match(render(agents.tiktok), /TikTok/);
  assert.match(render(agents.androidWebview), /sao chép liên kết/);
  // Trình duyệt trong chính app Messenger: bấm là mở luồng, không cần hướng dẫn.
  assert.doesNotMatch(render('Mozilla/5.0 (iPhone) AppleWebKit/605.1.15 Mobile/15E148 [MessengerForiOS;FBAV/470]'), /class="hint"/);
});

test('trang đệm: nút Zalo chỉ hiện khi có liên kết; lượt bấm đếm từ lúc chạm, tách Messenger/Zalo', () => {
  const without = render(agents.iosSafari);
  assert.doesNotMatch(without, /id="zalo"|Nhắn qua Zalo/);
  const withZalo = render(agents.zaloIos, { zaloUrl: 'https://zalo.me/g/abcdef' });
  assert.match(withZalo, /<a class="btn btn-zalo" id="zalo" href="https:\/\/zalo\.me\/g\/abcdef"/);
  assert.match(withZalo, /pointerdown/, 'đếm từ lúc chạm, không đợi click (iPhone nhảy app trước click)');
  assert.match(withZalo, /arm\(open, 'messenger'\)/);
  assert.match(withZalo, /'\?to=' \+ to/);
});

test('trang đệm: tên Page và mã được escape', () => {
  const html = render(agents.iosSafari, { pageName: 'A <b>"x"</b>', code: 'tmdt-01' });
  assert.match(html, /A &lt;b&gt;&quot;x&quot;&lt;\/b&gt;/);
  assert.doesNotMatch(html, /<b>"x"<\/b>/);
});

test('kho lượt quét: đếm theo máy, trình duyệt, cách phục vụ và lượt bấm nút', async () => {
  assert.equal(isValidQrCode('tmdt-01'), true);
  assert.equal(isValidQrCode('../x'), false);
  // Mã phải được nhân viên tạo ở Cài đặt trước; quét mã chưa tạo không đếm (xem test bên dưới).
  const { registerQrCode } = await import('../app/qr-scans.mjs');
  await registerQrCode('tmdt-01', { at: 0 });
  await recordQrScan('tmdt-01', { userAgent: agents.androidChrome, mode: 'redirect', at: 1 });
  await recordQrScan('tmdt-01', { userAgent: agents.zaloAndroid, mode: 'page', at: 2 });
  await recordQrScan('tmdt-01', { userAgent: agents.iosSafari, mode: 'page', at: 3 });
  await recordQrOpen('tmdt-01', { at: 4 });
  await recordQrOpen('tmdt-01', { at: 5, target: 'zalo' });
  const { codes, recent } = await listQrScans({ 'tmdt-01': 2 });
  assert.equal(codes.length, 1);
  const entry = codes[0];
  assert.equal(entry.scans, 3);
  assert.equal(entry.opens, 1, 'bấm Zalo không tính vào lượt mở Messenger');
  assert.equal(entry.zaloOpens, 1);
  assert.equal(recent[0].event, 'open-zalo');
  recent.shift();
  assert.deepEqual(entry.platforms, { android: 2, ios: 1 });
  assert.deepEqual(entry.browsers, { chrome: 1, zalo: 1, safari: 1 });
  assert.deepEqual(entry.modes, { redirect: 1, page: 2 });
  assert.equal(entry.referrals, 2);
  assert.equal(entry.arrivalRate, 67);
  assert.equal(entry.openRate, 50, 'tỷ lệ bấm so với số lượt được phục vụ bằng trang, không tính lượt chuyển hướng');
  assert.equal(recent[0].event, 'open');
  assert.equal(recent[1].browser, 'safari');
  await assert.rejects(recordQrOpen('KHÔNG-HỢP-LỆ'), /không hợp lệ/);
});

test('đường /q/ và beacon /open công khai: mã chưa tạo ở Cài đặt không tạo mục mới (không đếm, không phình kho); kho đủ 500 mã thì tạo thêm bị từ chối, xoá mã rồi mới tạo được', async () => {
  const { maximumTrackedCodes, registerQrCode, deleteQrCode } = await import('../app/qr-scans.mjs');
  assert.equal(maximumTrackedCodes, 500);
  // Mã lạ ai đó gõ vào URL: không có mục, không ghi gì.
  assert.equal(await recordQrScan('ma-la-x', { userAgent: agents.iosSafari, mode: 'page', at: 999 }), null);
  assert.equal(await recordQrOpen('ma-la-x', { at: 1000 }), null);
  assert.ok(!(await listQrScans()).codes.some(entry => entry.code === 'ma-la-x'));
  assert.ok(!(await listQrScans()).recent.some(item => item.code === 'ma-la-x'), 'không ghi vào danh sách lượt gần đây');
  // Nhân viên tạo mã: từ đó mới đếm. Tạo lại mã đã có thì giữ nguyên số liệu.
  const created = await registerQrCode('lo-a', { at: 5 });
  assert.equal(created.scans, 0);
  assert.equal(await registerQrCode('lo-a', { at: 6 }), null, 'đã có: không ghi lại');
  assert.equal((await recordQrScan('lo-a', { userAgent: agents.androidChrome, mode: 'redirect', at: 7 })).scans, 1);
  // Kho đủ 500 mã: mã thứ 501 bị từ chối rõ ràng; xoá một mã thì tạo được.
  const before = (await listQrScans()).codes.length;
  for (let index = before; index < maximumTrackedCodes; index += 1) await registerQrCode(`lo-${index}`, { at: 100 + index });
  assert.equal((await listQrScans()).codes.length, maximumTrackedCodes);
  await assert.rejects(registerQrCode('lo-thu-501', { at: 2000 }), /đã đủ 500 mã/);
  assert.equal(await recordQrScan('lo-thu-501', { userAgent: agents.iosSafari, at: 2001 }), null, 'chưa tạo được thì quét cũng không đếm');
  assert.equal(await deleteQrCode('lo-a'), true);
  assert.equal(await deleteQrCode('lo-a'), false, 'xoá lần hai: không còn');
  assert.ok(!(await listQrScans()).recent.some(item => item.code === 'lo-a'), 'xoá mã thì lượt gần đây của mã đó cũng bỏ');
  assert.equal((await registerQrCode('lo-thu-501', { at: 2002 })).code, 'lo-thu-501');
  assert.equal((await listQrScans()).codes.length, maximumTrackedCodes);
  await assert.rejects(registerQrCode('KHÔNG-HỢP-LỆ'), /không hợp lệ/);
});

test('máy xem trước liên kết / máy quét không phải lượt quét; điện thoại thật và trình duyệt trong app thì là', () => {
  for (const key of Object.keys(agents)) assert.equal(isLinkPreviewBot(agents[key]), false, `${key} là người thật`);
  assert.equal(isLinkPreviewBot('facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)'), true);
  assert.equal(isLinkPreviewBot('Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)'), true);
  assert.equal(isLinkPreviewBot('TelegramBot (like TwitterBot)'), true);
  assert.equal(isLinkPreviewBot('WhatsApp/2.23.20.0 A'), true);
  assert.equal(isLinkPreviewBot('curl/8.4.0'), true);
  assert.equal(isLinkPreviewBot(''), true, 'UA rỗng là script, điện thoại nào cũng gửi UA');
});

test('thống kê "vào Messenger": một lượt quét về CRM ba đường (Meta, Botcake, tin soạn sẵn) vẫn đếm một; ngày khác đếm riêng; đọc cả referrals cũ', () => {
  const day = 86_400_000;
  const conversations = [
    {
      id: '1:a',
      // Kho mới: referral Meta + tin Botcake + tin soạn sẵn cùng ngày cho cùng mã.
      qrReferrals: [
        { ref: 'tmdt-01', source: 'SHORTLINK', at: 10 * day + 100 },
        { ref: 'tmdt-01', source: 'SHORTLINK', type: 'BOTCAKE_OPTIN', at: 10 * day + 2_000 },
        { ref: 'cGFuY2FrZV91dG1fc291cmNlPXRtZHQtMDE', source: 'SHORTLINK', type: 'PREFILL_TEXT', at: 10 * day + 30_000 },
        // Quét lại hôm sau: lượt mới.
        { ref: 'tmdt-01', source: 'SHORTLINK', at: 11 * day + 5 }
      ],
      // Referral quảng cáo không dính vào.
      referrals: [{ ref: '', source: 'ADS', adId: '9', at: 10 * day }]
    },
    // Bản ghi từ trước khi tách ô: SHORTLINK nằm trong referrals.
    { id: '1:b', referrals: [{ ref: 'tmdt-01', source: 'SHORTLINK', at: 10 * day }, { ref: 'tmdt-02', source: 'SHORTLINK', at: 10 * day }] },
    // ref rác không ra mã → bỏ.
    { id: '1:c', qrReferrals: [{ ref: 'ZXZpbA', source: 'SHORTLINK', at: 10 * day }] }
  ];
  assert.deepEqual(countQrReferrals(conversations), { 'tmdt-01': 3, 'tmdt-02': 1 });
  assert.deepEqual(countQrReferrals([]), {});
});
