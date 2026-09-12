import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// The pipeline is real code, not settings. The screen that used to hold editable
// snippets now reads these modules so what staff see is what actually runs —
// previously it showed placeholder JavaScript that no code path ever executed.
const processingDirectory = path.dirname(fileURLToPath(import.meta.url));

const steps = [
  {
    id: 'webhook_referral',
    name: 'Nhận tin & bắt quảng cáo',
    type: 'input',
    file: '../meta-webhook.mjs'
  },
  {
    id: 'catalog',
    name: 'Danh mục sản phẩm & quà tặng',
    type: 'data',
    file: 'catalog.mjs'
  },
  {
    id: 'product_detect',
    name: 'Nhận diện sản phẩm',
    type: 'transform',
    file: 'product-detect.mjs'
  },
  {
    id: 'customer_info',
    name: 'Xưng hô & số điện thoại',
    type: 'transform',
    file: 'customer-info.mjs'
  },
  {
    id: 'pending_order',
    name: 'Giỏ hàng chờ',
    type: 'state',
    file: 'pending-order.mjs'
  },
  {
    id: 'pricing',
    name: 'Tính tiền & quà tặng',
    type: 'transform',
    file: 'pricing.mjs'
  },
  {
    id: 'order_key',
    name: 'Mã giỏ hàng',
    type: 'transform',
    file: 'order-key.mjs'
  },
  {
    id: 'compose_reply',
    name: 'Soạn tin trả lời',
    type: 'output',
    file: '../chatbot-templates.mjs'
  }
];

export function listPipelineSteps() {
  return steps.map(({ file, ...step }) => ({ ...step, file: path.basename(file) }));
}

export async function readPipelineStep(id) {
  const step = steps.find(item => item.id === id);
  if (!step) return null;
  const filePath = path.resolve(processingDirectory, step.file);
  // Guard against a crafted id walking out of the app directory.
  if (!filePath.startsWith(path.resolve(processingDirectory, '..'))) return null;
  try {
    const code = await readFile(filePath, 'utf8');
    return { ...step, file: path.basename(step.file), code };
  } catch {
    return { ...step, file: path.basename(step.file), code: '' };
  }
}
