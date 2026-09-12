import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { projectRoot } from '../config.mjs';

// The n8n workflow read this table from a Google Sheet and fell back to a copy
// baked into the node. That sheet now answers 410 Gone, so the table lives here
// instead: one file, no external dependency, editable from the CRM itself.
const priceMasterPath = process.env.PRICE_MASTER_PATH
  || path.join(projectRoot, 'data', 'processed', 'price-master.json');
const seedPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'price-master.seed.json');

let cache = null;

function normalizeRow(row) {
  const orderKey = String(row?.order_key ?? '').trim();
  const finalPrice = Math.max(0, Math.round(Number(row?.final_price) || 0));
  if (!orderKey || !finalPrice) return null;
  return {
    order_key: orderKey,
    final_price: finalPrice,
    gift: String(row?.gift ?? '').trim(),
    active: row?.active !== false && String(row?.active).toUpperCase() !== 'FALSE'
  };
}

function normalizeTable(value) {
  const rows = Array.isArray(value?.rows) ? value.rows : Array.isArray(value) ? value : [];
  const byKey = new Map();
  for (const row of rows) {
    const normalized = normalizeRow(row);
    if (normalized) byKey.set(normalized.order_key, normalized);
  }
  return { updatedAt: Number(value?.updatedAt) || 0, rows: [...byKey.values()] };
}

function readSeed() {
  try {
    return normalizeTable(JSON.parse(readFileSync(seedPath, 'utf8')));
  } catch {
    return { updatedAt: 0, rows: [] };
  }
}

/**
 * The table is read once and kept in memory. Pricing runs inside the reply
 * pipeline on every inbound message, so it must not wait on disk each time.
 */
export function getPriceMaster() {
  if (!cache) {
    try {
      cache = normalizeTable(JSON.parse(readFileSync(priceMasterPath, 'utf8')));
      if (!cache.rows.length) cache = readSeed();
    } catch {
      cache = readSeed();
    }
  }
  return cache.rows;
}

/** Looks up one basket key. Returns null when the key is absent or disabled. */
export function findPrice(orderKey) {
  const key = String(orderKey || '').trim();
  if (!key) return null;
  return getPriceMaster().find(row => row.order_key === key && row.active) || null;
}

export function reloadPriceMaster() {
  cache = null;
  return getPriceMaster();
}

export async function writePriceMaster(value) {
  const table = normalizeTable(value);
  table.updatedAt = Date.now();
  await mkdir(path.dirname(priceMasterPath), { recursive: true });
  const temporaryPath = `${priceMasterPath}.tmp`;
  await writeFile(temporaryPath, JSON.stringify(table, null, 2), 'utf8');
  await rename(temporaryPath, priceMasterPath);
  cache = table;
  return table;
}

/** Creates the editable copy from the seed the first time the server boots. */
export async function ensurePriceMaster() {
  try {
    await readFile(priceMasterPath, 'utf8');
  } catch {
    await writePriceMaster(readSeed());
  }
  return getPriceMaster();
}
