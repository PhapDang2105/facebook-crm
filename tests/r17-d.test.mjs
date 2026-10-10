// Vòng 17 — gói D: mẫu tin theo quà hiện hành (08/10) + quyết định chủ shop 10/10 (mục 1 Cam, 3 quà live chỉ túi lớn,
// 4 mời thêm 1 túi, 12 combo 2 live bỏ quạt → 1 Bát gáo dừa). Câu khách thật (đã che), mẫu = seed (lời mới áp lên máy chủ
// bằng S\r17\apply-templates-r17.mjs; PRICE_MIX_TUI_LON viết tay của máy chủ kiểm riêng bằng SERVER_MIX).
import assert from 'node:assert/strict';
import test from 'node:test';
import { Sim, VANG, XANH, basket, templates } from './helpers/r13-engine-sim.mjs';
import { renderChatbotReply } from '../app/chatbot-templates.mjs';
import { priceBasket } from '../app/processing/pricing.mjs';
import { ruleIntent } from '../app/processing/rule-intent.mjs';
import { fanToSpoonGifts } from '../app/chatbot-engine.mjs';

const MIN = 60 * 1000;
const LIVE = { livestream: true };
const said = turn => turn.sent.map(item => item.text).join('\n');
const giftNames = (items, options) => priceBasket(items, options).gifts.map(gift => gift.name);
// Lời PRICE_MIX_TUI_LON áp lên máy chủ (giữ kiểu viết tay của chủ shop, quà nối theo bảng quà).
const SERVER_MIX = 'Dạ bảng giá mix túi lớn ạ:\n• Xanh + Vàng: 298.000đ\n• Xanh + Nâu: 293.000đ\n• Vàng + Nâu: 293.000đ\n(Mix 2 túi miễn phí vận chuyển[?pair_gift], tặng {pair_gift}[/?])\n• Trọn bộ Xanh + Vàng + Nâu: 442.000đ, miễn phí vận chuyển[?full_gift] và tặng {full_gift}[/?] ạ.';

test('R17 quà live (08/10 + chủ shop 10/10 mục 3): live 2 túi lớn → Quạt; 3 túi → Quạt + bát + muỗng; Tropical / combo 10 gói → không quà live; khách thường không Quạt', () => {
  assert.deepEqual(giftNames([{ sku: 'GRA-XANH-Z450', quantity: 2 }], LIVE), ['Miễn phí vận chuyển', 'Quạt']);
  assert.deepEqual(giftNames([{ sku: 'GRA-XANH-Z450', quantity: 1 }, { sku: 'GRA-VANG-H350', quantity: 1 }, { sku: 'GRA-NAU-Z350', quantity: 1 }], LIVE), ['Miễn phí vận chuyển', 'Quạt', 'Bộ bát gáo dừa', 'Muỗng dừa']);
  assert.deepEqual(giftNames([{ sku: 'GRA-MINT-Z300', quantity: 2 }], LIVE), ['Miễn phí vận chuyển'], '2 Tropical (inbox1 chủ shop 1)');
  assert.deepEqual(giftNames([{ sku: 'CB10-XANH-G35', quantity: 2 }], LIVE), ['Miễn phí vận chuyển'], '2 hộp 10 gói');
  assert.deepEqual(giftNames([{ sku: 'GRA-XANH-Z450', quantity: 2 }]), ['Miễn phí vận chuyển']);
});

test('R17 bình luận A7 (…556819 "3 TÚI TẶNG GÌ EM") / inbox4 H3 (…519800897 "Ngon thì mua 3 túi tặng mấy bát dừa"): GIFT_POLICY_LIVE nói cả quà 3 túi', async () => {
  const sim = new Sim({ psid: 'r17d-a7' });
  const inbox = sim.inbox({ labels: ['livestream'] });
  const turn = await sim.send(inbox, '3 TÚI TẶNG GÌ EM', { llm: { template_id: 'GIFT_POLICY' } });
  assert.equal(turn.result.templateId, 'GIFT_POLICY_LIVE', JSON.stringify(turn.result));
  assert.match(said(turn), /2 túi lớn bất kỳ \(Xanh \/ Vàng \/ Nâu\) chỉ 298\.000đ, miễn phí vận chuyển và được tặng Quạt/);
  assert.match(said(turn), /Từ 3 túi tặng Quạt \+ Bộ bát gáo dừa \+ Muỗng dừa/);
  assert.doesNotMatch(said(turn), /lấy 2 túi vị nào/, 'không ép khách hỏi 3 túi về 2 túi');
});

test('R17 inbox5 B1 / A6 (…486347 "Nếu cô mua 3 túi vàng, xanh, nâu thì giá là bn và có tặng phẩm là gì"): bảng mix theo bảng quà — khách live trọn bộ có Quạt', () => {
  const live = renderChatbotReply({ template_id: 'PRICE_MIX_TUI_LON' }, { ...templates, PRICE_MIX_TUI_LON: SERVER_MIX }, LIVE).messages.join('\n');
  assert.match(live, /\(Mix 2 túi miễn phí vận chuyển, tặng Quạt\)/);
  assert.match(live, /442\.000đ, miễn phí vận chuyển và tặng Quạt \+ Bộ bát gáo dừa \+ Muỗng dừa ạ\./);
  const plain = renderChatbotReply({ template_id: 'PRICE_MIX_TUI_LON' }, { ...templates, PRICE_MIX_TUI_LON: SERVER_MIX }, {}).messages.join('\n');
  assert.match(plain, /\(Mix 2 túi miễn phí vận chuyển\)/);
  assert.match(plain, /442\.000đ, miễn phí vận chuyển và tặng Bộ bát gáo dừa \+ Muỗng dừa ạ\./);
  assert.doesNotMatch(plain, /Quạt/);
  // Seed (bảng tự dựng): cặp mix của khách live ghi quà.
  assert.match(renderChatbotReply({ template_id: 'PRICE_MIX_TUI_LON' }, templates, LIVE).messages[0], /Granola Túi Vàng 350g: 298\.000đ \(Miễn phí vận chuyển\) \+ tặng Quạt/);
});

test('R17 bình luận chủ shop 4: PRICE_SHIP_EXPLAIN ("174k mà sao giờ 189k đắt hơn vậy") không còn hứa "2 túi tặng Bát + Muỗng"', () => {
  assert.equal(ruleIntent('174k mà sao giờ 189k đắt hơn vậy', { lastTemplateId: 'PRICE_QUOTE' })?.value?.template_id, 'PRICE_SHIP_EXPLAIN');
  const plain = renderChatbotReply({ template_id: 'PRICE_SHIP_EXPLAIN' }, templates, {}).messages.join('\n');
  assert.match(plain, /2 túi bất kỳ thì chỉ 298\.000đ, miễn phí vận chuyển ạ 🌾 Từ 3 túi tặng Bộ bát gáo dừa \+ Muỗng dừa/);
  const live = renderChatbotReply({ template_id: 'PRICE_SHIP_EXPLAIN' }, templates, LIVE).messages.join('\n');
  assert.match(live, /miễn phí vận chuyển và tặng Quạt ạ 🌾 Từ 3 túi tặng Quạt \+ Bộ bát gáo dừa \+ Muỗng dừa/);
});

test('R17 chủ shop 10/10 mục 4 (inbox4 H3 …766508696 "Có được tặng gáo dừa k ạ?" khi giữ 2 túi): nói quà 2 túi + mời thêm 1 túi 447k', async () => {
  for (const [live, gift] of [[true, /combo 2 túi của anh\/chị được tặng Quạt ạ/], [false, /combo 2 túi của anh\/chị được miễn phí vận chuyển ạ/]]) {
    const sim = new Sim({ psid: `r17d-up-${live}` });
    const inbox = sim.inbox({ labels: live ? ['livestream'] : [], botLastTemplateId: 'ORDER_ADDRESS', botLastReplyAt: Date.now() - 2 * MIN, pendingOrder: basket([VANG(2)], 2 * MIN, live ? { livestream: true } : {}) });
    const turn = await sim.send(inbox, 'Có được tặng gáo dừa k ạ?', { llm: { template_id: 'GIFT_POLICY' } });
    assert.match(said(turn), gift, `live=${live}: ${said(turn)}`);
    assert.match(said(turn), /tặng cho đơn từ 3 túi \(3 túi 447\.000đ, miễn phí vận chuyển\).*lấy thêm 1 túi/);
    assert.equal(inbox.pendingOrder.items.length, 1, 'giỏ giữ nguyên 2 Vàng');
  }
});

test('R17 chủ shop 10/10 mục 12: combo 2 live "bỏ quạt" → 1 Bát gáo dừa; live 3 túi bỏ quạt → còn bát + muỗng', async () => {
  assert.deepEqual(fanToSpoonGifts().map(gift => gift.sku), ['BGD']);
  const sim = new Sim({ psid: 'r17d-fan3' });
  const inbox = sim.inbox({ labels: ['livestream'], botLastTemplateId: 'ORDER_ADDRESS', botLastReplyAt: Date.now() - 2 * MIN, pendingOrder: basket([XANH(3)], 2 * MIN, { livestream: true }) });
  const turn = await sim.send(inbox, 'bỏ quạt giúp chị', { llm: () => { throw new Error('không hỏi mô hình'); } });
  assert.deepEqual(inbox.pendingOrder.giftOverride.map(gift => gift.sku), ['BGD', 'MUONG']);
  assert.match(said(turn), /Quà của mình bây giờ là Bộ bát gáo dừa \+ Muỗng dừa ạ/);
});

test('R17 chủ shop 10/10 mục 1: Combo 10 gói Cam bán lại — "Gói mini có màu vàng kg e" → Xanh + Cam; "Gói cam giá sao e" → bảng giá Combo 10 gói Cam; lên đơn được', async () => {
  const flavours = ruleIntent('Gói mini có màu vàng kg e', {});
  assert.equal(flavours?.value?.template_id, 'SMALL_PACK_FLAVOURS');
  const text = renderChatbotReply(flavours.value, templates, {}).messages.join('\n');
  assert.match(text, /2 vị: Xanh nguyên bản .* và Cam/);
  assert.doesNotMatch(text, /chỉ còn/);
  const price = ruleIntent('Gói cam giá sao e', {});
  assert.deepEqual(price?.value, { template_id: 'PRICE_QUOTE', Product_N1: 'Combo 10 gói Cam' });
  const sim = new Sim({ psid: 'r17d-cam' });
  const inbox = sim.inbox({});
  const turn = await sim.send(inbox, 'Cho chị 1 hộp 10 gói cam', { llm: { template_id: 'ORDER_ADDRESS', Product_N1: 'Combo 10 gói Cam', No_A: '1' } });
  assert.deepEqual(inbox.pendingOrder.items.map(item => `${item.quantity} ${item.code}`), ['1 CB10-CAM-G30'], said(turn));
  assert.match(said(turn), /1 Combo 10 gói Cam, tổng 204\.000đ/);
});

test('R17 (gói C chuyển, inbox5 A9 / crm-gift-rules-0110 mục 5): giữ giỏ 1 túi, "Miễn ship cho chị nhé" → nói 1 túi 189k đã gồm ship, mời 2 túi 298k miễn ship; "ship bao nhiêu" như cũ', async () => {
  const sim = new Sim({ psid: 'r17d-freeship' });
  const inbox = sim.inbox({ botLastTemplateId: 'ORDER_ADDRESS', botLastReplyAt: Date.now() - 2 * MIN, pendingOrder: basket([XANH(1)], 2 * MIN) });
  const turn = await sim.send(inbox, 'Miễn ship cho chị nhé', { llm: { template_id: 'FREESHIP_POLICY' } });
  assert.match(said(turn), /2 túi .*298\.000đ thay vì 189\.000đ \(đã gồm ship\) cho 1 túi/, said(turn));
  assert.match(said(turn), /số điện thoại và địa chỉ/);
  assert.doesNotMatch(said(turn), /^Dạ đơn của .* tổng 189\.000đ/m, 'không lặp lại tin đơn 189k');
  const plain = renderChatbotReply({ template_id: 'FREESHIP_POLICY' }, templates, { messageText: 'ship bao nhiêu', pendingOrder: basket([XANH(1)], 2 * MIN) }).messages.join('\n');
  assert.match(plain, /tổng 189\.000đ \(đã gồm 15\.000đ phí ship\)/);
  assert.doesNotMatch(plain, /298\.000đ/);
});

test('R17 chủ shop 10/10 mục 6: PAYMENT_METHODS không hứa tự gửi số tài khoản — chuyển khoản trước thì bạn phụ trách hỗ trợ', () => {
  const text = renderChatbotReply({ template_id: 'PAYMENT_METHODS' }, templates, { messageText: 'thanh toán sao em' }).messages.join('\n');
  assert.match(text, /COD/);
  assert.match(text, /chuyển khoản trước thì em báo bạn phụ trách hỗ trợ/);
  assert.doesNotMatch(text, /gửi số tài khoản/);
});

test('R17 inbox1 A2 / inbox2 N1 (…8513889885 "Chị định mua 3 combo, nhưng còn đắt quá"): lời DISCOUNT_OATS_GIFT seed (áp lên máy chủ) không còn {oats_gift}', () => {
  assert.doesNotMatch(templates.DISCOUNT_OATS_GIFT, /oats_gift/);
  const reply = renderChatbotReply({ template_id: 'DISCOUNT_OATS_GIFT' }, templates, { messageText: 'Chị định mua 3 combo, nhưng còn đắt quá' });
  assert.match(reply.messages.join('\n'), /^Dạ giá combo bên em đã là giá tốt nhất rồi nên em không giảm thêm được ạ/);
});
