// ショートカットの照合を、キーボードの配列に合わせて行う(仕様書 第2.10節 C-10)。
//
// 【何が起きていたか(2026-11 の点検)】
// 記号のショートカット(Ctrl+[ 、Ctrl+] 、Ctrl+\ 、Ctrl+= など)を、押されたキーの「位置」
// (KeyboardEvent.code)だけで判定していた。code は英語配列での名前なので、英語キーボードでは
// 刻印どおりに動く。日本語キーボードは記号の並びが違うため、刻印とずれた。
//   ・「[」と刻印されたキーの code は BracketRight → Ctrl+[ のつもりが Ctrl+](インデント解除)になる
//   ・「]」と刻印されたキーの code は Backslash   → Ctrl+] のつもりが Ctrl+\(書式を消去)になる
//   ・「=」は Shift+- で打つ                      → Ctrl+= のつもりが Ctrl+Shift+-(縮小)になる
// メニューに「Ctrl+[」と書いてあるのに、そのキーを押すと別のことが起きていた。
//
// 【どう直したか】
// 今の配列で、そのキーが(Shiftを押さずに)打つ文字を調べ、ショートカットの記号と比べる。
// 文字は navigator.keyboard.getLayoutMap() で分かる(WebView2・Chromiumにある)。
// 配列が分からない間(起動直後・この機能の無い環境)は、従来どおり位置で判定する。
//
// 配列によっては、Shiftを押さずに打てない記号がある(日本語配列の「=」「`」)。
//   ・「=」… その記号の英語配列での位置にあるキー(日本語配列では「^」)を使う。
//            メニューにも「Ctrl+^」と、押すキーの刻印で出す(displayShortcut)。
//            Shift+- で打てるが、それを「=」として受けると Ctrl+Shift+-(縮小)と区別できない
//   ・「`」… 既定のショートカットが Ctrl+Shift+` で、日本語配列では Shift+@ が「`」なので、
//            打たれた文字(e.key)が「`」なら一致とする
//
// 通信・DOMに触れない判定だけをここに置く(.verify-shortcut-keys.mjs が、英語配列と
// 日本語配列の両方で固定する)。配列を調べる側は keyboard-layout.js。

// 記号の、英語配列での位置。配列が分からないとき・その配列に無い記号のときに使う。
export const US_SYMBOL_CODES = {
  "`": "Backquote", "-": "Minus", "=": "Equal", "[": "BracketLeft", "]": "BracketRight", "\\": "Backslash",
  ";": "Semicolon", "'": "Quote", ",": "Comma", ".": "Period", "/": "Slash",
};
const US_CODE_SYMBOLS = Object.fromEntries(Object.entries(US_SYMBOL_CODES).map(([ch, code]) => [code, ch]));

// 円記号とバックスラッシュは、日本語のWindowsでは同じ文字コードの別の見え方。同じキーとして扱う。
const normalize = (ch) => (ch === "¥" ? "\\" : ch);

// 記号のキーか(英数字・名前つきのキー(Enter・F1 など)ではない1文字)。
export function isSymbolKey(key) {
  return key.length === 1 && !/[a-z0-9]/i.test(key);
}

export function parseShortcut(s) {
  const parts = s.split("+");
  const key = parts.pop();
  return {
    key: key.toLowerCase(),
    ctrl: parts.includes("Ctrl"),
    shift: parts.includes("Shift"),
    alt: parts.includes("Alt"),
  };
}

// その配列に、Shiftを押さずにその記号を打てるキーがあるか。
function layoutHasBase(layout, key) {
  for (const ch of layout.values()) if (normalize(ch) === key) return true;
  return false;
}

// 押されたキーが、ショートカットの記号 key に当たるか(修飾キーは別に見る)。
// layout は Map<code, Shiftを押さずに打つ文字>。分からなければ null。
function symbolMatches(e, key, layout) {
  if (!layout) return e.code === US_SYMBOL_CODES[key];
  if (layoutHasBase(layout, key)) {
    if (normalize(layout.get(e.code) ?? "") === key) return true;
    return key === "`" && e.key === "`";
  }
  if (key === "`") return e.key === "`" || e.code === US_SYMBOL_CODES[key];
  return e.code === US_SYMBOL_CODES[key];
}

// キー入力 e が、ショートカット combo(parseShortcut の結果)に当たるか。
export function matchesShortcut(e, combo, layout = null) {
  if (/^[0-9]$/.test(combo.key)) {
    // 数字はすべて位置で判定する。Shiftを押していると e.key は記号になる
    // (日本語キーボードの Shift+1 は「!」、Shift+5 は「%」)ので、e.key で比べると
    // Ctrl+Shift+1〜3(サイドバーの切り替え)や Alt+Shift+5(取り消し線)が一度も一致しなかった
    // (2026-11 の点検。以前は「0」だけを位置で見ていた)。テンキーの数字も同じに扱う。
    if (e.code !== `Digit${combo.key}` && e.code !== `Numpad${combo.key}`) return false;
  } else if (isSymbolKey(combo.key)) {
    if (!symbolMatches(e, combo.key, layout)) return false;
  } else if ((e.key ?? "").toLowerCase() !== combo.key) {
    return false;
  }
  if ((e.ctrlKey || e.metaKey) !== combo.ctrl) return false;
  if (e.shiftKey !== combo.shift) return false;
  if (e.altKey !== combo.alt) return false;
  return true;
}

// メニューなどに出すショートカットの文字。その配列で実際に押すキーの刻印に合わせる
// (日本語配列では「Ctrl+=」を「Ctrl+^」と出す)。配列が分からなければそのまま。
export function displayShortcut(shortcut, layout = null) {
  if (!shortcut || !layout) return shortcut;
  const i = shortcut.lastIndexOf("+", shortcut.length - 2);
  const key = shortcut.slice(i + 1);
  if (!isSymbolKey(key) || key === "`" || layoutHasBase(layout, key)) return shortcut;
  const actual = layout.get(US_SYMBOL_CODES[key]);
  if (!actual || !isSymbolKey(actual)) return shortcut;
  return shortcut.slice(0, i + 1) + actual;
}

// キー入力 e から、ショートカットの文字列に書くキーの名前を作る(設定のキー割り当ての登録用)。
// matchesShortcut が同じ入力に一致する名前を返すこと。
export function keyNameFromEvent(e, layout = null) {
  const digit = /^(?:Digit|Numpad)([0-9])$/.exec(e.code ?? "");
  if (digit) return digit[1];
  if (layout) {
    const base = normalize(layout.get(e.code) ?? "");
    if (base && isSymbolKey(base)) {
      // その配列に無い記号の位置にあるキー(日本語配列の「^」)は、英語配列での名前(「=」)で持つ。
      // 既定のショートカットと同じ書き方にそろえ、表示のときに刻印へ直す。
      const us = US_CODE_SYMBOLS[e.code];
      if (us && us !== "`" && !layoutHasBase(layout, us)) return us;
      return base;
    }
  } else if (US_CODE_SYMBOLS[e.code]) {
    return US_CODE_SYMBOLS[e.code];
  }
  const key = e.key ?? "";
  return key.length === 1 ? key.toUpperCase() : key;
}
