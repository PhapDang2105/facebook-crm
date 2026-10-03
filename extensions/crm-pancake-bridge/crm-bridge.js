// Chạy trên trang CRM (fb.giotnang.vn): báo cho CRM biết cầu nối đã cài, và
// chuyển lệnh gửi của CRM sang nền của extension (nền mới được mở tab Pancake).
// Chỉ nhận tin từ chính trang CRM, chỉ một loại lệnh: GN_BRIDGE_SEND.
const version = chrome.runtime.getManifest().version;
// Chỉ chạy ở trang CRM gốc (kể cả khi có ?meta_ticket=… hay #settings); không chạy ở /q/* (trang công khai cho khách) hay /privacy.
if (!/^\/(index\.html)?$/.test(location.pathname)) throw new Error('crm-bridge: không chạy ở ' + location.pathname);

// Extension vừa được tải lại / cập nhật mà trang CRM chưa tải lại: bản content script cũ này mất liên lạc với nền
// ("Extension context invalidated"). Khi đó thôi báo "đã cài", gỡ dấu trên trang và trả lỗi rõ cho mọi lệnh.
const goneError = 'Cầu nối vừa cập nhật — tải lại trang CRM';
let gone = false;
const isInvalidated = error => /context invalidated/i.test(String(error?.message || error || ''));

function markGone() {
  if (gone) return;
  gone = true;
  try { delete document.documentElement.dataset.gnBridge; } catch { /* trang đang tải */ }
  window.postMessage({ type: 'GN_BRIDGE_GONE', error: goneError }, window.location.origin);
}

function announce() {
  if (gone) return;
  document.documentElement.dataset.gnBridge = version;
  window.postMessage({ type: 'GN_BRIDGE_READY', version }, window.location.origin);
}
announce();
document.addEventListener('DOMContentLoaded', announce);

const postResult = (requestId, result) => window.postMessage({ type: 'GN_BRIDGE_RESULT', requestId, ...result }, window.location.origin);

// Nền báo lệnh bắt đầu chạy (hết lượt xếp hàng sau lệnh khác): trang CRM đếm lại hạn chờ từ lúc này.
try {
  chrome.runtime.onMessage.addListener(message => {
    if (message?.type === 'GN_STARTED' && message.requestId) window.postMessage({ type: 'GN_BRIDGE_STARTED', requestId: String(message.requestId) }, window.location.origin);
    return false;
  });
} catch { /* nền đã mất liên lạc: lệnh gửi sẽ báo lỗi bên dưới */ }

window.addEventListener('message', event => {
  const data = event.data;
  if (event.source !== window || event.origin !== window.location.origin || !data) return;
  if (data.type === 'GN_BRIDGE_PING') { announce(); return; }
  if (data.type !== 'GN_BRIDGE_SEND' || !data.requestId || !data.item) return;
  if (gone) { postResult(data.requestId, { ok: false, error: goneError, bridgeGone: true }); return; }
  try {
    chrome.runtime.sendMessage({ type: 'GN_SEND', requestId: String(data.requestId), item: data.item }, result => {
      let failure = null;
      try { failure = chrome.runtime.lastError; } catch (error) { failure = error; }
      if (failure && isInvalidated(failure)) {
        markGone();
        postResult(data.requestId, { ok: false, error: goneError, bridgeGone: true });
        return;
      }
      postResult(data.requestId, failure ? { ok: false, error: failure.message } : result || { ok: false, error: 'cầu nối không trả lời' });
    });
  } catch (error) {
    // chrome.runtime.sendMessage ném ngay khi context đã mất (extension tải lại): trước đây lỗi này bị nuốt, trang chờ
    // tới hết giờ rồi báo "chưa rõ".
    if (isInvalidated(error) || !chrome.runtime?.id) markGone();
    postResult(data.requestId, { ok: false, error: gone ? goneError : String(error?.message || error).slice(0, 200), ...(gone ? { bridgeGone: true } : {}) });
  }
});
