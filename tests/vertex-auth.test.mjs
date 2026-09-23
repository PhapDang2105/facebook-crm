import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Khoá dịch vụ giả: chỉ cần ký được JWT, không gọi Google thật.
const directory = mkdtempSync(path.join(os.tmpdir(), 'crm-vertex-test-'));
const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const keyPath = path.join(directory, 'key.json');
writeFileSync(keyPath, JSON.stringify({
  client_email: 'bot@example.iam.gserviceaccount.com',
  private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }),
  project_id: 'du-an-test'
}));
process.env.GOOGLE_APPLICATION_CREDENTIALS = keyPath;
process.env.VERTEX_ACCESS_TOKEN = '';
process.on('exit', () => rmSync(directory, { recursive: true, force: true }));

const { getVertexAccessToken } = await import('../app/vertex-auth.mjs');

function tokenServer({ expiresIn = 3600, fail = false } = {}) {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url: String(url), body: String(options?.body || '') });
    await new Promise(resolve => setTimeout(resolve, 20));
    if (fail) return { ok: false, status: 500, json: async () => ({ error: 'server_error', error_description: 'Google lỗi tạm' }) };
    return { ok: true, status: 200, json: async () => ({ access_token: `tok-${calls.length}`, expires_in: expiresIn }) };
  };
  return { calls, fetchImpl };
}

test('nhiều cuộc gọi song song (bot xử lý nhiều hội thoại cùng lúc) chỉ xin token một lần rồi dùng chung; token sắp hết hạn thì xin lại', async () => {
  // Token chỉ còn 30 giây (dưới biên 60 giây) nên lượt gọi sau phải xin lại.
  const server = tokenServer({ expiresIn: 30 });
  const tokens = await Promise.all([1, 2, 3].map(() => getVertexAccessToken({ fetchImpl: server.fetchImpl })));
  assert.deepEqual(tokens, ['tok-1', 'tok-1', 'tok-1']);
  assert.equal(server.calls.length, 1, 'chỉ một yêu cầu tới oauth2.googleapis.com');
  assert.match(server.calls[0].body, /grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=/);
  assert.equal(await getVertexAccessToken({ fetchImpl: server.fetchImpl }), 'tok-2', 'token sắp hết hạn không được dùng lại');
  assert.equal(server.calls.length, 2);
});

test('xin token thất bại thì báo lỗi và lượt sau xin lại được (không kẹt lời hứa lỗi); token còn hạn thì lấy từ cache', async () => {
  const failing = tokenServer({ fail: true });
  await assert.rejects(getVertexAccessToken({ fetchImpl: failing.fetchImpl }), /Google lỗi tạm/);
  const recovered = tokenServer();
  assert.equal(await getVertexAccessToken({ fetchImpl: recovered.fetchImpl }), 'tok-1');
  assert.equal(await getVertexAccessToken({ fetchImpl: recovered.fetchImpl }), 'tok-1', 'token 3600 giây được dùng lại');
  assert.equal(recovered.calls.length, 1);
});
