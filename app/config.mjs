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

// Server so khớp `url.pathname` (luôn bắt đầu bằng "/"): đường dẫn cấu hình thiếu
// "/" đầu sẽ không bao giờ khớp và URL webhook bị dính vào tên miền.
function webhookPathFrom(value, fallback) {
  const trimmed = String(value || '').trim();
  if (!trimmed) return fallback;
  return trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
}

const webhookPath = webhookPathFrom(process.env.META_WEBHOOK_PATH, '/webhooks/facebook');

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
  subscribedFields: 'messages,message_echoes,messaging_postbacks,messaging_optins,message_reactions,message_deliveries,message_reads,messaging_referrals,feed',
  // Page vận hành trong Pancake (tin nhắn đã về CRM qua webhook Pancake) nhưng
  // QR thẻ cảm ơn trỏ về đó: Pancake không chuyển ref của m.me, nên Page phải
  // nối thêm app Meta của CRM — và chỉ đăng ký hai trường này, kẻo mỗi tin khách
  // về hộp thư hai lần (Meta lẫn Pancake) và bot trả lời hai lần.
  referralOnlyPageIds: String(process.env.META_REFERRAL_ONLY_PAGES || '').split(',').map(value => value.trim()).filter(Boolean),
  referralOnlyFields: 'messaging_postbacks,messaging_referrals'
};

export function isReferralOnlyPage(pageId) {
  return metaConfig.referralOnlyPageIds.includes(String(pageId));
}

/** Trường webhook đăng ký cho một Page: đủ bộ, hoặc chỉ referral với Page vận hành ở Pancake. */
export function subscriptionFieldsFor(pageId) {
  return isReferralOnlyPage(pageId) ? metaConfig.referralOnlyFields : metaConfig.subscribedFields;
}

// Webhook nhận đơn từ landing page (Webcake...). Token tự đặt, đưa vào URL
// hoặc header khi cấu hình bên nền tảng landing; để trống là tắt webhook.
const landingPath = webhookPathFrom(process.env.LANDING_WEBHOOK_PATH, '/webhooks/landing');
export const landingConfig = {
  token: process.env.LANDING_WEBHOOK_TOKEN || '',
  path: landingPath,
  webhookUrl: `${publicBaseUrl}${landingPath}`
};

// Pancake (pages.fm): Page vận hành trong Pancake, bot của CRM trả lời khách
// qua Pancake. Token và ID Page lấy ở Pancake → Cài đặt → Công cụ (Public API
// access token, Webhook). Để trống là tắt.
const pancakePath = webhookPathFrom(process.env.PANCAKE_WEBHOOK_PATH, '/webhooks/pancake');

function parsePancakePages() {
  const pages = [];
  if (process.env.PANCAKE_PAGES) {
    try {
      const parsed = JSON.parse(process.env.PANCAKE_PAGES);
      if (Array.isArray(parsed)) {
        // Một phần tử hỏng (null, thiếu id/token, chỉ toàn khoảng trắng) bị bỏ qua,
        // không làm rớt các Page hợp lệ đứng sau nó.
        for (const p of parsed) {
          if (!p || typeof p !== 'object') continue;
          const pageId = String(p.pageId ?? '').trim();
          const pageAccessToken = String(p.pageAccessToken ?? '').trim();
          if (!pageId || !pageAccessToken) continue;
          pages.push({
            pageId,
            pageName: String(p.pageName || 'Pancake Page'),
            pageAccessToken
          });
        }
      }
    } catch {}
  }
  if (process.env.PANCAKE_PAGE_ID && process.env.PANCAKE_PAGE_ACCESS_TOKEN) {
    const id = String(process.env.PANCAKE_PAGE_ID);
    if (!pages.some(p => p.pageId === id)) {
      pages.push({
        pageId: id,
        pageName: String(process.env.PANCAKE_PAGE_NAME || 'Giọt Nắng Healthy'),
        pageAccessToken: String(process.env.PANCAKE_PAGE_ACCESS_TOKEN)
      });
    }
  }
  return pages;
}

const parsedPages = parsePancakePages();

export const pancakeConfig = {
  pages: parsedPages,
  pageId: parsedPages[0]?.pageId || process.env.PANCAKE_PAGE_ID || '',
  pageName: parsedPages[0]?.pageName || process.env.PANCAKE_PAGE_NAME || 'Giọt Nắng Healthy',
  pageAccessToken: parsedPages[0]?.pageAccessToken || process.env.PANCAKE_PAGE_ACCESS_TOKEN || '',
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
