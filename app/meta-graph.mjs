import { createHmac } from 'node:crypto';
import { metaConfig } from './config.mjs';

const oauthEndpoints = new Set(['oauth/access_token', 'debug_token']);

export function appSecretProof(accessToken) {
  return createHmac('sha256', metaConfig.appSecret).update(accessToken).digest('hex');
}

export async function metaRequest(pathname, options = {}) {
  if (!metaConfig.graphVersion) throw new Error('Chưa cấu hình META_GRAPH_VERSION cho Graph API.');
  const endpoint = new URL(`https://graph.facebook.com/${metaConfig.graphVersion}/${pathname.replace(/^\//, '')}`);
  const method = options.method || 'GET';
  const query = { ...(options.query || {}) };
  const body = options.body ? { ...options.body } : null;
  const accessToken = query.access_token || body?.access_token || '';
  if (accessToken && !oauthEndpoints.has(pathname.replace(/^\//, ''))) {
    const proof = appSecretProof(accessToken);
    if (body) body.appsecret_proof = proof;
    else query.appsecret_proof = proof;
  }
  Object.entries(query).forEach(([key, value]) => endpoint.searchParams.set(key, value));
  const response = await fetch(endpoint, {
    method,
    headers: body ? { 'Content-Type': 'application/x-www-form-urlencoded' } : undefined,
    body: body ? new URLSearchParams(body) : undefined
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.error) {
    const error = new Error(payload.error?.message || `Meta trả về lỗi ${response.status}.`);
    error.metaCode = payload.error?.code;
    error.metaSubcode = payload.error?.error_subcode;
    error.statusCode = response.status;
    throw error;
  }
  return payload;
}

export function subscribePageToApp(pageId, pageAccessToken) {
  return metaRequest(`${pageId}/subscribed_apps`, {
    method: 'POST',
    body: { subscribed_fields: metaConfig.subscribedFields, access_token: pageAccessToken }
  });
}

export function unsubscribePageFromApp(pageId, pageAccessToken) {
  return metaRequest(`${pageId}/subscribed_apps`, { method: 'DELETE', body: { access_token: pageAccessToken } });
}

export async function fetchPageSubscription(pageId, pageAccessToken) {
  const result = await metaRequest(`${pageId}/subscribed_apps`, {
    query: { fields: 'subscribed_fields', access_token: pageAccessToken }
  });
  const subscription = (result.data || []).find(item => Array.isArray(item.subscribed_fields));
  return { subscribed: Boolean(subscription), fields: subscription?.subscribed_fields || [] };
}

export async function fetchCustomerProfile(psid, pageAccessToken) {
  try {
    const profile = await metaRequest(psid, { query: { fields: 'name,profile_pic', access_token: pageAccessToken } });
    return { name: profile.name || '', picture: profile.profile_pic || '' };
  } catch {
    // Meta hides the profile until the customer has messaged the Page and granted access.
    return { name: '', picture: '' };
  }
}

export function sendPageMessage({ pageId, psid, text, pageAccessToken, messagingType = 'RESPONSE' }) {
  return metaRequest(`${pageId}/messages`, {
    method: 'POST',
    body: {
      recipient: JSON.stringify({ id: psid }),
      messaging_type: messagingType,
      message: JSON.stringify({ text }),
      access_token: pageAccessToken
    }
  });
}

const sendAttachmentTypes = { image: 'image', video: 'video', audio: 'audio', document: 'file' };

export function parseDataUrl(dataUrl) {
  const match = /^data:([^;,]+)(;base64)?,([\s\S]*)$/.exec(String(dataUrl || ''));
  if (!match) return null;
  const [, mimeType, base64, data] = match;
  return {
    mimeType,
    buffer: base64 ? Buffer.from(data, 'base64') : Buffer.from(decodeURIComponent(data), 'utf8')
  };
}

/** Uploads a file to the Send API; Graph only accepts multipart for attachments. */
export async function sendPageAttachment({ pageId, psid, attachment, pageAccessToken }) {
  if (!metaConfig.graphVersion) throw new Error('Chưa cấu hình META_GRAPH_VERSION cho Graph API.');
  const file = parseDataUrl(attachment.dataUrl);
  if (!file) throw new Error('Tệp đính kèm không hợp lệ.');
  const form = new FormData();
  form.set('recipient', JSON.stringify({ id: psid }));
  form.set('messaging_type', 'RESPONSE');
  form.set('message', JSON.stringify({
    attachment: { type: sendAttachmentTypes[attachment.type] || 'file', payload: { is_reusable: false } }
  }));
  form.set('access_token', pageAccessToken);
  form.set('appsecret_proof', appSecretProof(pageAccessToken));
  form.set('filedata', new Blob([file.buffer], { type: file.mimeType }), attachment.name || 'tep-dinh-kem');
  const response = await fetch(`https://graph.facebook.com/${metaConfig.graphVersion}/${pageId}/messages`, {
    method: 'POST',
    body: form
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.error) {
    const error = new Error(payload.error?.message || `Meta trả về lỗi ${response.status} khi gửi tệp.`);
    error.statusCode = response.status;
    throw error;
  }
  return payload;
}

export function sendSenderAction({ pageId, psid, action, pageAccessToken }) {
  return metaRequest(`${pageId}/messages`, {
    method: 'POST',
    body: {
      recipient: JSON.stringify({ id: psid }),
      sender_action: action,
      access_token: pageAccessToken
    }
  });
}

const conversationFields = [
  'id',
  'updated_time',
  'unread_count',
  'participants',
  'messages.limit(25){id,message,created_time,from,to,sticker,attachments{id,name,mime_type,size,image_data,video_data,file_url}}'
].join(',');

export function fetchPageConversations(pageId, pageAccessToken, limit = 25) {
  return metaRequest(`${pageId}/conversations`, {
    query: { platform: 'messenger', fields: conversationFields, limit: String(limit), access_token: pageAccessToken }
  });
}

export function attachmentTypeFromMime(mimeType) {
  const value = String(mimeType || '').toLowerCase();
  if (value.startsWith('image/')) return 'image';
  if (value.startsWith('video/')) return 'video';
  if (value.startsWith('audio/')) return 'audio';
  return 'document';
}

export function normalizeGraphAttachment(attachment) {
  const url = attachment?.image_data?.url || attachment?.video_data?.url || attachment?.file_url || '';
  if (!url) return null;
  const type = attachment.image_data ? 'image' : attachment.video_data ? 'video' : attachmentTypeFromMime(attachment.mime_type);
  return {
    type,
    dataUrl: url,
    name: attachment.name || '',
    size: Number(attachment.size) || 0
  };
}

export function normalizeGraphMessage(message, pageId) {
  const direction = String(message?.from?.id || '') === String(pageId) ? 'outgoing' : 'incoming';
  const createdAt = Date.parse(message?.created_time || '') || 0;
  const attachment = (message?.attachments?.data || []).map(normalizeGraphAttachment).find(Boolean);
  const base = {
    id: String(message?.id || ''),
    mid: String(message?.id || ''),
    direction,
    text: message?.message || '',
    createdAt,
    status: direction === 'outgoing' ? 'sent' : 'received',
    senderName: message?.from?.name || ''
  };
  if (message?.sticker) return { ...base, type: 'image', dataUrl: message.sticker, name: 'sticker' };
  if (attachment) return { ...base, ...attachment };
  return { ...base, type: 'text' };
}

export function normalizeGraphConversation(thread, pageId) {
  const participant = (thread?.participants?.data || []).find(item => String(item.id) !== String(pageId));
  if (!participant) return null;
  const messages = (thread?.messages?.data || [])
    .map(message => normalizeGraphMessage(message, pageId))
    .filter(message => message.id)
    .sort((first, second) => first.createdAt - second.createdAt);
  return {
    psid: String(participant.id),
    name: participant.name || `Khách Facebook ${String(participant.id).slice(-4)}`,
    threadId: String(thread?.id || ''),
    unreadCount: Number(thread?.unread_count) || 0,
    updatedAt: Date.parse(thread?.updated_time || '') || 0,
    messages
  };
}
