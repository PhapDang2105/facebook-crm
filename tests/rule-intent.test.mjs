import assert from 'node:assert/strict';
import test from 'node:test';
import './helpers/seed-catalog.mjs';
import { commentBasket, processChatbotChanges } from '../app/chatbot-engine.mjs';
import { core, ruleIntent } from '../app/processing/rule-intent.mjs';
import { defaultMessageTemplates } from '../app/chatbot-templates.mjs';

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
    'Mình ở Biên Hòa Đồng Nai 0976594931', // "hòa đồn" không phải hóa đơn
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
  assert.equal(pick('xin giá', inbox({ botLastTemplateId: 'PACKAGING_INFO', botLastAgeMin: 3 })), null);
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
