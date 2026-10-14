// 12/10 (chủ shop): khách quét thẻ cảm ơn, vào Messenger nhưng không nhắn → Page không được nhắn trước, CRM không biết
// khách là ai. Trang đệm /q/<mã> có ô "để lại số điện thoại" để giữ ưu đãi; nhân viên gọi / nhắn Zalo từ Cài đặt → Mã QR.
// Kiểm kho (app/qr-leads.mjs), trang đệm (renderBridgePage leadForm), công tắc ở qr-settings và đường HTTP thật.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tempDir } from './helpers/temp-dir.mjs';

const directory = tempDir('qr-leads-');
process.env.QR_LEADS_PATH = path.join(directory, 'qr-leads.json');
process.env.QR_SETTINGS_PATH = path.join(directory, 'qr-settings.json');

const { addQrLead, applyQrLeadLinks, createQrLeadLimiter, deleteQrLead, linkQrLeads, parseQrLeadInput, qrLeadMergeWindowMs, qrLeadsView, readQrLeads, updateQrLead } = await import('../app/qr-leads.mjs');
const { renderBridgePage } = await import('../app/qr-bridge.mjs');
const { readQrSettings, writeQrSettings } = await import('../app/qr-settings.mjs');

test('ô SĐT: nhận số di động VN mọi cách viết, từ chối số sai, tên tuỳ chọn', () => {
  assert.deepEqual(parseQrLeadInput({ phone: '0912 345 678', name: '  Chị   Lan ' }), { phone: '0912345678', name: 'Chị Lan' });
  assert.equal(parseQrLeadInput({ phone: '+84 912.345.678' }).phone, '0912345678');
  assert.equal(parseQrLeadInput({ phone: '912345678' }).phone, '0912345678', 'mất số 0 đầu');
  assert.equal(parseQrLeadInput({ phone: '0123456789' }).error.includes('chưa đúng'), true, 'đầu số không phải di động');
  assert.match(parseQrLeadInput({ phone: '' }).error, /nhập số/);
  assert.equal(parseQrLeadInput({ phone: '0912345678', name: 'x'.repeat(200) }).name.length, 80);
});

test('lưu khách để lại SĐT: cùng số trong 30 ngày gộp một dòng, dòng thử tách riêng, đổi trạng thái / ghi chú / xoá', async () => {
  const now = Date.UTC(2026, 9, 12, 3);
  const first = await addQrLead({ code: 'tmdt-01', phone: '0912345678', platform: 'ios', browser: 'safari', now });
  assert.equal(first.created, true);
  assert.equal(first.lead.status, 'new');
  const doubleTap = await addQrLead({ code: 'tmdt-01', phone: '0912345678', channel: 'messenger', now: now + 30_000 });
  assert.equal(doubleTap.lead.visits, 1, 'bấm lại trong 2 phút không đếm thêm lượt');
  assert.equal(doubleTap.lead.channel, 'messenger');
  const again = await addQrLead({ code: 'tmdt-01', phone: '+84912345678', name: 'Chị Lan', now: now + 180_000 });
  assert.equal(again.created, false, 'cùng số → cập nhật dòng cũ');
  assert.equal(again.lead.id, first.lead.id);
  assert.equal(again.lead.visits, 2);
  assert.equal(again.lead.name, 'Chị Lan');
  const staff = await addQrLead({ code: 'tmdt-01', phone: '0912345678', test: true, now: now + 190_000 });
  assert.equal(staff.created, true, 'máy nhân viên thử: dòng riêng, không gộp vào khách thật');
  assert.equal(staff.lead.test, true);

  await assert.rejects(updateQrLead(first.lead.id, { status: 'bogus' }), /không hợp lệ/);
  const called = await updateQrLead(first.lead.id, { status: 'invalid', note: 'Không nghe máy 2 lần' }, { by: 'Thúy Hằng', now: now + 200_000 });
  assert.deepEqual([called.status, called.note, called.updatedBy], ['invalid', 'Không nghe máy 2 lần', 'Thúy Hằng']);
  // Khách tự để lại lần nữa sau khi bị đánh "Sai số" → quay về Chưa liên hệ.
  const back = await addQrLead({ code: 'tmdt-01', phone: '0912345678', now: now + 300_000 });
  assert.equal(back.lead.status, 'new');
  // Quá 30 ngày: dòng mới.
  const later = await addQrLead({ code: 'tmdt-01', phone: '0912345678', now: now + 300_000 + qrLeadMergeWindowMs + 1 });
  assert.equal(later.created, true);

  assert.equal(await updateQrLead('khong-co', { status: 'called' }), null);
  assert.equal(await deleteQrLead(staff.lead.id), true);
  assert.equal(await deleteQrLead(staff.lead.id), false);
  const stored = JSON.parse(readFileSync(process.env.QR_LEADS_PATH, 'utf8'));
  assert.equal(stored.leads.length, 2);
  assert.equal((await readQrLeads()).leads.length, 2);
});

test('bảng nhân viên: mới nhất trước, "Đã mua" chỉ khi đơn đặt SAU lúc để lại số, đơn cũ hơn là "Khách cũ"', () => {
  const leads = [
    { id: 'a', phone: '0911111111', createdAt: 100, lastAt: 100 },
    { id: 'b', phone: '0922222222', createdAt: 200, lastAt: 500 },
    { id: 'c', phone: '0933333333', createdAt: 300, lastAt: 300 }
  ];
  const view = qrLeadsView(leads, { purchases: new Map([['0911111111', 150], ['0922222222', 50]]) });
  assert.deepEqual(view.map(item => item.id), ['b', 'c', 'a']);
  assert.deepEqual(view.map(item => [item.purchasedAt, item.boughtBefore]), [[0, true], [0, false], [150, false]]);
});

test('chặn gửi dồn: tối đa N lượt mỗi máy trong một giờ', () => {
  const limiter = createQrLeadLimiter({ max: 2, windowMs: 1000 });
  assert.equal(limiter.allow('ip', 0), true);
  assert.equal(limiter.allow('ip', 10), true);
  assert.equal(limiter.allow('ip', 20), false);
  assert.equal(limiter.allow('ip-khac', 20), true);
  assert.equal(limiter.allow('ip', 1100), true, 'hết cửa sổ thì gửi lại được');
});

test('trang đệm: ô SĐT bắt buộc, chỉ một nút "Lưu ưu đãi qua Messenger" (không nút riêng), tắt thì như cũ', () => {
  const base = { code: 'tmdt-01', destination: 'https://m.me/1?ref=tmdt-01', pageName: 'Giọt Nắng', classification: { platform: 'ios', browser: 'safari', inApp: false } };
  const on = renderBridgePage({ ...base, leadForm: true });
  assert.match(on, /<form class="lead" id="lead" method="post" action="\/q\/tmdt-01\/lead"/);
  assert.match(on, /name="phone" type="tel"/);
  assert.match(on, /class="lead-trap" name="website"/);
  assert.match(on, /Bấm “Lưu ưu đãi” là Anh\/Chị đồng ý để Nhà Nắng gọi hoặc nhắn Zalo/);
  assert.doesNotMatch(on, /Giữ ưu đãi|lead-send|lead-or/, 'không còn nút xanh "Giữ ưu đãi" và chữ "hoặc"');
  assert.equal((on.match(/Lưu ưu đãi<small>qua Messenger/g) || []).length, 2, 'nút trong phiếu + thanh bám đáy');
  assert.match(on, /id="open" href="fb-messenger-public:\/\/user-thread\/1\?intent_trigger=mme&amp;ref=tmdt-01&amp;source_id=1441792&amp;nav=discover"/);
  assert.match(on, /id="open-sticky" href="fb-messenger-public:\/\/user-thread\/1\?intent_trigger=mme&amp;ref=tmdt-01/);
  // Lượt mở Messenger chỉ đếm khi đã có số (guard), không đếm ngay lúc chạm như trang cũ.
  assert.doesNotMatch(on, /arm\(open, 'messenger'\)/);
  assert.match(on, /guard\(open, 'messenger'\)/);
  assert.match(on, /guard\(document\.getElementById\('zalo'\), 'zalo'\)/);
  new Function(on.match(/<script>([\s\S]*)<\/script>/)[1]);

  const off = renderBridgePage(base);
  assert.doesNotMatch(off, /id="lead"/);
  assert.match(off, /id="open-sticky" href="fb-messenger-public:/);
  assert.match(off, /arm\(document\.getElementById\('open-sticky'\), 'messenger'\)/);
  new Function(off.match(/<script>([\s\S]*)<\/script>/)[1]);
});

test('công tắc ô SĐT ở Cài đặt → Mã QR: mặc định bật, lưu bật/tắt không đụng ô khác', async () => {
  assert.equal((await readQrSettings()).leadForm, true);
  await writeQrSettings({ zaloUrl: 'https://zalo.me/g/abc' });
  assert.equal((await writeQrSettings({ leadForm: false })).leadForm, false);
  const saved = await readQrSettings();
  assert.deepEqual([saved.leadForm, saved.zaloUrl], [false, 'https://zalo.me/g/abc']);
  assert.equal((await writeQrSettings({ prefillText: '' })).leadForm, false, 'lưu ô khác giữ nguyên công tắc');
  assert.equal((await writeQrSettings({ leadForm: true })).leadForm, true);
});

test('13/10: khách để lại số + hội thoại đã nhận ưu đãi QR + thẻ Re-marketing → "Đã gửi mess" (nối theo SĐT hoặc giờ quét)', async () => {
  const at = Date.UTC(2026, 9, 13, 2, 25);
  const minute = 60_000;
  const greeted = { qrGreetedAt: at + minute, labels: ['remarketing-tag'], source: 'inbox' };
  const leads = [
    { id: 'theo-gio', phone: '0824718150', status: 'new', channel: 'messenger', createdAt: at, lastAt: at },
    { id: 'theo-so', phone: '0933891226', status: 'new', channel: 'zalo', createdAt: at - 600 * minute, lastAt: at - 600 * minute },
    { id: 'da-goi', phone: '0943869323', status: 'called', channel: 'messenger', createdAt: at, lastAt: at },
    { id: 'thu', phone: '0913402007', status: 'new', test: true, createdAt: at, lastAt: at }
  ];
  const conversations = [
    // Lượt quét Meta 20 giây sau lúc khách để lại số qua nút Messenger.
    { id: 'p:1', ...greeted, qrReferrals: [{ ref: 'tmdt-01', at: at + 20_000 }] },
    // Khách nhắn số trong hội thoại (Zalo trước, Messenger sau): nối theo SĐT dù giờ không khớp.
    { id: 'p:2', ...greeted, qrReferrals: [{ ref: 'tmdt-01', at: at - 300 * minute }] },
    // Có lượt quét đúng giờ nhưng CHƯA gửi ưu đãi / chưa có thẻ: không tính.
    { id: 'p:3', labels: ['remarketing-tag'], qrReferrals: [{ at: at + 30_000 }] },
    { id: 'p:4', qrGreetedAt: at + minute, labels: [], qrReferrals: [{ at: at + 30_000 }] }
  ];
  const messages = { 'p:2': [{ direction: 'incoming', text: 'số em 0933 891 226 nha' }] };
  const links = linkQrLeads(leads, { conversations, messages, remarketingLabels: ['remarketing-tag'], now: at + 10 * minute });
  assert.deepEqual(links.map(link => [link.id, link.conversationId]).sort(), [['theo-gio', 'p:1'], ['theo-so', 'p:2']]);
  assert.equal(links.find(link => link.id === 'theo-gio').messagedAt, at + minute);
  assert.deepEqual(linkQrLeads(leads, { conversations, messages, remarketingLabels: [] }), [], 'chưa có thẻ Re-marketing trong cài đặt → không nối');

  // Hai khách để lại số cùng lúc, chỉ một hội thoại khớp giờ → không đoán.
  const twin = [
    { id: 'a', phone: '0911111111', status: 'new', channel: 'messenger', createdAt: at, lastAt: at },
    { id: 'b', phone: '0922222222', status: 'new', channel: 'messenger', createdAt: at + 30_000, lastAt: at + 30_000 }
  ];
  assert.deepEqual(linkQrLeads(twin, { conversations: [conversations[0]], remarketingLabels: ['remarketing-tag'], now: at }), []);
  // Khách chọn Zalo: không nối theo giờ (hội thoại Messenger cùng giờ là của người khác).
  assert.deepEqual(linkQrLeads([{ ...twin[0], channel: 'zalo' }], { conversations: [conversations[0]], remarketingLabels: ['remarketing-tag'], now: at }), []);

  // Ghi: chỉ đổi dòng còn "Chưa liên hệ"; nhân viên vừa chọn trạng thái khác thì giữ.
  const saved = await addQrLead({ code: 'tmdt-01', phone: '0824718150', channel: 'messenger', now: at });
  const other = await addQrLead({ code: 'tmdt-01', phone: '0988777666', channel: 'messenger', now: at });
  await updateQrLead(other.lead.id, { status: 'called' }, { by: 'NV', now: at + 1 });
  const changed = await applyQrLeadLinks([
    { id: saved.lead.id, conversationId: 'p:1', messagedAt: at + minute },
    { id: other.lead.id, conversationId: 'p:9', messagedAt: at + minute }
  ], { now: at + 2 * minute });
  assert.equal(changed, 1);
  const rows = (await readQrLeads()).leads;
  const done = rows.find(lead => lead.id === saved.lead.id);
  assert.deepEqual([done.status, done.conversationId, done.messagedAt, done.updatedBy], ['messaged', 'p:1', at + minute, 'Tự động']);
  assert.equal(rows.find(lead => lead.id === other.lead.id).status, 'called');
  assert.equal(await applyQrLeadLinks([{ id: saved.lead.id, conversationId: 'p:5' }]), 0, 'đã nối thì không nối lại');
});

// ===== Đường HTTP thật: máy chủ trên kho tạm (quiet-console) =====
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = 21000 + Math.floor(Math.random() * 20000);
const baseUrl = `http://127.0.0.1:${port}`;
const httpDir = tempDir('qr-leads-http-');
const httpLeads = path.join(httpDir, 'qr-leads.json');
const landingPath = path.join(httpDir, 'landing.json');
mkdirSync(httpDir, { recursive: true });
// Đơn gọi điện của số 0908527342 đặt SAU lúc khách để lại số (mốc xa trong tương lai) → bảng hiện "Đã mua".
writeFileSync(landingPath, JSON.stringify({
  orders: [{ id: 'lp1', name: 'Khách', phone: '0908527342', address: '12 Lê Lợi, Phường Bến Nghé, Quận 1, TP Hồ Chí Minh', products: [{ name: 'Granola Túi Xanh 450g', sku: 'GRA-XANH-Z450', quantity: 1 }], total: 189000, status: 'Mới', source: 'Gọi điện', createdAt: Date.now() + 3_600_000, landing: { externalId: 'x', page: 'giotnang.vn' } }],
  recent: []
}));

function startServer() {
  const child = spawn(process.execPath, [path.join(projectRoot, 'app', 'server.mjs'), String(port)], {
    cwd: projectRoot,
    env: {
      ...process.env,
      NODE_TEST_CONTEXT: '',
      CRM_SKIP_ENV_FILE: '1',
      CRM_REQUIRE_LOGIN: '0',
      CRM_LOGIN_USERS: '',
      PUBLIC_BASE_URL: baseUrl,
      META_APP_SECRET: 'qr-leads-secret',
      POS_SYNC_DISABLED: '1',
      PANCAKE_PAGE_ID: '',
      PANCAKE_PAGES: '',
      PANCAKE_PAGE_ACCESS_TOKEN: '',
      LANDING_WEBHOOK_TOKEN: '',
      META_ADS_SYNC_DISABLED: '1',
      QR_PAGE_ID: '103549382215599',
      QR_PAGE_NAME: 'Giọt Nắng',
      QR_LEADS_PATH: httpLeads,
      QR_SETTINGS_PATH: path.join(httpDir, 'qr-settings.json'),
      QR_SCANS_PATH: path.join(httpDir, 'qr-scans.json'),
      LANDING_ORDERS_PATH: landingPath,
      QR_LEAD_MAX_PER_HOUR: '3'
    },
    stdio: ['ignore', 'ignore', 'ignore']
  });
  test.after(() => { child.kill(); });
}

async function waitForServer() {
  for (let attempt = 0; attempt < 150; attempt += 1) {
    try { if ((await fetch(`${baseUrl}/api/health`)).ok) return; } catch { /* đang khởi động */ }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Máy chủ không khởi động kịp.');
}

const iphone = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
// Trang đệm đặt Referrer-Policy no-referrer nên trình duyệt gửi `Origin: null` — luật chống CSRF không được chặn form này.
const postLead = (body, { json = true } = {}) => fetch(`${baseUrl}/q/tmdt-01/lead`, {
  method: 'POST',
  headers: { 'Content-Type': json ? 'application/json' : 'application/x-www-form-urlencoded', Origin: 'null', 'User-Agent': iphone },
  body: json ? JSON.stringify(body) : new URLSearchParams(body).toString()
});

test('HTTP: trang quét có ô SĐT, khách gửi số → bảng nhân viên thấy, đổi trạng thái, máy tắt JS nhận trang cảm ơn, gửi dồn bị chặn', { timeout: 40000 }, async () => {
  startServer();
  await waitForServer();
  const page = await (await fetch(`${baseUrl}/q/tmdt-01`, { headers: { 'User-Agent': iphone } })).text();
  assert.match(page, /id="lead"/);

  const bad = await postLead({ phone: '0123' });
  assert.equal(bad.status, 400);
  assert.match((await bad.json()).error, /chưa đúng/);

  const trap = await postLead({ phone: '0911000222', website: 'http://spam' });
  assert.equal(trap.status, 200, 'máy tự điền: trả như đã lưu');

  const ok = await postLead({ phone: '0908 527 342', name: 'Chị Thử' });
  assert.equal(ok.status, 200);
  assert.deepEqual(await ok.json(), { saved: true, phone: '0908 527 342', message: 'Nhà Nắng sẽ gọi hoặc nhắn Zalo số 0908 527 342 sớm nhất ạ.' });

  // Trang đệm gửi số bằng sendBeacon dạng form (urlencoded) kèm kênh khách bấm.
  const form = await postLead({ phone: '+84 912 000 333', name: 'Bác Ba', via: 'zalo' }, { json: false });
  assert.equal(form.status, 200);
  assert.match(form.headers.get('content-type'), /text\/html/);
  assert.match(await form.text(), /Em đã giữ ưu đãi cho Anh\/Chị/);

  const list = await (await fetch(`${baseUrl}/api/qr/leads`)).json();
  assert.deepEqual(list.items.map(item => item.phone).sort(), ['0908527342', '0912000333'], 'số bẫy không vào bảng');
  const lead = list.items.find(item => item.phone === '0908527342');
  assert.deepEqual([lead.name, lead.platform, lead.browser, lead.code, lead.test], ['Chị Thử', 'ios', 'safari', 'tmdt-01', false]);
  assert.ok(lead.purchasedAt > 0, 'có đơn cùng số đặt sau → Đã mua');
  assert.equal(list.items.find(item => item.phone === '0912000333').channel, 'zalo');
  assert.equal(list.statuses.called, 'Đã gọi');

  const patched = await fetch(`${baseUrl}/api/qr/leads/${lead.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'called', note: 'Hẹn 17h' }) });
  assert.equal(patched.status, 200);
  assert.deepEqual(((body) => [body.status, body.note])(await patched.json()), ['called', 'Hẹn 17h']);
  assert.equal((await fetch(`${baseUrl}/api/qr/leads/${lead.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'x' }) })).status, 400);

  // QR_LEAD_MAX_PER_HOUR=3: đã có 2 lượt hợp lệ (lượt sai số và lượt bẫy không tính) → lượt 3 qua, lượt 4 bị chặn.
  assert.equal((await postLead({ phone: '0977000444' })).status, 200);
  assert.equal((await postLead({ phone: '0977000555' })).status, 429);

  // Tắt ô SĐT → trang quét không còn form.
  await fetch(`${baseUrl}/api/qr/settings`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ leadForm: false }) });
  assert.doesNotMatch(await (await fetch(`${baseUrl}/q/tmdt-01`, { headers: { 'User-Agent': iphone } })).text(), /id="lead"/);

  assert.equal((await fetch(`${baseUrl}/api/qr/leads/${lead.id}`, { method: 'DELETE' })).status, 200);
  assert.ok(existsSync(httpLeads));
  assert.equal(JSON.parse(readFileSync(httpLeads, 'utf8')).leads.length, 2);
});
