// Đọc/ghi kho JSON dùng chung cho các kho nhỏ (landing, tệp khách, cảnh báo SĐT…).
//
// Vì sao cần: trước đây mỗi kho tự `try { JSON.parse(readFile) } catch { kho rỗng }`.
// Một lần đọc lỗi (JSON cắt dở, EACCES, EMFILE, sửa tay hỏng) thành "kho rỗng"
// được nhớ lại, và lần ghi kế tiếp đè tệp thật bằng kho rỗng → mất sạch dữ liệu.
// Quy tắc ở đây (cùng mẫu đã có ở qr-scans / qr-settings / messaging-store):
//  - Chưa có tệp (ENOENT)       → giá trị mặc định.
//  - Tệp có mà nội dung hỏng    → cất bản hỏng sang `<tệp>.corrupt-<mốc>` để còn cứu,
//                                 log lỗi, rồi trả mặc định (lần ghi sau không đè mất gì).
//  - Lỗi đọc khác (EBUSY, EACCES, EMFILE…) → NÉM lỗi: người gọi không được coi là kho rỗng.
import { readFileSync, renameSync } from 'node:fs';
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import path from 'node:path';

const isPlainObject = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

/**
 * Đọc một tệp JSON theo quy tắc trên.
 * - `fallback`: giá trị (hoặc hàm trả giá trị) dùng khi chưa có tệp / tệp hỏng.
 * - `expect`: 'object' (mặc định), 'array' hoặc 'any' — JSON hợp lệ nhưng sai kiểu
 *   (ví dụ `null`, mảng thay cho object) cũng coi là hỏng.
 * - `normalize`: hàm chuẩn hoá giá trị đọc được; ném lỗi thì cũng coi là hỏng.
 * - `label`: tên kho cho dòng log (tiếng Việt).
 */
export async function readJsonFile(filePath, options = {}) {
  let raw;
  try {
    raw = await readFile(filePath, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return fallbackOf(options);
    throw readFailure(filePath, options, error);
  }
  return parseOrQuarantine(filePath, raw, options, () => quarantineJsonFile(filePath));
}

/** Như readJsonFile nhưng đồng bộ (tệp khoá nhỏ đọc lúc khởi động, ví dụ pos-config.json). */
export function readJsonFileSync(filePath, options = {}) {
  let raw;
  try {
    raw = readFileSync(filePath, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return fallbackOf(options);
    throw readFailure(filePath, options, error);
  }
  return parseOrQuarantine(filePath, raw, options, () => {
    const target = `${filePath}.corrupt-${Date.now()}`;
    try { renameSync(filePath, target); return target; } catch { return ''; }
  });
}

function fallbackOf({ fallback = null } = {}) {
  return typeof fallback === 'function' ? fallback() : fallback;
}

function readFailure(filePath, { label = '' } = {}, error) {
  const failure = new Error(`Không đọc được ${label || path.basename(filePath)} (${error?.code || error?.message || error}); không dùng kho rỗng để tránh ghi đè dữ liệu thật.`);
  failure.code = error?.code;
  failure.cause = error;
  return failure;
}

function parseOrQuarantine(filePath, raw, options, quarantine) {
  const { expect = 'object', normalize = value => value, label = '' } = options;
  let value;
  let problem = null;
  try {
    // Tệp sửa tay bằng Notepad có thể mang BOM.
    const parsed = JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw);
    if (expect === 'object' && !isPlainObject(parsed)) throw new Error('không phải object JSON');
    if (expect === 'array' && !Array.isArray(parsed)) throw new Error('không phải mảng JSON');
    value = normalize(parsed);
  } catch (error) {
    problem = error;
  }
  if (!problem) return value;
  const report = quarantined => {
    console.error(`${label || path.basename(filePath)} hỏng (${problem?.message || problem})${quarantined ? `, đã cất sang ${path.basename(quarantined)}` : ''}; bắt đầu lại từ mặc định.`);
    return fallbackOf(options);
  };
  const moved = quarantine();
  return moved && typeof moved.then === 'function' ? moved.then(report) : report(moved);
}

/** Đổi tên tệp hỏng sang `<tệp>.corrupt-<mốc>`; trả đường dẫn mới, hoặc '' nếu không đổi được (tệp vừa biến mất…). */
export async function quarantineJsonFile(filePath, now = Date.now()) {
  const target = `${filePath}.corrupt-${now}`;
  try {
    await rename(filePath, target);
    return target;
  } catch {
    return '';
  }
}

let temporaryCounter = 0;

/**
 * Ghi nguyên tử: tệp tạm (tên riêng theo tiến trình, để script bảo trì chạy song
 * song không dẫm nhau) → fsync → rename đè tệp thật. Sự cố giữa chừng chỉ để lại
 * tệp tạm, tệp thật vẫn là bản cũ nguyên vẹn. `space` = thụt lề JSON (mặc định 2,
 * như các kho đang có); truyền chuỗi đã dựng sẵn qua `text` nếu cần; `mode` = quyền
 * tệp mới (ví dụ 0o600 cho tệp khoá).
 */
export async function writeJsonAtomic(filePath, value, { space = 2, text, mode } = {}) {
  const content = text ?? JSON.stringify(value, null, space);
  await mkdir(path.dirname(filePath), { recursive: true });
  temporaryCounter = (temporaryCounter + 1) % 1_000_000;
  const temporaryPath = `${filePath}.${process.pid}-${temporaryCounter}.tmp`;
  let handle;
  try {
    handle = await open(temporaryPath, 'w', mode);
    await handle.writeFile(content, 'utf8');
    await handle.sync();
    await handle.close();
    handle = null;
    await rename(temporaryPath, filePath);
  } catch (error) {
    if (handle) await handle.close().catch(() => {});
    await unlink(temporaryPath).catch(() => {});
    throw error;
  }
}

// Mọi hàng ghi đang có việc (để lúc tắt máy chủ chờ ghi xong hết — drainAllWrites).
const busyQueues = new Set();

/**
 * Hàng ghi tuần tự cho một kho: `queue(fn)` chạy fn sau mọi lượt trước đó; lỗi
 * của một lượt không chặn các lượt sau. Trả promise kết quả của fn.
 */
export function createWriteQueue() {
  let tail = Promise.resolve();
  let pending = 0;
  const handle = { tail: () => tail };
  return function enqueue(task) {
    pending += 1;
    busyQueues.add(handle);
    const operation = tail.then(task);
    tail = operation.then(() => undefined, () => undefined).finally(() => {
      pending -= 1;
      if (!pending) busyQueues.delete(handle);
    });
    return operation;
  };
}

/**
 * Chờ mọi lượt ghi đã xếp ở MỌI hàng (createWriteQueue) chạy xong — kể cả lượt mà chính các lượt đó
 * xếp thêm. Dùng lúc tắt máy chủ: đơn landing / tệp khách / cài đặt vừa nhận không mất vì process.exit.
 * Không ném (lỗi ghi đã được báo cho người gọi lượt đó). `timeoutMs`: thôi chờ sau quãng này.
 */
export async function drainAllWrites({ timeoutMs = 8000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while ((busyQueues.size || trackedWrites.size) && Date.now() < deadline) {
    const waits = [...[...busyQueues].map(handle => handle.tail()), ...trackedWrites];
    let timer;
    const timeout = new Promise(resolve => { timer = setTimeout(resolve, Math.max(0, deadline - Date.now())); });
    await Promise.race([Promise.all(waits), timeout]);
    clearTimeout(timer);
  }
  return busyQueues.size === 0 && trackedWrites.size === 0;
}

// Lượt ghi lẻ không đi qua hàng (nối dòng vào kho lưu trữ đơn…): drainAllWrites cũng chờ.
const trackedWrites = new Set();

/** Ghi danh một lượt ghi đang chạy để drainAllWrites chờ nó. Trả lại chính promise đó (lỗi vẫn tới người gọi). */
export function trackWrite(promise) {
  const settled = Promise.resolve(promise).then(() => undefined, () => undefined);
  trackedWrites.add(settled);
  settled.then(() => trackedWrites.delete(settled));
  return promise;
}

/** Số hàng ghi / lượt ghi lẻ còn đang có việc (cho test / chẩn đoán). */
export function pendingWriteQueues() {
  return busyQueues.size + trackedWrites.size;
}
