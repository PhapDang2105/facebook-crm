// Tổng quan: các con số chính của hôm nay / 7 ngày / 30 ngày so với kỳ liền
// trước cùng độ dài, doanh thu theo ngày, nguồn đơn, sản phẩm và chiến dịch
// dẫn đầu, và việc đang chờ nhân viên.
//
// Đọc mỗi kho một lần (hội thoại, đơn landing, số liệu quảng cáo, cài đặt thẻ,
// hàng chờ bám đuổi) rồi tính thuần trong bộ nhớ.
import { buildCampaignReport } from './campaigns.mjs';
import { followUpQueue } from './follow-up.mjs';
import { readInboxSettings } from './inbox-settings.mjs';
import { listLandingOrders } from './landing-orders.mjs';
import { readMessagingStore } from './messaging-store.mjs';
import { adsConnectionStatus, readAdStore, vietnamDay } from './meta-ads.mjs';
import { countNewCustomers, firstOrderDates, METRIC_DEFINITIONS, withAdsFreshness } from './metrics.mjs';
import { collectOrderFacts, datesBetween, DAY_MS, isCancelledOrder, isValidFact, shiftDay, sourceLabel, vietnamDayStartMs } from './order-facts.mjs';
import { processingNotes } from './order-notes.mjs';

export const DASHBOARD_RANGES = [1, 7, 30];
/** Đơn còn mở cũ hơn chừng này ngày không còn tính là việc cần làm. */
export const TODO_WINDOW_DAYS = 30;

export function normalizeDashboardDays(value) {
  const days = Number(value);
  return DASHBOARD_RANGES.includes(days) ? days : 7;
}

const round = (value, digits = 0) => {
  const factor = 10 ** digits;
  return Math.round((Number(value) || 0) * factor) / factor;
};
const ratio = (numerator, denominator, digits = 2) => (denominator ? round(numerator / denominator, digits) : null);

/** Hội thoại tính vào "cuộc trò chuyện": hộp thư (không tính luồng bình luận), không phải chính Page. */
const isChatConversation = conversation => conversation && conversation.source !== 'comment' && conversation.psid !== conversation.pageId;

/** Đếm việc cần làm từ các trường thật đang có trên đơn / hội thoại. */
export function dashboardTodo({ conversations = [], landingOrders = [], labels = [], followUpQueueLength = 0, now = Date.now() } = {}) {
  const cutoff = now - TODO_WINDOW_DAYS * DAY_MS;
  let ordersToReview = 0;
  let ordersIncomplete = 0;
  const visit = order => {
    if (!order || (Number(order.createdAt) || 0) < cutoff) return;
    // Đơn đã chốt (Đã xác nhận / Hủy) hay nhân viên đã ẩn khỏi bảng: không còn việc.
    if (isCancelledOrder(order) || String(order.processingStatus || '') === 'confirmed' || order.hiddenFromTable) return;
    const notes = processingNotes(order);
    if (notes.some(note => note.startsWith('⏳') || note === '⚠ Chưa có địa chỉ' || note === '⚠ Chưa chọn sản phẩm')) ordersIncomplete += 1;
    else if (notes.some(note => note.startsWith('⚠') || note.startsWith('🤖') || note.startsWith('☎'))) ordersToReview += 1;
  };
  for (const conversation of conversations) for (const order of Array.isArray(conversation?.customerOrders) ? conversation.customerOrders : []) visit(order);
  for (const order of landingOrders) visit(order);
  // Thẻ bot gắn khi cần người: sự kiện handoff (mặc định "Cần người xử lý"), khiếu nại, bảo hành.
  const attentionLabels = new Set((labels || []).filter(label => ['handoff', 'complaint', 'warranty'].includes(label?.auto)).map(label => label.id));
  if (!attentionLabels.size) ['consulting', 'complaint', 'warranty'].forEach(id => attentionLabels.add(id));
  const conversationsNeedStaff = conversations.filter(conversation => (Array.isArray(conversation?.labels) ? conversation.labels : []).some(label => attentionLabels.has(label))).length;
  return { ordersToReview, ordersIncomplete, conversationsNeedStaff, followUpQueue: Number(followUpQueueLength) || 0 };
}

/**
 * Dựng Tổng quan. Thuần: mọi dữ liệu truyền vào. `days` = 1 (hôm nay), 7 hay
 * 30 ngày gần nhất tính cả hôm nay, giờ Việt Nam; kỳ trước cùng độ dài liền trước.
 */
export function buildDashboard({
  conversations = [], messages = {}, landingOrders = [], adStore = {}, labels = [], followUpQueueLength = 0,
  days = 7, now = Date.now(), ads = null
} = {}) {
  const span = normalizeDashboardDays(days);
  const until = vietnamDay(now);
  const since = shiftDay(until, -(span - 1));
  const previous = { since: shiftDay(since, -span), until: shiftDay(since, -1) };
  const dates = datesBetween(since, until);
  const period = date => (date >= since && date <= until ? 'current' : date >= previous.since && date <= previous.until ? 'prev' : '');

  const blank = () => ({ revenue: 0, orders: 0, spend: 0, conversations: 0, newCustomers: 0, converted: 0 });
  const stats = { current: blank(), prev: blank() };
  const daily = new Map(dates.map(date => [date, { date, revenue: 0, orders: 0, spend: 0, conversations: 0 }]));

  // Đơn: doanh thu, nguồn, sản phẩm, khách mới.
  const facts = collectOrderFacts({ conversations, landingOrders });
  const sources = new Map();
  const products = new Map();
  const orderedConversations = { current: new Set(), prev: new Set() };
  for (const fact of facts) {
    if (!isValidFact(fact)) continue;
    const bucket = period(fact.dateVN);
    if (!bucket) continue;
    stats[bucket].orders += 1;
    stats[bucket].revenue += fact.total;
    if (fact.conversationId) orderedConversations[bucket].add(fact.conversationId);
    if (bucket !== 'current') continue;
    const day = daily.get(fact.dateVN);
    day.orders += 1;
    day.revenue += fact.total;
    const source = sources.get(fact.source) || { key: fact.source, label: sourceLabel(fact.source), orders: 0, revenue: 0 };
    source.orders += 1;
    source.revenue += fact.total;
    sources.set(fact.source, source);
    for (const line of fact.products) {
      const key = line.sku || line.name;
      const product = products.get(key) || { sku: line.sku, name: line.name, quantity: 0, revenue: 0 };
      product.quantity += line.quantity;
      product.revenue += line.revenue;
      products.set(key, product);
    }
  }
  // Khách mới: cùng định nghĩa với Báo cáo (metrics.mjs).
  const firstDates = firstOrderDates(facts, isValidFact);
  stats.current.newCustomers = countNewCustomers(firstDates, since, until);
  stats.prev.newCustomers = countNewCustomers(firstDates, previous.since, previous.until);

  // Cuộc trò chuyện: hội thoại hộp thư có tin khách trong kỳ.
  const bounds = {
    current: [vietnamDayStartMs(since), vietnamDayStartMs(until) + DAY_MS],
    prev: [vietnamDayStartMs(previous.since), vietnamDayStartMs(previous.until) + DAY_MS]
  };
  // Một lượt duyệt ngược mỗi hội thoại (tin xếp theo giờ tăng dần), dừng khi qua đầu kỳ trước.
  const dailyRows = [...daily.values()];
  for (const conversation of conversations) {
    if (!isChatConversation(conversation)) continue;
    const last = Number(conversation.lastCustomerMessageAt) || 0;
    // Tin khách gần nhất còn trước kỳ trước: không cần duyệt tin.
    if (last && last < bounds.prev[0]) continue;
    const list = messages[conversation.id];
    if (!Array.isArray(list)) continue;
    let inCurrent = false;
    let inPrev = false;
    const seenDays = new Set();
    for (let index = list.length - 1; index >= 0; index -= 1) {
      const message = list[index];
      const at = Number(message?.createdAt) || 0;
      if (at && at < bounds.prev[0]) break;
      if (message?.direction !== 'incoming' || !at) continue;
      if (at >= bounds.current[0] && at < bounds.current[1]) {
        inCurrent = true;
        // Theo ngày: mỗi hội thoại tính một lần mỗi ngày có tin khách.
        const dayIndex = Math.floor((at - bounds.current[0]) / DAY_MS);
        if (!seenDays.has(dayIndex)) {
          seenDays.add(dayIndex);
          dailyRows[dayIndex].conversations += 1;
        }
      } else if (at >= bounds.prev[0] && at < bounds.prev[1]) {
        inPrev = true;
      }
    }
    for (const [bucket, hit] of [['current', inCurrent], ['prev', inPrev]]) {
      if (!hit) continue;
      stats[bucket].conversations += 1;
      if (orderedConversations[bucket].has(conversation.id)) stats[bucket].converted += 1;
    }
  }

  // Chi tiêu quảng cáo.
  for (const entry of Array.isArray(adStore.daily) ? adStore.daily : []) {
    const date = String(entry?.date || '');
    const bucket = period(date);
    if (!bucket) continue;
    const spend = Number(entry.spend) || 0;
    stats[bucket].spend += spend;
    if (bucket === 'current') daily.get(date).spend += spend;
  }

  const campaignReport = buildCampaignReport({ conversations, landingOrders, adStore, from: since, to: until, now, ads, facts });
  // ROAS: một định nghĩa (metrics.mjs) — doanh thu quy về quảng cáo Meta ÷ chi phí Meta,
  // lấy thẳng từ báo cáo chiến dịch của từng kỳ (trước đây: mọi doanh thu ÷ chi phí).
  const previousCampaignReport = buildCampaignReport({ conversations, landingOrders, adStore, from: previous.since, to: previous.until, now, ads, facts });
  const knownCampaigns = adStore.campaigns && typeof adStore.campaigns === 'object' ? Object.values(adStore.campaigns) : [];
  const activeCampaigns = new Set([
    ...knownCampaigns.filter(item => item?.id && String(item.status).toUpperCase() === 'ACTIVE').map(item => String(item.id)),
    ...campaignReport.campaigns.filter(row => row.source === 'meta' && row.spend > 0).map(row => String(row.id))
  ]).size;

  const adsConnected = Boolean(ads?.connected);
  const kpi = pick => ({ value: pick(stats.current), prev: pick(stats.prev) });
  const aov = item => (item.orders ? round(item.revenue / item.orders) : null);
  const freshAds = withAdsFreshness({ connected: adsConnected, syncedAt: ads?.syncedAt ?? adStore.syncedAt ?? null, ...(ads?.error ? { error: ads.error } : {}) }, now);

  return {
    range: { since, until, days: span },
    previous,
    kpis: {
      revenue: kpi(item => round(item.revenue)),
      orders: kpi(item => item.orders),
      aov: kpi(aov),
      // Chưa nối tài khoản quảng cáo: chi tiêu/ROAS không biết (null), không phải 0.
      spend: adsConnected ? kpi(item => round(item.spend)) : { value: null, prev: null },
      roas: adsConnected ? { value: campaignReport.totals.roas, prev: previousCampaignReport.totals.roas } : { value: null, prev: null },
      newCustomers: kpi(item => item.newCustomers),
      conversations: kpi(item => item.conversations),
      conversionRate: kpi(item => ratio(item.converted, item.conversations, 4)),
      activeCampaigns: { value: activeCampaigns }
    },
    daily: [...daily.values()].map(day => ({ ...day, revenue: round(day.revenue), spend: round(day.spend) })),
    sources: [...sources.values()].sort((first, second) => second.revenue - first.revenue || second.orders - first.orders),
    topProducts: [...products.values()].sort((first, second) => second.revenue - first.revenue || second.quantity - first.quantity).slice(0, 5),
    topCampaigns: campaignReport.campaigns
      .filter(row => row.orders || row.spend)
      .sort((first, second) => second.revenue - first.revenue || second.spend - first.spend)
      .slice(0, 5)
      .map(row => ({ id: row.id, name: row.name, source: row.source, spend: row.spend, orders: row.orders, revenue: row.revenue, roas: row.roas })),
    todo: dashboardTodo({ conversations, landingOrders, labels, followUpQueueLength, now }),
    ads: freshAds,
    definitions: METRIC_DEFINITIONS
  };
}

/** Tổng quan trên dữ liệu thật. */
export async function loadDashboard({ days = 7, now = Date.now() } = {}) {
  const [store, landingOrders, adStore, settings, queue] = await Promise.all([
    readMessagingStore(),
    listLandingOrders(),
    readAdStore(),
    readInboxSettings().catch(() => ({ labels: [] })),
    followUpQueue({ now }).catch(() => [])
  ]);
  const ads = await adsConnectionStatus({ store: adStore });
  return buildDashboard({
    conversations: store.conversations || [],
    messages: store.messages || {},
    landingOrders,
    adStore,
    labels: settings.labels || [],
    followUpQueueLength: queue.length,
    days,
    now,
    ads
  });
}
