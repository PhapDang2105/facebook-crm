// Đơn landing (01/10): T3 form dở → hoàn tất giữ sửa của nhân viên; T10 kho quá trần chuyển đơn cũ
// sang kho lưu trữ (báo cáo vẫn thấy); T8 SĐT mất số 0 đầu / 0084; archiveMonth theo giờ VN; T7 sửa SĐT.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { tempDir } from './helpers/temp-dir.mjs';

const directory = tempDir('fix-store-landing-');
process.env.LANDING_ORDERS_PATH = path.join(directory, 'landing-orders.json');
process.env.ORDER_ARCHIVE_PATH = path.join(directory, 'order-archive');
process.env.PHONE_WARNINGS_PATH = path.join(directory, 'phone-warnings.json');
process.env.POS_CONFIG_PATH = path.join(directory, 'pos-config.json');
process.env.ADDRESS_AI_CACHE_PATH = path.join(directory, 'address-ai-cache.json');

await import('./helpers/seed-catalog.mjs');
const landing = await import('../app/landing-orders.mjs');
const { recordLandingOrder, updateLandingStore, readLandingStore, listLandingOrders, normalizeLandingPayload, setLandingActiveLimitForTest, LANDING_ACTIVE_LIMIT } = landing;
const { applyCustomerOrderEdits, recordOrderHistory, normalizeEditedPhone } = await import('../app/order-edits.mjs');
const { archiveMonth } = await import('../app/order-archive.mjs');
const { toLocalPhoneLoose } = await import('../app/phone-warnings.mjs');

const context = { autoFill: false, checkPhone: false };
const base = { name: 'Lan', phone: '0912345678', address: '12 Lê Lợi, Phường Bến Nghé, Quận 1, Hồ Chí Minh', products: 'Granola Túi Xanh 450g: 1 x 189.000 ₫' };

async function editStored(id, apply) {
  await updateLandingStore(store => { apply(store.orders.find(order => order.id === id)); });
}

test('T3: form dở → nhân viên sửa địa chỉ, ẩn, có lịch sử, đã đẩy POS → form hoàn tất về: giữ hết phần nhân viên', async () => {
  const draft = await recordLandingOrder({ ...base, id: 'F-T3', status: 'Form chưa hoàn tất' }, context);
  assert.equal(draft.created, true);
  assert.equal(draft.order.landing.incomplete, true);
  const id = draft.order.id;
  await editStored(id, order => {
    const changed = applyCustomerOrderEdits(order, { address: '99 Hai Bà Trưng, Phường Bến Nghé, Quận 1, Hồ Chí Minh', processingStatus: 'confirmed', hiddenFromTable: true }, 1000);
    assert.ok(changed.includes('address'));
    recordOrderHistory(order, { by: { username: 'nv1', name: 'NV 1' }, action: 'order.update', summary: 'địa chỉ', at: 1000 });
    order.pos = { id: 'POS-1', at: 1000 };
    order.purchaseLabeled = true;
  });
  const done = await recordLandingOrder({ ...base, id: 'F-T3', status: 'Form hoàn tất', name: 'Nguyễn Thị Lan', products: 'Granola Túi Xanh 450g: 2 x 189.000 ₫' }, context);
  assert.equal(done.updated, true);
  const order = (await readLandingStore()).orders.find(item => item.id === id);
  assert.equal(order.address, '99 Hai Bà Trưng, Phường Bến Nghé, Quận 1, Hồ Chí Minh', 'địa chỉ nhân viên sửa được giữ');
  assert.match(order.street, /99 Hai Bà Trưng/);
  assert.equal(order.hiddenFromTable, true, 'cờ ẩn khỏi bảng được giữ');
  assert.equal(order.history.length, 1, 'lịch sử được giữ');
  assert.equal(order.pos.id, 'POS-1', 'kết quả đẩy POS được giữ');
  assert.equal(order.purchaseLabeled, true);
  assert.equal(order.processingStatus, 'confirmed');
  assert.equal(order.status, 'Đã xác nhận', 'trạng thái nhân viên đặt được giữ');
  assert.ok(order.editedByStaffAt);
  // Nhóm nhân viên KHÔNG sửa (tên, giỏ) thì bản khách gửi xong thắng.
  assert.equal(order.name, 'Nguyễn Thị Lan');
  assert.equal(order.products[0].quantity, 2);
  assert.equal(order.landing.incomplete, false);
  assert.deepEqual(order.landing.formIds, ['F-T3']);
  // Form hoàn tất ghi địa chỉ khác: cất lại để nhân viên đối chiếu.
  assert.equal(order.landing.completedForm.address, base.address);
});

test('T3: form dở không ai sửa → bản hoàn tất thay nội dung, nhãn "Chưa hoàn tất" → "Mới"; đơn sửa trước khi có staffEdited thì giữ mọi nội dung', async () => {
  const draft = await recordLandingOrder({ ...base, phone: '0987654321', id: 'F-T3b', status: 'Form chưa hoàn tất', address: 'GXN' }, context);
  const done = await recordLandingOrder({ ...base, phone: '0987654321', id: 'F-T3b', status: 'Form hoàn tất' }, context);
  assert.equal(done.updated, true);
  assert.equal(done.order.id, draft.order.id);
  assert.equal(done.order.address, base.address);
  assert.equal(done.order.status, 'Mới');
  assert.equal(done.order.landing.completedForm, undefined);

  const legacy = await recordLandingOrder({ ...base, phone: '0977123456', id: 'F-T3c', status: 'Form chưa hoàn tất' }, context);
  await editStored(legacy.order.id, order => { order.address = 'NV sửa tay: 5 Lý Tự Trọng, Quận 1, Hồ Chí Minh'; order.editedByStaffAt = 5; });
  await recordLandingOrder({ ...base, phone: '0977123456', id: 'F-T3c', status: 'Form hoàn tất', name: 'Tên khác' }, context);
  const kept = (await readLandingStore()).orders.find(item => item.id === legacy.order.id);
  assert.equal(kept.address, 'NV sửa tay: 5 Lý Tự Trọng, Quận 1, Hồ Chí Minh');
  assert.equal(kept.name, 'Lan', 'không biết nhóm nào đã sửa → giữ mọi nội dung');
  assert.equal(kept.landing.incomplete, false);
});

test('T8: SĐT 9 chữ số mất số 0 đầu và dạng 0084 được nhận; số bàn vẫn bị loại', async () => {
  assert.equal(toLocalPhoneLoose('912345678'), '0912345678');
  assert.equal(toLocalPhoneLoose('0084 912 345 678'), '0912345678');
  assert.equal(toLocalPhoneLoose('+84912345678'), '0912345678');
  assert.equal(toLocalPhoneLoose('0283456789'), '', 'số bàn 028 vẫn loại như chủ ý');
  assert.equal(toLocalPhoneLoose('283456789'), '', '9 số đầu 2 (số bàn mất 0) không đoán');
  assert.equal(toLocalPhoneLoose('123456789'), '');
  assert.equal(normalizeLandingPayload({ phone: '912345678', name: 'A' }).phone, '0912345678');
  const result = await recordLandingOrder({ ...base, id: 'F-T8', phone: '0084912000111' }, context);
  assert.equal(result.error, '', 'trước đây: "Không tìm thấy số điện thoại hợp lệ" và đơn bị bỏ');
  assert.equal(result.order.phone, '0912000111');
});

test('T7: sửa SĐT ở đơn: +84 → 0, thêm số 0 bị mất; số lạ vẫn lưu nhưng kèm cảnh báo; < 9 số vẫn từ chối', () => {
  assert.deepEqual(normalizeEditedPhone('+84 912 345 678'), { phone: '0912345678', warning: '' });
  assert.deepEqual(normalizeEditedPhone('912345678'), { phone: '0912345678', warning: '' });
  const odd = normalizeEditedPhone('0123456789');
  assert.equal(odd.phone, '0123456789');
  assert.match(odd.warning, /không giống số di động/);
  assert.throws(() => normalizeEditedPhone('09123'), /không hợp lệ/);
  const order = { id: 'o1', name: 'A', phone: '0900000000', address: 'x', products: [] };
  const changed = applyCustomerOrderEdits(order, { phone: '+84912345678' });
  assert.deepEqual([...changed], ['phone']);
  assert.equal(order.phone, '0912345678');
  assert.equal(changed.warnings, undefined);
  const flagged = applyCustomerOrderEdits(order, { phone: '0283456789' });
  assert.equal(order.phone, '0283456789', 'số bàn không bị chặn hẳn');
  assert.match(flagged.warnings[0], /không giống số di động/);
  assert.ok(order.staffEdited.phone, 'ghi nhóm nhân viên đã sửa');
});

test('archiveMonth: theo giờ Việt Nam, không theo giờ máy chủ', () => {
  // 01/10 03:00 giờ VN = 30/09 20:00 UTC.
  assert.equal(archiveMonth(Date.UTC(2026, 8, 30, 20, 0)), '2026-10');
  assert.equal(archiveMonth(Date.UTC(2026, 8, 30, 16, 59)), '2026-09');
  assert.equal(archiveMonth(Date.UTC(2026, 8, 30, 17, 0)), '2026-10');
});

test('T10: kho chính quá trần → đơn cũ nhất chuyển nguyên bản sang kho lưu trữ theo tháng, listLandingOrders vẫn trả đủ', async () => {
  assert.equal(LANDING_ACTIVE_LIMIT, 5000);
  const before = (await readLandingStore()).orders.length;
  setLandingActiveLimitForTest(before + 2);
  try {
    const at = Date.UTC(2026, 7, 15, 3, 0);
    // Đơn cũ (tháng 8) có trạng thái POS / hủy: kho lưu trữ phải giữ nguyên các trường báo cáo cần.
    await updateLandingStore(store => {
      store.orders.push({ id: 'OLD-1', phone: '0911000001', createdAt: at, total: 300000, posStatus: { code: 3, name: 'Đã nhận' }, source: 'Landing page', products: [], landing: { campaign: 'utm_campaign=c1' } });
      store.orders.push({ id: 'OLD-2', phone: '0911000002', createdAt: at - 1, total: 200000, processingStatus: 'cancelled', source: 'Landing page', products: [], landing: {} });
    });
    for (let index = 0; index < 3; index += 1) {
      await recordLandingOrder({ ...base, id: `F-T10-${index}`, phone: `091100010${index}` }, context);
    }
    const store = await readLandingStore();
    assert.equal(store.orders.length, before + 2, 'kho chính giữ đúng trần');
    assert.ok(!store.orders.some(order => order.id === 'OLD-1' || order.id === 'OLD-2'));
    const archiveDirectory = path.join(directory, 'landing-orders-archive');
    assert.ok(existsSync(path.join(archiveDirectory, '2026-08.json')));
    const archived = JSON.parse(readFileSync(path.join(archiveDirectory, '2026-08.json'), 'utf8')).orders;
    assert.deepEqual(archived.map(order => order.id).sort(), ['OLD-1', 'OLD-2']);
    assert.deepEqual(archived.find(order => order.id === 'OLD-1').posStatus, { code: 3, name: 'Đã nhận' }, 'đơn đầy đủ, không rút gọn');
    const listed = await listLandingOrders();
    assert.ok(listed.some(order => order.id === 'OLD-1' && order.total === 300000), 'báo cáo/Tổng quan vẫn thấy doanh thu cũ');
    assert.equal(listed.length, store.orders.length + 3, 'ba đơn bị đẩy ra (hai đơn tháng 8 và một đơn cũ nhất còn lại) vẫn được liệt kê');
    assert.equal(new Set(listed.map(order => order.id)).size, listed.length, 'không trùng');
    assert.equal((await listLandingOrders({ includeArchived: false })).length, store.orders.length);
    assert.deepEqual(readdirSync(archiveDirectory).filter(name => name.endsWith('.tmp')), []);
  } finally {
    setLandingActiveLimitForTest(LANDING_ACTIVE_LIMIT);
  }
});
