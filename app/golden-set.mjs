// Bộ test vàng cho chatbot: tin khách thật (đã che SĐT) kèm ngữ cảnh, mô hình/LLM gợi ý một
// mã mẫu, nhân viên chấm "mẫu đúng". Chỉ dùng để ĐO (replay, ngưỡng mô hình nhỏ), không huấn luyện.
// Lưu ở data/processed/golden-set.json: { items: [{ id, text, prevCustomer, prevBot, source,
// lastTemplate, suggested, label, labeledAt }] }.
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { projectRoot } from './config.mjs';

const goldenPath = process.env.GOLDEN_SET_PATH || path.join(projectRoot, 'data', 'processed', 'golden-set.json');
let cached = null;
let writeQueue = Promise.resolve();

export async function readGoldenSet() {
  if (cached) return cached;
  try {
    const parsed = JSON.parse(await readFile(goldenPath, 'utf8'));
    cached = { items: Array.isArray(parsed?.items) ? parsed.items : [] };
  } catch {
    cached = { items: [] };
  }
  return cached;
}

function updateGoldenSet(mutate) {
  const operation = writeQueue.then(async () => {
    const state = await readGoldenSet();
    const result = await mutate(state);
    await mkdir(path.dirname(goldenPath), { recursive: true });
    const temporary = `${goldenPath}.tmp`;
    await writeFile(temporary, JSON.stringify(state, null, 1), 'utf8');
    await rename(temporary, goldenPath);
    return result;
  });
  writeQueue = operation.then(() => undefined, () => undefined);
  return operation;
}

const text = (value, limit) => String(value || '').replace(/\s+/g, ' ').trim().slice(0, limit);

/** Nạp danh sách tin cần chấm (thêm mới theo id, giữ nhãn đã chấm). */
export async function importGoldenItems(items = []) {
  return updateGoldenSet(state => {
    const byId = new Map(state.items.map(item => [item.id, item]));
    let added = 0;
    for (const raw of Array.isArray(items) ? items : []) {
      const id = text(raw?.id, 120);
      if (!id || !text(raw?.text, 300)) continue;
      const existing = byId.get(id);
      const fresh = { id, text: text(raw.text, 300), prevCustomer: text(raw.prevCustomer, 160), prevBot: text(raw.prevBot, 240), source: raw.source === 'comment' ? 'comment' : 'inbox', lastTemplate: text(raw.lastTemplate, 60), suggested: text(raw.suggested, 60), at: Number(raw.at) || 0 };
      if (existing) Object.assign(existing, fresh, { label: existing.label || '', labeledAt: existing.labeledAt || 0 });
      else { state.items.push({ ...fresh, label: '', labeledAt: 0 }); byId.set(id, state.items.at(-1)); added += 1; }
    }
    return { added, total: state.items.length };
  });
}

/** Nhân viên chấm: `label` là mã mẫu đúng, 'SKIP' = không rõ / bỏ qua. */
export async function labelGoldenItem(id, label) {
  const clean = text(label, 60).toUpperCase().replace(/[^A-Z0-9_]/g, '');
  if (!clean) throw new Error('Thiếu mã mẫu.');
  return updateGoldenSet(state => {
    const item = state.items.find(entry => entry.id === id);
    if (!item) return null;
    item.label = clean;
    item.labeledAt = Date.now();
    return { ...item };
  });
}

/** Tóm tắt + lô tiếp theo cần chấm (chưa có nhãn), cùng thống kê gợi ý đúng/sai đã chấm. */
export async function goldenSetOverview({ batch = 10 } = {}) {
  const state = await readGoldenSet();
  const labeled = state.items.filter(item => item.label);
  const judged = labeled.filter(item => item.label !== 'SKIP');
  const agree = judged.filter(item => item.label === item.suggested).length;
  const pending = state.items.filter(item => !item.label).sort((a, b) => a.at - b.at).slice(0, batch);
  return { total: state.items.length, labeled: labeled.length, skipped: labeled.length - judged.length, agreeWithSuggestion: agree, judged: judged.length, pending };
}

/** Các mục đã chấm (không SKIP): dùng cho replay và đo mô hình nhỏ. */
export async function goldenLabeled() {
  const state = await readGoldenSet();
  return state.items.filter(item => item.label && item.label !== 'SKIP');
}
