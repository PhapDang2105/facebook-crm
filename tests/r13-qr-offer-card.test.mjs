// Vòng 13 (02/10): (1) ưu đãi QR do CRM gửi kèm ẢNH THẺ như tin Botcake; (2) mốc "đã chào" lưu bền — khởi động
// lại không chào lần hai (ca thật 02/10 10:42: khách đã chốt đơn nhận ưu đãi lần hai sau khi dịch vụ khởi động lại).
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFileSync, statSync } from 'node:fs';
import { tempDir } from './helpers/temp-dir.mjs';

process.env.QR_SCANS_PATH = path.join(tempDir('r13-qr-card-'), 'qr-scans.json');

const { createQrGreeter, withOfferCardImage } = await import('../app/qr-greeting.mjs');
const { registerQrCode } = await import('../app/qr-scans.mjs');

await registerQrCode('tmdt-01');

const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
// r13-glue (ổn định test): khẳng định "đã gửi / đã ghi" KHÔNG dựa vào một quãng chờ cố định — máy bận (nhiều tệp test chạy
// song song) thì hẹn giờ trễ hơn quãng chờ và test đỏ ngẫu nhiên. Chờ tới khi điều kiện đúng (tối đa 15 giây); quãng chờ cố
// định chỉ còn dùng cho khẳng định "KHÔNG gửi gì" (trễ không làm sai kết quả).
async function until(predicate, label, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() > deadline) assert.fail(`hết giờ chờ: ${label}`);
    await pause(10);
  }
}
const conversation = (id, extra = {}) => ({ id, psid: id.split(':')[1], pageId: '1', name: `Khách ${id}`, ...extra });
const scan = conv => ({ type: 'referral', conversation: conv, referral: { ref: 'tmdt-01', source: 'SHORTLINK' } });
const text = 'Em gửi Anh/Chị thẻ ưu đãi cho những đơn hàng sau ạ 💛';

function greeter(overrides = {}) {
  const sent = [];
  const logs = [];
  const instance = createQrGreeter({
    offerMessage: async () => [{ type: 'text', text }],
    send: async (conv, payload) => { sent.push({ id: conv.id, ...payload }); },
    delayMs: 30,
    cooldownMs: 6 * 60 * 60 * 1000,
    log: line => logs.push(line),
    logError: line => logs.push(`ERR ${line}`),
    ...overrides
  });
  return { ...instance, sent, logs };
}

test('withOfferCardImage: mẫu chỉ có chữ → thêm ảnh thẻ lên ĐẦU (URL https tuyệt đối); mẫu đã có ảnh, base không https, thiếu tệp hay tắt → giữ nguyên', () => {
  const parts = [{ type: 'text', text }];
  assert.deepEqual(withOfferCardImage(parts, { baseUrl: 'https://fb.giotnang.vn' }), [
    { type: 'image', url: 'https://fb.giotnang.vn/q/brand/offer-card.png', optional: true },
    { type: 'text', text }
  ]);
  assert.deepEqual(withOfferCardImage(parts, { baseUrl: 'https://fb.giotnang.vn/' })[0].url, 'https://fb.giotnang.vn/q/brand/offer-card.png', 'không nhân đôi dấu /');
  const own = [{ type: 'image', url: 'https://cdn.example.com/the.jpg' }, { type: 'text', text }];
  assert.equal(withOfferCardImage(own, { baseUrl: 'https://fb.giotnang.vn' }), own, 'mẫu QR_OFFER tự chứa ảnh ![](…) thì không thêm');
  assert.equal(withOfferCardImage(parts, { baseUrl: 'http://127.0.0.1:8080' }), parts, 'base không https: chỉ gửi chữ');
  assert.equal(withOfferCardImage(parts, { baseUrl: '' }), parts);
  assert.equal(withOfferCardImage(parts, { baseUrl: 'https://fb.giotnang.vn', available: false }), parts, 'thiếu tệp ảnh: chỉ gửi chữ');
  assert.equal(withOfferCardImage(parts, { baseUrl: 'https://fb.giotnang.vn', enabled: false }), parts, 'QR_OFFER_IMAGE=0');
  assert.deepEqual(withOfferCardImage([], { baseUrl: 'https://fb.giotnang.vn' }), [], 'mẫu trống thì vẫn trống (không gửi riêng ảnh)');
});

test('tệp ảnh thẻ có trong mã nguồn (PNG ≤ 300 KB) và được phục vụ công khai ở /q/brand/offer-card.png với đúng Content-Type', () => {
  const file = new URL('../assets/branding/offers/the-uu-dai.png', import.meta.url);
  const size = statSync(file).size;
  assert.ok(size > 10_000 && size <= 300 * 1024, `kích thước ${size}`);
  assert.deepEqual([...readFileSync(file).subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 'chữ ký PNG');
  const source = readFileSync(new URL('../app/server.mjs', import.meta.url), 'utf8').replace(/\r/g, '');
  assert.match(source, /const qrOfferCardRoute = '\/q\/brand\/offer-card\.png';/);
  // R13 (gộp): bảng ảnh /q/brand/* còn MỘT nguồn (brandImageFiles của pancake.mjs) — server dùng lại, không chép.
  assert.match(source, /const qrBrandFiles = brandImageFiles;/);
  const pancakeSource = readFileSync(new URL('../app/pancake.mjs', import.meta.url), 'utf8').replace(/\r/g, '');
  assert.match(pancakeSource, /'\/q\/brand\/offer-card\.png': 'offers\/the-uu-dai\.png'/);
  assert.match(source, /'\.png': 'image\/png'/);
  assert.match(source, /enabled: String\(process\.env\.QR_OFFER_IMAGE \?\? ''\)\.trim\(\) !== '0'/);
  assert.ok(!/'Content-Type': 'image\/webp', 'Cache-Control': 'public, max-age=86400'/.test(source), 'không còn viết cứng image/webp cho mọi tệp /q/brand');
});

test('bộ chào gửi ảnh thẻ trước, chữ sau; ảnh thẻ (optional) gửi lỗi thì vẫn gửi chữ, ảnh trong mẫu (không optional) lỗi thì báo lỗi như cũ', async () => {
  const withCard = () => withOfferCardImage([{ type: 'text', text }], { baseUrl: 'https://fb.giotnang.vn' });
  const ok = greeter({ offerMessage: async () => withCard() });
  ok.schedule([scan(conversation('1:a'))]);
  await until(() => ok.logs.some(line => /đã gửi ưu đãi cho Khách 1:a/.test(line)), 'gửi ảnh thẻ + chữ cho 1:a');
  assert.deepEqual(ok.sent.map(item => (item.imageUrl ? 'ảnh' : 'chữ')), ['ảnh', 'chữ']);
  assert.equal(ok.sent[0].imageUrl, 'https://fb.giotnang.vn/q/brand/offer-card.png');
  assert.ok(ok.logs.some(line => /đã gửi ưu đãi cho Khách 1:a \(ảnh\+chữ\)/.test(line)));

  const sent = [];
  const broken = greeter({
    offerMessage: async () => withCard(),
    send: async (conv, payload) => {
      if (payload.imageUrl) throw new Error('Không tải được ảnh (502).');
      sent.push(payload);
    }
  });
  broken.schedule([scan(conversation('1:b'))]);
  await until(() => broken.logs.some(line => /đã gửi ưu đãi cho Khách 1:b/.test(line)), 'gửi phần chữ cho 1:b');
  assert.deepEqual(sent, [{ text }], 'ảnh thẻ lỗi: khách vẫn nhận phần chữ');
  assert.ok(broken.logs.some(line => /ERR QR: không gửi được ảnh thẻ cho Khách 1:b \(Không tải được ảnh \(502\)\.\), gửi phần chữ/.test(line)), broken.logs.join('\n'));
  assert.ok(broken.logs.some(line => /đã gửi ưu đãi cho Khách 1:b \(chữ\)/.test(line)));

  const strict = greeter({
    offerMessage: async () => [{ type: 'image', url: 'https://cdn.example.com/the.jpg' }, { type: 'text', text }],
    send: async (conv, payload) => { if (payload.imageUrl) throw new Error('ảnh hỏng'); }
  });
  strict.schedule([scan(conversation('1:c'))]);
  await until(() => strict.logs.some(line => /ERR QR: KHÔNG gửi được ưu đãi cho Khách 1:c/.test(line)), 'báo lỗi gửi cho 1:c');
  assert.ok(strict.logs.some(line => /ERR QR: KHÔNG gửi được ưu đãi cho Khách 1:c: ảnh hỏng/.test(line)), strict.logs.join('\n'));
});

test('mốc đã chào lưu bền: gửi xong ghi kho; bộ chào dựng lại (khởi động lại) đọc mốc → không chào lần hai trong 6 giờ, hết 6 giờ thì chào lại', async () => {
  const saved = new Map();
  const store = {
    load: async () => [...saved.entries()],
    save: async (conv, at) => { saved.set(conv.id, at); }
  };
  let current = 1_790_000_000_000;
  const now = () => current;
  const first = greeter({ greetedStore: store, now });
  const conv = conversation('1:d');
  first.schedule([scan(conv)]);
  await until(() => first.sent.length >= 1 && saved.has('1:d'), 'gửi ưu đãi + ghi mốc cho 1:d');
  assert.equal(first.sent.length, 1);
  assert.equal(saved.get('1:d'), current, 'mốc ghi kho sau khi gửi xong');

  // Khởi động lại 5 phút sau: bộ chào mới, RAM trống.
  current += 5 * 60 * 1000;
  const second = greeter({ greetedStore: store, now });
  // Lượt quét về TRƯỚC khi đọc xong kho cũng không được chào lại (xét lại mốc lúc gửi).
  second.schedule([scan(conv)]);
  await until(() => second.logs.some(line => /QR: bỏ qua chào Khách 1:d \(đã chào cách đây 5 phút/.test(line)), 'bộ chào mới bỏ qua 1:d theo mốc trong kho');
  assert.equal(second.sent.length, 0);
  assert.ok(second.logs.some(line => /QR: bỏ qua chào Khách 1:d \(đã chào cách đây 5 phút, mốc lưu trong kho\)/.test(line)), second.logs.join('\n'));
  await second.ready;
  second.schedule([scan(conv)]);
  await pause(100);
  assert.equal(second.sent.length, 0);
  assert.ok(second.logs.some(line => /QR: bỏ qua chào Khách 1:d \(vừa chào cách đây 300s\)/.test(line)), second.logs.join('\n'));

  // Trường qrGreetedAt trên hội thoại (bản trong kho) cũng đủ, không cần greetedStore.
  const third = greeter({ now });
  third.schedule([scan(conversation('1:e', { qrGreetedAt: current - 60_000 }))]);
  await pause(100);
  assert.equal(third.sent.length, 0);

  // Hết 6 giờ: chào lại được.
  current += 6 * 60 * 60 * 1000;
  const fourth = greeter({ greetedStore: store, now });
  await fourth.ready;
  fourth.schedule([scan(conv)]);
  await until(() => fourth.sent.length >= 1, 'hết 6 giờ: chào lại 1:d');
  assert.equal(fourth.sent.length, 1);
});

test('Botcake đã chào cũng ghi mốc bền; gửi lỗi hay bị bỏ qua thì KHÔNG ghi mốc', async () => {
  const saved = new Map();
  const store = { load: async () => [], save: async (conv, at) => { saved.set(conv.id, at); } };
  const g = greeter({ greetedStore: store });
  const conv = conversation('1:f');
  g.schedule([{ type: 'message', conversation: conv, referral: { ref: 'tmdt-01', source: 'SHORTLINK', type: 'BOTCAKE_OPTIN' }, message: { direction: 'outgoing', text: 'Mã thẻ: #tmdt-01' } }]);
  await until(() => saved.get('1:f') > 0, 'ghi mốc Botcake đã chào 1:f');
  assert.ok(saved.get('1:f') > 0);
  const failing = greeter({ greetedStore: store, send: async () => { throw new Error('ngoài cửa sổ 24 giờ'); } });
  failing.schedule([scan(conversation('1:g'))]);
  await until(() => failing.logs.some(line => /^ERR /.test(line)), 'báo lỗi gửi cho 1:g');
  await pause(30);
  assert.equal(saved.has('1:g'), false);
  const staffBusy = greeter({ greetedStore: store, staffLastMessageAt: async () => Date.now() - 60_000 });
  staffBusy.schedule([scan(conversation('1:h'))]);
  await pause(100);
  assert.equal(saved.has('1:h'), false);
});

test('hội thoại có đơn tạo trong 6 giờ qua: không gửi ưu đãi; đơn cũ hơn thì gửi; độ trễ riêng cho từng lượt hẹn (delayMs)', async () => {
  const recent = greeter({ recentOrderAt: async () => Date.now() - 20 * 60 * 1000 });
  recent.schedule([scan(conversation('1:i'))]);
  await until(() => recent.logs.some(line => /QR: không chào Khách 1:i/.test(line)), 'bộ chào xét xong 1:i');
  assert.equal(recent.sent.length, 0);
  assert.ok(recent.logs.some(line => /QR: không chào Khách 1:i \(hội thoại có đơn tạo 20 phút trước\)/.test(line)), recent.logs.join('\n'));
  const old = greeter({ recentOrderAt: async () => Date.now() - 3 * 24 * 60 * 60 * 1000 });
  old.schedule([scan(conversation('1:j'))]);
  await until(() => old.sent.length >= 1, 'đơn cũ: vẫn chào 1:j');
  assert.equal(old.sent.length, 1);
  const immediate = greeter({ delayMs: 5000 });
  // (Bộ chào mặc định chờ 5 giây; lượt hẹn delayMs 0 phải gửi sớm hơn hẳn — hạn chờ 3 giây.)
  immediate.schedule([scan(conversation('1:k'))], { delayMs: 0 });
  await until(() => immediate.sent.length >= 1, 'lượt hẹn delayMs 0 gửi ngay', 3000);
  assert.equal(immediate.sent.length, 1, 'delayMs của lượt hẹn thắng độ trễ mặc định');
  assert.ok(immediate.logs.some(line => /sẽ chào sau 0s/.test(line)));
});
