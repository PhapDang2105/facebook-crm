// Vòng 13 (02/10) — K12: suy luận địa chỉ bằng AI (address-ai.mjs). KHÔNG gọi Vertex: mọi câu trả lời là giả lập.
// Chuỗi địa chỉ lấy từ khoá cache thật trên máy chủ (đã bỏ dấu, không tên khách, không số điện thoại).
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const directory = mkdtempSync(path.join(os.tmpdir(), 'crm-r13-addr-ai-'));
process.env.ADDRESS_AI_CACHE_PATH = path.join(directory, 'cache.json');
process.on('exit', () => rmSync(directory, { recursive: true, force: true }));

const { ADDRESS_AI_CACHE_VERSION, addressAiSystemPrompt, flushAddressAiCache, inferAddress, resetAddressAiCache, validateAddressGuess } = await import('../app/processing/address-ai.mjs');

const settings = {
  provider: 'vertex', directAuthType: 'api_key', directApiKey: 'key',
  directEndpoint: 'https://aiplatform.googleapis.com/v1/projects/p/locations/global/publishers/google/models/gemini-3-flash-preview:generateContent',
  directModel: 'gemini-3-flash-preview', addressAi: true, addressAiSearch: true
};
const reply = json => async () => ({ ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text: JSON.stringify(json) }] } }] }) });
const counting = (json, counter) => async (...args) => { counter.calls += 1; return reply(json)(...args); };
const freshCache = async () => { await flushAddressAiCache(); rmSync(process.env.ADDRESS_AI_CACHE_PATH, { force: true }); resetAddressAiCache(); };

test('r13-addr K12: câu đầu prompt không còn kéo ngược quy tắc "không quy đổi đơn vị mới về cũ"', () => {
  const firstLine = addressAiSystemPrompt.split('\n')[0];
  // Câu cũ: "Kho dùng đơn vị hành chính BA CẤP theo danh mục TRƯỚC đợt sáp nhập… Không dùng tên tỉnh mới sau sáp nhập, không bỏ cấp quận/huyện."
  assert.doesNotMatch(firstLine, /Kho dùng đơn vị hành chính BA CẤP theo danh mục TRƯỚC đợt sáp nhập/);
  assert.match(firstLine, /hai kiểu/);
  assert.match(firstLine, /KHÔNG được đổi kiểu này sang kiểu kia/);
  assert.match(firstLine, /kiểu MỚI hai cấp/);
  // Quy tắc chủ shop vẫn còn nguyên, thêm chỉ dẫn phường suy từ tên đường là độ tin thấp.
  assert.match(addressAiSystemPrompt, /KHÔNG quy đổi về phường\/quận cũ/);
  assert.match(addressAiSystemPrompt, /suy ra được từ tên đường[^\n]*confidence="low"/);
});

test('r13-addr K12: khoá cache mang phiên bản — kết quả sinh bằng quy tắc cũ không được dùng lại và bị dọn khỏi tệp', async () => {
  await freshCache();
  const text = 'van phu huyen phu cat binh dinh';
  // Kết quả cũ trên máy chủ (khoá không có phiên bản): AI tự suy "Xã Cát Minh" gắn "high".
  const stale = { canonical: 'Thôn Vạn Phú, Xã Cát Minh, Huyện Phù Cát, Bình Định', street: 'Thôn Vạn Phú', ward: 'Xã Cát Minh', district: 'Huyện Phù Cát', province: 'Bình Định', reason: 'cũ', confidence: 'high', sources: [], model: 'x' };
  writeFileSync(process.env.ADDRESS_AI_CACHE_PATH, JSON.stringify({ [`${text}|s`]: { at: 1, result: stale } }));
  resetAddressAiCache();
  const counter = { calls: 0 };
  const fetchImpl = counting({ province: 'Tỉnh Bình Định', district: 'Huyện Phù Cát', ward: 'Xã Cát Minh', street: 'Thôn Vạn Phú', confidence: 'high', ambiguous: false, reason: 'Vạn Phú thuộc xã Cát Minh' }, counter);
  const first = await inferAddress(text, { settings, fetchImpl });
  assert.equal(counter.calls, 1, 'kết quả cũ (khoá không phiên bản) không được dùng lại');
  assert.notEqual(first?.canonical, stale.canonical);
  await inferAddress(text, { settings, fetchImpl });
  assert.equal(counter.calls, 1, 'kết quả phiên bản hiện tại thì lấy từ cache');
  await flushAddressAiCache();
  const saved = JSON.parse(readFileSync(process.env.ADDRESS_AI_CACHE_PATH, 'utf8'));
  assert.deepEqual(Object.keys(saved), [`${text}|s|v:${ADDRESS_AI_CACHE_VERSION}`]);
  await freshCache();
});

test('r13-addr K12: phường AI tự suy (không có trong chữ khách) chỉ là gợi ý — không tự điền vào đơn', async () => {
  await freshCache();
  // Ca thật: cùng thôn "Vạn Phú, Phù Cát" gõ hai kiểu, AI trả hai xã khác nhau (Cát Minh / Cát Khánh), đều "high".
  const guess = await inferAddress('van phu huyen phu cat binh dinh', { settings, fetchImpl: reply({ province: 'Tỉnh Bình Định', district: 'Huyện Phù Cát', ward: 'Xã Cát Minh', street: 'Thôn Vạn Phú', confidence: 'high', ambiguous: false, reason: 'Vạn Phú thuộc xã Cát Minh' }) });
  assert.equal(guess.canonical, '', 'không có địa chỉ để tự điền');
  assert.equal(guess.ward, '');
  assert.equal(guess.suggestOnly, true);
  assert.equal(guess.confidence, 'low');
  assert.deepEqual(guess.suggestion, { canonical: 'van phu, Xã Cát Minh, Huyện Phù Cát, Bình Định', ward: 'Xã Cát Minh', district: 'Huyện Phù Cát', province: 'Bình Định' });
  assert.match(guess.reason, /^Gợi ý \(AI tự suy, chưa kiểm được\): Xã Cát Minh, Huyện Phù Cát/);
  // Bot chat: địa chỉ khách nhắn giữ nguyên (không nhận phường AI tự suy).
  const { refineAddressWithAi } = await import('../app/chatbot-engine.mjs');
  resetAddressAiCache();
  const parsed = { template_id: 'ORDER_CONFIRMATION', Customer_Address: 'van phu huyen phu cat binh dinh' };
  await refineAddressWithAi(parsed, {}, settings, reply({ province: 'Tỉnh Bình Định', district: 'Huyện Phù Cát', ward: 'Xã Cát Khánh', street: 'Thôn Vạn Phú', confidence: 'high', ambiguous: false, reason: 'x' }));
  assert.equal(parsed.Customer_Address, 'van phu huyen phu cat binh dinh');
  await freshCache();
});

test('r13-addr K12: phường có trong chữ khách, hay kiểm được bằng danh mục trong quận khách đã ghi, thì vẫn tự điền', async () => {
  await freshCache();
  // Phường khách có gõ (so bỏ dấu): nhận như trước, độ tin cao.
  const typed = await inferAddress('332 ta quang Bửu p5', { settings, fetchImpl: reply({ province: 'Thành phố Hồ Chí Minh', district: 'Quận 8', ward: 'Phường 5', street: '332 Tạ Quang Bửu', confidence: 'high', ambiguous: false, reason: 'x' }) });
  assert.equal(typed.canonical, '332 ta quang Bửu, Phường 5, Quận 8, TP Hồ Chí Minh');
  assert.equal(typed.confidence, 'high');
  assert.equal(typed.suggestOnly, undefined);
  // Khách ghi quận + tên phường gõ lỗi một ký tự ("dich vog"): trong Cầu Giấy chỉ Dịch Vọng gần trùng → kiểm được.
  const raw = 'ngõ 199 trần quốc hoàn dich vog cầu giấy hà nội';
  const checked = validateAddressGuess({ province: 'Thành phố Hà Nội', district: 'Quận Cầu Giấy', ward: 'Phường Dịch Vọng', street: 'ngõ 199 Trần Quốc Hoàn' }, raw);
  assert.equal(checked.ok, true);
  assert.equal(checked.wardInText, true);
  // Cùng địa chỉ nhưng AI trả phường KHÁC trong quận (tự suy): không kiểm được.
  const other = validateAddressGuess({ province: 'Thành phố Hà Nội', district: 'Quận Cầu Giấy', ward: 'Phường Mai Dịch', street: 'ngõ 199 Trần Quốc Hoàn' }, raw);
  assert.equal(other.ok, true);
  assert.equal(other.wardInText, false);
  const filled = await inferAddress(raw, { settings, allowWardUnverified: true, fetchImpl: reply({ province: 'Thành phố Hà Nội', district: 'Quận Cầu Giấy', ward: 'Phường Dịch Vọng', street: 'ngõ 199 Trần Quốc Hoàn', confidence: 'high', ambiguous: false, reason: 'x' }) });
  assert.match(filled.canonical, /Phường Dịch Vọng, Quận Cầu Giấy, Hà Nội$/);
  assert.equal(filled.confidence, 'high');
  await freshCache();
});

test('r13-addr K12: địa chỉ khách ghi theo phường MỚI không còn được gửi cho AI để quy đổi về đơn vị cũ', async () => {
  await freshCache();
  const counter = { calls: 0 };
  // Ca thật trong cache: AI từng đổi "phường Kon Tum, Quảng Ngãi" → P. Lê Hồng Phong, TP Quảng Ngãi; "p Gò Vấp" → Phường 10.
  const wrongKonTum = counting({ province: 'Tỉnh Quảng Ngãi', district: 'Thành phố Quảng Ngãi', ward: 'Phường Lê Hồng Phong', street: '289 Đào Duy Từ', confidence: 'high', ambiguous: false, reason: 'x' }, counter);
  assert.equal(await inferAddress('289 dao duy tu phuong kon tum tinh quang ngai quang ngai', { settings, fetchImpl: wrongKonTum }), null);
  const wrongGoVap = counting({ province: 'Thành phố Hồ Chí Minh', district: 'Quận Gò Vấp', ward: 'Phường 10', street: '525/26 Quang Trung', confidence: 'high', ambiguous: false, reason: 'x' }, counter);
  assert.equal(await inferAddress('525 26 quang trung p go vap ho chi minh', { settings, fetchImpl: wrongGoVap }), null);
  assert.equal(counter.calls, 0, 'bộ đọc luật đã nhận là địa chỉ sau sáp nhập (giữ chữ khách) → không hỏi AI');
  // Nếu vẫn hỏi (ví dụ bật force), câu trả lời quy đổi về phường cũ bị từ chối.
  const rejected = validateAddressGuess({ province: 'Tỉnh Quảng Ngãi', district: 'Thành phố Quảng Ngãi', ward: 'Phường Lê Hồng Phong', street: '289 Đào Duy Từ' }, '289 dao duy tu phuong kon tum tinh quang ngai quang ngai');
  assert.equal(rejected.ok, false);
  await freshCache();
});
