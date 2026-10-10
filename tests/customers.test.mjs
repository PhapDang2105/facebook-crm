import { writeFileSync } from 'node:fs';
import { seed } from './helpers/temp-messaging-store.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { buildCustomers, customersToCsv, filterCustomers } from '../app/customers.mjs';

const page = '100000000000001';
const store = {
  conversations: [
    { id: `${page}:55`, pageId: page, psid: '55', name: 'Nguyễn Thị Lan', picture: 'p.jpg', source: 'inbox', gender: 'female', genderSource: 'name', labels: ['new'], createdAt: 1000, lastMessageAt: 5000, lastCustomerMessageAt: 4000, lastMessagePreview: 'ok', referral: { adId: 'ad1', adTitle: 'Granola giảm 20%' }, customerOrders: [{ phone: '0909123456', address: 'Q12', total: 298000 }], customerNotes: [{}], botEnabled: false },
    { id: `${page}:comment:55:${page}_9`, pageId: page, psid: '55', name: 'Lan', source: 'comment', gender: 'female', genderSource: 'staff', labels: ['consulting'], createdAt: 500, lastMessageAt: 9000, lastCustomerMessageAt: 9000, lastMessagePreview: 'giá sao', botEnabled: true },
    { id: `${page}:77`, pageId: page, psid: '77', name: 'Trần Văn Hùng', source: 'inbox', labels: [], createdAt: 2000, lastMessageAt: 3000, lastCustomerMessageAt: 3000, pendingOrder: { phone: '0385805790' } },
    { id: `${page}:${page}`, pageId: page, psid: page, name: 'Trang', source: 'inbox', labels: [], createdAt: 1, lastMessageAt: 1 }
  ],
  messages: { [`${page}:55`]: [{ direction: 'outgoing', createdAt: 900 }, { direction: 'incoming', createdAt: 1200 }] }
};

test('gộp mọi luồng của một người thành một khách hàng, bỏ chính Page', () => {
  const customers = buildCustomers(store, [{ id: page, name: 'Giọt Nắng' }]);
  assert.equal(customers.length, 2);
  const lan = customers[0];
  assert.equal(lan.id, `${page}:55`);
  assert.equal(lan.name, 'Nguyễn Thị Lan', 'inbox name beats the comment name');
  assert.equal(lan.channelName, 'Giọt Nắng');
  assert.deepEqual(lan.sources, ['ads', 'comment']);
  assert.equal(lan.gender, 'female');
  assert.equal(lan.genderSource, 'staff', 'the strongest gender source wins');
  assert.equal(lan.firstContactAt, 500);
  assert.equal(lan.lastMessageAt, 9000);
  assert.equal(lan.lastCustomerMessageAt, 9000);
  assert.equal(lan.phone, '0909123456');
  assert.equal(lan.orderCount, 1);
  assert.equal(lan.orderTotal, 298000);
  assert.deepEqual(lan.labels, ['new', 'consulting']);
  assert.equal(lan.botEnabled, true);
  assert.equal(lan.conversations.length, 2);
  const hung = customers[1];
  assert.equal(hung.phone, '0385805790', 'the basket the bot collected supplies the phone');
  assert.equal(hung.firstContactAt, 2000);
});

test('lọc theo từ khóa không dấu, nguồn, giới tính, thẻ, kênh và số ngày tương tác', () => {
  const customers = buildCustomers(store);
  assert.equal(filterCustomers(customers, { q: 'lan' }).length, 1);
  assert.equal(filterCustomers(customers, { q: '0385' }).length, 1);
  assert.equal(filterCustomers(customers, { q: 'tran van' }).length, 1);
  assert.equal(filterCustomers(customers, { source: 'comment' }).length, 1);
  assert.equal(filterCustomers(customers, { gender: 'female' }).length, 1);
  assert.equal(filterCustomers(customers, { label: 'customer' }).length, 0);
  assert.equal(filterCustomers(customers, { channelId: 'other' }).length, 0);
  // lastMessageAt của hai khách là 9000 và 3000; mốc "now" giả định là 9000.
  assert.equal(filterCustomers(customers, { activeWithin: 1 }, 9000 + 86400000).length, 1);
  assert.equal(filterCustomers(customers, { activeWithin: 1 }, 9000).length, 2);
  assert.equal(filterCustomers(customers, { activeWithin: 0 }, 9000).length, 2, 'bỏ trống thì không lọc');
});

test('CSV cho Excel: BOM, tiêu đề tiếng Việt, ô có dấu phẩy được bọc', () => {
  const csv = customersToCsv(buildCustomers(store));
  assert.ok(csv.startsWith('﻿Tên,ID Facebook,Giới tính'));
  assert.match(csv, /"Quảng cáo, Bình luận"/);
  assert.match(csv, /Nguyễn Thị Lan,55,Nữ/);
});

// --- Remarketing: ai đã mua gì, mua khi nào, mua combo mấy túi ---
const now = Date.UTC(2026, 8, 15);
const day = 86400000;
const shopPage = '100000000000002';
const remarketingStore = {
  conversations: [
    {
      id: `${shopPage}:1`, pageId: shopPage, psid: '1', name: 'Chị Mai', source: 'inbox', labels: [],
      createdAt: 1, lastMessageAt: now - day,
      customerOrders: [
        { createdAt: now - 3 * day, phone: '0909123456', address: 'Quận 7', total: 398000, products: [{ name: 'Granola Nguyên Bản', sku: 'GRA-01', quantity: 2 }] }
      ]
    },
    {
      id: `${shopPage}:2`, pageId: shopPage, psid: '2', name: 'Anh Dũng', source: 'inbox', labels: [],
      createdAt: 1, lastMessageAt: now - day,
      customerOrders: [
        { createdAt: now - 40 * day, phone: '0912345678', address: 'Hà Nội', total: 199000, products: [{ name: 'Yến Mạch Úc', sku: 'YMU-01', quantity: 1 }] },
        { createdAt: now - 60 * day, phone: '0912345678', address: 'Hà Nội', total: 597000, products: [{ name: 'Granola Nguyên Bản', sku: 'GRA-01', quantity: 3 }] }
      ]
    },
    { id: `${shopPage}:3`, pageId: shopPage, psid: '3', name: 'Khách hỏi giá', source: 'inbox', labels: [], createdAt: 1, lastMessageAt: now - day }
  ],
  messages: {}
};

test('gộp sản phẩm đã mua, ngày mua và combo lớn nhất của từng khách', () => {
  const [mai, dung, hoi] = buildCustomers(remarketingStore, []);
  assert.equal(mai.lastOrderAt, now - 3 * day);
  assert.equal(mai.comboMax, 2, 'combo tính theo tổng số túi trong một đơn');
  assert.deepEqual(mai.products.map(item => [item.sku, item.quantity]), [['GRA-01', 2]]);
  assert.equal(dung.comboMax, 3);
  assert.equal(dung.firstOrderAt, now - 60 * day);
  assert.equal(dung.lastOrderAt, now - 40 * day);
  assert.deepEqual(dung.products.map(item => item.sku), ['YMU-01', 'GRA-01'], 'mua gần nhất đứng trước');
  // Cột "Sản phẩm đã mua" trên bảng chỉ lấy đơn gần nhất, không cộng dồn.
  assert.deepEqual(dung.lastOrderProducts.map(item => [item.sku, item.quantity]), [['YMU-01', 1]]);
  assert.equal(dung.lastOrderCombo, 1, 'combo hiển thị theo đơn gần nhất');
  assert.equal(dung.comboMax, 3, 'còn bộ lọc combo vẫn xét mọi đơn');
  assert.deepEqual(mai.lastOrderProducts.map(item => [item.sku, item.quantity]), [['GRA-01', 2]]);
  assert.deepEqual(hoi.lastOrderProducts, []);
  assert.equal(hoi.comboMax, 0);
  assert.deepEqual(hoi.products, []);
});

test('cột Đã chi cộng mọi đơn, cột Đơn gần nhất chỉ lấy đơn mới nhất', () => {
  const [mai, dung, hoi] = buildCustomers(remarketingStore, []);
  assert.equal(mai.orderTotal, 398000);
  assert.equal(mai.lastOrderTotal, 398000, 'khách một đơn thì hai cột bằng nhau');
  assert.equal(dung.orderTotal, 199000 + 597000, 'Đã chi cộng cả hai đơn');
  assert.equal(dung.lastOrderTotal, 199000, 'Đơn gần nhất lấy đơn mới nhất, không phải đơn to nhất');
  assert.equal(hoi.orderTotal, 0);
  assert.equal(hoi.lastOrderTotal, 0, 'khách chưa mua thì chưa có đồng nào');
});

test('lọc remarketing: mua trong N ngày, theo sản phẩm, theo combo, theo số lần mua', () => {
  const all = buildCustomers(remarketingStore, []);
  const names = filters => filterCustomers(all, filters, now).map(item => item.name);
  assert.deepEqual(names({ orderedWithin: '7' }), ['Chị Mai'], 'chốt đơn trong 7 ngày trước');
  assert.deepEqual(names({ orderedWithin: '90' }), ['Chị Mai', 'Anh Dũng']);
  assert.deepEqual(names({ combo: '2' }), ['Chị Mai', 'Anh Dũng'], 'combo 2 là từ 2 túi trở lên');
  assert.deepEqual(names({ combo: '3' }), ['Anh Dũng']);
  assert.deepEqual(names({ product: 'YMU-01' }), ['Anh Dũng']);
  assert.deepEqual(names({ product: 'granola' }), ['Chị Mai', 'Anh Dũng'], 'khớp cả tên không dấu');
  assert.deepEqual(names({ minOrders: '2' }), ['Anh Dũng']);
  assert.deepEqual(names({ orderedWithin: '7', combo: '3' }), [], 'các bộ lọc cộng dồn');
  assert.deepEqual(names({ q: 'yen mach' }), ['Anh Dũng'], 'tìm kiếm chạm cả sản phẩm đã mua');
});

test('lọc Số đơn từ–đến và khoảng ngày MUA LẦN CUỐI (chủ shop 10/10: bộ lọc đơn hàng, thời gian mua hàng)', () => {
  const all = buildCustomers(remarketingStore, []);
  const names = filters => filterCustomers(all, filters, now).map(item => item.name);
  // Mai 1 đơn (12/09), Dũng 2 đơn (17/07 và 06/08), khách hỏi giá 0 đơn.
  assert.deepEqual(names({ minOrders: '1', maxOrders: '1' }), ['Chị Mai'], 'đúng 1 đơn');
  assert.deepEqual(names({ minOrders: '2', maxOrders: '2' }), ['Anh Dũng'], 'đúng 2 đơn');
  assert.deepEqual(names({ minOrders: '3' }), []);
  assert.deepEqual(names({ maxOrders: '' }), ['Chị Mai', 'Anh Dũng', 'Khách hỏi giá'], 'bỏ trống thì không lọc');

  assert.deepEqual(names({ orderedFrom: '2026-09-12' }), ['Chị Mai'], 'mua lần cuối từ 12/09');
  assert.deepEqual(names({ orderedFrom: '2026-09-13' }), []);
  assert.deepEqual(names({ orderedTo: '2026-09-11' }), ['Anh Dũng'], '"lâu chưa mua lại": khách chưa có đơn không lọt vào');
  assert.deepEqual(names({ orderedFrom: '2026-08-01', orderedTo: '2026-08-31' }), ['Anh Dũng']);
  assert.deepEqual(names({ orderedFrom: '2026-07-01', orderedTo: '2026-07-31' }), [], 'Dũng có mua tháng 7 nhưng lần cuối là tháng 8: cột Mua lần cuối luôn khớp khoảng đã chọn');
  assert.deepEqual(names({ orderedFrom: '2026-08-31', orderedTo: '2026-08-01' }), ['Anh Dũng'], 'chọn ngược hai đầu vẫn là khoảng đó');
  assert.deepEqual(names({ orderedFrom: '2026-02-31' }), ['Chị Mai', 'Anh Dũng', 'Khách hỏi giá'], 'ngày không có thật: bỏ qua, không lọc sai');
  assert.deepEqual(names({ orderedFrom: '12/09/2026' }), ['Chị Mai', 'Anh Dũng', 'Khách hỏi giá'], 'sai định dạng: bỏ qua');
  assert.deepEqual(names({ minOrders: '2', orderedTo: '2026-09-11' }), ['Anh Dũng'], 'cộng dồn với lọc số đơn');

  // Ranh giới ngày theo giờ Việt Nam (UTC+7), không theo giờ máy chủ (VM chạy UTC):
  // 23:59:59 ngày 30/09 giờ VN là 16:59:59Z; 00:00 ngày 01/10 giờ VN là 17:00Z ngày 30/09.
  const at = iso => ({ name: iso, lastOrderAt: Date.parse(iso), orderCount: 1, sources: [], labels: [], products: [] });
  const edge = [at('2026-09-30T16:59:59.999Z'), at('2026-09-30T17:00:00.000Z')];
  const edgeNames = filters => filterCustomers(edge, filters, now).map(item => item.name);
  assert.deepEqual(edgeNames({ orderedTo: '2026-09-30' }), ['2026-09-30T16:59:59.999Z']);
  assert.deepEqual(edgeNames({ orderedFrom: '2026-10-01' }), ['2026-09-30T17:00:00.000Z']);
  assert.equal(edgeNames({ orderedFrom: '2026-09-30', orderedTo: '2026-10-01' }).length, 2);
});

test('danh sách remarketing đổi số về dạng 84 và bỏ khách chưa có số', async () => {
  const { customersToAudienceCsv } = await import('../app/customers.mjs');
  const csv = customersToAudienceCsv(buildCustomers(remarketingStore, []));
  const lines = csv.replace('﻿', '').trim().split('\r\n');
  assert.deepEqual(lines, ['phone,fn,country', '84909123456,Chị Mai,VN', '84912345678,Anh Dũng,VN']);
});

test('màn Khách hàng chỉ gồm người ĐÃ NHẬN HÀNG (chủ shop 10/10): mới đặt, đang giao, hỏi giá không lọt vào; khách landing đã nhận có mặt', async () => {
  const { findCustomerById, invalidateBuyersCache, listCustomers } = await import('../app/customers.mjs');
  // Mai nhận hàng rồi (vận đơn Sapo giao thành công); Dũng có đơn nhưng chưa có tin giao; khách hỏi giá chưa mua.
  const store = structuredClone(remarketingStore);
  store.conversations[0].customerOrders[0].shipment = { trackingNumber: 'SPX0001', status: 'delivered' };
  seed(store);
  // Kho landing đọc một lần rồi nhớ trong bộ nhớ: ghi trước lượt đọc đầu tiên của tiến trình test này.
  writeFileSync(process.env.LANDING_ORDERS_PATH, JSON.stringify({ recent: [], orders: [
    { id: 'lp-nhan', createdAt: now - 4 * day, name: 'Chị Landing', phone: '0977000111', address: 'Đà Nẵng', total: 189000,
      status: 'Đã xác nhận', products: [{ name: 'Granola Túi Xanh 450g', sku: 'GRA-XANH', quantity: 1 }], shipment: { trackingNumber: 'SPX0002', status: 'delivered' } },
    { id: 'lp-dang-giao', createdAt: now - day, name: 'Anh Đang Giao', phone: '0977000222', address: 'Huế', total: 189000,
      status: 'Đã xác nhận', products: [{ name: 'Granola Túi Xanh 450g', sku: 'GRA-XANH', quantity: 1 }], shipment: { trackingNumber: 'SPX0003', status: 'delivering' } }
  ] }));
  invalidateBuyersCache();
  const result = await listCustomers({});
  assert.deepEqual(result.items.map(item => item.name), ['Chị Mai', 'Chị Landing']);
  assert.equal(result.total, 2, 'tổng số cũng chỉ đếm người đã nhận hàng');
  const landing = result.items.find(item => item.name === 'Chị Landing');
  assert.equal(landing.id, 'landing:0977000111');
  assert.deepEqual(landing.sources, ['landing']);
  assert.equal(landing.orderCount, 1);
  assert.equal((await listCustomers({ source: 'landing' })).items.length, 1, 'lọc nguồn "Landing page" có khách');
  // Hộp chi tiết, ghi chú… vẫn tra được người đã mua mà chưa nhận hàng (đơn đang giao).
  assert.equal((await findCustomerById(`${shopPage}:2`))?.name, 'Anh Dũng');
  assert.equal((await findCustomerById('landing:0977000222'))?.name, 'Anh Đang Giao');
  assert.ok(buildCustomers(remarketingStore, []).some(customer => customer.orderCount === 0),
    'buildCustomers vẫn giữ cả người chưa mua cho các nơi khác dùng');
});

test('đã nhận hàng: vận đơn giao thành công (Sapo hay hãng), POS Đã nhận / Đã thu tiền, thẻ "Giao hàng thành công", tính theo SĐT', () => {
  const shop = '100000000000011';
  const order = (id, phone, extra = {}) => ({ id, createdAt: now - 5 * day, phone, address: 'Quận 1', total: 189000, products: [{ name: 'Granola Túi Xanh 450g', sku: 'GRA-XANH', quantity: 1 }], ...extra });
  const conversation = (psid, name, orders, extra = {}) => ({ id: `${shop}:${psid}`, pageId: shop, psid, name, source: 'inbox', labels: [], createdAt: 1, lastMessageAt: now - day, customerOrders: orders, ...extra });
  const store = {
    conversations: [
      conversation('1', 'Sapo giao xong', [order('o1', '0901000001', { shipment: { trackingNumber: 'T1', status: 'delivered' } })]),
      conversation('2', 'Hãng báo giao xong', [order('o2', '0901000002', { shipment: { trackingNumber: 'T2', status: 'delivering', carrierStage: 'delivered' } })]),
      conversation('3', 'POS đã nhận', [order('o3', '0901000003', { posStatus: { code: 3, name: 'received' } })]),
      conversation('4', 'POS đã thu tiền', [order('o4', '0901000004', { posStatus: { code: 16, name: 'collected' } })]),
      conversation('5', 'Đang giao', [order('o5', '0901000005', { shipment: { trackingNumber: 'T5', status: 'delivering' } })]),
      conversation('6', 'Bom hàng', [order('o6', '0901000006', { shipment: { trackingNumber: 'T6', status: 'delivered', carrierStage: 'returning' } })]),
      conversation('7', 'Mới đặt', [order('o7', '0901000007', { posStatus: { code: 1, name: 'submitted' } })]),
      conversation('8', 'Có thẻ giao thành công', [order('o8', '0901000008')], { labels: ['delivered'] }),
      conversation('9', 'Nhận đơn landing', [order('o9', '0901000009')]),
      // Cùng người, Page khác: đơn ở Page kia đã giao thì người này đã là khách.
      { ...conversation('10', 'Sapo giao xong (Page 2)', [order('o10', '0901000001')]), id: '200000000000001:10', pageId: '200000000000001' }
    ],
    messages: {}
  };
  const landingOrders = [{ ...order('lp9', '0901000009', { name: 'Nhận đơn landing', shipment: { trackingNumber: 'T9', status: 'delivered' } }), createdAt: now - 20 * day }];
  const all = buildCustomers(store, [], [], { landingOrders, deliveredLabels: ['delivered'] });
  const received = all.filter(customer => customer.received).map(customer => customer.name).sort();
  assert.deepEqual(received, ['Có thẻ giao thành công', 'Hãng báo giao xong', 'Nhận đơn landing', 'POS đã nhận', 'POS đã thu tiền', 'Sapo giao xong', 'Sapo giao xong (Page 2)'].sort());
  const viaLanding = all.find(customer => customer.name === 'Nhận đơn landing');
  assert.equal(viaLanding.orderCount, 2, 'đơn landing cùng SĐT cộng vào khách hội thoại, không tách thành khách riêng');
  assert.deepEqual(viaLanding.sources, ['inbox', 'landing']);
  // Không cấu hình thẻ nhận sự kiện "delivered": thẻ không tự làm ai thành khách đã nhận hàng.
  assert.equal(buildCustomers(store, [], [], { landingOrders }).find(customer => customer.name === 'Có thẻ giao thành công').received, false);
});

test('đơn landing vào danh sách khách: không đếm trùng với đơn hội thoại hay tệp xuất kho, bỏ form dở và đơn hủy', () => {
  const shop = '100000000000012';
  const item = { name: 'Granola Túi Vàng 350g', sku: 'GRA-VANG', quantity: 1 };
  const store = {
    conversations: [{ id: `${shop}:1`, pageId: shop, psid: '1', name: 'Chị Hoa', source: 'inbox', labels: [], createdAt: 1, lastMessageAt: now - day,
      customerOrders: [{ id: 'chung', createdAt: now - 2 * day, phone: '0912000001', total: 174000, products: [item] }] }],
    messages: {}
  };
  const landingOrders = [
    // Cùng mã với đơn đã có trong hội thoại: không cộng lần hai.
    { id: 'chung', createdAt: now - 2 * day, phone: '0912000001', name: 'Hoa', total: 174000, products: [item] },
    { id: 'lp-moi', createdAt: now - 6 * day, phone: '0912000002', name: 'Anh Tú', address: 'Cần Thơ', total: 174000, products: [item] },
    { id: 'lp-do', createdAt: now - 3 * day, phone: '0912000003', name: 'Bỏ dở', total: 174000, products: [item], landing: { incomplete: true } },
    { id: 'lp-huy', createdAt: now - 3 * day, phone: '0912000004', name: 'Đã hủy', total: 174000, products: [item], processingStatus: 'cancelled' }
  ];
  const exported = [
    // Đơn landing đã xuất kho mang tiền tố "LP-": cùng một đơn với lp-moi.
    { phone: '0912000002', name: 'Anh Tú', orders: [{ id: 'LP-lp-moi', orderedAt: now - 6 * day, total: 174000, products: [item] }] },
    // Đơn xuất kho mà kho landing báo hủy: không tính.
    { phone: '0912000004', name: 'Đã hủy', orders: [{ id: 'LP-lp-huy', orderedAt: now - 3 * day, total: 174000, products: [item] }] }
  ];
  const all = buildCustomers(store, [], exported, { landingOrders });
  const byName = name => all.find(customer => customer.name === name);
  assert.equal(byName('Chị Hoa').orderCount, 1);
  assert.equal(byName('Anh Tú').orderCount, 1, 'đơn landing và bản xuất kho của nó là một đơn');
  assert.equal(byName('Anh Tú').id, 'landing:0912000002');
  assert.deepEqual(byName('Anh Tú').sources, ['landing', 'export']);
  assert.equal(byName('Anh Tú').address, 'Cần Thơ');
  assert.equal(all.some(customer => customer.name === 'Bỏ dở'), false, 'form bỏ dở chưa là đơn');
  assert.equal(byName('Đã hủy').orderCount, 0, 'đơn hủy không cộng dù đã nằm trong tệp xuất kho');
});

test('cột Ghi chú lấy ghi chú hội thoại mới nhất; CSV có thêm Trạng thái liên hệ và Ghi chú gần nhất', () => {
  const shop = '100000000000009';
  const customers = buildCustomers({
    conversations: [{
      id: `${shop}:9`, pageId: shop, psid: '9', name: 'Chị Ngọc', source: 'inbox', labels: [], createdAt: 1, lastMessageAt: 5,
      customerNotes: [
        { id: 'b', text: 'ghi chú cũ', createdAt: 100 },
        { id: 'a', text: 'Hẹn gọi chiều', createdAt: 200, author: { username: 'ha', name: 'Hà' } },
        { id: 'c', text: '   ', createdAt: 300 }
      ],
      customerOrders: [{ createdAt: 150, phone: '0909000111', address: 'Quận 1', total: 298000, products: [{ name: 'Túi Xanh', sku: 'GRA-XANH-Z450', quantity: 2 }] }]
    }],
    messages: {}
  });
  const customer = customers.find(item => item.psid === '9');
  assert.deepEqual(customer.lastNote, { text: 'Hẹn gọi chiều', at: 200, by: 'Hà' }, 'ghi chú trống bị bỏ qua');
  const [header, row] = customersToCsv([{ ...customer, contactStatus: 'unreachable' }]).replace(/^﻿/, '').trim().split('\r\n');
  assert.ok(header.endsWith(',Trạng thái liên hệ,Ghi chú gần nhất'), header);
  assert.ok(row.endsWith(',Không gọi được,Hẹn gọi chiều'), row);
  assert.ok(customersToCsv([{ ...customer, lastNote: undefined }]).trim().endsWith(',Chưa liên hệ,'), 'chưa chọn: Chưa liên hệ, ghi chú trống');
});

test('giới tính (10/10): khách landing đoán theo tên; lọc Nữ / Nam / Chưa rõ', () => {
  const item = { name: 'Granola Túi Xanh 450g', sku: 'GRA-XANH', quantity: 1 };
  const landingOrders = [
    { id: 'g1', createdAt: now - day, phone: '0913000001', name: 'Nguyễn Thị Hải Yến', total: 174000, products: [item] },
    { id: 'g2', createdAt: now - day, phone: '0913000002', name: 'Ms Xuan', total: 174000, products: [item] }
  ];
  const all = buildCustomers({ conversations: [], messages: {} }, [], [], { landingOrders });
  const yen = all.find(customer => customer.name === 'Nguyễn Thị Hải Yến');
  assert.equal(yen.gender, 'female');
  assert.equal(yen.genderSource, 'name');
  const names = gender => filterCustomers(all, { gender }, now).map(customer => customer.name);
  assert.deepEqual(names('female'), ['Nguyễn Thị Hải Yến']);
  assert.deepEqual(names('male'), []);
  assert.deepEqual(names('unknown'), ['Ms Xuan']);
});
