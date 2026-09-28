// Người gác giữa LLM, mô hình nhỏ và luật: chỉ so xem câu trả lời LLM có "đồng thuận" với
// mô hình nhỏ (top-K) hay luật ổn định không, để ghi vào nhật ký quyết định (guards.gate).
// Vòng này KHÔNG đổi hành vi — chỉ đo. Các mẫu cùng nghĩa được coi là một nhóm: xin địa chỉ
// (ORDER_ADDRESS và các biến thể nhắc/thiếu/làm rõ), bảng giá (PRICE_QUOTE, GENERAL_INFO, bảng
// mix, combo), cảm ơn / "đã gửi ở trên".

const templateGroups = [
  ['ORDER_ADDRESS', 'ORDER_ADDRESS_REMIND', 'ORDER_ADDRESS_PARTIAL', 'ORDER_ADDRESS_CLARIFY'],
  ['PRICE_QUOTE', 'GENERAL_INFO', 'PRICE_MIX_TUI_LON', 'PRICE_QUOTE_COMBO'],
  ['THANK_YOU', 'REPLY_ALREADY_SENT', 'REPLY_ALREADY_SENT_INFO']
];
const groupOf = new Map(templateGroups.flatMap((ids, index) => ids.map(id => [id, `g${index}`])));

/** Nhóm tương đương của mẫu; mẫu bảng giá theo sản phẩm (PRICE_<sản phẩm>) thuộc nhóm bảng giá. */
export function templateGroup(templateId) {
  const id = String(templateId || '').trim();
  if (!id) return '';
  if (groupOf.has(id)) return groupOf.get(id);
  if (id.startsWith('PRICE_') && id !== 'PRICE_ADJUSTMENT') return groupOf.get('PRICE_QUOTE');
  return id;
}

export function sameTemplateGroup(left, right) {
  const a = templateGroup(left);
  const b = templateGroup(right);
  return Boolean(a) && a === b;
}

const idOf = item => (typeof item === 'string' ? item : String(item?.templateId || ''));

/**
 * @param {{ llmTemplateId?: string, intentTopK?: Array<string|{templateId:string,p?:number}>, ruleTemplateId?: string }} input
 * @returns {{ agree: boolean|null, reason: string }}
 *   agree: true khi LLM cùng nhóm với luật ổn định hay một mẫu trong top-K của mô hình nhỏ;
 *   false khi có tham chiếu (luật / mô hình) mà LLM khác cả; null khi không có gì để so.
 */
export function gateCheck({ llmTemplateId = '', intentTopK = [], ruleTemplateId = '' } = {}) {
  const llm = String(llmTemplateId || '').trim();
  if (!llm) return { agree: null, reason: 'no-llm' };
  const rule = String(ruleTemplateId || '').trim();
  const topK = (Array.isArray(intentTopK) ? intentTopK : []).map(idOf).filter(Boolean);
  if (rule && sameTemplateGroup(llm, rule)) return { agree: true, reason: 'rule' };
  if (topK.length && sameTemplateGroup(llm, topK[0])) return { agree: true, reason: 'intent-top1' };
  if (topK.slice(1).some(id => sameTemplateGroup(llm, id))) return { agree: true, reason: 'intent-topk' };
  if (rule) return { agree: false, reason: 'rule-mismatch' };
  if (topK.length) return { agree: false, reason: 'intent-mismatch' };
  return { agree: null, reason: 'no-reference' };
}
