# Kiểm thử

- `*.test.mjs`: kiểm thử đơn vị từng module (`npm test`).
- `helpers/seed-catalog.mjs`: import đầu tiên trong test nào cần danh mục — trỏ `PRODUCTS_PATH`/`GIFTS_PATH` vào bản sao tạm của seed, không đụng `data/processed`.
- `catalog-pricing.test.mjs`: danh mục → giá → quà theo tổ hợp → đơn → file xuất kho.
- `domain/run-tests.mjs`: kiểm thử miền lead.
- `integration/meta-webhook.integration.mjs`: khởi động server thật với store tạm và bắn webhook (`npm run test:integration`).
