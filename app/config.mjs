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

// Kiểm thử không được nạp .env THẬT của máy (token Page, khoá POS, đường dẫn kho):
// dưới `node --test` (NODE_TEST_CONTEXT do runner đặt cho tiến trình con) hoặc khi
// CRM_SKIP_ENV_FILE=1 (tests/helpers/quiet-console.mjs đặt sẵn) thì bỏ qua tệp này.
export function shouldSkipEnvironmentFile(environment = process.env) {
  return Boolean(environment.NODE_TEST_CONTEXT) || environment.CRM_SKIP_ENV_FILE === '1';
}

if (!shouldSkipEnvironmentFile()) applyEnvironmentFile();

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
            pageAccessToken,
            // Token webhook riêng từng Page (server so cùng PANCAKE_WEBHOOK_TOKEN chung).
            ...(String(p.webhookToken ?? '').trim() ? { webhookToken: String(p.webhookToken).trim() } : {})
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

// Quản lý chiến dịch: đọc số liệu Facebook Marketing API (chỉ đọc, quyền ads_read).
// Token riêng (System User / người dùng có quyền ads_read), khác token Page;
// tài khoản quảng cáo ghi có hay không có tiền tố "act_" đều được.
export function normalizeAdAccountIds(value) {
  return [...new Set(String(value || '').split(',')
    .map(item => item.trim().replace(/^act_/i, ''))
    .filter(item => /^\d+$/.test(item))
    .map(item => `act_${item}`))];
}

export const metaAdsConfig = {
  accessToken: String(process.env.META_ADS_ACCESS_TOKEN || '').trim(),
  accountIds: normalizeAdAccountIds(process.env.META_AD_ACCOUNT_IDS),
  graphVersion: process.env.META_GRAPH_VERSION || 'v26.0',
  insightsPath: process.env.AD_INSIGHTS_PATH || path.join(projectRoot, 'data', 'processed', 'ad-insights.json'),
  syncDisabled: Boolean(process.env.META_ADS_SYNC_DISABLED)
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

// Quy đơn về chiến dịch: lần bấm quảng cáo gần nhất trong N ngày trước lúc đặt (mặc định 7).
function readAttributionDays() {
  const days = Number(process.env.CAMPAIGN_ATTRIBUTION_DAYS);
  return Number.isFinite(days) && days > 0 ? Math.min(90, days) : 7;
}

export const campaignConfig = {
  attributionDays: readAttributionDays()
};

// Đăng nhập CRM: CRM_LOGIN_USERS="ten:chuoi-bam,ten2:chuoi-bam" (băm bằng
// `node app/auth.mjs hash-password`), gộp với tài khoản ở Cài đặt → Nhân sự
// (staff.json) có mật khẩu. Cả hai đều trống thì không hỏi đăng nhập — chỉ dùng
// khi chạy trên máy mình.
//
// Bắt buộc đăng nhập (fail-closed): PUBLIC_BASE_URL là https (máy chủ thật) hoặc
// CRM_REQUIRE_LOGIN=1. Khi đó chưa có tài khoản nào thì CRM trả 503 "Chưa cấu hình
// đăng nhập" thay vì mở cho mọi người. CRM_REQUIRE_LOGIN=0 tắt hẳn (chỉ dùng khi
// chạy local qua đường hầm https và biết mình đang làm gì).
export function loginRequired(environment = process.env, baseUrl = publicBaseUrl) {
  const flag = String(environment.CRM_REQUIRE_LOGIN ?? '').trim();
  if (flag === '1' || flag.toLowerCase() === 'true') return true;
  if (flag === '0' || flag.toLowerCase() === 'false') return false;
  return String(baseUrl || '').startsWith('https://');
}

export const authConfig = {
  users: String(process.env.CRM_LOGIN_USERS || ''),
  sessionSecret: String(process.env.CRM_SESSION_SECRET || ''),
  secureCookie: publicBaseUrl.startsWith('https://'),
  requireLogin: loginRequired(),
  https: publicBaseUrl.startsWith('https://')
};
