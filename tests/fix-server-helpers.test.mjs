// Hàm thuần tách từ app/server.mjs (01/10): lọc nhật ký (SEC-1), câu lỗi thân thiện, cache tệp tĩnh,
// trang báo QR, quyết định webhook Pancake, máy nhân viên, dấu vân tay bỏ ghi kho.
import test from 'node:test';
import assert from 'node:assert/strict';
import { tempDir } from './helpers/temp-dir.mjs';
import { appendAudit, queryAudit } from '../app/audit-log.mjs';
import { createAuth, hashPassword } from '../app/auth.mjs';
import { isManager } from '../app/request-actor.mjs';
import {
  auditFiltersFrom, canReadAudit, conversationOrdersFingerprint, createSeenOnce, fileVersionStamp, friendlyAdsError,
  friendlyAdsStatus, friendlyAiTestError, friendlyCampaignInsights, hasStaffSession, pancakeWebhookDecision,
  publicNoticePage, purchaseLabelFingerprint, staticCacheControl
} from '../app/server-helpers.mjs';
import { backfillPurchaseLabels } from '../app/purchase-labels.mjs';

const BASE = Date.UTC(2026, 9, 1, 3, 0);
const staff = { username: 'nv', role: 'staff' };
const owner = { username: 'huy', role: 'owner' };

/** Đúng đường của server: lọc → chốt quyền → queryAudit với cùng bộ lọc. null = 403. */
async function auditAs(actor, query, dir) {
  const filters = auditFiltersFrom(new URLSearchParams(query));
  if (!canReadAudit(isManager(actor), filters)) return null;
  return queryAudit(filters, { dir });
}

test('SEC-1: nhân viên gửi conversationId/orderId chỉ toàn khoảng trắng (%20, %09) → 403, không đọc được toàn bộ nhật ký', async () => {
  const dir = tempDir('fix-server-audit-');
  await appendAudit({ actor: 'huy', actorName: 'huy', role: 'owner', action: 'settings.chatbot', summary: 'Sửa cài đặt' }, { dir, now: BASE });
  await appendAudit({ actor: 'nv', actorName: 'NV', role: 'staff', action: 'message.send', conversationId: 'page:1', summary: 'chào chị' }, { dir, now: BASE + 1000 });
  for (const query of ['conversationId=%20', 'orderId=%09', 'conversationId=%20&orderId=%20', 'conversationId=%0A%0D', 'orderId=%C2%A0', '']) {
    assert.equal(await auditAs(staff, query, dir), null, `nhân viên ?${query} phải bị 403`);
  }
  // Lọc thật một hội thoại: chỉ mục của hội thoại đó (kể cả có khoảng trắng hai đầu).
  for (const query of ['conversationId=page:1', 'conversationId=%20page:1%20']) {
    const result = await auditAs(staff, query, dir);
    assert.ok(result, `?${query} được xem`);
    assert.deepEqual(result.items.map(item => item.conversationId), ['page:1']);
  }
  // Quản trị không lọc vẫn xem toàn bộ.
  assert.equal((await auditAs(owner, '', dir)).items.length, 2);
  // Bộ lọc đã trim và cắt 200 ký tự.
  const filters = auditFiltersFrom(new URLSearchParams(`q=${'a'.repeat(300)}&actor=%20huy%20`));
  assert.equal(filters.q.length, 200);
  assert.equal(filters.actor, 'huy');
});

test('lỗi quảng cáo cho chủ shop: không lộ tên biến .env / mã Graph; nhóm theo nguyên nhân', () => {
  const notConfigured = friendlyAdsError(new Error('Chưa kết nối quảng cáo: điền META_ADS_ACCESS_TOKEN (quyền ads_read) và META_AD_ACCOUNT_IDS trong .env rồi khởi động lại CRM.'));
  assert.match(notConfigured, /Chưa kết nối tài khoản quảng cáo Facebook/);
  const expired = friendlyAdsError(Object.assign(new Error('Token quảng cáo (META_ADS_ACCESS_TOKEN) đã hết hạn hoặc bị thu hồi.'), { graphCode: 190 }));
  assert.match(expired, /đã hết hạn/);
  assert.match(friendlyAdsError(Object.assign(new Error('x'), { graphCode: 17 })), /giới hạn/);
  assert.match(friendlyAdsError(Object.assign(new Error('Token chưa có quyền ads_read trên tài khoản quảng cáo 123.'), { graphCode: 200 })), /chưa có quyền/);
  assert.match(friendlyAdsError(new Error('Không kết nối được tới Facebook (graph.facebook.com): ENOTFOUND.')), /Không kết nối được tới Facebook/);
  assert.match(friendlyAdsError(new Error('lạ')), /Chưa đồng bộ được/);
  for (const text of [notConfigured, expired, friendlyAdsError(new Error('Token quảng cáo (META_ADS_ACCESS_TOKEN) đã hết hạn')), friendlyAiTestError()]) {
    assert.doesNotMatch(text, /META_|\.env|ENOENT|ads_read/);
  }
  // Trạng thái /api/campaigns: chỉ đổi `error`, giữ nguyên phần khác.
  assert.deepEqual(friendlyAdsStatus({ connected: true, error: 'Token quảng cáo (META_ADS_ACCESS_TOKEN) đã hết hạn hoặc bị thu hồi.', syncedAt: 5 }),
    { connected: true, error: expired, syncedAt: 5 });
  assert.deepEqual(friendlyAdsStatus({ connected: true }), { connected: true });
  assert.equal(friendlyAdsStatus(null), null);
});

test('Cố vấn AI lỗi: summary không còn "ENOENT … vertex.json", bỏ trường error, gợi ý theo luật giữ nguyên', () => {
  const raw = {
    source: 'rules', model: 'rules', error: "ENOENT: no such file or directory, open 'C:\\khong-co\\vertex.json'",
    summary: "AI tạm thời không dùng được (ENOENT: no such file or directory, open 'C:\\khong-co\\vertex.json'), nên dưới đây chỉ là gợi ý theo luật tính sẵn: 2 chiến dịch cần để ý.",
    actions: [{ id: 'a' }]
  };
  const friendly = friendlyCampaignInsights(raw);
  assert.equal(friendly.error, undefined);
  assert.doesNotMatch(friendly.summary, /ENOENT|vertex\.json|C:/);
  assert.match(friendly.summary, /^AI tạm thời không dùng được \(nhờ bộ phận kỹ thuật kiểm tra kết nối AI\), nên dưới đây chỉ là gợi ý theo luật tính sẵn: 2 chiến dịch cần để ý\.$/);
  assert.deepEqual(friendly.actions, raw.actions);
  // Kết quả AI bình thường không đổi; null giữ null.
  const ok = { source: 'ai', summary: 'Tốt', actions: [] };
  assert.equal(friendlyCampaignInsights(ok), ok);
  assert.equal(friendlyCampaignInsights(null), null);
});

test('tệp tĩnh: chỉ .js/.css xin đúng mốc sửa tệp mới cache hẳn; ?v= ghi tay, sai mốc, index.html → no-cache', () => {
  const stamp = fileVersionStamp(1759300000123.7);
  assert.equal(stamp, Math.trunc(1759300000123.7).toString(36));
  assert.equal(staticCacheControl({ relative: 'app.js', version: stamp, stamp }), 'private, max-age=31536000, immutable');
  assert.equal(staticCacheControl({ relative: 'styles.css', version: stamp, stamp }), 'private, max-age=31536000, immutable');
  assert.equal(staticCacheControl({ relative: 'app.js', version: 'cu', stamp }), 'no-cache');
  assert.equal(staticCacheControl({ relative: 'staff.js', version: '20261001-ui1', stamp }), 'no-cache');
  assert.equal(staticCacheControl({ relative: 'app.js', version: '', stamp }), 'no-cache');
  assert.equal(staticCacheControl({ relative: 'index.html', version: stamp, stamp }), 'no-cache');
  assert.equal(staticCacheControl({ relative: 'assets/icons/a.png', version: stamp, stamp }), 'no-cache');
});

test('trang báo QR: HTML đầy đủ, chữ được escape, không phải JSON', () => {
  const html = publicNoticePage({ title: 'Mã <QR>', message: 'Quét lại "mã" & thử' });
  assert.match(html, /^<!doctype html>/);
  assert.match(html, /<title>Mã &lt;QR&gt;<\/title>/);
  assert.match(html, /Quét lại &quot;mã&quot; &amp; thử/);
  assert.doesNotMatch(html, /<QR>|"error"/);
});

test('webhook Pancake: không token chỉ nhận ở đường bí mật; đường mặc định nhận kèm cảnh báo, hoặc bỏ khi bật chặn', () => {
  const base = { configured: true, tokenValid: false, pageValid: true };
  assert.deepEqual(pancakeWebhookDecision({ ...base, configured: false }), { accept: false, status: 503, reason: 'not-configured' });
  assert.deepEqual(pancakeWebhookDecision({ ...base, tokenValid: true, secretPath: false, strict: true }), { accept: true, via: 'token' });
  assert.deepEqual(pancakeWebhookDecision({ ...base, pageValid: false, secretPath: true }), { accept: false, status: 200, reason: 'token-mismatch' });
  assert.deepEqual(pancakeWebhookDecision({ ...base, secretPath: true, strict: true }), { accept: true, via: 'secret-path' });
  // Đường mặc định: tương thích (webhook thật đang chạy) — nhận + cảnh báo; bật chặn thì bỏ (vẫn 200 cho Pancake).
  assert.deepEqual(pancakeWebhookDecision({ ...base, secretPath: false, strict: false }), { accept: true, via: 'page-id', warn: true });
  assert.deepEqual(pancakeWebhookDecision({ ...base, secretPath: false, strict: true }), { accept: false, status: 200, reason: 'default-path-no-token' });
});

test('máy nhân viên: chỉ phiên đăng nhập CRM hợp lệ; CRM chưa bật đăng nhập thì không ai là nhân viên', async () => {
  const users = new Map([['nv', await hashPassword('mat-khau-dai')]]);
  const auth = createAuth({ users, secret: 'bi-mat-thu', secure: false });
  const login = await auth.login({ username: 'nv', password: 'mat-khau-dai', clientId: '1' });
  const cookie = login.cookie.split(';')[0];
  assert.equal(hasStaffSession(auth, { headers: { cookie } }), true);
  assert.equal(hasStaffSession(auth, { headers: {} }), false);
  assert.equal(hasStaffSession(auth, { headers: { cookie: `${cookie.split('=')[0]}=gia.mao` } }), false);
  const open = createAuth({ users: new Map(), secret: 'x' });
  assert.equal(open.enabled, false);
  assert.equal(hasStaffSession(open, { headers: { cookie } }), false);
  assert.equal(hasStaffSession(null, { headers: {} }), false);
});

test('bỏ ghi kho: dấu vân tay bắt cả cờ "đã gắn" sửa im lặng (đơn đã có thẻ sẵn) của gắn bù thẻ Đã mua hàng', () => {
  const now = Date.now();
  const store = {
    conversations: [
      // Đơn chưa gắn cờ nhưng hội thoại đã có thẻ: backfill chỉ đặt cờ, không trả thay đổi thẻ nào.
      { id: 'p:1', pageId: 'p', psid: '1', labels: ['purchased'], customerOrders: [{ id: 'A', createdAt: now - 60 * 60 * 1000, status: 'Mới' }] },
      { id: 'p:2', pageId: 'p', psid: '2', labels: [], customerOrders: [] }
    ],
    messages: {}
  };
  const before = purchaseLabelFingerprint(store.conversations);
  const changes = backfillPurchaseLabels(store, { orderLabels: ['purchased'], landingOrders: [], now });
  assert.equal(changes.length, 0, 'không có thay đổi thẻ nào được báo');
  assert.equal(store.conversations[0].customerOrders[0].purchaseLabeled, true);
  assert.notEqual(purchaseLabelFingerprint(store.conversations), before, 'nhưng kho đã đổi (cờ) → phải ghi');
  // Lượt sau: không còn gì đổi → dấu vân tay giữ nguyên → bỏ ghi.
  const settled = purchaseLabelFingerprint(store.conversations);
  backfillPurchaseLabels(store, { orderLabels: ['purchased'], landingOrders: [], now });
  assert.equal(purchaseLabelFingerprint(store.conversations), settled);
  // Đơn POS: khởi tạo customerOrders / bổ sung giftItems / hủy đều làm đổi dấu vân tay.
  const conversation = { id: 'c', labels: ['x'] };
  const fingerprint = conversationOrdersFingerprint([conversation]);
  conversation.customerOrders = [];
  assert.notEqual(conversationOrdersFingerprint([conversation]), fingerprint);
  conversation.customerOrders.push({ id: 'pos1' });
  const withOrder = conversationOrdersFingerprint([conversation]);
  conversation.customerOrders[0].giftItems = [];
  assert.notEqual(conversationOrdersFingerprint([conversation]), withOrder);
});

test('log một lần: createSeenOnce nhớ có giới hạn', () => {
  const first = createSeenOnce(3);
  assert.equal(first('a'), true);
  assert.equal(first('a'), false);
  for (const key of ['b', 'c', 'd']) first(key);
  assert.equal(first('a'), true, 'mục cũ nhất đã bị bỏ khi đầy');
});
