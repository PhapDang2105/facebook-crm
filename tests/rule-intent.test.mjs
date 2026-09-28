import assert from 'node:assert/strict';
import test from 'node:test';
import './helpers/seed-catalog.mjs';
import { commentBasket, processChatbotChanges } from '../app/chatbot-engine.mjs';
import { core, ruleIntent } from '../app/processing/rule-intent.mjs';
import { defaultMessageTemplates, renderChatbotReply } from '../app/chatbot-templates.mjs';

// Câu lấy từ hội thoại thật 16–25/09 (đợt subagent vòng 4 đo luật).
const inbox = extra => ({ source: 'inbox', botLastTemplateId: '', botLastAgeMin: Infinity, bundleSize: 1, commentBasket, ...extra });
const pick = (text, ctx = inbox()) => {
  const result = ruleIntent(text, ctx);
  if (!result) return null;
  if (result.commentRule) return 'COMMENT_RULE';
  const value = result.value;
  return [value.template_id, value.Product_N1, value.No_A, value.Product_N2, value.No_B, value.also].filter(Boolean).join(' ');
};

test('core: bỏ dấu, dấu câu, lời gọi đầu câu, từ đệm cuối câu', () => {
  assert.equal(core('Xin giá ạ'), 'xin gia');
  assert.equal(core('Shop ơi tư vấn dùm'), 'tu van dum');
  assert.equal(core('Giá sao e ?'), 'gia sao');
});

test('hỏi giá cụt, ".", icebreaker: không cần mô hình', () => {
  for (const text of ['Xin giá', 'Ib', '.', 'Bn 1 gói ạ', 'Grannola', 'Làm cách nào để đặt hàng?']) assert.equal(pick(text), 'GENERAL_INFO', text);
  assert.equal(pick('Xin giá', inbox({ contextProduct: 'Granola Túi Xanh 450g' })), 'PRICE_QUOTE Granola Túi Xanh 450g');
  assert.equal(pick('Xin giá', { ...inbox(), source: 'comment' }), 'COMMENT_RULE');
  assert.equal(pick('Có chương trình giảm giá nào không?'), 'DISCOUNT_POLICY');
  assert.equal(pick('Hi'), 'WELCOME');
  assert.equal(pick('Túi xanh'), 'PRICE_QUOTE Granola Túi Xanh 450g');
});

test('giỏ ghi rõ: lên bước xin SĐT/địa chỉ đúng giỏ', () => {
  assert.equal(pick('Cho mình 1 xanh 1 vàng'), 'ORDER_ADDRESS Granola Túi Xanh 450g 1 Granola Túi Vàng 350g 1');
  assert.equal(pick('Lấy túi nâu ca cao'), 'ORDER_ADDRESS Granola Túi Nâu vị cacao 350g 1');
  assert.equal(pick('Gửi mk 1 túi xanh và 1 túi ca cao'), 'ORDER_ADDRESS Granola Túi Xanh 450g 1 Granola Túi Nâu vị cacao 350g 1');
  assert.equal(pick('2 bịch túi xanh 0916281139'), 'ORDER_ADDRESS Granola Túi Xanh 450g 2');
  assert.equal(pick('0973963885', inbox({ hasBasket: true, lastWasOrderStep: true, botLastTemplateId: 'ORDER_ADDRESS' })), 'ORDER_ADDRESS');
});

test('câu hỏi thông tin ngắn; đang ở bước đơn thì giữ bước đơn và trả lời bằng ý phụ', () => {
  assert.equal(pick('me bâu có dùng dc ko'), 'HEALTH_CONDITION');
  assert.equal(pick('Túi vàng và túi xanh khác nhau như nào'), 'BAG_COMPARISON_XANH_VANG');
  assert.equal(pick('Có miễn ship không'), 'FREESHIP_POLICY');
  assert.equal(pick('Có miễn ship không', inbox({ hasBasket: true, lastWasOrderStep: true, botLastTemplateId: 'ORDER_ADDRESS' })), 'ORDER_ADDRESS FREESHIP_POLICY');
  assert.equal(pick('Đã săn 290k', inbox({ livestream: true })), 'LIVE_DEAL_CLAIMED');
  assert.equal(pick('cảm ơn shop'), 'THANK_YOU');
  assert.equal(pick('1 gói trọng lượng. Bao nhiêu'), 'WEIGHT_EXPIRY', '"trọng lượng" không bị nhầm là "cho bé"');
});

test('những tin phải để mô hình (luật trả null)', () => {
  const cases = [
    'giao về phường cam linh giúp mình', // "linh" không phải link
    'nha khoa tiến sĩ hưng',
    '1 túi xanh 1 túi vàng 1 hộp 10 túi nhỏ',
    'Set mix 10 gói nhiều vị nhiêu e',
    'Bn gram 1túi và có bị hôi ko',
    '3 túi miễn síp nữa hả Tổng bao tiền',
    '1 túi xanh 1 túi vàng giá bn ạ Đc quà gì ạ',
    'Combo xanh',
    'Mình 2 gói xanh vàng',
    'Vàng 2 túi',
    'Nhưng có 1 thành phần quá cứng, cắn đau răng',
    'Mua đi'
  ];
  for (const text of cases) assert.equal(pick(text), null, text);
});

test('ngữ cảnh: "." hay "xin giá" ngay sau bước đơn, hay khi nhân viên vừa nhắn, không phải hỏi giá mới', () => {
  assert.equal(pick('.', inbox({ botLastTemplateId: 'ORDER_ADDRESS', botLastAgeMin: 3 })), null);
  // Sau PACKAGING_INFO ("cần em gửi bảng giá combo gói nhỏ không?") "xin giá" là xin giá gói nhỏ (vòng 9), không phải bảng giá chung.
  assert.equal(pick('xin giá', inbox({ botLastTemplateId: 'PACKAGING_INFO', botLastAgeMin: 3 })), 'PRICE_QUOTE_COMBO Combo 10 gói Xanh');
  assert.equal(pick('xin giá', inbox({ botLastTemplateId: 'PACKAGING_INFO', botLastAgeMin: 3, staffRepliedAfterBot: true })), null, 'nhân viên vừa nhắn: để mô hình');
  assert.equal(pick('xin giá', inbox({ botLastTemplateId: 'GENERAL_INFO', botLastAgeMin: 3, staffRepliedAfterBot: true })), null);
  assert.equal(pick('Cho mình 1 xanh 1 vàng', inbox({ orderAgeMin: 20 })), null, 'vừa chốt đơn: để luật sửa đơn/mô hình');
});

test('engine: luật khớp thì không gọi mô hình; chế độ "shadow" vẫn gọi mô hình', async () => {
  const templates = defaultMessageTemplates();
  const runWith = async ruleIntentMode => {
    let asked = 0;
    await processChatbotChanges([{
      type: 'message',
      conversation: { id: 'page:user', pageId: 'page', psid: 'user', name: 'Khách', botEnabled: true },
      message: { id: 'm1', mid: 'm1', direction: 'incoming', type: 'text', text: 'Cho mình 1 xanh 1 vàng', createdAt: Date.now() }
    }], {
      readSettings: async () => ({ enabled: true, responseMode: 'automatic', handoffKeywords: '', fragmentWaitMs: 1, messageTemplates: templates, ruleIntent: ruleIntentMode }),
      listMessages: async () => [],
      saveBotState: async () => {},
      sendMessage: async () => ({ message: { mid: 'x' } }),
      requestReply: async () => { asked += 1; return { templateId: 'GENERAL_INFO', messages: ['x'], handoff: false }; }
    });
    return asked;
  };
  assert.equal(await runWith('on'), 0);
  assert.equal(await runWith('shadow'), 1);
  assert.equal(await runWith('off'), 1);
});

test('rút gọn ngữ cảnh: mặc định giữ bản cũ; bật từng phần thì gọn hơn', async () => {
  const { buildChatbotQuery, composeSystemPrompt, thinkingConfigFor } = await import('../app/chatbot-engine.mjs');
  const conversation = { name: 'Lan Anh', botLastTemplateId: 'PRICE_QUOTE', botLastReplyAt: Date.now() - 60 * 1000 };
  const message = { text: 'ok' };
  const legacy = buildChatbotQuery({ conversation, message, settings: {} });
  assert.ok(legacy.includes('KHÁCH HÀNG: Lan Anh'));
  assert.ok(!legacy.includes('MẪU VỪA GỬI'));
  const compact = buildChatbotQuery({ conversation, message, settings: { contextTrim: { query: true } } });
  assert.ok(!compact.includes('Lan Anh'));
  assert.ok(compact.includes('MẪU VỪA GỬI: PRICE_QUOTE'));
  const templates = defaultMessageTemplates();
  const full = composeSystemPrompt('Prompt có WELCOME', templates);
  const trimmed = composeSystemPrompt('Prompt có WELCOME', templates, { catalog: true, templates: true });
  assert.ok(trimmed.length < full.length);
  assert.ok(full.includes('Tối đa'));
  assert.ok(!trimmed.includes('Tối đa'));
  assert.deepEqual(thinkingConfigFor('gemini-3-flash-preview', 'low'), { thinkingLevel: 'low' });
  assert.deepEqual(thinkingConfigFor('gemini-2.5-flash', 'low'), { thinkingBudget: 512 });
  assert.equal(thinkingConfigFor('gemini-3-flash-preview', ''), null);
});

test('luật thử nghiệm (vòng 6) mang experimental: TRIAL_ASK / ORDER_ASK / TERSE_HOW / ADDRESS_COMPLETE', () => {
  const ctx = { commentBasket };
  const trial = ruleIntent('Lấy c 1 túi dùng thử', ctx);
  assert.deepEqual([trial.rule, trial.experimental, trial.value.template_id], ['TRIAL_ASK', true, 'ASK_FLAVOR']);
  const xanh = ruleIntent('Mình lấy một túi xanh dung thử đã', ctx);
  assert.deepEqual([xanh.value.template_id, xanh.value.Product_N1, xanh.value.No_A], ['ORDER_ADDRESS', 'Granola Túi Xanh 450g', '1']);
  assert.equal(ruleIntent('C.mua 1 túi ăn thử được không shop', { ...ctx, contextProduct: 'Granola Túi Vàng 350g' }).value.Product_N1, 'Granola Túi Vàng 350g');
  assert.equal(ruleIntent('Lấy c 1 túi dùng thử', { ...ctx, trialOffer: true }), null, 'khách đang giữ ưu đãi: luồng dùng thử lo');
  const status = ruleIntent('Minh chưa nhận được hàng ạ', ctx);
  assert.deepEqual([status.rule, status.value.template_id], ['ORDER_ASK', 'ORDER_STATUS']);
  assert.equal(ruleIntent('Mua sao e', ctx).rule, 'TERSE_HOW');
  assert.equal(ruleIntent('Gannola bán sao ạ', ctx).value.template_id, 'GENERAL_INFO');
  const address = ruleIntent('Tổ 13 khu phố 2 phường Long Bình, Biên Hòa, Đồng Nai 0909123456', { ...ctx, hasBasket: true, lastWasOrderStep: true, addressComplete: true, addressText: 'Tổ 13 khu phố 2 phường Long Bình, Biên Hòa, Đồng Nai' });
  assert.deepEqual([address.rule, address.value.template_id, address.value.Customer_Address, address.value.Phone_Number], ['PHONE_ADDRESS', 'ORDER_ADDRESS', 'Tổ 13 khu phố 2 phường Long Bình, Biên Hòa, Đồng Nai', '0909123456']);
  assert.notEqual(ruleIntent('đổi sang 2 túi vàng, gửi về Tổ 13 khu phố 2 phường Long Bình, Biên Hòa, Đồng Nai', { ...ctx, hasBasket: true, lastWasOrderStep: true, addressComplete: true, addressText: 'x' })?.rule, 'ADDRESS_COMPLETE', 'kèm đổi giỏ: để mô hình');
});

test('vòng 7: luật thử nghiệm không che luật ổn định (shadow đính kèm); ORDER_ASK bắt "đã đặt rồi sao chưa thấy"; "combo 2 túi" không vị → hỏi vị', () => {
  const ctx = { commentBasket };
  const basket = ruleIntent('Lấy 1 túi xanh dùng thử', ctx);
  assert.deepEqual([basket.rule, basket.value.Product_N1, basket.shadow?.rule], ['BASKET', 'Granola Túi Xanh 450g', 'TRIAL_ASK']);
  assert.equal(ruleIntent('Lấy 1 túi xanh dùng thử', { ...ctx, experimentalRules: 'on' }).rule, 'TRIAL_ASK');
  const only = ruleIntent('Mua sao e', ctx);
  assert.deepEqual([only.rule, only.shadowOnly], ['TERSE_HOW', true]);
  for (const text of ['Bữa e đặt hàng sao chưa thấy đơn về', 'gửi hàng chưa shop', 'đã đặt rồi sao chưa thấy']) {
    assert.equal(ruleIntent(text, ctx)?.value?.template_id, 'ORDER_STATUS', text);
  }
  assert.equal(ruleIntent('lấy combo 2 túi', ctx).value.template_id, 'ASK_FLAVOR');
  assert.equal(ruleIntent('2 túi', ctx).value.template_id, 'ASK_FLAVOR');
});

test('vòng 7: "hàng mới không em" → FRESHNESS; freeship khi đang giữ giỏ mà khách đổi "1 túi ăn thử" → để mô hình; "ship mình 2 gói" → hỏi vị', () => {
  const ctx = { commentBasket };
  assert.equal(ruleIntent('Hàng mới không em', ctx)?.value?.template_id, 'FRESHNESS');
  assert.equal(ruleIntent('date mới ko shop', ctx)?.value?.template_id, 'FRESHNESS');
  assert.equal(ruleIntent('Có miễn ship không', { ...ctx, hasBasket: true, lastWasOrderStep: true }).value.template_id, 'ORDER_ADDRESS');
  assert.equal(ruleIntent('1túi miễn ship nha ăn thử', { ...ctx, hasBasket: true, lastWasOrderStep: true }), null, 'đổi số túi: không giữ giỏ cũ');
  assert.equal(ruleIntent('Ship mình 2 gói', ctx)?.value?.template_id, 'ASK_FLAVOR');
});

test('bộ chấm mẫu 26/09: "2 túi 298k miễn ship" là đặt hàng, không hỏi chính sách; "đúng hàng mới nhận" không phải hỏi độ mới', () => {
  const ctx = { commentBasket };
  assert.notEqual(ruleIntent('2 túi 298 k miễn sip', ctx)?.value?.template_id, 'FREESHIP_POLICY');
  assert.equal(ruleIntent('2 túi có miễn ship không', ctx)?.value?.template_id, 'FREESHIP_POLICY');
  assert.notEqual(ruleIntent('Đúng hàng mới nhận nha shop', ctx)?.value?.template_id, 'FRESHNESS');
  assert.equal(ruleIntent('Hàng mới không em', ctx)?.value?.template_id, 'FRESHNESS');
});

test('khiếu nại rõ (gọi không được, không ai gọi, bot luyên thuyên, ăn phải sợ) → CSKH_HANDOFF ngay; câu hỏi chính sách thì không', () => {
  const ctx = { commentBasket };
  for (const text of ['Cháu xem lại hàng cô đặt. cô gọi zalo suốt cho cháu k được', 'Có thấy ai gọi đâu', 'Ô sao lên đơn cứ luyên thuyên vậy shop', 'Nhưng có 1 thành phần quá cứng, ăn phải rất sợ luôn í', 'Thất vọng quá shop ơi']) {
    const ruled = ruleIntent(text, ctx);
    assert.equal(ruled?.value?.template_id, 'CSKH_HANDOFF', text);
    assert.equal(ruled.attention, true);
  }
  assert.notEqual(ruleIntent('Có đổi trả không shop', ctx)?.value?.template_id, 'CSKH_HANDOFF');
  // "gói" bỏ dấu trùng "gọi", "phần anh" trùng "phản ánh": không phải khiếu nại.
  for (const text of ['gói này mua lẻ không được hả shop', 'Gói nhỏ ship không được à', 'goi nho mua le khong duoc ha', 'gửi phần anh 1 túi']) {
    assert.notEqual(ruleIntent(text, ctx)?.value?.template_id, 'CSKH_HANDOFF', text);
  }
  assert.notEqual(ruleIntent('Đc kiểm hàng ko', ctx)?.value?.template_id, 'CSKH_HANDOFF');
  assert.equal(ruleIntent('Có thấy ai gọi đâu', { ...ctx, source: 'comment' })?.value?.template_id, undefined, 'bình luận đi luồng riêng');
});

test('vòng 8: câu đặt hàng có "phần anh" / "rất sợ béo" không phải khiếu nại; "phản ánh" (có dấu) và khiếu nại kèm giỏ vẫn bắt', () => {
  const ctx = { commentBasket };
  for (const text of ['phần anh 2 túi vàng, phần chị 1 túi xanh', 'ship cho anh 2 túi, phần anh xanh phần chị vàng', 'gửi anh phần anh', 'mình rất sợ béo nên đang cân nhắc', 'gói kỹ giúp mình nhé, gọi trước khi giao']) {
    assert.notEqual(ruleIntent(text, ctx)?.value?.template_id, 'CSKH_HANDOFF', text);
  }
  for (const text of ['phản ánh với shop là hàng bị mốc', 'gọi hoài không được', 'e goi hoai ko dc', 'thái độ nhân viên tệ quá', 'ăn phải sợ luôn', 'không thấy ai gọi cho mình', 'túi xanh bị mốc, thất vọng quá']) {
    const ruled = ruleIntent(text, ctx);
    assert.equal(ruled?.value?.template_id, 'CSKH_HANDOFF', text);
    assert.equal(ruled.attention, true, text);
  }
});

// ===== Vòng 9: đọc lại 214 hội thoại 26–28/09 (câu ví dụ lấy từ hội thoại thật).
test('vòng 9.1: SĐT + địa chỉ khi chưa có giỏ → ORDER_INFO_ASK_FLAVOR (giữ SĐT/địa chỉ); số Zalo sau WHOLESALE_CTV_CONTACT → WHOLESALE_RECEIVED + thẻ', () => {
  const ctx = { commentBasket };
  const info = ruleIntent('131/10B đường 6 linh Xuân thủ Đức tphcm 0912345678', { ...ctx, botLastTemplateId: 'ASK_FLAVOR', botLastAgeMin: 3, lastWasOrderStep: true });
  assert.deepEqual([info?.rule, info?.value?.template_id, info?.value?.Phone_Number, info?.value?.Customer_Address], ['ORDER_INFO', 'ORDER_INFO_ASK_FLAVOR', '0912345678', '131/10B đường 6 linh Xuân thủ Đức tphcm']);
  // "hòa đồn" không phải hóa đơn; tỉnh/thành nhận ra từ danh mục địa danh dù chưa đủ ba cấp.
  const partial = ruleIntent('Mình ở Biên Hòa Đồng Nai 0976594931', ctx);
  assert.equal(partial?.value?.template_id, 'ORDER_INFO_ASK_FLAVOR');
  assert.equal(partial?.value?.Customer_Address, 'Mình ở Biên Hòa Đồng Nai');
  // SĐT trơn ngay sau mẫu bán hàng: cũng bắt đầu đặt; sau ORDER_STATUS_NONE (tra đơn) thì không.
  assert.equal(ruleIntent('0912345678', { ...ctx, botLastTemplateId: 'ASK_FLAVOR', botLastAgeMin: 3, lastWasOrderStep: true })?.value?.template_id, 'ORDER_INFO_ASK_FLAVOR');
  assert.equal(ruleIntent('0912345678', { ...ctx, botLastTemplateId: 'ORDER_STATUS_NONE', botLastAgeMin: 3 }), null);
  // Có sản phẩm trong câu, hay đang giữ giỏ: luật cũ / luồng đơn lo, không bắt ORDER_INFO.
  assert.notEqual(ruleIntent('2 túi xanh, 12 Lê Lợi phường Bến Nghé quận 1 0912345678', ctx)?.value?.template_id, 'ORDER_INFO_ASK_FLAVOR');
  assert.equal(ruleIntent('0912345678', { ...ctx, hasBasket: true, lastWasOrderStep: true, botLastTemplateId: 'ORDER_ADDRESS' })?.rule, 'PHONE_ONLY');
  for (const text of ['0912345678', 'zalo 0912345678 nhé', 'Sđt zalo của mình 0912 345 678']) {
    const wholesale = ruleIntent(text, { ...ctx, botLastTemplateId: 'WHOLESALE_CTV_CONTACT', botLastAgeMin: 3 });
    assert.deepEqual([wholesale?.value?.template_id, wholesale?.attention], ['WHOLESALE_RECEIVED', true], text);
  }
  assert.equal(ruleIntent('0912345678', { ...ctx, source: 'comment', botLastTemplateId: 'ASK_FLAVOR' })?.value?.template_id, undefined, 'bình luận đi luồng riêng');
});

test('vòng 9.2: "vị nguyên bản"/"truyền thống" khi đang chọn vị hay giữ giỏ → ASK_FLAVOR_NGUYENBAN (không bảng giá); không ngữ cảnh thì để mô hình', () => {
  const ctx = { commentBasket };
  for (const text of ['vị nguyên bản', 'nguyên bản ạ', 'lấy vị truyền thống']) {
    assert.equal(ruleIntent(text, { ...ctx, botLastTemplateId: 'ASK_FLAVOR', botLastAgeMin: 3, lastWasOrderStep: true })?.value?.template_id, 'ASK_FLAVOR_NGUYENBAN', text);
  }
  assert.equal(ruleIntent('nguyên bản', { ...ctx, hasBasket: true })?.value?.template_id, 'ASK_FLAVOR_NGUYENBAN');
  assert.equal(ruleIntent('nguyên bản', ctx), null);
  assert.equal(ruleIntent('nguyên bản là sao', { ...ctx, hasBasket: true })?.value?.template_id, 'BAG_COMPARISON', 'hỏi nghĩa: so sánh túi, không phải chọn vị');
  assert.equal(ruleIntent('2 túi vàng nguyên bản', { ...ctx, hasBasket: true })?.rule, 'BASKET', 'nêu màu rõ: giỏ');
});

test('vòng 9.3: khách mới xin gợi ý → RECOMMEND_BEGINNER (trước COMPARE); "tư vấn c 1 túi nữa" không thành giỏ', () => {
  const ctx = { commentBasket };
  for (const text of ['túi nào ngon ạ', 'loại nào dễ ăn', 'mới tập ăn thì lấy loại nào', 'em chưa được trải nghiệm bao giờ', 'tư vấn giúp c 1 túi', 'tư vấn c 1 túi nữa', 'túi nào nên lấy']) {
    assert.equal(ruleIntent(text, ctx)?.value?.template_id, 'RECOMMEND_BEGINNER', text);
  }
  const advice = ruleIntent('tư vấn c 1 túi nữa', { ...ctx, hasBasket: true, lastWasOrderStep: true, botLastTemplateId: 'ORDER_ADDRESS', botLastAgeMin: 3 });
  assert.equal(advice?.value?.template_id, 'RECOMMEND_BEGINNER');
  assert.equal(advice?.value?.Product_N1, undefined, 'không cộng túi vào giỏ');
  assert.equal(ruleIntent('Túi vàng và túi xanh khác nhau như nào', ctx)?.value?.template_id, 'BAG_COMPARISON_XANH_VANG', 'so sánh vẫn COMPARE');
  assert.equal(ruleIntent('túi nào ngon giá bao nhiêu', ctx)?.value?.template_id, undefined, 'kèm hỏi giá: để mô hình');
});

test('vòng 9.4: xin bỏ thành phần → NO_VARIANT điền {ingredient} có dấu + thẻ; "bỏ qua đi" không bắt', () => {
  const ctx = { commentBasket };
  const cases = [['có loại không yến mạch không', 'yến mạch'], ['mình không ăn được đậu phộng, bỏ hạt được không', 'đậu phộng'], ['không lấy quả được không', 'quả sấy'], ['ko có hạt điều được k', 'hạt điều'], ['bỏ trái cây được không em', 'trái cây sấy']];
  for (const [text, ingredient] of cases) {
    const ruled = ruleIntent(text, ctx);
    assert.deepEqual([ruled?.value?.template_id, ruled?.value?.values?.ingredient, ruled?.attention], ['NO_VARIANT', ingredient, true], text);
  }
  assert.equal(ruleIntent('bỏ qua đi', ctx), null);
  assert.notEqual(ruleIntent('có yến mạch không', ctx)?.value?.template_id, 'NO_VARIANT', 'hỏi có/không thành phần: không phải xin bỏ');
  // Mẫu điền {ingredient} qua values: bộ render đọc value.values như các mẫu tự do.
  const rendered = renderChatbotReply({ template_id: 'NO_VARIANT', values: { ingredient: 'yến mạch' } }, defaultMessageTemplates(), {});
  assert.match(rendered.messages.join(' '), /đều có yến mạch/);
});

test('vòng 9.5: đang giữ giỏ, câu tóm tắt "…đúng không/phải không/đúng hả" → CONFIRM_YES; đổi giỏ thì không; combo 3 chọn vị → COMBO3_FLAVOR', () => {
  const ctx = { commentBasket };
  const basket = { ...ctx, hasBasket: true, lastWasOrderStep: true, botLastTemplateId: 'ORDER_ADDRESS', botLastAgeMin: 3 };
  for (const text of ['2 túi xanh 298k miễn ship đúng không', 'đúng hả', 'vậy là 2 túi phải không ạ', 'tổng 298k đúng không shop', 'đúng k?']) {
    assert.equal(ruleIntent(text, basket)?.value?.template_id, 'CONFIRM_YES', text);
  }
  assert.equal(ruleIntent('đổi sang 2 vàng đúng không', basket)?.value?.template_id, undefined, 'đổi giỏ: để mô hình');
  assert.equal(ruleIntent('thêm 1 túi nữa đúng không', basket)?.value?.template_id, undefined);
  assert.notEqual(ruleIntent('2 túi xanh đúng không', ctx)?.value?.template_id, 'CONFIRM_YES', 'chưa có giỏ: không xác nhận');
  for (const text of ['combo 3 túi khác nhau được không', 'combo gia đình là 3 túi gì', 'combo 3 túi cùng vị hay mix', 'combo 3 túi xanh hay 3 vị']) {
    assert.equal(ruleIntent(text, ctx)?.value?.template_id, 'COMBO3_FLAVOR', text);
  }
});

test('vòng 9.6: hẹn dịp khác / rút ý định đặt → ORDER_POSTPONED + clearBasket; đã có đơn thật thì không (hủy đơn đi luồng riêng)', () => {
  const ctx = { commentBasket };
  for (const text of ['thôi để bữa khác chốt nha', 'xin lỗi shop, mình hủy nhé', 'thôi để sau', 'hôm khác mình đặt', 'để đợt khác mua', 'xin lỗi em, chị không lấy nữa']) {
    const ruled = ruleIntent(text, { ...ctx, hasBasket: true, lastWasOrderStep: true, botLastTemplateId: 'ORDER_ADDRESS', botLastAgeMin: 3 });
    assert.deepEqual([ruled?.rule, ruled?.value?.template_id, ruled?.clearBasket], ['ORDER_POSTPONED', 'ORDER_POSTPONED', true], text);
  }
  assert.equal(ruleIntent('xin lỗi shop, mình hủy nhé', { ...ctx, hasRecentOrder: true, orderAgeMin: 30 })?.rule, undefined);
  assert.notEqual(ruleIntent('đã đặt rồi sao chưa thấy', ctx)?.rule, 'ORDER_POSTPONED');
  assert.equal(ruleIntent('thôi để sau', { ...ctx, trialOffer: true }), null, 'khách giữ ưu đãi: luồng dùng thử lo');
});

test('vòng 9.7: khiếu nại thêm (mua bên khác, k chốt đơn, người thật, mở ra toàn…, buôn bán kiểu gì) → CSKH_HANDOFF; câu cũ vẫn không bắt', () => {
  const ctx = { commentBasket };
  for (const text of ['thôi mình mua bên khác', 'k chốt đơn cho khách à', 'cho gặp người thật đi', 'cho nói chuyện với người thật', 'mở ra toàn viên ngũ cốc', 'túi vàng mở ra chủ yếu là ngũ cốc, ít hạt', 'buôn bán kiểu gì vậy', 'nhân viên thật đâu']) {
    const ruled = ruleIntent(text, ctx);
    assert.equal(ruled?.value?.template_id, 'CSKH_HANDOFF', text);
    assert.equal(ruled?.attention, true, text);
  }
  for (const text of ['gói nhỏ ship không được à', 'gửi phần anh 1 túi', 'phần anh 2 túi vàng, phần chị 1 túi xanh', 'Gói nhỏ mua lẻ không được hả shop']) {
    assert.notEqual(ruleIntent(text, ctx)?.value?.template_id, 'CSKH_HANDOFF', text);
  }
});

test('vòng 9.8: mẹ sau sinh / cho con bú → HEALTH_CONDITION; vừa đặt mà dặn "hàng mới" → ORDER_NOTE_ADDED (ghi chú); "thêm … nữa" khi có đơn cũ → để mô hình', () => {
  const ctx = { commentBasket };
  for (const text of ['mẹ sau sinh ăn được không', 'đang cho con bú ăn được không', 'đang ở cữ ăn được k', 'đang cho bú dùng được không']) {
    assert.equal(ruleIntent(text, ctx)?.value?.template_id, 'HEALTH_CONDITION', text);
  }
  const note = ruleIntent('gửi hàng mới nha', { ...ctx, hasRecentOrder: true, orderAgeMin: 10 });
  assert.deepEqual([note?.value?.template_id, note?.value?.values?.note, note?.value?.values?.fresh], ['ORDER_NOTE_ADDED', 'hàng mới', '1']);
  assert.equal(ruleIntent('date mới nhé shop', { ...ctx, hasRecentOrder: true, orderAgeMin: 10 })?.value?.template_id, 'ORDER_NOTE_ADDED');
  assert.equal(ruleIntent('Hàng mới không em', ctx)?.value?.template_id, 'FRESHNESS', 'chưa đặt: hỏi độ mới');
  assert.equal(ruleIntent('thêm 1 túi xanh nữa nhé', { ...ctx, hasRecentOrder: true, orderAgeMin: 200 }), null);
  assert.equal(ruleIntent('lấy thêm 1 túi xanh', ctx)?.rule, 'BASKET', 'không có đơn cũ: giỏ như cũ');
});

test('vòng 9.9: "socola/chocolate" là Túi Nâu ở mọi chỗ đếm màu; xanh mint/tropical/túi dâu/sữa hạt là hàng live → LIVE_ONLY_PRODUCT + thẻ, không đếm thành Túi Xanh', () => {
  const ctx = { commentBasket };
  assert.deepEqual([ruleIntent('lấy 2 túi socola', ctx)?.value?.Product_N1, ruleIntent('lấy 2 túi socola', ctx)?.value?.No_A], ['Granola Túi Nâu vị cacao 350g', '2']);
  assert.equal(ruleIntent('1 xanh 1 chocolate', ctx)?.value?.Product_N2, 'Granola Túi Nâu vị cacao 350g');
  assert.equal(ruleIntent('túi sô cô la', ctx)?.value?.Product_N1, 'Granola Túi Nâu vị cacao 350g');
  for (const text of ['cho mình 1 túi xanh mint', 'túi xanh mint giá bn', 'có bán sữa hạt không', 'cho mình 1 túi dâu', 'lấy 1 tropical', 'túi xanh bạc hà còn không']) {
    const ruled = ruleIntent(text, ctx);
    assert.deepEqual([ruled?.value?.template_id, ruled?.attention], ['LIVE_ONLY_PRODUCT', true], text);
    assert.notEqual(ruled?.value?.Product_N1, 'Granola Túi Xanh 450g', text);
  }
  assert.equal(ruleIntent('có xoài không', ctx)?.value?.template_id, undefined, 'hỏi thành phần: để mô hình');
  assert.equal(ruleIntent('Túi xanh', ctx)?.value?.Product_N1, 'Granola Túi Xanh 450g');
});

test('vòng 9.10: "mua ở đâu / thế nào" → ORDER_HELP (không ECOMMERCE_LINKS trừ khi nhắc sàn); "4/5/6 túi giá?" → ORDER_CUSTOM_BASKET + thẻ', () => {
  const ctx = { commentBasket };
  for (const text of ['mua ở đâu vậy', 'mua sản phẩm này thế nào', 'mua hàng kiểu gì', 'mua sp này ntn']) {
    assert.equal(ruleIntent(text, ctx)?.value?.template_id, 'ORDER_HELP', text);
  }
  assert.notEqual(ruleIntent('mua trên shopee thế nào', ctx)?.value?.template_id, 'ORDER_HELP');
  assert.equal(ruleIntent('cho xin link shopee', ctx)?.value?.template_id, 'ECOMMERCE_LINKS');
  const five = ruleIntent('5 túi giá bao nhiêu', ctx);
  assert.deepEqual([five?.value?.template_id, five?.value?.values?.cart, five?.attention], ['ORDER_CUSTOM_BASKET', '5 túi', true]);
  const four = ruleIntent('4 túi xanh bn', ctx);
  assert.deepEqual([four?.value?.template_id, four?.value?.Product_N1, four?.value?.No_A, four?.value?.values?.cart], ['ORDER_CUSTOM_BASKET', 'Granola Túi Xanh 450g', '4', '4 Granola Túi Xanh 450g']);
  assert.equal(ruleIntent('sáu túi bao nhiêu tiền', ctx)?.value?.template_id, 'ORDER_CUSTOM_BASKET');
  assert.equal(ruleIntent('2 túi bao nhiêu', ctx)?.value?.template_id, undefined, '2 túi: bảng combo, để luật/mô hình cũ');
});

test('vòng 9.11: gói nhỏ hỏi cách khác → PACKAGING_INFO; sau PACKAGING_INFO xin giá / "có" / hỏi combo 10 → PRICE_QUOTE_COMBO theo màu ngữ cảnh', () => {
  const ctx = { commentBasket };
  for (const text of ['có set nhiều gói nhỏ không', 'gói nhỏ mix vị có không', 'combo gói nhỏ có không', 'có hộp gói nhỏ không em']) {
    assert.equal(ruleIntent(text, ctx)?.value?.template_id, 'PACKAGING_INFO', text);
  }
  assert.equal(ruleIntent('Set mix 10 gói nhiều vị nhiêu e', ctx), null, 'kèm hỏi giá gói nhỏ chưa rõ loại: mô hình');
  const after = { ...ctx, botLastTemplateId: 'PACKAGING_INFO', botLastAgeMin: 3 };
  for (const text of ['xin giá', 'có', 'Có a', 'gửi em bảng giá', 'combo 10 gói bao nhiêu', 'giá gói nhỏ sao']) {
    assert.deepEqual([ruleIntent(text, after)?.value?.template_id, ruleIntent(text, after)?.value?.Product_N1], ['PRICE_QUOTE_COMBO', 'Combo 10 gói Xanh'], text);
  }
  assert.equal(ruleIntent('combo 10 gói nâu bao nhiêu', after)?.value?.Product_N1, 'Combo 10 gói Nâu');
  assert.equal(ruleIntent('xin giá', { ...after, contextProduct: 'Granola Túi Nâu vị cacao 350g' })?.value?.Product_N1, 'Combo 10 gói Nâu');
  assert.equal(ruleIntent('không cần', after), null);
  assert.notEqual(ruleIntent('2 hộp xanh', { ...after, smallPackContext: true })?.value?.template_id, 'PRICE_QUOTE_COMBO', 'giỏ gói nhỏ: mô hình');
  assert.equal(ruleIntent('hộp 10 gói giá bn', ctx)?.value?.template_id, 'PRICE_QUOTE_COMBO', 'không cần ngữ cảnh khi nêu rõ combo 10');
});
