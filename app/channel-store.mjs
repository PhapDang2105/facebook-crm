import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import path from 'node:path';
import { metaConfig, projectRoot } from './config.mjs';
import { createWriteQueue, readJsonFile, writeJsonAtomic } from './json-store.mjs';

// META_CHANNELS_PATH: ghi đè vị trí kho kênh (test dùng thư mục tạm); mặc định data/processed.
const channelStorePath = process.env.META_CHANNELS_PATH || path.join(projectRoot, 'data', 'processed', 'meta-channels.json');

function tokenKey() {
  // Khoá mã hoá token Page dẫn xuất từ App Secret; thiếu secret thì mọi máy dùng
  // chung một khoá đoán được, coi như lưu token trần — từ chối thay vì giả vờ mã hoá.
  if (!metaConfig.appSecret) throw new Error('Thiếu META_APP_SECRET nên không mã hoá/giải mã được token của Page.');
  return createHash('sha256').update(metaConfig.appSecret).digest();
}

export function encryptToken(token) {
  const initializationVector = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', tokenKey(), initializationVector);
  const encrypted = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()]);
  return {
    iv: initializationVector.toString('base64'),
    value: encrypted.toString('base64'),
    tag: cipher.getAuthTag().toString('base64')
  };
}

export function decryptToken(encrypted) {
  const decipher = createDecipheriv('aes-256-gcm', tokenKey(), Buffer.from(encrypted.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(encrypted.tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(encrypted.value, 'base64')), decipher.final()]).toString('utf8');
}

/**
 * Chưa có tệp → chưa kết nối Page nào. Tệp hỏng → cất `.corrupt-*` (giữ token mã hoá để
 * cứu) rồi coi như chưa có Page. Lỗi đọc khác (EBUSY, EACCES…) → ném: người gọi không được
 * coi là "không có Page" rồi ghi đè kho thật.
 */
export async function readChannelStore() {
  return readJsonFile(channelStorePath, {
    fallback: () => ({ items: [] }),
    normalize: value => (Array.isArray(value.items) ? value : { items: [] }),
    label: 'Kho kênh Facebook (meta-channels.json)'
  });
}

const enqueueWrite = createWriteQueue();
export function writeChannelStore(store) {
  // Ghi tuần tự, tệp tạm riêng theo tiến trình (confirm/refresh Page có thể ghi gần nhau).
  return enqueueWrite(() => writeJsonAtomic(channelStorePath, store));
}

export async function findChannel(pageId) {
  const store = await readChannelStore();
  return store.items.find(item => item.id === String(pageId)) || null;
}

export async function getPageAccessToken(pageId) {
  const channel = await findChannel(pageId);
  if (!channel) throw new Error('Facebook Page này chưa được kết nối trong CRM.');
  try {
    return decryptToken(channel.token);
  } catch {
    throw new Error('Không giải mã được mã truy cập Page. Hãy ngắt và kết nối lại Page này.');
  }
}

export function publicChannel(channel) {
  const isFb = !channel.platform || channel.platform === 'facebook';
  const hasExternalExpiredFbcdn = typeof channel.picture === 'string' && channel.picture.includes('fbcdn.net');
  const picture = isFb && channel.id
    ? `/api/channels/facebook/${channel.id}/picture`
    : (hasExternalExpiredFbcdn ? '/assets/giot-nang-logo.webp' : (channel.picture || ''));
  return {
    id: channel.id,
    name: channel.name,
    picture,
    platform: channel.platform || 'facebook',
    status: channel.status || 'connected',
    subscribed: Boolean(channel.subscribed),
    subscribedFields: Array.isArray(channel.subscribedFields) ? channel.subscribedFields : [],
    subscriptionError: channel.subscriptionError || '',
    connectedAt: channel.connectedAt,
    checkedAt: channel.checkedAt || channel.connectedAt,
    syncedAt: channel.syncedAt || ''
  };
}
