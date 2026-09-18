// Kho lưu trữ đơn: mọi đơn đều được ghi lại — kể cả đơn khách hủy, đơn quá hẹn
// rời bảng hay đơn đã xóa — để sau này còn tra được khách là ai, số nào, mua gì,
// mấy cái, giao đi đâu.
//
// Mỗi đơn một dòng JSON (NDJSON), file chia theo tháng. Ghi là nối thêm vào cuối
// file chứ không đọc-sửa-ghi cả kho, nên một đơn sửa nhiều lần cũng chỉ tốn thêm
// một dòng và không bao giờ phải khoá file lớn. Lúc đọc, dòng sau cùng của một
// mã đơn là bản đúng. Tên khoá viết tắt vì kho ghi rất nhiều dòng: một đơn
// khoảng 200 byte, nhẹ hơn bản đầy đủ trong landing-orders.json chừng mười lần.
import { appendFile, mkdir, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { projectRoot } from './config.mjs';
import { foldVietnamese } from './processing/auto-label.mjs';

const archiveDirectory = process.env.ORDER_ARCHIVE_PATH
  || path.join(projectRoot, 'data', 'processed', 'order-archive');

const text = (value, max) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

/** Tên file theo tháng đặt đơn: 2026-09.ndjson. */
export function archiveMonth(at) {
  const date = new Date(Number(at) || Date.now());
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

/**
 * Đơn rút gọn còn đúng những gì cần để tra lại. `st` là trạng thái lúc ghi:
 * mã trạng thái xử lý (calling, confirmed, cancelled...), hoặc 'deleted' khi
 * đơn bị xóa khỏi hệ thống.
 */
export function archiveRecord(order = {}, { status = '' } = {}) {
  const items = (Array.isArray(order.products) ? order.products : []).slice(0, 20).map(item => [
    text(item?.sku || item?.name, 80),
    Math.max(1, Math.round(Number(item?.quantity) || 1)),
    Math.round(Number(item?.paidPrice) || Number(item?.price) || 0)
  ]);
  return {
    id: text(order.id, 40),
    at: Number(order.createdAt) || Date.now(),
    src: order.source === 'Landing page' ? 'LP' : order.source === 'Facebook' ? 'CB' : text(order.source, 20),
    st: text(status || order.processingStatus || '', 20),
    name: text(order.name, 120),
    phone: text(order.phone, 20),
    addr: text(order.address, 200),
    items,
    total: Math.round(Number(order.total) || 0)
  };
}

/** Ghi thêm một dòng cho đơn này. Đơn không có mã hay số điện thoại thì bỏ qua. */
export async function appendOrderToArchive(order, options = {}) {
  const record = archiveRecord(order, options);
  if (!record.id || !record.phone) return null;
  await mkdir(archiveDirectory, { recursive: true });
  await appendFile(path.join(archiveDirectory, `${archiveMonth(record.at)}.ndjson`), `${JSON.stringify(record)}\n`, 'utf8');
  archiveCache = { at: 0, promise: null };
  return record;
}

/**
 * Đọc cả kho là đọc và phân tích MỌI dòng của MỌI tháng. Hộp chi tiết khách gọi
 * tới nó mỗi lần bấm vào một dòng, nên nhớ tạm vài giây; kho chỉ ghi nối nên
 * lần ghi nào cũng tự xoá bộ nhớ tạm, không có chuyện đọc phải bản cũ.
 */
let archiveCache = { at: 0, promise: null };
const archiveCacheMs = 5000;

function readAllRecords() {
  const now = Date.now();
  if (archiveCache.promise && now - archiveCache.at < archiveCacheMs) return archiveCache.promise;
  const promise = loadArchiveRecords();
  promise.catch(() => { archiveCache = { at: 0, promise: null }; });
  archiveCache = { at: now, promise };
  return promise;
}

function recordMatches(record, needle) {
  const haystack = [record.id, record.name, record.phone, record.addr, ...(record.items || []).map(item => item[0])].join(' ');
  return foldVietnamese(haystack).includes(needle);
}

/**
 * Đọc kho, mới nhất đứng đầu. `query` tìm trong mã đơn, tên, số điện thoại,
 * địa chỉ và SKU; `months` giới hạn số file tháng gần nhất phải đọc.
 */
/** Đọc mọi tệp tháng, khử trùng theo mã đơn, mới nhất đứng đầu. */
async function loadArchiveRecords() {
  let files = [];
  try {
    files = (await readdir(archiveDirectory)).filter(name => name.endsWith('.ndjson')).sort();
  } catch {
    return [];
  }
  // Dòng sau cùng của một mã đơn là bản đúng; Map giữ đúng thứ tự ghi.
  const byId = new Map();
  for (const file of files) {
    let content = '';
    try { content = await readFile(path.join(archiveDirectory, file), 'utf8'); } catch { continue; }
    for (const line of content.split('\n')) {
      if (!line.trim()) continue;
      try {
        const record = JSON.parse(line);
        if (record && record.id) byId.set(record.id, { ...record, file });
      } catch { /* dòng hỏng thì bỏ qua, phần còn lại vẫn đọc được */ }
    }
  }
  return [...byId.values()].sort((a, b) => (Number(b.at) || 0) - (Number(a.at) || 0));
}

export async function readOrderArchive({ query = '', limit = 200, months = 0 } = {}) {
  let records = await readAllRecords();
  if (months > 0) {
    // Giới hạn theo tệp tháng như trước: mỗi bản ghi mang tên tệp nó nằm trong.
    let files = [];
    try {
      files = (await readdir(archiveDirectory)).filter(name => name.endsWith('.ndjson')).sort().slice(-months);
    } catch {
      return { items: [], total: 0 };
    }
    const wanted = new Set(files);
    records = records.filter(record => wanted.has(record.file));
  }
  const needle = foldVietnamese(text(query, 120));
  // Bỏ `file` đi: nó chỉ dùng để lọc theo tháng, không phải dữ liệu của đơn.
  const items = records
    .filter(record => !needle || recordMatches(record, needle))
    .map(({ file, ...record }) => record);
  return { items: limit > 0 ? items.slice(0, limit) : items, total: items.length };
}
