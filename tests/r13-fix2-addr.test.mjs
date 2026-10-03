// R13 fix2 (03/10) — phản biện địa chỉ (scratchpad/r13/review-qr-addr.md, mục B1–B6). Mỗi ca dùng đúng chuỗi trong báo cáo
// (ca đối kháng của phản biện + 3 đơn thật Quảng Trị). Nguyên tắc: thà giữ chữ khách còn hơn gán sai.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  MAX_ADDRESS_LENGTH, addressTailConflict, clampAddressText, describeDeliveryAddress, expandAddressAbbreviations,
  resolveAddress, resolvedAddressFields
} from '../app/processing/locations.mjs';

const directory = mkdtempSync(path.join(os.tmpdir(), 'r13-fix2-addr-ai-'));
process.env.ADDRESS_AI_CACHE_PATH = path.join(directory, 'cache.json');
process.on('exit', () => rmSync(directory, { recursive: true, force: true }));
const { addressAiCooldownUntil, inferAddress, resetAddressAiCache } = await import('../app/processing/address-ai.mjs');

const columns = text => { const fields = resolvedAddressFields(text); return [fields.ward, fields.district, fields.province]; };
const three = text => { const r = resolveAddress(text); return [r.ward?.name || '', r.district?.name || '', r.province?.name || '']; };

test('B1: "xã A (B cũ)" với B là tên HUYỆN cũ → giữ xã khách ghi, không gán thị trấn huyện lỵ', () => {
  assert.deepEqual(columns('ấp 3, xã Hòa Khánh Đông (Đức Hòa cũ), Long An'), ['Xã Hòa Khánh Đông', 'Huyện Đức Hòa', 'Long An']);
  assert.equal(resolveAddress('ấp 3, xã Hòa Khánh Đông (Đức Hòa cũ), Long An').street, 'ấp 3');
  assert.deepEqual(columns('ấp 2 xã Tân Hưng (Cái Bè cũ), Tiền Giang'), ['Xã Tân Hưng', 'Huyện Cái Bè', 'Tiền Giang']);
  assert.deepEqual(columns('xóm 3 xã Diễn Kỷ (Diễn Châu cũ), Nghệ An'), ['Xã Diễn Kỷ', 'Huyện Diễn Châu', 'Nghệ An']);
  assert.deepEqual(columns('thôn Đoài xã Tam Hồng (Yên Lạc cũ), Vĩnh Phúc'), ['Xã Tam Hồng', 'Huyện Yên Lạc', 'Vĩnh Phúc']);
  assert.deepEqual(columns('tổ 2 xã Phước Lý (Cần Giuộc cũ) Long An'), ['Xã Phước Lý', 'Huyện Cần Giuộc', 'Long An']);
  assert.deepEqual(columns('số 12 đường 3, xã Bình Minh (Trảng Bom cũ), Đồng Nai'), ['Xã Bình Minh', 'Huyện Trảng Bom', 'Đồng Nai']);
  assert.deepEqual(columns('ấp 1 Hòa Khánh Đông (Đức Hòa cũ) Long An'), ['Xã Hòa Khánh Đông', 'Huyện Đức Hòa', 'Long An']);
  // "xã Tân Phú, (Châu Thành cũ), Tây Ninh": không còn Thị trấn Châu Thành; không đọc ra xã nào thì giữ chữ (phường trống), huyện Châu Thành.
  const tanPhu = resolvedAddressFields('xã Tân Phú, (Châu Thành cũ), Tây Ninh');
  assert.notEqual(tanPhu.ward, 'Thị trấn Châu Thành');
  assert.equal(tanPhu.province, 'Tây Ninh');
  // Có chữ "huyện" trong ngoặc và huyện không có thị trấn trùng tên: vẫn đúng như trước.
  assert.deepEqual(columns('thôn 5 xã Phú Hội (Đức Trọng cũ) Lâm Đồng'), ['Xã Phú Hội', 'Huyện Đức Trọng', 'Lâm Đồng']);
  // Chú thích phường cũ khi CHƯA đọc ra phường vẫn dùng được (ca thật POS "( an thới củ )").
  const anThoi = resolveAddress('251/6 đồng văn cống, bình thủy. Cần thơ ( an thới củ )');
  assert.deepEqual([anThoi.ward?.name, anThoi.district?.name], ['Phường An Thới', 'Quận Bình Thủy']);
});

test('B7: "xã Châu Hồng (Châu Tiến cũ)" → giữ tên khách ghi (Xã Châu Hồng), không gán tên cũ; chú thích còn nguyên trong phần đường', () => {
  const r = resolveAddress('xã Châu Hồng (Châu Tiến cũ), Quỳ Hợp, Nghệ An');
  assert.deepEqual([r.ward?.name, r.district?.name, r.province?.name], ['Xã Châu Hồng', 'Huyện Quỳ Hợp', 'Nghệ An']);
  assert.equal(r.street, '(Châu Tiến cũ)');
  assert.deepEqual(columns('Bản phúc tiến xã châu hồng ( cháu tiến cũ) quỳ hợp cũ tỉnh nghệ an'), ['Xã Châu Hồng', 'Huyện Quỳ Hợp', 'Nghệ An']);
});

test('B2: "phuong + số bằng chữ" không dấu là tên riêng/cửa hàng → giữ nguyên chữ; chỉ đổi khi đứng đầu đoạn hoặc sau chữ số', () => {
  const keep = [
    ['nha sach phuong nam, quan 3, hcm', 'Quận 3', 'nha sach phuong nam'],
    ['cong ty phuong nam, 12 le loi, tp ca mau', 'Thành phố Cà Mau', 'cong ty phuong nam, 12 le loi'],
    ['chi phuong hai, 45 tran phu, tp vung tau', 'Thành phố Vũng Tàu', 'chi phuong hai, 45 tran phu'],
    ['shop phuong ba, quan go vap', 'Quận Gò Vấp', 'shop phuong ba'],
    ['gui chi Phuong Tam, 12 Le Loi, tp tuy hoa', 'Thành phố Tuy Hòa', 'gui chi Phuong Tam, 12 Le Loi']
  ];
  for (const [text, district, street] of keep) {
    const r = resolveAddress(text);
    assert.equal(r.ward, null, text);
    assert.equal(r.district?.name, district, text);
    assert.equal(r.street, street, text);
    assert.equal(expandAddressAbbreviations(text).includes(text.match(/phuong \w+/i)[0]), true, `không đổi cụm trong ${text}`);
  }
  // 3 đơn thật Quảng Trị: số nhà/đường đứng trước → vẫn là Phường 2.
  for (const text of ['03/01 quang trung phuong hai thi xa quang tri, Huyện Triệu Phong, Quảng Trị',
    'GXN 03/01 quang trung phuong hai thi xa quang tri, Phường 2, Thị xã Quảng Trị, Quảng Trị',
    'GXN 03-01 quang trung phuong hai thi xa quang tri, Phường 2, Thị xã Quảng Trị, Quảng Trị']) {
    assert.match(expandAddressAbbreviations(text), /phuong 2 thi xa quang tri/, text);
  }
  assert.deepEqual(three('03/01 quang trung phuong hai thi xa quang tri'), ['Phường 2', 'Thị xã Quảng Trị', 'Quảng Trị']);
  assert.deepEqual(three('GXN 03-01 quang trung phuong hai thi xa quang tri, Phường 2, Thị xã Quảng Trị, Quảng Trị'), ['Phường 2', 'Thị xã Quảng Trị', 'Quảng Trị']);
  // Đứng đầu đoạn: vẫn là phường số (cách ghi thật "phường năm, quận 5").
  assert.deepEqual(three('phường năm, quận 5'), ['Phường 5', 'Quận 5', 'TP Hồ Chí Minh']);
  // Đơn thật: "Chung cu dat phuong nam 241 chu van an phuong 12 quan binh thanh" không đổi "phuong nam" thành phường số.
  assert.deepEqual(three('Chung cu dat phuong nam 241 chu van an phuong 12 quan binh thanh'), ['Phường 12', 'Quận Bình Thạnh', 'TP Hồ Chí Minh']);
});

test('B3: số nhà trần + tên huyện không loại hình trước "TP Huế" là tên đường → giữ chữ như nền; "Phú Lộc TP Huế" vẫn là huyện', () => {
  const phongDien = resolveAddress('45 Phong Điền, TP Huế');
  assert.equal(phongDien.district?.name, 'Thành phố Huế');
  assert.equal(phongDien.street, '45 Phong Điền');
  const huongThuy = resolveAddress('kiệt 5 Hương Thủy TP Huế');
  assert.equal(huongThuy.district?.name, 'Thành phố Huế');
  assert.equal(huongThuy.street, 'kiệt 5 Hương Thủy');
  assert.equal(resolveAddress('số 3 đường Hương Trà, TP Huế').street, 'số 3 đường Hương Trà');
  assert.equal(resolveAddress('Phú Lộc TP Huế').district?.name, 'Huyện Phú Lộc');
  assert.equal(resolveAddress('phong điền tp huế').district?.name, 'Huyện Phong Điền');
  assert.equal(resolveAddress('thị trấn Sịa, huyện Quảng Điền, thành phố Huế').district?.name, 'Huyện Quảng Điền');
});

test('B3 (chat): "quê tôi ở … nhưng gửi về 12 lê lợi vinh" → nơi giao là cụm sau "gửi về", không gán Đông Anh / Hà Nội', () => {
  const r = resolveAddress('quê tôi ở đông anh hà nội nhưng gửi về 12 lê lợi vinh');
  assert.notEqual(r.province?.name, 'Hà Nội');
  assert.notEqual(r.district?.name, 'Huyện Đông Anh');
  assert.equal(r.street, '12 lê lợi vinh');
  assert.equal(expandAddressAbbreviations('quê tôi ở đông anh hà nội nhưng gửi về 12 lê lợi vinh'), '12 lê lợi vinh');
  // Không có cấu trúc "nơi khác + nhưng/còn/mà + gửi về" thì không cắt gì.
  assert.deepEqual(three('mình ở Hà Nội, gửi cho mẹ ở 15 Lê Lợi Vinh Nghệ An'), ['Phường Lê Lợi', 'Thành phố Vinh', 'Nghệ An']);
  assert.equal(resolveAddress('gửi về công ty ở Bình Dương, 12 đường số 5, Dĩ An nhé').district?.name, 'Thành phố Dĩ An');
});

test('B4: đầu vào bộ đọc cắt còn 300 ký tự; chuỗi lặp 2.000 ký tự đọc xong trong vài trăm ms; engine bỏ qua tin > 500 ký tự', () => {
  assert.equal(MAX_ADDRESS_LENGTH, 300);
  assert.equal(clampAddressText('a'.repeat(1000)).length, 300);
  assert.equal(resolvedAddressFields('x'.repeat(400)).address.length, 300);
  const long = 'tpst '.repeat(400);
  const started = performance.now();
  resolveAddress(long); resolvedAddressFields(long); describeDeliveryAddress(long);
  const elapsed = performance.now() - started;
  assert.ok(elapsed < 1500, `ba hàm trên "tpst ×400" mất ${elapsed.toFixed(0)} ms (trước khi cắt: 3,5–4,8 s mỗi hàm)`);
  // Địa chỉ thật dài nhất ≈ 190 ký tự: không bị cắt.
  const real = 'Quán Cafe Ngọc, góc đường số 3 và số 6, khu dân cư Trần Anh, ấp mới 2, xã Mỹ Hạnh,  tỉnh Tây Ninh, Xã Mỹ Hạnh Nam, Huyện Đức Hòa, Long An';
  assert.equal(clampAddressText(real), real);
  assert.equal(describeDeliveryAddress(real).complete, true);
  const engine = readFileSync(new URL('../app/chatbot-engine.mjs', import.meta.url), 'utf8');
  assert.match(engine, /&& !\(String\(message\.text \|\| ''\)\.length <= 500 && describeDeliveryAddress\(String\(message\.text \|\| ''\)\)\.complete\);/);
});

test('B5: Vertex 429 → nghỉ 60 s (không gọi lại trong cùng phút); cùng địa chỉ đang hỏi dở → một lượt gọi chung', async () => {
  resetAddressAiCache();
  const settings = { provider: 'vertex', directAuthType: 'api_key', directApiKey: 'key', directEndpoint: 'https://aiplatform.googleapis.com/v1/projects/p/locations/global/publishers/google/models/gemini-2.5-flash:generateContent', directModel: 'gemini-2.5-flash', addressAi: true, addressAiSearch: false };
  let calls = 0;
  const quota = async () => { calls += 1; return { ok: false, status: 429, json: async () => ({ error: { message: 'Resource exhausted' } }) }; };
  assert.equal(await inferAddress('190/53 xóm đất p binh thoi', { settings, fetchImpl: quota }), null);
  assert.equal(calls, 1);
  assert.ok(addressAiCooldownUntil() > Date.now() + 50_000, 'ghi mốc nghỉ ~60 s');
  assert.equal(await inferAddress('190/53 xóm đất p binh thoi', { settings, fetchImpl: quota }), null);
  assert.equal(await inferAddress('ngõ 199 trần quốc hoàn diichj vọng', { settings, fetchImpl: quota }), null);
  assert.equal(calls, 1, 'trong lúc nghỉ không gọi thêm, kể cả địa chỉ khác');
  assert.match((await inferAddress('190/53 xóm đất p binh thoi', { settings, fetchImpl: quota, explain: true })).error, /429/);
  resetAddressAiCache();
  assert.equal(addressAiCooldownUntil(), 0);
  // Ba lượt đồng thời cùng địa chỉ chưa cache → một lần gọi, cả ba nhận cùng kết quả.
  let slowCalls = 0;
  const slow = async () => { slowCalls += 1; await new Promise(resolve => setTimeout(resolve, 60)); return { ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text: JSON.stringify({ province: 'Thành phố Hồ Chí Minh', district: 'Quận 11', ward: 'Phường 8', street: '190/53 xóm đất', confidence: 'high', ambiguous: false, reason: 'x' }) }] } }] }) }; };
  const results = await Promise.all([1, 2, 3].map(() => inferAddress('190/53 xóm đất p binh thoi', { settings, fetchImpl: slow })));
  assert.equal(slowCalls, 1, 'gộp lượt đang bay');
  assert.ok(results.every(result => result === results[0]));
  // Sau khi xong thì đọc từ cache, không gọi lại.
  await inferAddress('190/53 xóm đất p binh thoi', { settings, fetchImpl: slow });
  assert.equal(slowCalls, 1);
  resetAddressAiCache();
});

test('B6 (K7): ô chọn ghi tỉnh mẹ sau sáp nhập kèm quận/phường trùng tên chữ khách gõ → không cờ; mâu thuẫn thật vẫn cờ', () => {
  assert.equal(addressTailConflict('khu phố 3 thị trấn Tân Phú huyện Đồng Phú Bình Phước, Thị trấn Tân Phú, Huyện Đồng Phú, Đồng Nai'), null);
  assert.equal(addressTailConflict('ấp 3 xã Hòa Khánh Đông Đức Hòa Long An, Xã Hòa Khánh Đông, Tây Ninh'), null);
  assert.equal(addressTailConflict('khu phố 3 thị trấn Tân Phú huyện Đồng Phú Bình Phước, Thị trấn Gia Ray, Huyện Xuân Lộc, Đồng Nai')?.level, 'province');
  assert.equal(addressTailConflict('12 Lê Lợi phường 1 Vũng Tàu, Xã Long Vĩnh, Huyện Duyên Hải, Trà Vinh')?.level, 'province');
});
