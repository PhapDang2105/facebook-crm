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
    id: 'catalog',
    name: 'Danh mục sản phẩm & quà tặng',
    type: 'data',
    file: 'catalog.mjs',
    summary: 'Đọc sản phẩm từ Cài đặt → Sản phẩm (giá bán, giá combo, SKU xuất kho, tên gọi khác) và quà tặng từ Cài đặt → Quà tặng. Mọi bước sau — kể cả file xuất kho của Đơn hàng — đều lấy dữ liệu từ đây, nên thêm sản phẩm là bot và đơn hàng nhận ngay.'
  },
  {
    id: 'product_detect',
    name: 'Nhận diện sản phẩm',
    type: 'transform',
    file: 'product-detect.mjs',
    summary: 'Dò sản phẩm từ lời khách nói theo tên và tên gọi khác trong danh mục; nếu khách chưa nói gì thì lấy từ quảng cáo họ bấm vào. Cụm dài nhất thắng để "combo 10 gói xanh" không bị đọc thành "túi xanh".'
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
    id: 'pricing',
    name: 'Tính tiền & quà tặng',
    type: 'transform',
    file: 'pricing.mjs',
    summary: 'Đơn 1 sản phẩm tính giá bán; đơn từ 2 sản phẩm (cùng loại hay mua kèm) thì mỗi sản phẩm tính giá combo của chính nó. Quà tặng cộng dồn theo tổng số lượng. Sản phẩm lạ hoặc quá 20 sản phẩm thì chuyển nhân viên thay vì đoán giá. Đây cũng là nơi soạn khối danh mục gắn vào system prompt và tách dòng xuất kho.'
  },
  {
    id: 'order_key',
    name: 'Mã giỏ hàng',
    type: 'transform',
    file: 'order-key.mjs',
    summary: 'Quy giỏ hàng về một mã chuẩn (ví dụ NAU=1|XANH=2) để nhớ giỏ chờ và chặn tạo đơn trùng.'
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
