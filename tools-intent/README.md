# Mô hình ra quyết định nhỏ – công cụ huấn luyện và đo

Mô hình nhỏ (`app/processing/intent-model.mjs`, trọng số `intent-model.json`) đoán mã mẫu trả lời
cho tin khách trước khi hỏi LLM. Cài đặt `intentModel`: `shadow` (chỉ ghi log so với câu trả lời
thật), `on` (tự trả lời khi chắc ≥ `intentThreshold` và mẫu thuộc danh sách an toàn `intentSafeTemplates`
— hằng số trong `app/processing/intent-model.mjs`, không chỉnh trong Cài đặt), `off`.
Mô hình tầng (`app/processing/intent-cascade.mjs`, trọng số `intent-cascade.json`, `tools-intent/train-cascade.mjs`)
chạy song song theo cài đặt `intentCascade`.

Tất cả công cụ chạy trên máy chủ, trong `/opt/facebook-crm`, bằng `sudo -u crm node --env-file=.env …`
(đọc kho ở `data/processed`; đặt `CRM_DATA_DIR` chỉ khi chạy trên bản sao dữ liệu ở máy khác).
Tệp dữ liệu chứa chữ khách (đã che SĐT, không có tên) chỉ để ở `/tmp` hoặc `data/processed`, không đưa
vào git. Không công cụ nào gửi tin cho khách. Đối số sai (cờ thiếu giá trị, số không hợp lệ, tệp không có)
→ báo lỗi một dòng, mã thoát 1. Dòng JSONL hỏng (ghi dở) được bỏ qua và đếm.

## Row cho mô hình: MỘT định nghĩa (`intentRowOf`)

`app/processing/intent-features.mjs` → `intentRowOf({ text, lastTemplateId, prevBotText, pendingOrder, orders, now,
source, phoneInText?, hasBasket?, hasOrder?, orderAgeMin?, prevBotAsks?, livestream? })` dựng row mô hình dùng ở
dựng dữ liệu (`dataset-context`, `build-dataset`), đo (`golden-set.enrichGoldenContext`, `replay-golden`), huấn luyện
(`train-intent` / `train-cascade` qua `intentRowFromRecord`) và (khi engine nối) lúc chạy:

| Trường | Định nghĩa |
|---|---|
| `lastTemplate` | mã engine LƯU (`canonicalTemplateId`): ORDER_ADDRESS_PARTIAL/CLARIFY/CHOOSE, ORDER_CART_LINE, UPSELL_TWO_BAGS, ORDER_ADDRESS_REMIND → ORDER_ADDRESS; ORDER_UPDATED → ORDER_UPDATE; ORDER_CANCELLED → ORDER_CANCEL; ORDER_NOTE_ADDED → ORDER_NOTE |
| `lastWasOrderStep` | `isOrderStep` (ORDER_ADDRESS/PHONE/CONFIRMATION/UPDATE) + ASK_FLAVOR, ORDER_ADDRESS_REMIND, ORDER_CUSTOM_BASKET (như ctx của luật) |
| `hasBasket` | có `pendingOrder` → giỏ còn hạn 2 giờ có món; ngoại tuyến → giá trị đưa vào |
| `prevBotAsks` | giá trị engine đã tính (khác rỗng) hay: họ ORDER_ADDRESS + giỏ → thiếu SĐT/địa chỉ như `engine.prevBotAsks`; không biết giỏ → đọc `{missing}` câu bot; mã hỏi vị → `flavor`; còn lại `askedSlotOf(câu bot, mã)` |
| `hasOrder` / `orderAgeMin` | đơn CHƯA hủy gần nhất trước `now`; `hasOrder` chỉ khi < 24 giờ (như engine) |
| `phoneInText` / `addressInText` / `bagCount` | từ chữ: `<sdt>` sau `maskPersonal`, `ADDRESS_WORDS`, `countBags` (gồm "túi xanh x2", "combo 3") |

`normalizeIntentText` che bằng `maskPersonal` của nhật ký quyết định (SĐT → `<sdt>`, email → `<email>`, dãy ≥ 9 số
→ `<so>`): chữ trong nhật ký và chữ thật lúc chạy ra cùng token; giá "1.250.000" không bị coi là SĐT.

## Hợp đồng dòng dữ liệu v2 (`*.jsonl`, mỗi dòng một JSON)

```
{ id, text, prevBot, prevCustomer, label, labelSource, weak?, corrected?, source, lastTemplate, lastWasOrderStep,
  hasBasket, basketItems, hasOrder, orderAgeMin, livestream, prevBotAsks, phoneInText, addressInText, bagCount,
  ruleTemplate, at }
```

- `text`: chữ khách **đã gộp như engine** (các tin chữ liên tiếp chưa được Page trả lời trong ≤ 10 phút,
  tối đa 5 tin, nối `\n`) và đã che (`<sdt>`…). Chữ huấn luyện phải giống chữ engine đưa vào luật/mô hình.
- `prevBot`: **câu** bot trước (đã che), không bao giờ là mã mẫu. `lastTemplate`: mã engine lưu (bảng trên).
- `labelSource`: `template` (câu Page gửi khớp chữ ký mẫu) · `staff` (nhân viên tự viết, LLM quy về mã mẫu;
  `corrected` = nhân viên sửa bot trong 10 phút) · `rule` (luật hiện hành bắt) · `llm` (Gemini gán lại) ·
  `both` (LLM trùng nhãn gốc) · `pipeline` (từ nhật ký quyết định).
- `weak`: nhãn kém chắc (lớp pipeline khớp kém trên bộ chấm — `merge-labels --trust`; hay luật khác nhãn mà giỏ
  không dựng lại được — `relabel-policy`); giữ để huấn luyện nhưng `train-intent` giảm trọng số ×0,7.
- `orderAgeMin` là `null` khi chưa có đơn (JSON không ghi được Infinity). `basketItems` là **số túi** trong
  giỏ bot đang giữ. `prevBotAsks` ∈ `phone|address|phone_address|flavor|quantity|confirm|''`.
- Trường thêm (không bắt buộc, công cụ khác bỏ qua): `prevBotAgeMin` (có trường này = dòng v2, biết chắc ngữ cảnh
  giỏ), `staffRepliedAfterBot`, `bundleSize`, `ruleName`, `labelBefore`, `chosen`, `final`, `llmTemplate`,
  `basket` ([{ sku, quantity }] từ nhật ký), `lastTemplateMatched` (mã con khớp chữ), `ruleUncertain`,
  `ruleMissingTemplate`.

## Quy trình huấn luyện lại (mỗi tuần)

```sh
# 1. Dựng dataset. Ưu tiên nhật ký quyết định (từ khi engine ghi data/processed/decision-log/YYYY-MM-DD.jsonl):
node tools-intent/build-dataset.mjs /tmp/dataset.jsonl --from-decision-log data/processed/decision-log [--since 2026-09-28] [--include-comments]
#    Nhãn = `chosen` khi final là mẫu gác/hậu xử lý (REPLY_ALREADY_SENT*, ORDER_ADDRESS_REMIND) và có chosen, còn lại = final
#    (mã engine ORDER_UPDATE/CANCEL/NOTE → ORDER_UPDATED/CANCELLED/NOTE_ADDED). `prevBot` của nhật ký là MÃ MẪU → lastTemplate;
#    câu bot trước đọc từ `prevBotText`, giỏ từ `basket` nếu engine ghi. Khử trùng id; in số dòng hỏng / trước since / trùng.
#    --since YYYY-MM-DD theo giờ Việt Nam, mặc định 2026-09-18 (in ra khi chạy); sai định dạng → lỗi.
#    Chưa có nhật ký / cần dữ liệu cũ hơn: dựng từ kho hội thoại (ngữ cảnh suy ngoại tuyến, xem mục giả định):
node --env-file=.env tools-intent/build-dataset.mjs /tmp/dataset.jsonl --llm [--since 2026-09-18] [--include-comments]
#    --llm: câu nhân viên tự viết → Gemini quy về mã mẫu (cache data/processed/staff-labels.json).
#    Bình luận mặc định BỎ (--include-comments để giữ). Chữ ký mẫu = mẫu gộp seed (normalizeChatbotSettings).

# 2. Nhãn theo luật hiện hành (chính sách mới nhất thắng câu bot cũ đã gửi):
node tools-intent/relabel-policy.mjs /tmp/dataset.jsonl /tmp/ruled.jsonl [--templates data/processed/chatbot-settings.json] [--conflicts f.jsonl] [--stable-only]
#    Luật ổn định + luật thử nghiệm ('on'; --stable-only: chỉ luật ổn định) → renderChatbotReply → ruleTemplate.
#    --templates: mẫu GỘP SEED như engine đọc (normalizeChatbotSettings), không phải messageTemplates thô.
#    Luật bắt → label = ruleTemplate, labelSource 'rule'; TRỪ: dòng staff/corrected (nhân viên > luật); mẫu luật ra không
#    có trong bộ mẫu (cảnh báo, ruleMissingTemplate); kết quả phụ thuộc giỏ (ORDER_ADDRESS/ORDER_INFO_ASK_FLAVOR/
#    ORDER_CONFIRMATION/ASK_FLAVOR…) mà giỏ không dựng lại được (dòng có giỏ nhưng không đọc ra món, hay dữ liệu v1 thiếu
#    prevBotAgeMin/basket) → giữ nhãn gốc, ruleUncertain, khác nhãn thì weak; dòng nhật ký bước đơn giữ nguyên nhãn engine.
#    In ma trận nhãn cũ → nhãn luật; dòng nhân viên ≠ luật ghi ra /tmp/ruled.staff-vs-rule.jsonl (bug luật tiềm năng — đọc tay).

# 3. Gán nhãn LLM cho phần còn lại (labelSource ∉ {rule, staff}):
node --env-file=.env tools-intent/label-dataset.mjs /tmp/ruled.jsonl /tmp/labels.jsonl [--only-drift] [--limit N] [--concurrency 2]
#    Gọi đúng đường trả lời thật (engine.requestDirectModelReply rawResponse, không few-shot), so mẫu sau renderChatbotReply.
#    Câu bot trước chỉ đưa khi là CHỮ (mã mẫu nằm nhầm trong prevBot chỉ làm botLastTemplateId).
#    Cache data/processed/llm-labels.json theo id + promptVersion (hash system prompt đã ghép mẫu): đổi prompt → gán lại;
#    chạy lại → bỏ qua dòng đã có nhãn, dòng lỗi được thử lại. Ghi cache sau mỗi 20 dòng. 429/quá tải/mạng
#    (fetch failed, HeadersTimeout) thử lại 3 lần rồi ghi lỗi và đi tiếp. --only-drift: chỉ dòng nhãn thuộc POLICY_DRIFT.
#    --limit / --concurrency: số nguyên dương.

# 4. Trộn (bộ chấm là tham số thứ 4 — BẮT BUỘC cho bản đo):
node tools-intent/merge-labels.mjs /tmp/ruled.jsonl /tmp/labels.jsonl /tmp/merged.jsonl data/processed/golden-set.json --trust data/processed/replay-llm-out.json [--keep-other] [--golden-window 10]
#    Ưu tiên staff > rule > template/pipeline (nhãn KHÔNG thuộc POLICY_DRIFT) > llm. LLM được nhận khi trùng nhãn gốc
#    ('both') hoặc khác nhưng nhãn gốc thuộc POLICY_DRIFT ('llm'). Bỏ confidence.
#    Loại dòng thuộc bộ chấm: trùng id, HOẶC cùng hội thoại lệch ≤ 10 phút (--golden-window, phút), HOẶC chữ chuẩn hoá trùng
#    (≥ 12 ký tự). OTHER: giữ dòng OTHER của nhân viên (lớp từ chối cho mô hình tầng), bỏ OTHER khác (--keep-other: giữ hết).
#    --trust: độ khớp pipeline theo lớp (replay-llm-out.json); lớp < 80% hoặc n < 15 → dòng (không phải staff/rule)
#    weak:true; kết quả "LỖI…" (gọi model hỏng) không tính là sai. Tệp không phải mảng → cảnh báo, bỏ qua --trust.

# 5. Huấn luyện ra tệp TẠM (không ghi đè app/processing/*.json trực tiếp) và đo:
node tools-intent/train-intent.mjs /tmp/merged.jsonl /tmp/model-new.json --golden data/processed/golden-set.json [--holdout 0.2] [--include-comments] [--quiet]
node tools-intent/train-cascade.mjs /tmp/merged.jsonl /tmp/cascade-new.json --golden data/processed/golden-set.json [--flat /tmp/m.json | --flat-out /tmp/m.json] [--holdout 0.2] [--quiet]
node tools-intent/replay-golden.mjs data/processed/golden-set.json --model /tmp/m.json --compare /tmp/model-new.json --cascade /tmp/cascade-new.json --gate
#    Đạt tiêu chí (mục dưới) → sao /tmp/model-new.json vào app/processing/intent-model.json (bản TRIỂN KHAI huấn luyện lại
#    trên toàn bộ dữ liệu, kể cả golden — khi đó meta.sawGolden = true và nó KHÔNG còn dùng để đo).
```

`train-intent`: mỗi dòng qua `intentRowFromRecord`; bỏ bình luận / COMMENT_* (`--include-comments` để giữ), OTHER và lớp
< 4 mẫu; dòng nhân viên ×2, weak/llm ×0,7; hiệu chuẩn nhiệt độ trên 20% mới nhất (`--holdout`, số trong (0, 1)).
Ghi `meta.trainIds` (băm FNV-1a id các dòng dataset) và, với `--golden`, `meta.goldenExcluded` { source, goldenIds,
matchedRows, matchedIds, excluded, byKind } + `meta.sawGolden` (true = dataset chứa mục golden → cảnh báo; không có
`--golden` → null = không rõ). `--quiet`: chỉ một dòng "saved …".

`train-cascade`: như trên cho mô hình tầng (tầng 1 ORDER/SUPPORT/ANSWER/OTHER + mô hình con), đo giữ-out tầng vs phẳng
cùng dữ liệu; `model.meta` có trainIds / goldenExcluded / sawGolden. `--golden` được kiểm TRƯỚC khi huấn luyện; bảng bộ
chấm so với bản PHẲNG "m" huấn luyện CÙNG dataset, cùng công thức (hay `--flat <m.json>` có sẵn; `--flat-out` ghi bản m).

`POLICY_DRIFT` = {ORDER_ADDRESS, ASK_PRODUCT, ASK_FLAVOR, GENERAL_INFO, PRICE_QUOTE, REPLY_ALREADY_SENT,
REPLY_ALREADY_SENT_INFO, ORDER_ADDRESS_REMIND, THANK_YOU}: mẫu mà câu bot đã gửi không chắc là câu đúng
(hậu xử lý, chính sách đổi, thiếu ngữ cảnh giỏ), nên nhãn gốc chỉ là gợi ý (hằng số ở `dataset-context.mjs`).

## Tiêu chí thay mô hình

So với bản **"m"**: mô hình huấn luyện CÙNG công thức (cùng công cụ, cùng tham số) trên dataset **không chứa golden**
(merge-labels có tham số bộ chấm; `meta.sawGolden = false`). **Không** so với mô hình đang triển khai: bản triển khai học
toàn bộ dữ liệu (v5 học 284/290 mục golden) nên số đo của nó trên bộ chấm bị thổi phồng; `replay-golden` đánh dấu
"MỐC SO KHÔNG HỢP LỆ" và không tính chênh lệch khi mốc đã thấy golden hay là mô hình đang chạy không rõ nguồn.

Thay `intent-model.json` khi đủ cả ba:

1. `replay-golden --model m.json --compare mới.json`: nhóm **rule-miss** (tin luật không bắt) trên bộ chấm tăng
   ≥ **+8 điểm** so với m, không giảm ở nhóm lên đơn (dòng "Chênh (mô hình 2 − mốc mô hình 1)" in ĐẠT/CHƯA ĐẠT).
2. Chạy ẩn trên log thật **≥ 1 tuần** (`shadow-report`): tỷ lệ ✓ ở p ≥ 0,8 **không thấp hơn** mô hình đang chạy
   (so trên log thật — không dính golden).
3. Không tăng ✗ ở các mẫu `ORDER_*` (lên đơn sai đắt hơn thông tin sai).

## Báo cáo chạy ẩn

```sh
node tools-intent/shadow-report.mjs [--since YYYY-MM-DD] [--dir data/processed/decision-log] [--price-in 0.5 --price-cache 0.05 --price-out 3.0] [--json]
journalctl -u facebook-crm -o short-iso --since "7 days ago" > /tmp/journal.txt && node tools-intent/shadow-report.mjs --journal /tmp/journal.txt [--year 2026]
```

Bảng theo ngày: lượt, lượt LLM, bỏ qua theo lý do, luật ổn định bắt (dùng thật), **luật ổn định (ẩn)** ✓/✗ (luật ổn
định chạy ẩn so với mẫu đã chọn), **luật thử** ✓/✗ (luật thử nghiệm so với luật ổn định), mô hình nhỏ ✓/✗ ở
p ≥ 0,7/0,8/0,9 **chỉ trên lượt LLM**, gác trước ✓/✗, người gác agree/ngoài theo mẫu, token trung bình và median
(vào/cache/ra/suy nghĩ), % lượt có suy nghĩ, ước chi phí (USD; phần vào không cache × giá vào + cache × giá cache +
(ra + suy nghĩ) × giá ra), mô hình tầng (nhóm ✓/✗, mẫu ✓/✗ theo ngưỡng; tầng đoán OTHER — không mẫu — vẫn đếm cột
nhóm). Dấu ✓/✗ theo quy ước engine (`intentMatchMark`: ORDER_ADDRESS_REMIND ≡ ORDER_ADDRESS); REPLY_ALREADY_SENT*
là "~" (trung tính) và **loại khỏi n** cho cả mô hình nhỏ lẫn tầng. Giá không phải số, `--journal` không có,
`--since` sai định dạng → lỗi.

Journal cũ chỉ có các dòng `Luật X → T`, `Luật X (thử): luật A / luật ổn định B ✓`, `Mô hình nhỏ (thử): X (p, biên m) / thật Y ✓`,
`Token model: vào N (cache C) · ra O · suy nghĩ T`: lượt LLM = dòng Token; dòng "Mô hình nhỏ" được coi là lượt luật
khi cùng hội thoại vừa có dòng `Luật X → T` (≤ 40 dòng trước), còn lại là lượt LLM. Gác trước/người gác không có trong journal.

## Giả định khi dựng ctx ngoại tuyến

`build-dataset` (từ kho) và `relabel-policy` dựng lại ngữ cảnh mà engine có lúc chạy thật từ lịch sử tin.
Nhật ký quyết định ghi ctx thật của engine nên **ưu tiên** khi có. Các giả định:

| Trường engine | Ngoại tuyến | Ghi chú |
|---|---|---|
| gộp tin | tin chữ liên tiếp của khách tới tin Page kế tiếp, ≤ 10 phút tính tới tin cuối, 5 tin cuối | như `unansweredCustomerMessages`; tin ảnh trong cụm bị bỏ |
| `botLastTemplateId` / `lastTemplate` | `matchTemplate` câu Page gần nhất trước cụm, quy về mã engine lưu (`canonicalTemplateId`) | câu nhân viên viết tay → `''` |
| bot / nhân viên | tin Page **không** cờ `staff` = bot; có cờ `staff` = nhân viên | `staffRepliedAfterBot` = nhân viên nhắn sau lượt bot gần nhất + 5 s (như engine) |
| `botLastAgeMin` | `prevBotAgeMin` = tuổi câu Page gần nhất | không có → Infinity |
| `hasBasket` | `lastTemplate` ∈ ORDER_ADDRESS*/PHONE/CONFIRMATION/UPDATE/UPDATED/CART_LINE/CUSTOM_BASKET/UPSELL_TWO_BAGS **hoặc** câu bot khớp "đang giữ đơn" / "đơn của … gồm", và câu đó < 120 phút | engine dùng `pendingOrder` còn hạn 2 giờ; ASK_FLAVOR chưa có túi |
| `basketItems` | tổng số trước "túi/gói/combo…" trong đoạn giỏ của câu bot | 0 khi không phải bước đơn |
| `pendingOrder` (soạn đơn) | `relabel-policy`: `basket` [{sku, quantity}] của nhật ký, không có thì `commentBasket(câu bot trước)` | không dựng được → kết quả phụ thuộc giỏ KHÔNG gắn `rule` (giữ nhãn gốc) |
| `hasRecentOrder` / `orderAgeMin` | `customerOrders` có `createdAt` < tin và chưa hủy (`processingStatus ≠ cancelled`, `status ≠ Hủy`); `hasOrder` mô hình chỉ khi < 24 giờ | không gộp đơn của hộp thư cùng khách cho bình luận |
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
node tools-intent/replay-golden.mjs [golden.json] [--model m.json] [--compare mới.json] [--cascade tầng.json] [--gate] [--all]
node --env-file=.env tools-intent/replay-llm.mjs [golden.json] [--limit N] [--fewshot]
node tools-intent/order-coverage.mjs [golden.json] [dataset.jsonl] [--all] [--show N] [--json] [--templates data/processed/chatbot-settings.json]
```

- `replay-golden`: mô hình nhỏ (`--model`, mặc định `INTENT_MODEL_PATH` / app/processing/intent-model.json) + luật ổn định
  so với bộ chấm; `--compare`: cột thứ hai + dòng chênh (chỉ khi mốc hợp lệ); in trạng thái rò golden từng mô hình
  (meta.trainIds / sawGolden; không có → "không rõ"); `--cascade`: bảng phẳng vs tầng; `--gate`: cờ "LLM ∉ top-3 ∪ luật"
  bắt LLM sai (đọc replay-llm-out.json cạnh bộ chấm); `--all`: chưa chấm thì dùng nhãn gợi ý (sơ bộ).
- `replay-llm`: Gemini (đúng prompt/cache đang chạy) so với bộ chấm → `replay-llm-out.json` cạnh bộ chấm (`--fewshot`:
  3 ví dụ đã chấm gần nhất, leave-one-out → `replay-llm-out-fewshot.json`, không đè tệp thường). Kết quả gọi hỏng ghi
  `llm: "LỖI …"` và không tính đúng/sai (kể cả trong `merge-labels --trust`).
- `order-coverage`: độ phủ luật + máy trạng thái slot trên nhóm MUA (golden + dòng nhân viên; `--all` thêm dòng khác);
  `--templates` gộp seed như engine; `--show 0` không in danh sách lỗ.

Bộ chấm mẫu (`data/processed/golden-set.json`) do nhân viên chấm trong Cài đặt → Thiết lập chatbot →
Chấm mẫu. Chỉ dùng để ĐO: mô hình đem đo phải huấn luyện với bộ chấm tách ra (tham số thứ 4 của
merge-labels, `--golden` của train-intent/train-cascade để ghi meta.sawGolden); mô hình triển khai thì huấn luyện trên
toàn bộ dữ liệu và không dùng để đo nữa.

Quy ước chấm: số lượng mà chưa rõ vị → ASK_FLAVOR; SĐT/địa chỉ mà chưa có sản phẩm → ASK_FLAVOR;
chỉ SĐT hoặc chỉ địa chỉ sau ORDER_ADDRESS → ORDER_ADDRESS_PARTIAL; tin "Khách chọn mua từ Facebook
Shop" → SHOP_ORDER_RECEIVED; bình luận hỏi giá/"ib" → COMMENT_PUBLIC_REPLY; tin chỉ có "." → OTHER.

Nhóm tầng (`intent-cascade.mjs`): mọi mẫu seed đều có nhóm ORDER / SUPPORT / ANSWER (PRICE/INFO/SOCIAL), trừ mẫu OTHER
CÓ CHỦ Ý (`isIntentionalOther`: COMMENT_*, FOLLOW_UP_*, TRIAL_*, QR_OFFER, LIVESTREAM_COMMENT, LIVE_DEAL_CLAIMED,
REPLY_ALREADY_SENT*) — luồng riêng quyết hay hậu xử lý; test kiểm cả bộ seed.

## Luồng đơn tất định (`app/processing/order-flow.mjs`)

Khi bot đang xin SĐT/địa chỉ và giỏ còn hạn, tin chỉ có SĐT / địa chỉ đủ / cả hai / "địa chỉ cũ" được
quyết bằng code (giá trị ORDER_ADDRESS + slot), bộ soạn đơn tự ghép giỏ và chọn bước tiếp. Chạy như
luật thử nghiệm: `experimentalRules` = `shadow` (mặc định, chỉ ghi log "Luật PHONE_ONLY (thử)…") hay
`on`. Đo trên bộ chấm mẫu: `replay-golden.mjs` in dòng "Luật thử nghiệm (luồng đơn)". Bật khi log
chạy ẩn ≥ 1 tuần không có ✗.

## Test

`tests/tools-intent.test.mjs`: kho giả trong tmp (gộp tin, ctx v2, CLI với `CRM_DATA_DIR`, nhật ký quyết định — mã mẫu
trong prevBot, prevBotText/basket, nhãn sau gác, khử trùng, đếm hỏng/since), relabel với luật thật (mẫu gộp seed, giỏ
không dựng được, basket[sku]), merge ưu tiên + `--trust` + loại golden id/lân cận/chữ + OTHER nhân viên, cache/thử lại
của label-dataset (không gọi mạng), lỗi CLI, shadow-report trên nhật ký giả và journal giả.
`tests/intent-features.test.mjs` (intentRowOf, che, mã engine lưu), `tests/intent-train.test.mjs` (meta rò golden,
replay-golden mốc so), `tests/intent-cascade.test.mjs` (bảng nhóm phủ mọi mẫu seed), `tests/golden-set.test.mjs`,
`tests/order-coverage.test.mjs`.
