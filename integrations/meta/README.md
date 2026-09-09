# Kết nối Facebook Messenger

CRM nhận và trả lời tin nhắn Messenger của Facebook Page thông qua một ứng dụng Meta riêng.

Luồng đầy đủ gồm bốn phần: cấu hình ứng dụng → đăng nhập chọn Page (OAuth) → đăng ký webhook → nhận/gửi tin nhắn.

## 0. Vì sao CRM cần ứng dụng Meta riêng

Đã có một ứng dụng Meta khác trỏ webhook đối tượng Page về hệ thống tự động hóa nội bộ, đăng ký các trường `feed`, `messages`, `messaging_postbacks`.

Mỗi ứng dụng Meta chỉ có **một** Callback URL cho mỗi đối tượng, nên không thể dùng chung app đó cho CRM mà không cắt luồng đang chạy. Ngược lại, **một Facebook Page có thể đăng ký nhiều ứng dụng cùng lúc**, mỗi ứng dụng nhận webhook về endpoint riêng. Vì vậy CRM dùng app riêng, hệ thống cũ giữ nguyên app cũ, hai bên không đụng nhau.

Khi tạo app mới cần lưu ý:

- Thêm sản phẩm **Messenger**, **Webhooks** và **Facebook Login for Business**.
- Nâng `public_profile` lên quyền truy cập nâng cao, nếu không Facebook Login sẽ báo lỗi.
- Điền **URI chuyển hướng OAuth hợp lệ**; app bật "Chế độ sử dụng nghiêm ngặt cho URI chuyển hướng" nên URI phải khớp từng ký tự.

## 1. Cấu hình ứng dụng

Sao chép `.env.example` thành `.env` ở thư mục gốc rồi điền:

| Biến | Ý nghĩa | Lấy ở đâu |
| --- | --- | --- |
| `META_APP_ID` | App ID | App Dashboard |
| `META_APP_SECRET` | App Secret | App settings → Basic → App secret |
| `META_GRAPH_VERSION` | Phiên bản Graph API, ví dụ `v21.0` | App settings → Advanced → API version |
| `META_VERIFY_TOKEN` | Chuỗi bí mật tự đặt để Meta xác minh webhook | Tự sinh, phải khớp với ô Verify token |
| `PUBLIC_BASE_URL` | Domain HTTPS công khai trỏ về máy chủ CRM | Hạ tầng của bạn |
| `HOST` | Đặt `0.0.0.0` khi chạy sau reverse proxy | — |

Giá trị đã chốt cho dự án này:

- Domain CRM: `https://fb.giotnang.vn`
- Callback URL webhook: `https://fb.giotnang.vn/webhooks/facebook`
- OAuth Redirect URI: `https://fb.giotnang.vn/api/channels/meta/callback`
- `META_GRAPH_VERSION=v26.0`

## Hạ tầng

CRM chạy trên một máy ảo Google Compute Engine đặt tại Singapore (`e2-small`, 2 GB RAM, Debian 13), dùng IP tĩnh và mở sẵn HTTP/HTTPS. Tên miền trỏ về máy đó bằng bản ghi A quản lý tại TenTen.

Số hiệu cụ thể — IP, project ID, mã billing account, tên tài nguyên — **không lưu trong repo** vì đây là repository công khai. Chúng nằm trong ghi chú vận hành nội bộ và trong bảng điều khiển Google Cloud.

Chi phí máy chủ khoảng 16 USD/tháng. Có ngân sách theo dõi kèm cảnh báo email tại 25% / 50% / 90% / 100%; ngân sách cố ý **không** trừ Promotional credits, vì nếu trừ thì số liệu luôn bằng 0 và cảnh báo không bao giờ kích hoạt.

Khởi động lại CRM sau khi sửa `.env`. Khi chạy, máy chủ in ra Callback URL cần dùng và liệt kê biến còn thiếu:

```powershell
.\run.ps1
```

Trang **Cài đặt → Kênh** cũng hiển thị Callback URL và trạng thái webhook.

## 2. Quyền và Redirect URI trong Meta App

- Sản phẩm cần bật: **Messenger** và **Facebook Login for Business**.
- Redirect URI hợp lệ (Facebook Login → Settings → Valid OAuth Redirect URIs):
  `${PUBLIC_BASE_URL}/api/channels/meta/callback`
- Quyền ứng dụng yêu cầu: `pages_show_list`, `pages_read_engagement`, `pages_manage_metadata`, `pages_messaging`.

Muốn dùng với Page của người khác thì các quyền trên phải qua **App Review**. Trong lúc phát triển, tài khoản có vai trò Admin/Developer/Tester của ứng dụng vẫn dùng được ngay.

## 3. Đăng ký webhook

Vào **Meta App → Webhooks → Page** rồi nhấn *Subscribe to this object*:

- **Callback URL**: `${PUBLIC_BASE_URL}/webhooks/facebook`
- **Verify Token**: đúng giá trị `META_VERIFY_TOKEN`
- **Trường cần đăng ký**: `messages`, `message_echoes`, `messaging_postbacks`, `messaging_optins`, `messaging_reactions`, `message_deliveries`, `message_reads`

Meta gọi `GET` tới Callback URL để xác minh; CRM trả lại `hub.challenge` khi Verify Token khớp. Mọi `POST` sau đó đều được kiểm tra chữ ký `X-Hub-Signature-256` bằng App Secret — sai chữ ký thì bị từ chối với mã 401.

Việc đăng ký diễn ra ở **hai cấp** và cần cả hai:

1. **Cấp ứng dụng** — danh sách trường ở màn hình Webhooks này. Trường nào chưa bật ở đây thì Page sẽ không bao giờ gửi, kể cả khi đã đăng ký ở bước 2.
2. **Cấp Page ↔ ứng dụng** — CRM tự gọi `POST /{page-id}/subscribed_apps` khi bạn kết nối Page ở màn hình Cài đặt.

`message_echoes` cho phép CRM thấy cả những tin nhân viên trả lời trực tiếp trong hộp thư của Facebook, và bổ sung URL do Meta lưu trữ cho tệp mà CRM đã gửi lên.

## 4. Kết nối Page và đồng bộ

Mở **Cài đặt → Kênh → Kết nối Facebook**, đăng nhập rồi chọn các Page cần dùng. Với mỗi Page, CRM sẽ:

1. Lưu Page Access Token đã mã hóa AES-256-GCM bằng khóa dẫn xuất từ App Secret.
2. Gọi `POST /{page-id}/subscribed_apps` để Page bắt đầu đẩy webhook về ứng dụng.
3. Nhập sẵn tối đa 25 hội thoại gần nhất qua `GET /{page-id}/conversations` để hộp thư không trống.

Nút **Làm mới** kiểm tra lại tên Page, ảnh đại diện và trạng thái đăng ký webhook.

## 5. Nhận và gửi tin nhắn

- Tin nhắn đến đi qua webhook, được lưu vào `data/processed/meta-conversations.json` và đẩy tới trình duyệt qua Server-Sent Events (`GET /api/messaging/stream`), nên hộp thư cập nhật ngay mà không cần tải lại trang.
- Tin nhắn gửi đi dùng Send API `POST /{page-id}/messages`. Tệp đính kèm được tải lên bằng `multipart/form-data`; chú thích đi kèm tệp được gửi thành một tin nhắn riêng vì Send API không cho gộp.
- Mở một hội thoại sẽ gọi `sender_action: mark_seen` để đánh dấu đã xem trên Facebook.
- Meta chỉ cho trả lời trong **24 giờ** kể từ tin nhắn gần nhất của khách. API trả về `replyWindowEndsAt` và `canReply` cho từng hội thoại; quá hạn thì Send API báo lỗi và tin nhắn hiện trạng thái gửi hỏng.

## Ảnh đại diện khách hàng

CRM hiển thị chữ cái đầu thay cho ảnh đại diện. Đây là giới hạn của Meta, không phải lỗi: Messenger User Profile API (`GET /{psid}?fields=name,profile_pic`) đòi quyền `pages_messaging` ở mức **Advanced Access**, còn ứng dụng chưa qua App Review chỉ có Standard Access. Graph trả về:

```
Unsupported get request. Object with ID '...' does not exist, cannot be
loaded due to missing permissions, or does not support this operation.
```

Tên khách vẫn hiển thị đúng vì lấy từ `participants` của Conversations API, không qua lời gọi hồ sơ.

CRM chỉ thử lấy ảnh **một lần cho mỗi khách** rồi ghi cờ `pictureAttemptedAt` (khi đồng bộ) hoặc `profileResolvedAt` (khi nhận webhook). Không có cờ này thì mỗi tin nhắn đến lại gọi Graph một lần vô ích và nhanh chóng chạm rate limit.

Sau khi được cấp Advanced Access, xóa cờ để CRM thử lại:

```bash
sudo systemctl stop facebook-crm
sudo -u crm sed -i 's/"pictureAttemptedAt": [0-9]*,//g; s/"profileResolvedAt": [0-9]*,//g' /opt/facebook-crm/data/processed/meta-conversations.json
sudo systemctl start facebook-crm
```

## API nội bộ

| Endpoint | Mô tả |
| --- | --- |
| `GET /webhooks/facebook` | Xác minh đăng ký webhook |
| `POST /webhooks/facebook` | Nhận sự kiện, bắt buộc chữ ký hợp lệ |
| `GET /api/messaging/conversations?channelId=` | Danh sách hội thoại của một Page |
| `GET /api/messaging/conversations/{id}/messages` | Lịch sử tin nhắn |
| `POST /api/messaging/conversations/{id}/messages` | Gửi tin nhắn hoặc tệp |
| `POST /api/messaging/conversations/{id}/read` | Đánh dấu đã đọc |
| `PATCH /api/messaging/conversations/{id}/flags` | Cập nhật chưa đọc / tắt thông báo / nhãn |
| `POST /api/messaging/sync` | Nhập lại hội thoại từ Graph API |
| `GET /api/messaging/stream` | Luồng SSE cho cập nhật thời gian thực |

## Bảo mật và vận hành

- Không ghi App Secret hoặc Page Access Token vào mã nguồn, HTML hay localStorage.
- `data/processed/meta-channels.json` và `data/processed/meta-conversations.json` chứa dữ liệu khách hàng và mã truy cập đã mã hóa; cả hai đã bị loại khỏi Git.
- Nếu App Secret thay đổi, phải ngắt và kết nối lại các Page vì mã truy cập cũ không giải mã được bằng khóa mới.
- Mỗi hội thoại chỉ giữ 500 tin nhắn gần nhất trong tệp JSON.
- Webhook trả `200` trước rồi mới xử lý, tránh việc Meta gửi lại do phản hồi chậm. Tin nhắn trùng `mid` không bị lưu hai lần.

## Kiểm thử

```powershell
.\tools\node\node.exe .\tests\meta-webhook.test.mjs
.\tools\node\node.exe .\tests\integration\meta-webhook.integration.mjs
```

Bài kiểm thử tích hợp tự khởi động CRM ở cổng 8123 với cấu hình giả, gửi webhook có chữ ký thật rồi kiểm tra hội thoại được tạo đúng. Nó ghi vào thư mục tạm qua biến `META_CONVERSATIONS_PATH` nên không đụng tới dữ liệu thật. Truyền số cổng khác nếu 8123 đang bận:

```powershell
.\tools\node\node.exe .\tests\integration\meta-webhook.integration.mjs 8199
```
