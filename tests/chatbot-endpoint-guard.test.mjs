import test from 'node:test';
import assert from 'node:assert/strict';
import { assertUsableAiEndpoint } from '../app/chatbot-settings.mjs';

// Máy chủ tự gọi tới endpoint AI và mang theo giấy tờ tuỳ thân. Với Vertex thì
// giấy tờ đó là access token của CẢ dự án Google Cloud, nên endpoint trỏ đi đâu
// là token đi theo tới đó. Đây là chốt chặn duy nhất.

test('Vertex dùng access token chỉ gửi được tới googleapis.com', () => {
  const vertex = { provider: 'vertex', authType: 'access_token' };
  assert.ok(assertUsableAiEndpoint('https://aiplatform.googleapis.com/v1/projects/p/locations/global/x:generateContent', vertex));
  assert.ok(assertUsableAiEndpoint('https://asia-southeast1-aiplatform.googleapis.com/v1/x', vertex));
  assert.throws(() => assertUsableAiEndpoint('https://ke-tan-cong.example/thu', vertex), /googleapis\.com/);
  // Tên miền chỉ CHỨA googleapis.com chứ không kết thúc bằng nó thì vẫn chặn.
  assert.throws(() => assertUsableAiEndpoint('https://googleapis.com.ke-tan-cong.example/x', vertex), /googleapis\.com/);
});

test('Vertex dùng khoá API thì không bị bó vào googleapis', () => {
  // Khoá API là của riêng endpoint đó, nhân viên tự nhập, không phải giấy tờ dự án.
  assert.ok(assertUsableAiEndpoint('https://api.example.com/v1/x', { provider: 'vertex', authType: 'api_key' }));
});

test('provider tự đặt vẫn trỏ được endpoint riêng, trừ mạng nội bộ', () => {
  const custom = { provider: 'custom', authType: 'api_key' };
  assert.ok(assertUsableAiEndpoint('https://api.deepseek.com/chat/completions', custom));
  for (const internal of [
    'https://localhost/x',
    'https://127.0.0.1/x',
    'https://10.1.2.3/x',
    'https://192.168.1.1/x',
    'https://172.16.0.9/x',
    'https://169.254.169.254/computeMetadata/v1/',
    'https://metadata.google.internal/x'
  ]) {
    assert.throws(() => assertUsableAiEndpoint(internal, custom), /nội bộ/, internal);
  }
});

test('bắt buộc https và URL đọc được', () => {
  const custom = { provider: 'custom', authType: 'api_key' };
  assert.throws(() => assertUsableAiEndpoint('http://api.example.com/x', custom), /https/);
  assert.throws(() => assertUsableAiEndpoint('khong-phai-url', custom), /không hợp lệ/);
  assert.throws(() => assertUsableAiEndpoint('', custom), /không hợp lệ/);
});
