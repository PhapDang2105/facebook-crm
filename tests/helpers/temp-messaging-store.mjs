import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Import this module BEFORE anything under app/: messaging-store reads
// META_CONVERSATIONS_PATH once when it loads, so the redirect has to happen
// first. `seed` then writes whatever a test needs into that throwaway file.
const directory = mkdtempSync(path.join(os.tmpdir(), 'crm-messaging-test-'));
export const storePath = path.join(directory, 'conversations.json');
process.env.META_CONVERSATIONS_PATH = storePath;
// listCustomers đọc BỐN kho, không phải một. Không trỏ nốt hai kho này đi chỗ
// khác thì bài kiểm thử đọc tệp khách hàng và kho ghi đè THẬT của máy đang
// chạy: trên máy sạch thì xanh, trên máy vận hành thì đỏ vì dữ liệu chứ không
// vì mã — cùng một commit cho hai kết quả khác nhau.
process.env.CUSTOMER_FILE_PATH = path.join(directory, 'customer-file.json');
process.env.CUSTOMER_EDITS_PATH = path.join(directory, 'customer-edits.json');
writeFileSync(storePath, JSON.stringify({ conversations: [], messages: {} }));
process.on('exit', () => rmSync(directory, { recursive: true, force: true }));

// Kho nhận ra "tiến trình khác vừa ghi tệp" bằng mốc sửa. Trên Windows mốc sửa có thể TRÙNG với lần kho tự ghi
// ngay trước đó (ghi liền nhau trong cùng một nhịp đồng hồ), kho tưởng tệp chưa đổi và giữ bản cũ trong bộ nhớ:
// bài kiểm thử chập chờn ~1/5 lần. Mỗi lần gieo đặt một mốc sửa riêng (quá khứ, không trùng) để kho luôn đọc lại.
let seedCount = 0;
export function seed(store) {
  writeFileSync(storePath, JSON.stringify({ messages: {}, ...store }));
  seedCount += 1;
  const stamp = new Date(Date.UTC(2020, 0, 1) + seedCount * 1000);
  utimesSync(storePath, stamp, stamp);
}
