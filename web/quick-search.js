// R13: ô "Tìm kiếm  Ctrl K" trên thanh trên cùng (trước đây là nút trơ, không có xử lý nào).
// Tìm nhanh KHÁCH/HỘI THOẠI theo tên, số điện thoại (GET /api/customers?q=) và ĐƠN theo mã, tên, số điện thoại
// (GET /api/orders/archive?q=), và (05/10) TIN NHẮN cũ / SĐT trong mọi hội thoại (GET /api/messaging/search). Chọn một dòng: mở hội thoại của khách (hoặc hồ sơ khách khi
// chưa có hội thoại), hay mở màn Đơn hàng lọc đúng đơn đó. Tệp riêng, chạy sau app.js (dùng các hàm toàn cục của
// app.js: showView, openCustomerConversation, openCustomerDialog, openOrderById). Chữ của người dùng luôn gán qua
// textContent, không ghép thành chuỗi HTML.
(() => {
  const trigger = document.querySelector('.search-trigger');
  if (!trigger) return;

  const MIN_LENGTH = 2;
  const PER_GROUP = 6;
  let overlay = null;
  let input = null;
  let list = null;
  let hint = null;
  let rows = [];
  let active = -1;
  let requestId = 0;
  let timer = null;
  // Chế độ CHỌN KHÁCH (form Tạo đơn → "Chọn khách hàng có sẵn"): chỉ tìm khách, chọn xong gọi hàm này thay vì mở hội thoại.
  let pickCustomer = null;

  const el = (tag, className = '', text = '') => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text) node.textContent = text;
    return node;
  };
  const money = value => `${Math.round(Number(value) || 0).toLocaleString('vi-VN')}đ`;
  const day = at => (Number(at) ? new Date(Number(at)).toLocaleDateString('vi-VN', { day: '2-digit', month: '2-digit', timeZone: 'Asia/Ho_Chi_Minh' }) : '');
  const statusLabel = value => ({ deleted: 'Đã xoá', cancelled: 'Hủy', confirmed: 'Đã xác nhận' }[String(value || '')] || '');

  async function getJson(url) {
    const response = await fetch(url, { credentials: 'same-origin' });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `Lỗi ${response.status}`);
    return data;
  }

  function build() {
    overlay = el('div', 'quick-search hidden');
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-label', 'Tìm nhanh khách hàng, hội thoại, đơn hàng');
    const panel = el('div', 'quick-search-panel');
    input = el('input', 'quick-search-input');
    input.type = 'search';
    input.autocomplete = 'off';
    input.spellcheck = false;
    input.placeholder = 'Tên khách, số điện thoại, mã đơn…';
    input.setAttribute('aria-label', 'Tìm nhanh');
    list = el('div', 'quick-search-results');
    list.setAttribute('role', 'listbox');
    hint = el('p', 'quick-search-hint', 'Gõ ít nhất 2 ký tự. ↑ ↓ để chọn, Enter để mở, Esc để đóng.');
    panel.append(input, list, hint);
    overlay.append(panel);
    document.body.append(overlay);

    overlay.addEventListener('mousedown', event => { if (event.target === overlay) close(); });
    input.addEventListener('input', () => {
      clearTimeout(timer);
      timer = setTimeout(search, 220);
    });
    input.addEventListener('keydown', event => {
      if (event.key === 'Escape') { event.preventDefault(); close(); }
      else if (event.key === 'ArrowDown') { event.preventDefault(); setActive(active + 1); }
      else if (event.key === 'ArrowUp') { event.preventDefault(); setActive(active - 1); }
      else if (event.key === 'Enter') { event.preventDefault(); rows[active]?.run(); }
    });
  }

  function open({ pick = null } = {}) {
    if (!overlay) build();
    pickCustomer = typeof pick === 'function' ? pick : null;
    overlay.classList.remove('hidden');
    input.value = '';
    input.placeholder = pickCustomer ? 'Chọn khách: gõ tên hoặc số điện thoại…' : 'Tên khách, số điện thoại, mã đơn…';
    render([], '');
    input.focus();
  }

  function close() {
    if (!overlay) return;
    overlay.classList.add('hidden');
    clearTimeout(timer);
    requestId += 1;
    trigger.focus();
  }

  function setActive(index) {
    if (!rows.length) return;
    active = (index + rows.length) % rows.length;
    rows.forEach((row, position) => {
      row.node.classList.toggle('is-active', position === active);
      row.node.setAttribute('aria-selected', String(position === active));
    });
    rows[active].node.scrollIntoView({ block: 'nearest' });
  }

  function addRow(title, detail, tag, run) {
    const node = el('button', 'quick-search-row');
    node.type = 'button';
    node.setAttribute('role', 'option');
    const main = el('span', 'quick-search-row-main');
    main.append(el('strong', '', title), el('span', '', detail));
    node.append(main, el('em', 'quick-search-row-tag', tag));
    const entry = { node, run: () => { close(); run(); } };
    node.addEventListener('click', entry.run);
    rows.push(entry);
    return node;
  }

  function render(groups, message) {
    rows = [];
    active = -1;
    list.replaceChildren();
    for (const group of groups) {
      if (!group.items.length) continue;
      list.append(el('p', 'quick-search-group', group.title));
      for (const item of group.items) list.append(addRow(item.title, item.detail, item.tag, item.run));
    }
    if (message) list.append(el('p', 'quick-search-empty', message));
    if (rows.length) setActive(0);
  }

  function customerRow(customer) {
    const threads = Array.isArray(customer.conversations) ? customer.conversations.length : 0;
    const orders = Number(customer.orderCount) || 0;
    const detail = [customer.phone || 'chưa có SĐT', customer.channelName || '', orders ? `${orders} đơn` : 'chưa có đơn'].filter(Boolean).join(' · ');
    return {
      title: customer.name || customer.phone || 'Khách',
      detail,
      tag: pickCustomer ? 'Chọn' : threads ? 'Mở hội thoại' : 'Hồ sơ khách',
      run: () => {
        if (pickCustomer) return pickCustomer(customer);
        if (threads && typeof openCustomerConversation === 'function') return openCustomerConversation(customer);
        if (typeof showView === 'function') showView('customers');
        if (typeof openCustomerDialog === 'function') openCustomerDialog(customer);
      }
    };
  }

  function orderRow(order) {
    const status = statusLabel(order.st);
    return {
      title: `#${order.id}${order.name ? ` · ${order.name}` : ''}`,
      detail: [order.phone || '', money(order.total), day(order.at), status].filter(Boolean).join(' · '),
      tag: 'Mở đơn',
      run: () => { if (typeof openOrderById === 'function') openOrderById(order.id); }
    };
  }

  // 05/10: tin nhắn cũ / SĐT trong mọi hội thoại (GET /api/messaging/search) — mở đúng hội thoại và làm nổi tin khớp.
  function messageRow(hit) {
    const reason = { phone: 'SĐT', message: 'Tin nhắn', name: 'Tên' }[hit.reason] || '';
    return {
      title: hit.name || 'Khách Facebook',
      detail: [day(hit.matchedAt), reason, hit.snippet || ''].filter(Boolean).join(' · '),
      tag: 'Mở tin',
      run: () => { if (typeof openMessageSearchHit === 'function') openMessageSearchHit(hit); }
    };
  }

  async function search() {
    const query = input.value.trim();
    const current = ++requestId;
    if (query.length < MIN_LENGTH) return render([], '');
    render([], 'Đang tìm…');
    const encoded = encodeURIComponent(query);
    const [customers, orders, messages] = await Promise.allSettled([
      getJson(`/api/customers?q=${encoded}`),
      pickCustomer ? Promise.resolve({ items: [] }) : getJson(`/api/orders/archive?q=${encoded}&limit=${PER_GROUP}`),
      pickCustomer || query.length < 3 ? Promise.resolve({ items: [] }) : getJson(`/api/messaging/search?q=${encoded}&limit=20`)
    ]);
    if (current !== requestId) return;
    const customerItems = customers.status === 'fulfilled' && Array.isArray(customers.value.items) ? customers.value.items.slice(0, PER_GROUP).map(customerRow) : [];
    const orderItems = orders.status === 'fulfilled' && Array.isArray(orders.value.items) ? orders.value.items.slice(0, PER_GROUP).map(orderRow) : [];
    const messageItems = messages.status === 'fulfilled' && Array.isArray(messages.value.items) ? messages.value.items.filter(hit => hit.reason !== 'name').slice(0, PER_GROUP).map(messageRow) : [];
    const failed = customers.status === 'rejected' && orders.status === 'rejected';
    render([
      { title: 'Khách hàng và hội thoại', items: customerItems },
      { title: 'Đơn hàng', items: orderItems },
      { title: 'Tin nhắn', items: messageItems }
    ], failed ? `Chưa tìm được: ${customers.reason?.message || 'lỗi không rõ'}` : (!customerItems.length && !orderItems.length && !messageItems.length ? `Không thấy ${pickCustomer ? 'khách' : 'khách hay đơn'} nào khớp "${query}".` : ''));
  }

  // Cho app.js gọi: mở ô tìm ở chế độ chọn khách.
  window.crmQuickSearch = { open: () => open(), pickCustomer: callback => open({ pick: callback }) };

  trigger.addEventListener('click', () => open());
  document.addEventListener('keydown', event => {
    if (!(event.ctrlKey || event.metaKey) || event.shiftKey || event.altKey) return;
    if (String(event.key).toLowerCase() !== 'k') return;
    event.preventDefault();
    if (overlay && !overlay.classList.contains('hidden')) close();
    else open();
  });
})();
