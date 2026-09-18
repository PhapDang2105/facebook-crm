// Lớp trung gian cho mã QR in trên phiếu cảm ơn: QR trỏ về /q/<mã> của CRM,
// CRM đếm rồi mới chuyển hướng sang Messenger.
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

/**
 * Ghi một lượt quét. KHÔNG lưu địa chỉ IP: để đếm thì không cần, mà lưu vào là
 * thành dữ liệu cá nhân phải bảo vệ. Chỉ giữ loại máy để biết iPhone hay Android.
 */
export async function recordQrScan(code, { at = Date.now(), userAgent = '' } = {}) {
  if (!isValidQrCode(code)) throw new Error('Mã QR không hợp lệ.');
  const platform = /iphone|ipad|ios/i.test(userAgent) ? 'ios'
    : /android/i.test(userAgent) ? 'android'
      : /windows|macintosh|linux/i.test(userAgent) ? 'may tinh' : 'khac';
  return updateStore(store => {
    const entry = store.codes[code] || { code, scans: 0, firstAt: at, lastAt: at, platforms: {} };
    entry.scans += 1;
    entry.lastAt = at;
    entry.platforms[platform] = (entry.platforms[platform] || 0) + 1;
    store.codes[code] = entry;
    store.recent.push({ code, at, platform });
    if (store.recent.length > recentLimit) store.recent = store.recent.slice(-recentLimit);
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
    return {
      ...entry,
      referrals,
      // Chưa có lượt quét nào thì tỷ lệ là null, không phải 0 — tránh đọc nhầm
      // "0%" thành "hỏng" khi thật ra là "chưa ai quét".
      arrivalRate: entry.scans ? Math.round((referrals / entry.scans) * 100) : null
    };
  }).sort((first, second) => second.scans - first.scans);
  return { codes, recent: [...store.recent].slice(-100).reverse() };
}
