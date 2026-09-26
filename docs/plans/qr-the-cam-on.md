# QR trên thẻ cảm ơn: kéo khách sàn TMĐT về Messenger

Bản kế hoạch sau nghiên cứu và phản biện, chốt ngày 26/09/2026. Mục nào đã làm thì ghi ngày ở cuối dòng.

## Mục tiêu

Thẻ cảm ơn đã kèm mỗi đơn sàn TMĐT từ hai năm nay, mã QR trên thẻ dẫn về Zalo và cho ưu đãi, hiệu quả thấp. Tính năng bổ sung này đổi đích của QR sang Messenger của Page: khách quét → vào Messenger → CRM ghi nhận khách, xin số điện thoại, tặng ưu đãi, chăm sóc lại. App Meta của CRM đang vận hành với khách thật (bot trả lời hộp thư và bình luận), nên không có việc App Review nào cản luồng này. Ba mục tiêu của chủ shop:

1. Meta có tệp người mua thật để phân phối quảng cáo và tạo Lookalike.
2. Có tệp khách hàng riêng, không phụ thuộc sàn (sàn che số điện thoại người mua).
3. Nối vào CRM để chăm sóc lại.

Không phân biệt sàn nào: nguồn khách ghi chung là **Sàn TMĐT**, mã QR theo **lô in** (`tmdt-01`, `tmdt-02`…), không theo sàn hay sản phẩm.

## Phễu và số đo

| Bước | Số đo | Nguồn |
| --- | --- | --- |
| Khách quét thẻ | lượt quét / thẻ đã kèm | `data/processed/qr-scans.json` |
| Bấm "Mở Messenger" trên trang đệm | lượt bấm / lượt quét | `POST /q/<mã>/open` |
| Vào được Messenger | referral nhận được / lượt quét | webhook `messaging_referrals` và `messaging_postbacks` |
| Gửi một tin (vào tệp quảng cáo 365 ngày) | tin đầu tiên / referral | hộp thư |
| Đồng ý xử lý dữ liệu | đồng ý / referral | log đồng ý |
| Để lại số điện thoại | số / referral | tệp khách hàng |
| Mua lại trong 30 ngày | đơn nguồn QR / số | tệp khách hàng |

Kỳ vọng thực tế: 2–8% đơn có quét (benchmark bao bì thực phẩm rất thấp, trung vị 16 lượt quét mỗi mã theo Scanova 05/2026). Với 60.000 thẻ là 1.200–4.800 khách. In thử 50 thẻ để đo trước khi in hết.

## Năm phát hiện quyết định kế hoạch

1. **Điều khoản sàn đã siết hơn so với lúc bắt đầu kèm thẻ.** Shopee coi mọi vật dẫn khách ra ngoài sàn là "giao dịch ngoài Shopee" (phạt lũy tiến, từ 25/05/2026 có thể khóa sản phẩm ngay lần đầu). TikTok Shop cấm cả giao dịch ngoài nền tảng lẫn dùng dữ liệu người mua để tiếp thị (Điều khoản người bán VN mục 6 và 14; 48 điểm/180 ngày là đóng shop). Thẻ đã kèm hai năm không sao, rủi ro này là việc chủ shop đã cân nhắc; ghi lại để lời trên thẻ mới không in ưu đãi hay tên kênh khác, phần ưu đãi chỉ nói trong Messenger.
2. **Không còn kênh miễn phí để nhắn khuyến mại ngoài 24 giờ.** Recurring Notifications ngừng 10/02/2026; Sponsored Messages ngừng 31/07/2024; thẻ tin POST_PURCHASE_UPDATE, CONFIRMED_EVENT_UPDATE, ACCOUNT_UPDATE trả lỗi 100 từ 27/04/2026. Thay thế là Marketing Messages API: trả phí theo tin đã giao, 1 tin/người/ngày, chỉ qua đối tác đã App Review. Còn lại: trong 24 giờ, khách tự nhắn lại (bấm m.me?ref mở lại cửa sổ), Utility template (không khuyến mại), HUMAN_AGENT (nhân viên trả lời tay, 7 ngày).
3. **Số điện thoại đơn sàn trong Pancake POS bị che.** Shopee che tên và số với mọi phần mềm bên thứ ba từ 24/07/2024; TikTok Shop che qua API. Không tra được đơn sàn theo số khách đưa. Số khách đưa trong Messenger là bản ghi thật đầu tiên. Muốn nối đúng đơn cũ thì QR phải mang mã đơn, tức in tại kho theo từng gói.
4. **Chuyển hướng 302 sang m.me hỏng trên iPhone.** Safari không tự mở app Messenger khi tới Universal Link qua chuyển hướng, chỉ hiện thanh "Mở trong app"; trang web m.me nay bắt đăng nhập vì Meta đã đóng messenger.com (04/2026). Chrome Android thì mở app được sau 302. Trình duyệt trong app Zalo, Facebook, Instagram, TikTok không bàn giao cho hệ thống. Cần trang đệm HTML có nút bấm thật.
5. **Nút bấm chỉ gửi được qua Send API của Meta.** Hội thoại đến từ Pancake được CRM trả lời qua Public API Pancake (chỉ chữ và ảnh, `app/meta-sync.mjs`). Quick reply xin số điện thoại và nút "Nhận quà" phải đi qua token Meta của Page, CRM đã có token này (Page kết nối ở Cài đặt → Kênh). Page chưa có nút Bắt đầu (`messenger_profile` chưa được đặt trong mã).

Điểm thuận lợi: tệp "người đã nhắn tin cho Page" lưu 365 ngày; Conversions API for Business Messaging còn hoạt động với PSID (`action_source: business_messaging`, `user_data.page_id` + `page_scoped_user_id`); tối ưu quảng cáo Click-to-Messenger theo Purchase mở sau 5 sự kiện mua trong 30 ngày, Meta công bố chi phí biên thấp hơn 33% so với tối ưu theo hội thoại.

## Kế hoạch theo giai đoạn

### Giai đoạn 0. Quyết định và kiểm chứng

- [ ] Lời trên thẻ mới: cảm ơn và "quét để nhận hướng dẫn dùng, công thức, quà cảm ơn"; không in ưu đãi cụ thể, không nhắc kênh khác. Ưu đãi chỉ xuất hiện trong Messenger sau khi khách đồng ý.
- [ ] **Kết nối lại Page Nông Sản Giọt Nắng ở Cài đặt → Kênh → Kết nối Facebook.** Phát hiện 26/09 khi quét thử: token Meta của Page bị từ chối ("The user has not authorized application 1062928993200268", mã 190/458), tức tài khoản Facebook đã kết nối Page hôm 09/09 không còn cấp quyền cho app của CRM; log máy chủ từ 24/09 không nhận sự kiện Meta nào. Hệ quả: khách quét QR vào được Messenger nhưng CRM không nhận referral và không gửi được QR_OFFER. Chỉ chủ tài khoản Facebook làm được bước này (đăng nhập OAuth).
- [ ] Đặt nút Bắt đầu cho Page: sau khi kết nối lại, chạy `node scripts/set-messenger-profile.mjs 110068281327307` trên VPS (script đã có, chưa chạy được vì token hỏng). Không đặt Ice Breakers (sẽ che nút Bắt đầu; tài liệu không xác nhận referral kèm trong ice breaker).
- [ ] Xem Conversation Routing của Page (đã thay Handover Protocol): không đặt app mặc định, hoặc đặt CRM làm mặc định. Đặt Pancake làm mặc định thì CRM bị lỗi 2534037 khi hội thoại ngủ quá 24 giờ.
- [ ] Quyết định tắt "Đồng bộ sự kiện mua hàng" bên Pancake POS hay chấp nhận đếm đôi, trước khi CRM gửi Conversions API. Không khử trùng được bằng `event_id` vì không biết POS gửi gì.

### Giai đoạn 1. Trang đệm và in thử

- [x] `/q/<mã>`: chỉ 302 với Chrome Android hệ thống; còn lại trả trang HTML nhẹ có một nút "Mở Messenger" trỏ `m.me/<page>?ref=<mã>`. Nhận diện Zalo, Facebook, Instagram, TikTok, WebView để hiện hướng dẫn "Mở bằng trình duyệt". Ghi loại máy, loại trình duyệt, cách phục vụ (chuyển hướng hay trang) và lượt bấm nút. `Cache-Control: no-store`. Xem `app/qr-bridge.mjs`. (26/09/2026)
- [ ] In 50 thẻ: mức sửa lỗi Q, cạnh QR từ 2,2 cm, vùng trắng 4 module, in kèm dòng chữ `fb.giotnang.vn/q/<mã>`. Quét thử trên iPhone (Camera), Android (Camera, Google Lens), Zalo, app Facebook, một app ngân hàng. Đối chiếu lượt quét, lượt bấm, referral nhận về.
- [x] Trang đệm có thêm nút "Nhắn qua Zalo" khi đặt liên kết Zalo ở Cài đặt → Mã QR (khách quen Zalo hay quét bằng Zalo không phải rời app); lượt bấm đếm từ lúc chạm nút vì iPhone nhảy app trước `click`. Lần quét thử đầu (26/09, iPhone): trang đệm hiện, bấm vào Messenger được, nhưng Meta không gửi referral cho hội thoại có sẵn của chủ shop — đúng với cảnh báo "không cam kết" của Meta, cần đo trên nhiều máy hơn. (26/09/2026)
- [x] Cài đặt → Mã QR: tạo ảnh QR (SVG để in, PNG) cho mã lô bất kỳ qua `GET /api/qr/image/<mã>.svg|.png`, và bảng thống kê đọc từ `GET /api/qr/stats`. Xem `app/qr-image.mjs`. (26/09/2026)
- [ ] Chỉ in 60.000 thẻ khi tỷ lệ đến Messenger chấp nhận được.

### Giai đoạn 2. Lượt chào và bản ghi khách

Đây là toàn bộ giá trị của dự án.

- [ ] Tin QR đi qua Send API Meta kể cả khi hội thoại đang ở Pancake (cần token Meta của Page trong channel store).
- [ ] Trình tự chào: (1) tin cảm ơn kèm nút "Nhận hướng dẫn và quà" để khách gửi một tin và vào tệp 365 ngày; (2) thông báo xử lý dữ liệu có link tới `/privacy`, nút Đồng ý riêng cho tiếp thị, không mặc định; (3) quick reply `user_phone_number` (chỉ hiện khi hồ sơ có số) kèm nhánh gõ tay; (4) voucher cố định, giảm không quá 50%, hạn 30 ngày, dùng khi đặt qua Messenger. Không thẻ cào, không may rủi (khuyến mại may rủi phải đăng ký với Sở Công Thương).
- [ ] Lưu bằng chứng đồng ý: PSID, thời điểm, nội dung (Luật BVDLCN 91/2025 Điều 9; NĐ 356/2025 Điều 6).
- [ ] Ý định "dừng nhận tin" và "xóa dữ liệu" cho bot (Điều 10, 14, 28). Cập nhật `web/privacy.html`: mục đích thu số điện thoại và tiếp thị.
- [ ] Ghi số điện thoại, mã lô, nguồn "Sàn TMĐT" vào tệp khách hàng; gộp với khách landing và chatbot theo số. Lưu nguồn vào đầu tiên (ref, source, thời điểm) trên hội thoại để đo theo lô thẻ.
- [ ] Không đẩy dữ liệu người mua tải từ sàn vào bất kỳ tệp quảng cáo nào.
- [ ] Chào QR phải né khi bot đang giữa luồng chốt đơn hoặc nhân viên đang nhận trong Pancake (hiện chỉ có cooldown 6 giờ ở `scheduleQrGreetings`).
- [ ] Ref có thể mất (Meta không cam kết; khách gõ tin trước khi bấm Bắt đầu). Đọc referral ở cả ba chỗ: `postback.referral`, `message.referral`, sự kiện `messaging_referrals`.

### Giai đoạn 3. Meta và chăm sóc lại (khi đã có vài trăm khách)

- [ ] Conversions API for Business Messaging: `LeadSubmitted` khi khách xác nhận số điện thoại, `Purchase` (VND, số nguyên) khi khách đặt lại qua chatbot, đều kèm PSID; `event_id` = mã đơn; hàng đợi có trạng thái để thử lại; CRM tự chống trùng vì Meta không khử trùng cho kênh này. Không gửi Purchase cho đơn sàn (không xảy ra trong luồng chat, và `event_time` không được cũ quá 7 ngày). Cần Dataset gắn Page (`POST /{page_id}/dataset`) và token có quyền `page_events`; tài liệu Meta ghi quyền này cần Advanced Access, thử với token system user của chính doanh nghiệp trước, không được thì mới xin quyền cho riêng mục này.
- [ ] Quảng cáo: tệp "đã nhắn tin cho Page" (365 ngày) và tệp "mua sau khi nhắn tin" làm gợi ý cho Advantage+; quảng cáo nhắn tin tối ưu theo Purchase khi đủ 5 sự kiện/30 ngày.
- [ ] Chăm sóc lại trong khuôn khổ: một tin nhắc trước khi hết 24 giờ (giờ thứ 20); voucher lưu trong Messenger; menu cố định có mục "Ưu đãi của tôi" để khách tự quay lại; Utility template cho cập nhật đơn. Kịch bản bám đuổi mới trong `app/follow-up.mjs` với mốc kích hoạt `qr-scan`.
- [ ] Nếu cần nhắn hàng loạt: hỏi Pancake về Marketing Messages (Botcake là đối tác có sẵn) trước khi gắn nền tảng thứ ba.

### Đã bỏ

Nút `intent://` trên Android (Chrome đã đi qua 302, WebView chỉ cần thẻ `<a>`); nút chọn sản phẩm đã mua; SMS và ZNS; dạy bot nhận mã lô gõ tay; deep link `fb-messenger://` (không có tài liệu, không chắc truyền được ref); Pixel trên trang đệm (không có cookie Facebook, khớp kém); gửi Purchase kiểu Business Messaging cho đơn sàn; QR theo sàn hay theo sản phẩm.

## Pháp lý (tổng hợp văn bản, không phải tư vấn luật sư)

- Khuyến mại (NĐ 81/2018, sửa bởi NĐ 128/2024): voucher cho đơn kế tiếp là phiếu mua hàng, miễn thông báo Sở Công Thương khi tổng quà dưới 100 triệu; mức giảm tối đa 50%; thẻ cào "100% trúng quà" với quà khác nhau là may rủi, phải đăng ký.
- Dữ liệu cá nhân (Luật 91/2025/QH15 từ 01/01/2026; NĐ 356/2025): đồng ý phải rõ ràng cho từng mục đích, im lặng không phải đồng ý, lưu bằng chứng, có quyền rút lại, tiếp thị phải có cơ chế từ chối. Hộ kinh doanh và doanh nghiệp siêu nhỏ miễn hồ sơ đánh giá tác động; doanh nghiệp nhỏ được hoãn 5 năm.
- Tin nhắn quảng cáo (NĐ 91/2020): chưa áp dụng cho Messenger/Zalo nhưng dự thảo 16/09/2026 mở rộng sang OTT. Áp dụng luôn chuẩn: đồng ý trước, có "STOP", 7h–22h, tần suất thấp.
- Thẻ cảm ơn không phải nhãn hàng hóa (NĐ 43/2017); không ghi công dụng chữa bệnh; đặt ngoài bao bì thực phẩm.

## Nguồn

Meta: [m.me links](https://developers.facebook.com/documentation/business-messaging/messenger-platform/discovery/m-me-links) · [messaging_referrals](https://developers.facebook.com/documentation/business-messaging/messenger-platform/webhooks/webhook-events/messaging_referrals) · [Quick replies](https://developers.facebook.com/documentation/business-messaging/messenger-platform/send-messages/quick-replies) · [Chính sách nhắn tin](https://developers.facebook.com/documentation/business-messaging/messenger-platform/policy) · [Changelog (thẻ tin ngừng 27/04/2026)](https://developers.facebook.com/docs/messenger-platform/changelog/) · [Marketing Messages](https://developers.facebook.com/docs/marketing-messages-on-messenger/) · [Recurring Notifications ngừng](https://developers.facebook.com/docs/messenger-platform/marketing-messages/) · [Conversation Routing](https://developers.facebook.com/documentation/business-messaging/messenger-platform/conversation-routing) · [Mã lỗi](https://developers.facebook.com/documentation/business-messaging/messenger-platform/error-codes) · [CAPI Business Messaging](https://developers.facebook.com/docs/marketing-api/conversions-api/business-messaging/) · [Purchases through messaging](https://www.facebook.com/business/ads/click-to-message-ads/purchases-through-messaging) · [Customer list audiences](https://developers.facebook.com/docs/marketing-api/audiences/guides/custom-audiences) · [Lookalike](https://developers.facebook.com/docs/marketing-api/audiences/guides/lookalike-audiences) · [Advantage+ audience](https://www.facebook.com/business/ads/meta-advantage-plus/audience) · [Sponsored Messages ngừng](https://www.jonloomer.com/qvt/meta-to-deprecate-sponsored-messages/) · [messenger.com đóng](https://www.techcrunch.com/2026/02/19/meta-is-shutting-down-messengers-standalone-website/).

Trang đệm: [Universal Links và redirect](https://integrations.impact.com/integration-guides/for-brands/tracking-integrations/troubleshoot-ios-universal-links-and-redirects) · [Chrome Android app link qua 302](https://paul.kinlan.me/deep-app-linking-on-android-and-chrome/) · [inapp-spy](https://github.com/shalanah/inapp-spy) · [Mở link Zalo bằng trình duyệt](https://quantrimang.com/cong-nghe/cach-mo-link-tren-zalo-bang-trinh-duyet-199742) · [Kích thước QR](https://www.uniqode.com/blog/qr-code-best-practices/how-to-perfectly-size-your-qr-codes) · [Benchmark quét](https://scanova.io/blog/qr-code-statistics/).

Sàn và Pancake: [Shopee che thông tin người mua](https://banhang.shopee.vn/edu/article/7424) · [Giao dịch ngoài Shopee](https://ecommax.vn/vi-pham-giao-dich-ngoai-shopee/) · [Điều khoản người bán TikTok Shop VN](https://seller-vn.tiktok.com/university/essay?knowledge_id=2581017870255874) · [Điểm vi phạm TikTok Shop](https://seller-vn.tiktok.com/university/essay?knowledge_id=8623594494494465&lang=vi-VN) · Pancake POS "Đồng bộ sự kiện mua hàng" (docs.pos.pages.fm) · `integrations/pancake/openapi.json` (trường `marketplace_id`, `bill_phone_number`).

Pháp lý: [NĐ 128/2024](https://vanban.chinhphu.vn/?pageid=27160&docid=211405) · [Luật BVDLCN 91/2025](https://vanban.bocongan.gov.vn/co-so-du-lieu-van-ban/luat-bao-ve-du-lieu-ca-nhan-1753688803) · [NĐ 356/2025](https://luatvietnam.vn/thong-tin/nghi-dinh-356-2025-nd-cp-quy-dinh-chi-tiet-luat-bao-ve-du-lieu-ca-nhan-422896-d1.html) · [NĐ 91/2020](https://vanban.chinhphu.vn/default.aspx?pageid=27160&docid=200773) · [Dự thảo mở rộng sang OTT](https://luatvietnam.vn/tin-van-ban-moi/tai-khoan-zalo-messenger-whatsapp-telegram-phat-tan-tin-nhan-rac-co-the-bi-khoa-186-112471-article.html).

Ý tưởng mượn: Chatwoot fork Tech-Auris PR #551 (lưu nguồn vào đầu tiên trên hội thoại) và PR #559 (hàng đợi CAPI có trạng thái); Botcake và AhaChat (phễu đo từng bước cho công cụ QR ref).
