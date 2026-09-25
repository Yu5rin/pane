// カスタムCSSの作成補助(仕様書 第2.10.1節 C-16)の画面。dist/css-editor-window.html から読み込まれ、
// Pane/CssEditorWindow.cs の WebView2 の中で動く。
//
// 画面の作り:
//   左上: よく使う変数の入力欄(色は見本の色を押すとカラーピッカー、フォントは文字で入力)
//   左下: CSSの編集欄(CodeMirror)
//   右  : 見本(css-preview.html を iframe で表示。本文と同じ描画)
// CSSの編集欄がただ1つの原本(仕様書)。入力欄は css-vars.js で CSS の中の変数を読み書きする
// だけで、別の状態は持たない。入力欄で変えると編集欄の該当の宣言だけが書き換わり、編集欄で
// 変えると入力欄が読み直される。どちらの変更も見本へすぐ流す。
//
// C#とのやり取り(Pane/CssEditorWindow.cs):
//   JS→C#: initial-render-ready / css-editor-save {css} / css-editor-dirty {value} /
//          close-css-editor-window / open-theme-folder / log
//   C#→JS: css-editor-init {css, source, sourcePath, targetPath, targetExists, theme, lightTheme, darkTheme}
//          css-editor-saved {ok, targetPath | message} / confirm-close
//
// 初期ロードJS(仕様書 第8.4節)を増やさないよう、main.js からは一切 import されない
// 独立したエントリにしている。editor.js(本文のエディタ一式)も import しない(見本の iframe 側だけが使う)。
import { EditorState } from "@codemirror/state";
import { EditorView, keymap, lineNumbers, drawSelection, highlightActiveLine } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { syntaxHighlighting, bracketMatching, indentOnInput } from "@codemirror/language";
import { css as cssLanguage } from "@codemirror/lang-css";
import { codeHighlightStyle } from "./code-highlight-style.js";
import { readVars, setVar, removeVar, minimalChange } from "./css-vars.js";
import { parseColorLiteral } from "./color-picker.js";
import { paneConfirm } from "./dialog.js";

const bridge = window.chrome?.webview ?? null;

document.addEventListener("contextmenu", (e) => e.preventDefault(), true);

function logToHost(level, message) {
  console[level === "error" ? "error" : "log"](message);
  bridge?.postMessage({ type: "log", level, message: String(message) });
}
window.addEventListener("error", (e) => logToHost("error", `JS未処理エラー: ${e.message} (${e.filename}:${e.lineno}:${e.colno})`));
window.addEventListener("unhandledrejection", (e) => logToHost("error", `JS未処理のPromise拒否: ${e.reason}`));

// ---- 入力欄に出す項目 ----
// 見本の画面(view)ごとにまとめる。入力欄を触ると、見本がその項目の見える画面へ切り替わる
// (コードの色分けを触ればコードモード、メニューバーの色を触れば画面全体)。
// 色はライト用とダーク用を別々に持つ(見本の「ライト/ダーク」の切り替えに合わせて、書き込む先の
// ブロックも切り替わる)。書体は共通(ライト用の :root にだけ書く)。
//
// 入力欄に出さないもの:
//   ・本文の余白・行の高さ・最大幅: 設定画面の項目の値が常に優先され、CSSからは効かない
//     (main.js applyEditorPaddingSetting 等が要素に直接書き込む)
//   ・見出しの書体(--font-heading): 本文の見出しには効かず、取扱説明書の見出しにしか使われない
//     (最初の版では入力欄に出していたが、変えても本文が変わらなかった。2026-09-25 に実測して外した)
// どの変数がどの見本で確かめられるかは .verify-css-preview-coverage.mjs が実測で見張っている。
const FIELD_GROUPS = [
  {
    title: "本文",
    view: "markdown",
    kind: "color",
    fields: [
      { name: "--paper", label: "紙面(背景)" },
      { name: "--ink", label: "本文の文字" },
      { name: "--ink-sub", label: "補助の文字" },
      { name: "--ink-mute", label: "控えめな文字(記号など)" },
      { name: "--accent", label: "アクセント(リンクなど)" },
      { name: "--accent-ink", label: "アクセントの面の上の文字" },
      { name: "--accent-soft", label: "アクセントの面(選択範囲・今いる所など)" },
      { name: "--line", label: "枠線" },
      { name: "--rule", label: "区切り線" },
      // インラインコードとコードブロックの両方の背景(style.css .cm-codeblock-line も --code-bg)。
      { name: "--code-bg", label: "コードの背景" },
      // Markdown のコードブロックの行番号。コードモードの行番号は --ink-mute で描かれる。
      { name: "--code-linenum-fg", label: "コードブロックの行番号" },
      { name: "--panel-bg", label: "表の見出し行の背景" },
      { name: "--frontmatter-bg", label: "Front Matter の背景" },
    ],
  },
  {
    title: "Callout",
    view: "markdown",
    kind: "color",
    fields: [
      { name: "--callout-note", label: "NOTE の色" },
      { name: "--callout-note-bg", label: "NOTE の背景" },
      { name: "--callout-tip", label: "TIP の色" },
      { name: "--callout-tip-bg", label: "TIP の背景" },
      { name: "--callout-important", label: "IMPORTANT の色" },
      { name: "--callout-important-bg", label: "IMPORTANT の背景" },
      { name: "--callout-warning", label: "WARNING の色" },
      { name: "--callout-warning-bg", label: "WARNING の背景" },
      { name: "--callout-caution", label: "CAUTION の色" },
      { name: "--callout-caution-bg", label: "CAUTION の背景" },
    ],
  },
  {
    title: "コード",
    view: "code",
    kind: "color",
    fields: [
      { name: "--code-kw", label: "キーワード" },
      { name: "--code-kw2", label: "制御構文(if・return など)" },
      { name: "--code-var", label: "変数" },
      { name: "--code-fn", label: "関数" },
      { name: "--code-str", label: "文字列" },
      { name: "--code-num", label: "数値" },
      { name: "--code-cmt", label: "コメント" },
      { name: "--code-type", label: "型・クラス" },
      { name: "--code-prop", label: "プロパティ" },
      { name: "--code-op", label: "演算子・記号" },
      { name: "--code-regex", label: "正規表現" },
      { name: "--active-line-bg", label: "今の行の背景" },
      { name: "--fold-guide-hover", label: "折りたたみの範囲(マウスを乗せたとき)" },
    ],
  },
  {
    title: "画面",
    view: "chrome",
    kind: "color",
    fields: [
      { name: "--titlebar-bg", label: "タイトルバーの背景" },
      { name: "--titlebar-fg", label: "タイトルバーの文字" },
      { name: "--chrome-bg", label: "メニューバー・ステータスバーの背景" },
      { name: "--chrome-fg", label: "ステータスバーの文字" },
      { name: "--menu-hover-fg", label: "メニューバーのボタン(押したとき)" },
      { name: "--sidebar-bg", label: "サイドバーの背景" },
      { name: "--surface", label: "パレット・ダイアログの背景" },
      { name: "--input-bg", label: "入力欄の背景" },
      { name: "--accent-hover", label: "主なボタン(マウスを乗せたとき)" },
    ],
  },
  {
    title: "書体",
    view: "",
    kind: "font",
    fields: [
      { name: "--font-body", label: "本文と画面の書体" },
      { name: "--font-mono", label: "等幅の書体(コード)" },
    ],
  },
];

// 設定のカスタムCSSが未指定のときの雛形。ブロックだけを用意し、中身は入力欄で足していく。
const TEMPLATE = `/* Pane カスタムCSS
   「カスタムCSSを作る」で作成しました。左の入力欄で変えた値が、下のブロックに書き込まれます。
   書き方の詳しい説明と、使える変数の一覧は、カスタムCSSフォルダの sample.css にあります。 */

:root {
}

html[data-theme="dark"] {
}
`;

const ICON_ATTRS = 'viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"';
const ICON_RESET = `<svg ${ICON_ATTRS}><path d="M6 6l12 12M18 6 6 18"/></svg>`;

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// ---- 画面を組み立てる ----
document.body.innerHTML = `
  <div class="ce-bar">
    <span class="ce-title">カスタムCSSを作る</span>
    <span class="ce-target" id="ce-target"></span>
    <span class="ce-seg" role="group" aria-label="見本の画面" id="ce-views">
      <button type="button" data-view="markdown" aria-pressed="true">Markdown</button>
      <button type="button" data-view="code" aria-pressed="false">コード</button>
      <button type="button" data-view="chrome" aria-pressed="false">画面全体</button>
    </span>
    <span class="ce-seg" role="group" aria-label="見本の配色" id="ce-scopes">
      <button type="button" data-scope="light" aria-pressed="true">ライト</button>
      <button type="button" data-scope="dark" aria-pressed="false">ダーク</button>
    </span>
    <button type="button" class="btn tiny primary" id="ce-save">保存して反映</button>
    <button type="button" class="btn tiny" id="ce-close">閉じる</button>
  </div>
  <div class="ce-notice" id="ce-notice" hidden></div>
  <div class="ce-main">
    <div class="ce-left">
      <div class="ce-form" id="ce-form"></div>
      <div class="ce-code" id="ce-code"></div>
    </div>
    <iframe class="ce-preview" id="ce-preview" src="css-preview.html" title="見本"></iframe>
  </div>`;

const targetEl = document.getElementById("ce-target");
const noticeEl = document.getElementById("ce-notice");
const formEl = document.getElementById("ce-form");
const saveBtn = document.getElementById("ce-save");
const closeBtn = document.getElementById("ce-close");
const previewEl = document.getElementById("ce-preview");

let scope = document.documentElement.dataset.theme === "dark" ? "dark" : "light";
let themeInfo = { theme: document.documentElement.dataset.theme, lightTheme: "default", darkTheme: "default" };
let baseline = ""; // 最後に読み込んだ・保存した内容。これと違えば「保存していない変更」
let lastDirty = false;
let targetPath = "";
let targetExists = false;
let overwriteConfirmed = false;
let saving = false;
let sourceNote = ""; // 開いたときの由来の説明(sample.css をもとにした等)。案内の欄に出し続ける
let previewReady = false;

function renderForm() {
  const scopeLabel = scope === "dark" ? "ダーク" : "ライト";
  const resetBtn = (label) => `<button type="button" class="ce-reset" aria-label="${escapeHtml(label)}をテーマの値に戻す" title="テーマの値に戻す">${ICON_RESET}</button>`;
  const groups = FIELD_GROUPS.map((g) => {
    const rows = g.fields.map((f) => g.kind === "color" ? `
      <div class="ce-row" data-name="${f.name}" data-kind="color" data-view="${g.view}">
        <label for="ce-${f.name}" title="${f.name}">${escapeHtml(f.label)}</label>
        <button type="button" class="ce-swatch" aria-label="${escapeHtml(f.label)}の色を選ぶ"><span></span></button>
        <input type="text" id="ce-${f.name}" spellcheck="false" autocomplete="off">
        ${resetBtn(f.label)}
      </div>` : `
      <div class="ce-row font" data-name="${f.name}" data-kind="font" data-view="${g.view}">
        <label for="ce-${f.name}" title="${f.name}">${escapeHtml(f.label)}</label>
        <input type="text" id="ce-${f.name}" spellcheck="false" autocomplete="off">
        ${resetBtn(f.label)}
      </div>`).join("");
    const suffix = g.kind === "font" ? "(ライト・ダーク共通)" : `(${scopeLabel})`;
    return `<div class="ce-group-title">${escapeHtml(g.title)}${suffix}</div>${rows}`;
  }).join("");
  formEl.innerHTML = `
    ${groups}
    <div class="ce-help">
      <span>空欄の項目は、今のテーマの値(薄い文字)のままです。項目を触ると、右の見本がその項目の見える画面に切り替わります。ほかの指定は下のCSSに直接書けます。</span>
      <button type="button" class="btn tiny" id="ce-open-folder">sample.css のあるフォルダを開く</button>
    </div>`;
  for (const row of formEl.querySelectorAll(".ce-row")) wireRow(row);
  formEl.querySelector("#ce-open-folder").addEventListener("click", () => bridge?.postMessage({ type: "open-theme-folder" }));
  refreshForm();
}

function rowScope(row) {
  return row.dataset.kind === "font" ? "light" : scope;
}

function wireRow(row) {
  const name = row.dataset.name;
  const input = row.querySelector("input");
  let inputTimer = 0;
  // 項目を触ったら、見本をその項目が見える画面へ切り替える。
  if (row.dataset.view) row.addEventListener("focusin", () => setView(row.dataset.view));
  input.addEventListener("input", () => {
    clearTimeout(inputTimer);
    inputTimer = setTimeout(() => writeVar(rowScope(row), name, input.value), 250);
  });
  input.addEventListener("change", () => {
    clearTimeout(inputTimer);
    writeVar(rowScope(row), name, input.value);
  });
  row.querySelector(".ce-reset").addEventListener("click", () => {
    clearTimeout(inputTimer);
    writeVar(rowScope(row), name, "");
  });
  const swatch = row.querySelector(".ce-swatch");
  if (swatch) swatch.addEventListener("click", () => openPicker(row, swatch));
}

// ---- CSSの編集欄 ----
const editorTheme = EditorView.theme({
  "&": { backgroundColor: "var(--paper)", color: "var(--ink)", height: "100%" },
  ".cm-content": { caretColor: "var(--ink)" },
  ".cm-gutters": { backgroundColor: "var(--paper)", color: "var(--ink-mute)", borderRight: "1px solid var(--rule)" },
  ".cm-activeLine": { backgroundColor: "var(--active-line-bg, transparent)" },
  ".cm-activeLineGutter": { backgroundColor: "transparent", color: "var(--ink)" },
  "&.cm-focused .cm-selectionBackground, .cm-selectionBackground": { backgroundColor: "var(--accent-soft)" },
});

const view = new EditorView({
  parent: document.getElementById("ce-code"),
  state: EditorState.create({
    doc: "",
    extensions: [
      lineNumbers(),
      history(),
      drawSelection(),
      highlightActiveLine(),
      indentOnInput(),
      bracketMatching(),
      cssLanguage(),
      syntaxHighlighting(codeHighlightStyle),
      EditorView.lineWrapping,
      keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
      editorTheme,
      EditorView.updateListener.of((u) => { if (u.docChanged) onCssChanged(); }),
    ],
  }),
});

function currentCss() {
  return view.state.doc.toString();
}

// 入力欄からの書き込み。CSS全体を差し替えず、変わった部分だけを編集欄へ流す
// (カーソル位置と「元に戻す」の単位を保つため。css-vars.js minimalChange)。
function writeVar(targetScope, name, value) {
  const before = currentCss();
  const after = String(value ?? "").trim() ? setVar(before, targetScope, name, value) : removeVar(before, targetScope, name);
  const change = minimalChange(before, after);
  if (change) view.dispatch({ changes: change });
}

// ---- 見本への反映 ----
let previewTimer = 0;
function onCssChanged() {
  clearTimeout(previewTimer);
  previewTimer = setTimeout(sendCssToPreview, 120);
  updateDirty();
}

function postToPreview(msg) {
  if (!previewReady) return;
  previewEl.contentWindow.postMessage(msg, location.origin);
}

function sendCssToPreview() {
  postToPreview({ type: "css", css: currentCss() });
}

let previewView = "markdown"; // 見本に出している画面(markdown / code / chrome)
function setView(next) {
  if (!next || next === previewView) return;
  previewView = next;
  for (const btn of document.querySelectorAll("#ce-views button")) {
    btn.setAttribute("aria-pressed", String(btn.dataset.view === previewView));
  }
  postToPreview({ type: "view", view: previewView });
}

function sendThemeToPreview() {
  postToPreview({ type: "theme", theme: scope, lightTheme: themeInfo.lightTheme, darkTheme: themeInfo.darkTheme });
}

window.addEventListener("message", (e) => {
  if (e.origin !== location.origin || e.source !== previewEl.contentWindow) return;
  const msg = e.data;
  if (msg?.type === "preview-ready") {
    previewReady = true;
    postToPreview({ type: "view", view: previewView });
    sendThemeToPreview();
    sendCssToPreview();
  } else if (msg?.type === "preview-applied") {
    refreshForm();
  }
});

// 見本の中で実際に効いている値を読む。入力欄の薄い文字(今のテーマの値)と、色見本の色に使う。
function previewRootStyle() {
  try {
    const doc = previewEl.contentDocument;
    return doc ? doc.defaultView.getComputedStyle(doc.documentElement) : null;
  } catch { return null; }
}

// 変数の値は color-mix() などのこともあるため、見本の中で色として解決させてから読む。
let probeEl = null;
function resolvedColor(name) {
  try {
    const doc = previewEl.contentDocument;
    if (!doc?.body) return "";
    if (!probeEl || probeEl.ownerDocument !== doc) {
      probeEl = doc.createElement("span");
      probeEl.style.display = "none";
      doc.body.appendChild(probeEl);
    }
    probeEl.style.color = "";
    probeEl.style.color = `var(${name})`;
    return doc.defaultView.getComputedStyle(probeEl).color;
  } catch { return ""; }
}

function refreshForm() {
  const css = currentCss();
  const own = { light: readVars(css, "light"), dark: readVars(css, "dark") };
  const style = previewRootStyle();
  for (const row of formEl.querySelectorAll(".ce-row")) {
    const name = row.dataset.name;
    const vars = own[rowScope(row)];
    const input = row.querySelector("input");
    const value = vars.get(name) ?? "";
    // 入力中の欄は書き換えない(打っている文字が消えるため)。
    if (document.activeElement !== input) input.value = value;
    input.placeholder = style ? style.getPropertyValue(name).trim() : "";
    row.querySelector(".ce-reset").disabled = !vars.has(name);
    const swatchColor = row.querySelector(".ce-swatch span");
    if (swatchColor) swatchColor.style.background = resolvedColor(name);
  }
}

// ---- カラーピッカー ----
async function openPicker(row, swatch) {
  const name = row.dataset.name;
  const targetScope = rowScope(row);
  const input = row.querySelector("input");
  const startCss = currentCss();
  const startValue = input.value.trim();
  const parsed = parseColorLiteral(startValue) || parseColorLiteral(resolvedColor(name)) || parseColorLiteral("#000000");
  // 元の値が色の書き方でなければ(color-mix() 等)、6桁の16進数で書き戻す。
  const notation = parseColorLiteral(startValue)?.notation ?? parseColorLiteral("#000000").notation;
  const { formatColorLiteral, openColorPickerPanel } = await import("./color-picker-panel.js");
  const r = swatch.getBoundingClientRect();
  openColorPickerPanel({
    anchorRect: { left: r.left, top: r.top, right: r.right, bottom: r.bottom },
    initialColor: parsed,
    hasAlpha: (parsed.a ?? 1) < 1,
    formatColor: (rgba) => formatColorLiteral(rgba, notation),
    onChange: (rgba) => writeVar(targetScope, name, formatColorLiteral(rgba, notation)),
    onCommit: (rgba) => writeVar(targetScope, name, formatColorLiteral(rgba, notation)),
    onCancel: () => {
      // 開いたときの内容に戻す。
      const change = minimalChange(currentCss(), startCss);
      if (change) view.dispatch({ changes: change });
    },
  });
}

// ---- 保存・閉じる ----
function updateDirty(force = false) {
  const dirty = currentCss() !== baseline;
  if (!force && dirty === lastDirty) return;
  lastDirty = dirty;
  bridge?.postMessage({ type: "css-editor-dirty", value: dirty });
}

function showNotice(text, isError) {
  const full = [text, sourceNote].filter(Boolean).join(" ");
  noticeEl.textContent = full;
  noticeEl.hidden = !full;
  noticeEl.classList.toggle("error", !!isError);
}

function presetNote() {
  const preset = scope === "dark" ? themeInfo.darkTheme : themeInfo.lightTheme;
  if (!preset || preset === "default") return "";
  return `設定で「${preset}」のテーマを選んでいるため、ここで変えた色がそのテーマの色に負けて効かないことがあります。確実に効かせるには、設定 > 外観 のテーマを「既定」にしてください。`;
}

function fileName(path) {
  return String(path).split(/[\\/]/).pop();
}

async function save() {
  if (saving) return;
  if (!bridge) { showNotice("この画面は Pane の中でだけ保存できます。", true); return; }
  if (targetExists && !overwriteConfirmed) {
    const ok = await paneConfirm({
      title: "上書きの確認",
      message: `${fileName(targetPath)} を上書きします。よろしいですか?\n${targetPath}`,
      okLabel: "上書きする",
    });
    if (!ok) return;
    overwriteConfirmed = true;
  }
  saving = true;
  saveBtn.disabled = true;
  bridge.postMessage({ type: "css-editor-save", css: currentCss() });
}

function handleSaved(msg) {
  saving = false;
  saveBtn.disabled = false;
  if (!msg.ok) {
    showNotice(`保存できませんでした。${msg.message ?? ""}`, true);
    return;
  }
  baseline = currentCss();
  targetExists = true;
  overwriteConfirmed = true;
  sourceNote = "";
  updateDirty(true);
  showNotice(`保存しました。開いているウィンドウに反映しました(${fileName(msg.targetPath ?? targetPath)})。 ${presetNote()}`.trim(), false);
}

async function requestClose() {
  if (currentCss() !== baseline) {
    const ok = await paneConfirm({
      title: "保存していない変更があります",
      message: "保存せずに閉じると、この画面で変えた内容は失われます。閉じますか?",
      okLabel: "保存せずに閉じる",
      danger: true,
    });
    if (!ok) return;
  }
  if (bridge) bridge.postMessage({ type: "close-css-editor-window" });
  else window.close();
}

saveBtn.addEventListener("click", save);
closeBtn.addEventListener("click", requestClose);
for (const btn of document.querySelectorAll("#ce-scopes button")) {
  btn.addEventListener("click", () => setScope(btn.dataset.scope));
}
for (const btn of document.querySelectorAll("#ce-views button")) {
  btn.addEventListener("click", () => setView(btn.dataset.view));
}
document.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "s") {
    e.preventDefault();
    save();
    return;
  }
  // ダイアログやカラーピッカーが開いているときの Escape は、それぞれが自分で受け取る。
  if (e.key === "Escape" && !document.querySelector(".pane-dialog-overlay, .color-picker-panel")) {
    e.preventDefault();
    requestClose();
  }
});

function setScope(next) {
  scope = next === "dark" ? "dark" : "light";
  for (const btn of document.querySelectorAll("#ce-scopes button")) {
    btn.setAttribute("aria-pressed", String(btn.dataset.scope === scope));
  }
  renderForm();
  sendThemeToPreview();
  showNotice(presetNote(), false);
}

function loadInitial(msg) {
  themeInfo = {
    theme: msg.theme,
    lightTheme: msg.lightTheme || "default",
    darkTheme: msg.darkTheme || "default",
  };
  if (msg.theme === "light" || msg.theme === "dark") {
    document.documentElement.dataset.theme = msg.theme;
    scope = msg.theme;
  }
  document.documentElement.dataset.lightTheme = themeInfo.lightTheme;
  document.documentElement.dataset.darkTheme = themeInfo.darkTheme;
  const css = msg.source === "template" ? TEMPLATE : String(msg.css ?? "");
  view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: css } });
  // 開いたときの内容(雛形を含む)を「保存していない変更なし」の基準にする。何も変えずに
  // 閉じるときに確認を出さないため。保存は変更が無くてもできる(雛形のまま保存すると、
  // 空のブロックだけのファイルができる)。
  baseline = css;
  updateDirty(true);
  targetPath = String(msg.targetPath ?? "");
  targetExists = !!msg.targetExists;
  overwriteConfirmed = false;
  targetEl.textContent = targetPath ? `保存先: ${targetPath}` : "";
  targetEl.title = targetPath;
  sourceNote = msg.source === "sample"
    ? "sample.css をもとに編集しています。保存すると別のファイルとして保存し、sample.css は変えません。"
    : "";
  setScope(scope);
}

if (bridge) {
  bridge.addEventListener("message", (e) => {
    const msg = e && e.data;
    if (!msg) return;
    if (msg.type === "css-editor-init") loadInitial(msg);
    else if (msg.type === "css-editor-saved") handleSaved(msg);
    else if (msg.type === "confirm-close") requestClose();
  });
}

renderForm();
// 画面の組み立てが済んだ。C#側はこれを受けてからウィンドウを見せ、編集する内容を送ってくる。
logToHost("log", "initial-render-ready送信(カスタムCSSの作成補助)");
bridge?.postMessage({ type: "initial-render-ready" });
if (!bridge) {
  // ブラウザ単体で開いたとき(開発中の確認用)。雛形で始める。
  loadInitial({ source: "template", css: "", targetPath: "", targetExists: false, theme: scope });
}
