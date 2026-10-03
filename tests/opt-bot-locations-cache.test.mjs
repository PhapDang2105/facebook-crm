// Tối ưu chatbot (P3): normalizeChar nhớ theo ký tự; resolveAddress nhớ ~200 kết quả gần nhất (chỉ mục đã nạp).
// Kết quả nhớ dùng chung giữa các lần gọi → đóng băng sâu kết quả rồi chạy mọi hàm dùng nó: không hàm nào được sửa.
import assert from 'node:assert/strict';
import test from 'node:test';
import './helpers/seed-catalog.mjs';
import {
  resolveAddress, describeDeliveryAddress, mergeAddressFragment, resolvedAddressFields, typedVsPickedConflict,
  addressTailConflict, formatResolvedAddress, canonicalLocationColumns, normalizeExportLocation, streetForDisplay,
  normalizeLocationKey, loadLocationIndex
} from '../app/processing/locations.mjs';
import { orderFlowStep } from '../app/processing/order-flow.mjs';
import { ruleIntent } from '../app/processing/rule-intent.mjs';
import { renderChatbotReply } from '../app/chatbot-templates.mjs';
import { templates, XANH, basket } from './helpers/r13-engine-sim.mjs';

const deepFreeze = (value, seen = new Set()) => {
  if (value && typeof value === 'object' && !seen.has(value)) {
    seen.add(value);
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child, seen);
  }
  return value;
};

const ADDRESSES = [
  '12 Lê Lợi, phường Bến Nghé, quận 1, TPHCM',
  '176/1A KP1, An Phú Đông, Q12, HCM',
  'xóm 3 xã Vô Tranh huyện Phú Lương Thái Nguyên',
  '83 hải phòng Dà nẵng phường Hải châu',
  'Số 17, đường 38, P. Thảo Điền'
];

test('P3: normalizeLocationKey giữ nguyên kết quả (bỏ dấu, đ→d, gộp phân cách)', () => {
  assert.equal(normalizeLocationKey('Đường Lê Lợi, Phường Bến Nghé;\nQuận 1'), 'duong le loi phuong ben nghe quan 1');
  assert.equal(normalizeLocationKey('  Ấp 4 — Hòa Bình!  '), 'ap 4 hoa binh');
});

test('P3: resolveAddress nhớ kết quả cho cùng chuỗi; chỉ mục khác không dùng bộ nhớ', () => {
  const first = resolveAddress(ADDRESSES[0]);
  assert.equal(resolveAddress(ADDRESSES[0]), first);
  assert.ok(first.province);
  const other = { ...loadLocationIndex() }; // chỉ mục khác (bản sao nông)
  const fromOther = resolveAddress(ADDRESSES[0], other);
  assert.notEqual(fromOther, first);
  assert.deepEqual(JSON.stringify(fromOther), JSON.stringify(first));
  assert.equal(resolveAddress(ADDRESSES[0], loadLocationIndex()), first);
});

test('P3: kết quả đã đóng băng — mọi hàm dùng resolveAddress chạy được, kết quả không đổi', () => {
  const plain = ADDRESSES.map(text => JSON.stringify(resolveAddress(text)));
  for (const text of ADDRESSES) deepFreeze(resolveAddress(text));
  assert.deepEqual(ADDRESSES.map(text => JSON.stringify(resolveAddress(text))), plain);
  for (const text of ADDRESSES) {
    describeDeliveryAddress(text);
    mergeAddressFragment(text, ADDRESSES[0]);
    mergeAddressFragment(ADDRESSES[2], text);
    resolvedAddressFields(text);
    typedVsPickedConflict(text, { province: 'Hà Nội', district: 'Quận 1', ward: 'Phường Bến Nghé' });
    addressTailConflict(text);
    formatResolvedAddress(resolveAddress(text));
    canonicalLocationColumns({ address: text });
    normalizeExportLocation(text);
    streetForDisplay(text);
    const ctx = { hasBasket: true, lastWasOrderStep: true, source: 'inbox', botLastTemplateId: 'ORDER_ADDRESS', botLastAgeMin: 2, experimentalRules: 'on', addressText: text };
    orderFlowStep(`0912345678 ${text}`, ctx);
    ruleIntent(`0912345678 ${text}`, ctx);
    renderChatbotReply({ template_id: 'ORDER_ADDRESS', Phone_Number: '0912345678', Customer_Address: text }, templates,
      { pendingOrder: basket([XANH(2)]), lastTemplateId: 'ORDER_ADDRESS', messageText: `0912345678 ${text}`, now: Date.now() });
  }
});
