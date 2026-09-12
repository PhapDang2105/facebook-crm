# Facebook CRM Technical Workspace

Không gian làm việc dùng để quản lý kế hoạch kỹ thuật, dữ liệu, tích hợp và báo cáo của hệ thống CRM phục vụ Facebook/remarketing.

## Chạy ứng dụng MVP

Cách nhanh nhất: nhấp đúp `Open Facebook CRM.lnk` hoặc `Open Facebook CRM.cmd`. Hệ thống sẽ chạy ẩn và tự mở trên trình duyệt mặc định.

Yêu cầu Windows PowerShell 5.1 trở lên. Từ thư mục dự án chạy:

```powershell
.\run.ps1
```

Sau đó mở `http://localhost:8080`. Dữ liệu demo được sao chép vào `data/processed/crm-store.json` ở lần chạy đầu tiên.

Chạy kiểm thử (Node 22 hoặc bản portable trong `tools/node`):

```powershell
npm test
npm run test:integration
```

## Kết nối Facebook Messenger

Sao chép `.env.example` thành `.env`, điền thông tin ứng dụng Meta rồi khởi động lại. Hướng dẫn đầy đủ về quyền, webhook và cách vận hành nằm trong `integrations/meta/README.md`.

## GraphCode

GraphCode and a portable Node.js runtime are installed locally under `tools/`; no system-wide installation is required.

```powershell
.\GraphCode.cmd index
.\GraphCode.cmd stats
.\GraphCode.cmd context "describe a development task"
```

## Cấu trúc

- `app/`: backend Node (server, webhook Meta, chatbot, đơn hàng). `app/processing/` là luồng xử lý của chatbot: danh mục → nhận diện → tính tiền → soạn tin.
- `app/products.seed.json`, `app/gifts.seed.json`: danh mục sản phẩm và quà tặng khởi tạo; sau lần chạy đầu, dữ liệu sống ở `data/processed/`.
- `web/`: giao diện (HTML/CSS/JS thuần, không build).
- `data/processed/`: dữ liệu vận hành (hội thoại, đơn, sản phẩm, quà tặng, cấu hình chatbot) — không commit.
- `database/seeds/`: dữ liệu demo cho lần chạy đầu.
- `assets/templates/`: mẫu file xuất kho.
- `deploy/`: Caddyfile, systemd unit và hướng dẫn triển khai VPS.
- `integrations/meta/`: hướng dẫn kết nối Messenger.
- `docs/`: kiến trúc và nguyên tắc giao diện.
- `tests/`: kiểm thử đơn vị (`npm test`) và tích hợp webhook (`npm run test:integration`).
- `scripts/setup/`: script một lần để tạo shortcut, icon và mẫu xuất kho.
- `logs/`: log cục bộ khi chạy bằng `Open Facebook CRM.cmd`; không commit.

Thiết kế giao diện tuân theo `docs/design/ui-principles.md`: tối giản, tận dụng không gian, thoải mái và hiện đại.

## Nguyên tắc cấu hình

- **Cài đặt → Sản phẩm** là nguồn duy nhất về giá bán (chưa gồm ship), giá combo, SKU xuất kho, khối lượng, tên gọi khách hay dùng và thành phần xuất kho.
- **Cài đặt → Sản phẩm** cũng đánh dấu sản phẩm nào *ghép được* (các túi granola); sản phẩm không ghép chỉ bán riêng ×1/×2/×3.
- **Cài đặt → Quà tặng** giữ danh sách quà, phí vận chuyển và bảng **quà theo tổ hợp**: hệ thống tự sinh mọi tổ hợp bot có thể chốt (tối đa 3 sản phẩm), nhân viên tick quà cho từng dòng. Quà tên "Miễn phí vận chuyển" tick ở tổ hợp nào thì tổ hợp đó không cộng ship. Tổ hợp không có trong bảng thì bot chuyển nhân viên.
- **Thiết lập chatbot → Thiết lập tin nhắn** là nơi duy nhất chứa lời bot nói; `app/chatbot-templates.mjs` chỉ chọn mẫu và điền chỗ trống `{...}`. `app/chatbot-templates.seed.json` chỉ được đọc vào khi thiết lập chưa có bộ mẫu. Mẫu giá/quà (GENERAL_INFO, GIFT_POLICY, PRICE_*) được soạn từ danh mục ngay lúc trả lời, không lưu text.
- Chatbot, tin xác nhận đơn, receipt Messenger, bảng Đơn hàng và file xuất kho đều đọc từ các nơi trên khi trả lời/tạo đơn — không có bảng giá, mẫu tin hay cơ chế ghi đè nào trong mã.

## Quy tắc đặt tên

- Dùng chữ thường và dấu gạch ngang: `lead-import-2026-09-04.csv`.
- File theo ngày dùng định dạng `YYYY-MM-DD`.
- Không đưa họ tên, số điện thoại hoặc email vào tên file.
- Không commit dữ liệu khách hàng thật, access token, app secret hoặc file `.env`.

## Luồng đơn hàng

Chatbot chốt đơn → đơn tự xuất hiện trong **Đơn hàng → Nhập dữ liệu** (cột Nguồn đơn = Chatbot) cùng các file import → kiểm tra ở **Xử lý dữ liệu** → **Xuất dữ liệu** tạo file XLSX cho kho; preview và file dùng chung một hàm trên server.
