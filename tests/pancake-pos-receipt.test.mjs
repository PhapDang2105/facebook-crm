import test from 'node:test';
import assert from 'node:assert/strict';
import { pancakeMessageEvent } from '../app/pancake.mjs';

const conversation = { id: '110_555', type: 'INBOX', from: { id: '555', name: 'Khách' } };

test('thẻ xác nhận đơn (receipt template) do Pancake POS gửi khách được ghi như receipt, không thành "[Tệp đính kèm]"', () => {
  const event = pancakeMessageEvent('110', conversation, {
    id: 'm_pos_receipt', from: { id: '110', admin_name: 'POS' }, inserted_at: '2026-09-19T08:43:27.796573', message: '<div></div>',
    attachments: [{ type: 'template', payload: { template_type: 'receipt', recipient_name: 'Pháp Đặng', summary: { total_cost: 298000 }, elements: [] } }]
  });
  assert.equal(event.message.direction, 'outgoing');
  assert.equal(event.message.type, 'order-receipt');
  assert.equal(event.message.text, 'Đã gửi xác nhận đơn hàng');
  assert.equal(event.pancake.staff, true, 'POS gửi, không phải Public API: vẫn coi là người của Page');
});

test('tệp đính kèm khác (không phải ảnh/video/receipt) vẫn ghi là tệp đính kèm', () => {
  const event = pancakeMessageEvent('110', conversation, {
    id: 'm_file', from: { id: '555' }, inserted_at: '2026-09-19T08:43:27', message: '',
    attachments: [{ type: 'file', url: 'https://content.pancake.vn/x.pdf' }]
  });
  assert.equal(event.message.type, 'attachment');
  assert.equal(event.message.text, '[Tệp đính kèm]');
});
