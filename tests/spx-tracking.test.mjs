import assert from 'node:assert/strict';
import { normalizeSpxPayload, normalizeTrackingNumber } from '../app/spx-tracking.mjs';

assert.equal(normalizeTrackingNumber(' spxvn123456 '), 'SPXVN123456');
assert.throws(() => normalizeTrackingNumber('x'), /không hợp lệ/i);

const normalized = normalizeSpxPayload({
  retcode: 0,
  data: {
    order_info: { spx_tn: 'SPXVN123456' },
    parcel_info: { customer_tracking_no: '3799229-35540' },
    edd_info: { edd_min: 1788973199, edd_max: 1788973199 },
    sls_tracking_info: {
      records: [
        { tracking_name: 'Đã lấy hàng', description: 'SPX đã lấy hàng', actual_time: 1788800000 },
        { tracking_name: 'Loaded to Truck', description: 'Đơn hàng đã lên xe trung chuyển', actual_time: 1788850000, display_flag: 0 },
        { tracking_name: 'Đang giao hàng', description: 'Đơn hàng đang được giao', actual_time: 1788900000 }
      ]
    }
  }
}, 'SPXVN123456');

assert.equal(normalized.trackingNumber, 'SPXVN123456');
assert.equal(normalized.customerTrackingNumber, '3799229-35540');
assert.match(normalized.expectedDeliveryAt, /^2026-/);
assert.equal(normalized.status, 'Đang giao hàng');
assert.equal(normalized.records.length, 2);
assert.equal(normalized.records[0].status, 'Đang giao hàng');
assert.match(normalized.records[0].time, /^2026-/);
assert.throws(() => normalizeSpxPayload({ retcode: 2 }, 'SPXVN404'), /Không tìm thấy/);

console.log('PASS: SPX tracking normalization');
