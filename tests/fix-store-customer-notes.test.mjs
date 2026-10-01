// Ghi chú bot ghi cho khách chưa có SĐT nằm ở khoá `pageId:psid`; khi khách có SĐT (khoá chính
// `phone:<sđt>`) hộp chi tiết khách vẫn phải thấy ghi chú cũ.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { tempDir } from './helpers/temp-dir.mjs';

process.env.CUSTOMER_EDITS_PATH = path.join(tempDir('fix-store-notes-'), 'customer-edits.json');
const { addCustomerNote, listCustomerNotes, customerEditKey, applyCustomerEdits } = await import('../app/customer-edits.mjs');

test('listCustomerNotes gộp ghi chú dưới khoá hội thoại (aliases), khử trùng, mới nhất trước', async () => {
  const conversationKey = 'p1:u1';
  await addCustomerNote(conversationKey, { text: 'Bot: SĐT trùng đơn hội thoại khác', author: { username: 'bot', name: 'Chatbot AI' } }, 1000);
  const phoneKey = customerEditKey({ id: conversationKey, phone: '0912345678' });
  assert.equal(phoneKey, 'phone:0912345678');
  await addCustomerNote(phoneKey, { text: 'NV: đã gọi xác nhận' }, 3000);
  assert.deepEqual((await listCustomerNotes(phoneKey)).map(note => note.text), ['NV: đã gọi xác nhận'], 'không có aliases: như cũ');
  const merged = await listCustomerNotes(phoneKey, { aliases: [conversationKey, phoneKey, conversationKey] });
  assert.deepEqual(merged.map(note => note.at), [3000, 1000]);
  assert.equal(merged[1].text, 'Bot: SĐT trùng đơn hội thoại khác');
  // Khách chưa có SĐT: editKey chính là id, alias trùng không nhân đôi.
  assert.equal((await listCustomerNotes(conversationKey, { aliases: [conversationKey] })).length, 1);
});

test('applyCustomerEdits: staffNoteCount/noteCount tính cả ghi chú dưới khoá hội thoại, khử trùng', () => {
  const note = (id, at) => ({ id, at, text: `ghi chú ${id}` });
  const edits = {
    'phone:0912345678': { name: 'Lan sửa', notes: [note('a', 3000)] },
    'p1:u1': { notes: [note('b', 1000), note('a', 3000)] },
    'p2:u2': { notes: [note('c', 500)] }
  };
  const customers = [
    { id: 'p1:u1', phone: '0912345678', noteCount: 2, labels: [] },
    { id: 'p2:u2', phone: '', noteCount: 0, labels: [] }
  ];
  applyCustomerEdits(customers, edits);
  assert.equal(customers[0].staffNoteCount, 2, 'a (trùng ở hai khoá) + b');
  assert.equal(customers[0].noteCount, 4);
  assert.equal(customers[0].lastStaffNoteAt, 3000);
  assert.equal(customers[0].name, 'Lan sửa', 'phần sửa hồ sơ vẫn lấy theo khoá chính');
  assert.equal(customers[1].staffNoteCount, 1, 'khách chưa có SĐT: khoá chính là id');
});

test('server: route ghi chú khách truyền customer.id làm alias', () => {
  const server = readFileSync(new URL('../app/server.mjs', import.meta.url), 'utf8');
  assert.match(server, /listCustomerNotes\(customer\.editKey, \{ aliases: \[customer\.id\] \}\)/);
});
