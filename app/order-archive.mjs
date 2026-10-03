// Kho lưu trữ đơn: mọi đơn đều được ghi lại — kể cả đơn khách hủy, đơn quá hẹn
// rời bảng hay đơn đã xóa — để sau này còn tra được khách là ai, số nào, mua gì,
// mấy cái, giao đi đâu.
//
// Mỗi đơn một dòng JSON (NDJSON), file chia theo tháng. Ghi là nối thêm vào cuối
// file chứ không đọc-sửa-ghi cả kho, nên một đơn sửa nhiều lần cũng chỉ tốn thêm
// một dòng và không bao giờ phải khoá file lớn. Lúc đọc, dòng sau cùng của một
// mã đơn là bản đúng. Tên khoá viết tắt vì kho ghi rất nhiều dòng: một đơn
// khoảng 200 byte, nhẹ hơn bản đầy đủ trong landing-orders.json chừng mười lần.
import { appendFile, mkdir, readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { projectRoot } from './config.mjs';
import { foldVietnamese } from './processing/auto-label.mjs';
import { trackWrite } from './json-store.mjs';

const archiveDirectory = process.env.ORDER_ARCHIVE_PATH
  || path.join(projectRoot, 'data', 'processed', 'order-archive');

const text = (value, max) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

// Giờ Việt Nam (Asia/Ho_Chi_Minh, +7, không đổi giờ mùa hè): VM chạy UTC, đơn 01/10 03:00
// giờ VN trước đây rơi vào tệp 2026-09.
const vietnamOffsetMs = 7 * 60 * 60 * 1000;

/** Tên file theo tháng đặt đơn (giờ Việt Nam): 2026-09.ndjson. */
export function archiveMonth(at) {
  return new Date((Number(at) || Date.now()) + vietnamOffsetMs).toISOString().slice(0, 7);
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
  // trackWrite: lúc tắt máy chủ drainAllWrites chờ dòng đang ghi dở xong rồi mới thoát.
  return trackWrite((async () => {
    const file = `${archiveMonth(record.at)}.ndjson`;
    const line = `${JSON.stringify(record)}\n`;
    await mkdir(archiveDirectory, { recursive: true });
    await appendFile(path.join(archiveDirectory, file), line, 'utf8');
    noteAppended(file, record, Buffer.byteLength(line, 'utf8'));
    return record;
  })());
}

/**
 * Chỉ mục trong RAM (P2, 03/10): trước đây mỗi lần ghi một dòng là bỏ bộ nhớ tạm, lần đọc sau (hộp chi tiết
 * khách, đặt mã đơn tay) đọc và phân tích lại MỌI dòng của MỌI tháng. Nay nạp một lần: Map mã đơn → bản ghi
 * (dòng sau cùng thắng) và 9 số cuối SĐT → mã đơn; dòng mới ghi thì cập nhật tại chỗ (kho chỉ ghi nối).
 * Script bảo trì ghi thêm vào tệp tháng: lượt đọc (tối đa 30 giây một lần) so kích thước tệp với số byte đã
 * biết, lệch thì nạp lại cả kho.
 */
let archiveIndex = null; // { byId: Map, byPhone: Map<tail9, Set<id>>, sizes: Map<file, bytes>, sorted: array|null, checkedAt }
let loadingIndex = null;
const appendedWhileLoading = [];
const archiveRecheckMs = 30 * 1000;

const phoneTail = value => String(value ?? '').replace(/\D/g, '').slice(-9);

function indexRecord(index, record) {
  const previous = index.byId.get(record.id);
  if (previous) {
    const ids = index.byPhone.get(phoneTail(previous.phone));
    if (ids && phoneTail(previous.phone) !== phoneTail(record.phone)) ids.delete(record.id);
  }
  index.byId.set(record.id, record);
  const tail = phoneTail(record.phone);
  if (tail) {
    if (!index.byPhone.has(tail)) index.byPhone.set(tail, new Set());
    index.byPhone.get(tail).add(record.id);
  }
  index.sorted = null;
}

function noteAppended(file, record, bytes) {
  // Đang nạp chỉ mục: nhớ dòng này để thêm sau khi nạp xong (lượt đọc tệp có thể đã qua chỗ đó).
  if (loadingIndex) appendedWhileLoading.push({ ...record, file });
  if (!archiveIndex) return;
  archiveIndex.sizes.set(file, (archiveIndex.sizes.get(file) || 0) + bytes);
  indexRecord(archiveIndex, { ...record, file });
}

async function archiveFileSizes() {
  let files = [];
  try {
    files = (await readdir(archiveDirectory)).filter(name => name.endsWith('.ndjson')).sort();
  } catch {
    return new Map();
  }
  const sizes = new Map();
  for (const file of files) {
    const info = await stat(path.join(archiveDirectory, file)).catch(() => null);
    if (info) sizes.set(file, info.size);
  }
  return sizes;
}

async function buildIndex() {
  const sizes = await archiveFileSizes();
  const index = { byId: new Map(), byPhone: new Map(), sizes: new Map(), sorted: null, checkedAt: Date.now() };
  for (const file of sizes.keys()) {
    let content = '';
    try { content = await readFile(path.join(archiveDirectory, file), 'utf8'); } catch { continue; }
    index.sizes.set(file, Buffer.byteLength(content, 'utf8'));
    for (const line of content.split('\n')) {
      if (!line.trim()) continue;
      try {
        const record = JSON.parse(line);
        if (record && record.id) indexRecord(index, { ...record, file });
      } catch { /* dòng hỏng thì bỏ qua, phần còn lại vẫn đọc được */ }
    }
  }
  return index;
}

async function sameSizes(index) {
  const sizes = await archiveFileSizes();
  if (sizes.size !== index.sizes.size) return false;
  for (const [file, size] of sizes) if (index.sizes.get(file) !== size) return false;
  return true;
}

async function loadIndex() {
  if (archiveIndex && Date.now() - archiveIndex.checkedAt < archiveRecheckMs) return archiveIndex;
  if (!loadingIndex) {
    loadingIndex = (async () => {
      if (archiveIndex && await sameSizes(archiveIndex)) {
        archiveIndex.checkedAt = Date.now();
        return archiveIndex;
      }
      const built = await buildIndex();
      // Dòng ghi trong lúc nạp: thêm lại (đã có thì chỉ dời về cuối — vẫn là bản mới nhất). Kích thước tệp không
      // cộng thêm: nếu lượt đọc chưa thấy dòng đó, lần kiểm sau thấy lệch và nạp lại.
      for (const record of appendedWhileLoading.splice(0)) indexRecord(built, record);
      archiveIndex = built;
      return archiveIndex;
    })().finally(() => { loadingIndex = null; appendedWhileLoading.length = 0; });
  }
  return loadingIndex;
}

function sortedRecords(index) {
  index.sorted ||= [...index.byId.values()].sort((a, b) => (Number(b.at) || 0) - (Number(a.at) || 0));
  return index.sorted;
}

async function readAllRecords() {
  return sortedRecords(await loadIndex());
}

/** Bản ghi (dòng sau cùng của mỗi mã) có 9 số cuối SĐT trùng `phone`, mới nhất trước — không chép cả kho. */
export async function findArchiveByPhone(phone) {
  const tail = phoneTail(phone);
  if (!tail) return [];
  const index = await loadIndex();
  return [...(index.byPhone.get(tail) || [])]
    .map(id => index.byId.get(id))
    .filter(Boolean)
    .sort((a, b) => (Number(b.at) || 0) - (Number(a.at) || 0))
    .map(({ file, ...record }) => record);
}

/** Mọi mã đơn đã có trong kho lưu trữ (để đặt mã đơn tay không trùng). */
export async function archiveOrderIds() {
  return new Set((await loadIndex()).byId.keys());
}

function recordMatches(record, needle) {
  const haystack = [record.id, record.name, record.phone, record.addr, ...(record.items || []).map(item => item[0])].join(' ');
  return foldVietnamese(haystack).includes(needle);
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
  const matched = needle ? records.filter(record => recordMatches(record, needle)) : records;
  // Bỏ `file` đi: nó chỉ dùng để lọc theo tháng, không phải dữ liệu của đơn. Chỉ chép phần trả về.
  const items = (limit > 0 ? matched.slice(0, limit) : matched).map(({ file, ...record }) => record);
  return { items, total: matched.length };
}
