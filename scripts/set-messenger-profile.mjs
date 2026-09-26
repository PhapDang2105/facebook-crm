// Đặt nút "Bắt đầu" và lời chào màn hình đầu cho Page đã kết nối trong CRM.
//
// Vì sao cần: khách MỚI (chưa từng nhắn Page) mở m.me/<page>?ref=<mã> từ QR
// thẻ cảm ơn chỉ thấy ô soạn tin nếu Page không có nút Bắt đầu, và Meta không
// gửi ref về webhook — ref của khách mới chỉ đi kèm postback của nút này.
// Có nút thì khách bấm một chạm, CRM nhận postback kèm ref và chào bằng QR_OFFER.
//
// Chạy trong thư mục dự án (đọc .env và data/processed/meta-channels.json):
//   node scripts/set-messenger-profile.mjs            # Page đầu tiên đã kết nối
//   node scripts/set-messenger-profile.mjs <pageId>   # Page cụ thể
//   node scripts/set-messenger-profile.mjs <pageId> --show   # chỉ xem, không đổi
import { readChannelStore, getPageAccessToken } from '../app/channel-store.mjs';
import { fetchMessengerProfile, setMessengerProfile } from '../app/meta-graph.mjs';

const arguments_ = process.argv.slice(2);
const showOnly = arguments_.includes('--show');
const requestedPageId = arguments_.find(value => /^\d+$/.test(value)) || '';

const channels = await readChannelStore();
const channel = requestedPageId
  ? channels.items?.find(item => String(item.id) === requestedPageId)
  : channels.items?.[0];
if (!channel) {
  console.error(requestedPageId ? `Không thấy Page ${requestedPageId} trong CRM.` : 'Chưa có Page nào kết nối trong CRM.');
  process.exit(1);
}
const pageId = String(channel.id);
const pageAccessToken = await getPageAccessToken(pageId);
const pageName = channel.name || 'Giọt Nắng';

console.log(`Page: ${pageName} (${pageId})`);
const before = await fetchMessengerProfile({ pageId, pageAccessToken });
console.log('Hiện tại:', JSON.stringify(before.data?.[0] || {}, null, 2));
if (showOnly) process.exit(0);

// Lời chào ngắn, dùng chung cho mọi khách mới (kể cả từ quảng cáo), nên không
// nhắc thẻ cảm ơn hay ưu đãi; phần đó QR_OFFER nói sau khi biết khách quét QR.
const profile = {
  get_started: { payload: 'GET_STARTED' },
  greeting: [{ locale: 'default', text: `Chào {{user_first_name}} 👋 Bấm Bắt đầu để ${pageName} tư vấn và gửi ưu đãi cho bạn nha.` }]
};
await setMessengerProfile({ pageId, pageAccessToken, profile });
const after = await fetchMessengerProfile({ pageId, pageAccessToken });
console.log('Đã đặt:', JSON.stringify(after.data?.[0] || {}, null, 2));
