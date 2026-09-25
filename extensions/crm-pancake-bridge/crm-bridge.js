// Chạy trên trang CRM (fb.giotnang.vn): báo cho CRM biết cầu nối đã cài, và
// chuyển lệnh gửi của CRM sang nền của extension (nền mới được mở tab Pancake).
// Chỉ nhận tin từ chính trang CRM, chỉ một loại lệnh: GN_BRIDGE_SEND.
const version = chrome.runtime.getManifest().version;

function announce() {
  document.documentElement.dataset.gnBridge = version;
  window.postMessage({ type: 'GN_BRIDGE_READY', version }, window.location.origin);
}
announce();
document.addEventListener('DOMContentLoaded', announce);

window.addEventListener('message', event => {
  const data = event.data;
  if (event.source !== window || event.origin !== window.location.origin || !data) return;
  if (data.type === 'GN_BRIDGE_PING') { announce(); return; }
  if (data.type !== 'GN_BRIDGE_SEND' || !data.requestId || !data.item) return;
  chrome.runtime.sendMessage({ type: 'GN_SEND', item: data.item }, result => {
    const failure = chrome.runtime.lastError;
    window.postMessage({
      type: 'GN_BRIDGE_RESULT',
      requestId: data.requestId,
      ...(failure ? { ok: false, error: failure.message } : result || { ok: false, error: 'cầu nối không trả lời' })
    }, window.location.origin);
  });
});
