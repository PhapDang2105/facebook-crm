// R1-05: lô bot chạy song song (3 lượt) gặp cache prompt rỗng/hết hạn cùng lúc chỉ tạo MỘT cachedContents.
import assert from 'node:assert/strict';
import test from 'node:test';
import './helpers/seed-catalog.mjs';
import { clearPromptCaches, requestDirectModelReply } from '../app/chatbot-engine.mjs';

const settings = { provider: 'vertex', directAuthType: 'access_token', directApiKey: 'token', directEndpoint: 'https://aiplatform.googleapis.com/v1/projects/p/locations/global/publishers/google/models/gemini-3-flash-preview:generateContent', directModel: 'gemini-3-flash-preview', systemPrompt: 'Chỉ trả JSON', promptCache: 'on', retryCount: 0, messageTemplates: {} };
const generated = { ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text: '{"template_id":"GENERAL_INFO"}' }] } }], usageMetadata: { promptTokenCount: 10 } }) };

test('R1-05: ba lượt cùng lúc → một lần tạo cache, cả ba dùng chung', async () => {
  clearPromptCaches();
  let creates = 0;
  const used = [];
  const fetchImpl = async (url, init) => {
    if (String(url).endsWith('/cachedContents')) {
      creates += 1;
      await new Promise(resolve => setTimeout(resolve, 20));
      return { ok: true, status: 200, json: async () => ({ name: `cache-${creates}` }) };
    }
    used.push(JSON.parse(init.body).cachedContent);
    return generated;
  };
  const ask = () => requestDirectModelReply({ settings, conversation: { psid: '1' }, message: { type: 'text', text: 'giá' }, fetchImpl, rawResponse: true });
  await Promise.all([ask(), ask(), ask()]);
  assert.equal(creates, 1);
  assert.deepEqual(used, ['cache-1', 'cache-1', 'cache-1']);
});

test('R1-05: tạo cache hỏng → các lượt đang chờ gửi không cache; lượt sau tạo lại', async () => {
  clearPromptCaches();
  let creates = 0;
  let fail = true;
  const used = [];
  const fetchImpl = async (url, init) => {
    if (String(url).endsWith('/cachedContents')) {
      creates += 1;
      await new Promise(resolve => setTimeout(resolve, 10));
      if (fail) return { ok: false, status: 500, json: async () => ({ error: { message: 'lỗi tạm' } }) };
      return { ok: true, status: 200, json: async () => ({ name: 'cache-ok' }) };
    }
    used.push(JSON.parse(init.body).cachedContent || '');
    return generated;
  };
  const ask = () => requestDirectModelReply({ settings, conversation: { psid: '1' }, message: { type: 'text', text: 'giá' }, fetchImpl, rawResponse: true });
  await Promise.all([ask(), ask()]);
  assert.equal(creates, 1);
  assert.deepEqual(used, ['', '']);
  fail = false;
  await ask();
  assert.equal(creates, 2, 'không giữ lượt hỏng');
  assert.equal(used.at(-1), 'cache-ok');
});
