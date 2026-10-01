import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

// Màn Quản lý chiến dịch là HTML/JS thuần, không có bước build: kiểm dây nối trên mã nguồn.
const web = (await readFile(new URL('../web/app.js', import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
const html = (await readFile(new URL('../web/index.html', import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
const section = (source, start, length = 4000) => {
  const at = source.indexOf(start);
  assert.ok(at >= 0, `không tìm thấy: ${start}`);
  return source.slice(at, at + length);
};

test('showView mở màn chiến dịch thì nạp số liệu; Tổng quan không còn gọi thẻ chiến dịch riêng', () => {
  const view = section(web, 'function showView(name)', 1200);
  assert.match(view, /if \(name === 'campaigns'\) loadCampaigns\(\);/);
  assert.doesNotMatch(web, /loadDashboardCampaignCards/, 'Tổng quan đọc /api/dashboard, không gọi /api/campaigns riêng');
});

test('gọi đúng các API chiến dịch; POST gửi JSON cùng nguồn', () => {
  const load = section(web, 'async function loadCampaigns()', 900);
  assert.match(load, /fetch\(`\/api\/campaigns\?days=\$\{campaignsDays\(\)\}`\)/);
  assert.match(load, /requestId !== campaignsRequestId/, 'chặn kết quả cũ đè kết quả mới');

  const sync = section(web, 'async function syncCampaigns()', 1200);
  assert.match(sync, /fetch\('\/api\/campaigns\/sync', \{\s*method: 'POST',\s*headers: \{ 'Content-Type': 'application\/json' \}/);
  assert.match(sync, /credentials: 'same-origin'/);
  assert.match(sync, /JSON\.stringify\(\{ days: campaignsDays\(\) \}\)/);

  assert.match(section(web, 'async function loadCampaignInsights()', 600), /fetch\('\/api\/campaigns\/insights'\)/);
  const analyze = section(web, 'async function analyzeCampaigns()', 1200);
  assert.match(analyze, /fetch\('\/api\/campaigns\/insights', \{\s*method: 'POST',\s*headers: \{ 'Content-Type': 'application\/json' \}/);
  assert.match(analyze, /JSON\.stringify\(\{ days: campaignsDays\(\) \}\)/);});

test('#campaigns-view có chọn khoảng, nút Đồng bộ/AI, bảng tóm tắt, bảng chiến dịch và khung đề xuất AI', () => {
  const view = section(html, '<section id="campaigns-view"', 3000);
  const end = view.indexOf('<section id="orders-view"');
  const markup = end > 0 ? view.slice(0, end) : view;
  assert.match(markup, /<select id="campaigns-range"[\s\S]*value="7"[\s\S]*value="14"[\s\S]*value="30"[\s\S]*value="90"/);
  assert.match(markup, /id="campaigns-sync"/);
  assert.match(markup, /id="campaigns-ai-run"/);
  assert.match(markup, /id="campaigns-summary"/);
  assert.match(markup, /id="campaigns-notice"/);
  assert.match(markup, /class="campaigns-table" id="campaigns-table"/);
  assert.match(markup, /id="campaigns-ai"/);
  assert.match(markup, /id="campaigns-ai-body"/);
});

test('đề xuất AI nhóm theo năm loại với nhãn tiếng Việt và bấm vào thì tìm tới dòng chiến dịch', () => {
  for (const [kind, label] of [['scale', 'Tăng ngân sách'], ['reduce', 'Giảm ngân sách'], ['pause', 'Tạm dừng'], ['creative', 'Đổi nội dung QC'], ['watch', 'Theo dõi']]) {
    assert.match(web, new RegExp(`\\{ kind: '${kind}', label: '${label}' \\}`));
  }
  assert.match(web, /data-campaign-target=/);
  assert.match(section(web, 'function highlightCampaignRow(', 700), /scrollIntoView/);
});

test('bảng tóm tắt thêm cột "Tổng tất cả đơn" từ blended, số gán chiến dịch vẫn là số chính', () => {
  const summary = section(web, 'function renderCampaignsSummary(report)', 3000);
  assert.match(summary, /report\.blended/);
  assert.match(summary, /Tổng tất cả đơn/);
  assert.match(summary, /totals\.cpa === null \|\| totals\.cpa === undefined \? '—'/);
  // CPA null (chiến dịch chỉ có utm) hiện "—"
  assert.match(section(web, 'function campaignRowHtml(', 1600), /campaignMoneyOrDash\(campaign\.cpa\)/);
  assert.match(section(web, 'function campaignMoneyOrDash(', 200), /value === null \|\| value === undefined \? '—'/);
});

test('bấm chiến dịch ở Tổng quan mở màn chiến dịch và tô đúng dòng khi số liệu về', () => {
  assert.match(section(web, 'function openCampaignFromDashboard(', 300), /campaignsPendingHighlight = campaignId[\s\S]*showView\('campaigns'\)/);
  assert.match(section(web, 'function renderCampaignsReport(', 600), /highlightCampaignRow\(target, \{ quiet: true \}\)/);
});
