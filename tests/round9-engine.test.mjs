import assert from 'node:assert/strict';
import test from 'node:test';
import './helpers/seed-catalog.mjs';
import { bagCountInText, buildDecisionRecord, canaryBucket, cascadeMatchMark, cascadeTrace, composeSystemPrompt, gateCheckWithCascade, intentTopK, modelTemplateChoices, prevBotAsks, processChatbotChanges, requestDirectModelReply, responseSchemaFor, withFallbackTemplates } from '../app/chatbot-engine.mjs';
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
  assert.deepEqual(Object.keys(row), ['v', 'at', 'conversationId', 'source', 'mid', 'text', 'type', 'prevBot', 'lastTemplate', 'prevBotAgeMin', 'prevBotAsks', 'ctx', 'rule', 'shadow', 'intent', 'cascade', 'llm', 'fewShot', 'chosen', 'final', 'also', 'skipped', 'guards', 'attention', 'handoff', 'ms']);
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

// ===== 5. Mô hình tầng (intentCascade: shadow | on | off) — dependencies.predictCascade giả =====
const groupOfFake = id => (/^(PRICE_|GENERAL_INFO|DISCOUNT_POLICY|FREESHIP_POLICY)/.test(id) ? 'PRICE' : /^ORDER_/.test(id) ? 'ORDER' : /^(THANK_YOU|WELCOME)$/.test(id) ? 'SOCIAL' : 'INFO');
const cascadeOf = (group, templateId, extra = {}) => ({ group, pGroup: 0.97, groupTopK: [{ group, p: 0.97 }], templateId, p: 0.93, margin: 0.6, topK: [{ templateId, p: 0.93 }, { templateId: 'GENERAL_INFO', p: 0.33 }], path: `${group}>${templateId}`, ...extra });
const captureLogs = async fn => {
  const logs = [];
  const original = console.log;
  console.log = (...args) => { logs.push(args.join(' ')); };
  try { return { out: await fn(), logs }; } finally { console.log = original; }
};

test('5a. cài đặt intentCascade mặc định shadow; shadow: nhật ký ghi cascade sau intent + log "Mô hình tầng (thử)", vẫn gọi LLM, không đổi trả lời', async () => {
  assert.equal(normalizeChatbotSettings({ enabled: true }).intentCascade, 'shadow');
  assert.equal(normalizeChatbotSettings({ enabled: true, intentCascade: 'on' }).intentCascade, 'on');
  assert.equal(normalizeChatbotSettings({ enabled: true, intentCascade: 'lạ' }).intentCascade, 'shadow');
  const seen = [];
  const { out: flow, logs } = await captureLogs(() => run({ botLastTemplateId: 'WELCOME', botLastReplyAt: now() - 60000 }, 'cho mình hỏi túi xanh với túi vàng khác gì nhau vậy shop', {
    reply: llmReply('BAG_COMPARISON_XANH_VANG'),
    extraSettings: { intentModel: 'off', preGuard: 'off', ruleIntent: 'off' },
    extraDeps: { predictCascade: row => { seen.push(row); return cascadeOf('INFO', 'BAG_COMPARISON_XANH_VANG'); }, cascadeGroupOf: groupOfFake }
  }));
  assert.equal(seen.length, 1, 'gọi mô hình tầng đúng một lần');
  assert.deepEqual(Object.keys(seen[0]), ['text', 'source', 'lastTemplate', 'lastWasOrderStep', 'hasBasket', 'livestream', 'hasOrder', 'hasRecentOrder', 'orderAgeMin', 'prevBotAsks', 'phoneInText', 'addressInText', 'bagCount', 'staffRepliedAfterBot'], 'cùng row với predictIntent, kèm các trường của decisionContext');
  assert.deepEqual([seen[0].hasOrder, seen[0].hasRecentOrder, seen[0].orderAgeMin, seen[0].prevBotAsks, seen[0].phoneInText, seen[0].addressInText, seen[0].bagCount, seen[0].staffRepliedAfterBot], [false, false, null, '', false, false, 0, false]);
  assert.equal(flow.asked.length, 1, 'shadow vẫn hỏi LLM');
  assert.equal(flow.results[0].templateId, 'BAG_COMPARISON_XANH_VANG');
  const row = flow.records[0];
  const keys = Object.keys(row);
  assert.equal(keys[keys.indexOf('intent') + 1], 'cascade', 'cascade ngay sau intent');
  assert.equal(row.intent, null, 'intentModel off → không có mô hình phẳng');
  assert.deepEqual(row.cascade, { group: 'INFO', subGroup: null, pGroup: 0.97, templateId: 'BAG_COMPARISON_XANH_VANG', p: 0.93, margin: 0.6, pWithin: null, marginWithin: null, topK: [{ templateId: 'BAG_COMPARISON_XANH_VANG', p: 0.93 }, { templateId: 'GENERAL_INFO', p: 0.33 }], path: 'INFO>BAG_COMPARISON_XANH_VANG', canary: null }, 'shadow: canary null; mô-đun cũ không có pWithin/subGroup → null');
  assert.deepEqual(row.guards.gate, { agree: true, reason: 'cascade-top1' }, 'người gác lấy top-K tầng làm tham chiếu khi không có luật/mô hình phẳng');
  const line = logs.find(item => item.startsWith('Mô hình tầng (thử):'));
  assert.equal(line, 'Mô hình tầng (thử): INFO 0.97 / BAG_COMPARISON_XANH_VANG 0.93 (biên 0.60) / thật BAG_COMPARISON_XANH_VANG ✓ (page:user)');
  // Chỉ đúng nhóm: dấu "nhóm✓"; khác nhóm: ✗; "đã gửi ở trên": ~.
  assert.equal(cascadeMatchMark(cascadeOf('PRICE', 'PRICE_QUOTE'), 'DISCOUNT_POLICY', groupOfFake), 'nhóm✓');
  assert.equal(cascadeMatchMark(cascadeOf('PRICE', 'PRICE_QUOTE'), 'ORDER_ADDRESS', groupOfFake), '✗');
  assert.equal(cascadeMatchMark(cascadeOf('PRICE', 'PRICE_QUOTE'), 'DISCOUNT_POLICY'), '✗', 'không có groupOf thì không kết luận được nhóm');
  assert.equal(cascadeMatchMark(cascadeOf('PRICE', 'PRICE_QUOTE'), 'REPLY_ALREADY_SENT', groupOfFake), '~');
  assert.equal(cascadeMatchMark(cascadeOf('ORDER', 'ORDER_ADDRESS'), 'ORDER_ADDRESS_REMIND', groupOfFake), '✓');
  // Tắt: không gọi mô hình tầng, cascade null.
  const off = await run({ botLastTemplateId: 'WELCOME', botLastReplyAt: now() - 60000 }, 'túi xanh với túi vàng khác gì nhau', {
    reply: llmReply('BAG_COMPARISON_XANH_VANG'), extraSettings: { intentCascade: 'off', intentModel: 'off', preGuard: 'off', ruleIntent: 'off' },
    extraDeps: { predictCascade: () => { throw new Error('không được gọi'); } }
  });
  assert.equal(off.records[0].cascade, null);
});

test('5b. on + chắc + nhóm INFO/PRICE + mẫu an toàn → trả mẫu tầng, KHÔNG gọi LLM; log không có "(thử)"; PRICE_QUOTE lấy sản phẩm ngữ cảnh', async () => {
  const { out: flow, logs } = await captureLogs(() => run({ botLastTemplateId: 'WELCOME', botLastReplyAt: now() - 60000 }, 'cho mình hỏi túi xanh với túi vàng khác gì nhau vậy shop', {
    reply: () => { throw new Error('không được gọi LLM'); },
    extraSettings: { intentCascade: 'on', intentModel: 'off', preGuard: 'off', ruleIntent: 'off' },
    extraDeps: { predictCascade: () => cascadeOf('INFO', 'BAG_COMPARISON_XANH_VANG'), cascadeGroupOf: groupOfFake }
  }));
  assert.equal(flow.asked.length, 0);
  assert.equal(flow.results[0].templateId, 'BAG_COMPARISON_XANH_VANG');
  assert.equal(flow.sent[0], render('BAG_COMPARISON_XANH_VANG').messages[0]);
  assert.equal(flow.records[0].llm, null);
  assert.equal(flow.records[0].chosen, 'BAG_COMPARISON_XANH_VANG');
  assert.ok(logs.some(item => item.startsWith('Mô hình tầng: INFO 0.97 / BAG_COMPARISON_XANH_VANG 0.93')), logs.join(' | '));
  const price = await run({ botLastTemplateId: 'WELCOME', botLastReplyAt: now() - 60000, referral: { adTitle: 'Granola Túi Xanh 450g' } }, 'giá sao shop', {
    reply: () => { throw new Error('không được gọi LLM'); },
    extraSettings: { intentCascade: 'on', intentModel: 'off', preGuard: 'off', ruleIntent: 'off' },
    extraDeps: { predictCascade: () => cascadeOf('PRICE', 'PRICE_QUOTE') }
  });
  assert.equal(price.asked.length, 0);
  assert.equal(price.results[0].templateId, 'PRICE_QUOTE');
  assert.equal(price.sent[0], render('PRICE_QUOTE', { Product_N1: 'Granola Túi Xanh 450g' }).messages[0], 'PRICE_QUOTE điền sản phẩm từ quảng cáo như mô hình phẳng');
});

test('5c. on nhưng nhóm ORDER / SUPPORT chắc, hay p thấp / biên mỏng / mẫu không an toàn / có SĐT → rơi về mô hình phẳng rồi LLM', async () => {
  const llmOnly = async (cascade, text = 'cho mình hỏi túi xanh với túi vàng khác gì nhau vậy shop', extra = {}) => run({ botLastTemplateId: 'WELCOME', botLastReplyAt: now() - 60000 }, text, {
    reply: llmReply('BAG_COMPARISON_XANH_VANG'),
    extraSettings: { intentCascade: 'on', intentModel: 'off', preGuard: 'off', ruleIntent: 'off', ...extra },
    extraDeps: { predictCascade: () => cascade, cascadeGroupOf: groupOfFake }
  });
  for (const [label, cascade, text] of [
    ['nhóm ORDER', cascadeOf('ORDER', 'ORDER_ADDRESS')],
    ['nhóm SUPPORT', cascadeOf('SUPPORT', 'CSKH_HANDOFF')],
    ['nhóm OTHER', cascadeOf('OTHER', 'THANK_YOU')],
    ['p thấp (dưới cascadeThreshold 0,8)', cascadeOf('INFO', 'BAG_COMPARISON_XANH_VANG', { p: 0.79 })],
    ['pWithin thấp dù p cao', cascadeOf('INFO', 'BAG_COMPARISON_XANH_VANG', { pWithin: 0.7, marginWithin: 0.5 })],
    ['pGroup dưới 0,85', cascadeOf('INFO', 'BAG_COMPARISON_XANH_VANG', { pGroup: 0.84 })],
    ['biên mỏng', cascadeOf('INFO', 'BAG_COMPARISON_XANH_VANG', { margin: 0.2 })],
    ['marginWithin mỏng dù margin dày', cascadeOf('INFO', 'BAG_COMPARISON_XANH_VANG', { pWithin: 0.95, marginWithin: 0.2 })],
    ['mẫu không an toàn', cascadeOf('INFO', 'ORDER_CONFIRMATION')],
    ['có SĐT', cascadeOf('INFO', 'BAG_COMPARISON_XANH_VANG'), 'túi xanh với túi vàng khác gì nhau 0909123456'],
    ['mô-đun trả null', null]
  ]) {
    const flow = await llmOnly(cascade, text);
    assert.equal(flow.asked.length, 1, `${label}: phải gọi LLM`);
    assert.equal(flow.results[0].templateId, 'BAG_COMPARISON_XANH_VANG', label);
    if (cascade) assert.equal(flow.records[0].cascade.group, cascade.group, label);
    else assert.equal(flow.records[0].cascade, null, label);
  }
  // Chắc mà nhóm ORDER: người gác vẫn ghi lệch tầng (không có luật/mô hình phẳng để so).
  const order = await llmOnly(cascadeOf('ORDER', 'ORDER_ADDRESS'));
  assert.deepEqual(order.records[0].guards.gate, { agree: false, reason: 'cascade-mismatch' });
  // Không đủ chắc ở tầng → mô hình phẳng 'on' vẫn được dùng như trước (ngưỡng hạ để mô hình thật chắc chắn).
  const flat = await run({ botLastTemplateId: 'WELCOME', botLastReplyAt: now() - 60000 }, 'giá bao nhiêu vậy shop', {
    reply: () => { throw new Error('không được gọi LLM'); },
    extraSettings: { intentCascade: 'on', intentModel: 'on', intentThreshold: 0.5, preGuard: 'off', ruleIntent: 'off' },
    extraDeps: { predictCascade: () => cascadeOf('ORDER', 'ORDER_ADDRESS') }
  });
  assert.equal(flat.asked.length, 0);
  assert.ok(['GENERAL_INFO', 'PRICE_QUOTE'].includes(flat.results[0].templateId), flat.results[0].templateId);
  assert.equal(flat.records[0].cascade.group, 'ORDER');
});

test('5d. mô-đun tầng lỗi / thiếu → engine không lỗi; gateCheckWithCascade; cascadeTrace làm tròn và bỏ phần tử rỗng', async () => {
  const thrown = await run({ botLastTemplateId: 'WELCOME', botLastReplyAt: now() - 60000 }, 'túi xanh với túi vàng khác gì nhau', {
    reply: llmReply('BAG_COMPARISON_XANH_VANG'), extraSettings: { intentCascade: 'on', intentModel: 'off', preGuard: 'off', ruleIntent: 'off' },
    extraDeps: { predictCascade: () => { throw new Error('mô hình hỏng'); } }
  });
  assert.equal(thrown.results[0].templateId, 'BAG_COMPARISON_XANH_VANG');
  assert.equal(thrown.records[0].cascade, null);
  // Không đưa predictCascade: engine tự nạp app/processing/intent-cascade.mjs; thiếu tệp / lỗi nạp → như không có.
  const real = await run({ botLastTemplateId: 'WELCOME', botLastReplyAt: now() - 60000 }, 'túi xanh với túi vàng khác gì nhau', {
    reply: llmReply('BAG_COMPARISON_XANH_VANG'), extraSettings: { intentCascade: 'shadow', intentModel: 'off', preGuard: 'off', ruleIntent: 'off' }
  });
  assert.equal(real.results[0].templateId, 'BAG_COMPARISON_XANH_VANG');
  assert.ok(real.records[0].cascade === null || typeof real.records[0].cascade.group === 'string');
  // Người gác gộp: luật / mô hình phẳng thắng trước; tầng bổ sung reason cascade-*; chỉ tầng mà lệch → cascade-mismatch.
  assert.deepEqual(gateCheckWithCascade({ llmTemplateId: 'PRICE_QUOTE', intentTopK: [{ templateId: 'GENERAL_INFO', p: 0.9 }], cascadeTopK: [{ templateId: 'THANK_YOU', p: 0.9 }] }), { agree: true, reason: 'intent-top1' });
  assert.deepEqual(gateCheckWithCascade({ llmTemplateId: 'PRICE_QUOTE', intentTopK: [{ templateId: 'THANK_YOU', p: 0.9 }], cascadeTopK: [{ templateId: 'GENERAL_INFO', p: 0.9 }] }), { agree: true, reason: 'cascade-top1' });
  assert.deepEqual(gateCheckWithCascade({ llmTemplateId: 'PRICE_QUOTE', cascadeTopK: [{ templateId: 'THANK_YOU', p: 0.6 }, { templateId: 'PRICE_MIX_TUI_LON', p: 0.3 }] }), { agree: true, reason: 'cascade-topk' });
  assert.deepEqual(gateCheckWithCascade({ llmTemplateId: 'PRICE_QUOTE', cascadeTopK: [{ templateId: 'THANK_YOU', p: 0.9 }] }), { agree: false, reason: 'cascade-mismatch' });
  assert.deepEqual(gateCheckWithCascade({ llmTemplateId: 'PRICE_QUOTE', intentTopK: [{ templateId: 'THANK_YOU', p: 0.9 }], cascadeTopK: [{ templateId: 'WELCOME', p: 0.9 }] }), { agree: false, reason: 'intent-mismatch' });
  assert.deepEqual(gateCheckWithCascade({ llmTemplateId: 'PRICE_QUOTE', ruleTemplateId: 'GENERAL_INFO', cascadeTopK: [{ templateId: 'THANK_YOU', p: 0.9 }] }), { agree: true, reason: 'rule' });
  assert.deepEqual(gateCheckWithCascade({ llmTemplateId: '', cascadeTopK: [{ templateId: 'THANK_YOU', p: 0.9 }] }), { agree: null, reason: 'no-llm' });
  assert.deepEqual(cascadeTrace({ group: 'PRICE', pGroup: 0.987, templateId: 'PRICE_QUOTE', p: 0.9123, margin: 0.456, topK: [{ templateId: 'PRICE_QUOTE', p: 0.9123 }, { templateId: '' }], path: ['PRICE', 'PRICE_QUOTE'] }),
    { group: 'PRICE', subGroup: null, pGroup: 0.99, templateId: 'PRICE_QUOTE', p: 0.91, margin: 0.46, pWithin: null, marginWithin: null, topK: [{ templateId: 'PRICE_QUOTE', p: 0.91 }], path: ['PRICE', 'PRICE_QUOTE'] });
  assert.equal(cascadeTrace(null), null);
});

test('5e. rào cứng khi on (màu/số túi, khiếu nại, đơn gần đây + SHIPPING_POLICY/WELCOME/DELIVERY_DELAY, WELCOME loại hẳn), pWithin/subGroup/ANSWER, cascadeThreshold, canary', async () => {
  assert.deepEqual([normalizeChatbotSettings({ enabled: true }).cascadeThreshold, normalizeChatbotSettings({ enabled: true }).cascadeCanary], [0.8, 100]);
  assert.deepEqual([normalizeChatbotSettings({ enabled: true, cascadeThreshold: 0.3, cascadeCanary: 250 }).cascadeThreshold, normalizeChatbotSettings({ enabled: true, cascadeThreshold: 0.3, cascadeCanary: 250 }).cascadeCanary], [0.5, 100]);
  assert.equal(normalizeChatbotSettings({ enabled: true, cascadeCanary: 0 }).cascadeCanary, 0);
  const on = (conversation, text, cascade, extra = {}, reply = llmReply('BAG_COMPARISON_XANH_VANG')) => run({ botLastTemplateId: 'GENERAL_INFO', botLastReplyAt: now() - 60000, ...conversation }, text, {
    reply, extraSettings: { intentCascade: 'on', intentModel: 'off', preGuard: 'off', ruleIntent: 'off', ...extra },
    extraDeps: { predictCascade: () => cascade, cascadeGroupOf: groupOfFake }
  });
  const answer = (templateId, extra = {}) => cascadeOf('ANSWER', templateId, { subGroup: 'INFO', pWithin: 0.9, marginWithin: 0.5, ...extra });
  // Nhóm ANSWER (tầng 1 bản mới) + subGroup: tự trả lời, nhật ký ghi subGroup/pWithin/canary true.
  const ok = await on({}, 'túi xanh với túi vàng khác gì nhau vậy shop', answer('BAG_COMPARISON_XANH_VANG'), {}, () => { throw new Error('không được gọi LLM'); });
  assert.equal(ok.results[0].templateId, 'BAG_COMPARISON_XANH_VANG');
  assert.deepEqual([ok.records[0].cascade.subGroup, ok.records[0].cascade.pWithin, ok.records[0].cascade.marginWithin, ok.records[0].cascade.canary], ['INFO', 0.9, 0.5, true]);
  // pWithin đủ nhưng p (tích) thấp: vẫn trả lời — ngưỡng KHÔNG áp lên tích.
  const product = await on({}, 'túi xanh với túi vàng khác gì nhau vậy shop', answer('BAG_COMPARISON_XANH_VANG', { p: 0.6, margin: 0.1 }), {}, () => { throw new Error('không được gọi LLM'); });
  assert.equal(product.asked.length, 0);
  // cascadeThreshold cài đặt: nâng lên 0,95 thì pWithin 0,9 không đủ → LLM.
  const strict = await on({}, 'túi xanh với túi vàng khác gì nhau vậy shop', answer('BAG_COMPARISON_XANH_VANG'), { cascadeThreshold: 0.95 });
  assert.equal(strict.asked.length, 1);
  // Rào cứng: có số túi / màu + số / khiếu nại (chữ hay nhãn) / đơn gần đây + mẫu chung / WELCOME.
  const recentOrder = { id: 'o1', createdAt: now() - 2 * 60 * 60 * 1000, phone: '0909123456', address: '12 Lê Lợi, Phường Bến Nghé, Quận 1, TP Hồ Chí Minh', products: [{ name: 'Granola Túi Xanh 450g', sku: 'GRA-XANH-Z450', quantity: 2 }] };
  for (const [label, conversation, text, cascade, extra] of [
    ['có số túi', {}, '2 túi xanh với túi vàng khác gì nhau', answer('BAG_COMPARISON_XANH_VANG')],
    ['màu + số', {}, 'xanh 3 nhé khác gì vàng', answer('BAG_COMPARISON_XANH_VANG')],
    ['khiếu nại trong chữ', {}, 'túi bị hư mốc rồi shop ơi khác gì nhau', answer('BAG_COMPARISON_XANH_VANG'), { complaintKeywords: 'bị hư' }],
    ['nhãn khiếu nại', { labels: ['complaint'] }, 'túi xanh với túi vàng khác gì nhau vậy shop', answer('BAG_COMPARISON_XANH_VANG')],
    ['đơn gần đây + SHIPPING_POLICY', { customerOrders: [recentOrder] }, 'ship mất bao lâu vậy shop', answer('SHIPPING_POLICY')],
    ['WELCOME loại hẳn', {}, 'chào shop', answer('WELCOME', { subGroup: 'SOCIAL' })]
  ]) {
    const flow = await on(conversation, text, cascade, extra);
    assert.equal(flow.asked.length, 1, `${label}: phải gọi LLM`);
    assert.equal(flow.records[0].cascade.templateId, cascade.templateId, `${label}: vẫn ghi nhật ký`);
  }
  // Không có đơn gần đây thì SHIPPING_POLICY vẫn tự trả lời được.
  const ship = await on({}, 'ship mất bao lâu vậy shop', answer('SHIPPING_POLICY'), {}, () => { throw new Error('không được gọi LLM'); });
  assert.equal(ship.results[0].templateId, 'SHIPPING_POLICY');
  // Canary 0: mọi hội thoại ngoài canary → chạy như shadow (gọi LLM), nhật ký cascade.canary false; canary 100 → true.
  const outside = await on({}, 'túi xanh với túi vàng khác gì nhau vậy shop', answer('BAG_COMPARISON_XANH_VANG'), { cascadeCanary: 0 });
  assert.equal(outside.asked.length, 1);
  assert.equal(outside.records[0].cascade.canary, false);
  assert.ok(canaryBucket('page:user') >= 0 && canaryBucket('page:user') < 100 && canaryBucket('page:user') === canaryBucket('page:user'));
  const inside = await on({}, 'túi xanh với túi vàng khác gì nhau vậy shop', answer('BAG_COMPARISON_XANH_VANG'), { cascadeCanary: canaryBucket('page:user') + 1 }, () => { throw new Error('không được gọi LLM'); });
  assert.equal(inside.records[0].cascade.canary, true);
  const edge = await on({}, 'túi xanh với túi vàng khác gì nhau vậy shop', answer('BAG_COMPARISON_XANH_VANG'), { cascadeCanary: canaryBucket('page:user') });
  assert.equal(edge.asked.length, 1, 'hash == canary → ngoài (điều kiện <)');
});
