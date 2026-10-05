// Cố vấn AI cho màn Quản lý chiến dịch (giai đoạn 1): đọc báo cáo hiệu quả
// chiến dịch (GET /api/campaigns) và hỏi mô hình đang cấu hình cho chatbot
// (Cài đặt → Chatbot: Vertex/Gemini, Anthropic, OpenAI-compatible…) vài lời
// khuyên cụ thể, thận trọng. CHỈ khuyên — module này không bao giờ gọi API
// quảng cáo hay đổi gì trong tài khoản.
//
// Lời khuyên được neo bằng luật tất định: chi nhiều mà 0 đơn → ứng viên tạm
// dừng; ROAS cao hơn hẳn trung bình và đều → ứng viên tăng ngân sách; ít dữ
// liệu → chỉ theo dõi. Các cờ này gửi kèm prompt, và câu trả lời của mô hình
// được kiểm lại theo chính các cờ đó. Mô hình lỗi/trả JSON hỏng thì dùng luật.
// Chỉ gửi số tổng hợp theo chiến dịch — không có dữ liệu khách hàng.
import path from 'node:path';
import { projectRoot } from './config.mjs';
import { readJsonFile, writeJsonAtomic } from './json-store.mjs';
import { readChatbotSettings } from './chatbot-settings.mjs';
import { assertPublicHost } from './network-guard.mjs';
import { getVertexAccessToken, vertexProjectId } from './vertex-auth.mjs';

export const actionKinds = Object.freeze(['scale', 'reduce', 'pause', 'creative', 'watch']);
export const confidenceLevels = Object.freeze(['cao', 'vừa', 'thấp']);

// Ngưỡng luật (VND). Shop nhỏ bán đồ ăn (granola…), đơn trung bình vài trăm nghìn.
export const campaignAiThresholds = Object.freeze({
  maxCampaigns: 30,            // chỉ gửi ~30 chiến dịch chi nhiều nhất
  minSpendToJudge: 200000,     // chi dưới 200k: quá ít để kết luận
  minActiveDays: 3,            // chạy dưới 3 ngày có chi tiêu: quá ít để kết luận
  pauseSpendFloor: 500000,     // chi ≥ max(500k, 2 × CPA tài khoản) mà 0 đơn → ứng viên tạm dừng
  pauseCpaMultiple: 2,
  reduceCpaMultiple: 2,        // CPA ≥ 2 × CPA tài khoản (có đơn) → ứng viên giảm ngân sách
  scaleRoasMultiple: 1.5,      // ROAS ≥ 1.5 × ROAS tài khoản…
  scaleMinRoas: 2,             // …và ≥ 2 tuyệt đối…
  scaleMinOrders: 3,           // …có ≥ 3 đơn, đơn rải trên ≥ 2 ngày, nửa sau không tụt dưới 70% nửa đầu
  scaleStability: 0.7,
  maxDailyInPrompt: 14,        // gửi tối đa 14 ngày gần nhất mỗi chiến dịch
  keepRuns: 20
});

const modelTimeoutMs = 60000;

function insightsPath(options = {}) {
  return options.path || process.env.CAMPAIGN_AI_PATH || path.join(projectRoot, 'data', 'processed', 'campaign-ai.json');
}

// ===== Cấu hình mô hình: dùng chung cài đặt chatbot =====

// Mặc định đọc cùng tệp cài đặt chatbot bằng bộ đọc chung (chatbot-settings.mjs: CHATBOT_SETTINGS_PATH, lỗi đọc thật
// thì ném thay vì coi là mặc định). server.mjs truyền đúng bộ đọc của nó qua configureCampaignAi.
let dependencies = { readSettings: () => readChatbotSettings(), fetchImpl: fetch };

/** Tuỳ chọn: server.mjs có thể truyền readChatbotSettings của nó; không truyền thì module tự đọc tệp cài đặt. */
export function configureCampaignAi(overrides = {}) {
  dependencies = { ...dependencies, ...overrides };
}

// ===== Luật tất định =====

const number = value => (Number.isFinite(Number(value)) ? Number(value) : 0);
const round = (value, digits = 0) => {
  const factor = 10 ** digits;
  return Math.round(number(value) * factor) / factor;
};

function ratio(numerator, denominator) {
  return denominator > 0 ? numerator / denominator : 0;
}

/** Số liệu tài khoản dùng làm mốc so sánh (ROAS/CPA trung bình trên phần có chi tiêu). */
export function accountBaseline(report = {}) {
  const totals = report.totals || {};
  const spend = number(totals.spend);
  const orders = number(totals.orders);
  const revenue = number(totals.revenue);
  return {
    spend,
    orders,
    revenue,
    roas: number(totals.roas) || ratio(revenue, spend),
    cpa: number(totals.cpa) || ratio(spend, orders)
  };
}

function dailyStats(daily = []) {
  const rows = (Array.isArray(daily) ? daily : [])
    .map(row => ({ date: String(row?.date || ''), spend: number(row?.spend), orders: number(row?.orders), revenue: number(row?.revenue) }))
    .sort((a, b) => a.date.localeCompare(b.date));
  const active = rows.filter(row => row.spend > 0);
  const orderDays = rows.filter(row => row.orders > 0).length;
  const half = Math.floor(active.length / 2);
  const first = active.slice(0, half);
  const second = active.slice(active.length - half);
  const sum = (list, key) => list.reduce((total, row) => total + row[key], 0);
  const firstRoas = ratio(sum(first, 'revenue'), sum(first, 'spend'));
  const secondRoas = ratio(sum(second, 'revenue'), sum(second, 'spend'));
  return { rows, activeDays: active.length, orderDays, firstRoas, secondRoas };
}

/**
 * Cờ luật cho một chiến dịch. `suggestion` là loại hành động luật đề xuất
 * (null = không có gì để nói), `judgeable` = đủ dữ liệu để mô hình được kết luận.
 */
export function campaignFlags(campaign = {}, baseline = {}, thresholds = campaignAiThresholds) {
  const result = spendFlags(campaign, baseline, thresholds);
  // R13 (T-3): "tạm dừng / tăng / giảm ngân sách" chỉ có nghĩa với MỘT chiến dịch Meta thật đang chạy. Trước đây luật
  // khuyên "tạm dừng" chiến dịch đã PAUSED và cả dòng gộp ("chưa rõ chiến dịch", dòng theo tên, dòng utm).
  if (BUDGET_KINDS.has(result.suggestion)) {
    const blocked = !isRealMetaCampaign(campaign) ? 'khong-phai-chien-dich-meta' : !campaignIsRunning(campaign) ? 'da-dung' : '';
    if (blocked) return { ...result, flags: [...result.flags, blocked], suggestion: null, reason: '' };
  }
  return result;
}

const BUDGET_KINDS = new Set(['pause', 'scale', 'reduce']);

/** Dòng báo cáo là MỘT chiến dịch Meta thật (có mã chiến dịch để vào Trình quản lý quảng cáo dừng / đổi ngân sách)? */
export function isRealMetaCampaign(campaign = {}) {
  const id = String(campaign?.id ?? '').trim();
  if (!id || id === 'meta:unknown' || /^(name|utm):/i.test(id)) return false;
  return !campaign.source || campaign.source === 'meta';
}

/** Chiến dịch đang chạy? Trạng thái trống (kho chưa có) = chưa biết → không chặn lời khuyên. */
export function campaignIsRunning(campaign = {}) {
  const status = String(campaign?.status || '').trim().toUpperCase();
  return !status || status === 'ACTIVE';
}

function spendFlags(campaign = {}, baseline = {}, thresholds = campaignAiThresholds) {
  const spend = number(campaign.spend);
  const orders = number(campaign.orders);
  const revenue = number(campaign.revenue);
  const roas = number(campaign.roas) || ratio(revenue, spend);
  const cpa = number(campaign.cpa) || ratio(spend, orders);
  const stats = dailyStats(campaign.daily);
  const flags = [];
  let suggestion = null;
  let reason = '';

  if (spend <= 0) {
    // Chiến dịch chỉ có UTM (không có số chi tiêu) hoặc chưa chạy: không có gì để đánh giá chi phí.
    flags.push('khong-co-chi-tieu');
    return { id: String(campaign.id), flags, suggestion, reason, judgeable: false, activeDays: stats.activeDays };
  }

  const pauseSpend = Math.max(thresholds.pauseSpendFloor, thresholds.pauseCpaMultiple * number(baseline.cpa));
  if (orders === 0 && spend >= pauseSpend) {
    flags.push('chi-nhieu-0-don');
    suggestion = 'pause';
    reason = `Đã chi ${formatVnd(spend)} mà chưa có đơn nào (ngưỡng ${formatVnd(pauseSpend)}).`;
    return { id: String(campaign.id), flags, suggestion, reason, judgeable: true, activeDays: stats.activeDays };
  }

  const tooLittle = spend < thresholds.minSpendToJudge || (stats.rows.length > 0 && stats.activeDays < thresholds.minActiveDays);
  if (tooLittle) {
    flags.push('it-du-lieu');
    suggestion = 'watch';
    reason = `Mới chi ${formatVnd(spend)} trong ${stats.activeDays || '?'} ngày — chưa đủ dữ liệu để kết luận.`;
    return { id: String(campaign.id), flags, suggestion, reason, judgeable: false, activeDays: stats.activeDays };
  }

  const baseRoas = number(baseline.roas);
  const baseCpa = number(baseline.cpa);
  const stable = stats.orderDays >= 2 && (stats.firstRoas === 0 || stats.secondRoas >= thresholds.scaleStability * stats.firstRoas);
  if (roas >= thresholds.scaleMinRoas && roas >= thresholds.scaleRoasMultiple * baseRoas && orders >= thresholds.scaleMinOrders) {
    if (stable) {
      flags.push('roas-cao-on-dinh');
      suggestion = 'scale';
      reason = `ROAS ${round(roas, 2)} so với trung bình ${round(baseRoas, 2)}, ${orders} đơn rải đều nhiều ngày.`;
    } else {
      flags.push('roas-cao-chua-on-dinh');
    }
  } else if (orders > 0 && baseCpa > 0 && cpa >= thresholds.reduceCpaMultiple * baseCpa) {
    flags.push('cpa-cao');
    suggestion = 'reduce';
    reason = `CPA ${formatVnd(cpa)} gấp ${round(cpa / baseCpa, 1)} lần trung bình (${formatVnd(baseCpa)}).`;
  }
  if (stats.secondRoas > 0 && stats.firstRoas > 0 && stats.secondRoas < 0.5 * stats.firstRoas) flags.push('roas-dang-giam');
  return { id: String(campaign.id), flags, suggestion, reason, judgeable: true, activeDays: stats.activeDays };
}

function formatVnd(value) {
  return `${Math.round(number(value)).toLocaleString('vi-VN')}đ`;
}

/** ~30 chiến dịch chi nhiều nhất (hoà thì nhiều doanh thu hơn trước). */
export function selectCampaigns(report = {}, limit = campaignAiThresholds.maxCampaigns) {
  const list = Array.isArray(report.campaigns) ? report.campaigns.filter(item => item && item.id !== undefined && item.id !== null && item.id !== '') : [];
  return [...list]
    .sort((a, b) => number(b.spend) - number(a.spend) || number(b.revenue) - number(a.revenue))
    .slice(0, limit);
}

const ruleConfidence = { pause: 'vừa', scale: 'vừa', reduce: 'vừa', watch: 'thấp', creative: 'thấp' };

/** Hành động chỉ theo luật — dùng khi không có AI, và làm "gợi ý của luật" trong prompt. */
export function ruleBasedActions(report = {}, thresholds = campaignAiThresholds) {
  const baseline = accountBaseline(report);
  const actions = [];
  for (const campaign of selectCampaigns(report, thresholds.maxCampaigns)) {
    const flag = campaignFlags(campaign, baseline, thresholds);
    if (!flag.suggestion) continue;
    actions.push({
      campaignId: String(campaign.id),
      campaignName: String(campaign.name || ''),
      kind: flag.suggestion,
      reason: flag.reason,
      confidence: ruleConfidence[flag.suggestion] || 'thấp'
    });
  }
  const order = { pause: 0, reduce: 1, scale: 2, creative: 3, watch: 4 };
  return actions.sort((a, b) => order[a.kind] - order[b.kind]);
}

// ===== Prompt =====

export const campaignAiSystemPrompt = [
  'Bạn là chuyên viên quảng cáo Facebook cẩn trọng, cố vấn cho Giọt Nắng — shop nhỏ bán đồ ăn (granola, hạt, đồ ăn vặt lành mạnh) qua Facebook Messenger và landing page. Tiền tệ là VND.',
  'Bạn nhận số liệu tổng hợp theo chiến dịch trong một khoảng ngày: chi tiêu, hiển thị, click, tin nhắn, đơn, doanh thu, CPA (chi/đơn), ROAS (doanh thu/chi), số theo ngày, và CỜ do hệ thống tính sẵn bằng luật.',
  'Nhiệm vụ: đưa ra ít lời khuyên cụ thể, thận trọng, có căn cứ số liệu. Các loại hành động: "scale" (tăng ngân sách từ từ, 15–20%), "reduce" (giảm ngân sách), "pause" (tạm dừng), "creative" (đổi nội dung/ảnh/video, tệp khách), "watch" (chưa làm gì, theo dõi thêm).',
  'Quy tắc: chiến dịch có cờ "it-du-lieu" hoặc "khong-co-chi-tieu" thì KHÔNG được kết luận — chỉ được "watch" hoặc bỏ qua. Không đề xuất "scale" cho chiến dịch chưa có đơn. Chiến dịch có trangThai khác ACTIVE (đã dừng, đã lưu trữ) hoặc có cờ "da-dung" / "khong-phai-chien-dich-meta" thì KHÔNG đề xuất "pause", "scale", "reduce". Chỉ dùng campaignId có trong dữ liệu. Không bịa số. Đơn có thể về chậm vài ngày nên đừng vội. Nhiều tin nhắn mà ít đơn gợi ý vấn đề chốt đơn/giá/ưu đãi hơn là quảng cáo. Tối đa 10 hành động, ưu tiên thứ tốn tiền nhất.',
  'Nếu có "thiTruong" (ưu đãi đối thủ hay dùng, quảng cáo đối thủ chạy lâu, bài hợp tác KOL): chỉ dùng nó để gợi ý "creative" cụ thể hơn (góc nội dung, ưu đãi nên thử); KHÔNG dùng nó làm căn cứ tăng/giảm/tạm dừng ngân sách, không chép nguyên văn quảng cáo đối thủ.',
  'Trả về DUY NHẤT một JSON, không markdown:',
  '{"summary":"2–4 câu tiếng Việt tóm tắt tình hình và việc nên làm trước","actions":[{"campaignId":"id đúng như dữ liệu","kind":"scale|reduce|pause|creative|watch","reason":"một–hai câu, có số liệu","confidence":"cao|vừa|thấp"}]}'
].join('\n');

export function buildCampaignPrompt(report = {}, { days, thresholds = campaignAiThresholds, market = null } = {}) {
  const baseline = accountBaseline(report);
  const campaigns = selectCampaigns(report, thresholds.maxCampaigns);
  const range = report.range || {};
  const totals = report.totals || {};
  const payload = {
    khoangNgay: { tu: range.since || '', den: range.until || '', soNgay: number(days ?? range.days) || undefined },
    taiKhoan: {
      chi: round(totals.spend), hienThi: round(totals.impressions), click: round(totals.clicks), tinNhan: round(totals.messages),
      don: round(totals.orders), doanhThu: round(totals.revenue), cpa: round(baseline.cpa), roas: round(baseline.roas, 2)
    },
    donKhongGanChienDich: { don: round(report.unattributed?.orders), doanhThu: round(report.unattributed?.revenue) },
    // Đơn landing gắn UTM không khớp chiến dịch Meta nào: không có chi phí tương ứng, không nằm trong ROAS tài khoản.
    donUtmKhongCoChiPhi: { don: round(report.utm?.orders), doanhThu: round(report.utm?.revenue) },
    tongSoChienDich: Array.isArray(report.campaigns) ? report.campaigns.length : 0,
    chienDich: campaigns.map(campaign => {
      const flag = campaignFlags(campaign, baseline, thresholds);
      const stats = dailyStats(campaign.daily);
      return {
        campaignId: String(campaign.id),
        ten: String(campaign.name || '').slice(0, 120),
        trangThai: campaign.status || '',
        nguon: campaign.source || '',
        // null = chưa biết ngân sách (không phải 0đ); "nhom" = ngân sách đặt ở nhóm quảng cáo (cộng các nhóm đang chạy).
        nganSachNgay: campaign.dailyBudget === null || campaign.dailyBudget === undefined ? null : round(campaign.dailyBudget),
        ...(campaign.budgetLevel === 'adset' ? { nganSachO: 'nhom' } : {}),
        chi: round(campaign.spend), hienThi: round(campaign.impressions), click: round(campaign.clicks), clickLienKet: round(campaign.linkClicks), tinNhan: round(campaign.messages), tinNhanKhachMoi: round(campaign.newMessages),
        don: round(campaign.orders), doanhThu: round(campaign.revenue), cpa: round(campaign.cpa), roas: round(campaign.roas, 2),
        soNgayCoChi: flag.activeDays,
        co: flag.flags,
        goiYLuat: flag.suggestion ? `${flag.suggestion}: ${flag.reason}` : '',
        // [ngày, chi, đơn, doanh thu] — chỉ các ngày gần nhất
        theoNgay: stats.rows.slice(-thresholds.maxDailyInPrompt).map(row => [row.date, round(row.spend), row.orders, round(row.revenue)])
      };
    }),
    // Tóm tắt đối thủ (ad-library.mjs → marketBrief): chỉ để gợi ý "creative".
    ...(market ? { thiTruong: market } : {})
  };
  return `Số liệu chiến dịch (JSON):\n${JSON.stringify(payload)}`;
}

// ===== Đọc & kiểm câu trả lời =====

export function parseInsightsAnswer(answer) {
  const raw = String(answer || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const parsed = JSON.parse(raw.slice(start, end + 1));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

const kindAliases = {
  scale: 'scale', increase: 'scale', 'tang': 'scale', 'tăng': 'scale',
  reduce: 'reduce', decrease: 'reduce', 'giam': 'reduce', 'giảm': 'reduce',
  pause: 'pause', stop: 'pause', 'dung': 'pause', 'dừng': 'pause', 'tạm dừng': 'pause',
  creative: 'creative', 'noi dung': 'creative', 'nội dung': 'creative',
  watch: 'watch', monitor: 'watch', 'theo dõi': 'watch'
};

export function clampKind(kind) {
  const key = String(kind || '').trim().toLowerCase();
  return kindAliases[key] || 'watch';
}

export function clampConfidence(value) {
  const key = String(value || '').trim().toLowerCase();
  if (confidenceLevels.includes(key)) return key;
  if (['high', 'cao'].includes(key)) return 'cao';
  if (['medium', 'mid', 'vua', 'trung bình'].includes(key)) return 'vừa';
  return 'thấp';
}

/**
 * Kiểm câu trả lời của mô hình theo dữ liệu thật: bỏ campaignId lạ, kẹp kind
 * và confidence vào enum, và không cho mô hình kết luận chiến dịch ít dữ liệu
 * hay "scale" chiến dịch chưa có đơn (hạ về "watch", độ tin "thấp").
 * Trả null nếu câu trả lời không dùng được.
 */
export function validateInsights(parsed, report = {}, thresholds = campaignAiThresholds) {
  if (!parsed || typeof parsed !== 'object') return null;
  const actionsIn = Array.isArray(parsed.actions) ? parsed.actions : null;
  const summary = String(parsed.summary || '').trim();
  if (!actionsIn && !summary) return null;
  const baseline = accountBaseline(report);
  const known = new Map(selectCampaigns(report, thresholds.maxCampaigns).map(campaign => [String(campaign.id), campaign]));
  const seen = new Set();
  const actions = [];
  for (const item of actionsIn || []) {
    if (!item || typeof item !== 'object') continue;
    const id = String(item.campaignId ?? '').trim();
    const campaign = known.get(id);
    if (!campaign) continue;
    let kind = clampKind(item.kind);
    let confidence = clampConfidence(item.confidence);
    const flag = campaignFlags(campaign, baseline, thresholds);
    if (!flag.judgeable && kind !== 'watch') { kind = 'watch'; confidence = 'thấp'; }
    if (kind === 'scale' && number(campaign.orders) === 0) { kind = 'watch'; confidence = 'thấp'; }
    // R13 (T-3): không "tạm dừng / tăng / giảm" chiến dịch đã dừng hay dòng không phải một chiến dịch Meta thật.
    if (BUDGET_KINDS.has(kind) && (!isRealMetaCampaign(campaign) || !campaignIsRunning(campaign))) { kind = 'watch'; confidence = 'thấp'; }
    const key = `${id}|${kind}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const reason = String(item.reason || '').trim().slice(0, 400) || flag.reason || '';
    actions.push({ campaignId: id, campaignName: String(campaign.name || ''), kind, reason, confidence });
    if (actions.length >= 15) break;
  }
  return { summary: summary.slice(0, 1200), actions };
}

// ===== Gọi mô hình (cùng giao thức với chatbot-engine) =====

function modelEndpoint(settings, model) {
  const configured = String(settings.directEndpoint || '');
  if (settings.provider !== 'vertex') return configured;
  return (configured.includes('PROJECT_ID') ? configured.replace('PROJECT_ID', encodeURIComponent(vertexProjectId())) : configured)
    .replace(/\/models\/[^/:]+:generateContent(?:\?.*)?$/, `/models/${encodeURIComponent(model)}:generateContent`);
}

// Lỗi tạm thời của nhà cung cấp (Vertex 429 "Resource exhausted" giờ cao điểm,
// 5xx, rớt mạng): thử lại vài lần, lùi dần. Lỗi cấu hình (4xx khác, thiếu khoá,
// JSON hỏng) thì không thử lại.
export const modelRetry = Object.freeze({ retries: 2, baseDelayMs: 1500, maxDelayMs: 10000 });

export function isRetryableStatus(status) {
  const code = Number(status);
  return code === 408 || code === 429 || (code >= 500 && code <= 599 && code !== 501);
}

/** Thời gian chờ trước lần thử thứ `attempt` (1, 2…): Retry-After nếu có, không thì lùi gấp đôi. */
export function retryDelayMs(attempt, { retryAfter = null, baseDelayMs = modelRetry.baseDelayMs, maxDelayMs = modelRetry.maxDelayMs } = {}) {
  const seconds = Number(retryAfter);
  if (retryAfter !== null && retryAfter !== '' && Number.isFinite(seconds) && seconds >= 0) return Math.min(maxDelayMs, seconds * 1000);
  return Math.min(maxDelayMs, baseDelayMs * 2 ** Math.max(0, attempt - 1));
}

const defaultSleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/** Một lượt hỏi–đáp JSON với nhà cung cấp đang cấu hình ở Cài đặt chatbot, thử lại khi lỗi tạm thời. Trả về chữ mô hình viết. */
export async function requestModelText({ retries = modelRetry.retries, baseDelayMs = modelRetry.baseDelayMs, maxDelayMs = modelRetry.maxDelayMs, sleep = defaultSleep, ...input }) {
  let attempt = 0;
  for (;;) {
    try {
      return await requestModelTextOnce(input);
    } catch (error) {
      attempt += 1;
      if (!error?.retryable || attempt > Math.max(0, Number(retries) || 0)) throw error;
      await sleep(retryDelayMs(attempt, { retryAfter: error.retryAfter ?? null, baseDelayMs, maxDelayMs }));
    }
  }
}

async function requestModelTextOnce({ system, prompt, settings, fetchImpl = dependencies.fetchImpl, timeoutMs = modelTimeoutMs }) {
  const vertex = settings.provider === 'vertex';
  const anthropic = !vertex && settings.directProtocol === 'anthropic';
  const useGoogleKey = vertex && settings.directAuthType === 'api_key';
  if (!settings.directApiKey && (!vertex || useGoogleKey)) throw new Error('Chưa có khoá API của nhà cung cấp mô hình (Cài đặt → Chatbot).');
  const model = settings.directModel || (vertex ? 'gemini-2.5-flash' : '');
  const endpoint = modelEndpoint(settings, model);
  if (!endpoint) throw new Error('Chưa cấu hình endpoint mô hình.');
  if (!vertex) await assertPublicHost(new URL(endpoint).hostname);
  const accessToken = vertex && !useGoogleKey ? (settings.directApiKey || await getVertexAccessToken({ fetchImpl })) : settings.directApiKey;
  const body = vertex ? {
    systemInstruction: { parts: [{ text: system }] },
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: { temperature: 0.2, responseMimeType: 'application/json' }
  } : anthropic ? {
    model, max_tokens: 2048, temperature: 0.2, system, messages: [{ role: 'user', content: prompt }]
  } : {
    model, temperature: 0.2,
    messages: [{ role: 'system', content: system }, { role: 'user', content: prompt }],
    response_format: { type: 'json_object' }
  };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let response;
    try {
      response = await fetchImpl(endpoint, {
        method: 'POST',
        redirect: 'manual',
        headers: {
          ...(anthropic
            ? { 'x-api-key': settings.directApiKey, 'anthropic-version': '2023-06-01' }
            : useGoogleKey ? { 'x-goog-api-key': settings.directApiKey } : { Authorization: `Bearer ${accessToken}` }),
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(body),
        signal: controller.signal
      });
    } catch (error) {
      // Hết giờ chờ (đã đợi đủ 60 giây) thì không thử lại; rớt mạng thì có.
      if (error?.name === 'AbortError') throw new Error('Nhà cung cấp mô hình phản hồi quá lâu.');
      const wrapped = new Error(`Không kết nối được nhà cung cấp mô hình: ${error?.cause?.code || error?.message || error}.`);
      wrapped.retryable = true;
      throw wrapped;
    }
    if (response.status >= 300 && response.status < 400) throw new Error(`Endpoint AI chuyển hướng (${response.status}).`);
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const failure = new Error(payload?.error?.message || payload?.message || `Nhà cung cấp mô hình trả về lỗi ${response.status}.`);
      failure.status = response.status;
      if (isRetryableStatus(response.status)) {
        failure.retryable = true;
        failure.retryAfter = response.headers?.get?.('retry-after') ?? null;
      }
      throw failure;
    }
    const text = vertex
      ? payload?.candidates?.[0]?.content?.parts?.map(part => part.text || '').join('')
      : anthropic
        ? payload?.content?.map(part => (part.type === 'text' ? part.text || '' : '')).join('')
        : payload?.choices?.[0]?.message?.content;
    if (!String(text || '').trim()) throw new Error('Mô hình không trả về nội dung.');
    return { text: String(text).trim(), model };
  } finally {
    clearTimeout(timer);
  }
}

// ===== Lưu trữ =====

let writeQueue = Promise.resolve();

/** ENOENT → []; tệp hỏng → cất `.corrupt-*` rồi []; lỗi đọc khác → ném (lần lưu không đè mất các lượt cũ). */
async function readRuns(filePath) {
  return readJsonFile(filePath, {
    fallback: () => [],
    normalize: parsed => (Array.isArray(parsed.runs) ? parsed.runs : []),
    label: 'Lịch sử Cố vấn AI chiến dịch'
  });
}

function saveRun(result, options = {}) {
  const filePath = insightsPath(options);
  const operation = writeQueue.then(async () => {
    const runs = [result, ...(await readRuns(filePath))].slice(0, campaignAiThresholds.keepRuns);
    await writeJsonAtomic(filePath, { runs });
  });
  writeQueue = operation.then(() => undefined, () => undefined);
  return operation;
}

/** Lần phân tích gần nhất đã lưu, hoặc null. */
export async function readCampaignInsights(options = {}) {
  await writeQueue;
  const runs = await readRuns(insightsPath(options));
  return runs[0] || null;
}

// ===== Theo dõi đề xuất: đã làm / bỏ qua, so trước–sau =====
//
// CRM không tự sửa quảng cáo (quyết định chủ shop 05/10/2026: "giữ chỉ khuyên"). Quản trị làm trong Trình quản lý
// quảng cáo rồi bấm "Đã làm" — CRM ghi lại lúc đó và so số liệu chiến dịch 7 ngày trước với các ngày sau đó.

export const DECISION_STATUSES = Object.freeze(['done', 'skipped']);
export const FOLLOW_UP_DAYS = Object.freeze({ before: 7, minAfter: 3, maxAfter: 14 });
const DAY = 24 * 60 * 60 * 1000;
const vnDay = ms => new Date(Number(ms) + 7 * 60 * 60 * 1000).toISOString().slice(0, 10);

/**
 * Ghi quyết định cho một đề xuất của lượt phân tích `generatedAt`. status '' = bỏ đánh dấu.
 * Trả về lượt đã cập nhật, hoặc null nếu không tìm thấy lượt / đề xuất.
 */
export function recordCampaignDecision({ generatedAt, campaignId, kind, status = '', by = '', now = Date.now() } = {}, options = {}) {
  const filePath = insightsPath(options);
  if (status && !DECISION_STATUSES.includes(status)) {
    const error = new Error('Trạng thái phải là "done" (đã làm) hoặc "skipped" (bỏ qua).');
    error.statusCode = 400;
    return Promise.reject(error);
  }
  const operation = writeQueue.then(async () => {
    const runs = await readRuns(filePath);
    const run = runs.find(item => item?.generatedAt === generatedAt);
    const action = run && (Array.isArray(run.actions) ? run.actions : []).find(item => String(item.campaignId) === String(campaignId) && item.kind === kind);
    if (!action) return null;
    if (status) action.decision = { status, at: now, by: String(by || '').slice(0, 80) };
    else delete action.decision;
    await writeJsonAtomic(filePath, { runs });
    return run;
  });
  writeQueue = operation.then(() => undefined, () => undefined);
  return operation;
}

/** Hai khoảng ngày để so: 7 ngày trước ngày làm, và từ ngày làm tới hôm nay (tối đa 14 ngày). null = chưa làm. */
export function followUpWindows(decidedAt, now = Date.now()) {
  const at = Number(decidedAt);
  if (!at) return null;
  const decidedDay = vnDay(at);
  const today = vnDay(now);
  const afterDays = Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${decidedDay}T00:00:00Z`)) / DAY) + 1;
  const afterUntil = afterDays > FOLLOW_UP_DAYS.maxAfter ? vnDay(at + (FOLLOW_UP_DAYS.maxAfter - 1) * DAY) : today;
  return {
    before: { from: vnDay(at - FOLLOW_UP_DAYS.before * DAY), to: vnDay(at - DAY), days: FOLLOW_UP_DAYS.before },
    after: { from: decidedDay, to: afterUntil, days: Math.min(afterDays, FOLLOW_UP_DAYS.maxAfter) },
    ready: afterDays >= FOLLOW_UP_DAYS.minAfter
  };
}

function periodFigures(row, days) {
  const spend = number(row?.spend);
  const orders = number(row?.orders);
  const revenue = number(row?.revenue);
  return {
    days,
    spend: round(spend),
    spendPerDay: round(ratio(spend, days)),
    orders,
    ordersPerDay: round(ratio(orders, days), 2),
    revenue: round(revenue),
    cpa: orders ? round(spend / orders) : null,
    roas: spend ? round(revenue / spend, 2) : null
  };
}

/**
 * Kết quả sau khi làm: số của chiến dịch trước / sau (theo ngày, vì hai khoảng dài khác nhau) và một câu nhận xét.
 * `reports` = { before, after } là báo cáo chiến dịch của hai khoảng trong followUpWindows.
 */
export function decisionFollowUp(action = {}, windows = null, reports = {}) {
  if (!windows) return null;
  if (!windows.ready) return { ready: false, daysLeft: FOLLOW_UP_DAYS.minAfter - windows.after.days, windows };
  const find = report => (Array.isArray(report?.campaigns) ? report.campaigns : []).find(item => String(item.id) === String(action.campaignId));
  const before = periodFigures(find(reports.before), windows.before.days);
  const after = periodFigures(find(reports.after), windows.after.days);
  let verdict = 'Chưa đủ đơn để kết luận.';
  if (action.kind === 'pause' || action.kind === 'reduce') {
    verdict = after.spendPerDay < before.spendPerDay
      ? `Chi/ngày giảm từ ${formatVnd(before.spendPerDay)} còn ${formatVnd(after.spendPerDay)}.`
      : `Chi/ngày chưa giảm (${formatVnd(before.spendPerDay)} → ${formatVnd(after.spendPerDay)}) — kiểm tra lại trong Trình quản lý quảng cáo.`;
  } else if (before.orders + after.orders >= 3 && before.cpa !== null && after.cpa !== null) {
    const change = (after.cpa - before.cpa) / before.cpa;
    verdict = change <= -0.1 ? `CPA tốt lên ${Math.round(-change * 100)}% (${formatVnd(before.cpa)} → ${formatVnd(after.cpa)}).`
      : change >= 0.1 ? `CPA xấu đi ${Math.round(change * 100)}% (${formatVnd(before.cpa)} → ${formatVnd(after.cpa)}).`
        : `CPA gần như giữ nguyên (${formatVnd(before.cpa)} → ${formatVnd(after.cpa)}).`;
  } else if (after.orders && !before.orders) {
    verdict = `Có ${after.orders} đơn sau khi làm (trước đó 0 đơn).`;
  }
  return { ready: true, windows, before, after, verdict };
}

// ===== Điểm vào =====

/**
 * Tuỳ chọn: `days`, `callModel({system, prompt, settings}) → string | {text, model}` (tiêm khi test),
 * `settings`, `fetchImpl`, `path`, `persist` (mặc định true), `now`.
 */
export async function generateCampaignInsights(report = {}, options = {}) {
  const safeReport = report && typeof report === 'object' ? report : {};
  const days = number(options.days ?? safeReport.range?.days) || null;
  const generatedAt = new Date(options.now ?? Date.now()).toISOString();
  const rules = ruleBasedActions(safeReport);
  const base = { generatedAt, days };
  const campaigns = selectCampaigns(safeReport);
  let result;

  if (!campaigns.length) {
    result = { ...base, model: 'rules', source: 'rules', summary: 'Chưa có số liệu chiến dịch trong khoảng ngày này nên chưa có gì để khuyên.', actions: [] };
  } else {
    let settings = null;
    try {
      settings = options.settings || await (options.readSettings || dependencies.readSettings)();
      const system = campaignAiSystemPrompt;
      const prompt = buildCampaignPrompt(safeReport, { days, market: options.market || null });
      const call = options.callModel || (input => requestModelText({
        ...input,
        fetchImpl: options.fetchImpl,
        ...(options.sleep ? { sleep: options.sleep } : {}),
        ...(options.retries !== undefined ? { retries: options.retries } : {})
      }));
      const answer = await call({ system, prompt, settings: settings || {} });
      const text = typeof answer === 'string' ? answer : answer?.text;
      const model = (typeof answer === 'object' && answer?.model) || settings?.directModel || 'ai';
      const checked = validateInsights(parseInsightsAnswer(text), safeReport);
      if (!checked) throw new Error('Mô hình trả về JSON không hợp lệ.');
      result = {
        ...base, model, source: 'ai',
        summary: checked.summary || 'AI không viết tóm tắt; xem các đề xuất bên dưới.',
        actions: checked.actions
      };
    } catch (error) {
      result = {
        ...base, model: 'rules', source: 'rules', error: String(error?.message || error).slice(0, 300),
        // R13: không chèn nguyên văn lỗi kỹ thuật (429 Resource exhausted, ENOENT …vertex.json) vào câu cho chủ shop —
        // chi tiết nằm ở `error` (máy chủ ghi log, friendlyCampaignInsights không đưa ra giao diện).
        summary: `AI tạm thời không dùng được (nhờ bộ phận kỹ thuật kiểm tra kết nối AI), nên dưới đây chỉ là gợi ý theo luật tính sẵn: ${rules.length ? `${rules.length} chiến dịch cần để ý.` : 'không có chiến dịch nào vượt ngưỡng.'}`,
        actions: rules
      };
    }
  }

  if (options.persist !== false) await saveRun(result, options);
  return result;
}
