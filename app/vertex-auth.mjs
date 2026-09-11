import crypto from 'node:crypto';
import fs from 'node:fs';

let cachedToken = null;

function base64Url(value) {
  return Buffer.from(value).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function readServiceAccount() {
  const file = process.env.GOOGLE_APPLICATION_CREDENTIALS || '/etc/facebook-crm/vertex-gemini-key.json';
  const credentials = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!credentials.client_email || !credentials.private_key || !credentials.project_id) throw new Error('Credential Vertex không hợp lệ.');
  return credentials;
}

export function vertexProjectId() {
  return process.env.GOOGLE_CLOUD_PROJECT || process.env.GCLOUD_PROJECT || readServiceAccount().project_id;
}

export async function getVertexAccessToken({ fetchImpl = fetch } = {}) {
  if (process.env.VERTEX_ACCESS_TOKEN) return process.env.VERTEX_ACCESS_TOKEN;
  if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) return cachedToken.value;
  const credentials = readServiceAccount();
  const now = Math.floor(Date.now() / 1000);
  const header = base64Url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claim = base64Url(JSON.stringify({ iss: credentials.client_email, scope: 'https://www.googleapis.com/auth/cloud-platform', aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 }));
  const unsigned = `${header}.${claim}`;
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(unsigned);
  const assertion = `${unsigned}.${base64Url(signer.sign(credentials.private_key))}`;
  const response = await fetchImpl('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }).toString() });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || !payload.access_token) throw new Error(payload.error_description || payload.error || `Không lấy được access token Vertex (${response.status}).`);
  cachedToken = { value: payload.access_token, expiresAt: Date.now() + Number(payload.expires_in || 3600) * 1000 };
  return cachedToken.value;
}
