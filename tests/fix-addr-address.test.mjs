// fix-addr (01/10): hồi quy cho các ca sai trong phân tích suy luận địa chỉ (scratchpad addr/address-analysis.md).
// SĐT/tên khách đã che hoặc thay bằng giá trị giả.
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const directory = mkdtempSync(path.join(os.tmpdir(), 'crm-fix-addr-'));
process.env.ADDRESS_AI_CACHE_PATH = path.join(directory, 'address-ai-cache.json');
process.on('exit', () => rmSync(directory, { recursive: true, force: true }));

const {
  describeDeliveryAddress, resolveAddress, resolvedAddressFields, mergeAddressFragment, expandAddressAbbreviations,
  houseNumbersOf, lostHouseNumbers, accentCompatible
} = await import('../app/processing/locations.mjs');
const { NEW_WARD_UNITS_2025 } = await import('../app/processing/new-ward-names-2025.mjs');
const { cleanAddressText, orderFlowStep } = await import('../app/processing/order-flow.mjs');
const { addressAiSystemPrompt, inferAddress, resetAddressAiCache, validateAddressGuess } = await import('../app/processing/address-ai.mjs');
const { keepTypedHouseNumber, refineAddressWithAi } = await import('../app/chatbot-engine.mjs');
const { pickAddressForPhone } = await import('../app/landing-orders.mjs');
const { buildPosOrderPayload } = await import('../app/pos-orders.mjs');

const names = resolved => [resolved.province?.name || '', resolved.district?.name || '', resolved.ward?.name || ''];
const fieldsOf = text => { const f = resolvedAddressFields(text); return [f.province, f.district, f.ward]; };

// ===== 1. Tên phường MỚI trùng/gần trùng tên phường CŨ =====

test('fix-addr #95: "phường Bình Lợi Trung, TPHCM" không thành Xã Bình Lợi (Bình Chánh); giữ chữ khách, cột lưu không phường/quận cũ', () => {
  const text = '79 Đặng Thùy Trâm, phường Bình Lợi Trung, TPHCM';
  const resolved = resolveAddress(text);
  assert.deepEqual(names(resolved), ['TP Hồ Chí Minh', '', '']);
  assert.equal(resolved.postMerger, true);
  assert.equal(resolved.street, '79 Đặng Thùy Trâm', 'không sót chữ "Trung" vào phần đường');
  assert.deepEqual(fieldsOf(text), ['TP Hồ Chí Minh', '', '']);
  const described = describeDeliveryAddress(text);
  assert.equal(described.complete, true);
  assert.equal(described.canonical, text);
});

test('fix-addr #104: "Phường Cầu Ông Lãnh" (tên mới trùng tên cũ, khách không ghi quận) không gán phường cũ', () => {
  const text = 'Tk16/36D. Nguyễn cảnh chân . Phường cầu ông lãnh.tphcm';
  const resolved = resolveAddress(text);
  assert.equal(resolved.ward, null);
  assert.equal(resolved.postMerger, true);
  assert.equal(resolved.district?.name, 'Quận 1', 'quận cũ chứa phường chỉ còn làm gợi ý');
  assert.deepEqual(fieldsOf(text), ['TP Hồ Chí Minh', '', '']);
  // Khách ghi rõ quận cũ thì vẫn là địa chỉ cũ ba cấp.
  assert.deepEqual(names(resolveAddress('12 Nguyễn Thái Học, Phường Cầu Ông Lãnh, Quận 1, TPHCM')), ['TP Hồ Chí Minh', 'Quận 1', 'Phường Cầu Ông Lãnh']);
});

test('fix-addr #258: "phường Trấn Biên, Biên Hòa, Đồng Nai" không sửa chính tả thành Phường Tân Biên', () => {
  const text = 'chung cư B1 Nguyễn Ái Quốc, phường Trấn Biên, Biên Hòa, Đồng Nai';
  const resolved = resolveAddress(text);
  assert.equal(resolved.ward, null);
  assert.equal(resolved.postMerger, true);
  assert.equal(resolved.district?.name, 'Thành phố Biên Hòa', 'khách tự ghi Biên Hòa');
  assert.equal(resolvedAddressFields(text).ward, '');
  assert.equal(describeDeliveryAddress(text).canonical, text);
});

test('fix-addr #339: "P. Nam Hoa Lư, Ninh Bình" không thành Huyện Hoa Lư', () => {
  const text = 'Sn 89 ngõ 914 đường nguyễn công trứ. P. Nam hoa lư . Ninh bình';
  const resolved = resolveAddress(text);
  assert.deepEqual(names(resolved), ['Ninh Bình', '', '']);
  assert.equal(resolved.postMerger, true);
  assert.deepEqual(fieldsOf(text), ['Ninh Bình', '', '']);
});

test('fix-addr: "xã đông Trạch, quảng tri" (đơn đã lưu) không thành Quảng Bình / Bố Trạch / Xã Đồng Trạch', () => {
  const text = 'Chợ lý hoà xã đông Trạch tỉnh quảng tri';
  const resolved = resolveAddress(text);
  assert.deepEqual(names(resolved), ['Quảng Trị', '', '']);
  assert.equal(resolved.postMerger, true);
  assert.deepEqual(fieldsOf(text), ['Quảng Trị', '', '']);
  // Khách gõ đúng tên cũ (có dấu "Đồng") kèm huyện cũ thì vẫn là địa chỉ cũ.
  assert.deepEqual(names(resolveAddress('thôn 2, xã Đồng Trạch, huyện Bố Trạch, Quảng Bình')), ['Quảng Bình', 'Huyện Bố Trạch', 'Xã Đồng Trạch']);
});

test('fix-addr: phường mới Hà Nội/TPHCM trùng xã cũ nơi khác (Thanh Xuân, Hồng Hà, Đại Thanh, Bình Trưng, Tân Hưng)', () => {
  for (const [text, province] of [
    ['12 Nguyễn Tuân, phường Thanh Xuân, Hà Nội', 'Hà Nội'],
    ['5 Yên Phụ, phường Hồng Hà, Hà Nội', 'Hà Nội'],
    ['5 ngõ 2 phường Đại Thanh, Hà Nội', 'Hà Nội'],
    ['12 Tên Lửa phường Bình Trưng, TPHCM', 'TP Hồ Chí Minh'],
    ['8 Lê Văn Lương phường Tân Hưng, TPHCM', 'TP Hồ Chí Minh']
  ]) {
    const resolved = resolveAddress(text);
    assert.equal(resolved.province?.name, province, text);
    assert.equal(resolved.ward, null, text);
    assert.equal(resolved.postMerger, true, text);
    assert.deepEqual(fieldsOf(text), [province, '', ''], text);
    assert.equal(describeDeliveryAddress(text).canonical, text, text);
  }
  // Không còn sai tỉnh: Bình Trưng (TPHCM) không thành Bà Rịa-Vũng Tàu / Châu Đức.
  assert.notEqual(resolveAddress('phường Bình Trưng, TPHCM').district?.name, 'Huyện Châu Đức');
});

test('fix-addr: POS nhận địa chỉ chữ đầy đủ khi cột phường trống (không mã phường)', () => {
  const address = '79 Đặng Thùy Trâm, phường Bình Lợi Trung, TPHCM';
  const order = { id: 'x1', name: 'Khách', phone: '0900000001', address, ...resolvedAddressFields(address), products: [], total: 0 };
  const payload = buildPosOrderPayload(order, { geo: { provinceId: '79' } });
  assert.equal(payload.shipping_address.address, address);
  assert.equal(payload.shipping_address.full_address, address);
  assert.equal(payload.shipping_address.commune_id, undefined);
  assert.equal(payload.shipping_address.commnue_name, undefined);
});

test('fix-addr: danh mục phường/xã mới đủ 34 tỉnh, 3.321 đơn vị (NQ UBTVQH 2025)', () => {
  const keys = Object.keys(NEW_WARD_UNITS_2025);
  assert.equal(keys.length, 34);
  const total = Object.values(NEW_WARD_UNITS_2025).reduce((sum, units) => sum + units.split('|').length, 0);
  assert.equal(total, 3321);
  assert.ok(NEW_WARD_UNITS_2025['dong nai'].split('|').includes('phường Trấn Biên'));
  assert.ok(accentCompatible('bình chau', 'Bình Châu'), 'chữ gõ không dấu thì bỏ qua');
  assert.equal(accentCompatible('đông Trạch', 'Đồng Trạch'), false);
});

// ===== 2. Số nhà =====

test('fix-addr #35: "88 láng hạ," không bị coi là câu đáp ngắn; "phố Láng Hạ" không bị cắt "ạ"', () => {
  assert.equal(cleanAddressText('Địa chỉ:88 láng hạ, phường Láng, hà nội'), '88 láng hạ, phường Láng, hà nội');
  assert.equal(cleanAddressText('88 Láng Hạ, Hà Nội'), '88 Láng Hạ, Hà Nội');
  assert.equal(cleanAddressText('số 5 phố Láng Hạ'), 'số 5 phố Láng Hạ');
  assert.equal(expandAddressAbbreviations('số 5 phố Láng Hạ'), 'số 5 phố Láng Hạ');
  assert.equal(cleanAddressText('12 Lê Lợi nha, Quận 1, HCM'), '12 Lê Lợi nha, Quận 1, HCM');
  // Câu đáp ngắn thật vẫn bỏ như cũ.
  assert.equal(cleanAddressText('1 trước ạ. 12 Lê Lợi, Q1, HCM'), '12 Lê Lợi, Q1, HCM');
  assert.equal(cleanAddressText('ok shop, 12 Lê Lợi Q1 HCM'), '12 Lê Lợi Q1 HCM');
  assert.equal(cleanAddressText('2 túi nha, 5 Lý Thường Kiệt, Hoàn Kiếm, Hà Nội'), '5 Lý Thường Kiệt, Hoàn Kiếm, Hà Nội');
});

test('fix-addr #148: "12 cửa đại hội an" — tên phường ngay sau số nhà là tên đường, không hỏi lại đường', () => {
  const described = describeDeliveryAddress('12 cửa đại hội an quảng nam');
  assert.equal(described.resolved.street, '12 cửa đại');
  assert.equal(described.resolved.ward, null);
  assert.equal(described.complete, true);
  assert.equal(described.wardUnverified, true);
  // "số nhà + đường 3/2 + phường" không bị chặn.
  assert.equal(resolveAddress('2/31b 3/2 Hưng lợi, ninh kiều, tp Cần Thơ').ward?.name, 'Phường Hưng Lợi');
});

test('fix-addr: số nhà khách gõ phải còn trên địa chỉ cuối (houseNumbersOf / lostHouseNumbers)', () => {
  assert.deepEqual(houseNumbersOf('71/82 khu phố 1 phường Long Bình Tân'), ['71/82', '1']);
  assert.deepEqual(houseNumbersOf('19A huỳnh đình Hai, Phường 14, Combo 2 tui, 0912345678'), ['19a']);
  assert.deepEqual(lostHouseNumbers('71/82 khu phố 1 phường Long Bình Tân', 'Gần siêu thị Big C, Phường Long Bình Tân'), ['71/82', '1']);
  assert.deepEqual(lostHouseNumbers('19A Huỳnh Đình Hai, P14', '19A Huỳnh Đình Hai, Phường 14, Quận Bình Thạnh'), []);
});

test('fix-addr: mô hình chat viết lại địa chỉ bỏ số nhà ("Gần siêu thị Big C") → giữ chữ khách + ghi chú đối chiếu', () => {
  const parsed = { template_id: 'ORDER_CONFIRMATION', Customer_Address: 'Gần siêu thị Big C, Phường Long Bình Tân, Biên Hòa, Đồng Nai' };
  keepTypedHouseNumber(parsed, { recentCustomerTexts: ['71/82 khu phố 1 phường Long Bình Tân Biên Hòa Đồng Nai', 'Chị ở gần sthị big c'], messageText: 'ok em' });
  assert.equal(parsed.Customer_Address, '71/82 khu phố 1 phường Long Bình Tân Biên Hòa Đồng Nai');
  assert.match(parsed.addressAiCheck, /71\/82/);
  assert.match(parsed.addressAiCheck, /cần đối chiếu/);
  // Mô hình giữ số nhà thì không đổi gì.
  const kept = { Customer_Address: '71/82 khu phố 1, Phường Long Bình Tân, Biên Hòa, Đồng Nai' };
  keepTypedHouseNumber(kept, { recentCustomerTexts: ['71/82 khu phố 1 phường Long Bình Tân Biên Hòa Đồng Nai'] });
  assert.equal(kept.Customer_Address, '71/82 khu phố 1, Phường Long Bình Tân, Biên Hòa, Đồng Nai');
  assert.equal(kept.addressAiCheck, undefined);
});

// ===== 3. Câu thường bị coi là địa chỉ =====

test('fix-addr: câu thường/phủ định không vào luồng địa chỉ và không thay địa chỉ đã có số nhà', () => {
  for (const text of ['Quà thay là gì ạ', 'Dạ vâng ạ', 'Ba túi ba vị nhé', 'Không phải Tân An long an', 'không phải phường biên hòa ạ', 'Có đường trong đó k shop', 'Lấy date xa dùm chị nhé']) {
    assert.equal(orderFlowStep(text, { hasBasket: true, lastWasOrderStep: true }), null, text);
  }
  assert.equal(resolveAddress('Dạ vâng ạ').province, null, '"da vang" không sửa chính tả thành Đà Nẵng');
  const saved = '12 Lê Lợi, phường Bến Thành, TPHCM';
  assert.equal(mergeAddressFragment('Quà thay là gì', saved), saved);
  // Địa chỉ thật vẫn vào luồng như trước.
  assert.equal(orderFlowStep('Xóm 3 xã Vô Tranh Phú Lương', { hasBasket: true, lastWasOrderStep: true })?.rule, 'ADDRESS_PARTIAL');
  assert.equal(orderFlowStep('12 Lê Lợi, Bến Thành, Quận 1, TPHCM', { hasBasket: true, lastWasOrderStep: true })?.rule, 'ADDRESS_PARTIAL');
});

// ===== 4. Landing =====

test('fix-addr: landing không đè địa chỉ khách vừa gõ (có số nhà/đường) bằng địa chỉ POS cũ ở nơi khác', async () => {
  const fetchAddresses = async () => ['5 Lê Lợi, Phường Bến Nghé, Quận 1, TP Hồ Chí Minh'];
  assert.equal(await pickAddressForPhone({ id: 'a', phone: '0900000001', address: '12 Tên Lửa, phường Bình Tân, TPHCM' }, [], { fetchAddresses }), null);
  // Địa chỉ POS có đúng phần đường khách gõ thì vẫn lấy (bổ sung phường/quận).
  const same = await pickAddressForPhone({ id: 'b', phone: '0900000001', address: '5 Lê Lợi, TPHCM' }, [], { fetchAddresses });
  assert.equal(same?.address, '5 Lê Lợi, Phường Bến Nghé, Quận 1, TP Hồ Chí Minh');
  // Khách không gõ số nhà/đường: như cũ.
  const none = await pickAddressForPhone({ id: 'c', phone: '0900000001', address: 'Chưa có địa chỉ' }, [], { fetchAddresses });
  assert.equal(none?.address, '5 Lê Lợi, Phường Bến Nghé, Quận 1, TP Hồ Chí Minh');
});

// ===== 5. AI =====

const settings = { provider: 'vertex', directAuthType: 'api_key', directApiKey: 'key', directEndpoint: 'https://aiplatform.googleapis.com/v1/projects/p/locations/global/publishers/google/models/gemini-3-flash-preview:generateContent', directModel: 'gemini-3-flash-preview', addressAi: true, addressAiSearch: true };
const reply = json => async () => ({ ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text: JSON.stringify(json) }] } }] }) });

test('fix-addr AI: phần đường giữ chữ khách, phường bịa (không có trong chữ khách) thì độ tin thấp', () => {
  const raw = '19A huỳnh đình Hai, p14, Bình Thạnh Combo 2 tui';
  const dropped = validateAddressGuess({ province: 'Thành phố Hồ Chí Minh', district: 'Quận Bình Thạnh', ward: 'Phường 14', street: 'Huỳnh Đình Hai' }, '19A huỳnh đình Hai, p14');
  assert.equal(dropped.ok, true);
  assert.match(dropped.canonical, /^19A huỳnh đình Hai, Phường 14/);
  const invented = validateAddressGuess({ province: 'Thành phố Hồ Chí Minh', district: 'Quận 8', ward: 'Phường 5', street: '' }, '332 ta quang Bửu p4');
  assert.equal(invented.ok, true);
  assert.equal(invented.wardInText, false, 'AI trả Phường 5 trong khi khách ghi p4');
  assert.ok(raw);
  assert.match(addressAiSystemPrompt, /KHÔNG quy đổi về phường\/quận cũ/);
});

test('fix-addr AI: khách chỉ ghi phường MỚI ("phường chánh hưng") — giữ chữ khách + tỉnh, không bịa số nhà/phường cũ', async () => {
  const onlyWard = validateAddressGuess({ province: 'Thành phố Hồ Chí Minh', district: 'Quận 8', ward: 'Phường 5', street: '99 Phạm Hùng' }, 'phường chánh hưng');
  assert.equal(onlyWard.ok, true);
  assert.equal(onlyWard.postMerger, true);
  assert.equal(onlyWard.canonical, 'phường chánh hưng, TP Hồ Chí Minh');
  assert.equal(onlyWard.ward, '');
  // Bộ đọc đã coi là địa chỉ sau sáp nhập: không nhận quy đổi về đơn vị cũ.
  const typedNew = validateAddressGuess({ province: 'Thành phố Hồ Chí Minh', district: 'Quận 8', ward: 'Phường 5', street: '' }, 'phường chánh hưng quận 8');
  assert.equal(typedNew.ok, false);
  resetAddressAiCache();
  const parsed = { template_id: 'ORDER_CONFIRM', Customer_Address: '332 ta quang Bửu phường chánh hưng' };
  await refineAddressWithAi(parsed, {}, settings, reply({ province: 'Thành phố Hồ Chí Minh', district: '', ward: '', street: '332 Tạ Quang Bửu', confidence: 'high', ambiguous: false, reason: 'địa chỉ sau sáp nhập' }));
  assert.equal(parsed.Customer_Address, '332 ta quang Bửu phường chánh hưng, TP Hồ Chí Minh');
  assert.equal(describeDeliveryAddress(parsed.Customer_Address).complete, true);
});

test('fix-addr AI: thiếu phường (wardUnverified) chỉ hỏi AI khi được bật (landing chạy nền), chatbot thì không', async () => {
  resetAddressAiCache();
  const text = '18 ngách 143/300 phố nguyễn chính hoàng mai hà nội';
  assert.equal(describeDeliveryAddress(text).wardUnverified, true);
  let calls = 0;
  const fetchImpl = async (...args) => { calls += 1; return reply({ province: 'Thành phố Hà Nội', district: 'Quận Hoàng Mai', ward: 'Phường Tân Mai', street: '18 ngách 143/300 phố Nguyễn Chính', confidence: 'high', ambiguous: false, reason: 'x' })(...args); };
  assert.equal(await inferAddress(text, { settings, fetchImpl }), null);
  assert.equal(calls, 0);
  const guess = await inferAddress(text, { settings, fetchImpl, allowWardUnverified: true });
  assert.equal(calls, 1);
  assert.equal(guess.canonical, '18 ngách 143/300 phố nguyễn chính, Phường Tân Mai, Quận Hoàng Mai, Hà Nội');
  assert.equal(guess.confidence, 'low', 'phường AI suy ra không có trong chữ khách → nhân viên đối chiếu');
});

// ===== 7. Viết tắt / viết dính / ghi chú "cũ" / phường sau quận =====

test('fix-addr: hbt, ka hp, tpvtau (cũ), tt huế, p8q11, p12Q5, qui nhơn, "( địa chỉ cũ )", phường ghi sau quận', () => {
  assert.equal(resolveAddress('Số 1c trần thánh tông hbt hn').district?.name, 'Quận Hai Bà Trưng');
  assert.equal(resolveAddress('264 đồng hòa ka hp').district?.name, 'Quận Kiến An');
  assert.deepEqual(names(resolveAddress('249/8 bình giã - phường 8 - tpvtau (cũ)')), ['Bà Rịa-Vũng Tàu', 'Thành phố Vũng Tàu', 'Phường 8']);
  assert.deepEqual(names(resolveAddress('đội 3 thôn phú lộc xã phong chương huyện phong điền tt huế')), ['Thừa Thiên Huế', 'Huyện Phong Điền', 'Xã Phong Chương']);
  assert.deepEqual(names(resolveAddress('43 dương đình nghệ p8q11')), ['TP Hồ Chí Minh', 'Quận 11', 'Phường 8']);
  assert.deepEqual(names(resolveAddress('277/11 Nguyễn chí thanh p12Q5 TPHCM')), ['TP Hồ Chí Minh', 'Quận 5', 'Phường 12']);
  assert.equal(resolveAddress('99 Lê Lợi, tp qui nhơn').district?.name, 'Thành phố Quy Nhơn');
  assert.deepEqual(names(resolveAddress('Pk sản số 2 Lê Đức thọ mai dịch cầu giấy Hà Nội ( địa chỉ cũ )')), ['Hà Nội', 'Quận Cầu Giấy', 'Phường Mai Dịch']);
  assert.deepEqual(names(resolveAddress('270 nguyễn văn cừ thành phố vinh nghệ an phường hưng phúc')), ['Nghệ An', 'Thành phố Vinh', 'Phường Hưng Phúc']);
});
