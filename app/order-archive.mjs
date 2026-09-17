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
  return record;
}

function recordMatches(record, needle) {
  const haystack = [record.id, record.name, record.phone, record.addr, ...(record.items || []).map(item => item[0])].join(' ');
  return foldVietnamese(haystack).includes(needle);
}

/**
 * Đọc kho, mới nhất đứng đầu. `query` tìm trong mã đơn, tên, số điện thoại,
 * địa chỉ và SKU; `months` giới hạn số file tháng gần nhất phải đọc.
 */
export async function readOrderArchive({ query = '', limit = 200, months = 0 } = {}) {
  let files = [];
  try {
    files = (await readdir(archiveDirectory)).filter(name => name.endsWith('.ndjson')).sort();
  } catch {
    return { items: [], total: 0 };
  }
  if (months > 0) files = files.slice(-months);
  // Dòng sau cùng của một mã đơn là bản đúng; Map giữ đúng thứ tự ghi.
  const byId = new Map();
  for (const file of files) {
    let content = '';
    try { content = await readFile(path.join(archiveDirectory, file), 'utf8'); } catch { continue; }
    for (const line of content.split('\n')) {
      if (!line.trim()) continue;
      try {
        const record = JSON.parse(line);
        if (record && record.id) byId.set(record.id, record);
      } catch { /* dòng hỏng thì bỏ qua, phần còn lại vẫn đọc được */ }
    }
  }
  const needle = foldVietnamese(text(query, 120));
  const items = [...byId.values()]
    .filter(record => !needle || recordMatches(record, needle))
    .sort((a, b) => (Number(b.at) || 0) - (Number(a.at) || 0));
  return { items: limit > 0 ? items.slice(0, limit) : items, total: items.length };
}
