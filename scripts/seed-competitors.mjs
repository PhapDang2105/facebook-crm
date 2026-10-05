// Nạp danh sách đối thủ (và mẫu quảng cáo chép từ Thư viện quảng cáo web) vào kho Theo dõi đối thủ.
//
//   node scripts/seed-competitors.mjs <tệp.json> [--dry-run]
//
// Tệp JSON: { "competitors": [ { "name", "page", "ig", "keywords", "note", "ads": [ { "text", "link", "startDate", "note" } ] } ] }
// Chạy lại không nhân đôi: đối thủ đã có (trùng Page / Instagram / tên) thì chỉ thêm mẫu chưa có (so nội dung).
// Kho này không có bộ nhớ đệm trong tiến trình CRM nên không cần dừng dịch vụ.
import { readFile } from 'node:fs/promises';
import { addCompetitor, addManualAd, normalizeCompetitorInput, readAdLibrary, updateAdLibrary } from '../app/ad-library.mjs';

const [file, flag] = process.argv.slice(2);
if (!file) {
  console.error('Cách dùng: node scripts/seed-competitors.mjs <tệp.json> [--dry-run]');
  process.exit(1);
}
const dryRun = flag === '--dry-run';
const input = JSON.parse(await readFile(file, 'utf8'));
const items = Array.isArray(input.competitors) ? input.competitors : [];

function findExisting(store, value) {
  return store.competitors.find(item => (value.pageId && item.pageId === value.pageId)
    || (value.pageUrl && item.pageUrl?.toLowerCase() === value.pageUrl.toLowerCase())
    || (value.igUsername && item.igUsername === value.igUsername)
    || item.name.toLowerCase() === value.name.toLowerCase());
}

const apply = store => {
  const report = [];
  for (const item of items) {
    const value = normalizeCompetitorInput(item);
    let competitor = findExisting(store, value);
    const created = !competitor;
    if (!competitor) competitor = addCompetitor(store, item, { by: 'seed' });
    let added = 0;
    for (const ad of Array.isArray(item.ads) ? item.ads : []) {
      const text = String(ad.text || '').trim();
      if (store.ads.some(existing => existing.competitorId === competitor.id && existing.texts?.[0] === text)) continue;
      addManualAd(store, { ...ad, competitorId: competitor.id }, { by: 'seed' });
      added += 1;
    }
    report.push(`${created ? '+' : '='} ${competitor.name}: ${added} mẫu mới`);
  }
  return report;
};

const report = dryRun ? apply(structuredClone(await readAdLibrary())) : await updateAdLibrary(apply);
console.log(report.join('\n'));
console.log(dryRun ? '(chạy thử, chưa ghi)' : 'Đã ghi kho Theo dõi đối thủ.');
