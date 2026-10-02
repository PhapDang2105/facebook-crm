// Vòng 13 (02/10) — bước GỘP cuối, mục 9 + 10:
// (9) web/app.js: tin mang cờ `system` (dòng hệ thống Facebook "Bạn đang phản hồi bình luận…", "… đã trả lời về một bài
//     viết. Xem bài viết(link)") vẽ kiểu dòng hệ thống mờ giữa khung, không phải bong bóng Page.
// (10) tools-intent: dòng dataset chép `candidateRule`; shadow-report thống kê luật ứng viên K (số lượt khớp khi chạy ẩn
//      và tỷ lệ trùng `chosen`); ghi chú `ctx.staffRepliedAfterBot` đổi nghĩa từ r13.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = relative => readFileSync(new URL(relative, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const app = read('../web/app.js');

/** Lấy nguyên một hàm cấp ngoài cùng của web/app.js (tới dòng "}" đầu dòng) để chạy thử phần thuần. */
function topLevelFunction(name) {
  const start = app.indexOf(`\nfunction ${name}(`);
  assert.ok(start >= 0, `web/app.js thiếu hàm ${name}`);
  return app.slice(start + 1, app.indexOf('\n}\n', start) + 2);
}
const pattern = app.match(/\nconst commentReplyNoticePattern = [^\n]+\n/)[0];
const { isCommentReplyNotice, splitSystemNoticeText } = new Function(`${pattern}\n${topLevelFunction('isCommentReplyNotice')}\n${topLevelFunction('splitSystemNoticeText')}\nreturn { isCommentReplyNotice, splitSystemNoticeText };`)();

test('9. tin có cờ system là dòng hệ thống (không vẽ bong bóng Page); tin Page thường và tin khách thì không', () => {
  // Câu thật trong hộp thư (link đã rút gọn).
  const replied = { type: 'text', direction: 'outgoing', system: true, text: 'Cuội Moon đã trả lời về một bài viết. Xem bài viết(https://www.facebook.com/giotnang.healthy/posts/pfbid02g5)' };
  const ad = { type: 'text', direction: 'outgoing', system: true, text: 'Khách đã trả lời một quảng cáo.' };
  const english = { direction: 'outgoing', system: true, text: 'Tina replied to a post. View post(https://www.facebook.com/x/posts/1)' };
  for (const item of [replied, ad, english]) assert.equal(isCommentReplyNotice(item), true, item.text);
  // Tin cũ chưa có cờ: câu "Bạn đang phản hồi bình luận…" vẫn nhận theo chữ như trước.
  assert.equal(isCommentReplyNotice({ type: 'text', text: 'Bạn đang phản hồi bình luận của người dùng về bài viết trên Trang của mình. Xem bình luận.(https://facebook.com/x/videos/1/?comment_id=2)' }), true);
  assert.equal(isCommentReplyNotice({ type: 'text', direction: 'outgoing', text: 'Dạ em chào chị ạ' }), false);
  assert.equal(isCommentReplyNotice({ type: 'image', system: true, text: '' }), false, 'ảnh không phải dòng hệ thống');
  assert.equal(isCommentReplyNotice(null), false);
});

test('9. dòng hệ thống: tách chữ + link cuối câu, nhãn link theo đúng câu ("Xem bình luận" / "Xem bài viết" / "View post")', () => {
  assert.deepEqual(splitSystemNoticeText('Bạn đang phản hồi bình luận của người dùng về bài viết trên Trang của mình. Xem bình luận.(https://facebook.com/x/videos/1/?comment_id=2)'),
    { body: 'Bạn đang phản hồi bình luận của người dùng về bài viết trên Trang của mình.', link: 'https://facebook.com/x/videos/1/?comment_id=2', linkLabel: 'Xem bình luận' });
  assert.deepEqual(splitSystemNoticeText('Cuội Moon đã trả lời về một bài viết. Xem bài viết(https://www.facebook.com/giotnang.healthy/posts/pfbid02g5)'),
    { body: 'Cuội Moon đã trả lời về một bài viết.', link: 'https://www.facebook.com/giotnang.healthy/posts/pfbid02g5', linkLabel: 'Xem bài viết' });
  assert.deepEqual(splitSystemNoticeText('Tina replied to a post. View post(https://www.facebook.com/x/posts/1)'), { body: 'Tina replied to a post.', link: 'https://www.facebook.com/x/posts/1', linkLabel: 'View post' });
  assert.deepEqual(splitSystemNoticeText('Khách đã trả lời một quảng cáo.'), { body: 'Khách đã trả lời một quảng cáo.', link: '', linkLabel: 'Xem' });
  assert.deepEqual(splitSystemNoticeText(''), { body: '', link: '', linkLabel: 'Xem' });
});

test('9. appendChatMessage rẽ sang dòng hệ thống TRƯỚC khi dựng bong bóng; dòng hệ thống dùng lớp chat-system-notice (mờ, giữa khung)', () => {
  const body = topLevelFunction('appendChatMessage');
  const branch = body.indexOf('if (isCommentReplyNotice(item)) {\n    appendCommentReplyNotice(item);\n    return;');
  assert.ok(branch > 0 && branch < body.indexOf("row.className = `message-row"), 'rẽ nhánh trước khi tạo message-row');
  const notice = topLevelFunction('appendCommentReplyNotice');
  assert.match(notice, /notice\.className = 'chat-system-notice chat-comment-notice';/);
  assert.match(notice, /const \{ body, link, linkLabel \} = splitSystemNoticeText\(item\.text\);/);
  assert.match(notice, /text\.textContent = body;/);
  assert.match(notice, /anchor\.textContent = linkLabel;/);
  assert.doesNotMatch(notice, /innerHTML/, 'chữ dòng hệ thống không ghép vào innerHTML');
  const styles = read('../web/styles.css');
  assert.match(styles, /\.chat-system-notice \{[^}]*align-self: center;/);
});

const { rowsFromDecisionLog } = await import('../tools-intent/build-dataset.mjs');
const { formatReport, summarize } = await import('../tools-intent/shadow-report.mjs');

const logEntry = (text, extra = {}) => ({ v: 2, at: Date.parse('2026-10-03T03:00:00Z'), conversationId: `c-${text}`, mid: `m-${text}`, source: 'inbox', type: 'text', text, final: 'GENERAL_INFO', chosen: 'GENERAL_INFO', ctx: {}, ...extra });

test('10. build-dataset: dòng từ nhật ký chép candidateRule { name, templateId, mode }; lượt không có thì không thêm trường', () => {
  const rows = rowsFromDecisionLog([
    logEntry('Có mấy vị', { candidateRule: { name: 'K5_FLAVOR_LIST_HELD', templateId: 'GENERAL_INFO', mode: 'shadow' }, ctx: { staffRepliedAfterBot: true } }),
    logEntry('ok em', { final: 'ORDER_ADDRESS', chosen: 'ORDER_ADDRESS', candidateRule: { name: 'K1_OK', templateId: 'ORDER_ADDRESS', mode: 'on', setQuantity: 2 } }),
    logEntry('túi xanh giá sao')
  ]);
  assert.equal(rows.length, 3);
  assert.deepEqual(rows[0].candidateRule, { name: 'K5_FLAVOR_LIST_HELD', templateId: 'GENERAL_INFO', mode: 'shadow' });
  assert.equal(rows[0].staffRepliedAfterBot, true);
  assert.deepEqual(rows[1].candidateRule, { name: 'K1_OK', templateId: 'ORDER_ADDRESS', mode: 'on' });
  assert.equal('candidateRule' in rows[2], false);
});

test('10. shadow-report: luật ứng viên K — số lượt khớp khi chạy ẩn và tỷ lệ trùng chosen, theo ngày và theo luật; bảng giữ nguyên cột', () => {
  const k = (name, templateId, mode = 'shadow') => ({ candidateRule: { name, templateId, mode } });
  const items = [
    { day: '2026-10-03', entry: logEntry('a', { ...k('K1', 'ORDER_ADDRESS'), chosen: 'ORDER_ADDRESS', final: 'ORDER_ADDRESS' }) },
    { day: '2026-10-03', entry: logEntry('b', { ...k('K1', 'ORDER_ADDRESS'), chosen: 'GENERAL_INFO', final: 'GENERAL_INFO' }) },
    { day: '2026-10-03', entry: logEntry('c', { ...k('K5', 'GENERAL_INFO'), chosen: 'GENERAL_INFO', final: 'REPLY_ALREADY_SENT' }) },
    { day: '2026-10-03', entry: logEntry('d', { ...k('K5', 'GENERAL_INFO'), chosen: 'REPLY_ALREADY_SENT', final: 'REPLY_ALREADY_SENT' }) },
    { day: '2026-10-04', entry: logEntry('e', { ...k('K3', 'PRICE_QUOTE'), chosen: 'PRICE_QUOTE', final: 'PRICE_QUOTE' }) },
    { day: '2026-10-04', entry: logEntry('f', { ...k('K3', 'PRICE_QUOTE', 'on'), chosen: 'PRICE_QUOTE', final: 'PRICE_QUOTE' }) },
    { day: '2026-10-04', entry: logEntry('g') },
    { day: '2026-10-04', entry: { skipped: 'bot-off', ...k('K1', 'ORDER_ADDRESS') } }
  ];
  const days = summarize(items);
  assert.deepEqual(days['2026-10-03'].candidate, { n: 4, ok: 2, bad: 1, neutral: 1, live: 0, byRule: { K1: { n: 2, ok: 1, bad: 1, neutral: 0, live: 0 }, K5: { n: 2, ok: 1, bad: 0, neutral: 1, live: 0 } } });
  assert.deepEqual(days['2026-10-04'].candidate, { n: 1, ok: 1, bad: 0, neutral: 0, live: 1, byRule: { K3: { n: 1, ok: 1, bad: 0, neutral: 0, live: 1 } } });
  const report = formatReport(days);
  assert.match(report, /^Luật ứng viên K \(candidateRule, chạy ẩn\) theo ngày: 2026-10-03 4 lượt, trùng chosen 2\/3 \(67%\), ~1 · 2026-10-04 1 lượt, trùng chosen 1\/1 \(100%\), đã bật thật 1 · TỔNG 5 lượt, trùng chosen 3\/4 \(75%\), ~1, đã bật thật 1$/m);
  assert.match(report, /^Luật ứng viên K theo luật: K1 2 lượt, trùng chosen 1\/2 \(50%\) · K5 2 lượt, trùng chosen 1\/1 \(100%\), ~1 · K3 1 lượt, trùng chosen 1\/1 \(100%\), đã bật thật 1$/m);
  assert.match(report, /\| Tầng nhóm \| Tầng≥0,7 \| Tầng≥0,8 \| Tầng≥0,9$/m, 'các cột của bảng giữ nguyên');
  // Nhật ký chưa có candidateRule (trước r13): báo cáo không in dòng luật ứng viên.
  assert.doesNotMatch(formatReport(summarize([{ day: '2026-09-30', entry: logEntry('h') }])), /Luật ứng viên K/);
});

test('10. README + build-dataset ghi chú staffRepliedAfterBot đổi nghĩa từ r13 và trường candidateRule', () => {
  const readme = read('../tools-intent/README.md');
  assert.match(readme, /`staffRepliedAfterBot` đổi nghĩa từ r13/);
  assert.match(readme, /\*\*`candidateRule`\*\* \(từ r13\)/);
  const tool = read('../tools-intent/build-dataset.mjs');
  assert.match(tool, /`ctx\.staffRepliedAfterBot` của nhật ký ĐỔI NGHĨA/);
  assert.match(tool, /Trường mới `candidateRule`/);
});
