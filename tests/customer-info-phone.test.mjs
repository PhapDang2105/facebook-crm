import test from 'node:test';
import assert from 'node:assert/strict';
import { extractVietnamesePhone } from '../app/processing/customer-info.mjs';

test('SĐT trong tin gộp: không nối chữ số qua xuống dòng, vẫn nối khoảng trắng/chấm trong cùng dòng', () => {
  assert.equal(extractVietnamesePhone('0912 345 678\n12 Nguyễn Huệ, Q1'), '0912345678');
  assert.equal(extractVietnamesePhone('Lấy 2 túi\n0912.345.678'), '0912345678');
  assert.equal(extractVietnamesePhone('0385.805.790'), '0385805790');
  assert.equal(extractVietnamesePhone('0912345678 12 Nguyễn Huệ'), '0912345678');
  assert.equal(extractVietnamesePhone('giá 174k'), '');
});
