# Scripts

- `set-messenger-profile.mjs [pageId] [--show]`: đặt nút "Bắt đầu" và lời chào màn hình đầu cho Page đã kết nối (chạy trong thư mục dự án, trên VPS: `sudo -u crm node scripts/set-messenger-profile.mjs`). Không có nút Bắt đầu thì khách mới quét QR thẻ cảm ơn không gửi được `ref` về CRM.

- `setup/create-desktop-shortcut.ps1`: tạo shortcut `Open Facebook CRM.lnk` trên Windows.
- `setup/build-order-export-template.py`: dựng mẫu `assets/templates/facebook-order-export.xlsx` (file xuất kho).
