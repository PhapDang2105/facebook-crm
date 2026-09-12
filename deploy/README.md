# Triển khai

Thư mục này chứa mọi thứ cần để đưa CRM lên một máy chủ Debian sạch.

| Tệp | Vai trò |
| --- | --- |
| `setup-server.sh` | Script cài đặt một lần: Node.js, Caddy, người dùng dịch vụ, mã nguồn, systemd |
| `facebook-crm.service` | Unit systemd để CRM tự chạy lại khi lỗi hoặc khi máy khởi động |
| `Caddyfile` | Reverse proxy, HTTPS tự động, và Basic Auth bảo vệ giao diện |

## Vì sao cần Basic Auth

Ứng dụng CRM **chưa có cơ chế đăng nhập**. Nếu đưa thẳng ra Internet, bất kỳ ai biết địa chỉ đều đọc được toàn bộ tin nhắn khách hàng và gửi tin dưới danh nghĩa Facebook Page.

`Caddyfile` xử lý việc đó bằng cách chia hai nhánh:

- `/webhooks/facebook` đi thẳng, không hỏi mật khẩu. Meta gọi bằng máy nên không đăng nhập được; bản thân endpoint này đã tự xác thực bằng chữ ký `X-Hub-Signature-256`.
- `/product-images/*` cũng đi thẳng: Messenger tải ảnh sản phẩm từ đây để hiện trên receipt và sau bảng giá.
- Mọi đường dẫn còn lại yêu cầu tên đăng nhập và mật khẩu.

Khi nào CRM có đăng nhập riêng thì có thể bỏ lớp này.

## Các bước

Trên máy chủ, với quyền root:

```bash
curl -fsSL https://raw.githubusercontent.com/OWNER/REPO/main/deploy/setup-server.sh -o setup-server.sh
sudo bash setup-server.sh fb.example.com https://github.com/OWNER/REPO.git
```

Script sẽ hỏi tên đăng nhập quản trị rồi yêu cầu nhập mật khẩu để băm bằng `caddy hash-password`. Mật khẩu không được lưu ở dạng gốc ở bất kỳ đâu.

Sau khi script chạy xong:

1. Sửa `/opt/facebook-crm/.env`, điền `META_APP_ID`, `META_APP_SECRET`, `META_GRAPH_VERSION`, `META_VERIFY_TOKEN`.
2. `systemctl start facebook-crm`
3. Kiểm tra: `curl -s https://<domain>/api/health`

Điều kiện để Caddy xin được chứng chỉ: DNS của tên miền đã trỏ đúng về máy chủ, và cổng 80/443 mở trên tường lửa.

## Cập nhật về sau

```bash
cd /opt/facebook-crm
sudo -u crm git pull --ff-only
sudo -u crm npm install --omit=dev
sudo systemctl restart facebook-crm
```

Dữ liệu chạy thật nằm trong `/opt/facebook-crm/data/processed/` và không bị `git pull` đụng tới vì đã nằm trong `.gitignore`. Vẫn nên sao lưu thư mục đó trước khi cập nhật lớn.
