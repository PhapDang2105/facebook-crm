| `app/customers.mjs` | Gộp mọi luồng của một người thành danh sách Khách hàng, lọc remarketing, xuất CSV |
| `app/customer-file.mjs`, `customer-edits.mjs` | Tệp khách của đơn đã xuất kho; kho ghi đè giữ phần nhân viên tự nhập (khoá theo số điện thoại) |
| `app/order-archive.mjs` | Kho lưu trữ đơn theo tháng (NDJSON, chỉ ghi nối) |
| `app/processing/address-ai.mjs` | Suy luận địa chỉ ba cấp bằng Vertex khi bộ luật không tách đủ |
# Kiến trúc hệ thống

## Thành phần

Giao diện là một trang HTML/CSS/JS thuần (`web/`), không build. Server là một tiến trình Node (`app/server.mjs`) phục vụ tĩnh, REST API và Server-Sent Events; dữ liệu là các file JSON trong `data/processed/` ghi bằng hàng đợi tuần tự (atomic rename).

| Module | Vai trò |
| --- | --- |
| `app/server.mjs` | HTTP server, định tuyến API, phục vụ `web/` và ảnh sản phẩm |
| `app/config.mjs` | Đọc `.env`, cấu hình Meta, landing, server |
| `app/channel-store.mjs`, `meta-graph.mjs`, `meta-webhook.mjs`, `meta-sync.mjs` | Kết nối Facebook Page: OAuth, Graph API, webhook (kiểm chữ ký), đồng bộ hội thoại, gửi tin |
| `app/messaging-store.mjs`, `message-events.mjs` | Lưu hội thoại/tin nhắn, pub/sub cho SSE |
| `app/chatbot-engine.mjs`, `chatbot-settings.mjs`, `chatbot-templates.mjs`, `vertex-auth.mjs` | Chatbot: system prompt, mẫu tin, gọi Vertex AI |
| `app/processing/*` | Luồng xử lý chatbot: danh mục (`catalog`), nhận diện sản phẩm (`product-detect`), tính tiền (`pricing`), tách địa chỉ ba cấp (`locations`), gắn thẻ (`auto-label`), đơn dở (`pending-order`) |
| `app/conversation-orders.mjs` | Đơn chatbot tạo từ hội thoại |
| `app/landing-orders.mjs`, `pos-sync.mjs` | Đơn landing page (webhook Webcake) và đồng bộ đơn từ Pancake POS mỗi 5 phút, tự điền cho đơn bỏ dở |
| `app/phone-warnings.mjs` | Tỷ lệ nhận hàng theo số điện thoại từ Pancake POS, có cache |
| `app/order-notes.mjs` | Ghi chú xử lý cho từng đơn (thiếu gì, tự điền gì, tỷ lệ nhận hàng) |
| `app/order-edits.mjs` | Nhân viên sửa đơn từ bảng Xử lý dữ liệu, ghi về kho đơn |
| `app/order-export.mjs`, `xlsx-import.mjs` | Dựng file xuất kho theo mẫu Pancake, đọc file import |
| `app/customers.mjs` | Gộp mọi luồng của một người thành danh sách Khách hàng, lọc remarketing, xuất CSV |
| `app/customer-file.mjs` | Tệp khách của đơn đã xuất kho, giữ từng đơn theo số điện thoại |
| `app/customer-edits.mjs` | Kho ghi đè: phần nhân viên tự nhập ở hộp chi tiết, khoá theo số điện thoại đã chuẩn hoá |
| `app/order-archive.mjs` | Kho lưu trữ đơn theo tháng (NDJSON, chỉ ghi nối, dòng sau cùng của một mã là bản đúng) |
| `app/processing/address-ai.mjs` | Suy luận địa chỉ ba cấp bằng Vertex khi bộ luật không tách đủ, có cache |
| `app/products.mjs`, `inbox-settings.mjs`, `spx-tracking.mjs` | Danh mục sản phẩm/quà, cài đặt hộp thư, tra vận đơn SPX |

Dữ liệu vận hành (không commit): `meta-channels.json`, `meta-conversations.json`, `landing-orders.json`, `phone-warnings.json`, `pos-config.json`, `products.json`, `gifts.json`, `chatbot-settings.json`, `inbox-settings.json`, `customer-file.json`, `customer-edits.json`, `address-ai-cache.json`, `order-archive/YYYY-MM.ndjson`, `product-images/`.

> **Sao lưu:** mọi tệp trên đều dựng lại được từ nguồn khác, TRỪ `customer-edits.json` — đó là nơi duy nhất giữ phần nhân viên tự nhập (sửa thông tin, thẻ, ghi chú). Mất tệp này là mất hẳn.

## API

- Sức khỏe: `GET /api/health`
- Kênh: `GET /api/channels`; `GET /api/channels/meta/connect`, `/callback`, `/pending`, `POST /api/channels/meta/confirm`; `POST /api/channels/facebook/{pageId}/refresh`, `/profiles`, `DELETE /api/channels/facebook/{pageId}`
- Webhook: `GET|POST /webhooks/facebook` (Meta), `POST /webhooks/landing?token=` (Webcake)
- Hộp thư: `GET /api/messaging/conversations?channelId=`; `GET|POST .../conversations/{id}/messages`; `POST .../read`; `PATCH .../flags`; `.../customer-panel`; `POST /api/messaging/sync`; `GET /api/messaging/stream` (SSE); `GET|PUT /api/inbox/settings`
- Chatbot: `GET|PUT /api/chatbot/settings`; `POST /api/chatbot/test`; `GET /api/chatbot/pipeline`, `/api/chatbot/pipeline/{step}`
- Danh mục: `GET|POST /api/products`, `PUT|DELETE /api/products/{id}`; `GET|PUT /api/gifts`
- Đơn hàng: `GET /api/customer-orders` (chatbot + landing, kèm ghi chú xử lý); `PATCH|DELETE /api/customer-orders/{id}`; `POST /api/orders/import/xlsx`; `POST /api/orders/export/preview`; `POST /api/orders/export`
- Landing/POS: `POST /api/landing/sync-pos`; `GET /api/landing/recent` (đối chiếu payload)
- Cảnh báo số điện thoại: `POST /api/phone-warnings/check`; `GET|POST|DELETE /api/phone-warnings/pos`
- Khách hàng: `GET /api/customers`, `/api/customers/export.csv`, `/api/customers/audience.csv`; hộp chi tiết: `PATCH /api/customers/{id}` (sửa tên/sđt/địa chỉ/giới tính, ô rỗng là gỡ phần đã sửa), `PUT /api/customers/{id}/labels`, `GET|POST /api/customers/{id}/notes`, `GET /api/customers/{id}/orders` (gộp tệp khách hàng + kho lưu trữ, khớp đúng số điện thoại)
- Kho lưu trữ đơn: `GET /api/orders/archive?q=&limit=`
- Vận chuyển: `GET /api/shipping/spx/track`

## Luồng dữ liệu chính

- Messenger: webhook Meta → kiểm chữ ký → `messaging-store` → SSE → hộp thư trong trình duyệt. Trả lời từ trình duyệt → Send API → lưu là tin đi → echo của Meta xác nhận.
- Đơn: chatbot (`conversation-orders`) và landing (`landing-orders`, `pos-sync`) cùng vào `GET /api/customer-orders` → bảng Đơn hàng: Nhập dữ liệu → Xử lý dữ liệu (ghi chú, sửa tại chỗ, đánh dấu đã xử lý) → Xuất dữ liệu (file kho).

Chi tiết kết nối Meta ở `integrations/meta/README.md`; luồng đơn, landing, POS ở `README.md` gốc.

## Hướng nâng cấp

Thay các hàm đọc/ghi JSON trong `messaging-store.mjs`, `landing-orders.mjs`, `phone-warnings.mjs` bằng một repository trên PostgreSQL, rồi thêm đăng nhập/phân quyền và nhật ký thao tác. Hiện giao diện được Caddy bảo vệ bằng Basic Auth (xem `deploy/`).
