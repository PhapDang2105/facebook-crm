import path from 'node:path';
import AdmZip from 'adm-zip';

const BUILTIN_DATE_FORMATS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 27, 30, 36, 45, 46, 47, 50, 57]);

function decodeXml(value = '') {
  return String(value)
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function getAttribute(attributes, name) {
  const match = String(attributes).match(new RegExp(`(?:^|\\s)${name}="([^"]*)"`));
  return match ? decodeXml(match[1]) : '';
}

function getXml(zip, entryName, required = true) {
  const entry = zip.getEntry(entryName);
  if (!entry) {
    if (!required) return '';
    throw new Error(`Tệp Excel thiếu thành phần bắt buộc: ${entryName}`);
  }
  return entry.getData().toString('utf8');
}

function extractText(xml) {
  return [...String(xml).matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)]
    .map(match => decodeXml(match[1]))
    .join('');
}

function parseSharedStrings(zip) {
  const xml = getXml(zip, 'xl/sharedStrings.xml', false);
  return xml ? [...xml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)].map(match => extractText(match[1])) : [];
}

function parseDateStyles(zip) {
  const xml = getXml(zip, 'xl/styles.xml', false);
  if (!xml) return new Set();
  const customFormats = new Map();
  for (const match of xml.matchAll(/<numFmt\b([^>]*)\/?>(?:<\/numFmt>)?/g)) {
    customFormats.set(Number(getAttribute(match[1], 'numFmtId')), getAttribute(match[1], 'formatCode'));
  }
  const cellXfs = xml.match(/<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/)?.[1] || '';
  const dateStyles = new Set();
  [...cellXfs.matchAll(/<xf\b([^>]*?)(?:\/>|>[\s\S]*?<\/xf>)/g)].forEach((match, index) => {
    const numFmtId = Number(getAttribute(match[1], 'numFmtId'));
    const custom = customFormats.get(numFmtId) || '';
    const normalized = custom.replace(/"[^"]*"/g, '').replace(/\\./g, '').replace(/\[[^\]]*\]/g, '');
    if (BUILTIN_DATE_FORMATS.has(numFmtId) || /[ymdhis]/i.test(normalized)) dateStyles.add(index);
  });
  return dateStyles;
}

function excelDate(serial) {
  const milliseconds = Math.round((Number(serial) - 25569) * 86400000);
  const date = new Date(milliseconds);
  if (!Number.isFinite(milliseconds) || Number.isNaN(date.getTime())) return String(serial);
  const iso = date.toISOString();
  return iso.endsWith('T00:00:00.000Z') ? iso.slice(0, 10) : iso.replace('T', ' ').replace('.000Z', '');
}

function columnIndex(address) {
  const letters = String(address).match(/^[A-Z]+/i)?.[0]?.toUpperCase() || '';
  return [...letters].reduce((value, character) => value * 26 + character.charCodeAt(0) - 64, 0) - 1;
}

function parseCell(attributes, body, sharedStrings, dateStyles) {
  const type = getAttribute(attributes, 't');
  if (type === 'inlineStr') return extractText(body);
  const raw = body.match(/<v\b[^>]*>([\s\S]*?)<\/v>/)?.[1] ?? '';
  if (type === 's') return sharedStrings[Number(raw)] ?? '';
  if (type === 'str' || type === 'e') return decodeXml(raw);
  if (type === 'b') return raw === '1' ? 'TRUE' : 'FALSE';
  const style = Number(getAttribute(attributes, 's'));
  if (raw !== '' && dateStyles.has(style)) return excelDate(raw);
  return decodeXml(raw);
}

function firstWorksheetPath(zip) {
  const workbookXml = getXml(zip, 'xl/workbook.xml');
  const sheets = [...workbookXml.matchAll(/<sheet\b([^>]*)\/?>(?:<\/sheet>)?/g)].map(match => ({
    name: getAttribute(match[1], 'name'),
    relationId: getAttribute(match[1], 'r:id'),
    state: getAttribute(match[1], 'state')
  }));
  const sheet = sheets.find(item => item.state !== 'hidden' && item.state !== 'veryHidden') || sheets[0];
  if (!sheet) throw new Error('Tệp Excel không có worksheet.');

  const relationshipsXml = getXml(zip, 'xl/_rels/workbook.xml.rels');
  const relationships = new Map([...relationshipsXml.matchAll(/<Relationship\b([^>]*)\/?>(?:<\/Relationship>)?/g)]
    .map(match => [getAttribute(match[1], 'Id'), getAttribute(match[1], 'Target')]));
  const target = relationships.get(sheet.relationId);
  if (!target) throw new Error('Không tìm thấy worksheet đầu tiên trong tệp Excel.');
  const entryName = target.startsWith('/')
    ? target.slice(1)
    : path.posix.normalize(path.posix.join('xl', target.replace(/\\/g, '/')));
  return { entryName, sheetName: sheet.name };
}

export function parseXlsx(buffer) {
  let zip;
  try { zip = new AdmZip(buffer); }
  catch { throw new Error('Không thể đọc tệp XLSX. Tệp có thể bị hỏng hoặc không đúng định dạng.'); }

  const { entryName, sheetName } = firstWorksheetPath(zip);
  const worksheetXml = getXml(zip, entryName);
  const sharedStrings = parseSharedStrings(zip);
  const dateStyles = parseDateStyles(zip);
  const rows = [];

  for (const rowMatch of worksheetXml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
    const row = [];
    for (const cellMatch of rowMatch[1].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const address = getAttribute(cellMatch[1], 'r');
      const index = columnIndex(address);
      if (index >= 0) row[index] = parseCell(cellMatch[1], cellMatch[2] || '', sharedStrings, dateStyles);
    }
    while (row.length && (row[row.length - 1] === '' || row[row.length - 1] === undefined)) row.pop();
    rows.push(Array.from({ length: row.length }, (_, index) => row[index] ?? ''));
  }

  while (rows.length && !rows[rows.length - 1].some(value => String(value).trim())) rows.pop();
  if (!rows.length) throw new Error(`Worksheet "${sheetName}" không có dữ liệu.`);
  const headers = rows.shift().map(value => String(value).trim());
  return { sheetName, headers, rows };
}
