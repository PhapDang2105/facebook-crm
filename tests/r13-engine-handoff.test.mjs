// Vòng 13 (02/10) — việc các agent khác chuyển cho engine: cờ luật ứng viên K (candidateRules), setQuantity, hoãn đơn giữ giỏ
// (keepBasket → postponed), shopCart, luồng dùng thử dùng luật đơn, "có mấy loại" gõ lỗi khi giữ giỏ, gợi ý phường AI.
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const directory = mkdtempSync(path.join(os.tmpdir(), 'crm-r13-engine-handoff-'));
process.env.ADDRESS_AI_CACHE_PATH = path.join(directory, 'address-ai-cache.json');
process.on('exit', () => rmSync(directory, { recursive: true, force: true }));

const { Sim, PHONE, XANH, VANG, basket, seedTemplates } = await import('./helpers/r13-engine-sim.mjs');
const { asksFlavourList, refineAddressWithAi } = await import('../app/chatbot-engine.mjs');
const { normalizeChatbotSettings } = await import('../app/chatbot-settings.mjs');
const { resetAddressAiCache } = await import('../app/processing/address-ai.mjs');
const followUp = await import('../app/follow-up.mjs');

const MIN = 60 * 1000;
const ADDRESS = '12 Nguyễn Trãi, phường Bến Thành, Quận 1, TP HCM';

test('luật ứng viên K (candidateRules): mặc định "shadow" chỉ ghi nhật ký (candidateRule), KHÔNG trả lời; "on" mới trả lời', async () => {
  assert.equal(normalizeChatbotSettings({}).candidateRules, 'shadow');
  assert.equal(normalizeChatbotSettings({ candidateRules: 'on' }).candidateRules, 'on');
  assert.equal(normalizeChatbotSettings({ candidateRules: 'bật' }).candidateRules, 'shadow');
  // experimentalRules đang 'on' (như máy chủ) nhưng candidateRules không ghi → K4 "Mua hàng" KHÔNG tự trả lời.
  const shadow = new Sim({ settings: { experimentalRules: 'on' } });
  const shadowTurn = await shadow.send(shadow.inbox(), 'Mua hàng', { llm: { template_id: 'WELCOME' } });
  assert.equal(shadowTurn.asked.length, 1, 'vẫn hỏi mô hình');
  assert.equal(shadowTurn.record.rule, null);
  assert.deepEqual(shadowTurn.record.candidateRule, { name: 'K4_WANT_BUY', templateId: 'GENERAL_INFO', mode: 'shadow' });
  assert.equal(shadowTurn.record.chosen, 'WELCOME');
  // Bật: luật trả lời, không gọi mô hình.
  const on = new Sim({ settings: { experimentalRules: 'on', candidateRules: 'on' } });
  const onTurn = await on.send(on.inbox(), 'Mua hàng', { llm: () => { throw new Error('luật K4 đã bật: không hỏi mô hình'); } });
  assert.equal(onTurn.asked.length, 0);
  assert.equal(onTurn.record.rule.name, 'K4_WANT_BUY');
  assert.equal(onTurn.record.candidateRule.mode, 'on');
  assert.ok(['GENERAL_INFO', 'PRICE_QUOTE'].includes(onTurn.result.templateId), JSON.stringify(onTurn.result));
  // Tắt hẳn: không có dấu vết luật ứng viên.
  const off = new Sim({ settings: { experimentalRules: 'on', candidateRules: 'off' } });
  const offTurn = await off.send(off.inbox(), 'Mua hàng', { llm: { template_id: 'WELCOME' } });
  assert.equal(offTurn.record.candidateRule, undefined);
});

test('K3 "Lấy 2 túi" khi đang giữ giỏ MỘT mã: "on" → đổi số lượng đúng mã đang giữ (setQuantity); "shadow" → để mô hình; giỏ hai mã → luật không bắt', async () => {
  const held = () => ({ botLastTemplateId: 'ORDER_ADDRESS', botLastReplyAt: Date.now() - MIN, pendingOrder: basket([XANH(1)], MIN) });
  const on = new Sim({ settings: { candidateRules: 'on' } });
  const onInbox = on.inbox(held());
  on.history(onInbox, 'outgoing', 'Dạ chị cho em xin số điện thoại và địa chỉ nha ạ.', MIN, { sender: 'bot' });
  const turn = await on.send(onInbox, 'Lấy 2 túi', { llm: () => { throw new Error('K3 bật: không hỏi mô hình'); } });
  assert.equal(turn.record.candidateRule.name, 'K3_QTY_HELD');
  assert.equal(turn.record.candidateRule.setQuantity, 2);
  assert.deepEqual(onInbox.pendingOrder.items.map(item => `${item.quantity} ${item.code}`), ['2 GRA-XANH-Z450']);
  const shadow = new Sim();
  const shadowInbox = shadow.inbox(held());
  const shadowTurn = await shadow.send(shadowInbox, 'Lấy 2 túi', { llm: { template_id: 'ORDER_ADDRESS', Product_N1: 'Granola Túi Xanh 450g', No_A: '2' } });
  assert.equal(shadowTurn.asked.length, 1);
  assert.equal(shadowTurn.record.candidateRule.mode, 'shadow');
  // Engine truyền đủ ngữ cảnh cho luật: cờ, số mã trong giỏ, giỏ Shop chưa thành giỏ chờ.
  const seen = [];
  const spy = { ruleIntent: (text, ctx) => { seen.push(ctx); return null; } };
  const two = new Sim();
  const twoInbox = two.inbox({ botLastTemplateId: 'ORDER_ADDRESS', botLastReplyAt: Date.now() - MIN, pendingOrder: basket([XANH(1), VANG(1)], MIN) });
  await two.send(twoInbox, 'Lấy 2 túi', { llm: { template_id: 'GENERAL_INFO' }, extra: spy });
  assert.equal(seen.at(-1).candidateRules, 'shadow');
  assert.equal(seen.at(-1).basketCodeCount, 2);
  assert.equal(seen.at(-1).shopCart, false);
  const cart = new Sim();
  const cartInbox = cart.inbox({ botLastTemplateId: 'SHOP_CART_STAFF', botLastReplyAt: Date.now() - MIN });
  cart.history(cartInbox, 'incoming', 'Khách chọn mua từ Facebook Shop: Yến mạch (CB2-HT-YM-T500) — 131.000đ', 2 * MIN, { cart: [{ sku: 'CB2-HT-YM-T500', quantity: 1 }] });
  cart.history(cartInbox, 'outgoing', 'Dạ em đã ghi nhận chị chọn Yến Mạch trên Facebook Shop ạ', 2 * MIN - 1000, { sender: 'bot' });
  await cart.send(cartInbox, 'chị bấm nhầm thôi em', { llm: { template_id: 'THANK_YOU' }, extra: spy });
  assert.equal(seen.at(-1).shopCart, true, 'giỏ Shop vừa bấm, chưa thành giỏ chờ');
  assert.equal(seen.at(-1).basketCodeCount, 0);
});

test('hoãn đơn "thôi để bữa khác chốt nha": GIỮ giỏ + cờ postponed, bám đuổi không nhắc giỏ; khách gửi SĐT/địa chỉ sau đó chốt bình thường', async () => {
  const sim = new Sim();
  const inbox = sim.inbox({ botLastTemplateId: 'ORDER_ADDRESS', botLastReplyAt: Date.now() - MIN, pendingOrder: basket([XANH(2)], MIN) });
  sim.history(inbox, 'outgoing', 'Dạ chị cho em xin số điện thoại và địa chỉ nha ạ.', MIN, { sender: 'bot' });
  const later = await sim.send(inbox, 'thôi để bữa khác chốt nha', { llm: () => { throw new Error('luật ORDER_POSTPONED đã bắt'); } });
  assert.equal(later.result.templateId, 'ORDER_POSTPONED');
  assert.equal(inbox.pendingOrder.postponed, true);
  assert.deepEqual(inbox.pendingOrder.items.map(item => `${item.quantity} ${item.code}`), ['2 GRA-XANH-Z450'], 'giỏ còn nguyên');
  assert.equal(followUp.orderRemindText(inbox, seedTemplates, { now: Date.now() + 4 * 60 * MIN }), '', 'không nhắc "em vẫn đang giữ đơn"');
  // Cùng giỏ không có cờ hoãn thì vẫn được nhắc.
  assert.match(followUp.orderRemindText({ ...inbox, pendingOrder: { ...inbox.pendingOrder, postponed: undefined } }, seedTemplates, { now: Date.now() + 4 * 60 * MIN }), /vẫn đang giữ đơn/);
  // Khách quay lại gửi SĐT + địa chỉ: lên đơn với giỏ đã giữ, không hỏi lại vị.
  const closed = await sim.send(inbox, `${PHONE} ${ADDRESS}`, { llm: { template_id: 'ORDER_CONFIRMATION', Phone_Number: PHONE, Customer_Address: ADDRESS } });
  assert.equal(closed.created.length, 1, JSON.stringify(closed.result));
  assert.deepEqual(closed.created[0].items.map(item => `${item.quantity} ${item.code}`), ['2 GRA-XANH-Z450']);
  // Khách quay lại chỉ gửi SĐT: giỏ được lưu lại ở lượt đặt hàng → cờ hoãn được bỏ.
  const resumed = new Sim();
  const resumedInbox = resumed.inbox({ botLastTemplateId: 'ORDER_POSTPONED', botLastReplyAt: Date.now() - 30 * MIN, pendingOrder: { ...basket([XANH(2)], 30 * MIN), postponed: true } });
  const phone = await resumed.send(resumedInbox, PHONE, { llm: { template_id: 'ORDER_ADDRESS', Phone_Number: PHONE } });
  assert.equal(resumedInbox.pendingOrder.phone, PHONE, JSON.stringify(phone.result));
  assert.equal(resumedInbox.pendingOrder.postponed, undefined);
});

test('luồng dùng thử nhờ mô hình (delegate) mà luật đơn đã khớp: dùng kết quả luật, không gọi mô hình', async () => {
  const sim = new Sim();
  const inbox = sim.inbox({ promo: { freeShipping: true, until: Date.now() + 24 * 60 * MIN, scenarioId: 's1', at: Date.now() - 60 * MIN, stage: 'chosen', bag: 'Granola Túi Xanh 450g', lockedUntil: Date.now() + 24 * 60 * MIN }, botLastTemplateId: 'TRIAL_ACCEPT', botLastReplyAt: Date.now() - MIN });
  const orderRule = { ruleIntent: () => ({ rule: 'PHONE_ADDRESS', value: { template_id: 'ORDER_CONFIRMATION', Product_N1: 'Granola Túi Xanh 450g', No_A: '1', Phone_Number: PHONE, Customer_Address: ADDRESS } }) };
  const turn = await sim.send(inbox, `${PHONE} ${ADDRESS}`, { llm: () => { throw new Error('luật đơn đã khớp: không hỏi mô hình'); }, extra: orderRule });
  assert.equal(turn.asked.length, 0);
  assert.equal(turn.created.length, 1, JSON.stringify(turn.result));
  assert.equal(turn.created[0].phone, PHONE);
  // Luật KHÔNG phải bước đơn (hay không có luật): luồng dùng thử vẫn hỏi mô hình như cũ.
  const other = new Sim();
  const otherInbox = other.inbox({ promo: { freeShipping: true, until: Date.now() + 24 * 60 * MIN, scenarioId: 's1', at: Date.now() - 60 * MIN, stage: 'offered' } });
  const asked = await other.send(otherInbox, 'để chị hỏi chồng đã', { llm: { template_id: 'SHIPPING_POLICY' }, extra: { ruleIntent: () => null } });
  assert.equal(asked.asked.length, 1);
  assert.equal(asked.asked[0].conversation.trialHint.length > 0, true, 'lượt hỏi mô hình mang gợi ý luồng dùng thử');
});

test('"có mấy loại" gõ lỗi ("Có mays lọi") khi đang giữ giỏ: không bị thay bằng câu nhắc giỏ trơn', async () => {
  for (const text of ['Có mays lọi', 'co may loai vay shop', 'có mấy vị']) assert.equal(asksFlavourList(text), true, text);
  for (const text of ['ok em', 'gửi cho chị nha', '2 túi xanh']) assert.equal(asksFlavourList(text), false, text);
  const sim = new Sim({ settings: { ruleIntent: 'off' } });
  const inbox = sim.inbox({ botLastTemplateId: 'ORDER_ADDRESS', botLastReplyAt: Date.now() - 20 * MIN, pendingOrder: basket([XANH(1)], 20 * MIN) });
  const turn = await sim.send(inbox, 'Có mays lọi', { llm: { template_id: 'GENERAL_INFO' } });
  assert.notEqual(turn.result.templateId, 'ORDER_ADDRESS_REMIND', JSON.stringify(turn.result));
  assert.match(turn.sent.map(item => item.text).join('\n'), /Túi Vàng/);
});

test('địa chỉ AI chỉ GỢI Ý phường (suggestOnly): không tự điền vào đơn, ghi gợi ý cho nhân viên vào ghi chú soát', async () => {
  resetAddressAiCache();
  const settings = {
    provider: 'vertex', directAuthType: 'api_key', directApiKey: 'key',
    directEndpoint: 'https://aiplatform.googleapis.com/v1/projects/p/locations/global/publishers/google/models/gemini-3-flash-preview:generateContent',
    directModel: 'gemini-3-flash-preview', addressAi: true, addressAiSearch: true
  };
  // Vertex giả lập: AI tự suy "Xã Cát Minh" cho "van phu huyen phu cat binh dinh" (không có trong chữ khách).
  const vertex = async () => ({ ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text: JSON.stringify({ province: 'Tỉnh Bình Định', district: 'Huyện Phù Cát', ward: 'Xã Cát Minh', street: 'Thôn Vạn Phú', confidence: 'high', ambiguous: false, reason: 'Vạn Phú thuộc xã Cát Minh' }) }] } }] }) });
  const parsed = { template_id: 'ORDER_CONFIRMATION', Phone_Number: PHONE, Customer_Address: 'van phu huyen phu cat binh dinh' };
  await refineAddressWithAi(parsed, {}, settings, vertex);
  assert.equal(parsed.Customer_Address, 'van phu huyen phu cat binh dinh', 'địa chỉ khách nhắn giữ nguyên');
  assert.equal(parsed.addressAiCheck, 'Gợi ý phường/xã (AI, chưa kiểm): Xã Cát Minh, Huyện Phù Cát');
  // Gọi lại (cache) không nhân đôi ghi chú.
  await refineAddressWithAi(parsed, {}, settings, vertex);
  assert.equal(parsed.addressAiCheck, 'Gợi ý phường/xã (AI, chưa kiểm): Xã Cát Minh, Huyện Phù Cát');
  resetAddressAiCache();
});
