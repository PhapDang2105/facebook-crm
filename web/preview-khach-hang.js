/* Bản xem trước màn Khách hàng — logic hiển thị.
   Viết theo đúng lối của web/app.js: không framework, dựng chuỗi HTML rồi
   gán vào innerHTML, tên hàm và chú thích bằng cùng giọng văn. */

const table = document.querySelector('#customers-table');
const totalLine = document.querySelector('#customers-total');
const pager = document.querySelector('#customers-pager');
const bulkBar = document.querySelector('#bulk-bar');
const bulkCount = document.querySelector('#bulk-count');
const moreRow = document.querySelector('#more-row');
const moreToggle = document.querySelector('#more-toggle');
const moreCount = document.querySelector('#more-count');

const tabsBar = document.querySelector('#customers-tabs');

const filters = {
  q: document.querySelector('#f-q'),
  source: document.querySelector('#f-source'),
  label: document.querySelector('#f-label'),
  channel: document.querySelector('#f-channel'),
  gender: document.querySelector('#f-gender'),
  product: document.querySelector('#f-product'),
  ordered: document.querySelector('#f-ordered'),
  active: document.querySelector('#f-active'),
  combo: document.querySelector('#f-combo'),
  minorders: document.querySelector('#f-minorders')
};
/* Trước đây có thêm một ô "Sắp xếp" riêng bên cạnh việc bấm tiêu đề cột. Hai
   đường vào cùng một việc khiến ô select báo một kiểu còn bảng chạy kiểu khác,
   nên chỉ giữ cách bấm thẳng vào tiêu đề cột. */

const picked = new Set();
/* Tab lọc nhanh đang chọn. Tách khỏi `filters` vì nó không phải ô select,
   và nút "Xóa lọc" không được đụng tới nó — người dùng vẫn đang đứng ở tab đó. */
let stateTab = '';
let sortKey = 'lastOrderAt';
let sortDir = -1;
let page = 1;
let pageSize = 25;
let shown = [];

const sourceNames = { inbox: 'Tin nhắn', comment: 'Bình luận', ads: 'Quảng cáo', export: 'Đơn đã xuất', landing: 'Landing page' };

function escapeHtml(value) {
  return String(value == null ? '' : value).replace(/[&<>"']/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[character]);
}

function formatMoney(value) {
  const amount = Math.max(0, Math.round(Number(value) || 0));
  return amount ? `${new Intl.NumberFormat('vi-VN').format(amount)}đ` : '—';
}

function formatDate(value) {
  if (!value) return '';
  const date = new Date(value);
  const pad = number => String(number).padStart(2, '0');
  return `${pad(date.getDate())}/${pad(date.getMonth() + 1)}/${date.getFullYear()}`;
}

/** "3 ngày trước", "2 tháng trước" — nhân viên đọc nhanh hơn ngày tháng thuần. */
function timeSince(value) {
  const then = new Date(Number(value));
  if (!Number(value) || Number.isNaN(then.getTime())) return '';
  const startOfDay = date => new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const days = Math.round((startOfDay(new Date()) - startOfDay(then)) / 86400000);
  if (days <= 0) return 'Hôm nay';
  if (days === 1) return 'Hôm qua';
  if (days < 30) return `${days} ngày trước`;
  const months = Math.max(1, Math.round(days / 30));
  if (months < 12) return `${months} tháng trước`;
  return `${Math.floor(months / 12)} năm trước`;
}

/** Trạng thái khách đếm theo số lần phát sinh đơn, giữ đúng quy ước đang chạy. */
function customerState(customer) {
  const count = Number(customer.orderCount) || 0;
  if (count >= 3) return { key: 'loyal', label: 'Khách hàng trung thành' };
  if (count === 2) return { key: 'returning', label: 'Khách hàng cũ' };
  return { key: 'new', label: 'Khách hàng mới' };
}

function foldText(value) {
  return String(value || '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/gi, 'd').toLowerCase();
}

/* ---------- Đổ tùy chọn vào hai ô lọc động ---------- */
PRODUCTS.forEach(product => {
  const option = document.createElement('option');
  option.value = product.sku;
  option.textContent = product.name;
  filters.product.append(option);
});
LABELS.forEach(label => {
  const option = document.createElement('option');
  option.value = label.id;
  option.textContent = label.name;
  filters.label.append(option);
});

/* ---------- Lọc ---------- */
function applyFilters() {
  const query = foldText(filters.q.value.trim());
  const now = Date.now();
  return ALL.filter(customer => {
    if (query) {
      const hay = foldText([customer.name, customer.phone, customer.address, customer.adTitle,
        (customer.products || []).map(item => item.name).join(' ')].join(' '));
      if (!hay.includes(query)) return false;
    }
    if (filters.source.value && !(customer.sources || []).includes(filters.source.value)) return false;
    if (filters.label.value && !(customer.labels || []).some(label => label.id === filters.label.value)) return false;
    if (filters.channel.value && customer.channelId !== filters.channel.value) return false;
    if (filters.gender.value && customer.gender !== filters.gender.value) return false;
    if (filters.product.value && !(customer.products || []).some(item => item.sku === filters.product.value)) return false;
    // Khách thiếu mốc thời gian phải bị loại, không được lọt qua: phép trừ với
    // giá trị rỗng ra NaN, mà mọi so sánh với NaN đều sai nên điều kiện "quá hạn"
    // không bao giờ đúng và khách đó vẫn hiện.
    if (filters.ordered.value) {
      if (!customer.lastOrderAt) return false;
      if (now - customer.lastOrderAt > Number(filters.ordered.value) * 86400000) return false;
    }
    if (filters.active.value) {
      if (!customer.lastCustomerMessageAt) return false;
      if (now - customer.lastCustomerMessageAt > Number(filters.active.value) * 86400000) return false;
    }
    if (filters.combo.value && (customer.comboMax || 0) < Number(filters.combo.value)) return false;
    if (filters.minorders.value && (customer.orderCount || 0) < Number(filters.minorders.value)) return false;
    return true;
  });
}

/* Tab lọc nhanh. "Ngừng mua" không suy từ số đơn mà từ khoảng lặng: quá 90 ngày
   không phát sinh đơn nào thì cần gọi lại, dù trước đó mua nhiều tới đâu. */
const TABS = [
  { key: '', label: 'Tất cả' },
  { key: 'new', label: 'Khách mới' },
  { key: 'returning', label: 'Khách quay lại' },
  { key: 'loyal', label: 'Khách trung thành' },
  { key: 'lapsed', label: 'Ngừng mua' }
];

function matchesTab(customer, key) {
  if (!key) return true;
  if (key === 'lapsed') return Date.now() - customer.lastOrderAt > 90 * 86400000;
  return customerState(customer).key === key;
}

function renderTabs(base) {
  tabsBar.innerHTML = TABS.map(tab => {
    const count = base.filter(customer => matchesTab(customer, tab.key)).length;
    return `<button class="customers-tab ${tab.key === stateTab ? 'active' : ''}" type="button" data-tab="${tab.key}">${tab.label}<b>${count}</b></button>`;
  }).join('');
}

/** Đếm số ô lọc phụ đang có giá trị, để gắn con số lên nút "Lọc thêm". */
function countMoreFilters() {
  return ['channel', 'gender', 'product', 'ordered', 'active', 'combo', 'minorders']
    .filter(key => filters[key].value).length;
}

/* ---------- Bảng ---------- */
const COLUMNS = [
  { key: 'name', label: 'Khách hàng', sortable: true },
  { key: 'phone', label: 'Số điện thoại', sortable: false },
  { key: 'province', label: 'Khu vực', sortable: true },
  { key: 'state', label: 'Trạng thái', sortable: true, mid: true },
  { key: 'labels', label: 'Thẻ', sortable: false },
  { key: 'orderCount', label: 'Số đơn', sortable: true, mid: true },
  { key: 'orderTotal', label: 'Đã chi', sortable: true, mid: true },
  { key: 'lastOrderProducts', label: 'Sản phẩm', sortable: false },
  { key: 'lastOrderAt', label: 'Mua lần cuối', sortable: true }
];

/** Chip thẻ khách. Màu và tên icon là dữ liệu nhân viên tự đặt trong Cài đặt,
 *  nên phải lọc trước khi ghép vào thuộc tính HTML: màu chỉ nhận mã hex, tên
 *  icon chỉ nhận chữ–số–gạch nối. */
function labelChip(label) {
  const color = /^#[0-9a-f]{3,8}$/i.test(String(label.color || '')) ? label.color : '#6b7280';
  const icon = /^[a-z0-9-]+$/i.test(String(label.icon || '')) ? label.icon : 'label';
  return `<span class="conversation-label" style="--label-color:${color}"><img class="label-icon" src="/assets/icons/labels/${icon}.svg" alt="">${escapeHtml(label.name)}</span>`;
}

function sortIcon(column) {
  if (sortKey !== column.key) return '/assets/icons/customers/sort.svg';
  return sortDir < 0 ? '/assets/icons/customers/sort-down.svg' : '/assets/icons/customers/sort-up.svg';
}

function headHtml() {
  const allPicked = shown.length > 0 && shown.slice((page - 1) * pageSize, page * pageSize).every(customer => picked.has(customer.id));
  const cells = COLUMNS.map(column => {
    const classes = [column.mid ? 'customer-mid' : '', column.sortable ? 'is-sortable' : '', sortKey === column.key ? 'is-sorted' : ''].filter(Boolean).join(' ');
    const icon = column.sortable ? `<img class="customers-sort-icon" src="${sortIcon(column)}" alt="">` : '';
    return `<th class="${classes}"${column.sortable ? ` data-sort="${column.key}" title="Bấm để sắp xếp"` : ''}><span class="customers-th">${column.label}${icon}</span></th>`;
  }).join('');
  return `<th class="customer-pick"><input type="checkbox" id="pick-all" aria-label="Chọn tất cả trên trang"${allPicked ? ' checked' : ''}></th>${cells}`;
}

function rowHtml(customer) {
  const state = customerState(customer);
  const initial = String(customer.name || 'K').trim().charAt(0).toUpperCase();
  const source = (customer.sources || []).map(name => sourceNames[name] || name).join(' · ');
  const products = customer.lastOrderProducts || [];
  const productCell = products.length
    ? `<div class="customer-products" title="${escapeHtml(products.map(item => `${item.name} ×${item.quantity}`).join(', '))}">${
        products.slice(0, 2).map(item => `<span class="customer-product">${escapeHtml(item.name)} ×${item.quantity}</span>`).join('')
      }${products.length > 2 ? `<span class="customer-product-meta">+${products.length - 2} mặt hàng khác</span>` : ''}</div>`
    : '<span class="customer-never">—</span>';
  const tags = (customer.labels || []).length
    ? `<div class="customer-tag-wrap">${customer.labels.slice(0, 2).map(labelChip).join('')}${
        customer.labels.length > 2 ? `<span class="customer-product-meta">+${customer.labels.length - 2}</span>` : ''}</div>`
    : '<span class="customer-never">—</span>';

  return `<tr data-id="${escapeHtml(customer.id)}" class="${picked.has(customer.id) ? 'is-picked' : ''}${customer.unread ? ' is-unread' : ''}">
    <td class="customer-pick"><input type="checkbox" data-pick="${escapeHtml(customer.id)}" aria-label="Chọn ${escapeHtml(customer.name)}"${picked.has(customer.id) ? ' checked' : ''}></td>
    <td class="customer-who"><div class="customer-who-cell">
      <span class="avatar">${escapeHtml(initial)}</span>
      <span class="customer-who-text">
        <strong>${escapeHtml(customer.name)}</strong>
        <small>${escapeHtml(source || 'Không rõ nguồn')}</small>
      </span>
    </div></td>
    <td><span class="customer-tel">${escapeHtml(customer.phone)}<button type="button" data-copy="${escapeHtml(customer.phone)}" title="Chép số điện thoại" aria-label="Chép số điện thoại"><img src="/assets/icons/customers/copy.svg" alt=""></button></span></td>
    <td class="customer-place"><b>${escapeHtml(customer.province)}</b><small title="${escapeHtml(customer.address)}">${escapeHtml(customer.address)}</small></td>
    <td class="customer-mid"><span class="customer-state customer-state--${state.key}">${state.label}</span></td>
    <td class="customer-tags">${tags}</td>
    <td class="customer-mid customer-order-count">${customer.orderCount}</td>
    <td class="customer-mid customer-money">${escapeHtml(formatMoney(customer.orderTotal))}</td>
    <td class="customer-bought">${productCell}</td>
    <td class="customer-bought-when"><b>${escapeHtml(formatDate(customer.lastOrderAt))}</b><small>${escapeHtml(timeSince(customer.lastOrderAt))}</small></td>
  </tr>`;
}

function render() {
  const base = applyFilters();
  renderTabs(base);
  shown = base.filter(customer => matchesTab(customer, stateTab)).sort((first, second) => {
    if (sortKey === 'name') return sortDir * String(first.name).localeCompare(String(second.name), 'vi');
    if (sortKey === 'province') return sortDir * String(first.province).localeCompare(String(second.province), 'vi');
    if (sortKey === 'state') return sortDir * ((first.orderCount || 0) - (second.orderCount || 0));
    return sortDir * ((Number(first[sortKey]) || 0) - (Number(second[sortKey]) || 0));
  });

  const pageCount = Math.max(1, Math.ceil(shown.length / pageSize));
  if (page > pageCount) page = pageCount;
  const slice = shown.slice((page - 1) * pageSize, page * pageSize);

  if (!shown.length) {
    table.classList.add('is-empty');
    table.innerHTML = '<div class="order-empty"><img src="/assets/icons/empty-box.svg" alt="" width="140" height="140"><small>Không có khách hàng nào khớp bộ lọc.</small></div>';
  } else {
    table.classList.remove('is-empty');
    table.innerHTML = `<table><thead><tr>${headHtml()}</tr></thead><tbody>${slice.map(rowHtml).join('')}</tbody></table>`;
  }

  const from = shown.length ? (page - 1) * pageSize + 1 : 0;
  const to = Math.min(page * pageSize, shown.length);
  totalLine.textContent = `Hiển thị ${from}–${to} / ${shown.length} khách hàng${shown.length === ALL.length ? '' : ` (tổng ${ALL.length})`}`;

  renderPager(pageCount);
  renderBulk();
  const count = countMoreFilters();
  moreCount.textContent = String(count);
  moreCount.classList.toggle('hidden', count === 0);
}

function renderPager(pageCount) {
  const numbers = [];
  for (let index = 1; index <= pageCount; index += 1) {
    if (index === 1 || index === pageCount || Math.abs(index - page) <= 1) numbers.push(index);
    else if (numbers[numbers.length - 1] !== '…') numbers.push('…');
  }
  pager.innerHTML = `
    <select class="customers-page-size" id="page-size" aria-label="Số dòng mỗi trang">
      ${[25, 50, 100].map(size => `<option value="${size}"${size === pageSize ? ' selected' : ''}>${size} dòng/trang</option>`).join('')}
    </select>
    <button type="button" data-page="${page - 1}"${page === 1 ? ' disabled' : ''} aria-label="Trang trước"><img src="/assets/icons/customers/chevron-left.svg" alt=""></button>
    ${numbers.map(number => number === '…'
      ? '<button type="button" disabled>…</button>'
      : `<button type="button" data-page="${number}" class="${number === page ? 'is-current' : ''}">${number}</button>`).join('')}
    <button type="button" data-page="${page + 1}"${page === pageCount ? ' disabled' : ''} aria-label="Trang sau"><img src="/assets/icons/customers/chevron-right.svg" alt=""></button>`;
}

function renderBulk() {
  bulkBar.classList.toggle('hidden', picked.size === 0);
  bulkCount.textContent = `Đã chọn ${picked.size} khách`;
}

/* ---------- Hộp chi tiết ---------- */
const dialog = document.querySelector('#customer-dialog');

function fact(label, value) {
  return `<div><dt>${escapeHtml(label)}</dt><dd>${value || '—'}</dd></div>`;
}

function openSheet(customer) {
  const initial = String(customer.name || 'K').trim().charAt(0).toUpperCase();
  const state = customerState(customer);
  document.querySelector('#sheet-id').innerHTML = `
    <span class="avatar">${escapeHtml(initial)}</span>
    <div>
      <h2 id="sheet-title">${escapeHtml(customer.name)}</h2>
      <small><span class="customer-state customer-state--${state.key}">${state.label}</span> · ${escapeHtml(customer.phone)} · ${escapeHtml(customer.province)}</small>
    </div>`;

  const tags = (customer.labels || []).map(labelChip).join(' ');

  const rows = customer.history.map(order => `<tr>
    <td>${escapeHtml(formatDate(order.at))}</td>
    <td>${order.products.map(item => `${escapeHtml(item.name)} ×${item.quantity}`).join('<br>')}</td>
    <td>${escapeHtml(order.status)}</td>
    <td class="num">${escapeHtml(formatMoney(order.total))}</td>
  </tr>`).join('');

  const notes = customer.notes.length
    ? customer.notes.map(note => `<div class="customer-note-item"><p>${escapeHtml(note.text)}</p><small>${escapeHtml(note.by)} · ${escapeHtml(formatDate(note.at))}</small></div>`).join('')
    : '<p class="customer-never">Chưa có ghi chú nào.</p>';

  document.querySelector('#sheet-body').innerHTML = `
    <section class="customer-sheet-block">
      <h3><img src="/assets/icons/customer-panel/user.png" alt="">Thông tin liên hệ</h3>
      <dl class="customer-facts">
        ${fact('Số điện thoại', escapeHtml(customer.phone))}
        ${fact('Giới tính', customer.gender === 'male' ? 'Nam' : customer.gender === 'female' ? 'Nữ' : '')}
        ${fact('Khu vực', escapeHtml(customer.province))}
        ${fact('Địa chỉ giao hàng', escapeHtml(customer.address))}
        ${fact('Nguồn khách', escapeHtml((customer.sources || []).map(name => sourceNames[name] || name).join(', ')))}
        ${fact('Quảng cáo dẫn vào', escapeHtml(customer.adTitle))}
        ${fact('Trang', escapeHtml(customer.channelName))}
        ${fact('Thẻ', tags)}
      </dl>
    </section>

    <section class="customer-sheet-block">
      <h3><img src="/assets/icons/customer-panel/wallet.png" alt="">Mua hàng</h3>
      <dl class="customer-facts">
        ${fact('Tổng số đơn', `${customer.orderCount} đơn`)}
        ${fact('Tổng đã chi', escapeHtml(formatMoney(customer.orderTotal)))}
        ${fact('Combo lớn nhất', `${customer.comboMax} túi/đơn`)}
        ${fact('Mua lần đầu', `${escapeHtml(formatDate(customer.firstOrderAt))} (${escapeHtml(timeSince(customer.firstOrderAt))})`)}
        ${fact('Mua lần cuối', `${escapeHtml(formatDate(customer.lastOrderAt))} (${escapeHtml(timeSince(customer.lastOrderAt))})`)}
        ${fact('Giá trị đơn trung bình', escapeHtml(formatMoney(customer.orderTotal / Math.max(1, customer.orderCount))))}
        ${fact('Đơn khách hủy', `${customer.history.filter(order => order.status === 'Khách hủy').length} đơn`)}
      </dl>
    </section>

    <section class="customer-sheet-block">
      <h3><img src="/assets/icons/customer-panel/list.png" alt="">Lịch sử đơn (${customer.history.length})</h3>
      <table class="customer-orders-table">
        <thead><tr><th>Ngày</th><th>Sản phẩm</th><th>Trạng thái</th><th class="num">Tiền</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </section>

    <section class="customer-sheet-block">
      <h3><img src="/assets/icons/customer-panel/note.png" alt="">Ghi chú &amp; hoạt động</h3>
      ${notes}
      <dl class="customer-facts" style="margin-top:9px">
        ${fact('Khách nhắn lần cuối', `${escapeHtml(formatDate(customer.lastCustomerMessageAt))} (${escapeHtml(timeSince(customer.lastCustomerMessageAt))})`)}
        ${fact('Tin nhắn cuối', escapeHtml(customer.lastMessagePreview))}
        ${fact('Chatbot', customer.botEnabled ? 'Đang bật' : 'Đã tắt')}
      </dl>
    </section>`;

  dialog.classList.remove('hidden');
}

/* ---------- Sự kiện ---------- */
/** Đổi bộ lọc là đổi danh sách, nên phải bỏ luôn những dòng đã tích: nếu giữ lại,
 *  thanh thao tác hàng loạt vẫn đếm và vẫn tác động lên những khách không còn
 *  nhìn thấy trên bảng. */
function resetView() {
  picked.clear();
  page = 1;
  render();
}

let searchTimer = 0;
filters.q.addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(resetView, 250);
});
Object.entries(filters).forEach(([key, input]) => {
  if (key === 'q') return;
  input.addEventListener('change', resetView);
});
tabsBar.addEventListener('click', event => {
  const tab = event.target.closest('[data-tab]');
  if (!tab) return;
  stateTab = tab.dataset.tab;
  resetView();
});

moreToggle.addEventListener('click', () => {
  const open = moreToggle.getAttribute('aria-expanded') === 'true';
  moreToggle.setAttribute('aria-expanded', String(!open));
  moreRow.classList.toggle('hidden', open);
});

document.querySelector('#clear-filters').addEventListener('click', () => {
  Object.values(filters).forEach(input => { input.value = ''; });
  resetView();
});

document.querySelector('#bulk-clear').addEventListener('click', () => { picked.clear(); render(); });

document.querySelector('#customers-refresh').addEventListener('click', () => {
  showToast('Đã tải lại danh sách khách hàng.', 'success');
});

table.addEventListener('change', event => {
  const all = event.target.closest('#pick-all');
  if (all) {
    const slice = shown.slice((page - 1) * pageSize, page * pageSize);
    if (all.checked) slice.forEach(customer => picked.add(customer.id));
    else slice.forEach(customer => picked.delete(customer.id));
    render();
    return;
  }
  const one = event.target.closest('[data-pick]');
  if (one) {
    if (one.checked) picked.add(one.dataset.pick);
    else picked.delete(one.dataset.pick);
    render();
  }
});

table.addEventListener('click', event => {
  const sorter = event.target.closest('th[data-sort]');
  if (sorter) {
    const key = sorter.dataset.sort;
    if (sortKey === key) sortDir = -sortDir;
    else { sortKey = key; sortDir = key === 'name' || key === 'province' ? 1 : -1; }
    render();
    return;
  }
  const copy = event.target.closest('[data-copy]');
  if (copy) {
    event.stopPropagation();
    navigator.clipboard?.writeText(copy.dataset.copy);
    showToast(`Đã chép số ${copy.dataset.copy}`, 'success', 2000);
    return;
  }
  if (event.target.closest('.customer-pick')) return;
  const row = event.target.closest('tr[data-id]');
  if (!row) return;
  const customer = ALL.find(item => item.id === row.dataset.id);
  if (customer) openSheet(customer);
});

pager.addEventListener('click', event => {
  const button = event.target.closest('button[data-page]');
  if (!button || button.disabled) return;
  page = Number(button.dataset.page);
  render();
});
pager.addEventListener('change', event => {
  if (!event.target.closest('#page-size')) return;
  pageSize = Number(event.target.value);
  page = 1;
  render();
});

dialog.addEventListener('click', event => {
  if (event.target.closest('[data-close]')) dialog.classList.add('hidden');
});
document.addEventListener('keydown', event => {
  if (event.key === 'Escape') dialog.classList.add('hidden');
});

const exportButton = document.querySelector('#customers-export');
const exportMenu = document.querySelector('#customers-export-menu');
exportButton.addEventListener('click', () => {
  const open = exportButton.getAttribute('aria-expanded') === 'true';
  exportButton.setAttribute('aria-expanded', String(!open));
  exportMenu.classList.toggle('hidden', open);
});
document.addEventListener('click', event => {
  if (event.target.closest('.customers-export')) return;
  exportButton.setAttribute('aria-expanded', 'false');
  exportMenu.classList.add('hidden');
});

/** Toast giống hệt app.js, để bản xem trước phản hồi đúng như hệ thống thật. */
function showToast(message, type = 'error', duration = 3500) {
  document.querySelector('.app-toast')?.remove();
  const toast = document.createElement('div');
  toast.className = `app-toast app-toast--${type}`;
  toast.textContent = message;
  toast.setAttribute('role', 'status');
  document.body.append(toast);
  window.setTimeout(() => toast.remove(), duration);
}

render();
