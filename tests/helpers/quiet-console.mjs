// Tắt console.log của mã app khi chạy test (được --import vào từng tiến trình con của node --test).
// Lý do: runner của node:test (FileTest.#processRawBuffer) đọc stdout của tiến trình con vừa có khung
// TAP tuần tự hoá vừa có chữ thô; một dòng log tiếng Việt có byte thứ hai ≥ 0x80 ("Mô hình nhỏ…",
// "Luật…") nằm ngay sau khung test:pass làm runner tính sai độ dài khung và ném
// "Unable to deserialize cloned data" → cả tệp test fail ngẫu nhiên (7/15 lần với round3-chatbot).
// Đặt CRM_TEST_VERBOSE=1 để xem lại log khi cần soi.
if (!process.env.CRM_TEST_VERBOSE) {
  console.log = () => {};
  console.info = () => {};
}
