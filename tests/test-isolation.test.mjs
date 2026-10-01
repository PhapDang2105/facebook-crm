import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { cleanupTempDirs, tempDir } from './helpers/temp-dir.mjs';
import { shouldSkipEnvironmentFile } from '../app/config.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const realData = path.join(projectRoot, 'data');

test('config: không nạp .env khi chạy dưới node --test hay CRM_SKIP_ENV_FILE=1; chạy app thường thì nạp', () => {
  assert.equal(shouldSkipEnvironmentFile({ NODE_TEST_CONTEXT: 'child-v8' }), true);
  assert.equal(shouldSkipEnvironmentFile({ CRM_SKIP_ENV_FILE: '1' }), true);
  assert.equal(shouldSkipEnvironmentFile({ CRM_SKIP_ENV_FILE: '0' }), false);
  assert.equal(shouldSkipEnvironmentFile({}), false);
  assert.equal(shouldSkipEnvironmentFile(), true, 'tiến trình test hiện tại');
});

test('quiet-console: mọi kho dữ liệu trỏ về thư mục tạm, khoá POS rỗng, danh mục là bản sao tệp mẫu', () => {
  const names = ['META_CONVERSATIONS_PATH', 'META_CHANNELS_PATH', 'CHATBOT_SETTINGS_PATH', 'CUSTOMER_FILE_PATH', 'CUSTOMER_EDITS_PATH',
    'FOLLOW_UPS_PATH', 'QR_SCANS_PATH', 'QR_SETTINGS_PATH', 'LANDING_ORDERS_PATH', 'POS_CONFIG_PATH', 'POS_COMBOS_PATH',
    'PHONE_WARNINGS_PATH', 'INBOX_SETTINGS_PATH', 'EXPORT_HISTORY_PATH', 'GOLDEN_SET_PATH', 'ADDRESS_AI_CACHE_PATH',
    'AD_INSIGHTS_PATH', 'CAMPAIGN_AI_PATH', 'STAFF_PATH', 'ORDER_ARCHIVE_PATH', 'EXPORT_FILES_DIR', 'DECISION_LOG_DIR',
    'AUDIT_LOG_DIR', 'CRM_DATA_DIR', 'PRODUCTS_PATH', 'GIFTS_PATH'];
  for (const name of names) {
    const value = process.env[name];
    assert.ok(value, `${name} phải được đặt`);
    assert.ok(path.resolve(value).startsWith(path.resolve(os.tmpdir())), `${name} nằm trong thư mục tạm (${value})`);
    assert.ok(!path.resolve(value).startsWith(realData), `${name} không trỏ vào data/ thật`);
  }
  assert.equal(process.env.POS_API_KEY, '');
  assert.equal(process.env.POS_SHOP_ID, '');
  assert.equal(process.env.CRM_SKIP_ENV_FILE, '1');
  assert.ok(existsSync(process.env.PRODUCTS_PATH) && existsSync(process.env.GIFTS_PATH));
});

test('tempDir: tạo thư mục riêng mỗi lần, cleanupTempDirs xoá đúng các thư mục được chỉ', () => {
  const a = tempDir('crm-isolation-');
  const b = tempDir('crm-isolation-');
  assert.notEqual(a, b);
  assert.ok(existsSync(a) && existsSync(b));
  cleanupTempDirs([a, b]);
  assert.ok(existsSync(process.env.CRM_TEST_SANDBOX), 'thư mục tạm của quiet-console còn nguyên');
  assert.ok(!existsSync(a) && !existsSync(b));
});
