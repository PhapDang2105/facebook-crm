import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { metaConfig, projectRoot } from './config.mjs';

const channelStorePath = path.join(projectRoot, 'data', 'processed', 'meta-channels.json');

function tokenKey() {
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

export async function readChannelStore() {
  try {
    const value = JSON.parse(await readFile(channelStorePath, 'utf8'));
    return Array.isArray(value.items) ? value : { items: [] };
  } catch {
    return { items: [] };
  }
}

export async function writeChannelStore(store) {
  await mkdir(path.dirname(channelStorePath), { recursive: true });
  const temporaryPath = `${channelStorePath}.tmp`;
  await writeFile(temporaryPath, JSON.stringify(store, null, 2), 'utf8');
  await rename(temporaryPath, channelStorePath);
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
  return {
    id: channel.id,
    name: channel.name,
    picture: channel.picture || '',
    platform: 'facebook',
    status: channel.status || 'connected',
    subscribed: Boolean(channel.subscribed),
    subscriptionError: channel.subscriptionError || '',
    connectedAt: channel.connectedAt,
    checkedAt: channel.checkedAt || channel.connectedAt,
    syncedAt: channel.syncedAt || ''
  };
}
