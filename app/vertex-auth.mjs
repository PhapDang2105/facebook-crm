import crypto from 'node:crypto';
import fs from 'node:fs';

let cachedToken = null;
// Lời xin token đang chờ: nhiều hội thoại được bot xử lý song song thì dùng
// chung một yêu cầu tới Google thay vì mỗi luồng tự xin một token.
let pendingToken = null;

function base64Url(value) {
  return Buffer.from(value).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

// Tệp key đã đọc, nhớ theo đường dẫn + mtime + cỡ (perf-analysis, 01/10): vertexProjectId() được gọi mỗi lượt gọi
// model khi chưa đặt GOOGLE_CLOUD_PROJECT — trước đây đọc + parse tệp mỗi lần. Thay tệp key (mtime đổi) thì đọc lại.
let cachedCredentials = null;

function readServiceAccount() {
  const file = process.env.GOOGLE_APPLICATION_CREDENTIALS || '/etc/facebook-crm/vertex-gemini-key.json';
  const stat = fs.statSync(file);
  if (cachedCredentials && cachedCredentials.file === file && cachedCredentials.mtimeMs === stat.mtimeMs && cachedCredentials.size === stat.size) return cachedCredentials.credentials;
  const credentials = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!credentials.client_email || !credentials.private_key || !credentials.project_id) throw new Error('Credential Vertex không hợp lệ.');
  cachedCredentials = { file, mtimeMs: stat.mtimeMs, size: stat.size, credentials };
  return credentials;
}

/** Quên tệp key đã nhớ (kiểm thử). */
export function resetVertexCredentialCache() {
  cachedCredentials = null;
}

export function vertexProjectId() {
  return process.env.GOOGLE_CLOUD_PROJECT || process.env.GCLOUD_PROJECT || readServiceAccount().project_id;
}

// Hạn chờ Google cấp token (INT-01): trước đây fetch không có hạn — oauth2.googleapis.com treo một lần là lời hứa
// dùng chung `pendingToken` không bao giờ xong và mọi lượt gọi model (bot, địa chỉ, chiến dịch) chờ mãi tới khi
// khởi động lại. Nay hủy fetch sau 15 giây, và có thêm một chốt chặn độc lập phòng fetchImpl bỏ qua `signal`,
// nên lời hứa luôn kết thúc và `finally` xoá nó để lượt sau xin lại.
export const VERTEX_TOKEN_TIMEOUT_MS = 15_000;

export async function getVertexAccessToken({ fetchImpl = fetch, timeoutMs = VERTEX_TOKEN_TIMEOUT_MS } = {}) {
  if (process.env.VERTEX_ACCESS_TOKEN) return process.env.VERTEX_ACCESS_TOKEN;
  if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) return cachedToken.value;
  if (!pendingToken) {
    pendingToken = withHardTimeout(requestAccessToken(fetchImpl, timeoutMs), timeoutMs).finally(() => { pendingToken = null; });
  }
  return pendingToken;
}

function withHardTimeout(promise, timeoutMs) {
  let timer;
  const guard = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Hết hạn chờ access token Vertex (${Math.round(timeoutMs / 1000)} giây).`)), timeoutMs + 1_000);
    timer.unref?.();
  });
  return Promise.race([promise, guard]).finally(() => clearTimeout(timer));
}

async function requestAccessToken(fetchImpl, timeoutMs) {
  const credentials = readServiceAccount();
  const now = Math.floor(Date.now() / 1000);
  const header = base64Url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claim = base64Url(JSON.stringify({ iss: credentials.client_email, scope: 'https://www.googleapis.com/auth/cloud-platform', aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 }));
  const unsigned = `${header}.${claim}`;
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(unsigned);
  const assertion = `${unsigned}.${base64Url(signer.sign(credentials.private_key))}`;
  const response = await fetchImpl('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }).toString(), signal: AbortSignal.timeout(timeoutMs) });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || !payload.access_token) throw new Error(payload.error_description || payload.error || `Không lấy được access token Vertex (${response.status}).`);
  cachedToken = { value: payload.access_token, expiresAt: Date.now() + Number(payload.expires_in || 3600) * 1000 };
  return cachedToken.value;
}
