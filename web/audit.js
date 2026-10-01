// Cài đặt → Lịch sử: dấu vết thao tác của nhân viên (API /api/audit), và hộp "Lịch sử cập nhật
// hội thoại" mở từ nút đồng hồ ở đầu khung chat. Tệp riêng, chạy sau app.js; tự tải khi bảng hiện ra (app.js chỉ bật/tắt
// các bảng Cài đặt). Chữ từ máy chủ luôn gán qua textContent, không ghép vào innerHTML.
(() => {
  const TIME_ZONE = 'Asia/Ho_Chi_Minh';
  const PAGE_SIZE = 50;
  // Nhóm trong ô "Loại thao tác" → các tiền tố action gửi lên máy chủ (cách nhau dấu phẩy).
  const ACTION_GROUPS = {
    auth: ['auth.'],
    message: ['message.', 'conversation.', 'comment.'],
    order: ['order.', 'landing.'],
    customer: ['customer.'],
    settings: ['settings.']
  };
  const ROLE_NAMES = { admin: 'Quản trị', owner: 'Chủ shop', staff: 'Nhân viên', bot: 'Tự động' };

  const el = (tag, className = '', textValue = '') => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (textValue) node.textContent = textValue;
    return node;
  };

  const dayKeyFormat = new Intl.DateTimeFormat('en-CA', { timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' });
  const timeFormat = new Intl.DateTimeFormat('vi-VN', { timeZone: TIME_ZONE, hour: '2-digit', minute: '2-digit' });
  const dayLabelFormat = new Intl.DateTimeFormat('vi-VN', { timeZone: TIME_ZONE, weekday: 'long', day: '2-digit', month: '2-digit', year: 'numeric' });

  /** Ngày theo giờ Việt Nam dạng YYYY-MM-DD. */
  const vnDay = (value = Date.now()) => dayKeyFormat.format(new Date(value));
  const shiftDay = (day, offset) => {
    const date = new Date(`${day}T00:00:00Z`);
    date.setUTCDate(date.getUTCDate() + offset);
    return date.toISOString().slice(0, 10);
  };
  const dayLabel = at => {
    const day = vnDay(at);
    const today = vnDay();
    if (day === today) return 'Hôm nay';
    if (day === shiftDay(today, -1)) return 'Hôm qua';
    const label = dayLabelFormat.format(new Date(at));
    return label.charAt(0).toUpperCase() + label.slice(1);
  };

  const actionGroup = action => {
    const value = String(action || '');
    return Object.keys(ACTION_GROUPS).find(group => ACTION_GROUPS[group].some(prefix => value.startsWith(prefix))) || 'other';
  };

  // Lỗi máy chủ thường là tiếng Anh ("Resource not found"): đổi sang câu tiếng
  // Việt dễ hiểu, giữ nguyên câu máy chủ đã viết bằng tiếng Việt; chi tiết ở console.
  const VIETNAMESE_TEXT = /[àáạảãâầấậẩẫăằắặẳẵèéẹẻẽêềếệểễìíịỉĩòóọỏõôồốộổỗơờớợởỡùúụủũưừứựửữỳýỵỷỹđ]/i;
  function friendlyError(status, raw) {
    if (raw) console.warn('[Lịch sử]', status || '', raw);
    if (status === 401) return 'phiên đăng nhập đã hết, tải lại trang để đăng nhập lại.';
    if (raw && VIETNAMESE_TEXT.test(raw)) return raw;
    if (status === 404) return 'máy chủ chưa có mục Lịch sử (cần cập nhật máy chủ).';
    if (status >= 500) return 'máy chủ đang gặp lỗi, thử lại sau ít phút.';
    if (!status) return 'không kết nối được máy chủ, kiểm tra mạng rồi thử lại.';
    return `máy chủ trả lỗi ${status}, thử lại sau.`;
  }

  async function getJson(url) {
    let response;
    try {
      response = await fetch(url, { credentials: 'same-origin' });
    } catch (networkError) {
      throw new Error(friendlyError(0, networkError?.message || ''));
    }
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(friendlyError(response.status, String(data.error || '')));
      error.status = response.status;
      throw error;
    }
    return data;
  }

  /** Mở đối tượng của một dòng: đơn → màn Đơn hàng lọc đúng đơn; hội thoại → mở hội thoại. */
  function openTarget(item) {
    const target = item.target || {};
    const orderId = target.type === 'order' ? target.id : item.orderId;
    const conversationId = target.type === 'conversation' ? target.id : item.conversationId;
    if (orderId && typeof window.openOrderById === 'function') return void window.openOrderById(orderId);
    if (conversationId && typeof window.openConversationById === 'function') window.openConversationById(conversationId);
  }

  function targetText(item) {
    const target = item.target || {};
    const name = String(target.name || '').trim();
    const orderId = target.type === 'order' ? target.id : item.orderId;
    if (orderId) return { main: `#${orderId}`, sub: name };
    return { main: name || String(target.id || ''), sub: '' };
  }

  function canOpen(item) {
    const target = item.target || {};
    const order = target.type === 'order' ? target.id : item.orderId;
    const conversation = target.type === 'conversation' ? target.id : item.conversationId;
    return Boolean((order && typeof window.openOrderById === 'function') || (conversation && typeof window.openConversationById === 'function'));
  }

  // ---------------------------------------------------------------------------
  // Ẩn mục Lịch sử với nhân viên thường (đã bật đăng nhập). Chưa bật đăng nhập thì hiện.
  const subnavButton = document.querySelector('[data-settings-section="audit"]');
  fetch('/api/auth/session', { credentials: 'same-origin' })
    .then(response => (response.ok ? response.json() : null))
    .then(session => {
      if (!subnavButton || !session?.enabled) return;
      subnavButton.hidden = session.role === 'staff';
    })
    .catch(() => {});

  // ---------------------------------------------------------------------------
  // Trang Lịch sử
  const panel = document.querySelector('[data-settings-panel="audit"]');
  const rows = document.getElementById('audit-rows');
  const moreButton = document.getElementById('audit-more');
  const range = document.getElementById('audit-range');
  const dates = document.getElementById('audit-dates');
  const fromInput = document.getElementById('audit-from');
  const toInput = document.getElementById('audit-to');
  const actorSelect = document.getElementById('audit-actor');
  const actionSelect = document.getElementById('audit-action');
  const searchInput = document.getElementById('audit-search');

  let state = { items: [], next: null };
  let requestId = 0;
  let lastDay = '';

  function rangeDays() {
    const today = vnDay();
    const preset = range?.value || '7d';
    if (preset === 'today') return { from: today, to: today };
    if (preset === '30d') return { from: shiftDay(today, -29), to: today };
    if (preset === 'custom') {
      const from = fromInput?.value || shiftDay(today, -6);
      const to = toInput?.value || today;
      return from <= to ? { from, to } : { from: to, to: from };
    }
    return { from: shiftDay(today, -6), to: today };
  }

  /** URL /api/audit theo bộ lọc đang chọn; `before` là con trỏ "Tải thêm". */
  function auditUrl(before = null) {
    const { from, to } = rangeDays();
    const params = new URLSearchParams({ from, to, limit: String(PAGE_SIZE) });
    if (actorSelect?.value) params.set('actor', actorSelect.value);
    const group = ACTION_GROUPS[actionSelect?.value || ''];
    if (group) params.set('action', group.join(','));
    const query = searchInput?.value.trim();
    if (query) params.set('q', query);
    if (before !== null && before !== undefined && before !== '') params.set('before', String(before));
    return `/api/audit?${params}`;
  }

  function fillActors(actors) {
    if (!actorSelect || !Array.isArray(actors)) return;
    const current = actorSelect.value;
    const options = [el('option', '', 'Tất cả nhân viên')];
    options[0].value = '';
    for (const actor of actors) {
      if (!actor?.username) continue;
      const option = el('option', '', actor.name || actor.username);
      option.value = actor.username;
      options.push(option);
    }
    actorSelect.replaceChildren(...options);
    actorSelect.value = [...actorSelect.options].some(option => option.value === current) ? current : '';
  }

  function actorCell(item) {
    const cell = el('span', 'audit-actor');
    const name = String(item.actorName || item.actor || 'Không rõ');
    const avatar = el('span', `audit-avatar${item.actor === 'bot' ? ' is-bot' : ''}`, name.trim().charAt(0).toUpperCase() || '?');
    avatar.setAttribute('aria-hidden', 'true');
    const copy = el('span', 'audit-actor-copy');
    copy.append(el('strong', '', name));
    const role = item.roleName || ROLE_NAMES[item.role] || '';
    if (role) copy.append(el('small', '', role));
    cell.append(avatar, copy);
    return cell;
  }

  function targetCell(item) {
    const { main, sub } = targetText(item);
    const cell = el('span', 'audit-target');
    if (!main && !sub) {
      cell.append(el('span', 'audit-muted', '—'));
      return cell;
    }
    const label = canOpen(item) ? el('button', 'audit-target-link', main || sub) : el('span', '', main || sub);
    if (label.tagName === 'BUTTON') {
      label.type = 'button';
      label.title = 'Mở';
      label.addEventListener('click', () => openTarget(item));
    }
    cell.append(label);
    if (main && sub) cell.append(el('small', '', sub));
    return cell;
  }

  function auditRow(item) {
    const group = actionGroup(item.action);
    const failed = item.action === 'auth.login_failed';
    const row = el('div', `audit-row${failed ? ' is-failed' : ''}`);
    const time = el('time', 'audit-time', item.at ? timeFormat.format(new Date(item.at)) : '—');
    if (item.at) time.dateTime = new Date(item.at).toISOString();
    const action = el('span', 'audit-action');
    action.append(el('span', `audit-badge audit-badge--${group}`, item.label || item.action || '—'));
    const summary = el('span', 'audit-summary', item.summary || '');
    if (item.summary) summary.title = item.summary;
    row.append(time, actorCell(item), action, targetCell(item), summary, el('span', 'audit-ip', item.ip || ''));
    return row;
  }

  function appendItems(items) {
    const fragment = document.createDocumentFragment();
    for (const item of items) {
      const day = item.at ? vnDay(item.at) : '';
      if (day && day !== lastDay) {
        lastDay = day;
        fragment.append(el('div', 'audit-day', dayLabel(item.at)));
      }
      fragment.append(auditRow(item));
    }
    rows.append(fragment);
  }

  function showMessage(text, className = '') {
    rows.replaceChildren(el('p', `channel-empty audit-empty${className ? ` ${className}` : ''}`, text));
    moreButton?.classList.add('hidden');
  }

  async function load({ append = false } = {}) {
    if (!rows) return;
    const id = ++requestId;
    if (!append) {
      showMessage('Đang tải lịch sử...');
      lastDay = '';
    }
    if (moreButton) moreButton.disabled = true;
    try {
      const data = await getJson(auditUrl(append ? state.next : null));
      if (id !== requestId) return;
      const items = Array.isArray(data.items) ? data.items : [];
      fillActors(data.actors);
      state = { items: append ? [...state.items, ...items] : items, next: data.next ?? null };
      if (!append) rows.replaceChildren();
      if (!state.items.length) {
        showMessage('Không có hoạt động nào trong khoảng này.');
        return;
      }
      appendItems(items);
      moreButton?.classList.toggle('hidden', state.next === null || state.next === undefined || state.next === '');
    } catch (error) {
      if (id !== requestId) return;
      if (error.status === 403) showMessage('Chỉ Quản trị xem được lịch sử.', 'audit-denied');
      else if (append) window.showToast?.(`Chưa tải thêm được: ${error.message}`, 'error');
      else showMessage(`Chưa tải được lịch sử: ${error.message}`);
    } finally {
      if (moreButton && id === requestId) moreButton.disabled = false;
    }
  }

  if (panel && rows) {
    range?.addEventListener('change', () => {
      const custom = range.value === 'custom';
      dates?.classList.toggle('hidden', !custom);
      if (custom) {
        const today = vnDay();
        if (fromInput && !fromInput.value) fromInput.value = shiftDay(today, -6);
        if (toInput && !toInput.value) toInput.value = today;
      }
      load();
    });
    fromInput?.addEventListener('change', () => load());
    toInput?.addEventListener('change', () => load());
    actorSelect?.addEventListener('change', () => load());
    actionSelect?.addEventListener('change', () => load());
    let searchTimer = 0;
    searchInput?.addEventListener('input', () => {
      window.clearTimeout(searchTimer);
      searchTimer = window.setTimeout(() => load(), 300);
    });
    moreButton?.addEventListener('click', () => load({ append: true }));
    // app.js bật/tắt lớp "hidden" của bảng khi chọn mục Cài đặt: bảng Lịch sử hiện ra thì tải lại.
    new MutationObserver(() => { if (!panel.classList.contains('hidden')) load(); })
      .observe(panel, { attributes: true, attributeFilter: ['class'] });
    if (!panel.classList.contains('hidden')) load();
  }

  // ---------------------------------------------------------------------------
  // Nút đồng hồ ở đầu khung chat: hộp "Lịch sử cập nhật hội thoại" (như Pancake), mỗi tab một
  // nhóm thao tác trên đúng hội thoại đang mở: GET /api/audit?conversationId=…&action=…
  const HISTORY_TABS = [
    { key: 'labels', label: 'Thẻ hội thoại', action: 'conversation.labels' },
    { key: 'assign', label: 'Phân công nhân viên', action: 'conversation.assign' },
    { key: 'bot', label: 'Bot', action: 'conversation.bot' },
    { key: 'orders', label: 'Đơn hàng', action: 'order.' },
    { key: 'messages', label: 'Tin nhắn & xem', action: 'message.send,conversation.view' }
  ];
  const fullFormat = new Intl.DateTimeFormat('en-GB', { timeZone: TIME_ZONE, day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  /** dd/mm/yyyy HH:MM theo giờ Việt Nam. */
  const fullTime = at => {
    const parts = Object.fromEntries(fullFormat.formatToParts(new Date(at)).map(part => [part.type, part.value]));
    return `${parts.day}/${parts.month}/${parts.year} ${parts.hour}:${parts.minute}`;
  };

  /** URL tab của hộp lịch sử hội thoại. */
  function conversationHistoryUrl(conversationId, action) {
    const params = new URLSearchParams({ conversationId, action, limit: String(PAGE_SIZE) });
    return `/api/audit?${params}`;
  }

  function openConversationHistory(conversationId) {
    document.querySelector('.audit-dialog')?.remove();
    const overlay = el('div', 'audit-dialog');
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    const box = el('section', 'audit-dialog-panel');
    const head = el('header', 'audit-dialog-head');
    const title = el('h2', '', 'Lịch sử cập nhật hội thoại');
    title.id = 'audit-dialog-title';
    overlay.setAttribute('aria-labelledby', title.id);
    const close = el('button', 'audit-dialog-close', '×');
    close.type = 'button';
    close.setAttribute('aria-label', 'Đóng');
    head.append(title, close);
    const tabs = el('div', 'audit-dialog-tabs');
    tabs.setAttribute('role', 'tablist');
    const list = el('ol', 'audit-dialog-list');
    list.setAttribute('aria-live', 'polite');
    box.append(head, tabs, list);
    overlay.append(box);
    document.body.append(overlay);

    let request = 0;
    const message = text => list.replaceChildren(el('li', 'audit-dialog-empty', text));
    async function show(tab) {
      for (const button of tabs.children) {
        const active = button.dataset.tab === tab.key;
        button.classList.toggle('is-active', active);
        button.setAttribute('aria-selected', String(active));
      }
      const id = ++request;
      if (!conversationId) return message('Chưa có thay đổi nào');
      message('Đang tải...');
      try {
        const data = await getJson(conversationHistoryUrl(conversationId, tab.action));
        if (id !== request) return;
        const items = Array.isArray(data.items) ? data.items : [];
        if (!items.length) return message('Chưa có thay đổi nào');
        list.replaceChildren(...items.map(item => {
          const line = el('li', 'audit-dialog-item');
          const top = el('div', 'audit-dialog-item-head');
          top.append(
            el('b', '', item.actorName || item.actor || 'Không rõ'),
            el('span', `audit-badge audit-badge--${actionGroup(item.action)}`, item.label || item.action || ''),
            el('time', '', item.at ? fullTime(item.at) : '')
          );
          line.append(top);
          if (item.summary) line.append(el('p', '', item.summary));
          return line;
        }));
      } catch (error) {
        if (id !== request) return;
        message(error.status === 403 ? 'Chỉ Quản trị xem được lịch sử.' : `Chưa tải được: ${error.message}`);
      }
    }
    for (const tab of HISTORY_TABS) {
      const button = el('button', 'audit-dialog-tab', tab.label);
      button.type = 'button';
      button.dataset.tab = tab.key;
      button.setAttribute('role', 'tab');
      button.addEventListener('click', () => show(tab));
      tabs.append(button);
    }
    const dismiss = () => {
      overlay.remove();
      document.removeEventListener('keydown', onKey);
    };
    const onKey = event => { if (event.key === 'Escape') dismiss(); };
    document.addEventListener('keydown', onKey);
    overlay.addEventListener('mousedown', event => { if (event.target === overlay) dismiss(); });
    close.addEventListener('click', dismiss);
    close.focus();
    show(HISTORY_TABS[0]);
  }

  document.getElementById('chat-head-history')?.addEventListener('click', () => {
    const active = typeof window.getActiveConversation === 'function' ? window.getActiveConversation() : null;
    openConversationHistory(active?.dataset.conversationId || '');
  });

  window.crmAudit = { auditUrl, conversationHistoryUrl, openConversationHistory };
})();
