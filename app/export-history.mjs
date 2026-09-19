// Lịch sử xuất kho: mỗi lần bấm Xuất XLSX ghi một dòng (lúc xuất, ngày đơn
// được chọn, số đơn, số dòng, có bỏ đơn chưa chuẩn không) và giữ chính tệp
// XLSX đã tải để tải lại. Nhẹ: chỉ vài trăm byte mỗi dòng cộng tệp vài chục
// KB; tự xoá sau 14 ngày (khi ghi và khi đọc), không ai phải dọn tay.
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { projectRoot } from './config.mjs';

const historyPath = process.env.EXPORT_HISTORY_PATH || path.join(projectRoot, 'data', 'processed', 'export-history.json');
const filesDirectory = process.env.EXPORT_FILES_DIR || path.join(projectRoot, 'data', 'processed', 'exports');
export const exportHistoryTtlMs = 14 * 24 * 60 * 60 * 1000;

let writeQueue = Promise.resolve();

async function readHistory() {
  try {
    const parsed = JSON.parse(await readFile(historyPath, 'utf8'));
    return { items: Array.isArray(parsed?.items) ? parsed.items : [] };
  } catch {
    return { items: [] };
  }
}

async function writeHistory(store) {
  await mkdir(path.dirname(historyPath), { recursive: true });
  const temporary = `${historyPath}.tmp`;
  await writeFile(temporary, JSON.stringify(store, null, 2), 'utf8');
  await rename(temporary, historyPath);
}

/** Bỏ dòng quá 14 ngày và xoá tệp của chúng; trả về store đã gọn. */
async function prune(store, now) {
  const kept = [];
  for (const item of store.items) {
    if (now - (Number(item.at) || 0) <= exportHistoryTtlMs) { kept.push(item); continue; }
    if (item.file) await rm(path.join(filesDirectory, item.file), { force: true }).catch(() => {});
  }
  const changed = kept.length !== store.items.length;
  store.items = kept;
  return changed;
}

function update(mutate) {
  const run = writeQueue.then(async () => {
    const store = await readHistory();
    const result = await mutate(store);
    await writeHistory(store);
    return result;
  });
  writeQueue = run.catch(() => {});
  return run;
}

const publicEntry = item => ({
  id: item.id,
  at: item.at,
  day: item.day || '',
  orders: Number(item.orders) || 0,
  rows: Number(item.rows) || 0,
  skippedInvalid: Number(item.skippedInvalid) || 0,
  fileName: item.fileName || '',
  hasFile: Boolean(item.file)
});

/** Ghi một lần xuất; `buffer` là tệp XLSX đã gửi cho nhân viên. */
export async function recordExport({ day = '', orders = 0, rows = 0, skippedInvalid = 0, fileName = '', buffer = null }, now = Date.now()) {
  const id = randomUUID();
  let file = '';
  if (buffer?.length) {
    await mkdir(filesDirectory, { recursive: true });
    file = `${id}.xlsx`;
    await writeFile(path.join(filesDirectory, file), buffer);
  }
  return update(async store => {
    await prune(store, now);
    const entry = { id, at: now, day: String(day || ''), orders: Number(orders) || 0, rows: Number(rows) || 0, skippedInvalid: Number(skippedInvalid) || 0, fileName: String(fileName || ''), file };
    store.items.unshift(entry);
    return publicEntry(entry);
  });
}

/** Các lần xuất trong 14 ngày, mới nhất trước. */
export async function listExports(now = Date.now()) {
  const store = await readHistory();
  if (await prune(store, now)) await update(async fresh => { await prune(fresh, now); return null; });
  return store.items.map(publicEntry);
}

/** Tệp XLSX của một lần xuất, hoặc null khi đã hết hạn/không có. */
export async function readExportFile(id, now = Date.now()) {
  const store = await readHistory();
  const item = store.items.find(entry => entry.id === id && now - (Number(entry.at) || 0) <= exportHistoryTtlMs);
  if (!item?.file) return null;
  try {
    return { buffer: await readFile(path.join(filesDirectory, item.file)), fileName: item.fileName || item.file };
  } catch {
    return null;
  }
}
