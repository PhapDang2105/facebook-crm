// Ghi dữ liệu vào trang tính của mẫu XLSX kho (assets/templates/facebook-order-export.xlsx).
//
// Trước 01/10 server.mjs ghi TỪNG Ô bằng một RegExp quét lại cả XML đang lớn dần (bậc hai: 200 dòng
// ~2 giây chặn cả máy chủ), và String.replace với chuỗi thay chứa giá trị ô nên "$&", "$1", "$`", "$'"
// trong tên/địa chỉ khách bị diễn giải (XML hỏng). Giờ: tách sheetData theo dòng MỘT lần, ghi ô trong
// từng dòng, ghép lại — trên mẫu kho thật kết quả giống hệt cách cũ (tests/fix-server-xlsx-template.test.mjs
// so từng byte). Thêm: ô tự đóng <c …/> không còn làm hỏng ô kế bên (mẫu hiện tại không có ô như vậy).
import { columnIndex as excelColumnIndex } from './xlsx-import.mjs';
import { excelColumnName } from './xlsx-export.mjs';

export function escapeXml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

const isBlank = value => value === '' || value === null || value === undefined;

// Một ô <c …>…</c> hay <c …/>: thuộc tính viết theo dạng tên="giá trị" để dấu "/" của ô tự đóng không
// lọt vào nhóm thuộc tính (bản cũ `[^>]*` nuốt "/" rồi kéo dài tới </c> của ô SAU, làm mất ô đó).
const ATTRIBUTE = '\\s+[\\w:]+="[^"]*"';
const cellPattern = address => new RegExp(`<c((?:${ATTRIBUTE})*?\\s+r="${address}"(?:${ATTRIBUTE})*)\\s*(?:\\/>|>[\\s\\S]*?<\\/c>)`);
const ANY_CELL = new RegExp(`<c(?:${ATTRIBUTE})*?\\s+r="([A-Z]+)(\\d+)"(?:${ATTRIBUTE})*\\s*(?:\\/>|>[\\s\\S]*?<\\/c>)`, 'g');

function cellXml(attributes, value) {
  return typeof value === 'number' && Number.isFinite(value)
    ? `<c${attributes}><v>${value}</v></c>`
    : `<c${attributes} t="inlineStr"><is><t xml:space="preserve">${escapeXml(value)}</t></is></c>`;
}

/** Kiểu ô dữ liệu (dòng ≥ 4) đầu tiên của cột trong mẫu — ô mới của cột đó mang cùng kiểu. */
export function findDataCellStyle(xml, column) {
  const cellPattern = new RegExp(`<c\\b([^>]*\\br="${column}(\\d+)"[^>]*)`, 'g');
  for (const match of xml.matchAll(cellPattern)) {
    if (Number(match[2]) < 4) continue;
    const style = match[1].match(/\bs="(\d+)"/);
    if (style) return style[1];
  }
  return null;
}

/**
 * Ghi MỘT ô (cách cũ, quét cả XML). Giữ để so kết quả với fillTemplateSheet trong test; hàm thay
 * `() => …` thay cho chuỗi thay nên "$" trong dữ liệu không còn bị String.replace diễn giải.
 */
export function writeTemplateCell(xml, address, value) {
  if (isBlank(value)) return xml;
  const pattern = cellPattern(address);
  const match = xml.match(pattern);
  if (match) {
    const attributes = match[1].replace(/\s+t="[^"]*"/g, '');
    const replacement = cellXml(attributes, value);
    return xml.replace(pattern, () => replacement);
  }
  const addressParts = address.match(/^([A-Z]+)(\d+)$/);
  if (!addressParts) throw new Error(`Invalid Excel cell address: ${address}`);
  const [, column, rowText] = addressParts;
  const rowNumber = Number(rowText);
  const style = findDataCellStyle(xml, column);
  const newCell = cellXml(` r="${address}"${style ? ` s="${style}"` : ''}`, value);
  const rowPattern = new RegExp(`<row([^>]*\\br="${rowNumber}"[^>]*)>([\\s\\S]*?)<\\/row>`);
  const rowMatch = xml.match(rowPattern);
  if (rowMatch) {
    const rowContent = insertCell(rowMatch[2], column, newCell);
    const replacement = `<row${rowMatch[1]}>${rowContent}</row>`;
    return xml.replace(rowPattern, () => replacement);
  }
  const newRow = `<row r="${rowNumber}">${newCell}</row>`;
  const sheetDataEnd = xml.indexOf('</sheetData>');
  if (sheetDataEnd < 0) throw new Error('Excel template sheet data was not found.');
  return updateDimension(`${xml.slice(0, sheetDataEnd)}${newRow}${xml.slice(sheetDataEnd)}`, rowNumber);
}

/** Chèn ô vào nội dung một dòng, trước ô đầu tiên nằm ở cột sau nó. */
function insertCell(rowContent, column, newCell) {
  const targetColumn = excelColumnIndex(column);
  let insertAt = rowContent.length;
  for (const cell of rowContent.matchAll(ANY_CELL)) {
    if (excelColumnIndex(cell[1]) > targetColumn) { insertAt = cell.index; break; }
  }
  return `${rowContent.slice(0, insertAt)}${newCell}${rowContent.slice(insertAt)}`;
}

function updateDimension(xml, rowNumber) {
  return xml.replace(/<dimension ref="([A-Z]+\d+):([A-Z]+)(\d+)"\/>/, (tag, start, endColumn, endRow) =>
    Number(endRow) < rowNumber ? `<dimension ref="${start}:${endColumn}${rowNumber}"/>` : tag);
}

/** Nội dung một dòng tách thành mảnh: ô (có address, column) và chữ xen giữa (giữ nguyên). */
function rowTokens(content) {
  const tokens = [];
  let cursor = 0;
  for (const match of content.matchAll(ANY_CELL)) {
    if (match.index > cursor) tokens.push({ text: content.slice(cursor, match.index) });
    tokens.push({ text: match[0], address: `${match[1]}${match[2]}`, column: excelColumnIndex(match[1]) });
    cursor = match.index + match[0].length;
  }
  if (cursor < content.length) tokens.push({ text: content.slice(cursor) });
  return tokens;
}

/** Ghi một ô vào dòng (mảng mảnh): thay ô cùng địa chỉ, không thì chèn trước ô đầu tiên ở cột sau nó. */
function writeCellInTokens(tokens, address, column, value, style) {
  const existing = tokens.find(token => token.address === address);
  if (existing) {
    const match = existing.text.match(cellPattern(address));
    existing.text = cellXml(match[1].replace(/\s+t="[^"]*"/g, ''), value);
    return;
  }
  const columnIndex = excelColumnIndex(column);
  const cell = { text: cellXml(` r="${address}"${style ? ` s="${style}"` : ''}`, value), address, column: columnIndex };
  const at = tokens.findIndex(token => token.column !== undefined && token.column > columnIndex);
  if (at < 0) tokens.push(cell);
  else tokens.splice(at, 0, cell);
}

/**
 * Ghi `rows` (mảng dòng, mỗi dòng mảng giá trị theo cột A, B, …) vào trang tính bắt đầu từ dòng
 * `firstRow`. Ô rỗng/null bỏ qua; số ghi dạng số, còn lại inlineStr. Dòng có sẵn trong mẫu giữ
 * thuộc tính và các ô khác; dòng chưa có thêm vào cuối sheetData và nới <dimension>.
 */
export function fillTemplateSheet(xml, rows, { firstRow = 4 } = {}) {
  const list = Array.isArray(rows) ? rows : [];
  if (!list.some(row => (Array.isArray(row) ? row : []).some(value => !isBlank(value)))) return xml;
  const open = xml.search(/<sheetData\b[^>]*>/);
  const close = xml.indexOf('</sheetData>');
  if (open < 0 || close < 0) throw new Error('Excel template sheet data was not found.');
  const bodyStart = xml.indexOf('>', open) + 1;
  const body = xml.slice(bodyStart, close);
  // Vị trí từng dòng của mẫu: chỉ dòng đầu tiên mang số đó được ghi (như RegExp không cờ g của cách cũ).
  const templateRows = new Map();
  for (const match of body.matchAll(/<row([^>]*)>([\s\S]*?)<\/row>/g)) {
    const number = Number((match[1].match(/\br="(\d+)"/) || [])[1]);
    if (!number || templateRows.has(number)) continue;
    templateRows.set(number, { start: match.index, end: match.index + match[0].length, attributes: match[1], content: match[2] });
  }
  const styles = new Map();
  const styleOf = column => {
    if (!styles.has(column)) styles.set(column, findDataCellStyle(xml, column));
    return styles.get(column);
  };
  const edited = new Map();
  const added = [];
  list.forEach((row, rowIndex) => {
    const rowNumber = rowIndex + firstRow;
    const values = Array.isArray(row) ? row : [];
    let target = edited.get(rowNumber);
    values.forEach((value, columnIndex) => {
      if (isBlank(value)) return;
      if (!target) {
        const template = templateRows.get(rowNumber);
        target = template ? { ...template, tokens: rowTokens(template.content) } : { attributes: ` r="${rowNumber}"`, tokens: [], added: true };
        edited.set(rowNumber, target);
        if (target.added) added.push(rowNumber);
      }
      const column = excelColumnName(columnIndex);
      writeCellInTokens(target.tokens, `${column}${rowNumber}`, column, value, styleOf(column));
    });
  });
  // Ghép lại: dòng mẫu đã sửa thay tại chỗ, dòng mới nối cuối (theo thứ tự đã tạo).
  const rowXml = item => `<row${item.attributes}>${item.tokens.map(token => token.text).join('')}</row>`;
  const pieces = [];
  let cursor = 0;
  const replaced = [...edited.values()].filter(item => !item.added).sort((first, second) => first.start - second.start);
  for (const item of replaced) {
    pieces.push(body.slice(cursor, item.start), rowXml(item));
    cursor = item.end;
  }
  pieces.push(body.slice(cursor));
  for (const rowNumber of added) pieces.push(rowXml(edited.get(rowNumber)));
  let result = `${xml.slice(0, bodyStart)}${pieces.join('')}${xml.slice(close)}`;
  if (added.length) result = updateDimension(result, Math.max(...added));
  return result;
}
