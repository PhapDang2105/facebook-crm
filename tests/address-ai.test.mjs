import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Cache đặt ở thư mục tạm để kiểm thử không đụng data/processed.
const directory = mkdtempSync(path.join(os.tmpdir(), 'crm-address-ai-'));
process.env.ADDRESS_AI_CACHE_PATH = path.join(directory, 'cache.json');
process.on('exit', () => rmSync(directory, { recursive: true, force: true }));

const { addressHint, inferAddress, parseAddressAnswer, resetAddressAiCache, validateAddressGuess } = await import('../app/processing/address-ai.mjs');
const { refineAddressWithAi } = await import('../app/chatbot-engine.mjs');

const settings = {
  provider: 'vertex',
  directAuthType: 'api_key',
  directApiKey: 'key',
  directEndpoint: 'https://aiplatform.googleapis.com/v1/projects/p/locations/global/publishers/google/models/gemini-3-flash-preview:generateContent',
  directModel: 'gemini-3-flash-preview',
  addressAi: true,
  addressAiSearch: true
};

function vertexReply(json, sources = []) {
  return async (url, init) => ({
    ok: true,
    json: async () => ({
      candidates: [{
        content: { parts: [{ text: '```json\n' + JSON.stringify(json) + '\n```' }] },
        groundingMetadata: { groundingChunks: sources.map(uri => ({ web: { uri } })) }
      }]
    }),
    _url: url,
    _init: init
  });
}

test('gợi ý cho mô hình nêu phần bộ đọc đã nhận ra', () => {
  assert.match(addressHint('58 hoàng hoa thám, phường tây hồ, hà nội').text, /tỉnh\/thành: Hà Nội/);
  assert.match(addressHint('332 ta quang Bửu phường chánh hưng').text, /chưa nhận ra tỉnh/);
});

test('đọc JSON dù mô hình bọc markdown hay viết thêm chữ', () => {
  assert.equal(parseAddressAnswer('Đây là kết quả:\n```json\n{"ward":"Phường 3"}\n```').ward, 'Phường 3');
  assert.equal(parseAddressAnswer('không có gì'), null);
});

test('chỉ nhận câu trả lời khớp đủ ba cấp trong danh mục kho', () => {
  const raw = '17/18 trần phú phường 3 dalat';
  const good = validateAddressGuess({ province: 'Tỉnh Lâm Đồng', district: 'Thành phố Đà Lạt', ward: 'Phường 3', street: '17/18 Trần Phú' }, raw);
  assert.equal(good.ok, true);
  assert.equal(good.canonical, '17/18 Trần Phú, Phường 3, Thành phố Đà Lạt, Lâm Đồng');
  const invented = validateAddressGuess({ province: 'Tỉnh Lâm Đồng', district: 'Thành phố Đà Lạt', ward: 'Phường Hoa Hồng', street: '' }, raw);
  assert.equal(invented.ok, false, 'phường không có trong danh mục thì bỏ');
  const ambiguous = validateAddressGuess({ province: 'Tỉnh Lâm Đồng', district: 'Thành phố Đà Lạt', ward: 'Phường 3', ambiguous: true }, raw);
  assert.equal(ambiguous.ok, false, 'mô hình báo mơ hồ thì bỏ');
  const missing = validateAddressGuess({ province: 'Tỉnh Lâm Đồng', district: '', ward: '' }, raw);
  assert.equal(missing.ok, false);
});

test('không cho mô hình đổi tỉnh hay quận mà bộ đọc đã chắc', () => {
  const raw = '403 Ông ích khiêm p hải châu 2 q hải châu Đà nẵng, An Giang';
  const swapped = validateAddressGuess({ province: 'Thành phố Đà Nẵng', district: 'Quận Hải Châu', ward: 'Phường Hải Châu 2', street: '403 Ông Ích Khiêm' }, raw);
  assert.equal(swapped.ok, false);
  assert.match(swapped.reason, /đổi tỉnh/);
});

test('suy luận qua Vertex, đối chiếu danh mục và nhớ kết quả', async () => {
  resetAddressAiCache();
  let calls = 0;
  const fetchImpl = async (url, init) => {
    calls += 1;
    const body = JSON.parse(init.body);
    assert.ok(url.includes('gemini-3-flash-preview:generateContent'));
    assert.equal(init.headers['x-goog-api-key'], 'key');
    assert.deepEqual(body.tools, [{ googleSearch: {} }]);
    assert.match(body.contents[0].parts[0].text, /ta quang Bửu phường chánh hưng/);
    return vertexReply({ province: 'Thành phố Hồ Chí Minh', district: 'Quận 8', ward: 'Phường 5', street: '332 Tạ Quang Bửu', confidence: 'high', ambiguous: false, reason: 'Chánh Hưng thuộc Phường 5, Quận 8' }, ['https://example.com/q8'])(url, init);
  };
  const first = await inferAddress('332 ta quang Bửu phường chánh hưng', { settings, fetchImpl });
  assert.equal(first.canonical, '332 Tạ Quang Bửu, Phường 5, Quận 8, TP Hồ Chí Minh');
  assert.equal(first.province, 'TP Hồ Chí Minh');
  assert.deepEqual(first.sources, ['https://example.com/q8']);
  const again = await inferAddress('332 ta quang Bửu phường chánh hưng', { settings, fetchImpl });
  assert.equal(again.canonical, first.canonical);
  assert.equal(calls, 1, 'cùng địa chỉ thì lấy từ cache');
});

test('không gọi mô hình khi tắt, khi không dùng Vertex, hay địa chỉ đã đủ', async () => {
  resetAddressAiCache();
  let calls = 0;
  const fetchImpl = async () => { calls += 1; throw new Error('không được gọi'); };
  assert.equal(await inferAddress('332 ta quang Bửu phường chánh hưng', { settings: { ...settings, addressAi: false }, fetchImpl }), null);
  assert.equal(await inferAddress('332 ta quang Bửu phường chánh hưng', { settings: { ...settings, provider: 'openai' }, fetchImpl }), null);
  // "dalat" giờ bộ luật tự đọc được nên không cần AI.
  assert.equal(await inferAddress('17/18 trần phú phường 3 dalat', { settings, fetchImpl }), null);
  assert.equal(await inferAddress('12 Lê Lợi, Phường Bến Nghé, Quận 1, TP Hồ Chí Minh', { settings, fetchImpl }), null);
  assert.equal(await inferAddress('Chưa có địa chỉ', { settings, fetchImpl }), null);
  assert.equal(calls, 0);
});

test('mô hình báo mơ hồ hay lỗi mạng thì không đổi gì', async () => {
  resetAddressAiCache();
  const ambiguous = await inferAddress('332 ta quang Bửu phường chánh hưng', { settings, fetchImpl: vertexReply({ province: '', district: '', ward: '', ambiguous: true, reason: 'không đủ' }) });
  assert.equal(ambiguous, null);
  const failing = await inferAddress('190/53 xóm đất p binh thoi', { settings, fetchImpl: async () => ({ ok: false, status: 429, json: async () => ({ error: { message: 'quota' } }) }) });
  assert.equal(failing, null);
});

test('chatbot thay địa chỉ khách nhắn bằng địa chỉ AI đã đối chiếu', async () => {
  resetAddressAiCache();
  const fetchImpl = vertexReply({ province: 'Thành phố Hồ Chí Minh', district: 'Quận 8', ward: 'Phường 5', street: '332 Tạ Quang Bửu', ambiguous: false, reason: 'x' });
  const parsed = { template_id: 'ORDER_CONFIRM', Customer_Address: '332 ta quang Bửu phường chánh hưng' };
  await refineAddressWithAi(parsed, {}, settings, fetchImpl);
  assert.equal(parsed.Customer_Address, '332 Tạ Quang Bửu, Phường 5, Quận 8, TP Hồ Chí Minh');
  const complete = { template_id: 'ORDER_CONFIRM', Customer_Address: '12 Lê Lợi, Phường Bến Nghé, Quận 1, TP Hồ Chí Minh' };
  await refineAddressWithAi(complete, {}, settings, async () => { throw new Error('không được gọi'); });
  assert.equal(complete.Customer_Address, '12 Lê Lợi, Phường Bến Nghé, Quận 1, TP Hồ Chí Minh');
});
