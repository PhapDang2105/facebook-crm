# Facebook CRM Technical Workspace

Không gian làm việc dùng để quản lý kế hoạch kỹ thuật, dữ liệu, tích hợp và báo cáo của hệ thống CRM phục vụ Facebook/remarketing.

## Chạy ứng dụng MVP

Cách nhanh nhất: nhấp đúp `Open Facebook CRM.lnk` hoặc `Open Facebook CRM.cmd`. Hệ thống sẽ chạy ẩn và tự mở trên trình duyệt mặc định.

Yêu cầu Windows PowerShell 5.1 trở lên. Từ thư mục dự án chạy:

```powershell
.\run.ps1
```

Sau đó mở `http://localhost:8080`. Dữ liệu demo được sao chép vào `data/processed/crm-store.json` ở lần chạy đầu tiên.

Chạy kiểm thử logic:

```powershell
.\tools\node\node.exe .\tests\domain\run-tests.mjs
```

## GraphCode

GraphCode and a portable Node.js runtime are installed locally under `tools/`; no system-wide installation is required.

```powershell
.\GraphCode.cmd index
.\GraphCode.cmd stats
.\GraphCode.cmd context "describe a development task"
```

## Cấu trúc

- `docs/`: tài liệu kiến trúc, mô hình dữ liệu, API, bảo mật và vận hành.
- `data/`: khu vực tiếp nhận, xử lý và xuất dữ liệu khách hàng.
- `config/`: cấu hình mẫu theo môi trường; không lưu secret thật.
- `integrations/`: tài liệu hoặc mã tích hợp Meta, website và hệ thống đơn hàng.
- `database/`: schema, migration, seed không chứa dữ liệu thật và truy vấn kiểm tra.
- `reports/`: định nghĩa KPI, báo cáo kỹ thuật và dữ liệu báo cáo đã ẩn danh.
- `scripts/`: công cụ import, làm sạch, đối soát và bảo trì.
- `tests/`: dữ liệu giả và kịch bản kiểm thử.
- `logs/`: log cục bộ; không commit log chứa dữ liệu khách hàng.
- `archive/`: tài liệu hoặc kết quả cũ cần lưu vết.
- `assets/`: logo, icon, hình ảnh, font, template và tài nguyên giao diện dùng chung.

Thiết kế giao diện tuân theo `docs/design/ui-principles.md`: tối giản, tận dụng không gian, thoải mái và hiện đại.

## Quy tắc đặt tên

- Dùng chữ thường và dấu gạch ngang: `lead-import-2026-09-04.csv`.
- File theo ngày dùng định dạng `YYYY-MM-DD`.
- Không đưa họ tên, số điện thoại hoặc email vào tên file.
- Không commit dữ liệu khách hàng thật, access token, app secret hoặc file `.env`.

## Luồng dữ liệu

`data/incoming` → `data/raw` → `data/processed` → `data/exports`

- `incoming`: file vừa nhận, chưa kiểm tra.
- `raw`: bản gốc bất biến sau khi kiểm tra và ghi nhận nguồn.
- `processed`: dữ liệu đã chuẩn hóa/khử trùng.
- `exports`: dữ liệu xuất cho hệ thống khác; cần xóa theo chính sách lưu trữ.
- `samples`: dữ liệu giả hoặc đã ẩn danh dùng để phát triển và kiểm thử.
- `quarantine`: bản ghi lỗi, thiếu trường hoặc nghi trùng cần kiểm tra.

## Quản lý asset

- Giữ file thiết kế gốc trong `assets/source/`.
- Icon SVG đặt trong `assets/icons/svg/`; bản PNG đặt trong `assets/icons/png/`.
- File đã tối ưu để sử dụng đặt trong `assets/optimized/`.
- File xuất tạm hoặc bản bàn giao đặt trong `assets/exports/`.
- Dùng tên mô tả, chữ thường và dấu gạch ngang; ví dụ `facebook-lead-status-new.svg`.
