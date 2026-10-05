import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { tempDir } from './helpers/temp-dir.mjs';
import {
  addCompetitor, addManualAd, adLibraryError, adLibraryView, buildArchiveParams, buildBrandedParams, buildMarketPrompt,
  daysRunning, detectOffers, generateMarketInsights, marketBrief, marketSignals, parseArchivedAd, parseBrandedContent,
  parseIgUsername, parseLibraryAdId, parsePageRef, parsePageUrl, readAdLibrary, removeCompetitor, ruleMarketIdeas,
  syncCompetitors, updateAdLibrary, validateMarketAnswer
} from '../app/ad-library.mjs';

const directory = tempDir('ad-library-');
// 05/10/2026 10:00 giờ Việt Nam.
const now = Date.parse('2026-10-05T03:00:00Z');
const storePath = () => path.join(directory, `store-${Math.random().toString(36).slice(2)}.json`);
const config = (overrides = {}) => ({ accessToken: 'token-thu', graphVersion: 'v26.0', appSecret: '', countries: ['VN'], path: storePath(), ...overrides });
const json = (body, status = 200) => ({ ok: status < 400, status, json: async () => body });

function fakeFetch(handler) {
  const calls = [];
  const fetchImpl = async url => {
    const target = new URL(String(url));
    calls.push(target);
    return handler(target);
  };
  return { fetchImpl, calls };
}

test('nhận dạng Page, Instagram và ID quảng cáo từ nhiều kiểu liên kết', () => {
  assert.equal(parsePageRef('103549382215599'), '103549382215599');
  assert.equal(parsePageRef('https://www.facebook.com/ads/library/?active_status=active&view_all_page_id=936023372925639'), '936023372925639');
  assert.equal(parsePageRef('facebook.com/profile.php?id=61550000000001'), '61550000000001');
  assert.equal(parsePageRef('https://www.facebook.com/Granola-ABC-110068281327307/'), '110068281327307');
  assert.equal(parsePageRef('https://www.facebook.com/giotnang.healthy'), '');
  assert.equal(parsePageRef('https://evil.com/?view_all_page_id=123456789'), '');

  assert.equal(parsePageUrl('https://m.facebook.com/giotnang.healthy/?ref=bookmarks'), 'https://www.facebook.com/giotnang.healthy');
  assert.equal(parsePageUrl('facebook.com/profile.php?id=61550000000001'), 'https://www.facebook.com/profile.php?id=61550000000001');
  assert.equal(parsePageUrl('https://www.facebook.com/ads/library/?id=1'), '');
  assert.equal(parsePageUrl('https://www.facebook.com/groups/abc'), '');
  assert.equal(parsePageUrl('https://instagram.com/abc'), '');

  assert.equal(parseIgUsername('@Granola.ABC'), 'granola.abc');
  assert.equal(parseIgUsername('https://www.instagram.com/granola_abc/'), 'granola_abc');
  assert.equal(parseIgUsername('ten co dau cach'), '');

  assert.equal(parseLibraryAdId('https://www.facebook.com/ads/library/?id=1234567890123'), '1234567890123');
  assert.equal(parseLibraryAdId('https://www.facebook.com/somepage/posts/1'), '');
});

test('tham số /ads_archive và /branded_content_search đúng tài liệu', () => {
  const ads = buildArchiveParams({ pageIds: Array.from({ length: 12 }, (_, index) => String(100000 + index)), countries: ['VN', 'TH'] });
  assert.equal(ads.ad_reached_countries, "['VN','TH']");
  assert.equal(ads.ad_type, 'ALL');
  assert.equal(ads.ad_active_status, 'ACTIVE');
  assert.equal(ads.search_page_ids.split(',').length, 10, 'tối đa 10 Page một lượt');
  assert.match(ads.fields, /ad_creative_bodies/);
  assert.equal(buildArchiveParams({ terms: 'x'.repeat(150) }).search_terms.length, 100);

  const branded = buildBrandedParams({ pageUrl: 'https://www.facebook.com/abc', since: '2026-04-09', until: '2026-10-05' });
  assert.deepEqual(Object.keys(branded).sort(), ['creation_date_max', 'creation_date_min', 'fields', 'limit', 'page_url']);
  assert.equal(buildBrandedParams({ igUsername: 'abc', since: 'a', until: 'b' }).ig_username, 'abc');
});

test('lỗi Meta thành câu tiếng Việt: chưa xác minh danh tính, sai URL Page / Instagram', () => {
  const identity = adLibraryError({ error: { code: 10, error_subcode: 2332002, message: 'Application does not have permission for this action' } }, 400);
  assert.match(identity.message, /facebook\.com\/ID/);
  assert.equal(identity.graphCode, 10);
  assert.match(adLibraryError({ error: { code: 100, message: '(#100) Invalid Page URL.' } }, 400, 'branded_content_search').message, /liên kết Page/);
  assert.match(adLibraryError({ error: { code: 100, message: '(#100) Invalid Instagram account name.' } }, 400, 'branded_content_search').message, /Instagram/);
  assert.match(adLibraryError({ error: { code: 190, message: 'expired' } }, 400).message, /hết hạn/);
});

test('thêm đối thủ: cần Page / Instagram / từ khoá, không trùng', () => {
  const store = { competitors: [], ads: [], branded: [], insights: [] };
  assert.throws(() => addCompetitor(store, { name: 'A' }), /Cần Page/);
  assert.throws(() => addCompetitor(store, { name: 'A', page: 'không phải link' }), /Không đọc được Page/);
  const first = addCompetitor(store, { name: 'Granola ABC', page: 'https://www.facebook.com/granola.abc', ig: '@granola.abc', keywords: 'granola, ngũ cốc, granola' }, { now });
  assert.equal(first.pageUrl, 'https://www.facebook.com/granola.abc');
  assert.equal(first.igUsername, 'granola.abc');
  assert.deepEqual(first.keywords, ['granola', 'ngũ cốc']);
  assert.throws(() => addCompetitor(store, { name: 'Trùng', ig: 'granola.abc' }), /đã có/);
});

test('mẫu dán tay: kiểm liên kết, ngày, trùng ID', () => {
  const store = { competitors: [], ads: [], branded: [], insights: [] };
  const competitor = addCompetitor(store, { name: 'Hạt Xanh', keywords: 'hạt dinh dưỡng' });
  assert.throws(() => addManualAd(store, { competitorId: competitor.id, text: 'ngắn' }), /ít nhất 10/);
  assert.throws(() => addManualAd(store, { competitorId: competitor.id, text: 'Nội dung đủ dài rồi', link: 'https://google.com' }), /Thư viện/);
  assert.throws(() => addManualAd(store, { competitorId: competitor.id, text: 'Nội dung đủ dài rồi', startDate: '2026-12-01' }, { now }), /tương lai/);
  const ad = addManualAd(store, { competitorId: competitor.id, text: 'Granola ít đường, freeship toàn quốc, tặng 1 túi khi mua combo 3', link: 'https://www.facebook.com/ads/library/?id=998877665544', startDate: '2026-09-01' }, { now, by: 'Hằng' });
  assert.equal(ad.libraryId, '998877665544');
  assert.throws(() => addManualAd(store, { competitorId: competitor.id, text: 'Nội dung đủ dài rồi', link: 'facebook.com/ads/library/?id=998877665544' }), /đã có/);
  assert.equal(daysRunning(ad, now), 35);
  assert.deepEqual(detectOffers(ad.texts[0]).sort(), ['combo', 'freeship', 'gift', 'health']);
  removeCompetitor(store, competitor.id);
  assert.equal(store.ads.length, 0);
});

test('đọc ArchivedAd: không giữ ad_snapshot_url (chứa token), tính còn chạy', () => {
  const ad = parseArchivedAd({
    id: '555', page_id: '42', page_name: 'ABC', ad_delivery_start_time: '2026-09-01T00:00:00+0000',
    ad_creative_bodies: ['Giảm 20% hôm nay'], publisher_platforms: ['facebook', 'instagram'],
    ad_snapshot_url: 'https://www.facebook.com/ads/archive/render_ad/?id=555&access_token=BI-MAT'
  }, 'c1', now);
  assert.equal(JSON.stringify(ad).includes('BI-MAT'), false);
  assert.equal(ad.active, true);
  assert.deepEqual(ad.platforms, ['FACEBOOK', 'INSTAGRAM']);
  assert.equal(parseArchivedAd({ id: '1', ad_delivery_stop_time: '2026-09-10T00:00:00+0000' }, 'c1', now).active, false);
});

test('bài hợp tác: phân biệt đối thủ là người đăng hay nhãn hàng thuê creator', () => {
  const competitor = { id: 'c1', name: 'Granola ABC', pageUrl: 'https://www.facebook.com/granola.abc' };
  const hired = parseBrandedContent({ creation_date: '2026-09-20T10:00:00+0000', type: 'INSTAGRAM_REEL', url: 'https://www.instagram.com/reel/x', creator: { id: '9', name: 'Bếp Của Mây', url: 'https://www.instagram.com/bepcuamay' }, partners: [{ id: '1', name: 'Granola ABC' }] }, competitor, now);
  assert.equal(hired.role, 'partner');
  assert.equal(hired.date, '2026-09-20');
  const own = parseBrandedContent({ creation_date: '2026-09-21', type: 'FACEBOOK_POST', url: 'https://facebook.com/p/1', creator: { id: '1', name: 'Granola ABC' }, partners: [{ id: '7', name: 'Ví XYZ', url: 'javascript:alert(1)' }] }, competitor, now);
  assert.equal(own.role, 'creator');
  assert.equal(own.partners[0].url, '', 'không nhận liên kết javascript:');
});

test('lấy dữ liệu: Thư viện quảng cáo lỗi 2332002 nhưng KOL hợp tác vẫn cập nhật, mẫu dán tay giữ nguyên', async () => {
  const settings = config();
  await updateAdLibrary(store => {
    const competitor = addCompetitor(store, { name: 'Granola ABC', page: 'https://www.facebook.com/ads/library/?view_all_page_id=111222333', keywords: '' });
    store.competitors[0].pageUrl = 'https://www.facebook.com/granola.abc';
    addManualAd(store, { competitorId: competitor.id, text: 'Freeship toàn quốc cho đơn từ 2 túi' }, { now });
  }, settings.path);
  const { fetchImpl, calls } = fakeFetch(url => {
    if (url.pathname.endsWith('/ads_archive')) return json({ error: { code: 10, error_subcode: 2332002, message: 'Application does not have permission for this action' } }, 400);
    if (url.pathname.endsWith('/branded_content_search')) {
      assert.equal(url.searchParams.get('page_url'), 'https://www.facebook.com/granola.abc');
      assert.equal(url.searchParams.get('creation_date_max'), '2026-10-05');
      return json({ data: [{ creation_date: '2026-09-30T00:00:00+0000', type: 'INSTAGRAM_REEL', url: 'https://www.instagram.com/reel/1', creator: { id: '9', name: 'Bếp Của Mây' }, partners: [{ id: '1', name: 'Granola ABC' }] }] });
    }
    throw new Error(`lạ: ${url}`);
  });
  const summary = await syncCompetitors({ config: settings, fetchImpl, now });
  assert.match(summary.ads.error, /2332002/);
  assert.equal(summary.branded.found, 1);
  assert.equal(calls.every(url => url.searchParams.get('access_token') === 'token-thu'), true);
  const store = await readAdLibrary(settings.path);
  assert.equal(store.ads.length, 1, 'mẫu dán tay còn nguyên');
  assert.equal(store.branded[0].creator.name, 'Bếp Của Mây');
  const view = adLibraryView(store, { config: settings, now });
  assert.equal(view.competitors[0].branded, 1);
  assert.match(view.competitors[0].webUrl, /view_all_page_id=111222333/);
});

test('lấy dữ liệu: quảng cáo API thay bản dán tay trùng ID, lỗi tham số của một đối thủ không chặn đối thủ khác', async () => {
  const settings = config();
  await updateAdLibrary(store => {
    const a = addCompetitor(store, { name: 'A', page: '111222333' });
    addCompetitor(store, { name: 'B', ig: '@sai.ten' });
    addManualAd(store, { competitorId: a.id, text: 'Bản dán tay của quảng cáo 777', link: 'facebook.com/ads/library/?id=777777' }, { now });
  }, settings.path);
  const { fetchImpl } = fakeFetch(url => {
    if (url.pathname.endsWith('/ads_archive')) {
      return json({ data: [{ id: '777777', page_id: '111222333', page_name: 'A', ad_delivery_start_time: '2026-09-01', ad_creative_bodies: ['Combo 3 túi giá 299k'] }] });
    }
    return json({ error: { code: 100, message: '(#100) Invalid Instagram account name.' } }, 400);
  });
  const summary = await syncCompetitors({ config: settings, fetchImpl, now });
  assert.equal(summary.ads.found, 1);
  assert.equal(summary.branded.found, 0);
  assert.match(summary.branded.warnings[0], /^B: .*Instagram/);
  const store = await readAdLibrary(settings.path);
  assert.deepEqual(store.ads.map(ad => ad.source), ['api']);
});

test('chưa có token hoặc chưa có đối thủ: báo rõ, không gọi Meta', async () => {
  await assert.rejects(syncCompetitors({ config: config({ accessToken: '' }), fetchImpl: () => assert.fail('không được gọi'), now }), /META_AD_LIBRARY_TOKEN/);
  await assert.rejects(syncCompetitors({ config: config(), fetchImpl: () => assert.fail('không được gọi'), now }), /Chưa có đối thủ/);
});

function sampleStore() {
  const store = { competitors: [], ads: [], branded: [], insights: [] };
  const a = addCompetitor(store, { name: 'A', keywords: 'granola' });
  const b = addCompetitor(store, { name: 'B', keywords: 'hạt' });
  addManualAd(store, { competitorId: a.id, text: 'Freeship mọi đơn, granola ít đường', startDate: '2026-08-01' }, { now });
  addManualAd(store, { competitorId: b.id, text: 'Miễn phí vận chuyển + tặng muỗng gỗ', startDate: '2026-09-28' }, { now });
  store.branded.push(
    { key: 'b:1', competitorId: a.id, date: '2026-09-01', type: 'INSTAGRAM_REEL', role: 'partner', creator: { id: '9', name: 'Bếp Của Mây' }, partners: [] },
    { key: 'b:2', competitorId: b.id, date: '2026-09-15', type: 'FACEBOOK_POST', role: 'partner', creator: { id: '9', name: 'Bếp Của Mây' }, partners: [] }
  );
  return store;
}

test('tín hiệu thị trường + gợi ý theo luật: ưu đãi chung, quảng cáo chạy lâu, creator chung', () => {
  const signals = marketSignals(sampleStore(), now);
  assert.equal(signals.commonOffers[0].key, 'freeship');
  assert.equal(signals.commonOffers[0].competitors, 2);
  assert.equal(signals.longRunning.length, 1, 'chỉ quảng cáo chạy ≥ 14 ngày');
  assert.equal(signals.longRunning[0].days, 66);
  assert.deepEqual(signals.topCreators[0].competitors.sort(), ['A', 'B']);
  const ideas = ruleMarketIdeas(signals);
  assert.deepEqual([...new Set(ideas.map(idea => idea.kind))].sort(), ['audience', 'creative', 'offer']);
  assert.equal(ruleMarketIdeas(marketSignals({}, now))[0].kind, 'research');
  assert.ok(marketBrief(sampleStore(), now).uuDaiPhoBien[0].startsWith('Miễn phí vận chuyển'));
  assert.equal(marketBrief({}, now), null);
});

test('AI gợi ý: kiểm campaignId và tên đối thủ, lỗi mô hình thì dùng luật', async () => {
  const report = { range: { since: '2026-09-29', until: '2026-10-05' }, totals: { spend: 1000000, orders: 5 }, campaigns: [{ id: '120000', name: 'Granola chuyển đổi', source: 'meta', spend: 1000000, orders: 5 }] };
  const prompt = buildMarketPrompt(sampleStore(), report, { now });
  assert.match(prompt, /Bếp Của Mây/);
  assert.match(prompt, /"campaignId":"120000"/);
  const checked = validateMarketAnswer({ summary: 'ok', ideas: [
    { kind: 'offer', title: 'Thử freeship', detail: 'Nhóm QC nhỏ', competitors: ['A', 'Bịa'], campaignId: '120000' },
    { kind: 'lạ', title: 'X', detail: 'Y', campaignId: '999' },
    { kind: 'test', title: '', detail: 'thiếu tiêu đề' }
  ] }, report, sampleStore());
  assert.equal(checked.ideas.length, 2);
  assert.deepEqual(checked.ideas[0].competitors, ['A']);
  assert.equal(checked.ideas[0].campaignName, 'Granola chuyển đổi');
  assert.equal(checked.ideas[1].kind, 'creative');
  assert.equal(checked.ideas[1].campaignId, undefined);

  const filePath = storePath();
  const store = sampleStore();
  const ai = await generateMarketInsights(report, { store, filePath, now, settings: {}, callModel: async () => ({ text: '{"summary":"Đối thủ đều freeship","ideas":[{"kind":"offer","title":"Freeship 2 túi","detail":"Thử 5 ngày","competitors":["A"]}]}', model: 'gemini-test' }) });
  assert.equal(ai.source, 'ai');
  assert.equal((await readAdLibrary(filePath)).insights[0].summary, 'Đối thủ đều freeship');
  const fallback = await generateMarketInsights(report, { store, filePath, now, persist: false, settings: {}, callModel: async () => { throw new Error('429'); } });
  assert.equal(fallback.source, 'rules');
  assert.ok(fallback.ideas.length);
});
