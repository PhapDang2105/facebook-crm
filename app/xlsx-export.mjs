// XLSX thuần (một sheet, chữ inline) từ bảng bất kỳ: nút Export ở Nhập dữ liệu
// tải đúng các cột/dòng đang hiển thị, không qua mẫu kho và không ghi lịch sử xuất.
import AdmZip from 'adm-zip';

/**
 * Thoát chữ cho XML của tệp XLSX (dùng chung với xlsx-template.mjs). Bỏ ký tự điều khiển XML 1.0
 * không cho phép (\x00-\x08, \x0B, \x0C, \x0E-\x1F; tên Facebook / chữ dán từ nơi khác hay mang theo):
 * một ký tự như vậy là Excel báo tệp hỏng, không mở được.
 */
export function escapeXml(value) {
  return String(value ?? '')
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

/** Tên sheet: tối đa 31 ký tự (giới hạn của Excel) đếm trên chữ GỐC, rồi mới thoát XML (cắt sau khi thoát từng làm đứt "&amp;"). */
export function sheetNameXml(name) {
  const clean = String(name ?? '').replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '').replace(/[[\]:*?/\\]/g, ' ');
  return escapeXml([...clean].slice(0, 31).join('') || 'Sheet1');
}

export function excelColumnName(index) {
  let name = '';
  let current = index;
  while (current >= 0) {
    name = String.fromCharCode(65 + (current % 26)) + name;
    current = Math.floor(current / 26) - 1;
  }
  return name;
}

function cell(reference, value, style = 0) {
  if (typeof value === 'number' && Number.isFinite(value)) return `<c r="${reference}"${style ? ` s="${style}"` : ''}><v>${value}</v></c>`;
  const text = String(value ?? '');
  if (!text) return '';
  return `<c r="${reference}" t="inlineStr"${style ? ` s="${style}"` : ''}><is><t xml:space="preserve">${escapeXml(text)}</t></is></c>`;
}

/** Trả buffer .xlsx với hàng đầu là tiêu đề (in đậm), các hàng sau là dữ liệu. */
export function buildPlainXlsx(headers = [], rows = [], { sheetName = 'Đơn hàng' } = {}) {
  const head = Array.isArray(headers) ? headers.map(item => String(item ?? '')) : [];
  const body = Array.isArray(rows) ? rows : [];
  const width = Math.max(head.length, ...body.map(row => (Array.isArray(row) ? row.length : 0)), 1);
  const lines = [];
  lines.push(`<row r="1">${head.map((value, index) => cell(`${excelColumnName(index)}1`, value, 1)).join('')}</row>`);
  body.forEach((row, rowIndex) => {
    const cells = (Array.isArray(row) ? row : []).map((value, index) => cell(`${excelColumnName(index)}${rowIndex + 2}`, value)).join('');
    lines.push(`<row r="${rowIndex + 2}">${cells}</row>`);
  });
  const columns = Array.from({ length: width }, (_, index) => `<col min="${index + 1}" max="${index + 1}" width="${index === 0 ? 14 : 22}" customWidth="1"/>`).join('');
  const sheet = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><cols>${columns}</cols><sheetData>${lines.join('')}</sheetData></worksheet>`;
  const styles = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs></styleSheet>`;
  const workbook = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${sheetNameXml(sheetName)}" sheetId="1" r:id="rId1"/></sheets></workbook>`;
  const workbookRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`;
  const rootRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`;
  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`;
  const zip = new AdmZip();
  zip.addFile('[Content_Types].xml', Buffer.from(contentTypes, 'utf8'));
  zip.addFile('_rels/.rels', Buffer.from(rootRels, 'utf8'));
  zip.addFile('xl/workbook.xml', Buffer.from(workbook, 'utf8'));
  zip.addFile('xl/_rels/workbook.xml.rels', Buffer.from(workbookRels, 'utf8'));
  zip.addFile('xl/styles.xml', Buffer.from(styles, 'utf8'));
  zip.addFile('xl/worksheets/sheet1.xml', Buffer.from(sheet, 'utf8'));
  return zip.toBuffer();
}
