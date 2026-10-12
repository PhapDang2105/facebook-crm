// Vòng 18 (12/10) — GÓI A: hiểu ý đặt hàng (hoãn / combo gia đình gói nhỏ / "Có" sau SMALL_PACK_FLAVOURS / "loại nhiều hạt").
// Câu khách thật trong S\r18\out-inbox4.md N2 (đã che tên/SĐT).
import assert from 'node:assert/strict';
import test from 'node:test';
import { Sim } from './helpers/r13-engine-sim.mjs';

const MIN = 60000;
const itemsOf = list => (list || []).map(item => `${item.quantity} ${item.code || item.sku}`).sort();
const said = turn => turn.sent.map(item => item.text).join('\n');
const X = 'Granola Túi Xanh 450g';

test('R18 A inbox4 N2 (…81627306): "Chị lấy thử 1 túi nhé ăn hợp lần sau chị lấy combo" sau bảng giá Túi Xanh → không ORDER_POSTPONED (lên 1 túi)', async () => {
  const sim = new Sim({ psid: 'r18a-thu' });
  const inbox = sim.inbox({ botLastTemplateId: 'PRICE_QUOTE', botLastReplyAt: Date.now() - MIN });
  sim.history(inbox, 'outgoing', `Dạ, em gửi chị Bảng giá ${X} để mình dễ tham khảo ạ: …`, 1.1 * MIN, { sender: 'bot' });
  sim.history(inbox, 'outgoing', 'Dạ chị lấy 2 Túi (được giá combo) hay 1 Túi dùng thử ạ? Em lên đơn liền cho mình nha 🌾', MIN, { sender: 'bot' });
  const turn = await sim.send(inbox, 'Chị lấy thử 1 túi nhé ăn hợp lần sau chị lấy combo', { llm: { template_id: 'ORDER_ADDRESS', Product_N1: X, No_A: '1' } });
  assert.notEqual(turn.record?.rule?.name, 'ORDER_POSTPONED');
  assert.notEqual(turn.result.templateId, 'ORDER_POSTPONED', said(turn));
  assert.deepEqual(itemsOf(inbox.pendingOrder?.items), ['1 GRA-XANH-Z450']);
  // Hẹn dịp khác thật vẫn là hoãn.
  const later = new Sim({ psid: 'r18a-hoan' });
  const box = later.inbox({ botLastTemplateId: 'PRICE_QUOTE', botLastReplyAt: Date.now() - MIN });
  const postponed = await later.send(box, 'thôi để lần sau chị lấy nhé');
  assert.equal(postponed.result.templateId, 'ORDER_POSTPONED', said(postponed));
});

test('R18 A inbox4 N2 (…86775734): "Có" sau SMALL_PACK_FLAVOURS ("cần em gửi bảng giá combo 10 gói không") → bảng giá Combo 10 gói, không lên đơn', async () => {
  const sim = new Sim({ psid: 'r18a-co' });
  const inbox = sim.inbox({ botLastTemplateId: 'SMALL_PACK_FLAVOURS', botLastReplyAt: Date.now() - MIN });
  const turn = await sim.send(inbox, 'Có', { llm: { template_id: 'ORDER_ADDRESS', Product_N1: 'Combo 10 gói Xanh', No_A: '1' } });
  assert.equal(turn.asked.length, 0, 'không gọi mô hình');
  assert.match(said(turn), /Bảng giá Combo 10 gói/u, said(turn));
  assert.equal(inbox.pendingOrder?.items?.length || 0, 0);
});

test('R18 A inbox4 N2 (…83821320): sau bảng giá Combo 10 gói ("3 Combo Gia Đình"), "Combo gia đình là đủ 3 vị ạ" / "E lấy combo gia đình mix đủ 3 vị ạ" → COMBO10_FAMILY, không 3 túi lớn', async () => {
  for (const text of ['Combo gia đình là đủ 3 vị ạ', 'E lấy combo gia đình mix đủ 3 vị ạ']) {
    const sim = new Sim({ psid: `r18a-cgd-${text.length}` });
    const inbox = sim.inbox({ botLastTemplateId: 'PRICE_QUOTE', botLastReplyAt: Date.now() - MIN });
    sim.history(inbox, 'outgoing', 'Dạ, em gửi chị Bảng giá Combo 10 gói Xanh để mình dễ tham khảo ạ: … 👨‍👩‍👧‍👦 3 Combo Gia Đình (1.05kg) …', 1.1 * MIN, { sender: 'bot' });
    sim.history(inbox, 'outgoing', 'Dạ chị đang cần thêm thông tin nào về sản phẩm thì nhắn cho em để em hỗ trợ cho mình nhé ạ.', MIN, { sender: 'bot' });
    const turn = await sim.send(inbox, text, { llm: { template_id: 'ORDER_ADDRESS', Product_N1: X, No_A: '1', Product_N2: 'Granola Túi Vàng 350g', No_B: '1', Product_N3: 'Granola Túi Nâu vị cacao 350g', No_C: '1' } });
    assert.equal(turn.result.templateId, 'COMBO10_FAMILY', `${text}\n${said(turn)}`);
    assert.match(said(turn), /3 hộp Combo 10 gói/u);
    assert.doesNotMatch(said(turn), /Túi Vàng|442\.000/u);
    assert.equal(inbox.pendingOrder?.items?.length || 0, 0, text);
  }
  // Bảng giá túi lớn vừa gửi → COMBO3 (combo 3 túi lớn) như cũ.
  const sim = new Sim({ psid: 'r18a-cgd-big' });
  const inbox = sim.inbox({ botLastTemplateId: 'PRICE_QUOTE', botLastReplyAt: Date.now() - MIN });
  sim.history(inbox, 'outgoing', `Dạ, em gửi chị Bảng giá ${X} để mình dễ tham khảo ạ: …`, MIN, { sender: 'bot' });
  const big = await sim.send(inbox, 'Combo gia đình là đủ 3 vị ạ');
  assert.equal(big.result.templateId, 'COMBO3_FLAVOR', said(big));
});

test('R18 A inbox4 N2 (…77945783): "chị muốn lấy loại nhiều hạt ấy" → lên giỏ 1 Túi Vàng (không chỉ gửi bảng giá)', async () => {
  const sim = new Sim({ psid: 'r18a-nh' });
  const inbox = sim.inbox({ botLastTemplateId: 'PRICE_QUOTE', botLastReplyAt: Date.now() - 19 * 60 * MIN });
  const turn = await sim.send(inbox, 'chị muốn lấy loại nhiều hạt ấy', { llm: { template_id: 'PRICE_QUOTE', Product_N1: 'Granola Túi Vàng 350g' } });
  assert.equal(turn.asked.length, 0, 'không gọi mô hình');
  assert.deepEqual(itemsOf(inbox.pendingOrder?.items), ['1 GRA-VANG-H350'], said(turn));
  // Câu hỏi không lên giỏ.
  const ask = new Sim({ psid: 'r18a-nh2' });
  const box = ask.inbox({ botLastTemplateId: 'PRICE_QUOTE', botLastReplyAt: Date.now() - MIN });
  await ask.send(box, 'muốn lấy loại nhiều hạt thì giá sao em', { llm: { template_id: 'PRICE_QUOTE', Product_N1: 'Granola Túi Vàng 350g' } });
  assert.equal(box.pendingOrder?.items?.length || 0, 0);
});
