import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

process.env.PHONE_WARNINGS_PATH = path.join(mkdtempSync(path.join(tmpdir(), 'warnings-')), 'phone-warnings.json');

const {
  assessPhone,
  fetchPosPhoneReport,
  listManualWarnings,
  lookupPhone,
  lookupPhones,
  removeManualWarning,
  setManualWarning,
  attachPhoneWarning
} = await import('../app/phone-warnings.mjs');

const posConfig = { apiKey: 'k', shopId: '1', baseUrl: 'https://pos.example/api/v1' };

function posFetch({ orders = [], customers = [] } = {}) {
  const calls = [];
  const fetchImpl = async url => {
    calls.push(String(url));
    const body = String(url).includes('/orders') ? { data: orders } : { data: customers };
    return { ok: true, json: async () => body };
  };
  fetchImpl.calls = calls;
  return fetchImpl;
}

test('đánh giá mức cảnh báo từ POS: 2 đơn hoàn → high, 1 đơn → watch, chặn → block', () => {
  assert.equal(assessPhone().level, 'none');
  assert.equal(assessPhone({ pos: { failed: 1, success: 5 } }).level, 'watch');
  assert.equal(assessPhone({ pos: { failed: 2, success: 5 } }).level, 'high');
  assert.equal(assessPhone({ pos: { failed: 1, success: 1 } }).level, 'high', 'tỷ lệ hoàn 50%');
  assert.equal(assessPhone({ pos: { failed: 0, success: 0, report: { fail: 3, success: 1, warning: 1 } } }).level, 'high');
  assert.equal(assessPhone({ pos: { failed: 0, success: 3, customer: { isBlock: true } } }).level, 'block');
  assert.equal(assessPhone({ pos: { failed: 0, success: 3, customer: { tags: ['Thường xuyên hoàn'] } } }).level, 'watch');
  assert.equal(assessPhone({ pos: { error: 'mạng' } }).level, 'none');
  assert.equal(assessPhone({ manual: { level: 'watch', incidents: 2 } }).level, 'high', 'nhân viên ghi bom 2 lần');
});

test('tra POS: đếm đơn hoàn/huỷ và thành công của đúng số, đọc reports_by_phone và khách bị chặn', async () => {
  const fetchImpl = posFetch({
    orders: [
      { status: 5, bill_phone_number: '0909123456', reports_by_phone: { '0909123456': { order_fail: 2, order_success: 1, warning: 1 } } },
      { status: 3, bill_phone_number: '0909123456' },
      { status: 6, shipping_address: { phone_number: '+84909123456' } },
      { status: 3, bill_phone_number: '0909999999' }
    ],
    customers: [{ id: 'c1', phone_numbers: ['0909123456'], is_block: false, tags: [{ name: 'Thường xuyên hoàn' }], order_count: 3, succeed_order_count: 1 }]
  });
  const report = await fetchPosPhoneReport('0909 123 456', { config: posConfig, fetchImpl });
  assert.equal(report.orders, 3);
  assert.equal(report.failed, 2);
  assert.equal(report.success, 1);
  assert.deepEqual(report.report, { fail: 2, success: 1, warning: 1 });
  assert.deepEqual(report.customer.tags, ['Thường xuyên hoàn']);
  assert.match(fetchImpl.calls[0], /\/shops\/1\/orders\?api_key=k&search=0909123456&page_size=100&extra_fields%5B%5D=return_rate/);
  const assessed = assessPhone({ pos: report });
  assert.equal(assessed.level, 'high');
  assert.equal(assessed.failed, 2);
  // Lỗi mạng: không ném, không chặn lên đơn.
  const failing = await fetchPosPhoneReport('0909123456', { config: posConfig, fetchImpl: async () => { throw new Error('timeout'); } });
  assert.equal(failing.error, 'timeout');
  // Chưa cấu hình POS: null.
  assert.equal(await fetchPosPhoneReport('0909123456', { config: { apiKey: '', shopId: '' } }), null);
});

test('danh sách thủ công và tra cứu gộp có cache', async () => {
  await setManualWarning({ phone: '0912 345 678', level: 'high', reason: 'Bom 2 đơn tháng 8', by: 'Hằng' }, 1000);
  const listed = await listManualWarnings();
  assert.equal(listed.length, 1);
  assert.equal(listed[0].phone, '0912345678');
  assert.equal(listed[0].incidents, 1);
  await assert.rejects(setManualWarning({ phone: 'abc' }), /không hợp lệ/);

  const fetchImpl = posFetch({ orders: [{ status: 4, bill_phone_number: '0912345678' }], customers: [] });
  const first = await lookupPhone('0912345678', { config: posConfig, fetchImpl, now: 2000 });
  assert.equal(first.level, 'high');
  assert.equal(first.failed, 2, 'thủ công 1 + POS 1');
  assert.equal(first.posChecked, true);
  assert.equal(fetchImpl.calls.length, 2);
  // Lần hai trong 24 giờ dùng cache, không gọi POS.
  await lookupPhone('0912345678', { config: posConfig, fetchImpl, now: 3000 });
  assert.equal(fetchImpl.calls.length, 2);
  // Hết hạn cache thì gọi lại.
  await lookupPhone('0912345678', { config: posConfig, fetchImpl, now: 2000 + 25 * 60 * 60 * 1000 });
  assert.equal(fetchImpl.calls.length, 4);

  const batch = await lookupPhones(['0912345678', '0999000111', '0912345678'], { config: posConfig, fetchImpl: posFetch(), now: 2000 });
  assert.deepEqual(Object.keys(batch).sort(), ['0912345678', '0999000111']);
  assert.equal(batch['0999000111'].level, 'none');

  await removeManualWarning('0912345678');
  assert.equal((await listManualWarnings()).length, 0);
});

test('gắn cảnh báo vào đơn, không ném lỗi khi POS hỏng', async () => {
  await setManualWarning({ phone: '0977000111', level: 'block', reason: 'Bom 3 lần' });
  const order = await attachPhoneWarning({ phone: '0977000111' }, { config: { apiKey: '', shopId: '' } });
  assert.equal(order.phoneWarning.level, 'block');
  assert.match(order.phoneWarning.label, /Chặn/);
  const clean = await attachPhoneWarning({ phone: '0977000222' }, { config: posConfig, fetchImpl: async () => { throw new Error('down'); } });
  assert.equal(clean.phoneWarning, undefined);
  await removeManualWarning('0977000111');
});

test('kết nối POS bằng khoá dán vào Cài đặt: kiểm tra qua /shops, tự lấy shop, che khoá khi hiển thị', async () => {
  process.env.POS_CONFIG_PATH = path.join(mkdtempSync(path.join(tmpdir(), 'posconf-')), 'pos-config.json');
  const { connectPos, disconnectPos, posStatus, posConfig } = await import('../app/phone-warnings.mjs?pos');
  const fetchImpl = async url => {
    assert.match(String(url), /\/shops\?api_key=abcd1234efgh$/);
    return { ok: true, json: async () => ({ success: true, shops: [{ id: 6036602, name: 'Nông Sản Giọt Nắng' }] }) };
  };
  const result = await connectPos({ apiKey: 'abcd1234efgh' }, { fetchImpl });
  assert.equal(result.configured, true);
  assert.equal(result.shopId, '6036602');
  assert.equal(result.shopName, 'Nông Sản Giọt Nắng');
  assert.equal(result.keyHint, 'abcd…efgh');
  assert.equal(posConfig().apiKey, 'abcd1234efgh');
  await assert.rejects(connectPos({ apiKey: 'sai' }, { fetchImpl: async () => ({ ok: false, status: 401, json: async () => ({ success: false, message: 'Unauthorized' }) }) }), /Unauthorized/);
  assert.equal(posStatus().configured, true, 'khoá sai không ghi đè khoá đang dùng');
  await disconnectPos();
  assert.equal(posStatus().configured, false);
});
