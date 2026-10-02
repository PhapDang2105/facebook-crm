// Dựng tập huấn luyện mô hình nhỏ (hợp đồng dòng dữ liệu v2): (tin khách đã gộp, ngữ cảnh) → mã mẫu Page đã trả lời.
// Chạy trên máy chủ:
//   node --env-file=.env tools-intent/build-dataset.mjs <out.jsonl> [--since 2026-09-18] [--llm] [--include-comments]
//   node tools-intent/build-dataset.mjs <out.jsonl> --from-decision-log data/processed/decision-log [--since …]
//   - Từ KHO HỘI THOẠI: tin khách gộp như engine (tin chữ liên tiếp chưa được Page trả lời, ≤ 10 phút, ≤ 5 tin,
//     nối "\n"); trả lời khớp mẫu → nhãn theo chữ ký mẫu (labelSource 'template'); câu nhân viên tự viết
//     → với --llm, Gemini quy về mã mẫu (labelSource 'staff', cache data/processed/staff-labels.json);
//     nhân viên viết lại trong 10 phút sau bot → nhãn nhân viên thay nhãn bot, đánh dấu corrected.
//   - Từ NHẬT KÝ QUYẾT ĐỊNH (ưu tiên khi có): mỗi dòng là một lượt engine thật, labelSource 'pipeline'.
//     Nhãn = `chosen` (mẫu mô hình/luật đã chọn, trước hậu xử lý) khi có; bản ghi cũ không có chosen thì = final
//     (mã engine ORDER_UPDATE/CANCEL/NOTE quy về mã mẫu ORDER_UPDATED/CANCELLED/NOTE_ADDED) — xem decisionLabelOf.
//     LƯU Ý từ r13 (02/10): `ctx.staffRepliedAfterBot` của nhật ký ĐỔI NGHĨA — chỉ còn true khi có tin THẬT của nhân viên
//     sau lượt bot + 5 giây (cờ staff, hay tin Page không mang dấu máy gửi). Trước r13, MỌI tin Page sau lượt bot (ưu
//     đãi QR, bám đuổi, lời chào Botcake/AI Pancake, thẻ đơn POS) cũng bật cờ này → dòng nhật ký trước 02/10 có cờ
//     true nhiều hơn thực tế; khi huấn luyện gộp hai giai đoạn, đặc trưng này lệch phân phối (cân nhắc --since 2026-10-02
//     hay bỏ đặc trưng khi so sánh). Bản dựng từ kho hội thoại (dataset-context) vốn đã chỉ tính tin có cờ staff.
//     Trường mới `candidateRule` { name, templateId, mode } (luật ứng viên K1/K1b/K3/K4/K5; mode 'shadow' = chỉ ghi nhật
//     ký, 'on' = đã trả lời thật) được chép sang dòng dataset khi nhật ký có — KHÔNG phải đặc trưng huấn luyện, chỉ để
//     đối chiếu luật ứng viên với nhãn (shadow-report in tỷ lệ trùng `chosen`).
//     Trường `prevBot` của nhật ký là MÃ MẪU bot trước (botLastTemplateId) → lastTemplate; câu bot trước (đã che)
//     đọc từ `prevBotText` nếu engine ghi; giỏ đang giữ đọc từ `basket` [{ sku, quantity }] nếu có.
//     Ngữ cảnh mô hình dựng bằng intentRowOf (một định nghĩa với engine) từ ctx/chữ của nhật ký.
//     Khử trùng id (conversationId:mid); đếm dòng hỏng / trước --since / trùng và in ra.
//   - --since YYYY-MM-DD (giờ Việt Nam; mặc định 2026-09-18, in ra khi chạy). Sai định dạng → lỗi.
//   - Bình luận mặc định bỏ (--include-comments để giữ).
// Chỉ ghi chữ khách đã che SĐT; không ghi tên; không gửi gì cho khách.
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isSystemNotice, matchTemplate, templateSignatures } from '../app/processing/template-match.mjs';
import { isLivestreamConversation } from '../app/conversation-orders.mjs';
import { canonicalTemplateId, intentRowOf, labelTemplateId } from '../app/processing/intent-features.mjs';
import { basketItemsOf, cliFail, customerTurns, looksLikeTemplateId, maskPhone, parseCliArgs, phoneInTextOf, readJsonl, toJsonl, turnContext } from './dataset-context.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SKIP_IDS = new Set(['COMMENT_PRIVATE_REPLY', 'COMMENT_PUBLIC_FALLBACK', 'COMMENT_PUBLIC_REPEAT', 'ORDER_CART_LINE', 'ORDER_ADDRESS_REMIND', 'ORDER_UNCHANGED', 'ORDER_NOTE_ADDED', 'REPLY_ALREADY_SENT', 'REPLY_ALREADY_SENT_INFO', 'UPSELL_TWO_BAGS', 'TRIAL_REMIND', 'TRIAL_NEXT_STEP', 'QR_OFFER', 'LIVE_DEAL_CLAIMED', 'COMMENT_PUBLIC_SORRY', 'COMMENT_STAFF_FOLLOWUP', 'ORDER_STATUS_CHECKING', 'ORDER_AFTER_SALE', 'GIFT_POLICY_EMPTY', 'ORDER_UPDATED']);

/** Trường v2 chung cho cả hai nguồn: thứ tự cố định để đọc tệp bằng mắt dễ hơn. */
function v2Row(fields) {
  const { id, text, prevBot, prevCustomer, label, labelSource, weak, corrected, source, lastTemplate, lastWasOrderStep, hasBasket, basketItems, hasOrder, orderAgeMin, livestream, prevBotAsks, phoneInText, addressInText, bagCount, ruleTemplate, at, ...extra } = fields;
  return {
    id, text, prevBot, prevCustomer, label, labelSource,
    ...(weak ? { weak: true } : {}), ...(corrected ? { corrected: true } : {}),
    source, lastTemplate, lastWasOrderStep: Boolean(lastWasOrderStep), hasBasket: Boolean(hasBasket), basketItems: Number(basketItems) || 0,
    hasOrder: Boolean(hasOrder), orderAgeMin: Number.isFinite(Number(orderAgeMin)) && orderAgeMin !== null ? Number(orderAgeMin) : null,
    livestream: Boolean(livestream), prevBotAsks: prevBotAsks || '', phoneInText: Boolean(phoneInText), addressInText: Boolean(addressInText),
    bagCount: Number(bagCount) || 0, ruleTemplate: ruleTemplate || '', at, ...extra
  };
}

/**
 * Dựng dòng v2 từ kho hội thoại. `labelStaff(customerText, staffText)` (tuỳ chọn, async) quy câu nhân
 * viên về mã mẫu; `cache` giữ kết quả theo "convId:createdAt".
 */
export async function buildRowsFromStore(store, { templates = {}, since = 0, includeComments = false, labelStaff = null, cache = {}, stats = {} } = {}) {
  const signatures = templateSignatures(templates);
  const match = text => matchTemplate(text, signatures);
  Object.assign(stats, { template: 0, staff: 0, corrected: 0, staffUnlabeled: 0, llmCalls: 0, comments: 0, ...stats });
  const rows = [];
  for (const conversation of store.conversations || []) {
    const source = conversation.source === 'comment' ? 'comment' : 'inbox';
    if (source === 'comment' && !includeComments) { stats.comments += 1; continue; }
    const livestream = isLivestreamConversation(conversation) || (conversation.labels || []).includes('livestream');
    for (const turn of customerTurns(store.messages?.[conversation.id] || [])) {
      const at = Number(turn.current.createdAt) || 0;
      if (at < since) continue;
      const replies = turn.replies.filter(reply => reply.text && (reply.type || 'text') === 'text' && !isSystemNotice(reply.text));
      if (!replies.length) continue;
      const first = replies[0];
      const firstLabel = match(first.text);
      // Bot trả lời xong, nhân viên viết thêm câu không khớp mẫu trong 10 phút: coi là nhân viên sửa bot.
      // Câu nhân viên phải có nội dung (≥ 20 ký tự): "Dạ vâng ạ" không nói lên mẫu nào.
      const isStaffText = reply => !match(reply.text) && String(reply.text).trim().length >= 20;
      const staffAfterBot = firstLabel ? replies.slice(1).find(reply => isStaffText(reply) && reply.createdAt - first.createdAt <= 10 * 60000) : null;
      const staffReply = !firstLabel ? (isStaffText(first) && first.createdAt - at <= 24 * 3600000 ? first : null) : staffAfterBot;
      let label = firstLabel;
      let labelSource = firstLabel ? 'template' : '';
      let corrected = false;
      const text = maskPhone(turn.text).slice(0, 300);
      if (staffReply) {
        const key = `${conversation.id}:${staffReply.createdAt}`;
        if (!(key in cache) && labelStaff) { cache[key] = await labelStaff(text, maskPhone(staffReply.text).slice(0, 400)); stats.llmCalls += 1; }
        const mapped = cache[key];
        // Bot đã trả lời: chỉ coi là "sửa" khi nhân viên đưa ra câu có mẫu tương đương khác mẫu bot.
        const substantive = mapped?.label && (mapped.confidence ?? 1) >= 0.7 && !['WELCOME', 'OTHER'].includes(mapped.label);
        if (firstLabel && substantive && mapped.label !== firstLabel) { corrected = true; stats.corrected += 1; label = mapped.label; labelSource = 'staff'; stats.staff += 1; }
        else if (!firstLabel && mapped?.label && (mapped.confidence ?? 1) >= 0.7) { label = mapped.label; labelSource = 'staff'; stats.staff += 1; }
        else if (!firstLabel) { stats.staffUnlabeled += 1; continue; }
      }
      if (!label) continue;
      if (labelSource === 'template') stats.template += 1;
      const context = turnContext({ before: turn.before, at, matchTemplateFn: match });
      // Trường mô hình: intentRowOf (một định nghĩa với engine) — đơn chưa hủy < 24 giờ trước tin, SĐT/địa chỉ/túi từ chữ.
      const modelRow = intentRowOf({
        text: turn.text, source, lastTemplateId: context.lastTemplateMatched || context.lastTemplate, prevBotText: context.prevBot,
        hasBasket: context.hasBasket, orders: Array.isArray(conversation.customerOrders) ? conversation.customerOrders : [], now: at - 1,
        livestream, phoneInText: phoneInTextOf(turn.text), prevBotAsks: context.prevBotAsks
      });
      rows.push(v2Row({
        id: `${conversation.id}:${at}`,
        ...context,
        ...modelRow,
        text,
        label, labelSource, corrected,
        source,
        ruleTemplate: '',
        at,
        bundleSize: turn.bundle.length
      }));
    }
  }
  return rows;
}

/** Ngày YYYY-MM-DD theo giờ Việt Nam → mốc ms lúc 00:00 (+07:00); sai định dạng → NaN. */
export function parseSinceDate(value) {
  const text = String(value || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return NaN;
  const at = Date.parse(`${text}T00:00:00+07:00`);
  return Number.isFinite(at) && new Date(at + 7 * 3600000).toISOString().slice(0, 10) === text ? at : NaN;
}
export const DEFAULT_SINCE = '2026-09-18';

/**
 * Đọc mọi tệp YYYY-MM-DD.jsonl trong thư mục nhật ký (tệp có ngày < since bỏ cả tệp). Dòng hỏng (ghi dở) bỏ qua và
 * đếm vào `stats.bad`; `stats.files` = số tệp đã đọc.
 */
export function readDecisionLog(dir, { since = 0, stats = {} } = {}) {
  Object.assign(stats, { bad: 0, files: 0, ...stats });
  if (!existsSync(dir)) return [];
  const files = readdirSync(dir).filter(name => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(name)).sort();
  const entries = [];
  for (const name of files) {
    // Tên tệp là ngày giờ Việt Nam: bỏ cả tệp khi ngày đó kết thúc trước since.
    if (since && Date.parse(`${name.slice(0, 10)}T23:59:59.999+07:00`) < since) continue;
    stats.files += 1;
    const fileStats = {};
    entries.push(...readJsonl(readFileSync(path.join(dir, name), 'utf8'), fileStats));
    stats.bad += fileStats.bad || 0;
  }
  return entries;
}

/**
 * Nhãn của một bản ghi nhật ký: mẫu mô hình/luật ĐÃ CHỌN (`chosen`, trước mọi hậu xử lý) khi có; bản ghi cũ không có
 * `chosen` thì lấy `final`; mã engine → mã mẫu.
 * R13 (báo cáo mô hình, mục 3.E.2): trước đây chỉ lấy `chosen` khi `final` là 3 mẫu gác (REPLY_ALREADY_SENT*,
 * ORDER_ADDRESS_REMIND), còn lại lấy `final` — trong khi engine chấm ✓/✗ mô hình nhỏ theo `chosen`. Lệch 43/611 dòng hộp
 * thư 30/09–02/10 (7,0%); 21 dòng thành LIVESTREAM_COMMENT (hậu xử lý GENERAL_INFO → lời chào live) rồi bị train-intent loại.
 */
export function decisionLabelOf(entry) {
  const final = String(entry?.final || '');
  const chosen = String(entry?.chosen || '');
  return labelTemplateId(chosen || final);
}

/**
 * Dòng v2 từ nhật ký quyết định (labelSource 'pipeline'). `prevBot` của nhật ký là MÃ MẪU (botLastTemplateId) →
 * lastTemplate; câu bot trước = `prevBotText` (đã che) nếu engine ghi (nhật ký cũ ghi chữ ở `prevBot` vẫn đọc được).
 * Giỏ: `basket` [{ sku, quantity }] giữ nguyên trên dòng (relabel dựng lại pendingOrder). Trường mô hình: intentRowOf.
 * `stats`: pipeline, skipped, comments, beforeSince, duplicates, legacyPrev.
 *
 * Vòng 12 (B5 #1): nhật ký v1 (trước bản sửa 10/2026) ghi prevBot/lastTemplate/prevBotAgeMin/prevBotAsks SAU khi bot trả
 * lời (engine đọc conversation đã bị saveBotState ghi đè → prevBot == final ở 1.096/1.106 lượt): dùng làm đặc trưng là
 * rò đáp án. Bản ghi v1: KHÔNG đọc các trường đó; lastTemplate dựng lại từ prevBotText (chụp trước khi trả lời, tin
 * cậy) qua chữ ký mẫu, không khớp thì lấy `final` của lượt trước cùng hội thoại trong nhật ký; prevBotAsks/prevBotAgeMin
 * bỏ trống. Bản ghi v2 (engine chụp trace.prev lúc bắt đầu lượt) đọc thẳng như cũ.
 */
export function rowsFromDecisionLog(entries, { templates = {}, includeComments = false, since = 0, stats = {} } = {}) {
  const signatures = templateSignatures(templates);
  Object.assign(stats, { pipeline: 0, skipped: 0, comments: 0, beforeSince: 0, duplicates: 0, legacyPrev: 0, ...stats });
  const rows = [];
  const seen = new Set();
  // Mẫu bot gửi ở lượt trước cùng hội thoại (theo thời gian) — chỉ dùng cho bản ghi v1.
  const timeOf = entry => Number(entry?.at) || Date.parse(entry?.at) || 0;
  const previousFinal = new Map();
  const lastFinal = new Map();
  for (const entry of [...entries].filter(Boolean).sort((a, b) => timeOf(a) - timeOf(b))) {
    previousFinal.set(entry, lastFinal.get(String(entry.conversationId)) || '');
    if (entry.final && !entry.skipped) lastFinal.set(String(entry.conversationId), String(entry.final));
  }
  for (const entry of entries) {
    if (!entry || entry.skipped || (entry.type || 'text') !== 'text' || !entry.final || !String(entry.text || '').trim()) { stats.skipped += 1; continue; }
    const at = Number(entry.at) || Date.parse(entry.at) || 0;
    if (at < since) { stats.beforeSince += 1; continue; }
    const source = entry.source === 'comment' ? 'comment' : 'inbox';
    if (source === 'comment' && !includeComments) { stats.comments += 1; continue; }
    const id = `${entry.conversationId}:${entry.mid || at}`;
    if (seen.has(id)) { stats.duplicates += 1; continue; }
    seen.add(id);
    const ctx = entry.ctx || {};
    const trustedPrev = Number(entry.v) >= 2;
    if (!trustedPrev) stats.legacyPrev += 1;
    const codeLogged = looksLikeTemplateId(entry.prevBot);
    const loggedId = codeLogged && trustedPrev ? String(entry.prevBot) : '';
    const prevBotRaw = entry.prevBotText ?? (codeLogged ? '' : entry.prevBot);
    const prevBot = maskPhone(prevBotRaw || '').slice(0, 240);
    const lastTemplate = canonicalTemplateId((trustedPrev ? entry.lastTemplate || loggedId : '') || ctx.lastTemplate || (prevBot ? matchTemplate(prevBot, signatures) : '')
      || (trustedPrev ? '' : previousFinal.get(entry) || '') || '');
    const text = maskPhone(entry.text).slice(0, 300);
    const basket = Array.isArray(entry.basket) ? entry.basket.filter(item => item && (item.sku || item.code)).map(item => ({ sku: String(item.sku || item.code), quantity: Math.max(1, Number(item.quantity) || 1) })) : null;
    const modelRow = intentRowOf({
      text, source, lastTemplateId: lastTemplate, prevBotText: prevBot, hasBasket: basket ? basket.length > 0 || Boolean(ctx.hasBasket) : ctx.hasBasket,
      hasOrder: ctx.hasOrder ?? ctx.hasRecentOrder, orderAgeMin: ctx.orderAgeMin, prevBotAsks: trustedPrev ? entry.prevBotAsks : undefined, livestream: ctx.livestream,
      phoneInText: ctx.phoneInText, staffRepliedAfterBot: ctx.staffRepliedAfterBot, now: at
    });
    const label = decisionLabelOf(entry);
    stats.pipeline += 1;
    rows.push(v2Row({
      id,
      ...modelRow,
      text,
      prevBot,
      prevCustomer: String(entry.prevCustomer || ''),
      label,
      labelSource: 'pipeline',
      source,
      basketItems: basket ? basket.reduce((sum, item) => sum + item.quantity, 0) : Array.isArray(ctx.basketItems) ? ctx.basketItems.reduce((sum, item) => sum + (Number(item?.quantity) || 1), 0) : Number(ctx.basketItems) || basketItemsOf({ lastTemplate, prevBot }),
      ruleTemplate: labelTemplateId(entry.rule?.templateId || ''),
      at,
      prevBotAgeMin: trustedPrev && Number.isFinite(Number(entry.prevBotAgeMin)) && entry.prevBotAgeMin !== null ? entry.prevBotAgeMin : null,
      staffRepliedAfterBot: Boolean(ctx.staffRepliedAfterBot),
      ...(basket ? { basket } : {}),
      ...(entry.rule?.name ? { ruleName: entry.rule.name } : {}),
      // R13: luật ứng viên (K-luật) khớp ở lượt này — chỉ để đối chiếu, không phải đặc trưng.
      ...(entry.candidateRule?.name ? { candidateRule: { name: String(entry.candidateRule.name), templateId: labelTemplateId(entry.candidateRule.templateId || ''), mode: entry.candidateRule.mode === 'on' ? 'on' : 'shadow' } } : {}),
      ...(entry.chosen && labelTemplateId(entry.chosen) !== label ? { chosen: entry.chosen } : {}),
      ...(String(entry.final) !== label ? { final: entry.final } : {}),
      ...(entry.llm?.templateId ? { llmTemplate: entry.llm.templateId } : {})
    }));
  }
  return rows;
}

/** Gán nhãn câu nhân viên bằng Gemini (Vertex): quy câu nhân viên về mã mẫu gần nhất, cache theo lượt. */
async function makeStaffLabeller(templates) {
  const { getVertexAccessToken, vertexProjectId } = await import(pathToFileURL(path.join(root, 'app/vertex-auth.mjs')).href);
  const describe = text => String(text || '').replace(/\[\?[^\]]*\]|\[\/\?\]|\[\[[^\]]*\]\]/g, ' ').replace(/\{[^}]+\}/g, '…').replace(/\s+/g, ' ').trim().slice(0, 70);
  const ids = Object.keys(templates).filter(id => templates[id] && !id.startsWith('FOLLOW_UP_') && !SKIP_IDS.has(id));
  ids.push('OTHER');
  const catalogue = ids.map(id => `${id}: ${id === 'OTHER' ? 'không mã nào tương đương / cần người thật' : describe(templates[id])}`).join('\n');
  const system = `Shop granola Giọt Nắng có bộ mẫu trả lời (mã + nội dung tóm tắt). Cho một tin khách và câu NHÂN VIÊN đã trả lời, hãy chọn ĐÚNG MỘT mã mẫu mà nếu bot dùng thì thay được câu nhân viên (cùng ý, cùng thông tin). Câu nhân viên xử lý việc riêng (tra đơn cụ thể, xin lỗi sự cố, thương lượng) không có mẫu tương đương → OTHER. Chỉ trả JSON.\nDanh sách mã:\n${catalogue}`;
  const schema = { type: 'OBJECT', properties: { template_id: { type: 'STRING', enum: ids }, confidence: { type: 'NUMBER' } }, required: ['template_id', 'confidence'] };
  const endpoint = `https://aiplatform.googleapis.com/v1/projects/${encodeURIComponent(vertexProjectId())}/locations/global/publishers/google/models/gemini-3-flash-preview:generateContent`;
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  return async (customerText, staffText) => {
    const user = `Khách: "${customerText}"\nNhân viên trả lời: "${staffText}"`;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const token = await getVertexAccessToken();
      const response = await fetch(endpoint, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ systemInstruction: { parts: [{ text: system }] }, contents: [{ role: 'user', parts: [{ text: user }] }], generationConfig: { responseMimeType: 'application/json', responseSchema: schema, thinkingConfig: { thinkingLevel: 'low' }, temperature: 0 } }) });
      const payload = await response.json().catch(() => ({}));
      if (response.status === 401) { await wait(65000); continue; }
      if (response.status === 429 || response.status >= 500) { await wait(2000 * 2 ** attempt * (0.5 + Math.random())); continue; }
      if (!response.ok) return null;
      try { const parsed = JSON.parse(payload?.candidates?.[0]?.content?.parts?.map(part => part.text || '').join('') || ''); return { label: parsed.template_id, confidence: Number(parsed.confidence) || 0 }; } catch { return null; }
    }
    return null;
  };
}

async function main() {
  const args = process.argv.slice(2);
  const usage = 'Dùng: node tools-intent/build-dataset.mjs <out.jsonl> [--since YYYY-MM-DD] [--llm] [--include-comments] [--from-decision-log <dir>]';
  const cli = parseCliArgs(args, ['--since', '--from-decision-log'], ['--include-comments', '--llm']);
  const outPath = cli.positional[0];
  if (!outPath) cliFail(usage);
  const sinceText = cli.value('--since', DEFAULT_SINCE);
  const since = parseSinceDate(sinceText);
  if (!Number.isFinite(since)) cliFail(`--since sai định dạng "${sinceText}" (cần YYYY-MM-DD, ví dụ 2026-09-28).`);
  console.log(`Từ ngày ${sinceText} (giờ Việt Nam)${cli.has('--since') ? '' : ' — mặc định, đổi bằng --since'}`);
  const includeComments = cli.has('--include-comments');
  // CRM_DATA_DIR: chỉ để chạy trên bản sao dữ liệu ở máy khác; mặc định là kho thật của app.
  const dataDir = process.env.CRM_DATA_DIR || path.join(root, 'data', 'processed');
  const { normalizeChatbotSettings } = await import(pathToFileURL(path.join(root, 'app', 'chatbot-settings.mjs')).href);
  // Mẫu gộp seed (như engine đọc): chữ ký mẫu nào cũng có, kể cả mẫu Cài đặt chưa lưu.
  const settings = normalizeChatbotSettings(JSON.parse(readFileSync(path.join(dataDir, 'chatbot-settings.json'), 'utf8')));
  const templates = settings.messageTemplates || {};
  const stats = {};
  let rows;
  if (cli.has('--from-decision-log')) {
    const dir = cli.value('--from-decision-log');
    if (!existsSync(dir) || !statSync(dir).isDirectory()) cliFail(`Không thấy thư mục nhật ký quyết định: ${dir}`);
    const readStats = {};
    const entries = readDecisionLog(dir, { since, stats: readStats });
    rows = rowsFromDecisionLog(entries, { templates, includeComments, since, stats });
    console.log(`Nhật ký quyết định ${dir}: ${readStats.files} tệp · ${entries.length} dòng · hỏng (bỏ) ${readStats.bad} · trước ${sinceText} ${stats.beforeSince} · trùng id ${stats.duplicates}`);
  } else {
    const store = JSON.parse(readFileSync(path.join(dataDir, 'meta-conversations.json'), 'utf8'));
    const cachePath = path.join(dataDir, 'staff-labels.json');
    const cache = existsSync(cachePath) ? JSON.parse(readFileSync(cachePath, 'utf8')) : {};
    const labelStaff = args.includes('--llm') ? await makeStaffLabeller(templates) : null;
    rows = await buildRowsFromStore(store, { templates, since, includeComments, labelStaff, cache, stats });
    if (labelStaff) writeFileSync(cachePath, JSON.stringify(cache));
  }
  writeFileSync(outPath, toJsonl(rows));
  const counts = rows.reduce((acc, row) => { acc[row.label] = (acc[row.label] || 0) + 1; return acc; }, {});
  const bundled = rows.filter(row => row.text.includes('\n')).length;
  console.log(JSON.stringify({ rows: rows.length, bundled, ...stats, labels: Object.keys(counts).length, top: Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 12) }));
  if (stats.corrected) console.log('Nhân viên sửa bot (mẫu bot → mẫu nhân viên):', rows.filter(row => row.corrected).slice(0, 10).map(row => `"${row.text.slice(0, 50)}" → ${row.label}`).join(' · '));
}

const isMain = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isMain) await main();
export { readJsonl };
