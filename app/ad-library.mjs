// Theo dõi đối thủ bằng dữ liệu minh bạch của Meta + mẫu nhân viên dán tay.
//
// CHỈ ĐỌC: hai lệnh gọi Meta duy nhất là GET /ads_archive và GET /branded_content_search.
//
//  1. Thư viện quảng cáo (/ads_archive): quảng cáo đang chạy của Page đối thủ hoặc theo từ khoá.
//     - Token phải của NGƯỜI DÙNG đã xác minh danh tính ở facebook.com/ID; chưa xác minh → lỗi 10 / 2332002
//       (đã chạy thử 05/10/2026 với tài khoản Nông Sản Giọt Nắng: đúng lỗi này).
//     - Quảng cáo bán hàng chỉ trả về khi có hiển thị ở EU/Anh; quảng cáo chỉ chạy ở VN → rỗng. Vì vậy mỗi
//       đối thủ có nút mở Thư viện quảng cáo trên web (xem đủ quảng cáo VN) và ô dán mẫu tay.
//  2. Nội dung có thương hiệu (/branded_content_search): bài hợp tác trả phí giữa creator/KOL và nhãn hàng,
//     tìm theo URL Page hoặc tên Instagram, nội dung từ 17/08/2023. Không giới hạn EU, và chạy được với token
//     hiện có (thử 05/10/2026: trả data rỗng cho Page Giọt Nắng, không lỗi quyền) → biết đối thủ thuê KOL nào.
//
// Kho: data/processed/ad-library.json — đối thủ, quảng cáo (api|manual), bài hợp tác, lần lấy cuối, gợi ý AI.
import { randomUUID } from 'node:crypto';
import { adLibraryConfig, metaConfig } from './config.mjs';
import { createWriteQueue, readJsonFile, writeJsonAtomic } from './json-store.mjs';
import { GRAPH_TIMEOUT_MS, appSecretProof, graphEndpoint, shortenMetaError } from './meta-graph.mjs';
import { requestModelText } from './campaign-ai.mjs';
import { readChatbotSettings } from './chatbot-settings.mjs';

export const AD_LIBRARY_LIMITS = Object.freeze({
  maxCompetitors: 40,
  maxKeywords: 5,
  maxAdsPerCompetitor: 60,   // giữ tối đa 60 quảng cáo / đối thủ (mới nhất trước)
  maxBrandedPerCompetitor: 100,
  brandedDays: 180,          // lấy bài hợp tác 180 ngày gần nhất
  maxManualText: 3000,
  pageIdsPerCall: 10,        // tài liệu: search_page_ids tối đa 10 Page
  maxPages: 5,               // tối đa 5 trang kết quả mỗi lượt gọi
  pageSize: 100,
  longRunningDays: 14,       // quảng cáo còn chạy sau 14 ngày: dấu hiệu đang có lãi
  keepInsights: 10,
  maxAdsInPrompt: 25
});

// Tài liệu branded_content_search: chỉ có nội dung tạo từ ngày này trở đi.
export const BRANDED_CONTENT_SINCE = '2023-08-17';

const DAY_MS = 24 * 60 * 60 * 1000;
const VIETNAM_OFFSET_MS = 7 * 60 * 60 * 1000;
const vietnamDay = ms => new Date(Number(ms) + VIETNAM_OFFSET_MS).toISOString().slice(0, 10);

const ARCHIVE_FIELDS = [
  'id', 'page_id', 'page_name', 'ad_creation_time', 'ad_delivery_start_time', 'ad_delivery_stop_time',
  'ad_creative_bodies', 'ad_creative_link_titles', 'ad_creative_link_captions', 'ad_creative_link_descriptions',
  'publisher_platforms', 'languages'
].join(',');
const BRANDED_FIELDS = 'creation_date,creator,partners,type,url';

const text = (value, max = 200) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
const list = value => (Array.isArray(value) ? value : []);
const isDay = value => /^\d{4}-\d{2}-\d{2}$/.test(String(value || ''));

// ===== Nhận dạng liên kết =====

const digits = value => (/^\d{5,25}$/.test(String(value || '').trim()) ? String(value).trim() : '');

function urlOf(value) {
  const raw = String(value || '').trim();
  if (!raw || /\s/.test(raw)) return null;
  try {
    return new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
  } catch {
    return null;
  }
}

const isFacebookHost = url => /(^|\.)facebook\.com$/i.test(url.hostname);

/** ID Page từ: số trần, liên kết Thư viện quảng cáo (view_all_page_id=…), profile.php?id=…, hoặc …-123456789/ cuối đường dẫn. */
export function parsePageRef(input) {
  const plain = digits(input);
  if (plain) return plain;
  const url = urlOf(input);
  if (!url || !isFacebookHost(url)) return '';
  for (const key of ['view_all_page_id', 'page_id', 'search_page_ids']) {
    const found = digits(url.searchParams.get(key));
    if (found) return found;
  }
  if (/\/profile\.php$/i.test(url.pathname)) return digits(url.searchParams.get('id'));
  const tail = url.pathname.match(/-(\d{8,25})\/?$/);
  return tail ? tail[1] : '';
}

/** URL Page dùng cho branded_content_search: https://www.facebook.com/<tên-trang> (bỏ query, trừ profile.php?id=). */
export function parsePageUrl(input) {
  const url = urlOf(input);
  if (!url || !isFacebookHost(url) || /^\/ads\/library/i.test(url.pathname)) return '';
  if (/\/profile\.php$/i.test(url.pathname)) {
    const id = digits(url.searchParams.get('id'));
    return id ? `https://www.facebook.com/profile.php?id=${id}` : '';
  }
  const slug = url.pathname.replace(/^\/+|\/+$/g, '').split('/')[0];
  if (!slug || !/^[\p{L}\p{N}._-]{2,100}$/u.test(slug) || /^(groups|watch|reel|share|story\.php|permalink\.php|photo|events)$/i.test(slug)) return '';
  return `https://www.facebook.com/${slug}`;
}

/** Tên Instagram từ "@ten", "ten" hoặc instagram.com/ten/. */
export function parseIgUsername(input) {
  const raw = String(input || '').trim();
  if (!raw) return '';
  const url = /instagram\.com/i.test(raw) ? urlOf(raw) : null;
  const candidate = url ? url.pathname.replace(/^\/+|\/+$/g, '').split('/')[0] : raw.replace(/^@/, '');
  return /^[a-z0-9._]{1,30}$/i.test(candidate) ? candidate.toLowerCase() : '';
}

/** ID quảng cáo trong Thư viện từ liên kết facebook.com/ads/library/?id=… (hoặc số trần). */
export function parseLibraryAdId(input) {
  const plain = digits(input);
  if (plain) return plain;
  const url = urlOf(input);
  if (!url || !isFacebookHost(url) || !/\/ads\/library/i.test(url.pathname)) return '';
  return digits(url.searchParams.get('id'));
}

/** Liên kết Thư viện quảng cáo trên web — xem được mọi quảng cáo đang chạy ở VN (API thì không). */
export function adLibraryWebUrl({ adId = '', pageId = '', terms = '', country = 'VN' } = {}) {
  const url = new URL('https://www.facebook.com/ads/library/');
  if (adId) {
    url.searchParams.set('id', adId);
    return url.toString();
  }
  url.searchParams.set('active_status', 'active');
  url.searchParams.set('ad_type', 'all');
  url.searchParams.set('country', country || 'VN');
  url.searchParams.set('media_type', 'all');
  if (pageId) {
    url.searchParams.set('search_type', 'page');
    url.searchParams.set('view_all_page_id', pageId);
  } else {
    url.searchParams.set('q', String(terms || '').slice(0, 100));
    url.searchParams.set('search_type', 'keyword_unordered');
  }
  return url.toString();
}

// ===== Kho =====

function emptyStore() {
  return { competitors: [], ads: [], branded: [], lastSync: null, insights: [] };
}

function normalizeStore(value) {
  return {
    competitors: list(value.competitors).filter(item => item?.id && item?.name),
    ads: list(value.ads).filter(item => item?.key && item?.competitorId),
    branded: list(value.branded).filter(item => item?.key && item?.competitorId),
    lastSync: value.lastSync && typeof value.lastSync === 'object' ? value.lastSync : null,
    insights: list(value.insights).filter(item => item?.generatedAt)
  };
}

export async function readAdLibrary(filePath = adLibraryConfig.path) {
  return readJsonFile(filePath, { fallback: emptyStore, normalize: normalizeStore, label: 'Kho theo dõi đối thủ' });
}

const enqueueWrite = createWriteQueue();

/** Đọc → sửa → ghi tuần tự (thêm đối thủ và lượt lấy dữ liệu trùng lúc không đè nhau). */
export function updateAdLibrary(mutate, filePath = adLibraryConfig.path) {
  return enqueueWrite(async () => {
    const store = await readAdLibrary(filePath);
    const result = await mutate(store);
    await writeJsonAtomic(filePath, store);
    return result;
  });
}

// ===== Đối thủ & mẫu dán tay =====

function inputError(message) {
  const error = new Error(message);
  error.statusCode = 400;
  return error;
}

/** {name, page, ig, keywords, note} → đối thủ. `page` nhận ID, liên kết Thư viện quảng cáo hoặc liên kết Page. */
export function normalizeCompetitorInput(input = {}) {
  const name = text(input.name, 80);
  if (!name) throw inputError('Nhập tên đối thủ.');
  const pageRef = text(input.page, 300);
  const pageId = parsePageRef(pageRef);
  const pageUrl = parsePageUrl(pageRef);
  if (pageRef && !pageId && !pageUrl) throw inputError('Không đọc được Page. Dán liên kết Page (facebook.com/ten-trang), số ID, hoặc liên kết Thư viện quảng cáo có "view_all_page_id=…".');
  const igRef = text(input.ig, 200);
  const igUsername = parseIgUsername(igRef);
  if (igRef && !igUsername) throw inputError('Tên Instagram không hợp lệ (ví dụ: @tenshop hoặc instagram.com/tenshop).');
  const keywords = [...new Set((Array.isArray(input.keywords) ? input.keywords : String(input.keywords || '').split(','))
    .map(item => text(item, 100)).filter(Boolean))].slice(0, AD_LIBRARY_LIMITS.maxKeywords);
  if (!pageId && !pageUrl && !igUsername && !keywords.length) throw inputError('Cần Page, tên Instagram hoặc ít nhất một từ khoá để theo dõi đối thủ.');
  return { name, pageId, pageUrl, igUsername, keywords, note: text(input.note, 300) };
}

export function addCompetitor(store, input, { by = '', now = Date.now() } = {}) {
  const value = normalizeCompetitorInput(input);
  if (store.competitors.length >= AD_LIBRARY_LIMITS.maxCompetitors) throw inputError(`Tối đa ${AD_LIBRARY_LIMITS.maxCompetitors} đối thủ.`);
  const same = store.competitors.find(item => (value.pageId && item.pageId === value.pageId)
    || (value.pageUrl && item.pageUrl?.toLowerCase() === value.pageUrl.toLowerCase())
    || (value.igUsername && item.igUsername === value.igUsername));
  if (same) throw inputError(`Đối thủ này đã có trong danh sách (${same.name}).`);
  const competitor = { id: randomUUID().slice(0, 8), ...value, addedAt: now, addedBy: by };
  store.competitors.push(competitor);
  return competitor;
}

export function removeCompetitor(store, id) {
  const competitor = store.competitors.find(item => item.id === id);
  if (!competitor) return null;
  store.competitors = store.competitors.filter(item => item.id !== id);
  store.ads = store.ads.filter(ad => ad.competitorId !== id);
  store.branded = store.branded.filter(post => post.competitorId !== id);
  return competitor;
}

/** Mẫu nhân viên chép từ Thư viện quảng cáo web: nội dung + (tuỳ chọn) liên kết quảng cáo, ngày bắt đầu chạy. */
export function addManualAd(store, input = {}, { by = '', now = Date.now() } = {}) {
  const competitor = store.competitors.find(item => item.id === String(input.competitorId || ''));
  if (!competitor) throw inputError('Chọn đối thủ cho mẫu quảng cáo.');
  const body = String(input.text ?? '').replace(/\r\n?/g, '\n').trim().slice(0, AD_LIBRARY_LIMITS.maxManualText);
  if (body.length < 10) throw inputError('Dán nội dung quảng cáo (ít nhất 10 ký tự).');
  const link = text(input.link, 500);
  const libraryId = parseLibraryAdId(link);
  if (link && !libraryId) throw inputError('Liên kết phải là liên kết quảng cáo trong Thư viện (facebook.com/ads/library/?id=…).');
  const startDate = isDay(input.startDate) ? input.startDate : '';
  if (startDate && startDate > vietnamDay(now)) throw inputError('Ngày bắt đầu chạy không được ở tương lai.');
  if (libraryId && store.ads.some(ad => ad.libraryId === libraryId)) throw inputError('Quảng cáo này đã có trong danh sách.');
  const ad = {
    key: `m:${randomUUID().slice(0, 10)}`,
    source: 'manual',
    competitorId: competitor.id,
    libraryId,
    pageId: competitor.pageId,
    pageName: competitor.name,
    texts: [body],
    titles: [],
    captions: [],
    platforms: [],
    startDate,
    stopDate: '',
    active: true,
    note: text(input.note, 300),
    addedAt: now,
    addedBy: by
  };
  store.ads.unshift(ad);
  return ad;
}

export function removeAd(store, key) {
  const ad = store.ads.find(item => item.key === key);
  if (!ad) return null;
  store.ads = store.ads.filter(item => item.key !== key);
  return ad;
}

// ===== Gọi Graph API =====

/** Lỗi Graph → câu tiếng Việt nói rõ phải làm gì. `edge` = 'ads_archive' | 'branded_content_search'. */
export function adLibraryError(payload, status, edge = 'ads_archive') {
  const error = payload?.error || {};
  const code = Number(error.code);
  const subcode = Number(error.error_subcode);
  const raw = String(error.message || '');
  const branded = edge === 'branded_content_search';
  let message;
  if (!branded && (code === 10 || subcode === 2332002 || subcode === 2332004)) {
    message = 'Meta chưa cho tài khoản này dùng API Thư viện quảng cáo (lỗi 10/2332002). Chủ tài khoản tạo token phải xác minh danh tính tại facebook.com/ID rồi làm theo các bước ở facebook.com/ads/library/api. Trong lúc chờ: dùng nút "Mở Thư viện" và dán mẫu tay; phần KOL/creator hợp tác vẫn lấy được.';
  } else if (branded && code === 10) {
    message = 'Meta chưa cho token này dùng tìm kiếm nội dung có thương hiệu (lỗi 10). Kiểm tra token người dùng ở META_AD_LIBRARY_TOKEN.';
  } else if (code === 190 || code === 102) {
    message = 'Token theo dõi đối thủ đã hết hạn hoặc bị thu hồi. Tạo token người dùng mới (Graph API Explorer → Generate Access Token, đổi sang token dài hạn) rồi đặt vào META_AD_LIBRARY_TOKEN.';
  } else if ([4, 17, 32, 613].includes(code)) {
    message = 'Meta đang giới hạn số lần gọi; thử lại sau ít phút.';
  } else if (code === 100 && /instagram account name/i.test(raw)) {
    message = 'Meta không tìm thấy tài khoản Instagram này — kiểm tra lại tên Instagram của đối thủ.';
  } else if (code === 100 && /page url/i.test(raw)) {
    message = 'Meta không nhận liên kết Page này — mở Page đối thủ, chép đúng địa chỉ trên thanh trình duyệt.';
  } else if ([100, 1009, 2500].includes(code)) {
    message = `Meta từ chối tham số tìm kiếm: ${shortenMetaError(raw) || 'tham số không hợp lệ'}.`;
  } else {
    message = `${branded ? 'Tìm nội dung có thương hiệu' : 'API Thư viện quảng cáo'} báo lỗi${status ? ` ${status}` : ''}: ${shortenMetaError(raw) || 'không rõ nguyên nhân'}.`;
  }
  const wrapped = new Error(message);
  wrapped.statusCode = status || 502;
  if (Number.isFinite(code)) wrapped.graphCode = code;
  if (Number.isFinite(subcode)) wrapped.graphSubcode = subcode;
  wrapped.graphMessage = raw;
  return wrapped;
}

/** Lỗi làm cả nguồn hỏng (quyền, token, giới hạn, mạng) — khác lỗi tham số của riêng một đối thủ. */
const isFatal = error => !error.graphCode || [10, 190, 102, 4, 17, 32, 613].includes(error.graphCode);

/** Tham số /ads_archive đúng tài liệu: mảng viết dạng ['VN'] / [123], từ khoá ≤ 100 ký tự. */
export function buildArchiveParams({ pageIds = [], terms = '', countries = ['VN'], activeStatus = 'ACTIVE', limit = AD_LIBRARY_LIMITS.pageSize } = {}) {
  const params = {
    ad_reached_countries: JSON.stringify(countries).replace(/"/g, "'"),
    ad_type: 'ALL',
    ad_active_status: activeStatus,
    fields: ARCHIVE_FIELDS,
    limit: String(limit)
  };
  if (pageIds.length) params.search_page_ids = `[${pageIds.slice(0, AD_LIBRARY_LIMITS.pageIdsPerCall).join(',')}]`;
  if (terms) params.search_terms = String(terms).slice(0, 100);
  return params;
}

/** Tham số /branded_content_search: page_url HOẶC ig_username, creation_date_min/max bắt buộc. */
export function buildBrandedParams({ pageUrl = '', igUsername = '', since, until, limit = AD_LIBRARY_LIMITS.pageSize } = {}) {
  const params = { creation_date_min: since, creation_date_max: until, fields: BRANDED_FIELDS, limit: String(limit) };
  if (pageUrl) params.page_url = pageUrl;
  else params.ig_username = igUsername;
  return params;
}

async function fetchJson(url, fetchImpl, edge) {
  let response;
  const signal = AbortSignal.timeout(GRAPH_TIMEOUT_MS);
  try {
    response = await fetchImpl(url, { method: 'GET', signal });
  } catch (error) {
    const reason = error?.name === 'TimeoutError' || signal.aborted ? `quá ${GRAPH_TIMEOUT_MS / 1000} giây không trả lời` : (error?.cause?.code || error?.message || error);
    throw new Error(`Không kết nối được tới Facebook (graph.facebook.com): ${reason}.`);
  }
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload?.error) throw adLibraryError(payload, response.status, edge);
  return payload;
}

function edgeUrl(edge, params, config, withProof) {
  const url = graphEndpoint(edge, config.graphVersion || 'v26.0');
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  url.searchParams.set('access_token', config.accessToken);
  const secret = config.appSecret ?? metaConfig.appSecret;
  if (withProof && secret) url.searchParams.set('appsecret_proof', appSecretProof(config.accessToken, secret));
  return url;
}

/** GET một edge tìm kiếm, đi tối đa `maxPages` trang. Token của app khác app CRM → appsecret_proof sai → thử lại không kèm proof. */
export async function fetchGraphSearch(edge, params, { config = adLibraryConfig, fetchImpl = fetch, maxPages = AD_LIBRARY_LIMITS.maxPages } = {}) {
  let first;
  try {
    first = await fetchJson(edgeUrl(edge, params, config, true), fetchImpl, edge);
  } catch (error) {
    if (!/appsecret_proof/i.test(error.graphMessage || '')) throw error;
    first = await fetchJson(edgeUrl(edge, params, config, false), fetchImpl, edge);
  }
  const items = [...list(first.data)];
  let next = first.paging?.next;
  for (let page = 1; next && page < maxPages; page += 1) {
    const body = await fetchJson(next, fetchImpl, edge);
    // Tài liệu: trang có data rỗng = hết kết quả.
    if (!list(body.data).length) break;
    items.push(...body.data);
    next = body.paging?.next;
  }
  return items;
}

/** Một ArchivedAd → dòng của kho. Không giữ ad_snapshot_url (chứa access_token). */
export function parseArchivedAd(raw = {}, competitorId = '', now = Date.now()) {
  const strings = value => list(value).map(item => String(item || '').trim()).filter(Boolean).slice(0, 10);
  const day = value => (value ? String(value).slice(0, 10) : '');
  const stopDate = day(raw.ad_delivery_stop_time);
  return {
    key: `a:${raw.id}`,
    source: 'api',
    competitorId,
    libraryId: String(raw.id || ''),
    pageId: String(raw.page_id || ''),
    pageName: text(raw.page_name, 120),
    texts: strings(raw.ad_creative_bodies).map(item => item.slice(0, AD_LIBRARY_LIMITS.maxManualText)),
    titles: strings(raw.ad_creative_link_titles),
    captions: strings([...list(raw.ad_creative_link_captions), ...list(raw.ad_creative_link_descriptions)]),
    platforms: strings(raw.publisher_platforms).map(item => item.toUpperCase()),
    startDate: day(raw.ad_delivery_start_time || raw.ad_creation_time),
    stopDate,
    active: !stopDate || stopDate >= vietnamDay(now),
    fetchedAt: now
  };
}

const safeHttpUrl = value => {
  const url = urlOf(value);
  return url && /^https?:$/.test(url.protocol) ? url.toString() : '';
};

function brandedEntity(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const name = text(raw.name, 120);
  if (!name && !raw.id) return null;
  return { id: String(raw.id || ''), name: name || String(raw.id), url: safeHttpUrl(raw.url) };
}

/** Một BrandedContentSearch → bài hợp tác của kho. `role`: đối thủ là người đăng (creator) hay nhãn hàng trả tiền (partner). */
export function parseBrandedContent(raw = {}, competitor = {}, now = Date.now()) {
  const creator = brandedEntity(raw.creator);
  const partners = list(raw.partners).map(brandedEntity).filter(Boolean).slice(0, 10);
  const url = safeHttpUrl(raw.url);
  const ownName = foldVietnamese(competitor.name || '');
  const ownIg = competitor.igUsername || '';
  const isCreator = creator && (foldVietnamese(creator.name) === ownName || (ownIg && foldVietnamese(creator.name) === ownIg) || (creator.url && competitor.pageUrl && creator.url.toLowerCase().startsWith(competitor.pageUrl.toLowerCase())));
  return {
    key: `b:${url || `${creator?.id}:${raw.creation_date}`}`,
    competitorId: competitor.id || '',
    date: String(raw.creation_date || '').slice(0, 10),
    type: text(raw.type, 40).toUpperCase(),
    url,
    creator,
    partners,
    role: isCreator ? 'creator' : 'partner',
    fetchedAt: now
  };
}

export function isAdLibraryConfigured(config = adLibraryConfig) {
  return Boolean(config.accessToken);
}

/** Quảng cáo đang chạy của mọi đối thủ (Page có ID gom 10 Page/lượt; còn lại tìm theo từ khoá). */
async function collectAds(competitors, { config, fetchImpl, now }) {
  const byPage = new Map(competitors.filter(item => item.pageId).map(item => [item.pageId, item]));
  const fetched = new Map();
  const countries = config.countries?.length ? config.countries : ['VN'];
  const pageIds = [...byPage.keys()];
  for (let index = 0; index < pageIds.length; index += AD_LIBRARY_LIMITS.pageIdsPerCall) {
    const batch = pageIds.slice(index, index + AD_LIBRARY_LIMITS.pageIdsPerCall);
    for (const pageId of batch) fetched.set(byPage.get(pageId).id, []);
    for (const raw of await fetchGraphSearch('ads_archive', buildArchiveParams({ pageIds: batch, countries }), { config, fetchImpl })) {
      const owner = byPage.get(String(raw.page_id));
      if (owner) fetched.get(owner.id).push(parseArchivedAd(raw, owner.id, now));
    }
  }
  for (const competitor of competitors.filter(item => !item.pageId && item.keywords?.length)) {
    fetched.set(competitor.id, []);
    for (const terms of competitor.keywords) {
      const found = await fetchGraphSearch('ads_archive', buildArchiveParams({ terms, countries }), { config, fetchImpl });
      fetched.get(competitor.id).push(...found.map(raw => parseArchivedAd(raw, competitor.id, now)));
    }
  }
  return { fetched, countries };
}

/** Bài hợp tác KOL/creator của từng đối thủ có URL Page hoặc tên Instagram. Lỗi tham số của một đối thủ không chặn đối thủ khác. */
async function collectBranded(competitors, { config, fetchImpl, now }) {
  const until = vietnamDay(now);
  const floor = vietnamDay(now - (AD_LIBRARY_LIMITS.brandedDays - 1) * DAY_MS);
  const since = floor > BRANDED_CONTENT_SINCE ? floor : BRANDED_CONTENT_SINCE;
  const fetched = new Map();
  const warnings = [];
  for (const competitor of competitors.filter(item => item.pageUrl || item.igUsername)) {
    const posts = [];
    try {
      // Có cả Page và Instagram: tìm cả hai (bài IG có thể không gắn Page).
      const targets = [competitor.pageUrl && { pageUrl: competitor.pageUrl }, competitor.igUsername && { igUsername: competitor.igUsername }].filter(Boolean);
      for (const target of targets) {
        const found = await fetchGraphSearch('branded_content_search', buildBrandedParams({ ...target, since, until }), { config, fetchImpl });
        posts.push(...found.map(raw => parseBrandedContent(raw, competitor, now)));
      }
      fetched.set(competitor.id, posts);
    } catch (error) {
      if (isFatal(error)) throw error;
      warnings.push(`${competitor.name}: ${error.message}`);
    }
  }
  return { fetched, warnings, since, until };
}

/**
 * Lấy dữ liệu mọi đối thủ từ hai nguồn. Mỗi nguồn hỏng riêng (vd. Thư viện quảng cáo chưa xác minh danh tính
 * nhưng nội dung có thương hiệu vẫn chạy): ghi lỗi của nguồn đó, nguồn kia vẫn cập nhật. Chỉ thay dữ liệu API của
 * đối thủ đã lấy được; mẫu dán tay giữ nguyên.
 */
export async function syncCompetitors({ config = adLibraryConfig, fetchImpl = fetch, now = Date.now(), filePath = config.path } = {}) {
  if (!isAdLibraryConfigured(config)) {
    throw inputError('Chưa có token để theo dõi đối thủ: đặt META_AD_LIBRARY_TOKEN (token người dùng) trong .env rồi khởi động lại CRM.');
  }
  const { competitors } = await readAdLibrary(filePath);
  if (!competitors.length) throw inputError('Chưa có đối thủ nào. Thêm đối thủ trước.');

  let ads = null;
  let adsError = '';
  try {
    ads = await collectAds(competitors, { config, fetchImpl, now });
  } catch (error) {
    adsError = error.message;
  }
  let branded = null;
  let brandedError = '';
  try {
    branded = await collectBranded(competitors, { config, fetchImpl, now });
  } catch (error) {
    brandedError = error.message;
  }

  return updateAdLibrary(current => {
    const known = new Set(current.competitors.map(item => item.id));
    let adsFound = 0;
    if (ads) {
      const synced = new Set([...ads.fetched.keys()].filter(id => known.has(id)));
      const fresh = [];
      for (const [competitorId, items] of ads.fetched) {
        if (!synced.has(competitorId)) continue;
        fresh.push(...[...new Map(items.filter(ad => ad.libraryId).map(ad => [ad.libraryId, ad])).values()]
          .sort((first, second) => second.startDate.localeCompare(first.startDate))
          .slice(0, AD_LIBRARY_LIMITS.maxAdsPerCompetitor));
      }
      const apiIds = new Set(fresh.map(ad => ad.libraryId));
      // Mẫu dán tay trùng ID với quảng cáo API: giữ bản API (đủ trường hơn).
      current.ads = [...fresh, ...current.ads.filter(ad => (ad.source !== 'api' || !synced.has(ad.competitorId)) && !(ad.source === 'manual' && ad.libraryId && apiIds.has(ad.libraryId)))];
      adsFound = fresh.length;
    }
    let brandedFound = 0;
    if (branded) {
      const synced = new Set([...branded.fetched.keys()].filter(id => known.has(id)));
      const fresh = [];
      for (const [competitorId, items] of branded.fetched) {
        if (!synced.has(competitorId)) continue;
        fresh.push(...[...new Map(items.map(post => [post.key, post])).values()]
          .sort((first, second) => second.date.localeCompare(first.date))
          .slice(0, AD_LIBRARY_LIMITS.maxBrandedPerCompetitor));
      }
      current.branded = [...fresh, ...current.branded.filter(post => !synced.has(post.competitorId))];
      brandedFound = fresh.length;
    }
    const previous = current.lastSync || {};
    current.lastSync = {
      at: now,
      ads: ads ? { at: now, found: adsFound, countries: ads.countries } : { ...(previous.ads || {}), error: adsError, errorAt: now },
      branded: branded
        ? { at: now, found: brandedFound, since: branded.since, until: branded.until, ...(branded.warnings.length ? { warnings: branded.warnings.slice(0, 10) } : {}) }
        : { ...(previous.branded || {}), error: brandedError, errorAt: now }
    };
    return { ads: current.lastSync.ads, branded: current.lastSync.branded };
  }, filePath);
}

// ===== Phân tích =====

/** Bỏ dấu tiếng Việt để bắt mẫu chữ ổn định ("Miễn phí" = "mien phi"). */
export function foldVietnamese(value) {
  return String(value || '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D').toLowerCase().trim();
}

export const OFFER_PATTERNS = Object.freeze([
  { key: 'freeship', label: 'Miễn phí vận chuyển', pattern: /free ?ship|mien phi (van chuyen|ship|giao)|bao ship/ },
  { key: 'gift', label: 'Tặng quà', pattern: /\btang\b|qua tang|mua \d+ tang|nhan ngay \d/ },
  { key: 'discount', label: 'Giảm giá / % sale', pattern: /giam( gia)? ?\d|\d+ ?%|\bsale\b|khuyen mai|\bkm\b|dong gia|voucher/ },
  { key: 'combo', label: 'Combo / set', pattern: /combo|\bset\b|\bbo \d|mua \d+|mua tu \d/ },
  // "100k+ lượt bán" là số đã bán, không phải giá: bỏ con số có dấu + ngay sau.
  { key: 'price', label: 'Nêu giá cụ thể', pattern: /\d[\d.,]*\s?(k|d|vnd|nghin|ngan)\b(?!\s?\+)|\d{2,3}\.000/ },
  { key: 'urgency', label: 'Khan hiếm / gấp', pattern: /chi con|so luong (co han|gioi han)|hom nay|duy nhat|sap het|het hang|chay hang|cuoi cung|flash|\bdeal\b|chot ngay|chot voi|keo lo/ },
  { key: 'guarantee', label: 'Cam kết / đổi trả', pattern: /hoan tien|doi tra|cam ket|bao hanh|khong ngon/ },
  { key: 'social', label: 'Số đã bán / khách mua lại', pattern: /feedback|danh gia|khach (hang )?(noi|chia se|khen)|khach cu|mua (di mua )?lai|luot ban|da ban|\d+k\+|best ?seller|ban chay/ },
  { key: 'creator', label: 'KOL / KOC review', pattern: /\bkoc\b|\bkol\b|review|reviewer|influencer/ },
  { key: 'health', label: 'Sức khoẻ / giảm cân / ít đường', pattern: /giam can|eat ?clean|an kieng|healthy|giu dang|tieu duong|it duong|khong duong|chat xo|protein|calo/ },
  { key: 'live', label: 'Livestream', pattern: /\blive\b|livestream|phat truc tiep/ }
]);

export function detectOffers(value) {
  const folded = foldVietnamese(value);
  return OFFER_PATTERNS.filter(item => item.pattern.test(folded)).map(item => item.key);
}

const offerLabel = key => OFFER_PATTERNS.find(item => item.key === key)?.label || key;

export function adText(ad) {
  return [...list(ad.texts), ...list(ad.titles), ...list(ad.captions)].join('\n');
}

/** Số ngày quảng cáo đã chạy (tới ngày dừng, hoặc hôm nay nếu còn chạy). null = không rõ ngày bắt đầu. */
export function daysRunning(ad, now = Date.now()) {
  if (!isDay(ad?.startDate)) return null;
  const end = ad.stopDate && isDay(ad.stopDate) && ad.stopDate < vietnamDay(now) ? ad.stopDate : vietnamDay(now);
  return Math.max(1, Math.round((Date.parse(`${end}T00:00:00Z`) - Date.parse(`${ad.startDate}T00:00:00Z`)) / DAY_MS) + 1);
}

const BRANDED_TYPE_LABELS = { FACEBOOK_POST: 'Bài Facebook', INSTAGRAM_POST: 'Bài Instagram', INSTAGRAM_STORY: 'Story Instagram', INSTAGRAM_REEL: 'Reel Instagram' };
export const brandedTypeLabel = type => BRANDED_TYPE_LABELS[String(type || '').toUpperCase()] || (type ? String(type) : 'Khác');

/** Người hợp tác với đối thủ trong một bài: đối thủ đăng → các nhãn hàng; đối thủ là nhãn hàng → người đăng. */
function collaboratorsOf(post) {
  return post.role === 'creator' ? list(post.partners) : [post.creator].filter(Boolean);
}

/** Tín hiệu thị trường: theo đối thủ, ưu đãi phổ biến, quảng cáo chạy lâu, KOL/creator hợp tác. */
export function marketSignals(store = {}, now = Date.now()) {
  const competitors = list(store.competitors);
  const ads = list(store.ads);
  const branded = list(store.branded);
  const decorated = ads.map(ad => ({ ad, offers: detectOffers(adText(ad)), days: daysRunning(ad, now) }));
  const since90 = vietnamDay(now - 89 * DAY_MS);
  const perCompetitor = competitors.map(competitor => {
    const own = decorated.filter(item => item.ad.competitorId === competitor.id);
    const offers = {};
    for (const item of own) for (const key of item.offers) offers[key] = (offers[key] || 0) + 1;
    const posts = branded.filter(post => post.competitorId === competitor.id);
    const collaborators = new Map();
    for (const post of posts) for (const entity of collaboratorsOf(post)) collaborators.set(entity.id || entity.name, entity.name);
    const types = {};
    for (const post of posts) types[brandedTypeLabel(post.type)] = (types[brandedTypeLabel(post.type)] || 0) + 1;
    return {
      id: competitor.id,
      name: competitor.name,
      ads: own.length,
      active: own.filter(item => item.ad.active !== false).length,
      longestDays: own.reduce((max, item) => Math.max(max, item.days || 0), 0),
      offers,
      brandedPosts: posts.length,
      brandedLast90: posts.filter(post => post.date >= since90).length,
      collaborators: [...collaborators.values()].slice(0, 15),
      brandedTypes: types
    };
  });
  const offerUse = {};
  for (const row of perCompetitor) for (const key of Object.keys(row.offers)) offerUse[key] = (offerUse[key] || 0) + 1;
  const commonOffers = Object.entries(offerUse)
    .map(([key, competitorsUsing]) => ({ key, label: offerLabel(key), competitors: competitorsUsing, ads: decorated.filter(item => item.offers.includes(key)).length }))
    .sort((first, second) => second.competitors - first.competitors || second.ads - first.ads);
  const nameOf = id => competitors.find(item => item.id === id)?.name || '';
  const longRunning = decorated
    .filter(item => item.ad.active !== false && (item.days || 0) >= AD_LIBRARY_LIMITS.longRunningDays)
    .sort((first, second) => second.days - first.days)
    .slice(0, 10)
    .map(item => ({ key: item.ad.key, competitor: nameOf(item.ad.competitorId), days: item.days, offers: item.offers.map(offerLabel), excerpt: text(adText(item.ad), 220) }));
  // Creator/KOL làm với nhiều bài / nhiều đối thủ nhất.
  const creators = new Map();
  for (const post of branded) {
    for (const entity of collaboratorsOf(post)) {
      const key = entity.id || entity.name;
      const row = creators.get(key) || { name: entity.name, url: entity.url || '', posts: 0, competitors: new Set(), lastDate: '' };
      row.posts += 1;
      row.competitors.add(nameOf(post.competitorId));
      if (post.date > row.lastDate) row.lastDate = post.date;
      creators.set(key, row);
    }
  }
  const topCreators = [...creators.values()]
    .map(row => ({ ...row, competitors: [...row.competitors].filter(Boolean) }))
    .sort((first, second) => second.competitors.length - first.competitors.length || second.posts - first.posts)
    .slice(0, 15);
  const brandedTypes = {};
  for (const post of branded) brandedTypes[brandedTypeLabel(post.type)] = (brandedTypes[brandedTypeLabel(post.type)] || 0) + 1;
  return {
    competitors: competitors.length,
    ads: ads.length,
    activeAds: ads.filter(ad => ad.active !== false).length,
    brandedPosts: branded.length,
    perCompetitor,
    commonOffers,
    longRunning,
    topCreators,
    brandedTypes
  };
}

/** Gợi ý theo luật (không cần AI): ưu đãi nhiều đối thủ cùng dùng, quảng cáo chạy lâu, KOL hợp tác. */
export function ruleMarketIdeas(signals = {}) {
  const ideas = [];
  // Mẫu số là đối thủ ĐÃ có quảng cáo trong kho — đối thủ chưa dán mẫu không nói được là "không dùng" ưu đãi.
  const total = list(signals.perCompetitor).filter(row => row.ads > 0).length;
  if (!Number(signals.ads) && !Number(signals.brandedPosts)) {
    return [{ kind: 'research', title: 'Chưa có dữ liệu đối thủ để phân tích', detail: 'Bấm "Lấy dữ liệu" để kéo bài hợp tác KOL, rồi "Mở Thư viện" ở từng đối thủ, chép 3–5 quảng cáo đang chạy lâu nhất vào ô "Dán mẫu quảng cáo".', competitors: [] }];
  }
  for (const offer of list(signals.commonOffers).filter(item => item.competitors >= Math.max(2, Math.ceil(total / 2))).slice(0, 3)) {
    ideas.push({ kind: 'offer', title: `${offer.competitors}/${total} đối thủ dùng "${offer.label}"`, detail: `Có ${offer.ads} quảng cáo đối thủ dùng kiểu này. Nếu chiến dịch của mình chưa có, thử một nhóm quảng cáo nhỏ với ưu đãi tương tự (ngân sách thấp 3–5 ngày rồi so CPA).`, competitors: [] });
  }
  for (const item of list(signals.longRunning).slice(0, 3)) {
    ideas.push({ kind: 'creative', title: `${item.competitor}: quảng cáo chạy ${item.days} ngày`, detail: `Quảng cáo còn chạy lâu thường là quảng cáo có lãi. Tham khảo góc nội dung${item.offers.length ? ` (${item.offers.join(', ')})` : ''}: "${item.excerpt.slice(0, 120)}…"`, competitors: [item.competitor] });
  }
  const shared = list(signals.topCreators).filter(item => item.competitors.length >= 2).slice(0, 2);
  for (const creator of shared) {
    ideas.push({ kind: 'audience', title: `${creator.name} hợp tác với ${creator.competitors.length} đối thủ`, detail: `Creator này đã làm bài hợp tác cho ${creator.competitors.join(', ')} (${creator.posts} bài). Tệp người theo dõi của họ đúng ngành: cân nhắc liên hệ hợp tác, hoặc nhắm quảng cáo tới người quan tâm tới creator này.`, competitors: creator.competitors });
  }
  const busy = list(signals.perCompetitor).filter(row => row.brandedLast90 >= 3).sort((first, second) => second.brandedLast90 - first.brandedLast90).slice(0, 2);
  for (const row of busy) {
    const mainType = Object.entries(row.brandedTypes).sort((first, second) => second[1] - first[1])[0]?.[0] || '';
    ideas.push({ kind: 'test', title: `${row.name}: ${row.brandedLast90} bài hợp tác KOL trong 90 ngày`, detail: `Đối thủ đang đẩy mạnh KOL/creator${mainType ? `, chủ yếu dạng ${mainType}` : ''}${row.collaborators.length ? ` (vd. ${row.collaborators.slice(0, 3).join(', ')})` : ''}. Thử 1–2 creator nhỏ (micro) với mã ưu đãi riêng để đo đơn.`, competitors: [row.name] });
  }
  if (!ideas.length) ideas.push({ kind: 'research', title: 'Chưa thấy mẫu chung', detail: 'Các đối thủ chưa dùng chung ưu đãi nào, chưa có quảng cáo chạy quá 14 ngày và chưa có KOL chung. Dán thêm mẫu quảng cáo (ghi ngày bắt đầu chạy) để thấy rõ hơn.', competitors: [] });
  return ideas;
}

// ===== AI gợi ý =====

export const IDEA_KINDS = Object.freeze(['offer', 'creative', 'audience', 'test', 'research']);

export const marketAiSystemPrompt = [
  'Bạn là chuyên viên quảng cáo Facebook cẩn trọng, cố vấn cho Giọt Nắng — shop nhỏ bán đồ ăn lành mạnh (granola, hạt, ngũ cốc) qua Messenger và landing page, tiền VND.',
  'Bạn nhận: (1) quảng cáo đối thủ (nội dung, số ngày đã chạy, ưu đãi hệ thống nhận ra), (2) bài hợp tác trả phí giữa đối thủ và creator/KOL (ai, dạng bài, bao nhiêu), (3) số liệu chiến dịch của chính shop (chi, đơn, CPA, ROAS).',
  'Quảng cáo đối thủ chạy càng lâu càng có khả năng đang có lãi; nhiều đối thủ cùng dùng một ưu đãi là chuẩn thị trường; creator làm cho nhiều đối thủ là creator có tệp đúng ngành.',
  'Nhiệm vụ: 3–6 gợi ý CỤ THỂ, áp dụng được ngay cho chiến dịch của shop: góc nội dung/hook, ưu đãi, tệp khách/KOL, hoặc bài thử A/B nhỏ. Mỗi gợi ý nêu rõ dựa trên dữ liệu đối thủ nào và áp vào chiến dịch nào (campaignId) nếu có.',
  'Quy tắc: KHÔNG chép nguyên văn quảng cáo đối thủ, không dùng tên/thương hiệu đối thủ trong nội dung đề xuất cho shop. Không bịa số. Không khuyên tăng/giảm ngân sách (đã có phần Cố vấn chiến dịch). Ưu đãi đề xuất phải nhỏ, thử được với ngân sách thấp. Chỉ dùng campaignId có trong dữ liệu.',
  'Trả về DUY NHẤT một JSON, không markdown:',
  '{"summary":"2–4 câu tóm tắt đối thủ đang làm gì và shop nên thử gì trước","ideas":[{"kind":"offer|creative|audience|test|research","title":"tiêu đề ngắn","detail":"1–3 câu cách làm cụ thể","competitors":["tên đối thủ làm căn cứ"],"campaignId":"id chiến dịch của shop nếu áp vào một chiến dịch, không thì để trống"}]}'
].join('\n');

export function buildMarketPrompt(store = {}, report = {}, { now = Date.now() } = {}) {
  const signals = marketSignals(store, now);
  const nameOf = id => list(store.competitors).find(item => item.id === id)?.name || '';
  const ads = list(store.ads)
    .map(ad => ({ ad, days: daysRunning(ad, now) || 0 }))
    .sort((first, second) => second.days - first.days)
    .slice(0, AD_LIBRARY_LIMITS.maxAdsInPrompt)
    .map(({ ad, days }) => ({
      doiThu: nameOf(ad.competitorId),
      soNgayChay: days || null,
      dangChay: ad.active !== false,
      uuDai: detectOffers(adText(ad)).map(offerLabel),
      noiDung: text(adText(ad), 500)
    }));
  const totals = report.totals || {};
  const campaigns = list(report.campaigns).filter(item => item?.source === 'meta' && Number(item.spend) > 0).slice(0, 12).map(item => ({
    campaignId: String(item.id), ten: text(item.name, 100), trangThai: item.status || '',
    chi: Math.round(Number(item.spend) || 0), tinNhan: Number(item.messages) || 0, don: Number(item.orders) || 0,
    cpa: item.cpa === null || item.cpa === undefined ? null : Math.round(item.cpa), roas: item.roas === null || item.roas === undefined ? null : Math.round(item.roas * 100) / 100
  }));
  const payload = {
    doiThu: signals.perCompetitor.map(row => ({
      ten: row.name, soQuangCao: row.ads, dangChay: row.active, chayLauNhat: row.longestDays, uuDai: Object.keys(row.offers).map(offerLabel),
      baiHopTacKOL: row.brandedPosts, baiHopTac90Ngay: row.brandedLast90, dangBai: row.brandedTypes, nguoiHopTac: row.collaborators.slice(0, 8)
    })),
    uuDaiPhoBien: signals.commonOffers.map(item => ({ uuDai: item.label, soDoiThu: item.competitors, soQuangCao: item.ads })),
    creatorNoiBat: signals.topCreators.slice(0, 10).map(item => ({ ten: item.name, soBai: item.posts, doiThu: item.competitors, ganNhat: item.lastDate })),
    quangCaoDoiThu: ads,
    shop: {
      khoangNgay: report.range ? `${report.range.since} → ${report.range.until}` : '',
      chi: Math.round(Number(totals.spend) || 0), don: Number(totals.orders) || 0,
      cpa: totals.cpa ? Math.round(totals.cpa) : null, roas: totals.roas ? Math.round(totals.roas * 100) / 100 : null,
      chienDich: campaigns
    }
  };
  return `Dữ liệu (JSON):\n${JSON.stringify(payload)}`;
}

function parseJsonAnswer(answer) {
  const raw = String(answer || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const parsed = JSON.parse(raw.slice(start, end + 1));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** Kiểm câu trả lời: kẹp kind, bỏ campaignId lạ và tên đối thủ bịa, giới hạn độ dài và số gợi ý. */
export function validateMarketAnswer(parsed, report = {}, store = {}) {
  if (!parsed || typeof parsed !== 'object') return null;
  const summary = text(parsed.summary, 1200);
  const known = new Map(list(report.campaigns).map(item => [String(item.id), item]));
  const names = new Set(list(store.competitors).map(item => item.name));
  const ideas = [];
  for (const item of list(parsed.ideas)) {
    if (!item || typeof item !== 'object') continue;
    const title = text(item.title, 120);
    const detail = text(item.detail, 600);
    if (!title || !detail) continue;
    const kind = IDEA_KINDS.includes(String(item.kind)) ? String(item.kind) : 'creative';
    const campaign = known.get(String(item.campaignId ?? '').trim());
    ideas.push({
      kind, title, detail,
      competitors: list(item.competitors).map(name => text(name, 80)).filter(name => names.has(name)).slice(0, 5),
      ...(campaign ? { campaignId: String(campaign.id), campaignName: String(campaign.name || '') } : {})
    });
    if (ideas.length >= 8) break;
  }
  if (!summary && !ideas.length) return null;
  return { summary, ideas };
}

/**
 * AI đọc dữ liệu đối thủ + số liệu chiến dịch của shop → gợi ý áp dụng. Mô hình lỗi thì dùng luật.
 * Tuỳ chọn: callModel (tiêm khi test), settings, store, persist (mặc định true), filePath, now.
 */
export async function generateMarketInsights(report = {}, options = {}) {
  const now = options.now ?? Date.now();
  const filePath = options.filePath || adLibraryConfig.path;
  const store = options.store || await readAdLibrary(filePath);
  const signals = marketSignals(store, now);
  const base = { generatedAt: new Date(now).toISOString(), competitors: signals.competitors, ads: signals.ads, brandedPosts: signals.brandedPosts };
  let result;
  if (!signals.ads && !signals.brandedPosts) {
    result = { ...base, model: 'rules', source: 'rules', summary: 'Chưa có dữ liệu đối thủ nào để phân tích.', ideas: ruleMarketIdeas(signals) };
  } else {
    try {
      const settings = options.settings || await (options.readSettings || readChatbotSettings)();
      const call = options.callModel || (input => requestModelText({ ...input, ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}) }));
      const answer = await call({ system: marketAiSystemPrompt, prompt: buildMarketPrompt(store, report, { now }), settings: settings || {} });
      const checked = validateMarketAnswer(parseJsonAnswer(typeof answer === 'string' ? answer : answer?.text), report, store);
      if (!checked) throw new Error('Mô hình trả về JSON không hợp lệ.');
      result = { ...base, model: (typeof answer === 'object' && answer?.model) || settings?.directModel || 'ai', source: 'ai', summary: checked.summary || 'Xem các gợi ý bên dưới.', ideas: checked.ideas };
    } catch (error) {
      result = {
        ...base, model: 'rules', source: 'rules', error: String(error?.message || error).slice(0, 300),
        summary: 'AI tạm thời không dùng được (nhờ bộ phận kỹ thuật kiểm tra kết nối AI), nên dưới đây là gợi ý theo luật từ dữ liệu đối thủ.',
        ideas: ruleMarketIdeas(signals)
      };
    }
  }
  if (options.persist !== false) {
    await updateAdLibrary(current => { current.insights = [result, ...current.insights].slice(0, AD_LIBRARY_LIMITS.keepInsights); }, filePath);
  }
  return result;
}

/** Tóm tắt thị trường gọn cho Cố vấn chiến dịch (gợi ý "đổi nội dung"). null khi chưa có dữ liệu đối thủ. */
export function marketBrief(store = {}, now = Date.now()) {
  const signals = marketSignals(store, now);
  if (!signals.ads && !signals.brandedPosts) return null;
  return {
    soDoiThu: signals.competitors,
    uuDaiPhoBien: signals.commonOffers.slice(0, 5).map(item => `${item.label} (${item.competitors} đối thủ)`),
    quangCaoChayLau: signals.longRunning.slice(0, 5).map(item => ({ soNgay: item.days, uuDai: item.offers, noiDung: item.excerpt.slice(0, 160) })),
    baiHopTacKOL: signals.brandedPosts,
    dangBaiKOL: signals.brandedTypes
  };
}

/** Dữ liệu cho màn Đối thủ: thêm liên kết web, số ngày chạy, ưu đãi nhận ra; lỗi chỉ là câu đã dịch. */
export function adLibraryView(store = {}, { config = adLibraryConfig, now = Date.now() } = {}) {
  const country = config.countries?.[0] || 'VN';
  const adCounts = new Map();
  for (const ad of list(store.ads)) adCounts.set(ad.competitorId, (adCounts.get(ad.competitorId) || 0) + 1);
  const brandedCounts = new Map();
  for (const post of list(store.branded)) brandedCounts.set(post.competitorId, (brandedCounts.get(post.competitorId) || 0) + 1);
  const latest = list(store.insights)[0] || null;
  const { error, ...insight } = latest || {};
  return {
    configured: isAdLibraryConfigured(config),
    countries: config.countries,
    competitors: list(store.competitors).map(item => ({
      ...item,
      ads: adCounts.get(item.id) || 0,
      branded: brandedCounts.get(item.id) || 0,
      webUrl: adLibraryWebUrl({ pageId: item.pageId, terms: item.keywords?.[0] || item.name, country })
    })),
    ads: list(store.ads).map(ad => ({
      ...ad,
      days: daysRunning(ad, now),
      offers: detectOffers(adText(ad)).map(offerLabel),
      webUrl: ad.libraryId ? adLibraryWebUrl({ adId: ad.libraryId }) : ''
    })).sort((first, second) => (second.days || 0) - (first.days || 0)),
    branded: list(store.branded).map(post => ({ ...post, typeLabel: brandedTypeLabel(post.type) }))
      .sort((first, second) => second.date.localeCompare(first.date)).slice(0, 200),
    signals: marketSignals(store, now),
    lastSync: store.lastSync || null,
    insights: latest ? insight : null
  };
}
