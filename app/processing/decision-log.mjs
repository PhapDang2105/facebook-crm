// Nhật ký quyết định của bot: mỗi lượt trả lời (kể cả khi bỏ qua) ghi một dòng JSONL vào
// data/processed/decision-log/YYYY-MM-DD.jsonl (ngày theo giờ Việt Nam). Đây là nguồn dữ liệu
// để đo độ chính xác luật / mô hình nhỏ / LLM và huấn luyện lại về sau — thay cho việc đoán lại
// ngữ cảnh từ kho tin nhắn. Ghi nối tiếp qua hàng đợi promise (không chặn lượt trả lời); chuỗi
// tự do che SĐT (<sdt>), email (<email>), dãy ≥ 9 chữ số (<so>) — khóa định danh (conversationId,
// mid, mã mẫu, tên luật…) giữ nguyên; trường `text` cắt 400 ký tự; tệp cũ hơn 45 ngày tự xóa
// ở lần ghi đầu tiên mỗi ngày. Lỗi ghi chỉ console.warn, không làm hỏng lượt trả lời.
import { appendFile, mkdir, readdir, unlink } from 'node:fs/promises';
import path from 'node:path';
import { projectRoot } from '../config.mjs';

export const defaultDecisionLogDir = process.env.DECISION_LOG_DIR || path.join(projectRoot, 'data', 'processed', 'decision-log');
export const decisionLogKeepDays = 45;
const vnOffsetMs = 7 * 60 * 60 * 1000;
const textLimit = 400;

// SĐT Việt Nam: đầu 0 / 84 / +84 / "(+84)", giữa các chữ số được xen tới 3 ký tự cách/chấm/gạch (nhóm
// 2–4 số bất kỳ: "+84 912 345 678", "(+84) 912-345-678", "0912  345  678", "0912 34 56 78"). Che trước
// khi ghi. Không đứng giữa một dãy số dài hơn (psid, mốc giờ) và không bắt đầu ngay sau "số + dấu"
// (đuôi số tiền "12.090.000.000" không bị coi là SĐT); số tiền "1.250.000", "298k" giữ nguyên.
// Đúng số chữ số: di động 9 số sau 0/84, bàn 10 số (đầu 2) — để số lượng ngay sau SĐT ("0912 345 678 1 túi")
// không bị nuốt vào phần che (28/09).
const phonePattern = /(?<!\d)(?<!\d[.,])(?:\(\s*\+?84\s*\)|\+?84|0)[\s.-]{0,3}(?:2(?:[\s.-]{0,3}\d){9}|\d(?:[\s.-]{0,3}\d){8})(?!\d)/g;
const emailPattern = /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)+/gu;
// Dãy ≥ 9 chữ số liền (số tài khoản, mã khách…) còn lại sau khi che SĐT. Số tiền "298.000"/"298k" có dấu
// ngăn nên không bị che.
const longNumberPattern = /(?<!\d)\d{9,}(?!\d)/g;

// Khóa định danh (mã hội thoại, mã tin, mốc giờ, mã mẫu, tên luật/nhóm của mô hình…): giữ nguyên
// để còn nối lại với kho tin nhắn và dựng dataset. Chỉ chuỗi tự do (text, ghi chú…) mới bị che.
const identifierKeys = new Set([
  'v', 'at', 'receivedAt', 'conversationId', 'mid', 'id', 'source', 'type', 'prevBot', 'lastTemplate', 'templateId',
  'llmTemplateId', 'ruleTemplateId', 'chosen', 'final', 'also', 'fewShot', 'name', 'group', 'subGroup', 'path', 'model', 'mode', 'decision'
]);

/**
 * Che SĐT trong một chuỗi → "<sdt>". Hàm DÙNG CHUNG: nhật ký quyết định, và công cụ dựng dataset /
 * normalizeIntentText gọi lại đúng hàm này để token che lúc huấn luyện khớp lúc chạy thật.
 */
export function maskPhones(value) {
  return String(value ?? '').replace(phonePattern, '<sdt>');
}

/**
 * Che thông tin cá nhân trong chuỗi tự do: SĐT → <sdt> (maskPhones), email → <email>, dãy ≥ 9 chữ số → <so>.
 * Đây là thứ nhật ký ghi cho `text`: công cụ muốn token khớp tuyệt đối với nhật ký thì gọi hàm này.
 */
export function maskPersonal(value) {
  return maskPhones(value).replace(emailPattern, '<email>').replace(longNumberPattern, '<so>');
}

/** Ngày YYYY-MM-DD theo giờ Việt Nam (UTC+7) của mốc thời gian. */
export function vnDateKey(at = Date.now()) {
  return new Date((Number(at) || Date.now()) + vnOffsetMs).toISOString().slice(0, 10);
}

/**
 * Bản ghi đã làm sạch: chuỗi tự do che SĐT/email/dãy số dài, khóa định danh (identifierKeys) giữ
 * nguyên; trường `text` (ở mọi cấp) cắt ≤ 400 ký tự.
 */
export function sanitizeRecord(value, key = '') {
  if (typeof value === 'string') {
    if (identifierKeys.has(key)) return value;
    const masked = maskPersonal(value);
    return key === 'text' && masked.length > textLimit ? masked.slice(0, textLimit) : masked;
  }
  // Mảng chuỗi dưới khóa định danh (fewShot: danh sách mã mẫu) giữ khóa; mảng khác xét từng phần tử như chuỗi tự do.
  if (Array.isArray(value)) return value.map(item => sanitizeRecord(item, identifierKeys.has(key) ? key : ''));
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
