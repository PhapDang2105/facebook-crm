// Nền của cầu nối: nhận lệnh gửi từ CRM, tìm (hay mở ngầm) một tab pancake.vn,
// chạy lệnh gửi trong chính trang đó — đúng lệnh giao diện Pancake dùng để nhờ
// extension Pancake gửi tin (REPLY_INBOX_PHOTO, loại chữ, gửi được ngoài 24 giờ)
// — rồi trả kết quả thành công / lỗi của extension Pancake về CRM.
//
// Nhật ký: chrome://extensions → "Giọt Nắng CRM – Cầu nối Pancake" → "service worker" (Kiểm tra chế độ xem) →
// tab Console: mỗi bước ghi một dòng "[GN cầu nối] …" (mã khách, convId, loại câu trả lời của extension Pancake).

const pancakeUrl = 'https://pancake.vn/';
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const log = (...args) => console.warn('[GN cầu nối]', ...args);

// Hạn chờ (ms). CRM chờ cả lệnh: mở tab (≤ tabLoadMs) + trang sẵn sàng (≤ pageReadyMs) + tìm ID (≤ lookupMs, thử lại 1 lần
// khi tab vừa mở) + gửi (≤ sendMs) — web/app.js sendThroughBridge chờ 5 phút với khách cần tìm ID, đếm lại từ lúc
// cầu nối báo bắt đầu (GN_STARTED), nên lệnh xếp hàng sau lệnh khác không bị tính là "không trả lời".
const timeouts = { tabLoadMs: 30000, pageReadyMs: 20000, freshSettleMs: 2000, lookupMs: 60000, sendMs: 90000 };

function validItem(item) {
  return Boolean(item
    && /^\d{5,20}$/.test(String(item.pageId))
    && new RegExp(`^${item.pageId}_\\d{5,25}$`).test(String(item.convId))
    && (/^\d{5,25}$/.test(String(item.globalUserId)) || (item.needsGlobalId === true && !item.globalUserId))
    && typeof item.text === 'string' && item.text.trim().length > 0 && item.text.length <= 2000);
}

// Mã luồng (thread_id / thread_key của Pancake): chỉ chữ, số, _ . : - (tối đa 100 ký tự); khác thì bỏ.
const cleanThreadId = value => (/^[\w.:-]{1,100}$/.test(String(value ?? '')) ? String(value) : '');

/**
 * Tham số cho lệnh GET_GLOBAL_ID_FOR_CONV (nhờ extension Pancake tìm ID Facebook toàn cục của khách).
 *
 * CHƯA KIỂM CHỨNG: định dạng lệnh này do đoán theo mã giao diện Pancake (extension Pancake 0.5.57,
 * id oehooocookcnclgniepdgaiankfifmmn) — không có tài liệu. 03/10 extension trả "không tìm được" cho mọi khách
 * khi ta gửi threadId = PSID, tên khách theo CRM, mốc tin cuối theo CRM. Nay ƯU TIÊN dữ liệu Pancake đang giữ
 * (máy chủ CRM lấy từ API tin nhắn Pancake: pancakeName, pancakeUpdatedAt, threadId / threadKey), thiếu thì lùi về
 * PSID / tên CRM / mốc CRM như cũ.
 *
 * Cách sửa khi có mẫu thật: mở một hội thoại trong tab pancake.vn mà Pancake phải "tìm ID" (khách chưa có ID
 * Facebook), mở DevTools của tab đó (F12) → Console, dán:
 *   window.addEventListener('message', e => { if (/GLOBAL_ID/.test(e.data?.type)) console.log(JSON.stringify(e.data)); });
 * rồi gửi tin cho khách đó ngay trong Pancake. Console in ra lệnh GET_GLOBAL_ID_FOR_CONV Pancake tự gửi (tên trường,
 * kiểu giá trị: threadId là gì, conversationUpdatedTime là số ms hay chuỗi ISO…) và câu trả lời *_SUCCESS / *_FAILURE.
 * Sửa đúng theo đó ở hàm này (tên trường) và ở lookupGlobalIdThroughPancake (đọc câu trả lời).
 */
function lookupArgs(item) {
  const psid = String(item.convId).split('_')[1];
  const threadId = cleanThreadId(item.threadId) || cleanThreadId(item.threadKey);
  const pancakeName = String(item.pancakeName || '').trim().slice(0, 200);
  const pancakeUpdatedAt = Number(item.pancakeUpdatedAt) || 0;
  return {
    pageId: String(item.pageId),
    convId: String(item.convId),
    threadId: threadId || psid,
    threadKey: cleanThreadId(item.threadKey),
    customerName: pancakeName || String(item.name || '').slice(0, 200),
    conversationUpdatedTime: pancakeUpdatedAt || Number(item.updatedTime) || Date.now(),
    timeoutMs: timeouts.lookupMs,
    // Chỉ để ghi nhật ký: giá trị nào lấy từ Pancake, giá trị nào lùi về CRM.
    sources: { threadId: threadId ? 'pancake' : 'psid', customerName: pancakeName ? 'pancake' : 'crm', updatedTime: pancakeUpdatedAt ? 'pancake' : 'crm' }
  };
}

// Chạy trong trang pancake.vn (MAIN world, hàm được chép nguyên văn sang trang — không dùng biến ngoài hàm):
// nhờ extension Pancake tìm ID Facebook của khách. Trả { ok, globalId } hay { ok:false, lookupFailed:true, error,
// replyType, timeout? } — error giữ nguyên lời / dữ liệu Pancake trả về (cắt 300 ký tự).
function lookupGlobalIdThroughPancake(args) {
  const describe = data => {
    if (!data) return '';
    if (typeof data.error === 'string' && data.error) return data.error;
    if (data.error) { try { return JSON.stringify(data.error); } catch { return String(data.error); } }
    const rest = { ...data };
    delete rest.taskId;
    try { return JSON.stringify(rest); } catch { return String(data.type || ''); }
  };
  return new Promise(resolve => {
    const taskId = `giotnang-id-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const finish = result => { clearTimeout(timer); window.removeEventListener('message', onMessage); resolve(result); };
    const timer = setTimeout(() => finish({ ok: false, lookupFailed: true, timeout: true, replyType: 'timeout', error: `extension Pancake không trả lời lệnh tìm ID Facebook sau ${Math.round(args.timeoutMs / 1000)} giây` }), args.timeoutMs);
    function onMessage(event) {
      const data = event.data;
      if (event.source !== window || !data || data.taskId !== taskId) return;
      if (data.type === 'GET_GLOBAL_ID_FOR_CONV_SUCCESS' && /^\d{5,25}$/.test(String(data.globalId || ''))) finish({ ok: true, globalId: String(data.globalId), replyType: data.type });
      else if (data.type === 'GET_GLOBAL_ID_FOR_CONV_SUCCESS' || data.type === 'GET_GLOBAL_ID_FOR_CONV_FAILURE') {
        const detail = describe(data).slice(0, 300);
        finish({ ok: false, lookupFailed: true, replyType: data.type, error: `extension Pancake không tìm được ID Facebook của khách${detail ? ` — Pancake báo: ${detail}` : ''}` });
      }
    }
    window.addEventListener('message', onMessage);
    window.postMessage({
      type: 'GET_GLOBAL_ID_FOR_CONV',
      taskId,
      pageId: args.pageId,
      convId: args.convId,
      convType: 'INBOX',
      threadId: args.threadId,
      ...(args.threadKey ? { threadKey: args.threadKey } : {}),
      customerName: args.customerName,
      conversationUpdatedTime: args.conversationUpdatedTime,
      isBusiness: true,
      allowSearchByName: true
    }, '*');
  });
}

// Chạy trong trang pancake.vn (MAIN world): gửi lệnh cho extension Pancake và
// chờ nó báo kết quả theo taskId.
function sendThroughPancake(item) {
  const describe = data => {
    if (typeof data?.error === 'string' && data.error) return data.error;
    if (data?.error) { try { return JSON.stringify(data.error); } catch { return String(data.error); } }
    const rest = { ...(data || {}) };
    delete rest.taskId;
    try { return `extension Pancake báo lỗi: ${JSON.stringify(rest)}`; } catch { return 'extension Pancake báo lỗi'; }
  };
  return new Promise(resolve => {
    const taskId = `giotnang-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const finish = result => { clearTimeout(timer); window.removeEventListener('message', onMessage); resolve(result); };
    const timer = setTimeout(() => finish({ ok: false, replyType: 'timeout', error: `extension Pancake không trả lời sau ${Math.round(item.timeoutMs / 1000)} giây (đã cài và đăng nhập Facebook chưa?)` }), item.timeoutMs);
    function onMessage(event) {
      const data = event.data;
      if (event.source !== window || !data || data.taskId !== taskId) return;
      if (data.type === 'REPLY_INBOX_PHOTO_SUCCESS') finish({ ok: true, replyType: data.type, messageId: String(data.messageId || '') });
      else if (data.type === 'REPLY_INBOX_PHOTO_FAILURE') finish({ ok: false, replyType: data.type, error: describe(data).slice(0, 300) });
    }
    window.addEventListener('message', onMessage);
    window.postMessage({
      type: 'REPLY_INBOX_PHOTO',
      taskId,
      pageId: item.pageId,
      convId: item.convId,
      message: item.text,
      attachmentType: 'SEND_TEXT_ONLY',
      globalUserId: item.globalUserId,
      platform: 'facebook',
      isBusiness: true,
      customerName: item.name || '',
      files: []
    }, '*');
  });
}

// Chạy trong trang pancake.vn: trang đã tải xong và đã dựng giao diện (không chỉ khung trắng).
function pancakePageState() {
  return { ready: document.readyState === 'complete' && Boolean(document.body) && document.body.childElementCount > 0, url: location.href };
}

async function waitForLoad(tabId, timeoutMs = timeouts.tabLoadMs) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const tab = await chrome.tabs.get(tabId);
    if (tab.status === 'complete') return true;
    await wait(500);
  }
  return false;
}

/**
 * Trang Pancake sẵn sàng nhận lệnh: tab tải xong + trang dựng xong (hỏi thẳng trang, mỗi 500 ms, tối đa pageReadyMs).
 * Tab vừa mở thì chờ thêm một chút cho extension Pancake nối vào trang (nó chạy sau khi trang tải xong; extension
 * Pancake không có lệnh "ping" đã biết để hỏi trực tiếp). Thay cho việc luôn chờ cứng 5 giây như bản 1.1.2.
 */
async function waitForPancakeReady(tabId, { fresh = false } = {}) {
  const loaded = await waitForLoad(tabId);
  const started = Date.now();
  let state = null;
  while (Date.now() - started < timeouts.pageReadyMs) {
    try {
      const [probe] = await chrome.scripting.executeScript({ target: { tabId }, world: 'MAIN', func: pancakePageState });
      state = probe?.result || null;
    } catch (error) {
      state = { ready: false, error: String(error?.message || error) };
    }
    if (state?.ready) break;
    await wait(500);
  }
  if (fresh && state?.ready) await wait(timeouts.freshSettleMs);
  log('tab Pancake', tabId, fresh ? '(vừa mở)' : '(đang mở)', 'tải xong:', loaded, 'sẵn sàng:', Boolean(state?.ready), state?.error || '');
  return Boolean(state?.ready);
}

/** Tab Pancake để gửi: dùng tab đang mở; không có thì mở ngầm một tab ghim. */
async function pancakeTab() {
  const tabs = await chrome.tabs.query({ url: 'https://pancake.vn/*' });
  const existing = tabs.find(tab => tab.status === 'complete') || tabs[0];
  if (existing) {
    const ready = await waitForPancakeReady(existing.id);
    return { tabId: existing.id, fresh: false, ready };
  }
  const created = await chrome.tabs.create({ url: pancakeUrl, active: false, pinned: true });
  const ready = await waitForPancakeReady(created.id, { fresh: true });
  return { tabId: created.id, fresh: true, ready };
}

async function runInPancake(tabId, func, args) {
  const [injection] = await chrome.scripting.executeScript({ target: { tabId }, world: 'MAIN', func, args: [args] });
  return injection?.result || null;
}

async function send(item) {
  const key = String(item?.key || '');
  if (!validItem(item)) { log('lệnh không hợp lệ', key, item?.convId); return { ok: false, error: 'lệnh gửi không hợp lệ' }; }
  log('bắt đầu', key, item.convId, item.globalUserId ? 'có ID Facebook' : 'cần tìm ID Facebook');
  const { tabId, fresh, ready } = await pancakeTab();
  let globalUserId = String(item.globalUserId || '');
  let foundId = '';
  if (!globalUserId) {
    const args = lookupArgs(item);
    log('tìm ID', key, item.convId, 'nguồn tham số:', JSON.stringify(args.sources));
    let lookup = await runInPancake(tabId, lookupGlobalIdThroughPancake, args);
    // Tab vừa mở (hay chưa sẵn sàng) mà extension Pancake không trả lời: có thể nó chưa kịp nối vào trang — chờ sẵn
    // sàng rồi thử lại MỘT lần. An toàn: tìm ID không gửi gì cho khách.
    if (lookup?.timeout && (fresh || !ready)) {
      log('tìm ID hết giờ trên tab vừa mở — thử lại một lần', key, item.convId);
      await waitForPancakeReady(tabId);
      lookup = await runInPancake(tabId, lookupGlobalIdThroughPancake, args);
    }
    log('kết quả tìm ID', key, item.convId, 'loại trả lời:', lookup?.replyType || typeof lookup, lookup?.ok ? 'tìm được' : (lookup?.error || 'không có kết quả'));
    if (!lookup?.ok) return { ok: false, lookupFailed: true, error: String(lookup?.error || 'không chạy được lệnh tìm ID Facebook trong tab Pancake').slice(0, 400) };
    globalUserId = foundId = lookup.globalId;
  }
  // Gửi KHÔNG thử lại khi hết giờ: extension Pancake có thể đã gửi (thử lại là khách nhận hai tin).
  const result = await runInPancake(tabId, sendThroughPancake, { pageId: String(item.pageId), convId: String(item.convId), globalUserId, text: item.text, name: String(item.name || ''), timeoutMs: timeouts.sendMs })
    || { ok: false, error: 'không chạy được trong tab Pancake' };
  log('kết quả gửi', key, item.convId, 'loại trả lời:', result.replyType || typeof result, result.ok ? 'đã gửi' : result.error);
  const { replyType, ...reply } = result;
  return foundId ? { ...reply, globalId: foundId } : reply;
}

// Mọi lệnh (bám đuổi + báo vận đơn, mọi tab CRM) chạy LẦN LƯỢT qua một hàng: hai lô chạy chồng trong cùng một tab
// Pancake thì lệnh này chen lệnh kia (03/10: tự gửi vận đơn và lô bám đuổi chạy cùng lúc).
let queue = Promise.resolve();
function serialized(task) {
  const run = queue.then(task, task);
  queue = run.then(() => undefined, () => undefined);
  return run;
}

chrome.runtime.onMessage.addListener((message, sender, reply) => {
  // Chỉ nhận lệnh từ trang CRM.
  if (message?.type !== 'GN_SEND' || !String(sender.url || '').startsWith('https://fb.giotnang.vn/')) return false;
  const tabId = sender.tab?.id;
  serialized(async () => {
    // Báo trang CRM lệnh bắt đầu chạy (hết lượt xếp hàng): trang đếm lại hạn chờ từ lúc này.
    if (message.requestId && Number.isInteger(tabId)) {
      try { await chrome.tabs.sendMessage(tabId, { type: 'GN_STARTED', requestId: String(message.requestId) }); } catch { /* trang đã đóng / tải lại */ }
    }
    return send(message.item);
  }).then(reply, error => {
    log('lỗi', message.item?.key, message.item?.convId, String(error?.message || error));
    reply({ ok: false, error: String(error?.message || error).slice(0, 300) });
  });
  return true;
});
