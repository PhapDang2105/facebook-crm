# Mô hình ra quyết định nhỏ – công cụ huấn luyện và đo

Mô hình nhỏ (`app/processing/intent-model.mjs`, trọng số `intent-model.json`) đoán mã mẫu trả lời
cho tin khách trước khi hỏi LLM. Cài đặt `intentModel`: `shadow` (chỉ ghi log so với câu trả lời
thật), `on` (tự trả lời khi chắc ≥ `intentThreshold` và mẫu thuộc danh sách an toàn `intentSafeTemplates`
— hằng số trong `app/processing/intent-model.mjs`, không chỉnh trong Cài đặt), `off`.

Tất cả công cụ chạy trên máy chủ, trong `/opt/facebook-crm`, bằng `sudo -u crm node --env-file=.env …`
(`build-dataset` đọc kho ở `data/processed`; đặt `CRM_DATA_DIR` chỉ khi chạy trên bản sao dữ liệu ở máy khác).
Dataset huấn luyện (`*.jsonl`) chứa chữ khách: để ở `/tmp` hoặc scratch, đã nằm trong .gitignore.
Không công cụ nào gửi tin cho khách. Tệp dữ liệu chứa chữ khách (đã che SĐT) chỉ để ở `/tmp` hoặc
`data/processed`, không đưa vào git.

## Huấn luyện lại (mỗi tuần)

```sh
node --env-file=.env tools-intent/build-dataset.mjs /tmp/dataset.jsonl --llm
#   kho hội thoại → tập nhãn. Trả lời khớp mẫu → nhãn theo mẫu; câu nhân viên tự viết → LLM quy về mã mẫu
#   (kết quả cache ở data/processed/staff-labels.json); nhân viên sửa bot trong 10 phút → corrected.
node tools-intent/merge-labels.mjs /tmp/dataset.jsonl /tmp/labels.jsonl /tmp/merged.jsonl [data/processed/golden-set.json]
#   trộn nhãn LLM (tệp labels.jsonl do script gán nhãn tạo, tuỳ chọn); có golden-set → bỏ tin thuộc bộ chấm.
node tools-intent/train-intent.mjs /tmp/merged.jsonl app/processing/intent-model.json
#   in độ đúng giữ-out theo ngưỡng; commit intent-model.json rồi deploy.
```

## Đo

```sh
node tools-intent/replay-golden.mjs                # mô hình nhỏ + luật ổn định so với bộ chấm mẫu (không gọi LLM)
node --env-file=.env tools-intent/replay-llm.mjs   # Gemini (đúng prompt/cache đang chạy) so với bộ chấm mẫu
```

Bộ chấm mẫu (`data/processed/golden-set.json`) do nhân viên chấm trong Cài đặt → Thiết lập chatbot →
Chấm mẫu. Chỉ dùng để ĐO: mô hình đem đo phải huấn luyện với bộ chấm tách ra (tham số thứ 4 của
merge-labels); mô hình triển khai thì huấn luyện trên toàn bộ dữ liệu.

Quy ước chấm: số lượng mà chưa rõ vị → ASK_FLAVOR; SĐT/địa chỉ mà chưa có sản phẩm → ASK_FLAVOR;
chỉ SĐT hoặc chỉ địa chỉ sau ORDER_ADDRESS → ORDER_ADDRESS_PARTIAL; tin "Khách chọn mua từ Facebook
Shop" → SHOP_ORDER_RECEIVED; bình luận hỏi giá/"ib" → COMMENT_PUBLIC_REPLY; tin chỉ có "." → OTHER.

## Bật mô hình

Sau ≥ 1 tuần chạy `shadow`, đếm trong log: `journalctl -u facebook-crm | grep "Mô hình nhỏ"` →
dòng "X (p, biên m) / thật Y ✓/✗". Mẫu nào ở p ≥ ngưỡng đạt ≥ 97% ✓ thì đặt `intentModel: 'on'`.

## Luồng đơn tất định (`app/processing/order-flow.mjs`)

Khi bot đang xin SĐT/địa chỉ và giỏ còn hạn, tin chỉ có SĐT / địa chỉ đủ / cả hai / "địa chỉ cũ" được
quyết bằng code (giá trị ORDER_ADDRESS + slot), bộ soạn đơn tự ghép giỏ và chọn bước tiếp. Chạy như
luật thử nghiệm: `experimentalRules` = `shadow` (mặc định, chỉ ghi log "Luật PHONE_ONLY (thử)…") hay
`on`. Đo trên bộ chấm mẫu: `replay-golden.mjs` in dòng "Luật thử nghiệm (luồng đơn)". Bật khi log
chạy ẩn ≥ 1 tuần không có ✗.
