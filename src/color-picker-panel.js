// カラーピッカーパネル本体(仕様書 第4章)のDOM構築・操作。
// src/color-picker.js から分離してある(初期ロードJS削減、仕様書 第8.4節)。
// パネルは「色を変更…」等で実際に開かれたときにしか使われないため、editor.js側は
// これを動的import()で必要になった瞬間にだけ読み込む(math.js/mermaid-render.jsと同じ作法)。
// 一方、色文字列の認識・パース・コントラスト計算(color-picker.js側に残した関数)は
// 本文の色プレビュー表示(常時の装飾)に使うため、そちらは静的importのまま残す。
import { hslToRgb, rgbToHsl, parseColorLiteral, clamp, clampInt, CSS_COLOR_NAMES } from "./color-picker.js";

// ---- 整形(元のリテラルの記法に書き戻す。仕様書 4.3) ----
// このモジュール内でしか使わない(color-picker.js側のfindColorMatches/readableTextColor等の
// 常時実行パスはparseColorLiteralまでしか必要としないため)。
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
// color-picker.js の CSS_COLOR_NAMES から作る hex→名前の逆引き。
// formatColorLiteralの"name"分岐(編集後も一致する名前があれば名前で書き戻す)専用のため、
// ここでしか使わないこのモジュールに閉じ込める(元のNAME_BY_HEXと同じ作り方)。
const NAME_BY_HEX = (() => {
  const m = new Map();
  for (const [name, hex] of Object.entries(CSS_COLOR_NAMES)) if (!m.has(hex)) m.set(hex, name);
  return m;
})();
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
function toHexDisplay({ r, g, b, a }, { withAlpha = false } = {}) {
  let s = "#" + toHex2(r, true) + toHex2(g, true) + toHex2(b, true);
  if (withAlpha && a < 1) s += toHex2(clampInt(a * 255), true);
  return s;
}
function toRgbDisplay({ r, g, b, a }) {
  return a < 1 ? `RGB(${clampInt(r)}, ${clampInt(g)}, ${clampInt(b)}, ${fmtAlphaNum(a)})` : `RGB(${clampInt(r)}, ${clampInt(g)}, ${clampInt(b)})`;
}
function toHslDisplay(rgba) {
  const { h, s, l } = rgbToHsl(rgba);
  const base = `HSL(${Math.round(h)}°, ${Math.round(s)}%, ${Math.round(l)}%)`;
  return rgba.a < 1 ? base.slice(0, -1) + `, ${fmtAlphaNum(rgba.a)})` : base;
}

// ---- 配色パレット生成(仕様書 4.2) ----
const norm360 = (h) => ((h % 360) + 360) % 360;
const clampPct = (v) => clamp(v, 0, 100);
function buildPalettes({ r, g, b }) {
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
const PALETTE_LABELS = [
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

  // ---- パネル内だけのアンドゥ履歴(改善要望1) ----
  // 本文側のアンドゥ履歴(仕様書4.3、editor.js側でaddToHistory:falseにより中間状態を
  // 積まない仕組み)とは完全に独立させる。ここではパネルを開いている間の
  // 「操作の区切り」(ドラッグ1回、数値入力の確定1回、パレットクリック1回など)ごとに
  // hsl/alphaのスナップショットを積み、Ctrl+Z/Ctrl+Yで行き来する。積んだ結果は
  // onChange経由でeditor.js側に伝わるが、editor.js側は常にaddToHistory:falseで
  // 書き込むだけなので、本文のアンドゥ履歴には一切影響しない。
  let history = [{ hsl: { ...hsl }, alpha }]; // index 0 = パネルを開いた時点の色
  let histIndex = 0;
  function historySnapshotEquals(a, b) {
    return a.hsl.h === b.hsl.h && a.hsl.s === b.hsl.s && a.hsl.l === b.hsl.l && a.alpha === b.alpha;
  }
  // 操作の区切りごとに呼ぶ(ドラッグ終了時・数値入力確定時・パレット確定時・スポイト取得時)。
  // ドラッグ中の連続変化はrender()/notifyChange()だけを呼び、ここは呼ばないことで
  // 「ドラッグ開始〜終了を1つ」という区切り単位を実現する。
  // 直前のエントリと結果が変わっていなければ積まない(空の操作で履歴を汚さない)。
  function pushHistorySnapshot() {
    const cur = { hsl: { ...hsl }, alpha };
    if (historySnapshotEquals(history[histIndex], cur)) return;
    history = history.slice(0, histIndex + 1); // redo分は上書きで破棄
    history.push(cur);
    histIndex = history.length - 1;
    syncHistoryDataset(); // render()を経由しない呼び出し(ドラッグ終了時など)もあるためここでも同期する
  }
  function applyHistoryIndex(idx) {
    if (idx < 0 || idx >= history.length) return;
    histIndex = idx;
    const snap = history[idx];
    hsl = { ...snap.hsl };
    alpha = snap.alpha;
    render();
    notifyChange();
  }
  function undoColorHistory() { applyHistoryIndex(histIndex - 1); }
  function redoColorHistory() { applyHistoryIndex(histIndex + 1); }
  // 検証スクリプト(.verify-picker.mjs)向けに履歴の長さ・現在位置をdata属性として公開する。
  // 「ドラッグ中は積まれず、pointerupで1件だけ増える」といった区切りの単位はJS内部の
  // クロージャ変数のままでは外部から確認できないための最小限のフック(render()の末尾で
  // 毎回同期するため、ここだけ更新漏れの心配がない)。
  function syncHistoryDataset() {
    root.dataset.cpHistLen = String(history.length);
    root.dataset.cpHistIndex = String(histIndex);
  }

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
    <div class="cp-actions">
      <button type="button" class="btn tiny cp-cancel">キャンセル</button>
      <button type="button" class="btn tiny cp-apply">適用</button>
    </div>
  `;
  document.body.appendChild(root);

  const $ = (sel) => root.querySelector(sel);
  const previewEl = $(".cp-preview"); // ドラッグハンドル(ユーザー要望1)
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
  const cancelBtn = $(".cp-cancel");

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
          pushHistorySnapshot(); // 即commitで閉じるため実質使われないが、他の操作と扱いを揃えておく
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
    syncHistoryDataset();
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
  // 注意点(改善要望1): ドラッグ中の連続変化(pointermoveのたびに呼ばれるonMove)は
  // 履歴に積まない。pointerup(ドラッグ終了)の瞬間に1回だけpushHistorySnapshot()を呼び、
  // 「ドラッグ開始〜終了を1つの操作」として履歴の区切りにする。
  function bindDrag(el, onMove) {
    el.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return; // 右クリック等では開始しない(既存コードの流儀に合わせる)
      e.preventDefault();
      el.setPointerCapture(e.pointerId);
      onMove(e);
      const move = (ev) => onMove(ev);
      const up = (ev) => {
        el.releasePointerCapture(ev.pointerId);
        el.removeEventListener("pointermove", move);
        el.removeEventListener("pointerup", up);
        pushHistorySnapshot();
      };
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
  // input(打鍵のたび)はライブ反映のみ、change(確定=blurやEnter、上下キーでの増減の都度)で
  // 履歴に1つ積む(改善要望1「数値入力はそれぞれ1つ」)。数値入力欄のキーボード上下キー操作は
  // type="number"のネイティブ挙動としてinput/changeの両方を都度発火するため、
  // 1回の増減がそのまま履歴1件になる。
  for (const [inp, ch] of [[rInput, "r"], [gInput, "g"], [bInput, "b"]]) {
    inp.addEventListener("input", () => {
      const rgb = currentRgb();
      const v = clampInt(Number(inp.value));
      setFromRgb(ch === "r" ? v : rgb.r, ch === "g" ? v : rgb.g, ch === "b" ? v : rgb.b);
    });
    inp.addEventListener("change", pushHistorySnapshot);
  }
  hexInput.addEventListener("input", () => {
    const raw = "#" + hexInput.value.replace(/[^0-9a-fA-F]/g, "");
    const parsed = raw.length === 4 || raw.length === 7 || raw.length === 9 || raw.length === 5 ? parseColorLiteral(raw) : null;
    if (!parsed) return;
    hsl = rgbToHsl(parsed);
    if (raw.length === 5 || raw.length === 9) alpha = parsed.a;
    render(); notifyChange();
  });
  hexInput.addEventListener("change", pushHistorySnapshot);

  // ---- スポイト ----
  if (window.EyeDropper) {
    $(".cp-eyedropper").addEventListener("click", async () => {
      try {
        const res = await new window.EyeDropper().open();
        const parsed = parseColorLiteral(res.sRGBHex);
        if (parsed) { hsl = rgbToHsl(parsed); render(); notifyChange(); pushHistorySnapshot(); }
      } catch { /* ユーザーによるキャンセル等はベストエフォートで無視する */ }
    });
  }

  // ---- 確定・キャンセル ----
  function commit() { if (closed) return; closed = true; cleanup(); onCommit(currentRgba()); }
  function cancel() { if (closed) return; closed = true; cleanup(); onCancel(); }
  applyBtn.addEventListener("click", commit);
  // 改善要望2: Esc・パネル外クリックと同じ動作(開いた時の色に戻して閉じる)を
  // ボタンとしても用意する。cancel()自体は既存のonCancel()をそのまま呼ぶだけなので、
  // editor.js側の「開いた時の色に戻す」処理(finish(colorText))は変更不要。
  cancelBtn.addEventListener("click", cancel);

  function onKeyDown(e) {
    if (e.key === "Escape") { e.preventDefault(); cancel(); return; }
    // 改善要望1・注意点: パネル内だけのCtrl+Z/Ctrl+Y(Ctrl+Shift+Z)。本文側のアンドゥ操作
    // (CodeMirrorのkeymap)と取り違えないよう、フォーカスがパネル内(数値入力欄・パレットの
    // ボタンなど含む)にある時だけ反応し、preventDefault+stopPropagationで本文側へ
    // 伝播させない。パネル外(本文)にフォーカスがあるときは何もせず素通りさせる。
    if (!root.contains(document.activeElement)) return;
    const key = e.key.toLowerCase();
    if (e.ctrlKey && !e.altKey && key === "z" && !e.shiftKey) {
      e.preventDefault(); e.stopPropagation();
      undoColorHistory();
    } else if (e.ctrlKey && !e.altKey && (key === "y" || (key === "z" && e.shiftKey))) {
      e.preventDefault(); e.stopPropagation();
      redoColorHistory();
    }
  }
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

  // ---- パネルのドラッグ移動(ユーザー要望1) ----
  // プレビュー行(.cp-preview、色スウォッチ+色番号の行)をドラッグハンドルにする。
  // 入力欄・スライダー・彩度明度の四角形・パレット・ボタンの上で操作を始めると色が
  // 選べなくなるため、ドラッグ開始点をプレビュー行に限定したうえで、念のため
  // イベントの発生源(e.target)がフォーム要素・操作系の子要素でないことも確認する
  // (プレビュー行自体には現状スウォッチとテキストしか無いが、将来ここに操作要素が
  // 増えても誤ってドラッグが始まらないようにするための保険)。
  function isNonDraggableTarget(target) {
    return !!target.closest(
      "input, button, .cp-sl-box, .cp-hue-slider, .cp-alpha-slider, .cp-palette-swatch"
    );
  }
  function dragPlacedByUser() {
    // 一度でもドラッグで動かしたら、以後は自動再配置(place())を行わない
    // (ユーザーが置いた位置を尊重する。実際にはplace()はパネルを開いた直後の
    // 1回しか呼ばれないため、このフラグ自体は現状の自動再配置を止めるためというより、
    // 「ドラッグ移動済みかどうか」を外部(検証スクリプト等)から確認できるようdata属性へ
    // 反映する目的で持つ)。
    root.dataset.cpUserPositioned = "true";
  }
  previewEl.style.touchAction = "none";
  previewEl.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return; // 右クリック等では開始しない(既存コードの流儀に合わせる)
    if (isNonDraggableTarget(e.target)) return;
    e.preventDefault();
    previewEl.setPointerCapture(e.pointerId);
    const startClientX = e.clientX, startClientY = e.clientY;
    const startLeft = root.offsetLeft, startTop = root.offsetTop;
    const move = (ev) => {
      const margin = 0; // パネル自体は掴んだ場所の相対位置のまま動かし、クランプだけ画面端で行う
      const vw = window.innerWidth, vh = window.innerHeight;
      const pw = root.offsetWidth, ph = root.offsetHeight;
      const rawLeft = startLeft + (ev.clientX - startClientX);
      const rawTop = startTop + (ev.clientY - startClientY);
      // ビューポートからはみ出さないようクランプする(掴む部分が画面外へ出ると
      // 二度と動かせなくなるため。パネル自体が画面より大きい極端なケースでも
      // 0未満にはならないようMath.maxで下限を0に揃える)。
      const left = clamp(rawLeft, margin, Math.max(margin, vw - pw - margin));
      const top = clamp(rawTop, margin, Math.max(margin, vh - ph - margin));
      root.style.left = `${left}px`;
      root.style.top = `${top}px`;
    };
    const up = (ev) => {
      previewEl.releasePointerCapture(ev.pointerId);
      previewEl.removeEventListener("pointermove", move);
      previewEl.removeEventListener("pointerup", up);
      dragPlacedByUser();
    };
    previewEl.addEventListener("pointermove", move);
    previewEl.addEventListener("pointerup", up);
  });

  render();
  place();
  root.focus();

  return { close: () => { if (!closed) { closed = true; cleanup(); } } };
}
