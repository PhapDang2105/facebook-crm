import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Import this module BEFORE anything under app/: messaging-store reads
// META_CONVERSATIONS_PATH once when it loads, so the redirect has to happen
// first. `seed` then writes whatever a test needs into that throwaway file.
const directory = mkdtempSync(path.join(os.tmpdir(), 'crm-messaging-test-'));
export const storePath = path.join(directory, 'conversations.json');
process.env.META_CONVERSATIONS_PATH = storePath;
writeFileSync(storePath, JSON.stringify({ conversations: [], messages: {} }));
process.on('exit', () => rmSync(directory, { recursive: true, force: true }));

export function seed(store) {
  writeFileSync(storePath, JSON.stringify({ messages: {}, ...store }));
}
