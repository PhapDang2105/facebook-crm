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
| `app/pancake.mjs` | Page vận hành trong Pancake: nhận webhook tin nhắn, ghi hộp thư, bot trả lời ngược qua Public API của Pancake |
| `app/order-notes.mjs` | Ghi chú xử lý cho từng đơn (thiếu gì, tự điền gì, tỷ lệ nhận hàng) |
| `app/order-edits.mjs` | Nhân viên sửa đơn từ bảng Xử lý dữ liệu, ghi về kho đơn |
| `app/order-export.mjs`, `xlsx-import.mjs` | Dựng file xuất kho theo mẫu Pancake, đọc file import |
| `app/customers.mjs` | Gộp mọi luồng của một người thành danh sách Khách hàng, lọc remarketing, xuất CSV |
| `app/customer-file.mjs` | Tệp khách của đơn đã xuất kho, giữ từng đơn theo số điện thoại |
| `app/customer-edits.mjs` | Kho ghi đè: phần nhân viên tự nhập ở hộp chi tiết, khoá theo số điện thoại đã chuẩn hoá |
| `app/order-archive.mjs` | Kho lưu trữ đơn theo tháng (NDJSON, chỉ ghi nối, dòng sau cùng của một mã là bản đúng) |
| `app/processing/address-ai.mjs` | Suy luận địa chỉ ba cấp bằng Vertex khi bộ luật không tách đủ, có cache |
| `app/meta-ads.mjs` | Đọc Facebook Marketing API (chỉ GET, quyền `ads_read`): chi tiêu/hiển thị/lượt bấm/tin nhắn theo ngày × quảng cáo và danh sách chiến dịch, lưu `ad-insights.json` (120 ngày), đồng bộ nền mỗi 60 phút |
| `app/campaigns.mjs` | Báo cáo Chiến dịch: quy đơn hội thoại (lần bấm quảng cáo gần nhất trong `CAMPAIGN_ATTRIBUTION_DAYS` ngày, mặc định 7) và đơn landing (utm_campaign) về chiến dịch, tính CPA/ROAS, `blended` (mọi đơn trên toàn bộ chi tiêu); khoảng `days` hoặc `from`/`to` |
| `app/order-facts.mjs` | Bộ gom đơn dùng chung: đơn hội thoại + landing thành sự kiện đơn phẳng (nguồn chatbot/landing/pos/import, hủy, bỏ dở, doanh thu từng dòng, khóa khách theo SĐT), khử trùng theo mã; luật hủy/bỏ dở; tiện ích khoảng ngày giờ Việt Nam |
| `app/dashboard.mjs` | Tổng quan: KPI hôm nay/7/30 ngày so với kỳ trước, theo ngày, nguồn, sản phẩm và chiến dịch dẫn đầu, việc cần làm |
| `app/reports.mjs` | Báo cáo from/to theo ngày/tuần/tháng: doanh số, nguồn, sản phẩm, khách mới/quay lại, nhân viên, chiến dịch, bám đuổi; xuất CSV từng phần |
| `app/products.mjs`, `inbox-settings.mjs`, `spx-tracking.mjs` | Danh mục sản phẩm/quà, cài đặt hộp thư, tra vận đơn SPX |

Dữ liệu vận hành (không commit): `meta-channels.json`, `meta-conversations.json`, `landing-orders.json`, `phone-warnings.json`, `pos-config.json`, `products.json`, `gifts.json`, `chatbot-settings.json`, `inbox-settings.json`, `customer-file.json`, `customer-edits.json`, `address-ai-cache.json`, `ad-insights.json`, `order-archive/YYYY-MM.ndjson`, `product-images/`.

> **Sao lưu:** mọi tệp trên đều dựng lại được từ nguồn khác, TRỪ `customer-edits.json` — đó là nơi duy nhất giữ phần nhân viên tự nhập (sửa thông tin, thẻ, ghi chú). Mất tệp này là mất hẳn.

## API

- Sức khỏe: `GET /api/health`
- Kênh: `GET /api/channels`; `GET /api/channels/meta/connect`, `/callback`, `/pending`, `POST /api/channels/meta/confirm`; `POST /api/channels/facebook/{pageId}/refresh`, `/profiles`, `DELETE /api/channels/facebook/{pageId}`
- Webhook: `GET|POST /webhooks/facebook` (Meta), `POST /webhooks/landing?token=` (Webcake), `POST /webhooks/pancake?token=` (tin nhắn từ Pancake)
- Hộp thư: `GET /api/messaging/conversations?channelId=`; `GET|POST .../conversations/{id}/messages`; `POST .../read`; `PATCH .../flags`; `.../customer-panel`; `POST /api/messaging/sync`; `GET /api/messaging/stream` (SSE); `GET|PUT /api/inbox/settings`
- Chatbot: `GET|PUT /api/chatbot/settings`; `POST /api/chatbot/test`; `GET /api/chatbot/pipeline`, `/api/chatbot/pipeline/{step}`
- Danh mục: `GET|POST /api/products`, `PUT|DELETE /api/products/{id}`; `GET|PUT /api/gifts`
- Đơn hàng: `GET /api/customer-orders` (chatbot + landing, kèm ghi chú xử lý); `PATCH|DELETE /api/customer-orders/{id}`; `POST /api/orders/import/xlsx`; `POST /api/orders/export/preview`; `POST /api/orders/export`
- Landing/POS: `POST /api/landing/sync-pos`; `GET /api/landing/recent` (đối chiếu payload)
- Cảnh báo số điện thoại: `POST /api/phone-warnings/check`; `GET|POST|DELETE /api/phone-warnings/pos`
- Khách hàng: `GET /api/customers`, `/api/customers/export.csv`, `/api/customers/audience.csv`; hộp chi tiết: `PATCH /api/customers/{id}` (sửa tên/sđt/địa chỉ/giới tính, ô rỗng là gỡ phần đã sửa), `PUT /api/customers/{id}/labels`, `GET|POST /api/customers/{id}/notes`, `GET /api/customers/{id}/orders` (gộp tệp khách hàng + kho lưu trữ, khớp đúng số điện thoại)
- Kho lưu trữ đơn: `GET /api/orders/archive?q=&limit=`
- Vận chuyển: `GET /api/shipping/spx/track`
- Chiến dịch: `GET /api/campaigns?days=7|14|30|90` hoặc `?from=YYYY-MM-DD&to=YYYY-MM-DD` (giờ Việt Nam; báo cáo: `range`, `ads` trạng thái kết nối, `totals` (chỉ đơn đã quy), `blended` (`orders, revenue, spend, cpa, roas` của mọi đơn trên toàn bộ chi tiêu), `campaigns[]` kèm `daily[]`, `unattributed`; CPA/ROAS `null` khi không có chi tiêu); `POST /api/campaigns/sync` (`{ "days": 30 }`, kéo lại số liệu Meta rồi trả báo cáo; lỗi Meta trả 502 kèm lời giải thích); `GET /api/campaigns/insights` (lần phân tích AI gần nhất hoặc `null`), `POST /api/campaigns/insights` (`{ "days": 7 }`, chạy cố vấn AI trên báo cáo)

- Tổng quan: `GET /api/dashboard?days=1|7|30` (mặc định 7; 1 = hôm nay giờ Việt Nam) hoặc `?from=YYYY-MM-DD&to=YYYY-MM-DD` (khoảng tự chọn, giờ Việt Nam, tính cả ngày cuối; đảo ngược thì đổi chỗ, ngày cuối quá hôm nay lùi về hôm nay, tối đa 366 ngày; sai dạng → 400; `range.custom: true`), kỳ so sánh là kỳ liền trước cùng độ dài: `range`, `previous`, `kpis` (`{value, prev}`: revenue, orders, aov, spend, roas, newCustomers, conversations, conversionRate; `activeCampaigns.value`), `daily[]`, `sources[]`, `topProducts[]`, `topCampaigns[]`, `todo`, `ads`
- Báo cáo: `GET /api/reports?from=&to=&groupBy=day|week|month` (mặc định 30 ngày gần nhất theo ngày, tối đa 366 ngày): `range`, `sales` (`rows[]` + `totals`), `sources[]`, `products[]`, `customers`, `staff[]`, `campaigns[]`, `followUps`; `GET /api/reports/export.csv?from&to&groupBy&section=sales|products|sources|staff|campaigns` (CSV UTF-8 có BOM, tiêu đề tiếng Việt, tệp `bao-cao-<section>-<from>-<to>.csv`)

## Luồng dữ liệu chính

- Messenger: webhook Meta → kiểm chữ ký → `messaging-store` → SSE → hộp thư trong trình duyệt. Trả lời từ trình duyệt → Send API → lưu là tin đi → echo của Meta xác nhận.
- Đơn: chatbot (`conversation-orders`) và landing (`landing-orders`, `pos-sync`) cùng vào `GET /api/customer-orders` → bảng Đơn hàng: Nhập dữ liệu → Xử lý dữ liệu (ghi chú, sửa tại chỗ, đánh dấu đã xử lý) → Xuất dữ liệu (file kho).
- Số liệu: `order-facts` gom cùng các đơn đó (một luật hủy/bỏ dở) → `campaigns` (ghép chi tiêu `ad-insights.json`), `dashboard`, `reports` — chỉ đọc, không ghi kho.

Chi tiết kết nối Meta ở `integrations/meta/README.md`; luồng đơn, landing, POS ở `README.md` gốc.

## Hướng nâng cấp

Thay các hàm đọc/ghi JSON trong `messaging-store.mjs`, `landing-orders.mjs`, `phone-warnings.mjs` bằng một repository trên PostgreSQL, rồi thêm phân quyền và nhật ký thao tác. Đăng nhập: `app/auth.mjs` (tài khoản trong `CRM_LOGIN_USERS`, cookie phiên ký HMAC) chặn mọi đường trừ webhook, `/q/*`, ảnh sản phẩm, `/privacy` và trang `/login`; Caddy vẫn có thể giữ Basic Auth phía trước (xem `deploy/`).
