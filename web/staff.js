// Cài đặt → Nhân sự: danh sách tài khoản CRM (API /api/staff). Tệp riêng, chạy sau app.js;
// tự tải khi bảng Nhân sự hiện ra (app.js chỉ bật/tắt các bảng Cài đặt). Chữ của người dùng
// luôn gán qua textContent / value, không ghép vào innerHTML.
(() => {
  const panel = document.querySelector('[data-settings-panel="staff"]');
  const rows = document.getElementById('staff-rows');
  const addButton = document.getElementById('staff-add');
  if (!panel || !rows || !addButton) return;

  let state = { items: [], loginEnabled: false, canManage: true, currentUser: '', ownerAccounts: 0 };
  let loading = false;

  const toast = (message, type = 'error') => {
    if (typeof window.showToast === 'function') window.showToast(message, type);
    else window.alert(message);
  };

  const el = (tag, className = '', textValue = '') => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (textValue) node.textContent = textValue;
    return node;
  };

  async function api(method, url, body) {
    const response = await fetch(url, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
      credentials: 'same-origin'
    });
    const data = await response.json().catch(() => ({}));
    if (response.status === 403 && !/trang khác/i.test(String(data.error || ''))) throw new Error('Chỉ Quản trị được thay đổi mục này.');
    if (!response.ok) throw new Error(data.error || `Lỗi ${response.status}`);
    return data;
  }

  function render() {
    addButton.hidden = !state.canManage;
    rows.replaceChildren();
    if (!state.items.length) {
      rows.append(el('p', 'channel-empty staff-empty', 'Chưa có nhân sự nào.'));
      return;
    }
    // 03/10: MỘT hàng tiêu đề cột, vẽ ở đây (index.html không có hàng tĩnh — tests/r14-staff-header). Từng có hai hàng
    // (tĩnh + vẽ), rồi không hàng nào khi hai lần sửa bỏ ở hai nơi. Màn hẹp (≤ 1100px) ẩn hàng này, mỗi ô tự mang nhãn
    // cột qua data-label (staff.css).
    const columns = ['Họ tên', 'Tên đăng nhập', 'Vai trò', 'Số điện thoại', 'Tên trên Pancake/POS', 'Mật khẩu', 'Trạng thái'];
    const [, loginLabel, roleLabel, phoneLabel, pancakeLabel, passwordLabel, statusLabel] = columns;
    const head = el('div', 'staff-row staff-table-head');
    head.append(...columns.map(label => el('span', '', label)), el('span', ''));
    rows.append(head);
    const cell = (label, className, text) => { const node = el('span', className, text); node.dataset.label = label; return node; };
    for (const member of state.items) {
      const row = el('div', `staff-row${member.active ? '' : ' is-inactive'}`);
      const name = el('span', 'staff-name', member.name);
      if (member.username === state.currentUser) name.append(el('em', 'staff-you', 'bạn'));
      row.append(
        name,
        cell(loginLabel, 'staff-username', member.username),
        cell(roleLabel, `staff-role staff-role--${member.role}`, member.roleName || member.role),
        cell(phoneLabel, 'staff-muted', member.phone || '—'),
        cell(pancakeLabel, 'staff-muted', member.pancakeNames?.length ? member.pancakeNames.join(', ') : '—'),
        cell(passwordLabel, member.hasPassword ? 'staff-ok' : 'staff-muted', member.hasPassword ? 'Đã đặt' : 'Chưa đặt'),
        cell(statusLabel, member.active ? 'staff-status' : 'staff-status is-off', member.active ? 'Đang làm' : 'Đã nghỉ')
      );
      const actions = el('span', 'staff-actions');
      if (state.canManage) {
        const edit = el('button', 'staff-edit', 'Sửa');
        edit.type = 'button';
        edit.addEventListener('click', () => openForm(member));
        actions.append(edit);
      }
      row.append(actions);
      rows.append(row);
    }
  }

  async function load() {
    if (loading) return;
    loading = true;
    try {
      state = { ...state, ...(await api('GET', '/api/staff')) };
      render();
    } catch (error) {
      rows.replaceChildren(el('p', 'channel-empty staff-empty', `Chưa tải được nhân sự: ${error.message}`));
    } finally {
      loading = false;
    }
  }

  function field(labelText, input) {
    const label = el('label', 'staff-field');
    label.append(el('span', 'staff-field-label', labelText), input);
    return label;
  }

  function openForm(member = null) {
    const editing = Boolean(member);
    const overlay = el('div', 'staff-dialog');
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    const form = el('form', 'staff-dialog-panel');
    form.noValidate = true;
    const title = el('h2', '', editing ? `Sửa nhân sự: ${member.name}` : 'Thêm nhân sự');
    title.id = 'staff-dialog-title';
    overlay.setAttribute('aria-labelledby', title.id);

    const name = Object.assign(el('input'), { name: 'name', required: true, maxLength: 80, value: member?.name || '', autocomplete: 'off' });
    const username = Object.assign(el('input'), { name: 'username', required: true, maxLength: 32, value: member?.username || '', autocomplete: 'off', spellcheck: false, placeholder: 'chữ thường không dấu, vd: hang.th' });
    const role = el('select');
    role.name = 'role';
    for (const [value, labelText] of Object.entries(state.roles || { staff: 'Nhân viên', admin: 'Quản trị' })) {
      const option = Object.assign(el('option', '', labelText), { value });
      option.selected = (member?.role || 'staff') === value;
      role.append(option);
    }
    const phone = Object.assign(el('input'), { name: 'phone', value: member?.phone || '', inputMode: 'tel', autocomplete: 'off', maxLength: 15 });
    const pancakeNames = Object.assign(el('input'), { name: 'pancakeNames', value: (member?.pancakeNames || []).join(', '), autocomplete: 'off', maxLength: 300, placeholder: 'vd: Thúy Hằng, nhiều tên cách dấu phẩy' });
    const password = Object.assign(el('input'), { name: 'password', type: 'password', autocomplete: 'new-password', minLength: 8, placeholder: editing ? 'Để trống nếu không đổi' : 'Ít nhất 8 ký tự' });
    const active = Object.assign(el('input'), { name: 'active', type: 'checkbox', checked: member ? member.active : true });
    const activeLabel = el('label', 'staff-check');
    activeLabel.append(active, el('span', '', 'Đang làm'));

    const error = el('p', 'staff-form-error');
    error.hidden = true;
    const cancel = Object.assign(el('button', 'staff-cancel', 'Huỷ'), { type: 'button' });
    const save = Object.assign(el('button', 'settings-save-button', editing ? 'Lưu thay đổi' : 'Thêm nhân sự'), { type: 'submit' });
    const buttons = el('div', 'staff-dialog-actions');
    buttons.append(cancel, save);

    form.append(
      title,
      field('Họ tên', name),
      field('Tên đăng nhập', username),
      field('Vai trò', role),
      field('Số điện thoại', phone),
      field('Tên trên Pancake/POS', pancakeNames),
      field(editing && member.hasPassword ? 'Đổi mật khẩu' : 'Mật khẩu', password),
      activeLabel,
      error,
      buttons
    );
    overlay.append(form);
    document.body.append(overlay);
    name.focus();

    const close = () => {
      overlay.remove();
      document.removeEventListener('keydown', onKey);
    };
    const onKey = event => { if (event.key === 'Escape') close(); };
    document.addEventListener('keydown', onKey);
    overlay.addEventListener('mousedown', event => { if (event.target === overlay) close(); });
    cancel.addEventListener('click', close);

    form.addEventListener('submit', async event => {
      event.preventDefault();
      error.hidden = true;
      if (password.value && password.value.length < 8) {
        error.textContent = 'Mật khẩu cần ít nhất 8 ký tự.';
        error.hidden = false;
        password.focus();
        return;
      }
      // SĐT sai (chữ, thiếu số) máy chủ âm thầm xoá thành trống: báo ngay tại ô.
      const phoneDigits = phone.value.replace(/[\s.\-()]/g, '');
      if (phoneDigits && !/^(\+?84|0)\d{9}$/.test(phoneDigits)) {
        error.textContent = 'Số điện thoại chưa đúng (10 số, bắt đầu bằng 0). Để trống nếu không có.';
        error.hidden = false;
        phone.setAttribute('aria-invalid', 'true');
        phone.focus();
        return;
      }
      phone.removeAttribute('aria-invalid');
      const body = {
        name: name.value,
        username: username.value,
        role: role.value,
        phone: phone.value,
        pancakeNames: pancakeNames.value,
        active: active.checked
      };
      if (password.value) body.password = password.value;
      // Sửa chính mình: đổi mật khẩu/tên đăng nhập làm mọi phiên cũ hết hiệu lực. Kèm mật khẩu mới
      // thì máy chủ cấp lại cookie cho máy này (ở lại CRM, máy khác phải đăng nhập lại). Đổi tên
      // đăng nhập mà không kèm mật khẩu, hay cho chính mình nghỉ: máy này cũng phải đăng nhập lại.
      const self = editing && state.currentUser && member.username === state.currentUser;
      const usernameChanged = self && username.value.trim().toLowerCase() !== String(member.username || '').toLowerCase();
      const deactivatingSelf = self && member.active && !body.active;
      const endsOwnSession = self && (deactivatingSelf || (usernameChanged && !body.password));
      const ownQuestion = deactivatingSelf
        ? 'Bạn đang chuyển chính mình sang "Đã nghỉ". Lưu xong bạn sẽ bị đăng xuất và không đăng nhập lại được. Tiếp tục?'
        : endsOwnSession
          ? 'Bạn đang đổi tên đăng nhập của chính mình. Lưu xong bạn cần đăng nhập lại bằng tên mới. Tiếp tục?'
          : self && body.password
            ? 'Bạn đang đổi mật khẩu của chính mình. Máy này vẫn giữ đăng nhập; các máy khác đang dùng tài khoản này sẽ phải đăng nhập lại bằng mật khẩu mới. Tiếp tục?'
            : '';
      if (ownQuestion && !window.confirm(ownQuestion)) return;
      save.disabled = true;
      try {
        const result = editing
          ? await api('PATCH', `/api/staff/${encodeURIComponent(member.id)}`, body)
          : await api('POST', '/api/staff', body);
        password.value = '';
        if (endsOwnSession) {
          close();
          location.assign(`/login?reason=expired&next=${encodeURIComponent(location.pathname + location.hash)}`);
          return;
        }
        // Đổi tên đăng nhập kèm mật khẩu: phiên mới mang tên mới, dấu "bạn" theo tên mới.
        if (self && result.member?.username) state.currentUser = result.member.username;
        state = { ...state, items: result.items, loginEnabled: result.loginEnabled ?? state.loginEnabled };
        render();
        close();
        toast(self && body.password ? 'Đã đổi mật khẩu. Máy này vẫn đăng nhập; máy khác cần đăng nhập lại bằng mật khẩu mới.' : (editing ? `Đã lưu ${result.member.name}.` : `Đã thêm ${result.member.name}.`), 'success');
        // Vừa bật đăng nhập (tài khoản có mật khẩu đầu tiên): tải lại để màn hình hỏi đăng nhập.
        if (!editing && result.loginEnabled && !state.currentUser) toast('Đăng nhập đã bật. Lần mở CRM sau, mọi người cần đăng nhập.', 'success');
      } catch (failure) {
        error.textContent = failure.message;
        error.hidden = false;
      } finally {
        save.disabled = false;
      }
    });
  }

  addButton.addEventListener('click', () => openForm());
  // app.js bật/tắt lớp "hidden" của bảng khi chọn mục Cài đặt: bảng Nhân sự hiện ra thì tải lại danh sách.
  // Chỉ tải khi bảng CHUYỂN từ ẩn sang hiện: lớp khác đổi (is-staff-readonly của app.js thêm lại sau
  // mỗi lần vẽ) không được gọi load() — trước đây nhân viên thường mở mục này là gọi /api/staff liên tục.
  let wasHidden = panel.classList.contains('hidden');
  new MutationObserver(() => {
    const hidden = panel.classList.contains('hidden');
    if (wasHidden && !hidden) load();
    wasHidden = hidden;
  }).observe(panel, { attributes: true, attributeFilter: ['class'] });
  if (!wasHidden) load();
})();
