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

// Tin soạn sẵn khách gửi khi mở Messenger từ thẻ (tham số `text` của m.me).
// Messenger giới hạn ngắn; Pancake cho 140 ký tự nên lấy cùng mức.
export const prefillTextMaxLength = 140;

function normalizeSettings(value) {
  const zaloUrl = String(value?.zaloUrl || '').trim();
  const prefillText = String(value?.prefillText || '').replace(/\s+/g, ' ').trim().slice(0, prefillTextMaxLength);
  return { zaloUrl: isAllowedZaloUrl(zaloUrl) ? zaloUrl : '', prefillText, updatedAt: Number(value?.updatedAt) || 0 };
}

/** Tệp chưa có → mặc định. Tệp hỏng → cất sang `.corrupt-<mốc>` thay vì để lượt lưu sau đè mất. Lỗi đọc khác thì ném ra. */
export async function readQrSettings() {
  if (cachedSettings) return cachedSettings;
  let raw;
  try {
    raw = await readFile(settingsPath, 'utf8');
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    cachedSettings = normalizeSettings({});
    return cachedSettings;
  }
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('không phải object JSON');
    cachedSettings = normalizeSettings(parsed);
  } catch (error) {
    const quarantined = `${settingsPath}.corrupt-${Date.now()}`;
    await rename(settingsPath, quarantined).catch(() => {});
    console.error(`Cài đặt mã QR hỏng (${error.message}), đã cất sang ${path.basename(quarantined)}; dùng mặc định.`);
    cachedSettings = normalizeSettings({});
  }
  return cachedSettings;
}

/** Từ chối (reject) với lời tiếng Việt để route trả thẳng cho người dùng. */
export async function writeQrSettings({ zaloUrl, prefillText } = {}) {
  const current = await readQrSettings();
  const link = zaloUrl === undefined ? current.zaloUrl : String(zaloUrl || '').trim();
  if (link && !isAllowedZaloUrl(link)) {
    throw new Error('Liên kết Zalo phải là địa chỉ https trên zalo.me (ví dụ https://zalo.me/0901234567 hoặc https://zalo.me/g/abcdef).');
  }
  const text = prefillText === undefined ? current.prefillText : String(prefillText || '').replace(/\s+/g, ' ').trim();
  if (text.length > prefillTextMaxLength) throw new Error(`Tin soạn sẵn tối đa ${prefillTextMaxLength} ký tự (đang ${text.length}).`);
  const operation = writeQueue.then(async () => {
    const settings = { zaloUrl: link, prefillText: text, updatedAt: Date.now() };
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
