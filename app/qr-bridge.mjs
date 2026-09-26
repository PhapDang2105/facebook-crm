// Trang đệm cho mã QR trên thẻ cảm ơn: /q/<mã> → Messenger.
//
// Vì sao không chuyển hướng 302 thẳng sang m.me cho mọi máy:
//  - iPhone: Safari KHÔNG tự mở app Messenger khi tới m.me qua chuyển hướng,
//    chỉ hiện thanh "Mở trong app" rồi tải trang web m.me — trang đó nay bắt
//    đăng nhập Facebook vì Meta đã đóng messenger.com (04/2026). Universal Link
//    chỉ chắc chắn kích hoạt khi CHÍNH KHÁCH bấm vào liên kết.
//  - Trình duyệt trong app Zalo, Facebook, Instagram, TikTok, app ngân hàng:
//    tự tải trang, không bàn giao cho hệ thống; cần hướng dẫn "mở bằng trình
//    duyệt" và một nút để bấm lại.
//  - Chrome trên Android: coi 302 ngay sau lượt bấm là thao tác của người dùng
//    và mở app được — nhánh duy nhất còn chuyển hướng thẳng.
// Trang trả về nhẹ, không tải tài nguyên ngoài (mọi thứ dưới /assets nằm sau
// mật khẩu của Caddy, còn /q/* thì đi thẳng), không chuyển hướng tự động.

const escapeHtml = value => String(value ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/**
 * Nhận diện máy và trình duyệt từ User-Agent. Chỉ giữ những gì quyết định cách
 * phục vụ và đáng đếm (iPhone hay Android, Zalo hay Chrome); không lưu chuỗi UA.
 */
export function classifyUserAgent(userAgent = '') {
  const ua = String(userAgent || '');
  const platform = /iphone|ipad|ipod/i.test(ua) ? 'ios'
    : /android/i.test(ua) ? 'android'
      : /windows|macintosh|linux|cros/i.test(ua) ? 'may tinh' : 'khac';

  // Trình duyệt trong app xét trước: UA của chúng vẫn mang "Chrome/" hay
  // "Safari/" nên xét sau là nhận nhầm thành trình duyệt hệ thống.
  let browser = 'khac';
  let inApp = false;
  if (/\bZalo\b|ZaloTheme|ZaloLanguage/i.test(ua)) { browser = 'zalo'; inApp = true; }
  else if (/Orca-Android|MessengerForiOS|MessengerLiteForiOS/i.test(ua)) { browser = 'messenger'; inApp = true; }
  else if (/FBAN|FB_IAB|FBAV|FBIOS/i.test(ua)) { browser = 'facebook'; inApp = true; }
  else if (/Instagram/i.test(ua)) { browser = 'instagram'; inApp = true; }
  else if (/musical_ly|Bytedance|TikTok/i.test(ua)) { browser = 'tiktok'; inApp = true; }
  else if (/MicroMessenger|\bLine\/|Telegram/i.test(ua)) { browser = 'app khac'; inApp = true; }
  else if (platform === 'android' && /;\s*wv\)|\bwv\b/.test(ua)) { browser = 'webview'; inApp = true; }
  else if (platform === 'ios' && /AppleWebKit/i.test(ua) && !/Safari\//i.test(ua)) { browser = 'webview'; inApp = true; }
  else if (/CriOS\//.test(ua)) browser = 'chrome';
  else if (/FxiOS\//.test(ua)) browser = 'firefox';
  else if (/EdgiOS\/|Edg\//.test(ua)) browser = 'edge';
  else if (/SamsungBrowser\//.test(ua)) browser = 'samsung';
  else if (/OPR\/|Opera/.test(ua)) browser = 'opera';
  else if (/Firefox\//.test(ua)) browser = 'firefox';
  else if (/Chrome\/\d+/.test(ua)) browser = 'chrome';
  else if (/Safari\//.test(ua) && /AppleWebKit/i.test(ua)) browser = 'safari';

  return { platform, browser, inApp };
}

/** Chỉ Chrome hệ thống trên Android mở được app Messenger sau một chuyển hướng 302. */
export function shouldRedirectDirectly(classification) {
  return classification?.platform === 'android' && classification?.browser === 'chrome' && !classification?.inApp;
}

const inAppHints = {
  zalo: 'Bạn đang mở trong Zalo. Nếu nút trên không mở được Messenger, bấm biểu tượng ⋯ ở góc trên, chọn <b>Mở bằng trình duyệt</b>, rồi bấm lại nút.',
  facebook: 'Bạn đang mở trong ứng dụng Facebook. Nếu nút trên không mở được Messenger, bấm biểu tượng ⋯ ở góc trên, chọn <b>Mở trong trình duyệt</b>, rồi bấm lại nút.',
  instagram: 'Bạn đang mở trong Instagram. Nếu nút trên không mở được Messenger, bấm biểu tượng ⋯ ở góc trên, chọn <b>Mở trong trình duyệt</b>, rồi bấm lại nút.',
  tiktok: 'Bạn đang mở trong TikTok. Nếu nút trên không mở được Messenger, bấm biểu tượng ⋯ ở góc trên, chọn <b>Mở trong trình duyệt</b>, rồi bấm lại nút.',
  messenger: '',
  'app khac': 'Nếu nút trên không mở được Messenger, hãy sao chép liên kết rồi mở bằng Safari hoặc Chrome.',
  webview: 'Nếu nút trên không mở được Messenger, hãy sao chép liên kết rồi mở bằng Safari hoặc Chrome.'
};

/**
 * Trang HTML tối thiểu: một nút "Mở Messenger" là thẻ <a> trỏ thẳng m.me?ref
 * (lượt bấm thật của khách kích hoạt Universal Link / App Link), hướng dẫn
 * riêng khi đang ở trong app, và đường lùi về trang Facebook của Page.
 * Không có tài nguyên ngoài, không tự chuyển hướng, không cookie.
 */
export function renderBridgePage({ code, destination, pageName, fallbackUrl = '', classification = {} }) {
  const name = escapeHtml(pageName || 'Giọt Nắng');
  const href = escapeHtml(destination);
  const safeCode = escapeHtml(code);
  const hint = classification.inApp ? (inAppHints[classification.browser] ?? inAppHints.webview) : '';
  const fallback = fallbackUrl
    ? `<p class="fallback">Không mở được? Vào trang Facebook <a href="${escapeHtml(fallbackUrl)}">${name}</a> và nhắn tin cho chúng tôi.</p>`
    : '';
  return `<!doctype html>
<html lang="vi">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${name} · Mở Messenger</title>
<style>
  :root { color-scheme: light; }
  body { margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 24px 16px; box-sizing: border-box; background: #f3faf6; color: #1f2329; font: 17px/1.55 -apple-system, "Segoe UI", Roboto, Arial, sans-serif; }
  main { width: 100%; max-width: 420px; padding: 32px 24px 28px; background: #fff; border-radius: 16px; box-shadow: 0 2px 12px rgba(31,122,69,.10); text-align: center; }
  .brand { margin: 0 0 18px; color: #1f7a45; font-weight: 800; font-size: 15px; letter-spacing: .08em; text-transform: uppercase; }
  h1 { margin: 0 0 10px; font-size: 24px; line-height: 1.25; }
  p { margin: 0 0 18px; color: #4b5057; }
  .btn { display: block; padding: 16px 20px; margin: 4px 0 18px; background: #1f7a45; color: #fff; font-size: 19px; font-weight: 700; text-decoration: none; border-radius: 999px; }
  .btn:active { background: #17603a; }
  .hint { margin: 0 0 16px; padding: 12px 14px; background: #fff7e0; border-radius: 10px; color: #5b4a12; font-size: 15px; text-align: left; }
  .copy { display: inline-block; margin: 0 0 14px; padding: 8px 14px; background: none; border: 1px solid #c9d3cd; border-radius: 999px; color: #1f7a45; font: inherit; font-size: 15px; }
  .fallback { margin: 0; font-size: 14px; color: #65676b; }
  .fallback a, .code { color: #1f7a45; }
  .code { display: block; margin-top: 16px; font-size: 12px; color: #9aa0a6; }
</style>
</head>
<body>
<main>
  <p class="brand">${name}</p>
  <h1>Cảm ơn bạn đã mua hàng 💛</h1>
  <p>Bấm nút bên dưới để mở Messenger và nhận hướng dẫn sử dụng cùng quà cảm ơn từ ${name}.</p>
  <a class="btn" id="open" href="${href}" rel="noopener">Mở Messenger</a>
  ${hint ? `<div class="hint">${hint}</div>` : ''}
  <button class="copy" type="button" id="copy" hidden>Sao chép liên kết</button>
  ${fallback}
  <span class="code">Mã thẻ: ${safeCode}</span>
</main>
<script>
(function () {
  var open = document.getElementById('open');
  var copy = document.getElementById('copy');
  var beacon = '/q/${safeCode}/open';
  open.addEventListener('click', function () {
    try { navigator.sendBeacon(beacon); } catch (e) {}
  });
  if (navigator.clipboard && navigator.clipboard.writeText) {
    copy.hidden = false;
    copy.addEventListener('click', function () {
      navigator.clipboard.writeText(open.href).then(function () { copy.textContent = 'Đã sao chép'; }, function () {});
    });
  }
})();
</script>
</body>
</html>
`;
}
