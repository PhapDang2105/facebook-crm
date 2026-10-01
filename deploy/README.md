# Triển khai

Thư mục này chứa mọi thứ cần để đưa CRM lên một máy chủ Debian sạch.

| Tệp | Vai trò |
| --- | --- |
| `setup-server.sh` | Script cài đặt một lần: Node.js ≥ 22, Caddy, người dùng dịch vụ `crm`, mã nguồn, systemd, tài khoản chủ shop |
| `facebook-crm.service` | Unit systemd để CRM tự chạy lại khi lỗi hoặc khi máy khởi động |
| `Caddyfile` | Reverse proxy, HTTPS tự động, header bảo mật (không còn Basic Auth — CRM tự hỏi đăng nhập) |

## Đăng nhập (thay cho Basic Auth cũ)

Từ 01/10 máy chủ thật **không còn Basic Auth** ở Caddy: CRM tự hỏi đăng nhập ở `/login`. Tài khoản gồm chủ shop trong `.env` (`CRM_LOGIN_USERS`) và Cài đặt → Nhân sự (`data/processed/staff.json`, người đang làm có mật khẩu).

```bash
cd /opt/facebook-crm
sudo -u crm node app/auth.mjs hash-password   # nhập mật khẩu (≥ 8 ký tự), in ra chuỗi scrypt$…
```

```ini
CRM_LOGIN_USERS=huy:scrypt$…,lan:scrypt$…
CRM_SESSION_SECRET=<chuỗi ngẫu nhiên dài, ví dụ: openssl rand -hex 32>
# Tuỳ chọn: 1 = bắt buộc đăng nhập kể cả khi PUBLIC_BASE_URL không phải https;
# 0 = tắt bắt buộc (chỉ chạy local qua đường hầm https).
# CRM_REQUIRE_LOGIN=1
```

- **Không mở toang**: `PUBLIC_BASE_URL` là https (hoặc `CRM_REQUIRE_LOGIN=1`) mà chưa có tài khoản nào thì mọi trang/API trả **503 "Chưa cấu hình đăng nhập"**; chỉ webhook, `/q/*`, `/product-images/*`, `/privacy`, `/api/health` còn chạy. Máy local (http://localhost) chưa khai tài khoản thì vẫn dùng không cần đăng nhập.
- Đường công khai do CRM tự quyết: webhook Meta (chữ ký `X-Hub-Signature-256`), `/webhooks/landing` (`LANDING_WEBHOOK_TOKEN`), `/webhooks/pancake` (`PANCAKE_WEBHOOK_TOKEN`), `/q/*` (khách quét QR), `/product-images/*` (Messenger tải ảnh), `/privacy` (Meta kiểm tra).
- Phiên: cookie `HttpOnly` 30 ngày (`Secure` khi https). Đổi mật khẩu, cho nghỉ, đổi tên đăng nhập trong Nhân sự → mọi phiên cũ của người đó hết hiệu lực (chậm nhất 15 giây).
- Khoá đăng nhập: sai 10 lần / 15 phút theo **IP** (IP lấy từ `X-Forwarded-For` chỉ khi kết nối từ chính Caddy trên 127.0.0.1/::1) và 20 lần / 15 phút theo **tên đăng nhập**.
- Nhân viên thường (vai trò Nhân viên) không ghi được các mục Cài đặt (chatbot, sản phẩm, quà, kênh, POS, QR, Nhân sự, bám đuổi hàng loạt); chủ shop / Quản trị thì được.
- Header bảo mật (`nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: same-origin`, HSTS khi https, CSP cho trang HTML) do CRM tự gắn; `Caddyfile` gắn thêm khi CRM chưa gắn.

## Các bước

Trên máy chủ, với quyền root:

```bash
curl -fsSL https://raw.githubusercontent.com/OWNER/REPO/main/deploy/setup-server.sh -o setup-server.sh
sudo bash setup-server.sh fb.example.com https://github.com/OWNER/REPO.git
```

Script sẽ hỏi tên đăng nhập chủ shop rồi mật khẩu, băm bằng `node app/auth.mjs hash-password` và ghi `CRM_LOGIN_USERS` + `CRM_SESSION_SECRET` vào `.env` (nếu chưa có). Mật khẩu không được lưu ở dạng gốc ở bất kỳ đâu.

Sau khi script chạy xong:

1. Sửa `/opt/facebook-crm/.env`, điền `META_APP_ID`, `META_APP_SECRET`, `META_GRAPH_VERSION`, `META_VERIFY_TOKEN`.
2. `systemctl start facebook-crm`
3. Kiểm tra: `curl -s http://127.0.0.1:8080/api/health` — gọi API qua tên miền khi chưa đăng nhập sẽ ra 401 (CRM tự chặn mọi đường trừ `/login`, `/privacy`, `/q/*`, `/product-images` và các webhook)

Điều kiện để Caddy xin được chứng chỉ: DNS của tên miền đã trỏ đúng về máy chủ, và cổng 80/443 mở trên tường lửa.

## Cập nhật về sau

```bash
cd /opt/facebook-crm
sudo -u crm git pull --ff-only
sudo -u crm npm ci --omit=dev
sudo systemctl restart facebook-crm
```

Dùng `npm ci`, không dùng `npm install`: `npm install` trên máy chủ ghi lại `package-lock.json` theo phiên bản npm ở đó, và lần `git pull` sau bị từ chối vì "local changes would be overwritten". Nếu đã lỡ (pull báo lỗi ở `package-lock.json`), khôi phục tệp khóa rồi kéo lại:

```bash
sudo -u crm git checkout -- package-lock.json
sudo -u crm git pull --ff-only
sudo -u crm npm ci --omit=dev
```

Dữ liệu chạy thật nằm trong `/opt/facebook-crm/data/processed/` và không bị `git pull` đụng tới vì đã nằm trong `.gitignore`. Vẫn nên sao lưu thư mục đó trước khi cập nhật lớn.
