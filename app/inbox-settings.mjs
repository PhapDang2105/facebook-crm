// Cài đặt → Tin nhắn: the labels staff pin on a conversation and the quick
// replies they pick from the composer. Both are plain lists staff edit on
// screen — nothing here is hard-coded into the inbox, so renaming a label or
// changing a reply never needs a deploy.
import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { projectRoot } from './config.mjs';
import { autoLabelEvents } from './processing/auto-label.mjs';

const inboxSettingsPath = process.env.INBOX_SETTINGS_PATH
  || path.join(projectRoot, 'data', 'processed', 'inbox-settings.json');

// The Pancake set the team already works with. `auto` is what the bot watches
// for: it tags the thread when an order is placed, when it hands the thread to
// a person, or when the customer complains. No "new" label: the inbox already
// shows unread and first-contact.
export const defaultConversationLabels = Object.freeze([
  { id: 'consulting', name: 'Cần người xử lý', color: '#8f7ad0', icon: 'person-raising-hand', auto: 'handoff' },
  { id: 'warranty', name: 'Bảo hành', color: '#d9866f', icon: 'hammer-and-wrench', auto: '' },
  { id: 'complaint', name: 'Khiếu nại', color: '#c85f5b', icon: 'warning', auto: 'complaint' },
  { id: 'customer', name: 'Đã mua hàng', color: '#5fa871', icon: 'shopping-bags', auto: 'order' },
  { id: 'livestream', name: 'Livestream', color: '#c26a9a', icon: 'video-camera', auto: '' },
  { id: 'wholesale', name: 'Khách sỉ', color: '#c79a2c', icon: 'package', auto: '' },
  { id: 'bad', name: 'Khách xấu', color: '#6b7280', icon: 'prohibited', auto: '' },
  { id: 'jt', name: 'Giao J&T', color: '#b0714b', icon: 'delivery-truck', auto: '' }
]);

export const defaultInboxSettings = Object.freeze({
  labels: defaultConversationLabels,
  quickReplies: []
});

const maximumLabels = 40;
const maximumQuickReplies = 300;
const maximumQuickReplyImages = 6;

/** Stable id from a Vietnamese name: `Giao J&T` → `giao-jt`. */
export function labelSlug(value) {
  return String(value || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd').replace(/Đ/g, 'D')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}

function cleanColor(value, fallback) {
  const text = String(value || '').trim().toLowerCase();
  return /^#[0-9a-f]{6}$/.test(text) ? text : fallback;
}

export function normalizeConversationLabels(value) {
  const list = Array.isArray(value) ? value : [];
  const seen = new Set();
  const used = new Set();
  const labels = [];
  for (const item of list) {
    const name = String(item?.name || '').trim().slice(0, 40);
    if (!name) continue;
    let id = labelSlug(item?.id) || labelSlug(name) || `the-${labels.length + 1}`;
    while (seen.has(id)) id = `${id}-2`;
    seen.add(id);
    const icon = String(item?.icon || '').trim().toLowerCase();
    const auto = String(item?.auto || '').trim();
    labels.push({
      id,
      name,
      color: cleanColor(item?.color, '#6b7280'),
      icon: /^[a-z0-9-]{1,40}$/.test(icon) ? icon : '',
      // Mỗi sự kiện chỉ gắn cho một thẻ: thẻ đầu tiên giữ, thẻ sau bỏ trống.
      auto: autoLabelEvents.includes(auto) && !used.has(auto) ? (used.add(auto), auto) : ''
    });
    if (labels.length >= maximumLabels) break;
  }
  return labels;
}

function cleanShortcut(value) {
  return String(value || '').trim().replace(/^\/+/, '').replace(/\s+/g, '').slice(0, 40);
}

/**
 * Quick reply images arrive as either stored paths (`/product-images/…`) or
 * fresh uploads (`data:` URLs); `storeImage` turns an upload into a path.
 */
export async function normalizeQuickReplies(value, storeImage = async () => '') {
  const list = Array.isArray(value) ? value : [];
  const seen = new Set();
  const replies = [];
  for (const item of list) {
    const shortcut = cleanShortcut(item?.shortcut);
    const text = String(item?.text || '').trim().slice(0, 4000);
    if (!shortcut && !text) continue;
    const id = String(item?.id || '').trim().replace(/[^A-Za-z0-9-]/g, '').slice(0, 40) || `qr-${Date.now().toString(36)}-${replies.length}`;
    if (seen.has(id)) continue;
    seen.add(id);
    const images = [];
    for (const image of Array.isArray(item?.images) ? item.images : []) {
      const source = typeof image === 'string' ? image : String(image?.dataUrl || image?.url || '');
      if (!source) continue;
      const stored = source.startsWith('data:') ? await storeImage(source, `quick-${id}`) : source;
      if (/^\/product-images\/[A-Za-z0-9-]+\.(?:png|jpg|webp)$/.test(stored)) images.push(stored);
      if (images.length >= maximumQuickReplyImages) break;
    }
    if (!text && !images.length) continue;
    replies.push({ id, shortcut, text, images });
    if (replies.length >= maximumQuickReplies) break;
  }
  return replies;
}

export async function normalizeInboxSettings(value = {}, storeImage) {
  const labels = normalizeConversationLabels(value.labels);
  return {
    labels: labels.length ? labels : [...defaultConversationLabels],
    quickReplies: await normalizeQuickReplies(value.quickReplies, storeImage),
    updatedAt: Number(value.updatedAt) || Date.now()
  };
}

let cached = null;

export async function readInboxSettings() {
  if (cached) return cached;
  try {
    cached = await normalizeInboxSettings(JSON.parse(await readFile(inboxSettingsPath, 'utf8')));
  } catch {
    cached = await normalizeInboxSettings(defaultInboxSettings);
  }
  return cached;
}

export async function writeInboxSettings(value, storeImage) {
  const settings = await normalizeInboxSettings({ ...value, updatedAt: Date.now() }, storeImage);
  await mkdir(path.dirname(inboxSettingsPath), { recursive: true });
  const temporaryPath = `${inboxSettingsPath}.tmp`;
  await writeFile(temporaryPath, JSON.stringify(settings, null, 2), 'utf8');
  await rename(temporaryPath, inboxSettingsPath);
  cached = settings;
  return settings;
}

const labelIconsPath = path.join(projectRoot, 'web', 'assets', 'icons', 'labels');

/** Icons staff can put on a label: the Fluent Emoji files shipped under web/assets/icons/labels. */
export async function listLabelIcons() {
  try {
    return (await readdir(labelIconsPath)).filter(name => name.endsWith('.svg')).map(name => name.slice(0, -4)).sort();
  } catch {
    return [];
  }
}

/**
 * Thẻ nào được gắn cho các sự kiện bot báo về (order / handoff / complaint).
 * Không thẻ nào nhận sự kiện thì đơn giản là không gắn gì — nhân viên đã tự
 * bỏ tự động cho việc đó.
 */
export function labelsForEvents(labels, events = []) {
  const byEvent = new Map((labels || []).filter(label => label.auto).map(label => [label.auto, label.id]));
  return [...new Set(events.map(event => byEvent.get(event)).filter(Boolean))];
}

/** Name and colour for a label id, so the customer list can show what staff chose. */
export function labelLookup(labels) {
  return new Map((labels || []).map(label => [label.id, label]));
}
