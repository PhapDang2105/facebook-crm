import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Import this module BEFORE anything under app/: it points the catalogue at a
// throwaway copy of the seed files, so tests never read or touch
// data/processed and edits made in one test never leak into another.
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const directory = mkdtempSync(path.join(os.tmpdir(), 'crm-catalog-test-'));
process.env.PRODUCTS_PATH = path.join(directory, 'products.json');
process.env.GIFTS_PATH = path.join(directory, 'gifts.json');
writeFileSync(process.env.PRODUCTS_PATH, readFileSync(path.join(projectRoot, 'app', 'products.seed.json')));
writeFileSync(process.env.GIFTS_PATH, readFileSync(path.join(projectRoot, 'app', 'gifts.seed.json')));
process.on('exit', () => rmSync(directory, { recursive: true, force: true }));
