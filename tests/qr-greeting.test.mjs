import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { tempDir } from './helpers/temp-dir.mjs';

process.env.QR_SCANS_PATH = path.join(tempDir('qr-greet-'), 'qr-scans.json');

const { createQrGreeter, isCardScan } = await import('../app/qr-greeting.mjs');
const { registerQrCode } = await import('../app/qr-scans.mjs');

await registerQrCode('tmdt-01');

const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const conversation = (id, extra = {}) => ({ id, psid: id.split(':')[1], pageId: '1', name: `Khách ${id}`, ...extra });
const metaReferral = (conv, ref = 'tmdt-01') => ({ type: 'referral', conversation: conv, referral: { ref, source: 'SHORTLINK' } });
const botcake = (conv, ref = 'tmdt-01') => ({ type: 'message', conversation: conv, referral: { ref, source: 'SHORTLINK', type: 'BOTCAKE_OPTIN' }, message: { direction: 'outgoing', text: `Dạ cảm ơn… Mã thẻ: #${ref}` } });
const prefill = (conv, ref = 'tmdt-01') => ({ type: 'message', conversation: conv, referral: { ref, source: 'SHORTLINK', type: 'PREFILL_TEXT' }, message: { direction: 'incoming', text: `Cho mình nhận quà #${ref}` } });

function greeter(overrides = {}) {
  const sent = [];
  const logs = [];
  const instance = createQrGreeter({
    offerMessage: async () => 'Ưu đãi QR',
    send: async (conv, payload) => { sent.push({ id: conv.id, ...payload }); },
    delayMs: 40,
    cooldownMs: 10_000,
    log: line => logs.push(line),
    logError: line => logs.push(`ERR ${line}`),
    ...overrides
  });
  return { ...instance, sent, logs };
}

test('isCardScan: chỉ referral SHORTLINK với mã đã tạo; mã lạ, quảng cáo, thiếu referral đều không', () => {
  const conv = conversation('1:a');
  assert.equal(isCardScan(metaReferral(conv)), true);
  assert.equal(isCardScan(metaReferral(conv, 'cGFuY2FrZV91dG1fc291cmNlPXRtZHQtMDE')), true, 'ref mã hoá kiểu Pancake');
  assert.equal(isCardScan(metaReferral(conv, 'tmdt-99')), false, 'mã chưa tạo ở Cài đặt → Mã QR');
  assert.equal(isCardScan(metaReferral(conv, '123456')), false);
  assert.equal(isCardScan({ type: 'referral', conversation: conv, referral: { ref: 'tmdt-01', source: 'ADS' } }), false, 'quảng cáo có luồng riêng');
  assert.equal(isCardScan({ type: 'message', conversation: conv, message: { text: 'hi' } }), false);
  assert.equal(isCardScan(null), false);
});

test('khách quét qua Meta: chào sau delay một lần; quét lại trong cooldown không chào nữa', async () => {
  const g = greeter();
  const conv = conversation('1:a');
  g.schedule([metaReferral(conv)]);
  assert.equal(g.isPending(conv.id), true);
  g.schedule([metaReferral(conv)]);
  await pause(120);
  assert.equal(g.sent.length, 1);
  assert.equal(g.sent[0].text, 'Ưu đãi QR');
  assert.equal(g.isPending(conv.id), false);
  assert.ok(g.logs.some(line => /bỏ qua chào/.test(line)));
});

test('Botcake chào trong lúc CRM đang hẹn (referral Meta về trước): hủy hẹn, khách KHÔNG nhận hai tin', async () => {
  const g = greeter();
  const conv = conversation('1:b');
  g.schedule([metaReferral(conv)]);
  await pause(10);
  g.schedule([botcake(conv)]);
  assert.equal(g.isPending(conv.id), false, 'hẹn giờ đã bị hủy');
  await pause(120);
  assert.equal(g.sent.length, 0);
  assert.ok(g.logs.some(line => /hủy lượt chào CRM đang hẹn/.test(line)));
  // Tin soạn sẵn của khách về sau đó: đã có Botcake chào → cooldown, không chào.
  g.schedule([prefill(conv)]);
  await pause(120);
  assert.equal(g.sent.length, 0);
});

test('tin soạn sẵn về trước, tin Botcake về sau: vẫn hủy hẹn', async () => {
  const g = greeter();
  const conv = conversation('1:c');
  g.schedule([prefill(conv)]);
  assert.equal(g.isPending(conv.id), true);
  g.schedule([botcake(conv)]);
  await pause(120);
  assert.equal(g.sent.length, 0);
});

test('Botcake chào trước, referral Meta về sau: cooldown chặn, không chào', async () => {
  const g = greeter();
  const conv = conversation('1:d');
  g.schedule([botcake(conv)]);
  g.schedule([metaReferral(conv)]);
  assert.equal(g.isPending(conv.id), false);
  await pause(120);
  assert.equal(g.sent.length, 0);
});

// Sửa 02/10 theo quyết định chủ shop: trước đây test này khẳng định "bot tắt / nhân viên đang nhận → không
// chào". Nay vẫn gửi ưu đãi (bot không bật lại); chỉ bỏ qua khi nhân viên vừa nhắn trong 10 phút — xem
// tests/fix-meta-qr-staff-quiet.test.mjs.
test('bot tắt hoặc nhân viên đang nhận trong Pancake: VẪN gửi ưu đãi, trạng thái bot giữ nguyên', async () => {
  const g = greeter();
  const off = conversation('1:e', { botEnabled: false });
  const assigned = conversation('1:f', { pancakeAssigned: true });
  g.schedule([metaReferral(off), metaReferral(assigned)]);
  assert.equal(g.isPending('1:e'), true);
  assert.equal(g.isPending('1:f'), true);
  await pause(120);
  assert.deepEqual(g.sent.map(item => item.id).sort(), ['1:e', '1:f']);
  assert.equal(off.botEnabled, false, 'không bật lại bot');
  assert.ok(!g.logs.some(line => /bot tắt|nhân viên đang nhận/.test(line)));
});

test('mã lạ, thiếu psid: bỏ qua; mẫu QR_OFFER trống: không gửi và không giữ cooldown; gửi lỗi: thả cooldown để lần sau thử lại', async () => {
  const g = greeter({ offerMessage: async () => '' });
  g.schedule([metaReferral(conversation('1:g'), 'tmdt-99'), { type: 'referral', conversation: { id: '1:h' }, referral: { ref: 'tmdt-01', source: 'SHORTLINK' } }]);
  assert.equal(g.isPending('1:g'), false);
  assert.equal(g.isPending('1:h'), false);
  const empty = conversation('1:i');
  g.schedule([metaReferral(empty)]);
  await pause(120);
  assert.equal(g.sent.length, 0);
  assert.equal(g.greetedAt.has(empty.id), false, 'mẫu trống thì không tính là đã chào');

  const failing = greeter({ send: async () => { throw new Error('ngoài cửa sổ 24h'); } });
  const conv = conversation('1:k');
  failing.schedule([metaReferral(conv)]);
  await pause(120);
  assert.equal(failing.greetedAt.has(conv.id), false);
  assert.ok(failing.logs.some(line => /ERR .*ngoài cửa sổ 24h/.test(line)));
});

test('mẫu có ảnh: gửi ảnh rồi chữ theo đúng thứ tự phần trong mẫu', async () => {
  const g = greeter({ offerMessage: async () => [{ type: 'image', url: 'https://fb.giotnang.vn/assets/qr/uu-dai.png' }, { type: 'text', text: 'Ưu đãi cho chị' }] });
  const conv = conversation('1:img');
  g.schedule([metaReferral(conv)]);
  await pause(120);
  assert.deepEqual(g.sent, [{ id: conv.id, imageUrl: 'https://fb.giotnang.vn/assets/qr/uu-dai.png' }, { id: conv.id, text: 'Ưu đãi cho chị' }]);
  assert.ok(g.logs.some(line => /đã gửi ưu đãi .*ảnh\+chữ/.test(line)));
});
