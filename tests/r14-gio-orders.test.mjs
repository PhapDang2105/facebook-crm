// Vòng 14 (03/10) — agent "gio": giỏ theo đúng lời khách, mời 2 túi, câu kèm, địa chỉ trên phiếu. Câu khách thật 02–03/10
// (không tên/SĐT thật; SĐT giả 0912345678).
import assert from 'node:assert/strict';
import test from 'node:test';
import { templates, XANH, NAU, basket } from './helpers/r13-engine-sim.mjs';
import { adjustOrderQuantities, colourCountsInText, renderChatbotReply, stripReceiverName } from '../app/chatbot-templates.mjs';
import { cleanAddressText } from '../app/processing/order-flow.mjs';
import { describeDeliveryAddress } from '../app/processing/locations.mjs';
import { normalizePendingOrder } from '../app/processing/pending-order.mjs';

const MIN = 60 * 1000;
const TROPICAL = quantity => ({ product: 'Granola Tropical vị Cacao 300g', code: 'GRA-MINT-Z300', quantity });
const codes = items => items.map(item => `${item.code}x${item.quantity}`).sort().join('+');
const female = { gender: 'female', name: 'Khách' };
const text = reply => (reply.parts || []).filter(part => part.type === 'text').map(part => part.text).join('\n') || reply.messages.join('\n');

// ===== 1. Không lọc món mô hình đọc được khi tổng túi khớp =====
test('"mình lấy 2 túi 1 xanh + lâu": giữ Xanh + Nâu (không còn 1 Xanh 189k)', () => {
  assert.equal(codes(adjustOrderQuantities([XANH(1), NAU(1)], { messageText: 'mình lấy 2 túi 1 xanh + lâu' })), 'GRA-NAU-Z350x1+GRA-XANH-Z450x1');
  // Không dấu ("lau" không sửa lỗi gõ) vẫn giữ nhờ tổng túi = tổng món.
  assert.equal(codes(adjustOrderQuantities([XANH(1), NAU(1)], { messageText: 'minh lay 2 tui 1 xanh + lau' })), 'GRA-NAU-Z350x1+GRA-XANH-Z450x1');
  // Tổng không khớp thì vẫn lọc theo màu khách nêu như cũ.
  assert.equal(codes(adjustOrderQuantities([XANH(1), NAU(1)], { messageText: 'lấy 1 túi xanh' })), 'GRA-XANH-Z450x1');
});

test('đơn thật: giỏ 2 túi, không kèm lời mời 2 túi', () => {
  const reply = renderChatbotReply({ template_id: 'ORDER_ADDRESS', Product_N1: 'Túi Xanh', No_A: '1', Product_N2: 'Túi Nâu', No_B: '1' }, templates, { messageText: 'mình lấy 2 túi 1 xanh + lâu', customer: female });
  assert.equal(codes(reply.pendingOrder.items), 'GRA-NAU-Z350x1+GRA-XANH-Z450x1');
  assert.doesNotMatch(text(reply), /nếu chị lấy 2/);
});

// ===== 2. Vị đồng nghĩa =====
test('"cân bằng" = Xanh, "nhiều hạt" = Vàng; "Ko fai 2 túi nâu" là đính chính', () => {
  assert.deepEqual(colourCountsInText('Ko fai 2 túi nâu\n1 Granola vị ca cao và 1 Granola cân bằng').counts, { NAU: 1, XANH: 1 });
  assert.deepEqual(colourCountsInText('2 túi nhiều hạt').counts, { VANG: 2 });
  // Cạnh màu / lời tả: không đếm thêm.
  assert.deepEqual(colourCountsInText('2 túi vàng nhiều hạt').counts, { VANG: 2 });
  const fixed = adjustOrderQuantities([NAU(2)], { messageText: 'Ko fai 2 túi nâu\n1 Granola vị ca cao và 1 Granola cân bằng', heldItems: [NAU(2)] });
  assert.equal(codes(fixed), 'GRA-NAU-Z350x1+GRA-XANH-Z450x1');
});

test('mô hình chép "Granola cân bằng" vào Product_N2 → Túi Xanh', () => {
  const reply = renderChatbotReply({ template_id: 'ORDER_ADDRESS', Product_N1: 'Granola vị ca cao', No_A: '1', Product_N2: 'Granola cân bằng', No_B: '1' }, templates, { messageText: '1 Granola vị ca cao và 1 Granola cân bằng', customer: female });
  assert.equal(codes(reply.pendingOrder.items), 'GRA-NAU-Z350x1+GRA-XANH-Z450x1');
});

test('"1 túi nâu 1 túi nguyên bản" → hỏi lại nguyên bản (Xanh hay Vàng), giữ 1 Nâu; trả lời "xanh" thì cộng vào giỏ', () => {
  const now = Date.now();
  const asked = renderChatbotReply({ template_id: 'ORDER_ADDRESS', Product_N1: 'Túi Nâu', No_A: '1', Product_N2: 'Granola nguyên bản', No_B: '1' }, templates,
    { messageText: '1 túi nâu 1 túi nguyên bản', customer: female, pendingOrder: basket([NAU(2)], MIN), lastTemplateId: 'ORDER_ADDRESS', now });
  assert.equal(asked.templateId, 'ASK_FLAVOR_NGUYENBAN');
  assert.match(text(asked), /Túi Xanh 450g.*Túi Vàng 350g/);
  assert.equal(codes(asked.pendingOrder.items), 'GRA-NAU-Z350x1');
  assert.equal(asked.pendingOrder.nguyenBanAsk, 1);
  const stored = normalizePendingOrder(asked.pendingOrder);
  assert.equal(stored.nguyenBanAsk, 1, 'cờ đi theo giỏ chờ khi lưu');
  const answered = renderChatbotReply({ template_id: 'ORDER_ADDRESS', Product_N1: 'Granola Túi Xanh 450g', No_A: '1' }, templates,
    { messageText: 'Túi xanh', customer: female, pendingOrder: stored, lastTemplateId: 'ASK_FLAVOR_NGUYENBAN', now: now + MIN });
  assert.equal(answered.templateId, 'ORDER_ADDRESS');
  assert.equal(codes(answered.pendingOrder.items), 'GRA-NAU-Z350x1+GRA-XANH-Z450x1');
  assert.ok(!answered.pendingOrder.nguyenBanAsk);
});

test('"nguyên bản" kèm màu hay là câu hỏi: không hỏi lại', () => {
  for (const said of ['2 túi xanh nguyên bản', 'Hộp 10 gói và 1 túi xanh nguyên bản']) {
    const reply = renderChatbotReply({ template_id: 'ORDER_ADDRESS', Product_N1: 'Túi Xanh', No_A: said.startsWith('2') ? '2' : '1' }, templates, { messageText: said, customer: female });
    assert.notEqual(reply.templateId, 'ASK_FLAVOR_NGUYENBAN', said);
  }
});

// ===== 3. "combo" không số, "2 mà e" =====
test('"C lấy combo vị ca cao nhé" → 2 túi; "2 mà e" với giỏ một món → 2', () => {
  assert.equal(codes(adjustOrderQuantities([TROPICAL(1)], { messageText: 'C lấy combo vị ca cao nhé' })), 'GRA-MINT-Z300x2');
  assert.equal(codes(adjustOrderQuantities([NAU(1)], { messageText: 'C lấy combo vị ca cao nhé' })), 'GRA-NAU-Z350x2');
  assert.equal(codes(adjustOrderQuantities([TROPICAL(1)], { messageText: '2 mà e', heldItems: [TROPICAL(1)] })), 'GRA-MINT-Z300x2');
  assert.equal(codes(adjustOrderQuantities([], { messageText: '2 mà e', heldItems: [TROPICAL(1)] })), 'GRA-MINT-Z300x2');
  // Combo 10 gói là tên sản phẩm: không nhân đôi.
  const combo10 = { product: 'Combo 10 gói Xanh', code: 'CB10-XANH-G35', quantity: 1 };
  assert.equal(codes(adjustOrderQuantities([combo10], { messageText: 'lấy combo nhé' })), 'CB10-XANH-G35x1');
});

// ===== 4. Mời 2 túi =====
const oneBag = (messageText, extra = {}) => renderChatbotReply({ template_id: 'ORDER_ADDRESS', Product_N1: 'Túi Xanh', No_A: '1', ...(extra.value || {}) }, templates, { messageText, customer: female, ...extra.context });
test('mời 2 túi: vẫn mời khi khách chỉ nói "túi xanh"', () => {
  assert.match(text(oneBag('cho chị túi xanh')), /lấy 2 túi thì giá chỉ còn/);
});
test('không mời khi khách đã nói "1 túi 174k" / "1 túi dùng thử" (tin này hay tin gần đây)', () => {
  assert.doesNotMatch(text(oneBag('Lấy 1 túi 174k')), /lấy 2 túi thì/);
  assert.doesNotMatch(text(oneBag('1 túi dùng thử ạ')), /lấy 2 túi thì/);
  assert.doesNotMatch(text(oneBag('12 Lê Lợi, Bến Nghé, Quận 1, TP HCM', { context: { recentCustomerTexts: ['Lấy 1 túi 174k', '12 Lê Lợi, Bến Nghé, Quận 1, TP HCM'] }, value: { Customer_Address: '12 Lê Lợi, Bến Nghé, Quận 1, TP HCM' } })), /lấy 2 túi thì/);
});
test('không mời khi khách đã gửi SĐT cho đơn 1 túi (ca "Đã mua 1 mà hỏi hoài")', () => {
  const reply = oneBag('0912345678', { value: { Phone_Number: '0912345678' } });
  assert.equal(reply.templateId, 'ORDER_ADDRESS');
  assert.doesNotMatch(text(reply), /lấy 2 túi thì/);
  assert.match(text(reply), /189\.000đ/);
});
test('FREESHIP_POLICY khi giữ giỏ 1 túi: báo tổng 189k, xin thông tin, không mời "lấy 2 túi vị nào"', () => {
  const reply = renderChatbotReply({ template_id: 'FREESHIP_POLICY' }, templates, { messageText: 'ship bao nhiêu e', customer: female, pendingOrder: basket([XANH(1)], MIN) });
  assert.match(text(reply), /1 Granola Túi Xanh 450g, tổng 189\.000đ/);
  assert.match(text(reply), /số điện thoại/);
  assert.doesNotMatch(text(reply), /lấy 2 túi vị nào/);
  // Không giữ giỏ: mẫu chính sách như cũ.
  assert.match(text(renderChatbotReply({ template_id: 'FREESHIP_POLICY' }, templates, { messageText: 'ship bao nhiêu', customer: female })), /lấy 2 túi vị nào/);
});

// ===== 5. Câu kèm hỏi lại điều khách vừa chọn =====
test('"Chị chốt một túi xanh" + also RECOMMEND_BEGINNER: không gửi câu "1 túi thử hay combo 2"', () => {
  const reply = renderChatbotReply({ template_id: 'ORDER_ADDRESS', Product_N1: 'Túi Xanh', No_A: '1', also: 'RECOMMEND_BEGINNER' }, templates, { messageText: 'Chị chốt một túi xanh', customer: female });
  assert.doesNotMatch(text(reply), /1 túi thử hay combo/);
  assert.ok(!reply.alsoTemplateId);
});
test('đã chọn 2 túi + also FREESHIP_POLICY: không hỏi "lấy 2 túi vị nào"', () => {
  const reply = renderChatbotReply({ template_id: 'ORDER_ADDRESS', Product_N1: 'Túi Vàng', No_A: '2', also: 'FREESHIP_POLICY' }, templates, { messageText: 'Không chị lấy 2 hộp miễn ship', customer: female });
  assert.doesNotMatch(text(reply), /vị nào/);
  assert.match(text(reply), /2 Granola Túi Vàng/);
});
test('câu kèm thông tin (KIDS_FAMILY) giữ phần trả lời, bỏ câu mời cuối', () => {
  const reply = renderChatbotReply({ template_id: 'ORDER_ADDRESS', Product_N1: 'Túi Xanh', No_A: '2', also: 'KIDS_FAMILY' }, templates, { messageText: 'lấy 2 túi xanh, bé ăn được không', customer: female });
  assert.match(text(reply), /các bé ăn được/);
  assert.doesNotMatch(text(reply), /lấy thử 1 túi hay combo/);
  // Không có giỏ: câu kèm giữ nguyên.
  const plain = renderChatbotReply({ template_id: 'PRICE_QUOTE', Product_N1: 'Túi Xanh', also: 'KIDS_FAMILY' }, templates, { messageText: 'bé ăn được không', customer: female });
  assert.match(text(plain), /lấy thử 1 túi hay combo/);
});

// ===== 6. Địa chỉ trên phiếu =====
const ticket = (raw, name = '') => stripReceiverName(cleanAddressText(raw), name);
test('cắt tên người nhận trùng tên Facebook ở đầu địa chỉ', () => {
  assert.equal(ticket('Kim van ấp 6 phú thịnh tân phú đồng nai', 'Kim Van'), 'ấp 6 phú thịnh tân phú đồng nai');
  assert.equal(ticket('Vũ Hoàng Anh 0912345678 Cụm Công nghiệp hà bình phương, xã văn bình, huyện thường tín, tp hà nội', 'Hoàng Anh'), 'Cụm Công nghiệp hà bình phương, xã văn bình, huyện thường tín, tp hà nội');
  assert.equal(ticket('Oanh Vy Thôn chi Long, xã Nguyễn Văn linh, tỉnh Hưng Yên 0912345678', 'Oanh Vy'), 'Thôn chi Long, xã Nguyễn Văn linh, tỉnh Hưng Yên');
  assert.equal(ticket('Đinh Huyền tk thạch lý Đà Bắc hoà bình', 'Diệu Huyền'), 'tk thạch lý Đà Bắc hoà bình');
  assert.equal(ticket('Dương thị quyên số nhà 20 khu trại hà phường mạo Khê tỉnh Quảng Ninh', 'Quyên Dương'), 'số nhà 20 khu trại hà phường mạo Khê tỉnh Quảng Ninh');
  assert.equal(ticket('Lại Liên, xóm 11, xã Hải Phương, huyện Hải Hậu, Nam Định', 'Lại Liên'), 'xóm 11, xã Hải Phương, huyện Hải Hậu, Nam Định');
  assert.equal(ticket('Trần Thị Trúc Mai, trường th Bùi Sĩ Hùng xã Bình Đại tỉnh Vĩnh Long', 'Mai Trần Thị Trúc'), 'trường th Bùi Sĩ Hùng xã Bình Đại tỉnh Vĩnh Long');
  // Mã bưu chính 6 số cuối cũng bỏ.
  assert.equal(ticket('Nguyễn Ngọc Lâm\nSaigon Royal - Toà AB1 - Nhà A14-09\n9 Đ. Nguyễn Trường Tộ, Xóm Chiếu, Hồ Chí Minh 700000\n\nSĐT - 0912345678', 'Lam Ngoc Nguyen'),
    'Saigon Royal - Toà AB1 - Nhà A14-09, 9 Đ. Nguyễn Trường Tộ, Xóm Chiếu, Hồ Chí Minh');
});
test('không cắt tên đường trùng tên khách khi phần còn lại thiếu đường', () => {
  assert.equal(ticket('Nguyễn Văn Linh, Phường Tân Phong, Quận 7, TP HCM', 'Linh Nguyễn'), 'Nguyễn Văn Linh, Phường Tân Phong, Quận 7, TP HCM');
  // Không có tên hồ sơ: như cũ.
  assert.equal(ticket('Kim van ấp 6 phú thịnh tân phú đồng nai'), 'Kim van ấp 6 phú thịnh tân phú đồng nai');
});
test('"e tên yến", "gửi địa chỉ", "chỉ" đầu, "Hèm … ₫uông"', () => {
  assert.equal(cleanAddressText('số nhà 94 phố Ngô quyền phường Năng Tĩnh tp Nam định tỉnh Nam định\ne tên yến sdt 0912345678'), 'số nhà 94 phố Ngô quyền phường Năng Tĩnh tp Nam định tỉnh Nam định');
  assert.equal(cleanAddressText('gửi địa chỉ 158, thôn 8 nga liên nga sơn thanh hoá 0912345678'), '158, thôn 8 nga liên nga sơn thanh hoá');
  assert.equal(cleanAddressText('chỉ tổ dân phố áp tràn phường Thùy nguyên thành phố Hải phòng'), 'tổ dân phố áp tràn phường Thùy nguyên thành phố Hải phòng');
  assert.equal(cleanAddressText('Hèm 120 ₫uông thống nhất phường Phan rang tinh khánh hòa'), 'Hẻm 120 đuông thống nhất phường Phan rang tinh khánh hòa');
  // Chữ "lâu"/"chỉ"/số 6 chữ số giữa địa chỉ không đụng.
  assert.equal(cleanAddressText('Số 123456 đường Láng, Hà Nội'), 'Số 123456 đường Láng, Hà Nội');
});
test('"VPBank Saigon Tower" giữ nguyên; "q9 q4" = Phường 9, Quận 4', () => {
  const vp = describeDeliveryAddress('Tòa nhà VPBank Saigon Tower(Nexus), số 3A-3B Tôn Đức Thắng, Phường Bến Nghé, Quận 1, Hồ Chí Minh');
  assert.match(vp.canonical, /VPBank Saigon Tower/);
  assert.match(describeDeliveryAddress('12 Lê Lợi q1 sài gòn').canonical, /Quận 1, TP Hồ Chí Minh/);
  const q = describeDeliveryAddress('20/26 đoàn văn bơ q9 q4');
  assert.match(q.canonical, /Phường 9, Quận 4, TP Hồ Chí Minh/);
});

// ===== Việc bổ sung (điều phối): STAFF_ONLY_PRODUCT, GIFT_POLICY khi đã có đơn =====
test('mô hình chọn STAFF_ONLY_PRODUCT: điền tên sản phẩm + thẻ cần người', () => {
  const named = renderChatbotReply({ template_id: 'STAFF_ONLY_PRODUCT', Product_N1: 'hạt điều' }, templates, { customer: female });
  assert.match(text(named), /hạt điều/);
  assert.equal(named.attention, true);
  const blank = renderChatbotReply({ template_id: 'STAFF_ONLY_PRODUCT' }, templates, { customer: female });
  assert.match(text(blank), /sản phẩm mình hỏi/);
  assert.equal(blank.attention, true);
});
test('khách đã có đơn hỏi quà (GIFT_POLICY): quà của đơn, không mời lên đơn mới', () => {
  const recentOrder = { id: 'o-gio', createdAt: Date.now() - 30 * MIN, status: 'Mới', products: [{ name: 'Granola Túi Xanh 450g', sku: 'GRA-XANH-Z450', quantity: 3 }], gift: 'Bộ bát gáo dừa + Muỗng dừa' };
  const reply = renderChatbotReply({ template_id: 'GIFT_POLICY' }, templates, { customer: female, recentOrder, hasOrder: true, messageText: 'có quà gì không em' });
  assert.doesNotMatch(text(reply), /lấy mấy túi để em lên đơn/);
  assert.match(text(reply), /đơn/);
});
