# Kiểm thử

```bash
npm test                 # toàn bộ tests/*.test.mjs (node --test, mỗi tệp một tiến trình con)
npm run test:coverage    # như trên, kèm bảng độ phủ của app/ và tools-intent/
npm run test:integration # server thật + webhook Meta — đọc .env/dữ liệu thật, chỉ chạy khi cần
```

Chạy lẻ một tệp hay lọc theo tên test **phải kèm** `--import ./tests/helpers/quiet-console.mjs` (như `npm test`):

```bash
node --test --import ./tests/helpers/quiet-console.mjs tests/qr-bridge.test.mjs
node --test --import ./tests/helpers/quiet-console.mjs --test-name-pattern="bình luận" tests/comments.test.mjs
```

Thiếu `--import` thì kho dữ liệu không được trỏ về thư mục tạm (test có thể đọc/ghi `data/processed` thật) và log tiếng Việt
của app làm hỏng khung TAP của runner ("Unable to deserialize cloned data"). Đặt `CRM_TEST_VERBOSE=1` để xem lại log.

## Cô lập khỏi máy thật

- `app/config.mjs` **không nạp `.env`** khi chạy dưới `node --test` (`NODE_TEST_CONTEXT`) hay khi `CRM_SKIP_ENV_FILE=1`.
- `helpers/quiet-console.mjs` (nạp trước mọi tệp): đặt `CRM_SKIP_ENV_FILE=1`, `POS_API_KEY`/`POS_SHOP_ID` rỗng, và trỏ mọi
  biến đường dẫn kho (`META_CONVERSATIONS_PATH`, `QR_SCANS_PATH`, `LANDING_ORDERS_PATH`, `POS_CONFIG_PATH`, `POS_COMBOS_PATH`,
  `STAFF_PATH`, `AUDIT_LOG_DIR`, `CHATBOT_SETTINGS_PATH`, `META_CHANNELS_PATH`, `CRM_DATA_DIR`, …) về một thư mục tạm riêng
  của từng tệp test; `PRODUCTS_PATH`/`GIFTS_PATH` là bản sao tệp mẫu. Tệp test cần dữ liệu riêng cứ gán biến trước khi
  `await import('../app/…')`. Thêm kho mới trong app (biến `*_PATH` mới) thì thêm vào danh sách trong quiet-console và
  `test-isolation.test.mjs`.
- `helpers/seed-catalog.mjs`: import đầu tiên trong test nào cần danh mục riêng — bản sao tạm của seed, sửa trong test này
  không lọt sang test khác.
- `helpers/temp-messaging-store.mjs`: kho hội thoại tạm + `seed(store)` để ghi sẵn dữ liệu.
- `helpers/temp-dir.mjs`: `tempDir(prefix)` thay cho `mkdtempSync` — thư mục tạm tự xoá khi tiến trình test thoát.
- `helpers/fake-dns.mjs`: `installFakeDns()` thay `dns.promises.lookup` bằng bản giả (endpoint AI tuỳ chỉnh đi qua
  `assertPublicHost` tra DNS thật) — test không phụ thuộc mạng máy chạy.

## Nhanh

Engine chatbot đợi gom tin (`fragmentWaitMs`, mặc định 4 giây; tin chỉ SĐT gấp đôi): settings trong test đặt
`fragmentWaitMs: 0` trừ khi đang kiểm chính việc đợi. Còn một chỗ đợi cứng 3 giây trong `app/chatbot-engine.mjs`
(thử lại tin riêng của bình luận khi lỗi tạm) chưa tiêm được.

## Tệp đáng chú ý

- `catalog-pricing.test.mjs`: danh mục → giá → quà theo tổ hợp → đơn → file xuất kho.
- `test-isolation.test.mjs`: canh các điều trên (không nạp `.env`, kho về thư mục tạm, `tempDir` dọn đúng).
- `tools-intent.test.mjs`, `intent-*.test.mjs`, `order-coverage.test.mjs`: CLI trong `tools-intent/` chạy bằng `spawnSync`
  (kế thừa biến môi trường đã trỏ về thư mục tạm).
- `integration/meta-webhook.integration.mjs`: khởi động server thật với store tạm và bắn webhook (`npm run test:integration`).
