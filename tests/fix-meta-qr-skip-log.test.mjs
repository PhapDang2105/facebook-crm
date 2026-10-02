// Bộ chào QR: referral về mà KHÔNG được coi là lượt quét thẻ thì ghi một dòng nêu lý do (trước đây im lặng),
// có giới hạn tần suất.
import test from 'node:test';
import assert from 'node:assert/strict';

const { cardScanSkipReason, createQrGreeter } = await import('../app/qr-greeting.mjs');
const { registerQrCode } = await import('../app/qr-scans.mjs');

await registerQrCode('tmdt-01');

const conversation = id => ({ id, psid: id.split(':')[1], pageId: '1', name: `Khách ${id}` });
const referralChange = (conv, referral) => ({ type: 'referral', conversation: conv, referral });

function greeter(overrides = {}) {
  const logs = [];
  const sent = [];
  const instance = createQrGreeter({
    offerMessage: async () => 'Ưu đãi QR',
    send: async (conv, payload) => { sent.push({ id: conv.id, ...payload }); },
    delayMs: 5,
    cooldownMs: 10_000,
    log: line => logs.push(line),
    logError: line => logs.push(`ERR ${line}`),
    ...overrides
  });
  return { ...instance, logs, sent };
}

test('cardScanSkipReason: nêu đúng lý do; lượt quét thật và change không có referral thì rỗng', () => {
  const conv = conversation('1:a');
  assert.equal(cardScanSkipReason(referralChange(conv, { ref: 'tmdt-01', source: 'SHORTLINK' })), '');
  assert.equal(cardScanSkipReason({ type: 'message', conversation: conv, message: { text: 'hi' } }), '');
  assert.equal(cardScanSkipReason(null), '');
  assert.match(cardScanSkipReason(referralChange(conv, { ref: 'tmdt-01', source: 'ADS' })), /nguồn ADS, không phải link m\.me/);
  assert.match(cardScanSkipReason(referralChange(conv, { ref: 'tmdt-01', source: '' })), /nguồn trống/);
  assert.match(cardScanSkipReason(referralChange(conv, { ref: '', source: 'SHORTLINK' })), /không mang ref/);
  assert.match(cardScanSkipReason(referralChange(conv, { ref: 'Khuyến mãi!!', source: 'SHORTLINK' })), /không phải dạng mã thẻ/);
  assert.match(cardScanSkipReason(referralChange(conv, { ref: 'tmdt-99', source: 'SHORTLINK' })), /mã "tmdt-99" chưa tạo ở Cài đặt → Mã QR/);
  // Kho không biết mã nào (kho rỗng / chưa nạp): mã đúng dạng cũng bị bỏ, lý do nói rõ.
  assert.match(cardScanSkipReason(referralChange(conv, { ref: 'tmdt-01', source: 'SHORTLINK' }), { known: () => false }), /mã "tmdt-01" chưa tạo/);
});

test('referral bị bỏ qua: một dòng "QR: bỏ qua referral ref=… (lý do)", không hẹn chào; change thường không ghi gì', () => {
  const g = greeter();
  const conv = conversation('1:b');
  g.schedule([
    referralChange(conv, { ref: 'tmdt-99', source: 'SHORTLINK' }),
    referralChange(conv, { ref: 'ad-ref', source: 'ADS' }),
    { type: 'message', conversation: conv, message: { text: 'hi' } }
  ]);
  assert.equal(g.isPending(conv.id), false);
  assert.deepEqual(g.logs, [
    'QR: bỏ qua referral ref="tmdt-99" (mã "tmdt-99" chưa tạo ở Cài đặt → Mã QR) — Khách 1:b',
    'QR: bỏ qua referral ref="ad-ref" (nguồn ADS, không phải link m.me (SHORTLINK)) — Khách 1:b'
  ]);
});

test('giới hạn tần suất: cùng ref + lý do chỉ ghi một dòng mỗi 10 phút; ref lạ dài / có ký tự lạ được cắt gọn', () => {
  let clock = 1_000_000;
  const g = greeter({ now: () => clock });
  const skipped = psid => referralChange(conversation(`1:${psid}`), { ref: 'tmdt-99', source: 'SHORTLINK' });
  for (let index = 0; index < 50; index += 1) g.schedule([skipped(`k${index}`)]);
  assert.equal(g.logs.length, 1, '50 khách cùng mã lạ: một dòng');
  clock += 9 * 60 * 1000;
  g.schedule([skipped('sau-9-phut')]);
  assert.equal(g.logs.length, 1);
  clock += 2 * 60 * 1000;
  g.schedule([skipped('sau-11-phut')]);
  assert.equal(g.logs.length, 2, 'hết cửa sổ thì ghi lại');
  // ref khác → dòng riêng; ref do bên ngoài gửi: không đưa xuống dòng / ký tự điều khiển vào log, tối đa 60 ký tự.
  g.schedule([referralChange(conversation('1:z'), { ref: `dòng 1\ndòng 2 ${'x'.repeat(200)}`, source: 'SHORTLINK' })]);
  assert.equal(g.logs.length, 3);
  assert.doesNotMatch(g.logs[2], /\n/);
  assert.match(g.logs[2], /^QR: bỏ qua referral ref="d\?ng 1\?d\?ng 2 x{46}" \(ref không phải dạng mã thẻ\)/);
  // Rất nhiều ref khác nhau (ai đó tự gõ m.me?ref=…): bộ nhớ dấu vết có trần, vẫn chạy bình thường.
  for (let index = 0; index < 500; index += 1) g.schedule([referralChange(conversation('1:spam'), { ref: `la-${index}`, source: 'SHORTLINK' })]);
  assert.equal(g.logs.length, 503);
});

test('lượt quét thật vẫn chào như cũ, không sinh dòng "bỏ qua referral"', async () => {
  const g = greeter();
  const conv = conversation('1:c');
  g.schedule([referralChange(conv, { ref: 'tmdt-01', source: 'SHORTLINK' })]);
  assert.equal(g.isPending(conv.id), true);
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.equal(g.sent.length, 1);
  assert.ok(!g.logs.some(line => /bỏ qua referral/.test(line)));
});
