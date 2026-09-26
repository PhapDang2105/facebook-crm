// Chạy trên trang CRM (fb.giotnang.vn): báo cho CRM biết cầu nối đã cài, và
// chuyển lệnh gửi của CRM sang nền của extension (nền mới được mở tab Pancake).
// Chỉ nhận tin từ chính trang CRM, chỉ một loại lệnh: GN_BRIDGE_SEND.
const version = chrome.runtime.getManifest().version;
// Chỉ chạy ở trang CRM gốc (kể cả khi có ?meta_ticket=… hay #settings); không chạy ở /q/* (trang công khai cho khách) hay /privacy.
if (!/^\/(index\.html)?$/.test(location.pathname)) throw new Error('crm-bridge: không chạy ở ' + location.pathname);

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
