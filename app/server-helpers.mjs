// Hàm thuần của app/server.mjs (server.mjs khởi động máy chủ ngay khi nạp nên không test thẳng được):
// lọc nhật ký, câu lỗi thân thiện cho chủ shop, cache tệp tĩnh, trang báo lỗi công khai, quyết định
// nhận webhook Pancake, nhận diện máy nhân viên, dấu vân tay để bỏ ghi kho khi không đổi gì.
// Test: tests/fix-server-*.test.mjs.
import { createHash, randomBytes } from 'node:crypto';

// ===== Nhật ký hoạt động (/api/audit) =====

export const AUDIT_FILTER_KEYS = ['from', 'to', 'actor', 'action', 'q', 'conversationId', 'orderId', 'limit', 'before'];

/**
 * Bộ lọc /api/audit đã chuẩn hoá (cắt 200 ký tự, bỏ khoảng trắng hai đầu). Chốt quyền và queryAudit
 * dùng CÙNG giá trị này: trước 01/10 chốt nhận "%20" là "có lọc hội thoại" còn queryAudit trim ra
 * rỗng → nhân viên đọc được toàn bộ nhật ký (SEC-1).
 */
export function auditFiltersFrom(searchParams) {
  return Object.fromEntries(AUDIT_FILTER_KEYS.map(key => [key, String(searchParams?.get?.(key) || '').slice(0, 200).trim()]));
}

/** Quản trị xem toàn bộ; nhân viên chỉ khi lọc đúng MỘT hội thoại hay MỘT đơn (giá trị đã trim). */
export function canReadAudit(manager, filters) {
  return Boolean(manager) || Boolean(filters?.conversationId) || Boolean(filters?.orderId);
}

// ===== Câu lỗi cho chủ shop (chi tiết kỹ thuật chỉ vào nhật ký máy chủ) =====

const ASK_TECH = 'nhờ bộ phận kỹ thuật kiểm tra';

/** Lỗi đồng bộ / trạng thái quảng cáo Meta → câu tiếng Việt không có tên biến .env, đường dẫn tệp hay mã lỗi. */
export function friendlyAdsError(error) {
  const message = String(error?.message ?? error ?? '');
  const code = Number(error?.graphCode);
  if (/^Chưa kết nối quảng cáo/.test(message) || /META_ADS_ACCESS_TOKEN.*\.env|META_AD_ACCOUNT_IDS.*\.env/.test(message)) {
    return `Chưa kết nối tài khoản quảng cáo Facebook — ${ASK_TECH} kết nối quảng cáo.`;
  }
  if (code === 190 || code === 102 || /hết hạn|thu hồi/.test(message)) {
    return `Kết nối quảng cáo Facebook đã hết hạn — ${ASK_TECH} và cấp lại quyền đọc quảng cáo.`;
  }
  if ([4, 17, 32, 613, 80000, 80004].includes(code) || /giới hạn số lần gọi/.test(message)) {
    return 'Facebook đang giới hạn số lần lấy số liệu quảng cáo; thử đồng bộ lại sau ít phút.';
  }
  if (code === 10 || code === 294 || (code >= 200 && code < 300) || code === 100 || /ads_read|tài khoản quảng cáo/.test(message)) {
    return `CRM chưa có quyền đọc số liệu tài khoản quảng cáo — ${ASK_TECH} quyền của tài khoản quảng cáo.`;
  }
  if (/Không kết nối được tới Facebook/.test(message)) {
    return 'Không kết nối được tới Facebook lúc lấy số liệu quảng cáo; thử lại sau ít phút.';
  }
  return `Chưa đồng bộ được số liệu quảng cáo. Thử lại sau ít phút; nếu vẫn lỗi, ${ASK_TECH} nhật ký máy chủ.`;
}

/** Trạng thái quảng cáo của /api/campaigns: `ads.error` (lỗi lần đồng bộ cuối) đổi sang câu thân thiện. */
export function friendlyAdsStatus(ads) {
  if (!ads || typeof ads !== 'object' || !ads.error) return ads;
  return { ...ads, error: friendlyAdsError(ads.error) };
}

const AI_UNAVAILABLE_PATTERN = /^AI tạm thời không dùng được \([\s\S]*\), nên dưới đây/;

/**
 * Kết quả Cố vấn AI khi mô hình lỗi: summary từng mang nguyên văn lỗi ("ENOENT … vertex.json").
 * Bỏ chi tiết khỏi summary và bỏ trường `error`; phần gợi ý theo luật giữ nguyên.
 */
export function friendlyCampaignInsights(insights) {
  if (!insights || typeof insights !== 'object') return insights;
  const { error, ...rest } = insights;
  const summary = String(rest.summary || '');
  if (!error && !AI_UNAVAILABLE_PATTERN.test(summary)) return insights;
  return {
    ...rest,
    summary: summary.replace(AI_UNAVAILABLE_PATTERN, `AI tạm thời không dùng được (${ASK_TECH} kết nối AI), nên dưới đây`)
  };
}

/** Lỗi khi thử mô hình ở Cài đặt → Chatbot (thiếu tệp khoá, mạng…): câu chung, chi tiết vào log. */
export function friendlyAiTestError() {
  return `Chưa gọi được mô hình AI. Kiểm tra nhà cung cấp/khoá ở Cài đặt → Chatbot, hoặc ${ASK_TECH} nhật ký máy chủ.`;
}

// ===== Tệp tĩnh =====

/** Mốc phiên bản của tệp (index.html gắn vào app.js?v=… / styles.css?v=…). */
export const fileVersionStamp = mtimeMs => Math.trunc(Number(mtimeMs) || 0).toString(36);

/**
 * Cache-Control cho tệp tĩnh: .js/.css xin đúng phiên bản hiện tại (?v= trùng mốc sửa tệp, do
 * index.html tự gắn) thì cache hẳn một năm — mỗi lần deploy mốc đổi nên URL đổi. ?v= ghi tay (staff.js,
 * ảnh…) hay sai mốc thì vẫn no-cache (hỏi lại bằng ETag) như cũ; index.html luôn no-cache.
 */
export function staticCacheControl({ relative = '', version = '', stamp = '' } = {}) {
  if (version && stamp && version === stamp && /\.(?:js|css)$/.test(relative)) return 'private, max-age=31536000, immutable';
  return 'no-cache';
}

// ===== ETag cho API đọc nặng (/api/customer-orders, /api/customers) =====

/** ETag yếu theo nội dung trả về: đúng theo cấu tạo, không phụ thuộc kho nào đã đổi. */
export function contentEtag(body) {
  return `W/"${createHash('sha1').update(String(body)).digest('base64url')}"`;
}

/**
 * If-None-Match có khớp ETag không. Chịu được: danh sách nhiều thẻ, "*", W/ hay không, và hậu tố mã hoá
 * mà proxy nén (Caddy `encode`) có thể gắn vào ("…-gzip", "…-zstd", "…-br").
 */
export function etagMatches(header, etag) {
  if (!header || !etag) return false;
  const core = tag => String(tag).trim().replace(/^W\//, '').replace(/^"|"$/g, '').replace(/-(?:gzip|zstd|br|deflate)$/, '');
  const wanted = core(etag);
  return String(header).split(',').some(tag => tag.trim() === '*' || core(tag) === wanted);
}

// ===== Trang công khai (khách quét QR) =====

const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);

/** Trang HTML ngắn cho khách (thay JSON thô `{"error":…}`) khi mã QR sai hay CRM chưa cấu hình Page. */
export function publicNoticePage({ title = 'Giọt Nắng', message = '' } = {}) {
  return `<!doctype html>
<html lang="vi">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${escapeHtml(title)}</title>
<style>
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;background:#fff8ef;color:#3b2a1a}
main{max-width:420px;margin:24px 16px;padding:28px 24px;background:#fff;border-radius:16px;box-shadow:0 4px 24px rgba(0,0,0,.08);text-align:center}
img{width:72px;height:72px;object-fit:contain}
h1{font-size:20px;margin:12px 0 8px}
p{font-size:15px;line-height:1.5;margin:0}
</style>
</head>
<body>
<main>
<img src="/q/brand/logo.webp" alt="Giọt Nắng">
<h1>${escapeHtml(title)}</h1>
<p>${escapeHtml(message)}</p>
</main>
</body>
</html>`;
}

// ===== Webhook Pancake =====

/**
 * Nhận hay bỏ một gói webhook Pancake. Pancake KHÔNG gửi token (22/09: mọi lần gọi thật đều không có),
 * nên gói không token được nhận theo page_id khi:
 *  - đường dẫn webhook là đường bí mật (PANCAKE_WEBHOOK_PATH khác mặc định): biết đường mới gửi được;
 *  - hoặc đường mặc định /webhooks/pancake (đoán được) nhưng CHƯA bật chặn (PANCAKE_WEBHOOK_REQUIRE_SECRET=1):
 *    vẫn nhận để không gãy webhook thật đang chạy, kèm `warn` để server ghi cảnh báo.
 * Trả { accept, status?, via?, warn?, reason? }.
 */
export function pancakeWebhookDecision({ configured, tokenValid, pageValid, secretPath, strict }) {
  if (!configured) return { accept: false, status: 503, reason: 'not-configured' };
  if (tokenValid) return { accept: true, via: 'token' };
  if (!pageValid) return { accept: false, status: 200, reason: 'token-mismatch' };
  if (secretPath) return { accept: true, via: 'secret-path' };
  if (strict) return { accept: false, status: 200, reason: 'default-path-no-token' };
  return { accept: true, via: 'page-id', warn: true };
}

/**
 * Dấu vết ngắn của một máy bấm nút trên trang đệm QR: băm (khoá ngẫu nhiên theo tiến trình) IP + User-Agent.
 * Không đảo ngược được, không ghi đĩa (qr-scans chỉ giữ trong bộ nhớ 30 phút); khởi động lại là đổi khoá.
 */
const visitorSalt = randomBytes(16).toString('hex');
export function qrVisitorKey(ip, userAgent) {
  return createHash('sha256').update(`${visitorSalt}|${String(ip || '')}|${String(userAgent || '').slice(0, 300)}`).digest('base64url').slice(0, 22);
}

// ===== Máy nhân viên =====

/** Request mang phiên đăng nhập CRM hợp lệ (máy nhân viên). CRM chưa bật đăng nhập thì không ai là nhân viên. */
export function hasStaffSession(auth, request) {
  if (!auth?.enabled) return false;
  try {
    return Boolean(auth.session(request)?.username);
  } catch {
    return false;
  }
}

// ===== Dấu vân tay để bỏ ghi kho hội thoại khi không đổi gì =====

/**
 * Mọi thứ gắn bù thẻ "Đã mua hàng" có thể sửa (kể cả sửa im lặng: cờ purchaseLabeled của đơn khi thẻ
 * đã có sẵn, cờ của luồng bình luận, landingLabeled): trước/sau bằng nhau thì không có gì phải ghi.
 */
export function purchaseLabelFingerprint(conversations) {
  const parts = [];
  for (const conversation of Array.isArray(conversations) ? conversations : []) {
    if (!conversation) continue;
    const orders = Array.isArray(conversation.customerOrders) ? conversation.customerOrders : [];
    let flags = '';
    for (const order of orders) flags += order?.purchaseLabeled ? '1' : '0';
    parts.push([
      conversation.id,
      Array.isArray(conversation.labels) ? conversation.labels.join(',') : String(conversation.labels ?? ''),
      conversation.purchaseLabeled ? 1 : 0,
      Array.isArray(conversation.landingLabeled) ? conversation.landingLabeled.join(',') : String(conversation.landingLabeled ?? ''),
      flags
    ].join('|'));
  }
  return parts.join('\n');
}

/** Thẻ + toàn bộ đơn của vài hội thoại (đồng bộ đơn POS chỉ sửa hai phần này). */
export function conversationOrdersFingerprint(conversations) {
  return JSON.stringify((Array.isArray(conversations) ? conversations : []).map(conversation => [
    conversation?.id, conversation?.labels, conversation?.customerOrders
  ]));
}

// ===== Ghi chú nội bộ của bot =====

export const BOT_NOTE_AUTHOR = Object.freeze({ username: 'bot', name: 'Chatbot AI' });

/**
 * dependencies.addStaffNote(conversation, note) cho chatbot-engine (noteForStaff, C2: SĐT trùng đơn của hội thoại
 * khác…): ghi vào ghi chú hồ sơ khách (Khách hàng → ghi chú; cùng kho với ghi chú nhân viên), tác giả "Chatbot AI".
 * Khách = (pageId:psid) của hội thoại; hồ sơ có SĐT thì dùng khoá bền editKey của nó. Trả ghi chú đã lưu hoặc null.
 */
export function createStaffNoteWriter({ findCustomerById, addCustomerNote, onSaved = () => {} }) {
  return async (conversation, note) => {
    const text = String(note || '').trim();
    if (!text || !conversation?.pageId || !conversation?.psid) return null;
    const id = `${conversation.pageId}:${conversation.psid}`;
    const customer = await Promise.resolve(findCustomerById(id)).catch(() => null);
    const saved = await addCustomerNote(customer?.editKey || id, { text, author: { ...BOT_NOTE_AUTHOR } });
    await Promise.resolve(onSaved({ conversation, customer, note: saved })).catch(() => {});
    return saved;
  };
}

// ===== Log một lần =====

/** Tập có giới hạn (bỏ mục cũ nhất khi đầy): `first(key)` true đúng lần đầu gặp key. */
export function createSeenOnce(maximum = 2000) {
  const seen = new Set();
  return key => {
    const value = String(key);
    if (seen.has(value)) return false;
    seen.add(value);
    while (seen.size > maximum) seen.delete(seen.values().next().value);
    return true;
  };
}
