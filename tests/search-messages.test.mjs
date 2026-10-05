// 05/10 (chủ shop: "Chức năng tìm kiếm chưa tìm được số điện thoại hay tin nhắn cũ"): tìm trên toàn bộ kho hội thoại
// (app/message-search.mjs) — SĐT trong tin cũ (viết liền, có dấu chấm/khoảng trắng/+84, gõ 4 số cuối), chữ không dấu,
// SĐT đơn/giỏ/hồ sơ khách, đoạn trích có vị trí tô đậm, chỉ mục dựng lười + soát lại theo hội thoại, hiệu năng 2.000 × 100.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createSearchIndex, foldAligned, makeSnippet, normalizeSearchPhone, parseSearchQuery, refreshSearchIndex, searchIndex } from '../app/message-search.mjs';

const DAY = 24 * 60 * 60 * 1000;
const now = Date.UTC(2026, 9, 5, 3, 0, 0);

function makeStore() {
  const old = [];
  // Tin SĐT nằm ở ĐẦU một hội thoại 300 tin (ngoài 100 tin giao diện tải mặc định), viết có dấu chấm.
  old.push({ id: 'a-0', direction: 'incoming', type: 'text', text: 'Sđt em 0912.345.678 nha shop', createdAt: now - 21 * DAY });
  old.push({ id: 'a-1', direction: 'incoming', type: 'text', text: 'Thôn Đông, xã Tân Tiến, huyện Văn Giang, tỉnh Hưng Yên', createdAt: now - 21 * DAY + 120000 });
  for (let index = 2; index < 300; index += 1) old.push({ id: `a-${index}`, direction: index % 2 ? 'outgoing' : 'incoming', type: 'text', text: `tin thường số ${index}`, createdAt: now - 20 * DAY + index * 1000 });
  return {
    conversations: [
      { id: 'p:a', pageId: 'p', psid: 'a', name: 'Lan Anh', lastMessageAt: now - 1000, lastMessagePreview: 'tin thường số 299' },
      { id: 'p:b', pageId: 'p', psid: 'b', name: 'Trần Văn Bình', lastMessageAt: now - 2000, customerOrders: [{ id: 'o1', phone: '+84 987 654 321', createdAt: now - 5 * DAY }] },
      { id: 'p:c', pageId: 'p', psid: 'c', name: 'Chị Cúc', lastMessageAt: now - 3000, pendingOrder: { phone: '0371112222', at: now - DAY } },
      { id: 'p:d', pageId: 'p', psid: 'd', name: 'Đức', lastMessageAt: now - 4000 },
      { id: 'q:e', pageId: 'q', psid: 'e', name: 'Khách Facebook 9999', lastMessageAt: now - 5000, source: 'comment' }
    ],
    messages: {
      'p:a': old,
      'p:b': [{ id: 'b-0', direction: 'incoming', type: 'text', text: 'Cho mình hỏi GIÁ túi xanh ạ', createdAt: now - 6 * DAY }],
      'p:c': [{ id: 'c-0', direction: 'outgoing', type: 'text', text: 'Dạ em gửi chị địa chỉ cửa hàng ở Đà Nẵng', createdAt: now - 3 * DAY }],
      'p:d': [{ id: 'd-0', direction: 'incoming', type: 'text', text: 'số mới của mình +84 868 000 111', createdAt: now - 2 * DAY }],
      'q:e': [{ id: 'e-0', direction: 'incoming', type: 'text', text: 'Ship về Đắk Lắk bao lâu', createdAt: now - 9 * DAY }]
    }
  };
}

function search(store, query, options) {
  const index = createSearchIndex();
  refreshSearchIndex(index, store, 1);
  return searchIndex(index, query, options);
}

test('chuẩn hoá: SĐT +84/0084/chấm/khoảng trắng → 0xxxxxxxxx; bỏ dấu giữ nguyên độ dài', () => {
  assert.equal(normalizeSearchPhone('+84 912 345 678'), '0912345678');
  assert.equal(normalizeSearchPhone('0084912345678'), '0912345678');
  assert.equal(normalizeSearchPhone('0912.345.678'), '0912345678');
  assert.equal(normalizeSearchPhone('912345678'), '0912345678');
  assert.equal(parseSearchQuery('0912 345 678').phone, '0912345678');
  assert.equal(parseSearchQuery('5678').phone, '5678');
  assert.equal(parseSearchQuery('567').phone, '', 'dưới 4 số không là tìm SĐT');
  assert.equal(parseSearchQuery('túi 5678').phone, '');
  const folded = foldAligned('Địa chỉ ĐÀ NẴNG');
  assert.equal(folded.folded, 'dia chi da nang');
  assert.equal(folded.folded.length, folded.text.length);
});

test('SĐT trong tin CŨ (tin đầu của hội thoại 300 tin) — tìm được với mọi cách gõ, trả đúng tin + đoạn trích tô đậm', () => {
  const store = makeStore();
  for (const query of ['0912345678', '0912.345.678', '0912 345 678', '+84912345678', '+84 912 345 678', '84912345678', '5678', '345678']) {
    const results = search(store, query);
    assert.equal(results.length, 1, `${query}: ${JSON.stringify(results)}`);
    const [hit] = results;
    assert.equal(hit.id, 'p:a');
    assert.equal(hit.reason, 'phone');
    assert.equal(hit.messageId, 'a-0');
    assert.equal(hit.position, 300, 'tin thứ 300 tính từ cuối — giao diện tải đủ tin để cuộn tới');
    assert.equal(hit.matchedAt, now - 21 * DAY);
    assert.equal(hit.snippet.slice(hit.highlight[0], hit.highlight[1]), '0912.345.678');
  }
});

test('SĐT trong đơn của hội thoại, giỏ đang chờ, và tin viết +84 có khoảng trắng', () => {
  const store = makeStore();
  const order = search(store, '0987654321');
  assert.deepEqual(order.map(item => [item.id, item.reason]), [['p:b', 'phone']]);
  assert.match(order[0].snippet, /SĐT trong đơn: 0987654321/);
  assert.equal(order[0].snippet.slice(...order[0].highlight), '0987654321');
  const pending = search(store, '037.111.2222');
  assert.deepEqual(pending.map(item => item.id), ['p:c']);
  assert.match(pending[0].snippet, /giỏ/);
  const spaced = search(store, '0868000111');
  assert.deepEqual(spaced.map(item => [item.id, item.messageId]), [['p:d', 'd-0']]);
  assert.equal(spaced[0].snippet.slice(...spaced[0].highlight), '+84 868 000 111');
});

test('SĐT trong hồ sơ khách (customer-edits) theo khoá hội thoại và theo SĐT gốc', () => {
  const store = makeStore();
  const byConversation = search(store, '0399888777', { edits: { 'q:e': { phone: '0399888777' } } });
  assert.deepEqual(byConversation.map(item => [item.id, item.reason]), [['q:e', 'phone']]);
  assert.match(byConversation[0].snippet, /hồ sơ khách/);
  const byPhone = search(store, '0355444333', { edits: { 'phone:0987654321': { phone: '0355444333' } } });
  assert.deepEqual(byPhone.map(item => item.id), ['p:b']);
  assert.deepEqual(search(store, '0355444333'), [], 'không có hồ sơ thì không khớp');
});

test('chữ trong tin: không dấu, không phân biệt hoa thường; tên khách; kết quả mới nhất trước', () => {
  const store = makeStore();
  const unaccented = search(store, 'dak lak');
  assert.deepEqual(unaccented.map(item => [item.id, item.reason, item.messageId]), [['q:e', 'message', 'e-0']]);
  assert.equal(unaccented[0].snippet.slice(...unaccented[0].highlight), 'Đắk Lắk');
  assert.equal(unaccented[0].source, 'comment');
  assert.equal(unaccented[0].channelId, 'q');
  const upper = search(store, 'gia TUI xanh');
  assert.deepEqual(upper.map(item => item.id), ['p:b']);
  assert.equal(upper[0].snippet.slice(...upper[0].highlight), 'GIÁ túi xanh');
  const accented = search(store, 'Hưng Yên');
  assert.deepEqual(accented.map(item => [item.id, item.messageId]), [['p:a', 'a-1']]);
  const name = search(store, 'tran van binh');
  assert.deepEqual(name.map(item => [item.id, item.reason]), [['p:b', 'name']]);
  // "da nang": hội thoại c (tin Page) — và không khớp vắt qua hai tin liền nhau.
  assert.deepEqual(search(store, 'da nang').map(item => item.id), ['p:c']);
  assert.deepEqual(search(store, '299 tin'), [], 'không ghép cuối tin này với đầu tin sau');
  // Thứ tự: hội thoại mới nhất trước, tối đa `limit`.
  const many = search(store, 'tin thuong');
  assert.deepEqual(many.map(item => item.id), ['p:a']);
  assert.equal(many[0].messageId, 'a-299', 'tin mới nhất khớp');
  assert.equal(search(store, 'a').length, 0, 'một ký tự chữ: không tìm');
});

test('đoạn trích ≤ 120 ký tự quanh chữ khớp, có dấu … hai đầu', () => {
  const long = `${'x'.repeat(200)} 0912345678 ${'y'.repeat(200)}`;
  const { snippet, highlight } = makeSnippet(long, 201, 211);
  assert.ok(snippet.length <= 120, snippet.length);
  assert.equal(snippet.slice(...highlight), '0912345678');
  assert.ok(snippet.startsWith('…') && snippet.endsWith('…'));
});

test('chỉ mục: dựng lười, soát lại chỉ hội thoại đổi (tin mới, tên đổi, SĐT đơn mới), bỏ hội thoại đã xoá', () => {
  const store = makeStore();
  const index = createSearchIndex();
  assert.equal(refreshSearchIndex(index, store, 1), 5);
  assert.equal(refreshSearchIndex(index, store, 1), 0, 'không đổi gì → không dựng lại');
  store.messages['p:d'].push({ id: 'd-1', direction: 'incoming', type: 'text', text: 'gửi về 12 Nguyễn Huệ', createdAt: now });
  assert.equal(refreshSearchIndex(index, store, 2), 1);
  assert.deepEqual(searchIndex(index, 'nguyen hue').map(item => item.id), ['p:d']);
  store.conversations[2].customerOrders = [{ id: 'o2', phone: '0909090909', createdAt: now }];
  assert.equal(refreshSearchIndex(index, store, 3), 1);
  assert.deepEqual(searchIndex(index, '0909090909').map(item => item.id), ['p:c']);
  store.conversations.splice(4, 1);
  delete store.messages['q:e'];
  refreshSearchIndex(index, store, 4);
  assert.deepEqual(searchIndex(index, 'dak lak'), []);
  // Kho đọc lại từ đĩa (đối tượng mới) → mọi mục dựng lại.
  const reloaded = JSON.parse(JSON.stringify(store));
  assert.equal(refreshSearchIndex(index, reloaded, 4), 4);
});

test('hiệu năng: kho giả 2.000 hội thoại × 100 tin — mỗi lần tìm < 300 ms (kể cả soát chỉ mục)', () => {
  const words = 'chị ơi cho em hỏi granola túi xanh giá bao nhiêu ship về hà nội được không ạ địa chỉ thôn xã huyện tỉnh cảm ơn shop nhé'.split(' ');
  let seed = 7;
  const random = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  const store = { conversations: [], messages: {} };
  for (let conversation = 0; conversation < 2000; conversation += 1) {
    const id = `p:${conversation}`;
    store.conversations.push({ id, pageId: 'p', psid: String(conversation), name: `Khách ${conversation}`, lastMessageAt: now - conversation * 60000 });
    store.messages[id] = Array.from({ length: 100 }, (_, index) => ({
      id: `${id}-${index}`,
      direction: index % 2 ? 'outgoing' : 'incoming',
      type: 'text',
      text: index === 3 ? `sđt 09${String(10000000 + conversation).slice(-8)}` : Array.from({ length: 6 + Math.floor(random() * 14) }, () => words[Math.floor(random() * words.length)]).join(' '),
      createdAt: now - (100 - index) * 60000
    }));
  }
  const index = createSearchIndex();
  const buildStarted = performance.now();
  refreshSearchIndex(index, store, 1);
  const buildMs = performance.now() - buildStarted;
  const timings = {};
  for (const query of ['0910001999', '1999', 'dia chi thon', 'khong co chu nay dau', 'granola tui xanh', 'Khách 1234']) {
    const started = performance.now();
    refreshSearchIndex(index, store, 1);
    const results = searchIndex(index, query);
    timings[query] = Math.round((performance.now() - started) * 10) / 10;
    assert.ok(timings[query] < 300, `${query}: ${timings[query]} ms`);
    if (query === '0910001999') assert.deepEqual(results.map(item => item.id), ['p:1999']);
  }
  // Số đo (để báo cáo): CRM_TEST_VERBOSE=1 mới in.
  if (process.env.CRM_TEST_VERBOSE) console.info(`dựng chỉ mục 200.000 tin: ${Math.round(buildMs)} ms; mỗi lần tìm: ${JSON.stringify(timings)}`);
  assert.ok(buildMs < 3000, `dựng chỉ mục lần đầu ${Math.round(buildMs)} ms`);
});
