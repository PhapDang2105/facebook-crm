// Đo suy luận địa chỉ bằng AI trên các đơn landing thật mà bộ đọc luật không
// tách đủ ba cấp. Không ghi vào cache vận hành: kết quả nằm ở file do
// ADDRESS_AI_CACHE_PATH chỉ định (mặc định logs/address-ai-measure.json).
//
//   set VERTEX_ACCESS_TOKEN=<gcloud auth print-access-token>
//   set GOOGLE_CLOUD_PROJECT=<project id>
//   node scripts/measure-address-ai.mjs [--no-search] [--limit=20]
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.env.ADDRESS_AI_CACHE_PATH ||= path.join(projectRoot, 'logs', 'address-ai-measure.json');

const { normalizeChatbotSettings } = await import('../app/chatbot-settings.mjs');
const { inferAddress, flushAddressAiCache } = await import('../app/processing/address-ai.mjs');
const { resolveAddress } = await import('../app/processing/locations.mjs');

const args = process.argv.slice(2);
const noSearch = args.includes('--no-search');
const limit = Number((args.find(arg => arg.startsWith('--limit=')) || '').split('=')[1]) || Infinity;
const offset = Number((args.find(arg => arg.startsWith('--offset=')) || '').split('=')[1]) || 0;

let stored = {};
try { stored = JSON.parse(await readFile(path.join(projectRoot, 'data', 'processed', 'chatbot-settings.json'), 'utf8')); } catch { /* chưa có cấu hình: dùng mặc định */ }
const settings = normalizeChatbotSettings({ ...stored, directApiKey: '', addressAi: true, addressAiSearch: !noSearch });
if (settings.provider !== 'vertex') throw new Error('Chatbot đang không dùng Vertex; script này chỉ đo với Gemini trên Vertex.');

const landing = JSON.parse(await readFile(path.join(projectRoot, 'data', 'processed', 'landing-orders.json'), 'utf8'));
const orders = Array.isArray(landing) ? landing : Object.values(landing).find(Array.isArray) || [];
const seen = new Set();
const cases = [];
for (const order of orders) {
  const address = String(order.rawAddress || order.address || '').trim();
  if (!address || /^chưa có địa chỉ$/i.test(address)) continue;
  const resolved = resolveAddress(address);
  if (!['none', 'partial'].includes(resolved.confidence)) continue;
  const key = address.toLowerCase();
  if (seen.has(key)) continue;
  seen.add(key);
  cases.push({ address, before: resolved.confidence });
  if (cases.length >= offset + limit) break;
}

cases.splice(0, offset);
console.log(`Đo ${cases.length} địa chỉ (tra cứu Google Search: ${noSearch ? 'tắt' : 'bật'}), model ${settings.directModel}\n`);
const tally = { resolved: 0, rejected: 0, error: 0 };
const started = Date.now();
for (const item of cases) {
  const t0 = Date.now();
  const outcome = await inferAddress(item.address, { settings, explain: true, force: true });
  const ms = Date.now() - t0;
  if (outcome?.canonical) {
    tally.resolved += 1;
    console.log(`✔ [${item.before}] "${item.address}"\n    → ${outcome.canonical}\n    ${outcome.reason}${outcome.sources?.length ? `\n    nguồn: ${outcome.sources.slice(0, 2).join(' ')}` : ''}  (${ms} ms)`);
  } else if (outcome?.error) {
    tally.error += 1;
    console.log(`✖ [${item.before}] "${item.address}"\n    lỗi: ${outcome.error}  (${ms} ms)`);
  } else {
    tally.rejected += 1;
    const guess = outcome?.guess ? `${outcome.guess.ward || '?'}, ${outcome.guess.district || '?'}, ${outcome.guess.province || '?'} (ambiguous=${outcome.guess.ambiguous === true})` : 'không có JSON';
    console.log(`– [${item.before}] "${item.address}"\n    không nhận: ${outcome?.rejected || 'không rõ'} · mô hình đề xuất: ${guess}  (${ms} ms)`);
  }
}
await flushAddressAiCache();
console.log(`\nKết quả: khớp danh mục ${tally.resolved}/${cases.length}, từ chối ${tally.rejected}, lỗi ${tally.error}, tổng ${Math.round((Date.now() - started) / 1000)} giây.`);
