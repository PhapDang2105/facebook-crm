// Vòng 13 (02/10) — hồi quy luật nhận ý (rule-intent.mjs). Câu khách lấy nguyên văn từ hội thoại 30/09–02/10
// (báo cáo out-inbox1/2/3, out-comments, out-models); không tên khách, SĐT giả.
import assert from 'node:assert/strict';
import test from 'node:test';
import './helpers/seed-catalog.mjs';
import { commentBasket, processChatbotChanges } from '../app/chatbot-engine.mjs';
import { COMMENT_DISLIKE, LIVE_FEEDBACK, normalizeColourTypos, quantityOnlyRequest, ruleIntent } from '../app/processing/rule-intent.mjs';
import { foldVietnamese } from '../app/processing/auto-label.mjs';
import { defaultMessageTemplates } from '../app/chatbot-templates.mjs';

const inbox = extra => ({ source: 'inbox', botLastTemplateId: '', botLastAgeMin: 5, bundleSize: 1, commentBasket, experimentalRules: 'on', ...extra });
const holding = extra => inbox({ hasBasket: true, lastWasOrderStep: true, botLastTemplateId: 'ORDER_ADDRESS', botLastAgeMin: 3, ...extra });
const brief = result => (result ? [result.rule, result.value?.template_id, result.value?.also || '', result.value?.Product_N1 || '', result.value?.No_A || ''].filter(Boolean).join(' ') : null);

test('r13 #2: "Lần sau nếu ăn ngon mình sẽ mua ăn thường xuyên" không phải hoãn đơn; hẹn dịp khác GIỮ giỏ (keepBasket), hủy rõ mới xóa', () => {
  // Ca thật 01/10 16:32: luật ORDER_POSTPONED xóa giỏ 2 túi đang giữ; 3 phút sau khách gửi SĐT + địa chỉ thì bot hỏi lại vị.
  for (const text of ['Ok bạn.\nLần sau nếu ăn ngon mình sẽ mua ăn thường xuyên', 'Ăn giòn ngon đúng như quảng cáo cảm ơn Sốp lần sau mua tiếp', 'Thế gửi cho mình một túi xanh một túi vàng nhé mình ăn thử xem loại nào ngon lần sau mình mua', 'lần sau mình ủng hộ shop tiếp nha']) {
    for (const ctx of [inbox(), holding()]) {
      const ruled = ruleIntent(text, ctx);
      assert.notEqual(ruled?.rule, 'ORDER_POSTPONED', text);
      assert.ok(!ruled?.clearBasket, `${text}: không xóa giỏ`);
    }
  }
  const later = ruleIntent('Thôi để lần sau chị lấy thử vị ca cao cũg đk', holding());
  assert.deepEqual([later.rule, later.value.template_id, later.keepBasket, later.clearBasket], ['ORDER_POSTPONED', 'ORDER_POSTPONED', true, undefined], 'hẹn dịp khác: giữ giỏ');
  const cancel = ruleIntent('xin lỗi shop, mình hủy nhé', holding());
  assert.deepEqual([cancel.rule, cancel.clearBasket, cancel.keepBasket], ['ORDER_POSTPONED', true, undefined], 'hủy rõ: xóa giỏ như cũ');
  assert.equal(ruleIntent('xin lỗi mình hủy nhé, lần sau ủng hộ shop', holding())?.clearBasket, true, 'có lời hủy thì "ủng hộ" không chặn');
});

test('r13 #2: hoãn (giữ giỏ) rồi khách gửi SĐT + địa chỉ → luồng đơn tất định vẫn chốt được', () => {
  const afterPostpone = inbox({ hasBasket: true, lastWasOrderStep: false, botLastTemplateId: 'ORDER_POSTPONED', botLastAgeMin: 3, addressComplete: true, addressText: '12 Lê Lợi, phường Bến Nghé, Quận 1, TP Hồ Chí Minh' });
  const ruled = ruleIntent('0912345678 12 Lê Lợi, phường Bến Nghé, Quận 1, TP Hồ Chí Minh', afterPostpone);
  assert.deepEqual([ruled?.rule, ruled?.value?.template_id, ruled?.value?.Phone_Number], ['PHONE_ADDRESS', 'ORDER_ADDRESS', '0912345678']);
});

test('r13 #3: NO_VARIANT xét chữ còn dấu — "bơ hạt điều" là Gói Cam, "không lấy quà" là GIFT_SWAP, câu hỏi "ko có yến mạch?" là thành phần', () => {
  // Ca …330895 02/10 10:46 (sau deploy): trả "cả 3 túi đều có hạt điều" + thẻ, nhân viên vào sau 38 phút.
  // R16: Combo 10 gói Cam đã tắt (chủ shop 03/10: combo 10 gói chỉ còn Xanh) — test cũ khẳng định bot báo giá Cam; nay không
  // được báo giá món đã ngừng bán (lời trả cụ thể do luật quyết, xem báo cáo r16: nên là SMALL_PACK_FLAVOURS).
  assert.doesNotMatch(String(brief(ruleIntent('Gói cam bơ hạt điều. Bn e', inbox({ botLastTemplateId: 'DISCOUNT_POLICY' }))) ?? ''), /Combo 10 gói Cam/);
  assert.doesNotMatch(String(brief(ruleIntent('Hỏi Giá Túi Cam Nhỏ', inbox())) ?? ''), /Combo 10 gói Cam/);
  assert.notEqual(ruleIntent('Chị hỏi giá túi cam lớn granola điều lành có không em?', inbox())?.rule, 'SMALL_PACK_PRICE', '"túi cam lớn" không có: để mô hình/nhân viên');
  assert.notEqual(ruleIntent('cảm ơn shop, giá bn', inbox())?.rule, 'SMALL_PACK_PRICE', '"cảm ơn" không phải "cam"');
  // Ca …506783 01/10 20:27: "không lấy quà" (quà tặng) từng ra "cả 3 túi đều có quả sấy".
  const gift = ruleIntent('Mình mua 2b mà không lấy quà có được không shop ơi', inbox({ hasBasket: true, botLastTemplateId: 'LIVESTREAM_COMMENT' }));
  assert.deepEqual([gift.rule, gift.value.template_id, gift.attention], ['GIFT_SWAP', 'GIFT_SWAP', true]);
  // "quả" (trái cây sấy) và lời xin bỏ rõ vẫn là NO_VARIANT.
  assert.equal(ruleIntent('không lấy quả được không', inbox())?.value?.template_id, 'NO_VARIANT');
  assert.equal(ruleIntent('bỏ hạt được không em', inbox())?.value?.template_id, 'NO_VARIANT');
  assert.equal(ruleIntent('Mình muốn mua hạt Granola mà k có Yến mạch á', inbox())?.value?.template_id, 'NO_VARIANT');
  assert.equal(ruleIntent('có loại không yến mạch không', inbox())?.value?.template_id, 'NO_VARIANT', 'tìm loại không có X: vẫn NO_VARIANT');
  // Câu HỎI về túi này có/không thành phần.
  assert.equal(brief(ruleIntent('Túi này ko có yến mạch?', inbox({ botLastTemplateId: 'PRICE_QUOTE' }))), 'INGREDIENTS INGREDIENTS_ALLERGY');
  assert.equal(brief(ruleIntent('Túi này ko có yến mạch?', holding())), 'INGREDIENTS ORDER_ADDRESS INGREDIENTS_ALLERGY', 'đang giữ giỏ: giữ bước đơn + trả lời kèm');
  assert.equal(brief(ruleIntent('Cho chị 1 bịch màu vàng . Bịch nầy ko có yến mạch phải ko ?', inbox())), 'BASKET_INFO ORDER_ADDRESS INGREDIENTS_ALLERGY Granola Túi Vàng 350g 1', 'giỏ + câu hỏi thành phần: giữ giỏ');
});

test('r13 #4: tiểu đường khớp cả khi có "mua"; "bột ngũ cốc giảm béo" không trả calo granola; không lặp câu calo lần hai', () => {
  assert.equal(brief(ruleIntent('Ch muốn mua cho người mắc tiểu đường ăn', inbox())), 'DIABETES HEALTH_DIABETES');
  assert.equal(brief(ruleIntent('bị tiểu đường ăn được không', inbox())), 'DIABETES HEALTH_DIABETES');
  assert.equal(brief(ruleIntent('người bị đái tháo đường ăn được ko shop', inbox())), 'DIABETES HEALTH_DIABETES');
  assert.equal(ruleIntent('Có bột ngũ cốc giảm béo không shop', inbox()), null, 'hỏi sản phẩm khác (bột ngũ cốc): để mô hình');
  assert.equal(brief(ruleIntent('Vậy loại ăn hỗ trợ giảm cân thì loại nào?', inbox())), 'CALORIES CALORIES_DIET', 'lần đầu: mẫu calo');
  assert.equal(ruleIntent('Vậy loại ăn hỗ trợ giảm cân thì loại nào?', inbox({ botLastTemplateId: 'CALORIES_DIET' })), null, 'bot vừa gửi CALORIES_DIET: không lặp, để mô hình');
});

test('r13 #5: "có mấy vị" chịu lỗi gõ; hỏi giá + từ 2 vị → PRICE_MIX_TUI_LON (mẫu có trong Cài đặt)', () => {
  for (const text of ['Có mays lọi', 'Có mấy vị hả em', 'Mình có mấy vị vậy shop', 'có vị gì', 'Co loại j e', 'Có mấy loại']) {
    assert.equal(brief(ruleIntent(text, inbox())), 'FLAVOR_LIST GENERAL_INFO', text);
  }
  assert.ok(defaultMessageTemplates().PRICE_MIX_TUI_LON, 'mẫu PRICE_MIX_TUI_LON tồn tại');
  for (const [text, ctx] of [
    ['Giá của túi xanh và vàng đi bạn', inbox({ botLastTemplateId: 'PRICE_QUOTE' })],
    ['Lấy tui vàng và nâu thi giá sao', inbox({ botLastTemplateId: 'LIVESTREAM_COMMENT' })],
    ['2 gói 1 vàng 1 xanh giá bn e', inbox()],
    ['Cho mình xin giá granola túi xanh vaf vàng đi ạ', inbox({ botLastTemplateId: 'PRICE_QUOTE' })],
    ['1 túi xanh, 1 túi vàng giá bao nhiêu?', inbox()]
  ]) assert.equal(brief(ruleIntent(text, ctx)), 'PRICE_MIX PRICE_MIX_TUI_LON', text);
  // Không bắt: hỏi trọng lượng, có số tiền (câu xác nhận), nhiều hơn 1 túi mỗi vị, hai câu hỏi một tin, đang ở bước đơn, địa chỉ có "Gia".
  assert.notEqual(ruleIntent('Xanh 450 g vàng bao nhiêu g', inbox())?.rule, 'PRICE_MIX');
  assert.notEqual(ruleIntent('Vậy túi xamh450g túi  vàng 350g tông 298k đứng không a', inbox())?.rule, 'PRICE_MIX');
  assert.notEqual(ruleIntent('2 xanh 1 vàng giá bn', inbox())?.rule, 'PRICE_MIX');
  assert.equal(ruleIntent('1 túi xanh 1 túi vàng giá bn ạ\nĐc quà gì ạ', inbox()), null);
  assert.notEqual(ruleIntent('1tui xanh 1tui vang\nTong nhiu em', holding())?.rule, 'PRICE_MIX', 'đang ở bước đơn: mô hình trả dòng giỏ + tổng');
  assert.notEqual(ruleIntent('1 xanh 1 vàng gửi về ngõ 3 Gia Lâm Hà Nội', inbox())?.rule, 'PRICE_MIX');
});

test('r13 #6: hỏi quà theo chiều ngược ("xem mẫu quạt") → GIFT_POLICY + ảnh quà, không phải ảnh sản phẩm', () => {
  for (const text of ['Xem mẫu quạt', 'Cho xem hình bộ bát muỗng dưa đc k shop', 'Xem Bộ bat gao dua', 'Gửi ảnh quà cho chị xem', 'Cái quạt là kiểu thế nào', 'Tặng quạt gì đấy', 'bộ bát ntn']) {
    const ruled = ruleIntent(text, inbox());
    assert.deepEqual([ruled?.rule, ruled?.value?.template_id, ruled?.giftPhotos], ['GIFT_QUESTION', 'GIFT_POLICY', true], text);
  }
  assert.equal(brief(ruleIntent('Xem mẫu quạt', holding({ botLastTemplateId: 'ORDER_ADDRESS_REMIND' }))), 'GIFT_QUESTION ORDER_ADDRESS GIFT_POLICY');
  assert.equal(brief(ruleIntent('gửi hình qua zalo', inbox())), 'PHOTOS PRODUCT_PHOTOS', '"qua" (không dấu) không phải "quà"');
  assert.equal(brief(ruleIntent('Gửi hình e xem', inbox())), 'PHOTOS PRODUCT_PHOTOS');
});

test('r13 #7: chuẩn hoá lỗi gõ màu; quantityOnlyRequest; giỏ gõ sai vẫn lên đúng', () => {
  assert.equal(normalizeColourTypos('1 xanh + 1 túi vành'), '1 xanh + 1 túi vàng');
  assert.equal(normalizeColourTypos('2ca cao, 79xom hạ'), '2 cacao, 79xom hạ');
  assert.equal(normalizeColourTypos('2 túi cá cao'), '2 túi cacao');
  assert.equal(normalizeColourTypos('lấy 2 vag 1 xah').trim(), 'lấy 2 vàng 1 xanh');
  assert.equal(normalizeColourTypos('túi xamh450g'), 'túi xanh 450g');
  assert.equal(normalizeColourTypos('số 5 đường Vành Đai 2'), 'số 5 đường Vành Đai 2', 'địa danh giữ nguyên');
  assert.equal(brief(ruleIntent('Cho chị 1 xanh + 1 túi vành', inbox({ botLastTemplateId: 'LIVESTREAM_COMMENT' }))), 'BASKET ORDER_ADDRESS Granola Túi Xanh 450g 1');
  assert.equal(ruleIntent('Cho chị 1 xanh + 1 túi vành', inbox())?.value?.Product_N2, 'Granola Túi Vàng 350g');
  assert.equal(brief(ruleIntent('2ca cao', inbox())), 'BASKET ORDER_ADDRESS Granola Túi Nâu vị cacao 350g 2');
  assert.equal(brief(ruleIntent('2 túi cá cao', inbox())), 'BASKET ORDER_ADDRESS Granola Túi Nâu vị cacao 350g 2');
  for (const [text, count] of [['Số lượng là 2', 2], ['lấy 2 nha', 2], ['Chị lấy 2 mà', 2], ['Lấy 2 túi', 2], ['3 túi', 3], ['mình lấy tạm 1 túi thôi', 1], ['Cho c 1 tưi ăn thử đã', 1], ['Số lượng 3 túi nha b', 3], ['Mình lấy hai túi', 2]]) {
    assert.equal(quantityOnlyRequest(text), count, text);
  }
  for (const text of ['2', 'Vàng 2 túi', 'lấy 2 túi xanh', 'lấy 2 được không?', '2 túi bao nhiêu', 'Cho a 3 túi nữa', 'Mình đặt 3 túi rồi', '0912345678', 'combo 2', 'số 2 Lê Lợi']) {
    assert.equal(quantityOnlyRequest(text), 0, text);
  }
});

test('r13 #8: "Không nuốt noi" là chê (COMMENT_DISLIKE); "Ko thấy gj hết" là góp ý phiên live (LIVE_FEEDBACK)', () => {
  const fold = text => foldVietnamese(text).toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
  assert.ok(COMMENT_DISLIKE.test(fold('Không nuốt noi')));
  assert.ok(COMMENT_DISLIKE.test(fold('ko nuốt được')));
  assert.ok(LIVE_FEEDBACK.test(fold('Ko thấy gj hết')));
  assert.ok(!COMMENT_DISLIKE.test(fold('ngon lắm shop')));
  assert.ok(!LIVE_FEEDBACK.test(fold('ko thấy gì là sao, mình vẫn xem được mà')));
  assert.ok(!LIVE_FEEDBACK.test(fold('Xin giá')));
});

test('r13 #9: "không nhớ đặt hàng gì" → tra đơn; "nhầm / bấm nhầm" khi đang giữ giỏ → xóa giỏ + lời mềm', () => {
  assert.equal(brief(ruleIntent('Em khong nhớ là em đặt hàng gì bên chị.  Gửi lại cho em xin mẫu chị nhé', inbox({ botLastTemplateId: 'GENERAL_INFO' }))), 'ORDER_ASK ORDER_STATUS');
  for (const text of ['nhầm', 'bấm nhầm', 'Mình ấn nhầm thôi', 'Chị bấm nhầm đấy', 'lỡ tay bấm nhầm shop ơi']) {
    const ruled = ruleIntent(text, inbox({ hasBasket: true, botLastTemplateId: 'ORDER_ADDRESS' }));
    assert.deepEqual([ruled?.rule, ruled?.value?.template_id, ruled?.clearBasket], ['CANCEL_BASKET_MISCLICK', 'ORDER_POSTPONED', true], text);
  }
  assert.equal(ruleIntent('không mua', inbox({ hasBasket: true }))?.clearBasket, true);
  assert.ok(defaultMessageTemplates().ORDER_POSTPONED, 'mẫu lời mềm có sẵn');
  // Không giỏ, hay "nhận nhầm hàng" (khiếu nại), "chọn nhầm vị xanh" (đổi giỏ) thì không phải luật này.
  assert.notEqual(ruleIntent('bấm nhầm', inbox())?.rule, 'CANCEL_BASKET_MISCLICK');
  assert.notEqual(ruleIntent('shop giao nhầm hàng rồi', inbox({ hasBasket: true }))?.rule, 'CANCEL_BASKET_MISCLICK');
  assert.notEqual(ruleIntent('mình chọn nhầm túi xanh', inbox({ hasBasket: true }))?.rule, 'CANCEL_BASKET_MISCLICK');
  assert.equal(ruleIntent('bấm nhầm', inbox({ shopCart: true }))?.rule, 'CANCEL_BASKET_MISCLICK', 'engine báo đang có giỏ Facebook Shop');
});

test('r13 (models A2): "Vàng nhiều hạt và xanh nguyên bản / Mỗi loại 1 túi" → giỏ 2 túi (1 + 1), không phải 3 túi', () => {
  const two = ruleIntent('Vàng nhieu hạt và xanh nguyên bản\nMoi loại 1 túi', inbox());
  assert.deepEqual([two.rule, two.value.Product_N1, two.value.No_A, two.value.Product_N2, two.value.No_B, two.value.Product_N3], ['TWO_NAMED_FLAVOURS', 'Granola Túi Vàng 350g', '1', 'Granola Túi Xanh 450g', '1', undefined]);
  for (const text of ['3 túi 3 vị', 'Mình lấy mỗi loại 1 túi', '3 túi xanh vàng nâu nha em']) assert.equal(ruleIntent(text, inbox())?.rule, 'THREE_FLAVOURS', text);
});

test('r13 (models B): luật ứng viên K1/K1b/K3/K4/K5 đứng cuối chuỗi luật, theo cờ candidateRules (chưa có thì theo experimentalRules)', () => {
  const quoted = { botLastTemplateId: 'PRICE_QUOTE', botLastAgeMin: 30 };
  // K1: hỏi giá cụt không cần ngữ cảnh "fresh".
  for (const text of ['Giá sao', 'Granola giá sao vậy', 'Là bao nhiêu 1 túi bạn', 'Báo giá giúp mình', 'Bao nhiêu 1 gói đó b', 'Tư vấn và báo giá']) {
    assert.equal(brief(ruleIntent(text, inbox(quoted))), 'K1_SHORT_PRICE GENERAL_INFO', text);
  }
  assert.equal(ruleIntent('Giá sao', inbox({ ...quoted, contextProduct: 'Granola Túi Xanh 450g' })).value.Product_N1, 'Granola Túi Xanh 450g');
  assert.equal(ruleIntent('Giá sao', { ...inbox(quoted), source: 'comment' })?.commentRule, true, 'bình luận: luật bình luận');
  // K1b: đang giữ giỏ → vẫn bảng giá (engine kèm câu nhắc giỏ).
  assert.equal(brief(ruleIntent('Giá bao nhiêu em', holding())), 'K1B_SHORT_PRICE_HELD GENERAL_INFO');
  // K3: đang giữ giỏ, chỉ nêu số lượng.
  for (const [text, count] of [['Lấy 2 túi', 2], ['3 túi', 3], ['Chị lấy 2 mà', 2], ['Số lượng là 2', 2], ['mình lấy tạm 1 túi thôi', 1]]) {
    const ruled = ruleIntent(text, holding());
    assert.deepEqual([ruled?.rule, ruled?.value?.template_id, ruled?.setQuantity], ['K3_QTY_HELD', 'ORDER_ADDRESS', count], text);
  }
  assert.equal(ruleIntent('Lấy 2 túi', holding({ basketCodeCount: 2 })), null, 'giỏ nhiều mã: để mô hình hỏi vị nào');
  assert.equal(ruleIntent('Lấy 2 túi', holding({ basketCodeCount: 1 }))?.rule, 'K3_QTY_HELD');
  // Chủ shop 05/10: chưa giữ giỏ, không nêu vị → mặc định Túi Xanh (trước đây BAGS_NO_FLAVOR hỏi vị).
  assert.equal(brief(ruleIntent('Lấy 2 túi', inbox())), 'BAGS_DEFAULT_XANH ORDER_ADDRESS Granola Túi Xanh 450g 2', 'chưa giữ giỏ: mặc định Túi Xanh');
  // K4: "Mua", "Mua hàng".
  for (const text of ['Mua', 'Mua hàng', 'Mình muốn mua granola']) assert.equal(brief(ruleIntent(text, inbox(quoted))), 'K4_WANT_BUY GENERAL_INFO', text);
  assert.equal(ruleIntent('Mua đi', inbox(quoted)), null, '"Mua đi": để mô hình như cũ');
  // K5: "có mấy vị" khi đang giữ giỏ.
  assert.equal(brief(ruleIntent('Có mấy vị hả em', holding())), 'K5_FLAVOR_LIST_HELD ORDER_ADDRESS BAG_COMPARISON');
  assert.equal(brief(ruleIntent('Có mays lọi', inbox({ hasBasket: true, botLastTemplateId: 'ASK_TWO_BAGS' }))), 'K5_FLAVOR_LIST_HELD GENERAL_INFO');
  // Không bắt: nhân viên vừa nhắn, có màu/số/SĐT, sau PACKAGING_INFO (xin giá gói nhỏ), khách giữ ưu đãi dùng thử.
  assert.equal(ruleIntent('xin giá', inbox({ botLastTemplateId: 'GENERAL_INFO', staffRepliedAfterBot: true })), null);
  assert.notEqual(ruleIntent('giá 3 túi', inbox(quoted))?.rule, 'K1_SHORT_PRICE');
  assert.notEqual(ruleIntent('giá túi vàng', inbox(quoted))?.rule, 'K1_SHORT_PRICE');
  assert.equal(ruleIntent('Giá sao', inbox({ ...quoted, trialOffer: true })), null);
  // Cờ: mặc định (không cờ nào) = chạy ẩn; candidateRules ưu tiên hơn experimentalRules; 'off' tắt hẳn.
  const shadow = ruleIntent('Giá sao', { ...inbox(quoted), experimentalRules: undefined });
  assert.deepEqual([shadow.rule, shadow.shadowOnly, shadow.candidate], ['K1_SHORT_PRICE', true, true]);
  assert.equal(ruleIntent('Giá sao', inbox({ ...quoted, candidateRules: 'shadow' })).shadowOnly, true, 'experimentalRules on nhưng candidateRules shadow → chạy ẩn');
  assert.equal(ruleIntent('Giá sao', inbox({ ...quoted, experimentalRules: 'shadow', candidateRules: 'on' })).shadowOnly, undefined);
  assert.equal(ruleIntent('Giá sao', inbox({ ...quoted, candidateRules: 'off' })), null);
  // Luật ổn định vẫn đi trước luật ứng viên.
  assert.equal(brief(ruleIntent('Xin giá', inbox())), 'TERSE_PRICE GENERAL_INFO');
});

test('r13 K3 với bộ soạn đơn: giỏ một mã + "Lấy 2 túi" → ORDER_ADDRESS cùng mã, số mới; giỏ hai mã giữ nguyên; không gọi mô hình', async () => {
  const templates = defaultMessageTemplates();
  const run = async (items, text) => {
    const saved = [];
    let asked = 0;
    const conversation = { id: 'page:user', pageId: 'page', psid: 'user', name: 'Khách', botEnabled: true, botLastTemplateId: 'ORDER_ADDRESS', botLastReplyAt: Date.now() - 60000,
      pendingOrder: { items, key: items.map(item => `${item.code}=${item.quantity}`).sort().join('|'), at: Date.now() - 60000, phone: '', address: '', addressAsks: 0 } };
    const message = { id: 'm1', mid: 'm1', direction: 'incoming', type: 'text', text, createdAt: Date.now() };
    const results = await processChatbotChanges([{ type: 'message', conversation, message }], {
      readSettings: async () => ({ enabled: true, autoOrder: true, responseMode: 'automatic', handoffKeywords: '', complaintKeywords: '', fragmentWaitMs: 0, phoneFragmentWaitMs: 0, messageTemplates: templates, ruleIntent: 'on', experimentalRules: 'on',
        // (agent engine, R13) engine nay truyền cờ riêng `candidateRules` (mặc định 'shadow': luật K chỉ ghi nhật ký) — test
        // này kiểm K3 khi ĐÃ BẬT nên phải bật cờ đó; trước đây K3 ăn theo experimentalRules 'on'.
        candidateRules: 'on', preGuard: 'off', intentModel: 'off', intentCascade: 'off', addressAi: false }),
      listMessages: async () => [{ id: 'o1', mid: 'o1', direction: 'outgoing', type: 'text', text: 'Dạ chị gửi giúp em số điện thoại và địa chỉ nhận hàng nha', createdAt: Date.now() - 60000 }, message],
      getConversation: async () => conversation,
      saveBotState: async (_id, state) => { saved.push(state); },
      sendMessage: async () => ({ message: { mid: 'x' } }),
      requestReply: async () => { asked += 1; return { templateId: 'GENERAL_INFO', messages: ['x'], handoff: false }; }
    });
    const pending = saved.map(state => state.pendingOrder).filter(Boolean).at(-1) || conversation.pendingOrder;
    return { templateId: results[0]?.templateId, asked, items: pending.items.map(item => `${item.quantity}×${item.code}`) };
  };
  const one = await run([{ product: 'Granola Túi Xanh 450g', code: 'GRA-XANH-Z450', quantity: 1 }], 'Lấy 2 túi');
  assert.deepEqual([one.templateId, one.asked, one.items], ['ORDER_ADDRESS', 0, ['2×GRA-XANH-Z450']]);
  const bare = await run([{ product: 'Granola Túi Xanh 450g', code: 'GRA-XANH-Z450', quantity: 1 }], 'Chị lấy 2 mà');
  assert.deepEqual([bare.asked, bare.items], [0, ['2×GRA-XANH-Z450']], 'không có chữ "túi" vẫn đổi số lượng (quantityOnlyRequest)');
  const two = await run([{ product: 'Granola Túi Xanh 450g', code: 'GRA-XANH-Z450', quantity: 1 }, { product: 'Granola Túi Vàng 350g', code: 'GRA-VANG-H350', quantity: 1 }], 'Lấy 2 túi');
  assert.deepEqual(two.items, ['1×GRA-XANH-Z450', '1×GRA-VANG-H350'], 'giỏ hai mã: không đoán, giữ nguyên giỏ');
});
