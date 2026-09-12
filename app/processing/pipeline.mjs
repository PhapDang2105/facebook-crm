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
    file: '../meta-webhook.mjs',
    summary: 'Đọc sự kiện Messenger từ Meta. Nếu khách đến từ quảng cáo Click-to-Messenger thì giữ lại tiêu đề quảng cáo để biết họ đang quan tâm sản phẩm nào.'
  },
  {
    id: 'product_detect',
    name: 'Nhận diện sản phẩm',
    type: 'transform',
    file: 'product-detect.mjs',
    summary: 'Dò sản phẩm từ lời khách nói; nếu khách chưa nói gì thì lấy từ quảng cáo họ bấm vào. Cố tình không nhận từ màu đơn lẻ để tránh nhầm với tên nguyên liệu.'
  },
  {
    id: 'customer_info',
    name: 'Xưng hô & số điện thoại',
    type: 'transform',
    file: 'customer-info.mjs',
    summary: 'Bóc số điện thoại theo đúng đầu số nhà mạng Việt Nam, chuẩn hoá +84 về 0. Xác định xưng hô anh/chị theo giới tính.'
  },
  {
    id: 'pending_order',
    name: 'Giỏ hàng chờ',
    type: 'state',
    file: 'pending-order.mjs',
    summary: 'Nhớ sản phẩm, số điện thoại và địa chỉ trong 2 giờ để khách đưa từng phần qua nhiều tin nhắn vẫn chốt được đơn.'
  },
  {
    id: 'order_key',
    name: 'Mã tổ hợp đơn',
    type: 'transform',
    file: 'order-key.mjs',
    summary: 'Quy giỏ hàng về một mã tra giá. Trả về rỗng khi có sản phẩm lạ, số lượng quá 3, hoặc combo bị trộn — không định giá được thì không chốt đơn.'
  },
  {
    id: 'price_master',
    name: 'Bảng giá & quà tặng',
    type: 'data',
    file: 'price-master.mjs',
    summary: 'Tra giá và quà tặng theo mã tổ hợp. Bảng nằm trong data/processed/price-master.json, sửa được mà không cần đụng mã nguồn.'
  },
  {
    id: 'compose_reply',
    name: 'Soạn tin trả lời',
    type: 'output',
    file: '../chatbot-templates.mjs',
    summary: 'Chọn mẫu tin, hỏi đúng phần khách còn thiếu, và soạn tin xác nhận đơn kèm tổng tiền với quà tặng.'
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
