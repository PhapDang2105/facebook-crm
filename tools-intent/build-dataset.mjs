// Dựng tập huấn luyện mô hình nhỏ (hợp đồng dòng dữ liệu v2): (tin khách đã gộp, ngữ cảnh) → mã mẫu Page đã trả lời.
// Chạy trên máy chủ:
//   node --env-file=.env tools-intent/build-dataset.mjs <out.jsonl> [--since 2026-09-18] [--llm] [--include-comments]
//   node tools-intent/build-dataset.mjs <out.jsonl> --from-decision-log data/processed/decision-log [--since …]
//   - Từ KHO HỘI THOẠI: tin khách gộp như engine (tin chữ liên tiếp chưa được Page trả lời, ≤ 10 phút, ≤ 5 tin,
//     nối "\n"); trả lời khớp mẫu → nhãn theo chữ ký mẫu (labelSource 'template'); câu nhân viên tự viết
//     → với --llm, Gemini quy về mã mẫu (labelSource 'staff', cache data/processed/staff-labels.json);
//     nhân viên viết lại trong 10 phút sau bot → nhãn nhân viên thay nhãn bot, đánh dấu corrected.
//   - Từ NHẬT KÝ QUYẾT ĐỊNH (ưu tiên khi có): mỗi dòng là một lượt engine thật, nhãn = final,
//     labelSource 'pipeline', ngữ cảnh lấy nguyên từ ctx của engine (không phải suy ngoại tuyến).
//   - Bình luận mặc định bỏ (--include-comments để giữ).
// Chỉ ghi chữ khách đã che SĐT; không ghi tên; không gửi gì cho khách.
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isSystemNotice, matchTemplate, templateSignatures } from '../app/processing/template-match.mjs';
import { isLivestreamConversation } from '../app/conversation-orders.mjs';
import { addressInTextOf, bagCountOf, customerTurns, lastWasOrderStepOf, maskPhone, orderContextAt, prevBotAsksOf, readJsonl, textContext, toJsonl, turnContext } from './dataset-context.mjs';

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
      rows.push(v2Row({
        id: `${conversation.id}:${at}`,
        text,
        ...context,
        label, labelSource, corrected,
        source,
        ...orderContextAt(conversation.customerOrders, at),
        livestream,
        ...textContext(turn.text),
        ruleTemplate: '',
        at,
        bundleSize: turn.bundle.length
      }));
    }
  }
  return rows;
}

/** Đọc mọi tệp YYYY-MM-DD.jsonl trong thư mục nhật ký (lọc theo ngày trong tên tệp). */
export function readDecisionLog(dir, { since = 0 } = {}) {
  if (!existsSync(dir)) return [];
  const files = readdirSync(dir).filter(name => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(name)).sort();
  const entries = [];
  for (const name of files) {
    if (since && Date.parse(`${name.slice(0, 10)}T23:59:59Z`) < since) continue;
    for (const line of readFileSync(path.join(dir, name), 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try { entries.push(JSON.parse(line)); } catch { /* dòng hỏng (ghi dở) bỏ qua */ }
    }
  }
  return entries;
}

/** Dòng v2 từ nhật ký quyết định: nhãn = final (câu engine đã chọn), ctx lấy nguyên. */
export function rowsFromDecisionLog(entries, { templates = {}, includeComments = false, since = 0, stats = {} } = {}) {
  const signatures = templateSignatures(templates);
  Object.assign(stats, { pipeline: 0, skipped: 0, comments: 0, ...stats });
  const rows = [];
  for (const entry of entries) {
    if (!entry || entry.skipped || (entry.type || 'text') !== 'text' || !entry.final || !String(entry.text || '').trim()) { stats.skipped += 1; continue; }
    const at = Number(entry.at) || Date.parse(entry.at) || 0;
    if (at < since) continue;
    const source = entry.source === 'comment' ? 'comment' : 'inbox';
    if (source === 'comment' && !includeComments) { stats.comments += 1; continue; }
    const ctx = entry.ctx || {};
    const prevBot = maskPhone(entry.prevBot || '').slice(0, 240);
    const lastTemplate = String(entry.lastTemplate || ctx.lastTemplate || (prevBot ? matchTemplate(prevBot, signatures) : '') || '');
    const text = maskPhone(entry.text).slice(0, 300);
    stats.pipeline += 1;
    rows.push(v2Row({
      id: `${entry.conversationId}:${entry.mid || at}`,
      text,
      prevBot,
      prevCustomer: String(entry.prevCustomer || ''),
      label: entry.final,
      labelSource: 'pipeline',
      source,
      lastTemplate,
      lastWasOrderStep: ctx.lastWasOrderStep ?? lastWasOrderStepOf(lastTemplate),
      hasBasket: ctx.hasBasket,
      basketItems: Array.isArray(ctx.basketItems) ? ctx.basketItems.reduce((sum, item) => sum + (Number(item?.quantity) || 1), 0) : ctx.basketItems,
      hasOrder: ctx.hasRecentOrder,
      orderAgeMin: Number.isFinite(Number(ctx.orderAgeMin)) && ctx.orderAgeMin !== null ? ctx.orderAgeMin : null,
      livestream: ctx.livestream,
      prevBotAsks: entry.prevBotAsks || prevBotAsksOf(prevBot, lastTemplate),
      phoneInText: ctx.phoneInText ?? text.includes('<sdt>'),
      addressInText: ctx.addressInText ?? addressInTextOf(text),
      bagCount: ctx.bagCount ?? bagCountOf(text),
      ruleTemplate: entry.rule?.templateId || '',
      at,
      prevBotAgeMin: Number.isFinite(Number(entry.prevBotAgeMin)) && entry.prevBotAgeMin !== null ? entry.prevBotAgeMin : null,
      staffRepliedAfterBot: Boolean(ctx.staffRepliedAfterBot),
      ...(entry.rule?.name ? { ruleName: entry.rule.name } : {}),
      ...(entry.chosen && entry.chosen !== entry.final ? { chosen: entry.chosen } : {}),
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
  const valueFlags = new Set(['--since', '--from-decision-log']);
  const outPath = args.filter((arg, index) => !arg.startsWith('--') && !valueFlags.has(args[index - 1]))[0];
  if (!outPath) { console.log('Dùng: node tools-intent/build-dataset.mjs <out.jsonl> [--since YYYY-MM-DD] [--llm] [--include-comments] [--from-decision-log <dir>]'); process.exit(1); }
  const since = Date.parse(args.includes('--since') ? args[args.indexOf('--since') + 1] : '2026-09-18T00:00:00Z');
  const includeComments = args.includes('--include-comments');
  // CRM_DATA_DIR: chỉ để chạy trên bản sao dữ liệu ở máy khác; mặc định là kho thật của app.
  const dataDir = process.env.CRM_DATA_DIR || path.join(root, 'data', 'processed');
  const settings = JSON.parse(readFileSync(path.join(dataDir, 'chatbot-settings.json'), 'utf8'));
  const templates = settings.messageTemplates || {};
  const stats = {};
  let rows;
  if (args.includes('--from-decision-log')) {
    const dir = args[args.indexOf('--from-decision-log') + 1];
    const entries = readDecisionLog(dir, { since });
    rows = rowsFromDecisionLog(entries, { templates, includeComments, since, stats });
    console.log(`Nhật ký quyết định ${dir}: ${entries.length} dòng`);
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
