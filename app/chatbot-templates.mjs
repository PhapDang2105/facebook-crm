import { priceBasket, renderPriceQuote } from './processing/pricing.mjs';
import { orderKey as buildOrderKey, productCode, toPricedItems } from './processing/order-key.mjs';
import { isOrderStep, usablePendingOrder } from './processing/pending-order.mjs';
import { extractVietnamesePhone, toLocalPhone } from './processing/customer-info.mjs';

const templates = {
  WELCOME: 'Dạ Giọt Nắng xin chào anh/chị ạ 👋 Anh/chị đang cần thông tin nào về sản phẩm để em tư vấn cho chính xác nhé ạ 🍀',
  CSKH_HANDOFF: 'Dạ em đã tiếp nhận thông tin của mình và chuyển bộ phận chăm sóc khách hàng hỗ trợ kỹ hơn nhé ạ. Bên em sẽ phản hồi mình sớm ạ.',
  ORDER_ADDRESS: 'Dạ để lên đơn đúng tuyến cho đơn vị vận chuyển.###Anh/chị cho em xin số điện thoại và địa chỉ trước sáp nhập để em lên đơn gửi mình cho chính xác nha ạ.',
  ECOMMERCE_LINKS: 'Dạ em gửi mình link gian hàng chính hãng của Giọt Nắng ạ 💛\n🛒 Shopee: https://shopee.vn/nongsangiotnang\n🛒 TikTok Shop: https://www.tiktok.com/@nongsangiotnang',
  GENERAL_INFO: 'Dạ hiện tại nhà em có 3 vị chính ạ:\n🌾 Túi Xanh nguyên bản 450g: 174.000đ\n🌾 Túi Vàng nguyên bản 350g: 174.000đ\n🌾 Túi Nâu cacao 350g: 164.000đ\nGiá trên chưa gồm phí vận chuyển. Anh/chị đang quan tâm loại nào để em gửi bảng giá chi tiết ạ?',
  BAG_COMPARISON: 'Dạ các túi đều dùng chung các loại hạt, khác nhau về tỷ lệ và hương vị ạ 🥰\n🤎 Túi Nâu: vị cacao, 50% hạt và quả.\n💚 Túi Xanh: vị nguyên bản, tỷ lệ hạt 50%.\n💛 Túi Vàng: vị nguyên bản, tỷ lệ hạt 70%.',
  BAG_COMPARISON_XANH_VANG: 'Dạ Túi Xanh 450g có khoảng 50% hạt và trái cây, vị cân bằng, dễ ăn. Túi Vàng 350g có khoảng 70% hạt và trái cây nên rõ vị hạt hơn. Thích dễ ăn chọn Túi Xanh; thích nhiều hạt chọn Túi Vàng nha ạ.',
  HOW_TO_USE_GRANOLA: 'Dạ mình có thể ăn granola trực tiếp như snack, hoặc dùng cùng sữa chua/sữa tươi cho bữa sáng nhanh gọn. Có thể thêm chuối, dâu hoặc xoài để dễ ăn hơn nha ạ.',
  CALORIES_DIET: 'Dạ 100g granola khoảng 445 Kcal. Nếu dùng trong chế độ giảm cân, mình có thể dùng 20–30g cùng sữa chua không đường hoặc trái cây thay bữa sáng. Hiệu quả còn phụ thuộc chế độ ăn và cơ địa ạ.',
  WHOLESALE_CTV_CONTACT: 'Dạ anh/chị cho em xin số Zalo được không ạ. Bên em có bộ phận CSKH sỉ/CTV tư vấn cho mình.',
  GIFT_POLICY: 'Dạ chương trình tặng bộ bát và muỗng dừa hiện áp dụng với combo 3 túi ạ.',
  SHIPPING_POLICY: 'Dạ thời gian giao dự kiến: TP.HCM và tỉnh lân cận 1–3 ngày, các tỉnh khác 4–6 ngày ạ. Bên em sẽ gửi mã vận đơn để mình theo dõi nha ạ.',
  STORE_ADDRESS: 'Dạ địa chỉ bên em là 176/1A Khu phố 1, An Phú Đông, Quận 12, TP.HCM. SĐT: 0899 677 899 (Giọt Nắng) ạ.',
  BANK_TRANSFER: 'Dạ thông tin chuyển khoản: ACB – 18066788 – Công ty Cổ phần GONA Việt Nam. Sau khi chuyển, mình gửi ảnh giao dịch thành công để bên em xác nhận nha ạ.',
  CRUNCHY_CEREAL_INFO: 'Dạ hạt tròn là viên ngũ cốc giòn làm từ yến mạch, gạo lứt, mật thốt nốt, bột chuối xanh và muối hồng Himalaya; được sấy và nướng, không chiên qua dầu ạ.',
  NO_ADDED_SUGAR: 'Dạ trong quá trình sản xuất bên em không thêm đường, nhưng trái cây sấy vốn có đường tự nhiên ạ.',
  OIL_SMELL_WARRANTY: 'Dạ các loại hạt có dầu tự nhiên nên đôi khi có thể ỉu hoặc hôi dầu do bảo quản hay vận chuyển. Bên em có chính sách bảo hành và sẽ hỗ trợ mình ạ.',
  WEIGHT_EXPIRY: 'Dạ một túi Granola Nguyên Bản nặng 450g. Hạn sử dụng 6 tháng kể từ ngày sản xuất và được in đầy đủ trên bao bì ạ.',
  PRICE_ADJUSTMENT: 'Dạ giá túi lẻ có điều chỉnh theo chi phí nguyên liệu. Bên em vẫn giữ giá combo và hỗ trợ 50% phí vận chuyển cho đơn một túi nên phí ship còn khoảng 15.000đ ạ.',
  DELIVERY_DELAY: 'Dạ em xin lỗi mình vì đơn giao chậm ạ. Bên em đang theo dõi và thúc đẩy đơn vị vận chuyển giao sớm nhất cho mình.',
  INSPECTION_RETURN_POLICY: 'Dạ khi nhận hàng mình có thể đồng kiểm mẫu mã cùng shipper. Sau khi trải nghiệm, nếu sản phẩm có vấn đề bên em hỗ trợ theo chính sách bảo hành ạ.',
  REFUSED_DELIVERY: 'Dạ hệ thống ghi nhận đơn bị từ chối nhận và đang hoàn về. Anh/chị cho em biết mình có nhận được cuộc gọi từ shipper không để bên em làm việc với đơn vị vận chuyển ạ.',
  THANK_YOU: 'Dạ em cảm ơn anh/chị rất nhiều ạ. Chúc mình một ngày thật nhiều năng lượng và niềm vui ạ.',
  PRICE_MIX_TUI_LON: 'Dạ bảng giá mix túi lớn ạ:\n• Xanh + Vàng: 298.000đ\n• Xanh + Nâu: 293.000đ\n• Vàng + Nâu: 293.000đ\n• Trọn bộ Xanh + Vàng + Nâu: 442.000đ, miễn phí vận chuyển và tặng bộ bát muỗng dừa ạ.',
  PRICE_NGHE_LANH: 'Dạ Bột ngũ cốc Nghệ Lành 14 gói/hộp: 1 hộp 174.000đ + ship 15.000đ; combo 2 hộp 298.000đ, miễn phí vận chuyển ạ.',
  PRICE_YEN_MACH_UC_NGUYEN_CAM: 'Dạ Yến Mạch Úc Nguyên Cám: 1kg 116.000đ + ship 15.000đ; 2kg 222.000đ miễn phí vận chuyển; 3kg 299.000đ miễn phí vận chuyển ạ.',
  PRICE_TUI_XANH: 'Dạ Túi Xanh 450g: 1 túi 174.000đ + ship 15.000đ; combo 2 túi 298.000đ; combo 3 túi 447.000đ và tặng bộ bát muỗng dừa. Combo được miễn phí vận chuyển ạ.',
  PRICE_TUI_VANG: 'Dạ Túi Vàng 350g: 1 túi 174.000đ + ship 15.000đ; combo 2 túi 298.000đ; combo 3 túi 447.000đ và tặng bộ bát muỗng dừa. Combo được miễn phí vận chuyển ạ.',
  PRICE_TUI_NAU: 'Dạ Túi Nâu cacao 350g: 1 túi 164.000đ + ship 15.000đ; combo 2 túi 288.000đ; combo 3 túi 432.000đ và tặng bộ bát muỗng dừa. Combo được miễn phí vận chuyển ạ.',
  PRICE_TUI_XANH_NHO: 'Dạ Combo Túi Xanh nhỏ: 10 gói 189.000đ + ship 15.000đ; 20 gói 358.000đ; 30 gói 537.000đ và tặng bộ bát muỗng dừa. Combo từ 20 gói được miễn phí vận chuyển ạ.',
  PRICE_TUI_NAU_NHO: 'Dạ Combo Túi Nâu nhỏ: 10 gói 189.000đ + ship 15.000đ; 20 gói 358.000đ; 30 gói 537.000đ và tặng bộ bát muỗng dừa. Combo từ 20 gói được miễn phí vận chuyển ạ.',
  PRICE_TUI_CAM_NHO: 'Dạ Combo Túi Cam nhỏ: 10 gói 189.000đ + ship 15.000đ; 20 gói 358.000đ; 30 gói 537.000đ và tặng bộ bát muỗng dừa. Combo từ 20 gói được miễn phí vận chuyển ạ.',
  PRICE_COMBO_10_GOI_MIX_3_MAU: 'Dạ Combo 10 gói mix 3 vị: 10 gói 189.000đ + ship 15.000đ; 20 gói 358.000đ; 30 gói 537.000đ và tặng bộ bát muỗng dừa. Combo từ 20 gói được miễn phí vận chuyển ạ.',
  PRICE_HAT_AN_LANH_DANG_HU: 'Dạ Hạt An Lành dạng hũ: 1 hũ 269.000đ + ship 15.000đ; combo 2 hũ 528.000đ và miễn phí vận chuyển ạ.',
  // Rendered from Cài đặt → Sản phẩm at reply time; this text is only the
  // fallback when the model names a product the catalogue does not have.
  PRICE_QUOTE: 'Dạ anh/chị đang quan tâm sản phẩm nào để em gửi bảng giá chi tiết ạ?'
};

function renderOrder(value, context = {}) {
  const now = Number(context.now) || Date.now();
  const templateId = String(value.template_id || '').trim();
  const products = [value.Product_N1, value.Product_N2, value.Product_N3];
  const quantities = [value.No_A, value.No_B, value.No_C];
  const freshItems = toPricedItems(products.map((product, index) => ({
    product: String(product || '').trim(),
    quantity: Number(String(quantities[index] || '').replace(/\D/g, '')) || 0
  })).filter(item => item.product && item.product !== '0' && item.quantity > 0));

  // The price comes from the basket itself, never from a key the model
  // declared: an order_key the model invented used to price three bags as one.
  const freshKey = buildOrderKey(freshItems);
  const freshPrice = freshKey ? priceBasket(freshItems) : null;
  const pending = usablePendingOrder(context.pendingOrder, { now, templateId });
  const items = freshItems.length ? freshItems : (pending?.items || []);
  const key = freshKey || pending?.key || '';
  const priced = items.length ? priceBasket(items) : null;
  const price = priced?.priceable ? priced : null;

  const freshPhone = toLocalPhone(value.Phone_Number) || extractVietnamesePhone(value.Phone_Number);
  const freshAddress = String(value.Customer_Address || '').trim();
  const phone = freshPhone || pending?.phone || '';
  const address = (freshAddress && freshAddress !== '0' ? freshAddress : '') || pending?.address || '';
  const hasPhone = Boolean(phone);
  const hasAddress = Boolean(address);

  // Remember a priceable basket, plus whatever contact detail has arrived so
  // far, so the customer never has to repeat something already given.
  const freshPriceable = Boolean(freshItems.length && freshPrice?.priceable);
  const nextPending = freshPriceable || pending || hasPhone || hasAddress
    ? {
        items: freshPriceable ? freshItems : (pending?.items || []),
        key: freshPriceable ? freshKey : (pending?.key || ''),
        at: freshPriceable ? now : (pending?.at || now),
        phone,
        address
      }
    : null;

  const confirmed = isOrderStep(templateId) && Boolean(price) && hasPhone && hasAddress;

  if (!confirmed) {
    // Only a request to close the order is escalated. While still collecting
    // details the bot keeps asking rather than dropping the customer on a human.
    if (templateId === 'ORDER_CONFIRMATION' && items.length && !price) {
      return { templateId: 'CSKH_HANDOFF', messages: [templates.CSKH_HANDOFF], handoff: true, pendingOrder: null };
    }
    const missing = hasPhone && !hasAddress ? 'địa chỉ nhận hàng đầy đủ'
      : !hasPhone && hasAddress ? 'số điện thoại'
      : 'số điện thoại và địa chỉ nhận hàng đầy đủ';
    const known = hasPhone ? 'số điện thoại' : hasAddress ? 'địa chỉ' : '';
    const opening = known
      ? `Dạ em đã nhận được ${known} của mình rồi ạ.`
      : 'Dạ em đã ghi nhận sản phẩm rồi ạ.';
    return {
      templateId: 'ORDER_ADDRESS',
      messages: [`${opening} Anh/chị cho em xin ${missing} để em lên đơn gửi mình nha ạ.`],
      handoff: false,
      pendingOrder: nextPending
    };
  }

  const total = price.total;
  // Catalogue names, not the customer's wording, so the confirmation and the
  // order record agree on what is being shipped.
  const orderItems = price.lines.map(line => ({ product: line.name, code: line.sku, quantity: line.quantity }));
  const lines = orderItems.map(item => `🌾 ${item.product} – Số lượng: ${item.quantity}`).join('\n');
  return {
    templateId: 'ORDER_CONFIRMATION',
    messages: [
      `Dạ em xin phép xác nhận lại thông tin đặt hàng của mình nha:\n\n${lines}\n━━━━━━━━━━━━\n📞 Số điện thoại: ${phone}\n━━━━━━━━━━━━\n🏡 Địa chỉ nhận hàng: ${address}\n━━━━━━━━━━━━\n💰 Tổng tiền: ${total.toLocaleString('vi-VN')}đ${price.gift ? `\n━━━━━━━━━━━━\n🎁 ${price.gift}` : ''}\n\nEm cảm ơn anh/chị đã ủng hộ Giọt Nắng. Nếu có gì sai sót, mình nhắn em biết nhé ạ.`,
      templates.SHIPPING_POLICY,
      'Dạ sau khi nhận hàng mình giúp em kiểm tra sản phẩm và quay video đủ 6 mặt hộp khi mở. Bên em hỗ trợ đổi trả trong 7 ngày nếu sản phẩm có lỗi ạ.'
    ],
    handoff: false,
    // Cleared: the basket has become a real order.
    pendingOrder: null,
    order: { items: orderItems, phone, address, total, orderKey: key, gift: price.gift }
  };
}

export function renderChatbotReply(value = {}, overrides = {}, deletedTemplateIds = [], context = {}) {
  const templateId = String(value.template_id || '').trim();
  if (isOrderStep(templateId)) return renderOrder(value, context);
  const available = { ...templates, ...overrides };
  for (const id of deletedTemplateIds) delete available[id];
  // Built from the catalogue at reply time, so it can never quote a stale price
  // the way a static PRICE_* template can.
  if (templateId === 'PRICE_QUOTE') {
    const quote = renderPriceQuote(value.Product_N1 || value.product || '');
    if (quote) return { templateId: 'PRICE_QUOTE', messages: [quote], handoff: false };
  }
  const raw = available[templateId] || value.reply || value.message || value.text || available.CSKH_HANDOFF || templates.CSKH_HANDOFF;
  return {
    templateId: available[templateId] ? templateId : 'CSKH_HANDOFF',
    messages: String(raw).replace(/\\n/g, '\n').split('###').map(item => item.trim()).filter(Boolean).slice(0, 3),
    handoff: templateId === 'CSKH_HANDOFF'
  };
}

export const chatbotTemplates = Object.freeze(templates);
export { productCode };
