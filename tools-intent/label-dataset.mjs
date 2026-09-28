// Gán nhãn LLM cho dataset: gọi Gemini ĐÚNG như đường trả lời thật (engine.requestDirectModelReply, prompt/cache/
// thinking đang cài, rawResponse, không few-shot) cho từng dòng chưa có nhãn chắc (labelSource ∉ {rule, staff}).
// Cache theo id ở data/processed/llm-labels.json kèm promptVersion (hash system prompt đã ghép mẫu): đổi prompt
// thì gán lại từ đầu; chạy lại thì bỏ qua dòng đã có nhãn (dòng lỗi được thử lại). Ghi cache sau mỗi 20 dòng.
// Lỗi 429 / quá tải / mạng (fetch failed, HeadersTimeout) thử lại 3 lần rồi ghi lỗi và ĐI TIẾP.
// Dùng (máy chủ): node --env-file=.env tools-intent/label-dataset.mjs <in.jsonl> <labels.jsonl> [--only-drift] [--limit N] [--concurrency 2]
// Không gửi gì cho khách.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { POLICY_DRIFT, readJsonl, toJsonl } from './dataset-context.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Băm FNV-1a (cùng cách engine băm prompt cho cache Vertex) — đổi prompt/mẫu là đổi promptVersion. */
export function hashText(text) {
  let hash = 2166136261;
  const value = String(text || '');
  for (let i = 0; i < value.length; i += 1) { hash ^= value.charCodeAt(i); hash = Math.imul(hash, 16777619) >>> 0; }
  return hash.toString(16);
}

/** Dòng cần LLM gán: chưa có nhãn chắc (rule/staff); --only-drift thì chỉ nhãn thuộc POLICY_DRIFT. */
export function needsLlmLabel(row, { onlyDrift = false } = {}) {
  if (['rule', 'staff'].includes(row.labelSource) || row.corrected) return false;
  if (onlyDrift && !POLICY_DRIFT.has(row.label)) return false;
  return Boolean(String(row.text || '').trim());
}

/** Lỗi tạm (hết hạn mức, quá tải, mạng, hết giờ): đáng thử lại. */
export const isTransientError = error => /429|503|resource exhausted|overloaded|fetch failed|headerstimeout|bodytimeout|und_err|etimedout|econnreset|timeout|socket hang up/i.test(String(error?.message || error));

/** Đọc/ghi cache; cache của promptVersion khác bị bỏ (giữ lại ở `stale` để đối chiếu, không dùng). */
export function loadCache(cachePath, promptVersion) {
  const empty = { promptVersion, items: {} };
  if (!existsSync(cachePath)) return empty;
  try {
    const cache = JSON.parse(readFileSync(cachePath, 'utf8'));
    if (cache.promptVersion === promptVersion && cache.items) return cache;
    return { ...empty, stale: { promptVersion: cache.promptVersion, count: Object.keys(cache.items || {}).length } };
  } catch { return empty; }
}

/**
 * Gán nhãn một lô dòng bằng `callModel(row)` (async → { raw, label }) với hàng đợi `concurrency`, cache theo id,
 * `flush()` sau mỗi 20 kết quả. Trả về số dòng đã gọi / lỗi.
 */
export async function labelRows(rows, { cache, callModel, concurrency = 2, retries = 3, wait = ms => new Promise(resolve => setTimeout(resolve, ms)), flush = () => {}, log = () => {} }) {
  const queue = rows.filter(row => !cache.items[row.id]?.label);
  const stats = { total: rows.length, cached: rows.length - queue.length, called: 0, errors: 0 };
  let done = 0;
  const worker = async () => {
    for (;;) {
      const row = queue.shift();
      if (!row) return;
      let result = null;
      for (let attempt = 0; attempt < retries; attempt += 1) {
        try { result = await callModel(row); break; } catch (error) {
          const transient = isTransientError(error);
          if (attempt === retries - 1 || !transient) { result = { error: String(error?.message || error).slice(0, 120) }; break; }
          await wait(4000 * 2 ** attempt * (0.5 + Math.random()));
        }
      }
      stats.called += 1;
      if (result?.error) stats.errors += 1;
      cache.items[row.id] = { ...result, at: Date.now() };
      done += 1;
      if (done % 20 === 0) { flush(); log(`${done}/${queue.length + done} · lỗi ${stats.errors}`); }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, worker));
  flush();
  return stats;
}

async function main() {
  const args = process.argv.slice(2);
  const valueFlags = new Set(['--limit', '--concurrency']);
  const positional = args.filter((arg, index) => !arg.startsWith('--') && !valueFlags.has(args[index - 1]));
  const [inPath, labelsPath] = positional;
  if (!inPath || !labelsPath) { console.log('Dùng: node --env-file=.env tools-intent/label-dataset.mjs <in.jsonl> <labels.jsonl> [--only-drift] [--limit N] [--concurrency 2]'); process.exit(1); }
  const limit = args.includes('--limit') ? Number(args[args.indexOf('--limit') + 1]) : Infinity;
  const concurrency = args.includes('--concurrency') ? Number(args[args.indexOf('--concurrency') + 1]) : 2;
  const onlyDrift = args.includes('--only-drift');
  process.chdir(root);
  const load = file => import(pathToFileURL(path.join(root, file)).href);
  const engine = await load('app/chatbot-engine.mjs');
  const { normalizeChatbotSettings } = await load('app/chatbot-settings.mjs');
  const { renderChatbotReply } = await load('app/chatbot-templates.mjs');
  (await load('app/processing/catalog.mjs')).reloadCatalog();
  const dataDir = process.env.CRM_DATA_DIR || path.join(root, 'data', 'processed');
  const stored = JSON.parse(readFileSync(path.join(dataDir, 'chatbot-settings.json'), 'utf8'));
  const settings = normalizeChatbotSettings({ ...stored, enabled: true });
  const promptVersion = hashText(engine.composeSystemPrompt(settings.systemPrompt, settings.messageTemplates, settings.contextTrim));
  const cachePath = path.join(dataDir, 'llm-labels.json');
  const cache = loadCache(cachePath, promptVersion);
  if (cache.stale) console.log(`Cache cũ (prompt ${cache.stale.promptVersion}, ${cache.stale.count} dòng) bị bỏ: prompt hiện tại ${promptVersion}.`);
  const all = readJsonl(readFileSync(inPath, 'utf8'));
  const rows = all.filter(row => needsLlmLabel(row, { onlyDrift })).slice(0, limit);
  console.log(`${rows.length}/${all.length} dòng cần LLM${onlyDrift ? ' (chỉ nhãn lệch chính sách)' : ''} · model ${settings.directModel} · thinking ${settings.thinkingLevel || 'mặc định'} · đã có cache ${rows.filter(row => cache.items[row.id]?.label).length}`);
  const callModel = async row => {
    const at = Number(row.at) || Date.now();
    const recentMessages = [
      ...(row.prevCustomer ? [{ direction: 'incoming', type: 'text', text: row.prevCustomer, createdAt: at - 120000 }] : []),
      ...(row.prevBot ? [{ direction: 'outgoing', type: 'text', text: row.prevBot, createdAt: at - 60000 }] : [])
    ];
    const conversation = { id: 'label', name: 'Khách', source: row.source || 'inbox', botEnabled: true, botLastTemplateId: row.lastTemplate || '', botLastReplyAt: row.prevBot ? at - 60000 : 0 };
    const reply = await engine.requestDirectModelReply({ settings, conversation, message: { type: 'text', text: row.text, createdAt: at }, recentMessages, rawResponse: true, context: {}, examples: [] });
    const raw = String(reply.parsed?.template_id || '');
    let label = raw;
    // So mẫu SAU khi dựng câu: "2 túi" mà chưa rõ vị thì ORDER_ADDRESS thành ASK_FLAVOR…
    try { label = renderChatbotReply(reply.parsed || {}, settings.messageTemplates, { messageText: row.text }).templateId || raw; } catch { label = raw; }
    if (!label) throw new Error('Mô hình không trả template_id');
    return { label, raw, ...(reply.usage ? { usage: { input: reply.usage.promptTokenCount, cached: reply.usage.cachedContentTokenCount || 0, output: reply.usage.candidatesTokenCount, thinking: reply.usage.thoughtsTokenCount || 0 } } : {}) };
  };
  const flush = () => writeFileSync(cachePath, JSON.stringify({ promptVersion, model: settings.directModel, updatedAt: Date.now(), items: cache.items }));
  const stats = await labelRows(rows, { cache, callModel, concurrency, flush, log: line => console.log(line) });
  const labels = rows.map(row => {
    const item = cache.items[row.id] || {};
    return item.label ? { id: row.id, label: item.label, raw: item.raw, labelSource: 'llm' } : { id: row.id, error: item.error || 'chưa gán' };
  });
  writeFileSync(labelsPath, toJsonl(labels));
  const counts = labels.filter(item => item.label).reduce((acc, item) => { acc[item.label] = (acc[item.label] || 0) + 1; return acc; }, {});
  console.log(JSON.stringify({ ...stats, promptVersion, top: Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 12) }));
}

const isMain = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isMain) await main();
