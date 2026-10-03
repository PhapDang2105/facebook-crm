import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { tempDir } from './helpers/temp-dir.mjs';

// Kho nhân sự tạm cho test: không đụng dữ liệu thật.
process.env.STAFF_PATH = path.join(tempDir('crm-staff-'), 'staff.json');
const { listStaff, saveStaffMember, staffLoginAccounts, staffByUsername, MIN_PASSWORD_LENGTH } = await import('../app/staff.mjs');
const { verifyPassword } = await import('../app/auth.mjs');

test('nhân sự: thêm, kiểm tên đăng nhập, mật khẩu chỉ lưu chuỗi băm, không trả chuỗi băm ra ngoài', async () => {
  const lan = await saveStaffMember({ name: '  Thúy  Hằng ', username: 'Hang.TH', role: 'admin', phone: '0912 345 678', pancakeNames: 'Thúy Hằng, Thúy Hằng', password: 'matkhau-123' });
  assert.equal(lan.name, 'Thúy Hằng');
  assert.equal(lan.username, 'hang.th', 'tên đăng nhập viết thường');
  assert.equal(lan.roleName, 'Quản trị');
  assert.equal(lan.phone, '0912345678');
  assert.deepEqual(lan.pancakeNames, ['Thúy Hằng']);
  assert.equal(lan.hasPassword, true);
  assert.equal('passwordHash' in lan, false);
  const raw = JSON.parse(readFileSync(process.env.STAFF_PATH, 'utf8'));
  assert.match(raw.items[0].passwordHash, /^scrypt\$/);
  assert.equal(JSON.stringify(raw).includes('matkhau-123'), false, 'không lưu mật khẩu gốc');
  assert.equal(await verifyPassword('matkhau-123', raw.items[0].passwordHash), true);

  await assert.rejects(saveStaffMember({ name: 'A', username: 'hang.th' }), /đã có người dùng/);
  await assert.rejects(saveStaffMember({ name: 'A', username: 'ab' }), /Tên đăng nhập 3–32/);
  await assert.rejects(saveStaffMember({ name: 'A', username: 'phương anh' }), /Tên đăng nhập 3–32/);
  await assert.rejects(saveStaffMember({ name: '', username: 'abc' }), /họ tên/);
  await assert.rejects(saveStaffMember({ name: 'A', username: 'chu.shop' }, { reservedUsernames: new Set(['chu.shop']) }), /chủ shop/);
  await assert.rejects(saveStaffMember({ name: 'A', username: 'abc', password: 'x'.repeat(MIN_PASSWORD_LENGTH - 1) }), /ít nhất/);
  assert.equal((await listStaff()).every(item => !('passwordHash' in item)), true);
});

test('nhân sự: sửa không gửi mật khẩu thì giữ mật khẩu; danh sách đăng nhập chỉ gồm người đang làm có mật khẩu', async () => {
  const anh = await saveStaffMember({ name: 'Phương Anh', username: 'phuonganh', role: 'staff', password: 'phuonganh-1' });
  const vy = await saveStaffMember({ name: 'Hồng Vy', username: 'hongvy' });
  assert.equal(vy.hasPassword, false);
  let users = await staffLoginAccounts();
  assert.deepEqual([...users.keys()].sort(), ['hang.th', 'phuonganh']);

  const renamed = await saveStaffMember({ name: 'Phương Anh (ca tối)' }, { id: anh.id });
  assert.equal(renamed.username, 'phuonganh');
  assert.equal(renamed.hasPassword, true, 'không gửi mật khẩu thì giữ mật khẩu cũ');
  const before = (await staffLoginAccounts()).get('phuonganh').hash;
  await saveStaffMember({ password: 'doi-mat-khau' }, { id: anh.id });
  assert.notEqual((await staffLoginAccounts()).get('phuonganh').hash, before, 'đổi mật khẩu → chuỗi băm mới (phiên cũ hết hiệu lực)');

  await saveStaffMember({ active: false }, { id: anh.id });
  users = await staffLoginAccounts();
  assert.equal(users.has('phuonganh'), false, 'đã nghỉ thì không đăng nhập được');
  assert.equal(await staffByUsername('phuonganh'), null);
  assert.equal((await staffByUsername('HANG.TH')).role, 'admin');
  const list = await listStaff();
  assert.equal(list.at(-1).username, 'phuonganh', 'người đã nghỉ xếp cuối');
  await assert.rejects(saveStaffMember({ name: 'X' }, { id: 'st_khongco' }), /Không tìm thấy/);
});

test('nhân sự: không để mất Quản trị cuối cùng có mật khẩu (trừ khi còn tài khoản .env)', async () => {
  const [admin] = (await listStaff()).filter(item => item.role === 'admin');
  await assert.rejects(saveStaffMember({ role: 'staff' }, { id: admin.id }), /ít nhất một Quản trị/);
  await assert.rejects(saveStaffMember({ active: false }, { id: admin.id }), /ít nhất một Quản trị/);
  const ok = await saveStaffMember({ role: 'staff' }, { id: admin.id, reservedUsernames: new Set(['chu.shop']) });
  assert.equal(ok.role, 'staff', 'còn tài khoản chủ shop trong .env thì được hạ quyền');
});

test('nhân sự: sessionVersion tăng khi đổi mật khẩu / cho nghỉ / đi làm lại → phiên cũ bị thu hồi; đổi tên hiển thị thì không', async () => {
  const { staffLoginAccounts } = await import('../app/staff.mjs');
  const owner = new Set(['chu.shop']); // còn tài khoản chủ shop (.env) nên không vướng luật "Quản trị cuối cùng"
  const minh = await saveStaffMember({ name: 'Minh', username: 'minh.nv', role: 'staff', password: 'minh-matkhau-1' }, { reservedUsernames: owner });
  assert.equal('sessionVersion' in minh, false, 'không trả phiên bản ra giao diện');
  const version = async () => (await staffLoginAccounts()).get('minh.nv')?.version;
  assert.equal(await version(), 0);
  await saveStaffMember({ name: 'Minh (ca sáng)' }, { id: minh.id, reservedUsernames: owner });
  assert.equal(await version(), 0, 'đổi tên hiển thị không đăng xuất ai');
  await saveStaffMember({ password: 'minh-matkhau-2' }, { id: minh.id, reservedUsernames: owner });
  assert.equal(await version(), 1);
  await saveStaffMember({ active: false }, { id: minh.id, reservedUsernames: owner });
  assert.equal((await staffLoginAccounts()).has('minh.nv'), false, 'đã nghỉ thì không còn trong danh sách đăng nhập');
  await saveStaffMember({ active: true }, { id: minh.id, reservedUsernames: owner });
  assert.equal(await version(), 3, 'đi làm lại: phiên trước khi nghỉ KHÔNG sống lại');
  const account = (await staffLoginAccounts()).get('minh.nv');
  assert.match(account.hash, /^scrypt\$/);
});
