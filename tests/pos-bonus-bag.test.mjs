import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPosOrderPayload } from '../app/pos-orders.mjs';

// Đơn 5 Túi Vàng: quà "1 Túi Vàng 350g" cùng SKU với dòng hàng vẫn phải lên POS thành dòng tặng riêng.
test('đơn 5 Túi Vàng đẩy POS kèm dòng Túi Vàng tặng (giá 0)', () => {
  const order = {
    id: 'T5VANG',
    phone: '0900000001',
    customerName: 'Khách thử',
    address: '1 Đường A, Phường B, TP Hồ Chí Minh',
    products: [{ sku: 'GRA-VANG-H350', name: 'Túi Vàng 350g', quantity: 5, price: 149000 }],
    total: 745000
  };
  const payload = buildPosOrderPayload(order, { warehouseId: 'w', shopId: 's' });
  const items = payload.items || payload.order?.items || [];
  const vang = items.filter(item => String(item.variation_id).toUpperCase().includes('VANG'));
  const bonus = vang.filter(item => item.is_bonus_product);
  assert.ok(bonus.length >= 1, `thiếu dòng Túi Vàng tặng: ${JSON.stringify(items.map(i => [i.variation_id, i.quantity, i.is_bonus_product]))}`);
  assert.equal(bonus[0].variation_info.retail_price, 0);
});
