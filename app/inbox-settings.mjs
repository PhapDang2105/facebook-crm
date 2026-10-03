// Cài đặt → Tin nhắn: the labels staff pin on a conversation and the quick
// replies they pick from the composer. Both are plain lists staff edit on
// screen — nothing here is hard-coded into the inbox, so renaming a label or
// changing a reply never needs a deploy.
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { projectRoot } from './config.mjs';
import { createWriteQueue, readJsonFile, writeJsonAtomic } from './json-store.mjs';
import { autoLabelEvents } from './processing/auto-label.mjs';

const inboxSettingsPath = process.env.INBOX_SETTINGS_PATH
  || path.join(projectRoot, 'data', 'processed', 'inbox-settings.json');

// The Pancake set the team already works with. `auto` is what the bot watches
// for: it tags the thread when an order is placed, when it hands the thread to
// a person, or when the customer complains. No "new" label: the inbox already
// shows unread and first-contact.
export const defaultConversationLabels = Object.freeze([
  { id: 'consulting', name: 'Cần người xử lý', color: '#8f7ad0', icon: 'person-raising-hand', auto: 'handoff' },
  { id: 'warranty', name: 'Bảo hành', color: '#d9866f', icon: 'hammer-and-wrench', auto: 'warranty' },
  { id: 'complaint', name: 'Khiếu nại', color: '#c85f5b', icon: 'warning', auto: 'complaint' },
  { id: 'customer', name: 'Đã mua hàng', color: '#5fa871', icon: 'shopping-bags', auto: 'order' },
  { id: 'exchange', name: 'Đổi sản phẩm', color: '#3b82f6', icon: 'handshake', auto: 'update' },
  { id: 'cancelled', name: 'Hủy đơn', color: '#9ca3af', icon: 'no-entry', auto: 'cancel' },
  { id: 'livestream', name: 'Livestream', color: '#c26a9a', icon: 'video-camera', auto: 'livestream' },
  { id: 'wholesale', name: 'Khách sỉ', color: '#c79a2c', icon: 'package', auto: 'wholesale' },
  { id: 'bad', name: 'Khách xấu', color: '#6b7280', icon: 'prohibited', auto: 'bad' },
  // Hệ thống đã gửi tin bám đuổi cho khách (lọc để kiểm tra tin nào đã đi, khách nào đã quay lại).
  { id: 'followup', name: 'Bám đuổi', color: '#0ea5e9', icon: 'alarm-clock', auto: 'followup' },
  // Khách đã nhận tin bám đuổi rồi chốt đơn (bot, nhân viên hay Facebook Shop) trong 14 ngày.
  { id: 'followup-won', name: 'Bám đuổi thành công', color: '#16a34a', icon: 'trophy', auto: 'followup-won' },
  // Khách ghi số điện thoại trong tin nhắn hay bình luận (02/10).
  { id: 'phone', name: 'Số điện thoại', color: '#0d9488', icon: 'telephone-receiver', auto: 'phone' },
  // Vận đơn Sapo (03/10): đã gửi mã/hành trình vận đơn cho khách; vận đơn giao thành công.
  { id: 'shipment-sent', name: 'Đã gửi mã vận đơn', color: '#f97316', icon: 'pickup-truck', auto: 'shipment-sent' },
  { id: 'delivered', name: 'Giao hàng thành công', color: '#22c55e', icon: 'check-mark-button', auto: 'delivered' },
  { id: 'jt', name: 'Giao J&T', color: '#b0714b', icon: 'delivery-truck', auto: '' }
]);

/**
 * Thẻ mặc định mới (Đổi sản phẩm, Hủy đơn) và sự kiện tự động mới (bảo hành,
 * live, sỉ, khách xấu) được bổ sung vào bộ thẻ nhân viên đang dùng: thẻ chưa có
 * thì thêm vào cuối, thẻ có sẵn mà chưa gắn sự kiện nào thì gắn sự kiện mặc
 * định (không đè lựa chọn nhân viên đã đặt).
 */
export function mergeDefaultLabels(labels, removedDefaults = []) {
  const list = (Array.isArray(labels) ? labels : []).map(label => ({ ...label }));
  const usedEvents = new Set(list.map(label => label.auto).filter(Boolean));
  // R13 (T-2): thẻ mặc định nhân viên ĐÃ XOÁ ở Cài đặt → Tin nhắn (ghi ở `removedDefaults`) không tự thêm lại.
  // Thẻ mặc định MỚI của một bản phát hành (chưa từng có, chưa từng xoá) vẫn được bổ sung như cũ.
  const removed = new Set(Array.isArray(removedDefaults) ? removedDefaults : []);
  for (const preset of defaultConversationLabels) {
    const existing = list.find(label => label.id === preset.id);
    if (!existing) {
      if (removed.has(preset.id)) continue;
      if (preset.auto && usedEvents.has(preset.auto)) continue;
      list.push({ ...preset });
      if (preset.auto) usedEvents.add(preset.auto);
    } else if (!existing.auto && preset.auto && !usedEvents.has(preset.auto)) {
      existing.auto = preset.auto;
      usedEvents.add(preset.auto);
    }
  }
  return list;
}

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
  const defaultIds = new Set(defaultConversationLabels.map(label => label.id));
  // Chỉ giữ mã thẻ mặc định thật và chưa có lại trong danh sách; bộ thẻ trống = về bộ mặc định đầy đủ.
  const removedDefaults = labels.length
    ? [...new Set((Array.isArray(value.removedDefaults) ? value.removedDefaults : []).map(id => String(id)))]
      .filter(id => defaultIds.has(id) && !labels.some(label => label.id === id))
    : [];
  return {
    labels: labels.length ? mergeDefaultLabels(labels, removedDefaults) : [...defaultConversationLabels],
    quickReplies: await normalizeQuickReplies(value.quickReplies, storeImage),
    ...(removedDefaults.length ? { removedDefaults } : {}),
    updatedAt: Number(value.updatedAt) || Date.now()
  };
}

/**
 * R13 (T-2): thẻ mặc định bị xoá ở lần lưu này = thẻ mặc định ĐANG có trong bộ đã lưu mà bộ gửi lên không còn;
 * cộng các thẻ đã xoá từ trước (trừ thẻ vừa được thêm lại). Trước đây xoá thẻ mặc định xong lưu là thẻ tự sống lại.
 */
export function removedDefaultLabelIds(previous = {}, submittedLabels = []) {
  const submitted = new Set(normalizeConversationLabels(submittedLabels).map(label => label.id));
  if (!submitted.size) return [];
  const before = new Set((Array.isArray(previous?.labels) ? previous.labels : []).map(label => label?.id));
  const removed = new Set(Array.isArray(previous?.removedDefaults) ? previous.removedDefaults : []);
  for (const preset of defaultConversationLabels) {
    if (submitted.has(preset.id)) removed.delete(preset.id);
    else if (before.has(preset.id)) removed.add(preset.id);
  }
  return [...removed];
}

let cached = null;

/**
 * Chưa có tệp → bộ mặc định. Tệp hỏng → cất `.corrupt-*` rồi bộ mặc định. Lỗi đọc khác
 * (EBUSY, EACCES…) → ném và KHÔNG nhớ bộ mặc định: trước đây bộ mặc định được nhớ lại và lần
 * lưu kế tiếp từ màn Cài đặt đè mất bộ thẻ/tin trả lời nhanh thật.
 */
export async function readInboxSettings() {
  if (cached) return cached;
  const stored = await readJsonFile(inboxSettingsPath, { fallback: () => defaultInboxSettings, label: 'Cài đặt tin nhắn (inbox-settings.json)' });
  cached = await normalizeInboxSettings(stored);
  return cached;
}

const enqueueWrite = createWriteQueue();
export function writeInboxSettings(value, storeImage) {
  // Ghi tuần tự, tệp tạm riêng: hai lần lưu gần nhau không đè cùng một .tmp.
  return enqueueWrite(async () => {
    // Nơi gọi chỉ gửi { labels, quickReplies }: thẻ mặc định bị xoá suy từ bộ đang lưu (đọc lỗi thì coi như chưa xoá gì).
    const previous = await readInboxSettings().catch(() => null);
    const removedDefaults = Array.isArray(value?.removedDefaults) ? value.removedDefaults : removedDefaultLabelIds(previous || {}, value?.labels);
    const settings = await normalizeInboxSettings({ ...value, removedDefaults, updatedAt: Date.now() }, storeImage);
    await writeJsonAtomic(inboxSettingsPath, settings);
    cached = settings;
    return settings;
  });
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

