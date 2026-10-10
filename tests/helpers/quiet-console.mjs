// Nạp trước mọi tệp test (`node --test --import ./tests/helpers/quiet-console.mjs`, xem package.json):
// 1) cô lập test khỏi dữ liệu/.env THẬT của máy, 2) tắt console.log của mã app.
//
// (2) Lý do tắt log: runner của node:test (FileTest.#processRawBuffer) đọc stdout của tiến trình con vừa có khung
// TAP tuần tự hoá vừa có chữ thô; một dòng log tiếng Việt có byte thứ hai ≥ 0x80 ("Mô hình nhỏ…",
// "Luật…") nằm ngay sau khung test:pass làm runner tính sai độ dài khung và ném
// "Unable to deserialize cloned data" → cả tệp test fail ngẫu nhiên (7/15 lần với round3-chatbot).
// Đặt CRM_TEST_VERBOSE=1 để xem lại log khi cần soi.
import { copyFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tempDir } from './temp-dir.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

// app/config.mjs bỏ qua .env khi có NODE_TEST_CONTEXT (node --test) hoặc CRM_SKIP_ENV_FILE=1; đặt cả
// cờ này để chạy lẻ `node --import ./tests/helpers/quiet-console.mjs tests/x.test.mjs` cũng không nạp .env.
process.env.CRM_SKIP_ENV_FILE = '1';
// Khoá POS thật (biến môi trường của máy) không được lọt vào test: tra đơn/đẩy đơn POS phải đi qua fetch giả.
process.env.POS_API_KEY = '';
process.env.POS_SHOP_ID = '';

// Mọi kho dữ liệu của app mặc định nằm ở data/processed THẬT. Trỏ hết về một thư mục tạm (tự xoá khi tiến trình
// thoát); tệp test cần dữ liệu riêng vẫn tự đặt lại biến trước khi import app (gán đè, không bị chặn ở đây).
// Không đụng INTENT_MODEL_PATH / INTENT_CASCADE_PATH / LOCATIONS_PATH: đó là tệp đi kèm mã nguồn, không phải dữ liệu.
const sandbox = tempDir('crm-test-data-');
// Biến do quiet-console của tiến trình CHA đặt (runner node --test cũng nạp --import rồi truyền env xuống) trỏ vào
// thư mục tạm của cha: mỗi tệp test lấy thư mục riêng để các tệp chạy song song không ghi chung một kho.
const inherited = process.env.CRM_TEST_SANDBOX || '';
const ownedByParent = value => Boolean(inherited) && String(value || '').startsWith(inherited);
process.env.CRM_TEST_SANDBOX = sandbox;
const sandboxFiles = {
  META_CONVERSATIONS_PATH: 'meta-conversations.json',
  META_CHANNELS_PATH: 'meta-channels.json',
  CHATBOT_SETTINGS_PATH: 'chatbot-settings.json',
  CUSTOMER_FILE_PATH: 'customer-file.json',
  CUSTOMER_EDITS_PATH: 'customer-edits.json',
  FOLLOW_UPS_PATH: 'follow-ups.json',
  QR_SCANS_PATH: 'qr-scans.json',
  QR_SETTINGS_PATH: 'qr-settings.json',
  LANDING_ORDERS_PATH: 'landing-orders.json',
  POS_CONFIG_PATH: 'pos-config.json',
  POS_COMBOS_PATH: 'pos-combos.json',
  PHONE_WARNINGS_PATH: 'phone-warnings.json',
  INBOX_SETTINGS_PATH: 'inbox-settings.json',
  EXPORT_HISTORY_PATH: 'export-history.json',
  GOLDEN_SET_PATH: 'golden-set.json',
  ADDRESS_AI_CACHE_PATH: 'address-ai-cache.json',
  AD_INSIGHTS_PATH: 'ad-insights.json',
  CAMPAIGN_AI_PATH: 'campaign-ai.json',
  STAFF_PATH: 'staff.json',
  ORDER_ARCHIVE_PATH: 'order-archive',
  EXPORT_FILES_DIR: 'exports',
  DECISION_LOG_DIR: 'decision-log',
  // Nhật ký hoạt động (app/audit-log.mjs) đọc AUDIT_LOG_DIR mỗi lần ghi: test đi qua đường ghi thẻ/bot tự động
  // (follow-up, server) không được ghi vào data/processed/audit-log THẬT.
  AUDIT_LOG_DIR: 'audit-log',
  // tools-intent (build-dataset, label-dataset) đọc kho ở CRM_DATA_DIR.
  CRM_DATA_DIR: 'data'
};
for (const [name, file] of Object.entries(sandboxFiles)) {
  if (!process.env[name] || ownedByParent(process.env[name])) process.env[name] = path.join(sandbox, file);
}

// Danh mục: bản sao tệp mẫu (như helpers/seed-catalog.mjs) để test không import seed-catalog cũng không đọc
// products.json/gifts.json thật. seed-catalog vẫn đặt lại thư mục riêng của nó khi được import.
if (!process.env.PRODUCTS_PATH || ownedByParent(process.env.PRODUCTS_PATH)) {
  process.env.PRODUCTS_PATH = path.join(sandbox, 'products.json');
  copyFileSync(path.join(projectRoot, 'app', 'products.seed.json'), process.env.PRODUCTS_PATH);
}
if (!process.env.GIFTS_PATH || ownedByParent(process.env.GIFTS_PATH)) {
  process.env.GIFTS_PATH = path.join(sandbox, 'gifts.json');
  copyFileSync(path.join(projectRoot, 'app', 'gifts.seed.json'), process.env.GIFTS_PATH);
}

if (!process.env.CRM_TEST_VERBOSE) {
  console.log = () => {};
  console.info = () => {};
}
