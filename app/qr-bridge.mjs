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

/**
 * Máy xem trước liên kết và máy quét tự động: khi khách dán link /q/… vào
 * Zalo, Messenger, Telegram… thì máy của họ tải trang để dựng thẻ xem trước —
 * không phải lượt quét. UA rỗng cũng là máy (curl, script), điện thoại nào cũng
 * gửi UA. Vẫn phục vụ trang bình thường, chỉ không đếm.
 */
export function isLinkPreviewBot(userAgent = '') {
  const ua = String(userAgent || '').trim();
  if (!ua) return true;
  return /\bbot\b|bot\/|crawler|spider|preview|facebookexternalhit|facebookcatalog|Facebot|WhatsApp|TelegramBot|Twitterbot|Slackbot|Discordbot|LinkedInBot|Zalo(?:PC)?Bot|ZaloCrawler|curl\/|wget\/|python-requests|python-urllib|Go-http-client|okhttp\/|HeadlessChrome|Lighthouse|PhantomJS/i.test(ua);
}

const codePattern = /^[a-z0-9][a-z0-9-]{0,39}$/;

/**
 * Tham số `ref` theo đúng cách Pancake tạo "đường dẫn với nguồn truy cập"
 * (Cài đặt → Công cụ): base64url của `pancake_utm_source=<mã>`. Nhờ vậy Pancake
 * tự ghi nguồn truy cập cho hội thoại, còn CRM nhận ra mã theo cả hai chiều.
 */
export function pancakeRef(code) {
  return Buffer.from(`pancake_utm_source=${code}`).toString('base64url');
}

/** Mã lô từ tham số ref: dạng thô (`tmdt-01`) hoặc dạng Pancake mã hoá; không phải hai dạng đó thì rỗng. */
export function qrCodeFromRef(ref) {
  const raw = String(ref || '').trim();
  if (!raw) return '';
  if (codePattern.test(raw)) return raw;
  try {
    const decoded = Buffer.from(raw, 'base64url').toString('utf8');
    const match = decoded.match(/^pancake_utm_source=([a-z0-9][a-z0-9-]{0,39})$/);
    return match ? match[1] : '';
  } catch {
    return '';
  }
}

/**
 * Mã lô ghi trong tin soạn sẵn mà khách gửi: `#tmdt-01`. Đây là cách CRM nhận
 * ra khách quét thẻ khi Page vận hành ở Pancake — Pancake không chuyển `ref`
 * về webhook, nhưng tin khách gửi thì có, và tin soạn sẵn mang mã ở cuối.
 */
export function qrCodeFromText(text, { outgoing = false } = {}) {
  // Mã chỉ được nhận khi đứng CUỐI tin (tin soạn sẵn kết bằng "#mã"; Botcake kết bằng "Mã thẻ: #mã").
  // "đơn #123456 của em đâu", "giá #1 thị trường" không phải mã thẻ.
  const pattern = outgoing ? /Mã thẻ:\s*#([a-z0-9][a-z0-9-]{0,39})\s*$/iu : /(?:^|\s)#([a-z0-9][a-z0-9-]{0,39})\s*$/iu;
  const match = String(text || '').trim().match(pattern);
  return match ? match[1].toLowerCase() : '';
}

export const samplePrefillText = 'Mình vừa quét thẻ cảm ơn {page}, cho mình nhận hướng dẫn và quà nhé 💛 #{code}';

/** Tin soạn sẵn cho một mã: điền {page}/{code}; thiếu `#mã` thì tự nối vào cuối để CRM còn nhận ra. Mẫu rỗng → không có tin. */
export function prefillMessageFor({ code, pageName = '', template = '' }) {
  const source = String(template || '').trim();
  if (!source) return '';
  let text = source.replace(/\{page\}/g, pageName || 'shop').replace(/\{code\}/g, code).replace(/\s+/g, ' ').trim();
  if (qrCodeFromText(text) !== code) text = `${text} #${code}`.trim();
  return text.slice(0, 140);
}

/**
 * Đích Messenger của một mã: m.me của Page với `ref` = chính mã lô. Botcake
 * (bot của Pancake, Công cụ → Messenger Ref URL, Custom Ref Parameter = mã) nhận
 * referral này qua app Meta của Pancake và tự gửi tin ưu đãi ngay khi khách mở
 * hội thoại — không cần khách gõ gì; app Meta của CRM (nếu Page nối) cũng nhận
 * được cùng ref. Tin soạn sẵn (`text`) chỉ thêm khi chủ shop đặt ở Cài đặt →
 * Mã QR: đường dự phòng để CRM nhận ra khách khi không có bot nào chào.
 */
export function messengerDestination({ pageId, code, pageName = '', prefillText = '' }) {
  const text = prefillMessageFor({ code, pageName, template: prefillText });
  return `https://m.me/${encodeURIComponent(pageId)}?ref=${encodeURIComponent(code)}${text ? `&text=${encodeURIComponent(text)}` : ''}`;
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
// Heartline in trên thẻ bảo hành: đường lùi cho khách không mở được Messenger.
export const heartline = { display: '0899 677 899', tel: '0899677899' };

// Mặt trời cười của logo, vẽ tay bằng SVG nội tuyến: trang không được tải ảnh
// ngoài (mọi thứ dưới /assets nằm sau mật khẩu, và trang phải nhẹ).
const sunMark = `<svg class="sun" viewBox="0 0 96 96" aria-hidden="true">
  <g stroke="#f2b134" stroke-width="5" stroke-linecap="round"><path d="M48 6v10M48 80v10M6 48h10M80 48h10M18 18l7 7M71 71l7 7M18 78l7-7M71 25l7-7"/></g>
  <circle cx="48" cy="48" r="22" fill="#f8c74d"/>
  <circle cx="40" cy="45" r="2.6" fill="#7a4b1c"/><circle cx="56" cy="45" r="2.6" fill="#7a4b1c"/>
  <path d="M39 53q9 8 18 0" fill="none" stroke="#7a4b1c" stroke-width="3" stroke-linecap="round"/>
</svg>`;

/**
 * Trang khách thấy sau khi quét thẻ cảm ơn (iPhone, Zalo, trình duyệt trong
 * app, máy tính; Android Chrome được chuyển thẳng). Một việc duy nhất: bấm nút
 * mở Messenger. Nút là thẻ <a> trỏ thẳng m.me?ref (lượt bấm thật của khách mới
 * kích hoạt Universal Link / App Link), có hướng dẫn riêng khi đang ở trong app,
 * và đường lùi là Heartline + trang Facebook của Page. Không tài nguyên ngoài,
 * không tự chuyển hướng, không cookie. Giọng thẻ bảo hành: "chúng em" / "anh chị".
 */
export function renderBridgePage({ code, destination, pageName, fallbackUrl = '', zaloUrl = '', classification = {} }) {
  const name = escapeHtml(pageName || 'Giọt Nắng');
  const href = escapeHtml(destination);
  const safeCode = escapeHtml(code);
  const hint = classification.inApp ? (inAppHints[classification.browser] ?? inAppHints.webview) : '';
  // Khách quét bằng Zalo hay quen Zalo thì có đường đi thẳng, không phải rời app.
  const zalo = zaloUrl
    ? `<a class="btn btn-zalo" id="zalo" href="${escapeHtml(zaloUrl)}" rel="noopener">Nhắn qua Zalo</a>`
    : '';
  const facebook = fallbackUrl ? ` hoặc nhắn qua trang Facebook <a href="${escapeHtml(fallbackUrl)}">${name}</a>` : '';
  return `<!doctype html>
<html lang="vi">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex, nofollow">
<meta name="theme-color" content="#fbf5e6">
<title>${name} · Cảm ơn anh chị</title>
<style>
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100vh; min-height: 100dvh; display: flex; align-items: center; justify-content: center; padding: 20px 16px calc(20px + env(safe-area-inset-bottom)); background: #fbf5e6; background-image: radial-gradient(circle at 50% -10%, #fde9b0 0, rgba(253,233,176,0) 55%); color: #3d3226; font: 17px/1.5 -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif; -webkit-text-size-adjust: 100%; }
  main { width: 100%; max-width: 400px; text-align: center; }
  .sun { width: 84px; height: 84px; display: block; margin: 0 auto 6px; }
  .brand { margin: 0 0 22px; color: #7a4b1c; font-size: 15px; font-weight: 700; letter-spacing: .12em; text-transform: uppercase; }
  h1 { margin: 0 0 10px; color: #3d3226; font-size: 27px; line-height: 1.2; letter-spacing: -.01em; }
  .lead { margin: 0 auto 24px; max-width: 320px; color: #5f5344; }
  .gift { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 8px; margin: 0 0 22px; padding: 0; list-style: none; }
  .gift li { padding: 12px 6px; background: #fff; border: 1px solid #efe4c9; border-radius: 14px; color: #3d3226; font-size: 14px; line-height: 1.3; }
  .gift b { display: block; margin-bottom: 4px; color: #2f8f4e; font-size: 20px; font-weight: 700; }
  .btn { display: block; width: 100%; padding: 17px 20px; margin: 0 0 12px; background: #2f8f4e; color: #fff; font-size: 19px; font-weight: 700; text-decoration: none; border-radius: 16px; box-shadow: 0 6px 18px rgba(47,143,78,.25); }
  .btn:active { background: #257540; transform: translateY(1px); }
  .btn-zalo { background: #fff; color: #0068ff; border: 1.5px solid #cfe0ff; box-shadow: none; }
  .btn-zalo:active { background: #eef4ff; }
  .hint { margin: 4px 0 14px; padding: 12px 14px; background: #fff7dc; border: 1px solid #f3e2a3; border-radius: 12px; color: #5b4a12; font-size: 15px; line-height: 1.45; text-align: left; }
  .copy { display: inline-block; margin: 2px 0 16px; padding: 8px 14px; background: none; border: 1px solid #d9cfb6; border-radius: 999px; color: #7a4b1c; font: inherit; font-size: 15px; }
  .fallback { margin: 6px 0 0; padding-top: 16px; border-top: 1px solid #efe4c9; color: #6f6353; font-size: 14px; line-height: 1.5; }
  .fallback a { color: #2f8f4e; font-weight: 600; text-decoration: none; }
  .tel { white-space: nowrap; }
  .foot { margin: 18px 0 0; color: #9a8d78; font-size: 13px; }
  .code { display: block; margin-top: 4px; font-size: 12px; color: #b5a98f; }
</style>
</head>
<body>
<main>
  ${sunMark}
  <p class="brand">${name}</p>
  <h1>Cảm ơn anh chị đã chọn Giọt Nắng</h1>
  <p class="lead">Nhắn cho chúng em một tin qua Messenger, chúng em gửi ngay:</p>
  <ul class="gift">
    <li><b>1</b>Hướng dẫn dùng ngon nhất</li>
    <li><b>2</b>Quà cảm ơn từ Ngôi nhà của Nắng</li>
    <li><b>3</b>Đổi ngay nếu hạt mềm, thiếu hàng</li>
  </ul>
  <a class="btn" id="open" href="${href}" rel="noopener">Nhận quà qua Messenger</a>
  ${zalo}
  ${hint ? `<div class="hint">${hint}</div>` : ''}
  <button class="copy" type="button" id="copy" hidden>Sao chép liên kết</button>
  <p class="fallback">Không mở được? Gọi Heartline <a class="tel" href="tel:${heartline.tel}">${heartline.display}</a>${facebook}.</p>
  <p class="foot">ăn sạch · sống lành cùng Giọt Nắng<span class="code">Mã thẻ: ${safeCode}</span></p>
</main>
<script>
(function () {
  var open = document.getElementById('open');
  var copy = document.getElementById('copy');
  var beacon = '/q/${safeCode}/open';
  // Đếm ngay khi ngón tay chạm nút (pointerdown/touchstart), không đợi click:
  // trên iPhone, bấm liên kết mở app là Safari nhảy sang Messenger trước khi
  // sự kiện click kịp chạy, nên đếm ở click là mất lượt.
  function send(to) {
    var url = beacon + '?to=' + to;
    try { if (navigator.sendBeacon && navigator.sendBeacon(url)) return; } catch (e) {}
    try { fetch(url, { method: 'POST', keepalive: true }); } catch (e) {}
  }
  function arm(element, to) {
    if (!element) return;
    var sent = false;
    var fire = function () { if (sent) return; sent = true; send(to); };
    element.addEventListener('pointerdown', fire);
    element.addEventListener('touchstart', fire, { passive: true });
    element.addEventListener('click', fire);
  }
  arm(open, 'messenger');
  arm(document.getElementById('zalo'), 'zalo');
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
