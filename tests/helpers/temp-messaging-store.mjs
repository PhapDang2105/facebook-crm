import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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

export function seed(store) {
  writeFileSync(storePath, JSON.stringify({ messages: {}, ...store }));
}
