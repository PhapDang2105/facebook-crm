const SPX_TRACKING_ENDPOINT = 'https://spx.vn/shipment/order/open/order/get_order_info';

export function normalizeTrackingNumber(value) {
  const trackingNumber = String(value || '').trim().toUpperCase();
  if (!/^[A-Z0-9-]{6,40}$/.test(trackingNumber)) {
    const error = new Error('Mã vận đơn không hợp lệ. Vui lòng kiểm tra và nhập lại.');
    error.statusCode = 400;
    throw error;
  }
  return trackingNumber;
}

function toIsoTime(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return '';
  const milliseconds = numeric > 10_000_000_000 ? numeric : numeric * 1000;
  const date = new Date(milliseconds);
  return Number.isNaN(date.getTime()) ? '' : date.toISOString();
}

function firstText(...values) {
  return values.find(value => typeof value === 'string' && value.trim())?.trim() || '';
}

export function normalizeSpxPayload(payload, requestedTrackingNumber) {
  if (!payload || typeof payload !== 'object') {
    const error = new Error('SPX trả về dữ liệu không hợp lệ. Vui lòng thử lại sau.');
    error.statusCode = 502;
    throw error;
  }

  if (Number(payload.retcode || 0) !== 0) {
    const error = new Error('Không tìm thấy vận đơn SPX này. Vui lòng kiểm tra lại mã.');
    error.statusCode = 404;
    throw error;
  }

  const data = payload.data && typeof payload.data === 'object' ? payload.data : payload;
  const trackingInfo = data.sls_tracking_info || data.tracking_info || {};
  const rawRecords = Array.isArray(trackingInfo.records)
    ? trackingInfo.records
    : Array.isArray(data.tracking_list) ? data.tracking_list : [];
  const records = rawRecords.filter(record => Number(record.display_flag ?? 1) !== 0).map(record => ({
    status: firstText(record.tracking_name, record.status, record.title, 'Đang vận chuyển'),
    description: firstText(record.description, record.message, record.content),
    location: firstText(
      record.current_location?.location_name,
      record.current_location,
      record.location,
      record.station_name,
      record.city
    ),
    time: toIsoTime(record.actual_time ?? record.timestamp ?? record.time)
  })).filter(record => record.status || record.description)
    .sort((left, right) => String(right.time).localeCompare(String(left.time)));

  const newest = records[0] || {};
  const trackingNumber = firstText(
    data.order_info?.spx_tn,
    data.spx_tn,
    data.sls_tracking_number,
    trackingInfo.spx_tn,
    requestedTrackingNumber
  );
  const status = firstText(
    trackingInfo.current_status_name,
    trackingInfo.current_status,
    data.current_status_name,
    data.status_name,
    newest.status,
    'Đã tiếp nhận thông tin vận đơn'
  );

  return {
    provider: 'SPX Express',
    trackingNumber,
    customerTrackingNumber: firstText(data.parcel_info?.customer_tracking_no),
    expectedDeliveryAt: toIsoTime(data.edd_info?.edd_max ?? data.edd_info?.edd_min),
    status,
    description: firstText(trackingInfo.current_status_description, data.status_description, newest.description),
    updatedAt: newest.time || '',
    records
  };
}

export async function getSpxTracking(value, fetchImplementation = fetch) {
  const trackingNumber = normalizeTrackingNumber(value);
  const endpoint = new URL(SPX_TRACKING_ENDPOINT);
  endpoint.searchParams.set('spx_tn', trackingNumber);
  endpoint.searchParams.set('language_code', 'vi');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12_000);

  try {
    const response = await fetchImplementation(endpoint, {
      headers: {
        Accept: 'application/json, text/plain, */*',
        'Accept-Language': 'vi-VN,vi;q=0.9',
        Referer: `https://spx.vn/track?${encodeURIComponent(trackingNumber)}`,
        Source: 'pc'
      },
      signal: controller.signal
    });
    if (!response.ok) {
      const error = new Error('Không thể kết nối với SPX lúc này. Vui lòng thử lại sau.');
      error.statusCode = 502;
      throw error;
    }
    const payload = await response.json().catch(() => null);
    return normalizeSpxPayload(payload, trackingNumber);
  } catch (error) {
    if (error.name === 'AbortError') {
      const timeoutError = new Error('SPX phản hồi quá lâu. Vui lòng thử lại.');
      timeoutError.statusCode = 504;
      throw timeoutError;
    }
    if (!error.statusCode) {
      const connectionError = new Error('Không thể kết nối với SPX lúc này. Vui lòng thử lại sau.');
      connectionError.statusCode = 502;
      throw connectionError;
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}
