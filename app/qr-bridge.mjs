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
  'app khac': 'Nếu nút trên không mở được Messenger, hãy mở trang này bằng Safari hoặc Chrome, hoặc gọi Heartline bên dưới.',
  webview: 'Nếu nút trên không mở được Messenger, hãy mở trang này bằng Safari hoặc Chrome, hoặc gọi Heartline bên dưới.'
};

/**
 * Trang HTML tối thiểu: một nút "Mở Messenger" là thẻ <a> trỏ thẳng m.me?ref
 * (lượt bấm thật của khách kích hoạt Universal Link / App Link), hướng dẫn
 * riêng khi đang ở trong app, và đường lùi về trang Facebook của Page.
 * Không có tài nguyên ngoài, không tự chuyển hướng, không cookie.
 */
// Heartline in trên thẻ bảo hành: đường lùi cho khách không mở được Messenger.
export const heartline = { display: '0899 677 899', tel: '0899677899' };

// Biểu tượng nội tuyến (không tải ngoài). Nét 2px, màu theo currentColor.
const icons = {
  // Logo Messenger chính thức (tệp webp 256px), phục vụ qua đường công khai /q/brand/.
  messenger: `<img src="/q/brand/messenger.webp" alt="" width="30" height="30">`,
  // Logo Zalo chính thức (tệp webp), phục vụ qua đường công khai /q/brand/ như logo thương hiệu.
  zalo: `<img src="/q/brand/zalo.webp" alt="" width="30" height="30">`,
  chevron: `<svg class="chev" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6"/></svg>`,
  phone: `<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1 1 .4 1.9.7 2.8a2 2 0 0 1-.5 2.1L8.1 9.9a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.9.6 2.8.7a2 2 0 0 1 1.7 2z"/></svg>`
};

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
  // Zalo là kênh ngang hàng với Messenger (khách không có Messenger, hoặc quét
  // bằng Zalo thì không phải rời app). Chưa đặt liên kết OA ở Cài đặt thì dùng
  // Zalo cá nhân của Heartline (zalo.me/<số điện thoại>).
  const zaloHref = escapeHtml(zaloUrl || `https://zalo.me/${heartline.tel}`);
  // Messenger là kênh chính (CRM đo được lượt vào qua ref); Zalo là đường phụ cho khách không dùng Messenger.
  const zalo = `<a class="alt" id="zalo" href="${zaloHref}" rel="noopener" aria-label="Lưu ưu đãi qua Zalo">${icons.zalo}<span>Không dùng Messenger?</span><b>Lưu qua Zalo</b></a>`;
  const facebook = fallbackUrl ? ` hoặc nhắn qua trang Facebook <a href="${escapeHtml(fallbackUrl)}">${name}</a>` : '';
  return `<!doctype html>
<html lang="vi">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex, nofollow">
<meta name="theme-color" content="#efe6d2">
<title>${name} | Cảm ơn quý khách</title>
<link rel="icon" type="image/webp" href="/q/brand/logo.webp">
<style>
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100vh; min-height: 100dvh; display: flex; align-items: center; justify-content: center; padding: 18px 14px calc(18px + env(safe-area-inset-bottom)); background: #efe6d2; color: #3a2e22; font: 16px/1.5 -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif; -webkit-text-size-adjust: 100%; }
  main { width: 100%; max-width: 400px; padding: clamp(20px, 6vw, 28px) clamp(16px, 5.5vw, 26px) 22px; background: #fff; border: 1px solid #e3d8bf; border-radius: 20px; box-shadow: 0 1px 2px rgba(58,46,34,.04), 0 8px 24px rgba(58,46,34,.06); text-align: center; }
  .wordmark { white-space: nowrap; font-weight: 700; }
  .w-giot { color: #7cc254; }
  .w-nang { color: #f9b122; }
  .logo { display: block; width: clamp(128px, 40vw, 150px); height: auto; margin: 0 auto 14px; }
  .letter { margin: 0 0 16px; padding: 16px 16px 12px; background: #fffdf8; border: 1px solid #efe4cc; border-radius: 14px; text-align: left; }
  .greet { margin: 0 0 6px; color: #3a2e22; font-family: "Times New Roman", Times, "Noto Serif", "Tinos", serif; font-style: italic; font-weight: 400; font-size: 21px; line-height: 1.25; }
  .letter-body { margin: 0 0 10px; color: #4a3f33; font-size: 15.5px; line-height: 1.5; }
  .offers { display: grid; gap: 8px; margin: 0 0 10px; padding: 0; list-style: none; }
  .offers li { display: flex; align-items: center; gap: 12px; color: #3a2e22; font-size: 15px; line-height: 1.4; }
  .offers li b { color: #2e6b3f; font-weight: 700; }
  .thumb { flex: 0 0 56px; display: grid; place-items: center; width: 56px; height: 56px; overflow: hidden; background: #f6f1e4; border-radius: 12px; }
  .thumb img { max-width: 52px; max-height: 50px; width: auto; height: auto; display: block; }
  .thumb-bare { background: transparent; }
  .thumb-bare img { max-width: 44px; max-height: 44px; }
  .sign { display: flex; align-items: center; justify-content: flex-end; gap: 12px; margin: 0; color: #6b5d4b; font-size: 14px; line-height: 1.35; text-align: right; }
  .sign b { color: #3a2e22; font-family: "Times New Roman", Times, "Noto Serif", "Tinos", serif; font-style: italic; font-size: 17px; }
  .stamp { display: grid; place-items: center; width: 44px; height: 44px; border: 2px solid #c8372d; border-radius: 6px; color: #c8372d; font-family: "Times New Roman", Times, "Noto Serif", "Tinos", serif; font-weight: 700; font-size: 12px; line-height: 1.05; text-align: center; transform: rotate(-8deg); opacity: .9; }
  /* Phiếu ưu đãi kiểu voucher (mẫu "Lưu" của sàn TMĐT): nền kem, viền chấm, răng cưa hai bên. */
  .ticket { position: relative; margin: 0 0 14px; padding: 0 12px 12px; background: #fff6e6; border: 1.5px solid #f3d6a4; border-radius: 16px; }
  .ticket-head { position: relative; display: flex; align-items: baseline; justify-content: center; gap: 6px; flex-wrap: wrap; padding: 11px 0 11px; margin: 0 0 12px; }
  .ticket-head::after { content: ""; position: absolute; left: 4px; right: 4px; bottom: 0; border-bottom: 2px dashed #e8b765; }
  .ticket::before, .ticket::after { content: ""; position: absolute; top: var(--notch, 32px); width: 18px; height: 18px; background: #fff; border: 1.5px solid #f3d6a4; border-radius: 50%; }
  .ticket::before { left: -10px; clip-path: inset(0 0 0 50%); }
  .ticket::after { right: -10px; clip-path: inset(0 50% 0 0); }
  .ticket-tag { color: #c2410c; font-size: 13px; font-weight: 800; letter-spacing: .08em; text-transform: uppercase; }
  .ticket-sub { color: #7a5a2e; font-size: 14px; }
  /* Nút tô màu thương hiệu từng kênh: cao 56px, rộng hết, logo trong ô trắng bên trái, mũi tên bên phải. */
  .channels { display: grid; gap: 10px; }
  .btn { position: relative; display: flex; align-items: center; gap: 12px; width: 100%; min-height: 60px; padding: 8px 12px 8px 8px; color: #fff; border-radius: 14px; text-decoration: none; -webkit-tap-highlight-color: transparent; transition: transform .12s ease, box-shadow .12s ease; }
  #open { background: linear-gradient(110deg, #0a84ff 0%, #7b3dff 58%, #ff4f81 100%); box-shadow: 0 6px 16px -4px rgba(123,61,255,.5); }
  .label small { display: block; margin-top: 1px; font-size: 13px; font-weight: 600; opacity: .9; letter-spacing: 0; }
  .alt { display: flex; flex-wrap: wrap; align-items: center; justify-content: center; gap: 4px 6px; padding: 4px 4px 0; color: #6b5d4b; font-size: 14px; text-decoration: none; -webkit-tap-highlight-color: transparent; }
  .alt span, .alt b { white-space: nowrap; }
  .alt img { width: 22px; height: 22px; display: block; }
  .alt b { color: #0068ff; font-weight: 800; }
  .alt:active b { text-decoration: underline; }
  .btn:active { transform: scale(.98); box-shadow: 0 2px 6px -2px rgba(0,0,0,.3); }
  .badge { flex: 0 0 40px; display: grid; place-items: center; width: 40px; height: 40px; background: #fff; border-radius: 11px; }
  .badge img { width: 30px; height: 30px; display: block; }
  .label { flex: 1; min-width: 0; text-align: left; font-size: 18px; font-weight: 800; letter-spacing: -.005em; line-height: 1.2; }
  .chev { flex: 0 0 22px; width: 22px; height: 22px; opacity: .9; animation: nudge 1.8s ease-in-out infinite; }
  @keyframes nudge { 0%, 70%, 100% { transform: translateX(0); } 80% { transform: translateX(4px); } 90% { transform: translateX(0); } }
  @media (prefers-reduced-motion: reduce) { .chev { animation: none; } .btn { transition: none; } }
  /* Máy hẹp (320px): nới lề ngoài, chữ lợi ích 14px để mỗi dòng nằm trên một hàng. */
  /* Máy 360-400px: lá thư nằm trong thẻ nên lề bị cộng hai lần; thu lề để mỗi dòng dấu tích nằm trên một hàng. */
  @media (max-width: 400px) { main { padding-left: 14px; padding-right: 14px; } .letter { padding-left: 12px; padding-right: 12px; } .offers li { font-size: 14.5px; gap: 10px; } }
  @media (max-width: 340px) { .letter { padding: 12px 9px 8px; } .letter-body { font-size: 14.5px; } body { padding-left: 10px; padding-right: 10px; } main { padding-left: 14px; padding-right: 14px; } .label { font-size: 17px; } .alt { font-size: 13px; } .offers li { font-size: 14px; gap: 9px; } .thumb { flex-basis: 48px; width: 48px; height: 48px; } .thumb img { max-width: 44px; max-height: 42px; } .fallback { font-size: 13px; } }
  /* Máy màn thấp (iPhone SE 568px, Android nhỏ): thu khoảng cách để hai nút và Heartline nằm trong một màn, không phải cuộn. */
  @media (max-height: 680px) {
    body { padding-top: 10px; padding-bottom: calc(10px + env(safe-area-inset-bottom)); }
    main { padding-top: 16px; padding-bottom: 14px; }
    .logo { width: 112px; margin-bottom: 8px; }
    .letter { margin-bottom: 12px; padding-top: 12px; padding-bottom: 8px; }
    .offers { gap: 6px; margin-bottom: 6px; }
    .thumb { flex-basis: 48px; width: 48px; height: 48px; }
    .thumb img { max-width: 44px; max-height: 42px; }
    .stamp { width: 38px; height: 38px; }
    .ticket-head { padding: 8px 0 7px; margin-bottom: 10px; }
    .btn { min-height: 54px; }
    .channels { gap: 8px; }
    .fallback { padding-top: 10px; }
  }
  .hint { margin: 4px 0 14px; padding: 10px 12px; background: #f6ecd0; border: 1px solid #e2cf9c; border-radius: 6px; color: #5b4a12; font-size: 14.5px; line-height: 1.45; text-align: left; }
  .fallback { margin: 4px 0 0; padding-top: 14px; border-top: 1px dashed #d9cba9; color: #6b5d4b; font-size: 14px; line-height: 1.5; }
  .fallback a { color: #2e6b3f; font-size: 13.5px; font-weight: 700; text-decoration: none; }
  .fallback .tel svg { width: .9em; height: .9em; vertical-align: -.08em; margin-right: 3px; stroke-width: 2.4; }
  .fallback .tel { color: #d0312d; white-space: nowrap; }
</style>
</head>
<body>
<main>
  <img class="logo" src="/q/brand/logo.webp" alt="${name}" width="150" height="83">
  <div class="letter">
    <h1 class="greet">Thân gửi anh chị,</h1>
    <p class="letter-body">Cảm ơn anh chị đã tin tưởng và ủng hộ <span class="wordmark"><span class="w-giot">Giọt</span> <span class="w-nang">Nắng</span></span>. Em gửi anh chị ưu đãi:</p>
    <ul class="offers">
      <li><span class="thumb thumb-bare"><img src="/q/brand/offer-free-ship.webp" alt="Xe giao hàng" width="52" height="52"></span><span><b>Miễn phí vận chuyển</b> cho toàn bộ đơn hàng tiếp theo</span></li>
      <li><span class="thumb"><img src="/q/brand/offer-combo3-mini.webp" alt="Ba túi granola Xanh, Vàng, Nâu" width="66" height="48"></span><span>Mua Combo&nbsp;1 tặng <b>Combo&nbsp;3&nbsp;mini</b> Xanh + Vàng + Nâu</span></li>
      <li><span class="thumb"><img src="/q/brand/offer-yen-mach.webp" alt="Hai túi Yến mạch 500g" width="54" height="48"></span><span>Mua Combo&nbsp;2 tặng <b>2&nbsp;túi Yến&nbsp;mạch</b></span></li>
      <li><span class="thumb"><img src="/q/brand/offer-tam-lanh.webp" alt="Hộp Bột Ngũ Cốc Tâm Lành" width="37" height="48"></span><span>Đặc biệt mua Combo&nbsp;3 tặng <b>1&nbsp;hộp Bột Ngũ Cốc Tâm&nbsp;Lành</b></span></li>
    </ul>
    <p class="sign"><span>Thương mến,<br><b>Nhà Nắng</b></span><span class="stamp" aria-hidden="true">Nhà<br>Nắng</span></p>
  </div>
  <section class="ticket" aria-label="Phiếu ưu đãi">
    <div class="ticket-head"><span class="ticket-tag">Phiếu ưu đãi</span><span class="ticket-sub">cho lần mua hàng tiếp theo</span></div>
    <div class="channels">
      <a class="btn" id="open" href="${href}" rel="noopener" aria-label="Lưu ưu đãi qua Messenger"><span class="badge">${icons.messenger}</span><span class="label">Lưu ưu đãi<small>qua Messenger</small></span>${icons.chevron}</a>
      ${zalo}
    </div>
  </section>
  ${hint ? `<div class="hint">${hint}</div>` : ''}
  <p class="fallback">Không mở được? Gọi Heartline <a class="tel" href="tel:${heartline.tel}">${icons.phone}${heartline.display}</a>${facebook}.</p>
</main>
<script>
(function () {
  var open = document.getElementById('open');
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
  // Răng cưa của phiếu nằm đúng trên đường chấm, kể cả khi dòng tiêu đề phiếu xuống hàng trên máy hẹp.
  var ticket = document.querySelector('.ticket');
  var head = ticket && ticket.querySelector('.ticket-head');
  function notch() { if (head) ticket.style.setProperty('--notch', (head.offsetHeight - 10) + 'px'); }
  notch();
  addEventListener('resize', notch);
})();
</script>
</body>
</html>
`;
}
