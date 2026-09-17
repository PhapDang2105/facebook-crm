// Khách hàng: one row per person per Page, merged from every thread they have
// with that Page — Messenger inbox, comments under posts, ads. Nothing is
// stored separately: the customer list is a view over the conversation store,
// so it can never drift from what the inbox shows.
import { readMessagingStore } from './messaging-store.mjs';
import { readChannelStore } from './channel-store.mjs';
import { customerPhoneKey, listExportedCustomers } from './customer-file.mjs';

const genderRank = { staff: 3, message: 2, name: 1 };

function customerKey(conversation) {
  return `${conversation.pageId}:${conversation.psid}`;
}

function firstMessageAt(store, conversation) {
  const messages = store.messages[conversation.id];
  const first = Array.isArray(messages) ? messages.find(item => item.direction === 'incoming') : null;
  return first?.createdAt || conversation.createdAt || 0;
}

/**
 * Sản phẩm đã mua, gộp theo SKU (không có SKU thì theo tên) — đây là thứ để lọc
 * remarketing: ai đã mua combo 2, ai mua Granola, ai mua trong 7 ngày qua.
 */
function collectPurchases(customer, orders) {
  for (const order of orders) {
    const createdAt = Number(order?.createdAt) || 0;
    if (createdAt) {
      if (!customer.firstOrderAt || createdAt < customer.firstOrderAt) customer.firstOrderAt = createdAt;
      if (createdAt > customer.lastOrderAt) customer.lastOrderAt = createdAt;
    }
    const items = Array.isArray(order?.products) ? order.products : [];
    // Combo tính theo tổng số túi trong MỘT đơn, vì bảng giá combo tính theo giỏ.
    const basket = items.reduce((sum, item) => sum + Math.max(1, Math.round(Number(item?.quantity) || 1)), 0);
    if (basket > customer.comboMax) customer.comboMax = basket;
    // Bảng hiển thị đơn GẦN NHẤT; danh sách gộp bên dưới chỉ để lọc "đã từng mua".
    if (createdAt >= customer.lastOrderSeenAt) {
      customer.lastOrderSeenAt = createdAt;
      customer.lastOrderCombo = basket;
      customer.lastOrderTotal = Number(order?.total) || 0;
      customer.lastOrderProducts = items.map(item => ({
        sku: String(item?.sku || '').trim(),
        name: String(item?.name || '').trim() || String(item?.sku || '').trim(),
        quantity: Math.max(1, Math.round(Number(item?.quantity) || 1))
      })).filter(item => item.name);
    }
    for (const item of items) {
      const name = String(item?.name || '').trim();
      const sku = String(item?.sku || '').trim();
      if (!name && !sku) continue;
      const key = sku || name.toLowerCase();
      const found = customer.products.find(entry => entry.key === key);
      const quantity = Math.max(1, Math.round(Number(item?.quantity) || 1));
      if (found) {
        found.quantity += quantity;
        if (createdAt > found.lastAt) found.lastAt = createdAt;
        if (!found.name && name) found.name = name;
      } else {
        customer.products.push({ key, sku, name: name || sku, quantity, lastAt: createdAt });
      }
    }
  }
  customer.products.sort((first, second) => (second.lastAt || 0) - (first.lastAt || 0));
}

/** Merges every thread of one person into a single customer record. */
export function buildCustomers(store, channels = [], exported = []) {
  const channelNames = new Map(channels.map(channel => [String(channel.id), channel.name]));
  const customers = new Map();
  for (const conversation of store.conversations) {
    if (!conversation.psid || conversation.psid === conversation.pageId) continue;
    const key = customerKey(conversation);
    const orders = Array.isArray(conversation.customerOrders) ? conversation.customerOrders : [];
    const notes = Array.isArray(conversation.customerNotes) ? conversation.customerNotes : [];
    const source = conversation.referral?.adId ? 'ads' : (conversation.source === 'comment' ? 'comment' : 'inbox');
    const existing = customers.get(key) || {
      id: key,
      channelId: conversation.pageId,
      channelName: channelNames.get(String(conversation.pageId)) || '',
      psid: conversation.psid,
      name: '',
      picture: '',
      gender: '',
      genderSource: '',
      sources: [],
      adTitle: '',
      firstContactAt: 0,
      lastCustomerMessageAt: 0,
      lastMessageAt: 0,
      lastMessagePreview: '',
      phone: '',
      address: '',
      orderCount: 0,
      orderTotal: 0,
      // Remarketing: ai đã mua gì, mua bao nhiêu túi một lần, mua lần cuối khi nào.
      firstOrderAt: 0,
      lastOrderAt: 0,
      lastOrderSeenAt: -1,
      lastOrderProducts: [],
      lastOrderCombo: 0,
      lastOrderTotal: 0,
      products: [],
      comboMax: 0,
      noteCount: 0,
      labels: [],
      botEnabled: false,
      unread: false,
      conversations: [],
      // Mã các đơn đã đếm từ hội thoại, để đơn xuất kho cùng mã không bị cộng lần hai.
      orderIds: []
    };
    // Prefer the inbox thread's name and picture: Messenger's profile lookup
    // gives the real name; a comment only carries what the webhook sent.
    if (!existing.name || conversation.source !== 'comment') {
      existing.name = conversation.name || existing.name;
      existing.picture = conversation.picture || existing.picture;
    }
    if ((genderRank[conversation.genderSource] || 0) > (genderRank[existing.genderSource] || 0) && conversation.gender) {
      existing.gender = conversation.gender;
      existing.genderSource = conversation.genderSource;
    }
    if (!existing.sources.includes(source)) existing.sources.push(source);
    if (conversation.referral?.adTitle && !existing.adTitle) existing.adTitle = conversation.referral.adTitle;
    const first = firstMessageAt(store, conversation);
    if (first && (!existing.firstContactAt || first < existing.firstContactAt)) existing.firstContactAt = first;
    if ((conversation.lastCustomerMessageAt || 0) > existing.lastCustomerMessageAt) existing.lastCustomerMessageAt = conversation.lastCustomerMessageAt;
    if ((conversation.lastMessageAt || 0) > existing.lastMessageAt) {
      existing.lastMessageAt = conversation.lastMessageAt;
      existing.lastMessagePreview = conversation.lastMessagePreview || '';
    }
    // Contact details: the latest order wins, then what the bot has collected.
    const latestOrder = orders[0];
    if (latestOrder?.phone && !existing.phone) existing.phone = latestOrder.phone;
    if (latestOrder?.address && !existing.address) existing.address = latestOrder.address;
    if (!existing.phone && conversation.pendingOrder?.phone) existing.phone = conversation.pendingOrder.phone;
    if (!existing.address && conversation.pendingOrder?.address) existing.address = conversation.pendingOrder.address;
    existing.orderCount += orders.length;
    existing.orderIds.push(...orders.map(order => String(order?.id || '')).filter(Boolean));
    existing.orderTotal += orders.reduce((sum, order) => sum + (Number(order.total) || 0), 0);
    collectPurchases(existing, orders);
    existing.noteCount += notes.length;
    for (const label of Array.isArray(conversation.labels) ? conversation.labels : []) {
      if (!existing.labels.includes(label)) existing.labels.push(label);
    }
    existing.botEnabled = existing.botEnabled || conversation.botEnabled !== false;
    existing.unread = existing.unread || Boolean(conversation.unread);
    existing.conversations.push({ id: conversation.id, source: conversation.source || 'inbox' });
    customers.set(key, existing);
  }
  mergeExportedCustomers(customers, exported);
  // Mới tương tác hoặc mới mua đều lên đầu: khách landing không có tin nhắn vẫn xếp theo ngày mua.
  const recency = customer => Math.max(customer.lastMessageAt || 0, customer.lastOrderAt || 0);
  return [...customers.values()].sort((first, second) => recency(second) - recency(first));
}

/**
 * Tệp khách hàng từ Xuất dữ liệu: khớp theo số điện thoại với khách Facebook đã
 * có thì cộng đơn (bỏ đơn chatbot đã đếm từ hội thoại, nhận ra qua mã), còn không
 * thì là một khách riêng (landing, import) để chăm sóc lại.
 */
function mergeExportedCustomers(customers, exported) {
  if (!Array.isArray(exported) || !exported.length) return;
  const byPhone = new Map();
  for (const customer of customers.values()) {
    const key = customerPhoneKey(customer.phone);
    if (key && !byPhone.has(key)) byPhone.set(key, customer);
  }
  for (const person of exported) {
    const key = customerPhoneKey(person.phone);
    if (!key) continue;
    let customer = byPhone.get(key);
    if (!customer) {
      customer = {
        id: `export:${key}`,
        channelId: 'export',
        channelName: 'Đơn đã xuất',
        psid: '',
        name: '',
        picture: '',
        gender: '',
        genderSource: '',
        sources: [],
        adTitle: '',
        firstContactAt: 0,
        lastCustomerMessageAt: 0,
        lastMessageAt: 0,
        lastMessagePreview: '',
        phone: key,
        address: '',
        orderCount: 0,
        orderTotal: 0,
        firstOrderAt: 0,
        lastOrderAt: 0,
        lastOrderSeenAt: -1,
        lastOrderProducts: [],
        lastOrderCombo: 0,
        lastOrderTotal: 0,
        products: [],
        comboMax: 0,
        noteCount: 0,
        labels: [],
        botEnabled: false,
        unread: false,
        conversations: [],
        orderIds: []
      };
      customers.set(customer.id, customer);
      byPhone.set(key, customer);
    }
    if (!customer.sources.includes('export')) customer.sources.push('export');
    if (!customer.name) customer.name = person.name || '';
    if (!customer.address) customer.address = person.address || '';
    customer.lastExportedAt = Math.max(customer.lastExportedAt || 0, Number(person.lastExportedAt) || 0);
    const known = new Set(customer.orderIds);
    const fresh = (Array.isArray(person.orders) ? person.orders : []).filter(order => !known.has(String(order.id || '').replace(/^(?:LP|CB)-/, '')));
    if (!fresh.length) continue;
    customer.orderCount += fresh.length;
    customer.orderTotal += fresh.reduce((sum, order) => sum + (Number(order.total) || 0), 0);
    collectPurchases(customer, fresh.map(order => ({ createdAt: Number(order.orderedAt) || Number(order.exportedAt) || 0, total: order.total, products: order.products })));
    customer.orderIds.push(...fresh.map(order => String(order.id || '').replace(/^(?:LP|CB)-/, '')));
  }
}

function foldText(value) {
  return String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D').toLowerCase();
}

/**
 * Bộ lọc cho cả hai việc: quản lý data (tìm kiếm, kênh, nguồn, giới tính, thẻ,
 * tương tác trong N ngày) và remarketing (đã mua trong N ngày, đã mua sản phẩm
 * nào, mua combo mấy túi, mua bao nhiêu lần).
 * Mọi mốc thời gian đều đếm bằng số ngày, không nhập ngày tháng thủ công.
 */
export function filterCustomers(customers, filters = {}, now = Date.now()) {
  const query = foldText(filters.q).trim();
  const activeWithin = Math.max(0, Number(filters.activeWithin) || 0);
  const activeSince = activeWithin ? now - activeWithin * 86400000 : 0;
  const orderedWithin = Math.max(0, Number(filters.orderedWithin) || 0);
  const orderedSince = orderedWithin ? now - orderedWithin * 86400000 : 0;
  const product = foldText(filters.product).trim();
  const combo = Math.max(0, Number(filters.combo) || 0);
  const minOrders = Math.max(0, Number(filters.minOrders) || 0);
  return customers.filter(customer => {
    if (filters.channelId && customer.channelId !== String(filters.channelId)) return false;
    if (filters.source && !customer.sources.includes(filters.source)) return false;
    if (filters.gender && customer.gender !== filters.gender) return false;
    if (filters.label && !customer.labels.includes(filters.label)) return false;
    if (activeSince && customer.lastMessageAt < activeSince) return false;
    // "Đã chốt đơn trong 7 ngày qua" tính theo ngày lên đơn, không phải ngày nhắn tin.
    if (orderedSince && (!customer.lastOrderAt || customer.lastOrderAt < orderedSince)) return false;
    if (minOrders && customer.orderCount < minOrders) return false;
    // Combo: có ít nhất một đơn từ N túi trở lên.
    if (combo && customer.comboMax < combo) return false;
    if (product && !customer.products.some(item => foldText(`${item.sku} ${item.name}`).includes(product))) return false;
    if (query) {
      const haystack = foldText([
        customer.name, customer.psid, customer.phone, customer.address, customer.adTitle,
        customer.products.map(item => `${item.sku} ${item.name}`).join(' ')
      ].join(' '));
      if (!haystack.includes(query)) return false;
    }
    return true;
  });
}

export async function listCustomers(filters = {}) {
  const [store, channels, exported] = await Promise.all([readMessagingStore(), readChannelStore(), listExportedCustomers()]);
  // Màn Khách hàng là kho dữ liệu người ĐÃ MUA: người mới hỏi giá vẫn nằm trong
  // Tin nhắn, đưa vào đây chỉ làm loãng danh sách remarketing. Khách của đơn đã
  // xuất kho (tệp khách hàng) luôn có mặt, kể cả chưa từng nhắn tin.
  const buyers = buildCustomers(store, channels.items || [], exported).filter(customer => customer.orderCount > 0);
  return { total: buyers.length, items: filterCustomers(buyers, filters) };
}

const sourceLabels = { inbox: 'Tin nhắn', comment: 'Bình luận', ads: 'Quảng cáo', export: 'Đơn đã xuất' };
const labelNames = { new: 'Khách mới', consulting: 'Cần tư vấn', customer: 'Đã mua' };
const genderNames = { male: 'Nam', female: 'Nữ' };

function formatTime(value) {
  if (!value) return '';
  const date = new Date(value);
  const pad = number => String(number).padStart(2, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())} ${pad(date.getDate())}/${pad(date.getMonth() + 1)}/${date.getFullYear()}`;
}

/** CSV for Excel: UTF-8 with BOM, semicolon-free, quotes escaped. */
export function customersToCsv(customers, labels = []) {
  const labelNamesById = new Map(labels.map(label => [label.id, label.name]));
  const headers = ['Tên', 'ID Facebook', 'Giới tính', 'Kênh', 'Nguồn', 'Liên hệ lần đầu', 'Khách nhắn cuối', 'Tương tác cuối', 'Số điện thoại', 'Địa chỉ', 'Số đơn', 'Tổng tiền', 'Mua lần cuối', 'Đơn gần nhất gồm', 'Đã mua từ trước tới nay', 'Combo lớn nhất', 'Thẻ', 'Quảng cáo'];
  const rows = customers.map(customer => [
    customer.name,
    customer.psid,
    genderNames[customer.gender] || '',
    customer.channelName || customer.channelId,
    customer.sources.map(source => sourceLabels[source] || source).join(', '),
    formatTime(customer.firstContactAt),
    formatTime(customer.lastCustomerMessageAt),
    formatTime(customer.lastMessageAt),
    customer.phone,
    customer.address,
    customer.orderCount,
    customer.orderTotal,
    formatTime(customer.lastOrderAt),
    (customer.lastOrderProducts || []).map(item => `${item.name} ×${item.quantity}`).join(', '),
    (customer.products || []).map(item => `${item.name} ×${item.quantity}`).join(', '),
    customer.comboMax || '',
    // Thẻ nhân viên đã xóa trong Cài đặt thì không xuất ra dưới dạng mã.
    customer.labels.map(label => labelNamesById.get(label) || labelNames[label]).filter(Boolean).join(', '),
    customer.adTitle
  ]);
  const escape = value => {
    const text = String(value ?? '');
    return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
  };
  return `\uFEFF${[headers, ...rows].map(row => row.map(escape).join(',')).join('\r\n')}\r\n`;
}

/**
 * Danh sách tải lên Facebook Custom Audience. Meta khớp theo số đã hash, và chỉ
 * nhận số ở dạng quốc tế, nên 0987… phải thành 84987…; khách chưa có số thì bỏ
 * qua chứ không xuất dòng rỗng làm hỏng tệp.
 */
export function customersToAudienceCsv(customers) {
  const headers = ['phone', 'fn', 'country'];
  const seen = new Set();
  const rows = [];
  for (const customer of customers) {
    const local = String(customer.phone || '').replace(/\D/g, '');
    if (!/^0\d{9}$/.test(local)) continue;
    const phone = `84${local.slice(1)}`;
    if (seen.has(phone)) continue;
    seen.add(phone);
    rows.push([phone, String(customer.name || '').trim(), 'VN']);
  }
  const escape = value => {
    const text = String(value ?? '');
    return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
  };
  return `\uFEFF${[headers, ...rows].map(row => row.map(escape).join(',')).join('\r\n')}\r\n`;
}
