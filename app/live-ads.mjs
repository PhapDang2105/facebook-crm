// Quảng cáo phiên Live (10/10, chủ shop: "khách mua Live được tặng quà"): khách bấm quảng cáo "Săn Sale 10/10 cùng Giọt
// Nắng" — tên Pancake trả về không có chữ "live", nhưng quảng cáo thuộc "Chiến dịch video trực tiếp - 09:54 10/10/26" →
// 14 khách hôm đó không được tính là khách Live, mất quà Live. Tra mã quảng cáo trong kho số liệu quảng cáo (Marketing API,
// app/meta-ads.mjs: ads[adId] = { campaignName, adsetName, adName }): tên chiến dịch / nhóm / quảng cáo là video trực tiếp
// hay livestream thì khách là khách Live.
//
// isLiveAdId chạy đồng bộ (isLivestreamConversation được gọi khắp engine) nên đọc từ bộ nhớ; refreshLiveAds nạp lại từ
// tệp (máy chủ gọi lúc khởi động và mỗi 10 phút — kho quảng cáo đồng bộ mỗi giờ).
import { metaAdsConfig } from './config.mjs';
import { readJsonFile } from './json-store.mjs';

const LIVE_NAME = /video trực tiếp|livestream|\blive\b|phát trực tiếp/iu;
let liveAdIds = new Set();
let loadedAt = 0;

/** Tên chiến dịch / nhóm / quảng cáo có phải phiên Live không. */
export function isLiveAdName(...names) {
  return names.some(name => LIVE_NAME.test(String(name || '').normalize('NFC')));
}

/** Mã quảng cáo Live từ kho quảng cáo `{ ads: { [adId]: { campaignName, adsetName, adName } } }`. */
export function liveAdIdsFrom(store) {
  const ads = store && typeof store.ads === 'object' && store.ads ? store.ads : {};
  return new Set(Object.entries(ads).filter(([, ad]) => isLiveAdName(ad?.campaignName, ad?.adsetName, ad?.adName)).map(([id]) => String(id)));
}

export function isLiveAdId(adId) {
  return Boolean(adId) && liveAdIds.has(String(adId));
}

/** Nạp lại danh sách mã quảng cáo Live (đọc tệp kho quảng cáo; lỗi thì giữ danh sách cũ). */
export async function refreshLiveAds({ filePath = metaAdsConfig.insightsPath } = {}) {
  try {
    const store = await readJsonFile(filePath, { fallback: () => ({ ads: {} }), label: 'Kho số liệu quảng cáo (quảng cáo Live)' });
    liveAdIds = liveAdIdsFrom(store);
    loadedAt = Date.now();
  } catch (error) {
    console.warn(`Quảng cáo Live: không đọc được kho quảng cáo (${error?.message || error}), giữ danh sách cũ.`);
  }
  return liveAdIds.size;
}

/** Chỉ cho test: đặt thẳng danh sách mã quảng cáo Live. */
export function setLiveAdIdsForTest(ids = []) {
  liveAdIds = new Set(ids.map(String));
  loadedAt = Date.now();
}

export const liveAdsLoadedAt = () => loadedAt;
