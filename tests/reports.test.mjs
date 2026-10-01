import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  buildReport, csvCell, followUpSummary, normalizeReportQuery, normalizeReportSection, periodKey, periodLabel,
  periodsBetween, reportCsvFileName, reportSectionCsv
} from '../app/reports.mjs';

// 29/09/2026 10:00 giờ Việt Nam.
const now = Date.parse('2026-09-29T03:00:00Z');
const at = (date, hour = 10) => Date.parse(`${date}T00:00:00Z`) + (hour - 7) * 60 * 60 * 1000;
const order = (id, date, total, extra = {}) => ({
  id, createdAt: at(date), total, status: 'Mới', source: 'Facebook', automatic: true, employee: 'Chatbot AI', phone: '0912345678',
  products: [{ sku: 'GX', name: 'Granola Xanh', quantity: 1, price: total }], ...extra
});

function fixture() {
  const conversations = [
    { id: 'p:a', pageId: 'p', psid: 'a', customerOrders: [
      // Khách A: đơn đầu 20/08 (trước khoảng), quay lại 22/09 và 29/09.
      order('a0', '2026-08-20', 100000, { phone: '0911111111' }),
      order('a1', '2026-09-22', 298000, { phone: '0911111111', products: [{ sku: 'GX', name: 'Granola Xanh', quantity: 2, price: 149000 }] }),
      order('a2', '2026-09-29', 159000, { phone: '0911111111', products: [{ sku: 'GV', name: 'Granola Vàng', quantity: 1, price: 159000 }] })
    ] },
    { id: 'p:b', pageId: 'p', psid: 'b', customerOrders: [
      // Khách B: mới 23/09, nhân viên Lan lên tay; một đơn hủy 24/09.
      order('b1', '2026-09-23', 447000, { phone: '0922222222', automatic: false, employee: 'Lan', products: [
        { sku: 'GX', name: 'Granola Xanh', quantity: 2, price: 149000 }, { sku: 'GV', name: 'Granola Vàng', quantity: 1, price: 149000 }
      ] }),
      order('b2', '2026-09-24', 500000, { phone: '0922222222', processingStatus: 'cancelled', status: 'Hủy', employee: 'Lan', automatic: false })
    ] }
  ];
  const landingOrders = [
    { id: 'l1', createdAt: at('2026-09-29', 8), total: 149000, status: 'Mới', source: 'Landing page', employee: 'Landing page', phone: '0933333333',
      products: [{ sku: 'GX', name: 'Granola Xanh', quantity: 1, price: 149000 }], landing: { campaign: 'utm_campaign=c1' } },
    // Form bỏ dở: không vào đâu cả (kể cả cột hủy).
    { id: 'l2', createdAt: at('2026-09-29', 8), total: 149000, status: 'Chưa hoàn tất', source: 'Landing page', phone: '0944444444', products: [], landing: { incomplete: true } }
  ];
  const adStore = {
    campaigns: { c1: { id: 'c1', name: 'Granola chuyển đổi', status: 'ACTIVE' } },
    ads: { a1: { campaignId: 'c1' } },
    daily: [
      { date: '2026-09-23', campaignId: 'c1', adId: 'a1', spend: 100000 },
      { date: '2026-09-29', campaignId: 'c1', adId: 'a1', spend: 50000 },
      { date: '2026-08-01', campaignId: 'c1', adId: 'a1', spend: 999999 }
    ]
  };
  return { conversations, landingOrders, adStore };
}

test('khoảng báo cáo: mặc định 30 ngày theo ngày; đảo ngược thì đổi chỗ; tối đa 366 ngày', () => {
  assert.deepEqual(normalizeReportQuery({ now }), { from: '2026-08-31', to: '2026-09-29', groupBy: 'day' });
  assert.deepEqual(normalizeReportQuery({ from: '2026-09-29', to: '2026-09-01', groupBy: 'week', now }), { from: '2026-09-01', to: '2026-09-29', groupBy: 'week' });
  assert.deepEqual(normalizeReportQuery({ from: '2024-01-01', to: '2026-09-29', groupBy: 'year', now }), { from: '2025-09-29', to: '2026-09-29', groupBy: 'day' });
  assert.deepEqual(normalizeReportQuery({ to: '2026-06-30', now }), { from: '2026-06-01', to: '2026-06-30', groupBy: 'day' });
  assert.deepEqual(normalizeReportQuery({ from: 'rác', to: '2026-02-31', now }), { from: '2026-08-31', to: '2026-09-29', groupBy: 'day' });
});

test('kỳ: ngày, tuần ISO (thứ Hai), tháng — mã và nhãn tiếng Việt', () => {
  assert.equal(periodKey('2026-09-29', 'day'), '2026-09-29');
  assert.equal(periodKey('2026-09-29', 'week'), '2026-09-28', 'thứ Ba 29/09 → thứ Hai 28/09');
  assert.equal(periodKey('2026-09-27', 'week'), '2026-09-21', 'Chủ nhật thuộc tuần bắt đầu thứ Hai trước đó');
  assert.equal(periodKey('2026-09-29', 'month'), '2026-09');
  assert.equal(periodLabel('2026-09-29', 'day'), '29/09');
  assert.equal(periodLabel('2026-09-22', 'week'), 'Tuần 22/09');
  assert.equal(periodLabel('2026-09', 'month'), 'Tháng 9/2026');
  assert.deepEqual(periodsBetween('2026-09-20', '2026-09-29', 'week'), ['2026-09-14', '2026-09-21', '2026-09-28']);
  assert.deepEqual(periodsBetween('2026-08-30', '2026-10-02', 'month'), ['2026-08', '2026-09', '2026-10']);
});

test('báo cáo theo ngày: doanh số, hủy riêng, chi tiêu/ROAS, nguồn, sản phẩm, khách mới/quay lại, nhân viên, chiến dịch', () => {
  const followUp = { lift: { sent: { n: 40, won: 6 }, holdout: { n: 5, won: 0 } }, wonAmount: 900000 };
  const report = buildReport({ ...fixture(), followUp, from: '2026-09-22', to: '2026-09-29', groupBy: 'day', now });
  assert.deepEqual(report.range, { from: '2026-09-22', to: '2026-09-29', groupBy: 'day' });
  assert.equal(report.sales.rows.length, 8, 'mọi ngày trong khoảng, kể cả ngày trống');
  assert.deepEqual(report.sales.rows[0], { period: '2026-09-22', label: '22/09', orders: 1, revenue: 298000, cancelled: 0, cancelledValue: 0, aov: 298000, spend: 0, adRevenue: 0, roas: null });
  assert.deepEqual(report.sales.rows[1], { period: '2026-09-23', label: '23/09', orders: 1, revenue: 447000, cancelled: 0, cancelledValue: 0, aov: 447000, spend: 100000, adRevenue: 0, roas: 0 });
  assert.deepEqual(report.sales.rows[2], { period: '2026-09-24', label: '24/09', orders: 0, revenue: 0, cancelled: 1, cancelledValue: 500000, aov: null, spend: 0, adRevenue: 0, roas: null });
  assert.deepEqual(report.sales.rows.at(-1), { period: '2026-09-29', label: '29/09', orders: 2, revenue: 308000, cancelled: 0, cancelledValue: 0, aov: 154000, spend: 50000, adRevenue: 149000, roas: 2.98 });
  // ROAS = doanh thu quy về quảng cáo (chỉ l1 theo utm c1) ÷ chi phí — không phải mọi doanh thu ÷ chi phí (trước đây 7,02).
  assert.deepEqual(report.sales.totals, { orders: 4, revenue: 1053000, cancelled: 1, cancelledValue: 500000, aov: 263250, spend: 150000, adRevenue: 149000, roas: 0.99 });
  assert.equal(report.campaignTotals.roas, report.sales.totals.roas, 'Báo cáo và Chiến dịch cùng một ROAS');
  assert.match(report.definitions.roas, /ROAS = doanh thu đơn quy được về quảng cáo Meta/);

  assert.deepEqual(report.sources, [
    { key: 'chatbot', label: 'Chatbot', orders: 2, revenue: 457000, share: 0.434 },
    { key: 'import', label: 'Nhập tay', orders: 1, revenue: 447000, share: 0.4245 },
    { key: 'landing', label: 'Landing page', orders: 1, revenue: 149000, share: 0.1415 }
  ]);
  assert.deepEqual(report.products.map(item => item.sku), ['GX', 'GV']);
  const gx = report.products[0];
  assert.equal(gx.quantity, 5);
  assert.equal(gx.orders, 3);
  assert.equal(report.products.reduce((sum, item) => sum + item.revenue, 0), 1053000, 'doanh thu sản phẩm cộng lại đúng doanh số');

  // A quay lại (đơn đầu 20/08), B và khách landing mới. A có ≥2 đơn: 1/3.
  assert.equal(report.customers.new, 2);
  assert.equal(report.customers.returning, 1);
  assert.equal(report.customers.repeatRate, 0.3333);
  assert.deepEqual(report.customers.rows.find(row => row.period === '2026-09-29'), { period: '2026-09-29', label: '29/09', new: 1, returning: 1 });
  assert.deepEqual(report.customers.rows.find(row => row.period === '2026-09-23'), { period: '2026-09-23', label: '23/09', new: 1, returning: 0 });

  assert.deepEqual(report.staff, [
    { employee: 'Chatbot AI', orders: 2, revenue: 457000 },
    { employee: 'Lan', orders: 1, revenue: 447000 },
    { employee: 'Landing page', orders: 1, revenue: 149000 }
  ]);
  assert.equal(report.campaigns.length, 1);
  assert.equal(report.campaigns[0].id, 'c1');
  assert.equal(report.campaigns[0].orders, 1);
  assert.equal(report.campaigns[0].spend, 150000);
  assert.equal('daily' in report.campaigns[0], false);
  assert.deepEqual(report.followUps, { sent: 40, won: 6, wonAmount: 900000, sentRate: 0.15, holdoutRate: 0 });
});

test('báo cáo theo tuần và tháng: gộp đúng kỳ, khách mới tính theo kỳ của đơn đầu tiên', () => {
  const weekly = buildReport({ ...fixture(), from: '2026-09-22', to: '2026-09-29', groupBy: 'week', now });
  assert.deepEqual(weekly.sales.rows.map(row => [row.period, row.label, row.orders, row.revenue, row.cancelled]), [
    ['2026-09-21', 'Tuần 21/09', 2, 745000, 1],
    ['2026-09-28', 'Tuần 28/09', 2, 308000, 0]
  ]);
  assert.deepEqual(weekly.customers.rows.map(row => [row.period, row.new, row.returning]), [['2026-09-21', 1, 1], ['2026-09-28', 1, 1]]);

  const monthly = buildReport({ ...fixture(), from: '2026-08-01', to: '2026-09-29', groupBy: 'month', now });
  assert.deepEqual(monthly.sales.rows.map(row => [row.label, row.orders, row.revenue, row.spend]), [['Tháng 8/2026', 1, 100000, 999999], ['Tháng 9/2026', 4, 1053000, 150000]]);
  assert.deepEqual(monthly.customers.rows.map(row => [row.period, row.new, row.returning]), [['2026-08', 1, 0], ['2026-09', 2, 1]]);
  assert.equal(monthly.customers.new, 3);
  assert.equal(monthly.customers.returning, 0);
});

test('báo cáo trống: tỷ lệ null, bám đuổi không có số thì null', () => {
  const report = buildReport({ from: '2026-09-01', to: '2026-09-03', now });
  assert.equal(report.sales.rows.length, 3);
  assert.deepEqual(report.sales.totals, { orders: 0, revenue: 0, cancelled: 0, cancelledValue: 0, aov: null, spend: 0, adRevenue: 0, roas: null });
  assert.equal(report.customers.repeatRate, null);
  assert.deepEqual(report.followUps, { sent: 0, won: 0, wonAmount: 0, sentRate: null, holdoutRate: null });
  assert.deepEqual(followUpSummary(null), report.followUps);
});

test('CSV: BOM UTF-8, tiêu đề tiếng Việt, ngoặc kép/xuống dòng được bọc, chặn công thức Excel', () => {
  assert.equal(csvCell('Granola, "Xanh"'), '"Granola, ""Xanh"""');
  assert.equal(csvCell('dòng 1\ndòng 2'), '"dòng 1\ndòng 2"');
  assert.equal(csvCell('=HYPERLINK("x")'), '"\'=HYPERLINK(""x"")"');
  assert.equal(csvCell('-bad'), "'-bad");
  assert.equal(csvCell(-5), '-5');
  assert.equal(csvCell(null), '');

  const report = buildReport({ ...fixture(), from: '2026-09-22', to: '2026-09-29', now });
  report.products.push({ sku: 'X,1', name: 'Tên "lạ"', quantity: 1, revenue: 0, orders: 1 });
  const sales = reportSectionCsv(report, 'sales');
  assert.ok(sales.startsWith('﻿Mã kỳ,Kỳ,Số đơn,Doanh thu,Đơn hủy,Giá trị hủy,Giá trị TB đơn,Chi tiêu QC,Doanh thu từ QC,ROAS\r\n'));
  assert.match(sales, /\r\n2026-09-23,23\/09,1,447000,0,0,447000,100000,0,0\r\n/);
  assert.match(sales, /\r\n,Tổng,4,1053000,1,500000,263250,150000,149000,0\.99\r\n$/);
  const products = reportSectionCsv(report, 'products');
  assert.ok(products.startsWith('﻿SKU,Sản phẩm,Số lượng,Doanh thu,Số đơn\r\n'));
  assert.match(products, /"X,1","Tên ""lạ""",1,0,1\r\n$/);
  assert.match(reportSectionCsv(report, 'sources'), /^﻿Nguồn,Số đơn,Doanh thu,Tỷ trọng doanh thu \(%\)\r\nChatbot,2,457000,43\.4\r\n/);
  assert.match(reportSectionCsv(report, 'staff'), /^﻿Nhân viên,Số đơn,Doanh thu\r\nChatbot AI,2,457000\r\n/);
  assert.match(reportSectionCsv(report, 'campaigns'), /^﻿Chiến dịch,Mã,Nguồn,Trạng thái,Chi tiêu,Hiển thị,Lượt bấm,Tin nhắn,Số đơn,Doanh thu,CPA,ROAS\r\nGranola chuyển đổi,c1,meta,ACTIVE,150000,0,0,0,1,149000,150000,0\.99\r\n$/);
  assert.equal(normalizeReportSection('staff'), 'staff');
  assert.equal(normalizeReportSection('../etc'), 'sales');
  assert.equal(reportCsvFileName('products', report.range), 'bao-cao-products-2026-09-22-2026-09-29.csv');
});

test('máy chủ nối route /api/reports và /api/reports/export.csv', async () => {
  const server = await readFile(new URL('../app/server.mjs', import.meta.url), 'utf8');
  assert.match(server, /import \{ loadReport, normalizeReportSection, reportCsvFileName, reportSectionCsv \} from '\.\/reports\.mjs'/);
  const route = server.slice(server.indexOf("url.pathname === '/api/reports'"), server.indexOf("url.pathname === '/api/reports'") + 1200);
  assert.match(route, /url\.pathname === '\/api\/reports\/export\.csv'/);
  assert.match(route, /loadReport\(\{[\s\S]*searchParams\.get\('from'\)[\s\S]*searchParams\.get\('to'\)[\s\S]*searchParams\.get\('groupBy'\)/);
  assert.match(route, /normalizeReportSection\(url\.searchParams\.get\('section'\)\)/);
  assert.match(route, /'Content-Type': 'text\/csv; charset=utf-8'/);
  assert.match(route, /'Content-Disposition': `attachment; filename="\$\{reportCsvFileName\(section, report\.range\)\}"`/);
  assert.match(route, /response\.end\(reportSectionCsv\(report, section\)\)/);
});
