// 今のキーボードの配列(どのキーが、Shiftを押さずにどの文字を打つか)を調べて持っておく。
// 使い道は shortcut-keys.js(記号のショートカットを、キーの刻印どおりに効かせる)。
//
// navigator.keyboard.getLayoutMap() は結果が後から届くので、起動時に調べ始め、届くまでは null を返す
// (その間は、従来どおりキーの位置で判定される)。配列は使っている途中で切り替えられる
// (言語バー)ので、ウィンドウが前面に戻るたびに調べ直す。調べるのは軽く、キー入力のたびには行わない。

let layout = null;
const listeners = new Set();

async function refresh() {
  try {
    const map = await navigator.keyboard?.getLayoutMap?.();
    if (!map) return;
    const next = new Map(map.entries());
    const changed = !layout || next.size !== layout.size || [...next].some(([code, ch]) => layout.get(code) !== ch);
    layout = next;
    if (changed) for (const fn of listeners) fn(layout);
  } catch {
    // 調べられない環境(この機能の無いブラウザ・許可されていない枠)では null のまま。
  }
}

// 起動時に1回呼ぶ。onChange は、配列が分かったとき・変わったときに呼ばれる
// (メニューに出すショートカットの文字を作り直すため)。
export function initKeyboardLayout(onChange) {
  if (onChange) listeners.add(onChange);
  refresh();
  window.addEventListener("focus", refresh);
}

// 今の配列。まだ分からなければ null。
export function getKeyboardLayout() {
  return layout;
}
