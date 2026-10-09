import { posConfig } from '../app/phone-warnings.mjs';

const cfg = posConfig();
const url = `${cfg.baseUrl.replace(/\/+$/, '')}/shops/${cfg.shopId}/variations?api_key=${cfg.apiKey}&page_size=100`;

console.log('Fetching POS variations from:', cfg.baseUrl, 'shopId:', cfg.shopId);
const res = await fetch(url);
const data = await res.json();
const items = data.data || [];
console.log(`Total variations retrieved: ${items.length}`);
const qtl = items.find(v => v.display_id === 'QUA-TANG-LIVE');
console.log('QUA-TANG-LIVE detail:', JSON.stringify(qtl, null, 2));

const quat = items.filter(v => /quat/i.test(v.display_id || '') || /quat/i.test(v.name || ''));
console.log('Variations matching "quat":', JSON.stringify(quat, null, 2));
