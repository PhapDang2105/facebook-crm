// Cài đặt → Nhân sự: danh sách tài khoản CRM (API /api/staff). Tệp riêng, chạy sau app.js;
// tự tải khi bảng Nhân sự hiện ra (app.js chỉ bật/tắt các bảng Cài đặt). Chữ của người dùng
// luôn gán qua textContent / value, không ghép vào innerHTML.
(() => {
  const panel = document.querySelector('[data-settings-panel="staff"]');
  const rows = document.getElementById('staff-rows');
  const addButton = document.getElementById('staff-add');
  const note = document.getElementById('staff-login-note');
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
    if (!response.ok) throw new Error(data.error || `Lỗi ${response.status}`);
    return data;
  }

  function renderNote() {
    if (!note) return;
    const withPassword = state.items.filter(item => item.active && item.hasPassword).length;
    let message = '';
    if (!state.loginEnabled) {
      message = 'Đăng nhập chưa bật. Khi đặt mật khẩu cho tài khoản đầu tiên (phải là Quản trị), CRM sẽ bắt mọi người đăng nhập bằng tài khoản của mình.';
    } else if (!state.canManage) {
      message = 'Bạn đang xem danh sách. Chỉ Quản trị mới thêm hoặc sửa được Nhân sự.';
    } else if (!withPassword && state.ownerAccounts) {
      message = 'Hiện chỉ có tài khoản chủ shop đăng nhập được. Đặt mật khẩu để nhân viên đăng nhập bằng tài khoản riêng.';
    }
    note.hidden = !message;
    note.textContent = message;
  }

  function render() {
    renderNote();
    addButton.hidden = !state.canManage;
    rows.replaceChildren();
    if (!state.items.length) {
      rows.append(el('p', 'channel-empty staff-empty', 'Chưa có nhân sự nào. Bấm “+ Thêm nhân sự” để tạo tài khoản đầu tiên.'));
      return;
    }
    for (const member of state.items) {
      const row = el('div', `staff-row${member.active ? '' : ' is-inactive'}`);
      const name = el('span', 'staff-name', member.name);
      if (member.username === state.currentUser) name.append(el('em', 'staff-you', 'bạn'));
      row.append(
        name,
        el('span', 'staff-username', member.username),
        el('span', `staff-role staff-role--${member.role}`, member.roleName || member.role),
        el('span', 'staff-muted', member.phone || '—'),
        el('span', 'staff-muted', member.pancakeNames?.length ? member.pancakeNames.join(', ') : '—'),
        el('span', member.hasPassword ? 'staff-ok' : 'staff-muted', member.hasPassword ? 'Đã đặt' : 'Chưa đặt'),
        el('span', member.active ? 'staff-status' : 'staff-status is-off', member.active ? 'Đang làm' : 'Đã nghỉ')
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

  function field(labelText, input, hint = '') {
    const label = el('label', 'staff-field');
    label.append(el('span', 'staff-field-label', labelText), input);
    if (hint) label.append(el('small', 'staff-field-hint', hint));
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
    const username = Object.assign(el('input'), { name: 'username', required: true, maxLength: 32, value: member?.username || '', autocomplete: 'off', spellcheck: false, placeholder: 'vd: hang.th' });
    const role = el('select');
    role.name = 'role';
    for (const [value, labelText] of Object.entries(state.roles || { staff: 'Nhân viên', admin: 'Quản trị' })) {
      const option = Object.assign(el('option', '', labelText), { value });
      option.selected = (member?.role || 'staff') === value;
      role.append(option);
    }
    const phone = Object.assign(el('input'), { name: 'phone', value: member?.phone || '', inputMode: 'tel', autocomplete: 'off', maxLength: 15 });
    const pancakeNames = Object.assign(el('input'), { name: 'pancakeNames', value: (member?.pancakeNames || []).join(', '), autocomplete: 'off', maxLength: 300, placeholder: 'vd: Thúy Hằng' });
    const password = Object.assign(el('input'), { name: 'password', type: 'password', autocomplete: 'new-password', minLength: 8, placeholder: editing ? 'Để trống nếu không đổi' : 'Ít nhất 8 ký tự' });
    const active = Object.assign(el('input'), { name: 'active', type: 'checkbox', checked: member ? member.active : true });
    const activeLabel = el('label', 'staff-check');
    activeLabel.append(active, el('span', '', 'Đang làm (bỏ chọn khi nhân viên đã nghỉ: không đăng nhập được nữa)'));

    const error = el('p', 'staff-form-error');
    error.hidden = true;
    const cancel = Object.assign(el('button', 'staff-cancel', 'Huỷ'), { type: 'button' });
    const save = Object.assign(el('button', 'settings-save-button', editing ? 'Lưu thay đổi' : 'Thêm nhân sự'), { type: 'submit' });
    const buttons = el('div', 'staff-dialog-actions');
    buttons.append(cancel, save);

    form.append(
      title,
      field('Họ tên', name),
      field('Tên đăng nhập', username, 'Chữ thường không dấu, số và . _ - (3–32 ký tự). Dùng để đăng nhập CRM.'),
      field('Vai trò', role, 'Quản trị: thêm/sửa Nhân sự. Nhân viên: dùng CRM, không sửa Nhân sự.'),
      field('Số điện thoại', phone),
      field('Tên trên Pancake/POS', pancakeNames, 'Tên hiện ở tin nhắn và đơn của người này; nhiều tên cách nhau bằng dấu phẩy.'),
      field(editing && member.hasPassword ? 'Đổi mật khẩu' : 'Mật khẩu', password, editing && member.hasPassword ? 'Để trống thì giữ mật khẩu cũ. Đổi mật khẩu sẽ đăng xuất người này ở mọi máy.' : 'Chưa đặt mật khẩu thì người này chưa đăng nhập được.'),
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
      const body = {
        name: name.value,
        username: username.value,
        role: role.value,
        phone: phone.value,
        pancakeNames: pancakeNames.value,
        active: active.checked
      };
      if (password.value) body.password = password.value;
      save.disabled = true;
      try {
        const result = editing
          ? await api('PATCH', `/api/staff/${encodeURIComponent(member.id)}`, body)
          : await api('POST', '/api/staff', body);
        password.value = '';
        state = { ...state, items: result.items, loginEnabled: result.loginEnabled ?? state.loginEnabled };
        render();
        close();
        toast(editing ? `Đã lưu ${result.member.name}.` : `Đã thêm ${result.member.name}.`, 'success');
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
  new MutationObserver(() => { if (!panel.classList.contains('hidden')) load(); })
    .observe(panel, { attributes: true, attributeFilter: ['class'] });
  if (!panel.classList.contains('hidden')) load();
})();
