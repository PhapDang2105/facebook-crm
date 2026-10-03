// Trang Vận chuyển → "Báo khách hành trình đơn" (vận đơn Sapo, app/sapo-sync.mjs).
// Máy chủ tự gửi khi khách còn trong 24 giờ Messenger; tin ngoài 24 giờ nằm ở hàng chờ này và được gửi
// qua cầu nối Pancake (extensions/crm-pancake-bridge, dùng chung sendThroughBridge của app.js).
// "Tự gửi khi mở CRM" (nhớ theo trình duyệt): cứ 5 phút gửi hết hàng chờ ngoài 24 giờ qua cầu nối.
(() => {
  const root = document.querySelector('#shipping-notices');
  if (!root) return;
  const list = root.querySelector('#shipping-notices-list');
  const status = root.querySelector('#shipping-notices-status');
  const toggle = root.querySelector('#shipping-notify-toggle');
  const autoBridge = root.querySelector('#shipping-auto-bridge');
  const sendAllButton = root.querySelector('#shipping-notices-send-all');
  const AUTO_KEY = 'crm-shipping-auto-bridge';
  const AUTO_EVERY_MS = 5 * 60 * 1000;
  // Tự gửi bỏ qua tin đã lỗi từ 2 lần (thường là Pancake không tìm được tài khoản Facebook của khách): nhân viên xử lý tay.
  const AUTO_MAX_ATTEMPTS = 2;
  // Cầu nối hết giờ chờ ("chưa rõ" đã gửi chưa): giữ tin lại 1 giờ trên trình duyệt này — tự gửi và
  // "Gửi hàng chờ" bỏ qua, không gửi lại tin khách có thể đã nhận. Kết quả gửi được tới trễ vẫn báo về.
  const UNCERTAIN_KEY = 'crm-shipping-uncertain';
  const UNCERTAIN_HOLD_MS = 60 * 60 * 1000;
  let items = [];
  let running = false;
  const done = new Set();

  // Một hàm escape chung (escapeHtml của app.js, chạy trước tệp này); giá trị trống không thành chữ "undefined".
  const esc = value => escapeHtml(value ?? '');
  // Link hành trình chỉ nhận http(s): escape không chặn được "javascript:…".
  const safeUrl = value => (/^https?:\/\//i.test(String(value || '').trim()) ? String(value).trim() : '');
  const bridgeReady = () => Boolean(document.documentElement.dataset.gnBridge);
  const time = at => at ? new Date(at).toLocaleString('vi-VN', { hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit' }) : '';
  const readAuto = () => { try { return localStorage.getItem(AUTO_KEY) === '1'; } catch { return false; } };
  const writeAuto = value => { try { localStorage.setItem(AUTO_KEY, value ? '1' : '0'); } catch { /* trình duyệt chặn lưu */ } };
  const readUncertain = () => {
    try {
      const value = JSON.parse(localStorage.getItem(UNCERTAIN_KEY) || '{}');
      return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    } catch { return {}; }
  };
  const writeUncertain = (key, until) => {
    const all = readUncertain();
    const now = Date.now();
    for (const [entry, expires] of Object.entries(all)) if (!(Number(expires) > now)) delete all[entry];
    if (until) all[key] = until; else delete all[key];
    try { localStorage.setItem(UNCERTAIN_KEY, JSON.stringify(all)); } catch { /* trình duyệt chặn lưu */ }
  };
  const isUncertain = key => Number(readUncertain()[key]) > Date.now();

  async function api(path, options = {}) {
    const response = await fetch(path, { ...options, headers: { 'Content-Type': 'application/json', ...(options.headers || {}) } });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || `Lỗi ${response.status}`);
    return body;
  }

  function render(data) {
    const summary = data.lastSummary;
    const parts = [];
    if (!data.configured) parts.push('Chưa cấu hình Sapo trên máy chủ.');
    else if (data.lastRunAt) parts.push(`Đồng bộ Sapo lúc ${time(data.lastRunAt)}${summary ? `: ${summary.shipments} vận đơn, tự báo ${summary.sent} khách` : ''}.`);
    if (data.quietHour) parts.push('Đang giờ nghỉ (22h–7h): máy chủ chưa tự gửi.');
    if (!bridgeReady()) parts.push('Chưa thấy cầu nối Pancake trên trình duyệt này — tin ngoài 24 giờ chỉ gửi được khi cài cầu nối.');
    status.textContent = parts.join(' ');
    toggle.checked = Boolean(data.settings?.notifyCustomers);
    toggle.disabled = Boolean(data.settings?.lockedByEnv);
    toggle.title = data.settings?.lockedByEnv ? 'Đang đặt cứng bằng SAPO_NOTIFY_CUSTOMERS trong .env' : '';
    const pending = items.filter(item => !done.has(item.key));
    sendAllButton.disabled = running || !bridgeReady() || !pending.some(item => !item.inWindow);
    sendAllButton.textContent = running ? 'Đang gửi…' : `Gửi hàng chờ qua Pancake (${pending.filter(item => !item.inWindow).length})`;
    if (!pending.length) {
      list.innerHTML = '<p class="shipping-recent-empty">Không có tin vận đơn nào đang chờ báo khách.</p>';
      return;
    }
    list.innerHTML = pending.map(item => `
      <article class="shipping-notice" data-key="${esc(item.key)}">
        <div class="shipping-notice-head">
          <strong>${esc(item.name || 'Khách')}</strong>
          <span class="shipping-notice-stage">${esc(item.stageLabel)}</span>
          <span class="shipping-notice-window ${item.inWindow ? 'is-open' : ''}">${item.inWindow ? 'Trong 24 giờ – máy chủ sẽ tự gửi' : 'Ngoài 24 giờ – gửi qua Pancake'}</span>
        </div>
        <div class="shipping-notice-meta">${esc(item.carrier)} · ${safeUrl(item.trackingUrl) ? `<a href="${esc(safeUrl(item.trackingUrl))}" target="_blank" rel="noopener">${esc(item.trackingNumber)}</a>` : esc(item.trackingNumber)}${item.stageAt ? ` · ${time(item.stageAt)}` : ''}</div>
        ${isUncertain(item.key) ? '<div class="shipping-notice-error">Lần gửi trước cầu nối không trả lời — chưa rõ khách đã nhận chưa. Tự gửi tạm bỏ qua tin này 1 giờ; kiểm tra trong Pancake trước khi gửi lại.</div>' : ''}
        ${item.error ? `<div class="shipping-notice-error">Đã thử ${item.attempts || 1} lần, lỗi: ${esc(item.error)}${(item.attempts || 0) >= AUTO_MAX_ATTEMPTS ? ' — tự gửi đã dừng, nhân viên gửi tay trong Pancake rồi bấm "Đã gửi tay"' : ''}</div>` : ''}
        <details><summary>Lời sẽ gửi</summary><pre>${esc(item.text)}</pre></details>
        <div class="shipping-notice-actions">
          <button type="button" data-action="send">${item.inWindow ? 'Gửi ngay' : 'Gửi qua Pancake'}</button>
          <button type="button" data-action="manual" class="ghost">Đã gửi tay</button>
          <button type="button" data-action="skip" class="ghost">Bỏ qua</button>
        </div>
      </article>`).join('');
  }

  async function refresh() {
    try {
      const data = await api('/api/shipping/notices');
      items = data.items || [];
      for (const key of [...done]) if (!items.some(item => item.key === key)) done.delete(key);
      render(data);
      root.dataset.loaded = '1';
      return data;
    } catch (error) {
      status.textContent = `Không tải được hàng chờ: ${error.message}`;
      return null;
    }
  }

  const report = results => api('/api/shipping/notices/results', { method: 'POST', body: JSON.stringify({ results }) });

  /** Kết quả gửi ĐƯỢC tới sau khi đã hết giờ chờ: báo đúng hàng chờ vận đơn (không phải hàng bám đuổi). */
  async function reportLateSuccess(key, late) {
    if (!late?.ok) return;
    try {
      await report([{ key, ok: true, via: 'pancake-bridge' }]);
      done.add(key);
      writeUncertain(key, 0);
      await refresh();
    } catch { /* lần sau nhân viên thấy tin còn chờ và bấm "Đã gửi tay" */ }
  }

  /** Gửi một nhóm mục ngoài 24 giờ qua cầu nối, lần lượt, cách nhau 15–30 giây. */
  async function sendViaBridge(keys) {
    if (!bridgeReady() || typeof sendThroughBridge !== 'function') throw new Error('Chưa cài cầu nối Pancake trên trình duyệt này.');
    const { items: batch = [], skipped = [] } = await api('/api/shipping/notices/bridge-items', { method: 'POST', body: JSON.stringify({ keys }) });
    let sent = 0;
    let failed = skipped.length;
    for (const [index, item] of batch.entries()) {
      if (index) await new Promise(resolve => setTimeout(resolve, 15000 + Math.random() * 15000));
      const result = await sendThroughBridge(item, '', { onLate: late => reportLateSuccess(item.key, late) });
      if (result.unknown) {
        // Chưa rõ đã gửi chưa: giữ tin lại 1 giờ (không tự gửi lại) và tính là một lần thử trên máy chủ
        // (tự gửi dừng sau AUTO_MAX_ATTEMPTS lần). Cầu nối báo gửi được trễ thì reportLateSuccess ghi "đã gửi".
        failed += 1;
        writeUncertain(item.key, Date.now() + UNCERTAIN_HOLD_MS);
        await report([{ key: item.key, ok: false, error: 'Cầu nối không trả lời — chưa rõ đã gửi hay chưa', via: 'pancake-bridge' }]).catch(() => {});
        continue;
      }
      await report([{ key: item.key, ok: result.ok, error: result.error, via: 'pancake-bridge' }]).catch(() => {});
      if (result.ok) { sent += 1; done.add(item.key); } else failed += 1;
      render({ ...(await api('/api/shipping/notices').catch(() => ({}))), items });
    }
    return { sent, failed };
  }

  async function runAll(auto = false) {
    if (running) return;
    const keys = items.filter(item => !item.inWindow && !done.has(item.key) && !isUncertain(item.key) && (!auto || (item.attempts || 0) < AUTO_MAX_ATTEMPTS)).map(item => item.key);
    if (!keys.length) return;
    if (!auto && !confirm(`Gửi ${keys.length} tin báo vận đơn qua Pancake?\nMỗi tin cách nhau 15–30 giây, để trang CRM mở tới khi xong.`)) return;
    running = true;
    render({ settings: { notifyCustomers: toggle.checked }, configured: true, items });
    try {
      const { sent, failed } = await sendViaBridge(keys);
      status.textContent = `Đã gửi ${sent} tin qua Pancake${failed ? `, ${failed} tin lỗi/chưa rõ` : ''}.`;
    } catch (error) {
      status.textContent = error.message;
    } finally {
      running = false;
      await refresh();
    }
  }

  list.addEventListener('click', async event => {
    const button = event.target.closest('button[data-action]');
    const card = button?.closest('.shipping-notice');
    if (!button || !card || running) return;
    const item = items.find(entry => entry.key === card.dataset.key);
    if (!item) return;
    button.disabled = true;
    try {
      if (button.dataset.action === 'send' && item.inWindow) {
        await api('/api/shipping/notices/send', { method: 'POST', body: JSON.stringify({ key: item.key }) });
        done.add(item.key);
      } else if (button.dataset.action === 'send') {
        if (isUncertain(item.key) && !confirm('Lần gửi trước chưa rõ khách đã nhận chưa (cầu nối không trả lời). Đã kiểm tra trong Pancake và vẫn gửi lại?')) return;
        running = true;
        const { sent } = await sendViaBridge([item.key]);
        if (!sent) throw new Error('Pancake chưa gửi được tin này.');
      } else {
        const via = button.dataset.action === 'manual' ? 'manual' : 'skipped';
        await report([{ key: item.key, ok: true, via }]);
        done.add(item.key);
      }
    } catch (error) {
      alert(error.message);
    } finally {
      running = false;
      await refresh();
    }
  });

  toggle.addEventListener('change', async () => {
    try {
      await api('/api/shipping/settings', { method: 'PUT', body: JSON.stringify({ notifyCustomers: toggle.checked }) });
    } catch (error) {
      toggle.checked = !toggle.checked;
      alert(error.message);
    }
  });
  autoBridge.checked = readAuto();
  autoBridge.addEventListener('change', () => { writeAuto(autoBridge.checked); if (autoBridge.checked) refresh().then(() => runAll(true)); });
  sendAllButton.addEventListener('click', () => runAll(false));
  root.querySelector('#shipping-notices-refresh').addEventListener('click', refresh);

  // Tải khi mở trang Vận chuyển; tự gửi (nếu bật) chạy cả khi đang ở trang khác của CRM.
  document.querySelectorAll('.nav[data-view="shipping"]').forEach(nav => nav.addEventListener('click', () => refresh()));
  if (!document.querySelector('#shipping-view')?.classList.contains('hidden')) refresh();
  setInterval(async () => {
    if (!autoBridge.checked || running || !bridgeReady()) return;
    await refresh();
    await runAll(true);
  }, AUTO_EVERY_MS);
})();
