// 06/10 (chủ shop): form Tạo đơn "chưa cho chọn địa chỉ" khi khách đã nhắn địa chỉ — gợi ý SĐT + địa chỉ cho ô "Chọn địa chỉ".
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { addressSuggestions, conversationPhones } from '../app/processing/order-flow.mjs';

const MIN = 60 * 1000;
const now = Date.parse('2026-10-06T06:40:00Z');
const msg = (direction, text, agoMin, extra = {}) => ({ id: `m${agoMin}${direction}`, direction, type: 'text', text, createdAt: now - agoMin * MIN, ...extra });

test('tin khách nhắn địa chỉ (kèm SĐT, kèm tên) → gợi ý đầu tiên, bỏ SĐT; câu hỏi / tin ngắn không lấy', () => {
  const messages = [
    msg('outgoing', 'Dạ chị cho em xin số điện thoại và địa chỉ nha ạ.', 30),
    msg('incoming', 'ship về quận 1 được không shop?', 25),
    msg('incoming', 'B', 20),
    msg('incoming', '12 Nguyễn Trãi, phường Bến Thành, Quận 1, TP HCM 0912345678', 10)
  ];
  const items = addressSuggestions({ conversation: {}, messages, now });
  assert.equal(items.length, 1, JSON.stringify(items));
  assert.equal(items[0].source, 'message');
  assert.match(items[0].address, /Nguyễn Trãi/);
  assert.doesNotMatch(items[0].address, /0912345678/);
  assert.deepEqual(conversationPhones({}, messages), ['0912345678']);
});

test('thứ tự: giỏ bot → tin khách → đơn CRM → đơn POS; trùng chữ chỉ một; đơn hủy bỏ qua', () => {
  const conversation = {
    pendingOrder: { address: '5 Lê Lợi, phường Bến Nghé, Quận 1, TP HCM', phone: '0987654321', at: now - 2 * MIN },
    customerOrders: [
      { id: 'o1', address: '5 Lê Lợi, phường Bến Nghé, Quận 1, TP HCM', phone: '0987654321', createdAt: now - 3 * 86400000 },
      { id: 'o2', address: '9 Hai Bà Trưng, phường Bến Nghé, Quận 1, TP HCM', phone: '0987654321', createdAt: now - 9 * 86400000 },
      { id: 'o3', address: '1 Hủy Rồi, Quận 3, TP HCM', processingStatus: 'cancelled', createdAt: now - 86400000 }
    ]
  };
  const posOrders = [
    { id: 55001, status: 3, bill_phone_number: '0987654321', inserted_at: '2026-09-14T03:00:00', shipping_address: { address: 'thôn Đồng Tâm', commune_name: 'Xã Đinh Văn', district_name: 'Huyện Lâm Hà', province_name: 'Tỉnh Lâm Đồng' } },
    { id: 55002, status: 6, bill_phone_number: '0987654321', inserted_at: '2026-09-15T03:00:00', shipping_address: { address: 'đơn đã hủy', province_name: 'Hà Nội' } }
  ];
  const items = addressSuggestions({ conversation, messages: [], posOrders, now });
  assert.deepEqual(items.map(item => item.source), ['basket', 'order', 'pos']);
  assert.match(items[1].address, /Hai Bà Trưng/);
  assert.match(items[2].address, /Đồng Tâm.*Lâm Đồng/);
  assert.equal(items[2].orderId, '55001');
  assert.deepEqual(conversationPhones(conversation, []), ['0987654321']);
});

test('máy chủ có API gợi ý, giao diện đổ gợi ý vào ô "Chọn địa chỉ" và tự điền khi form còn trống', () => {
  const server = readFileSync(new URL('../app/server.mjs', import.meta.url), 'utf8');
  assert.match(server, /address-suggestions\$\//);
  assert.match(server, /addressSuggestions\(\{ conversation, messages, posOrders \}\)/);
  const web = readFileSync(new URL('../web/app.js', import.meta.url), 'utf8');
  assert.match(web, /\/address-suggestions`/);
  assert.match(web, /function fillCustomerOrderFromSuggestions/);
  assert.match(web, /customerAddressSuggestions\.delete\(changedId\)/);
});
