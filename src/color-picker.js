// コード中のカラープレビュー・カラーピッカー(docs/カラープレビュー仕様.md 第2〜4章)。
// 色文字列の認識・パース・整形、コントラスト計算、配色パレット生成、
// カラーピッカーパネルのDOM構築・操作をまとめたモジュール。
// 外部通信ゼロの原則(CLAUDE.md)により、色空間変換・パレット生成・コントラスト計算は
// すべて自前実装する(CDN・外部の色ライブラリは使わない)。
// CodeMirrorのViewやDecorationには依存させず(依存はsrc/editor.js側だけに閉じる)、
// 「色の数学」と「パネルのDOM/操作」だけを提供する自己完結モジュールにする。

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
const NAME_BY_HEX = (() => {
  const m = new Map();
  for (const [name, hex] of Object.entries(CSS_COLOR_NAMES)) if (!m.has(hex)) m.set(hex, name);
  return m;
})();

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const clampInt = (v) => Math.round(clamp(v, 0, 255));

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

// ---- 整形(元のリテラルの記法に書き戻す。仕様書 4.3) ----
function toHex2(n, upper) { const s = clampInt(n).toString(16).padStart(2, "0"); return upper ? s.toUpperCase() : s; }
function canBeShort(n) { return clampInt(n) % 17 === 0; }
function fmtAlphaNum(a) {
  const r = Math.round(clamp(a, 0, 1) * 100) / 100;
  return String(r);
}
function formatHex(r, g, b, a, notation) {
  const upper = !!notation.upper;
  const wantShort = notation.hexLen === 3 || notation.hexLen === 4;
  const wantAlpha = notation.hexLen === 4 || notation.hexLen === 8;
  const alpha255 = clampInt(a * 255);
  if (wantShort) {
    const shortOk = canBeShort(r) && canBeShort(g) && canBeShort(b) && (!wantAlpha || canBeShort(alpha255));
    if (shortOk) {
      const h1 = (n) => { const s = (clampInt(n) / 17).toString(16); return upper ? s.toUpperCase() : s; };
      let s = "#" + h1(r) + h1(g) + h1(b);
      if (wantAlpha) s += h1(alpha255);
      return s;
    }
    // 3/4桁で表現できない色になった場合のみ6/8桁へ広げる(仕様書 4.3)
  }
  let s = "#" + toHex2(r, upper) + toHex2(g, upper) + toHex2(b, upper);
  if (wantAlpha) s += toHex2(alpha255, upper);
  return s;
}
function formatRgb(r, g, b, a, notation) {
  const hasAlpha = !!notation.hasAlpha;
  const fn = hasAlpha ? "rgba" : "rgb";
  const sep = notation.commaStyle ? ", " : " ";
  let body = `${r}${sep}${g}${sep}${b}`;
  if (hasAlpha) body += `${notation.commaStyle ? ", " : " / "}${fmtAlphaNum(a)}`;
  return `${fn}(${body})`;
}
function formatHsl(r, g, b, a, notation) {
  const { h, s, l } = rgbToHsl({ r, g, b });
  const hasAlpha = !!notation.hasAlpha;
  const fn = hasAlpha ? "hsla" : "hsl";
  const sep = notation.commaStyle ? ", " : " ";
  let body = `${Math.round(h)}${sep}${Math.round(s)}%${sep}${Math.round(l)}%`;
  if (hasAlpha) body += `${notation.commaStyle ? ", " : " / "}${fmtAlphaNum(a)}`;
  return `${fn}(${body})`;
}
export function formatColorLiteral({ r, g, b, a }, notation) {
  const rr = clampInt(r), gg = clampInt(g), bb = clampInt(b), aa = clamp(a ?? 1, 0, 1);
  switch (notation.kind) {
    case "hex": return formatHex(rr, gg, bb, aa, notation);
    case "rgb": return formatRgb(rr, gg, bb, aa, notation);
    case "hsl": return formatHsl(rr, gg, bb, aa, notation);
    case "name": {
      // 色名は近似できないため、編集後もぴったり一致する名前があればそれを保つ。
      // 一致しなくなった場合は6桁hexへ切り替える(仕様書はこのケースを明記していないための
      // 自前の判断。3桁hexの「表現できない値は広げる」規則と同じ考え方を色名にも適用した)。
      const hex = toHex2(rr, false) + toHex2(gg, false) + toHex2(bb, false);
      const name = NAME_BY_HEX.get(hex);
      return name ?? formatHex(rr, gg, bb, aa, { hexLen: 6, upper: false });
    }
    default: return formatHex(rr, gg, bb, aa, { hexLen: 6, upper: false });
  }
}
// 補助表記(プレビュー・ツールチップ用。表記スタイルは常に一定の見せ方で良い)
export function toHexDisplay({ r, g, b, a }, { withAlpha = false } = {}) {
  let s = "#" + toHex2(r, true) + toHex2(g, true) + toHex2(b, true);
  if (withAlpha && a < 1) s += toHex2(clampInt(a * 255), true);
  return s;
}
export function toRgbDisplay({ r, g, b, a }) {
  return a < 1 ? `RGB(${clampInt(r)}, ${clampInt(g)}, ${clampInt(b)}, ${fmtAlphaNum(a)})` : `RGB(${clampInt(r)}, ${clampInt(g)}, ${clampInt(b)})`;
}
export function toHslDisplay(rgba) {
  const { h, s, l } = rgbToHsl(rgba);
  const base = `HSL(${Math.round(h)}°, ${Math.round(s)}%, ${Math.round(l)}%)`;
  return rgba.a < 1 ? base.slice(0, -1) + `, ${fmtAlphaNum(rgba.a)})` : base;
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

// ---- 配色パレット生成(仕様書 4.2) ----
const norm360 = (h) => ((h % 360) + 360) % 360;
const clampPct = (v) => clamp(v, 0, 100);
export function buildPalettes({ r, g, b }) {
  const { h, s, l } = rgbToHsl({ r, g, b });
  const mk = (hh, ss, ll) => hslToRgb({ h: norm360(hh), s: clampPct(ss), l: clampPct(ll) });
  return {
    monochrome: [-30, -15, 0, 15, 30].map((d) => mk(h, s, l + d)),
    analogous: [-30, -15, 0, 15, 30].map((d) => mk(h + d, s, l)),
    complementary: [mk(h, s, l + 15), mk(h, s, l), mk(h, s, l - 15), mk(h + 180, s, l), mk(h + 180, s, l - 15)],
    triadic: [mk(h, s, l), mk(h + 120, s, l), mk(h + 240, s, l), mk(h, s, l + 15), mk(h + 120, s, l + 15)],
    tetradic: [mk(h, s, l), mk(h + 90, s, l), mk(h + 180, s, l), mk(h + 270, s, l), mk(h, s, l + 15)],
  };
}
export const PALETTE_LABELS = [
  ["monochrome", "単色"], ["analogous", "類似色"], ["complementary", "補色"],
  ["triadic", "三角配色"], ["tetradic", "四角配色"],
];

// ---- クリップボードコピー(ベストエフォート。他のコピー処理と同じフォールバック作法) ----
async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return; } catch { /* フォールバックへ */ }
  try {
    const ta = document.createElement("textarea");
    ta.value = text; ta.style.position = "fixed"; ta.style.opacity = "0";
    document.body.appendChild(ta); ta.select(); document.execCommand("copy"); ta.remove();
  } catch { /* コピーはベストエフォート */ }
}

// ---- カラーピッカーパネル(仕様書 第4章) ----
// DOM構築・ドラッグ操作・配色パレット・数値入力・スポイト・位置決めをすべてここで担う。
// CodeMirriorのview/dispatchには一切触れず、色が変わるたびにコールバックで通知するだけに
// することで、テキストへの書き戻し(アンドゥ履歴の扱い含む)はeditor.js側に閉じ込める。
//
// opts:
//   anchorRect: { left, top, right, bottom }  対象リテラルの矩形(重ならないようにする対象)
//   initialColor: parseColorLiteralの戻り値(r,g,b,a,notation)
//   hasAlpha: bool  不透明度スライダーを出すか(元のリテラルがアルファを持っていたか)
//   formatColor(rgba): string  現在の記法(元のリテラルの記法)での表記を返す
//   onChange(rgba): 操作中に随時呼ばれる(ライブ反映用)
//   onCommit(rgba): 確定(パレットクリック/適用ボタン)時に呼ばれる。呼び出し後にパネルを閉じる
//   onCancel(): キャンセル(Esc/外側クリック)時に呼ばれる。呼び出し後にパネルを閉じる
// 戻り値: { close() }  呼び出し側から強制的に閉じたい場合に使う(onCancel等は呼ばれない)
export function openColorPickerPanel(opts) {
  const { anchorRect, initialColor, hasAlpha, formatColor, onChange, onCommit, onCancel } = opts;
  let hsl = rgbToHsl(initialColor);
  let alpha = initialColor.a ?? 1;
  let closed = false;

  const root = document.createElement("div");
  root.className = "color-picker-panel";
  root.tabIndex = -1;
  root.innerHTML = `
    <div class="cp-preview">
      <div class="cp-preview-swatch-wrap"><span class="cp-preview-swatch"></span></div>
      <div class="cp-preview-text">
        <div class="cp-primary"></div>
        <div class="cp-secondary"></div>
      </div>
    </div>
    <div class="cp-sl-box"><div class="cp-sl-gradient"></div><div class="cp-sl-handle"></div></div>
    <div class="cp-hue-slider"><div class="cp-hue-handle"></div></div>
    <div class="cp-alpha-slider" hidden><div class="cp-alpha-track"></div><div class="cp-alpha-handle"></div></div>
    <div class="cp-numeric">
      <label class="cp-num-field">R<input type="number" min="0" max="255" step="1" data-ch="r"></label>
      <label class="cp-num-field">G<input type="number" min="0" max="255" step="1" data-ch="g"></label>
      <label class="cp-num-field">B<input type="number" min="0" max="255" step="1" data-ch="b"></label>
      <label class="cp-num-field cp-num-hex">#<input type="text" maxlength="9" data-ch="hex"></label>
    </div>
    <button type="button" class="cp-eyedropper" hidden title="スポイト">
      <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="m2 22 1-4 12-12"/><path d="M14.5 4.5 17 2l5 5-2.5 2.5"/><path d="m13 8 3 3"/></svg>
      スポイトで取得
    </button>
    <div class="cp-palettes"></div>
    <div class="cp-actions"><button type="button" class="btn tiny cp-apply">適用</button></div>
  `;
  document.body.appendChild(root);

  const $ = (sel) => root.querySelector(sel);
  const previewSwatch = $(".cp-preview-swatch");
  const primaryEl = $(".cp-primary");
  const secondaryEl = $(".cp-secondary");
  const slBox = $(".cp-sl-box");
  const slHandle = $(".cp-sl-handle");
  const hueSlider = $(".cp-hue-slider");
  const hueHandle = $(".cp-hue-handle");
  const alphaSlider = $(".cp-alpha-slider");
  const alphaHandle = $(".cp-alpha-handle");
  const rInput = $('input[data-ch="r"]');
  const gInput = $('input[data-ch="g"]');
  const bInput = $('input[data-ch="b"]');
  const hexInput = $('input[data-ch="hex"]');
  const palettesEl = $(".cp-palettes");
  const applyBtn = $(".cp-apply");

  if (hasAlpha) alphaSlider.hidden = false;
  if (window.EyeDropper) $(".cp-eyedropper").hidden = false;

  function currentRgb() { return hslToRgb(hsl); }
  function currentRgba() { const rgb = currentRgb(); return { r: rgb.r, g: rgb.g, b: rgb.b, a: alpha }; }

  const paletteRows = new Map(); // kind -> [{el, rgb}]
  for (const [kind, label] of PALETTE_LABELS) {
    const group = document.createElement("div");
    group.className = "cp-palette-group";
    const title = document.createElement("div");
    title.className = "cp-palette-title";
    title.textContent = label;
    const row = document.createElement("div");
    row.className = "cp-palette-row";
    group.appendChild(title);
    group.appendChild(row);
    palettesEl.appendChild(group);
    const swatches = [];
    for (let i = 0; i < 5; i++) {
      const sw = document.createElement("button");
      sw.type = "button";
      sw.className = "cp-palette-swatch";
      row.appendChild(sw);
      swatches.push(sw);
    }
    paletteRows.set(kind, swatches);
  }

  function renderPalettes() {
    const palettes = buildPalettes(currentRgb());
    for (const [kind] of PALETTE_LABELS) {
      const rgbs = palettes[kind];
      const swatches = paletteRows.get(kind);
      rgbs.forEach((rgb, i) => {
        const sw = swatches[i];
        sw.style.background = `rgb(${rgb.r},${rgb.g},${rgb.b})`;
        const text = formatColor({ ...rgb, a: 1 });
        sw.title = text;
        sw.dataset.color = text;
        sw.onclick = () => {
          hsl = rgbToHsl(rgb);
          alpha = 1;
          render();
          notifyChange();
          commit();
        };
        sw.oncontextmenu = (e) => {
          e.preventDefault();
          copyText(text);
          showCopyToast(sw);
        };
      });
    }
  }
  function showCopyToast(anchorEl) {
    const existing = anchorEl.querySelector(".cp-copy-toast");
    if (existing) existing.remove();
    const toast = document.createElement("span");
    toast.className = "cp-copy-toast";
    toast.textContent = "コピーしました";
    anchorEl.appendChild(toast);
    setTimeout(() => toast.remove(), 1200);
  }

  function render() {
    const rgba = currentRgba();
    const rgbOpaque = { r: rgba.r, g: rgba.g, b: rgba.b };
    const hueColor = `hsl(${hsl.h},100%,50%)`;
    previewSwatch.style.setProperty("--cp-color", `rgba(${rgba.r},${rgba.g},${rgba.b},${rgba.a})`);
    primaryEl.textContent = formatColor(rgba);
    // 補助表記(仕様書 4.1): 主表記以外の2つを小さく併記する
    const notationKind = opts.initialColor.notation.kind;
    const others = [];
    if (notationKind !== "hex") others.push(toHexDisplay(rgba, { withAlpha: rgba.a < 1 }));
    if (notationKind !== "rgb") others.push(toRgbDisplay(rgba));
    if (notationKind !== "hsl") others.push(toHslDisplay(rgba));
    secondaryEl.textContent = others.join(" ・ ");

    slBox.style.setProperty("--cp-hue", String(hsl.h));
    slHandle.style.left = `${hsl.s}%`;
    slHandle.style.top = `${100 - hsl.l}%`;
    slHandle.style.background = `rgb(${rgbOpaque.r},${rgbOpaque.g},${rgbOpaque.b})`;

    hueHandle.style.left = `${(hsl.h / 360) * 100}%`;

    if (hasAlpha) {
      alphaSlider.style.setProperty("--cp-alpha-color", `${rgbOpaque.r},${rgbOpaque.g},${rgbOpaque.b}`);
      alphaHandle.style.left = `${alpha * 100}%`;
    }

    if (document.activeElement !== rInput) rInput.value = String(rgba.r);
    if (document.activeElement !== gInput) gInput.value = String(rgba.g);
    if (document.activeElement !== bInput) bInput.value = String(rgba.b);
    if (document.activeElement !== hexInput) hexInput.value = toHexDisplay(rgba, { withAlpha: false }).slice(1);

    renderPalettes();
  }

  function notifyChange() { onChange(currentRgba()); }

  // ---- 彩度×明度の四角形(ドラッグ) ----
  function slFromEvent(e) {
    const rect = slBox.getBoundingClientRect();
    const x = clamp((e.clientX - rect.left) / rect.width, 0, 1);
    const y = clamp((e.clientY - rect.top) / rect.height, 0, 1);
    hsl = { h: hsl.h, s: x * 100, l: (1 - y) * 100 };
    render(); notifyChange();
  }
  function bindDrag(el, onMove) {
    el.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return; // 右クリック等では開始しない(既存コードの流儀に合わせる)
      e.preventDefault();
      el.setPointerCapture(e.pointerId);
      onMove(e);
      const move = (ev) => onMove(ev);
      const up = (ev) => { el.releasePointerCapture(ev.pointerId); el.removeEventListener("pointermove", move); el.removeEventListener("pointerup", up); };
      el.addEventListener("pointermove", move);
      el.addEventListener("pointerup", up);
    });
  }
  bindDrag(slBox, slFromEvent);

  // ---- 色相スライダー ----
  function hueFromEvent(e) {
    const rect = hueSlider.getBoundingClientRect();
    const x = clamp((e.clientX - rect.left) / rect.width, 0, 1);
    hsl = { h: x * 360, s: hsl.s, l: hsl.l };
    render(); notifyChange();
  }
  bindDrag(hueSlider, hueFromEvent);

  // ---- 不透明度スライダー ----
  if (hasAlpha) {
    function alphaFromEvent(e) {
      const rect = alphaSlider.getBoundingClientRect();
      const x = clamp((e.clientX - rect.left) / rect.width, 0, 1);
      alpha = x;
      render(); notifyChange();
    }
    bindDrag(alphaSlider, alphaFromEvent);
  }

  // ---- 数値入力(R/G/B、16進。どれを編集しても他が追従する) ----
  function setFromRgb(r, g, b) {
    hsl = rgbToHsl({ r: clampInt(r), g: clampInt(g), b: clampInt(b) });
    render(); notifyChange();
  }
  for (const [inp, ch] of [[rInput, "r"], [gInput, "g"], [bInput, "b"]]) {
    inp.addEventListener("input", () => {
      const rgb = currentRgb();
      const v = clampInt(Number(inp.value));
      setFromRgb(ch === "r" ? v : rgb.r, ch === "g" ? v : rgb.g, ch === "b" ? v : rgb.b);
    });
  }
  hexInput.addEventListener("input", () => {
    const raw = "#" + hexInput.value.replace(/[^0-9a-fA-F]/g, "");
    const parsed = raw.length === 4 || raw.length === 7 || raw.length === 9 || raw.length === 5 ? parseColorLiteral(raw) : null;
    if (!parsed) return;
    hsl = rgbToHsl(parsed);
    if (raw.length === 5 || raw.length === 9) alpha = parsed.a;
    render(); notifyChange();
  });

  // ---- スポイト ----
  if (window.EyeDropper) {
    $(".cp-eyedropper").addEventListener("click", async () => {
      try {
        const res = await new window.EyeDropper().open();
        const parsed = parseColorLiteral(res.sRGBHex);
        if (parsed) { hsl = rgbToHsl(parsed); render(); notifyChange(); }
      } catch { /* ユーザーによるキャンセル等はベストエフォートで無視する */ }
    });
  }

  // ---- 確定・キャンセル ----
  function commit() { if (closed) return; closed = true; cleanup(); onCommit(currentRgba()); }
  function cancel() { if (closed) return; closed = true; cleanup(); onCancel(); }
  applyBtn.addEventListener("click", commit);

  function onKeyDown(e) { if (e.key === "Escape") { e.preventDefault(); cancel(); } }
  function onDocMouseDown(e) { if (!root.contains(e.target)) cancel(); }
  document.addEventListener("keydown", onKeyDown, true);
  // クリック直後(パネルを開いた右クリック由来のclick等)で即キャンセルされないよう、
  // 外側クリック監視は次のイベントループから有効にする。
  setTimeout(() => document.addEventListener("mousedown", onDocMouseDown, true), 0);
  function cleanup() {
    document.removeEventListener("keydown", onKeyDown, true);
    document.removeEventListener("mousedown", onDocMouseDown, true);
    root.remove();
  }

  // ---- 位置決め(仕様書 4.4): 対象矩形と重ならないように下→上→右→左の順で試す ----
  function place() {
    const margin = 8;
    const vw = window.innerWidth, vh = window.innerHeight;
    const pw = root.offsetWidth, ph = root.offsetHeight;
    const clampX = (x) => clamp(x, margin, Math.max(margin, vw - pw - margin));
    const clampY = (y) => clamp(y, margin, Math.max(margin, vh - ph - margin));
    let left, top;
    if (anchorRect.bottom + margin + ph <= vh - margin) {
      top = anchorRect.bottom + margin; left = clampX(anchorRect.left);
    } else if (anchorRect.top - margin - ph >= margin) {
      top = anchorRect.top - margin - ph; left = clampX(anchorRect.left);
    } else if (anchorRect.right + margin + pw <= vw - margin) {
      left = anchorRect.right + margin; top = clampY(anchorRect.top);
    } else if (anchorRect.left - margin - pw >= margin) {
      left = anchorRect.left - margin - pw; top = clampY(anchorRect.top);
    } else {
      left = clampX(anchorRect.left); top = clampY(anchorRect.bottom + margin);
    }
    root.style.left = `${left}px`;
    root.style.top = `${top}px`;
  }

  render();
  place();
  root.focus();

  return { close: () => { if (!closed) { closed = true; cleanup(); } } };
}
