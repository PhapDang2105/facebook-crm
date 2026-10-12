// Vòng 18 (12/10) — GÓI A: LIVE_ONLY có ranh giới từ, "dâu sấy / túi sấy" là Tropical, "thêm túi dâu" cộng vào giỏ.
// Câu khách thật trong S\r18\out-inbox1.md N4, out-cross.md R2/R3 (đã che tên/SĐT).
import assert from 'node:assert/strict';
import test from 'node:test';
import { Sim, XANH, VANG, NAU, basket } from './helpers/r13-engine-sim.mjs';
import { LIVE_ONLY, core, prepRuleText } from '../app/processing/rule-intent.mjs';

const MIN = 60000;
const itemsOf = list => (list || []).map(item => `${item.quantity} ${item.code || item.sku}`).sort();
const said = turn => turn.sent.map(item => item.text).join('\n');

const live = text => LIVE_ONLY.test(core(prepRuleText(text)));
test('R18 A-N4: LIVE_ONLY không bắt "hạt bị hôi", "dâu sấy", "xoài"; vẫn bắt hạt bí / hạt điều / sữa hạt / hũ hạt', () => {
  for (const text of ['sợ hat bi hôi bua mua cung bi hôi', 'hạt bị mốc', 'Them một túi dâu sấy', 'túi có xoài không']) assert.equal(live(text), false, text);
  for (const text of ['bên em có hạt bí không', 'hat bi rang bao nhieu', 'sữa hạt giá sao', 'hũ hạt điều', 'đậu sấy bao nhiêu']) assert.equal(live(text), true, text);
});

test('R18 A-N4 (…3326342952406): giữ giỏ Vàng + Nâu, "sợ hat bi hôi bua mua cung bi hôi" → trấn an mùi (OIL_SMELL_WARRANTY), không "bạn phụ trách tư vấn riêng"', async () => {
  const sim = new Sim({ psid: 'r18a-hoi' });
  const inbox = sim.inbox({ labels: ['livestream'], botLastTemplateId: 'ORDER_ADDRESS_REMIND', botLastReplyAt: Date.now() - 0.5 * MIN, pendingOrder: basket([VANG(1), NAU(1)], MIN) });
  const turn = await sim.send(inbox, 'sợ hat bi hôi bua mua cung bi hôi');
  assert.notEqual(turn.record?.rule?.name, 'LIVE_ONLY');
  assert.notEqual(turn.result.templateId, 'STAFF_ONLY_PRODUCT', said(turn));
  assert.match(said(turn), /mùi lạ|đổi mới/u, said(turn));
  assert.deepEqual(itemsOf(inbox.pendingOrder?.items), ['1 GRA-NAU-Z350', '1 GRA-VANG-H350']);
});

test('R18 A-N4 (…2779372638900): "Mình lấy một túi xanh với 1tui sấy" → giỏ 1 Xanh + 1 Tropical (luật, mô hình chỉ đọc Xanh)', async () => {
  const sim = new Sim({ psid: 'r18a-say' });
  const inbox = sim.inbox({ labels: ['livestream'], botLastTemplateId: 'PRICE_QUOTE', botLastReplyAt: Date.now() - MIN });
  const turn = await sim.send(inbox, 'Mình lấy một  túi xanh với 1tui sấy', { llm: { template_id: 'ORDER_ADDRESS', Product_N1: 'Granola Túi Xanh 450g', No_A: '1' } });
  assert.deepEqual(itemsOf(inbox.pendingOrder?.items), ['1 GRA-MINT-Z300', '1 GRA-XANH-Z450'], said(turn));
});

test('R18 A-N4 (…2779372638900): giữ 1 Xanh, "Them một túi dau say" → cộng 1 Tropical vào giỏ (không bảng giá Tropical, không LIVE_ONLY)', async () => {
  const sim = new Sim({ psid: 'r18a-them' });
  const inbox = sim.inbox({ labels: ['livestream'], botLastTemplateId: 'ORDER_ADDRESS', botLastReplyAt: Date.now() - MIN, pendingOrder: basket([XANH(1)], MIN) });
  const turn = await sim.send(inbox, 'Them một  túi dau say');
  assert.notEqual(turn.record?.rule?.name, 'LIVE_ONLY');
  assert.deepEqual(itemsOf(inbox.pendingOrder?.items), ['1 GRA-MINT-Z300', '1 GRA-XANH-Z450'], said(turn));
  assert.doesNotMatch(said(turn), /Bảng giá/u);
});
