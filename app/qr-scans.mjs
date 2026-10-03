// Lớp trung gian cho mã QR in trên phiếu cảm ơn: QR trỏ về /q/<mã> của CRM,
// CRM đếm rồi mới đưa khách sang Messenger (chuyển hướng thẳng hoặc trang đệm,
// xem qr-bridge.mjs).
//
// Vì sao không in thẳng link m.me lên phiếu:
//  - Phiếu in rồi là không sửa được. Qua đây thì đổi đích lúc nào cũng được.
//  - Meta KHÔNG bảo hành việc gửi `ref` ("we do not make guarantees that
//    referrals will always work"). Đếm ở đây rồi đối chiếu với số referral
//    webhook nhận được là cách duy nhất biết tỷ lệ rớt thật, thay vì đoán.
//  - Máy không mở được Messenger vẫn có chỗ để đi tiếp.
import path from 'node:path';
import { projectRoot } from './config.mjs';
import { readJsonFile, writeJsonAtomic } from './json-store.mjs';
import { classifyUserAgent, qrCodeFromRef } from './qr-bridge.mjs';

const scansPath = process.env.QR_SCANS_PATH
  || path.join(projectRoot, 'data', 'processed', 'qr-scans.json');

// Mã chỉ gồm chữ thường, số và gạch nối. Đây vừa là quy ước đặt tên, vừa là
// chốt chặn chuyển hướng mở: mã do người ngoài gõ vào URL không được phép biến
// thành một địa chỉ đích khác.
const codePattern = /^[a-z0-9][a-z0-9-]{0,39}$/;

const recentLimit = 500;
// Bộ đếm theo ngày cho từng mã (quét, bấm mở, bấm Zalo) để bảng điều khiển lọc
// theo 7/30 ngày và vẽ biểu đồ. Khoá ngày theo giờ Việt Nam (UTC+7). Giữ tối
// đa 180 ngày cho mỗi mã; tổng cộng dồn vẫn nằm ở scans/opens.
const dayKeepLimit = 180;
const vietnamOffsetMs = 7 * 60 * 60 * 1000;
export function qrDayKey(at) {
  return new Date((Number(at) || 0) + vietnamOffsetMs).toISOString().slice(0, 10);
}
function bumpDay(entry, at, field) {
  if (!entry.days || typeof entry.days !== 'object') entry.days = {};
  const key = qrDayKey(at);
  const day = entry.days[key] || (entry.days[key] = { scans: 0, pages: 0, opens: 0, zaloOpens: 0 });
  day[field] = (Number(day[field]) || 0) + 1;
  const keys = Object.keys(entry.days).sort();
  for (const old of keys.slice(0, Math.max(0, keys.length - dayKeepLimit))) delete entry.days[old];
}
// Kho ghi từ bản trước chưa có `days`: dựng lại một lần từ danh sách lượt gần
// đây (đủ với lượng quét hiện tại), rồi từ đó ghi trực tiếp.
function backfillDays(store) {
  for (const entry of Object.values(store.codes)) {
    if (entry.days && typeof entry.days === 'object') continue;
    entry.days = {};
    for (const item of store.recent) {
      if (item?.code !== entry.code) continue;
      bumpDay(entry, item.at, item.event === 'open-zalo' ? 'zaloOpens' : item.event === 'open' ? 'opens' : 'scans');
      if (!item.event && item.mode === 'page') bumpDay(entry, item.at, 'pages');
    }
  }
}
let cachedStore = null;
let writeQueue = Promise.resolve();

export function isValidQrCode(value) {
  return codePattern.test(String(value ?? ''));
}

function emptyStore() {
  return { codes: Object.create(null), recent: [] };
}

function normalizeStore(value) {
  const codes = value.codes && typeof value.codes === 'object' && !Array.isArray(value.codes) ? value.codes : {};
  const recent = Array.isArray(value.recent) ? value.recent.slice(-recentLimit) : [];
  const store = { codes: Object.assign(Object.create(null), codes), recent };
  backfillDays(store);
  return store;
}

/**
 * Mã đã tạo ở Cài đặt → Mã QR (có mục trong kho): dùng đồng bộ để nhận ra khách quét thẻ thật, phân biệt với
 * tin khách gõ "#123456" (số đơn, giá…). Kho chưa nạp thì coi là chưa biết → bot trả lời như tin thường.
 */
export function isKnownQrCode(code) {
  const key = String(code || '').toLowerCase();
  return Boolean(key && cachedStore?.codes?.[key]);
}

/**
 * Tệp chưa có → kho rỗng. Tệp hỏng (ghi dở, không phải JSON object) → cất sang
 * `.corrupt-<mốc>` để còn cứu số liệu, KHÔNG âm thầm đè bằng kho rỗng ở lượt
 * quét kế tiếp. Lỗi đọc khác (quyền, đĩa) thì ném ra, không nhớ kho rỗng.
 */
// Giữ lời hứa đang đọc: lượt đọc nạp sẵn lúc khởi động và lượt quét đầu tiên dùng chung một kho,
// không để hai bản đọc song song rồi bản về sau đè mất mã vừa tạo trên bản kia.
let storeLoading = null;
async function readStore() {
  if (cachedStore) return cachedStore;
  storeLoading ||= readJsonFile(scansPath, { fallback: emptyStore, normalize: normalizeStore, label: 'Kho lượt quét QR' })
    .then(store => { cachedStore = store; return store; })
    .finally(() => { storeLoading = null; });
  return storeLoading;
}

async function persistStore(store) {
  await writeJsonAtomic(scansPath, store);
}

/** Ghi tuần tự như các kho khác: nhiều người quét cùng lúc không đè mất nhau. Mutate trả `null` = không có gì đổi, không ghi đĩa. */
function updateStore(mutate) {
  const operation = writeQueue.then(async () => {
    const store = await readStore();
    const result = await mutate(store);
    if (result !== null) await persistStore(store);
    return result;
  });
  writeQueue = operation.catch(() => {});
  return operation;
}

// Số mã tối đa nhân viên tạo được: kho đếm không phình vô hạn.
export const maximumTrackedCodes = 500;

/**
 * Mục đếm của một mã. Chỉ mã đã tạo ở Cài đặt → Mã QR mới có mục: đường
 * /q/<mã> và beacon /open là công khai, ai gõ mã lạ cũng không tạo được mục
 * mới (trước đây tạo tới 500 rồi lô in sau không còn chỗ, và không có cách dọn).
 */
function entryFor(store, code, at, { create = false } = {}) {
  if (!store.codes[code]) {
    if (!create) return null;
    if (Object.keys(store.codes).length >= maximumTrackedCodes) throw new Error(`Kho mã QR đã đủ ${maximumTrackedCodes} mã; xoá mã không dùng trước khi tạo thêm.`);
    store.codes[code] = { code, scans: 0, opens: 0, firstAt: at, lastAt: at, platforms: {}, browsers: {}, modes: {}, days: {} };
  }
  const entry = store.codes[code];
  // Kho ghi từ bản trước chưa có các ô này.
  entry.opens = Number(entry.opens) || 0;
  entry.browsers = entry.browsers && typeof entry.browsers === 'object' ? entry.browsers : {};
  entry.modes = entry.modes && typeof entry.modes === 'object' ? entry.modes : {};
  return entry;
}

/** Nhân viên tạo mã (bấm "Tạo QR" / tải ảnh): từ đây mã được đếm và được coi là mã thẻ thật. Đã có thì giữ nguyên. */
export async function registerQrCode(code, { at = Date.now() } = {}) {
  if (!isValidQrCode(code)) throw new Error('Mã QR không hợp lệ.');
  return updateStore(store => (store.codes[code] ? null : entryFor(store, code, at, { create: true })));
}

/** Xoá mã (gõ nhầm, lô không in): mất luôn số liệu của mã đó. Không có thì trả false. */
export async function deleteQrCode(code) {
  if (!isValidQrCode(code)) throw new Error('Mã QR không hợp lệ.');
  return updateStore(store => {
    if (!store.codes[code]) return null;
    delete store.codes[code];
    store.recent = store.recent.filter(item => item?.code !== code);
    return true;
  }).then(result => result === true);
}

// Cửa sổ ghép beacon /open với lượt trang đệm, và giữ dấu vết khử trùng (chỉ trong bộ nhớ).
const openPairWindowMs = 30 * 60 * 1000;
const recentOpenVisitors = new Map(); // `${mã}|${loại}|${dấu vết}` → lúc bấm
const maximumOpenVisitors = 5000;
function pruneOpenVisitors(now) {
  for (const [key, at] of recentOpenVisitors) {
    if (now - at > openPairWindowMs || at > now + openPairWindowMs) recentOpenVisitors.delete(key);
  }
  // Gửi dồn với dấu vết giả mỗi lần một khác: chặn bộ nhớ, bỏ mục cũ nhất.
  while (recentOpenVisitors.size > maximumOpenVisitors) recentOpenVisitors.delete(recentOpenVisitors.keys().next().value);
}

function pushRecent(store, item) {
  store.recent.push(item);
  if (store.recent.length > recentLimit) store.recent = store.recent.slice(-recentLimit);
}

/**
 * Ghi một lượt quét. KHÔNG lưu địa chỉ IP hay chuỗi User-Agent: để đếm thì
 * không cần, mà lưu vào là thành dữ liệu cá nhân phải bảo vệ. Chỉ giữ loại máy
 * (iPhone/Android), loại trình duyệt (Zalo, Chrome, Safari…) và cách phục vụ
 * (`redirect`: 302 thẳng sang m.me; `page`: trang đệm có nút bấm) — đủ để biết
 * khách rớt ở nhánh nào. Mã chưa tạo → trả null, không ghi gì.
 */
export async function recordQrScan(code, { at = Date.now(), userAgent = '', mode = 'page' } = {}) {
  if (!isValidQrCode(code)) throw new Error('Mã QR không hợp lệ.');
  const { platform, browser } = classifyUserAgent(userAgent);
  const served = mode === 'redirect' ? 'redirect' : 'page';
  return updateStore(store => {
    const entry = entryFor(store, code, at);
    if (!entry) return null;
    entry.scans += 1;
    entry.lastAt = at;
    entry.platforms[platform] = (entry.platforms[platform] || 0) + 1;
    entry.browsers[browser] = (entry.browsers[browser] || 0) + 1;
    entry.modes[served] = (entry.modes[served] || 0) + 1;
    bumpDay(entry, at, 'scans');
    // Đếm riêng lượt được phục vụ bằng trang đệm theo ngày: mẫu số của tỷ lệ bấm nút khi lọc theo kỳ.
    if (served === 'page') bumpDay(entry, at, 'pages');
    pushRecent(store, { code, at, platform, browser, mode: served });
    return entry;
  });
}

/**
 * Khách bấm nút trên trang đệm (beacon từ trang): "Mở Messenger" đếm vào
 * `opens`, "Nhắn qua Zalo" đếm vào `zaloOpens`. Lượt quét chuyển hướng thẳng
 * không có bước này, nên tỷ lệ bấm chỉ so với số lượt được phục vụ bằng trang.
 */
export async function recordQrOpen(code, { at = Date.now(), target = 'messenger', visitor = '' } = {}) {
  if (!isValidQrCode(code)) throw new Error('Mã QR không hợp lệ.');
  const zalo = target === 'zalo';
  const event = zalo ? 'open-zalo' : 'open';
  // Cùng một máy (server đưa dấu vết ngắn hạn, ví dụ hash UA+IP — không lưu đĩa) bấm lại trong
  // 30 phút: một lượt. Không có dấu vết thì chỉ dựa vào phép ghép với lượt trang đệm bên dưới.
  const visitorKey = visitor ? `${code}|${event}|${String(visitor).slice(0, 128)}` : '';
  return updateStore(store => {
    const entry = entryFor(store, code, at);
    if (!entry) return null;
    pruneOpenVisitors(at);
    if (visitorKey && recentOpenVisitors.has(visitorKey)) return null;
    // Beacon /open là công khai: chỉ đếm khi có lượt được phục vụ bằng trang đệm của cùng mã
    // trong 30 phút trước và lượt đó chưa "dùng" cho một lần bấm cùng loại — mỗi lượt trang
    // đệm cho tối đa một lần bấm Messenger (và một lần Zalo). Gửi beacon dồn/không quét
    // trước không làm tỷ lệ mở vượt 100%.
    const since = at - openPairWindowMs;
    const inWindow = item => item?.code === code && Number(item.at) >= since && Number(item.at) <= at;
    const pages = store.recent.filter(item => inWindow(item) && !item.event && item.mode === 'page').length;
    const opened = store.recent.filter(item => inWindow(item) && item.event === event).length;
    if (pages <= opened) return null;
    if (visitorKey) recentOpenVisitors.set(visitorKey, at);
    if (zalo) entry.zaloOpens = (Number(entry.zaloOpens) || 0) + 1;
    else entry.opens += 1;
    bumpDay(entry, at, zalo ? 'zaloOpens' : 'opens');
    pushRecent(store, { code, at, event: zalo ? 'open-zalo' : 'open' });
    return entry;
  });
}

/**
 * Số referral Messenger nhận được cho từng mã, đọc từ hội thoại trong hộp thư.
 * Một lượt quét có thể về CRM tới ba lần (referral Meta, tin Botcake "Mã thẻ:
 * #mã", tin soạn sẵn của khách) — khử trùng theo hội thoại | mã | ngày (giờ VN) để một
 * lượt quét đếm đúng một, không thì tỷ lệ "vào Messenger" vượt 100%.
 * Đọc `qrReferrals` (kho mới) lẫn `referrals` SHORTLINK (bản ghi từ trước khi tách ô).
 */
function* uniqueQrReferrals(conversations = []) {
  const seen = new Set();
  for (const conversation of conversations || []) {
    const list = [
      ...(Array.isArray(conversation?.qrReferrals) ? conversation.qrReferrals : []),
      ...(Array.isArray(conversation?.referrals) ? conversation.referrals : []).filter(item => item?.source === 'SHORTLINK')
    ];
    for (const referral of list) {
      const code = qrCodeFromRef(referral?.ref);
      if (!code) continue;
      // Ngày theo giờ Việt Nam (cùng ranh giới với qrDayKey, không dựng chuỗi ngày): khử trùng
      // và biểu đồ theo ngày chia ngày giống nhau.
      const day = Math.floor(((Number(referral?.at) || 0) + vietnamOffsetMs) / 86_400_000);
      const key = `${conversation.id || `${conversation.pageId}:${conversation.psid}`}|${code}|${day}`;
      if (seen.has(key)) continue;
      seen.add(key);
      yield { code, at: Number(referral?.at) || 0 };
    }
  }
}

export function countQrReferrals(conversations = []) {
  const counts = {};
  for (const { code } of uniqueQrReferrals(conversations)) counts[code] = (counts[code] || 0) + 1;
  return counts;
}

/** Referral Messenger theo mã và theo ngày (khoá ngày như qrDayKey), cùng phép khử trùng với countQrReferrals. */
export function countQrReferralsByDay(conversations = []) {
  const days = {};
  for (const { code, at } of uniqueQrReferrals(conversations)) {
    const key = qrDayKey(at);
    const perCode = days[code] || (days[code] = {});
    perCode[key] = (perCode[key] || 0) + 1;
  }
  return days;
}

/**
 * Số lượt quét, kèm số referral Messenger thật sự nhận được cho từng mã.
 * Hai con số này đặt cạnh nhau chính là thứ cần đo: quét mười lần mà chỉ bảy
 * lần Meta gửi `ref` thì tỷ lệ rớt là 30%, và ta biết điều đó bằng dữ liệu.
 */
export async function listQrScans(referralCounts = {}, { referralDays = {} } = {}) {
  const store = await readStore();
  const codes = Object.values(store.codes).map(entry => {
    const referrals = Number(referralCounts[entry.code]) || 0;
    // Chuỗi theo ngày của mã: quét/bấm lấy từ kho, referral lấy từ hộp thư.
    const days = {};
    for (const [key, day] of Object.entries(entry.days || {})) {
      days[key] = { scans: Number(day?.scans) || 0, pages: Number(day?.pages) || 0, opens: Number(day?.opens) || 0, zaloOpens: Number(day?.zaloOpens) || 0, referrals: 0 };
    }
    for (const [key, count] of Object.entries(referralDays[entry.code] || {})) {
      (days[key] || (days[key] = { scans: 0, pages: 0, opens: 0, zaloOpens: 0, referrals: 0 })).referrals = count;
    }
    const pageServed = Number(entry.modes?.page) || 0;
    const opens = Number(entry.opens) || 0;
    return {
      ...entry,
      opens,
      zaloOpens: Number(entry.zaloOpens) || 0,
      referrals,
      days,
      // Chưa có lượt quét nào thì tỷ lệ là null, không phải 0 — tránh đọc nhầm
      // "0%" thành "hỏng" khi thật ra là "chưa ai quét".
      arrivalRate: entry.scans ? Math.round((referrals / entry.scans) * 100) : null,
      openRate: pageServed ? Math.round((opens / pageServed) * 100) : null
    };
  }).sort((first, second) => second.scans - first.scans);
  return { codes, recent: [...store.recent].slice(-100).reverse() };
}

// Nạp kho lúc khởi động để isKnownQrCode (đồng bộ) có dữ liệu ngay.
readStore().catch(() => {});
