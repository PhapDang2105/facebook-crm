// Chốt chặn máy chủ tự gọi ra ngoài (SSRF): endpoint AI do nhân viên nhập và
// ảnh ngoài mà bot/nhân viên gửi khách đều được máy chủ tải hộ, nên đích đến
// không được là mạng nội bộ (127.x, 10.x, metadata 169.254.169.254, …) — kể cả
// khi một tên miền công khai trỏ về đó. Kiểm cả tên lẫn địa chỉ DNS thật.
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

/** Địa chỉ IPv4/IPv6 thuộc mạng nội bộ, loopback, link-local hay chưa cấp phát. */
export function isPrivateAddress(address) {
  const text = String(address || '').trim().toLowerCase();
  const version = isIP(text);
  if (version === 4) {
    const [a, b] = text.split('.').map(Number);
    return a === 0 || a === 10 || a === 127
      || (a === 100 && b >= 64 && b <= 127)
      || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168)
      || a >= 224;
  }
  if (version === 6) {
    if (text === '::' || text === '::1') return true;
    if (text.startsWith('::ffff:')) return isPrivateAddress(text.slice(7));
    return /^(fc|fd|fe[89ab])/.test(text) || text.startsWith('ff');
  }
  return true;
}

/** Tên máy nói thẳng là nội bộ (không cần tra DNS). */
export function isInternalHost(host) {
  const text = String(host || '').toLowerCase();
  if (['localhost', '[::1]', '0.0.0.0'].includes(text)) return true;
  if (/(^|\.)(localhost|internal|local|home\.arpa)$/.test(text)) return true;
  if (/^\[/.test(text)) return isPrivateAddress(text.slice(1, -1));
  return isIP(text) ? isPrivateAddress(text) : false;
}

/**
 * Tra DNS và ném lỗi nếu bất kỳ địa chỉ nào của tên máy là nội bộ (chặn cả
 * tên miền công khai trỏ về 127.0.0.1 hay dịch vụ metadata của VM).
 */
export async function assertPublicHost(hostname, { lookupImpl = lookup, resolve = true } = {}) {
  const host = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (!host || isInternalHost(host)) throw new Error('Địa chỉ trỏ vào mạng nội bộ nên bị từ chối.');
  // resolve=false: chỉ kiểm theo tên (mạng giả lập trong kiểm thử không có DNS).
  if (!resolve) return host;
  let addresses;
  try {
    addresses = isIP(host) ? [{ address: host }] : await lookupImpl(host, { all: true });
  } catch {
    throw new Error(`Không phân giải được tên máy ${host}.`);
  }
  if (!addresses.length || addresses.some(item => isPrivateAddress(item.address))) {
    throw new Error('Địa chỉ trỏ vào mạng nội bộ nên bị từ chối.');
  }
  return host;
}
