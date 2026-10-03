// Vòng 14: mẫu seed (HEALTH_CAUTION mới, OTHER_PRODUCTS bỏ mời hạt/hũ, GIFT_POLICY đủ ưu đãi + câu chốt, LIVESTREAM_COMMENT
// ghi giá chưa gồm ship), prompt docs, và dòng log lỗi trạm gửi Pancake (lý do ngắn, che SĐT).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import './helpers/seed-catalog.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const seed = JSON.parse(readFileSync(path.join(root, 'app', 'chatbot-templates.seed.json'), 'utf8'));
const prompt = readFileSync(path.join(root, 'docs', 'system-prompt.txt'), 'utf8');
const { renderChatbotReply, sanitizeModelAnswer } = await import('../app/chatbot-templates.mjs');
const { followUpRelayErrorText } = await import('../app/follow-up.mjs');
const render = (id, extra = {}) => renderChatbotReply({ template_id: id }, seed, { customer: { gender: 'female' }, ...extra });

test('HEALTH_CAUTION (quyết định 11): đúng chữ chủ shop, không nói mẹ sau sinh', () => {
  assert.equal(seed.HEALTH_CAUTION, 'Dạ granola bên em là thực phẩm thông thường, không thêm đường, không phải thuốc hay thực phẩm chức năng ạ. Người đang điều trị bệnh (huyết áp, tim mạch…) {title} nên hỏi bác sĩ về khẩu phần phù hợp; nếu dùng thì ăn lượng vừa phải (2–3 muỗng), kèm sữa chua không đường nha ạ.');
  const text = render('HEALTH_CAUTION').messages.join(' ');
  assert.match(text, /chị nên hỏi bác sĩ/);
  assert.doesNotMatch(text, /sau sinh|cho con bú/);
});

test('OTHER_PRODUCTS (quyết định 7): không mời hạt / hũ (chỉ nhân viên bán)', () => {
  const text = render('OTHER_PRODUCTS').messages.join(' ');
  assert.doesNotMatch(text, /Hạt An Lành|hũ|\bhạt\b/i);
  assert.match(text, /Nghệ Lành/);
});

test('GIFT_POLICY: đủ bậc quà (2 / 3 / 5 / 10 túi) theo Cài đặt → Quà tặng và có câu chốt (mẫu đang chạy cụt "…combo 3 túi ạ.")', () => {
  const text = render('GIFT_POLICY').messages.join('\n');
  assert.match(text, /Miễn phí vận chuyển: từ 2/);
  assert.match(text, /Bộ bát gáo dừa \+ Muỗng dừa: từ 3/);
  assert.match(text, /1 Túi Vàng 350g: đúng 5/);
  assert.match(text, /1 Túi Vàng 350g \+ 1 Túi Nâu 350g: từ 10/);
  assert.match(text, /Chị lấy mấy túi để em lên đơn kèm quà/);
  assert.doesNotMatch(seed.GIFT_POLICY, /\d{3}\.\d{3}đ/, 'không giá cứng');
});

test('LIVESTREAM_COMMENT: ghi rõ giá 1 túi/hộp chưa gồm ship 15.000đ (chữ như main 9d6f38b)', () => {
  assert.match(seed.LIVESTREAM_COMMENT, /\(Giá 1 túi\/hộp chưa gồm phí vận chuyển 15\.000đ\)\nLấy 2 túi bất kỳ chỉ 298\.000đ/);
});

test('mẫu đã chốt trước (GIFT_SWAP, PRICE_ADJUSTMENT, STAFF_WAIT_*) giữ nguyên chữ bd484c5', () => {
  assert.match(seed.GIFT_SWAP, /xin bộ phận phụ trách cho phép đổi/);
  assert.doesNotMatch(seed.GIFT_SWAP, /2 gói/);
  assert.match(seed.PRICE_ADJUSTMENT, /đơn 1 túi cộng ship 15\.000đ/);
  assert.ok(seed.STAFF_WAIT_OPEN && seed.STAFF_WAIT_CLOSED);
});

test('prompt docs: bệnh lý → HEALTH_CAUTION, hàng ngoài danh mục → LIVE_ONLY_PRODUCT (engine chuyển bạn phụ trách), không chuyển người vì tin ngắn/khó hiểu', () => {
  assert.match(prompt, /Bệnh lý, đang điều trị \(huyết áp, tim mạch, tiểu đường…\): HEALTH_CAUTION/);
  assert.doesNotMatch(prompt, /tiểu đường, bệnh lý: HEALTH_CONDITION/);
  assert.match(prompt, /Hàng không có trong SẢN PHẨM \(hạt điều[^)]*\): LIVE_ONLY_PRODUCT/);
  assert.match(prompt, /Không chuyển người chỉ vì tin ngắn hay khó hiểu/);
  // STAFF_ONLY_PRODUCT do mô hình chọn thẳng thì {product} trống → tin rỗng: prompt KHÔNG được nhắc tên mẫu này.
  assert.doesNotMatch(prompt, /STAFF_ONLY_PRODUCT/);
  assert.equal(sanitizeModelAnswer({ template_id: 'STAFF_ONLY_PRODUCT' }, prompt).template_id, 'GENERAL_INFO');
  assert.equal(sanitizeModelAnswer({ template_id: 'HEALTH_CAUTION' }, prompt).template_id, 'HEALTH_CAUTION');
  assert.doesNotMatch(prompt, /[\x00-\x08\x0b\x0c\x0e-\x1f]/);
});

test('log trạm gửi Pancake: lý do lỗi ngắn, che SĐT, gộp trùng, bỏ kết quả ok/unknown', () => {
  const text = followUpRelayErrorText([
    { key: 'a', ok: true },
    { key: 'b', unknown: true },
    { key: 'c', error: 'Không tìm thấy hội thoại 0912 345 678 trên Pancake' },
    { key: 'd', error: 'Không tìm thấy hội thoại 0912345678 trên Pancake' },
    { key: 'e', error: `Pancake 500 ${'x'.repeat(200)}` },
    { key: 'f' }
  ]);
  assert.doesNotMatch(text, /0912|345 678/);
  assert.match(text, /Không tìm thấy hội thoại <sđt> trên Pancake ×2/);
  assert.match(text, /không rõ lỗi/);
  assert.ok(text.length < 300);
  assert.equal(followUpRelayErrorText([{ ok: true }]), '');
  assert.match(followUpRelayErrorText(['1', '2', '3', '4'].map(n => ({ error: `lỗi ${n}` }))), /\+1 lý do khác$/);
});
