// Khách hàng: one row per person per Page, merged from every thread they have
// with that Page — Messenger inbox, comments under posts, ads. Nothing is
// stored separately: the customer list is a view over the conversation store,
// so it can never drift from what the inbox shows.
import { genderRank, readMessagingStore } from './messaging-store.mjs';
import { genderFromName } from './processing/customer-info.mjs';
import { readChannelStore } from './channel-store.mjs';
import { pancakeConfig } from './config.mjs';
import { customerPhoneKey, listExportedCustomers } from './customer-file.mjs';
import { applyCustomerEdits, CONTACT_STATUSES, isBotNote, readCustomerEdits } from './customer-edits.mjs';
import { collectOrderFacts, isCancelledOrder, isDayString, isIncompleteOrder, isValidFact, shiftDay, vietnamDayStartMs } from './order-facts.mjs';
import { listLandingOrders } from './landing-orders.mjs';
import { labelsForEvents, readInboxSettings } from './inbox-settings.mjs';
import { shipmentStage } from './shipment-stage.mjs';

function customerKey(conversation) {
  return `${conversation.pageId}:${conversation.psid}`;
}

// Pancake POS: 3 "Đã nhận", 16 "Đã thu tiền" (POS_STATUS.received / collected của phone-warnings.mjs).
const POS_RECEIVED_CODES = new Set([3, 16]);

/**
 * Đơn khách ĐÃ NHẬN HÀNG: vận đơn Sapo / hành trình hãng báo giao thành công, hay Pancake POS báo
 * "Đã nhận" / "Đã thu tiền". Vận đơn đang hoàn / đã hoàn thì shipmentStage trả null, không tính.
 */
export function isReceivedOrder(order) {
  if (!order) return false;
  return shipmentStage(order.shipment) === 'delivered' || POS_RECEIVED_CODES.has(Number(order.posStatus?.code));
}

/** Bản ghi khách rỗng — một khuôn cho khách hội thoại, khách landing và khách tệp xuất kho. */
function emptyCustomer(fields) {
  return {
    id: '',
    channelId: '',
    channelName: '',
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
    // Có ít nhất một đơn đã nhận hàng (isReceivedOrder, hay hội thoại mang thẻ "Giao hàng thành công"):
    // màn Khách hàng chỉ hiện những khách này (chủ shop 10/10).
    received: false,
    conversations: [],
    // Mã các đơn đã đếm từ hội thoại, để đơn xuất kho cùng mã không bị cộng lần hai.
    orderIds: [],
    ...fields
  };
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
      // "Khách mới" (metrics.mjs): mốc đơn ĐẦU TIÊN chỉ tính đơn hợp lệ — đơn hủy/hoàn/bom
      // hay form bỏ dở không biến khách thành khách mới, như Tổng quan và Báo cáo.
      if (!isCancelledOrder(order) && !isIncompleteOrder(order) && (!customer.firstOrderAt || createdAt < customer.firstOrderAt)) customer.firstOrderAt = createdAt;
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

/**
 * Merges every thread of one person into a single customer record, then adds landing-page orders
 * and the warehouse export file. `landingOrders`: đơn kho landing (khách đặt qua form, nhiều người
 * không nhắn Page); `deliveredLabels`: mã thẻ hội thoại nhận sự kiện "delivered" (Giao hàng thành công).
 */
export function buildCustomers(store, channels = [], exported = [], { landingOrders = [], deliveredLabels = [] } = {}) {
  const landing = Array.isArray(landingOrders) ? landingOrders : [];
  // Đơn không thành doanh thu — hủy/hoàn/bom (trạng thái mới nhất), form bỏ dở, đơn trùng
  // đã xóa khỏi bảng — cùng luật với Báo cáo (order-facts.mjs): không vào "Tổng đã chi",
  // số đơn hay "đã mua sản phẩm"; mã đơn vẫn được ghi để tệp xuất không cộng lại.
  const notCounted = new Set(collectOrderFacts({ conversations: store.conversations || [], landingOrders: landing })
    .filter(fact => fact.id && !isValidFact(fact)).map(fact => fact.id));
  const countedOrders = orders => orders.filter(order => order && !notCounted.has(String(order.id || '')));
  const deliveredLabelSet = new Set(deliveredLabels);
  const channelNames = new Map(channels.map(channel => [String(channel.id), channel.name]));
  const customers = new Map();
  for (const conversation of store.conversations) {
    if (!conversation.psid || conversation.psid === conversation.pageId) continue;
    const key = customerKey(conversation);
    const orders = Array.isArray(conversation.customerOrders) ? conversation.customerOrders : [];
    const notes = Array.isArray(conversation.customerNotes) ? conversation.customerNotes : [];
    const source = conversation.referral?.adId ? 'ads' : (conversation.source === 'comment' ? 'comment' : 'inbox');
    const existing = customers.get(key) || emptyCustomer({
      id: key,
      channelId: conversation.pageId,
      channelName: channelNames.get(String(conversation.pageId)) || '',
      psid: conversation.psid
    });
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
    const counted = countedOrders(orders);
    existing.orderCount += counted.length;
    existing.orderIds.push(...orders.map(order => String(order?.id || '')).filter(Boolean));
    existing.orderTotal += counted.reduce((sum, order) => sum + (Number(order.total) || 0), 0);
    collectPurchases(existing, counted);
    existing.noteCount += notes.length;
    // Ghi chú mới nhất viết ở khung khách bên Tin nhắn: cột "Ghi chú" màn Khách hàng so tiếp với ghi chú hộp chi
    // tiết (customer-edits.mjs) rồi hiện cái mới hơn.
    for (const note of notes) {
      if (isBotNote(note)) continue;
      const body = String(note?.text || '').trim();
      const at = Number(note?.createdAt) || Number(note?.at) || 0;
      if (body && (!existing.lastNote || at >= existing.lastNote.at)) {
        existing.lastNote = { text: body.slice(0, 200), at, by: String(note?.author?.name || note?.author?.username || '').slice(0, 80) };
      }
    }
    for (const label of Array.isArray(conversation.labels) ? conversation.labels : []) {
      if (!existing.labels.includes(label)) existing.labels.push(label);
    }
    // Đã nhận hàng: một đơn của hội thoại giao thành công, hay hội thoại mang thẻ "Giao hàng thành công"
    // (Sapo tự gắn khi vận đơn giao xong; nhân viên tự gắn được cho đơn giao trước khi có Sapo).
    if (orders.some(isReceivedOrder) || existing.labels.some(label => deliveredLabelSet.has(label))) existing.received = true;
    existing.botEnabled = existing.botEnabled || conversation.botEnabled !== false;
    existing.unread = existing.unread || Boolean(conversation.unread);
    existing.conversations.push({ id: conversation.id, source: conversation.source || 'inbox' });
    customers.set(key, existing);
  }
  const knownOrderIds = new Set([...customers.values()].flatMap(customer => customer.orderIds));
  mergeLandingCustomers(customers, landing, notCounted, knownOrderIds);
  mergeExportedCustomers(customers, exported, notCounted, knownOrderIds);
  // Đã nhận hàng tính theo NGƯỜI (số điện thoại): đơn giao thành công ở Page này, ở landing hay ở Page khác.
  const receivedPhones = new Set([...(store.conversations || []).flatMap(conversation => conversation.customerOrders || []), ...landing]
    .filter(isReceivedOrder).map(order => customerPhoneKey(order.phone)).filter(Boolean));
  for (const customer of customers.values()) {
    if (!customer.received && receivedPhones.has(customerPhoneKey(customer.phone))) customer.received = true;
    // Khách landing / tệp xuất kho không có hội thoại nên chưa có giới tính: đoán theo tên như hội thoại (cột Giới tính,
    // 10/10). Nhân viên chọn tay trong hộp chi tiết vẫn thắng (applyCustomerEdits phủ sau).
    if (!customer.gender) {
      const guess = genderFromName(customer.name);
      if (guess) Object.assign(customer, { gender: guess, genderSource: 'name' });
    }
  }
  // Mới tương tác hoặc mới mua đều lên đầu: khách landing không có tin nhắn vẫn xếp theo ngày mua.
  const recency = customer => Math.max(customer.lastMessageAt || 0, customer.lastOrderAt || 0);
  return [...customers.values()].sort((first, second) => recency(second) - recency(first));
}

/** Khách theo số điện thoại (khách đầu tiên mang số đó), để đơn landing / tệp xuất kho cộng vào đúng người. */
function customersByPhone(customers) {
  const byPhone = new Map();
  for (const customer of customers.values()) {
    const key = customerPhoneKey(customer.phone);
    if (key && !byPhone.has(key)) byPhone.set(key, customer);
  }
  return byPhone;
}

/**
 * Đơn landing page: khớp theo số điện thoại với khách đã có thì cộng đơn, không thì là một khách riêng
 * (nguồn "Landing page"). Đơn đã đếm từ hội thoại (cùng mã), form bỏ dở, đơn hủy/hoàn/bom, đơn trùng đã
 * xóa không cộng — cùng luật Báo cáo. Đơn mới trước để tên, địa chỉ lấy theo đơn gần nhất.
 */
function mergeLandingCustomers(customers, landingOrders, notCounted, knownOrderIds) {
  if (!landingOrders.length) return;
  const byPhone = customersByPhone(customers);
  const newestFirst = [...landingOrders].sort((first, second) => (Number(second?.createdAt) || 0) - (Number(first?.createdAt) || 0));
  for (const order of newestFirst) {
    const id = String(order?.id || '');
    const key = customerPhoneKey(order?.phone);
    if (!id || !key || knownOrderIds.has(id) || notCounted.has(id) || isIncompleteOrder(order) || isCancelledOrder(order)) continue;
    let customer = byPhone.get(key);
    if (!customer) {
      customer = emptyCustomer({ id: `landing:${key}`, channelId: 'landing', channelName: 'Landing page', phone: key });
      customers.set(customer.id, customer);
      byPhone.set(key, customer);
    }
    if (!customer.sources.includes('landing')) customer.sources.push('landing');
    if (!customer.name) customer.name = String(order.name || '').trim();
    if (!customer.address) customer.address = String(order.address || '').trim();
    customer.orderCount += 1;
    customer.orderTotal += Number(order.total) || 0;
    collectPurchases(customer, [order]);
    customer.orderIds.push(id);
    knownOrderIds.add(id);
    if (isReceivedOrder(order)) customer.received = true;
  }
}

/**
 * Tệp khách hàng từ Xuất dữ liệu: khớp theo số điện thoại với khách đã có thì
 * cộng đơn (bỏ đơn đã đếm từ hội thoại hay kho landing, nhận ra qua mã đã bỏ tiền tố
 * "LP-"/"CB-"; bỏ cả đơn kho đơn báo hủy/bỏ dở/trùng), còn không thì là một khách riêng.
 */
function mergeExportedCustomers(customers, exported, notCounted, knownOrderIds) {
  if (!Array.isArray(exported) || !exported.length) return;
  const byPhone = customersByPhone(customers);
  const bareId = order => String(order?.id || '').replace(/^(?:LP|CB)-/, '');
  for (const person of exported) {
    const key = customerPhoneKey(person.phone);
    if (!key) continue;
    let customer = byPhone.get(key);
    if (!customer) {
      customer = emptyCustomer({ id: `export:${key}`, channelId: 'export', channelName: 'Đơn đã xuất', phone: key });
      customers.set(customer.id, customer);
      byPhone.set(key, customer);
    }
    if (!customer.sources.includes('export')) customer.sources.push('export');
    if (!customer.name) customer.name = person.name || '';
    if (!customer.address) customer.address = person.address || '';
    customer.lastExportedAt = Math.max(customer.lastExportedAt || 0, Number(person.lastExportedAt) || 0);
    const fresh = (Array.isArray(person.orders) ? person.orders : []).filter(order => !knownOrderIds.has(bareId(order)) && !notCounted.has(bareId(order)));
    if (!fresh.length) continue;
    customer.orderCount += fresh.length;
    customer.orderTotal += fresh.reduce((sum, order) => sum + (Number(order.total) || 0), 0);
    collectPurchases(customer, fresh.map(order => ({ createdAt: Number(order.orderedAt) || Number(order.exportedAt) || 0, total: order.total, products: order.products })));
    for (const order of fresh) {
      customer.orderIds.push(bareId(order));
      knownOrderIds.add(bareId(order));
    }
  }
}

function foldText(value) {
  return String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D').toLowerCase();
}

/**
 * "2026-09-01" → mốc 00:00 giờ Việt Nam của ngày đó, cộng thêm `plusDays` ngày (máy chủ chạy UTC nên
 * không dùng giờ máy). Chuỗi sai hay ngày không có thật (31/02) trả 0, tức là không lọc theo mốc này.
 */
function vietnamDayStart(value, plusDays = 0) {
  const day = String(value || '').trim();
  return isDayString(day) ? vietnamDayStartMs(shiftDay(day, plusDays)) : 0;
}

/**
 * Bộ lọc cho cả hai việc: quản lý data (tìm kiếm, kênh, nguồn, giới tính, thẻ,
 * tương tác trong N ngày) và remarketing (đã mua trong N ngày hay trong một khoảng
 * ngày, đã mua sản phẩm nào, mua combo mấy túi, mua bao nhiêu đơn).
 * Khoảng ngày mua (`orderedFrom`/`orderedTo`, "YYYY-MM-DD" theo lịch Việt Nam, gồm cả
 * hai đầu) xét ngày MUA LẦN CUỐI — đúng cột "Mua lần cuối" trên bảng, nên khách hiện ra
 * luôn có ngày nằm trong khoảng đã chọn; chỉ có `orderedTo` là "lâu rồi chưa mua lại".
 */
export function filterCustomers(customers, filters = {}, now = Date.now()) {
  const query = foldText(filters.q).trim();
  const activeWithin = Math.max(0, Number(filters.activeWithin) || 0);
  const activeSince = activeWithin ? now - activeWithin * 86400000 : 0;
  const orderedWithin = Math.max(0, Number(filters.orderedWithin) || 0);
  const orderedSince = orderedWithin ? now - orderedWithin * 86400000 : 0;
  // Hai ô ngày chọn ngược (từ 30/09 đến 01/09) thì hiểu là cùng khoảng đó, không trả bảng rỗng.
  const [fromDay, toDay] = [String(filters.orderedFrom || ''), String(filters.orderedTo || '')]
    .sort((first, second) => (first && second ? first.localeCompare(second) : 0));
  const orderedFrom = vietnamDayStart(fromDay);
  const orderedBefore = vietnamDayStart(toDay, 1);
  const product = foldText(filters.product).trim();
  const combo = Math.max(0, Number(filters.combo) || 0);
  const minOrders = Math.max(0, Number(filters.minOrders) || 0);
  const maxOrders = Math.max(0, Number(filters.maxOrders) || 0);
  return customers.filter(customer => {
    if (filters.channelId && customer.channelId !== String(filters.channelId)) return false;
    if (filters.source && !customer.sources.includes(filters.source)) return false;
    // "unknown": chưa rõ giới tính (không đoán được từ tên, chưa ai chọn).
    if (filters.gender && (filters.gender === 'unknown' ? Boolean(customer.gender) : customer.gender !== filters.gender)) return false;
    if (filters.label && !customer.labels.includes(filters.label)) return false;
    if (activeSince && customer.lastMessageAt < activeSince) return false;
    // "Đã chốt đơn trong 7 ngày qua" tính theo ngày lên đơn, không phải ngày nhắn tin.
    if (orderedSince && (!customer.lastOrderAt || customer.lastOrderAt < orderedSince)) return false;
    if ((orderedFrom || orderedBefore) && !customer.lastOrderAt) return false;
    if (orderedFrom && customer.lastOrderAt < orderedFrom) return false;
    if (orderedBefore && customer.lastOrderAt >= orderedBefore) return false;
    if (minOrders && customer.orderCount < minOrders) return false;
    if (maxOrders && customer.orderCount > maxOrders) return false;
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

/**
 * Mọi khách đã mua, đã phủ phần nhân viên tự sửa. Tách riêng khỏi listCustomers
 * để các API sửa thông tin, gắn thẻ, ghi chú và lịch sử đơn tra được một khách
 * theo mã mà không phải đi qua bộ lọc của màn hình.
 */
/**
 * Dựng lại danh sách khách là việc nặng: đọc bốn kho rồi duyệt mọi hội thoại,
 * mọi đơn. Một cú bấm vào hộp chi tiết gọi tới hai, ba lần (tra khách, rồi tra
 * lại sau khi ghi), nên nhớ tạm vài giây để gộp chúng thành một lần. Ngắn thôi:
 * webhook vẫn liên tục thêm đơn mới, giữ lâu là màn hình nói dối.
 */
let buyersCache = { at: 0, promise: null };
const buyersCacheMs = 2000;

/** Gọi sau mỗi lần ghi vào kho ghi đè, để lần tra ngay sau đó thấy bản mới. */
export function invalidateBuyersCache() {
  buyersCache = { at: 0, promise: null };
}

export async function listBuyers({ fresh = false } = {}) {
  const now = Date.now();
  if (!fresh && buyersCache.promise && now - buyersCache.at < buyersCacheMs) return buyersCache.promise;
  const promise = buildBuyerList();
  // Hỏng thì đừng để bản hỏng nằm lại trong bộ nhớ tạm.
  promise.catch(() => invalidateBuyersCache());
  buyersCache = { at: now, promise };
  return promise;
}

async function buildBuyerList() {
  const [store, channels, exported, edits, landingOrders, inbox] = await Promise.all([
    readMessagingStore(), readChannelStore(), listExportedCustomers(), readCustomerEdits(),
    // Kho landing hỏng thì danh sách vẫn dựng được từ hội thoại và tệp xuất kho, chỉ thiếu khách landing.
    listLandingOrders({ includeArchived: true }).catch(error => {
      console.error(`Khách hàng: không đọc được kho đơn landing (${error?.message || error}).`);
      return [];
    }),
    readInboxSettings().catch(() => ({ labels: [] }))
  ]);
  const deliveredLabels = labelsForEvents(inbox?.labels || [], ['delivered']);
  // Người ĐÃ MUA (có đơn tính được): người mới hỏi giá vẫn nằm trong Tin nhắn. Khách đặt qua landing page và
  // khách của đơn đã xuất kho (tệp khách hàng) có mặt kể cả chưa từng nhắn tin. Hộp chi tiết, ghi chú, sửa
  // thông tin tra trên toàn bộ danh sách này; màn Khách hàng chỉ hiện người đã nhận hàng (listCustomers).
  // Page vận hành qua Pancake không có trong kho kênh Meta: thêm tên từ cấu hình Pancake để cột "Trang" hiện
  // tên Page thay vì mã số (kênh Meta cùng mã đứng sau nên thắng).
  const pancakePages = (pancakeConfig.pages?.length ? pancakeConfig.pages : (pancakeConfig.pageId ? [pancakeConfig] : []))
    .map(page => ({ id: String(page.pageId), name: page.pageName || '' }));
  const buyers = buildCustomers(store, [...pancakePages, ...(channels.items || [])], exported, { landingOrders, deliveredLabels })
    .filter(customer => customer.orderCount > 0);
  // Phủ trước khi lọc: nhân viên sửa số điện thoại hay tên xong thì tìm kiếm và
  // bộ lọc phải thấy bản mới, không phải bản suy ra cũ.
  return applyCustomerEdits(buyers, edits);
}

/**
 * Màn Khách hàng (và tệp CSV / remarketing tải từ đó): chỉ khách ĐÃ NHẬN HÀNG — có ít nhất một đơn giao
 * thành công (chủ shop 10/10). Đơn mới đặt, đang giao, bom/hoàn chưa làm ai thành khách hàng.
 */
export async function listCustomers(filters = {}) {
  const customers = (await listBuyers()).filter(customer => customer.received);
  return { total: customers.length, items: filterCustomers(customers, filters) };
}

/** Một khách theo mã, hoặc null nếu mã không còn ứng với ai. */
export async function findCustomerById(id) {
  const key = String(id || '');
  if (!key) return null;
  return (await listBuyers()).find(customer => customer.id === key) || null;
}

const sourceLabels = { inbox: 'Tin nhắn', comment: 'Bình luận', ads: 'Quảng cáo', export: 'Đơn đã xuất', landing: 'Landing page' };
const labelNames = { new: 'Khách mới', consulting: 'Cần tư vấn', customer: 'Đã mua' };
const genderNames = { male: 'Nam', female: 'Nữ' };

const vnTime = new Intl.DateTimeFormat('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh', hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit', year: 'numeric', hour12: false });
function formatTime(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  // Giờ Việt Nam bất kể múi giờ máy chủ (VM chạy UTC): "HH:mm dd/MM/yyyy".
  const part = type => vnTime.formatToParts(date).find(item => item.type === type)?.value || '';
  return `${part('hour')}:${part('minute')} ${part('day')}/${part('month')}/${part('year')}`;
}

/** CSV for Excel: UTF-8 with BOM, semicolon-free, quotes escaped. */
export function customersToCsv(customers, labels = []) {
  const labelNamesById = new Map(labels.map(label => [label.id, label.name]));
  const headers = ['Tên', 'ID Facebook', 'Giới tính', 'Kênh', 'Nguồn', 'Liên hệ lần đầu', 'Khách nhắn cuối', 'Tương tác cuối', 'Số điện thoại', 'Địa chỉ', 'Số đơn', 'Tổng tiền', 'Mua lần cuối', 'Đơn gần nhất gồm', 'Đã mua từ trước tới nay', 'Combo lớn nhất', 'Thẻ', 'Quảng cáo', 'Trạng thái liên hệ', 'Ghi chú gần nhất'];
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
    customer.adTitle,
    // Hai cột nhân viên điền trên màn Khách hàng: trạng thái liên hệ (chưa chọn = "Chưa liên hệ") và ghi chú mới nhất.
    CONTACT_STATUSES[customer.contactStatus] || CONTACT_STATUSES.none,
    customer.lastNote?.text || ''
  ]);
  return `\uFEFF${[headers, ...rows].map(row => row.map(csvCell).join(',')).join('\r\n')}\r\n`;
}

/**
 * \u00D4 CSV cho t\u1EC7p m\u1EDF b\u1EB1ng Excel (c\u00F9ng c\u00E1ch csvCell c\u1EE7a reports.mjs; ch\u00E9p l\u1EA1i \u0111\u1EC3 kh\u00F4ng k\u00E9o c\u1EA3
 * reports.mjs \u2014 chi\u1EBFn d\u1ECBch, b\u00E1m \u0111u\u1ED5i\u2026 \u2014 v\u00E0o module n\u00E0y): t\u00EAn Facebook, \u0111\u1ECBa ch\u1EC9 kh\u00E1ch g\u00F5, t\u00EAn qu\u1EA3ng c\u00E1o do ng\u01B0\u1EDDi
 * ngo\u00E0i ki\u1EC3m so\u00E1t \u2014 ch\u1EEF b\u1EAFt \u0111\u1EA7u b\u1EB1ng = + - @ (hay tab/CR) th\u00EAm ' \u0111\u1EC3 Excel kh\u00F4ng ch\u1EA1y c\u00F4ng
 * th\u1EE9c (v\u00ED d\u1EE5 =HYPERLINK(...)). KH\u00D4NG d\u00F9ng cho audience.csv: Meta kh\u1EDBp `fn` theo ch\u1EEF g\u1ED1c.
 */
function csvCell(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '';
  let text = String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
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
    // R13 (T9): t\u00EAn Facebook do ng\u01B0\u1EDDi ngo\u00E0i \u0111\u1EB7t \u2014 b\u1ECF c\u00E1c k\u00FD t\u1EF1 m\u1EDF c\u00F4ng th\u1EE9c (= + - @, tab, CR) \u1EDF \u0110\u1EA6U t\u00EAn \u0111\u1EC3 t\u1EC7p m\u1EDF
    // b\u1EB1ng Excel kh\u00F4ng ch\u1EA1y c\u00F4ng th\u1EE9c. Kh\u00F4ng th\u00EAm d\u1EA5u ' nh\u01B0 csvCell: Meta kh\u1EDBp `fn` theo ch\u1EEF, d\u1EA5u ' l\u00E0m l\u1EC7ch.
    rows.push([phone, audienceName(customer.name), 'VN']);
  }
  const escape = value => {
    const text = String(value ?? '');
    return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
  };
  return `\uFEFF${[headers, ...rows].map(row => row.map(escape).join(',')).join('\r\n')}\r\n`;
}

/** T\u00EAn cho audience.csv: b\u1ECF chu\u1ED7i k\u00FD t\u1EF1 m\u1EDF c\u00F4ng th\u1EE9c (= + - @, tab, CR, kho\u1EA3ng tr\u1EAFng xen gi\u1EEFa) \u1EDF \u0111\u1EA7u. */
export function audienceName(value) {
  return String(value || '').trim().replace(/^[=+\-@\t\r\s]+/, '').trim();
}

/** R13 (M3): kho\u00E1 kh\u1EED tr\u00F9ng "L\u1ECBch s\u1EED \u0111\u01A1n" c\u1EE7a kh\u00E1ch \u2014 m\u00E3 \u0111\u01A1n b\u1ECF ti\u1EC1n t\u1ED1 ngu\u1ED3n "CB-" / "LP-" (t\u1EC7p kh\u00E1ch h\u00E0ng l\u01B0u k\u00E8m ti\u1EC1n t\u1ED1). */
export function orderHistoryKey(id) {
  return String(id ?? '').trim().replace(/^(CB|LP)-/i, '');
}

/** Nh\u00E3n tr\u1EA1ng th\u00E1i c\u1EE7a m\u1ED9t d\u00F2ng kho l\u01B0u tr\u1EEF \u0111\u01A1n trong "L\u1ECBch s\u1EED \u0111\u01A1n": m\u00E3 n\u1ED9i b\u1ED9 \u2192 ch\u1EEF cho ng\u01B0\u1EDDi \u0111\u1ECDc. */
export function archiveStatusLabel(status) {
  const value = String(status || '').trim();
  if (!value) return '\u0110\u00E3 ghi kho';
  return { deleted: '\u0110\u00E3 xo\u00E1', cancelled: 'H\u1EE7y', confirmed: '\u0110\u00E3 x\u00E1c nh\u1EADn' }[value] || value;
}
