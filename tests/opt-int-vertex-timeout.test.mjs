import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// INT-01: Google treo khi cấp token thì lời hứa dùng chung phải kết thúc (hết hạn) và lượt sau xin lại được.
const directory = mkdtempSync(path.join(os.tmpdir(), 'crm-vertex-timeout-'));
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

// Hẹn giờ hết hạn đều unref (như máy chủ thật, nơi vòng lặp luôn sống) nên giữ vòng lặp sống trong lúc test.
const keepAlive = setInterval(() => {}, 1000);
test.after(() => clearInterval(keepAlive));

test('fetch tôn trọng signal: hết hạn thì huỷ, cả nhóm chờ chung nhận lỗi, lượt sau xin lại được', async () => {
  let seenSignal = null;
  const hanging = async (_url, options) => {
    seenSignal = options.signal;
    return new Promise((_, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason)));
  };
  const results = await Promise.allSettled([1, 2].map(() => getVertexAccessToken({ fetchImpl: hanging, timeoutMs: 40 })));
  assert.ok(seenSignal, 'fetch phải nhận signal hết hạn');
  assert.deepEqual(results.map(r => r.status), ['rejected', 'rejected']);
  const ok = async () => ({ ok: true, status: 200, json: async () => ({ access_token: 'tok-moi', expires_in: 3600 }) });
  assert.equal(await getVertexAccessToken({ fetchImpl: ok, timeoutMs: 40 }), 'tok-moi');
});

test('fetchImpl bỏ qua signal và treo mãi: chốt chặn vẫn kết thúc lời hứa', async () => {
  const neverSettles = () => new Promise(() => {});
  const started = Date.now();
  // Test trước đã để token trong cache nên dùng một bản module riêng (cache trống).
  const fresh = await import(`../app/vertex-auth.mjs?fresh=${Date.now()}`);
  await assert.rejects(fresh.getVertexAccessToken({ fetchImpl: neverSettles, timeoutMs: 30 }), /Hết hạn chờ access token Vertex/);
  assert.ok(Date.now() - started < 5_000);
});
