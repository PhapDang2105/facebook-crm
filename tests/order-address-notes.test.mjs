// Vòng 12: đơn bot tạo mang addressCheck / deliveryNote → ghi chú Xử lý dữ liệu ("⚠ …", "ℹ Giao: …") và ghi chú POS.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { tempDir } from './helpers/temp-dir.mjs';

const directory = tempDir('order-notes-12-');
process.env.POS_CONFIG_PATH = path.join(directory, 'pos-config.json');
process.env.META_CONVERSATIONS_PATH = path.join(directory, 'meta-conversations.json');
await import('./helpers/seed-catalog.mjs');
const { normalizeChatbotOrder } = await import('../app/conversation-orders.mjs');
const { processingNotes } = await import('../app/order-notes.mjs');
const { buildPosOrderPayload } = await import('../app/pos-orders.mjs');

const input = extra => ({
  items: [{ name: 'Granola Túi Vàng 350g', code: 'GRA-VANG-H350', quantity: 2 }],
  total: 298000,
  phone: '0909123456',
  address: '12 Lê Lợi, Phường Bến Nghé, Quận 1, TP Hồ Chí Minh',
  ...extra
});

test('đơn bot: chép addressCheck và deliveryNote sang bản ghi đơn → ghi chú "⚠ …" / "ℹ Giao: …" và ghi chú POS', () => {
  const order = normalizeChatbotOrder(input({ addressCheck: 'Địa chỉ nhận sau một lần hỏi, soát phường/xã', deliveryNote: 'giao giờ hành chính' }), { name: 'Chị Lan' }, { now: Date.UTC(2026, 8, 30), id: 'b12' });
  assert.equal(order.addressCheck, 'Địa chỉ nhận sau một lần hỏi, soát phường/xã');
  assert.equal(order.deliveryNote, 'giao giờ hành chính');
  const notes = processingNotes(order);
  assert.ok(notes.includes('⚠ Địa chỉ nhận sau một lần hỏi, soát phường/xã'), JSON.stringify(notes));
  assert.ok(notes.includes('ℹ Giao: giao giờ hành chính'), JSON.stringify(notes));
  const { note } = buildPosOrderPayload(order, { shopId: '1', warehouseId: 'wh' });
  assert.match(note, /Giao: giao giờ hành chính/);
  assert.match(note, /⚠ Địa chỉ nhận sau một lần hỏi/);
  // Không có thì không ghi trường rỗng.
  const plain = normalizeChatbotOrder(input({}), { name: 'Chị Lan' }, { now: Date.UTC(2026, 8, 30), id: 'b13' });
  assert.equal('addressCheck' in plain, false);
  assert.equal('deliveryNote' in plain, false);
  assert.doesNotMatch(buildPosOrderPayload(plain, { shopId: '1', warehouseId: 'wh' }).note, /Giao:|⚠/);
});
