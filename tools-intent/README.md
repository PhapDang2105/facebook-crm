# Mô hình ra quyết định nhỏ – công cụ huấn luyện và đo

Mô hình nhỏ (`app/processing/intent-model.mjs`, trọng số `intent-model.json`) đoán mã mẫu trả lời
cho tin khách trước khi hỏi LLM. Cài đặt `intentModel`: `shadow` (chỉ ghi log so với câu trả lời
thật), `on` (tự trả lời khi chắc ≥ `intentThreshold` và mẫu thuộc danh sách an toàn `intentSafeTemplates`
— hằng số trong `app/processing/intent-model.mjs`, không chỉnh trong Cài đặt), `off`.

Tất cả công cụ chạy trên máy chủ, trong `/opt/facebook-crm`, bằng `sudo -u crm node --env-file=.env …`
(đọc kho ở `data/processed`; đặt `CRM_DATA_DIR` chỉ khi chạy trên bản sao dữ liệu ở máy khác).
Tệp dữ liệu chứa chữ khách (đã che SĐT, không có tên) chỉ để ở `/tmp` hoặc `data/processed`, không đưa
vào git. Không công cụ nào gửi tin cho khách.

## Hợp đồng dòng dữ liệu v2 (`*.jsonl`, mỗi dòng một JSON)

```
{ id, text, prevBot, prevCustomer, label, labelSource, weak?, corrected?, source, lastTemplate, lastWasOrderStep,
  hasBasket, basketItems, hasOrder, orderAgeMin, livestream, prevBotAsks, phoneInText, addressInText, bagCount,
  ruleTemplate, at }
```

- `text`: chữ khách **đã gộp như engine** (các tin chữ liên tiếp chưa được Page trả lời trong ≤ 10 phút,
  tối đa 5 tin, nối `\n`) và đã che SĐT (`<sdt>`). Chữ huấn luyện phải giống chữ engine đưa vào luật/mô hình.
- `labelSource`: `template` (câu Page gửi khớp chữ ký mẫu) · `staff` (nhân viên tự viết, LLM quy về mã mẫu;
  `corrected` = nhân viên sửa bot trong 10 phút) · `rule` (luật hiện hành bắt) · `llm` (Gemini gán lại) ·
  `both` (LLM trùng nhãn gốc) · `pipeline` (từ nhật ký quyết định: nhãn = câu engine đã chọn).
- `weak`: nhãn thuộc lớp pipeline khớp kém trên bộ chấm (xem `merge-labels --trust`); giữ để huấn luyện
  nhưng `train-intent` có thể giảm trọng số.
- `orderAgeMin` là `null` khi chưa có đơn (JSON không ghi được Infinity). `basketItems` là **số túi** trong
  giỏ bot đang giữ. `prevBotAsks` ∈ `phone|address|phone_address|flavor|quantity|confirm|''`.
- Trường thêm (không bắt buộc, công cụ khác bỏ qua): `prevBotAgeMin`, `staffRepliedAfterBot`, `bundleSize`,
  `ruleName`, `labelBefore`, `chosen`, `llmTemplate`.

## Quy trình huấn luyện lại (mỗi tuần)

```sh
# 1. Dựng dataset. Ưu tiên nhật ký quyết định (từ khi engine ghi data/processed/decision-log/YYYY-MM-DD.jsonl):
node tools-intent/build-dataset.mjs /tmp/dataset.jsonl --from-decision-log data/processed/decision-log [--since 2026-09-28]
#    Chưa có nhật ký / cần dữ liệu cũ hơn: dựng từ kho hội thoại (ngữ cảnh suy ngoại tuyến, xem mục giả định):
node --env-file=.env tools-intent/build-dataset.mjs /tmp/dataset.jsonl --llm [--since 2026-09-18] [--include-comments]
#    --llm: câu nhân viên tự viết → Gemini quy về mã mẫu (cache data/processed/staff-labels.json).
#    Bình luận mặc định BỎ (--include-comments để giữ).

# 2. Nhãn theo luật hiện hành (chính sách mới nhất thắng câu bot cũ đã gửi):
node tools-intent/relabel-policy.mjs /tmp/dataset.jsonl /tmp/ruled.jsonl [--templates data/processed/chatbot-settings.json] [--stable-only]
#    Luật ổn định + luật thử nghiệm ('on') → renderChatbotReply (mẫu seed, hoặc --templates) → ruleTemplate.
#    Luật bắt → label = ruleTemplate, labelSource 'rule'; dòng staff/corrected giữ nguyên (nhân viên > luật).
#    In ma trận nhãn cũ → nhãn luật; dòng nhân viên ≠ luật ghi ra /tmp/ruled.staff-vs-rule.jsonl (bug luật tiềm năng — đọc tay).

# 3. Gán nhãn LLM cho phần còn lại (labelSource ∉ {rule, staff}):
node --env-file=.env tools-intent/label-dataset.mjs /tmp/ruled.jsonl /tmp/labels.jsonl [--only-drift] [--limit N] [--concurrency 2]
#    Gọi đúng đường trả lời thật (engine.requestDirectModelReply rawResponse, không few-shot), so mẫu sau renderChatbotReply.
#    Cache data/processed/llm-labels.json theo id + promptVersion (hash system prompt đã ghép mẫu): đổi prompt → gán lại;
#    chạy lại → bỏ qua dòng đã có nhãn, dòng lỗi được thử lại. Ghi cache sau mỗi 20 dòng. 429/quá tải/mạng
#    (fetch failed, HeadersTimeout) thử lại 3 lần rồi ghi lỗi và đi tiếp. --only-drift: chỉ dòng nhãn thuộc POLICY_DRIFT.

# 4. Trộn:
node tools-intent/merge-labels.mjs /tmp/ruled.jsonl /tmp/labels.jsonl /tmp/merged.jsonl [data/processed/golden-set.json] --trust data/processed/replay-llm-out.json
#    Ưu tiên staff > rule > template/pipeline (nhãn KHÔNG thuộc POLICY_DRIFT) > llm. LLM được nhận khi trùng nhãn gốc
#    ('both') hoặc khác nhưng nhãn gốc thuộc POLICY_DRIFT ('llm'). Bỏ OTHER, bỏ dòng thuộc bộ chấm (theo id), bỏ confidence.
#    --trust: độ khớp pipeline theo lớp (replay-llm-out.json); lớp < 80% hoặc n < 15 → dòng (không phải staff/rule) weak:true.

# 5. Huấn luyện và đo:
node tools-intent/train-intent.mjs /tmp/merged.jsonl app/processing/intent-model.json
node tools-intent/replay-golden.mjs --compare      # mô hình mới so với mô hình đang chạy trên bộ chấm mẫu
```

`POLICY_DRIFT` = {ORDER_ADDRESS, ASK_PRODUCT, ASK_FLAVOR, GENERAL_INFO, PRICE_QUOTE, REPLY_ALREADY_SENT,
REPLY_ALREADY_SENT_INFO, ORDER_ADDRESS_REMIND, THANK_YOU}: mẫu mà câu bot đã gửi không chắc là câu đúng
(hậu xử lý, chính sách đổi, thiếu ngữ cảnh giỏ), nên nhãn gốc chỉ là gợi ý (hằng số ở `dataset-context.mjs`).

## Tiêu chí thay mô hình

Thay `intent-model.json` khi đủ cả ba:

1. `replay-golden --compare`: nhóm **rule-miss** (tin luật không bắt) trên bộ chấm mẫu tăng ≥ **+8 điểm** so với
   mô hình đang chạy, không giảm ở nhóm lên đơn.
2. Chạy ẩn trên log thật **≥ 1 tuần** (`shadow-report`): tỷ lệ ✓ ở p ≥ 0,8 **không thấp hơn v5** (mô hình đang chạy).
3. Không tăng ✗ ở các mẫu `ORDER_*` (lên đơn sai đắt hơn thông tin sai).

## Báo cáo chạy ẩn

```sh
node tools-intent/shadow-report.mjs [--since YYYY-MM-DD] [--dir data/processed/decision-log] [--price-in 0.5 --price-cache 0.05 --price-out 3.0] [--json]
journalctl -u facebook-crm -o short-iso --since "7 days ago" > /tmp/journal.txt && node tools-intent/shadow-report.mjs --journal /tmp/journal.txt [--year 2026]
```

Bảng theo ngày: lượt, lượt LLM, bỏ qua theo lý do, luật ổn định bắt, luật thử ✓/✗ (so với luật ổn định),
mô hình nhỏ ✓/✗ ở p ≥ 0,7/0,8/0,9 **chỉ trên lượt LLM** (lượt luật đã có luật), gác trước ✓/✗, người gác
agree/ngoài theo mẫu, token trung bình và median (vào/cache/ra/suy nghĩ), % lượt có suy nghĩ, ước chi phí
(USD; phần vào không cache × giá vào + cache × giá cache + (ra + suy nghĩ) × giá ra). Dấu ✓/✗ theo quy ước
engine (`intentMatchMark`: ORDER_ADDRESS_REMIND ≡ ORDER_ADDRESS, REPLY_ALREADY_SENT* trung tính).

Journal cũ chỉ có các dòng `Luật X → T`, `Luật X (thử): luật A / luật ổn định B ✓`, `Mô hình nhỏ (thử): X (p, biên m) / thật Y ✓`,
`Token model: vào N (cache C) · ra O · suy nghĩ T`: lượt LLM = dòng Token; dòng "Mô hình nhỏ" được coi là lượt luật
khi cùng hội thoại vừa có dòng `Luật X → T` (≤ 40 dòng trước), còn lại là lượt LLM. Gác trước/người gác không có trong journal.

## Giả định khi dựng ctx ngoại tuyến

`build-dataset` (từ kho) và `relabel-policy` dựng lại ngữ cảnh mà engine có lúc chạy thật từ lịch sử tin.
Nhật ký quyết định ghi ctx thật của engine nên **ưu tiên** khi có. Các giả định:

| Trường engine | Ngoại tuyến | Ghi chú |
|---|---|---|
| gộp tin | tin chữ liên tiếp của khách tới tin Page kế tiếp, ≤ 10 phút tính tới tin cuối, 5 tin cuối | như `unansweredCustomerMessages`; tin ảnh trong cụm bị bỏ |
| `botLastTemplateId` / `lastTemplate` | `matchTemplate` câu Page gần nhất trước cụm | câu nhân viên viết tay → `''` |
| bot / nhân viên | tin Page **không** cờ `staff` = bot; có cờ `staff` = nhân viên | `staffRepliedAfterBot` = nhân viên nhắn sau lượt bot gần nhất + 5 s (như engine) |
| `botLastAgeMin` | `prevBotAgeMin` = tuổi câu Page gần nhất | không có → Infinity |
| `hasBasket` | `lastTemplate` ∈ ORDER_ADDRESS/PHONE/CONFIRMATION/UPDATE/UPDATED/CART_LINE/CUSTOM_BASKET **hoặc** câu bot khớp "đang giữ đơn" / "đơn của … gồm", và câu đó < 120 phút | engine dùng `pendingOrder` còn hạn 2 giờ; ASK_FLAVOR chưa có túi |
| `basketItems` | tổng số trước "túi/gói/combo…" trong đoạn giỏ của câu bot | 0 khi không phải bước đơn |
| `pendingOrder` (soạn đơn) | `relabel-policy`: giỏ đọc từ câu bot bằng `commentBasket(prevBot)` | không đọc được → bộ soạn đơn coi như chưa có món (ORDER_ADDRESS → ASK_PRODUCT) |
| `hasRecentOrder` / `orderAgeMin` | `customerOrders` có `createdAt` < tin và chưa hủy (`processingStatus ≠ cancelled`, `status ≠ Hủy`) | không gộp đơn của hộp thư cùng khách cho bình luận |
| `hasPreviousDelivery` | **false** | "gửi địa chỉ cũ" luật sẽ hỏi SĐT thay vì chốt |
| `contextProduct`, `quotedProduct` | `''` | không có referral/bài quảng cáo ngoại tuyến → hỏi giá cụt ra GENERAL_INFO thay vì PRICE_QUOTE |
| `trialOffer` | false | luồng dùng thử không dựng lại |
| `complaint` | `isComplaint(text)` với từ khóa mặc định | |
| `smallPackContext` | `lastTemplate === 'PACKAGING_INFO'` hoặc câu bot có "gói nhỏ / combo 10 gói" | |
| `addressComplete` / `addressText` | `describeDeliveryAddress(text bỏ SĐT).complete` khi có giỏ | |
| SĐT | `<sdt>` thay bằng SĐT giả `0912345678` khi chạy luật | luật đọc SĐT bằng `extractVietnamesePhone` |
| `phoneInText` | có SĐT ở cả tin gộp **hoặc từng dòng** | `extractVietnamesePhone` nối số qua xuống dòng ("0912 345 678\n12 Nguyễn…") và hỏng — engine hiện gặp cùng lỗi với tin gộp |
| `livestream` | `isLivestreamConversation` (bài/quảng cáo) hoặc thẻ `livestream` | |
| `replyContext` (renderChatbotReply) | `recentOutgoing` = [câu bot trước], `recentCustomerTexts` = [tin trước, tin này], không đơn cũ, không ưu đãi, xưng hô trung tính | |

Luật bình luận (`commentRule`) không đổi nhãn (ruleTemplate = `COMMENT_RULE`).

## Đo

```sh
node tools-intent/replay-golden.mjs                # mô hình nhỏ + luật ổn định so với bộ chấm mẫu (không gọi LLM)
node --env-file=.env tools-intent/replay-llm.mjs   # Gemini (đúng prompt/cache đang chạy) so với bộ chấm mẫu → replay-llm-out.json
```

Bộ chấm mẫu (`data/processed/golden-set.json`) do nhân viên chấm trong Cài đặt → Thiết lập chatbot →
Chấm mẫu. Chỉ dùng để ĐO: mô hình đem đo phải huấn luyện với bộ chấm tách ra (tham số thứ 4 của
merge-labels); mô hình triển khai thì huấn luyện trên toàn bộ dữ liệu.

Quy ước chấm: số lượng mà chưa rõ vị → ASK_FLAVOR; SĐT/địa chỉ mà chưa có sản phẩm → ASK_FLAVOR;
chỉ SĐT hoặc chỉ địa chỉ sau ORDER_ADDRESS → ORDER_ADDRESS_PARTIAL; tin "Khách chọn mua từ Facebook
Shop" → SHOP_ORDER_RECEIVED; bình luận hỏi giá/"ib" → COMMENT_PUBLIC_REPLY; tin chỉ có "." → OTHER.

## Luồng đơn tất định (`app/processing/order-flow.mjs`)

Khi bot đang xin SĐT/địa chỉ và giỏ còn hạn, tin chỉ có SĐT / địa chỉ đủ / cả hai / "địa chỉ cũ" được
quyết bằng code (giá trị ORDER_ADDRESS + slot), bộ soạn đơn tự ghép giỏ và chọn bước tiếp. Chạy như
luật thử nghiệm: `experimentalRules` = `shadow` (mặc định, chỉ ghi log "Luật PHONE_ONLY (thử)…") hay
`on`. Đo trên bộ chấm mẫu: `replay-golden.mjs` in dòng "Luật thử nghiệm (luồng đơn)". Bật khi log
chạy ẩn ≥ 1 tuần không có ✗.

## Test

`tests/tools-intent.test.mjs`: kho giả trong tmp (gộp tin, ctx v2, CLI với `CRM_DATA_DIR`, nhật ký quyết định),
relabel với luật thật, merge ưu tiên + `--trust`, cache/thử lại của label-dataset (không gọi mạng), shadow-report
trên nhật ký giả và journal giả.
