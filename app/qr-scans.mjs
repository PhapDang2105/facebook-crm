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
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { projectRoot } from './config.mjs';
import { classifyUserAgent, qrCodeFromRef } from './qr-bridge.mjs';

const scansPath = process.env.QR_SCANS_PATH
  || path.join(projectRoot, 'data', 'processed', 'qr-scans.json');

// Mã chỉ gồm chữ thường, số và gạch nối. Đây vừa là quy ước đặt tên, vừa là
// chốt chặn chuyển hướng mở: mã do người ngoài gõ vào URL không được phép biến
// thành một địa chỉ đích khác.
const codePattern = /^[a-z0-9][a-z0-9-]{0,39}$/;

const recentLimit = 500;
let cachedStore = null;
let writeQueue = Promise.resolve();

export function isValidQrCode(value) {
  return codePattern.test(String(value ?? ''));
}

function emptyStore() {
  return { codes: Object.create(null), recent: [] };
}

function normalizeStore(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('không phải object JSON');
  const codes = value.codes && typeof value.codes === 'object' && !Array.isArray(value.codes) ? value.codes : {};
  const recent = Array.isArray(value.recent) ? value.recent.slice(-recentLimit) : [];
  return { codes: Object.assign(Object.create(null), codes), recent };
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
async function readStore() {
  if (cachedStore) return cachedStore;
  let raw;
  try {
    raw = await readFile(scansPath, 'utf8');
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    cachedStore = emptyStore();
    return cachedStore;
  }
  try {
    cachedStore = normalizeStore(JSON.parse(raw));
  } catch (error) {
    const quarantined = `${scansPath}.corrupt-${Date.now()}`;
    await rename(scansPath, quarantined).catch(() => {});
    console.error(`Kho lượt quét QR hỏng (${error.message}), đã cất sang ${path.basename(quarantined)}; bắt đầu kho mới.`);
    cachedStore = emptyStore();
  }
  return cachedStore;
}

async function persistStore(store) {
  await mkdir(path.dirname(scansPath), { recursive: true });
  const temporaryPath = `${scansPath}.tmp`;
  await writeFile(temporaryPath, JSON.stringify(store, null, 2), 'utf8');
  await rename(temporaryPath, scansPath);
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
    store.codes[code] = { code, scans: 0, opens: 0, firstAt: at, lastAt: at, platforms: {}, browsers: {}, modes: {} };
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
    pushRecent(store, { code, at, platform, browser, mode: served });
    return entry;
  });
}

/**
 * Khách bấm nút trên trang đệm (beacon từ trang): "Mở Messenger" đếm vào
 * `opens`, "Nhắn qua Zalo" đếm vào `zaloOpens`. Lượt quét chuyển hướng thẳng
 * không có bước này, nên tỷ lệ bấm chỉ so với số lượt được phục vụ bằng trang.
 */
export async function recordQrOpen(code, { at = Date.now(), target = 'messenger' } = {}) {
  if (!isValidQrCode(code)) throw new Error('Mã QR không hợp lệ.');
  const zalo = target === 'zalo';
  return updateStore(store => {
    const entry = entryFor(store, code, at);
    if (!entry) return null;
    if (zalo) entry.zaloOpens = (Number(entry.zaloOpens) || 0) + 1;
    else entry.opens += 1;
    pushRecent(store, { code, at, event: zalo ? 'open-zalo' : 'open' });
    return entry;
  });
}

/**
 * Số referral Messenger nhận được cho từng mã, đọc từ hội thoại trong hộp thư.
 * Một lượt quét có thể về CRM tới ba lần (referral Meta, tin Botcake "Mã thẻ:
 * #mã", tin soạn sẵn của khách) — khử trùng theo hội thoại | mã | ngày để một
 * lượt quét đếm đúng một, không thì tỷ lệ "vào Messenger" vượt 100%.
 * Đọc `qrReferrals` (kho mới) lẫn `referrals` SHORTLINK (bản ghi từ trước khi tách ô).
 */
export function countQrReferrals(conversations = []) {
  const counts = {};
  const seen = new Set();
  for (const conversation of conversations || []) {
    const list = [
      ...(Array.isArray(conversation?.qrReferrals) ? conversation.qrReferrals : []),
      ...(Array.isArray(conversation?.referrals) ? conversation.referrals : []).filter(item => item?.source === 'SHORTLINK')
    ];
    for (const referral of list) {
      const code = qrCodeFromRef(referral?.ref);
      if (!code) continue;
      const day = Math.floor((Number(referral?.at) || 0) / 86_400_000);
      const key = `${conversation.id || `${conversation.pageId}:${conversation.psid}`}|${code}|${day}`;
      if (seen.has(key)) continue;
      seen.add(key);
      counts[code] = (counts[code] || 0) + 1;
    }
  }
  return counts;
}

/**
 * Số lượt quét, kèm số referral Messenger thật sự nhận được cho từng mã.
 * Hai con số này đặt cạnh nhau chính là thứ cần đo: quét mười lần mà chỉ bảy
 * lần Meta gửi `ref` thì tỷ lệ rớt là 30%, và ta biết điều đó bằng dữ liệu.
 */
export async function listQrScans(referralCounts = {}) {
  const store = await readStore();
  const codes = Object.values(store.codes).map(entry => {
    const referrals = Number(referralCounts[entry.code]) || 0;
    const pageServed = Number(entry.modes?.page) || 0;
    const opens = Number(entry.opens) || 0;
    return {
      ...entry,
      opens,
      zaloOpens: Number(entry.zaloOpens) || 0,
      referrals,
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
