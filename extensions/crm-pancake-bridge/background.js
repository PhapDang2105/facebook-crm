// Nền của cầu nối: nhận lệnh gửi từ CRM, tìm (hay mở ngầm) một tab pancake.vn,
// chạy lệnh gửi trong chính trang đó — đúng lệnh giao diện Pancake dùng để nhờ
// extension Pancake gửi tin (REPLY_INBOX_PHOTO, loại chữ, gửi được ngoài 24 giờ)
// — rồi trả kết quả thành công / lỗi của extension Pancake về CRM.

const pancakeUrl = 'https://pancake.vn/';
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

function validItem(item) {
  return item
    && /^\d{5,20}$/.test(String(item.pageId))
    && new RegExp(`^${item.pageId}_\\d{5,25}$`).test(String(item.convId))
    && (/^\d{5,25}$/.test(String(item.globalUserId)) || (item.needsGlobalId === true && !item.globalUserId))
    && typeof item.text === 'string' && item.text.trim().length > 0 && item.text.length <= 2000;
}

// Chạy trong trang pancake.vn: nhờ extension Pancake tìm ID Facebook của khách
// (lệnh GET_GLOBAL_ID_FOR_CONV — Pancake chưa lưu ID thì extension dò hộp thư
// Page theo tên khách + thời điểm hội thoại).
function lookupGlobalIdThroughPancake(item) {
  return new Promise(resolve => {
    const taskId = `giotnang-id-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const finish = result => { clearTimeout(timer); window.removeEventListener('message', onMessage); resolve(result); };
    const timer = setTimeout(() => finish({ ok: false, error: 'extension Pancake không tìm được ID Facebook sau 90 giây' }), 90000);
    function onMessage(event) {
      const data = event.data;
      if (event.source !== window || !data || data.taskId !== taskId) return;
      if (data.type === 'GET_GLOBAL_ID_FOR_CONV_SUCCESS' && /^\d{5,25}$/.test(String(data.globalId || ''))) finish({ ok: true, globalId: String(data.globalId) });
      else if (data.type === 'GET_GLOBAL_ID_FOR_CONV_SUCCESS' || data.type === 'GET_GLOBAL_ID_FOR_CONV_FAILURE') finish({ ok: false, error: 'extension Pancake không tìm được ID Facebook của khách' });
    }
    window.addEventListener('message', onMessage);
    window.postMessage({
      type: 'GET_GLOBAL_ID_FOR_CONV',
      taskId,
      pageId: item.pageId,
      convId: item.convId,
      convType: 'INBOX',
      threadId: item.convId.split('_')[1],
      customerName: item.name || '',
      conversationUpdatedTime: item.updatedTime || Date.now(),
      isBusiness: true,
      allowSearchByName: true
    }, '*');
  });
}

async function waitForLoad(tabId, timeoutMs = 30000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const tab = await chrome.tabs.get(tabId);
    if (tab.status === 'complete') return;
    await wait(500);
  }
}

/** Tab Pancake để gửi: dùng tab đang mở; không có thì mở ngầm một tab ghim. */
async function pancakeTab() {
  const tabs = await chrome.tabs.query({ url: 'https://pancake.vn/*' });
  const ready = tabs.find(tab => tab.status === 'complete') || tabs[0];
  if (ready) {
    await waitForLoad(ready.id);
    return ready.id;
  }
  const created = await chrome.tabs.create({ url: pancakeUrl, active: false, pinned: true });
  await waitForLoad(created.id);
  // Chờ extension Pancake nối vào trang mới mở.
  await wait(5000);
  return created.id;
}

// Chạy trong trang pancake.vn (MAIN world): gửi lệnh cho extension Pancake và
// chờ nó báo kết quả theo taskId.
function sendThroughPancake(item) {
  return new Promise(resolve => {
    const taskId = `giotnang-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const finish = result => { clearTimeout(timer); window.removeEventListener('message', onMessage); resolve(result); };
    const timer = setTimeout(() => finish({ ok: false, error: 'extension Pancake không trả lời sau 90 giây (đã cài và đăng nhập Facebook chưa?)' }), 90000);
    function onMessage(event) {
      const data = event.data;
      if (event.source !== window || !data || data.taskId !== taskId) return;
      if (data.type === 'REPLY_INBOX_PHOTO_SUCCESS') finish({ ok: true, messageId: String(data.messageId || '') });
      else if (data.type === 'REPLY_INBOX_PHOTO_FAILURE') finish({ ok: false, error: (typeof data.error === 'string' ? data.error : JSON.stringify(data.error || 'extension Pancake báo lỗi')).slice(0, 200) });
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

async function send(item) {
  if (!validItem(item)) return { ok: false, error: 'lệnh gửi không hợp lệ' };
  const tabId = await pancakeTab();
  let globalUserId = String(item.globalUserId || '');
  let foundId = '';
  if (!globalUserId) {
    const [lookup] = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: lookupGlobalIdThroughPancake,
      args: [{ pageId: String(item.pageId), convId: String(item.convId), name: String(item.name || ''), updatedTime: Number(item.updatedTime) || Date.now() }]
    });
    if (!lookup?.result?.ok) return { ok: false, error: lookup?.result?.error || 'không tìm được ID Facebook của khách' };
    globalUserId = foundId = lookup.result.globalId;
  }
  const [injection] = await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    func: sendThroughPancake,
    args: [{ pageId: String(item.pageId), convId: String(item.convId), globalUserId, text: item.text, name: String(item.name || '') }]
  });
  const result = injection?.result || { ok: false, error: 'không chạy được trong tab Pancake' };
  return foundId ? { ...result, globalId: foundId } : result;
}

chrome.runtime.onMessage.addListener((message, sender, reply) => {
  // Chỉ nhận lệnh từ trang CRM.
  if (message?.type !== 'GN_SEND' || !String(sender.url || '').startsWith('https://fb.giotnang.vn/')) return false;
  send(message.item).then(reply, error => reply({ ok: false, error: String(error?.message || error).slice(0, 200) }));
  return true;
});
