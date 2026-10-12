// Vòng 18 — Gói B: làm sạch địa chỉ khách gõ trước khi lên phiếu (out-inbox2 N3, out-inbox3 N5, out-inbox1/4 Nhẹ).
// Câu khách THẬT, SĐT thay bằng số giả, số nhà đổi bớt.
import './helpers/seed-catalog.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { cleanAddressText, extractDeliveryNote, isNonAddressSegment, orderFlowStep } from '../app/processing/order-flow.mjs';
import { describeDeliveryAddress, mergeAddressFragment } from '../app/processing/locations.mjs';

test('R18-B (inbox2 N3, …138672): dòng tên người nhận đứng sau SĐT ("Dũng") không lên địa chỉ', () => {
  const out = cleanAddressText('12f đường 15 kp4 phường An khánh tphcm\n0912345678\nDũng');
  assert.equal(out, '12f đường 15 kp4 phường An khánh tphcm');
});

test('R18-B (inbox2 N3, …686900): tin "M gửi nhé" gộp cùng cụm không lên địa chỉ', () => {
  const out = cleanAddressText('0912345678\n6/5 Vũ chí thắng( cổng trường mầm non Hoa Cúc) nghĩa xá, Lê chân, Hải phòng\nM gửi nhé');
  assert.doesNotMatch(out, /M gửi/u, out);
  assert.match(out, /Vũ chí thắng/u);
  assert.match(out, /Lê chân/u);
  assert.equal(isNonAddressSegment('M gửi'), true);
  assert.equal(isNonAddressSegment('Mình lấy nhé'), true);
  // Địa danh/đường hai chữ vẫn là mảnh địa chỉ.
  assert.equal(isNonAddressSegment('Gửi Ngô Quyền'), false);
});

test('R18-B (inbox3 N5, …1266888): câu đệm đầu "Chị quên." bị bỏ, mảnh phường + tỉnh ghép vào địa chỉ trường đã gửi', () => {
  const fresh = cleanAddressText('Chị quên.Phường Gia Viên Hải Phòng');
  assert.equal(fresh, 'Phường Gia Viên Hải Phòng');
  const merged = mergeAddressFragment(fresh, 'Trường MN sao sáng 4 phân hiệu 2( Trường MN 20/10 cũ)');
  assert.match(merged, /Trường MN sao sáng 4 phân hiệu 2/u, merged);
  assert.match(merged, /Gia Viên/u);
});

test('R18-B (inbox3 N5, …0645476): tên người nhận "C hương." đứng đầu bị bỏ', () => {
  const out = cleanAddressText('C hương. Phố hạnh phúc. Phường điện biên phủ (phố 6, phường Thanh Bình cũ). tỉnh điện biên.');
  assert.doesNotMatch(out, /^C hương/u, out);
  assert.match(out, /Phố hạnh phúc/u);
  assert.match(out, /Phường điện biên phủ/u);
  // "Cô Bắc." / "Chi Lăng." mở đầu là tên đường (không phải "chị/cô + tên") — giữ nguyên.
  assert.match(cleanAddressText('Cô Bắc. Số 25, Phường Cầu Ông Lãnh, Quận 1, TP HCM'), /^Cô Bắc/u);
  assert.match(cleanAddressText('Chi Lăng. Số 25, Phường 9, Quận Phú Nhuận, TP HCM'), /^Chi Lăng/u);
});

test('R18-B (inbox3 N5, …7118377): ghi chú giao "ship ngày mai hoặc sáng thứ 2 nhận nhé, hàng mới" ra khỏi địa chỉ, vào ghi chú đơn', () => {
  const raw = 'Đc 169 đường 83 thạnh mỹ lợi tphcm, ship ngày mai hoặc sáng thứ 2 nhận nhé, hàng mới ,đt0912345678';
  const out = cleanAddressText(raw);
  assert.doesNotMatch(out, /ship|hàng mới/u, out);
  assert.match(out, /169 đường 83 thạnh mỹ lợi tphcm/u);
  const note = extractDeliveryNote(raw);
  assert.match(note, /ship ngày mai/u, note);
  assert.match(note, /hàng mới/u, note);
});

test('R18-B (inbox3 N5, …8673862 / …2247784): tên dính sau SĐT ("…752_vân", "- Huệ") không lên địa chỉ', () => {
  assert.equal(cleanAddressText('39A Quách Đình Bảo, Phường Phú Thạnh, Quận Tân Phú, TP.HCM\n0912 345 678_vân'), '39A Quách Đình Bảo, Phường Phú Thạnh, Quận Tân Phú, TP.HCM');
  const out = cleanAddressText('Số nhà 11 ngõ 13 thôn phù đổng 1 xã phù đổng . Tp hà nội\nĐT : 0912345678- Huệ');
  assert.doesNotMatch(out, /Huệ|-\s*$/u, out);
  assert.match(out, /Tp hà nội$/u);
});

test('R18-B (inbox4 L2, …82795735): dòng tên "Kim Thuỷ" giữa SĐT và địa chỉ không lên địa chỉ', () => {
  const out = cleanAddressText('0912345678\nKim Thuỷ\n31, chu văn an , phường 4, thành phố trà vinh, tỉnh trà vinh');
  assert.doesNotMatch(out, /Kim Thuỷ/u, out);
  assert.match(out, /^31, chu văn an/u);
});

test('R18-B (inbox1 Nhẹ, Lục Bình Hoa): dòng "Người nhận : …" và nhãn "Điên thoại" (gõ sai) không lên địa chỉ', () => {
  const out = cleanAddressText('LôB10-08 Chung cư Nguyễn Thượng Hiền, F1 Q Gò vấp TPHCM\nĐiên thoại 0912345678\nNgười nhận : Lục Bình Hoa');
  assert.equal(out, 'LôB10-08 Chung cư Nguyễn Thượng Hiền, F1 Q Gò vấp TPHCM');
});

test('R18-B (inbox2 V6, …610843): "( đc củ)" kèm địa chỉ đủ — bỏ cụm này khỏi địa chỉ, giữ "phường Thanh Bình cũ"', () => {
  assert.equal(cleanAddressText('Đc 03 nguyễn hới p nguyễn an ninh tpvt ( đc củ) 0912345678'), '03 nguyễn hới p nguyễn an ninh tpvt');
  assert.match(cleanAddressText('Phố 6 (phường Thanh Bình cũ), tỉnh điện biên'), /phường Thanh Bình cũ/u);
});

test('R18-B (inbox2 V6, …610843): đang giữ giỏ, khách gửi địa chỉ đủ + "(đc củ)" + SĐT → lên đơn (PHONE_ADDRESS), không hỏi SĐT lần trước', () => {
  const raw = 'Đc 03 nguyễn hới p nguyễn an ninh tpvt ( đc củ) 0912345678';
  const step = orderFlowStep(raw, { hasBasket: true, lastWasOrderStep: true, addressComplete: true, hasPreviousDelivery: false });
  assert.equal(step?.rule, 'PHONE_ADDRESS', JSON.stringify(step));
  assert.equal(step.value.Phone_Number, '0912345678');
  assert.doesNotMatch(step.value.Customer_Address, /củ|cũ/u);
});

test('R18-B (inbox2 Nhẹ, …107101): chữ "cũ" chú thích tên xã không dính vào phần số nhà trên phiếu', () => {
  const described = describeDeliveryAddress(cleanAddressText('Đc  thôn gò mái xã hợp tiến cũ số nhà35\nHuyện mỹ đức thành phố hà nội'));
  assert.doesNotMatch(described.canonical, /cũ số nhà/u, described.canonical);
  assert.match(described.canonical, /số nhà35/u);
  assert.match(described.canonical, /Hợp Tiến/u);
  // "Củ Chi" (tên huyện) đứng đầu mảnh không bị cắt.
  assert.match(describeDeliveryAddress('ấp 3, củ chi kiểu mới, Xã Tân Thạnh Đông, Huyện Củ Chi, TP Hồ Chí Minh').canonical, /củ chi kiểu mới/iu);
});

test('R18-B (inbox4 N6, …76253109): lô tin có 2 SĐT ("số sau") → lấy số CUỐI', () => {
  const step = orderFlowStep('0912345699\n0912345678', { hasBasket: true, lastWasOrderStep: true });
  assert.equal(step?.rule, 'PHONE_ONLY', JSON.stringify(step));
  assert.equal(step.value.Phone_Number, '0912345678');
});

test('R18-B (chủ shop 12/10): ghi chú kho trong ngoặc ĐẦU địa chỉ ("(Tặng BGD)", "(Live)") giữ nguyên qua làm sạch và ghép mảnh', () => {
  for (const tagged of ['(Tặng BGD) Tổ 9, phường Quang Trung, TP Thái Nguyên', '(Live) 12 Lê Lợi, Phường Bến Nghé, Quận 1, TP Hồ Chí Minh', '(Tặng BGD) (Live) Số 5 ngõ 2, Xã Hợp Tiến, Huyện Mỹ Đức, Hà Nội']) {
    const tag = tagged.match(/^(?:\([^)]*\)\s*)+/u)[0].trim();
    assert.ok(cleanAddressText(tagged).startsWith(tag), cleanAddressText(tagged));
    const merged = mergeAddressFragment('số nhà 7', tagged);
    assert.ok(merged.startsWith(tag), merged);
    assert.match(merged, /số nhà 7/u);
    assert.ok(mergeAddressFragment('', tagged).startsWith(tag));
  }
});
