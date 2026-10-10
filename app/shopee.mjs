// Shopee Open Platform (API v2): kết nối shop Shopee của Giọt Nắng vào CRM (chủ shop 10/10/2026).
//
// App "Manager Nong San Giot Nang" (Seller In House System, Live partner_id 2041152) trên open.shopee.com.
// Mọi request ký HMAC-SHA256 bằng Partner Key: chuỗi gốc = partner_id + đường dẫn API + timestamp
// (+ access_token + shop_id với API của shop). Timestamp chỉ sống 5 phút.
// Ủy quyền: chủ shop bấm "Kết nối shop Shopee" → trang ủy quyền Shopee → Shopee chuyển về
// /api/shopee/callback?code=…&shop_id=… → đổi code (dùng một lần, sống 10 phút) lấy access_token (4 giờ) và
// refresh_token (30 ngày, ĐỔI MỚI mỗi lần làm mới — luôn lưu bản mới). Ủy quyền tối đa 365 ngày.
// Domain của trang chuyển về phải trùng "Live Redirect URL Domain" khai trong console của app.
//
// Partner Key và token lưu ở data/processed/shopee-config.json (quyền 600), không bao giờ trả ra giao diện;
// SHOPEE_PARTNER_ID / SHOPEE_PARTNER_KEY trong .env dùng khi chưa dán trong Cài đặt.
import { createHmac, randomBytes } from 'node:crypto';
import path from 'node:path';
import { projectRoot } from './config.mjs';
import { readJsonFileSync, writeJsonAtomic } from './json-store.mjs';

const configPath = process.env.SHOPEE_CONFIG_PATH || path.join(projectRoot, 'data', 'processed', 'shopee-config.json');
const apiHost = () => (process.env.SHOPEE_API_HOST || 'https://partner.shopeemobile.com').replace(/\/+$/, '');
const requestTimeoutMs = 15000;
// Làm mới access_token khi còn dưới 30 phút (token sống 4 giờ).
const REFRESH_BEFORE_MS = 30 * 60 * 1000;
const STATE_TTL_MS = 15 * 60 * 1000;

let saved = null;
const pendingStates = new Map();

function load() {
  if (saved) return saved;
  try {
    saved = readJsonFileSync(configPath, { fallback: () => ({}), label: 'Kết nối Shopee (shopee-config.json)' });
  } catch (error) {
    console.error(error?.message || error);
    return {};
  }
  return saved;
}

async function persist(next) {
  await writeJsonAtomic(configPath, next, { mode: 0o600 });
  saved = next;
  return next;
}

/** Khoá app: bản dán trong Cài đặt thắng .env. */
export function shopeeApp() {
  const config = load();
  return {
    partnerId: String(config.partnerId || process.env.SHOPEE_PARTNER_ID || '').trim(),
    partnerKey: String(config.partnerKey || process.env.SHOPEE_PARTNER_KEY || '').trim()
  };
}

export const shopeeSign = (partnerKey, baseString) => createHmac('sha256', partnerKey).update(baseString).digest('hex');

/** Trạng thái để hiển thị: không bao giờ trả Partner Key hay token. */
export function shopeeStatus(now = Date.now()) {
  const config = load();
  const app = shopeeApp();
  const connected = Boolean(config.shopId && config.refreshToken && Number(config.refreshExpiresAt) > now);
  return {
    appConfigured: Boolean(app.partnerId && app.partnerKey),
    partnerId: app.partnerId,
    keyHint: app.partnerKey ? `${app.partnerKey.slice(0, 4)}…${app.partnerKey.slice(-4)}` : '',
    keySource: config.partnerKey ? 'settings' : (process.env.SHOPEE_PARTNER_KEY ? 'env' : ''),
    connected,
    expired: Boolean(config.shopId && config.refreshToken && !connected),
    shopId: config.shopId ? String(config.shopId) : '',
    shopName: config.shopName || '',
    authorizedAt: Number(config.authorizedAt) || 0,
    authExpireAt: Number(config.authExpireAt) || 0,
    lastError: config.lastError || ''
  };
}

/** Lưu Partner ID / Partner Key chủ shop dán trong Cài đặt → Kênh. Đổi khoá thì bỏ token cũ (của khoá cũ). */
export async function saveShopeeApp({ partnerId, partnerKey }) {
  const id = String(partnerId || '').trim();
  const key = String(partnerKey || '').trim();
  if (!/^\d{4,12}$/.test(id)) throw new Error('Partner ID là dãy số (ví dụ 2041152), xem ở trang app trên open.shopee.com.');
  if (!/^[A-Za-z0-9]{32,128}$/.test(key)) throw new Error('Partner Key chưa đúng: là chuỗi dài chữ và số, chép ở mục "Live API Partner Key" của app.');
  const current = load();
  const sameApp = String(current.partnerId || '') === id && String(current.partnerKey || '') === key;
  return persist(sameApp ? { ...current, savedAt: Date.now() } : { partnerId: id, partnerKey: key, savedAt: Date.now() });
}

export async function disconnectShopee() {
  return persist({});
}

/** Link ủy quyền (đường auth_partner có ký); `state` nằm trong trang chuyển về để chặn yêu cầu giả. */
export function shopeeAuthUrl(publicBaseUrl, now = Date.now()) {
  const app = shopeeApp();
  if (!app.partnerId || !app.partnerKey) throw new Error('Chưa lưu Partner ID và Partner Key của app Shopee.');
  for (const [state, at] of pendingStates) if (now - at > STATE_TTL_MS) pendingStates.delete(state);
  const state = randomBytes(16).toString('hex');
  pendingStates.set(state, now);
  const redirect = `${String(publicBaseUrl).replace(/\/+$/, '')}/api/shopee/callback?state=${state}`;
  const apiPath = '/api/v2/shop/auth_partner';
  const timestamp = Math.floor(now / 1000);
  const sign = shopeeSign(app.partnerKey, `${app.partnerId}${apiPath}${timestamp}`);
  const url = new URL(`${apiHost()}${apiPath}`);
  url.search = new URLSearchParams({ partner_id: app.partnerId, timestamp: String(timestamp), sign, redirect }).toString();
  return { url: url.toString(), state };
}

export function consumeShopeeState(state, now = Date.now()) {
  const at = pendingStates.get(String(state || ''));
  pendingStates.delete(String(state || ''));
  return Boolean(at) && now - at <= STATE_TTL_MS;
}

async function shopeeFetch(apiPath, { method = 'GET', query = {}, body = null, shop = null, fetchImpl = fetch, now = Date.now() } = {}) {
  const app = shopeeApp();
  if (!app.partnerId || !app.partnerKey) throw new Error('Chưa lưu Partner ID và Partner Key của app Shopee.');
  const timestamp = Math.floor(now / 1000);
  const base = shop ? `${app.partnerId}${apiPath}${timestamp}${shop.accessToken}${shop.shopId}` : `${app.partnerId}${apiPath}${timestamp}`;
  const params = new URLSearchParams({ partner_id: app.partnerId, timestamp: String(timestamp), sign: shopeeSign(app.partnerKey, base) });
  if (shop) { params.set('access_token', shop.accessToken); params.set('shop_id', String(shop.shopId)); }
  for (const [key, value] of Object.entries(query)) if (value !== undefined && value !== null && value !== '') params.set(key, String(value));
  const response = await fetchImpl(`${apiHost()}${apiPath}?${params}`, {
    method,
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(requestTimeoutMs)
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload?.error) {
    const error = new Error(`Shopee: ${payload?.message || payload?.error || `HTTP ${response.status}`}`);
    error.code = payload?.error || '';
    throw error;
  }
  return payload;
}

function tokenFields(payload, now) {
  return {
    accessToken: String(payload.access_token || ''),
    refreshToken: String(payload.refresh_token || ''),
    accessExpiresAt: now + (Number(payload.expire_in) || 4 * 3600) * 1000,
    refreshExpiresAt: now + 30 * 24 * 3600 * 1000
  };
}

/** Trang chuyển về sau ủy quyền: đổi code lấy token, lấy tên shop, lưu. */
export async function completeShopeeAuthorization({ code, shopId }, { fetchImpl = fetch, now = Date.now() } = {}) {
  const app = shopeeApp();
  const id = Number(shopId);
  if (!code || !Number.isFinite(id) || id <= 0) throw new Error('Shopee không trả mã ủy quyền hoặc mã shop.');
  const payload = await shopeeFetch('/api/v2/auth/token/get', { method: 'POST', body: { code: String(code), shop_id: id, partner_id: Number(app.partnerId) }, fetchImpl, now });
  const next = { ...load(), partnerId: app.partnerId, partnerKey: load().partnerKey || '', shopId: String(id), ...tokenFields(payload, now), authorizedAt: now, lastError: '' };
  if (!next.partnerKey) delete next.partnerKey;
  await persist(next);
  try {
    const info = await shopeeShopApi('/api/v2/shop/get_shop_info', {}, { fetchImpl, now });
    await persist({ ...load(), shopName: String(info.shop_name || ''), authExpireAt: (Number(info.expire_time) || 0) * 1000 });
  } catch (error) {
    console.warn(`Shopee: đã ủy quyền nhưng chưa lấy được thông tin shop (${error.message}).`);
  }
  return shopeeStatus(now);
}

/** Làm mới access_token (refresh_token đổi mới mỗi lần: luôn lưu bản vừa nhận). */
export async function refreshShopeeToken({ fetchImpl = fetch, now = Date.now(), force = false } = {}) {
  const config = load();
  if (!config.shopId || !config.refreshToken) return false;
  if (!force && Number(config.accessExpiresAt) - now > REFRESH_BEFORE_MS) return false;
  try {
    const payload = await shopeeFetch('/api/v2/auth/access_token/get', {
      method: 'POST',
      body: { refresh_token: config.refreshToken, shop_id: Number(config.shopId), partner_id: Number(shopeeApp().partnerId) },
      fetchImpl,
      now
    });
    await persist({ ...load(), ...tokenFields(payload, now), lastError: '' });
    return true;
  } catch (error) {
    await persist({ ...load(), lastError: String(error.message || error).slice(0, 200) });
    throw error;
  }
}

/** Gọi API của shop đã kết nối (GET: tham số trên URL; POST: thân JSON), tự làm mới token khi sắp hết. */
export async function shopeeShopApi(apiPath, params = {}, { method = 'GET', fetchImpl = fetch, now = Date.now() } = {}) {
  await refreshShopeeToken({ fetchImpl, now });
  const config = load();
  if (!config.shopId || !config.accessToken) throw new Error('Chưa kết nối shop Shopee.');
  const shop = { shopId: config.shopId, accessToken: config.accessToken };
  const payload = method === 'GET'
    ? await shopeeFetch(apiPath, { query: params, shop, fetchImpl, now })
    : await shopeeFetch(apiPath, { method, body: params, shop, fetchImpl, now });
  // Phần lớn API để dữ liệu trong `response`; vài API (shop.get_shop_info) trả thẳng ở ngoài cùng.
  return payload.response || payload;
}

/** Kiểm tra kết nối: tên shop + số đơn tạo trong 7 ngày qua (get_order_list, tối đa 15 ngày mỗi lần hỏi). */
export async function testShopeeConnection({ fetchImpl = fetch, now = Date.now() } = {}) {
  const info = await shopeeShopApi('/api/v2/shop/get_shop_info', {}, { fetchImpl, now });
  let orders = 0;
  let cursor = '';
  for (let page = 0; page < 50; page += 1) {
    const result = await shopeeShopApi('/api/v2/order/get_order_list', {
      time_range_field: 'create_time',
      time_from: Math.floor(now / 1000) - 7 * 86400,
      time_to: Math.floor(now / 1000),
      page_size: 100,
      cursor
    }, { fetchImpl, now });
    orders += (result.order_list || []).length;
    if (!result.more || !result.next_cursor) break;
    cursor = result.next_cursor;
  }
  await persist({ ...load(), shopName: String(info.shop_name || load().shopName || ''), authExpireAt: (Number(info.expire_time) || 0) * 1000 || load().authExpireAt || 0 });
  return { shopName: String(info.shop_name || ''), ordersLast7Days: orders };
}

let refreshTimer = null;
/** Giữ token sống: mỗi 20 phút xem, còn dưới 30 phút thì làm mới (cũng giữ refresh_token 30 ngày luôn mới). */
export function startShopeeTokenRefresh() {
  if (refreshTimer) return () => {};
  const run = () => refreshShopeeToken().catch(error => console.warn(`Shopee: làm mới token lỗi: ${error.message}`));
  setTimeout(run, 60 * 1000).unref?.();
  refreshTimer = setInterval(run, 20 * 60 * 1000);
  refreshTimer.unref?.();
  return () => { clearInterval(refreshTimer); refreshTimer = null; };
}
