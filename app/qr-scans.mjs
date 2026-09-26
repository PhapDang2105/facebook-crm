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
import { classifyUserAgent } from './qr-bridge.mjs';

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
  const codes = value && typeof value === 'object' && value.codes && typeof value.codes === 'object' ? value.codes : {};
  const recent = Array.isArray(value?.recent) ? value.recent.slice(-recentLimit) : [];
  return { codes: Object.assign(Object.create(null), codes), recent };
}

async function readStore() {
  if (cachedStore) return cachedStore;
  try {
    cachedStore = normalizeStore(JSON.parse(await readFile(scansPath, 'utf8')));
  } catch {
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

/** Ghi tuần tự như các kho khác: nhiều người quét cùng lúc không đè mất nhau. */
function updateStore(mutate) {
  const operation = writeQueue.then(async () => {
    const store = await readStore();
    const result = await mutate(store);
    await persistStore(store);
    return result;
  });
  writeQueue = operation.catch(() => {});
  return operation;
}

// Đường /q/<mã> công khai: mã lạ chỉ được tạo mục đếm tới giới hạn này, tránh ai đó gõ mã ngẫu nhiên làm kho phình vô hạn.
export const maximumTrackedCodes = 500;

function entryFor(store, code, at) {
  if (!store.codes[code] && Object.keys(store.codes).length >= maximumTrackedCodes) return null;
  const entry = store.codes[code] || { code, scans: 0, opens: 0, firstAt: at, lastAt: at, platforms: {}, browsers: {}, modes: {} };
  // Kho ghi từ bản trước chưa có các ô này.
  entry.opens = Number(entry.opens) || 0;
  entry.browsers = entry.browsers && typeof entry.browsers === 'object' ? entry.browsers : {};
  entry.modes = entry.modes && typeof entry.modes === 'object' ? entry.modes : {};
  store.codes[code] = entry;
  return entry;
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
 * khách rớt ở nhánh nào.
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
