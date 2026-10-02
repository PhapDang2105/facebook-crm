// fix-review (02/10) lỗi 1: form landing dở → nhân viên CHỈ ẩn dòng / đổi trạng thái / ghi chú xử lý → form hoàn tất
// về phải dùng nội dung form (trước đây: mọi lần sửa đặt editedByStaffAt, thiếu staffEdited bị coi là "sửa mọi nhóm"
// nên đơn giữ "Chưa có địa chỉ", giỏ 0đ). Cùng nguyên nhân chặn chép sửa của POS (pos-content-sync) với dấu cũ.
// Chuyển từ scratchpad/rv/repro-landing-status.test.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { tempDir } from './helpers/temp-dir.mjs';

const directory = tempDir('fix-review-landing-');
process.env.LANDING_ORDERS_PATH = path.join(directory, 'landing-orders.json');
process.env.ORDER_ARCHIVE_PATH = path.join(directory, 'order-archive');
process.env.PHONE_WARNINGS_PATH = path.join(directory, 'phone-warnings.json');
process.env.POS_CONFIG_PATH = path.join(directory, 'pos-config.json');
process.env.ADDRESS_AI_CACHE_PATH = path.join(directory, 'address-ai-cache.json');

await import('./helpers/seed-catalog.mjs');
const { recordLandingOrder, updateLandingStore, readLandingStore } = await import('../app/landing-orders.mjs');
const { applyCustomerOrderEdits, staffEditedGroups, staffEditedAt, legacyStaffEditAt, STAFF_EDIT_GROUPS } = await import('../app/order-edits.mjs');
const { applyPosContent } = await import('../app/pos-content-sync.mjs');

const context = { autoFill: false, checkPhone: false };
const ADDRESS = '12 Lê Lợi, Phường Bến Nghé, Quận 1, Hồ Chí Minh';
const PRODUCTS = 'Granola Túi Xanh 450g: 2 x 189.000 ₫';
const ALL_GROUPS = Object.keys(STAFF_EDIT_GROUPS).sort();

async function editStored(id, apply) {
  await updateLandingStore(store => { apply(store.orders.find(order => order.id === id)); });
}
const stored = async id => (await readLandingStore()).orders.find(order => order.id === id);

const lightEdits = [
  { label: 'ghi chú xử lý', patch: { staffNote: 'đã gọi, khách hẹn điền lại' }, field: 'staffNote', phone: '0912345601' },
  { label: 'đổi trạng thái', patch: { processingStatus: 'callback' }, field: 'processingStatus', phone: '0912345602' },
  { label: 'ẩn dòng', patch: { hiddenFromTable: true }, field: 'hiddenFromTable', phone: '0912345603' }
];

for (const [index, edit] of lightEdits.entries()) {
  test(`form dở → nhân viên chỉ ${edit.label} → form hoàn tất về: đơn lấy địa chỉ và giỏ của form`, async () => {
    const formId = `F-RV-${index}`;
    const draft = await recordLandingOrder({ name: 'Lan', phone: edit.phone, id: formId, status: 'Form chưa hoàn tất' }, context);
    assert.equal(draft.order.landing.incomplete, true);
    const id = draft.order.id;
    await editStored(id, order => {
      const changed = applyCustomerOrderEdits(order, edit.patch, 1000);
      assert.deepEqual([...changed], [edit.field]);
      assert.deepEqual(order.staffEdited, {}, 'đã theo dõi nhóm, chưa sửa nhóm nội dung nào');
      assert.equal(order.staffEditedLegacyAt, undefined);
      assert.equal(staffEditedGroups(order).size, 0);
    });
    const done = await recordLandingOrder({ name: 'Lan', phone: edit.phone, id: formId, address: ADDRESS, products: PRODUCTS }, context);
    assert.equal(done.updated, true);
    const order = await stored(id);
    assert.equal(order.address, ADDRESS, 'địa chỉ khách vừa điền phải vào đơn');
    assert.equal(order.products[0].quantity, 2);
    assert.ok(order.total > 0, 'tổng tiền theo giỏ của form');
    assert.equal(order.landing.incomplete, false);
    assert.ok(!order.landing.needsAddress);
    assert.equal(order.landing.completedForm, undefined, 'không có gì phải cất để đối chiếu');
    // Phần nhân viên đã làm vẫn đi theo đơn.
    for (const [key, value] of Object.entries(edit.patch)) assert.equal(order[key], value);
    assert.equal(order.editedByStaffAt, 1000);
  });
}

test('đổi trạng thái rồi MỚI sửa địa chỉ: chỉ nhóm địa chỉ được giữ, giỏ của form vẫn vào đơn', async () => {
  const draft = await recordLandingOrder({ name: 'Lan', phone: '0912345604', id: 'F-RV-MIX', status: 'Form chưa hoàn tất' }, context);
  const id = draft.order.id;
  const staffAddress = '99 Hai Bà Trưng, Phường Bến Nghé, Quận 1, Hồ Chí Minh';
  await editStored(id, order => {
    applyCustomerOrderEdits(order, { processingStatus: 'calling' }, 1000);
    applyCustomerOrderEdits(order, { address: staffAddress }, 2000);
    assert.deepEqual(order.staffEdited, { address: 2000 });
  });
  await recordLandingOrder({ name: 'Lan', phone: '0912345604', id: 'F-RV-MIX', address: ADDRESS, products: PRODUCTS }, context);
  const order = await stored(id);
  assert.equal(order.address, staffAddress, 'địa chỉ nhân viên sửa được giữ');
  assert.equal(order.landing.completedForm.address, ADDRESS, 'địa chỉ form cất lại để đối chiếu');
  assert.equal(order.products[0].quantity, 2, 'giỏ của form');
});

test('đơn sửa KIỂU CŨ (chỉ có editedByStaffAt): vẫn coi là sửa mọi nhóm, kể cả sau khi được sửa tiếp bằng bản mới', async () => {
  // Đơn cũ: chỉ có editedByStaffAt (bản mã trước khi có staffEdited), không biết nhân viên sửa nhóm nào.
  const legacy = { id: 'old', name: 'A', phone: '0900000000', address: 'NV sửa tay', products: [], editedByStaffAt: 5 };
  assert.equal(legacyStaffEditAt(legacy), 5);
  assert.deepEqual([...staffEditedGroups(legacy)].sort(), ALL_GROUPS);
  assert.equal(staffEditedAt(legacy, 'address'), 5);
  // Sửa tiếp bằng bản mới (chỉ đổi trạng thái): mốc cũ được chép vào cờ staffEditedLegacyAt, không bị xoá dấu.
  applyCustomerOrderEdits(legacy, { processingStatus: 'calling' }, 9000);
  assert.equal(legacy.staffEditedLegacyAt, 5);
  assert.deepEqual(legacy.staffEdited, {});
  assert.deepEqual([...staffEditedGroups(legacy)].sort(), ALL_GROUPS, 'vẫn không đè nội dung nhân viên có thể đã sửa');
  assert.equal(staffEditedAt(legacy, 'address'), 5, 'mốc sửa nội dung là mốc cũ, không phải lần đổi trạng thái');
  applyCustomerOrderEdits(legacy, { staffNote: 'x' }, 9500);
  assert.equal(legacy.staffEditedLegacyAt, 5, 'cờ kiểu cũ không bị ghi đè bằng mốc mới');

  // Qua kho: form hoàn tất không đè đơn kiểu cũ.
  const draft = await recordLandingOrder({ name: 'Lan', phone: '0912345605', id: 'F-RV-OLD', status: 'Form chưa hoàn tất' }, context);
  await editStored(draft.order.id, order => {
    order.address = 'NV sửa tay: 5 Lý Tự Trọng, Quận 1, Hồ Chí Minh';
    order.editedByStaffAt = 5;
    applyCustomerOrderEdits(order, { hiddenFromTable: true }, 9000);
  });
  await recordLandingOrder({ name: 'Tên khác', phone: '0912345605', id: 'F-RV-OLD', address: ADDRESS, products: PRODUCTS }, context);
  const kept = await stored(draft.order.id);
  assert.equal(kept.address, 'NV sửa tay: 5 Lý Tự Trọng, Quận 1, Hồ Chí Minh');
  assert.equal(kept.name, 'Lan');

  // Đơn chưa ai sửa / đơn bản mới: không có mốc kiểu cũ.
  assert.equal(legacyStaffEditAt({ id: 'n' }), 0);
  assert.equal(staffEditedGroups({ id: 'n' }).size, 0);
  const fresh = { id: 'f', name: 'A', phone: '0900000000', address: 'x', products: [] };
  applyCustomerOrderEdits(fresh, { name: 'B' }, 100);
  assert.equal(legacyStaffEditAt(fresh), 0);
  assert.deepEqual([...staffEditedGroups(fresh)], ['name']);
  assert.equal(staffEditedAt(fresh, 'name'), 100);
  assert.equal(staffEditedAt(fresh, 'address'), 0);
});

// ===== pos-content-sync: dấu POS cũ (chưa có values) + nhân viên chỉ đổi trạng thái/ẩn dòng → sửa trên POS vẫn chép về =====

const XANH = 'GRA-XANH-Z450';
const posOrder = (extra = {}) => ({
  id: 51946, status: 1, bill_full_name: 'Lan', bill_phone_number: '0912345678', shipping_fee: 0, is_free_shipping: true, cod: 189000,
  shipping_address: { address: '12 Lê Lợi', commune_name: 'Phường Bến Nghé', district_name: 'Quận 1', province_name: 'Hồ Chí Minh', full_address: ADDRESS },
  items: [{ quantity: 1, variation_info: { display_id: XANH, name: 'Túi Xanh', retail_price: 189000 } }],
  updated_at: '2026-10-01T01:00:00.000000', ...extra
});
const landingOrder = () => ({
  id: 'L1', source: 'Landing page', landing: { posId: '51946' }, name: 'Lan', phone: '0912345678',
  address: ADDRESS, total: 189000, freeShipping: true, shippingFee: 0,
  products: [{ sku: XANH, quantity: 1, price: 189000 }], createdAt: Date.parse('2026-10-01T00:00:00Z')
});
const moved = () => posOrder({
  updated_at: '2026-10-01T05:00:00.000000',
  shipping_address: { address: '7 Pasteur', commune_name: 'Phường Bến Nghé', district_name: 'Quận 1', province_name: 'Hồ Chí Minh', full_address: '7 Pasteur, Phường Bến Nghé, Quận 1, Hồ Chí Minh' }
});

test('POS (dấu cũ chưa có values): nhân viên chỉ đổi trạng thái / ẩn dòng trong CRM → địa chỉ sửa trên POS vẫn được chép về', () => {
  for (const patch of [{ processingStatus: 'confirmed' }, { hiddenFromTable: true }, { staffNote: 'đã gọi' }]) {
    const order = landingOrder();
    applyPosContent(order, posOrder(), { now: Date.parse('2026-10-01T01:01:00Z') });
    delete order.posContent.values; // dấu ghi trước khi có values
    applyCustomerOrderEdits(order, patch, Date.parse('2026-10-01T02:00:00Z'));
    const result = applyPosContent(order, moved(), { now: Date.parse('2026-10-01T05:01:00Z') });
    assert.ok(result.changed.includes('địa chỉ'), `${Object.keys(patch)[0]}: trước đây bị coi là "nhân viên đã sửa mọi nhóm" nên không chép`);
    assert.match(order.address, /7 Pasteur/);
  }
});

test('POS (dấu cũ): nhân viên THẬT SỰ sửa địa chỉ sau dấu thì bản CRM vẫn thắng; đơn sửa kiểu cũ giữ mọi nhóm', () => {
  const precise = landingOrder();
  applyPosContent(precise, posOrder(), { now: Date.parse('2026-10-01T01:01:00Z') });
  delete precise.posContent.values;
  const staffAddress = '99 Hai Bà Trưng, Phường Bến Nghé, Quận 1, Hồ Chí Minh';
  applyCustomerOrderEdits(precise, { address: staffAddress }, Date.parse('2026-10-01T02:00:00Z'));
  applyCustomerOrderEdits(precise, { processingStatus: 'confirmed' }, Date.parse('2026-10-01T02:30:00Z'));
  applyPosContent(precise, moved(), { now: Date.parse('2026-10-01T05:01:00Z') });
  assert.equal(precise.address, staffAddress);

  const legacy = landingOrder();
  applyPosContent(legacy, posOrder(), { now: Date.parse('2026-10-01T01:01:00Z') });
  delete legacy.posContent.values;
  legacy.address = staffAddress;
  legacy.editedByStaffAt = Date.parse('2026-10-01T02:00:00Z'); // sửa bằng bản mã cũ
  applyCustomerOrderEdits(legacy, { hiddenFromTable: true }, Date.parse('2026-10-01T03:00:00Z'));
  applyPosContent(legacy, moved(), { now: Date.parse('2026-10-01T05:01:00Z') });
  assert.equal(legacy.address, staffAddress, 'không biết nhóm nào đã sửa → giữ bản CRM');
});
