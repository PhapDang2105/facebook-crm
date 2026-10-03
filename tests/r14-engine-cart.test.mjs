// Vòng 14 (03/10) — engine: giỏ Facebook Shop. Ca thật …764130 (02/10 18:01–18:03): khách bấm giỏ 4 lần liền
// (CB-XANH+NAU rồi 3 lần CB-VANGG+XANH) — r13 cộng dồn thành 4 Xanh + 3 Vàng + 1 Nâu = 1.187.000đ. Quyết định 8: chờ đơn POS 20 giây.
import assert from 'node:assert/strict';
import test from 'node:test';
import { Sim } from './helpers/r13-engine-sim.mjs';
import { SHOP_ORDER_WAIT_MS, shopCartOfBundle } from '../app/chatbot-engine.mjs';
import { normalizeChatbotSettings } from '../app/chatbot-settings.mjs';

const shopName = 'Granola Mới Ngũ Cốc Ăn Sáng Healthy Lành Mạnh Với Hạt Dinh Dưỡng Trái Cây Từ Giọt Nắng';
const cartText = (sku, price) => `Khách chọn mua từ Facebook Shop: ${shopName} (${sku}) — ${price.toLocaleString('vi-VN')}đ`;
const cartLine = sku => ({ name: shopName, sku, quantity: 1, image: '' });
const noModel = () => { throw new Error('không được gọi mô hình cho tin giỏ Shop'); };
const itemsOf = pending => (pending?.items || []).map(item => `${item.quantity} ${item.code}`).sort();

test('4 lần bấm giỏ trong một cụm tin (ca …764130): lấy giỏ CUỐI (1 Vàng + 1 Xanh 298k), không cộng; giỏ khác nhau → thẻ', async () => {
  const sim = new Sim({ settings: { shopOrderFollowUpMs: [] } });
  const inbox = sim.inbox({ gender: 'male', botGender: 'male' });
  const clicks = [['CB-XANH+NAU', 293000], ['CB-VANGG+XANH', 298000], ['CB-VANGG+XANH', 298000]];
  clicks.forEach(([sku, price], index) => sim.history(inbox, 'incoming', cartText(sku, price), 90000 - index * 20000, { cart: [cartLine(sku)] }));
  const turn = await sim.send(inbox, cartText('CB-VANGG+XANH', 298000), { message: { cart: [cartLine('CB-VANGG+XANH')] }, llm: noModel });
  assert.equal(turn.result.templateId, 'ORDER_ADDRESS', JSON.stringify(turn.result));
  assert.deepEqual(itemsOf(inbox.pendingOrder), ['1 GRA-VANG-H350', '1 GRA-XANH-Z450']);
  const said = turn.sent.map(item => item.text).join('\n');
  assert.match(said, /298\.000đ/);
  assert.doesNotMatch(said, /1\.187\.000đ|591\.000đ|4 Granola|3 Granola/);
  assert.ok(inbox.labels.includes('handoff'), 'các lần bấm khác nhau → thẻ cần người xem');
});

test('một tin mang nhiều dòng giỏ ghép từ nhiều lần bấm (2 dòng chữ "Khách chọn mua…") → giỏ của lần bấm cuối; giỏ nhiều món thật vẫn đủ', async () => {
  const merged = { id: 'm1', text: `${cartText('CB-XANH+NAU', 293000)}\n${cartText('CB-VANGG+XANH', 298000)}`, cart: [cartLine('CB-XANH+NAU'), cartLine('CB-VANGG+XANH')] };
  const picked = shopCartOfBundle([merged], merged);
  assert.deepEqual(picked.lines.map(line => line.sku), ['CB-VANGG+XANH']);
  assert.equal(picked.differs, true);
  // Giỏ thật nhiều món (một dòng chữ, các món nối "; ") là MỘT giỏ.
  const real = { id: 'm2', text: `Khách chọn mua từ Facebook Shop: Túi Xanh (GRA-XANH-Z450) × 1; Túi Vàng (GRA-VANG-H350) × 1`, cart: [{ sku: 'GRA-XANH-Z450', quantity: 1 }, { sku: 'GRA-VANG-H350', quantity: 1 }] };
  const whole = shopCartOfBundle([real], real);
  assert.deepEqual(whole.lines.map(line => line.sku), ['GRA-XANH-Z450', 'GRA-VANG-H350']);
  assert.equal(whole.differs, false);
  // Bấm lại đúng giỏ cũ: không gắn thẻ.
  const again = { id: 'm4', text: cartText('CB-VANGG+XANH', 298000), cart: [cartLine('CB-VANGG+XANH')] };
  assert.equal(shopCartOfBundle([{ ...again, id: 'm3' }, again], again).differs, false);
  // Mô phỏng trọn lượt với tin ghép: không cộng (trước đây 1.187.000đ / 591.000đ).
  const sim = new Sim({ settings: { shopOrderFollowUpMs: [] } });
  const inbox = sim.inbox();
  const turn = await sim.send(inbox, merged.text, { message: { cart: merged.cart }, llm: noModel });
  assert.deepEqual(itemsOf(inbox.pendingOrder), ['1 GRA-VANG-H350', '1 GRA-XANH-Z450'], JSON.stringify(turn.result));
});

test('quyết định 8: giỏ Shop chờ đơn POS 20 giây (mặc định), Cài đặt vẫn đặt được', () => {
  assert.equal(SHOP_ORDER_WAIT_MS, 20000);
  assert.equal(normalizeChatbotSettings({}).shopOrderWaitMs, 20000);
  assert.equal(normalizeChatbotSettings({ shopOrderWaitMs: 45000 }).shopOrderWaitMs, 45000);
  assert.equal(normalizeChatbotSettings({ shopOrderWaitMs: 0 }).shopOrderWaitMs, 0);
  assert.equal(normalizeChatbotSettings({ shopOrderWaitMs: '' }).shopOrderWaitMs, 20000);
  assert.equal(normalizeChatbotSettings({ shopOrderWaitMs: 999999 }).shopOrderWaitMs, 120000);
});
