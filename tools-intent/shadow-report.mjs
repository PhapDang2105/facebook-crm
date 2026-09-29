// Báo cáo chạy ẩn theo ngày từ NHẬT KÝ QUYẾT ĐỊNH (data/processed/decision-log/YYYY-MM-DD.jsonl, X1 ghi) hay
// từ log journalctl cũ (--journal <file>): lượt, lượt LLM, bỏ qua theo lý do, luật ổn định / thử, mô hình nhỏ
// ✓/✗ theo ngưỡng 0,7/0,8/0,9 trên lượt LLM, gác trước ✓/✗, người gác agree/ngoài theo mẫu, token TB/median,
// % lượt có suy nghĩ, ước chi phí; mô hình tầng (trường `cascade` / dòng "Mô hình tầng (thử)"): nhóm ✓/✗ và
// mẫu ✓/✗ theo ngưỡng p trên lượt LLM, kèm dòng tổng theo nhóm dự đoán (cột cuối bảng).
// Vòng 12 (28/09): quy ước "~" (REPLY_ALREADY_SENT* — trung tính) LOẠI khỏi n cho CẢ mô hình nhỏ và mô hình tầng; tầng đoán
// OTHER (templateId rỗng) vẫn đếm cột nhóm (không vào cột mẫu theo ngưỡng); tách cột "Luật ổn định (ẩn)" (luật ổn định
// chạy ẩn, so với mẫu đã chọn) và "Luật thử" (luật thử nghiệm, so với luật ổn định / mẫu đã chọn).
// Dùng: node tools-intent/shadow-report.mjs [--since YYYY-MM-DD] [--dir data/processed/decision-log] [--journal <file>]
//         [--price-in 0.5] [--price-cache 0.05] [--price-out 3.0] [--json]
// Journal: journalctl -u facebook-crm -o short-iso --since "7 days ago" > /tmp/journal.txt (dòng không có năm thì --year).
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { decisionLabelOf } from '../app/processing/intent-features.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const THRESHOLDS = [0.7, 0.8, 0.9];
export const DEFAULT_PRICES = { input: 0.5, cache: 0.05, output: 3.0 };

/** Dấu so mô hình nhỏ với mẫu đã chọn — cùng quy ước engine.intentMatchMark (mẫu con ORDER_ADDRESS ≡ ADDRESS theo decisionLabelOf, "đã gửi ở trên" trung tính ~). */
export function intentMatchMark(predicted, chosen) {
  if (['REPLY_ALREADY_SENT', 'REPLY_ALREADY_SENT_INFO'].includes(chosen)) return '~';
  return decisionLabelOf(predicted) === decisionLabelOf(chosen) ? '✓' : '✗';
}

/**
 * Nhóm của mẫu theo mô hình tầng (processing/intent-cascade.mjs, nạp động — thiếu mô-đun thì '' và cột
 * "nhóm ✓" chỉ đếm được khi mẫu tương đương). Test / công cụ khác đưa groupOf riêng qua options.
 */
const cascadeModule = await import('../app/processing/intent-cascade.mjs').catch(() => null);
export const defaultGroupOf = typeof cascadeModule?.groupOf === 'function' ? cascadeModule.groupOf : () => '';

/** Dấu so mô hình tầng với mẫu đã chọn — cùng engine.cascadeMatchMark: ✓ mẫu tương đương, ~ trung tính, nhóm✓ chỉ đúng nhóm, ✗. */
export function cascadeMatchMark(cascade, chosen, groupOf = defaultGroupOf) {
  const mark = intentMatchMark(cascade?.templateId, chosen);
  if (mark !== '✗') return mark;
  let chosenGroup = '';
  try { chosenGroup = groupOf(chosen) || ''; } catch { chosenGroup = ''; }
  return chosenGroup && chosenGroup === cascade?.group ? 'nhóm✓' : '✗';
}

// Nhóm mà tầng đoán SAI vào đó là lỗi nguy hiểm (tự trả lời mẫu thông tin khi khách đang đặt hàng / cần người).
export const DANGER_GROUPS = new Set(['ORDER', 'SUPPORT']);

const emptyCascade = () => ({
  group: { n: 0, ok: 0, bad: 0, danger: 0 },
  tpl: Object.fromEntries(THRESHOLDS.map(t => [String(t), { n: 0, ok: 0, bad: 0 }])),
  byGroup: {}
});

/**
 * Cộng một dấu mô hình tầng (trên lượt LLM) vào thống kê: nhóm ✓ (✓ hay nhóm✓), mẫu ✓ theo ngưỡng p, theo nhóm dự
 * đoán; `chosenGroup` (nhóm của mẫu thật) để đếm riêng ✗ "khác nhóm vào ORDER/SUPPORT" (danger).
 */
function addCascadeMark(stats, cascade, mark, chosenGroup = '') {
  if (mark === '~') return;
  const hasTemplate = Boolean(cascade.templateId);
  const groupOk = mark === '✓' || mark === 'nhóm✓';
  const danger = !groupOk && DANGER_GROUPS.has(String(chosenGroup || '')) && String(cascade.group || '') !== String(chosenGroup);
  stats.group.n += 1;
  if (groupOk) stats.group.ok += 1; else stats.group.bad += 1;
  if (danger) stats.group.danger += 1;
  const slot = stats.byGroup[String(cascade.group || '?')] || (stats.byGroup[String(cascade.group || '?')] = { n: 0, groupOk: 0, tplOk: 0, tplBad: 0, danger: 0 });
  slot.n += 1;
  if (groupOk) slot.groupOk += 1;
  if (danger) slot.danger += 1;
  // Tầng đoán OTHER (không mẫu): chỉ đếm nhóm; cột mẫu theo ngưỡng chỉ tính lượt có mẫu.
  if (!hasTemplate) { slot.refused = (slot.refused || 0) + 1; return; }
  if (mark === '✓') slot.tplOk += 1; else slot.tplBad += 1;
  for (const t of THRESHOLDS) {
    if (!(Number(cascade.p) >= t)) continue;
    const bucket = stats.tpl[String(t)];
    bucket.n += 1;
    if (mark === '✓') bucket.ok += 1; else bucket.bad += 1;
  }
}

/** Cộng dấu mô hình nhỏ theo ngưỡng; "~" (trung tính) loại khỏi n — cùng quy ước với mô hình tầng. */
function addIntentMark(day, intent, mark) {
  if (mark === '~') return;
  for (const t of THRESHOLDS) {
    if (!(Number(intent.p) >= t)) continue;
    const bucket = day.intent[String(t)];
    bucket.n += 1;
    if (mark === '✓') bucket.ok += 1; else bucket.bad += 1;
  }
}

const emptyDay = () => ({
  turns: 0, llm: 0, skipped: {}, ruleStable: 0, ruleHidden: { n: 0, ok: 0, bad: 0 }, ruleShadow: { n: 0, ok: 0, bad: 0 },
  intent: Object.fromEntries(THRESHOLDS.map(t => [String(t), { n: 0, ok: 0, bad: 0 }])),
  cascade: emptyCascade(),
  preGuard: { n: 0, ok: 0, bad: 0, decisions: {} }, gate: { agree: 0, outside: 0, byTemplate: {}, reasons: {} },
  tokens: { input: [], cached: [], output: [], thinking: [] }, thinkingTurns: 0, handoff: 0, attention: 0, cost: 0
});

/** Cộng một lượt (dạng nhật ký quyết định v1) vào ngày. options.groupOf: nhóm của mẫu (mặc định mô-đun tầng). */
export function addEntry(day, entry, prices = DEFAULT_PRICES, options = {}) {
  const groupOf = typeof options.groupOf === 'function' ? options.groupOf : defaultGroupOf;
  if (entry.skipped) { day.skipped[entry.skipped] = (day.skipped[entry.skipped] || 0) + 1; return; }
  day.turns += 1;
  if (entry.rule) day.ruleStable += 1;
  // shadow của nhật ký: [luật ổn định chạy ẩn (khi không dùng thật), luật thử đính kèm]. Có cờ experimental/kind thì theo cờ;
  // không có: có luật dùng thật → mọi mục là luật thử; không có luật thật và ≥ 2 mục → mục đầu là luật ổn định ẩn.
  const shadows = (entry.shadow || []).filter(Boolean);
  const flagged = shadows.some(item => typeof item.experimental === 'boolean' || item.kind);
  const isHidden = (item, index) => (flagged ? item.experimental === false || item.kind === 'stable' : !entry.rule && shadows.length >= 2 && index === 0);
  const hidden = shadows.filter(isHidden);
  const chosen = entry.chosen || entry.final;
  for (const item of hidden) { day.ruleHidden.n += 1; if (item.templateId === chosen) day.ruleHidden.ok += 1; else day.ruleHidden.bad += 1; }
  const reference = entry.rule?.templateId || hidden[0]?.templateId || chosen;
  shadows.forEach((item, index) => {
    if (isHidden(item, index)) return;
    day.ruleShadow.n += 1;
    if (item.templateId === reference) day.ruleShadow.ok += 1; else day.ruleShadow.bad += 1;
  });
  if (entry.llm) {
    day.llm += 1;
    const usage = entry.llm.usage || {};
    const input = Number(usage.input) || 0; const cached = Number(usage.cached) || 0; const output = Number(usage.output) || 0; const thinking = Number(usage.thinking) || 0;
    if (input || output) {
      day.tokens.input.push(input); day.tokens.cached.push(cached); day.tokens.output.push(output); day.tokens.thinking.push(thinking);
      if (thinking > 0) day.thinkingTurns += 1;
      day.cost += (Math.max(0, input - cached) * prices.input + cached * prices.cache + (output + thinking) * prices.output) / 1e6;
    }
    // Mô hình nhỏ chỉ đo trên lượt LLM (lượt luật đã có luật, mô hình nhỏ không thay gì).
    if (entry.intent?.templateId) addIntentMark(day, entry.intent, intentMatchMark(entry.intent.templateId, entry.chosen || entry.final));
    // Mô hình tầng (trường `cascade` của nhật ký): cũng chỉ đo trên lượt LLM; đoán OTHER (không mẫu) vẫn đếm nhóm.
    if (entry.cascade && (entry.cascade.templateId || entry.cascade.group)) {
      const chosen = entry.chosen || entry.final;
      let chosenGroup = ''; try { chosenGroup = groupOf(chosen) || ''; } catch { chosenGroup = ''; }
      addCascadeMark(day.cascade, entry.cascade, cascadeMatchMark(entry.cascade, chosen, groupOf), chosenGroup);
    }
  }
  const pre = entry.guards?.preGuard;
  if (pre) {
    day.preGuard.n += 1;
    if (pre.matched) day.preGuard.ok += 1; else day.preGuard.bad += 1;
    const decision = String(pre.decision || '?');
    day.preGuard.decisions[decision] = (day.preGuard.decisions[decision] || 0) + 1;
  }
  const gate = entry.guards?.gate;
  if (gate) {
    const template = String(entry.final || entry.chosen || '?');
    const slot = day.gate.byTemplate[template] || (day.gate.byTemplate[template] = { agree: 0, outside: 0 });
    if (gate.agree) { day.gate.agree += 1; slot.agree += 1; } else { day.gate.outside += 1; slot.outside += 1; if (gate.reason) day.gate.reasons[gate.reason] = (day.gate.reasons[gate.reason] || 0) + 1; }
  }
  if (entry.handoff) day.handoff += 1;
  if (entry.attention) day.attention += 1;
}

/** Đọc thư mục nhật ký → [{ day, entry }] (ngày lấy theo tên tệp). */
export function readDecisionLogByDay(dir, { since = '' } = {}) {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const name of readdirSync(dir).filter(item => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(item)).sort()) {
    const day = name.slice(0, 10);
    if (since && day < since) continue;
    for (const line of readFileSync(path.join(dir, name), 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try { out.push({ day, entry: JSON.parse(line) }); } catch { /* dòng ghi dở */ }
    }
  }
  return out;
}

export function summarize(items, prices = DEFAULT_PRICES, options = {}) {
  const days = {};
  for (const { day, entry } of items) addEntry(days[day] || (days[day] = emptyDay()), entry, prices, options);
  return days;
}

// --- Log journalctl cũ: dựng lại lượt từ các dòng console.log của engine ---
const MONTHS = { Jan: '01', Feb: '02', Mar: '03', Apr: '04', May: '05', Jun: '06', Jul: '07', Aug: '08', Sep: '09', Oct: '10', Nov: '11', Dec: '12' };
const RE_DAY_ISO = /^(\d{4}-\d{2}-\d{2})/;
const RE_DAY_SYSLOG = /^([A-Z][a-z]{2}) +(\d{1,2}) /;
const RE_INTENT = /Mô hình nhỏ( \(thử\))?: (\S+) \(([\d.]+), biên ([\d.]+)\) \/ thật (\S+)(?: → (\S+))? ([✓✗~])(?: \(([^)]*)\))?/u;
// "Mô hình tầng (thử): PRICE 0.97 / PRICE_QUOTE 0.88 (biên 0.60) / thật GENERAL_INFO ✓ (c1)" — dấu: ✓ ✗ ~ nhóm✓.
const RE_CASCADE = /Mô hình tầng( \(thử\))?: (\S+) ([\d.]+) \/ (\S+) ([\d.]+) \(biên ([\d.]+)\) \/ thật (\S+)(?: → (\S+))? (nhóm✓|[✓✗~])(?: \(([^)]*)\))?/u;
const RE_RULE_SHADOW = /Luật (\S+) \(thử\): luật (\S+) \/ luật ổn định (\S+) ([✓✗])/u;
const RE_RULE = /Luật (\S+)( \(thử\))? → (\S+)(?: \(([^)]*)\))?/u;
const RE_TOKEN = /Token (\S+): vào (\d+|\?) \(cache (\d+)\) · ra (\d+|\?) · suy nghĩ (\d+)/u;
const RE_SKIP = /skipped: '([^']+)'/u;

/**
 * Journal → [{ day, entry }] xấp xỉ: mỗi dòng "Token" là một lượt LLM; dòng "Mô hình nhỏ" ghép vào lượt LLM gần
 * nhất của cùng hội thoại (không có luật ổn định xen giữa) — cùng hội thoại mà vừa có "Luật X → T" thì là lượt luật.
 */
export function parseJournal(text, { year = new Date().getFullYear() } = {}) {
  const items = [];
  const lastRuleByConversation = new Map();
  // Dòng "Mô hình nhỏ" vừa kết luận lượt luật/LLM cho hội thoại nào (dòng "Mô hình tầng" đi ngay sau dùng lại).
  const lastIntentTurn = new Map();
  let lineNo = 0;
  for (const raw of String(text || '').split('\n')) {
    lineNo += 1;
    const line = raw.trim();
    if (!line) continue;
    const iso = line.match(RE_DAY_ISO);
    const syslog = line.match(RE_DAY_SYSLOG);
    const day = iso ? iso[1] : syslog ? `${year}-${MONTHS[syslog[1]] || '01'}-${syslog[2].padStart(2, '0')}` : 'không-rõ-ngày';
    const token = line.match(RE_TOKEN);
    if (token) {
      items.push({ day, entry: { llm: { templateId: '', usage: { input: Number(token[2]) || 0, cached: Number(token[3]) || 0, output: Number(token[4]) || 0, thinking: Number(token[5]) || 0 } }, final: '' } });
      continue;
    }
    const shadow = line.match(RE_RULE_SHADOW);
    if (shadow) { items.push({ day, entry: { shadow: [{ name: shadow[1], templateId: shadow[2] }], rule: { name: 'ổn định', templateId: shadow[3] }, final: shadow[3], journalShadowOnly: true } }); continue; }
    const rule = line.match(RE_RULE);
    if (rule) {
      if (!rule[2]) lastRuleByConversation.set(rule[4] || '', lineNo);
      items.push({ day, entry: { rule: rule[2] ? null : { name: rule[1], templateId: rule[3] }, shadow: rule[2] ? [{ name: rule[1], templateId: rule[3] }] : [], final: rule[3], journalRuleOnly: true } });
      continue;
    }
    const intent = line.match(RE_INTENT);
    if (intent) {
      const conversationId = intent[8] || '';
      const ruleLine = lastRuleByConversation.get(conversationId);
      const ruleTurn = ruleLine !== undefined && lineNo - ruleLine <= 40;
      if (ruleTurn) lastRuleByConversation.delete(conversationId);
      lastIntentTurn.set(conversationId, { lineNo, ruleTurn });
      items.push({ day, entry: { intent: { templateId: intent[2], p: Number(intent[3]), margin: Number(intent[4]) }, chosen: intent[5], final: intent[6] || intent[5], llm: ruleTurn ? null : { templateId: intent[5] }, journalIntentOnly: true } });
      continue;
    }
    const cascade = line.match(RE_CASCADE);
    if (cascade) {
      const conversationId = cascade[10] || '';
      const recentIntent = lastIntentTurn.get(conversationId);
      let ruleTurn;
      if (recentIntent && lineNo - recentIntent.lineNo <= 3) ruleTurn = recentIntent.ruleTurn;
      else {
        const ruleLine = lastRuleByConversation.get(conversationId);
        ruleTurn = ruleLine !== undefined && lineNo - ruleLine <= 40;
        if (ruleTurn) lastRuleByConversation.delete(conversationId);
      }
      items.push({ day, entry: { cascade: { group: cascade[2], pGroup: Number(cascade[3]), templateId: cascade[4], p: Number(cascade[5]), margin: Number(cascade[6]) }, mark: cascade[9], chosen: cascade[7], final: cascade[8] || cascade[7], llm: ruleTurn ? null : { templateId: cascade[7] }, journalCascadeOnly: true } });
      continue;
    }
    const skip = line.match(RE_SKIP);
    if (skip) items.push({ day, entry: { skipped: skip[1] } });
  }
  return items;
}

/** Tổng hợp journal: dòng "Token" đếm lượt LLM/token; dòng "Luật" đếm luật; dòng "Mô hình nhỏ" / "Mô hình tầng" chỉ đếm mô hình (không cộng vào lượt). */
export function summarizeJournal(items, prices = DEFAULT_PRICES) {
  const days = {};
  for (const { day, entry } of items) {
    const stats = days[day] || (days[day] = emptyDay());
    if (entry.journalCascadeOnly) {
      // Dấu đã có sẵn trong dòng log (engine tính bằng groupOf thật); nhóm của mẫu thật (đếm ✗ nguy hiểm) cần mô-đun tầng, thiếu thì bỏ qua.
      if (entry.llm) { let chosenGroup = ''; try { chosenGroup = defaultGroupOf(entry.chosen) || ''; } catch { chosenGroup = ''; } addCascadeMark(stats.cascade, entry.cascade, entry.mark, chosenGroup); }
      continue;
    }
    if (entry.journalIntentOnly) {
      if (!entry.llm) continue;
      addIntentMark(stats, entry.intent, intentMatchMark(entry.intent.templateId, entry.chosen));
      continue;
    }
    if (entry.journalRuleOnly || entry.journalShadowOnly) {
      // Lượt = luật ổn định bắt (dòng "Luật X → T") hay lượt LLM (dòng "Token"); dòng luật thử / so luật thử không phải lượt riêng.
      if (entry.rule && !entry.journalShadowOnly) { stats.turns += 1; stats.ruleStable += 1; }
      // "Luật X (thử): luật A / luật ổn định B ✓" = luật thử so luật ổn định; "Luật X (thử) → T" = luật chạy ẩn (không so được).
      for (const shadow of entry.shadow || []) {
        if (entry.journalShadowOnly) { stats.ruleShadow.n += 1; if (shadow.templateId === entry.rule.templateId) stats.ruleShadow.ok += 1; else stats.ruleShadow.bad += 1; }
        else stats.ruleHidden.n += 1;
      }
      continue;
    }
    addEntry(stats, entry, prices);
  }
  return days;
}

const mean = list => (list.length ? list.reduce((sum, value) => sum + value, 0) / list.length : 0);
const median = list => { if (!list.length) return 0; const sorted = [...list].sort((a, b) => a - b); const mid = Math.floor(sorted.length / 2); return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2; };
const pct = (num, den) => (den ? `${Math.round(100 * num / den)}%` : '–');
const okBad = bucket => (bucket.n ? (bucket.ok + bucket.bad ? `${bucket.ok}✓/${bucket.bad}✗` : `${bucket.n} (không so được)`) : '–');

export function formatReport(days) {
  const lines = [];
  // Cột mô hình tầng để cuối (nhóm ✓/✗ trên lượt LLM; mẫu ✓/✗ theo ngưỡng p) — các cột cũ giữ nguyên vị trí.
  const header = ['Ngày', 'Lượt', 'LLM', 'Bỏ qua', 'Luật ổn', 'Luật ổn định (ẩn)', 'Luật thử', 'Nhỏ≥0,7', 'Nhỏ≥0,8', 'Nhỏ≥0,9', 'Gác trước', 'Gác agree/ngoài', 'Token TB vào/cache/ra/nghĩ', 'Median vào/ra', '%nghĩ', 'USD', 'Tầng nhóm', 'Tầng≥0,7', 'Tầng≥0,8', 'Tầng≥0,9'];
  lines.push(header.join(' | '));
  const total = emptyDay();
  for (const [day, stats] of Object.entries(days).sort()) {
    lines.push(rowOf(day, stats));
    total.turns += stats.turns; total.llm += stats.llm; total.ruleStable += stats.ruleStable; total.cost += stats.cost; total.thinkingTurns += stats.thinkingTurns; total.handoff += stats.handoff; total.attention += stats.attention;
    for (const key of Object.keys(stats.skipped)) total.skipped[key] = (total.skipped[key] || 0) + stats.skipped[key];
    for (const key of ['n', 'ok', 'bad']) { total.ruleHidden[key] += stats.ruleHidden[key]; total.ruleShadow[key] += stats.ruleShadow[key]; total.preGuard[key] += stats.preGuard[key]; }
    for (const t of THRESHOLDS) for (const key of ['n', 'ok', 'bad']) total.intent[String(t)][key] += stats.intent[String(t)][key];
    for (const key of ['n', 'ok', 'bad', 'danger']) total.cascade.group[key] += stats.cascade.group[key];
    for (const t of THRESHOLDS) for (const key of ['n', 'ok', 'bad']) total.cascade.tpl[String(t)][key] += stats.cascade.tpl[String(t)][key];
    for (const [group, slot] of Object.entries(stats.cascade.byGroup)) { const target = total.cascade.byGroup[group] || (total.cascade.byGroup[group] = { n: 0, groupOk: 0, tplOk: 0, tplBad: 0, danger: 0 }); for (const key of ['n', 'groupOk', 'tplOk', 'tplBad', 'danger', 'refused']) if (slot[key]) target[key] = (target[key] || 0) + slot[key]; }
    total.gate.agree += stats.gate.agree; total.gate.outside += stats.gate.outside;
    for (const key of Object.keys(stats.tokens)) total.tokens[key].push(...stats.tokens[key]);
    for (const [template, slot] of Object.entries(stats.gate.byTemplate)) { const target = total.gate.byTemplate[template] || (total.gate.byTemplate[template] = { agree: 0, outside: 0 }); target.agree += slot.agree; target.outside += slot.outside; }
    for (const [reason, n] of Object.entries(stats.gate.reasons)) total.gate.reasons[reason] = (total.gate.reasons[reason] || 0) + n;
  }
  if (Object.keys(days).length > 1) lines.push(rowOf('TỔNG', total));
  const skipped = Object.entries(total.skipped).sort((a, b) => b[1] - a[1]);
  if (skipped.length) lines.push(`Bỏ qua theo lý do: ${skipped.map(([reason, n]) => `${reason} ×${n}`).join(' · ')}`);
  const gateTemplates = Object.entries(total.gate.byTemplate).sort((a, b) => (b[1].agree + b[1].outside) - (a[1].agree + a[1].outside));
  if (gateTemplates.length) lines.push(`Người gác theo mẫu (agree/ngoài): ${gateTemplates.slice(0, 15).map(([template, slot]) => `${template} ${slot.agree}/${slot.outside}`).join(' · ')}`);
  const reasons = Object.entries(total.gate.reasons).sort((a, b) => b[1] - a[1]);
  if (reasons.length) lines.push(`Người gác "ngoài" theo lý do: ${reasons.map(([reason, n]) => `${reason} ×${n}`).join(' · ')}`);
  if (total.handoff || total.attention) lines.push(`Chuyển người: ${total.handoff} · thẻ cần người xem: ${total.attention}`);
  const cascadeGroups = Object.entries(total.cascade.byGroup).sort((a, b) => b[1].n - a[1].n);
  if (cascadeGroups.length) lines.push(`Mô hình tầng theo nhóm (lượt LLM): ${cascadeGroups.map(([group, slot]) => `${group} ${slot.n} (nhóm ${pct(slot.groupOk, slot.n)}, mẫu ${slot.tplOk}✓/${slot.tplBad}✗${slot.refused ? `, không mẫu ${slot.refused}` : ''}${slot.danger ? `, ⚠${slot.danger} vào ORDER/SUPPORT` : ''})`).join(' · ')}`);
  if (total.cascade.group.danger) lines.push(`Mô hình tầng ✗ nguy hiểm (thật là ORDER/SUPPORT mà tầng đoán nhóm khác): ${total.cascade.group.danger}`);
  return lines.join('\n');
  function rowOf(day, stats) {
    const skippedTotal = Object.values(stats.skipped).reduce((sum, n) => sum + n, 0);
    const tokens = `${Math.round(mean(stats.tokens.input))}/${Math.round(mean(stats.tokens.cached))}/${Math.round(mean(stats.tokens.output))}/${Math.round(mean(stats.tokens.thinking))}`;
    const medians = `${Math.round(median(stats.tokens.input))}/${Math.round(median(stats.tokens.output))}`;
    return [day, stats.turns, stats.llm, skippedTotal, stats.ruleStable, okBad(stats.ruleHidden), okBad(stats.ruleShadow), ...THRESHOLDS.map(t => okBad(stats.intent[String(t)])), okBad(stats.preGuard), `${stats.gate.agree}/${stats.gate.outside}`, tokens, medians, pct(stats.thinkingTurns, stats.tokens.input.length), stats.cost.toFixed(3),
      // Cột nhóm: "2✓/1✗ ⚠1" — ⚠ là số ✗ rơi vào ORDER/SUPPORT (nguy hiểm nếu bật tự trả lời).
      `${okBad(stats.cascade.group)}${stats.cascade.group.danger ? ` ⚠${stats.cascade.group.danger}` : ''}`, ...THRESHOLDS.map(t => okBad(stats.cascade.tpl[String(t)]))].join(' | ');
  }
}

/** Lỗi CLI: in gọn, thoát 1 (không stack). */
function fail(message) { console.error(message); process.exit(1); }

function main() {
  const args = process.argv.slice(2);
  const valueFlags = ['--since', '--dir', '--journal', '--year', '--price-in', '--price-cache', '--price-out'];
  for (let i = 0; i < args.length; i += 1) if (valueFlags.includes(args[i]) && (args[i + 1] === undefined || args[i + 1] === '' || args[i + 1].startsWith('--'))) fail(`Thiếu giá trị cho ${args[i]}.`);
  const value = (flag, fallback) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : fallback);
  const number = (flag, fallback) => { const raw = value(flag, String(fallback)); const parsed = Number(raw); if (raw === '' || !Number.isFinite(parsed) || parsed < 0) fail(`${flag} phải là số không âm (nhận "${raw}").`); return parsed; };
  const prices = { input: number('--price-in', DEFAULT_PRICES.input), cache: number('--price-cache', DEFAULT_PRICES.cache), output: number('--price-out', DEFAULT_PRICES.output) };
  const since = value('--since', '');
  if (since && !/^\d{4}-\d{2}-\d{2}$/.test(since)) fail(`--since sai định dạng "${since}" (cần YYYY-MM-DD).`);
  const journal = value('--journal', '');
  let days;
  if (journal) {
    if (!existsSync(journal)) fail(`Không thấy tệp journal: ${journal}`);
    const year = number('--year', new Date().getFullYear());
    const items = parseJournal(readFileSync(journal, 'utf8'), { year });
    days = summarizeJournal(items.filter(item => !since || item.day >= since), prices);
    console.log(`Journal ${journal}: ${items.length} dòng nhận ra (lượt LLM đếm theo dòng "Token"; mô hình nhỏ ghép theo hội thoại).`);
  } else {
    const dir = value('--dir', path.join(root, 'data', 'processed', 'decision-log'));
    const items = readDecisionLogByDay(dir, { since });
    if (!items.length) { console.log(`Không có nhật ký quyết định ở ${dir}${since ? ` từ ${since}` : ''}.`); return; }
    days = summarize(items, prices);
  }
  if (args.includes('--json')) { console.log(JSON.stringify(days)); return; }
  console.log(`Giá (USD/1M token): vào ${prices.input} · cache ${prices.cache} · ra+suy nghĩ ${prices.output}`);
  console.log(formatReport(days));
}

const isMain = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isMain) main();
