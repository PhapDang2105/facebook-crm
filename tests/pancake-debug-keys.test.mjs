import test from 'node:test';
import assert from 'node:assert/strict';

const { describePancakePayload } = await import('../app/pancake.mjs');

test('chẩn đoán gói tin Pancake: liệt kê khoá, nêu giá trị khoá gợi nguồn, không lộ nội dung tin', () => {
  const line = describePancakePayload({
    event_type: 'messaging',
    page_id: '103549382215599',
    data: {
      conversation: { id: 'c1', type: 'INBOX', from: { id: 'u1', name: 'Khách Bí Mật' }, ads: [{ ad_id: 'ad9' }], referral: { ref: 'tmdt-01', source: 'SHORTLINK' } },
      message: { id: 'm_1', message: 'số điện thoại 0901234567', from: { id: 'u1' } }
    }
  });
  assert.match(line, /event=messaging/);
  assert.match(line, /data\.conversation\.referral\.ref/);
  assert.match(line, /data\.conversation\.ads\[0\]\.ad_id/);
  assert.match(line, /referral\.ref=tmdt-01/);
  assert.match(line, /referral\.source=SHORTLINK/);
  assert.doesNotMatch(line, /Khách Bí Mật|0901234567/, 'không ghi tên khách hay nội dung tin');
  assert.match(describePancakePayload({ event_type: 'messaging', data: { message: { id: 'm' } } }), /không có khoá nào tên ref/);
});
