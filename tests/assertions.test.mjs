import test from 'node:test';

// Bốn tệp dưới đây viết theo lối cũ: `assert` chạy thẳng ở cấp cao nhất, không
// có lời gọi `test()` nào. Hệ quả là toàn bộ khẳng định trong đó không được
// node:test đếm, không lọc được theo tên bài, và khẳng định đầu tiên vỡ sẽ chặn
// im lặng phần còn lại của tệp.
//
// Bọc bằng cách nạp chúng BÊN TRONG một bài test, thay vì thụt lề lại hàng trăm
// dòng — vừa giữ nguyên từng khẳng định vừa đưa chúng vào bảng kết quả. Chúng
// đã được đổi đuôi thành .assertions.mjs nên `tests/*.test.mjs` không còn nạp
// thẳng nữa, tránh chạy hai lần.
for (const name of ['meta-webhook', 'order-export', 'spx-tracking', 'xlsx-import']) {
  test(`khẳng định trong ${name}.assertions.mjs`, async () => {
    await import(`./${name}.assertions.mjs`);
  });
}
