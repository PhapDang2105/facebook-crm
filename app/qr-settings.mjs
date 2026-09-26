// Cấu hình của trang đệm QR do nhân viên đặt ở Cài đặt → Mã QR: hiện chỉ có
// liên kết Zalo (OA hoặc nhóm) để khách quét thẻ được chọn Zalo thay vì
// Messenger. Lưu riêng, không trộn vào kho đếm lượt quét.
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { projectRoot } from './config.mjs';

const settingsPath = process.env.QR_SETTINGS_PATH
  || path.join(projectRoot, 'data', 'processed', 'qr-settings.json');

let cachedSettings = null;
let writeQueue = Promise.resolve();

/**
 * Chỉ nhận liên kết Zalo thật (zalo.me/<OA>, zalo.me/g/<nhóm>, oa.zalo.me…):
 * trang đệm là trang công khai, một liên kết lạ đặt ở đây là biến nó thành
 * chuyển hướng tuỳ ý cho người ngoài.
 */
export function isAllowedZaloUrl(value) {
  let parsed;
  try {
    parsed = new URL(String(value || ''));
  } catch {
    return false;
  }
  if (parsed.protocol !== 'https:') return false;
  const host = parsed.hostname.toLowerCase();
  return host === 'zalo.me' || host.endsWith('.zalo.me') || host === 'zaloapp.com' || host.endsWith('.zaloapp.com');
}

function normalizeSettings(value) {
  const zaloUrl = String(value?.zaloUrl || '').trim();
  return { zaloUrl: isAllowedZaloUrl(zaloUrl) ? zaloUrl : '', updatedAt: Number(value?.updatedAt) || 0 };
}

export async function readQrSettings() {
  if (cachedSettings) return cachedSettings;
  try {
    cachedSettings = normalizeSettings(JSON.parse(await readFile(settingsPath, 'utf8')));
  } catch {
    cachedSettings = normalizeSettings({});
  }
  return cachedSettings;
}

/** Từ chối (reject) với lời tiếng Việt để route trả thẳng cho người dùng. */
export async function writeQrSettings({ zaloUrl }) {
  const link = String(zaloUrl || '').trim();
  if (link && !isAllowedZaloUrl(link)) {
    throw new Error('Liên kết Zalo phải là địa chỉ https trên zalo.me (ví dụ https://zalo.me/0901234567 hoặc https://zalo.me/g/abcdef).');
  }
  const operation = writeQueue.then(async () => {
    const settings = { zaloUrl: link, updatedAt: Date.now() };
    await mkdir(path.dirname(settingsPath), { recursive: true });
    const temporaryPath = `${settingsPath}.tmp`;
    await writeFile(temporaryPath, JSON.stringify(settings, null, 2), 'utf8');
    await rename(temporaryPath, settingsPath);
    cachedSettings = settings;
    return settings;
  });
  writeQueue = operation.catch(() => {});
  return operation;
}
