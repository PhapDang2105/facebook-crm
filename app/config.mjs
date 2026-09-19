import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const appDirectory = path.dirname(fileURLToPath(import.meta.url));

export const projectRoot = path.dirname(appDirectory);

export function parseEnvironmentFile(content) {
  const values = {};
  for (const line of String(content).split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const separator = trimmed.indexOf('=');
    if (separator < 1) continue;
    const key = trimmed.slice(0, separator).replace(/^export\s+/, '').trim();
    const rawValue = trimmed.slice(separator + 1).trim();
    const quoted = rawValue.length > 1
      && ((rawValue.startsWith('"') && rawValue.endsWith('"')) || (rawValue.startsWith("'") && rawValue.endsWith("'")));
    values[key] = quoted ? rawValue.slice(1, -1) : rawValue;
  }
  return values;
}

export function applyEnvironmentFile(filePath = path.join(projectRoot, '.env')) {
  let content = '';
  try {
    content = readFileSync(filePath, 'utf8');
  } catch {
    return {};
  }
  const values = parseEnvironmentFile(content);
  // Real environment variables win so a deployment can override the local file.
  for (const [key, value] of Object.entries(values)) {
    if (process.env[key] === undefined) process.env[key] = value;
  }
  return values;
}

applyEnvironmentFile();

function readPort() {
  const fromArgument = Number(process.argv[2]);
  if (Number.isInteger(fromArgument) && fromArgument > 0) return fromArgument;
  const fromEnvironment = Number(process.env.PORT);
  return Number.isInteger(fromEnvironment) && fromEnvironment > 0 ? fromEnvironment : 8080;
}

export const serverConfig = {
  port: readPort(),
  host: process.env.HOST || '127.0.0.1'
};

const publicBaseUrl = (process.env.PUBLIC_BASE_URL || `http://localhost:${serverConfig.port}`).replace(/\/+$/, '');
const webhookPath = process.env.META_WEBHOOK_PATH || '/webhooks/facebook';

export const metaConfig = {
  appId: process.env.META_APP_ID || '',
  appSecret: process.env.META_APP_SECRET || '',
  graphVersion: process.env.META_GRAPH_VERSION || '',
  verifyToken: process.env.META_VERIFY_TOKEN || '',
  publicBaseUrl,
  webhookPath,
  webhookUrl: `${publicBaseUrl}${webhookPath}`,
  redirectUri: process.env.META_REDIRECT_URI || `${publicBaseUrl}/api/channels/meta/callback`,
  // message_echoes also captures replies staff send from Facebook's own Page inbox.
  // Meta names the reaction field message_reactions, not messaging_reactions;
  // sending the wrong name makes the whole subscribed_apps call fail.
  // `feed` delivers comments on the Page's posts and ads; the rest is Messenger.
  subscribedFields: 'messages,message_echoes,messaging_postbacks,messaging_optins,message_reactions,message_deliveries,message_reads,messaging_referrals,feed'
};

// Webhook nhận đơn từ landing page (Webcake...). Token tự đặt, đưa vào URL
// hoặc header khi cấu hình bên nền tảng landing; để trống là tắt webhook.
export const landingConfig = {
  token: process.env.LANDING_WEBHOOK_TOKEN || '',
  path: process.env.LANDING_WEBHOOK_PATH || '/webhooks/landing',
  webhookUrl: `${publicBaseUrl}${process.env.LANDING_WEBHOOK_PATH || '/webhooks/landing'}`
};

// Pancake (pages.fm): Page vận hành trong Pancake, bot của CRM trả lời khách
// qua Pancake. Token và ID Page lấy ở Pancake → Cài đặt → Công cụ (Public API
// access token, Webhook). Để trống là tắt.
const pancakePath = process.env.PANCAKE_WEBHOOK_PATH || '/webhooks/pancake';
export const pancakeConfig = {
  pageId: process.env.PANCAKE_PAGE_ID || '',
  pageName: process.env.PANCAKE_PAGE_NAME || 'Giọt Nắng Healthy',
  pageAccessToken: process.env.PANCAKE_PAGE_ACCESS_TOKEN || '',
  webhookToken: process.env.PANCAKE_WEBHOOK_TOKEN || '',
  path: pancakePath,
  webhookUrl: `${publicBaseUrl}${pancakePath}`,
  apiBase: process.env.PANCAKE_API_BASE || 'https://pages.fm/api/public_api',
  // Mặc định bot im khi hội thoại đã có nhân viên nhận trong Pancake.
  botWhenAssigned: process.env.PANCAKE_BOT_WHEN_ASSIGNED === '1'
};

// Pancake POS Open API: tra lịch sử giao hàng theo số điện thoại để cảnh báo
// khách hay bom hàng. Tạo khoá ở POS: Cài đặt → Nâng cao → Kết nối bên thứ ba
// → Webhook/API → API KEY → Tạo. Để trống là chỉ dùng danh sách thủ công.
export const posConfig = {
  apiKey: process.env.POS_API_KEY || '',
  shopId: process.env.POS_SHOP_ID || ''
};

export function missingMetaConfiguration() {
  return [
    !metaConfig.appId && 'META_APP_ID',
    !metaConfig.appSecret && 'META_APP_SECRET',
    !metaConfig.graphVersion && 'META_GRAPH_VERSION'
  ].filter(Boolean);
}

export function isMetaConfigured() {
  return missingMetaConfiguration().length === 0 && Boolean(metaConfig.redirectUri);
}

export function missingWebhookConfiguration() {
  return [
    ...missingMetaConfiguration(),
    !metaConfig.verifyToken && 'META_VERIFY_TOKEN',
    !metaConfig.publicBaseUrl.startsWith('https://') && 'PUBLIC_BASE_URL'
  ].filter(Boolean);
}

export function isWebhookConfigured() {
  return missingWebhookConfiguration().length === 0;
}
