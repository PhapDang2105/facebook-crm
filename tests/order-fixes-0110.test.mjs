// Vòng sửa phần đơn hàng 01/10: mã đơn tạo tay trùng, đơn chuyển khoản lên POS
// như COD, file kho mất quà live/quà POS, đơn live tặng hai bát, đẩy POS hai lần
// khi hết giờ. (Đếm cảnh báo SĐT bỏ đơn hủy: tests/phone-warnings.test.mjs.)
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tempDir } from './helpers/temp-dir.mjs';

const directory = tempDir('orderfix-');
process.env.POS_CONFIG_PATH = path.join(directory, 'pos-config.json');
process.env.META_CONVERSATIONS_PATH = path.join(directory, 'meta-conversations.json');
process.env.LANDING_ORDERS_PATH = path.join(directory, 'landing-orders.json');
process.env.ORDER_ARCHIVE_PATH = path.join(directory, 'order-archive');
process.env.POS_PUSH_ORDERS = '1';

// Danh mục thử nạp TRƯỚC mọi thứ dưới app/.
await import('./helpers/seed-catalog.mjs');
const { reloadCatalog, giftsForKey } = await import('../app/processing/catalog.mjs');
const { buildPosOrderPayload, syncOrderToPos, posPrepaidAmount } = await import('../app/pos-orders.mjs');
const { buildExportRows, exportFactsForOrders } = await import('../app/order-export.mjs');
const { normalizeChatbotOrder, normalizeCustomerOrder } = await import('../app/conversation-orders.mjs');
const { applyCustomerOrderEdits } = await import('../app/order-edits.mjs');
const { uniqueOrderId, reserveOrderIdInStore, takenOrderIds } = await import('../app/order-lookup.mjs');
const { updateMessagingStore, ensureConversation, readMessagingStore } = await import('../app/messaging-store.mjs');
const { updateLandingStore } = await import('../app/landing-orders.mjs');
const { appendOrderToArchive } = await import('../app/order-archive.mjs');

const XANH = 'GRA-XANH-Z450';
const ADDRESS = '12 Nguyễn Huệ, Phường Bến Nghé, Quận 1, TP Hồ Chí Minh';
const LIVE_GIFT = { id: 'qua-tang-live', name: 'Quạt + Bát gáo dừa', active: true, minQuantity: 2, maxQuantity: 2, livestreamOnly: true, excludedSkus: [], sku: 'QUA-TANG-LIVE', weight: 50 };

/** Chạy `run` với bảng quà đã sửa bởi `edit`, rồi trả bảng quà gốc. */
async function withGifts(edit, run) {
  const original = readFileSync(process.env.GIFTS_PATH, 'utf8');
  const gifts = JSON.parse(original);
  edit(gifts);
  writeFileSync(process.env.GIFTS_PATH, JSON.stringify(gifts));
  reloadCatalog();
  try {
    return await run();
  } finally {
    writeFileSync(process.env.GIFTS_PATH, original);
    reloadCatalog();
  }
}

// ===== 1. Mã đơn tạo tay không trùng =====

test('mã đơn tạo tay: mã ngắn chưa dùng giữ nguyên; trùng (đơn đang có, landing, kho lưu trữ kể cả đơn đã xóa) thì thêm hậu tố -2, -3', async () => {
  assert.equal(uniqueOrderId('51234', new Set()), '51234');
  assert.equal(uniqueOrderId('51234', new Set(['51234'])), '51234-2');
  assert.equal(uniqueOrderId('51234', new Set(['51234', '51234-2'])), '51234-3');
  assert.match(uniqueOrderId('', new Set()), /^\d{5}$/);
  await updateMessagingStore(store => {
    const conversation = ensureConversation(store, { pageId: 'p1', psid: 'u-ids', name: 'Khách mã' });
    conversation.customerOrders = [{ id: '40001', name: 'A', phone: '0385805790', products: [] }];
    return null;
  });
  await updateLandingStore(store => { store.orders.unshift({ id: '40002', name: 'B', phone: '0385805791', products: [] }); });
  await appendOrderToArchive({ id: '40003', phone: '0385805792', createdAt: Date.now(), products: [] }, { status: 'deleted' });
  const taken = await takenOrderIds();
  for (const id of ['40001', '40002', '40003']) {
    assert.ok(taken.has(id), `mã ${id} đã dùng`);
    assert.equal(uniqueOrderId(id, taken), `${id}-2`);
  }
  assert.equal(uniqueOrderId('40004', taken), '40004');
  // Kiểm lại trong lượt ghi kho (hai người tạo cùng lúc).
  const store = await readMessagingStore();
  const order = { id: '40001' };
  assert.equal(reserveOrderIdInStore(order, store), '40001-2');
  assert.equal(reserveOrderIdInStore({ id: '49999' }, store), '49999');
  // Mã có hậu tố vẫn hợp lệ qua chuẩn hoá đơn (chỉ giữ chữ, số, gạch).
  assert.equal(normalizeCustomerOrder({ id: '40001-2', name: 'A', phone: '0385805790', address: ADDRESS, products: [{ name: 'Granola Túi Xanh 450g', sku: XANH, quantity: 1, price: 174000 }] }).id, '40001-2');
  // Máy chủ dùng mã duy nhất khi tạo đơn tay và trả mã thật cho trình duyệt.
  const server = readFileSync(new URL('../app/server.mjs', import.meta.url), 'utf8');
  const create = server.slice(server.indexOf("if (payload.type === 'order') {"), server.indexOf("if (payload.type === 'order') {") + 4000);
  assert.match(create, /order\.id = uniqueOrderId\(order\.id, await takenOrderIds\(\)\);/);
  assert.match(create, /reserveOrderIdInStore\(order, store\);/);
  assert.match(server, /createdOrderId: order\.id/);
});

// ===== 2. Chuyển khoản → POS không thu COD =====

test('đơn "Chuyển khoản" lên POS: transfer_money = tổng, cod = 0, ghi chú "Đã chuyển khoản"; đặt cọc thì COD phần còn lại; COD giữ nguyên', () => {
  const base = { id: 'ck1', name: 'A', phone: '0385805790', address: ADDRESS, products: [{ name: 'Granola Túi Xanh 450g', sku: XANH, quantity: 1, price: 174000, weight: 450 }], shippingFee: 15000, freeShipping: false, discount: 0, total: 189000 };
  const transfer = buildPosOrderPayload({ ...base, payment: 'Chuyển khoản' });
  assert.equal(transfer.transfer_money, 189000);
  assert.equal(transfer.cod, 0);
  assert.match(transfer.note, /Đã chuyển khoản 189\.000đ, KHÔNG thu COD/);
  const deposit = buildPosOrderPayload({ ...base, payment: 'COD', prepaid: 50000 });
  assert.equal(deposit.transfer_money, 50000);
  assert.equal(deposit.cod, 139000);
  assert.match(deposit.note, /đặt cọc.*thu COD 139\.000đ/);
  const cod = buildPosOrderPayload({ ...base, payment: 'COD' });
  assert.equal('transfer_money' in cod, false);
  assert.equal('cod' in cod, false);
  assert.doesNotMatch(cod.note, /chuyển khoản/i);
  assert.equal(posPrepaidAmount({ total: 100000, prepaid: 500000 }), 100000, 'cọc không vượt tổng');
  assert.equal(posPrepaidAmount({ total: 100000, payment: 'chuyen khoan' }), 100000);
  // Đặt cọc đi qua chuẩn hoá đơn.
  assert.equal(normalizeCustomerOrder({ ...base, prepaid: '50.000' }).prepaid, 50000);
  assert.equal('prepaid' in normalizeCustomerOrder(base), false);
});

// ===== 3 + 6. File kho đủ quà; quà live không cộng quà khuyến mãi =====

const headers = ['Mã đơn hàng', 'Khách hàng', 'Số điện thoại', 'Địa chỉ', 'Sản phẩm', 'Mã mẫu mã', 'Số lượng', 'Đơn giá', 'Ghi chú'];
const row = (id, sku, quantity, price, { address = ADDRESS, note = '', name = sku } = {}) => [id, 'A', '0385805790', address, name, sku, String(quantity), String(price), note];
const lines = rows => rows.map(item => `${item[19]}x${item[21]}@${item[22]}`);

test('xuất kho: đơn nhân viên tạo cho khách live (cờ livestream, địa chỉ không "(Live)") có dòng quà live; live + ưu đãi bám đuổi không thêm bát thứ hai', async () => {
  await withGifts(gifts => gifts.items.push(LIVE_GIFT), () => {
    const manual = { id: '51234', source: 'Facebook', livestream: true, products: [{ sku: XANH, quantity: 2 }] };
    const data = { headers, rows: [row('CB-51234', XANH, 2, 149000)] };
    // Trước đây: dòng bảng không mang cờ live → mất quà live.
    assert.deepEqual(lines(buildExportRows(data)), ['GRA-XANH-Z450x2@149000']);
    assert.deepEqual(lines(buildExportRows(data, { orderFacts: exportFactsForOrders([manual]) })), ['GRA-XANH-Z450x2@149000', 'QUA-TANG-LIVEx1@0']);
    // Live 2 túi + quà bám đuổi (cờ promoGift / ghi chú): chỉ quà live, không BGD.
    const note = 'Khách ghi: Ưu đãi bám đuổi combo 2 túi: tặng Bộ bát gáo dừa – ưu đãi bám đuổi.';
    const promoLive = buildExportRows({ headers, rows: [row('CB-r9', XANH, 2, 149000, { address: `(Live) ${ADDRESS}`, note })] }, { orderFacts: exportFactsForOrders([{ id: 'r9', source: 'Facebook', livestream: true, promoGift: 'Bộ bát gáo dừa' }]) });
    assert.deepEqual(lines(promoLive), ['GRA-XANH-Z450x2@149000', 'QUA-TANG-LIVEx1@0']);
    // Khách thường 2 túi + bám đuổi vẫn nhận BGD như cũ.
    assert.deepEqual(lines(buildExportRows({ headers, rows: [row('CB-r10', XANH, 2, 149000)] }, { orderFacts: exportFactsForOrders([{ id: 'r10', source: 'Facebook', promoGift: 'Bộ bát gáo dừa' }]) })), ['GRA-XANH-Z450x2@149000', 'BGDx1@0']);
    // Khách live 3 túi: chỉ bát + muỗng.
    assert.deepEqual(lines(buildExportRows({ headers, rows: [row('CB-r11', XANH, 3, 149000)] }, { orderFacts: exportFactsForOrders([{ id: 'r11', source: 'Facebook', livestream: true }]) })), ['GRA-XANH-Z450x3@149000', 'BGDx1@0', 'MUONGx1@0']);
  });
});

test('xuất kho đơn nguồn POS: ghi đúng các dòng tặng trên POS (quà live nhân viên thêm), combo đã gồm bát + muỗng không ghi trùng; đơn kéo về trước đây tra quà theo tên', async () => {
  await withGifts(gifts => gifts.items.push(LIVE_GIFT), () => {
    const live = { id: 'pos777', source: 'POS', products: [{ sku: 'CB2-XANH-Z450', quantity: 1 }], giftItems: [{ sku: 'QUA-TANG-LIVE', name: 'Quạt + Bát gáo dừa', quantity: 1 }] };
    const data = { headers, rows: [row('CB-pos777', 'CB2-XANH-Z450', 1, 298000, { name: 'Combo 2 túi xanh' })] };
    assert.deepEqual(lines(buildExportRows(data)), ['GRA-XANH-Z450x2@149000'], 'trước đây: mất quà live của đơn POS');
    assert.deepEqual(lines(buildExportRows(data, { orderFacts: exportFactsForOrders([live]) })), ['GRA-XANH-Z450x2@149000', 'QUA-TANG-LIVEx1@0']);
    const combo3 = { id: 'pos778', source: 'POS', giftItems: [{ sku: 'BGD', quantity: 1 }, { sku: 'MUONG', quantity: 1 }] };
    const three = buildExportRows({ headers, rows: [row('CB-pos778', 'CB3-XANH-Z450+BGD+M', 1, 447000, { name: 'Combo 3 túi xanh' })] }, { orderFacts: exportFactsForOrders([combo3]) });
    assert.deepEqual(lines(three).filter(line => /^(BGD|MUONG)x/.test(line)), ['BGDx1@0', 'MUONGx1@0'], 'mỗi quà một dòng, không trùng');
    // Đơn POS kéo về trước 01/10: chỉ có chữ quà.
    const legacy = { id: 'pos779', source: 'POS', gift: 'Quạt + Bát gáo dừa' };
    assert.deepEqual(lines(buildExportRows({ headers, rows: [row('CB-pos779', 'CB2-XANH-Z450', 1, 298000)] }, { orderFacts: exportFactsForOrders([legacy]) })), ['GRA-XANH-Z450x2@149000', 'QUA-TANG-LIVEx1@0']);
  });
});

test('quà live không cộng dồn quà khuyến mãi: bảng quà thiếu "tối đa 2 túi" vẫn không tặng quà live cho 3 túi; 2 túi live chỉ quà live (giữ miễn ship)', async () => {
  await withGifts(gifts => {
    gifts.items.push({ ...LIVE_GIFT, maxQuantity: 0 });
    // Bộ bát cấu hình từ 2 túi: khách live 2 túi vẫn chỉ nhận quà live.
    gifts.items.find(gift => gift.sku === 'BGD').minQuantity = 2;
  }, () => {
    assert.deepEqual(giftsForKey(`${XANH}=3`, { livestream: true }).map(gift => gift.sku || gift.id), ['freeship', 'BGD', 'MUONG']);
    assert.deepEqual(giftsForKey(`${XANH}=2`, { livestream: true }).map(gift => gift.sku || gift.id), ['freeship', 'QUA-TANG-LIVE']);
    assert.deepEqual(giftsForKey(`${XANH}=2`).map(gift => gift.sku || gift.id), ['freeship', 'BGD'], 'khách thường không đổi');
  });
  await withGifts(gifts => gifts.items.push(LIVE_GIFT), () => {
    // POS: đơn live 2 túi có cờ ưu đãi bám đuổi → chỉ dòng quà live.
    const posSkus = new Set([XANH, 'BGD', 'MUONG', 'QUA-TANG-LIVE']);
    const twoBags = { id: 'lv2', name: 'A', phone: '0385805790', address: ADDRESS, products: [{ name: 'Granola Túi Xanh 450g', sku: XANH, quantity: 2, price: 174000 }], freeShipping: true, shippingFee: 0, discount: 50000, total: 298000 };
    const bonus = payload => payload.items.filter(item => item.is_bonus_product).map(item => item.variation_id);
    assert.deepEqual(bonus(buildPosOrderPayload({ ...twoBags, livestream: true, promoGift: 'Bộ bát gáo dừa' }, { posSkus })), ['QUA-TANG-LIVE']);
    assert.deepEqual(bonus(buildPosOrderPayload({ ...twoBags, promoGift: 'Bộ bát gáo dừa' }, { posSkus })), ['BGD'], 'khách thường vẫn nhận bát bám đuổi');
    // Bot chốt đơn live 2 túi trong cửa sổ bám đuổi: không ghi promoGift, chữ quà bỏ phần bát ưu đãi.
    const promo = 'Bộ bát gáo dừa – ưu đãi bám đuổi';
    const liveConversation = { name: 'Khách', post: { message: 'Săn deal hời – live tối nay' } };
    const order = normalizeChatbotOrder({ items: [{ code: XANH, quantity: 2 }], phone: '0909123456', address: ADDRESS, total: 298000, promoGift: promo, gift: `Miễn phí vận chuyển + Quạt + Bát gáo dừa + ${promo}` }, liveConversation, { id: 'lv3' });
    assert.equal(order.promoGift, undefined);
    assert.equal(order.gift, 'Miễn phí vận chuyển + Quạt + Bát gáo dừa');
    const normal = normalizeChatbotOrder({ items: [{ code: XANH, quantity: 2 }], phone: '0909123456', address: ADDRESS, total: 298000, promoGift: promo }, { name: 'Khách' }, { id: 'lv4' });
    assert.equal(normal.promoGift, promo);
    // Sửa đơn (tính lại giỏ) của khách live 2 túi còn cờ bám đuổi cũ → bỏ cờ.
    const edited = normalizeChatbotOrder({ items: [{ code: XANH, quantity: 3 }], phone: '0909123456', address: ADDRESS, total: 447000 }, liveConversation, { id: 'lv5' });
    edited.promoGift = promo;
    applyCustomerOrderEdits(edited, { lines: [{ sku: XANH, name: edited.products[0].name, quantity: '2' }] });
    assert.equal(edited.promoGift, undefined);
    assert.doesNotMatch(edited.gift, /ưu đãi bám đuổi/);
    assert.match(edited.gift, /Quạt \+ Bát gáo dừa/);
  });
});

// ===== 7. Hết giờ khi đẩy POS: kiểm POS trước khi đẩy lại =====

const config = { apiKey: 'k', shopId: '714334721', baseUrl: 'https://pos.example/api/v1' };

function posMock(state) {
  return async (url, options = {}) => {
    const address = String(url);
    const method = options.method || 'GET';
    state.calls.push({ address, method });
    if (address.includes('/products/variations')) return { ok: true, status: 200, json: async () => ({ data: [{ id: `v-${XANH}`, display_id: XANH }] }) };
    if (address.includes('/warehouses')) return { ok: true, status: 200, json: async () => ({ data: [{ id: 'wh-1', province_id: '701', allow_create_order: true }] }) };
    if (method === 'POST' && /\/orders\?api_key=k$/.test(address)) {
      if (state.post === 'timeout') throw Object.assign(new Error('This operation was aborted'), { name: 'AbortError' });
      return { ok: true, status: 200, json: async () => ({ data: { id: 88001, system_id: 501, status_name: 'new' } }) };
    }
    if (method === 'GET' && /\/orders\?/.test(address) && address.includes('search=')) {
      if (state.search === 'fail') return { ok: false, status: 502, json: async () => ({}) };
      return { ok: true, status: 200, json: async () => ({ data: state.posOrders || [] }) };
    }
    throw new Error(`gọi lạ: ${method} ${address}`);
  };
}

async function seedOrder(id) {
  await updateMessagingStore(store => {
    const conversation = ensureConversation(store, { pageId: 'p7', psid: `u-${id}`, name: 'Khách POS' });
    conversation.pancakeConversationId = `p7_${id}`;
    conversation.customerOrders = [{ id, name: 'Khách POS', phone: '0385805790', address: ADDRESS, products: [{ name: 'Granola Túi Xanh 450g', sku: XANH, quantity: 1, price: 174000, weight: 450 }], shippingFee: 15000, freeShipping: false, discount: 0, total: 189000 }];
    return null;
  });
  return `p7:u-${id}`;
}

const posts = state => state.calls.filter(call => call.method === 'POST').length;

test('đẩy POS hết giờ: ghi lỗi "chưa chắc", lần đẩy lại kiểm POS (custom_id CRM-…/ghi chú) — đã có thì nhận mã, không POST lần hai', async () => {
  const conversationId = await seedOrder('to1');
  const state = { calls: [], post: 'timeout', posOrders: [] };
  const first = await syncOrderToPos(conversationId, 'to1', { config, fetchImpl: posMock(state), log: () => {} });
  assert.equal(first.uncertain, true);
  assert.match(first.error, /không phản hồi/);
  assert.equal(posts(state), 1);
  assert.ok(state.calls.some(call => call.method === 'GET' && call.address.includes('search=0385805790')), 'hỏi lại POS ngay sau khi hết giờ');
  // POS thật ra đã tạo đơn (tìm theo SĐT, khớp custom_id); mã đơn khác chỉ trùng tiền tố không được nhận.
  state.post = 'ok';
  state.posOrders = [
    { id: 'CRM-to10', custom_id: 'CRM-to10', note: 'Đơn CRM #to10', status: 0 },
    { id: 'CRM-to1', custom_id: 'CRM-to1', system_id: 777, status_name: 'Mới', note: 'Đơn CRM #to1 · tạo bởi Bạn', status: 0 }
  ];
  const retry = await syncOrderToPos(conversationId, 'to1', { config, fetchImpl: posMock(state), log: () => {} });
  assert.equal(retry.id, 'CRM-to1');
  assert.equal(retry.recovered, true);
  assert.equal(posts(state), 1, 'không POST lần hai');
  const saved = (await readMessagingStore()).conversations.find(item => item.id === conversationId).customerOrders[0];
  assert.equal(saved.pos.id, 'CRM-to1');
});

test('đẩy POS hết giờ: không kiểm được POS thì KHÔNG đẩy mù; kiểm được và chưa có thì mới đẩy lại; khóa chống đẩy đồng thời', async () => {
  const conversationId = await seedOrder('to2');
  const state = { calls: [], post: 'timeout', posOrders: [] };
  await syncOrderToPos(conversationId, 'to2', { config, fetchImpl: posMock(state), log: () => {} });
  assert.equal(posts(state), 1);
  state.post = 'ok';
  state.search = 'fail';
  const blocked = await syncOrderToPos(conversationId, 'to2', { config, fetchImpl: posMock(state), log: () => {} });
  assert.equal(blocked.uncertain, true);
  assert.match(blocked.error, /Chưa kiểm được đơn trên Pancake POS/);
  assert.equal(posts(state), 1, 'POS không trả lời thì không POST');
  state.search = 'ok';
  // Hai lệnh đẩy cùng lúc (bot + nhân viên bấm): một lần kiểm, một lần POST.
  const [one, two] = await Promise.all([
    syncOrderToPos(conversationId, 'to2', { config, fetchImpl: posMock(state), log: () => {} }),
    syncOrderToPos(conversationId, 'to2', { config, fetchImpl: posMock(state), log: () => {} })
  ]);
  assert.equal(one.id, '88001');
  assert.equal(two.id, '88001');
  assert.equal(posts(state), 2, 'đúng một POST mới sau khi kiểm POS chưa có đơn');
  // Lỗi chắc chắn (POS từ chối) không đánh dấu "chưa chắc".
  const conversation3 = await seedOrder('to3');
  const reject = { calls: [], posOrders: [] };
  const rejectFetch = async (url, options = {}) => {
    if ((options.method || 'GET') === 'POST') return { ok: false, status: 422, json: async () => ({ success: false, message: 'invalid phone' }) };
    return posMock(reject)(url, options);
  };
  const rejected = await syncOrderToPos(conversation3, 'to3', { config, fetchImpl: rejectFetch, log: () => {} });
  assert.match(rejected.error, /422/);
  assert.equal(rejected.uncertain, undefined);
});
