// Kết nối Shopee Open Platform (10/10): ký request, link ủy quyền, đổi code lấy token, làm mới token (refresh_token
// đổi mới mỗi lần), gọi API của shop. Shopee giả lập bằng fetchImpl; kho khoá trỏ vào thư mục tạm (quiet-console).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';

const {
  completeShopeeAuthorization, consumeShopeeState, disconnectShopee, refreshShopeeToken, saveShopeeApp,
  shopeeAuthUrl, shopeeShopApi, shopeeSign, shopeeStatus, testShopeeConnection
} = await import('../app/shopee.mjs');

const KEY = 'a'.repeat(32) + 'b'.repeat(32);
const now = Date.UTC(2026, 9, 10, 3, 0, 0);
const calls = [];
/** Shopee giả: trả token / thông tin shop / danh sách đơn theo đường dẫn. */
function fakeShopee({ failRefresh = false } = {}) {
  let refreshCount = 0;
  return async (url, init = {}) => {
    const parsed = new URL(url);
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ path: parsed.pathname, query: Object.fromEntries(parsed.searchParams), body, method: init.method || 'GET' });
    const json = payload => ({ ok: true, status: 200, json: async () => payload });
    if (parsed.pathname === '/api/v2/auth/token/get') return json({ access_token: 'access-1', refresh_token: 'refresh-1', expire_in: 14400, error: '' });
    if (parsed.pathname === '/api/v2/auth/access_token/get') {
      if (failRefresh) return { ok: false, status: 403, json: async () => ({ error: 'error_auth', message: 'Invalid refresh_token' }) };
      refreshCount += 1;
      return json({ access_token: `access-r${refreshCount}`, refresh_token: `refresh-r${refreshCount}`, expire_in: 14400, error: '' });
    }
    if (parsed.pathname === '/api/v2/shop/get_shop_info') return json({ error: '', shop_name: 'Nông Sản Giọt Nắng', expire_time: 1817000000 });
    if (parsed.pathname === '/api/v2/order/get_order_list') {
      const page = parsed.searchParams.get('cursor') ? 2 : 1;
      return json({ error: '', response: { order_list: Array.from({ length: page === 1 ? 100 : 7 }, (_, i) => ({ order_sn: `SN${page}-${i}` })), more: page === 1, next_cursor: page === 1 ? '100' : '' } });
    }
    return { ok: false, status: 404, json: async () => ({ error: 'not_found', message: 'không có' }) };
  };
}

test('chữ ký HMAC-SHA256 đúng ví dụ tài liệu Shopee (chuỗi gốc partner_id + path + timestamp)', () => {
  const base = '2001887/api/v2/shop/get_shop_info165571443159777174636562737266615546704c6d14701711';
  assert.equal(shopeeSign('key', base), createHmac('sha256', 'key').update(base).digest('hex'));
  assert.match(shopeeSign('key', base), /^[0-9a-f]{64}$/);
});

test('lưu khoá app: kiểm định dạng, không trả khoá ra trạng thái, tệp quyền 600', async () => {
  await assert.rejects(() => saveShopeeApp({ partnerId: 'abc', partnerKey: KEY }), /Partner ID/);
  await assert.rejects(() => saveShopeeApp({ partnerId: '2041152', partnerKey: 'ngan' }), /Partner Key/);
  await saveShopeeApp({ partnerId: '2041152', partnerKey: KEY });
  const status = shopeeStatus(now);
  assert.equal(status.appConfigured, true);
  assert.equal(status.connected, false);
  assert.equal(status.keyHint, 'aaaa…bbbb');
  assert.ok(!JSON.stringify(status).includes(KEY), 'không lộ khoá');
  if (process.platform !== 'win32') assert.equal(statSync(process.env.SHOPEE_CONFIG_PATH).mode & 0o777, 0o600);
});

test('link ủy quyền: ký đúng, trang chuyển về mang state dùng một lần', () => {
  const { url, state } = shopeeAuthUrl('https://fb.giotnang.vn/', now);
  const parsed = new URL(url);
  assert.equal(parsed.origin + parsed.pathname, 'https://partner.shopeemobile.com/api/v2/shop/auth_partner');
  assert.equal(parsed.searchParams.get('partner_id'), '2041152');
  const timestamp = parsed.searchParams.get('timestamp');
  assert.equal(timestamp, String(Math.floor(now / 1000)));
  assert.equal(parsed.searchParams.get('sign'), shopeeSign(KEY, `2041152/api/v2/shop/auth_partner${timestamp}`));
  assert.equal(parsed.searchParams.get('redirect'), `https://fb.giotnang.vn/api/shopee/callback?state=${state}`);
  assert.equal(consumeShopeeState(state, now + 1000), true);
  assert.equal(consumeShopeeState(state, now + 2000), false, 'state chỉ dùng một lần');
  assert.equal(consumeShopeeState('gia-mao', now), false);
  const late = shopeeAuthUrl('https://fb.giotnang.vn', now).state;
  assert.equal(consumeShopeeState(late, now + 16 * 60 * 1000), false, 'quá 15 phút thì hết hạn');
});

test('đổi code lấy token, lấy tên shop; gọi API shop ký kèm access_token + shop_id; tự làm mới khi sắp hết hạn', async () => {
  calls.length = 0;
  const fetchImpl = fakeShopee();
  const status = await completeShopeeAuthorization({ code: 'CODE123', shopId: '901234' }, { fetchImpl, now });
  assert.equal(status.connected, true);
  assert.equal(status.shopId, '901234');
  assert.equal(status.shopName, 'Nông Sản Giọt Nắng');
  const tokenCall = calls.find(call => call.path === '/api/v2/auth/token/get');
  assert.deepEqual(tokenCall.body, { code: 'CODE123', shop_id: 901234, partner_id: 2041152 });
  assert.equal(tokenCall.query.sign, shopeeSign(KEY, `2041152/api/v2/auth/token/get${Math.floor(now / 1000)}`));
  const infoCall = calls.find(call => call.path === '/api/v2/shop/get_shop_info');
  assert.equal(infoCall.query.access_token, 'access-1');
  assert.equal(infoCall.query.sign, shopeeSign(KEY, `2041152/api/v2/shop/get_shop_info${Math.floor(now / 1000)}access-1901234`));
  assert.ok(!JSON.stringify(shopeeStatus(now)).includes('access-1'), 'không lộ token');

  // Còn hạn: không làm mới.
  assert.equal(await refreshShopeeToken({ fetchImpl, now: now + 60 * 60 * 1000 }), false);
  // 3 giờ 40 phút sau (còn 20 phút): làm mới, lưu refresh_token MỚI.
  const later = now + (3 * 60 + 40) * 60 * 1000;
  calls.length = 0;
  await shopeeShopApi('/api/v2/shop/get_shop_info', {}, { fetchImpl, now: later });
  assert.deepEqual(calls.map(call => call.path), ['/api/v2/auth/access_token/get', '/api/v2/shop/get_shop_info']);
  assert.equal(calls[0].body.refresh_token, 'refresh-1');
  const stored = JSON.parse(readFileSync(process.env.SHOPEE_CONFIG_PATH, 'utf8'));
  assert.equal(stored.refreshToken, 'refresh-r1', 'refresh_token đổi mới mỗi lần, phải lưu bản mới');
  assert.equal(calls[1].query.access_token, 'access-r1');
});

test('kiểm tra kết nối đếm đơn 7 ngày qua qua nhiều trang', async () => {
  calls.length = 0;
  const result = await testShopeeConnection({ fetchImpl: fakeShopee(), now: now + 2 * 60 * 1000 + (3 * 60 + 40) * 60 * 1000 });
  assert.equal(result.ordersLast7Days, 107);
  const list = calls.filter(call => call.path === '/api/v2/order/get_order_list');
  assert.equal(list.length, 2);
  assert.equal(list[0].query.time_range_field, 'create_time');
  assert.equal(Number(list[0].query.time_to) - Number(list[0].query.time_from), 7 * 86400);
});

test('làm mới lỗi: ghi lỗi để Cài đặt hiện, ném lỗi; ngắt kết nối xoá hết', async () => {
  const far = now + 10 * 60 * 60 * 1000;
  await assert.rejects(() => refreshShopeeToken({ fetchImpl: fakeShopee({ failRefresh: true }), now: far }), /Invalid refresh_token/);
  assert.match(shopeeStatus(far).lastError, /Invalid refresh_token/);
  const status = await disconnectShopee().then(() => shopeeStatus(far));
  assert.equal(status.connected, false);
  assert.equal(status.appConfigured, Boolean(process.env.SHOPEE_PARTNER_KEY));
});
