// Vòng 02/10 (mô phỏng đầu-cuối + quyết định chủ shop):
//  1. Bot tắt / hội thoại đã phân công vẫn gửi ưu đãi QR; chỉ bỏ qua khi nhân viên vừa nhắn trong 10 phút.
//  2. ref viết hoa hoặc dán kèm "ref=" vẫn ra mã.
//  3. Mẫu QR_OFFER để trống → không gửi; mẫu còn câu giữ chỗ "SỬA NỘI DUNG ƯU ĐÃI" → không bao giờ gửi.
//  4. Dịch vụ sắp tắt: gửi ngay các lượt chào đang hẹn (flush).
import test from 'node:test';
import assert from 'node:assert/strict';

const { createQrGreeter, isCardScan, lastStaffMessageAt, resolveQrOfferTemplate } = await import('../app/qr-greeting.mjs');
const { qrCodeFromRef } = await import('../app/qr-bridge.mjs');
// Ref kiểu Pancake (base64url của `pancake_utm_source=<mã>`) — dữ liệu thử; app chỉ cần GIẢI mã (qrCodeFromRef).
const pancakeRef = code => Buffer.from(`pancake_utm_source=${code}`).toString('base64url');

const { registerQrCode } = await import('../app/qr-scans.mjs');
const { defaultMessageTemplates } = await import('../app/chatbot-templates.mjs');

await registerQrCode('tmdt-01');

const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const conversation = (id, extra = {}) => ({ id, psid: id.split(':')[1], pageId: '1', name: `Khách ${id}`, ...extra });
const scan = (conv, ref = 'tmdt-01') => ({ type: 'referral', conversation: conv, referral: { ref, source: 'SHORTLINK' } });
const minute = 60 * 1000;

function greeter(overrides = {}) {
  const sent = [];
  const logs = [];
  const instance = createQrGreeter({
    offerMessage: async () => 'Ưu đãi QR',
    send: async (conv, payload) => { sent.push({ id: conv.id, ...payload }); },
    delayMs: 30,
    cooldownMs: 10_000,
    log: line => logs.push(line),
    logError: line => logs.push(`ERR ${line}`),
    ...overrides
  });
  return { ...instance, sent, logs };
}

test('lastStaffMessageAt: chỉ tin gửi đi mang cờ staff; tin bot, bám đuổi, tự động Pancake, phiếu máy gửi thay, tin khách không tính', () => {
  assert.equal(lastStaffMessageAt(undefined), 0);
  assert.equal(lastStaffMessageAt([]), 0);
  const messages = [
    { direction: 'outgoing', staff: true, staffName: 'Lan', sender: 'staff', createdAt: 1000 },
    { direction: 'outgoing', staff: true, staffName: 'Lan', createdAt: 5000 },
    { direction: 'outgoing', sender: 'bot', createdAt: 6000 },
    { direction: 'outgoing', sender: 'staff', staffName: 'Lan', createdAt: 7000 },
    { direction: 'outgoing', staff: true, followUp: true, createdAt: 8000 },
    { direction: 'outgoing', pancakeSender: 'Public API', createdAt: 9000 },
    { direction: 'incoming', staff: true, createdAt: 9500 },
    null
  ];
  assert.equal(lastStaffMessageAt(messages), 5000);
});

test('bot tắt, nhân viên đang nhận: vẫn gửi ưu đãi khi nhân viên không nhắn gần đây; bot không bị bật lại', async () => {
  const staffAt = { '1:tat': 0, '1:nv': Date.now() - 11 * minute };
  const g = greeter({ staffLastMessageAt: async conv => staffAt[conv.id] || 0 });
  const off = conversation('1:tat', { botEnabled: false });
  const assigned = conversation('1:nv', { pancakeAssigned: true, botEnabled: false });
  g.schedule([scan(off), scan(assigned)]);
  await pause(100);
  assert.deepEqual(g.sent.map(item => item.id).sort(), ['1:nv', '1:tat']);
  assert.deepEqual([off.botEnabled, assigned.botEnabled, assigned.pancakeAssigned], [false, false, true], 'chỉ gửi tin, không đổi trạng thái hội thoại');
});

test('nhân viên vừa nhắn trong 10 phút: không chen tin ưu đãi, log nêu số phút, không giữ cooldown (quét lại sau đó vẫn được chào)', async () => {
  let staffAt = Date.now() - 3 * minute;
  const g = greeter({ staffLastMessageAt: async () => staffAt });
  const conv = conversation('1:dang-chat');
  g.schedule([scan(conv)]);
  await pause(100);
  assert.equal(g.sent.length, 0);
  assert.ok(g.logs.includes('QR: không chào Khách 1:dang-chat (nhân viên vừa nhắn 3 phút trước)'), g.logs.join('\n'));
  // Nhân viên ngừng nhắn quá 10 phút, khách quét lại: chào.
  staffAt = Date.now() - 10 * minute - 1000;
  g.schedule([scan(conv)]);
  await pause(100);
  assert.equal(g.sent.length, 1);
});

test('xét lúc GỬI chứ không phải lúc hẹn; ngưỡng đổi được (staffQuietMs, 0 = không né); đọc tin lỗi thì vẫn gửi', async () => {
  // Lúc hẹn chưa có tin nhân viên, trong mấy giây chờ nhân viên trả lời → không gửi.
  let staffAt = 0;
  const late = greeter({ staffLastMessageAt: async () => staffAt });
  late.schedule([scan(conversation('1:tre'))]);
  staffAt = Date.now();
  await pause(100);
  assert.equal(late.sent.length, 0);
  assert.ok(late.logs.some(line => /nhân viên vừa nhắn 0 phút trước/.test(line)));

  const short = greeter({ staffLastMessageAt: async () => Date.now() - 3 * minute, staffQuietMs: 2 * minute });
  short.schedule([scan(conversation('1:ngan'))]);
  const disabled = greeter({ staffLastMessageAt: async () => Date.now(), staffQuietMs: 0 });
  disabled.schedule([scan(conversation('1:khong-ne'))]);
  const broken = greeter({ staffLastMessageAt: async () => { throw new Error('kho hỏng'); } });
  broken.schedule([scan(conversation('1:loi-doc'))]);
  const sync = greeter({ staffLastMessageAt: () => { throw new Error('ném đồng bộ'); } });
  sync.schedule([scan(conversation('1:loi-dong-bo'))]);
  await pause(100);
  assert.equal(short.sent.length, 1, 'ngưỡng 2 phút, nhân viên nhắn 3 phút trước');
  assert.equal(disabled.sent.length, 1);
  assert.equal(broken.sent.length, 1, 'không đọc được tin nhân viên: vẫn gửi ưu đãi');
  assert.ok(broken.logs.some(line => /ERR QR: không đọc được tin nhân viên của Khách 1:loi-doc: kho hỏng/.test(line)));
  assert.equal(sync.sent.length, 1);
});

test('qrCodeFromRef: chữ hoa và tiền tố "ref=" vẫn ra mã; base64 Pancake và chuỗi base64 lạ giữ như cũ', () => {
  assert.equal(qrCodeFromRef('tmdt-01'), 'tmdt-01');
  assert.equal(qrCodeFromRef('TMDT-01'), 'tmdt-01');
  assert.equal(qrCodeFromRef('Tmdt-01'), 'tmdt-01');
  assert.equal(qrCodeFromRef('ref=tmdt-01'), 'tmdt-01');
  assert.equal(qrCodeFromRef(' REF=TMDT-01 '), 'tmdt-01');
  assert.equal(qrCodeFromRef('ref='), '');
  assert.equal(qrCodeFromRef(pancakeRef('tmdt-01')), 'tmdt-01', 'ref Pancake mã hoá (có chữ hoa) không bị hạ chữ thường nhầm thành mã');
  assert.equal(qrCodeFromRef(`ref=${pancakeRef('tmdt-01')}`), 'tmdt-01');
  assert.equal(qrCodeFromRef(Buffer.from('pancake_utm_source=TMDT-01').toString('base64url')), 'tmdt-01');
  assert.equal(qrCodeFromRef('ZXZpbA'), '', 'base64 của chữ đọc được ("evil") không phải mã thẻ');
  assert.equal(qrCodeFromRef('Khuyến mãi'), '');
  assert.equal(qrCodeFromRef('a'.repeat(41)), '');
  // Đầu-cuối tới bộ chào: ref viết hoa / có tiền tố được coi là lượt quét thẻ.
  const conv = conversation('1:hoa');
  assert.equal(isCardScan(scan(conv, 'TMDT-01')), true);
  assert.equal(isCardScan(scan(conv, 'ref=tmdt-01')), true);
  assert.equal(isCardScan(scan(conv, 'TMDT-99')), false, 'mã chưa tạo vẫn không phải thẻ thật');
});

test('resolveQrOfferTemplate: không có khoá → mẫu mặc định; chuỗi rỗng → không gửi; còn câu giữ chỗ → chặn', () => {
  assert.deepEqual(resolveQrOfferTemplate({ stored: 'Dạ em gửi {title} ưu đãi ạ', fallback: 'mặc định' }), { template: 'Dạ em gửi {title} ưu đãi ạ' });
  assert.deepEqual(resolveQrOfferTemplate({ stored: undefined, fallback: 'Mẫu mặc định' }), { template: 'Mẫu mặc định' });
  assert.deepEqual(resolveQrOfferTemplate({ stored: null, fallback: 'Mẫu mặc định' }), { template: 'Mẫu mặc định' });
  for (const empty of ['', '   ', '\n']) {
    const result = resolveQrOfferTemplate({ stored: empty, fallback: 'Mẫu mặc định' });
    assert.equal(result.template, '');
    assert.equal(result.skip, 'mẫu QR_OFFER để trống');
    assert.equal(result.warn, undefined);
  }
  assert.equal(resolveQrOfferTemplate({}).skip, 'mẫu QR_OFFER để trống');
  // Mẫu đi kèm mã nguồn hiện còn câu giữ chỗ: không có khoá cũng KHÔNG gửi nó cho khách.
  const seed = defaultMessageTemplates().QR_OFFER;
  assert.match(seed, /SỬA NỘI DUNG ƯU ĐÃI/);
  for (const stored of [undefined, seed, 'Dạ ưu đãi: 🎁 sửa nội dung ưu đãi tại Cài đặt', 'SỬA NỘI DUNG ƯU ĐÃI']) {
    const result = resolveQrOfferTemplate({ stored, fallback: seed });
    assert.equal(result.template, '');
    assert.equal(result.warn, true);
    assert.match(result.skip, /còn câu giữ chỗ/);
  }
});

test('bộ chào: offerMessage trả { skip } → không gửi, ghi lý do (cảnh báo khi warn), thả cooldown', async () => {
  const blocked = greeter({ offerMessage: async () => resolveQrOfferTemplate({ stored: defaultMessageTemplates().QR_OFFER }) });
  const conv = conversation('1:giu-cho');
  blocked.schedule([scan(conv)]);
  const empty = greeter({ offerMessage: async () => resolveQrOfferTemplate({ stored: '', fallback: 'Mẫu mặc định' }) });
  empty.schedule([scan(conversation('1:trong'))]);
  await pause(100);
  assert.equal(blocked.sent.length, 0);
  assert.ok(blocked.logs.some(line => /^ERR QR: KHÔNG gửi ưu đãi cho Khách 1:giu-cho: mẫu QR_OFFER còn câu giữ chỗ/.test(line)), blocked.logs.join('\n'));
  assert.equal(blocked.greetedAt.has(conv.id), false, 'sửa mẫu xong, khách quét lại là được chào');
  assert.equal(empty.sent.length, 0);
  assert.ok(empty.logs.includes('QR: KHÔNG gửi ưu đãi cho Khách 1:trong: mẫu QR_OFFER để trống'));
});

test('flush lúc dịch vụ sắp tắt: gửi ngay các lượt đang hẹn, mỗi lượt đúng một lần; không có lượt nào thì không làm gì', async () => {
  const idle = greeter();
  assert.equal(await idle.flush(), 0);
  assert.deepEqual(idle.logs, []);

  const g = greeter({ delayMs: 60_000 });
  const finished = [];
  g.schedule([scan(conversation('1:f1')), scan(conversation('1:f2'))], { afterGreeting: change => { finished.push(change.conversation.id); } });
  assert.equal(g.isPending('1:f1'), true);
  assert.equal(await g.flush({ timeoutMs: 1000 }), 2);
  assert.deepEqual(g.sent.map(item => item.id).sort(), ['1:f1', '1:f2']);
  assert.equal(g.isPending('1:f1'), false);
  assert.ok(g.logs.some(line => /dịch vụ sắp tắt, gửi ngay 2 lượt chào đang hẹn/.test(line)));
  await pause(10);
  assert.deepEqual(finished.sort(), ['1:f1', '1:f2'], 'vẫn trả luồng sau khi gửi');
  assert.equal(await g.flush(), 0, 'gọi lại không gửi lần hai');
  assert.equal(g.sent.length, 2);

  // Gửi chậm hơn hạn chờ: flush trả về đúng hạn, không ném lỗi, không treo việc tắt dịch vụ.
  const slow = greeter({ delayMs: 60_000, send: () => new Promise(resolve => setTimeout(resolve, 5_000).unref()) });
  slow.schedule([scan(conversation('1:cham'))]);
  const started = Date.now();
  assert.equal(await slow.flush({ timeoutMs: 50 }), 1);
  assert.ok(Date.now() - started < 1000);
  // Gửi lỗi trong lúc flush: bị bắt như thường.
  const failing = greeter({ delayMs: 60_000, send: async () => { throw new Error('mạng rớt'); } });
  failing.schedule([scan(conversation('1:loi'))]);
  assert.equal(await failing.flush({ timeoutMs: 1000 }), 1);
  assert.ok(failing.logs.some(line => /KHÔNG gửi được ưu đãi cho Khách 1:loi: mạng rớt/.test(line)));
});
