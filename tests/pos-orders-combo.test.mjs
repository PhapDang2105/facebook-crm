import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { tempDir } from './helpers/temp-dir.mjs';

// Vòng rà 28/09: combo POS khi giá CRM cao hơn niêm yết, quà bám đuổi, sửa/hủy đơn trên POS, tên tỉnh "TP …".
const directory = tempDir('poscombo-');
process.env.POS_CONFIG_PATH = path.join(directory, 'pos-config.json');
process.env.META_CONVERSATIONS_PATH = path.join(directory, 'meta-conversations.json');
process.env.POS_COMBOS_PATH = path.join(directory, 'khong-co-pos-combos.json');
process.env.POS_PUSH_ORDERS = '1';

await import('./helpers/seed-catalog.mjs');
const { buildPosOrderPayload, posComboPlan, updatePosOrder, pushOrderToPos, cancelPosOrder, isCrmOwnedPosOrder, findGeo, resolvePosGeo } = await import('../app/pos-orders.mjs');

const config = { apiKey: 'k', shopId: '714334721', baseUrl: 'https://pos.example/api/v1' };
const PRICES = { 'CB2-XANH-Z450': 298000, 'CB2-NAU-Z350': 288000, 'CB3-XANH-Z450+BGD+M': 447000, 'CB-VANGG+XANH': 298000, 'GRA-XANH-Z450': 189000, 'GRA-NAU-Z350': 179000, 'GRA-VANG-H350': 189000, BGD: 23000, MUONG: 17000 };
const posPrices = new Map(Object.entries(PRICES).map(([sku, price]) => [sku, { id: `v-${sku}`, productId: `p-${sku}`, retailPrice: price }]));
const posSkus = new Set(posPrices.keys());
const base = { id: 'o1', name: 'A', phone: '0909123456', address: '12 Lê Lợi, Quận 1, TP Hồ Chí Minh', freeShipping: true, shippingFee: 0, gift: '' };
const bag = (sku, quantity, price) => ({ name: sku, sku, quantity, price, weight: 450 });
const cod = payload => payload.items.filter(item => !item.is_bonus_product).reduce((sum, item) => sum + item.quantity * item.variation_info.retail_price, 0) - payload.discount + (payload.is_free_shipping ? 0 : payload.shipping_fee);

test('V1: giá hàng CRM CAO HƠN niêm yết combo POS → không dùng mã combo, đẩy từng túi (COD = CRM), có cảnh báo', () => {
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = message => warnings.push(String(message));
  try {
    // Nhân viên tạo 2 Xanh giá lẻ 174k (tổng 348k), POS niêm yết CB2 298k.
    const high = { ...base, products: [bag('GRA-XANH-Z450', 2, 174000)], discount: 0, total: 348000 };
    const payload = buildPosOrderPayload(high, { posSkus, posPrices });
    assert.deepEqual(payload.items.map(item => item.variation_id), ['GRA-XANH-Z450']);
    assert.equal(payload.discount, 0);
    assert.equal(cod(payload), 348000);
    assert.equal(posComboPlan(high, { posSkus, posPrices, warn: false }).combo, null);
    assert.ok(warnings.some(text => /cao hơn giá niêm yết combo CB2-XANH-Z450/.test(text)));
    // CRM 2 Nâu 298k > CB2-NAU 288k.
    const nau = buildPosOrderPayload({ ...base, products: [bag('GRA-NAU-Z350', 2, 149000)], discount: 0, total: 298000 }, { posSkus, posPrices });
    assert.equal(nau.items[0].variation_id, 'GRA-NAU-Z350');
    assert.equal(cod(nau), 298000);
  } finally {
    console.warn = originalWarn;
  }
  // Giá CRM ≤ niêm yết: vẫn một dòng combo, chênh thành giảm giá.
  const ok = buildPosOrderPayload({ ...base, products: [bag('GRA-XANH-Z450', 2, 174000)], discount: 60000, total: 288000 }, { posSkus, posPrices });
  assert.deepEqual(ok.items.map(item => [item.variation_id, item.variation_info.retail_price]), [['CB2-XANH-Z450', 298000]]);
  assert.equal(ok.discount, 10000);
  assert.equal(cod(ok), 288000);
});

test('V1: đơn tổng 0 (lỗi/chưa có giá) không đẩy bằng combo (trước đây combo 298k + giảm 298k)', () => {
  const zero = buildPosOrderPayload({ ...base, products: [bag('GRA-XANH-Z450', 2, 0)], discount: 0, total: 0 }, { posSkus, posPrices });
  assert.deepEqual(zero.items.map(item => item.variation_id), ['GRA-XANH-Z450']);
  assert.equal(zero.discount, 0);
});

// Danh sách mẫu mã POS được nhớ 1 giờ trong module: mọi lời gọi trong tệp dùng cùng một bộ —
// POS chỉ có mã combo, không có túi lẻ GRA-XANH-Z450 hay MIX5-H420.
const POS_ONLY_COMBOS = ['CB-VANGG+XANH', 'CB2-XANH-Z450'];
function posFetch(calls, { variations = Object.keys(PRICES), existingNote = null, getFails = false } = {}) {
  return async (url, options = {}) => {
    const address = String(url);
    const method = options.method || 'GET';
    calls.push({ address, method, body: options.body ? JSON.parse(options.body) : null });
    if (address.includes('/products/variations')) return { ok: true, status: 200, json: async () => ({ data: variations.map(sku => ({ id: `v-${sku}`, product_id: `p-${sku}`, display_id: sku, retail_price: PRICES[sku] || 0 })) }) };
    if (address.includes('/warehouses')) return { ok: true, status: 200, json: async () => ({ data: [{ id: 'wh-1', allow_create_order: true, province_id: '701' }] }) };
    if (address.includes('/geo/')) return { ok: true, status: 200, json: async () => ({ data: [] }) };
    if (/\/orders\/[^/?]+\?api_key=k$/.test(address) && method === 'GET') {
      if (getFails) return { ok: false, status: 500, json: async () => ({}) };
      return { ok: true, status: 200, json: async () => ({ data: { id: 'CRM-o1', note: existingNote, items: [] } }) };
    }
    if (/\/orders\/[^/?]+\?api_key=k$/.test(address) && method === 'PUT') return { ok: true, status: 200, json: async () => ({ success: true }) };
    if (address.endsWith('/orders?api_key=k') && method === 'POST') return { ok: true, status: 200, json: async () => ({ id: 'CRM-o1', system_id: 1 }) };
    throw new Error(`gọi lạ: ${method} ${address}`);
  };
}

test('V1: updatePosOrder dùng giá niêm yết POS như lúc tạo — PUT combo với giảm giá đúng, không tính lại giá combo = tổng CRM', async () => {
  const calls = [];
  const order = { ...base, pos: { id: 'CRM-o1' }, products: [bag('GRA-XANH-Z450', 1, 174000), bag('GRA-VANG-H350', 1, 174000)], discount: 60000, total: 288000 };
  await updatePosOrder(order, { config, fetchImpl: posFetch(calls, { variations: POS_ONLY_COMBOS }) });
  const put = calls.find(call => call.method === 'PUT');
  assert.equal(put.body.items.length, 1);
  assert.equal(put.body.items[0].variation_id, 'v-CB-VANGG+XANH');
  assert.equal(put.body.items[0].variation_info.retail_price, 298000, 'giá niêm yết POS, không phải tổng CRM');
  assert.equal(put.body.discount, 10000);
});

test('nhẹ (a): đẩy bằng combo chỉ cần mã combo có trên POS (không đòi từng túi lẻ); SKU POS không có → báo lỗi rõ', async () => {
  const calls = [];
  const order = { ...base, id: 'o2', products: [bag('GRA-XANH-Z450', 2, 174000)], discount: 50000, total: 298000 };
  // POS chỉ có mã combo, không có túi lẻ GRA-XANH-Z450.
  const created = await pushOrderToPos(order, { config, fetchImpl: posFetch(calls, { variations: POS_ONLY_COMBOS }) });
  assert.equal(created.id, 'CRM-o1');
  const post = calls.find(call => call.method === 'POST');
  assert.deepEqual(post.body.items.map(item => item.variation_id), ['v-CB2-XANH-Z450']);
  await assert.rejects(
    updatePosOrder({ ...base, pos: { id: 'CRM-o3' }, products: [bag('MIX5-H420', 2, 269000)], discount: 10000, total: 528000 }, { config, fetchImpl: posFetch([], { variations: POS_ONLY_COMBOS }) }),
    /POS không có mẫu mã: MIX5-H420/
  );
});

test('V3: quà bát gáo dừa bám đuổi (promoGift) chỉ đẩy khi giỏ đúng 2 túi và combo chưa gồm bát', () => {
  const promo = 'Bộ bát gáo dừa – ưu đãi bám đuổi';
  const bonus = payload => payload.items.filter(item => item.is_bonus_product).map(item => item.variation_id);
  const two = buildPosOrderPayload({ ...base, products: [bag('GRA-XANH-Z450', 2, 174000)], discount: 50000, total: 298000, promoGift: promo }, { posSkus, posPrices });
  assert.deepEqual(bonus(two), ['BGD']);
  // Cờ sót sau khi sửa sang 1 túi / 3 túi: không thêm BGD (3 túi combo đã gồm bát trong mã).
  const one = buildPosOrderPayload({ ...base, products: [bag('GRA-XANH-Z450', 1, 174000)], discount: 0, total: 189000, freeShipping: false, shippingFee: 15000, promoGift: promo }, { posSkus, posPrices });
  assert.deepEqual(bonus(one), []);
  const three = buildPosOrderPayload({ ...base, products: [bag('GRA-XANH-Z450', 3, 174000)], discount: 75000, total: 447000, promoGift: promo }, { posSkus, posPrices });
  assert.deepEqual(three.items.map(item => item.variation_id), ['CB3-XANH-Z450+BGD+M']);
});

test('N2: chỉ đơn CRM tạo mới được sửa trên POS; đơn nhân viên lên trên POS rồi kéo về thì không', () => {
  assert.equal(isCrmOwnedPosOrder({ id: 'ab12', source: 'Facebook', pos: { id: '99001', systemId: '1' } }), true);
  assert.equal(isCrmOwnedPosOrder({ id: 'ab12', pos: { id: 'CRM-ab12' } }), true);
  assert.equal(isCrmOwnedPosOrder({ id: 'pos52682', source: 'POS', pos: { id: '777', systemId: '52682', importedAt: 1 } }), false);
  assert.equal(isCrmOwnedPosOrder({ id: 'pos1', source: 'POS', pos: { id: '777' } }), false);
  assert.equal(isCrmOwnedPosOrder({ id: 'ab12', pos: { error: 'lỗi' } }), false, 'chưa có trên POS');
});

test('nhẹ (c): hủy trên POS nối "khách hủy (CRM)" vào ghi chú đang có, không ghi đè; đọc lỗi thì như cũ', async () => {
  const calls = [];
  await cancelPosOrder({ id: 'o1', pos: { id: 'CRM-o1' } }, { config, fetchImpl: posFetch(calls, { existingNote: 'NV Hằng: gọi trước 17h · Quà: Bộ bát gáo dừa' }) });
  const put = calls.find(call => call.method === 'PUT');
  assert.equal(put.body.status, 6);
  assert.equal(put.body.note, 'NV Hằng: gọi trước 17h · Quà: Bộ bát gáo dừa · khách hủy (CRM)');
  const failed = [];
  await cancelPosOrder({ id: 'o1', pos: { id: 'CRM-o1' } }, { config, fetchImpl: posFetch(failed, { getFails: true }) });
  assert.equal(failed.find(call => call.method === 'PUT').body.note, 'Đơn CRM #o1 · khách hủy');
});

test('V5: tỉnh CRM "TP Hồ Chí Minh" khớp tên POS "Hồ Chí Minh" / "Thành phố Hồ Chí Minh"', async () => {
  for (const posName of ['Hồ Chí Minh', 'Thành phố Hồ Chí Minh', 'TP. Hồ Chí Minh']) {
    assert.equal(findGeo([{ id: 79, name: posName }], 'TP Hồ Chí Minh')?.id, 79, posName);
  }
  assert.equal(findGeo([{ id: 1, name: 'Thành phố Hà Nội' }], 'Hà Nội')?.id, 1);
  assert.equal(findGeo([{ id: 1, name: 'Đà Nẵng' }], 'TP Hồ Chí Minh'), null);
  const geo = await resolvePosGeo({ province: 'TP Hồ Chí Minh', district: 'Quận 1', ward: 'Phường Bến Nghé' }, config, async url => {
    const kind = new URL(url).pathname.split('/').pop();
    const data = kind === 'provinces' ? [{ id: '701', name: 'Hồ Chí Minh' }] : kind === 'districts' ? [{ id: '70101', name: 'Quận 1' }] : [{ id: '7010101', name: 'Phường Bến Nghé' }];
    return { ok: true, json: async () => ({ data }) };
  });
  assert.deepEqual(geo, { provinceId: '701', districtId: '70101', communeId: '7010101' });
});
