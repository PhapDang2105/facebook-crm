// Vòng 18 — gói D: bình luận hỏi giá luôn có giá (bình luận B5, B6, B7). Câu khách thật, mô hình giả lập đúng lựa chọn đã ghi
// trong decisions.jsonl.
import assert from 'node:assert/strict';
import test from 'node:test';
import { Sim, XANH, basket } from './helpers/r13-engine-sim.mjs';

const MIN = 60 * 1000;
const said = turn => turn.sent.map(item => item.text).join('\n');
const LIVE_POST = { id: '103549382215599_1083862934547261', message: 'Săn deal cùng Giọt Nắng ạ' };
const GENERAL_POST = { id: '103549382215599_983587510871003', message: 'SÁNG NÀO CŨNG NHẸ NHÀNG, CHỈ NHỜ MỘT BÁT GRANOLA.\n\n👉 Không cần chuẩn bị cầu kỳ, chỉ vài phút mỗi sáng' };

test('R18 D bình luận B5 (…469031, bài live …547261 "Xin giá 4tui Granola"): báo giá 4 túi (kèm quà live) rồi hỏi vị — không chỉ hỏi vị', async () => {
  const sim = new Sim({ psid: 'r18d-b5' });
  const thread = sim.comment({ post: LIVE_POST });
  const turn = await sim.send(thread, 'Xin giá 4tui Granola', { llm: { template_id: 'ORDER_ADDRESS', Product_N1: 'Granola Túi Xanh 450g', No_A: '4' } });
  const text = said(turn);
  assert.match(text, /4 túi \(mix vị tùy ý\) giá 596\.000đ, miễn phí vận chuyển, tặng Quạt/, text);
  assert.match(text, /lấy 4 túi vị nào/);
  assert.doesNotMatch(text, /4 Granola Túi Xanh/, 'không tự đoán Túi Xanh');
});

test('R18 D bình luận B5 (…333455, bài live …606624 "3 gói thì giá sao"): báo giá 3 túi', async () => {
  const sim = new Sim({ psid: 'r18d-b5b' });
  const thread = sim.comment({ post: { id: '103549382215599_1086498297606624', message: 'Săn deal cùng Giọt Nắng ạ' } });
  const turn = await sim.send(thread, '3 gói thì giá sao', { llm: { template_id: 'ORDER_ADDRESS', Product_N1: 'Granola Túi Xanh 450g', No_A: '3' } });
  assert.match(said(turn), /3 túi \(mix vị tùy ý\) giá 447\.000đ, miễn phí vận chuyển, tặng Quạt \+ Bộ bát gáo dừa \+ Muỗng dừa/, said(turn));
});

test('R18 D bình luận B6 (…695872, bài chung …871003 "Lấy chị 3 gói"): không tự lên 3 Túi Xanh — hỏi vị, giữ 3 túi', async () => {
  const sim = new Sim({ psid: 'r18d-b6' });
  const thread = sim.comment({ post: GENERAL_POST });
  const turn = await sim.send(thread, 'Lấy chị 3 gói', { llm: { template_id: 'ORDER_ADDRESS', Product_N1: 'Granola Túi Xanh 450g', No_A: '3' } });
  const text = said(turn);
  assert.doesNotMatch(text, /3 Granola Túi Xanh/, text);
  assert.match(text, /vị nào/);
  // Bài nói đúng Túi Xanh thì đoán Túi Xanh vẫn đúng (giữ hành vi cũ).
  const sim2 = new Sim({ psid: 'r18d-b6x' });
  const xanhPost = sim2.comment({ post: { id: '103549382215599_1001185305777890', message: '🌿 GRANOLA TÚI XANH – BỮA SÁNG LÀNH CHO CẢ NHÀ' } });
  const turn2 = await sim2.send(xanhPost, 'Lấy chị 3 gói', { llm: { template_id: 'ORDER_ADDRESS', Product_N1: 'Granola Túi Xanh 450g', No_A: '3' } });
  assert.match(said(turn2), /3 Granola Túi Xanh/, said(turn2));
});

test('R18 D bình luận B7 (…056494 "giá" khi hộp thư còn giỏ 1 Túi Xanh 14 giờ trước): tin riêng vẫn là bảng giá, câu nhắc giỏ (nếu có) nối cuối', async () => {
  const sim = new Sim({ psid: 'r18d-b7' });
  sim.inbox({ labels: ['livestream'], botLastTemplateId: 'ORDER_ADDRESS', botLastReplyAt: Date.now() - 14 * 60 * MIN, pendingOrder: basket([XANH(1)], 14 * 60 * MIN, { livestream: true }) });
  const thread = sim.comment({ post: { id: '103549382215599_1071054978790922', message: '' } });
  const turn = await sim.send(thread, 'giá', { llm: () => { throw new Error('luật TERSE_PRICE, không hỏi mô hình'); } });
  const text = said(turn);
  assert.match(text, /298\.000đ|149\.000đ|174\.000đ/, text);
  const remindAt = text.indexOf('đang giữ đơn');
  if (remindAt >= 0) assert.ok(remindAt > text.search(/298\.000đ|174\.000đ/), 'câu nhắc giỏ phải sau bảng giá');
  assert.notEqual(turn.result.templateId, 'ORDER_ADDRESS_REMIND');
});
