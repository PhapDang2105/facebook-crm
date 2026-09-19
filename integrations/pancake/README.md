# Pancake

Pancake có hai hệ thống với hai API riêng, cùng công ty:

| Hệ thống | Việc | Tài liệu | Spec đã tải |
| --- | --- | --- | --- |
| **Pancake** (pages.fm, quản lý hội thoại đa kênh) | Nhận tin khách qua webhook, gửi tin trả lời, hội thoại, khách của Page | https://developer.pancake.biz/ và `/webhook` | `pancake-api.yaml`, `pancake-webhook.yaml` |
| **Pancake POS** (pos.pages.fm, bán hàng và kho) | Đơn, khách, sản phẩm, mã giảm giá, khuyến mãi | https://docs.pancake.biz/pos/api/ | `openapi.json` |

## Pancake (hội thoại): dùng bot của CRM trả lời khách qua Pancake

### Token

Hai loại token, đều truyền bằng tham số truy vấn, không có header:

- `access_token` (User Access Token): cấp tài khoản, lấy ở pages.fm → Tài khoản → Cài đặt cá nhân → API Access Token. Chỉ dùng cho `GET https://pages.fm/api/v1/pages` (liệt kê Page) và `POST /pages/{page_id}/generate_page_access_token` (sinh token cho Page). Hết hạn khi đăng xuất hoặc sau 90 ngày không dùng.
- `page_access_token` (Page Access Token): cấp Page, dùng cho mọi API dưới `https://pages.fm/api/public_api/v1` và `/v2`. Sinh bằng token trên, hoặc trong Pancake: Cài đặt → Tích hợp → Public API.

### Endpoint cần cho luồng bot

- `GET /public_api/v2/pages/{page_id}/conversations?page_access_token=` — 60 hội thoại mới nhất, lọc `type` (INBOX, COMMENT...), `since/until`, `unread_first`, phân trang bằng `last_conversation_id`.
- `GET /public_api/v1/pages/{page_id}/conversations/{conversation_id}/messages` — 30 tin gần nhất, lùi bằng `current_count`; trả kèm thông tin khách và hội thoại.
- `POST /public_api/v1/pages/{page_id}/conversations/{conversation_id}/messages` — gửi tin. Body tin nhắn inbox: `{ "action": "reply_inbox", "message": "..." }`; ảnh/tệp dùng `content_ids` (không gửi cùng `message`). Có thêm dạng trả lời bình luận và private reply.
- Khách của Page: `GET|PUT /pages/{page_id}/page_customers`, ghi chú khách, thẻ hội thoại (`POST .../tags`), gán nhân viên (`.../assign`), đánh dấu đã đọc.

### Webhook (nhận tin mới)

- Pancake POST JSON tới URL đã đăng ký; endpoint phải trả HTTP 200. Sự kiện: `messaging` (tin mới hoặc tin sửa, cả inbox lẫn bình luận), `conversation` (gán, thẻ, đã đọc...), `post`, `subscription`, `connect_status`.
- Payload `messaging`: `page_id`, `event_type`, `data.conversation` (id, type, from, tags, snippet, seen...), `data.message` (id, conversation_id, message, from {id, name, page_customer_id}, attachments, has_phone, phone_info, inserted_at), `data.post` với bình luận.
- Điều kiện: Pancake phải bật tính năng Webhook cho Page (liên hệ hỗ trợ Pancake, tốn 1 slot kết nối của gói), rồi đặt URL trong cài đặt công cụ của Page (cần quyền admin). Webhook bị tạm ngưng nếu trong 30 phút lỗi trên 80% và từ 300 lần, nên endpoint phải trả 200 nhanh và xử lý idempotent (một sự kiện có thể gửi hơn một lần).

### Phía CRM (`app/pancake.mjs`)

- Endpoint nhận: `POST ${PUBLIC_BASE_URL}/webhooks/pancake?token=<PANCAKE_WEBHOOK_TOKEN>`; sai token trả 401, chưa cấu hình trả 503, hợp lệ trả 200 ngay rồi mới xử lý.
- Chỉ nhận sự kiện `messaging` loại INBOX của đúng `PANCAKE_PAGE_ID`; bình luận và Page khác bỏ qua. Tin trùng mã (Pancake gửi lại khi cập nhật) không ghi hai lần, không gọi bot lần hai.
- Tin được ghi vào hộp thư như tin từ Meta; hội thoại giữ thêm mã hội thoại Pancake để gửi trả lời đúng chỗ. Ảnh khách lấy qua đường công khai `https://pancake.vn/api/v1/pages/{page_id}/avatar/{psid}` (không cần token, 301 tới ảnh trên CDN) nên hộp thư dùng thẳng làm `src`. Kênh ảo `PANCAKE_PAGE_NAME` xuất hiện ở hộp thư và Cài đặt → Kênh.
- Bot chạy qua cùng bộ xử lý với Meta; hội thoại có `assignee_ids` (nhân viên đã nhận trong Pancake) thì bot không trả lời trừ khi `PANCAKE_BOT_WHEN_ASSIGNED=1`. Nhân viên gõ trả lời trong Pancake (tin của Page mà `from.admin_name` khác "Public API", tên "Public API" là tin CRM gửi) thì bot tự tắt cho hội thoại đó (`botEnabled=false`, kèm `botPausedBy`); bật lại bằng công tắc Bot trong CRM.
- Mỗi hội thoại bot trả lời tuần tự: tin thứ hai của cùng khách chờ tin trước xong, và các tin chữ liền nhau chưa được trả lời (trong 10 phút, tối đa 5) được gộp thành một câu hỏi cho mô hình; tin đến trong lúc mô hình đang trả lời làm câu trả lời đó bị bỏ, tin sau trả lời gộp. (`app/chatbot-engine.mjs`, áp dụng cả Meta.)
- Ảnh: ảnh sản phẩm của mẫu tin và tệp nhân viên đính kèm từ CRM được tải lên bằng `POST /v1/pages/{page_id}/upload_contents` (multipart `file`) rồi gửi bằng `content_ids` (không gửi cùng `message`); mã nội dung của ảnh sản phẩm được nhớ 12 giờ. Pancake chỉ nhận tệp tới **500 KB** (trả 200 kèm `success:false`, "File size should not exceed 500KB"), nên ảnh lớn hơn được thu nhỏ (cạnh dài 1080px) và nén JPEG bằng `sharp` trước khi tải; tệp không phải ảnh phải tự nhỏ hơn 500 KB. Thẻ receipt của Messenger không gửi được qua Pancake và bản chữ chỉ lặp lại ORDER_CONFIRMATION, nên khi chốt đơn qua Pancake bot chỉ gửi tin xác nhận đơn, không gửi receipt. Ảnh/video khách gửi (và bản dội lại của ảnh Page gửi) có `attachments[].url` trên CDN Pancake, hộp thư hiện thẳng.
- Cấu hình trong `.env`: `PANCAKE_PAGE_ID`, `PANCAKE_PAGE_ACCESS_TOKEN`, `PANCAKE_WEBHOOK_TOKEN`, tuỳ chọn `PANCAKE_PAGE_NAME`, `PANCAKE_BOT_WHEN_ASSIGNED`. Caddy có khối `@pancake` cho đường này đi thẳng.
- Lịch sử: webhook chỉ mang tin mới, nên CRM còn kéo hội thoại inbox và tin gần đây bằng API liệt kê (`GET /v2/.../conversations`, `GET /v1/.../messages`) khi mở kênh lần đầu (`POST /api/messaging/sync`), lúc khởi động và mỗi 10 phút. Tin cùng mã không ghi trùng; tin kéo về không đưa bot.
- Lưu ý: nếu Facebook bật **Meta AI** cho Page (thanh dưới hội thoại trong Pancake ghi "Meta AI đang phản hồi"), Facebook tự gửi "Tác nhân AI sẽ phản hồi." và có thể trả lời song song với bot CRM. Tắt trong Meta Business Suite → Hộp thư → Tự động hoá.

## Pancake POS Open API

Nguồn: https://docs.pancake.biz/pos/api/ (spec OpenAPI 3.1 tải về ở `openapi.json`, lấy từ `https://docs.pancake.biz/pos/api/openapi.json?lang=vi`).

## Kết nối

- Base URL: `https://pos.pages.fm/api/v1`
- Xác thực: tham số truy vấn `api_key` trên mọi yêu cầu. Tạo khoá trong POS: **Cấu hình → Ứng dụng → API KEY → Thêm mới**. CRM đã lưu khoá này ở Cài đặt → Kênh (`app/phone-warnings.mjs`, `pos-config.json`) và dùng cho cảnh báo số điện thoại và đồng bộ đơn.
- Mọi endpoint nghiệp vụ nằm dưới `/shops/{SHOP_ID}/...`; `GET /shops` trả danh sách shop của khoá.

## Nhóm đang dùng trong CRM

- `GET /shops/{SHOP_ID}/orders` với `filter_status`, lọc theo số điện thoại: tỷ lệ nhận hàng (`phone-warnings.mjs`).
- `GET /shops/{SHOP_ID}/orders`, đơn landing/bỏ dở: đồng bộ 5 phút một lần vào bảng Đơn hàng (`pos-sync.mjs`).

## Mã giảm giá (`vouchers`)

| Endpoint | Việc |
| --- | --- |
| `GET /shops/{SHOP_ID}/vouchers` | Danh sách phiếu giảm giá |
| `POST /shops/{SHOP_ID}/vouchers` | Tạo phiếu giảm giá |
| `GET /shops/{SHOP_ID}/vouchers/{VOUCHER_ID}` | Chi tiết một phiếu |

Body tạo phiếu:

```json
{
  "name": "GIOTNANG10",
  "promo_code_info": { "discount": 10, "is_percent": true, "max_discount_by_percent": 30000 },
  "is_free_shipping": false,
  "is_activated": true,
  "customer_tags": ["Khách cũ"],
  "start_time": "2026-09-19T00:00:00Z",
  "end_time": "2026-10-19T00:00:00Z"
}
```

- `name` chính là mã khách nhập. `discount` là số tiền hoặc phần trăm tuỳ `is_percent`; `max_discount_by_percent` là trần khi giảm theo phần trăm.
- Phiếu trả về có `id` (uuid), `display_id`, `type` (`discount_by_coupon_id`), `is_used`, `customer_tags`. Không có endpoint cập nhật hay xoá phiếu; không có endpoint kiểm tra một mã có hợp lệ với một đơn hay không.
- Khi tạo đơn (`POST /shops/{SHOP_ID}/orders`) giảm giá đi qua các trường `discount`, `total_discount`, `activated_promotion_advances[]` (`promotion_advance_id`), `discount_by_customer_level`.

## Khuyến mãi theo khách (`promotion_advance`)

`POST /shops/{SHOP_ID}/promotion_advance/create_multi`: tạo khuyến mãi gắn cho danh sách `shop_customer_ids`, có `order_price_min/max`, thời hạn, thẻ khách. Phù hợp cho ưu đãi chăm sóc lại theo từng khách (tệp khách hàng) hơn là mã dùng chung.

## Khách hàng

`GET /shops/{SHOP_ID}/customers` (tìm theo `search`, lọc theo thời gian tạo/cập nhật), `POST` tạo khách (`name`, `phoneNumber` bắt buộc), `PUT` cập nhật, ghi chú và lịch sử điểm.

## Webhook

`PUT /shops/{SHOP_ID}` với `shop.webhook_enable`, `webhook_url`, `webhook_types` (`orders`, `customers`, `products`, `variations_warehouses`, `auto_call`), `webhook_headers`. POS gửi POST tới URL khi có thay đổi. Cấu hình cũng làm được trong POS: **Cấu hình → Nâng cao → Kết nối bên thứ 3 → Webhook/API**.
