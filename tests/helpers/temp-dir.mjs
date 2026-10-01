import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Thư mục tạm cho test, tự xoá khi tiến trình test thoát (mỗi tệp *.test.mjs chạy
// trong một tiến trình con riêng của node --test). Dùng thay cho mkdtempSync cấp
// module — trước đây mỗi lần `npm test` để lại vài chục thư mục trong %TEMP%.
const created = new Set();
let hooked = false;

/** Xoá các thư mục tạm đã tạo (mặc định: tất cả; truyền danh sách để chỉ xoá vài thư mục). */
export function cleanupTempDirs(directories = [...created]) {
  for (const directory of directories) {
    try { rmSync(directory, { recursive: true, force: true }); } catch {}
    created.delete(directory);
  }
}

/** Tạo thư mục tạm mới (tiền tố `prefix`) và hẹn xoá lúc tiến trình thoát. */
export function tempDir(prefix = 'crm-test-') {
  const directory = mkdtempSync(path.join(os.tmpdir(), prefix));
  created.add(directory);
  if (!hooked) {
    hooked = true;
    process.on('exit', () => cleanupTempDirs());
  }
  return directory;
}
