// File kho XLSX (app/xlsx-template.mjs, 01/10): dựng sheetData một lượt cho ra ĐÚNG từng byte như cách
// cũ ghi từng ô (writeTemplateCell), nhanh hơn nhiều; "$" trong dữ liệu không còn làm hỏng XML.
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import AdmZip from 'adm-zip';
import { fillTemplateSheet, writeTemplateCell } from '../app/xlsx-template.mjs';
import { excelColumnName } from '../app/xlsx-export.mjs';

const templateXml = new AdmZip(fileURLToPath(new URL('../assets/templates/facebook-order-export.xlsx', import.meta.url)))
  .getEntry('xl/worksheets/sheet1.xml').getData().toString('utf8');

/** Từng ô một, quét lại cả XML (writeTemplateCell đã sửa "$" và ô tự đóng). */
function cellByCell(xml, rows, firstRow = 4, write = writeTemplateCell) {
  rows.forEach((row, rowIndex) => row.forEach((value, columnIndex) => {
    xml = write(xml, `${excelColumnName(columnIndex)}${rowIndex + firstRow}`, value);
  }));
  return xml;
}

// Bản chép NGUYÊN VĂN writeTemplateCell trong app/server.mjs trước 01/10 (chuỗi thay, `[^>]*`): so từng byte
// trên mẫu kho thật với dữ liệu không có "$" để chắc file kho không đổi.
function legacyWriteTemplateCell(xml, address, value) {
  if (value === '' || value === null || value === undefined) return xml;
  const escapeXml = text => String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
  const columnIndex = name => [...name].reduce((sum, char) => sum * 26 + char.charCodeAt(0) - 64, 0) - 1;
  const cellPattern = new RegExp(`<c([^>]*\\br="${address}"[^>]*)(?:\\/>|>[\\s\\S]*?<\\/c>)`);
  const match = xml.match(cellPattern);
  const isNumber = typeof value === 'number' && Number.isFinite(value);
  const createCell = attributes => isNumber
    ? `<c${attributes}><v>${value}</v></c>`
    : `<c${attributes} t="inlineStr"><is><t xml:space="preserve">${escapeXml(value)}</t></is></c>`;
  if (match) {
    const attributes = match[1].replace(/\s+t="[^"]*"/g, '');
    return xml.replace(cellPattern, createCell(attributes));
  }
  const [, column, rowText] = address.match(/^([A-Z]+)(\d+)$/);
  const rowNumber = Number(rowText);
  let style = null;
  for (const found of xml.matchAll(new RegExp(`<c\\b([^>]*\\br="${column}(\\d+)"[^>]*)`, 'g'))) {
    if (Number(found[2]) < 4) continue;
    const styleMatch = found[1].match(/\bs="(\d+)"/);
    if (styleMatch) { style = styleMatch[1]; break; }
  }
  const newCell = createCell(` r="${address}"${style ? ` s="${style}"` : ''}`);
  const rowPattern = new RegExp(`<row([^>]*\\br="${rowNumber}"[^>]*)>([\\s\\S]*?)<\\/row>`);
  const rowMatch = xml.match(rowPattern);
  if (rowMatch) {
    const targetColumn = columnIndex(column);
    let insertAt = rowMatch[2].length;
    for (const cell of rowMatch[2].matchAll(/<c\b[^>]*\br="([A-Z]+)\d+"[^>]*(?:\/>|>[\s\S]*?<\/c>)/g)) {
      if (columnIndex(cell[1]) > targetColumn) { insertAt = cell.index; break; }
    }
    const rowContent = `${rowMatch[2].slice(0, insertAt)}${newCell}${rowMatch[2].slice(insertAt)}`;
    return xml.replace(rowPattern, `<row${rowMatch[1]}>${rowContent}</row>`);
  }
  const sheetDataEnd = xml.indexOf('</sheetData>');
  return `${xml.slice(0, sheetDataEnd)}<row r="${rowNumber}">${newCell}</row>${xml.slice(sheetDataEnd)}`
    .replace(/<dimension ref="([A-Z]+\d+):([A-Z]+)(\d+)"\/>/, (tag, start, endColumn, endRow) => Number(endRow) < rowNumber ? `<dimension ref="${start}:${endColumn}${rowNumber}"/>` : tag);
}

test('mẫu kho thật: kết quả giống từng byte bản cũ trong server.mjs (dữ liệu không có "$")', () => {
  for (const rows of [sampleRows(3), sampleRows(40, { columns: 58 })]) {
    assert.equal(fillTemplateSheet(templateXml, rows), cellByCell(templateXml, rows, 4, legacyWriteTemplateCell));
  }
  // Quanh dòng cuối của mẫu (770): dòng có sẵn rồi dòng mới nối cuối + nới <dimension>.
  const tail = sampleRows(6, { columns: 9 });
  assert.equal(fillTemplateSheet(templateXml, tail, { firstRow: 767 }), cellByCell(templateXml, tail, 767, legacyWriteTemplateCell));
});

function sampleRows(count, { columns = 40, sparse = true } = {}) {
  return Array.from({ length: count }, (_, index) => Array.from({ length: columns }, (__, column) => {
    if (sparse && (column * 7 + index) % 3 === 0) return '';
    if (column === 0) return index + 1;
    if (column % 5 === 0) return 149000 * (column % 3 + 1);
    return `Ô ${index}-${column} <b> & "x" 'y'`;
  }));
}

test('fillTemplateSheet giống hệt cách ghi từng ô cũ trên mẫu kho thật (dòng có sẵn, dòng mới, ô rỗng, số)', () => {
  for (const rows of [sampleRows(1), sampleRows(25), sampleRows(60, { columns: 58 }), [[null, undefined, '', 0, 'a']], [], [['']]]) {
    assert.equal(fillTemplateSheet(templateXml, rows), cellByCell(templateXml, rows));
  }
  // Vượt số dòng mẫu (770): dòng mới nối cuối sheetData và nới <dimension>.
  const many = sampleRows(40, { columns: 6 });
  const filled = fillTemplateSheet(templateXml, many, { firstRow: 765 });
  assert.equal(filled, cellByCell(templateXml, many, 765));
  assert.match(filled, /<dimension ref="A1:BF804"\/>/);
  // Mẫu tự dựng: thay ô có sẵn (bỏ t=…, giữ s=…), chèn ô đúng thứ tự cột, dòng chưa có.
  const tiny = '<worksheet><dimension ref="A1:C4"/><sheetData><row r="4"><c r="A4" s="3"/><c r="C4" s="5" t="n"><v>1</v></c></row></sheetData></worksheet>';
  const rows = [['x', 'y', 'z'], ['', 7]];
  assert.equal(fillTemplateSheet(tiny, rows), cellByCell(tiny, rows));
  assert.equal(fillTemplateSheet(tiny, rows),
    '<worksheet><dimension ref="A1:C5"/><sheetData><row r="4"><c r="A4" s="3" t="inlineStr"><is><t xml:space="preserve">x</t></is></c><c r="B4" t="inlineStr"><is><t xml:space="preserve">y</t></is></c><c r="C4" s="5" t="inlineStr"><is><t xml:space="preserve">z</t></is></c></row><row r="5"><c r="B5"><v>7</v></c></row></sheetData></worksheet>');
});

test('dữ liệu có "$&", "$1", "$`", "$\'" (tên/địa chỉ khách) ghi nguyên văn, XML không bị chèn rác', () => {
  const nasty = ['Tên $1 $` x', "Địa chỉ $& và $' cuối", '$$ tiền'];
  for (const xml of [templateXml, '<worksheet><dimension ref="A1:C4"/><sheetData><row r="4"><c r="B4" s="2"/></row></sheetData></worksheet>']) {
    const out = fillTemplateSheet(xml, [nasty]);
    assert.equal(out, cellByCell(xml, [nasty]));
    const texts = [...out.matchAll(/<c r="([A-C]4)"[^>]*><is><t xml:space="preserve">([^<]*)<\/t><\/is><\/c>/g)].map(match => [match[1], match[2]]);
    assert.deepEqual(texts, [['A4', 'Tên $1 $` x'], ['B4', 'Địa chỉ $&amp; và $&apos; cuối'], ['C4', '$$ tiền']]);
    assert.equal((out.match(/<worksheet/g) || []).length, 1, 'không lồng lại phần XML trước ô');
  }
});

// Ngưỡng rộng để không chập chờn khi máy đang chạy nặng: bản mới ~30 ms, bản cũ ~10 giây (máy dev, 01/10).
test('200 dòng × 17 ô trên mẫu thật: dưới 2 giây (cách cũ ~10 giây trên máy dev)', () => {
  const rows = sampleRows(200, { columns: 17, sparse: false });
  const started = performance.now();
  fillTemplateSheet(templateXml, rows);
  assert.ok(performance.now() - started < 2000, `chậm: ${Math.round(performance.now() - started)} ms`);
});
