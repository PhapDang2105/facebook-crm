// Báo cáo: doanh số theo ngày / tuần / tháng, nguồn đơn, sản phẩm, khách mới
// và khách quay lại, nhân viên, chiến dịch, bám đuổi — cho một khoảng from/to
// (giờ Việt Nam, tối đa 366 ngày), kèm xuất CSV từng phần.
//
// Cùng luật với Tổng quan và Chiến dịch (order-facts.mjs): đơn hủy/hoàn và form
// landing bỏ dở không tính doanh thu; đơn hủy đếm riêng ở cột Đơn hủy.
import { buildCampaignReport } from './campaigns.mjs';
import { followUpStatus } from './follow-up.mjs';
import { listLandingOrders } from './landing-orders.mjs';
import { readMessagingStore } from './messaging-store.mjs';
import { adsConnectionStatus, readAdStore, vietnamDay } from './meta-ads.mjs';
import { collectOrderFacts, datesBetween, isValidFact, normalizeDayRange, shiftDay, sourceLabel } from './order-facts.mjs';

export const REPORT_GROUPS = ['day', 'week', 'month'];
export const REPORT_MAX_DAYS = 366;
export const REPORT_DEFAULT_DAYS = 30;
export const REPORT_SECTIONS = ['sales', 'products', 'sources', 'staff', 'campaigns'];

const round = (value, digits = 0) => {
  const factor = 10 ** digits;
  return Math.round((Number(value) || 0) * factor) / factor;
};
const ratio = (numerator, denominator, digits = 4) => (denominator ? round(numerator / denominator, digits) : null);

/**
 * Khoảng báo cáo: from/to hợp lệ thì dùng (đảo ngược thì đổi chỗ, dài quá 366
 * ngày thì cắt phía đầu); thiếu from thì lùi 30 ngày từ to; thiếu to thì hôm nay.
 */
export function normalizeReportQuery({ from, to, groupBy, now = Date.now() } = {}) {
  const today = vietnamDay(now);
  const until = normalizeDayRange(to, to) ? to : today;
  const since = normalizeDayRange(from, from) ? from : shiftDay(until, -(REPORT_DEFAULT_DAYS - 1));
  const range = normalizeDayRange(since, until, { maxDays: REPORT_MAX_DAYS });
  return { from: range.since, to: range.until, groupBy: REPORT_GROUPS.includes(groupBy) ? groupBy : 'day' };
}

/** Thứ Hai của tuần ISO chứa ngày này. */
function weekStart(day) {
  const weekday = new Date(`${day}T00:00:00Z`).getUTCDay(); // 0 = Chủ nhật
  return shiftDay(day, -((weekday + 6) % 7));
}

/** Mã kỳ: 'YYYY-MM-DD' (ngày), thứ Hai đầu tuần ISO (tuần), 'YYYY-MM' (tháng). */
export function periodKey(day, groupBy = 'day') {
  if (groupBy === 'week') return weekStart(day);
  if (groupBy === 'month') return day.slice(0, 7);
  return day;
}

/** Nhãn kỳ: "29/09", "Tuần 22/09", "Tháng 9/2026". */
export function periodLabel(period, groupBy = 'day') {
  if (groupBy === 'month') {
    const [year, month] = period.split('-');
    return `Tháng ${Number(month)}/${year}`;
  }
  const [, month, day] = period.split('-');
  return groupBy === 'week' ? `Tuần ${day}/${month}` : `${day}/${month}`;
}

/** Mọi kỳ chạm vào khoảng [from, to], theo thứ tự thời gian. */
export function periodsBetween(from, to, groupBy = 'day') {
  const keys = [];
  for (const date of datesBetween(from, to)) {
    const key = periodKey(date, groupBy);
    if (keys[keys.length - 1] !== key) keys.push(key);
  }
  return keys;
}

/** Tóm bám đuổi từ followUpStatus(): nhóm được gửi so với nhóm đối chứng (toàn thời gian). */
export function followUpSummary(status = {}) {
  const sent = Number(status?.lift?.sent?.n) || 0;
  const won = Number(status?.lift?.sent?.won) || 0;
  const holdout = Number(status?.lift?.holdout?.n) || 0;
  const holdoutWon = Number(status?.lift?.holdout?.won) || 0;
  return {
    sent,
    won,
    wonAmount: round(status?.wonAmount),
    sentRate: ratio(won, sent),
    holdoutRate: ratio(holdoutWon, holdout)
  };
}

/** Dựng báo cáo. Thuần: mọi dữ liệu truyền vào. */
export function buildReport({
  conversations = [], landingOrders = [], adStore = {}, followUp = null, from, to, groupBy, now = Date.now(), ads = null
} = {}) {
  const query = normalizeReportQuery({ from, to, groupBy, now });
  const inRange = date => date >= query.from && date <= query.to;
  const periods = periodsBetween(query.from, query.to, query.groupBy);
  const blankRow = period => ({
    period, label: periodLabel(period, query.groupBy),
    orders: 0, revenue: 0, cancelled: 0, cancelledValue: 0, spend: 0,
    customers: new Set(), newCustomers: new Set()
  });
  const rows = new Map(periods.map(period => [period, blankRow(period)]));
  const rowOf = date => rows.get(periodKey(date, query.groupBy));

  const facts = collectOrderFacts({ conversations, landingOrders });
  const sources = new Map();
  const products = new Map();
  const staff = new Map();
  const firstOrderDate = new Map();
  const ordersUpToEnd = new Map();
  const customersInRange = new Set();

  for (const fact of facts) {
    if (fact.incomplete || !fact.dateVN) continue;
    if (fact.cancelled) {
      if (inRange(fact.dateVN)) {
        const row = rowOf(fact.dateVN);
        row.cancelled += 1;
        row.cancelledValue += fact.total;
      }
      continue;
    }
    // Đơn hợp lệ (facts xếp cũ trước: lần đầu gặp khách là đơn đầu tiên).
    if (!firstOrderDate.has(fact.customerKey)) firstOrderDate.set(fact.customerKey, fact.dateVN);
    if (fact.dateVN <= query.to) ordersUpToEnd.set(fact.customerKey, (ordersUpToEnd.get(fact.customerKey) || 0) + 1);
    if (!inRange(fact.dateVN)) continue;
    const row = rowOf(fact.dateVN);
    row.orders += 1;
    row.revenue += fact.total;
    row.customers.add(fact.customerKey);
    customersInRange.add(fact.customerKey);

    const source = sources.get(fact.source) || { key: fact.source, label: sourceLabel(fact.source), orders: 0, revenue: 0 };
    source.orders += 1;
    source.revenue += fact.total;
    sources.set(fact.source, source);

    const seenInOrder = new Set();
    for (const line of fact.products) {
      const key = line.sku || line.name;
      const product = products.get(key) || { sku: line.sku, name: line.name, quantity: 0, revenue: 0, orders: 0 };
      product.quantity += line.quantity;
      product.revenue += line.revenue;
      if (!seenInOrder.has(key)) product.orders += 1;
      seenInOrder.add(key);
      products.set(key, product);
    }

    const employee = fact.employee || 'Không rõ';
    const person = staff.get(employee) || { employee, orders: 0, revenue: 0 };
    person.orders += 1;
    person.revenue += fact.total;
    staff.set(employee, person);
  }

  for (const entry of Array.isArray(adStore.daily) ? adStore.daily : []) {
    const date = String(entry?.date || '');
    if (inRange(date)) rowOf(date).spend += Number(entry.spend) || 0;
  }

  // Khách mới / quay lại. Theo kỳ: mới = đơn hợp lệ đầu tiên của khách nằm trong
  // kỳ đó; quay lại = khách có đơn trong kỳ mà đơn đầu tiên ở kỳ trước đó.
  let newTotal = 0;
  let returningTotal = 0;
  let repeaters = 0;
  for (const key of customersInRange) {
    if (firstOrderDate.get(key) >= query.from) newTotal += 1;
    else returningTotal += 1;
    if ((ordersUpToEnd.get(key) || 0) >= 2) repeaters += 1;
  }
  const customerRows = [...rows.values()].map(row => {
    let fresh = 0;
    for (const key of row.customers) if (periodKey(firstOrderDate.get(key), query.groupBy) === row.period) fresh += 1;
    return { period: row.period, label: row.label, new: fresh, returning: row.customers.size - fresh };
  });

  const salesRow = row => ({
    orders: row.orders,
    revenue: round(row.revenue),
    cancelled: row.cancelled,
    cancelledValue: round(row.cancelledValue),
    aov: row.orders ? round(row.revenue / row.orders) : null,
    spend: round(row.spend),
    roas: row.spend ? round(row.revenue / row.spend, 2) : null
  });
  const salesRows = [...rows.values()].map(row => ({ period: row.period, label: row.label, ...salesRow(row) }));
  const totals = salesRow([...rows.values()].reduce((sum, row) => {
    for (const key of ['orders', 'revenue', 'cancelled', 'cancelledValue', 'spend']) sum[key] += row[key];
    return sum;
  }, { orders: 0, revenue: 0, cancelled: 0, cancelledValue: 0, spend: 0 }));

  const campaignReport = buildCampaignReport({ conversations, landingOrders, adStore, from: query.from, to: query.to, now, ads, facts });

  return {
    range: { from: query.from, to: query.to, groupBy: query.groupBy },
    sales: { rows: salesRows, totals },
    sources: [...sources.values()]
      .sort((first, second) => second.revenue - first.revenue || second.orders - first.orders)
      .map(source => ({ ...source, revenue: round(source.revenue), share: ratio(source.revenue, totals.revenue) })),
    products: [...products.values()]
      .sort((first, second) => second.revenue - first.revenue || second.quantity - first.quantity)
      .map(product => ({ ...product, revenue: round(product.revenue) })),
    customers: {
      new: newTotal,
      returning: returningTotal,
      repeatRate: ratio(repeaters, customersInRange.size),
      rows: customerRows
    },
    staff: [...staff.values()]
      .sort((first, second) => second.revenue - first.revenue || second.orders - first.orders)
      .map(person => ({ ...person, revenue: round(person.revenue) })),
    // Dòng chiến dịch như màn Chiến dịch (bỏ mảng theo ngày cho gọn).
    campaigns: campaignReport.campaigns.map(({ daily, ...row }) => row),
    followUps: followUpSummary(followUp)
  };
}

/** Báo cáo trên dữ liệu thật. */
export async function loadReport({ from, to, groupBy, now = Date.now() } = {}) {
  const [store, landingOrders, adStore, followUp] = await Promise.all([
    readMessagingStore(),
    listLandingOrders(),
    readAdStore(),
    followUpStatus().catch(() => null)
  ]);
  const ads = await adsConnectionStatus({ store: adStore });
  return buildReport({ conversations: store.conversations || [], landingOrders, adStore, followUp, from, to, groupBy, now, ads });
}

// ===== CSV =====

/** Ô CSV: bọc ngoặc kép khi có dấu phẩy/ngoặc/xuống dòng; chữ bắt đầu bằng = + - @ thêm ' để Excel không chạy công thức. */
export function csvCell(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '';
  let text = String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export function toCsv(headers, rows) {
  return `﻿${[headers, ...rows].map(row => row.map(csvCell).join(',')).join('\r\n')}\r\n`;
}

const percent = value => (value === null || value === undefined ? '' : round(value * 100, 1));

/** Một phần của báo cáo thành CSV (tiêu đề tiếng Việt). */
export function reportSectionCsv(report, section) {
  switch (section) {
    case 'products':
      return toCsv(['SKU', 'Sản phẩm', 'Số lượng', 'Doanh thu', 'Số đơn'],
        report.products.map(item => [item.sku, item.name, item.quantity, item.revenue, item.orders]));
    case 'sources':
      return toCsv(['Nguồn', 'Số đơn', 'Doanh thu', 'Tỷ trọng doanh thu (%)'],
        report.sources.map(item => [item.label, item.orders, item.revenue, percent(item.share)]));
    case 'staff':
      return toCsv(['Nhân viên', 'Số đơn', 'Doanh thu'],
        report.staff.map(item => [item.employee, item.orders, item.revenue]));
    case 'campaigns':
      return toCsv(['Chiến dịch', 'Mã', 'Nguồn', 'Trạng thái', 'Chi tiêu', 'Hiển thị', 'Lượt bấm', 'Tin nhắn', 'Số đơn', 'Doanh thu', 'CPA', 'ROAS'],
        report.campaigns.map(item => [item.name, item.id, item.source, item.status, item.spend, item.impressions, item.clicks, item.messages, item.orders, item.revenue, item.cpa, item.roas]));
    case 'sales':
    default: {
      const line = (period, label, item) => [period, label, item.orders, item.revenue, item.cancelled, item.cancelledValue, item.aov, item.spend, item.roas];
      return toCsv(['Mã kỳ', 'Kỳ', 'Số đơn', 'Doanh thu', 'Đơn hủy', 'Giá trị hủy', 'Giá trị TB đơn', 'Chi tiêu QC', 'ROAS'],
        [...report.sales.rows.map(item => line(item.period, item.label, item)), line('', 'Tổng', report.sales.totals)]);
    }
  }
}

export function normalizeReportSection(value) {
  return REPORT_SECTIONS.includes(value) ? value : 'sales';
}

export function reportCsvFileName(section, range) {
  return `bao-cao-${section}-${range.from}-${range.to}.csv`;
}
