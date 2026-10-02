// Quản lý chiến dịch: số liệu quảng cáo đọc từ Facebook Marketing API.
//
// CHỈ ĐỌC: mọi lệnh gọi là GET tới /{act}/insights và /{act}/campaigns (quyền
// ads_read). Module không có hàm nào tạo/sửa/tắt quảng cáo — đổi ngân sách hay
// tắt chiến dịch vẫn làm trong Trình quản lý quảng cáo.
//
// Số liệu theo ngày × quảng cáo được giữ ở data/processed/ad-insights.json
// (120 ngày gần nhất) để màn Chiến dịch mở ra không phải chờ Meta; vòng nền
// đồng bộ lại mỗi 60 phút (Meta còn chỉnh số của vài ngày gần đây).
import { createHmac } from 'node:crypto';
import { metaAdsConfig, metaConfig } from './config.mjs';
import { createWriteQueue, readJsonFile, writeJsonAtomic } from './json-store.mjs';
import { shortenMetaError } from './meta-graph.mjs';

export const MESSAGING_ACTION = 'onsite_conversion.messaging_conversation_started_7d';
export const AD_INSIGHTS_KEEP_DAYS = 120;
export const AD_SYNC_INTERVAL_MS = 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const VIETNAM_OFFSET_MS = 7 * 60 * 60 * 1000;
// Chặn vòng lặp vô hạn nếu Meta trả mãi `paging.next`.
const MAXIMUM_PAGES = 200;

const INSIGHT_FIELDS = 'campaign_id,campaign_name,adset_id,adset_name,ad_id,ad_name,spend,impressions,clicks,actions';
const CAMPAIGN_FIELDS = 'id,name,status,effective_status,daily_budget,lifetime_budget,objective';

/** Ngày theo giờ Việt Nam ("YYYY-MM-DD") — cùng múi với tài khoản quảng cáo và giờ đặt đơn. */
export function vietnamDay(ms) {
  return new Date(Number(ms) + VIETNAM_OFFSET_MS).toISOString().slice(0, 10);
}

export function isAdsConfigured(config = metaAdsConfig) {
  return Boolean(config.accessToken && config.accountIds?.length);
}

// ===== Kho số liệu =====

function emptyStore() {
  return { syncedAt: null, accounts: [], campaigns: {}, ads: {}, daily: [] };
}

function normalizeAdStore(value) {
  const plainObject = item => (item && typeof item === 'object' && !Array.isArray(item) ? item : {});
  return {
    syncedAt: Number(value.syncedAt) || null,
    accounts: Array.isArray(value.accounts) ? value.accounts.map(String) : [],
    campaigns: plainObject(value.campaigns),
    ads: plainObject(value.ads),
    daily: Array.isArray(value.daily) ? value.daily.filter(row => row && row.date && row.adId) : [],
    ...(value.lastError?.message ? { lastError: { message: String(value.lastError.message), at: Number(value.lastError.at) || 0 } } : {})
  };
}

/**
 * Chưa có tệp → kho rỗng; tệp hỏng → cất `.corrupt-*` rồi kho rỗng; lỗi đọc khác (EBUSY,
 * EACCES…) → ném. Trước đây mọi lỗi = kho rỗng, và lượt đồng bộ kế tiếp ghi đè kho chỉ còn
 * 7 ngày mới kéo (mất ~113 ngày chi tiêu).
 */
export async function readAdStore(filePath = metaAdsConfig.insightsPath) {
  return readJsonFile(filePath, { fallback: emptyStore, normalize: normalizeAdStore, label: 'Kho số liệu quảng cáo' });
}

const enqueueWrite = createWriteQueue();

/** Ghi tuần tự: đồng bộ tay và vòng nền trùng lúc không đè mất nhau. */
function updateAdStore(mutate, filePath = metaAdsConfig.insightsPath) {
  return enqueueWrite(async () => {
    const store = await readAdStore(filePath);
    const result = await mutate(store);
    // Kho lớn (120 ngày × quảng cáo): ghi gọn, không thụt lề, như trước.
    await writeJsonAtomic(filePath, store, { space: 0 });
    return result;
  });
}

// ===== Gọi Graph API =====

/** Lỗi Graph → câu tiếng Việt nói rõ phải làm gì (token hết hạn, thiếu ads_read, bị giới hạn...). */
export function adsGraphError(payload, status, accountId = '') {
  const error = payload?.error || {};
  const code = Number(error.code);
  const subcode = Number(error.error_subcode);
  const detail = shortenMetaError(error.message);
  const account = accountId ? ` ${accountId}` : '';
  let message;
  if (code === 190 || code === 102) {
    message = 'Token quảng cáo (META_ADS_ACCESS_TOKEN) đã hết hạn hoặc bị thu hồi. Tạo token mới có quyền ads_read (nên dùng token System User không hết hạn) rồi khởi động lại CRM.';
  } else if (code === 10 || code === 294 || (code >= 200 && code < 300)) {
    message = `Token chưa có quyền ads_read trên tài khoản quảng cáo${account}. Cấp quyền ads_read cho token và thêm người dùng/System User đó vào tài khoản quảng cáo trong Business Manager.`;
  } else if ([4, 17, 32, 613, 80000, 80004].includes(code)) {
    message = 'Meta đang giới hạn số lần gọi API quảng cáo; thử đồng bộ lại sau ít phút.';
  } else if (code === 100 && subcode === 33) {
    message = `Không đọc được tài khoản quảng cáo${account}: sai mã tài khoản trong META_AD_ACCOUNT_IDS hoặc token không được cấp quyền ads_read trên tài khoản này.`;
  } else {
    message = `Facebook Marketing API báo lỗi${status ? ` ${status}` : ''}${account ? ` (tài khoản${account})` : ''}: ${detail || 'không rõ nguyên nhân'}.`;
  }
  const wrapped = new Error(message);
  wrapped.statusCode = status || 502;
  if (Number.isFinite(code)) wrapped.graphCode = code;
  wrapped.graphMessage = String(error.message || '');
  return wrapped;
}

// Graph treo thì lượt đồng bộ treo theo (cờ `running` giữ mãi, vòng nền chết lặng): mỗi lần gọi
// (kể cả đọc thân phản hồi) tối đa 30 giây.
export const GRAPH_TIMEOUT_MS = 30_000;

async function fetchJson(url, fetchImpl, accountId) {
  let response;
  const signal = AbortSignal.timeout(GRAPH_TIMEOUT_MS);
  try {
    response = await fetchImpl(url, { method: 'GET', signal });
  } catch (error) {
    const reason = error?.name === 'TimeoutError' || signal.aborted ? `quá ${GRAPH_TIMEOUT_MS / 1000} giây không trả lời` : (error?.cause?.code || error?.message || error);
    throw new Error(`Không kết nối được tới Facebook (graph.facebook.com): ${reason}.`);
  }
  const payload = await response.json().catch(() => ({}));
  if (signal.aborted) throw new Error(`Không kết nối được tới Facebook (graph.facebook.com): quá ${GRAPH_TIMEOUT_MS / 1000} giây không trả lời.`);
  if (!response.ok || payload?.error) throw adsGraphError(payload, response.status, accountId);
  return payload;
}

function graphUrl(pathname, query, config, withProof) {
  const url = new URL(`https://graph.facebook.com/${config.graphVersion || 'v26.0'}/${String(pathname).replace(/^\//, '')}`);
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, String(value));
  url.searchParams.set('access_token', config.accessToken);
  const secret = config.appSecret ?? metaConfig.appSecret;
  if (withProof && secret) url.searchParams.set('appsecret_proof', createHmac('sha256', secret).update(config.accessToken).digest('hex'));
  return url;
}

/**
 * GET một edge và đi hết các trang (`paging.next` đã mang sẵn token). Token
 * quảng cáo có thể thuộc app khác app CRM: khi đó appsecret_proof tính bằng
 * META_APP_SECRET bị Meta từ chối, nên gửi lại một lần không kèm proof.
 */
export async function graphList(pathname, query, { config = metaAdsConfig, fetchImpl = fetch, accountId = '' } = {}) {
  let first;
  try {
    first = await fetchJson(graphUrl(pathname, query, config, true), fetchImpl, accountId);
  } catch (error) {
    if (!/appsecret_proof/i.test(error.graphMessage || '')) throw error;
    first = await fetchJson(graphUrl(pathname, query, config, false), fetchImpl, accountId);
  }
  const items = [...(Array.isArray(first.data) ? first.data : [])];
  let next = first.paging?.next;
  for (let page = 1; next && page < MAXIMUM_PAGES; page += 1) {
    const body = await fetchJson(next, fetchImpl, accountId);
    items.push(...(Array.isArray(body.data) ? body.data : []));
    next = body.paging?.next;
  }
  return items;
}

// ===== Chuẩn hoá =====

const number = value => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

/** Một dòng insights (level=ad, time_increment=1) → dòng số liệu theo ngày của kho. */
export function parseInsightRow(row, accountId = '') {
  const actions = Array.isArray(row?.actions) ? row.actions : [];
  const messages = actions.filter(action => action?.action_type === MESSAGING_ACTION).reduce((sum, action) => sum + number(action.value), 0);
  return {
    date: String(row?.date_start || ''),
    accountId,
    campaignId: String(row?.campaign_id || ''),
    adsetId: String(row?.adset_id || ''),
    adId: String(row?.ad_id || ''),
    spend: Math.round(number(row?.spend) * 100) / 100,
    impressions: Math.round(number(row?.impressions)),
    clicks: Math.round(number(row?.clicks)),
    messages: Math.round(messages)
  };
}

/** Ngân sách Meta trả dạng chuỗi theo đơn vị nhỏ nhất của tiền tệ (VND: chính là đồng). */
const budget = value => (value === undefined || value === null || value === '' ? null : number(value));

export function parseCampaign(item, accountId = '') {
  return {
    id: String(item?.id || ''),
    name: String(item?.name || '').trim(),
    status: String(item?.effective_status || item?.status || ''),
    dailyBudget: budget(item?.daily_budget),
    lifetimeBudget: budget(item?.lifetime_budget),
    objective: String(item?.objective || ''),
    accountId
  };
}

/** Chỉ số liệu của một tài khoản: chiến dịch + dòng theo ngày + bản đồ quảng cáo → chiến dịch. */
export async function fetchAccountInsights(accountId, { since, until, config = metaAdsConfig, fetchImpl = fetch } = {}) {
  const context = { config, fetchImpl, accountId };
  const campaigns = await graphList(`${accountId}/campaigns`, { fields: CAMPAIGN_FIELDS, limit: 200 }, context);
  const rows = await graphList(`${accountId}/insights`, {
    level: 'ad',
    time_increment: 1,
    time_range: JSON.stringify({ since, until }),
    fields: INSIGHT_FIELDS,
    limit: 500
  }, context);
  const ads = {};
  const daily = [];
  for (const row of rows) {
    const parsed = parseInsightRow(row, accountId);
    if (!parsed.date || !parsed.adId) continue;
    daily.push(parsed);
    ads[parsed.adId] = {
      campaignId: parsed.campaignId,
      campaignName: String(row.campaign_name || '').trim(),
      adsetId: parsed.adsetId,
      adsetName: String(row.adset_name || '').trim(),
      adName: String(row.ad_name || '').trim()
    };
  }
  return { campaigns: campaigns.map(item => parseCampaign(item, accountId)).filter(item => item.id), ads, daily };
}

/** Gộp kết quả đồng bộ vào kho: thay trọn khoảng ngày vừa kéo của các tài khoản đó, bỏ trùng ngày+quảng cáo, giữ 120 ngày. */
export function mergeAdInsights(store, results, { since, until, now = Date.now(), accounts = [] } = {}) {
  const synced = new Set(results.map(result => result.accountId));
  const keptSince = vietnamDay(now - (AD_INSIGHTS_KEEP_DAYS - 1) * DAY_MS);
  const rows = new Map();
  for (const row of store.daily) {
    if (row.date < keptSince) continue;
    // Quảng cáo không còn chi tiêu thì Meta không trả dòng: xoá dòng cũ trong khoảng vừa kéo.
    if (synced.has(row.accountId) && row.date >= since && row.date <= until) continue;
    rows.set(`${row.date}|${row.adId}`, row);
  }
  for (const result of results) {
    // R13 (TB-3): Graph /campaigns mặc định KHÔNG trả chiến dịch đã lưu trữ / đã xoá. Chiến dịch của tài khoản vừa
    // đồng bộ mà không còn trong kết quả thì trước đây giữ mãi trạng thái cũ (ACTIVE) → Tổng quan / Chiến dịch đếm
    // thừa "đang chạy". Nay đánh dấu ARCHIVED; lần sau Meta trả lại thì trạng thái thật ghi đè.
    // Danh sách trả về RỖNG thì không kết luận gì (có thể Graph trục trặc): không đổi trạng thái chiến dịch nào.
    const returned = new Set(result.campaigns.map(campaign => String(campaign.id)));
    for (const campaign of returned.size ? Object.values(store.campaigns || {}) : []) {
      if (!campaign || String(campaign.accountId || '') !== String(result.accountId || '') || returned.has(String(campaign.id))) continue;
      if (!['ARCHIVED', 'DELETED'].includes(String(campaign.status || '').toUpperCase())) {
        campaign.status = 'ARCHIVED';
        campaign.archivedAt = now;
      }
    }
    for (const campaign of result.campaigns) store.campaigns[campaign.id] = campaign;
    Object.assign(store.ads, result.ads);
    for (const row of result.daily) if (row.date >= keptSince) rows.set(`${row.date}|${row.adId}`, row);
  }
  store.daily = [...rows.values()].sort((first, second) => first.date.localeCompare(second.date) || first.adId.localeCompare(second.adId));
  store.accounts = accounts;
  store.syncedAt = now;
  delete store.lastError;
  return store;
}

/**
 * Kéo số liệu `days` ngày gần nhất (tính cả hôm nay) của mọi tài khoản quảng
 * cáo và ghi vào kho. Một tài khoản lỗi là cả lượt lỗi (không ghi nửa vời);
 * lỗi được ghi lại để màn Chiến dịch báo cho nhân viên.
 */
export async function syncAdInsights({ days = 7, now = Date.now(), config = metaAdsConfig, fetchImpl = fetch, filePath = config.insightsPath } = {}) {
  if (!isAdsConfigured(config)) {
    throw new Error('Chưa kết nối quảng cáo: điền META_ADS_ACCESS_TOKEN (quyền ads_read) và META_AD_ACCOUNT_IDS trong .env rồi khởi động lại CRM.');
  }
  const span = Math.min(AD_INSIGHTS_KEEP_DAYS, Math.max(1, Math.round(Number(days) || 7)));
  const until = vietnamDay(now);
  const since = vietnamDay(now - (span - 1) * DAY_MS);
  const results = [];
  try {
    for (const accountId of config.accountIds) {
      results.push({ accountId, ...(await fetchAccountInsights(accountId, { since, until, config, fetchImpl })) });
    }
  } catch (error) {
    await updateAdStore(store => { store.lastError = { message: error.message, at: now }; }, filePath).catch(() => {});
    throw error;
  }
  await updateAdStore(store => { mergeAdInsights(store, results, { since, until, now, accounts: config.accountIds }); }, filePath);
  return {
    syncedAt: now,
    since,
    until,
    accounts: config.accountIds,
    rows: results.reduce((sum, result) => sum + result.daily.length, 0),
    campaigns: results.reduce((sum, result) => sum + result.campaigns.length, 0)
  };
}

/** Trạng thái kết nối cho màn Chiến dịch: đã cấu hình chưa, lần đồng bộ cuối, lỗi lần gần nhất. */
export async function adsConnectionStatus({ config = metaAdsConfig, store = null } = {}) {
  const current = store || await readAdStore(config.insightsPath);
  const connected = isAdsConfigured(config);
  const missing = [!config.accessToken && 'META_ADS_ACCESS_TOKEN', !config.accountIds?.length && 'META_AD_ACCOUNT_IDS'].filter(Boolean);
  return {
    connected,
    accounts: connected ? config.accountIds : [],
    syncedAt: current.syncedAt || null,
    ...(missing.length ? { missing } : {}),
    ...(connected && current.lastError?.message ? { error: current.lastError.message } : {})
  };
}

let timer = null;

/**
 * Số ngày vòng nền kéo lại: kho trống → 90 ngày; còn lại → từ lần đồng bộ thành công cuối
 * + 3 ngày (Meta còn chỉnh số vài ngày gần đây), kẹp trong 7–120. Trước đây luôn 7 ngày nên
 * máy chủ ngưng/token hỏng quá 7 ngày thì khoảng giữa không bao giờ được kéo lại → thiếu
 * chi tiêu, ROAS đẹp hơn thật.
 */
export function catchUpDays(syncedAt, now = Date.now()) {
  if (!Number(syncedAt)) return 90;
  const gap = Math.ceil(Math.max(0, now - Number(syncedAt)) / DAY_MS) + 3;
  return Math.min(AD_INSIGHTS_KEEP_DAYS, Math.max(7, gap));
}

/**
 * Đồng bộ nền mỗi 60 phút (lượt đầu sau khởi động: 90 ngày nếu kho còn trống,
 * không thì từ lần đồng bộ cuối, xem catchUpDays). Tắt khi chưa cấu hình hoặc đặt META_ADS_SYNC_DISABLED.
 */
export function startAdInsightsSync({ log = console.log, config = metaAdsConfig } = {}) {
  if (!isAdsConfigured(config) || config.syncDisabled) return null;
  let running = false;
  const run = async () => {
    if (running) return;
    running = true;
    try {
      const store = await readAdStore(config.insightsPath);
      const summary = await syncAdInsights({ days: catchUpDays(store.syncedAt), config });
      if (!store.syncedAt) log(`Đồng bộ quảng cáo: ${summary.rows} dòng số liệu, ${summary.campaigns} chiến dịch (${summary.since} → ${summary.until}).`);
    } catch (error) {
      log(`Đồng bộ quảng cáo lỗi: ${error.message}`);
    } finally {
      running = false;
    }
  };
  run();
  timer = setInterval(run, AD_SYNC_INTERVAL_MS);
  if (typeof timer.unref === 'function') timer.unref();
  return () => clearInterval(timer);
}
