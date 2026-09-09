# Quản lý dữ liệu

Thư mục này có thể chứa dữ liệu khách hàng nhạy cảm. Các thư mục dữ liệu thật đã được loại khỏi Git bằng `.gitignore`.

Mỗi lần nhập dữ liệu nên có manifest ghi: nguồn, người cung cấp, thời điểm nhận, số bản ghi, checksum, schema/version và trạng thái xử lý. Manifest không được chứa PII.

Chỉ `samples/` được phép chứa dữ liệu commit lên Git, và dữ liệu đó phải là dữ liệu giả hoặc đã ẩn danh không thể khôi phục.

