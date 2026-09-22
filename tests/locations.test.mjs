import test from 'node:test';
import assert from 'node:assert/strict';
import {
  canonicalLocationColumns,
  describeDeliveryAddress,
  expandAddressAbbreviations,
  formatResolvedAddress,
  isUsableStreet,
  loadLocationIndex,
  mergeAddressFragment,
  normalizeExportLocation,
  mergedProvinceMembers,
  cleanTelex,
  resolveAddress,
  streetForDisplay
} from '../app/processing/locations.mjs';

const names = resolved => [resolved.province?.name || '', resolved.district?.name || '', resolved.ward?.name || ''];

test('danh mục nạp đủ 63 tỉnh và tên TP Hồ Chí Minh đã sạch', () => {
  const index = loadLocationIndex();
  assert.equal(index.provinces.length, 63);
  assert.ok(index.provinces.some(province => province.name === 'TP Hồ Chí Minh'));
  assert.ok(!index.provinces.some(province => /TP TP/.test(province.name)));
});

test('địa chỉ đầy đủ có dấu phẩy: ba cấp và phần đường phố', () => {
  const resolved = resolveAddress('12 Nguyễn Huệ, Phường Bến Nghé, Quận 1, TP.HCM');
  assert.deepEqual(names(resolved), ['TP Hồ Chí Minh', 'Quận 1', 'Phường Bến Nghé']);
  assert.equal(resolved.street, '12 Nguyễn Huệ');
  assert.equal(resolved.confidence, 'exact');
  assert.equal(formatResolvedAddress(resolved), '12 Nguyễn Huệ, Phường Bến Nghé, Quận 1, TP Hồ Chí Minh');
});

test('viết tắt phổ biến: P., Q1, HCM, HN, Sg, TT', () => {
  assert.deepEqual(names(resolveAddress('số 5 Lê Lợi, P. Tân Định, Q1, HCM')), ['TP Hồ Chí Minh', 'Quận 1', 'Phường Tân Định']);
  assert.deepEqual(names(resolveAddress('KP 3, TT Củ Chi, Củ Chi, Sg')), ['TP Hồ Chí Minh', 'Huyện Củ Chi', 'Thị trấn Củ Chi']);
  assert.deepEqual(names(resolveAddress('chung cư HH2 Linh Đàm, Hoàng Liệt, Hoàng Mai, HN')), ['Hà Nội', 'Quận Hoàng Mai', 'Phường Hoàng Liệt']);
  assert.equal(expandAddressAbbreviations('Ấp 2, Q.7'), 'Ấp 2, Quận 7');
});

test('không dấu và không có dấu phẩy vẫn đọc được', () => {
  assert.deepEqual(names(resolveAddress('123 Nguyen Trai, Thanh Xuan, Ha Noi')), ['Hà Nội', 'Quận Thanh Xuân', '']);
  const resolved = resolveAddress('Nhà 4 ngách 5 Đội Cấn Ba Đình HN');
  assert.deepEqual(names(resolved), ['Hà Nội', 'Quận Ba Đình', 'Phường Đội Cấn']);
  assert.equal(resolved.street, 'Nhà 4 ngách 5');
});

test('số phường/quận phân biệt 1 với 10, 5 với 15', () => {
  assert.deepEqual(names(resolveAddress('23 Trần Phú, Phường 5, Quận 10')), ['TP Hồ Chí Minh', 'Quận 10', 'Phường 5']);
  assert.deepEqual(names(resolveAddress('Tổ 5, Phường Cổ Nhuế 2, Bắc Từ Liêm, Hà Nội')), ['Hà Nội', 'Quận Bắc Từ Liêm', 'Phường Cổ Nhuế 2']);
  assert.deepEqual(names(resolveAddress('221 Điện Biên Phủ, phường 15, Bình Thạnh')), ['TP Hồ Chí Minh', 'Quận Bình Thạnh', 'Phường 15']);
});

test('tên trùng: xã Hòa Bình không thành tỉnh Hòa Bình, tên đường không thành tỉnh', () => {
  assert.deepEqual(names(resolveAddress('Thôn Đông, Xã Hòa Bình, Huyện Thủy Nguyên, Hải Phòng')), ['Hải Phòng', 'Huyện Thủy Nguyên', 'Xã Hòa Bình']);
  assert.deepEqual(names(resolveAddress('77 Hoà Bình, Phường 5, Quận 11, Sài Gòn')), ['TP Hồ Chí Minh', 'Quận 11', 'Phường 5']);
  assert.deepEqual(names(resolveAddress('Xã Tân Phú, Huyện Tân Châu, Tây Ninh')), ['Tây Ninh', 'Huyện Tân Châu', 'Xã Tân Phú']);
  assert.equal(resolveAddress('Đường Hà Nội số 5').province, null);
});

test('thiếu tỉnh: suy ra từ quận có tên duy nhất; thiếu quận: suy ra từ phường duy nhất trong tỉnh', () => {
  assert.deepEqual(names(resolveAddress('xóm 3, xã Nghi Phú, tp Vinh')), ['Nghệ An', 'Thành phố Vinh', 'Xã Nghi Phú']);
  assert.deepEqual(names(resolveAddress('Quận Gò Vấp')), ['TP Hồ Chí Minh', 'Quận Gò Vấp', '']);
  assert.deepEqual(names(resolveAddress('Vũng Tàu')), ['Bà Rịa-Vũng Tàu', 'Thành phố Vũng Tàu', '']);
  assert.deepEqual(names(resolveAddress('Phường Đa Kao, Hồ Chí Minh')), ['TP Hồ Chí Minh', 'Quận 1', 'Phường Đa Kao']);
});

test('tên tỉnh lặp lại sau số điện thoại không thành thành phố trùng tên tỉnh', () => {
  const echoed = resolveAddress('Đc sn 02- ngõ02- đường lý thường kiệt-tổ 18- phường Bắc Sơn- Tam Điệp- Ninh Bình Đt: 0382687268, Ninh Bình');
  assert.deepEqual(names(echoed), ['Ninh Bình', 'Thành phố Tam Điệp', 'Phường Bắc Sơn']);
  assert.equal(echoed.confidence, 'exact');
  assert.equal(echoed.street, 'sn 02- ngõ02- đường lý thường kiệt-tổ 18');
  // Không có huyện nào khác thì tên lặp vẫn là thành phố trùng tên tỉnh.
  assert.deepEqual(names(resolveAddress('Phường Nam Bình, Ninh Bình, Ninh Bình')), ['Ninh Bình', 'Thành phố Ninh Bình', 'Phường Nam Bình']);
});

test('huyện tên duy nhất không có tiền tố, không dấu phẩy: tin khi có xã/phường ghi rõ đứng trước', () => {
  const hocMon = resolveAddress('105/3 ấp Tân thới 2 xã Tân hiệp Hóc Môn');
  assert.deepEqual(names(hocMon), ['TP Hồ Chí Minh', 'Huyện Hóc Môn', 'Xã Tân Hiệp']);
  assert.equal(hocMon.street, '105/3 ấp Tân thới 2');
  // Không có xã/phường xác nhận thì vẫn không đoán: "Hóc Môn" có thể là tên đường.
  assert.equal(resolveAddress('105/3 đường Hóc Môn').province, null);
});

test('phần đường phố để hiển thị: cắt tên cấp khách gõ dính trong ô địa chỉ', () => {
  assert.equal(streetForDisplay('Sau thương thanh cao lương son hoa bình, Xã Thanh Cao, Huyện Lương Sơn, Hòa Bình'), 'Sau thương');
  assert.equal(streetForDisplay('Sn 786-khu10 tt hùng Sơn - Lâm thao - Phú thọ, Thị trấn Hùng Sơn, Huyện Lâm Thao, Phú Thọ'), 'Sn 786-khu10');
  assert.equal(streetForDisplay('77a Đặng Văn Ngữ, kim liên, Hà Nội, Phường Kim Liên, Quận Đống Đa, Hà Nội'), '77a Đặng Văn Ngữ');
  assert.equal(streetForDisplay('A5 tô 1kp1 phuòng Thới an q12, Phường Thới An, Quận 12, Hồ Chí Minh'), 'A5 tô 1kp1');
  assert.equal(streetForDisplay('Toà zr1 kđt vinhomes ocean park gia lâm, Xã Đa Tốn, Huyện Gia Lâm, Hà Nội'), 'Toà zr1 kđt vinhomes ocean park');
  // Tên phường trùng tên đường: không cắt khi cắt xong chỉ còn số, hay khi có từ chỉ đường đứng trước.
  assert.equal(streetForDisplay('33/63/239 lê lợi, Phường Lê Lợi, Quận Ngô Quyền, Hải Phòng'), '33/63/239 lê lợi');
  assert.equal(streetForDisplay('12 đường Hà Nội, Phường Bến Nghé, Quận 1, TP.HCM'), '12 đường Hà Nội');
  // Tên cấp chỉ là số phải có loại hình mới bị cắt: "Ngách 15" không phải Phường 15.
  assert.equal(streetForDisplay('Ngách 15, Phường 15, Quận 10, TP.HCM'), 'Ngách 15');
  assert.equal(streetForDisplay('Ngách 15 phường 15, Phường 15, Quận 10, TP.HCM'), 'Ngách 15');
  assert.equal(streetForDisplay('12 Nguyễn Huệ, Phường Bến Nghé, Quận 1, TP.HCM'), '12 Nguyễn Huệ');
  assert.equal(streetForDisplay(''), '');
});

test('tỉnh mới sau sáp nhập 2025: phường/quận không có trong tỉnh ghi thì tìm ở tỉnh cũ đã nhập vào, ghi theo tên cũ của kho', () => {
  const merged = resolveAddress('234/51 khu phố đông an phường tân đông hiệp , Phường Tân Đông Hiệp, Hồ Chí Minh');
  assert.deepEqual(names(merged), ['Bình Dương', 'Thành phố Dĩ An', 'Phường Tân Đông Hiệp']);
  assert.equal(merged.confidence, 'exact');
  assert.deepEqual(names(resolveAddress('Dĩ An, Hồ Chí Minh')), ['Bình Dương', 'Thành phố Dĩ An', '']);
  // Chơn Thành nay thuộc Đồng Nai; danh mục kho chưa có phường Hưng Long (lập sau) nên chỉ ra được hai cấp.
  assert.deepEqual(names(resolveAddress('Phường Hưng Long, Thị xã Chơn Thành, Đồng Nai')), ['Bình Phước', 'Huyện Chơn Thành', '']);
  // Phường trùng tên ở nhiều nơi trong tỉnh cũ, hay có sẵn trong tỉnh mới, thì không đoán.
  assert.equal(resolveAddress('Phường 1, Hồ Chí Minh').district, null);
  assert.deepEqual(names(resolveAddress('Phường Bến Nghé, Quận 1, Hồ Chí Minh')), ['TP Hồ Chí Minh', 'Quận 1', 'Phường Bến Nghé']);
  // Mọi tên trong bảng sáp nhập đều có trong danh mục.
  const index = loadLocationIndex();
  for (const province of index.provinces) {
    for (const member of mergedProvinceMembers(province, index)) assert.ok(member.code, `${province.name} → ${member.name}`);
  }
  assert.equal(mergedProvinceMembers(index.provinces.find(province => province.bare === 'ho chi minh'), index).length, 2);
});

test('thành phố trực thuộc tỉnh trùng tên tỉnh', () => {
  const resolved = resolveAddress('Phường Đông Sơn, Thành phố Thanh Hoá, Thanh Hoá');
  assert.deepEqual(names(resolved), ['Thanh Hóa', 'Thành phố Thanh Hóa', 'Phường Đông Sơn']);
  assert.equal(resolved.confidence, 'exact');
});

test('sai chính tả nhẹ được sửa và đánh dấu fuzzy', () => {
  const resolved = resolveAddress('Số 8, Phường Nguyễn Trãi, Quận Hà Đông, Hà Nội');
  assert.equal(resolved.confidence, 'exact');
  const typo = resolveAddress('Số 8 Lê Lợi, Quận Hà Đôg, Hà Nội');
  assert.deepEqual(names(typo), ['Hà Nội', 'Quận Hà Đông', '']);
  assert.equal(typo.fuzzy, true);
});

test('tên có gạch ngang và mọi kiểu viết loại hình', () => {
  const resolved = resolveAddress('kp6 Đông Hải, pr-tc, Ninh Thuận');
  assert.deepEqual(names(resolved), ['Ninh Thuận', 'Thành phố Phan Rang – Tháp Chàm', 'Phường Đông Hải']);
  assert.equal(resolved.street, 'kp6');
  // Khách ghi "xã" cho một thị trấn cùng tên trong huyện: loại hình khách ghi thắng.
  assert.deepEqual(names(resolveAddress('Xã Yên Viên, Gia Lâm, Hà Nội')), ['Hà Nội', 'Huyện Gia Lâm', 'Xã Yên Viên']);
  assert.deepEqual(names(resolveAddress('Thị trấn Yên Viên, Gia Lâm, Hà Nội')), ['Hà Nội', 'Huyện Gia Lâm', 'Thị trấn Yên Viên']);
  // Tên dài cụ thể hơn thắng tên ngắn nằm trong nó.
  assert.deepEqual(names(resolveAddress('TT NT Mộc Châu, Mộc Châu, Sơn La')), ['Sơn La', 'Huyện Mộc Châu', 'Thị trấn NT Mộc Châu']);
  // Không dấu phẩy, chữ "Quan" cuối tên huyện không bị coi là tiền tố.
  assert.deepEqual(names(resolveAddress('Xã Trấn Ninh Huyện Văn Quan Lạng Sơn')), ['Lạng Sơn', 'Huyện Văn Quan', 'Xã Trấn Ninh']);
});

test('địa chỉ đời thật: số 0 đầu, tiếng Anh, T.P, số điện thoại và câu dẫn lẫn trong địa chỉ', () => {
  assert.deepEqual(names(resolveAddress('12 Lê Lợi, Phường 05, Quận 03, TP.HCM')), ['TP Hồ Chí Minh', 'Quận 3', 'Phường 5']);
  assert.deepEqual(names(resolveAddress('12 Le Loi, Ward 7, Go Vap District, Ho Chi Minh City')), ['TP Hồ Chí Minh', 'Quận Gò Vấp', 'Phường 7']);
  const hanoi = resolveAddress('Số 2 ngõ 12 Trần Duy Hưng, Trung Hòa, Cầu Giấy, T.P Hà Nội');
  assert.deepEqual(names(hanoi), ['Hà Nội', 'Quận Cầu Giấy', 'Phường Trung Hòa']);
  assert.equal(hanoi.street, 'Số 2 ngõ 12 Trần Duy Hưng');
  const messy = resolveAddress('Địa chỉ: 12 Lê Lợi, P.7, Q.Gò Vấp, HCM, sdt 0909123456 nhé');
  assert.deepEqual(names(messy), ['TP Hồ Chí Minh', 'Quận Gò Vấp', 'Phường 7']);
  assert.equal(messy.street, '12 Lê Lợi');
  assert.equal(resolveAddress('Số 1 Đại Cồ Việt, Hai Bà Trưng, HN 100000').street, 'Số 1 Đại Cồ Việt');
  assert.deepEqual(names(resolveAddress('12 Lê Lợi / Bến Nghé / Q1 / HCM')), ['TP Hồ Chí Minh', 'Quận 1', 'Phường Bến Nghé']);
  assert.deepEqual(names(resolveAddress('số 10, hẻm 123/45 Nguyễn Trãi, phường Nguyễn Cư Trinh, quận 1')), ['TP Hồ Chí Minh', 'Quận 1', 'Phường Nguyễn Cư Trinh']);
});

test('tên đường trùng tên tỉnh/phường không bị hiểu là nơi giao', () => {
  assert.deepEqual(names(resolveAddress('15 đường Hà Nội, Phường 1, TP Vũng Tàu')), ['Bà Rịa-Vũng Tàu', 'Thành phố Vũng Tàu', 'Phường 1']);
  assert.deepEqual(names(resolveAddress('Số 8 đường Hồ Chí Minh, Phường 5, Thành phố Cà Mau, Cà Mau')), ['Cà Mau', 'Thành phố Cà Mau', 'Phường 5']);
  assert.equal(resolveAddress('gần chợ Bến Thành, Quận 1').ward, null);
  // Nhưng "Dương" cuối tên riêng không phải là "đường".
  assert.deepEqual(names(resolveAddress('Hòa Bình, Tương Dương, Nghệ An')), ['Nghệ An', 'Huyện Tương Dương', 'Thị trấn Hòa Bình']);
  assert.deepEqual(names(resolveAddress('Phường Thổ Quan Quận Đống Đa Hà Nội')), ['Hà Nội', 'Quận Đống Đa', 'Phường Thổ Quan']);
});

test('quận cũ và thành phố mới trùng tên: phường quyết định, không có phường thì hỏi phường', () => {
  assert.deepEqual(names(resolveAddress('Phường Hiệp Bình Chánh, Thủ Đức, HCM')), ['TP Hồ Chí Minh', 'Thành phố Thủ Đức', 'Phường Hiệp Bình Chánh']);
  assert.deepEqual(names(resolveAddress('Phường Sông Trí, Kỳ Anh, Hà Tĩnh')), ['Hà Tĩnh', 'Thị xã Kỳ Anh', 'Phường Sông Trí']);
  assert.deepEqual(names(resolveAddress('Xã Kỳ Tân, Kỳ Anh, Hà Tĩnh')), ['Hà Tĩnh', 'Huyện Kỳ Anh', 'Xã Kỳ Tân']);
  const unsure = describeDeliveryAddress('Thủ Đức, HCM');
  assert.equal(unsure.resolved.ambiguous.level, 'district');
  assert.equal(unsure.choices, null, 'không hỏi "Quận hay Thành phố"');
  assert.deepEqual(unsure.missing, ['ward', 'street']);
});

test('khách gọi cả tỉnh bằng tên thành phố ("thành phố Huế"): huyện khác ghi phía trước mới là nơi giao', () => {
  const hue = resolveAddress('kiệt 9, nhà số 7, đường lê tư thành , thị trấn sịa, huyện quảng điền, thành phố huế');
  assert.deepEqual(names(hue), ['Thừa Thiên Huế', 'Huyện Quảng Điền', 'Thị trấn Sịa']);
  assert.equal(hue.street, 'kiệt 9, nhà số 7, đường lê tư thành');
  assert.equal(hue.confidence, 'exact');
  assert.deepEqual(names(resolveAddress('thị trấn sịa, quảng điền, huế')), ['Thừa Thiên Huế', 'Huyện Quảng Điền', 'Thị trấn Sịa']);
  assert.deepEqual(names(resolveAddress('xã phong hiền, huyện phong điền, tp huế')), ['Thừa Thiên Huế', 'Huyện Phong Điền', 'Xã Phong Hiền']);
  // Không có huyện khác thì "thành phố Huế" vẫn là Thành phố Huế.
  assert.deepEqual(names(resolveAddress('phường thuận hòa, thành phố huế')), ['Thừa Thiên Huế', 'Thành phố Huế', 'Phường Thuận Hòa']);
  assert.deepEqual(names(resolveAddress('12 Lê Lợi, Vĩnh Ninh, thành phố Huế')), ['Thừa Thiên Huế', 'Thành phố Huế', 'Phường Vĩnh Ninh']);
});

test('hai tên chỉ khác dấu: có dấu thì phân biệt, không dấu thì mơ hồ và đưa lựa chọn', () => {
  assert.deepEqual(names(resolveAddress('Thị trấn Sa Pa, Sa Pa, Lào Cai')), ['Lào Cai', 'Huyện Sa Pa', 'Phường Sa Pa']);
  assert.deepEqual(names(resolveAddress('Phường Sa Pả, Sa Pa, Lào Cai')), ['Lào Cai', 'Huyện Sa Pa', 'Phường Sa Pả']);
  assert.equal(resolveAddress('Phuong Sa Pa, Sa Pa, Lao Cai').ward, null);
  assert.deepEqual(names(resolveAddress('Xã Hoằng Đông, Hoằng Hóa, Thanh Hóa')), ['Thanh Hóa', 'Huyện Hoằng Hóa', 'Xã Hoằng Đông']);
  assert.deepEqual(names(resolveAddress('Xã Hoằng Đồng, Hoằng Hóa, Thanh Hóa')), ['Thanh Hóa', 'Huyện Hoằng Hóa', 'Xã Hoằng Đồng']);
  const unsure = resolveAddress('Thôn 3, Xa Hoang Dong, Huyen Hoang Hoa, Thanh Hoa');
  assert.equal(unsure.ward, null);
  assert.equal(unsure.ambiguous.level, 'ward');
  assert.deepEqual([...unsure.ambiguous.options].sort(), ['Xã Hoằng Đông', 'Xã Hoằng Đồng']);
});

test('địa chỉ giao hàng: thiếu gì hỏi nấy, số nhà không có tên đường thì chưa đủ', () => {
  assert.equal(isUsableStreet('12'), false);
  assert.equal(isUsableStreet('số 12'), false);
  assert.equal(isUsableStreet('12 Lê Lợi'), true);
  assert.equal(isUsableStreet('Thôn Đông'), true);
  assert.equal(isUsableStreet('Ấp 2'), true);
  const partial = describeDeliveryAddress('Quận 12, TP.HCM');
  assert.equal(partial.complete, false);
  assert.deepEqual(partial.missing, ['ward', 'street']);
  assert.equal(partial.known, 'Quận 12, TP Hồ Chí Minh');
  assert.equal(partial.missingLabel, 'phường/xã và tên đường hoặc thôn/ấp kèm số nhà');
  const numberOnly = describeDeliveryAddress('12, Phường Bến Nghé, Quận 1, HCM');
  assert.deepEqual(numberOnly.missing, ['street']);
  const full = describeDeliveryAddress('12 Nguyễn Huệ, Phường Bến Nghé, Quận 1, HCM');
  assert.equal(full.complete, true);
  assert.equal(full.canonical, '12 Nguyễn Huệ, Phường Bến Nghé, Quận 1, TP Hồ Chí Minh');
  const choose = describeDeliveryAddress('Thôn 3, Xa Hoang Dong, Huyen Hoang Hoa, Thanh Hoa');
  assert.equal(choose.choices.level, 'ward');
  assert.equal(choose.choices.options.length, 2);
});

test('ghép phần khách bổ sung vào địa chỉ đã lưu', () => {
  assert.equal(mergeAddressFragment('phường 5', 'Quận 12, TP.HCM'), 'phường 5, Quận 12, TP.HCM');
  assert.equal(mergeAddressFragment('số 12 Lê Lợi', 'Phường 5, Quận 12, TP.HCM'), 'số 12 Lê Lợi, Phường 5, Quận 12, TP.HCM');
  // Khách nhắn hẳn địa chỉ mới có tỉnh thì thay toàn bộ.
  assert.equal(mergeAddressFragment('45 Lê Lợi, P. Đa Kao, Q1, HCM', 'Quận 12, TP.HCM'), '45 Lê Lợi, P. Đa Kao, Q1, HCM');
  // Khách chọn một trong hai xã trùng tên: giữ thôn, bỏ tên xã không dấu gây mơ hồ.
  const chosen = mergeAddressFragment('Hoằng Đồng', 'Thôn 3, Xa Hoang Dong, Huyen Hoang Hoa, Thanh Hoa');
  const resolved = describeDeliveryAddress(chosen);
  assert.equal(resolved.complete, true);
  assert.equal(resolved.canonical, 'Thôn 3, Xã Hoằng Đồng, Huyện Hoằng Hóa, Thanh Hóa');
  assert.equal(mergeAddressFragment('', 'Quận 12, TP.HCM'), 'Quận 12, TP.HCM');
  assert.equal(mergeAddressFragment('Quận 12, TP.HCM', ''), 'Quận 12, TP.HCM');
});

test('không đoán khi mơ hồ, nhưng giữ phần đường phố', () => {
  const resolved = resolveAddress('Phường 1, Hồ Chí Minh');
  assert.equal(resolved.province.name, 'TP Hồ Chí Minh');
  assert.equal(resolved.district, null, 'nhiều quận ở TP Hồ Chí Minh có Phường 1');
  assert.equal(resolved.confidence, 'partial');
  assert.equal(resolveAddress('').confidence, 'none');
  assert.equal(resolveAddress('gần chợ, hỏi bảo vệ').street, 'gần chợ, hỏi bảo vệ');
});

test('cột xuất kho: tên chuẩn từ ba cột, hoặc từ địa chỉ khi cột trống', () => {
  assert.deepEqual(
    canonicalLocationColumns({ province: 'Hồ Chí Minh', district: 'Quận 1', ward: 'Phường Tân Định' }),
    { province: 'TP Hồ Chí Minh', district: 'Quận 1', ward: 'Phường Tân Định' }
  );
  assert.deepEqual(
    canonicalLocationColumns({ address: '45 Lê Lợi, P. Đa Kao, Q1, HCM' }),
    { province: 'TP Hồ Chí Minh', district: 'Quận 1', ward: 'Phường Đa Kao' }
  );
  // Cột thiếu phường được bù từ địa chỉ khi cùng tỉnh.
  assert.deepEqual(
    canonicalLocationColumns({ province: 'Hà Nội', district: 'Cầu Giấy', address: '45 Trần Thái Tông, Dịch Vọng Hậu, Cầu Giấy, Hà Nội' }),
    { province: 'Hà Nội', district: 'Quận Cầu Giấy', ward: 'Phường Dịch Vọng Hậu' }
  );
  // Không nhận ra thì giữ nguyên giá trị gốc.
  assert.deepEqual(
    canonicalLocationColumns({ province: 'Hà Nội', district: 'Không tồn tại', ward: 'Cũng không' }),
    { province: 'Hà Nội', district: 'Không tồn tại', ward: 'Cũng không' }
  );
});

test('normalizeExportLocation giữ hành vi cũ', () => {
  assert.equal(normalizeExportLocation('Hồ Chí Minh'), 'TP Hồ Chí Minh');
  assert.equal(normalizeExportLocation('Thành phố Thanh Hoá'), 'Thành phố Thanh Hóa');
  assert.equal(normalizeExportLocation('Hà Nội'), 'Hà Nội');
  assert.equal(normalizeExportLocation('Xã Tân Phú'), 'Xã Tân Phú');
});

test('form nối ba cấp chuẩn sau phần khách gõ tay có lặp tỉnh: đọc đủ ba cấp, phần đường sạch', () => {
  const repeated = resolveAddress('28 xóm 6 xã Bảo Lạc tỉnh Cao Bằng, Xã Bảo Lạc, Huyện Bảo Lạc, Cao Bằng');
  assert.deepEqual(names(repeated), ['Cao Bằng', 'Huyện Bảo Lạc', 'Thị trấn Bảo Lạc']);
  assert.equal(repeated.confidence, 'exact');
  assert.equal(repeated.street, '28 xóm 6');
  // Khách ghi "xã" cho một thị trấn: loại hình không chặn.
  assert.deepEqual(names(resolveAddress('Tổ 3 xã sông mã tỉnh Sơn La, Thị trấn Sông Mã, Huyện Sông Mã, Sơn La')), ['Sơn La', 'Huyện Sông Mã', 'Thị trấn Sông Mã']);
  // Tỉnh ghi giữa câu, form nối phường/quận phía sau (ở tỉnh cũ đã nhập vào): vẫn tìm thấy.
  assert.deepEqual(names(resolveAddress('Số 1 đinh Tiên Hoàng Nam Vĩnh Yên phường Vĩnh Phúc tỉnh Phú Thọ, Phường Khai Quang, Thành phố Vĩnh Yên')), ['Vĩnh Phúc', 'Thành phố Vĩnh Yên', 'Phường Khai Quang']);
  // Tên phường trùng tên đường trong cùng địa chỉ: tên đường giữ nguyên.
  assert.equal(resolveAddress('12 Lê Lợi, Phường Lê Lợi, Quận Ngô Quyền, Hải Phòng').street, '12 Lê Lợi');
  // Tỉnh lặp lại sớm không bị đọc thành thành phố cùng tên: hai quận cùng có Phường Đông Sơn thì mơ hồ.
  const dongSon = resolveAddress('Tdp Đông hoàng phường đông sơn tỉnh Thanh Hoá, Phường Đông Sơn, Thanh Hóa');
  assert.equal(dongSon.district, null);
  assert.equal(dongSon.ambiguous.level, 'district');
  // Có dấu ở tỉnh vẫn đủ để phân biệt Sa Pa với Sa Pả sau khi tỉnh đã được che.
  assert.deepEqual(names(resolveAddress('Sa Pa, Sa Pa, Lào Cai')), ['Lào Cai', 'Huyện Sa Pa', 'Phường Sa Pa']);
});

test('số La Mã, huyện đảo không có cấp xã, viết tắt và chữ dính', () => {
  assert.deepEqual(names(resolveAddress('84 nguyễn văn linh, Phường Hải Châu I, Quận Hải Châu, Đà Nẵng')), ['Đà Nẵng', 'Quận Hải Châu', 'Phường Hải Châu 1']);
  assert.deepEqual(names(resolveAddress('Phường Hải Châu II, Quận Hải Châu, Đà Nẵng')), ['Đà Nẵng', 'Quận Hải Châu', 'Phường Hải Châu 2']);
  // Huyện đảo chỉ có một đơn vị mang tên huyện: tỉnh + huyện là đủ, cột phường theo danh mục.
  const island = resolveAddress('Đường Nguyễn Văn linh, Khu 7, Huyện Côn Đảo, Bà Rịa-Vũng Tàu');
  assert.deepEqual(names(island), ['Bà Rịa-Vũng Tàu', 'Huyện Côn Đảo', 'Côn Đảo']);
  assert.equal(island.confidence, 'exact');
  assert.equal(describeDeliveryAddress('Khu 7, Côn Đảo, Bà Rịa Vũng Tàu').complete, true);
  assert.deepEqual(names(resolveAddress('Đảo Cồn Cỏ, Quảng Trị')), ['Quảng Trị', 'Huyện Đảo Cồn Cỏ', 'Đảo Cồn Cỏ']);
  assert.deepEqual(canonicalLocationColumns({ district: 'Huyện Côn Đảo', province: 'Bà Rịa - Vũng Tàu' }), { province: 'Bà Rịa-Vũng Tàu', district: 'Huyện Côn Đảo', ward: 'Côn Đảo' });
  // dalat, tpth, hp, "PAn phú, Tp Thủ Đức."
  assert.deepEqual(names(resolveAddress('17/18 trần phú phường 3 dalat')), ['Lâm Đồng', 'Thành phố Đà Lạt', 'Phường 3']);
  const thuDuc = resolveAddress('Nhà 11 đường S khu đô thị Lakeview City, PAn phú, Tp Thủ Đức.');
  assert.deepEqual(names(thuDuc), ['TP Hồ Chí Minh', 'Thành phố Thủ Đức', 'Phường An Phú']);
  assert.equal(thuDuc.street, 'Nhà 11 đường S khu đô thị Lakeview');
  assert.equal(resolveAddress('nhà số Quán Rẽ an khánh hp').province.name, 'Hải Phòng');
  assert.equal(resolveAddress('Vinh tri 2 phường Nguyệt viên tpth').province.name, 'Thanh Hóa');
  // "PXi" trong "Xã Đắk PXi" không phải "Phường Xi".
  assert.deepEqual(names(resolveAddress('Xã Đắk PXi, Huyện Đắk Hà, Kon Tum')), ['Kon Tum', 'Huyện Đắk Hà', 'Xã Đắk PXi']);
  assert.equal(expandAddressAbbreviations('QTân Bình, PAn Phú'), 'Quận Tân Bình, Phường An Phú');
});

test('gõ lỗi Telex trong đoạn không dấu phẩy được làm sạch rồi so khớp mờ', () => {
  assert.equal(cleanTelex('diichj vong'), 'dich vong');
  assert.equal(cleanTelex('hoaang'), 'hoang');
  const telex = resolveAddress('Ngõ 199 trần quốc hoàn diichj vọng cầu giấy hà nội');
  assert.deepEqual(names(telex), ['Hà Nội', 'Quận Cầu Giấy', 'Phường Dịch Vọng']);
  assert.equal(telex.fuzzy, true);
  assert.equal(telex.street, 'Ngõ 199 trần quốc hoàn');
  // Không có dấu Telex thừa thì cụm từ trong tên đường không bị so mờ thành quận khác.
  assert.equal(resolveAddress('146 trần bình trọng phường Thủ Dầu Một Tp.hcm').district, null);
});

test('địa chỉ ghi theo đơn vị sau sáp nhập 2025: không đoán, chỉ đánh dấu để hỏi lại', () => {
  for (const text of [
    '58 hoàng hoa thám, phường tây hồ, hà nội',
    '146 trần bình trọng phường Thủ Dầu Một Tp.hcm',
    '83 lê Đại phường hoà cường thành phố Đà Nẵng, Phường Hòa Cường, Đà Nẵng',
    'Vinh tri 2 phường Nguyệt viên tpth'
  ]) {
    const resolved = resolveAddress(text);
    assert.equal(resolved.ward, null, text);
    assert.equal(resolved.postMerger, true, text);
    assert.equal(describeDeliveryAddress(text).complete, false, text);
  }
  // Tỉnh mới ghi kèm phường của tỉnh cũ đã nhập vào vẫn đọc được, không phải sau sáp nhập.
  const merged = resolveAddress('Phường Tân Đông Hiệp, Hồ Chí Minh');
  assert.equal(merged.postMerger, false);
  assert.equal(merged.confidence, 'exact');
  // Đủ ba cấp, thiếu cấp không kèm "phường X", hay mơ hồ: không đánh dấu.
  assert.equal(resolveAddress('12 Lê Lợi, Phường Bến Nghé, Quận 1, HCM').postMerger, false);
  assert.equal(resolveAddress('Quận 3, Hồ Chí Minh').postMerger, false);
  assert.equal(resolveAddress('Thôn 3, Xa Hoang Dong, Huyen Hoang Hoa, Thanh Hoa').postMerger, false);
  // Sai chính tả nhẹ một phường có thật không bị coi là đơn vị mới.
  assert.equal(resolveAddress('phường Nguyễn Trãi, Hà Nội').postMerger, false);
});
