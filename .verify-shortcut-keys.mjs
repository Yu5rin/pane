// 記号のショートカットを、キーボードの配列に合わせて(キーの刻印どおりに)判定する処理の検査。
// ブラウザは使わない(src/shortcut-keys.js は通信にもDOMにも触れない判定だけを持つ)。
//
// 2026-11 の点検まで、記号のキーは位置(KeyboardEvent.code = 英語配列での名前)だけで判定していた。
// 日本語キーボードでは「[」のキーを押すと Ctrl+] の動きになるなど、刻印とずれていた。
// 英語配列で動きが変わっていないこと、日本語配列で刻印どおりになることを、両方の配列で固定する。
import { parseShortcut, matchesShortcut, displayShortcut, keyNameFromEvent } from "./src/shortcut-keys.js";

let ng = 0;
const ok = (label, cond, detail) => {
  console.log(`${cond ? "OK  " : "NG  "} ${label}${cond || detail === undefined ? "" : `\n     実際: ${JSON.stringify(detail)}`}`);
  if (!cond) ng++;
};

// 配列: キーの位置(code) → Shiftを押さずに打つ文字。
const US = new Map(Object.entries({
  Backquote: "`", Minus: "-", Equal: "=", BracketLeft: "[", BracketRight: "]", Backslash: "\\",
  Semicolon: ";", Quote: "'", Comma: ",", Period: ".", Slash: "/", KeyA: "a", Digit1: "1",
}));
// 日本語配列(106/109キー)。「=」「`」は、Shiftを押さずには打てない。
const JIS = new Map(Object.entries({
  Minus: "-", Equal: "^", IntlYen: "¥", BracketLeft: "@", BracketRight: "[", Backslash: "]",
  Semicolon: ";", Quote: ":", Comma: ",", Period: ".", Slash: "/", IntlRo: "\\", KeyA: "a", Digit1: "1",
}));
// キー入力。key は、その配列でそのキーが(Shiftの有無に応じて)打つ文字。
const ev = (code, key, mods = "") => ({ code, key, ctrlKey: mods.includes("C"), shiftKey: mods.includes("S"), altKey: mods.includes("A"), metaKey: false });
const hit = (shortcut, e, layout) => matchesShortcut(e, parseShortcut(shortcut), layout);

// ---- 英語配列: これまでと同じキーで動く ----
ok("US: Ctrl+[ は「[」のキー", hit("Ctrl+[", ev("BracketLeft", "[", "C"), US));
ok("US: Ctrl+] は「]」のキー", hit("Ctrl+]", ev("BracketRight", "]", "C"), US));
ok("US: Ctrl+\\ は「\\」のキー", hit("Ctrl+\\", ev("Backslash", "\\", "C"), US));
ok("US: Ctrl+= は「=」のキー", hit("Ctrl+=", ev("Equal", "=", "C"), US));
ok("US: Ctrl+Shift+= は Shift+「=」(打つ文字は「+」)", hit("Ctrl+Shift+=", ev("Equal", "+", "CS"), US));
ok("US: Ctrl+Shift+- は Shift+「-」(打つ文字は「_」)", hit("Ctrl+Shift+-", ev("Minus", "_", "CS"), US));
ok("US: Ctrl+Shift+[ は Shift+「[」(打つ文字は「{」)", hit("Ctrl+Shift+[", ev("BracketLeft", "{", "CS"), US));
ok("US: Ctrl+Shift+` は Shift+「`」(打つ文字は「~」)", hit("Ctrl+Shift+`", ev("Backquote", "~", "CS"), US));
ok("US: Ctrl+, と Ctrl+/", hit("Ctrl+,", ev("Comma", ",", "C"), US) && hit("Ctrl+/", ev("Slash", "/", "C"), US));
ok("US: Ctrl+[ のキーで Ctrl+] は動かない", !hit("Ctrl+]", ev("BracketLeft", "[", "C"), US));
ok("US: 表示はそのまま", displayShortcut("Ctrl+=", US) === "Ctrl+=" && displayShortcut("Ctrl+Shift+[", US) === "Ctrl+Shift+[");

// ---- 日本語配列: キーの刻印どおりに動く ----
// 以前は「[」のキー(位置は BracketRight)で Ctrl+] が、「]」のキー(位置は Backslash)で Ctrl+\ が動いていた。
ok("JIS: 「[」のキーで Ctrl+[ が動く", hit("Ctrl+[", ev("BracketRight", "[", "C"), JIS));
ok("JIS: 「[」のキーで Ctrl+] は動かない(以前はこちらが動いていた)", !hit("Ctrl+]", ev("BracketRight", "[", "C"), JIS));
ok("JIS: 「]」のキーで Ctrl+] が動く", hit("Ctrl+]", ev("Backslash", "]", "C"), JIS));
ok("JIS: 「]」のキーで Ctrl+\\ は動かない(以前はこちらが動いていた)", !hit("Ctrl+\\", ev("Backslash", "]", "C"), JIS));
ok("JIS: 「¥」のキーでも「ろ」のキーでも Ctrl+\\ が動く", hit("Ctrl+\\", ev("IntlYen", "\\", "C"), JIS) && hit("Ctrl+\\", ev("IntlRo", "\\", "C"), JIS));
ok("JIS: 「@」のキーでは Ctrl+[ は動かない(以前はこちらが動いていた)", !hit("Ctrl+[", ev("BracketLeft", "@", "C"), JIS));
ok("JIS: Shift+「[」で Ctrl+Shift+[ が動く", hit("Ctrl+Shift+[", ev("BracketRight", "{", "CS"), JIS));
ok("JIS: Alt+[ と Ctrl+Alt+] も刻印どおり", hit("Alt+[", ev("BracketRight", "[", "A"), JIS) && hit("Ctrl+Alt+]", ev("Backslash", "]", "CA"), JIS));
// 「=」は Shift を押さずには打てない。英語配列での位置にある「^」のキーを使う。
ok("JIS: Ctrl+= は「^」のキー", hit("Ctrl+=", ev("Equal", "^", "C"), JIS));
ok("JIS: Ctrl+Shift+= は Shift+「^」", hit("Ctrl+Shift+=", ev("Equal", "~", "CS"), JIS));
// Shift+「-」は「=」を打つが、それを Ctrl+= として受けると Ctrl+Shift+-(縮小)と区別できない。
ok("JIS: Shift+「-」は Ctrl+Shift+-(縮小)として動く", hit("Ctrl+Shift+-", ev("Minus", "=", "CS"), JIS));
ok("JIS: Shift+「-」で Ctrl+= や Ctrl+Shift+= は動かない", !hit("Ctrl+=", ev("Minus", "=", "CS"), JIS) && !hit("Ctrl+Shift+=", ev("Minus", "=", "CS"), JIS));
ok("JIS: 「-」のキーで Ctrl+- が動く", hit("Ctrl+-", ev("Minus", "-", "C"), JIS));
// 「`」は Shift+「@」。
ok("JIS: Shift+「@」(打つ文字は「`」)で Ctrl+Shift+` が動く", hit("Ctrl+Shift+`", ev("BracketLeft", "`", "CS"), JIS));
ok("JIS: 表示は押すキーの刻印に合わせる(Ctrl+= → Ctrl+^)", displayShortcut("Ctrl+=", JIS) === "Ctrl+^" && displayShortcut("Ctrl+Shift+=", JIS) === "Ctrl+Shift+^");
ok("JIS: その配列にある記号の表示は変えない", displayShortcut("Ctrl+[", JIS) === "Ctrl+[" && displayShortcut("Ctrl+Shift+`", JIS) === "Ctrl+Shift+`" && displayShortcut("Ctrl+B", JIS) === "Ctrl+B");

// ---- 配列が分からないとき: これまでどおり位置で判定する ----
ok("配列不明: Ctrl+[ は BracketLeft の位置", hit("Ctrl+[", ev("BracketLeft", "[", "C"), null) && !hit("Ctrl+[", ev("BracketRight", "]", "C"), null));
ok("配列不明: 表示はそのまま", displayShortcut("Ctrl+=", null) === "Ctrl+=");

// ---- 数字・文字・名前つきのキー ----
ok("Ctrl+Shift+1 は、打つ文字が「!」でも一致する", hit("Ctrl+Shift+1", ev("Digit1", "!", "CS"), JIS));
ok("Alt+Shift+5 は、打つ文字が「%」でも一致する", hit("Alt+Shift+5", ev("Digit5", "%", "AS"), US));
ok("テンキーの数字でも一致する", hit("Ctrl+1", ev("Numpad1", "1", "C"), US));
ok("Ctrl+B / F3 / Ctrl+Shift+Backspace", hit("Ctrl+B", ev("KeyB", "b", "C"), JIS) && hit("F3", ev("F3", "F3", ""), JIS) && hit("Ctrl+Shift+Backspace", ev("Backspace", "Backspace", "CS"), JIS));
ok("修飾キーが違えば一致しない", !hit("Ctrl+B", ev("KeyB", "B", "CS"), US) && !hit("Ctrl+[", ev("BracketLeft", "[", "CA"), US));

// ---- 設定でキーを登録するとき: 登録した名前が、同じキー入力に一致する ----
for (const [name, layout, e] of [
  ["US 「[」", US, ev("BracketLeft", "[", "C")],
  ["JIS 「[」", JIS, ev("BracketRight", "[", "C")],
  ["JIS 「]」", JIS, ev("Backslash", "]", "C")],
  ["JIS 「^」", JIS, ev("Equal", "^", "C")],
  ["JIS 「@」", JIS, ev("BracketLeft", "@", "C")],
  ["JIS 「:」", JIS, ev("Quote", ":", "C")],
  ["JIS Shift+1", JIS, ev("Digit1", "!", "CS")],
  ["配列不明 「[」", null, ev("BracketLeft", "[", "C")],
  ["US 文字キー", US, ev("KeyK", "k", "C")],
]) {
  const key = keyNameFromEvent(e, layout);
  const combo = `${e.ctrlKey ? "Ctrl+" : ""}${e.shiftKey ? "Shift+" : ""}${e.altKey ? "Alt+" : ""}${key}`;
  ok(`登録: ${name} → 「${combo}」が、同じキー入力に一致する`, hit(combo, e, layout), combo);
}
ok("登録: JISの「^」は、既定と同じ書き方(=)で持ち、表示で「^」に直す", keyNameFromEvent(ev("Equal", "^", "C"), JIS) === "=" && displayShortcut("Ctrl+=", JIS) === "Ctrl+^");

console.log(`--- 集計: NG=${ng}`);
process.exit(ng === 0 ? 0 : 1);
