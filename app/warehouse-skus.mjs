// Bảng SKU chuẩn của kho (chủ shop gửi 14/10/2026, hai ảnh "Mã SKU"). File xuất kho chỉ nên có các mã này:
// mã khác (combo CRM "CB10-…", mã chung POS "QUA-TANG-LIVE"…) phải đổi về mã chuẩn trước khi xuất,
// còn sót thì màn Xuất dữ liệu cảnh báo. Kho thêm mã mới thì thêm vào đây.
export const STANDARD_WAREHOUSE_SKUS = Object.freeze(new Set([
  'SH-NB-H420', 'GRA-XANH-Z450', 'GRA-VANG-Z450', 'GRA-VANG-H350', 'GRA-NAU-Z350', 'GRA-CAM-H250', 'GRA-MINT-Z300',
  'SH-NB-PRE-H420', 'SH-SO-PRE-H420', '55-NB-PRE-H420', '100-NB-PRE-H420', 'GRA-XANH-G35', 'GRA-NAU-G35', 'GRA-CAM-G30',
  'MIX5-H420', 'NGHE-H350', 'NGHE-G25', 'TAM-LANH-G25', 'TAM-LANH-H350',
  'DRM-H420', 'DRM-VUA-H420', 'DRM-XH-H250', 'DRM-Z440', 'DRM-ZX420', 'DRM-Z225', 'DRM-HG180',
  'MCA-H420', 'MCA-Z440', 'MCA-ZX420', 'MCA-Z225', 'MCN-NGUYEN-H420', 'MCN-NGUYEN-H200', 'MCN-VO-H420', 'MCN-VO-H200', 'MCA-HG180',
  'HNS-Z440', 'HNS-Z225', 'HNS-H420', 'HDS-H420', 'HDS-Z440', 'HDS-Z225', 'HDC-H420', 'HDC-Z440', 'HDC-Z225',
  'BCC-H450', 'BCC-H160', 'BCC-Z100', 'BCC-Z200', 'BCC-Z500', 'HBX-H420', 'OCV-H320', 'OCD-H320', 'TD-Z440', 'TD-Z150',
  'DSG-H250', 'TGL-G15', 'TGL-H450', 'BRAGG-473', 'BGD', 'MUONG', 'QUAT', 'HU-300ML', 'TKQ-G20', 'THK-G20', 'TGDN-G25', 'QUA-4TRA-G3',
  'HECTOR-THAO-MOC-25ML', 'HECTOR-BASIC-HOP-250ML', 'HECTOR-THAO-MOC-HOP-250ML',
  'HT-HN-Z440', 'HT-HDV-Z440', 'HT-BX-Z440', 'HT-OCV-Z440', 'HT-OCD-Z440', 'HT-YM-Z440', 'HT-YM-T500', 'CB2-HT-YM-T500', 'CB4-HT-YM-T500',
  'YM-VO-T500', 'CHILE-DET-T500', 'CHILE-VO-T500', 'HT-DG-Z440', 'HT-HC-H480', 'CHIA-Z500', 'CHIA-H220', 'CHIA-G100', 'CHIA-G10'
]));

export function isStandardWarehouseSku(sku) {
  return STANDARD_WAREHOUSE_SKUS.has(String(sku || '').trim().toUpperCase());
}

/**
 * Combo CRM không có trong bảng chuẩn ("CB10-XANH-G35" = 10 gói) → { sku: mã chuẩn của một gói, units: 10 }:
 * mã chuẩn duy nhất bằng hoặc kết thúc bằng "-XANH-G35". Không phải combo / đã là mã chuẩn / không ra
 * đúng một mã → null.
 */
export function standardComboParts(sku) {
  const code = String(sku || '').trim().toUpperCase();
  if (isStandardWarehouseSku(code)) return null;
  const match = code.match(/^CB(\d+)-(.+)$/);
  if (!match || Number(match[1]) < 2) return null;
  const candidates = [...STANDARD_WAREHOUSE_SKUS].filter(item => item === match[2] || item.endsWith(`-${match[2]}`));
  return candidates.length === 1 ? { sku: candidates[0], units: Number(match[1]) } : null;
}
