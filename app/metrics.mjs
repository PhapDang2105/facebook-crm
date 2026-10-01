// Định nghĩa số liệu dùng chung cho Tổng quan, Báo cáo, Chiến dịch và cố vấn
// AI: một hàm ROAS, một định nghĩa "khách mới", một cách báo số quảng cáo đã cũ.
// Chữ định nghĩa (METRIC_DEFINITIONS) gửi kèm API để giao diện hiện đúng câu
// này trong chú thích, không mỗi màn tự viết một kiểu.

const round = (value, digits = 0) => {
  const factor = 10 ** digits;
  return Math.round((Number(value) || 0) * factor) / factor;
};

export const METRIC_DEFINITIONS = Object.freeze({
  revenue: 'Doanh thu = tổng tiền các đơn hợp lệ đặt trong khoảng ngày (giờ Việt Nam). Không tính đơn hủy, hoàn, bom (theo trạng thái mới nhất, kể cả đơn bị hủy/hoàn trên POS nhiều ngày sau), đơn trùng đã xóa khỏi bảng, và form landing bỏ dở chưa xác nhận.',
  roas: 'ROAS = doanh thu đơn quy được về quảng cáo Meta (khách bấm quảng cáo trong 7 ngày trước khi đặt, hoặc đơn landing có utm_campaign khớp chiến dịch Meta) ÷ chi phí quảng cáo Meta cùng khoảng ngày. Đơn landing gắn UTM không khớp chiến dịch nào có chi phí thì không cộng vào ROAS mà hiện riêng; đơn hủy/hoàn/bom và đơn trùng không tính.',
  newCustomers: 'Khách mới = khách (nhận theo số điện thoại) có đơn hợp lệ ĐẦU TIÊN nằm trong khoảng ngày đang xem (giờ Việt Nam). Đơn hủy/hoàn/bom, đơn trùng và form bỏ dở không tính là đơn đầu tiên.'
});

/** ROAS = doanh thu ÷ chi phí, 2 chữ số thập phân; không có chi phí thì null (không chia cho 0). */
export function roasOf(revenue, spend) {
  const cost = Number(spend) || 0;
  return cost > 0 ? round((Number(revenue) || 0) / cost, 2) : null;
}

/** CPA = chi phí ÷ số đơn; thiếu một trong hai thì null. */
export function cpaOf(spend, orders) {
  const cost = Number(spend) || 0;
  const count = Number(orders) || 0;
  return cost > 0 && count > 0 ? round(cost / count) : null;
}

/**
 * Ngày đơn hợp lệ đầu tiên của từng khách. `facts` xếp cũ trước (như
 * collectOrderFacts trả về); `isCounted(fact)` quyết định đơn nào là đơn thật.
 */
export function firstOrderDates(facts = [], isCounted = () => true) {
  const first = new Map();
  for (const fact of facts) {
    if (!fact?.dateVN || !isCounted(fact)) continue;
    const known = first.get(fact.customerKey);
    if (!known || fact.dateVN < known) first.set(fact.customerKey, fact.dateVN);
  }
  return first;
}

/** Khách mới trong [from, to]: số khách có đơn hợp lệ đầu tiên nằm trong khoảng. */
export function countNewCustomers(firstDates, from, to) {
  let count = 0;
  for (const date of firstDates.values()) if (date >= from && date <= to) count += 1;
  return count;
}

// ===== Số liệu quảng cáo đã cũ =====

/** Vòng nền đồng bộ mỗi 60 phút: quá 3 giờ chưa đồng bộ được là số đã cũ. */
export const ADS_STALE_AFTER_MS = 3 * 60 * 60 * 1000;

const VIETNAM_OFFSET_MS = 7 * 60 * 60 * 1000;

/** "14:05 30/09/2026" theo giờ Việt Nam. */
export function formatVietnamTime(ms) {
  const date = new Date(Number(ms) + VIETNAM_OFFSET_MS);
  const pad = value => String(value).padStart(2, '0');
  return `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())} ${pad(date.getUTCDate())}/${pad(date.getUTCMonth() + 1)}/${date.getUTCFullYear()}`;
}

/**
 * Trạng thái kết nối quảng cáo kèm cờ "số cũ": Meta Ads lỗi / mất kết nối /
 * lâu chưa đồng bộ mà kho vẫn còn số của lần trước thì số đó chỉ đúng đến lúc
 * đồng bộ cuối — thêm `stale`, `dataUntil` và câu cảnh báo "dữ liệu đến …".
 * Còn mới thì trả lại nguyên `ads` (không thêm trường).
 */
export function withAdsFreshness(ads, now = Date.now()) {
  if (!ads || typeof ads !== 'object') return ads;
  const syncedAt = Number(ads.syncedAt) || 0;
  if (!syncedAt) return ads;
  const disconnected = ads.connected === false;
  const failing = Boolean(ads.error);
  const late = now - syncedAt > ADS_STALE_AFTER_MS;
  if (!disconnected && !failing && !late) return ads;
  const why = disconnected ? 'Meta Ads đang mất kết nối' : failing ? 'Meta Ads đang lỗi' : 'chưa đồng bộ lại được với Meta Ads';
  return {
    ...ads,
    stale: true,
    dataUntil: syncedAt,
    notice: `Số liệu quảng cáo chỉ là dữ liệu đến ${formatVietnamTime(syncedAt)} (${why}); chi phí và ROAS sau mốc này chưa được cập nhật.`
  };
}
