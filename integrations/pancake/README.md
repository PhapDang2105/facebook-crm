# Pancake POS Open API

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
