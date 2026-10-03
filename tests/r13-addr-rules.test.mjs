// Vòng 13 (02/10) — bộ đọc địa chỉ (locations.mjs): nhóm lỗi K1–K8, K10 của báo cáo r13/out-address.md.
// Mỗi ca dùng ĐÚNG chuỗi địa chỉ khách/đơn thật (không tên khách, không số điện thoại).
// Nguyên tắc bất biến: không tăng ca gán sai phường/quận/tỉnh; thà giữ chữ khách còn hơn gán sai.
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ADDRESS_PICK_CONFLICT_REASON, addressTailConflict, describeDeliveryAddress, expandAddressAbbreviations,
  resolveAddress, resolvedAddressFields, typedVsPickedConflict
} from '../app/processing/locations.mjs';

const columns = text => { const fields = resolvedAddressFields(text); return [fields.ward, fields.district, fields.province]; };

// ===== K4: tên phường/xã MỚI bị bắt nhầm =====

test('r13-addr K4: có "phường/xã X" rõ thì chỉ xét X — tên thôn/ấp/khu/đường trùng tên mới không phải phường của địa chỉ', () => {
  // "thôn Phước Hải" từng bị bắt làm phường mới, bỏ mất Tân Hải (đơn …4a8151).
  assert.deepEqual(columns('Tổ 5 thôn Phước Hải phường Tân Hải Phú Mỹ bà Rịa vũng tàu'), ['Xã Tân Hải', 'Thị xã Phú Mỹ', 'Bà Rịa-Vũng Tàu']);
  assert.notEqual(resolveAddress('Tổ 5 thôn Phước Hải phường Tân Hải Phú Mỹ bà Rịa vũng tàu').newWard, 'phuoc hai');
  // "ấp Mỹ thạnh" từng bị bắt; khách ghi "xã Mỹ phong" + "TP MT tiền giang" (Mỹ Tho) → giữ mã Xã Mỹ Phong (đơn …053195).
  assert.deepEqual(columns('226/d ấp Mỹ thạnh xã Mỹ phong TP MT tiền giang'), ['Xã Mỹ Phong', 'Thành phố Mỹ Tho', 'Tiền Giang']);
  // "võ nguyên giáp" (tên đường mang họ người) từng bị bắt thành phường mới "Nguyên Giáp" (đơn …464d08).
  const anBien = resolveAddress('Chung cư hoàng huy võ nguyên giáp phường an biên Hải Phòng');
  assert.equal(anBien.newWard, 'an bien');
  assert.equal(anBien.province?.name, 'Hải Phòng');
  // "khu thống nhất 2" từng bị bắt thành phường mới "Thống Nhất"; tên mới khách ghi là Hà An (đơn …d76931).
  const haAn = resolveAddress('Phường hà an khu thống nhất 2 thành phố Quảng Ninh');
  assert.equal(haAn.newWard, 'ha an');
  assert.equal(haAn.postMerger, true);
  // "Ngõ 161 Ngọc Hồi … phường yên sở": tên đường Ngọc Hồi không phải phường mới Ngọc Hồi (đơn …6e8a13).
  assert.equal(resolveAddress('Ngõ 161 Ngọc Hồi tòa Athena phường yên sở - tp Hà Nội').newWard, 'yen so');
});

test('r13-addr K4: tên mới chỉ là phần đầu/gối lên một tên dài hơn, hay nằm trong tên tỉnh do viết tắt mở ra, thì không bắt', () => {
  // "thanh xuân bắc" không phải phường mới "Thanh Xuân"; "thế VINH THANH xuân…" cũng không phải xã mới "Vĩnh Thanh" (đơn …f1bced).
  const thanhXuan = resolveAddress('99luong thê vinh thanh xuân bắc ha nôi');
  assert.equal(thanhXuan.newWard, undefined);
  assert.equal(thanhXuan.postMerger, false);
  assert.equal(thanhXuan.ward, null);
  assert.equal(thanhXuan.province?.name, 'Hà Nội');
  // "hiệp bình chánh" là phường cũ của Thủ Đức, không phải phường mới "Hiệp Bình" + Huyện Bình Chánh (đơn …a2566d).
  assert.deepEqual(columns('21b đường 6 phường hiệp bình chánh tphcm'), ['Phường Hiệp Bình Chánh', 'Thành phố Thủ Đức', 'TP Hồ Chí Minh']);
  // "(brvt cũ)" mở ra "Bà Rịa - Vũng Tàu": không bắt phường mới "Vũng Tàu"; tên mới khách ghi là Phú Mỹ (đơn …920364).
  const phuMy = resolveAddress('178, độc lập, phường Phú Mỹ, TPhcm (brvt cũ)');
  assert.equal(phuMy.newWard, 'phu my');
  assert.notEqual(phuMy.newWard, 'vung tau');
  assert.equal(phuMy.street, '178, độc lập');
  // "đặc khu Phú Quốc" là khách ghi rõ loại hình cấp xã mới (không bị chữ "khu" loại).
  assert.equal(resolveAddress('Số 9 Trần Hưng đạo dương đông đặc khu Phú Quốc tỉnh an giang').newWard, 'phu quoc');
  // Họ người chỉ tính khi đúng dấu: "khả lễ võ cường" vẫn là phường mới Võ Cường (lễ ≠ Lê).
  assert.equal(resolveAddress('Số nhà 199 đường Lê thánh Tông khu khả lễ võ cường Bắc ninh').newWard, 'vo cuong');
});

// ===== K1 + K3: khác loại hình Phường/Xã nhưng khách ghi đúng quận chứa phường → giữ mã =====

test('r13-addr K1/K3: "Phường X, <quận>" mà danh mục kho là "Xã X" cùng quận → cột lưu vẫn giữ mã phường/quận', () => {
  assert.deepEqual(columns('Số nhà C01C, Khu đô thị Gold 6B, Khối 23, Phường Nghi Phú, Thành phố Vinh, Nghệ An'), ['Xã Nghi Phú', 'Thành phố Vinh', 'Nghệ An']);
  assert.deepEqual(columns('Đường d5 khu tái định cư cường thuận, Phường Phước Tân, Thành phố Biên Hòa, Đồng Nai'), ['Xã Phước Tân', 'Thành phố Biên Hòa', 'Đồng Nai']);
  assert.deepEqual(columns('Trung tâm, hanh chinh thuỷ nguyên khu nha A cửa 1, Phường Dương Quan, Thành phố Thủy Nguyên, Hải Phòng'), ['Xã Dương Quan', 'Huyện Thủy Nguyên', 'Hải Phòng']);
  // Bot vẫn giữ nguyên chữ khách trên phiếu (khách ghi "Phường", không đổi thành "Xã").
  const delivery = describeDeliveryAddress('Số nhà C01C, Khu đô thị Gold 6B, Khối 23, Phường Nghi Phú, Thành phố Vinh, Nghệ An');
  assert.equal(delivery.complete, true);
  assert.equal(delivery.keepAsTyped, true);
  assert.match(delivery.canonical, /Phường Nghi Phú, Thành phố Vinh/);
  // Không ghi quận (chỉ "TP X" trùng tên tỉnh, hay tỉnh khác): vẫn giữ chữ, không gán mã — như trước.
  assert.equal(resolvedAddressFields('số 678 đường Trần Hưng đạo cầu ngà phường nam Sơn thành phố Bắc ninh').ward, '');
  assert.deepEqual(columns('L25 đường dương bạch mai phường an hòa rạch giá kiên giang, An Giang'), ['', '', 'An Giang']);
});

test('r13-addr K3: "Krông Pắk" (POS) / "krông pack" là Huyện Krông Pắc — khớp mờ không làm rơi quận', () => {
  assert.deepEqual(columns('Km44, Xã Ea Kly, Huyện Krông Pắk, Đắk Lắk'), ['Xã Ea Kly', 'Huyện Krông Pắc', 'Đắk Lắk']);
  assert.deepEqual(columns('Thôn 2 xã tân tiến krông pack daklak, Xã Tân Tiến, Huyện Krông Pắk, Đắk Lắk'), ['Xã Tân Tiến', 'Huyện Krông Pắc', 'Đắk Lắk']);
});

// ===== K2: khách gõ tỉnh mới + bộ phường–quận–tỉnh cũ đủ trong địa chỉ → giữ ba cột cũ =====

test('r13-addr K2: tỉnh MỚI khách gõ + ô chọn ba cấp CŨ khớp danh mục → giữ ba cột (không còn chỉ tỉnh mới)', () => {
  assert.deepEqual(
    columns('Quán Cafe Ngọc, góc đường số 3 và số 6, khu dân cư Trần Anh, ấp mới 2, xã Mỹ Hạnh,  tỉnh Tây Ninh, Xã Mỹ Hạnh Nam, Huyện Đức Hòa, Long An'),
    ['Xã Mỹ Hạnh Nam', 'Huyện Đức Hòa', 'Long An']);
  assert.deepEqual(columns('KP 10 phường Dương Đông Đặc Khu Phú Quốc Tỉnh An Giang, Phường Dương Đông, Thành phố Phú Quốc, Kiên Giang'), ['Phường Dương Đông', 'Thành phố Phú Quốc', 'Kiên Giang']);
  assert.deepEqual(columns('245- Lương Thế Vinh - Thị trấn Gôi- huyện Vụ Bản - tỉnh Ninh Bình, Thị trấn Gôi, Huyện Vụ Bản, Nam Định'), ['Thị trấn Gôi', 'Huyện Vụ Bản', 'Nam Định']);
  // Không có tên tỉnh cũ trong địa chỉ (khách chỉ ghi tỉnh mới): giữ chữ khách như trước, không gán phường/quận cũ.
  assert.deepEqual(columns('18ô3 KP thanh long xã đất đỏ thành phố Hồ Chí Minh'), ['', '', 'TP Hồ Chí Minh']);
  assert.deepEqual(columns('Ấp Kinh tram xã Hòa Hưng an giang'), ['', '', 'An Giang']);
});

// ===== K5: cột quận/huyện sai =====

test('r13-addr K5: "Lắk" của "Đắk Lắk", "Bình Chánh" của "Hiệp Bình Chánh", "TP Huế" gọi cả tỉnh không thành quận/huyện', () => {
  const krongPac = resolvedAddressFields('87quang trung .phước an . Krong pắc Đăk lăk, Đắk Lắk');
  assert.notEqual(krongPac.district, 'Huyện Lắk');
  assert.deepEqual([krongPac.ward, krongPac.district, krongPac.province], ['Thị trấn Phước An', 'Huyện Krông Pắc', 'Đắk Lắk']);
  assert.notEqual(resolvedAddressFields('21b đường 6 phường hiệp bình chánh tphcm').district, 'Huyện Bình Chánh');
  const phongDien = resolvedAddressFields('Thôn7 điền hải phong điền tp huế');
  assert.notEqual(phongDien.district, 'Thành phố Huế');
  assert.deepEqual([phongDien.ward, phongDien.district, phongDien.province], ['Xã Điền Hải', 'Huyện Phong Điền', 'Thừa Thiên Huế']);
  const phuLoc = resolvedAddressFields('Thôn 9 huong xuân Phú Lộc TP Huế');
  assert.equal(phuLoc.district, 'Huyện Phú Lộc');
  assert.equal(phuLoc.ward, '');
  // Chỉ có "TP Huế" thì vẫn là Thành phố Huế như trước.
  assert.equal(resolveAddress('12 lê lợi phường vĩnh ninh tp huế').district?.name, 'Thành phố Huế');
});

test('r13-addr K5: không sửa chính tả bừa — "quan binh" không thành tỉnh Quảng Bình, "dfooong hưng" không thành Thị trấn Đông Hưng', () => {
  const quanBinh = resolveAddress('02 nha xe lo cu xa thanh da phuong 27 quan binh');
  assert.equal(quanBinh.province, null);
  const trongQuan = resolvedAddressFields('chợ trọng quan dfooong hưng thái bình');
  assert.equal(trongQuan.ward, '');
  assert.equal(trongQuan.district, 'Huyện Đông Hưng');
  assert.equal(describeDeliveryAddress('chợ trọng quan dfooong hưng thái bình').complete, false);
});

// ===== K6: đuôi "(cũ)/củ", mốc sau tên tỉnh, viết tắt =====

test('r13-addr K6: chú thích "cũ/củ" sau tên cấp và mốc sau tên tỉnh không làm trượt địa chỉ', () => {
  assert.deepEqual(columns('Khu phố 2 p Tân định bến cát bình dương ( củ)'), ['Phường Tân Định', 'Thị xã Bến Cát', 'Bình Dương']);
  assert.deepEqual(columns('276/55 thống nhất p16 gò vấp củ HCM'), ['Phường 16', 'Quận Gò Vấp', 'TP Hồ Chí Minh']);
  assert.equal(resolveAddress('276/55 thống nhất p16 gò vấp củ HCM').street, '276/55 thống nhất');
  const anThoi = resolveAddress('251/6 đồng văn cống, bình thủy. Cần thơ ( an thới củ )');
  assert.deepEqual([anThoi.ward?.name, anThoi.district?.name, anThoi.province?.name], ['Phường An Thới', 'Quận Bình Thủy', 'Cần Thơ']);
  assert.equal(anThoi.street, '251/6 đồng văn cống');
  const haiBoi = resolveAddress('Cổ điên hải bối đông anh hà nội quán đốp cafe');
  assert.deepEqual([haiBoi.ward?.name, haiBoi.district?.name, haiBoi.province?.name], ['Xã Hải Bối', 'Huyện Đông Anh', 'Hà Nội']);
  assert.equal(haiBoi.street, 'Cổ điên, quán đốp cafe');
  assert.deepEqual(columns('31đg 427 hồng vân  thường tín cũ hà nội'), ['Xã Hồng Vân', 'Huyện Thường Tín', 'Hà Nội']);
  // "xã A ( B cũ)": trước đây lấy B (đơn …24ee3a, ô chọn POS là Xã Châu Tiến). R13 fix2 (B1/B7, phản biện 03/10): chính luật đó gán
  // "Thị trấn Đức Hòa" cho "xã Hòa Khánh Đông (Đức Hòa cũ)"; nay phường khách ghi đọc đúng danh mục thì GIỮ (Xã Châu Hồng), chú thích
  // chỉ dùng khi chưa đọc ra phường. Địa chỉ đầy đủ của đơn (có đuôi ô chọn) vẫn ra Xã Châu Tiến theo đuôi.
  assert.deepEqual(columns('Bản phúc tiến xã châu hồng ( cháu tiến cũ) quỳ hợp cũ tỉnh nghệ an'), ['Xã Châu Hồng', 'Huyện Quỳ Hợp', 'Nghệ An']);
  assert.deepEqual(columns('Bản phúc tiến xã châu hồng ( cháu tiến cũ) quỳ hợp cũ tỉnh nghệ an, Xã Châu Tiến, Huyện Quỳ Hợp, Nghệ An'), ['Xã Châu Tiến', 'Huyện Quỳ Hợp', 'Nghệ An']);
  // Chữ "cũ/củ" là một phần của tên hay của tên đường thì giữ nguyên.
  assert.deepEqual(columns('ấp bốn phú xã Bình Mỹ huyện củ Chi'), ['Xã Bình Mỹ', 'Huyện Củ Chi', 'TP Hồ Chí Minh']);
  const phoCu = resolveAddress('Chùa phố cũ phường hợp Giang tp Cao Bằng');
  assert.equal(phoCu.ward?.name, 'Phường Hợp Giang');
  assert.equal(phoCu.street, 'Chùa phố cũ');
  // Ô chọn nói khác chú thích: tên trong ngoặc không ghi đè phường khách ghi sau đó (đơn …e9a374).
  assert.equal(resolvedAddressFields('51/to 2 to 23 (phường Tam hòa cũ) khu phố Tân lập đồng khởi phường Tam hiệp, Phường Tam Hiệp, Thành phố Biên Hòa, Đồng Nai').ward, 'Phường Tam Hiệp');
});

test('r13-addr K6: viết tắt tpst, tpbr, tpprtc, tppleiku, cpa (trước Quảng Ninh); KHÔNG mở "py"/"vt" vì nhập nhằng trên đơn thật', () => {
  assert.deepEqual(columns('507/2/6a lê hồng phong p3 tpst sóc trăng'), ['Phường 3', 'Thành phố Sóc Trăng', 'Sóc Trăng']);
  assert.deepEqual(columns('204 ql51 kim sơn kim dinh tpbr brvt'), ['Phường Kim Dinh', 'Thành phố Bà Rịa', 'Bà Rịa-Vũng Tàu']);
  assert.equal(resolvedAddressFields('TÂN SƠN 2 THÀNH HẢI TPPRTC NINH THUÂN').ward, 'Xã Thành Hải');
  assert.deepEqual(columns('Tổ5 khu hoà lac Cẩm bình cpa quảng ninh'), ['Phường Cẩm Bình', 'Thành phố Cẩm Phả', 'Quảng Ninh']);
  // "py - vĩnh phúc" là Phúc Yên, "vt phu tho" là Việt Trì: không mở thành Phú Yên / Vũng Tàu.
  assert.doesNotMatch(expandAddressAbbreviations('27 đồng xuân - py - vĩnh phúc'), /Phú Yên/);
  assert.doesNotMatch(expandAddressAbbreviations('Nhà số 6 to 48 tien phu tien cat vt phu tho'), /Vũng Tàu/);
  assert.equal(resolveAddress('27 đồng xuân - py - vĩnh phúc').province?.name, 'Vĩnh Phúc');
});

// ===== K10: tên phường mới trùng hai phường cũ khác quận =====

test('r13-addr K10: "phường X + tỉnh" với X là phường MỚI trùng hai phường cũ khác quận → giữ chữ, coi là đủ, không hỏi "quận nào"', () => {
  const dongSon = describeDeliveryAddress('Tdp Đông hoàng phường đông sơn tỉnh Thanh Hoá');
  assert.equal(dongSon.complete, true);
  assert.equal(dongSon.choices, null);
  assert.equal(dongSon.keepAsTyped, true);
  assert.equal(dongSon.canonical, 'Tdp Đông hoàng phường đông sơn tỉnh Thanh Hoá');
  assert.equal(dongSon.resolved.postMerger, true);
  assert.equal(dongSon.resolved.newWard, 'dong son');
  assert.deepEqual(columns('Tdp Đông hoàng phường đông sơn tỉnh Thanh Hoá'), ['', '', 'Thanh Hóa']);
  // Khách ghi cả quận cũ ("tppleiku") → là địa chỉ ba cấp cũ, đọc đủ, không hỏi quận.
  const taySon = describeDeliveryAddress('34/6 nguyên hữu Huan To 3 phuong tay son tppleiku tinh gia lai');
  assert.equal(taySon.complete, true);
  assert.equal(taySon.choices, null);
  assert.deepEqual(columns('34/6 nguyên hữu Huan To 3 phuong tay son tppleiku tinh gia lai'), ['Phường Tây Sơn', 'Thành phố Pleiku', 'Gia Lai']);
  // Tên trơ (không ghi "phường/xã") trùng tên huyện cũ: vẫn là huyện, không tự coi là phường mới.
  assert.equal(resolveAddress('đông sơn thanh hóa').district?.name, 'Huyện Đông Sơn');
});

// ===== K8: "phường/xã + tên lạ" =====

test('r13-addr K8: tên lạ không có trong danh mục phường/xã MỚI của tỉnh thì không tự coi là sau sáp nhập', () => {
  // "TT eapoc cumgar": thị trấn (kiểu cũ) gõ sai → hỏi lại, không nhận nguyên chữ (đơn …c96460, NV phải thêm Ea Pốk, Cư M'gar).
  const eaPok = describeDeliveryAddress('Cape. Lộc vừng TT eapoc cumgar Đăk Lăk');
  assert.equal(eaPok.resolved.postMerger, false);
  assert.equal(eaPok.complete, false);
  // "xã An Qui" là Xã An Quy (i/y) của huyện khách ghi; "ấp An Bình" không phải xã mới An Bình (đơn …b0f75f).
  const anQuy = resolveAddress('ấp An Bình xã An Qui huyện Thạnh phú tỉnh bến tre');
  assert.equal(anQuy.postMerger, false);
  assert.deepEqual([anQuy.ward?.name, anQuy.district?.name, anQuy.province?.name], ['Xã An Quy', 'Huyện Thạnh Phú', 'Bến Tre']);
  // Phường có thật nhưng danh mục kho thiếu: không còn "sau sáp nhập"; có số nhà + quận + tỉnh → nhận, NV bổ sung phường.
  const trucBach = describeDeliveryAddress('15 hàng bún, Phường Trúc Bạch, Quận Ba Đình, Hà Nội');
  assert.equal(trucBach.resolved.postMerger, false);
  assert.equal(trucBach.complete, true);
  assert.equal(trucBach.wardUnverified, true);
  // "xã hội" trong tên cơ quan không phải "xã + tên lạ".
  assert.equal(resolveAddress('Phòng giao dịch Ngân hàng Chính sách xã hội Cần Đước').postMerger, false);
  // "phuong hai" = Phường 2; "phường Hai Bà Trưng" không đổi.
  assert.deepEqual(columns('03/01 quang trung phuong hai thi xa quang tri'), ['Phường 2', 'Thị xã Quảng Trị', 'Quảng Trị']);
  assert.match(expandAddressAbbreviations('số 5 phường Hai Bà Trưng, Hà Nội'), /phường Hai Bà Trưng/);
  // Tên gần trùng một tên MỚI của tỉnh vẫn là địa chỉ sau sáp nhập (giữ chữ): gõ dính, gõ thiếu phần sau.
  assert.equal(resolveAddress('Nội ô Xã Phướclong, tỉnh cà mau , Cà Mau').postMerger, true);
  assert.equal(resolveAddress('Bảo uyên , cổng khu du lịch langbiang , phường langbiang , lạc dương , lâm đồng').postMerger, true);
  // "phường Sài Gòn" là phường mới của TP.HCM, không bị mở thành tên tỉnh; "sài gòn" trơ vẫn là TP.HCM.
  const saiGon = resolveAddress('LIVE 93-95 Hàm Nghi, Phường Sài Gòn, Hồ Chí Minh');
  assert.equal(saiGon.newWard, 'sai gon');
  assert.equal(saiGon.postMerger, true);
  assert.equal(resolveAddress('12 lê lợi quận 1 sài gòn').province?.name, 'TP Hồ Chí Minh');
});

// ===== K7 (+K11): chữ khách gõ ↔ ô chọn / đuôi POS =====

test('r13-addr K7: khách gõ đủ ba cấp nhưng ô chọn khác tỉnh/quận → trả lý do "Ô chọn khác chữ khách gõ", không tự chọn bên nào', () => {
  const vungTau = addressTailConflict('B15 hoang cầm p2 tp Vũng Tàu, Xã Long Vĩnh, Huyện Duyên Hải, Trà Vinh');
  assert.equal(vungTau.reason, ADDRESS_PICK_CONFLICT_REASON);
  assert.equal(vungTau.reason, 'Ô chọn khác chữ khách gõ');
  assert.equal(vungTau.level, 'province');
  assert.deepEqual(vungTau.typed, { ward: 'Phường 2', district: 'Thành phố Vũng Tàu', province: 'Bà Rịa-Vũng Tàu' });
  // Ba cột vẫn như bộ đọc ra từ cả địa chỉ (không tự đổi sang bên nào); chỉ thêm addressCheck cho Xử lý dữ liệu.
  const fields = resolvedAddressFields('B15 hoang cầm p2 tp Vũng Tàu, Xã Long Vĩnh, Huyện Duyên Hải, Trà Vinh');
  assert.deepEqual([fields.ward, fields.district, fields.province], ['Xã Long Vĩnh', 'Huyện Duyên Hải', 'Trà Vinh']);
  assert.match(fields.addressCheck, /^Ô chọn khác chữ khách gõ: khách gõ "Phường 2, Thành phố Vũng Tàu, Bà Rịa-Vũng Tàu" ↔ ô chọn "Xã Long Vĩnh, Huyện Duyên Hải, Trà Vinh"$/);
  // Đuôi form chỉ có tỉnh, khác tỉnh khách gõ: không lấy "Bình Phước" im lặng.
  const camRanh = resolvedAddressFields('252 phạm văn đồng thuận phát cam thuận cam ranh Khánh Hòa, Bình Phước');
  assert.match(camRanh.addressCheck, /Ô chọn khác chữ khách gõ.*Phường Cam Thuận, Thành phố Cam Ranh, Khánh Hòa.*Bình Phước/);
  // K11: hai bộ cấp ở hai tỉnh trong một địa chỉ.
  assert.match(resolvedAddressFields('156 xã Phú lập huyện tân phú tỉnh đồng nai, Phường Hòa Thọ Đông, Quận Cẩm Lệ, Đà Nẵng').addressCheck, /Ô chọn khác chữ khách gõ/);
  // Khác quận trong cùng tỉnh.
  const q3 = typedVsPickedConflict('57 cao thắng, p.3, q.3', { ward: 'Phường 5', district: 'Quận Gò Vấp', province: 'Hồ Chí Minh' });
  assert.equal(q3.level, 'district');
  assert.equal(addressTailConflict('37 Phan văn khỏe p13q6, Phường 13, Quận 5, Hồ Chí Minh').level, 'district');
  assert.equal(addressTailConflict('40b đường bình nhâm 61 khu phô bình phước  phường bình nhâm, thuận An,  Bình Dương, Phường Hàng Bông, Quận Hoàn Kiếm, Hà Nội').level, 'province');
});

test('r13-addr K7: không gắn cờ khi không mâu thuẫn, đơn vị đổi tên, khác phường cùng quận, hay chữ khách gõ không đủ chắc', () => {
  // Khớp nhau.
  assert.equal(addressTailConflict('Thôn 2vu điện, Xã Chân Lý, Huyện Lý Nhân, Hà Nam'), null);
  assert.equal(resolvedAddressFields('Thôn 2vu điện, Xã Chân Lý, Huyện Lý Nhân, Hà Nam').addressCheck, undefined);
  assert.equal(addressTailConflict('276/55 thống nhất p16 gò vấp củ HCM, Phường 16, Quận Gò Vấp, Hồ Chí Minh'), null);
  // Đơn vị đổi tên/nhập: Đạ Tẻh → Đạ Huoai (huyện), Cầu Kho → Cầu Ông Lãnh (phường cùng quận).
  assert.equal(typedVsPickedConflict('Thôn Phú Bình xã Đạ Lây huyện Đạ Tẻh tỉnh Lâm Đồng', { ward: 'Xã Đạ Lây', district: 'Huyện Đạ Huoai', province: 'Lâm Đồng' }), null);
  assert.equal(typedVsPickedConflict('55/26 trần đình xu.p.cầu kho.q1', { ward: 'Phường Cầu Ông Lãnh', district: 'Quận 1', province: 'Hồ Chí Minh' }), null);
  // Khác phường/xã trong cùng quận: không thuộc phạm vi cảnh báo.
  assert.equal(addressTailConflict('8k đường 17b phường An lạc bình tân HCM, Phường Bình Trị Đông B, Quận Bình Tân, Hồ Chí Minh'), null);
  // Ô chọn theo đơn vị mới (phường + tỉnh mới chứa tỉnh khách gõ): cùng một nơi.
  assert.equal(typedVsPickedConflict('7/2b khu phố Bình Hoà phường Lái Thiêu thuận an bình dương', { ward: 'Phường Lái Thiêu', district: '', province: 'Hồ Chí Minh' }), null);
  // Chữ khách gõ không tự đọc ra đủ ba cấp (chỉ số nhà/đường, hay tên mới sau sáp nhập): không kết luận.
  assert.equal(typedVsPickedConflict('số 5 ngõ 3', { ward: 'Phường 5', district: 'Quận Gò Vấp', province: 'Hồ Chí Minh' }), null);
  assert.equal(addressTailConflict('phường Tây Tựu, Hà Nội'), null);
  assert.equal(addressTailConflict(''), null);
  assert.equal(typedVsPickedConflict('57 cao thắng, p.3, q.3', {}), null);
});

// ===== Giữ hành vi đúng hiện có =====

test('r13-addr: hành vi đúng của bản đang chạy không đổi (Tây Tựu, Đồng Nai, Trấn Biên, p13q6, Hàng Gai)', () => {
  const tayTuu = describeDeliveryAddress('phường Tây Tựu, Hà Nội');
  assert.equal(tayTuu.resolved.postMerger, true);
  assert.equal(tayTuu.keepAsTyped, true);
  assert.deepEqual(columns('phường Tây Tựu, Hà Nội'), ['', '', 'Hà Nội']);
  assert.deepEqual(columns('số 207 phố Trung Kiên, phường Tây Tựu, Bắc Từ Liêm, Hà Nội'), ['Phường Tây Tựu', 'Quận Bắc Từ Liêm', 'Hà Nội']);
  assert.deepEqual(columns('Đồng Nai, Đồng Nai'), ['', '', 'Đồng Nai']);
  const tranBien = resolvedAddressFields('chung cư b1 nguyễn ái quốc phường trấn biên, Phường Trấn Biên, Thành phố Biên Hòa, Đồng Nai');
  assert.notEqual(tranBien.ward, 'Phường Tân Biên');
  assert.equal(tranBien.ward, '');
  assert.equal(tranBien.province, 'Đồng Nai');
  assert.deepEqual(columns('37 Phan văn khỏe p13q6'), ['Phường 13', 'Quận 6', 'TP Hồ Chí Minh']);
  // K9 (đánh đổi có chủ ý, không sửa): "số nhà + tên trùng tên phường" không gán phường.
  assert.deepEqual(columns('93 hàng gai -hoàn kiếm - hanoi'), ['', 'Quận Hoàn Kiếm', 'Hà Nội']);
});
