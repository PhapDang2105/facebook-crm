import assert from 'node:assert/strict';
import AdmZip from 'adm-zip';
import { parseXlsx } from '../app/xlsx-import.mjs';

const workbook = new AdmZip();
workbook.addFile('xl/workbook.xml', Buffer.from(`<?xml version="1.0" encoding="UTF-8"?>
  <workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
    <sheets><sheet name="Đơn hàng" sheetId="1" r:id="rId1"/></sheets>
  </workbook>`));
workbook.addFile('xl/_rels/workbook.xml.rels', Buffer.from(`<?xml version="1.0" encoding="UTF-8"?>
  <Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>`));
workbook.addFile('xl/sharedStrings.xml', Buffer.from(`<?xml version="1.0" encoding="UTF-8"?>
  <sst><si><t>Mã mẫu mã</t></si><si><t>Số lượng</t></si><si><t>Sản phẩm</t></si><si><t>CB2-HT-YM-T500</t></si><si><t>Yến Mạch Cán Dẹt</t></si></sst>`));
workbook.addFile('xl/worksheets/sheet1.xml', Buffer.from(`<?xml version="1.0" encoding="UTF-8"?>
  <worksheet><sheetData>
    <row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="s"><v>2</v></c></row>
    <row r="2"><c r="A2" t="s"><v>3</v></c><c r="B2"><v>3</v></c><c r="C2" t="s"><v>4</v></c></row>
  </sheetData></worksheet>`));

const parsed = parseXlsx(workbook.toBuffer());
assert.equal(parsed.sheetName, 'Đơn hàng');
assert.deepEqual(parsed.headers, ['Mã mẫu mã', 'Số lượng', 'Sản phẩm']);
assert.deepEqual(parsed.rows, [['CB2-HT-YM-T500', '3', 'Yến Mạch Cán Dẹt']]);

console.log('PASS: XLSX import parser');
