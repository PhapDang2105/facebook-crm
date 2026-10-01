// Bộ giới hạn tốc độ gọi Pancake: Pancake cho tối đa 5 lần gọi mỗi giây cho mỗi Page, quá thì
// trả 429 ("Too many requests"). Trước đây mỗi đường (đồng bộ, bot gửi tin, bám đuổi, tra quảng
// cáo, tải ảnh) tự nghỉ theo ý mình và chạy song song nên vẫn chạm trần. Giờ mọi lần gọi đi qua
// một hàng đợi nhẹ theo Page:
//  - tối đa `maxConcurrent` yêu cầu đang chạy cùng lúc;
//  - tối đa `perSecond` lần BẮT ĐẦU gọi trong mỗi cửa sổ `windowMs` (cửa sổ trượt);
//  - gặp 429 thì cả Page lùi lại (`backoffPancake`), mọi yêu cầu đang chờ đều đợi hết mốc lùi;
//  - thứ tự vào trước ra trước.
let limits = { perSecond: 4, maxConcurrent: 3, windowMs: 1000 };
const states = new Map();

/** Đổi giới hạn (test, hay chỉnh tay khi Pancake đổi chính sách). Trả về giới hạn đang dùng. */
export function configurePancakeRateLimit(options = {}) {
  const next = { ...limits };
  for (const key of ['perSecond', 'maxConcurrent', 'windowMs']) {
    const value = Number(options[key]);
    if (Number.isFinite(value) && value > 0) next[key] = value;
  }
  limits = next;
  return { ...limits };
}

function stateOf(key) {
  const id = String(key || 'default');
  let state = states.get(id);
  if (!state) {
    state = { active: 0, starts: [], blockedUntil: 0, queue: [], timer: null };
    states.set(id, state);
  }
  return state;
}

function pump(state) {
  if (state.timer) return;
  while (state.queue.length) {
    const now = Date.now();
    state.starts = state.starts.filter(at => now - at < limits.windowMs);
    if (state.active >= limits.maxConcurrent) return; // lượt xong sẽ gọi pump lại
    let wait = 0;
    if (state.blockedUntil > now) wait = state.blockedUntil - now;
    else if (state.starts.length >= limits.perSecond) wait = state.starts[0] + limits.windowMs - now;
    if (wait > 0) {
      state.timer = setTimeout(() => {
        state.timer = null;
        pump(state);
      }, wait);
      return;
    }
    state.active += 1;
    state.starts.push(now);
    state.queue.shift()();
  }
}

/** Chạy `task` khi tới lượt của Page `key`; trả về kết quả của task. */
export async function withPancakeSlot(key, task) {
  const state = stateOf(key);
  await new Promise(resolve => {
    state.queue.push(resolve);
    pump(state);
  });
  try {
    return await task();
  } finally {
    state.active -= 1;
    pump(state);
  }
}

/** Pancake vừa trả 429: cả Page nghỉ `milliseconds` trước lần gọi kế tiếp. */
export function backoffPancake(key, milliseconds) {
  const state = stateOf(key);
  state.blockedUntil = Math.max(state.blockedUntil, Date.now() + Math.max(0, Number(milliseconds) || 0));
}

/** Tình trạng hàng đợi (chẩn đoán / test). */
export function pancakeRateLimitState(key) {
  const state = stateOf(key);
  return { active: state.active, waiting: state.queue.length, blockedUntil: state.blockedUntil };
}
