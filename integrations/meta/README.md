# Kết nối Facebook Page

Trang **Cài đặt → Kết nối kênh** hỗ trợ nhiều Facebook Page. Mã truy cập Page chỉ được lưu ở máy chủ và được mã hóa bằng App Secret; trình duyệt không lưu mã truy cập.

## Cấu hình Meta App

Thiết lập các biến môi trường trước khi chạy `run.ps1`:

- `META_APP_ID`: App ID của ứng dụng Meta.
- `META_APP_SECRET`: App Secret của ứng dụng Meta.
- `META_GRAPH_VERSION`: phiên bản Graph API mà ứng dụng đang dùng, ví dụ `vXX.X`.
- `META_REDIRECT_URI`: không bắt buộc khi chạy ở cổng 8080; mặc định là `http://localhost:8080/api/channels/meta/callback`.

Redirect URI trong Meta App phải khớp chính xác với `META_REDIRECT_URI`. Ứng dụng yêu cầu các quyền `pages_show_list`, `pages_read_engagement`, `pages_manage_metadata` và `pages_messaging`.

Sau khi cấu hình, khởi động lại CRM, mở **Cài đặt**, chọn **Kết nối Facebook Page**, đăng nhập Facebook và chọn các Page cần sử dụng.

## Bảo mật và vận hành

- Không ghi App Secret hoặc Page Access Token vào mã nguồn, HTML hay localStorage.
- Tệp `data/processed/meta-channels.json` chứa mã truy cập đã mã hóa và đã được loại khỏi Git.
- Nếu App Secret thay đổi, cần ngắt và kết nối lại các Page vì mã truy cập cũ không thể giải mã bằng khóa mới.
- Việc nhận tin nhắn thực tế còn yêu cầu cấu hình Webhooks Messenger và URL HTTPS công khai trong Meta App.
