// Quản lý chiến dịch: ghép chi tiêu quảng cáo (meta-ads.mjs) với đơn thật của
// CRM để ra chi phí mỗi đơn (CPA) và doanh thu trên chi tiêu (ROAS) theo chiến dịch.
//
// Quy đơn về chiến dịch:
//  - Đơn trong hội thoại (bot chốt, nhân viên lên, POS kéo về): lần bấm quảng
//    cáo GẦN NHẤT của khách trước lúc đặt, trong vòng CAMPAIGN_ATTRIBUTION_DAYS
//    ngày (mặc định 7; `referrals[]`, hoặc `referral` của dữ liệu cũ). Quảng cáo
//    → chiến dịch qua bản đồ quảng cáo của kho số liệu; không có thì đọc tên
//    chiến dịch trong adTitle ("Tên quảng cáo · Tên chiến dịch", pancake.mjs ghép như vậy).
//  - Đơn landing: utm_campaign (campaignKey) khớp mã chiến dịch, rồi khớp tên
//    (không phân biệt hoa thường); không khớp thì là một dòng riêng nguồn "utm".
//  - Còn lại: chưa quy được (`unattributed`).
// Đơn hủy/hoàn và form landing bỏ dở chưa xác nhận không tính doanh thu
// (luật chung ở order-facts.mjs).
import { campaignConfig } from './config.mjs';
import { listLandingOrders } from './landing-orders.mjs';
import { readMessagingStore } from './messaging-store.mjs';
import { adsConnectionStatus, readAdStore, vietnamDay } from './meta-ads.mjs';
import { collectOrderFacts, datesBetween, DAY_MS, isCancelledOrder, isValidFact, normalizeDayRange } from './order-facts.mjs';

export { isCancelledOrder };

export const CAMPAIGN_RANGES = [7, 14, 30, 90];
export const ATTRIBUTION_WINDOW_MS = campaignConfig.attributionDays * DAY_MS;
const UNKNOWN_AD_CAMPAIGN = { id: 'meta:unknown', name: 'Quảng cáo chưa rõ chiến dịch' };

export function normalizeRangeDays(value) {
  const days = Number(value);
  return CAMPAIGN_RANGES.includes(days) ? days : 7;
}

const lower = value => String(value || '').trim().toLowerCase();
const round = (value, digits = 0) => {
  const factor = 10 ** digits;
  return Math.round((Number(value) || 0) * factor) / factor;
};

/** Lần bấm quảng cáo của hội thoại, kèm thời điểm (dữ liệu cũ chỉ có `referral` thì lấy lúc mở hội thoại). */
function adClicks(conversation) {
  const history = (Array.isArray(conversation?.referrals) ? conversation.referrals : [])
    .filter(item => item && (item.adId || item.adTitle) && item.source !== 'SHORTLINK' && Number(item.at));
  if (history.length) return history;
  const single = conversation?.referral;
  if (single && (single.adId || single.adTitle) && single.source !== 'SHORTLINK') {
    const at = Number(single.at) || Number(conversation.createdAt) || 0;
    if (at) return [{ ...single, at }];
  }
  return [];
}

/** Lần bấm quảng cáo gần nhất không muộn hơn lúc đặt đơn và không sớm hơn cửa sổ quy đơn. */
export function referralForOrder(conversation, createdAt, windowMs = ATTRIBUTION_WINDOW_MS) {
  let best = null;
  for (const click of adClicks(conversation)) {
    const at = Number(click.at);
    if (at > createdAt || createdAt - at > windowMs) continue;
    if (!best || at > best.at) best = { ...click, at };
  }
  return best;
}

/** "Tên quảng cáo · Tên chiến dịch" → "Tên chiến dịch". */
export function campaignNameFromAdTitle(adTitle) {
  const parts = String(adTitle || '').split(' · ');
  return parts.length > 1 ? parts[parts.length - 1].trim() : '';
}

function safeDecode(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * Khoảng ngày của báo cáo: `from`/`to` ("YYYY-MM-DD", giờ Việt Nam) nếu hợp lệ,
 * không thì `days` ngày gần nhất (7/14/30/90) tính cả hôm nay.
 */
export function campaignRange({ from, to, days = 7, now = Date.now() } = {}) {
  const explicit = normalizeDayRange(from, to);
  if (explicit) return explicit;
  const span = normalizeRangeDays(days);
  return { since: vietnamDay(now - (span - 1) * DAY_MS), until: vietnamDay(now), days: span };
}

/**
 * Dựng báo cáo chiến dịch. Thuần: mọi dữ liệu truyền vào, `now` quyết định
 * khoảng ngày (theo giờ Việt Nam, tính cả hôm nay) khi không có from/to.
 */
export function buildCampaignReport({
  conversations = [], landingOrders = [], adStore = {}, days = 7, from, to, now = Date.now(), ads = null,
  attributionWindowMs = ATTRIBUTION_WINDOW_MS, facts = null
} = {}) {
  const { since, until, days: span } = campaignRange({ from, to, days, now });
  const dates = datesBetween(since, until);
  const inRange = date => date >= since && date <= until;
  const knownCampaigns = adStore.campaigns && typeof adStore.campaigns === 'object' ? adStore.campaigns : {};
  const adMap = adStore.ads && typeof adStore.ads === 'object' ? adStore.ads : {};
  const byName = new Map(Object.values(knownCampaigns).filter(item => item?.name).map(item => [lower(item.name), item]));

  const rows = new Map();
  const rowFor = ({ key, id, name, source, campaign = null }) => {
    if (!rows.has(key)) {
      rows.set(key, {
        id,
        name: name || id,
        status: campaign?.status || '',
        source,
        dailyBudget: campaign?.dailyBudget ?? null,
        spend: 0, impressions: 0, clicks: 0, messages: 0, orders: 0, revenue: 0,
        byDate: new Map()
      });
    }
    return rows.get(key);
  };
  const metaRow = (campaignId, fallbackName = '') => {
    const campaign = knownCampaigns[campaignId];
    return rowFor({ key: `meta:${campaignId}`, id: campaignId, name: campaign?.name || fallbackName, source: 'meta', campaign });
  };
  const day = (row, date) => {
    if (!row.byDate.has(date)) row.byDate.set(date, { spend: 0, orders: 0, revenue: 0 });
    return row.byDate.get(date);
  };

  // Chi tiêu theo ngày × quảng cáo.
  let totalSpend = 0;
  for (const entry of Array.isArray(adStore.daily) ? adStore.daily : []) {
    if (!entry || !inRange(String(entry.date))) continue;
    totalSpend += Number(entry.spend) || 0;
    const campaignId = String(entry.campaignId || adMap[entry.adId]?.campaignId || '');
    if (!campaignId) continue;
    const row = metaRow(campaignId, adMap[entry.adId]?.campaignName);
    row.spend += Number(entry.spend) || 0;
    row.impressions += Number(entry.impressions) || 0;
    row.clicks += Number(entry.clicks) || 0;
    row.messages += Number(entry.messages) || 0;
    day(row, entry.date).spend += Number(entry.spend) || 0;
  }

  const rowForCampaignName = name => {
    const campaign = byName.get(lower(name));
    if (campaign) return metaRow(campaign.id);
    return rowFor({ key: `name:${lower(name)}`, id: `name:${name}`, name, source: 'meta' });
  };

  // Quy từng đơn trong khoảng về một dòng chiến dịch (hoặc không dòng nào).
  const rowOfFact = new Map();
  const attribute = (fact, conversation) => {
    if (!isValidFact(fact) || !inRange(fact.dateVN)) return;
    let row = null;
    if (conversation) {
      // Đơn trong hội thoại → lần bấm quảng cáo gần nhất trong cửa sổ quy đơn.
      const click = referralForOrder(conversation, fact.createdAt, attributionWindowMs);
      if (click) {
        const mapped = click.adId ? adMap[click.adId] : null;
        const nameFromTitle = campaignNameFromAdTitle(click.adTitle);
        if (mapped?.campaignId) row = metaRow(mapped.campaignId, mapped.campaignName);
        else if (nameFromTitle) row = rowForCampaignName(nameFromTitle);
        else row = rowFor({ key: UNKNOWN_AD_CAMPAIGN.id, ...UNKNOWN_AD_CAMPAIGN, source: 'meta' });
      }
    } else if (fact.source === 'landing') {
      // Đơn landing → utm_campaign (hoặc trang landing).
      const key = safeDecode(String(fact.utmCampaign || '').trim());
      // "{{campaign.id}}" là tham số động Meta chưa thay: không nói được gì.
      if (key && !key.includes('{{')) {
        const campaign = knownCampaigns[key] || byName.get(lower(key));
        row = campaign ? metaRow(campaign.id) : rowFor({ key: `utm:${lower(key)}`, id: key, name: key, source: 'utm' });
      }
    }
    rowOfFact.set(fact, row);
  };
  // `facts` gom sẵn (Tổng quan/Báo cáo dùng lại một lượt gom) hoặc gom tại đây.
  const conversationById = new Map(conversations.filter(item => item?.id).map(item => [String(item.id), item]));
  for (const fact of facts || collectOrderFacts({ conversations, landingOrders })) {
    attribute(fact, fact.conversationId ? conversationById.get(fact.conversationId) || null : null);
  }

  const unattributed = { orders: 0, revenue: 0 };
  for (const [fact, row] of rowOfFact) {
    if (!row) {
      unattributed.orders += 1;
      unattributed.revenue += fact.total;
      continue;
    }
    row.orders += 1;
    row.revenue += fact.total;
    const bucket = day(row, fact.dateVN);
    bucket.orders += 1;
    bucket.revenue += fact.total;
  }

  // Chiến dịch đang chạy mà chưa tiêu đồng nào trong khoảng này vẫn hiện, để thấy nó đang "đứng".
  for (const campaign of Object.values(knownCampaigns)) {
    if (campaign?.id && String(campaign.status).toUpperCase() === 'ACTIVE') metaRow(campaign.id);
  }

  // CPA/ROAS chỉ có nghĩa khi có chi tiêu: dòng utm (không có số chi) để null.
  const cpaOf = (spend, orders) => (spend && orders ? round(spend / orders) : null);
  const roasOf = (spend, revenue) => (spend ? round(revenue / spend, 2) : null);

  const campaigns = [...rows.values()].map(row => ({
    id: row.id,
    name: row.name,
    status: row.status,
    source: row.source,
    dailyBudget: row.dailyBudget,
    spend: round(row.spend, 2),
    impressions: row.impressions,
    clicks: row.clicks,
    messages: row.messages,
    orders: row.orders,
    revenue: round(row.revenue),
    cpa: cpaOf(row.spend, row.orders),
    roas: roasOf(row.spend, row.revenue),
    daily: dates.map(date => {
      const bucket = row.byDate.get(date) || { spend: 0, orders: 0, revenue: 0 };
      return { date, spend: round(bucket.spend, 2), orders: bucket.orders, revenue: round(bucket.revenue) };
    })
  })).sort((first, second) => second.spend - first.spend || second.revenue - first.revenue);

  // Tổng chỉ gồm đơn đã quy được về chiến dịch; đơn chưa quy được nằm riêng ở `unattributed`.
  const sum = key => campaigns.reduce((total, row) => total + row[key], 0);
  const totals = {
    spend: round(sum('spend'), 2),
    impressions: sum('impressions'),
    clicks: sum('clicks'),
    messages: sum('messages'),
    orders: sum('orders'),
    revenue: round(sum('revenue'))
  };
  totals.cpa = cpaOf(totals.spend, totals.orders);
  totals.roas = totals.spend ? round(totals.revenue / totals.spend, 2) : null;

  // Toàn cảnh: mọi đơn trong khoảng (đã quy + chưa quy) trên toàn bộ chi tiêu
  // (kể cả chi tiêu của quảng cáo chưa rõ chiến dịch).
  const blendedOrders = totals.orders + unattributed.orders;
  const blendedRevenue = round(totals.revenue + unattributed.revenue);
  const blendedSpend = round(totalSpend, 2);
  const blended = {
    orders: blendedOrders,
    revenue: blendedRevenue,
    spend: blendedSpend,
    cpa: cpaOf(blendedSpend, blendedOrders),
    roas: roasOf(blendedSpend, blendedRevenue)
  };

  return {
    range: { since, until, days: span },
    ads: ads || { connected: false, accounts: [], syncedAt: adStore.syncedAt || null },
    totals,
    blended,
    campaigns,
    unattributed: { orders: unattributed.orders, revenue: round(unattributed.revenue) }
  };
}

/** Báo cáo trên dữ liệu thật: hội thoại, đơn landing, kho số liệu quảng cáo. */
export async function loadCampaignReport({ days = 7, from, to, now = Date.now() } = {}) {
  const [store, landingOrders, adStore] = await Promise.all([readMessagingStore(), listLandingOrders(), readAdStore()]);
  const ads = await adsConnectionStatus({ store: adStore });
  return buildCampaignReport({ conversations: store.conversations || [], landingOrders, adStore, days, from, to, now, ads });
}
