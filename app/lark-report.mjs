// Gửi báo cáo kinh doanh hằng ngày tới bot tuỳ chỉnh Lark.
//
// Webhook là một bí mật có quyền đăng tin vào nhóm, vì vậy chỉ đọc từ .env và
// không bao giờ đưa vào log / API. Bộ lập lịch ghi ngày đã gửi xuống đĩa để
// restart sau giờ hẹn không gửi trùng; nếu CRM tắt đúng giờ thì lần khởi động
// kế tiếp sẽ gửi bù báo cáo của ngày hôm trước.
import path from 'node:path';
import { projectRoot } from './config.mjs';
import { readJsonFile, writeJsonAtomic } from './json-store.mjs';

export const LARK_REPORT_TIME_ZONE = 'Asia/Ho_Chi_Minh';
export const LARK_REPORT_DEFAULT_TIME = '08:00';
export const LARK_REPORT_RETRY_MS = 5 * 60 * 1000;
export const LARK_REPORT_POLL_MS = 60 * 1000;
export const LARK_CONVERSATION_MAX_LENGTH = 12000;
export const LARK_CONVERSATION_TITLE_MAX_LENGTH = 120;

const pad = value => String(value).padStart(2, '0');

/** Chỉ chấp nhận webhook bot chính thức của Lark, không cho biến này thành SSRF. */
export function normalizeLarkWebhook(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  let url;
  try { url = new URL(text); } catch { throw new Error('URL webhook Lark không hợp lệ.'); }
  if (url.protocol !== 'https:' || url.hostname !== 'open.larksuite.com'
    || !/^\/open-apis\/bot\/v2\/hook\/[A-Za-z0-9_-]+$/.test(url.pathname)
    || url.search || url.hash || url.username || url.password) {
    throw new Error('Webhook phải là URL bot chính thức https://open.larksuite.com/open-apis/bot/v2/hook/…');
  }
  return url.toString();
}

export function normalizeLarkReportTime(value) {
  const match = String(value || '').trim().match(/^([01]\d|2[0-3]):([0-5]\d)$/);
  return match ? `${match[1]}:${match[2]}` : LARK_REPORT_DEFAULT_TIME;
}

export function larkReportConfig(environment = process.env) {
  const webhookUrl = normalizeLarkWebhook(environment.LARK_REPORT_WEBHOOK_URL);
  return {
    enabled: Boolean(webhookUrl) && environment.LARK_REPORT_ENABLED !== '0',
    webhookUrl,
    time: normalizeLarkReportTime(environment.LARK_REPORT_TIME),
    statePath: environment.LARK_REPORT_STATE_PATH
      || path.join(projectRoot, 'data', 'processed', 'lark-report-state.json')
  };
}

function zonedParts(now, timeZone = LARK_REPORT_TIME_ZONE) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
  }).formatToParts(new Date(now));
  const value = type => parts.find(part => part.type === type)?.value || '';
  return {
    day: `${value('year')}-${value('month')}-${value('day')}`,
    time: `${value('hour')}:${value('minute')}`
  };
}

export function previousDay(day) {
  const [year, month, date] = String(day).split('-').map(Number);
  const shifted = new Date(Date.UTC(year, month - 1, date - 1));
  return `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}`;
}

const number = value => new Intl.NumberFormat('vi-VN').format(Number(value) || 0);
const money = value => `${number(Math.round(Number(value) || 0))} ₫`;
const percent = value => value === null || value === undefined ? '—' : `${number(Math.round(Number(value) * 1000) / 10)}%`;
const decimal = value => value === null || value === undefined ? '—' : number(Math.round(Number(value) * 100) / 100);
const displayDay = value => {
  const [year, month, day] = String(value || '').split('-');
  return year && month && day ? `${day}/${month}/${year}` : String(value || '');
};

/** Nội dung gọn, thuần văn bản để hoạt động với mọi bot tuỳ chỉnh Lark. */
export function formatLarkReport(report) {
  const totals = report?.sales?.totals || {};
  const products = (Array.isArray(report?.products) ? report.products : []).slice(0, 3);
  const sources = (Array.isArray(report?.sources) ? report.sources : []).slice(0, 3);
  const lines = [
    `📊 BÁO CÁO KINH DOANH · ${displayDay(report?.range?.from)}`,
    '',
    `✅ Đơn thành công: ${number(totals.orders)}`,
    `💰 Doanh thu: ${money(totals.revenue)}`,
    `🧾 Giá trị đơn trung bình: ${totals.aov === null || totals.aov === undefined ? '—' : money(totals.aov)}`,
    `↩️ Hủy/hoàn: ${number(totals.cancelled)} đơn · ${money(totals.cancelledValue)}`,
    '',
    `📣 Chi phí quảng cáo: ${money(totals.spend)}`,
    `🎯 Doanh thu từ quảng cáo: ${money(totals.adRevenue)}`,
    `📈 ROAS: ${decimal(totals.roas)}`,
    '',
    `👤 Khách mới: ${number(report?.customers?.new)}`,
    `🔁 Khách quay lại: ${number(report?.customers?.returning)}`,
    `♻️ Tỷ lệ mua lại: ${percent(report?.customers?.repeatRate)}`
  ];
  if (products.length) {
    lines.push('', '🏆 Top sản phẩm:');
    for (const [index, item] of products.entries()) {
      lines.push(`${index + 1}. ${item.name || item.sku || 'Không rõ'} · ${number(item.quantity)} sản phẩm · ${money(item.revenue)}`);
    }
  }
  if (sources.length) {
    lines.push('', '🧭 Top nguồn đơn:');
    for (const [index, item] of sources.entries()) {
      lines.push(`${index + 1}. ${item.label || item.key || 'Không rõ'} · ${number(item.orders)} đơn · ${money(item.revenue)}`);
    }
  }
  lines.push('', `CRM tự động gửi lúc ${new Intl.DateTimeFormat('vi-VN', {
    timeZone: LARK_REPORT_TIME_ZONE, hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit', year: 'numeric'
  }).format(new Date())}`);
  return lines.join('\n');
}

export function larkTextPayload(report) {
  return { msg_type: 'text', content: { text: formatLarkReport(report) } };
}

export function normalizeLarkConversationReport({ title, conversation } = {}) {
  const cleanTitle = String(title || '').replace(/\s+/g, ' ').trim();
  const cleanConversation = String(conversation || '').replace(/\r\n?/g, '\n').trim();
  if (!cleanConversation) throw new Error('Hãy dán đoạn hội thoại cần báo cáo.');
  if (cleanTitle.length > LARK_CONVERSATION_TITLE_MAX_LENGTH) {
    throw new Error(`Tiêu đề tối đa ${LARK_CONVERSATION_TITLE_MAX_LENGTH} ký tự.`);
  }
  if (cleanConversation.length > LARK_CONVERSATION_MAX_LENGTH) {
    throw new Error(`Đoạn hội thoại tối đa ${number(LARK_CONVERSATION_MAX_LENGTH)} ký tự.`);
  }
  return { title: cleanTitle, conversation: cleanConversation };
}

/** Đoạn hội thoại do chủ shop dán tay để báo cáo vào nhóm Lark. */
export function formatLarkConversationReport(input, {
  reporter = '', now = Date.now()
} = {}) {
  const { title, conversation } = normalizeLarkConversationReport(input);
  const lines = [
    `📝 BÁO CÁO HỘI THOẠI${title ? ` · ${title}` : ''}`,
    reporter ? `👤 Người gửi: ${String(reporter).replace(/\s+/g, ' ').trim().slice(0, 80)}` : '',
    `🕒 ${new Intl.DateTimeFormat('vi-VN', {
      timeZone: LARK_REPORT_TIME_ZONE, hour: '2-digit', minute: '2-digit',
      day: '2-digit', month: '2-digit', year: 'numeric'
    }).format(new Date(now))}`,
    '',
    '────────────────────',
    conversation
  ];
  return lines.filter((line, index) => line || index >= 3).join('\n');
}

export function larkConversationPayload(input, options) {
  return { msg_type: 'text', content: { text: formatLarkConversationReport(input, options) } };
}

async function postLarkPayload(payload, {
  webhookUrl, fetchImpl = fetch, timeoutMs = 10000
} = {}) {
  const url = normalizeLarkWebhook(webhookUrl);
  if (!url) throw new Error('Chưa cấu hình LARK_REPORT_WEBHOOK_URL.');
  const response = await fetchImpl(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(timeoutMs)
  });
  const body = await response.json().catch(() => ({}));
  const code = body.code ?? body.StatusCode ?? body.status_code;
  if (!response.ok || (code !== undefined && Number(code) !== 0)) {
    throw new Error(`Lark từ chối báo cáo (HTTP ${response.status}${code !== undefined ? `, mã ${code}` : ''}).`);
  }
  return { ok: true };
}

/** Gửi một báo cáo; chỉ thành công khi cả HTTP và mã kết quả của Lark đều thành công. */
export async function sendLarkReport(report, {
  webhookUrl, fetchImpl = fetch, timeoutMs = 10000
} = {}) {
  return postLarkPayload(larkTextPayload(report), { webhookUrl, fetchImpl, timeoutMs });
}

export async function sendLarkConversationReport(input, {
  reporter = '', now = Date.now(), webhookUrl, fetchImpl = fetch, timeoutMs = 10000
} = {}) {
  return postLarkPayload(larkConversationPayload(input, { reporter, now }), { webhookUrl, fetchImpl, timeoutMs });
}

const defaultReadState = statePath => readJsonFile(statePath, {
  fallback: () => ({ lastSentDay: '', sentAt: 0 }),
  label: 'Trạng thái báo cáo Lark'
});

/**
 * Bộ lập lịch có dependency injection để kiểm thử mà không đụng dữ liệu/webhook thật.
 * tick() trả sent/already-sent/not-time/retry-wait/disabled/in-flight.
 */
export function createLarkReportScheduler({
  config = larkReportConfig(), loadReport, send = sendLarkReport,
  readState = defaultReadState, writeState = writeJsonAtomic,
  now = () => Date.now(), setIntervalImpl = setInterval
} = {}) {
  let timer = null;
  let inFlight = null;
  let retryNotBefore = 0;

  async function runTick(at = now()) {
    if (!config.enabled) return { status: 'disabled' };
    if (inFlight) return { status: 'in-flight' };
    const local = zonedParts(at);
    if (local.time < config.time) return { status: 'not-time' };
    if (at < retryNotBefore) return { status: 'retry-wait' };
    const reportDay = previousDay(local.day);
    inFlight = (async () => {
      // Khoá trước cả lượt đọc trạng thái: nếu một lần đọc/tạo báo cáo kéo dài qua
      // nhịp kế tiếp thì không có hai lượt cùng thấy "chưa gửi" rồi gửi trùng.
      const state = await readState(config.statePath);
      if (state?.lastSentDay === reportDay) return { status: 'already-sent', reportDay };
      const report = await loadReport({ from: reportDay, to: reportDay, groupBy: 'day', now: at });
      await send(report, { webhookUrl: config.webhookUrl });
      await writeState(config.statePath, { lastSentDay: reportDay, sentAt: at });
      retryNotBefore = 0;
      return { status: 'sent', reportDay };
    })();
    try {
      return await inFlight;
    } catch (error) {
      retryNotBefore = at + LARK_REPORT_RETRY_MS;
      throw error;
    } finally {
      inFlight = null;
    }
  }

  function start() {
    if (!config.enabled || timer) return { enabled: config.enabled, time: config.time };
    const tick = () => runTick().then(result => {
      if (result.status === 'sent') console.log(`Báo cáo Lark ngày ${result.reportDay}: đã gửi.`);
    }).catch(error => console.warn(`Gửi báo cáo Lark lỗi, sẽ thử lại: ${error.message}`));
    setImmediate(tick);
    timer = setIntervalImpl(tick, LARK_REPORT_POLL_MS);
    timer?.unref?.();
    return { enabled: true, time: config.time };
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  return { config, runTick, start, stop };
}

export function startLarkReportScheduler(options = {}) {
  const scheduler = createLarkReportScheduler(options);
  const status = scheduler.start();
  if (status.enabled) console.log(`Báo cáo Lark: bật, gửi báo cáo ngày hôm trước lúc ${status.time} (giờ Việt Nam).`);
  return scheduler;
}
