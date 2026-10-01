// Thay dns.promises.lookup bằng bản giả trả một IP công khai: app/network-guard.mjs
// (assertPublicHost) tra DNS thật cho endpoint AI tuỳ chỉnh, nên test đi qua đường đó
// đỏ/xanh theo mạng của máy chạy (mất mạng, DNS chậm, sandbox chặn). network-guard
// import { lookup } từ 'node:dns/promises' — binding sống, syncBuiltinESMExports()
// đẩy giá trị mới sang mọi module ESM đã import.
import dnsPromises from 'node:dns/promises';
import { syncBuiltinESMExports } from 'node:module';

/** Cài lookup giả (mặc định mọi tên → 93.184.216.34); trả hàm khôi phục bản thật. */
export function installFakeDns(resolveHost = () => '93.184.216.34') {
  const original = dnsPromises.lookup;
  dnsPromises.lookup = async (hostname, options = {}) => {
    const address = resolveHost(hostname);
    const entry = { address, family: address.includes(':') ? 6 : 4 };
    return options.all ? [entry] : entry;
  };
  syncBuiltinESMExports();
  return () => {
    dnsPromises.lookup = original;
    syncBuiltinESMExports();
  };
}
