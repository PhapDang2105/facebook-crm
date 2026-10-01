import test from 'node:test';
import assert from 'node:assert/strict';

const { matchStaffByPancakeName } = await import('../app/staff.mjs');
const { isStaffAdmin, pancakeAutomatedSender, pancakeMessageEvent } = await import('../app/pancake.mjs');

test('tin trang theo `from` của Pancake: nhân viên (uid) / POS / Botcake / AI Pancake / Public API / ngoài Pancake', () => {
  assert.equal(isStaffAdmin('Thúy Hằng', 'Dạ chị ơi', { admin_name: 'Thúy Hằng', uid: 'u1' }), true);
  assert.equal(isStaffAdmin('Thúy Hằng', 'Dạ', { admin_name: 'Thúy Hằng', ai_generated: true }), false, 'AI Pancake không phải người gõ');
  assert.equal(pancakeAutomatedSender({ admin_name: 'POS' }), 'Pancake POS');
  assert.equal(pancakeAutomatedSender({ admin_name: 'Thúy Hằng' }, 'Chào chị! Mã thẻ: #ABC123'), 'Botcake');
  assert.equal(pancakeAutomatedSender({ admin_name: 'Thúy Hằng', ai_generated: true }), 'AI Pancake');
  assert.equal(pancakeAutomatedSender({ admin_name: 'Public API', uid: 'x' }), 'Public API');
  assert.equal(pancakeAutomatedSender({ ai_generated: false, email: '1@facebook.com', id: '1' }), 'Ngoài Pancake');
  assert.equal(pancakeAutomatedSender({ admin_name: 'Thúy Hằng', uid: 'u1' }), '');

  const conversation = { id: '111_222', from: { id: '222', name: 'Khách' } };
  const staff = pancakeMessageEvent('111', conversation, { id: 'm1', message: 'Dạ chị ơi', inserted_at: '2026-10-01T06:55:00', from: { id: '111', admin_name: 'Thúy Hằng', uid: 'u1', platform: 'mobile' } });
  assert.equal(staff.message.staffName, 'Thúy Hằng');
  assert.equal(staff.message.staffUid, 'u1');
  assert.equal(staff.message.staffPlatform, 'mobile');
  assert.equal(staff.message.pancakeSender, undefined);
  const outside = pancakeMessageEvent('111', conversation, { id: 'm2', message: 'Chào Khách! Chúng tôi có thể giúp gì cho bạn?', inserted_at: '2026-10-01T06:55:00', from: { id: '111', email: '111@facebook.com', ai_generated: false } });
  assert.equal(outside.message.staff, undefined);
  assert.equal(outside.message.pancakeSender, 'Ngoài Pancake');
});

const members = [
  { username: 'hang', name: 'Thúy Hằng', pancakeNames: ['Hằng Nguyễn'], active: true },
  { username: 'lan', name: 'Lan', pancakeNames: [], active: true },
  { username: 'lan2', name: 'Lan', pancakeNames: [], active: false }
];

test('tên nhân viên trên Pancake → tài khoản CRM: "Tên trên Pancake/POS" trước, rồi họ tên; không phân biệt dấu/hoa thường', () => {
  assert.equal(matchStaffByPancakeName('Hằng Nguyễn', members)?.username, 'hang');
  assert.equal(matchStaffByPancakeName('hang nguyen', members)?.username, 'hang');
  assert.equal(matchStaffByPancakeName('Thúy  Hằng', members)?.username, 'hang');
  assert.equal(matchStaffByPancakeName('Lan', members)?.username, 'lan', 'trùng tên: ưu tiên người đang làm');
  assert.equal(matchStaffByPancakeName('Người lạ', members), null);
  assert.equal(matchStaffByPancakeName('', members), null);
});
