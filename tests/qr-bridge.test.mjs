import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

process.env.QR_SCANS_PATH = path.join(mkdtempSync(path.join(tmpdir(), 'qr-')), 'qr-scans.json');

const { classifyUserAgent, renderBridgePage, shouldRedirectDirectly } = await import('../app/qr-bridge.mjs');
const { recordQrScan, recordQrOpen, listQrScans, isValidQrCode } = await import('../app/qr-scans.mjs');

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

test('trang đệm: tên Page và mã được escape', () => {
  const html = render(agents.iosSafari, { pageName: 'A <b>"x"</b>', code: 'tmdt-01' });
  assert.match(html, /A &lt;b&gt;&quot;x&quot;&lt;\/b&gt;/);
  assert.doesNotMatch(html, /<b>"x"<\/b>/);
});

test('kho lượt quét: đếm theo máy, trình duyệt, cách phục vụ và lượt bấm nút', async () => {
  assert.equal(isValidQrCode('tmdt-01'), true);
  assert.equal(isValidQrCode('../x'), false);
  await recordQrScan('tmdt-01', { userAgent: agents.androidChrome, mode: 'redirect', at: 1 });
  await recordQrScan('tmdt-01', { userAgent: agents.zaloAndroid, mode: 'page', at: 2 });
  await recordQrScan('tmdt-01', { userAgent: agents.iosSafari, mode: 'page', at: 3 });
  await recordQrOpen('tmdt-01', { at: 4 });
  const { codes, recent } = await listQrScans({ 'tmdt-01': 2 });
  assert.equal(codes.length, 1);
  const entry = codes[0];
  assert.equal(entry.scans, 3);
  assert.equal(entry.opens, 1);
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
