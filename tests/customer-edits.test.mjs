import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// Trỏ kho đi chỗ khác TRƯỚC khi nạp module: customer-edits.mjs chốt đường dẫn
// ngay lúc nạp, đặt sau là bài test ghi thẳng vào dữ liệu thật.
const directory = mkdtempSync(path.join(tmpdir(), 'customer-edits-'));
process.env.CUSTOMER_EDITS_PATH = path.join(directory, 'customer-edits.json');
process.on('exit', () => rmSync(directory, { recursive: true, force: true }));

const {
  addCustomerNote,
  applyCustomerEdits,
  customerEditKey,
  listCustomerNotes,
  readCustomerEdits,
  setCustomerLabels,
  updateCustomerProfile
} = await import('../app/customer-edits.mjs');

const buyer = (extra = {}) => ({
  id: 'export:0909123456',
  phone: '0909123456',
  name: 'Khách Gốc',
  address: 'Số 1, Phường 2, Quận 3, TP Hồ Chí Minh',
  gender: '',
  genderSource: '',
  labels: [],
  noteCount: 0,
  ...extra
});

/** Phủ kho lên một danh sách khách rồi trả về bản ghi đầu tiên. */
async function overlay(customers) {
  return applyCustomerEdits(customers, await readCustomerEdits())[0];
}

test('khoá theo số điện thoại, không theo mã khách', () => {
  // Mã khách đổi khi khách landing bắt đầu nhắn tin cho Page; số thì không.
  assert.equal(customerEditKey({ id: 'export:0909123456', phone: '0909123456' }), 'phone:0909123456');
  assert.equal(customerEditKey({ id: '110:psid-1', phone: '0909 123 456' }), 'phone:0909123456');
  assert.equal(customerEditKey({ id: '110:psid-1', phone: '' }), '110:psid-1');
});

test('phần nhân viên sửa theo khách sang cả bản ghi mang mã khác', async () => {
  const key = customerEditKey(buyer());
  await updateCustomerProfile(key, { name: 'Chị Hạnh', gender: 'female' });

  // Cùng người, nhưng nay đã nhắn tin cho Page nên mã khách đổi hẳn.
  const merged = await overlay([buyer({ id: '110068281327307:psid-9' })]);
  assert.equal(merged.name, 'Chị Hạnh');
  assert.equal(merged.gender, 'female');
  assert.equal(merged.genderSource, 'staff');
});

test('ô để trống gỡ phần đã sửa, trả về dữ liệu gốc', async () => {
  const key = customerEditKey(buyer());
  await updateCustomerProfile(key, { name: 'Tên Nhập Nhầm' });
  assert.equal((await overlay([buyer()])).name, 'Tên Nhập Nhầm');

  await updateCustomerProfile(key, { name: '' });
  assert.equal((await overlay([buyer()])).name, 'Khách Gốc');
});

test('số điện thoại phải hợp lệ, nhưng để trống thì được', async () => {
  const key = customerEditKey(buyer());
  await assert.rejects(() => updateCustomerProfile(key, { phone: '123' }), /Số điện thoại không hợp lệ/);
  await assert.doesNotReject(() => updateCustomerProfile(key, { phone: '' }));
  await assert.rejects(() => updateCustomerProfile(key, {}), /Không có gì để sửa/);
  await assert.rejects(() => updateCustomerProfile(key, { gender: 'khac' }), /Giới tính không hợp lệ/);
});

test('gắn thẻ: thêm được thẻ mới và gỡ được thẻ đến từ hội thoại', async () => {
  const withLabel = () => buyer({ labels: ['customer'] });
  const key = customerEditKey(withLabel());

  // Thẻ "customer" do hội thoại tự gắn; nhân viên bỏ tích nó và thêm "vip".
  await setCustomerLabels(key, ['vip'], ['customer']);
  const after = await overlay([withLabel()]);
  assert.deepEqual(after.labels, ['vip'], 'thẻ hội thoại phải bị gỡ, không được mọc lại');

  // Tích lại thì thẻ hội thoại quay về và phần gỡ bị xoá.
  await setCustomerLabels(key, ['customer', 'vip'], ['customer']);
  assert.deepEqual((await overlay([withLabel()])).labels.sort(), ['customer', 'vip']);
});

test('thẻ gốc được ghi lại để route biết đâu là thêm, đâu là gỡ', async () => {
  const after = await overlay([buyer({ labels: ['customer', 'handoff'] })]);
  assert.deepEqual(after.derivedLabels, ['customer', 'handoff']);
  assert.equal(after.editKey, 'phone:0909123456');
});

test('ghi chú chỉ thêm, đếm riêng phần thêm từ hộp chi tiết', async () => {
  const key = customerEditKey(buyer());
  // Mốc thời gian đóng cứng: hai ghi chú rơi vào cùng một mili giây thì thứ tự
  // "mới nhất lên đầu" không còn xác định, bài sẽ đỏ lúc có lúc không.
  await addCustomerNote(key, { text: 'Giao sau 18h' }, 1_700_000_000_000);
  await addCustomerNote(key, { text: 'Gọi trước khi tới', by: 'Hà' }, 1_700_000_060_000);

  const notes = await listCustomerNotes(key);
  assert.equal(notes.length, 2);
  assert.equal(notes[0].text, 'Gọi trước khi tới', 'mới nhất lên đầu');
  assert.equal(notes[0].by, 'Hà');
  assert.equal(notes[1].by, 'Nhân viên', 'không ghi tên thì để mặc định');

  // noteCount cộng vào phần đã đếm từ hội thoại; staffNoteCount thì không.
  const after = await overlay([buyer({ noteCount: 3 })]);
  assert.equal(after.noteCount, 5);
  assert.equal(after.staffNoteCount, 2);

  await assert.rejects(() => addCustomerNote(key, { text: '   ' }), /không được để trống/);
});

test('__proto__ làm mã khách bị từ chối, không ô nhiễm prototype', async () => {
  await assert.rejects(() => addCustomerNote('__proto__', { text: 'x' }), /không hợp lệ/);
  await assert.rejects(() => setCustomerLabels('constructor', ['x'], []), /không hợp lệ/);
  assert.equal({}.labels, undefined);
  assert.equal({}.updatedAt, undefined);
});

test('khách không có gì trong kho thì đi qua nguyên vẹn', async () => {
  const untouched = applyCustomerEdits([buyer({ id: 'export:0988000111', phone: '0988000111' })], {})[0];
  assert.equal(untouched.name, 'Khách Gốc');
  assert.equal(untouched.staffNoteCount, undefined);
  assert.equal(untouched.editKey, 'phone:0988000111');
});
