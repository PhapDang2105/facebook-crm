// Trang đệm /q/<mã> trên iPhone trong webview của app khác (Zalo, Facebook, Instagram…): webview không bàn
// giao m.me cho app Messenger, nên trang phải chỉ rõ cách mở bằng Safari — khối hướng dẫn ngay dưới nút,
// nút "Mở bằng Safari" (x-safari-https, iOS 17+, không dùng trong webview của Meta) và "Sao chép liên kết".
import test from 'node:test';
import assert from 'node:assert/strict';

const { classifyUserAgent, iosMajorVersion, renderBridgePage, safariEscapeLink } = await import('../app/qr-bridge.mjs');

const agents = {
  iosSafari: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
  zaloIos15: 'Mozilla/5.0 (iPhone; CPU iPhone OS 15_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Zalo iOS/470 ZaloTheme/light ZaloLanguage/vn',
  zaloIos18: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_3 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Zalo iOS/640 ZaloTheme/light ZaloLanguage/vn',
  facebookIos: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 [FBAN/FBIOS;FBAV/470.0.0.35.108;FBDV/iPhone15,3;FBSN/iOS;FBSV/17.5]',
  instagramIos: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Instagram 335.0.0.34.98 (iPhone15,3; iOS 17_5; vi_VN)',
  iosWebview: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148',
  messengerIos: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 [MessengerForiOS;FBAV/470]',
  ipadZalo: 'Mozilla/5.0 (iPad; CPU OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Zalo iOS/640',
  zaloAndroid: 'Mozilla/5.0 (Linux; Android 12; 2201117TG Build/SKQ1.211103.001) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/109.0.5414.117 Mobile Safari/537.36 Zalo android/12100676 ZaloTheme/dark ZaloLanguage/vi',
  androidChrome: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.6478.71 Mobile Safari/537.36'
};

const pageUrl = 'https://crm.example.com/q/tmdt-01?from=inapp';
const render = (userAgent, extra = {}) => renderBridgePage({
  code: 'tmdt-01',
  destination: 'https://m.me/103549382215599?ref=tmdt-01',
  pageName: 'Giọt Nắng',
  fallbackUrl: 'https://www.facebook.com/103549382215599',
  classification: classifyUserAgent(userAgent),
  pageUrl,
  iosVersion: iosMajorVersion(userAgent),
  ...extra
});

test('iosMajorVersion: đọc phiên bản iOS từ User-Agent của iPhone/iPad; máy khác là 0', () => {
  assert.equal(iosMajorVersion(agents.zaloIos15), 15);
  assert.equal(iosMajorVersion(agents.zaloIos18), 18);
  assert.equal(iosMajorVersion(agents.ipadZalo), 17);
  assert.equal(iosMajorVersion(agents.zaloAndroid), 0);
  assert.equal(iosMajorVersion(''), 0);
  assert.equal(iosMajorVersion(undefined), 0);
});

test('iPhone trong Zalo (iOS 17+): hướng dẫn nằm ngay dưới nút Messenger, có "Mở bằng Safari" (x-safari-https) và "Sao chép liên kết"', () => {
  const html = render(agents.zaloIos18);
  // Nút chính vẫn là thẻ <a> trỏ m.me?ref — nhánh nào mở được thì vẫn mang ref về CRM.
  assert.match(html, /<a class="btn" id="open" href="https:\/\/m\.me\/103549382215599\?ref=tmdt-01"/);
  assert.match(html, /<div class="hint hint-ios">Anh\/Chị đang mở trong Zalo/);
  assert.match(html, /Mở bằng trình duyệt/);
  assert.match(html, /<a class="hint-btn" id="safari" href="x-safari-https:\/\/crm\.example\.com\/q\/tmdt-01\?from=inapp">Mở bằng Safari<\/a>/);
  assert.match(html, /<button class="hint-btn" id="copy" type="button" data-link="https:\/\/crm\.example\.com\/q\/tmdt-01\?from=inapp">Sao chép liên kết<\/button>/);
  assert.match(html, /<input class="hint-link" id="copy-link" readonly hidden value="https:\/\/crm\.example\.com\/q\/tmdt-01\?from=inapp"/);
  // Vị trí: trong phiếu, sau nút Messenger và trước dòng Zalo; không còn khối hướng dẫn ở cuối trang.
  const open = html.indexOf('id="open"');
  const hint = html.indexOf('class="hint hint-ios"');
  const zalo = html.indexOf('id="zalo"');
  assert.ok(open < hint && hint < zalo, 'hướng dẫn nằm giữa nút Messenger và dòng Zalo');
  assert.equal(html.match(/class="hint[ "]/g).length, 1, 'chỉ một khối hướng dẫn');
  // Lượt bấm hai nút phụ gửi beacon riêng (máy chủ chỉ ghi log, không tính là mở Messenger).
  assert.match(html, /arm\(copy, 'copy'\)/);
  assert.match(html, /arm\(document\.getElementById\('safari'\), 'safari'\)/);
  assert.match(html, /navigator\.clipboard\.writeText/);
  // Không dùng scheme Messenger không có tài liệu (không mang được ref), không tự chuyển hướng.
  assert.doesNotMatch(html, /fb-messenger:|intent:/);
  assert.doesNotMatch(html, /http-equiv="refresh"|location\.(href|replace|assign)/);
  assert.doesNotMatch(html, /src="(?!\/q\/brand\/)|@import|url\(/, 'không tải tài nguyên ngoài');
  assert.doesNotMatch(html, /anh chị|anh\/chị|Anh\/chị|Bạn đang/, 'xưng hô Anh/Chị');
  assert.ok(Buffer.byteLength(html, 'utf8') < 17_000, 'trang vẫn nhẹ');
});

test('iOS dưới 17 không hiểu x-safari-https: chỉ có hướng dẫn và nút sao chép, không có nút bấm vào là đứng im', () => {
  const html = render(agents.zaloIos15);
  assert.match(html, /class="hint hint-ios"/);
  assert.match(html, /id="copy"/);
  assert.doesNotMatch(html, /x-safari-|id="safari" href/);
});

test('webview của Meta (Facebook, Instagram) trên iPhone: x-safari-https không ổn định nên không đưa; vẫn có hướng dẫn ⋯ và nút sao chép', () => {
  for (const [agent, name] of [[agents.facebookIos, 'ứng dụng Facebook'], [agents.instagramIos, 'Instagram']]) {
    const html = render(agent);
    assert.match(html, new RegExp(`class="hint hint-ios">Anh/Chị đang mở trong ${name}`));
    assert.match(html, /Mở trong trình duyệt/);
    assert.match(html, /id="copy"/);
    assert.doesNotMatch(html, /x-safari-/);
  }
  // Webview không rõ app (iOS 17): hướng dẫn chung + cả hai nút.
  const generic = render(agents.iosWebview);
  assert.match(generic, /mở trang này bằng <b>Safari<\/b>/);
  assert.match(generic, /href="x-safari-https:\/\/crm\.example\.com\/q\/tmdt-01\?from=inapp"/);
});

test('không đổi các nhánh khác: Safari hệ thống, trong chính Messenger, Android trong app, Android Chrome (trang đệm)', () => {
  for (const agent of [agents.iosSafari, agents.messengerIos, agents.zaloAndroid, agents.androidChrome]) {
    const html = render(agent);
    assert.doesNotMatch(html, /hint-ios|hint-actions|id="copy"|id="safari"|x-safari-|Sao chép liên kết|navigator\.clipboard/, agent.slice(0, 60));
  }
  assert.match(render(agents.zaloAndroid), /<div class="hint">Anh\/Chị đang mở trong Zalo\. Nếu nút trên không mở được Messenger/, 'Android trong Zalo: khối hướng dẫn cũ, ở cuối trang');
  assert.match(render(agents.iosSafari), /class="ios-tip"/);
});

test('địa chỉ trang không phải https hoặc thiếu: không có nút (máy chủ chạy thử http://localhost), hướng dẫn vẫn hiện; địa chỉ được escape', () => {
  for (const url of ['', 'http://localhost:8080/q/tmdt-01?from=inapp', 'javascript:alert(1)', 'https://a.example/q/x"><script>']) {
    const html = render(agents.zaloIos18, { pageUrl: url });
    assert.match(html, /class="hint hint-ios"/);
    assert.doesNotMatch(html, /class="hint-actions"|id="copy"|x-safari-|<script>alert|"><script>/, url);
  }
  const escaped = render(agents.zaloIos18, { pageUrl: 'https://crm.example.com/q/tmdt-01?from=inapp&x=1' });
  assert.match(escaped, /href="x-safari-https:\/\/crm\.example\.com\/q\/tmdt-01\?from=inapp&amp;x=1"/);
  assert.equal(safariEscapeLink(pageUrl, { classification: classifyUserAgent(agents.zaloIos18), iosVersion: 18 }), `x-safari-${pageUrl}`);
  assert.equal(safariEscapeLink(pageUrl, { classification: classifyUserAgent(agents.zaloIos18), iosVersion: 16 }), '');
  assert.equal(safariEscapeLink(pageUrl, { classification: classifyUserAgent(agents.iosSafari), iosVersion: 17 }), '');
  assert.equal(safariEscapeLink(pageUrl, { classification: classifyUserAgent(agents.zaloAndroid), iosVersion: 0 }), '');
  assert.equal(safariEscapeLink(pageUrl, { classification: classifyUserAgent(agents.facebookIos), iosVersion: 17 }), '');
});
