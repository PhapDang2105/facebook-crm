// Vòng 12 (01/10): địa chỉ, số lượng, xưng hô, giỏ — mọi ca dựng từ hội thoại thật 28/09–01/10
// (báo cáo r12 inbox-1/2/3); SĐT trong test là số giả 09000000xx.
import assert from 'node:assert/strict';
import test from 'node:test';
import { adjustOrderQuantities, colourCountsInText, defaultMessageTemplates, maxAddressAsks, renderChatbotReply, stripReceiverName } from '../app/chatbot-templates.mjs';
import { describeDeliveryAddress, mergeAddressFragment, resolveAddress, resolvedAddressFields } from '../app/processing/locations.mjs';
import { cleanAddressText, collectAddressBurst, extractDeliveryNote, isPaymentMessage, lookupPreviousAddress, orderFlowStep, pickPreviousAddress } from '../app/processing/order-flow.mjs';
import { extractVietnamesePhone, genderFromMessage, genderFromName, GENDER_SOURCE_RANK, selfReference } from '../app/processing/customer-info.mjs';
import { isBasketStep, isOrderStep, normalizePendingOrder, touchPendingOrder, usablePendingOrder } from '../app/processing/pending-order.mjs';
import { processingNotes } from '../app/order-notes.mjs';

const templates = defaultMessageTemplates();
const PHONE = '0900000001';
const XANH = (quantity = 1) => ({ product: 'Granola Túi Xanh 450g', code: 'GRA-XANH-Z450', quantity });
const VANG = (quantity = 1) => ({ product: 'Granola Túi Vàng 350g', code: 'GRA-VANG-H350', quantity });
const basket = (items, extra = {}) => ({ items, key: items.map(item => `${item.code}=${item.quantity}`).sort().join('|'), at: Date.now() - 60000, phone: '', address: '', addressAsks: 0, ...extra });
const names = resolved => [resolved.province?.name || '', resolved.district?.name || '', resolved.ward?.name || ''];

// ===== 1. Ghép phần bổ sung: không mất số nhà/đường =====

test('vòng 12 #1: khách bổ sung phường/tỉnh không làm mất số nhà/đường đã gửi (3 ca thật)', () => {
  // …4283662488/…3588846237/…4991785: phiếu từng chỉ còn "Phường hải châu thành phố đà nẵng".
  const danang = mergeAddressFragment('Phường hải châu thành phố đà nẵng', '83 hải phòng Dà nẵng phường Hải châu');
  assert.match(danang, /^83 hải phòng/);
  const dn = describeDeliveryAddress(danang);
  assert.equal(dn.complete, true);
  assert.equal(dn.resolved.province.name, 'Đà Nẵng', '"Hải Phòng" là tên đường, không phải tỉnh');
  assert.match(dn.canonical, /83 hải phòng/);
  const hn = mergeAddressFragment('Phường hoàng mai, hà nội', 'Số13/112 ngõ 663 trương định hoàng mai');
  assert.match(hn, /Số13\/112 ngõ 663 trương định/);
  assert.equal(describeDeliveryAddress(hn).complete, true);
  assert.equal(describeDeliveryAddress(hn).resolved.province.name, 'Hà Nội');
  const bt = mergeAddressFragment('Quan Bình Thạnh, tp, HCM nhé', '19A huỳnh đình Hai, p14, Bình Thạnh');
  assert.equal(describeDeliveryAddress(bt).canonical, '19A huỳnh đình Hai, Phường 14, Quận Bình Thạnh, TP Hồ Chí Minh');
  // Địa chỉ cũ đã có tỉnh khác: phần mới vẫn là địa chỉ mới (giữ hành vi cũ).
  assert.equal(mergeAddressFragment('hà nội', 'Xóm 3, Vô Tranh, Phú Lương, Thái Nguyên'), 'hà nội');
  // Bản thân tin đầu đã đủ: số nhà + đường Hải Phòng + phường Hải Châu (mới) + Đà Nẵng.
  const first = describeDeliveryAddress('83 hải phòng Dà nẵng phường Hải châu');
  assert.equal(first.resolved.province.name, 'Đà Nẵng');
  assert.equal(first.complete, true);
});

test('vòng 12 #1: bộ soạn đơn — đã hỏi phường/tỉnh, khách gửi "Phường hải châu thành phố đà nẵng" → phiếu giữ "83 hải phòng"', () => {
  const pending = basket([XANH(1)], { phone: PHONE, address: '19A huỳnh đình Hai, p14, Bình Thạnh', addressAsks: 1 });
  const reply = renderChatbotReply({ template_id: 'ORDER_ADDRESS', Customer_Address: 'Quan Bình Thạnh, tp, HCM nhé' }, templates, { pendingOrder: pending, messageText: 'Quan Bình Thạnh, tp, HCM nhé' });
  assert.equal(reply.templateId, 'ORDER_CONFIRMATION');
  assert.match(reply.order.address, /^19A huỳnh đình Hai, Phường 14, Quận Bình Thạnh/);
  const dn = renderChatbotReply({ template_id: 'ORDER_ADDRESS', Customer_Address: 'Phường hải châu thành phố đà nẵng' }, templates, { pendingOrder: basket([XANH(1)], { phone: PHONE, address: '83 hải phòng Dà nẵng phường Hải châu', addressAsks: 1 }), messageText: 'Phường hải châu thành phố đà nẵng' });
  assert.equal(dn.templateId, 'ORDER_CONFIRMATION');
  assert.match(dn.order.address, /83 hải phòng/);
});

// ===== 2. Địa chỉ đủ thì nhận ngay =====

test('vòng 12 #2: địa chỉ đủ (phường mới sau sáp nhập, p8/f5, Thủ Đức + Hiệp Bình/Linh Trung, quận + đường) được nhận ngay', () => {
  for (const text of [
    'Nhà 2 ngõ 12 mạc đĩnh chi phường thành vinh nghệ an',
    '63 đường 1 ấp 68 bà điểm Tphcm',
    '88b co tháng p8 soctrang.',
    '37 Tiểu La,Hòa Cường, tp Đà Nẵng',
    '18 ngách 143/300 phố nguyễn chính hoàng mai hà nội',
    'Chung cư Urban Green. Đường số6. hiệp bình.thủ đức.',
    '236 đường linh trung thủ đức',
    '12 Trần Quốc Thảo, f5, q3, hcm'
  ]) {
    const described = describeDeliveryAddress(text);
    assert.equal(described.complete, true, `${text}: thiếu ${described.missing.join(',')}`);
    assert.ok(described.canonical, text);
  }
  assert.deepEqual(names(resolveAddress('12 Trần Quốc Thảo, f5, q3, hcm')), ['TP Hồ Chí Minh', 'Quận 3', 'Phường 5']);
  assert.deepEqual(names(resolveAddress('88b co tháng p8 soctrang.')).slice(0, 1), ['Sóc Trăng'], 'tên tỉnh viết dính');
  // Phường mới "Thành Vinh" giữ nguyên chữ khách, không ép về phường cũ.
  const vinh = describeDeliveryAddress('Nhà 2 ngõ 12 mạc đĩnh chi phường thành vinh nghệ an');
  assert.equal(vinh.keepAsTyped, true);
  assert.equal(vinh.canonical, 'Nhà 2 ngõ 12 mạc đĩnh chi phường thành vinh nghệ an');
  // Khách không ghi tỉnh (máy suy từ Thủ Đức): giữ chữ khách + thêm tên tỉnh.
  assert.equal(describeDeliveryAddress('Chung cư Urban Green. Đường số6. hiệp bình.thủ đức.').canonical, 'Chung cư Urban Green. Đường số6. hiệp bình.thủ đức, TP Hồ Chí Minh');
  // Quận + đường + tỉnh thiếu phường: nhận, đánh dấu để nhân viên bổ sung.
  const hoangMai = describeDeliveryAddress('18 ngách 143/300 phố nguyễn chính hoàng mai hà nội');
  assert.equal(hoangMai.wardUnverified, true);
  assert.equal(hoangMai.canonical, '18 ngách 143/300 phố nguyễn chính, Quận Hoàng Mai, Hà Nội');
  // Thôn/xóm thiếu xã thì shipper không tìm được: vẫn hỏi.
  assert.deepEqual(describeDeliveryAddress('Xóm 3 Phú Lương').missing, ['ward']);
  // Chỉ có tên phường mới + tỉnh, không số nhà: vẫn xin số nhà/đường.
  assert.deepEqual(describeDeliveryAddress('Phường hải châu thành phố đà nẵng').missing, ['street']);
});

test('vòng 12 #2: hỏi lại tối đa 1 lần; sau đó nhận nguyên chữ khách ghi + ghi chú nhân viên', () => {
  assert.equal(maxAddressAsks, 1);
  const pending = basket([XANH(2)], { phone: PHONE, address: 'Long An', addressAsks: 1 });
  const reply = renderChatbotReply({ template_id: 'ORDER_ADDRESS', Customer_Address: 'cho cu ben luc' }, templates, { pendingOrder: pending, messageText: 'cho cu ben luc' });
  assert.equal(reply.templateId, 'ORDER_CONFIRMATION');
  assert.match(reply.order.addressCheck, /Soát phường\/xã/);
  const notes = processingNotes({ address: reply.order.address, street: 'cho cu ben luc', province: 'Long An', products: [{ sku: 'GRA-XANH-Z450', name: 'Granola Túi Xanh 450g' }], addressCheck: reply.order.addressCheck });
  assert.ok(notes.some(note => note.startsWith('⚠ Soát phường/xã')), notes.join(' | '));
  // Ca thật "88b co tháng p8 soctrang." (hỏi 3 lần, khách bỏ): nay chốt ngay lần đầu.
  const soc = renderChatbotReply({ template_id: 'ORDER_ADDRESS', Customer_Address: '88b co tháng p8 soctrang.' }, templates, { pendingOrder: basket([XANH(2)], { phone: PHONE }), messageText: '88b co tháng p8 soctrang.' });
  assert.equal(soc.templateId, 'ORDER_CONFIRMATION');
});

// ===== 3. Sau sáp nhập: không đổi về đơn vị cũ =====

test('vòng 12 #3: tỉnh/loại hình khách ghi khác danh mục cũ → giữ nguyên chữ khách (Đất Đỏ, Nam Sơn)', () => {
  const datDo = describeDeliveryAddress('18ô3 KP thanh long xã đất đỏ thành phố Hồ Chí Minh');
  assert.equal(datDo.complete, true);
  assert.equal(datDo.keepAsTyped, true);
  assert.equal(datDo.canonical, '18ô3 KP thanh long xã đất đỏ thành phố Hồ Chí Minh');
  assert.doesNotMatch(datDo.canonical, /Bà Rịa|Huyện Đất Đỏ/);
  const namSon = describeDeliveryAddress('số 678 đường Trần Hưng đạo cầu ngà phường nam Sơn thành phố Bắc ninh');
  assert.equal(namSon.keepAsTyped, true);
  assert.doesNotMatch(namSon.canonical, /Xã Nam Sơn/);
  // Cột kho vẫn có tỉnh để xuất file.
  assert.equal(resolvedAddressFields('số 678 đường Trần Hưng đạo cầu ngà phường nam Sơn thành phố Bắc ninh').province, 'Bắc Ninh');
});

// ===== 4. Chữ thừa trên phiếu =====

test('vòng 12 #4: lọc nhãn/chữ thừa trên phiếu (sđt, shop.đc, Linh:, 1 trước ạ., nhé, huyệ, người nhận, ghi chú giao)', () => {
  assert.equal(cleanAddressText('shop.đc 98/17 đường số 5.phường 17.go vấp'), '98/17 đường số 5.phường 17.go vấp');
  assert.equal(cleanAddressText(`Linh: ${PHONE} Số 73 ngõ 12 chùa bộc p kim liên hà nội`), 'Số 73 ngõ 12 chùa bộc p kim liên hà nội');
  assert.equal(cleanAddressText(`1 trước ạ.\n${PHONE}\nPhước Thọ mỹ hoà phù mỹ bình định`), 'Phước Thọ mỹ hoà phù mỹ bình định');
  assert.equal(cleanAddressText(`Đc ấp6, xã bàu cạn, huyện long thành, tỉnh Đồng Nai, sđt ${PHONE}`), 'ấp6, xã bàu cạn, huyện long thành, tỉnh Đồng Nai');
  assert.equal(cleanAddressText(`ấp tân bình xã tân thới huyện tân phú đông tỉnh tiền giang sdt ${PHONE}`), 'ấp tân bình xã tân thới huyện tân phú đông tỉnh tiền giang');
  assert.equal(cleanAddressText('Quan Bình Thạnh, tp, HCM nhé'), 'Quan Bình Thạnh, tp, HCM');
  assert.equal(cleanAddressText('Chị tâm Địa chỉ: 289 lý thường kiệt, sđt'), '289 lý thường kiệt');
  assert.equal(cleanAddressText('Gửi về ĐC 343 Lê Lợi ĐT'), '343 Lê Lợi');
  assert.equal(cleanAddressText('Mình ở xóm 7 thôn độ chàng'), 'xóm 7 thôn độ chàng');
  assert.equal(cleanAddressText(`Tk16/36D. Nguyễn cảnh chân . Phường cầu ông lãnh.tphcm Dt: ${PHONE}`), 'Tk16/36D. Nguyễn cảnh chân . Phường cầu ông lãnh.tphcm');
  assert.equal(cleanAddressText('12 Lê Lợi chuyển cho chị Ngân'), '12 Lê Lợi');
  assert.equal(cleanAddressText('12 Lê Lợi, Phường Bến Nghé, Quận 1 giao giờ hành chính'), '12 Lê Lợi, Phường Bến Nghé, Quận 1');
  assert.equal(extractDeliveryNote('12 Lê Lợi giao giờ hành chính'), 'giao giờ hành chính');
  assert.equal(cleanAddressText('ĐT 741, xã Phú Hòa'), 'ĐT 741, xã Phú Hòa', '"ĐT 741" là đường tỉnh');
  // Đoạn lặp sau khi ghép tin.
  assert.equal(cleanAddressText('236 đường linh trung, 236 đường linh trung phường linh trung thủ đức'), '236 đường linh trung phường linh trung thủ đức');
  // "huyệ." gõ cụt không còn trên phiếu.
  assert.doesNotMatch(describeDeliveryAddress('Truòng mầm non Hoa Hồng xã ĐÁ Bạc huyệ. Châu Đức tỉnh BRVT').canonical, /huyệ,/);
  // Tên người nhận đầu địa chỉ.
  assert.equal(stripReceiverName('Nguyễn Thị Hiền trường mn Phìn Hồ xã Phìn Hồ huyện Nậm Pồ Tỉnh Điện Biên'), 'trường mn Phìn Hồ xã Phìn Hồ huyện Nậm Pồ Tỉnh Điện Biên');
  assert.equal(stripReceiverName('Nguyễn thị hương, sn 79b khu 3'), 'sn 79b khu 3');
  assert.equal(stripReceiverName('Nguyễn Thị Minh Khai, P. Đa Kao'), 'Nguyễn Thị Minh Khai, P. Đa Kao', 'tên đường bốn chữ giữ nguyên');
});

test('vòng 12 #4: nhánh địa chỉ đủ (PHONE_ADDRESS/ADDRESS_COMPLETE) cũng bỏ nhãn "Sdt"; bộ soạn đơn lọc "Nguyen Huong:" + tên người nhận', () => {
  const ctx = { hasBasket: true, lastWasOrderStep: true, source: 'inbox', addressComplete: true };
  const step = orderFlowStep(`236 đường linh trung phường linh trung thủ đức Sdt ${PHONE}`, ctx);
  assert.equal(step.rule, 'PHONE_ADDRESS');
  assert.equal(step.value.Customer_Address, '236 đường linh trung phường linh trung thủ đức');
  assert.equal(orderFlowStep('Đc ấp6, xã bàu cạn, huyện long thành, tỉnh Đồng Nai nhé', ctx).value.Customer_Address, 'ấp6, xã bàu cạn, huyện long thành, tỉnh Đồng Nai');
  const reply = renderChatbotReply({ template_id: 'ORDER_ADDRESS', Phone_Number: PHONE, Customer_Address: `${PHONE}Nguyen Huong: Nguyễn thị hương, sn 79b khu 3, khu phố 114, thị trấn Định Quán, huyện Định Quán, tỉnh Đồng Nai` }, templates, { pendingOrder: basket([XANH(2)]), messageText: 'x' });
  assert.equal(reply.templateId, 'ORDER_CONFIRMATION');
  assert.doesNotMatch(reply.order.address, /Nguyen Huong|hương,/);
  assert.match(reply.order.address, /^sn 79b khu 3/);
});

// ===== 5. Địa chỉ gửi thành nhiều tin =====

test('vòng 12 #5: gom các tin địa chỉ liên tiếp (≤ 90 giây, bot chen giữa không cắt) thành một khối', () => {
  const t0 = Date.parse('2026-09-29T20:16:00+07:00');
  const at = seconds => t0 + seconds * 1000;
  const messages = [
    { direction: 'incoming', type: 'text', text: 'Chị lấy 1 vàng.1 xanh', createdAt: at(0) },
    { direction: 'outgoing', type: 'text', text: 'Dạ đơn của chị gồm…', createdAt: at(5) },
    { direction: 'incoming', type: 'text', text: 'Tổ 6', createdAt: at(60) },
    { direction: 'incoming', type: 'text', text: 'Thôn ba dùi', createdAt: at(62) },
    { direction: 'incoming', type: 'text', text: 'Khánh Bình', createdAt: at(64) },
    { direction: 'outgoing', type: 'text', text: 'Dạ em đã nhận được địa chỉ…', createdAt: at(65) },
    { direction: 'incoming', type: 'text', text: 'Khánh Vĩnh', createdAt: at(70) },
    { direction: 'incoming', type: 'text', text: 'Khánh Hòa', createdAt: at(72) },
    { direction: 'incoming', type: 'text', text: PHONE, createdAt: at(74) }
  ];
  const burst = collectAddressBurst(messages);
  assert.deepEqual(burst, { text: 'Tổ 6, Thôn ba dùi, Khánh Bình, Khánh Vĩnh, Khánh Hòa', phone: PHONE, count: 6 });
  const described = describeDeliveryAddress(burst.text);
  assert.equal(described.complete, true);
  assert.equal(described.canonical, 'Tổ 6, Thôn ba dùi, Xã Khánh Bình, Huyện Khánh Vĩnh, Khánh Hòa');
  // Cách nhau quá 90 giây hay chỉ một tin: không gom.
  assert.equal(collectAddressBurst([{ direction: 'incoming', text: 'Tổ 6', createdAt: at(0) }, { direction: 'incoming', text: 'Khánh Hòa', createdAt: at(200) }]), null);
});

// ===== 6. Số lượng =====

test('vòng 12 #6a: chỉ nhắc vị không số ("e túi xanh", "C ăn túi xanh nha") → giữ số lượng giỏ/đơn, không về 1', () => {
  const held = renderChatbotReply({ template_id: 'ORDER_ADDRESS', Product_N1: 'Túi Xanh', No_A: '1', Phone_Number: PHONE }, templates, { pendingOrder: basket([XANH(2)]), messageText: 'e túi xanh' });
  assert.deepEqual(held.pendingOrder.items.map(item => [item.code, item.quantity]), [['GRA-XANH-Z450', 2]]);
  const now = Date.now();
  const recentOrder = { id: 'o1', createdAt: now - 5 * 60000, products: [{ name: 'Granola Túi Xanh 450g', sku: 'GRA-XANH-Z450', quantity: 2 }], phone: PHONE, address: 'Ngõ 191 Đường Lạc Long Quân, Phường Nghĩa Đô, Quận Cầu Giấy, Hà Nội', status: 'Mới' };
  const live = renderChatbotReply({ template_id: 'ORDER_UPDATE', Product_N1: 'Túi Xanh', No_A: '1' }, templates, { now, recentOrder, messageText: 'C ăn túi xanh nha' });
  assert.notEqual(live.templateId, 'ORDER_UPDATE', 'không sửa đơn 2 túi thành 1 túi');
  assert.equal(live.order?.updateOrderId, undefined);
});

test('vòng 12 #6b: tin thanh toán (stk/ck/0đ) không bao giờ vào nhánh sửa đơn', () => {
  for (const text of ['Bạn gửi stk để mình ck xong lên đơn 0đ nha', 'mình đã chuyển khoản rồi nhé', 'ck rồi shop']) assert.equal(isPaymentMessage(text), true, text);
  assert.equal(isPaymentMessage('2 túi xanh nhé'), false);
  const now = Date.now();
  const recentOrder = { id: 'o2', createdAt: now - 4 * 60000, products: [{ name: 'Granola Túi Xanh 450g', sku: 'GRA-XANH-Z450', quantity: 2 }], phone: PHONE, address: 'Thôn Đông sàng, Xã Đường Lâm, Thị xã Sơn Tây, Hà Nội', status: 'Mới' };
  const reply = renderChatbotReply({ template_id: 'ORDER_UPDATE', Product_N1: 'Túi Xanh', No_A: '1' }, templates, { now, recentOrder, messageText: 'Bạn gửi stk để mình ck xong lên đơn 0đ nha' });
  assert.notEqual(reply.templateId, 'ORDER_UPDATE');
  assert.equal(reply.order?.updateOrderId, undefined);
});

test('vòng 12 #6c: "2 xanh" = 2 túi Xanh; "mỗi loại 1 túi" = chỉ hai vị nêu; "N túi" theo màu giỏ đang giữ; câu hỏi không tạo giỏ', () => {
  assert.deepEqual(colourCountsInText('2 xanh').counts, { XANH: 2 });
  assert.deepEqual(colourCountsInText('Đổi lại 1 xanh,1vang đc kg shop').counts, { XANH: 1, VANG: 1 });
  assert.deepEqual(colourCountsInText('2 túi xanh mint').counts, {}, 'xanh mint là Tropical');
  const cart = reply => (reply.order?.items || reply.pendingOrder?.items || []).map(item => `${item.quantity} ${item.code}`).sort();
  const two = renderChatbotReply({ template_id: 'ORDER_ADDRESS', Product_N1: 'Túi Vàng', No_A: '1', Product_N2: 'Túi Xanh', No_B: '1' }, templates, { messageText: '2 xanh' });
  assert.deepEqual(cart(two), ['2 GRA-XANH-Z450']);
  const each = renderChatbotReply({ template_id: 'ORDER_ADDRESS', Product_N1: 'Túi Vàng', No_A: '1', Product_N2: 'Túi Xanh', No_B: '1', Product_N3: 'Túi Nâu', No_C: '1' }, templates, { messageText: 'Vàng + xanh, mỗi loại 1 túi' });
  assert.deepEqual(cart(each), ['1 GRA-VANG-H350', '1 GRA-XANH-Z450']);
  const more = renderChatbotReply({ template_id: 'ORDER_ADDRESS', Product_N1: 'Túi Xanh', No_A: '1', Product_N2: 'Túi Vàng', No_B: '1' }, templates, { pendingOrder: basket([XANH(1)]), messageText: 'Lấy 2 túi nhé' });
  assert.deepEqual(cart(more), ['2 GRA-XANH-Z450']);
  const question = renderChatbotReply({ template_id: 'ORDER_ADDRESS', Product_N1: 'Túi Vàng', No_A: '1' }, templates, { messageText: 'Loại nào có trái cây vậy' });
  assert.deepEqual(cart(question), [], 'câu hỏi không lên giỏ 1 Vàng');
  // Tin không nhắc hàng ("Địa chỉ chưa sáp nhập") không đổi vị của đơn vừa chốt.
  const now = Date.now();
  const recentOrder = { id: 'o3', createdAt: now - 60000, products: [{ name: 'Granola Túi Vàng 350g', sku: 'GRA-VANG-H350', quantity: 1 }], phone: PHONE, address: 'Tk16/36D Nguyễn Cảnh Chân, Phường Cầu Kho, Quận 1, TP Hồ Chí Minh', status: 'Mới' };
  const keep = renderChatbotReply({ template_id: 'ORDER_UPDATE', Product_N1: 'Túi Xanh', No_A: '1', Phone_Number: '0', Customer_Address: '0' }, templates, { now, recentOrder, messageText: 'Địa chỉ chưa sáp nhập' });
  assert.ok(!(keep.order?.items || []).some(item => item.code === 'GRA-XANH-Z450'), 'không đổi Vàng thành Xanh');
  // Hàm thuần.
  assert.deepEqual(adjustOrderQuantities([XANH(1)], { messageText: 'gửi c 2 túi', heldItems: [XANH(1)] }).map(item => item.quantity), [2]);
  assert.deepEqual(adjustOrderQuantities([XANH(1)], { messageText: 'lấy thêm 1 túi', heldItems: [XANH(1)], adding: true }).map(item => item.quantity), [2]);
});

test('vòng 12 #6d: "Cho mình 2 túi" + SĐT → hỏi vị, giỏ nhớ 2 túi → "Túi vàng" = 2 Vàng', () => {
  const asked = renderChatbotReply({ template_id: 'ORDER_ADDRESS', Phone_Number: PHONE }, templates, { messageText: `Cho mình 2 túi nhé ${PHONE}` });
  assert.equal(asked.templateId, 'ASK_FLAVOR');
  assert.equal(asked.pendingOrder.askedBagCount, 2);
  assert.equal(normalizePendingOrder(asked.pendingOrder).askedBagCount, 2);
  const chosen = renderChatbotReply({ template_id: 'ORDER_ADDRESS', Product_N1: 'Túi Vàng', No_A: '' }, templates, { pendingOrder: asked.pendingOrder, messageText: 'Túi vàng nhiều hạt nhé' });
  assert.deepEqual((chosen.pendingOrder?.items || []).map(item => [item.code, item.quantity]), [['GRA-VANG-H350', 2]]);
  assert.equal(chosen.pendingOrder.askedBagCount, undefined, 'giỏ đã có hàng thì bỏ số túi tạm');
});

// ===== 7. Địa chỉ cũ =====

test('vòng 12 #7: "địa chỉ cũ" — bot vừa xin SĐT (ORDER_ADDRESS_OLD_ASK_PHONE) → lấy địa chỉ đơn cũ; không tra ra → cần người, không hỏi từng cấp', () => {
  const ctx = { hasBasket: true, lastWasOrderStep: false, source: 'inbox' };
  for (const text of ['Như mấy lần', 'Don cu cho chị', 'giống lần trước nha', 'dia chi cu']) assert.equal(orderFlowStep(text, ctx)?.rule, 'OLD_ADDRESS', text);
  const pending = basket([XANH(2)]);
  const previousDelivery = { phone: PHONE, address: '12 Lê Lợi, Phường Bến Nghé, Quận 1, TP.HCM' };
  const found = renderChatbotReply({ template_id: 'ORDER_ADDRESS', Phone_Number: PHONE }, templates, { pendingOrder: pending, lastTemplateId: 'ORDER_ADDRESS_OLD_ASK_PHONE', previousDelivery, messageText: PHONE });
  assert.equal(found.templateId, 'ORDER_CONFIRMATION');
  assert.match(found.order.address, /12 Lê Lợi/);
  const missing = renderChatbotReply({ template_id: 'ORDER_ADDRESS', Phone_Number: PHONE }, templates, { pendingOrder: pending, lastTemplateId: 'ORDER_ADDRESS_OLD_ASK_PHONE', messageText: PHONE });
  assert.equal(missing.templateId, 'ORDER_ADDRESS');
  assert.equal(missing.attention, true);
  assert.equal(missing.oldAddressMissing, true);
  // Khách nói "như mấy lần" ở tin đặt đầu: giỏ nhớ để lượt có SĐT lấy lại.
  const first = renderChatbotReply({ template_id: 'ORDER_ADDRESS', Product_N1: 'Túi Vàng', No_A: '2' }, templates, { messageText: 'Gởi chị 2 túi nữa. Như mấy lần. Túi vàng' });
  assert.equal(first.pendingOrder.wantsPrevious, true);
  const later = renderChatbotReply({ template_id: 'ORDER_ADDRESS', Phone_Number: PHONE }, templates, { pendingOrder: first.pendingOrder, previousDelivery, messageText: PHONE });
  assert.equal(later.templateId, 'ORDER_CONFIRMATION');
});

test('vòng 12 #7: pickPreviousAddress / lookupPreviousAddress — đơn gần nhất cùng SĐT trong CRM + kho landing (đã đồng bộ POS), không gọi mạng', async () => {
  const customerOrders = [{ id: 'c1', phone: PHONE, address: '(Live) 5 Trần Phú, Phường 4, Quận 5, TP Hồ Chí Minh', createdAt: 1000 }];
  const landing = { orders: [
    { id: 'l1', phone: '+84900000001', address: '9 Hai Bà Trưng, Phường Bến Nghé, Quận 1, TP Hồ Chí Minh', createdAt: 2000, source: 'Landing page' },
    { id: 'l2', phone: '0900000002', address: 'khác', createdAt: 3000 },
    { id: 'l3', phone: PHONE, address: 'Chưa có địa chỉ', createdAt: 4000 }
  ] };
  assert.deepEqual(pickPreviousAddress(PHONE, customerOrders, landing.orders), { phone: PHONE, address: '9 Hai Bà Trưng, Phường Bến Nghé, Quận 1, TP Hồ Chí Minh', at: 2000, source: 'Landing page', orderId: 'l1' });
  assert.equal(pickPreviousAddress(PHONE, customerOrders).address, '5 Trần Phú, Phường 4, Quận 5, TP Hồ Chí Minh', 'bỏ đầu "(Live) "');
  assert.equal(pickPreviousAddress('0900000009', customerOrders, landing.orders), null);
  assert.equal((await lookupPreviousAddress(PHONE, { customerOrders, landingStore: async () => landing })).orderId, 'l1');
  assert.equal(await lookupPreviousAddress(PHONE, { landingStore: async () => { throw new Error('hỏng tệp'); } }), null);
});

// ===== 8. Xưng hô =====

test('vòng 12 #8: khách tự xưng thắng tên/hồ sơ; "Thi" không dấu = "Thị"; "Thanh" không mặc định nam; SĐT "O9…"', () => {
  assert.equal(genderFromMessage('Lấy chị 1 túi vàng đi'), 'female');
  assert.equal(genderFromMessage('anh lấy 2 túi'), 'male');
  assert.equal(genderFromMessage('Chị tâm Địa chỉ: 289 lý thường kiệt'), 'female');
  assert.equal(genderFromMessage('chị ơi cho em hỏi'), '');
  assert.deepEqual(selfReference('Cho cô 1 túi màu xanh'), { pronoun: 'cô', gender: 'female' });
  assert.deepEqual(selfReference('em đặt 2 túi nhé'), { pronoun: 'em', gender: '' });
  assert.ok(GENDER_SOURCE_RANK.message > GENDER_SOURCE_RANK.pancake && GENDER_SOURCE_RANK.staff > GENDER_SOURCE_RANK.message);
  assert.equal(genderFromName('Dao Thi My Thanh'), 'female');
  assert.equal(genderFromName('Nguyen Thanh'), '');
  assert.equal(genderFromName('Bùi Thị Hoà Việt'), 'female');
  assert.equal(extractVietnamesePhone('O900000001 giao giờ hành chính'), PHONE);
  assert.equal(extractVietnamesePhone('O Đảng ủy xã'), '');
});

// ===== 9. Giỏ còn hạn theo tin nhắc giữ đơn =====

test('vòng 12 #9: giỏ đã có tin nhắc giữ đơn còn dùng được 24 giờ sau lần nhắc; ORDER_ADDRESS_REMIND là bước giỏ', () => {
  const now = Date.now();
  // 03/10 (ca Trang Nhi Vân): hạn giỏ chưa nhắc 2 → 24 giờ; khách gửi SĐT/địa chỉ sau 3 giờ vẫn chốt được.
  assert.ok(usablePendingOrder(basket([XANH(2)], { at: now - 3 * 60 * 60 * 1000 }), { now, templateId: 'ORDER_ADDRESS' }), '3 giờ, chưa nhắc: còn dùng');
  const old = basket([XANH(2)], { at: now - 25 * 60 * 60 * 1000 });
  assert.equal(usablePendingOrder(old, { now, templateId: 'ORDER_ADDRESS' }), null, 'quá 24 giờ, chưa nhắc: hết hạn');
  const conversation = { pendingOrder: old };
  assert.equal(touchPendingOrder(conversation, now - 60 * 60 * 1000), true);
  assert.ok(usablePendingOrder(conversation.pendingOrder, { now, templateId: 'ORDER_ADDRESS' }), 'nhắc 1 giờ trước: còn giữ');
  assert.ok(usablePendingOrder(conversation.pendingOrder, { now, templateId: 'ORDER_ADDRESS_REMIND' }));
  assert.equal(usablePendingOrder(conversation.pendingOrder, { now: now + 24 * 60 * 60 * 1000, templateId: 'ORDER_ADDRESS' }), null, 'quá 24 giờ sau lần nhắc');
  assert.equal(isBasketStep('ORDER_ADDRESS_REMIND'), true);
  assert.equal(isBasketStep('ORDER_ADDRESS_OLD_ASK_PHONE'), true);
  assert.equal(isOrderStep('ORDER_ADDRESS_REMIND'), false, 'không đổi bộ chọn mẫu soạn đơn');
  assert.equal(touchPendingOrder({ pendingOrder: null }), false);
});

test('vòng 12: ghi chú đơn hiện ghi chú giao hàng khách ghi lẫn trong địa chỉ', () => {
  const notes = processingNotes({ address: '12 Lê Lợi, Phường Bến Nghé, Quận 1, TP Hồ Chí Minh', street: '12 Lê Lợi', ward: 'Phường Bến Nghé', district: 'Quận 1', province: 'TP Hồ Chí Minh', products: [{ sku: 'GRA-XANH-Z450', name: 'Granola Túi Xanh 450g' }], deliveryNote: 'giao giờ hành chính' });
  assert.ok(notes.includes('ℹ Giao: giao giờ hành chính'), notes.join(' | '));
  const reply = renderChatbotReply({ template_id: 'ORDER_ADDRESS', Phone_Number: PHONE, Customer_Address: '12 Lê Lợi, Phường Bến Nghé, Quận 1, TP.HCM giao giờ hành chính' }, templates, { pendingOrder: basket([XANH(2)]), messageText: 'x' });
  assert.equal(reply.order.deliveryNote, 'giao giờ hành chính');
  assert.doesNotMatch(reply.order.address, /hành chính/);
});
