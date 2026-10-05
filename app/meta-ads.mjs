// Quản lý chiến dịch: số liệu quảng cáo đọc từ Facebook Marketing API.
//
// CHỈ ĐỌC: mọi lệnh gọi là GET tới /{act}, /{act}/insights, /{act}/campaigns, /{act}/adsets (quyền ads_read).
// Module không có hàm nào tạo/sửa/tắt quảng cáo — đổi ngân sách hay tắt chiến dịch vẫn làm trong Trình quản lý
// quảng cáo (quyết định chủ shop 05/10/2026: "giữ chỉ khuyên").
//
// Số liệu theo ngày × quảng cáo được giữ ở data/processed/ad-insights.json (120 ngày gần nhất) để màn Chiến dịch
// mở ra không phải chờ Meta.
//
// Theo tài liệu Meta (rà 05/10/2026, Graph v26):
//  - Gọi insights đồng bộ dễ bị "dữ liệu quá lớn" (100/1487534, hoặc mã 1 "reduce the amount of data") / quá giờ:
//    kéo theo từng cửa sổ ngày, GHI từng cửa sổ (lỗi giữa chừng không mất phần đã kéo), lỗi to quá thì chia đôi.
//  - "Insights refresh every 15 minutes and do not change after 28 days": mỗi giờ kéo lại 3 ngày gần nhất, mỗi
//    ngày một lần kéo lại 28 ngày. Kho chưa đủ 90 ngày của một tài khoản (kể cả khi đã bấm Đồng bộ tay 7 ngày,
//    hay tài khoản mới thêm) thì vòng nền kéo bù đủ 90 ngày — mốc phủ riêng từng tài khoản (`coverage`).
//  - use_unified_attribution_setting=true: cùng cách quy chuyển đổi với Trình quản lý quảng cáo.
//  - Quảng cáo đã xoá / lưu trữ có thể không ra dòng ở level=ad: lấy thêm tổng theo ngày level=account, phần
//    chênh vào dòng "chưa rõ chiến dịch" để tổng chi khớp Trình quản lý quảng cáo (ROAS không đẹp hơn thật).
//  - Ngân sách VND có offset 1 (giá trị = đồng). Chiến dịch không bật ngân sách chiến dịch thì ngân sách nằm ở
//    nhóm quảng cáo: cộng ngân sách ngày các nhóm đang chạy.
//  - Bị giới hạn (4, 17, 613, 80000…) thì DỪNG lượt, không thử dồn (gọi tiếp chỉ kéo dài thời gian bị chặn).
import { metaAdsConfig, metaConfig } from './config.mjs';
import { createWriteQueue, readJsonFile, writeJsonAtomic } from './json-store.mjs';
import { GRAPH_TIMEOUT_MS, appSecretProof, graphEndpoint, shortenMetaError } from './meta-graph.mjs';

export const MESSAGING_ACTION = 'onsite_conversion.messaging_conversation_started_7d';
export const NEW_MESSAGING_ACTION = 'onsite_conversion.messaging_first_reply';
export const AD_INSIGHTS_KEEP_DAYS = 120;
export const AD_SYNC_INTERVAL_MS = 60 * 60 * 1000;
export const AD_SYNC_PLAN = Object.freeze({
  backfillDays: 90,        // mỗi tài khoản phải phủ đủ 90 ngày
  recentDays: 3,           // lượt hằng giờ
  deepDays: 28,            // lượt sâu: số liệu chỉ cố định sau 28 ngày
  deepEveryMs: 20 * 60 * 60 * 1000,
  windowDays: 15,          // mỗi lần gọi insights tối đa 15 ngày; lỗi "quá lớn" thì chia đôi
  insightsTimeoutMs: 120 * 1000,
  nearLimitPct: 75         // header giới hạn ≥ 75% thì dừng lượt, để dành cho lượt sau
});
const DAY_MS = 24 * 60 * 60 * 1000;
const VIETNAM_OFFSET_MS = 7 * 60 * 60 * 1000;
// Chặn vòng lặp vô hạn nếu Meta trả mãi `paging.next`.
const MAXIMUM_PAGES = 200;

const INSIGHT_FIELDS = 'campaign_id,campaign_name,adset_id,adset_name,ad_id,ad_name,spend,impressions,reach,clicks,inline_link_clicks,actions';
const ACCOUNT_DAY_FIELDS = 'spend,impressions,clicks,inline_link_clicks,actions';
const CAMPAIGN_FIELDS = 'id,name,status,effective_status,daily_budget,lifetime_budget,objective';
// Không có DELETED: Meta từ chối lọc đối tượng đã xoá ở /campaigns (100/1815001, chạy thật 05/10/2026). Chi tiêu của
// chiến dịch đã xoá vẫn vào kho qua insights (tên lấy từ campaign_name của dòng) và dòng chênh level=account.
const CAMPAIGN_STATUSES = '["ACTIVE","PAUSED","ARCHIVED","IN_PROCESS","WITH_ISSUES"]';
const ADSET_FIELDS = 'id,campaign_id,daily_budget,lifetime_budget,effective_status';
const ACCOUNT_FIELDS = 'name,currency,timezone_name,account_status';
/**
 * Múi giờ của tài khoản có cùng giờ Việt Nam không: UTC+7 QUANH NĂM (không đổi giờ mùa hè). Tài khoản thật của shop đặt
 * Asia/Bangkok (05/10/2026) — cùng giờ với Asia/Ho_Chi_Minh nên số theo ngày khớp đơn hàng. Múi giờ lạ → coi là không khớp.
 */
export function isVietnamClockTimezone(timezone) {
  const offsetMinutes = at => {
    try {
      const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: timezone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
        .formatToParts(at).map(part => [part.type, part.value]));
      return Math.round((Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute) - Math.floor(at.getTime() / 60000) * 60000) / 60000);
    } catch {
      return null;
    }
  };
  const year = new Date().getUTCFullYear();
  return [new Date(Date.UTC(year, 0, 15)), new Date(Date.UTC(year, 6, 15))].every(at => offsetMinutes(at) === 7 * 60);
}
// account_status của Meta: 1 = đang hoạt động.
const ACCOUNT_STATUS_TEXT = { 2: 'bị vô hiệu hoá', 3: 'chưa thanh toán', 7: 'đang chờ xét rủi ro', 8: 'đang chờ thanh toán', 9: 'trong thời gian gia hạn', 100: 'chờ đóng', 101: 'đã đóng' };

/** Ngày theo giờ Việt Nam ("YYYY-MM-DD") — cùng múi với tài khoản quảng cáo và giờ đặt đơn. */
export function vietnamDay(ms) {
  return new Date(Number(ms) + VIETNAM_OFFSET_MS).toISOString().slice(0, 10);
}

const addDays = (day, count) => new Date(Date.parse(`${day}T00:00:00Z`) + count * DAY_MS).toISOString().slice(0, 10);
const daysBetween = (first, last) => Math.round((Date.parse(`${last}T00:00:00Z`) - Date.parse(`${first}T00:00:00Z`)) / DAY_MS) + 1;

export function isAdsConfigured(config = metaAdsConfig) {
  return Boolean(config.accessToken && config.accountIds?.length);
}

// ===== Kho số liệu =====

function emptyStore() {
  return { syncedAt: null, accounts: [], campaigns: {}, ads: {}, daily: [], coverage: {}, accountInfo: {} };
}

function normalizeAdStore(value) {
  const plainObject = item => (item && typeof item === 'object' && !Array.isArray(item) ? item : {});
  return {
    syncedAt: Number(value.syncedAt) || null,
    accounts: Array.isArray(value.accounts) ? value.accounts.map(String) : [],
    campaigns: plainObject(value.campaigns),
    ads: plainObject(value.ads),
    daily: Array.isArray(value.daily) ? value.daily.filter(row => row && row.date && row.adId) : [],
    coverage: plainObject(value.coverage),
    accountInfo: plainObject(value.accountInfo),
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

const THROTTLE_CODES = new Set([4, 17, 32, 613]);
const isThrottleCode = code => THROTTLE_CODES.has(code) || (code >= 80000 && code <= 80014);

/** Lỗi Graph → câu tiếng Việt nói rõ phải làm gì (token hết hạn, thiếu ads_read, bị giới hạn, dữ liệu quá lớn...). */
export function adsGraphError(payload, status, accountId = '') {
  const error = payload?.error || {};
  const code = Number(error.code);
  const subcode = Number(error.error_subcode);
  const raw = String(error.message || '');
  const detail = shortenMetaError(raw);
  const account = accountId ? ` ${accountId}` : '';
  const tooMuchData = subcode === 1487534 || (code === 1 && (subcode === 99 || /reduce the amount of data/i.test(raw)));
  let message;
  if (code === 190 || code === 102) {
    const why = subcode === 463 ? 'đã hết hạn' : subcode === 458 ? 'không còn gắn với app (app bị gỡ khỏi người dùng hệ thống)' : subcode === 467 || subcode === 460 ? 'không còn hiệu lực' : 'đã hết hạn hoặc bị thu hồi';
    message = `Token quảng cáo (META_ADS_ACCESS_TOKEN) ${why}. Tạo token mới cho người dùng hệ thống (Business Manager → Người dùng hệ thống → Tạo mã, quyền ads_read, thời hạn "Không bao giờ") rồi khởi động lại CRM.`;
  } else if (code === 10 || code === 294 || (code >= 200 && code < 300)) {
    message = `Token chưa có quyền ads_read trên tài khoản quảng cáo${account}. Trong Business Manager: gán tài khoản quảng cáo này cho người dùng hệ thống (quyền "Xem hiệu quả") và tạo token có ads_read.`;
  } else if (isThrottleCode(code)) {
    message = 'Meta đang giới hạn số lần gọi API quảng cáo; CRM tự thử lại ở lượt sau (mỗi giờ).';
  } else if (code === 100 && subcode === 33) {
    message = `Không đọc được tài khoản quảng cáo${account}: sai mã tài khoản trong META_AD_ACCOUNT_IDS hoặc tài khoản chưa được gán cho người dùng hệ thống.`;
  } else if (tooMuchData) {
    message = `Meta báo dữ liệu quá lớn cho một lần lấy${account ? ` (tài khoản${account})` : ''}; CRM đã chia nhỏ khoảng ngày mà vẫn chưa được.`;
  } else if (code === 1 || code === 2) {
    message = 'Meta đang trục trặc tạm thời; CRM tự thử lại ở lượt sau.';
  } else if (code === 2635) {
    message = 'Phiên bản Graph API trong META_GRAPH_VERSION đã ngừng hỗ trợ; cần nâng lên bản mới.';
  } else {
    message = `Facebook Marketing API báo lỗi${status ? ` ${status}` : ''}${account ? ` (tài khoản${account})` : ''}: ${detail || 'không rõ nguyên nhân'}.`;
  }
  const wrapped = new Error(message);
  wrapped.statusCode = status || 502;
  if (Number.isFinite(code)) wrapped.graphCode = code;
  if (Number.isFinite(subcode)) wrapped.graphSubcode = subcode;
  wrapped.graphMessage = raw;
  wrapped.tooMuchData = tooMuchData;
  wrapped.throttled = isThrottleCode(code);
  // Lỗi tạm của Meta (mã 1/2 không phải "quá lớn", is_transient, 5xx): thử lại ngay vài lần.
  wrapped.transient = !tooMuchData && !wrapped.throttled && (code === 1 || code === 2 || error.is_transient === true || (!Number.isFinite(code) && status >= 500));
  return wrapped;
}

/** % đã dùng lớn nhất trong các header giới hạn của Meta (X-FB-Ads-Insights-Throttle, X-Business-Use-Case-Usage, X-Ad-Account-Usage). */
export function usagePercent(headers) {
  const read = name => {
    try {
      const value = headers?.get?.(name);
      return value ? JSON.parse(value) : null;
    } catch {
      return null;
    }
  };
  const numbers = [];
  const throttle = read('x-fb-ads-insights-throttle');
  if (throttle) numbers.push(Number(throttle.app_id_util_pct), Number(throttle.acc_id_util_pct));
  const account = read('x-ad-account-usage');
  if (account) numbers.push(Number(account.acc_id_util_pct));
  const business = read('x-business-use-case-usage');
  for (const entries of Object.values(business || {})) {
    for (const entry of Array.isArray(entries) ? entries : []) numbers.push(Number(entry?.call_count), Number(entry?.total_cputime), Number(entry?.total_time));
  }
  return Math.max(0, ...numbers.filter(Number.isFinite));
}

const defaultSleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const NETWORK_CODES = /^(ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|EPIPE|UND_ERR_[A-Z_]+)$/;

/**
 * Một GET tới Graph. Lỗi tạm thời (Meta mã 1/2, 5xx, rớt mạng) thử lại 2 lần, lùi 2 s → 4 s. Bị giới hạn hay
 * dữ liệu quá lớn thì ném ngay (người gọi dừng lượt / chia nhỏ). `context.usage` giữ % giới hạn cao nhất đã thấy.
 */
async function fetchJson(url, fetchImpl, accountId, { timeoutMs = GRAPH_TIMEOUT_MS, sleep = defaultSleep, context = null } = {}) {
  for (let attempt = 0; ; attempt += 1) {
    let response;
    const signal = AbortSignal.timeout(timeoutMs);
    try {
      response = await fetchImpl(url, { method: 'GET', signal });
    } catch (error) {
      const timedOut = error?.name === 'TimeoutError' || signal.aborted;
      const reason = timedOut ? `quá ${Math.round(timeoutMs / 1000)} giây không trả lời` : (error?.cause?.code || error?.message || error);
      const wrapped = new Error(`Không kết nối được tới Facebook (graph.facebook.com): ${reason}.`);
      wrapped.timeout = timedOut;
      wrapped.transient = !timedOut && NETWORK_CODES.test(String(error?.cause?.code || error?.code || ''));
      if (wrapped.transient && attempt < 2) {
        await sleep(2000 * 2 ** attempt);
        continue;
      }
      throw wrapped;
    }
    if (context) context.usage = Math.max(context.usage || 0, usagePercent(response.headers));
    const payload = await response.json().catch(() => ({}));
    if (signal.aborted) {
      throw Object.assign(new Error(`Không kết nối được tới Facebook (graph.facebook.com): quá ${Math.round(timeoutMs / 1000)} giây không trả lời.`), { timeout: true });
    }
    if (response.ok && !payload?.error) return payload;
    const error = adsGraphError(payload, response.status, accountId);
    if (error.transient && attempt < 2) {
      await sleep(2000 * 2 ** attempt);
      continue;
    }
    throw error;
  }
}

// appsecret_proof: token quảng cáo có thể thuộc app khác app CRM → proof bằng META_APP_SECRET bị từ chối. Nhớ lại
// để các lượt sau khỏi tốn một lần gọi hỏng (gói phát triển của Meta giới hạn chặt). META_ADS_APP_SECRET nếu có.
let proofRejected = false;

function graphUrl(pathname, query, config, withProof) {
  const url = graphEndpoint(pathname, config.graphVersion || 'v26.0');
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, String(value));
  url.searchParams.set('access_token', config.accessToken);
  const secret = config.appSecret ?? metaConfig.appSecret;
  if (withProof && secret) url.searchParams.set('appsecret_proof', appSecretProof(config.accessToken, secret));
  return url;
}

async function graphGet(pathname, query, { config, fetchImpl, accountId, ...options }) {
  const sleep = options.sleep || config.sleep || defaultSleep;
  const call = withProof => fetchJson(graphUrl(pathname, query, config, withProof), fetchImpl, accountId, { ...options, sleep });
  if (proofRejected) return call(false);
  try {
    return await call(true);
  } catch (error) {
    if (!/appsecret_proof/i.test(error.graphMessage || '')) throw error;
    proofRejected = true;
    return call(false);
  }
}

/** Cho test: quên lần appsecret_proof bị từ chối. */
export function resetProofMemory() {
  proofRejected = false;
}

/**
 * GET một edge và đi hết các trang (`paging.next` đã mang sẵn token). Token quảng cáo có thể thuộc app khác app
 * CRM: khi đó appsecret_proof tính bằng META_APP_SECRET bị Meta từ chối, nên gửi lại không kèm proof.
 */
export async function graphList(pathname, query, { config = metaAdsConfig, fetchImpl = fetch, accountId = '', timeoutMs, context = null, sleep } = {}) {
  const options = { config, fetchImpl, accountId, timeoutMs, context, sleep: sleep || config.sleep || defaultSleep };
  const first = await graphGet(pathname, query, options);
  const items = [...(Array.isArray(first.data) ? first.data : [])];
  let next = first.paging?.next;
  for (let page = 1; next && page < MAXIMUM_PAGES; page += 1) {
    const body = await fetchJson(next, fetchImpl, accountId, options);
    items.push(...(Array.isArray(body.data) ? body.data : []));
    next = body.paging?.next;
  }
  // INT-28: dừng ở trần trang mà Meta còn trang sau → danh sách THIẾU; người gọi không được coi là đủ.
  if (next) items.truncated = true;
  return items;
}

// ===== Chuẩn hoá =====

const number = value => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

const actionCount = (actions, type) => (Array.isArray(actions) ? actions : [])
  .filter(action => action?.action_type === type)
  .reduce((sum, action) => sum + number(action.value), 0);

/** Một dòng insights (level=ad, time_increment=1) → dòng số liệu theo ngày của kho. */
export function parseInsightRow(row, accountId = '') {
  return {
    date: String(row?.date_start || ''),
    accountId,
    campaignId: String(row?.campaign_id || ''),
    adsetId: String(row?.adset_id || ''),
    adId: String(row?.ad_id || ''),
    spend: Math.round(number(row?.spend) * 100) / 100,
    impressions: Math.round(number(row?.impressions)),
    clicks: Math.round(number(row?.clicks)),
    linkClicks: Math.round(number(row?.inline_link_clicks)),
    messages: Math.round(actionCount(row?.actions, MESSAGING_ACTION)),
    newMessages: Math.round(actionCount(row?.actions, NEW_MESSAGING_ACTION))
  };
}

/** Ngân sách Meta trả dạng chuỗi theo đơn vị nhỏ nhất của tiền tệ (VND offset 1: chính là đồng). */
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

/** Chiến dịch không có ngân sách chung (ngân sách ở nhóm quảng cáo): cộng ngân sách các nhóm đang chạy. */
export function applyAdsetBudgets(campaigns, adsets = []) {
  const sums = new Map();
  for (const adset of adsets) {
    if (String(adset?.effective_status || '').toUpperCase() !== 'ACTIVE') continue;
    const id = String(adset?.campaign_id || '');
    const row = sums.get(id) || { daily: 0, lifetime: 0, any: false };
    const daily = budget(adset?.daily_budget);
    const lifetime = budget(adset?.lifetime_budget);
    if (daily !== null) { row.daily += daily; row.any = true; }
    if (lifetime !== null) { row.lifetime += lifetime; row.any = true; }
    sums.set(id, row);
  }
  return campaigns.map(campaign => {
    const sum = sums.get(campaign.id);
    if (campaign.dailyBudget !== null || campaign.lifetimeBudget !== null || !sum?.any) return campaign;
    return { ...campaign, dailyBudget: sum.daily || null, lifetimeBudget: sum.lifetime || null, budgetLevel: 'adset' };
  });
}

/**
 * Tổng chi theo ngày của cả tài khoản (level=account) trừ tổng các dòng level=ad: phần chênh (quảng cáo đã xoá /
 * lưu trữ không ra dòng riêng) thành một dòng "gap:<tài khoản>" không có chiến dịch.
 */
export function accountGapRows(accountRows = [], adRows = [], accountId = '') {
  const sums = new Map();
  for (const row of adRows) {
    const day = sums.get(row.date) || { spend: 0, impressions: 0, clicks: 0, linkClicks: 0, messages: 0, newMessages: 0 };
    for (const key of Object.keys(day)) day[key] += number(row[key]);
    sums.set(row.date, day);
  }
  const gaps = [];
  for (const raw of accountRows) {
    const total = parseInsightRow(raw, accountId);
    if (!total.date) continue;
    const parts = sums.get(total.date) || {};
    const spend = Math.round((total.spend - number(parts.spend)) * 100) / 100;
    if (spend < 1) continue;
    const rest = key => Math.max(0, total[key] - number(parts[key]));
    gaps.push({
      date: total.date, accountId, campaignId: '', adsetId: '', adId: `gap:${accountId}`,
      spend, impressions: rest('impressions'), clicks: rest('clicks'), linkClicks: rest('linkClicks'), messages: rest('messages'), newMessages: rest('newMessages')
    });
  }
  return gaps;
}

/** Thông tin tài khoản: chặn tài khoản không phải VND / giờ Việt Nam (số sẽ sai), cảnh báo tài khoản không hoạt động. */
export function checkAccountInfo(info = {}, accountId = '') {
  const currency = String(info.currency || '');
  const timezone = String(info.timezone_name || '');
  if (currency && currency !== 'VND') {
    const error = new Error(`Tài khoản quảng cáo ${accountId} dùng tiền ${currency}; CRM chỉ tính được tài khoản VND. Bỏ tài khoản này khỏi META_AD_ACCOUNT_IDS.`);
    error.permanent = true;
    throw error;
  }
  if (timezone && !isVietnamClockTimezone(timezone)) {
    const error = new Error(`Tài khoản quảng cáo ${accountId} đặt múi giờ ${timezone}; số theo ngày sẽ lệch với đơn hàng (giờ Việt Nam). Bỏ tài khoản này khỏi META_AD_ACCOUNT_IDS hoặc đổi múi giờ tài khoản.`);
    error.permanent = true;
    throw error;
  }
  const status = Number(info.account_status);
  return {
    name: String(info.name || '').trim(),
    currency,
    timezone,
    status: Number.isFinite(status) ? status : null,
    ...(Number.isFinite(status) && status !== 1 ? { warning: `Tài khoản quảng cáo ${accountId}${info.name ? ` (${info.name})` : ''} ${ACCOUNT_STATUS_TEXT[status] || `có trạng thái ${status}`}.` } : {})
  };
}

/** Chiến dịch + nhóm quảng cáo (để biết ngân sách) của một tài khoản. */
async function fetchAccountCampaigns(accountId, context) {
  const campaigns = await graphList(`${accountId}/campaigns`, { fields: CAMPAIGN_FIELDS, effective_status: CAMPAIGN_STATUSES, limit: 200 }, context);
  const adsets = await graphList(`${accountId}/adsets`, { fields: ADSET_FIELDS, effective_status: '["ACTIVE"]', limit: 200 }, context);
  const parsed = applyAdsetBudgets(campaigns.map(item => parseCampaign(item, accountId)).filter(item => item.id), adsets);
  return { campaigns: parsed, campaignsTruncated: Boolean(campaigns.truncated) };
}

/** Số liệu một cửa sổ ngày: dòng theo quảng cáo + dòng chênh lệch với tổng tài khoản + bản đồ quảng cáo → chiến dịch. */
export async function fetchWindowInsights(accountId, { since, until, config = metaAdsConfig, fetchImpl = fetch, context = {}, sleep } = {}) {
  const options = { config, fetchImpl, accountId, timeoutMs: config.insightsTimeoutMs || AD_SYNC_PLAN.insightsTimeoutMs, context, sleep };
  const common = { time_increment: 1, time_range: JSON.stringify({ since, until }), use_unified_attribution_setting: 'true' };
  const rows = await graphList(`${accountId}/insights`, { ...common, level: 'ad', fields: INSIGHT_FIELDS, limit: 250 }, options);
  const totals = await graphList(`${accountId}/insights`, { ...common, level: 'account', fields: ACCOUNT_DAY_FIELDS, limit: 250 }, options);
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
  daily.push(...accountGapRows(totals, daily, accountId));
  return { ads, daily, ...(rows.truncated ? { dailyTruncated: true } : {}) };
}

/** Gộp kết quả đồng bộ vào kho: thay trọn khoảng ngày vừa kéo của các tài khoản đó, bỏ trùng ngày+quảng cáo, giữ 120 ngày. */
export function mergeAdInsights(store, results, { since, until, now = Date.now(), accounts = [] } = {}) {
  // INT-28: tài khoản có số liệu bị cắt ở trần trang thì KHÔNG xoá dòng cũ trong khoảng (chỉ ghi đè dòng trùng ngày+quảng
  // cáo) — xoá rồi chèn phần thiếu là mất chi tiêu, ROAS đẹp hơn thật.
  const synced = new Set(results.filter(result => !result.dailyTruncated).map(result => result.accountId));
  const truncated = results.filter(result => result.dailyTruncated || result.campaignsTruncated).map(result => result.accountId);
  const keptSince = vietnamDay(now - (AD_INSIGHTS_KEEP_DAYS - 1) * DAY_MS);
  const rows = new Map();
  for (const row of store.daily) {
    if (row.date < keptSince) continue;
    // Quảng cáo không còn chi tiêu thì Meta không trả dòng: xoá dòng cũ trong khoảng vừa kéo.
    if (synced.has(row.accountId) && row.date >= since && row.date <= until) continue;
    rows.set(`${row.date}|${row.adId}`, row);
  }
  for (const result of results) {
    // R13 (TB-3): chiến dịch của tài khoản vừa đồng bộ mà không còn trong kết quả thì trước đây giữ mãi trạng thái cũ
    // (ACTIVE). Nay đánh dấu ARCHIVED; lần sau Meta trả lại thì trạng thái thật ghi đè.
    // Danh sách trả về RỖNG thì không kết luận gì (có thể Graph trục trặc, hoặc cửa sổ không mang chiến dịch).
    const returned = new Set((result.campaigns || []).map(campaign => String(campaign.id)));
    // Danh sách chiến dịch bị cắt ở trần trang: thiếu ≠ đã lưu trữ.
    for (const campaign of returned.size && !result.campaignsTruncated ? Object.values(store.campaigns || {}) : []) {
      if (!campaign || String(campaign.accountId || '') !== String(result.accountId || '') || returned.has(String(campaign.id))) continue;
      if (!['ARCHIVED', 'DELETED'].includes(String(campaign.status || '').toUpperCase())) {
        campaign.status = 'ARCHIVED';
        campaign.archivedAt = now;
      }
    }
    for (const campaign of result.campaigns || []) store.campaigns[campaign.id] = campaign;
    Object.assign(store.ads, result.ads || {});
    for (const row of result.daily || []) if (row.date >= keptSince) rows.set(`${row.date}|${row.adId}`, row);
  }
  store.daily = [...rows.values()].sort((first, second) => first.date.localeCompare(second.date) || first.adId.localeCompare(second.adId));
  store.accounts = accounts;
  store.syncedAt = now;
  if (truncated.length) store.lastError = { message: `Meta trả quá ${MAXIMUM_PAGES} trang số liệu cho tài khoản ${truncated.join(', ')}: lượt này chỉ ghi thêm, không xoá số cũ; số liệu có thể thiếu.`, at: now };
  else delete store.lastError;
  return store;
}

/** Hợp khoảng đã phủ của một tài khoản với cửa sổ vừa ghi (liền/chồng thì nối, rời thì lấy cửa sổ mới). */
export function extendCoverage(coverage, since, until) {
  if (!coverage?.since || !coverage?.until) return { since, until };
  if (since <= addDays(coverage.until, 1) && until >= addDays(coverage.since, -1)) {
    return { since: since < coverage.since ? since : coverage.since, until: until > coverage.until ? until : coverage.until };
  }
  return { since, until };
}

/**
 * Lượt nền cần kéo khoảng nào cho từng tài khoản:
 *  - chưa phủ đủ 90 ngày (kho trống, mới bấm Đồng bộ tay vài ngày, tài khoản mới thêm) → 90 ngày;
 *  - lâu chưa kéo sâu (> 20 giờ) hoặc máy chủ ngưng làm hở khoảng → 28 ngày (hoặc từ ngày cuối đã phủ − 3, tối đa 120);
 *  - còn lại → 3 ngày gần nhất.
 */
export function planBackgroundSync(store = {}, accounts = [], now = Date.now(), plan = AD_SYNC_PLAN) {
  const today = vietnamDay(now);
  const target = addDays(today, -(plan.backfillDays - 1));
  return accounts.map(accountId => {
    const coverage = store.coverage?.[accountId];
    if (!coverage?.since || coverage.since > target) return { accountId, since: target, until: today, kind: 'backfill' };
    // Máy chủ ngưng / lượt trước hụt: kéo từ ngày cuối đã phủ (gồm cả ngày đó, Meta còn chỉnh) tới hôm nay.
    const gapSince = addDays(coverage.until, -(plan.recentDays - 1));
    const deepDue = !coverage.deepAt || now - Number(coverage.deepAt) > plan.deepEveryMs;
    let since = deepDue ? addDays(today, -(plan.deepDays - 1)) : addDays(today, -(plan.recentDays - 1));
    if (gapSince < since) since = gapSince;
    const oldest = addDays(today, -(AD_INSIGHTS_KEEP_DAYS - 1));
    if (since < oldest) since = oldest;
    return { accountId, since, until: today, kind: deepDue || gapSince < addDays(today, -(plan.recentDays - 1)) ? 'deep' : 'recent' };
  });
}

/** Các cửa sổ ≤ windowDays, MỚI trước (số gần đây lên màn hình sớm nhất). */
export function syncWindows(since, until, windowDays = AD_SYNC_PLAN.windowDays) {
  const windows = [];
  let end = until;
  while (end >= since) {
    const start = addDays(end, -(windowDays - 1));
    windows.push({ since: start < since ? since : start, until: end });
    end = addDays(start, -1);
  }
  return windows;
}

// Một lượt đồng bộ tại một thời điểm (bấm tay trùng vòng nền thì chờ nhau): gói phát triển của Meta giới hạn chặt.
let exclusive = Promise.resolve();
function runExclusive(task) {
  const run = exclusive.then(task, task);
  exclusive = run.then(() => undefined, () => undefined);
  return run;
}

/**
 * Kéo số liệu cho các khoảng `ranges` = [{accountId, since, until, kind?}] — từng tài khoản, từng cửa sổ, ghi kho
 * sau mỗi cửa sổ. Lỗi "quá lớn"/quá giờ → chia đôi cửa sổ (tối thiểu 1 ngày). Bị giới hạn / gần 75% giới hạn →
 * dừng lượt (phần đã ghi vẫn giữ). Lỗi của một tài khoản là lỗi cả lượt (ném sau khi ghi lastError).
 */
async function syncRanges(ranges, { config, fetchImpl, now, filePath, sleep }) {
  const context = { usage: 0 };
  let rows = 0;
  let campaigns = 0;
  const warnings = [];
  let stoppedEarly = '';
  try {
    for (const range of ranges) {
      if (stoppedEarly) break;
      const { accountId } = range;
      const options = { config, fetchImpl, accountId, context, sleep };
      const info = checkAccountInfo(await graphGet(accountId, { fields: ACCOUNT_FIELDS }, options), accountId);
      if (info.warning) warnings.push(info.warning);
      const campaignResult = await fetchAccountCampaigns(accountId, options);
      campaigns += campaignResult.campaigns.length;
      let first = true;
      const pending = syncWindows(range.since, range.until, config.windowDays || AD_SYNC_PLAN.windowDays);
      while (pending.length) {
        if (context.usage >= AD_SYNC_PLAN.nearLimitPct) {
          stoppedEarly = `Gần chạm giới hạn gọi API của Meta (${Math.round(context.usage)}%): tạm dừng, lượt sau kéo tiếp.`;
          break;
        }
        const window = pending.shift();
        let result;
        try {
          result = await fetchWindowInsights(accountId, { ...window, config, fetchImpl, context, sleep });
        } catch (error) {
          const days = daysBetween(window.since, window.until);
          if ((error.tooMuchData || error.timeout) && days > 1) {
            const half = Math.ceil(days / 2);
            const split = addDays(window.until, -(half - 1));
            pending.unshift({ since: split, until: window.until }, { since: window.since, until: addDays(split, -1) });
            continue;
          }
          throw error;
        }
        await updateAdStore(store => {
          mergeAdInsights(store, [{ accountId, ...(first ? campaignResult : { campaigns: [] }), ...result }], { since: window.since, until: window.until, now, accounts: config.accountIds });
          store.coverage[accountId] = { ...store.coverage[accountId], ...extendCoverage(store.coverage[accountId], window.since, window.until) };
          store.accountInfo[accountId] = { name: info.name, currency: info.currency, timezone: info.timezone, status: info.status };
          if (!pending.length && (range.kind === 'deep' || range.kind === 'backfill')) store.coverage[accountId].deepAt = now;
          if (warnings.length) store.lastError = { message: warnings.join(' '), at: now };
        }, filePath);
        first = false;
        rows += result.daily.length;
      }
    }
  } catch (error) {
    await updateAdStore(store => { store.lastError = { message: error.message, at: now }; }, filePath).catch(() => {});
    throw error;
  }
  if (stoppedEarly) await updateAdStore(store => { store.lastError = { message: stoppedEarly, at: now }; }, filePath).catch(() => {});
  return { rows, campaigns, usage: Math.round(context.usage), ...(stoppedEarly ? { stoppedEarly } : {}), ...(warnings.length ? { warnings } : {}) };
}

/**
 * Đồng bộ tay: kéo `days` ngày gần nhất (tính cả hôm nay) của mọi tài khoản. Không làm hỏng việc kéo bù 90 ngày:
 * mốc phủ chỉ mở rộng theo đúng khoảng đã kéo.
 */
export async function syncAdInsights({ days = 7, now = Date.now(), config = metaAdsConfig, fetchImpl = fetch, filePath = config.insightsPath, sleep } = {}) {
  if (!isAdsConfigured(config)) {
    throw new Error('Chưa kết nối quảng cáo: điền META_ADS_ACCESS_TOKEN (quyền ads_read) và META_AD_ACCOUNT_IDS trong .env rồi khởi động lại CRM.');
  }
  const span = Math.min(AD_INSIGHTS_KEEP_DAYS, Math.max(1, Math.round(Number(days) || 7)));
  const until = vietnamDay(now);
  const since = vietnamDay(now - (span - 1) * DAY_MS);
  return runExclusive(async () => {
    const summary = await syncRanges(config.accountIds.map(accountId => ({ accountId, since, until, kind: 'manual' })), { config, fetchImpl, now, filePath, sleep });
    return { syncedAt: now, since, until, accounts: config.accountIds, ...summary };
  });
}

/** Một lượt nền theo planBackgroundSync. */
export async function runBackgroundAdSync({ now = Date.now(), config = metaAdsConfig, fetchImpl = fetch, filePath = config.insightsPath, sleep } = {}) {
  return runExclusive(async () => {
    const store = await readAdStore(filePath);
    const ranges = planBackgroundSync(store, config.accountIds, now);
    const summary = await syncRanges(ranges, { config, fetchImpl, now, filePath, sleep });
    return { ranges, ...summary };
  });
}

/** Trạng thái kết nối cho màn Chiến dịch: đã cấu hình chưa, lần đồng bộ cuối, lỗi lần gần nhất, tài khoản. */
export async function adsConnectionStatus({ config = metaAdsConfig, store = null } = {}) {
  const current = store || await readAdStore(config.insightsPath);
  const connected = isAdsConfigured(config);
  const missing = [!config.accessToken && 'META_ADS_ACCESS_TOKEN', !config.accountIds?.length && 'META_AD_ACCOUNT_IDS'].filter(Boolean);
  const coverage = connected ? config.accountIds.map(accountId => current.coverage?.[accountId]?.since).filter(Boolean).sort()[0] : null;
  return {
    connected,
    accounts: connected ? config.accountIds : [],
    syncedAt: current.syncedAt || null,
    ...(coverage ? { coveredSince: coverage } : {}),
    ...(missing.length ? { missing } : {}),
    ...(connected && current.lastError?.message ? { error: current.lastError.message } : {})
  };
}

let timer = null;

/** Vòng nền mỗi 60 phút (lượt đầu ngay khi khởi động). Tắt khi chưa cấu hình hoặc đặt META_ADS_SYNC_DISABLED. */
export function startAdInsightsSync({ log = console.log, config = metaAdsConfig } = {}) {
  if (!isAdsConfigured(config) || config.syncDisabled) return null;
  const run = async () => {
    try {
      const summary = await runBackgroundAdSync({ config });
      const kinds = [...new Set(summary.ranges.map(range => range.kind))];
      if (!kinds.every(kind => kind === 'recent') || summary.stoppedEarly) {
        log(`Đồng bộ quảng cáo (${kinds.join('/')}): ${summary.rows} dòng, ${summary.campaigns} chiến dịch, dùng ${summary.usage}% giới hạn${summary.stoppedEarly ? ` — ${summary.stoppedEarly}` : ''}.`);
      }
    } catch (error) {
      log(`Đồng bộ quảng cáo lỗi: ${error.message}`);
    }
  };
  run();
  timer = setInterval(run, AD_SYNC_INTERVAL_MS);
  if (typeof timer.unref === 'function') timer.unref();
  return () => clearInterval(timer);
}
