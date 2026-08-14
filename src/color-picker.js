// コード中のカラープレビュー・カラーピッカー(docs/カラープレビュー仕様.md 第2〜4章)。
// 色文字列の認識・パース・書式整形(元の記法への書き戻し)・コントラスト計算をまとめたモジュール。
// 外部通信ゼロの原則(CLAUDE.md)により、色空間変換・コントラスト計算は
// すべて自前実装する(CDN・外部の色ライブラリは使わない)。
// CodeMirrorのViewやDecorationには依存させず(依存はsrc/editor.js側だけに閉じる)、
// 「色の数学」だけを提供する自己完結モジュールにする。
//
// カラーピッカーパネルのDOM構築・操作(openColorPickerPanel)・配色パレット生成・
// 補助表記(toHexDisplay等)は src/color-picker-panel.js に分離してある(初期ロードJS削減、
// 仕様書 第8.4節)。ここに残すのは本文の色プレビュー表示(常時の装飾、editor.js側で
// visibleRangesごとに毎回呼ばれる)が必要とする「認識・パース・コントラスト計算」だけ。
// formatColorLiteral(編集後の書き戻し)も「色を変更…」でパネルを開いたときにしか
// 呼ばれないため、パネルと一緒にcolor-picker-panel.js側へ移してある。

// ---- CSS色名を認識してよい言語(仕様書 第2節の表の備考) ----
export const CSS_COLOR_LANGS = new Set(["css", "scss", "less", "sass", "stylus"]);

// ---- CSS Color Module Level 4 の拡張色名(147色)。仕様書は対象を絞っていないため
// 標準の名前付き色を一通り列挙する。値は6桁hex(小文字)。----
export const CSS_COLOR_NAMES = {
  aliceblue: "f0f8ff", antiquewhite: "faebd7", aqua: "00ffff", aquamarine: "7fffd4", azure: "f0ffff",
  beige: "f5f5dc", bisque: "ffe4c4", black: "000000", blanchedalmond: "ffebcd", blue: "0000ff",
  blueviolet: "8a2be2", brown: "a52a2a", burlywood: "deb887", cadetblue: "5f9ea0", chartreuse: "7fff00",
  chocolate: "d2691e", coral: "ff7f50", cornflowerblue: "6495ed", cornsilk: "fff8dc", crimson: "dc143c",
  cyan: "00ffff", darkblue: "00008b", darkcyan: "008b8b", darkgoldenrod: "b8860b", darkgray: "a9a9a9",
  darkgreen: "006400", darkgrey: "a9a9a9", darkkhaki: "bdb76b", darkmagenta: "8b008b", darkolivegreen: "556b2f",
  darkorange: "ff8c00", darkorchid: "9932cc", darkred: "8b0000", darksalmon: "e9967a", darkseagreen: "8fbc8f",
  darkslateblue: "483d8b", darkslategray: "2f4f4f", darkslategrey: "2f4f4f", darkturquoise: "00ced1",
  darkviolet: "9400d3", deeppink: "ff1493", deepskyblue: "00bfff", dimgray: "696969", dimgrey: "696969",
  dodgerblue: "1e90ff", firebrick: "b22222", floralwhite: "fffaf0", forestgreen: "228b22", fuchsia: "ff00ff",
  gainsboro: "dcdcdc", ghostwhite: "f8f8ff", gold: "ffd700", goldenrod: "daa520", gray: "808080",
  green: "008000", greenyellow: "adff2f", grey: "808080", honeydew: "f0fff0", hotpink: "ff69b4",
  indianred: "cd5c5c", indigo: "4b0082", ivory: "fffff0", khaki: "f0e68c", lavender: "e6e6fa",
  lavenderblush: "fff0f5", lawngreen: "7cfc00", lemonchiffon: "fffacd", lightblue: "add8e6",
  lightcoral: "f08080", lightcyan: "e0ffff", lightgoldenrodyellow: "fafad2", lightgray: "d3d3d3",
  lightgreen: "90ee90", lightgrey: "d3d3d3", lightpink: "ffb6c1", lightsalmon: "ffa07a",
  lightseagreen: "20b2aa", lightskyblue: "87cefa", lightslategray: "778899", lightslategrey: "778899",
  lightsteelblue: "b0c4de", lightyellow: "ffffe0", lime: "00ff00", limegreen: "32cd32", linen: "faf0e6",
  magenta: "ff00ff", maroon: "800000", mediumaquamarine: "66cdaa", mediumblue: "0000cd",
  mediumorchid: "ba55d3", mediumpurple: "9370db", mediumseagreen: "3cb371", mediumslateblue: "7b68ee",
  mediumspringgreen: "00fa9a", mediumturquoise: "48d1cc", mediumvioletred: "c71585", midnightblue: "191970",
  mintcream: "f5fffa", mistyrose: "ffe4e1", moccasin: "ffe4b5", navajowhite: "ffdead", navy: "000080",
  oldlace: "fdf5e6", olive: "808000", olivedrab: "6b8e23", orange: "ffa500", orangered: "ff4500",
  orchid: "da70d6", palegoldenrod: "eee8aa", palegreen: "98fb98", paleturquoise: "afeeee",
  palevioletred: "db7093", papayawhip: "ffefd5", peachpuff: "ffdab9", peru: "cd853f", pink: "ffc0cb",
  plum: "dda0dd", powderblue: "b0e0e6", purple: "800080", rebeccapurple: "663399", red: "ff0000",
  rosybrown: "bc8f8f", royalblue: "4169e1", saddlebrown: "8b4513", salmon: "fa8072", sandybrown: "f4a460",
  seagreen: "2e8b57", seashell: "fff5ee", sienna: "a0522d", silver: "c0c0c0", skyblue: "87ceeb",
  slateblue: "6a5acd", slategray: "708090", slategrey: "708090", snow: "fffafa", springgreen: "00ff7f",
  steelblue: "4682b4", tan: "d2b48c", teal: "008080", thistle: "d8bfd8", tomato: "ff6347",
  turquoise: "40e0d0", violet: "ee82ee", wheat: "f5deb3", white: "ffffff", whitesmoke: "f5f5f5",
  yellow: "ffff00", yellowgreen: "9acd32",
};
// clamp/clampIntはcolor-picker-panel.js側(パレット生成・数値入力欄の丸め等)からも
// 使うためexportする。
export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
export const clampInt = (v) => Math.round(clamp(v, 0, 255));

// ---- 認識する記法(仕様書 第2節) ----
// 直前が英数字・"_"の場合は無視するため、hexだけ否定後読みを付ける
// (rgb()/hsl()/色名は先頭が識別子的な文字列のため\bで足りる)。
const NUM = "[+-]?(?:\\d+\\.?\\d*|\\.\\d+)%?";
const HEX_RE = /(?<![A-Za-z0-9_])#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{4}|[0-9a-fA-F]{3})\b/g;
const RGB_RE = new RegExp(`\\brgba?\\(\\s*(${NUM})\\s*[,\\s]\\s*(${NUM})\\s*[,\\s]\\s*(${NUM})\\s*(?:[,/]\\s*(${NUM})\\s*)?\\)`, "gi");
const RGB_EXEC_RE = new RegExp(RGB_RE.source, "i");
const HSL_RE = new RegExp(`\\bhsla?\\(\\s*(${NUM})(?:deg)?\\s*[,\\s]\\s*(${NUM})\\s*[,\\s]\\s*(${NUM})\\s*(?:[,/]\\s*(${NUM})\\s*)?\\)`, "gi");
const HSL_EXEC_RE = new RegExp(HSL_RE.source, "i");
let nameRe = null;
function getNameRe() {
  if (!nameRe) {
    const names = Object.keys(CSS_COLOR_NAMES).sort((a, b) => b.length - a.length);
    nameRe = new RegExp(`\\b(${names.join("|")})\\b`, "gi");
  }
  return nameRe;
}

// テキスト中の色リテラル一覧を返す(仕様書 第2節)。行単位など短い範囲に対して呼ぶ想定
// (性能要件: 呼び出し側がview.visibleRangesの範囲だけに絞って渡す)。
// allowNames: CSS系言語の時だけtrueにする(色名はそれ以外の言語では識別子と紛れるため)。
export function findColorMatches(text, allowNames) {
  const found = [];
  for (const m of text.matchAll(HEX_RE)) found.push({ from: m.index, to: m.index + m[0].length, raw: m[0], kind: "hex" });
  for (const m of text.matchAll(RGB_RE)) found.push({ from: m.index, to: m.index + m[0].length, raw: m[0], kind: "rgb" });
  for (const m of text.matchAll(HSL_RE)) found.push({ from: m.index, to: m.index + m[0].length, raw: m[0], kind: "hsl" });
  if (allowNames) {
    for (const m of text.matchAll(getNameRe())) {
      if (!CSS_COLOR_NAMES[m[1].toLowerCase()]) continue;
      found.push({ from: m.index, to: m.index + m[0].length, raw: m[0], kind: "name" });
    }
  }
  found.sort((a, b) => a.from - b.from || b.to - a.to);
  const out = [];
  let lastEnd = -1;
  for (const f of found) { if (f.from >= lastEnd) { out.push(f); lastEnd = f.to; } }
  return out;
}

function toChannel(raw) {
  const v = parseFloat(raw);
  if (!Number.isFinite(v)) return 0;
  return raw.trim().endsWith("%") ? clampInt((v / 100) * 255) : clampInt(v);
}
function toAlpha(raw) {
  if (raw == null) return 1;
  const v = parseFloat(raw);
  if (!Number.isFinite(v)) return 1;
  return raw.trim().endsWith("%") ? clamp(v / 100, 0, 1) : clamp(v, 0, 1);
}
function hasCommaBeforeSlash(raw) {
  const body = raw.slice(raw.indexOf("(") + 1, raw.lastIndexOf(")"));
  const beforeAlpha = body.split("/")[0];
  return beforeAlpha.includes(",");
}

// ---- HSL <-> RGB(0-255) ----
export function hslToRgb({ h, s, l }) {
  const hh = ((h % 360) + 360) % 360 / 360;
  const ss = clamp(s, 0, 100) / 100;
  const ll = clamp(l, 0, 100) / 100;
  if (ss === 0) { const v = clampInt(ll * 255); return { r: v, g: v, b: v }; }
  const q = ll < 0.5 ? ll * (1 + ss) : ll + ss - ll * ss;
  const p = 2 * ll - q;
  const hue2rgb = (t0) => {
    let t = t0; if (t < 0) t += 1; if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  return {
    r: clampInt(hue2rgb(hh + 1 / 3) * 255),
    g: clampInt(hue2rgb(hh) * 255),
    b: clampInt(hue2rgb(hh - 1 / 3) * 255),
  };
}
export function rgbToHsl({ r, g, b }) {
  const rr = r / 255, gg = g / 255, bb = b / 255;
  const max = Math.max(rr, gg, bb), min = Math.min(rr, gg, bb);
  const l = (max + min) / 2;
  if (max === min) return { h: 0, s: 0, l: l * 100 };
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h;
  switch (max) {
    case rr: h = (gg - bb) / d + (gg < bb ? 6 : 0); break;
    case gg: h = (bb - rr) / d + 2; break;
    default: h = (rr - gg) / d + 4; break;
  }
  return { h: h * 60, s: s * 100, l: l * 100 };
}

// ---- パース(仕様書 第2節) ----
// notationに元の書式(桁数・区切り・大文字小文字など)を残し、formatColorLiteralで
// 書き戻すときにそのまま踏襲できるようにする(仕様書 4.3「表記は元のリテラルに合わせる」)。
export function parseColorLiteral(raw) {
  if (!raw) return null;
  if (raw[0] === "#") return parseHex(raw);
  const lower = raw.toLowerCase();
  if (lower.startsWith("rgb")) return parseRgb(raw);
  if (lower.startsWith("hsl")) return parseHsl(raw);
  if (CSS_COLOR_NAMES[lower]) return parseName(raw);
  return null;
}
function parseHex(raw) {
  const hex = raw.slice(1);
  const len = hex.length;
  if (![3, 4, 6, 8].includes(len)) return null;
  const upper = /[A-F]/.test(hex);
  const two = (h) => parseInt(h.length === 1 ? h + h : h, 16);
  let r, g, b, a = 1;
  if (len === 3 || len === 4) {
    r = two(hex[0]); g = two(hex[1]); b = two(hex[2]);
    if (len === 4) a = two(hex[3]) / 255;
  } else {
    r = parseInt(hex.slice(0, 2), 16); g = parseInt(hex.slice(2, 4), 16); b = parseInt(hex.slice(4, 6), 16);
    if (len === 8) a = parseInt(hex.slice(6, 8), 16) / 255;
  }
  return { r, g, b, a, notation: { kind: "hex", hexLen: len, upper } };
}
function parseRgb(raw) {
  const m = raw.match(RGB_EXEC_RE);
  if (!m) return null;
  const r = toChannel(m[1]), g = toChannel(m[2]), b = toChannel(m[3]);
  const a = toAlpha(m[4]);
  return { r, g, b, a, notation: { kind: "rgb", hasAlpha: m[4] != null, commaStyle: hasCommaBeforeSlash(raw) } };
}
function parseHsl(raw) {
  const m = raw.match(HSL_EXEC_RE);
  if (!m) return null;
  const h = ((parseFloat(m[1]) % 360) + 360) % 360;
  const s = clamp(parseFloat(m[2]), 0, 100);
  const l = clamp(parseFloat(m[3]), 0, 100);
  const a = toAlpha(m[4]);
  const { r, g, b } = hslToRgb({ h, s, l });
  return { r, g, b, a, notation: { kind: "hsl", hasAlpha: m[4] != null, commaStyle: hasCommaBeforeSlash(raw) } };
}
function parseName(raw) {
  const hex = CSS_COLOR_NAMES[raw.toLowerCase()];
  if (!hex) return null;
  return {
    r: parseInt(hex.slice(0, 2), 16), g: parseInt(hex.slice(2, 4), 16), b: parseInt(hex.slice(4, 6), 16), a: 1,
    notation: { kind: "name" },
  };
}

// ---- コントラスト計算(仕様書 3.2、WCAG) ----
function srgbToLinear(c) {
  const cs = c / 255;
  return cs <= 0.03928 ? cs / 12.92 : Math.pow((cs + 0.055) / 1.055, 2.4);
}
export function relativeLuminance({ r, g, b }) {
  return 0.2126 * srgbToLinear(r) + 0.7152 * srgbToLinear(g) + 0.0722 * srgbToLinear(b);
}
export function contrastRatio(rgb1, rgb2) {
  const l1 = relativeLuminance(rgb1), l2 = relativeLuminance(rgb2);
  const lighter = Math.max(l1, l2), darker = Math.min(l1, l2);
  return (lighter + 0.05) / (darker + 0.05);
}
function mixRgb(a, b, t) {
  return { r: a.r + (b.r - a.r) * t, g: a.g + (b.g - a.g) * t, b: a.b + (b.b - a.b) * t };
}
// アルファ付きの色を背景に合成して不透明化してから、背景とのコントラスト比が3.0以上に
// なるまで文字色(--ink)へ5%刻みで混ぜる(仕様書 3.2の手順そのまま)。
export function readableTextColor(rgba, bgRgb, inkRgb) {
  const composed = rgba.a >= 1 ? { r: rgba.r, g: rgba.g, b: rgba.b } : mixRgb(bgRgb, { r: rgba.r, g: rgba.g, b: rgba.b }, rgba.a);
  if (contrastRatio(composed, bgRgb) >= 3.0) return composed;
  for (let step = 1; step <= 20; step++) {
    const mixed = mixRgb(composed, inkRgb, step * 0.05);
    if (contrastRatio(mixed, bgRgb) >= 3.0) return mixed;
  }
  return inkRgb;
}

