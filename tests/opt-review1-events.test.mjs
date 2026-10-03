// Rà soát 1 (03/10): khung khách của hội thoại đang mở tải lại khi bot tự tắt / lỗi (R1-01), dấu đã báo vận đơn
// ghi ngay sau khi gửi (R1-06), gộp tin tải về với tin SSE theo từng trường (R1-07).
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { tempDir } from './helpers/temp-dir.mjs';

process.env.META_CONVERSATIONS_PATH = path.join(tempDir('opt-review1-'), 'meta-conversations.json');
process.env.FOLLOW_UPS_PATH = path.join(tempDir('opt-review1-fu-'), 'follow-ups.json');
const { handlePancakeWebhook } = await import('../app/pancake.mjs');
const { subscribeToMessagingEvents } = await import('../app/message-events.mjs');
const { botPanelStateChanged } = await import('../app/server-helpers.mjs');
const { runSapoSync } = await import('../app/sapo-sync.mjs');

test('R1-01: saveBotState đổi bật/tắt bot hoặc lỗi bot → cần phát customer-panel; đổi việc khác thì không', () => {
  assert.equal(botPanelStateChanged({ botEnabled: true }, { botEnabled: false }), true);
  assert.equal(botPanelStateChanged({}, { botEnabled: false }), true, 'chưa có trường = đang bật');
  assert.equal(botPanelStateChanged({ botEnabled: false }, { botEnabled: false }), false);
  assert.equal(botPanelStateChanged({}, { botLastError: 'Vertex 429', botLastErrorAt: 5 }), true);
  assert.equal(botPanelStateChanged({ botLastError: 'x', botLastErrorAt: 5 }, { botLastError: 'x', botLastErrorAt: 5 }), false);
  assert.equal(botPanelStateChanged({ botLastError: 'x', botLastErrorAt: 5 }, { botLastError: 'x', botLastErrorAt: 9 }), true);
  assert.equal(botPanelStateChanged({ botEnabled: true }, { botHandledMessageId: 'm1', pendingOrder: {} }), false);
  assert.equal(botPanelStateChanged(null, { botEnabled: false }), false);
});

test('R1-01: saveBotState trong server.mjs phát customer-panel khi khung khách đổi', async () => {
  const server = await readFile(new URL('../app/server.mjs', import.meta.url), 'utf8');
  const body = server.slice(server.indexOf('saveBotState: async (id,'), server.indexOf('const envLoginUsers'));
  assert.match(body, /panelChanged = botPanelStateChanged\(conversation, botState\);\n\s+Object\.assign\(conversation, botState\);/);
  assert.match(body, /if \(saved && panelChanged\) publishMessagingEvent\(\{ type: 'customer-panel', conversationId: saved\.id \}\);/);
});

test('R1-01: nhân viên nhắn trong Pancake làm bot tự tắt → phát customer-panel cho hội thoại đó', async () => {
  const events = [];
  const unsubscribe = subscribeToMessagingEvents(event => events.push(event));
  const config = { pageId: '110', pageName: 'Test', pageAccessToken: 'pat-1', webhookToken: 'hook-1', apiBase: 'https://pages.fm/api/public_api', botWhenAssigned: false };
  const payload = (id, from) => ({
    page_id: '110',
    event_type: 'messaging',
    data: {
      conversation: { id: '110_991', type: 'INBOX', from: { id: '991', name: 'Chị Na' }, assignee_ids: [] },
      message: { id, conversation_id: '110_991', page_id: '110', type: 'INBOX', message: 'Dạ em chào chị', original_message: 'Dạ em chào chị', inserted_at: new Date().toISOString().replace('Z', ''), from, attachments: [] }
    }
  });
  try {
    const options = { processChatbotChanges: async () => {}, chatbotDependencies: {}, config };
    await handlePancakeWebhook(payload('m_991_1', { id: '991', name: 'Chị Na' }), options);
    assert.equal(events.filter(event => event.type === 'customer-panel').length, 0, 'tin khách không đổi bot');
    await handlePancakeWebhook(payload('m_991_2', { id: '110', name: 'Test', admin_name: 'Nguyễn Hồng Vy' }), options);
    const panels = events.filter(event => event.type === 'customer-panel');
    assert.deepEqual(panels, [{ type: 'customer-panel', conversationId: '110:991' }]);
    // Nhân viên nhắn tiếp: bot đã tắt, không phát thêm.
    await handlePancakeWebhook(payload('m_991_3', { id: '110', name: 'Test', admin_name: 'Nguyễn Hồng Vy' }), options);
    assert.equal(events.filter(event => event.type === 'customer-panel').length, 1);
  } finally {
    unsubscribe();
  }
});

const HOUR = 60 * 60 * 1000;
const now = Date.parse('2026-10-03T03:00:00Z');
const sapoOrder = () => ({
  id: 1, name: 'SON1', source_name: 'facebook', tags: '', note: null, created_on: new Date(now - 2 * HOUR).toISOString(), status: 'open', total_price: 298000,
  phone: null, shipping_address: { phone: '0912345678' },
  fulfillments: [{ status: 'success', shipment_status: 'picked_up', tracking_info: { carrier: 'JNT_EXPRESS', tracking_number: '802835136377', tracking_url: 'https://jtexpress.vn/tracking?type=track&billcode=802835136377' } }]
});
const sapoStore = () => ({
  conversations: [{ id: 'c1', pageId: 'p1', psid: 'c1', source: 'inbox', name: 'Khách c1', lastCustomerMessageAt: now - HOUR, gender: 'female',
    customerOrders: [{ id: 'A', phone: '0912345678', createdAt: now - 20 * HOUR, total: 298000, status: 'Mới', products: [{ sku: 'GRA-XANH' }] }] }],
  messages: {}
});
function sapoDeps(store, sendMessage) {
  const writes = [];
  let state = { noticesFrom: now - HOUR };
  let sendCalled = false;
  let recorded = false;
  return {
    writes,
    deps: {
      now, log: () => {}, notify: true,
      listOrders: async () => ({ orders: [sapoOrder()], complete: true }),
      readState: async () => state,
      writeState: async value => { state = value; },
      readMessagingStore: async () => store,
      // Lượt ghi ngay sau khi gửi (ghi dấu đã báo / lỗi gửi): ghi lại cách ghi.
      updateMessagingStore: async (mutate, options = {}) => {
        const result = mutate(store);
        if (sendCalled && !recorded) { recorded = true; writes.push({ defer: options.defer === true }); }
        return result;
      },
      readLandingStore: async () => ({ orders: [] }),
      updateLandingStore: async mutate => mutate({ orders: [] }),
      sendMessage: async (...args) => { sendCalled = true; return sendMessage(...args); },
      genderOf: inbox => inbox.gender,
      readTemplates: async () => ({})
    }
  };
}

test('R1-06: báo vận đơn đã gửi (hoặc không rõ đã tới) → ghi dấu notifiedStage NGAY, không ghi gộp', async () => {
  const sent = sapoDeps(sapoStore(), async () => ({ message: { mid: 'm1' } }));
  assert.equal((await runSapoSync(sent.deps)).sent, 1);
  assert.deepEqual(sent.writes, [{ defer: false }]);

  const uncertain = sapoDeps(sapoStore(), async () => { const error = new Error('hết giờ chờ'); error.unknownDelivery = true; throw error; });
  assert.equal((await runSapoSync(uncertain.deps)).sent, 1);
  assert.deepEqual(uncertain.writes, [{ defer: false }]);

  // Lỗi chắc chắn (chưa tới khách): ghi gộp như trước, mất dấu thì chỉ vào hàng chờ lại.
  const failed = sapoDeps(sapoStore(), async () => { throw new Error('(#10) outside allowed window'); });
  assert.equal((await runSapoSync(failed.deps)).failed, 1);
  assert.deepEqual(failed.writes, [{ defer: true }]);
});

const web = (await readFile(new URL('../web/app.js', import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
function webFunction(name) {
  const start = web.search(new RegExp(`\\n(async )?function ${name}\\(`));
  assert.ok(start >= 0, `không tìm thấy hàm ${name}`);
  return web.slice(start, web.indexOf('\n}\n', start) + 3);
}

test('R1-07: tin có ở cả bản tải về và SSE — gộp từng trường, trạng thái không lùi, ảnh CDN không mất', () => {
  const context = vm.createContext({});
  vm.runInContext(webFunction('mergeFetchedMessages'), context);
  const merge = (fetched, pending) => JSON.parse(JSON.stringify(context.mergeFetchedMessages(fetched, pending)));
  // SSE mới hơn: đã gửi + có ảnh CDN; bản máy chủ đọc trước đó còn "đang gửi", chưa có ảnh.
  assert.deepEqual(merge([{ id: 'm1', createdAt: 10, status: 'sending', text: 'a' }], [{ id: 'm1', createdAt: 10, status: 'sent', url: 'https://cdn/x.jpg' }]),
    [{ id: 'm1', createdAt: 10, status: 'sent', text: 'a', url: 'https://cdn/x.jpg' }]);
  // Bong bóng tạm "đang gửi" không đè bản máy chủ đã gửi; trường rỗng của SSE không xoá ảnh đã có.
  assert.deepEqual(merge([{ id: 'm2', mid: 'x2', createdAt: 5, status: 'sent', url: 'https://cdn/y.jpg', attachments: [{ type: 'image' }] }], [{ id: 'tmp', mid: 'x2', createdAt: 5, status: 'sending', url: '', attachments: [] }]),
    [{ id: 'm2', mid: 'x2', createdAt: 5, status: 'sent', url: 'https://cdn/y.jpg', attachments: [{ type: 'image' }] }]);
  // Tin chỉ có ở SSE vẫn giữ, xếp theo giờ.
  assert.deepEqual(merge([{ id: 'a', createdAt: 1 }], [{ id: 'b', createdAt: 0 }]).map(item => item.id), ['b', 'a']);
});
