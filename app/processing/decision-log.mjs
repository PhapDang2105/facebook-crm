// Nhật ký quyết định của bot: mỗi lượt trả lời (kể cả khi bỏ qua) ghi một dòng JSONL vào
// data/processed/decision-log/YYYY-MM-DD.jsonl (ngày theo giờ Việt Nam). Đây là nguồn dữ liệu
// để đo độ chính xác luật / mô hình nhỏ / LLM và huấn luyện lại về sau — thay cho việc đoán lại
// ngữ cảnh từ kho tin nhắn. Ghi nối tiếp qua hàng đợi promise (không chặn lượt trả lời); SĐT
// trong mọi chuỗi được che thành <sdt>; trường `text` cắt 400 ký tự; tệp cũ hơn 45 ngày tự xóa
// ở lần ghi đầu tiên mỗi ngày. Lỗi ghi chỉ console.warn, không làm hỏng lượt trả lời.
import { appendFile, mkdir, readdir, unlink } from 'node:fs/promises';
import path from 'node:path';
import { projectRoot } from '../config.mjs';

export const defaultDecisionLogDir = process.env.DECISION_LOG_DIR || path.join(projectRoot, 'data', 'processed', 'decision-log');
export const decisionLogKeepDays = 45;
const vnOffsetMs = 7 * 60 * 60 * 1000;
const textLimit = 400;

// SĐT Việt Nam (0xxx / +84xxx, có thể có dấu cách, chấm, gạch): che trước khi ghi.
const phonePattern = /(\+?84|0)\d[\d .-]{7,9}\d/g;

/** Che SĐT trong một chuỗi. */
export function maskPhones(value) {
  return String(value ?? '').replace(phonePattern, '<sdt>');
}

/** Ngày YYYY-MM-DD theo giờ Việt Nam (UTC+7) của mốc thời gian. */
export function vnDateKey(at = Date.now()) {
  return new Date((Number(at) || Date.now()) + vnOffsetMs).toISOString().slice(0, 10);
}

/** Bản ghi đã làm sạch: mọi chuỗi che SĐT, trường `text` (ở mọi cấp) cắt ≤ 400 ký tự. */
export function sanitizeRecord(value, key = '') {
  if (typeof value === 'string') {
    const masked = maskPhones(value);
    return key === 'text' && masked.length > textLimit ? masked.slice(0, textLimit) : masked;
  }
  if (Array.isArray(value)) return value.map(item => sanitizeRecord(item));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, sanitizeRecord(item, name)]));
  }
  if (typeof value === 'number' && !Number.isFinite(value)) return null;
  return value === undefined ? null : value;
}

// Hàng đợi ghi và ngày đã dọn tệp cũ, theo từng thư mục (test dùng thư mục tạm riêng).
const queues = new Map();
const prunedDay = new Map();

async function pruneOldFiles(dir, now) {
  const names = await readdir(dir).catch(() => []);
  const threshold = vnDateKey(now - decisionLogKeepDays * 24 * 60 * 60 * 1000);
  for (const name of names) {
    const match = name.match(/^(\d{4}-\d{2}-\d{2})\.jsonl$/);
    if (match && match[1] < threshold) await unlink(path.join(dir, name)).catch(() => {});
  }
}

/**
 * Ghi một bản ghi (một dòng JSON) vào tệp của ngày hiện tại. Trả promise của lần ghi này —
 * engine không đợi; test đợi để đọc lại. Không bao giờ ném lỗi.
 */
export function appendDecisionLog(record, { dir = defaultDecisionLogDir, now = Date.now() } = {}) {
  const previous = queues.get(dir) || Promise.resolve();
  const run = previous.catch(() => {}).then(async () => {
    const day = vnDateKey(now);
    await mkdir(dir, { recursive: true });
    if (prunedDay.get(dir) !== day) {
      prunedDay.set(dir, day);
      await pruneOldFiles(dir, now);
    }
    const line = JSON.stringify(sanitizeRecord(record));
    await appendFile(path.join(dir, `${day}.jsonl`), `${line}\n`, 'utf8');
  }).catch(error => {
    console.warn(`Nhật ký quyết định: không ghi được (${String(error?.message || error).slice(0, 120)})`);
  });
  queues.set(dir, run);
  return run;
}

/** Đợi mọi lần ghi đang chờ xong (dùng khi tắt máy chủ / trong test). */
export function flushDecisionLog(dir = defaultDecisionLogDir) {
  return queues.get(dir) || Promise.resolve();
}
