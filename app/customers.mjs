// Khách hàng: one row per person per Page, merged from every thread they have
// with that Page — Messenger inbox, comments under posts, ads. Nothing is
// stored separately: the customer list is a view over the conversation store,
// so it can never drift from what the inbox shows.
import { readMessagingStore } from './messaging-store.mjs';
import { readChannelStore } from './channel-store.mjs';

const genderRank = { staff: 3, message: 2, name: 1 };

function customerKey(conversation) {
  return `${conversation.pageId}:${conversation.psid}`;
}

function firstMessageAt(store, conversation) {
  const messages = store.messages[conversation.id];
  const first = Array.isArray(messages) ? messages.find(item => item.direction === 'incoming') : null;
  return first?.createdAt || conversation.createdAt || 0;
}

/** Merges every thread of one person into a single customer record. */
export function buildCustomers(store, channels = []) {
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
      noteCount: 0,
      labels: [],
      botEnabled: false,
      unread: false,
      conversations: []
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
    existing.orderTotal += orders.reduce((sum, order) => sum + (Number(order.total) || 0), 0);
    existing.noteCount += notes.length;
    for (const label of Array.isArray(conversation.labels) ? conversation.labels : []) {
      if (!existing.labels.includes(label)) existing.labels.push(label);
    }
    existing.botEnabled = existing.botEnabled || conversation.botEnabled !== false;
    existing.unread = existing.unread || Boolean(conversation.unread);
    existing.conversations.push({ id: conversation.id, source: conversation.source || 'inbox' });
    customers.set(key, existing);
  }
  return [...customers.values()].sort((first, second) => (second.lastMessageAt || 0) - (first.lastMessageAt || 0));
}

function foldText(value) {
  return String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D').toLowerCase();
}

/** Search, channel, source, gender, label and date-range filters from the query string. */
export function filterCustomers(customers, filters = {}) {
  const query = foldText(filters.q).trim();
  const from = Number(filters.from) || 0;
  const to = Number(filters.to) || 0;
  return customers.filter(customer => {
    if (filters.channelId && customer.channelId !== String(filters.channelId)) return false;
    if (filters.source && !customer.sources.includes(filters.source)) return false;
    if (filters.gender && customer.gender !== filters.gender) return false;
    if (filters.label && !customer.labels.includes(filters.label)) return false;
    if (from && customer.lastMessageAt < from) return false;
    if (to && customer.lastMessageAt > to) return false;
    if (query) {
      const haystack = foldText([customer.name, customer.psid, customer.phone, customer.address, customer.adTitle].join(' '));
      if (!haystack.includes(query)) return false;
    }
    return true;
  });
}

export async function listCustomers(filters = {}) {
  const [store, channels] = await Promise.all([readMessagingStore(), readChannelStore()]);
  const all = buildCustomers(store, channels.items || []);
  return { total: all.length, items: filterCustomers(all, filters) };
}

const sourceLabels = { inbox: 'Tin nhắn', comment: 'Bình luận', ads: 'Quảng cáo' };
const labelNames = { new: 'Khách mới', consulting: 'Cần tư vấn', customer: 'Đã mua' };
const genderNames = { male: 'Nam', female: 'Nữ' };

function formatTime(value) {
  if (!value) return '';
  const date = new Date(value);
  const pad = number => String(number).padStart(2, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())} ${pad(date.getDate())}/${pad(date.getMonth() + 1)}/${date.getFullYear()}`;
}

/** CSV for Excel: UTF-8 with BOM, semicolon-free, quotes escaped. */
export function customersToCsv(customers) {
  const headers = ['Tên', 'ID Facebook', 'Giới tính', 'Kênh', 'Nguồn', 'Liên hệ lần đầu', 'Khách nhắn cuối', 'Tương tác cuối', 'Số điện thoại', 'Địa chỉ', 'Số đơn', 'Tổng tiền', 'Thẻ', 'Quảng cáo'];
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
    customer.labels.map(label => labelNames[label] || label).join(', '),
    customer.adTitle
  ]);
  const escape = value => {
    const text = String(value ?? '');
    return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
  };
  return `\uFEFF${[headers, ...rows].map(row => row.map(escape).join(',')).join('\r\n')}\r\n`;
}
