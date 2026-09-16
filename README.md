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

- `app/`: backend Node (server, webhook Meta, chatbot, đơn hàng, `customers.mjs` gộp mọi luồng của một người thành danh sách Khách hàng). `app/processing/` là luồng xử lý của chatbot: danh mục → nhận diện → tính tiền → soạn tin.
- `app/products.seed.json`, `app/gifts.seed.json`: danh mục sản phẩm và quà tặng khởi tạo; sau lần chạy đầu, dữ liệu sống ở `data/processed/`.
- `web/`: giao diện (HTML/CSS/JS thuần, không build).
- `data/processed/`: dữ liệu vận hành (hội thoại, đơn, sản phẩm, quà tặng, cấu hình chatbot) — không commit.
- `database/seeds/`: dữ liệu demo cho lần chạy đầu, và `dmhc.csv` là danh mục tỉnh/quận/phường chuẩn của kho (63 tỉnh, 3 cấp, có mã).
- `assets/templates/`: mẫu file xuất kho.
- `deploy/`: Caddyfile, systemd unit và hướng dẫn triển khai VPS.
- `integrations/meta/`: hướng dẫn kết nối Messenger.
- `docs/`: kiến trúc và nguyên tắc giao diện.
- `tests/`: kiểm thử đơn vị (`npm test`) và tích hợp webhook (`npm run test:integration`).
- `scripts/setup/`: script một lần để tạo shortcut, icon và mẫu xuất kho.
- `logs/`: log cục bộ khi chạy bằng `Open Facebook CRM.cmd`; không commit.

Thiết kế giao diện tuân theo `docs/design/ui-principles.md`: tối giản, tận dụng không gian, thoải mái và hiện đại.

## Nguyên tắc cấu hình

- **Cài đặt → Sản phẩm** là nguồn duy nhất về giá bán (chưa gồm ship), giá combo, SKU xuất kho (mỗi sản phẩm một mã), khối lượng, đơn vị đếm (Túi/Hũ/Hộp/Combo) và tên gọi khách hay dùng.
- **Cài đặt → Sản phẩm** cũng đánh dấu sản phẩm nào *ghép được* (các túi granola); sản phẩm không ghép chỉ bán riêng ×1/×2/×3.
- **Cài đặt → Quà tặng** giữ phí vận chuyển và mỗi quà là một **quy tắc**: tặng từ N sản phẩm trong đơn (tổng mọi loại), trừ đơn có sản phẩm bị loại. Quà tên "Miễn phí vận chuyển" áp dụng cho đơn nào thì đơn đó không cộng ship. Bot chỉ tự chốt tổ hợp hợp lệ (sản phẩm ghép được với nhau, tối đa 3 sản phẩm); còn lại chuyển nhân viên.
- **Thiết lập chatbot → Thiết lập tin nhắn** là nơi duy nhất chứa lời bot nói, mỗi câu trả lời một mẫu sửa được; `app/chatbot-templates.mjs` chỉ chọn mẫu và điền chỗ trống. Cú pháp mẫu: `{giá_trị}`, `[?x]…[/?]` (chỉ giữ khi x có giá trị), `[[danh_sách]]…[[|]]dòng kẻ[[/danh_sách]]` (lặp theo từng dòng), `###` tách tin, `![tên](url)` gửi ảnh; dòng nào mọi chỗ trống đều rỗng thì tự bỏ. Mẫu giá/quà (GENERAL_INFO, GIFT_POLICY, PRICE_QUOTE, PRICE_QUOTE_COMBO, PRICE_MIX_TUI_LON) được điền số từ danh mục ngay lúc trả lời; mã PRICE_<sản phẩm> kiểu Smax vẫn hiểu là báo giá sản phẩm đó. `app/chatbot-templates.seed.json` chỉ dùng để bổ sung mã thiết lập chưa có.
- **Cài đặt → Tin nhắn** (`app/inbox-settings.mjs`, lưu ở `data/processed/inbox-settings.json`): *Mẫu trả lời nhanh* cho nhân viên (ký tự tắt + nội dung + tối đa 6 ảnh; gõ `/` trong ô tin nhắn hoặc bấm nút ⚡, `{name}`/`{title}` được điền theo khách đang mở, ảnh gửi bằng URL công khai `/product-images/quick-…`); *Thẻ hội thoại* (tên + màu, hiện thành thanh thẻ phía trên ô nhập tin giống Pancake, bấm để gắn/bỏ; bot tự gắn `consulting` = Cần người xử lý khi chuyển nhân viên và `customer` = Đã mua hàng khi chốt đơn); *Mẫu câu mặc định* sửa thẳng WELCOME, COMMENT_PUBLIC_REPLY, COMMENT_PRIVATE_REPLY, CSKH_HANDOFF — cùng kho `messageTemplates` với Thiết lập chatbot, không nhân đôi.
- Chatbot, tin xác nhận đơn, receipt Messenger, bảng Đơn hàng và file xuất kho đều đọc từ các nơi trên khi trả lời/tạo đơn — không có bảng giá, mẫu tin hay cơ chế ghi đè nào trong mã.
- **Địa chỉ** (`app/processing/locations.mjs`, danh mục `database/seeds/dmhc.csv`): địa chỉ khách nhắn được tự động tách thành tỉnh/quận/phường theo tên chuẩn của kho ngay khi tạo đơn, và bước xuất dùng cùng hàm đó cho cả đơn chatbot lẫn file import. Đọc từ cuối lên: tỉnh → quận trong tỉnh → phường trong quận; hiểu viết tắt (HCM, HN, Q1, P.5, TT, TX), không dấu, thiếu dấu phẩy, sai chính tả nhẹ; thiếu tỉnh thì suy từ quận có tên duy nhất, thiếu quận thì suy từ phường duy nhất trong tỉnh. Hai tên chỉ khác dấu ("Hoằng Đông"/"Hoằng Đồng") mà khách gõ không dấu thì coi là mơ hồ, không đoán. Quận cũ và thành phố mới trùng tên (Quận/Thành phố Thủ Đức, Thị xã/Huyện Cai Lậy, Kỳ Anh, Long Mỹ) được phân định bằng phường/xã; cùng có phường đó thì lấy đơn vị lớn hơn (đơn vị sau sáp nhập). Tên đường trùng tên tỉnh ("đường Hà Nội", "đường Hồ Chí Minh") không bị hiểu là nơi giao. Bỏ qua câu dẫn ("Địa chỉ:"), số điện thoại, mã bưu điện, chữ "city/district/ward" trong địa chỉ. Kiểm tra hàng loạt (`resolveAddress` trên 11.554 phường/xã × 8 kiểu viết): nhập đầy đủ hoặc không dấu phẩy đạt 100%, không có ca nào gán sai ngoài chính sách Thủ Đức nói trên. Đơn ghi thêm `street`, `province`, `district`, `ward`, `locationConfidence` (exact/fuzzy/partial/none).
- **Chatbot hỏi lại địa chỉ**: trước khi chốt đơn, địa chỉ phải đủ ba cấp và có tên đường/thôn/ấp (chỉ số nhà thì chưa đủ). Thiếu gì bot hỏi đúng phần đó bằng mẫu `ORDER_ADDRESS_CLARIFY`; trùng tên thì đưa lựa chọn bằng `ORDER_ADDRESS_CHOOSE`. Phần khách nhắn thêm được tự ghép vào địa chỉ đã lưu (`mergeAddressFragment`). Hỏi tối đa 2 lần (`maxAddressAsks`) rồi vẫn lên đơn với địa chỉ khách đưa để không kẹt khách. Tin xác nhận và đơn ghi địa chỉ theo tên chuẩn của kho; bản khách gõ giữ ở `rawAddress`.

## Quy tắc đặt tên

- Dùng chữ thường và dấu gạch ngang: `lead-import-2026-09-04.csv`.
- File theo ngày dùng định dạng `YYYY-MM-DD`.
- Không đưa họ tên, số điện thoại hoặc email vào tên file.
- Không commit dữ liệu khách hàng thật, access token, app secret hoặc file `.env`.

## Đơn từ landing page (Webcake)

`app/landing-orders.mjs` nhận đơn từ form landing qua webhook `POST /webhooks/landing?token=<LANDING_WEBHOOK_TOKEN>` (JSON hoặc form-urlencoded; token đặt trong `.env`, để trống là tắt). Trường được nhận dạng theo nghĩa nên tên khác nhau vẫn đọc được: họ tên / name / full_name, số điện thoại / phone / sđt, địa chỉ + phường/xã + quận/huyện + tỉnh/thành, sản phẩm / product / sku (một dòng hoặc danh sách `products[]`), số lượng, tổng tiền, ghi chú, mã đơn (order_id), utm/campaign/page. Sản phẩm được khớp với Cài đặt → Sản phẩm để lấy SKU kho và giá combo; địa chỉ được tách ba cấp như đơn chatbot. Thiếu địa chỉ hay sản phẩm lạ vẫn tạo đơn kèm cờ "Thiếu địa chỉ" / "Kiểm tra sản phẩm" trong cột Ghi chú; thiếu số điện thoại hợp lệ thì từ chối. Chống trùng theo `order_id` hoặc cùng SĐT + giỏ trong 10 phút. Đơn lưu ở `data/processed/landing-orders.json`, xuất hiện trong **Đơn hàng** với Nguồn đơn = Landing page (mã `LP-…`) và đi cùng luồng kiểm tra → xuất kho. `GET /api/landing/recent` (sau mật khẩu) trả 30 payload gần nhất để đối chiếu khi một trường chưa được nhận ra. Trên VPS, Caddy phải cho `/webhooks/landing` đi thẳng (đã có trong `deploy/Caddyfile`).

## Luồng đơn hàng

Chatbot chốt đơn → đơn tự xuất hiện trong **Đơn hàng → Nhập dữ liệu** (cột Nguồn đơn = Chatbot) cùng các file import → kiểm tra ở **Xử lý dữ liệu** → **Xuất dữ liệu** tạo file XLSX cho kho; preview và file dùng chung một hàm trên server.

## Cảnh báo số điện thoại hay bom hàng

Kết nối Pancake POS ở **Cài đặt → Kênh** (dán khoá API một lần; CRM kiểm tra khoá qua `GET /shops`, tự chọn shop, lưu ở `data/processed/pos-config.json` quyền 600, giao diện chỉ thấy vài ký tự đầu/cuối). Từ đó `app/phone-warnings.mjs` tự chấm mỗi số điện thoại, không có gì để nhập tay: `GET /shops/{id}/orders?search=<sđt>&extra_fields[]=return_rate` cho lịch sử đơn của số đó ở shop mình và `reports_by_phone` (order_fail/order_success/warning — lịch sử toàn hệ thống Pancake nên xét theo tỷ lệ; cờ `warning` do POS chấm là chuẩn), `GET /shops/{id}/customers?search=<sđt>` cho `is_block` và thẻ "thường xuyên hoàn". Mức: `block` (POS chặn), `high` (warning ≥ 2; hệ thống bom ≥ 3 đơn và ≥ 30%; shop mình hoàn ≥ 2 đơn hoặc hoàn 1 trong ≤ 2 đơn), `watch` (warning = 1; hệ thống ≥ 2 đơn và ≥ 15%; shop mình hoàn 1 đơn; thẻ hoàn). Cache 24 giờ trong `data/processed/phone-warnings.json`. Cảnh báo hiện ở bảng **Đơn hàng** (huy hiệu cạnh số điện thoại, dòng tô đỏ/cam, bộ lọc "Cảnh báo bom hàng", nằm trong "Cần xử lý"), panel khách trong **Tin nhắn**, và trên đơn chatbot/landing (`phoneWarning`; đơn chatbot của số cảnh báo còn được gắn thẻ "Cần người xử lý"). `POS_API_KEY`/`POS_SHOP_ID` trong `.env` là cách cấu hình thay thế.

## Tự điền cho đơn landing khách bỏ dở

Đơn Webcake "chưa hoàn tất" hoặc gửi xong mà thiếu sản phẩm/địa chỉ được `autoFillLandingOrder` (trong `app/landing-orders.mjs`) điền tự động rồi đưa vào **Xử lý dữ liệu** chờ nhân viên duyệt, không ai phải nhập tay: sản phẩm mặc định là tổ hợp (SKU × số lượng) xuất hiện nhiều nhất trong các đơn đã có sản phẩm của cùng `utm_campaign` (hoặc cùng trang landing), không có thì lấy tổ hợp phổ biến nhất của mọi đơn landing; địa chỉ lấy từ Pancake POS (hồ sơ khách + địa chỉ giao các đơn trước của số đó) rồi đến đơn landing trước trong CRM, chỉ nhận địa chỉ đủ ba cấp và khớp phần khách đã gõ (cùng tỉnh/quận/phường nếu có). Đơn được dựng lại từ payload đã vá nên giá combo, quà, ba cấp địa chỉ đều đúng như đơn thường; `landing.autoFilled` ghi rõ đã điền gì từ đâu, cột Ghi chú hiện "🤖 Tự điền: …", trạng thái vẫn "Chưa hoàn tất" nếu khách chưa gửi. Bản khách gửi xong luôn đè lên bản tự điền.

## Đồng bộ đơn landing từ Pancake POS

Webhook chỉ bắt được landing đã gắn "Kết nối" trong Webcake, còn Pancake POS nhận đơn của **mọi** landing (kể cả đơn khách bỏ dở, `is_abandoned_order`). `app/pos-sync.mjs` kéo đơn POS nguồn Webcake mỗi 5 phút (và ngay khi khởi động, 48 giờ gần nhất) khi POS đã kết nối ở Cài đặt → Kênh: mỗi đơn POS được dựng thành payload y hệt webhook Webcake (cùng chuỗi sản phẩm "Tên (Phân loại): sl x giá", `inserted_at` đổi sang giờ Việt Nam) rồi đi qua `recordLandingOrder`, nên trùng với đơn webhook thì gộp (ghi `landing.posId`), đơn bỏ dở thì tự điền và vào Xử lý dữ liệu, số hay bom hàng thì gắn cảnh báo. `POST /api/landing/sync-pos` (`{ "sinceHours": 72 }`) kéo lại thủ công; đặt `POS_SYNC_DISABLED=1` để tắt.
