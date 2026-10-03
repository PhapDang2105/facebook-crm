import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

// Tối ưu hộp thư (web/app.js, 03/10): SSE của hội thoại đang mở chỉ vẽ phần đổi, bộ đệm tin không kẹt
// trống/cũ, đổi Page nhanh không vẽ đè, panel khách không GET trùng, dữ liệu mẫu không lẫn vào khách thật.
// Như các tệp *-web.test.mjs khác: cắt hàm cấp ngoài cùng của app.js rồi chạy trong vm với hàm giả.
const web = (await readFile(new URL('../web/app.js', import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
const fn = name => {
  const start = web.search(new RegExp(`\\n(async )?function ${name}\\(`));
  assert.ok(start >= 0, `không tìm thấy hàm ${name}`);
  const end = web.indexOf('\n}\n', start);
  return web.slice(start, end + 3);
};
const run = (names, context = {}, prelude = '') => {
  vm.createContext(context);
  vm.runInContext([prelude, ...names.map(fn)].join('\n'), context);
  return context;
};
const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((ok, fail) => { resolve = ok; reject = fail; });
  return { promise, resolve, reject };
};
const tick = () => new Promise(resolve => setImmediate(resolve));

function inboxEventContext() {
  const calls = [];
  const active = { dataset: { conversationId: 'c1' } };
  const log = name => (...args) => { calls.push([name, ...args]); };
  const context = {
    calls,
    active,
    currentMessageChannelId: 'p1',
    remoteConversations: new Map(),
    remoteMessages: new Map(),
    getActiveConversation: () => active,
    isUnattendedConversation: () => false,
    applyRemoteConversation: conversation => { context.remoteConversations.set(conversation.id, conversation); return active; },
    renderConversation: log('renderConversation'),
    renderCustomerPanel: log('renderCustomerPanel'),
    loadCustomerPanelFromServer: log('loadCustomerPanelFromServer'),
    renderConversationHeaderBasics: log('renderConversationHeaderBasics'),
    renderCustomerGender: log('renderCustomerGender'),
    renderCustomerOrderChip: log('renderCustomerOrderChip'),
    renderChatMessages: (element, options) => calls.push(['renderChatMessages', options]),
    renderChatSeenBy: log('renderChatSeenBy'),
    markRemoteConversationRead: log('markRemoteConversationRead'),
    scheduleFilterConversations: log('scheduleFilterConversations'),
    renderRemoteConversations: log('renderRemoteConversations')
  };
  return run(['handleMessagingEvent', 'refreshOpenConversationFromEvent', 'cacheRemoteMessage'], context);
}

test('B1: sự kiện "đã xem" của hội thoại đang mở chỉ vẽ dòng seenBy — không vẽ lại khung tin, không gọi lại panel khách', () => {
  const context = inboxEventContext();
  const base = { id: 'c1', channelId: 'p1', name: 'Khách A', labels: ['x'], seenBy: {} };
  context.remoteConversations.set('c1', base);
  context.handleMessagingEvent({ type: 'conversation', conversation: { ...base, seenBy: { hang: { name: 'Hằng', at: 5 } } } });
  const names = context.calls.map(call => call[0]);
  assert.deepEqual(names, ['renderChatSeenBy', 'scheduleFilterConversations']);
});

test('B1: tin mới của hội thoại đang mở → vẽ lại khung tin giữ chỗ cuộn, không vẽ header/panel; tin khách → đánh dấu đã đọc', () => {
  const context = inboxEventContext();
  const base = { id: 'c1', channelId: 'p1', name: 'Khách A', labels: [], seenBy: {} };
  context.remoteConversations.set('c1', base);
  context.remoteMessages.set('c1', []);
  context.handleMessagingEvent({ type: 'message', conversation: { ...base, lastMessagePreview: 'alo' }, message: { id: 'm1', direction: 'incoming', createdAt: 1 } });
  const names = context.calls.map(call => call[0]);
  assert.ok(names.includes('renderChatMessages'));
  assert.equal(JSON.stringify(context.calls.find(call => call[0] === 'renderChatMessages')[1]), JSON.stringify({ keepScroll: true }));
  assert.ok(!names.includes('renderConversation') && !names.includes('renderCustomerPanel') && !names.includes('loadCustomerPanelFromServer'));
  assert.ok(!names.includes('renderConversationHeaderBasics'), 'tên/ảnh/thẻ không đổi thì không vẽ lại đầu khung chat');
  assert.ok(names.includes('markRemoteConversationRead'));
  assert.equal(context.remoteMessages.get('c1').length, 1);
});

test('B1: thẻ hội thoại đổi → vẽ lại đầu khung chat (không panel, không khung tin)', () => {
  const context = inboxEventContext();
  const base = { id: 'c1', channelId: 'p1', name: 'Khách A', labels: ['a'], seenBy: {} };
  context.remoteConversations.set('c1', base);
  context.handleMessagingEvent({ type: 'conversation', conversation: { ...base, labels: ['a', 'b'] } });
  const names = context.calls.map(call => call[0]);
  assert.ok(names.includes('renderConversationHeaderBasics'));
  assert.ok(!names.includes('renderChatMessages') && !names.includes('loadCustomerPanelFromServer'));
});

test('B3: tin của hội thoại Page khác bỏ bản tin đã tải (mở lại thì tải mới); sự kiện không có tin thì giữ', () => {
  const context = inboxEventContext();
  context.remoteMessages.set('c9', [{ id: 'old' }]);
  context.handleMessagingEvent({ type: 'conversation', conversation: { id: 'c9', channelId: 'p2' } });
  assert.ok(context.remoteMessages.has('c9'));
  context.handleMessagingEvent({ type: 'message', conversation: { id: 'c9', channelId: 'p2' }, message: { id: 'new' } });
  assert.ok(!context.remoteMessages.has('c9'));
  assert.equal(context.calls.length, 0, 'không vẽ gì cho Page đang không mở');
});

function messagesContext(fetchImpl) {
  const context = {
    remoteMessages: new Map(),
    remoteConversations: new Map(),
    rendered: [],
    status: [],
    fetch: fetchImpl,
    readApiResponse: async value => value,
    encodeURIComponent,
    getActiveConversation: () => ({ dataset: { conversationId: 'c1' } }),
    renderChatMessages: (element, options) => context.rendered.push(options),
    showComposerStatus: message => context.status.push(message)
  };
  return run(['ensureRemoteMessages', 'mergeFetchedMessages', 'cacheRemoteMessage'], context);
}

test('B4: tải tin hỏng không để lại bộ đệm rỗng vĩnh viễn — lần mở sau tải lại', async () => {
  let attempts = 0;
  const context = messagesContext(async () => { attempts += 1; throw new Error('502'); });
  const conversation = { dataset: { conversationId: 'c1' } };
  await context.ensureRemoteMessages(conversation);
  assert.ok(!context.remoteMessages.has('c1'));
  assert.deepEqual(context.status, ['502']);
  await context.ensureRemoteMessages(conversation);
  assert.equal(attempts, 2, 'lần mở sau gọi lại máy chủ');
});

test('B4: tin SSE tới trong lúc đang tải được gộp vào kết quả (không bị ghi đè mất)', async () => {
  const pending = deferred();
  const context = messagesContext(() => pending.promise);
  const conversation = { dataset: { conversationId: 'c1' } };
  const loading = context.ensureRemoteMessages(conversation);
  context.cacheRemoteMessage('c1', { id: 'sse-2', createdAt: 20 });
  pending.resolve({ items: [{ id: 'm1', createdAt: 10 }] });
  await loading;
  assert.deepEqual([...context.remoteMessages.get('c1').map(item => item.id)], ['m1', 'sse-2']);
  // Tải lại sau khi nối lại SSE (force): tin cũ lấy theo máy chủ, tin tới trong lúc tải vẫn giữ.
  const again = deferred();
  context.fetch = () => again.promise;
  const reloading = context.ensureRemoteMessages(conversation, { force: true });
  context.cacheRemoteMessage('c1', { id: 'sse-3', createdAt: 30 });
  again.resolve({ items: [{ id: 'm1', createdAt: 10 }, { id: 'sse-2', createdAt: 20, text: 'bản máy chủ' }] });
  await reloading;
  assert.deepEqual([...context.remoteMessages.get('c1').map(item => item.id)], ['m1', 'sse-2', 'sse-3']);
  assert.equal(context.remoteMessages.get('c1')[1].text, 'bản máy chủ');
  assert.equal(JSON.stringify(context.rendered.at(-1)), JSON.stringify({ keepScroll: true }));
});

test('B6: đổi Page nhanh — danh sách của Page trước về trễ không vẽ đè Page đang chọn', async () => {
  const responses = new Map([['A', deferred()], ['B', deferred()]]);
  const rendered = [];
  const context = run(['loadRemoteConversations'], {
    conversationsRequestId: 0,
    currentMessageChannelId: 'A',
    syncedChannelIds: new Set(['A', 'B']),
    encodeURIComponent,
    fetch: url => responses.get(new URL(url, 'http://x').searchParams.get('channelId')).promise,
    readApiResponse: async value => value,
    renderRemoteConversations: items => rendered.push(items.map(item => item.id).join(','))
  }, 'var conversationsRequestId, currentMessageChannelId;');
  const loadA = context.loadRemoteConversations('A');
  context.currentMessageChannelId = 'B';
  const loadB = context.loadRemoteConversations('B');
  responses.get('B').resolve({ items: [{ id: 'b1' }] });
  await loadB;
  responses.get('A').resolve({ items: [{ id: 'a1' }] });
  await loadA;
  assert.deepEqual(rendered, ['b1']);
});

test('P3/B12: danh sách vẽ lại giữ nguyên phần tử của hội thoại đã có; findConversationElement tra theo Map', () => {
  assert.match(fn('renderRemoteConversations'), /const existing = findConversationElement\(conversation\.id\);/);
  assert.match(fn('findConversationElement'), /conversationElementsById\.get\(/);
  assert.doesNotMatch(fn('findConversationElement'), /getConversationItems/);
  assert.match(fn('buildConversationElement'), /conversationElementsById\.set\(String\(conversation\.id\), element\);/);
  assert.match(fn('sendRemoteMessage'), /active\.dataset\.conversationId !== conversationId/);
  assert.match(fn('getActiveConversation'), /cached\?\.isConnected && cached\.classList\.contains\('active'\)/);
  assert.doesNotMatch(fn('selectConversation'), /getConversationItems\(\)\.forEach/);
  assert.match(fn('getChatMessageAction'), /getConversationStorageKey\(name, conversation\)/);
});

function panelContext() {
  const fetches = [];
  const context = {
    fetches,
    active: null,
    customerPanelInflight: null,
    customerPanelRequestId: 0,
    customerPanelScrollOnLoad: false,
    customerPanelStore: { notes: {}, orders: {}, bots: {}, touched: {} },
    customerGenders: new Map(),
    customerBotErrors: {},
    chatBody: null,
    encodeURIComponent,
    getActiveConversation: () => context.active,
    getConversationName: () => '',
    fetch: url => { const pending = deferred(); fetches.push({ url, pending }); return pending.promise; },
    readApiResponse: async value => value,
    saveCustomerPanelStore: () => {},
    renderChatbotToggle: () => {},
    renderCustomerGender: () => {},
    renderChatbotError: () => {},
    renderCustomerNotes: () => {},
    renderCustomerOrders: () => {},
    renderConversationOrderCards: () => {},
    refreshCustomerOrderProfile: () => {}
  };
  return run(['loadCustomerPanelFromServer', 'fetchCustomerPanelFromServer', 'getCustomerPanelKey'], context,
    'var customerPanelInflight, customerPanelRequestId, customerPanelScrollOnLoad;');
}

test('P3/B1: gọi panel khách dồn dập cho cùng hội thoại gộp thành tối đa một lần GET nữa', async () => {
  const context = panelContext();
  const conversation = { dataset: { conversationId: 'c1' } };
  context.active = conversation;
  const first = context.loadCustomerPanelFromServer(conversation);
  const second = context.loadCustomerPanelFromServer(conversation);
  const third = context.loadCustomerPanelFromServer(conversation);
  assert.equal(context.fetches.length, 1);
  assert.equal(second, third, 'các lần gọi trong lúc chờ dùng chung một lần tải sau');
  context.fetches[0].pending.resolve({ notes: [], orders: [], botEnabled: true });
  await first;
  await tick();
  assert.equal(context.fetches.length, 2);
  context.fetches[1].pending.resolve({ notes: [], orders: [], botEnabled: false });
  await third;
  assert.equal(context.customerPanelStore.bots.c1, false);
});

test('P3/B1: lần tải gộp của hội thoại cũ không chạy khi đã bấm sang khách khác (không làm hỏng lần tải của khách mới)', async () => {
  const context = panelContext();
  const first = { dataset: { conversationId: 'c1' } };
  const second = { dataset: { conversationId: 'c2' } };
  context.active = first;
  const loading = context.loadCustomerPanelFromServer(first);
  context.loadCustomerPanelFromServer(first);
  context.active = second;
  context.loadCustomerPanelFromServer(second);
  assert.equal(context.fetches.length, 2);
  context.fetches[0].pending.resolve({ notes: [], orders: [] });
  await loading;
  await tick();
  assert.equal(context.fetches.length, 2, 'không GET thêm cho c1');
  context.fetches[1].pending.resolve({ notes: [], orders: [], botEnabled: true });
  await tick();
  await tick();
  assert.equal(context.customerPanelStore.bots.c2, true, 'kết quả của khách đang mở được ghi');
});

test('B11: lưu panel xong mà đã sang khách khác thì không vẽ nút bot theo khách cũ', async () => {
  const toggles = [];
  const context = run(['saveCustomerPanelChange', 'getCustomerPanelKey'], {
    active: null,
    customerPanelStore: { notes: {}, orders: {}, bots: {}, touched: {} },
    chatBody: null,
    encodeURIComponent,
    JSON,
    getActiveConversation: () => context.active,
    getConversationName: () => '',
    fetch: async () => ({ notes: [], orders: [], botEnabled: true }),
    readApiResponse: async value => value,
    saveCustomerPanelStore: () => {},
    renderChatbotToggle: conversation => toggles.push(conversation.dataset.conversationId),
    renderCustomerNotes: () => {},
    renderCustomerOrders: () => {},
    renderConversationOrderCards: () => {},
    showToast: () => {}
  });
  const first = { dataset: { conversationId: 'c1' } };
  context.active = { dataset: { conversationId: 'c2' } };
  await context.saveCustomerPanelChange(first, { type: 'note' });
  assert.deepEqual(toggles, []);
  context.active = first;
  await context.saveCustomerPanelChange(first, { type: 'note' });
  assert.deepEqual(toggles, ['c1']);
});

test('B2: hồ sơ mẫu "Lan Anh" chỉ áp cho dòng demo — khách Facebook thật trùng tên không nhận SĐT/địa chỉ/đơn giả', () => {
  const context = run(['demoConversationProfile', 'getCustomerPanelProfile', 'getSeedCustomerOrder', 'getCustomerPanelKey'], {
    usingRemoteConversations: false,
    conversationProfiles: { 'Lan Anh': { phone: '+84 912 345 678', order: ['#GN-240901', 'Granola', '1', 'Đã mua', '+84 912 345 678', '12 Nguyễn Huệ', '890.000 đ'] } },
    customerPanelStore: { orders: { real: [{ phone: '0909000111', address: 'Hà Nội' }] } },
    appSettings: {},
    getConversationName: conversation => conversation.name,
    getActiveConversation: () => null
  }, 'var usingRemoteConversations;');
  const real = { name: 'Lan Anh', dataset: { conversationId: 'real', avatar: '' } };
  const demo = { name: 'Lan Anh', dataset: { avatar: '' } };
  assert.equal(context.demoConversationProfile(real), null);
  assert.equal(context.getCustomerPanelProfile(real).phone, '0909000111');
  assert.equal(context.getCustomerPanelProfile(real).address, 'Hà Nội');
  assert.equal(context.getSeedCustomerOrder(real).length, 0);
  assert.equal(context.getCustomerPanelProfile(demo).phone, '+84 912 345 678');
  context.usingRemoteConversations = true;
  assert.equal(context.demoConversationProfile(demo), null, 'đã nối Page thì không còn dữ liệu mẫu');
  assert.doesNotMatch(fn('renderConversationHeaderBasics'), /conversationProfiles/);
});

test('B7: /api/channels hỏng lúc tải trang → báo lỗi và thử lại (2s, 4s…), tới khi được thì nối hộp thư thật', async () => {
  const timers = [];
  const toasts = [];
  let fail = true;
  let connected = 0;
  const loaded = [];
  const context = run(['loadMessageChannels', 'scheduleMessageChannelsRetry', 'getDefaultChannelId'], {
    window: { setTimeout: (callback, delay) => { timers.push({ callback, delay }); return timers.length; }, clearTimeout: () => {} },
    localStorage: { getItem: () => '' },
    messageChannelsRetryDelay: 0,
    messageChannelsRetryTimer: null,
    usingRemoteConversations: false,
    messageChannels: [],
    currentMessageChannelId: 'local-facebook',
    fetchChannelsState: async () => { if (fail) throw new Error('502'); return { items: [{ id: 1, name: 'Giọt Nắng' }] }; },
    showToast: message => toasts.push(message),
    loadRemoteConversations: async id => { loaded.push(id); },
    connectMessagingStream: () => { connected += 1; },
    getConversationItems: () => [],
    renderConversationLabelBadges: () => {},
    activateCurrentMessageChannel: () => {},
    reopenLastConversation: () => {}
  }, 'var messageChannelsRetryDelay, messageChannelsRetryTimer, usingRemoteConversations, messageChannels, currentMessageChannelId;');
  await context.loadMessageChannels();
  assert.equal(timers.at(-1).delay, 2000);
  assert.equal(toasts.length, 1);
  await context.loadMessageChannels();
  assert.equal(timers.at(-1).delay, 4000);
  assert.equal(toasts.length, 1, 'chỉ báo một lần');
  fail = false;
  await context.loadMessageChannels();
  assert.equal(context.usingRemoteConversations, true);
  assert.deepEqual(loaded, ['1']);
  assert.equal(connected, 1);
  assert.equal(timers.length, 2, 'được rồi thì thôi thử lại');
});

test('P7: bộ đệm panel khách trong trình duyệt giữ tối đa 200 hội thoại gần nhất', () => {
  const context = run(['pruneCustomerPanelStore'], { customerPanelStoreLimit: 200 }, 'var customerPanelStoreLimit;');
  const store = { notes: {}, orders: {}, bots: {}, touched: {} };
  for (let index = 0; index < 250; index += 1) {
    store.orders[`k${index}`] = [];
    store.touched[`k${index}`] = 1000 + index;
  }
  store.notes.legacy = [];
  context.pruneCustomerPanelStore(store);
  assert.equal(Object.keys(store.orders).length, 200);
  assert.ok(store.orders.k249 && !store.orders.k49 && !store.notes.legacy, 'bỏ cũ nhất (khoá không có touched coi là cũ nhất)');
  assert.ok(store.orders.k50);
  assert.match(fn('saveCustomerPanelStore'), /pruneCustomerPanelStore\(customerPanelStore, 50\)/, 'hết chỗ thì thu còn 50 rồi thử lại');
});

test('B10: danh sách hội thoại — trong tuần ghi thứ, cũ hơn ghi ngày/tháng (khác năm thêm năm)', () => {
  const context = run(['formatConversationActivityTime', 'isSameCalendarDay'], {});
  const now = new Date();
  const at = days => new Date(now.getFullYear(), now.getMonth(), now.getDate() - days, 12, 0).getTime();
  assert.match(context.formatConversationActivityTime(at(3)), /^(CN|T[2-7])$/);
  const old = new Date(at(40));
  const pad = value => String(value).padStart(2, '0');
  const expected = `${pad(old.getDate())}/${pad(old.getMonth() + 1)}${old.getFullYear() === now.getFullYear() ? '' : `/${old.getFullYear()}`}`;
  assert.equal(context.formatConversationActivityTime(at(40)), expected);
  assert.match(context.formatConversationActivityTime(at(400)), /^\d{2}\/\d{2}\/\d{4}$/);
  assert.equal(context.formatConversationActivityTime(Date.now() - 5 * 60000), '5 phút');
});

test('P9: nhãn giờ bỏ qua tab ẩn; chỉ ghi khi chữ đổi; tìm kiếm không khớp theo nhãn giờ', () => {
  let scanned = 0;
  const context = run(['updateConversationTimeLabels'], {
    document: { hidden: true },
    conversationTimeLabelsDay: '',
    conversationTimeLabelsAt: 0,
    getConversationItems: () => { scanned += 1; return []; }
  }, 'var conversationTimeLabelsDay, conversationTimeLabelsAt;');
  context.updateConversationTimeLabels();
  assert.equal(scanned, 0);
  context.document.hidden = false;
  context.updateConversationTimeLabels();
  assert.equal(scanned, 1);
  assert.match(fn('conversationSearchKey'), /querySelector\('\.conversation-copy'\)/);
});

test('P2/P5/P6/M1/M2: ảnh đại diện tải lười, tooltip không vòng lặp khung hình, bảng đơn không vẽ khi màn Đơn hàng ẩn', () => {
  const avatar = fn('applyAvatarPhoto');
  assert.match(avatar, /photo\.loading = 'lazy';/);
  assert.match(avatar, /photo\.decoding = 'async';/);
  assert.doesNotMatch(fn('updateConversationElement'), /avatar\.textContent =/);
  assert.doesNotMatch(fn('positionMessageTimeTooltip'), /requestAnimationFrame/);
  assert.match(fn('renderOrderData'), /if \(views\.get\('orders'\)\?\.classList\.contains\('hidden'\)\) \{\n\s*\['import', 'process', 'export'\]\.forEach\(name => orderPanelsDirty\.add\(name\)\);\n\s*return;/);
  assert.doesNotMatch(web, /innerHTML \+=/);
  assert.doesNotMatch(fn('applyImportedRecords'), /renderOrderData\(\)/);
});
