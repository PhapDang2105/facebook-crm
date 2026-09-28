import assert from 'node:assert/strict';
import test from 'node:test';
import './helpers/seed-catalog.mjs';
import { bagCountInText, buildDecisionRecord, composeSystemPrompt, intentTopK, modelTemplateChoices, prevBotAsks, processChatbotChanges, requestDirectModelReply, responseSchemaFor, withFallbackTemplates } from '../app/chatbot-engine.mjs';
import { defaultMessageTemplates, renderChatbotReply } from '../app/chatbot-templates.mjs';
import { normalizeChatbotSettings } from '../app/chatbot-settings.mjs';
import { gateCheck, sameTemplateGroup, templateGroup } from '../app/processing/llm-router.mjs';

// Vòng 9: nhật ký quyết định, bỏ REPLY_ALREADY_SENT khỏi lựa chọn của mô hình, gác trước LLM, người gác chỉ ghi.
const seed = Object.fromEntries(Object.entries(defaultMessageTemplates()).map(([id, text]) => [id, text.trim()]));
const templates = withFallbackTemplates(seed);
const settings = extra => async () => ({ enabled: true, responseMode: 'automatic', handoffKeywords: '', fragmentWaitMs: 1, messageTemplates: seed, ...extra });
const now = () => Date.now();
const settle = () => new Promise(resolve => setImmediate(resolve));

async function run(conversation, text, { reply, recent = [], extraDeps = {}, extraSettings = {}, type = 'text', message = {} } = {}) {
  const sent = [];
  const saved = [];
  const asked = [];
  const records = [];
  const results = await processChatbotChanges([{
    type: 'message',
    conversation: { id: 'page:user', pageId: 'page', psid: 'user', name: 'Khách', botEnabled: true, ...conversation },
    message: { id: 'm-new', mid: 'm-new', direction: 'incoming', type, text, createdAt: now(), ...message }
  }], {
    readSettings: settings(extraSettings),
    listMessages: async () => recent,
    saveBotState: async (_id, state) => { saved.push({ id: _id, ...state }); },
    sendMessage: async (_c, payload) => { sent.push(payload.text || `[ảnh ${payload.imageUrls?.length || 1}]`); return { message: { mid: 'x' } }; },
    createOrder: async (_c, order) => ({ order: { id: 'new', ...order }, created: true }),
    requestReply: async payload => { asked.push(payload); return typeof reply === 'function' ? reply(payload, asked.length) : reply; },
    appendDecisionLog: record => { records.push(record); },
    ...extraDeps
  });
  await settle();
  return { sent, saved, asked, results, records };
}
const outgoing = (text, agoMs, extra = {}) => ({ id: `o-${agoMs}`, direction: 'outgoing', type: 'text', text, createdAt: now() - agoMs, ...extra });
const incoming = (text, agoMs, extra = {}) => ({ id: `i-${agoMs}`, direction: 'incoming', type: 'text', text, createdAt: now() - agoMs, ...extra });
const render = (id, extra = {}) => renderChatbotReply({ template_id: id, ...extra }, templates, {});
const llmReply = (id, extra = {}) => ({ ...render(id), model: 'gemini-3-flash-preview', retried: false, fewShot: ['PRICE_QUOTE', 'GENERAL_INFO'], usage: { input: 2400, cached: 2300, output: 30, thinking: 0 }, ...extra });

// ===== 2. REPLY_ALREADY_SENT* không còn là lựa chọn của mô hình =====

test('2a. prompt ghép bỏ mọi dòng nhắc REPLY_ALREADY_SENT / _INFO; danh sách mẫu cho enum không chứa chúng', () => {
  const base = 'Chọn template_id.\n- Khách hỏi lại điều vừa gửi → REPLY_ALREADY_SENT (chưa có đơn) hoặc REPLY_ALREADY_SENT_INFO.\n- Hỏi giá → PRICE_QUOTE, chào → WELCOME.';
  const prompt = composeSystemPrompt(base, seed);
  assert.doesNotMatch(prompt, /REPLY_ALREADY_SENT/);
  assert.match(prompt, /Hỏi giá → PRICE_QUOTE/);
  const choices = modelTemplateChoices(seed, prompt);
  assert.ok(choices.includes('PRICE_QUOTE') && choices.includes('GENERAL_INFO') && choices.includes('ORDER_ADDRESS') && choices.includes('CSKH_HANDOFF'));
  assert.ok(!choices.some(id => /^REPLY_ALREADY_SENT|^FOLLOW_UP_|^COMMENT_/.test(id)));
  const schema = responseSchemaFor(choices);
  assert.equal(schema.type, 'object');
  assert.deepEqual(schema.required, ['template_id']);
  assert.deepEqual(schema.properties.template_id.enum, choices);
  assert.ok(['Product_N1', 'No_A', 'Phone_Number', 'Customer_Address', 'also', 'warming'].every(key => schema.properties[key]?.type === 'string'));
});

test('2b. Vertex: responseEnum "on" gửi responseSchema với enum template_id (không có REPLY_ALREADY_SENT); mặc định "off" không gửi', async () => {
  const bodies = [];
  const ask = responseEnum => requestDirectModelReply({
    settings: {
      provider: 'vertex', directAuthType: 'access_token', directApiKey: 'tok', promptCache: 'off', retryCount: 0, responseEnum,
      directEndpoint: 'https://aiplatform.googleapis.com/v1/projects/demo/locations/global/publishers/google/models/gemini-3-flash-preview:generateContent',
      directModel: 'gemini-3-flash-preview', structuredOutput: true, messageTemplates: seed,
      systemPrompt: 'Trả JSON. Giục → REPLY_ALREADY_SENT. Hỏi giá → PRICE_QUOTE.'
    },
    conversation: { psid: '1' }, message: { type: 'text', text: 'giá' },
    fetchImpl: async (_url, options) => { bodies.push(JSON.parse(options.body)); return { ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text: '{"template_id":"GENERAL_INFO"}' }] } }], usageMetadata: { promptTokenCount: 2360, cachedContentTokenCount: 0, candidatesTokenCount: 12, thoughtsTokenCount: 5 } }) }; }
  });
  const on = await ask('on');
  assert.equal(on.templateId, 'GENERAL_INFO');
  assert.deepEqual(on.usage, { input: 2360, cached: 0, output: 12, thinking: 5 }, 'số token kèm câu trả lời cho nhật ký');
  assert.equal(on.model, 'gemini-3-flash-preview');
  const schema = bodies[0].generationConfig.responseSchema;
  assert.ok(schema, 'có responseSchema');
  assert.equal(bodies[0].generationConfig.responseMimeType, 'application/json');
  assert.ok(schema.properties.template_id.enum.includes('PRICE_QUOTE'));
  assert.ok(!schema.properties.template_id.enum.some(id => id.startsWith('REPLY_ALREADY_SENT')));
  assert.doesNotMatch(bodies[0].systemInstruction.parts[0].text, /REPLY_ALREADY_SENT/);
  await ask('off');
  assert.equal(bodies[1].generationConfig.responseSchema, undefined);
  assert.equal(normalizeChatbotSettings({}).responseEnum, 'off');
});

test('2c. mô hình trả REPLY_ALREADY_SENT_INFO cho tin có ý mới → chuyển người + thẻ, KHÔNG gọi mô hình lần 2', async () => {
  const stubborn = await run({ botLastTemplateId: 'PRICE_QUOTE', botLastReplyAt: now() - 60000 }, 'túi xanh có yến mạch không?', { reply: llmReply('REPLY_ALREADY_SENT_INFO'), extraSettings: { preGuard: 'off' } });
  assert.equal(stubborn.asked.length, 1, 'chỉ một lượt LLM');
  assert.equal(stubborn.results[0].templateId, 'CSKH_HANDOFF');
  assert.ok(stubborn.saved.at(-1).addLabelEvents.includes('handoff'));
  assert.equal(stubborn.records[0].chosen, 'REPLY_ALREADY_SENT_INFO');
  assert.equal(stubborn.records[0].final, 'CSKH_HANDOFF');
  assert.equal(stubborn.records[0].llm.calls, 1);
});

// ===== 1. Nhật ký quyết định =====

test('1a. hộp thư: ghi đúng schema sau khi quyết định (luật/mô hình nhỏ/LLM/few-shot/gate), text là chữ gộp engine xử lý', async () => {
  const flow = await run({ botLastTemplateId: 'GENERAL_INFO', botLastReplyAt: now() - 3 * 60000, pendingOrder: null }, 'túi vàng có yến mạch không?', {
    reply: llmReply('INGREDIENTS_ALLERGY'),
    recent: [outgoing('Bảng giá', 3 * 60000), incoming('2 túi vàng nhé', 20000, { id: 'i-first' })],
    extraSettings: { preGuard: 'shadow', intentModel: 'shadow' }
  });
  assert.equal(flow.records.length, 1);
  const row = flow.records[0];
  assert.deepEqual(Object.keys(row), ['v', 'at', 'conversationId', 'source', 'mid', 'text', 'type', 'prevBot', 'lastTemplate', 'prevBotAgeMin', 'prevBotAsks', 'ctx', 'rule', 'shadow', 'intent', 'llm', 'fewShot', 'chosen', 'final', 'also', 'skipped', 'guards', 'attention', 'handoff', 'ms']);
  assert.equal(row.v, 1);
  assert.equal(row.source, 'inbox');
  assert.equal(row.mid, 'm-new');
  assert.equal(row.text, '2 túi vàng nhé\ntúi vàng có yến mạch không?', 'tin gộp đúng như engine đưa vào xử lý');
  assert.equal(row.prevBot, 'GENERAL_INFO');
  assert.ok(row.prevBotAgeMin >= 2.9 && row.prevBotAgeMin <= 3.2);
  assert.equal(row.prevBotAsks, '');
  assert.deepEqual(Object.keys(row.ctx), ['hasBasket', 'basketAgeMin', 'basketItems', 'hasRecentOrder', 'orderAgeMin', 'staffRepliedAfterBot', 'lastWasOrderStep', 'livestream', 'phoneInText', 'addressInText', 'bagCount', 'attentionOpen', 'gender']);
  assert.equal(row.ctx.bagCount, 2);
  assert.equal(row.ctx.hasBasket, false);
  assert.equal(row.rule, null);
  assert.deepEqual(row.shadow, []);
  assert.ok(row.intent === null || (typeof row.intent.templateId === 'string' && Array.isArray(row.intent.topK)));
  assert.equal(row.llm.templateId, 'INGREDIENTS_ALLERGY');
  assert.deepEqual(row.llm.usage, { input: 2400, cached: 2300, output: 30, thinking: 0 });
  assert.equal(row.llm.model, 'gemini-3-flash-preview');
  assert.deepEqual(row.fewShot, ['PRICE_QUOTE', 'GENERAL_INFO']);
  assert.equal(row.chosen, 'INGREDIENTS_ALLERGY');
  assert.equal(row.final, 'INGREDIENTS_ALLERGY');
  assert.equal(row.skipped, null);
  assert.equal(row.guards.preGuard, null, 'tin có ý mới: gác trước không bắt');
  assert.ok(row.guards.gate === null || typeof row.guards.gate.reason === 'string');
  assert.equal(typeof row.ms, 'number');
});

test('1b. bình luận cũng ghi (source comment); lượt bỏ qua (sticker) ghi skipped, final null; decisionLog "off" không ghi', async () => {
  const comment = await run({ id: 'page:post:comment:1', source: 'comment', post: { message: 'Granola Túi Xanh 450g' } }, 'giá sao', {
    reply: llmReply('PRICE_QUOTE', { ...render('PRICE_QUOTE', { Product_N1: 'Granola Túi Xanh 450g' }) }),
    extraDeps: { getConversation: async () => null }
  });
  assert.equal(comment.records.length, 1);
  assert.equal(comment.records[0].source, 'comment');
  assert.equal(comment.records[0].conversationId, 'page:post:comment:1');
  assert.ok(comment.records[0].final, 'bình luận có mẫu gửi');
  const sticker = await run({}, '', { type: 'sticker', reply: llmReply('WELCOME') });
  assert.equal(sticker.records.length, 1);
  assert.equal(sticker.records[0].skipped, 'sticker');
  assert.equal(sticker.records[0].final, null);
  assert.equal(sticker.records[0].type, 'sticker');
  const off = await run({}, 'xin giá', { reply: llmReply('GENERAL_INFO'), extraSettings: { decisionLog: 'off' } });
  assert.equal(off.records.length, 0);
  assert.equal(normalizeChatbotSettings({}).decisionLog, 'on');
});

test('1c. prevBotAsks / bagCountInText / intentTopK / buildDecisionRecord (schema thuần)', () => {
  assert.equal(prevBotAsks('ORDER_ADDRESS', { items: [{}], phone: '', address: '' }), 'phone_address');
  assert.equal(prevBotAsks('ORDER_ADDRESS_PARTIAL', { phone: '0385805790', address: '' }), 'address');
  assert.equal(prevBotAsks('ORDER_ADDRESS_CLARIFY', { phone: '', address: 'Hà Nội' }), 'phone');
  assert.equal(prevBotAsks('ASK_FLAVOR'), 'flavor');
  assert.equal(prevBotAsks('ASK_PRODUCT'), 'flavor');
  assert.equal(prevBotAsks('ORDER_EXISTING_CONFIRM'), 'confirm');
  assert.equal(prevBotAsks('ASK_QUANTITY'), 'quantity');
  assert.equal(prevBotAsks('PRICE_QUOTE'), '');
  assert.equal(bagCountInText('cho em 2 túi xanh và 1 túi vàng'), 3);
  assert.equal(bagCountInText('combo 3 giá sao'), 3);
  assert.equal(bagCountInText('túi xanh có yến mạch không'), 0);
  assert.deepEqual(intentTopK({ templateId: 'PRICE_QUOTE', confidence: 0.7, margin: 0.3, second: 'GENERAL_INFO' }), [{ templateId: 'PRICE_QUOTE', p: 0.7 }, { templateId: 'GENERAL_INFO', p: 0.4 }]);
  assert.deepEqual(intentTopK({ templateId: 'PRICE_QUOTE', confidence: 0.7, margin: 0.3, topK: [{ templateId: 'PRICE_QUOTE', p: 0.7 }, { templateId: 'GENERAL_INFO', p: 0.2 }, { templateId: 'BAG_COMPARISON', p: 0.1 }] }).length, 3, 'đọc intent.topK khi mô hình nhỏ trả');
  const row = buildDecisionRecord({
    conversation: { id: 'c', source: 'inbox', botLastTemplateId: 'ORDER_ADDRESS', botLastReplyAt: now() - 60000, pendingOrder: { items: [{ quantity: 2 }], at: now() - 60000, phone: '', address: '' } },
    change: { message: { mid: 'mid-1', text: 'ok', type: 'text' } },
    trace: { text: 'ok', type: 'text', ctx: null, rule: { name: 'ACK', templateId: 'THANK_YOU' }, shadow: [], intent: null, llm: null, fewShot: [], chosen: 'THANK_YOU', preGuard: null, gate: null, attention: false, handoff: false },
    result: { skipped: 'lặp tin vừa gửi' }, final: null, startedAt: now() - 5
  });
  assert.equal(row.prevBotAsks, 'phone_address');
  assert.equal(row.ctx.basketItems, 2);
  assert.equal(row.skipped, 'lặp tin vừa gửi');
  assert.equal(row.final, null);
  assert.deepEqual(row.rule, { name: 'ACK', templateId: 'THANK_YOU' });
});

// ===== 3. Gác trước LLM =====

test('3a. shadow (mặc định): khách giục sau bảng giá → vẫn gọi LLM, nhật ký ghi guards.preGuard {decision, matched}', async () => {
  assert.equal(normalizeChatbotSettings({}).preGuard, 'shadow');
  const flow = await run({ botLastTemplateId: 'PRICE_QUOTE', botLastReplyAt: now() - 2 * 60000 }, 'sao chưa trả lời', {
    reply: llmReply('GENERAL_INFO'), recent: [incoming('giá túi xanh', 3 * 60000), outgoing('Bảng giá Granola Túi Xanh 450g để chị tham khảo', 2 * 60000)]
  });
  assert.equal(flow.asked.length, 1, 'shadow vẫn hỏi mô hình');
  const guard = flow.records[0].guards.preGuard;
  assert.equal(guard.decision, 'REPLY_ALREADY_SENT');
  assert.equal(guard.reason, 'nudge');
  assert.equal(guard.mode, 'shadow');
  assert.equal(guard.matched, flow.results[0].templateId === 'REPLY_ALREADY_SENT');
});

test('3b. on: giục / lặp y câu sau mẫu thông tin → trả "đã gửi ở trên" ngay, không gọi LLM; _INFO kèm thẻ', async () => {
  const nudge = await run({ botLastTemplateId: 'PRICE_QUOTE', botLastReplyAt: now() - 2 * 60000 }, '???', { reply: llmReply('GENERAL_INFO'), extraSettings: { preGuard: 'on' } });
  assert.equal(nudge.asked.length, 0, 'không gọi LLM');
  assert.equal(nudge.results[0].templateId, 'REPLY_ALREADY_SENT');
  assert.match(nudge.sent[0], /gửi ngay tin phía trên/);
  assert.equal(nudge.records[0].guards.preGuard.matched, true);
  assert.equal(nudge.records[0].llm, null);
  // Lặp y câu vừa hỏi (không dấu hỏi) trong 10 phút sau mẫu thông tin không phải bảng giá → _INFO + thẻ.
  const repeat = await run({ botLastTemplateId: 'INGREDIENTS_ALLERGY', botLastReplyAt: now() - 60000 }, 'tui xanh co yen mach ko', {
    reply: llmReply('INGREDIENTS_ALLERGY'), extraSettings: { preGuard: 'on' },
    recent: [incoming('Túi xanh có yến mạch ko', 2 * 60000), outgoing(templates.INGREDIENTS_ALLERGY, 60000)]
  });
  assert.equal(repeat.asked.length, 0);
  assert.equal(repeat.results[0].templateId, 'REPLY_ALREADY_SENT_INFO');
  assert.ok(repeat.saved.at(-1).addLabelEvents.includes('handoff'), 'gắn thẻ cho nhân viên giải thích thêm');
  assert.equal(repeat.records[0].guards.preGuard.reason, 'repeat');
});

test('3c. không gác: tin có ý mới / có dấu hỏi ở câu trước / bot vừa nhắc rồi / bot đang xin SĐT / có SĐT / bình luận', async () => {
  const cases = [
    [{ botLastTemplateId: 'PRICE_QUOTE', botLastReplyAt: now() - 60000 }, 'túi xanh có yến mạch không?', {}],
    [{ botLastTemplateId: 'PRICE_QUOTE', botLastReplyAt: now() - 60000 }, 'gia sao', { recent: [incoming('giá sao?', 2 * 60000), outgoing('Bảng giá', 60000)] }],
    [{ botLastTemplateId: 'REPLY_ALREADY_SENT', botLastReplyAt: now() - 60000 }, 'alo', {}],
    [{ botLastTemplateId: 'ORDER_ADDRESS', botLastReplyAt: now() - 60000, pendingOrder: { items: [{ product: 'Granola Túi Xanh 450g', code: 'GRA-XANH-Z450', quantity: 1 }], key: 'k', at: now() - 60000, phone: '', address: '', addressAsks: 0 } }, 'shop ơi', {}],
    [{ botLastTemplateId: 'PRICE_QUOTE', botLastReplyAt: now() - 60000 }, 'alo 0385805790', {}]
  ];
  for (const [conversation, text, options] of cases) {
    const flow = await run(conversation, text, { reply: llmReply('GENERAL_INFO'), extraSettings: { preGuard: 'on' }, ...options });
    assert.equal(flow.records[0]?.guards.preGuard ?? null, null, `không gác: "${text}" sau ${conversation.botLastTemplateId}`);
    assert.notEqual(flow.results[0].templateId, 'REPLY_ALREADY_SENT', text);
  }
  const comment = await run({ id: 'page:post:comment:2', source: 'comment', botLastTemplateId: 'PRICE_QUOTE', botLastReplyAt: now() - 60000 }, 'shop ơi', {
    reply: llmReply('GENERAL_INFO'), extraSettings: { preGuard: 'on' }, extraDeps: { getConversation: async () => null }
  });
  assert.equal(comment.records[0].guards.preGuard, null);
  const off = await run({ botLastTemplateId: 'PRICE_QUOTE', botLastReplyAt: now() - 60000 }, '???', { reply: llmReply('GENERAL_INFO'), extraSettings: { preGuard: 'off' } });
  assert.equal(off.records[0].guards.preGuard, null);
  assert.equal(off.asked.length, 1);
});

// ===== 4. Người gác chỉ ghi =====

test('4. gateCheck: nhóm tương đương, ưu tiên luật rồi top-1, top-K; không có gì để so → null', () => {
  assert.equal(templateGroup('ORDER_ADDRESS_REMIND'), templateGroup('ORDER_ADDRESS'));
  assert.ok(sameTemplateGroup('PRICE_QUOTE', 'GENERAL_INFO'));
  assert.ok(sameTemplateGroup('PRICE_MIX_TUI_LON', 'PRICE_QUOTE_COMBO'));
  assert.ok(sameTemplateGroup('PRICE_GRANOLA_TUI_XANH', 'PRICE_QUOTE'), 'bảng giá theo sản phẩm thuộc nhóm bảng giá');
  assert.ok(!sameTemplateGroup('PRICE_ADJUSTMENT', 'PRICE_QUOTE'));
  assert.ok(sameTemplateGroup('THANK_YOU', 'REPLY_ALREADY_SENT_INFO'));
  assert.ok(!sameTemplateGroup('THANK_YOU', 'GENERAL_INFO'));
  assert.ok(!sameTemplateGroup('', ''));
  assert.deepEqual(gateCheck({ llmTemplateId: 'ORDER_ADDRESS_PARTIAL', intentTopK: [{ templateId: 'GENERAL_INFO', p: 0.6 }], ruleTemplateId: 'ORDER_ADDRESS' }), { agree: true, reason: 'rule' });
  assert.deepEqual(gateCheck({ llmTemplateId: 'GENERAL_INFO', intentTopK: [{ templateId: 'PRICE_QUOTE', p: 0.8 }, { templateId: 'BAG_COMPARISON', p: 0.1 }] }), { agree: true, reason: 'intent-top1' });
  assert.deepEqual(gateCheck({ llmTemplateId: 'BAG_COMPARISON', intentTopK: ['PRICE_QUOTE', 'BAG_COMPARISON'] }), { agree: true, reason: 'intent-topk' });
  assert.deepEqual(gateCheck({ llmTemplateId: 'THANK_YOU', intentTopK: [{ templateId: 'PRICE_QUOTE', p: 0.9 }] }), { agree: false, reason: 'intent-mismatch' });
  assert.deepEqual(gateCheck({ llmTemplateId: 'THANK_YOU', intentTopK: [{ templateId: 'PRICE_QUOTE', p: 0.9 }], ruleTemplateId: 'ORDER_ADDRESS' }), { agree: false, reason: 'rule-mismatch' });
  assert.deepEqual(gateCheck({ llmTemplateId: 'THANK_YOU' }), { agree: null, reason: 'no-reference' });
  assert.deepEqual(gateCheck({ llmTemplateId: '', intentTopK: ['PRICE_QUOTE'] }), { agree: null, reason: 'no-llm' });
});

test('4b. engine ghi guards.gate sau khi có LLM (so với top-K mô hình nhỏ / luật), không đổi câu trả lời', async () => {
  const flow = await run({ botLastTemplateId: 'WELCOME', botLastReplyAt: now() - 60000 }, 'cho mình hỏi túi xanh với túi vàng khác gì nhau vậy shop', {
    reply: llmReply('BAG_COMPARISON_XANH_VANG'), extraSettings: { intentModel: 'shadow', preGuard: 'off' }
  });
  assert.equal(flow.results[0].templateId, 'BAG_COMPARISON_XANH_VANG');
  const gate = flow.records[0].guards.gate;
  assert.ok(gate && typeof gate.reason === 'string' && ['boolean', 'object'].includes(typeof gate.agree));
  const noLlm = await run({ botLastTemplateId: 'ORDER_CONFIRMATION', botLastReplyAt: now() - 60000 }, 'ok', { reply: llmReply('GENERAL_INFO') });
  assert.equal(noLlm.asked.length, 0);
  assert.equal(noLlm.records[0].guards.gate, null, 'không gọi LLM thì không có gate');
  assert.equal(noLlm.records[0].chosen, 'THANK_YOU');
});
