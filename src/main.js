// Pane エントリポイント。
// WebView2(window.chrome.webview)が使える場合はpostMessageブリッジでC#側に
// ファイルの開閉・保存・エクスポート・印刷・画像挿入等を委譲する(仕様書 第7章)。
// 使えない場合(単体のブラウザで動作確認する場合)は File System Access API /
// File API による仮実装にフォールバックする(Phase 1からの経路をそのまま維持)。
import { createEditor, DEFAULT_FONT_SIZE } from "./editor.js";
import { buildCommands, initMenuBar, initCommandPalette, initContextMenu, routeNativeMenuCommand, routeNativeMenuClosed, bindShortcuts, applyKeyBindings } from "./commands.js";
import { createSearchUI } from "./search-ui.js";
import { createSidebar } from "./sidebar.js";
import { createQuickOpen } from "./quick-open.js";
import { createWordCountPopup } from "./word-count.js";
import { createSettings } from "./settings.js";
import { htmlToMarkdown } from "./html-to-markdown.js";
import { parseFrontMatterOverrides } from "./md-to-html.js";
import { resolveFileMode, codeLanguages } from "./languages.js";
import { FILE_TYPES } from "./file-types.js";
import { detectContentMode } from "./detect-mode.js";
import { setReadingSpeedWpm } from "./text-stats.js";
import { setOutlineMaxLevel } from "./markdown-extras.js";

const host = document.getElementById("cm-host");
const statusbarEl = document.getElementById("statusbar");
const menubarEl = document.getElementById("menubar");
const statusSidebarBtn = document.getElementById("status-sidebar");
const statusMode = document.getElementById("status-mode");
const statusPosition = document.getElementById("status-position");
const statusCount = document.getElementById("status-count");
const statusDirty = document.getElementById("status-dirty");
const statusZoom = document.getElementById("status-zoom");
const statusEncoding = document.getElementById("status-encoding");
const statusLineEnding = document.getElementById("status-line-ending");
const statusWrapBtn = document.getElementById("status-wrap");
const fileInput = document.getElementById("file-input");
const imageInput = document.getElementById("image-input");
// 内容からの編集モード自動判定(仕様書 第1章の拡張)の通知バナー。モーダルにはしない
// (常時ステータスバー付近に浮かべ、入力の邪魔をしない)。
const adBanner = document.getElementById("ad-banner");
const adBannerText = document.getElementById("ad-banner-text");
const adBannerAction = document.getElementById("ad-banner-action");
const adBannerClose = document.getElementById("ad-banner-close");

// 言語ID(src/file-types.js の FILE_TYPES[].id)→表示ラベルの対応。ステータスバーの
// 「コード (Python)」表示・言語ピッカーの両方で使う。
const LANGUAGE_LABELS = Object.fromEntries(FILE_TYPES.map((t) => [t.id, t.label]));

const bridge = window.chrome?.webview ?? null;

// ブラウザ既定の右クリックメニューを一切出さない(docs/コンテキストメニュー仕様.md 大原則1)。
// WebView2側でもAreDefaultContextMenusEnabled=falseを設定しているが(Pane/MainForm.cs)、
// 保険としてJS側でも最外周(捕捉フェーズ)で止める。独自メニューを出す/出さないの判断は
// このあと個別に登録するcontextmenuリスナー(initContextMenu、バブルフェーズ)側で行う。
document.addEventListener("contextmenu", (e) => e.preventDefault(), true);

// ---- 実機での不具合調査用ログ(仕様書外・デバッグ支援) ----
// C#側のLogger(%LOCALAPPDATA%\Pane\logs\)へJS側のログもまとめて送る。DevTools(Shift+F12)を
// 別途開かなくても、テキストファイル1つで両側の動きを追えるようにする。
function logToHost(level, message) {
  console[level === "error" ? "error" : "log"](message);
  bridge?.postMessage({ type: "log", level, message: String(message) });
}
window.addEventListener("error", (e) => {
  logToHost("error", `JS未処理エラー: ${e.message} (${e.filename}:${e.lineno}:${e.colno})`);
});
window.addEventListener("unhandledrejection", (e) => {
  logToHost("error", `JS未処理のPromise拒否: ${e.reason}`);
});

let currentHandle = null; // File System Access API(ブラウザ単体時のみ使用)
let currentPath = null; // ブリッジ経由で開いた際のフルパス(最近使ったファイル・画像挿入・reopenClosedに使う)
let currentName = "無題";
let currentEncoding = null;
let currentLineEnding = null;
let wordWrapOn = true;
let defaultCopyFormat = "markdown"; // "markdown" | "html"(仕様書 第2.9.3節、設定で切替)
let pandocAvailable = false;
let recentFiles = [];
// エクスポート・印刷の詳細設定(仕様書 docs/設定項目一覧.md「エクスポート・印刷」節)。
// JS側で使う項目だけをここに保持し、C#側専用の項目(exportDefaultFolder等)もそのまま
// 通過させてexport/printメッセージに乗せる(C#側で読む)。既定値はAppSettings.csと揃える。
let exportSettings = {
  exportPaperSize: "a4", exportCustomWidthMm: 210, exportCustomHeightMm: 297,
  exportOrientation: "portrait",
  exportMarginTopMm: 20, exportMarginBottomMm: 20, exportMarginLeftMm: 20, exportMarginRightMm: 20,
  exportHeaderText: "", exportFooterText: "",
  exportPageBreakBetweenTopHeadings: false,
  exportIncludeOutline: false, exportOutlineWidthPx: 260,
  exportAppendHead: "", exportAppendBody: "",
  exportDefaultFolder: "sameAsFile", exportCustomFolder: "",
  exportAfter: "none", exportShowSaveDialog: true,
  exportMathAs: "svg", exportReadYamlFrontMatter: true,
};
// 直近読み込みに成功したフォルダ(仕様書 第2.8節: ファイルを開くと親フォルダが自動読み込まれる)。
// { rootPath, rootName, entries, truncated } 。未読み込み・読み込み失敗時はnullのまま
// (失敗時のエラー表示はサイドバー側にだけ渡し、ここでは保持しない)。
let folderData = null;
// ダーティ・読み取り専用の表示はOSネイティブのウィンドウタイトルが兼ねる(C#側UpdateTitle)ため、
// HTML側は確認ダイアログの判定等に使う内部状態としてのみ保持する。
let isDirty = false;
let isReadOnly = false;
const closedFiles = []; // 閉じたファイルを再度開く(このウィンドウ内での置き換え履歴、ブリッジ利用時のみ)
const CLOSED_FILES_CAP = 20;
// グローバル検索のヒット行クリック(仕様書 第2.6節 G-02)から「開いたら指定行へジャンプする」
// 保留状態。openFileByPath(path, line)で設定し、file-openedが届いたタイミングで
// applyFileOpened側が消費する。{ path, line } または未設定時はnull。
let pendingGotoLine = null;
// 文字数カウントの表示ON/OFF(仕様書 V-13)。C#側の設定受け口が未実装でも動作に支障が
// 出ないよう、既定値はON(従来どおり表示)にしておく。
let showWordCount = true;
// キーバインドのカスタマイズ(仕様書 第2.10節 C-10)。コマンドID→ショートカット文字列。
// apply-settingsで届くたびに更新し、commands.jsのapplyKeyBindings()で既存のcommands配列
// (メニューバー・コマンドパレット・ショートカット待受け・設定画面が共有する同一インスタンス)
// へ即座に反映する(再起動不要)。getState()にも公開し、起動直後のbuildCommands()呼び出し
// 自体もこの値を参照できるようにする。
let keyBindings = {};
// 編集モード決定(仕様書 第1章)の優先順位2・3を上書きする設定。いずれもapply-settingsで届く。
// fileModeOverrides: 拡張子(ドット無し・小文字)→モード名。perFileModes: フルパス→手動で選んだモード名
// (優先順位1。同一セッション内での即時反映用にローカルにもキャッシュし、setMode()で都度更新する)。
let fileModeOverrides = {};
let perFileModes = {};
// 内容からの編集モード自動判定(仕様書 第1章の拡張)。既定は"standard"。
// off: 何もしない / suggest: 提案のみ(切り替えない) / standard: 無題の新規文書のみ即座に
// 切り替え(取り消し可) / aggressive: standardに加え拡張子ファイルでも食い違えば提案する。
let autoDetectMode = "standard";
const AUTO_DETECT_MODES = new Set(["off", "suggest", "standard", "aggressive"]);
// 現在の文書に対する自動判定の状態。ファイルを開く/新規作成のたびリセットする(仕様書の
// 「文書ごと」の記憶)。
//   locked:    trueなら以後この文書には一切自動判定を行わない。手動でモードを選んだ・
//              「元に戻す」を押した・無題の文書が拡張子付きで保存された、のいずれかで立つ。
//   suggested: 一度でも提案を出したらtrue(同じ文書に再提案しない)。
let autoDetectState = { locked: false, suggested: false };
function resetAutoDetectState() {
  autoDetectState = { locked: false, suggested: false };
  hideAdBanner();
}
// editor.setValue()をプログラムによる内容差し替え(ファイルを開く・新規作成等)として
// 自動判定の対象から除外しつつ呼ぶ。setValue()が実質差分無し(例: 空文書→空文書)の場合は
// CodeMirrorのdocChangedが発火せずonChange側でフラグを消費できないことがあるため、
// 呼び出し後にも明示的にfalseへ戻して次の本物の変更に影響を残さないようにする。
function setEditorValueQuiet(text) {
  suppressNextAutoDetectChange = true;
  editor.setValue(text);
  suppressNextAutoDetectChange = false;
}
// ペースト直後(貼り付け文字数がAUTO_DETECT_PASTE_MIN_CHARS以上)と、入力が止まって
// AUTO_DETECT_IDLE_MSたった時の2箇所だけで判定を走らせる(仕様: 入力のたびには走らせない)。
let lastPasteLength = 0;
let idleDetectTimer = null;
// ファイルを開く等プログラムによる内容差し替え(editor.setValue())の直後のonChangeは、
// ユーザーの入力ではないため自動判定の対象から除外する(ペースト/入力停止のみが対象)。
let suppressNextAutoDetectChange = false;
const AUTO_DETECT_PASTE_MIN_CHARS = 80;
const AUTO_DETECT_IDLE_MS = 1500;
const AUTO_DETECT_CONFIDENCE_MIN = 0.55;
// 全画面表示・常に手前に表示(仕様書 V-08/V-12)の状態。実際のトグルはC#側(WinForms)が
// 持っており、"window-state"で都度届く値をそのまま保持するだけ(第10.5節: JS側は表示専用)。
let windowState = { fullscreen: false, alwaysOnTop: false };
// 設定画面(仕様書 第2.10節)。ctx構築後(buildCommands()でctx.commandsが揃ってから)生成するため、
// ctx.actions.openSettingsは変数越しに参照するだけにしておく(sidebar/quickOpenと同じ遅延生成の形)。
let settingsUI = null;
// Ctrl+マウスホイールでの文字サイズ変更(仕様書 zoomWithCtrlWheel、既定true)。
let zoomWithCtrlWheelOn = true;
// サイドバーのファイル一覧・ツリーからの切替時、未保存の変更を確認せず保存してから
// 切り替えるか(仕様書 saveWithoutAskingOnSwitch、既定false)。
let saveWithoutAskingOnSwitch = false;
// 起動時アウトライン既定表示(仕様書 showOutlineByDefault)は最初のapply-settingsでのみ判定する。
// ユーザーが手でサイドバーを閉じた後、以後apply-settingsが再送されても勝手に開かないようにする。
let initialSidebarAutoOpenDone = false;
// switchFileFromSidebar()がbridge経由の保存完了("save-result")を待つためのresolve関数群。
let pendingSaveResolvers = [];

// 日時の挿入(仕様書 第3章 N-14)・「.LOG」自動追記(N-15)で共通して使う書式。
// Windowsのメモ帳(日本語環境)に合わせ YYYY/MM/DD HH:mm とする。
function formatDateTimeStamp(d) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// フォント名をCSSカスタムプロパティへ設定する(仕様書 C-08)。
// フォント名をそのまま素で入れると、Windowsの縦書き用フォント("@Yu Gothic"のように
// 先頭が@)や記号を含む名前でCSSとして不正になり、font-family全体が無効になって
// 何も反映されない。必ず引用符で囲み、中の " と \ をエスケープする。
// generic-family(sans-serif等)だけは引用符で囲むと意味が変わるためそのまま渡す。
const CSS_GENERIC_FONT_FAMILIES = new Set([
  "serif", "sans-serif", "monospace", "cursive", "fantasy", "system-ui",
  "ui-serif", "ui-sans-serif", "ui-monospace", "ui-rounded", "math", "emoji", "fangsong",
]);
function applyFontSetting(rootStyle, cssVar, rawName, label) {
  const name = typeof rawName === "string" ? rawName.trim() : "";
  if (!name) {
    rootStyle.removeProperty(cssVar);
    logToHost("info", `${label}: 未設定(テーマ既定に戻す)`);
    return;
  }
  const value = CSS_GENERIC_FONT_FAMILIES.has(name.toLowerCase())
    ? name
    : `"${name.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  rootStyle.setProperty(cssVar, value);
  logToHost("info", `${label}: ${value} を適用`);
}

function setDirty(v) {
  isDirty = v;
  // 未保存であることはタイトルバー(C#側のUpdateTitle)とステータスバーの両方で示す。
  // タイトルバーはタスクバー上で幅が足りず削られることがあるため、常に見える
  // ステータスバー側にも出しておく。
  if (statusDirty) statusDirty.hidden = !v;
  bridge?.postMessage({ type: "dirty", value: v });
}
function setName(name) {
  currentName = name;
}
// 文字数(仕様書 W-01/W-03)。ステータスバーは軽い集計に留める(doc.lengthと選択範囲の
// from/to差だけ、いずれもO(1))。単語数・段落数等の重い集計はポップアップを開いた時にだけ行う。
function updateCount() {
  if (!showWordCount) { statusCount.textContent = ""; return; }
  const total = editor.getDocLength();
  const selLen = editor.getSelectionLength();
  statusCount.textContent = selLen > 0 ? `${total}文字(選択 ${selLen}文字)` : `${total}文字`;
}
// 行/列(仕様書 N-03)。カーソル位置から直接取れる軽量な情報なので、選択変更のたびに呼んでよい。
function updatePosition() {
  const { line, col } = editor.getCursorInfo();
  statusPosition.textContent = `行 ${line}, 列 ${col}`;
}
// ズーム率(仕様書 N-03)。既定サイズに対する本文フォントサイズの比率を表示する。
function updateZoom() {
  statusZoom.textContent = `${Math.round((editor.getFontSize() / DEFAULT_FONT_SIZE) * 100)}%`;
}
function updateWordCountVisibility() {
  statusCount.hidden = !showWordCount;
  if (!showWordCount) wordCountPopup.close();
}
// カスタムCSS(仕様書 第2.10節 C-07)。<head>内に専用<style id="custom-css">を用意し、
// textContentとして反映する(信頼できないHTMLとして解釈されないようinnerHTMLは使わない)。
let customCssEl = null;
function applyCustomCss(css) {
  if (!customCssEl) {
    customCssEl = document.getElementById("custom-css");
    if (!customCssEl) {
      customCssEl = document.createElement("style");
      customCssEl.id = "custom-css";
      document.head.appendChild(customCssEl);
    }
  }
  customCssEl.textContent = css || "";
}

// ---- タイトルバーの配色を本文エリアに合わせる(ユーザー要望) ----
// ネイティブのタイトルバーはWinForms側(Pane/WindowChrome.cs)がDWMのAPIで塗るため、
// 「いまHTML側で実際に描画されている色」をJSから教えてやる必要がある。テーマ切替・
// テーマプリセット・カスタムCSSのどれで色が変わっても、CSS変数の定義を読むのではなく
// getComputedStyleで実際の描画色を読むことで、どの経路の変更にも同じ仕組みで追従できる。
// 受け口はPane/MainForm.csの case "titlebar-color"。
function rgbToHex(value) {
  const m = /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/.exec(value || "");
  if (!m) return null;
  const hex = (n) => Math.max(0, Math.min(255, Math.round(Number(n)))).toString(16).padStart(2, "0");
  return `#${hex(m[1])}${hex(m[2])}${hex(m[3])}`;
}
// 候補セレクタを順に見て、最初に「実際に塗られている」色を返す。
// 透明(rgba(0,0,0,0) / transparent)は「その要素では塗っていない」という意味のため次の候補へ送る。
function readPaintedColor(selectors, prop) {
  for (const sel of selectors) {
    const el = sel === "body" ? document.body : document.querySelector(sel);
    if (!el) continue;
    const value = getComputedStyle(el)[prop];
    if (!value || value === "transparent" || /rgba\(\s*0,\s*0,\s*0,\s*0\s*\)/.test(value)) continue;
    const hex = rgbToHex(value);
    if (hex) return hex;
  }
  return null;
}
let titleBarSyncTimer = null;
function syncTitleBarColor() {
  if (!bridge) return;
  // 背景色と文字色にはCSSのtransition(style.css: transition: background .2s, color .2s)が
  // 掛かっているため、テーマを切り替えた直後にgetComputedStyleすると「遷移中の中間色」が返る。
  // そのまま送るとタイトルバーだけ半端な色で固定されてしまうので、遷移が終わってから読む。
  // 待ち時間は決め打ちにせず実際のtransition-durationから求める
  // (prefers-reduced-motion時は0sになるため待たない。CSS側を変えてもここは追従する)。
  clearTimeout(titleBarSyncTimer);
  const durations = getComputedStyle(document.body).transitionDuration || "0s";
  const maxSeconds = durations.split(",").reduce((max, s) => Math.max(max, parseFloat(s) || 0), 0);
  titleBarSyncTimer = setTimeout(() => {
    const background = readPaintedColor([".cm-editor", "#cm-host", "body"], "backgroundColor");
    const foreground = readPaintedColor([".cm-content", ".cm-editor", "body"], "color");
    if (!background && !foreground) return;
    console.log(`[titlebar] 本文エリアの実描画色をタイトルバーへ反映: background=${background}, foreground=${foreground}`);
    bridge.postMessage({ type: "titlebar-color", background, foreground });
  }, Math.round(maxSeconds * 1000) + 60);
}

function updateStatusMeta() {
  statusEncoding.textContent = currentEncoding ? `文字コード: ${currentEncoding}` : "";
  statusLineEnding.textContent = currentLineEnding ? `改行コード: ${currentLineEnding}` : "";
}
const MODE_LABELS = { markdown: "Markdown", code: "コード", plain: "プレーンテキスト" };
// モード表示ラベル(仕様書 第1章の拡張): コードモードのときは言語名も添える(例: "コード (Python)")。
function modeLabel(mode, language) {
  if (mode === "code" && language) return `コード (${LANGUAGE_LABELS[language] ?? language})`;
  return MODE_LABELS[mode] ?? mode;
}
function updateStatusMode() {
  const mode = editor.getMode();
  statusMode.textContent = modeLabel(mode, editor.getCodeLanguage());
  host.classList.toggle("mode-code", mode === "code");
}

// ---- 自動判定の通知バナー(仕様書 第1章の拡張)。モーダルにせず、ステータスバー付近に
// 浮かべるだけの非侵襲的な表示にする。「切り替えた」通知は8秒程度で自動的に消えるが、
// 「提案」は(取りこぼさないよう)ユーザーが閉じる/選ぶまで残す。----
let adBannerHideTimer = null;
function hideAdBanner() {
  if (adBannerHideTimer) { clearTimeout(adBannerHideTimer); adBannerHideTimer = null; }
  adBanner.hidden = true;
  adBannerAction.hidden = true;
  adBannerAction.onclick = null;
}
function showAdBanner(text, { actionLabel, onAction, autoHideMs } = {}) {
  hideAdBanner();
  adBannerText.textContent = text;
  if (actionLabel) {
    adBannerAction.hidden = false;
    adBannerAction.textContent = actionLabel;
    adBannerAction.onclick = () => { hideAdBanner(); onAction?.(); };
  }
  adBanner.hidden = false;
  if (autoHideMs) adBannerHideTimer = setTimeout(hideAdBanner, autoHideMs);
}
adBannerClose.addEventListener("click", hideAdBanner);

// ---- 内容からの編集モード自動判定(仕様書 第1章の拡張)の適用ロジック ----
// 実際にモード/言語を切り替える(自動切り替え・提案の「切り替える」どちらからも呼ばれる)。
async function performAutoDetectSwitch(result) {
  if (result.mode === "code") await editor.setCodeLanguage(result.language);
  else await editor.setFileMode(currentPath ?? currentName, result.mode);
  updateStatusMode();
}
// 切り替え前の状態(prevMode/prevLanguage)を覚えておき、「元に戻す」で復元する。
function applyAutoDetectSwitch(result, prevMode, prevLanguage) {
  performAutoDetectSwitch(result);
  autoDetectState.suggested = true; // 直接切り替えた場合も、以後の重複提案は不要
  showAdBanner(`自動判定: ${modeLabel(result.mode, result.language)} に切り替えました`, {
    actionLabel: "元に戻す",
    autoHideMs: 8000,
    onAction: () => {
      performAutoDetectSwitch({ mode: prevMode, language: prevLanguage });
      // 「元に戻す」を押した文書には、以後この判定エンジンを一切働かせない(仕様書の指示)。
      autoDetectState.locked = true;
    },
  });
}
// 提案のみ表示する(切り替えない)。同じ文書には1回だけ。
function suggestAutoDetect(result) {
  if (autoDetectState.suggested) return;
  autoDetectState.suggested = true;
  const prevMode = editor.getMode();
  const prevLanguage = editor.getCodeLanguage();
  showAdBanner(`${modeLabel(result.mode, result.language)} として表示しますか?`, {
    actionLabel: "切り替える",
    onAction: () => applyAutoDetectSwitch(result, prevMode, prevLanguage),
  });
}
// 判定を実際に走らせて、autoDetectModeに応じて適用/提案/何もしないを振り分ける。
// 呼び出しはペースト直後・入力停止1.5秒後の2箇所のみ(仕様: 入力のたびには走らせない)。
function runAutoDetect() {
  if (autoDetectMode === "off" || autoDetectState.locked) return;
  const result = detectContentMode(editor.getValue());
  if (result.confidence < AUTO_DETECT_CONFIDENCE_MIN) return;
  if (result.mode === "plain") return; // plainへの自動遷移(切り替え・提案とも)は行わない
  if (result.mode === "code" && !result.language) return; // 言語不明なコード判定は適用しない

  const currentDocMode = editor.getMode();
  const currentDocLanguage = editor.getCodeLanguage();
  const alreadyApplied = result.mode === currentDocMode &&
    (result.mode !== "code" || result.language === currentDocLanguage);
  if (alreadyApplied) return; // 既に同じ表示なら切り替え・提案とも不要

  const isUntitled = !currentPath;
  if (isUntitled) {
    if (autoDetectMode === "suggest") { suggestAutoDetect(result); return; }
    applyAutoDetectSwitch(result, currentDocMode, currentDocLanguage); // standard / aggressive
    return;
  }
  // 拡張子のある(名前が付いた)文書: standardは何もしない。suggest/aggressiveは提案のみ。
  if (autoDetectMode === "standard") return;
  suggestAutoDetect(result);
}
function scheduleAutoDetectIdle() {
  if (idleDetectTimer) clearTimeout(idleDetectTimer);
  idleDetectTimer = setTimeout(() => { idleDetectTimer = null; runAutoDetect(); }, AUTO_DETECT_IDLE_MS);
}

// ---- 言語ピッカー(仕様書 第1章の拡張): #status-mode クリックでコードモードの言語を
// 選び直す。既存のコマンドパレット/クイックオープンと同じ.palette-overlayの仕組みを流用する。
let langPickerOverlay = null;
function closeLanguagePicker() { langPickerOverlay?.remove(); langPickerOverlay = null; }
// onChoose(languageId)を渡すと、選択時にコードモード全体の言語切替(既定の挙動)ではなく
// そちらを呼ぶ(右クリックメニュー「コードブロックの中」→「言語を選択…」、
// docs/コンテキストメニュー仕様.md 第2.6節が、コードモード全体ではなくフェンス1個の
// 情報文字列だけを書き換えたいために一覧UIだけを再利用する)。
function openLanguagePicker(onChoose) {
  if (langPickerOverlay) { closeLanguagePicker(); return; } // 開いている状態での再呼び出しはトグルで閉じる
  const items = codeLanguages
    .map((d) => ({ id: d.name, label: LANGUAGE_LABELS[d.name] ?? d.name }))
    .sort((a, b) => a.label.localeCompare(b.label, "ja"));

  langPickerOverlay = document.createElement("div");
  langPickerOverlay.className = "palette-overlay";
  langPickerOverlay.innerHTML = '<div class="palette"><input id="palette-input" placeholder="言語を検索…" autocomplete="off"><ul id="palette-list"></ul></div>';
  document.body.appendChild(langPickerOverlay);
  const input = langPickerOverlay.querySelector("#palette-input");
  const list = langPickerOverlay.querySelector("#palette-list");
  langPickerOverlay.addEventListener("mousedown", (e) => { if (e.target === langPickerOverlay) closeLanguagePicker(); });

  let filtered = items;
  let sel = 0;
  function choose(item) {
    closeLanguagePicker();
    if (onChoose) { onChoose(item.id); return; }
    editor.setCodeLanguage(item.id).then(updateStatusMode);
    // 手動での言語選択(仕様書 第1章の拡張): 以後この文書には自動判定を行わない。
    autoDetectState.locked = true;
  }
  function render() {
    list.innerHTML = "";
    filtered.forEach((item, i) => {
      const li = document.createElement("li");
      li.className = i === sel ? "sel" : "";
      li.textContent = item.label;
      li.addEventListener("mousedown", (e) => { e.preventDefault(); choose(item); });
      list.appendChild(li);
    });
  }
  function filter() {
    const q = input.value.trim().toLowerCase();
    filtered = !q ? items : items.filter((it) => it.label.toLowerCase().includes(q) || it.id.includes(q));
    sel = 0;
    render();
  }
  input.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { closeLanguagePicker(); return; }
    if (e.key === "ArrowDown") { e.preventDefault(); sel = Math.min(filtered.length - 1, sel + 1); render(); return; }
    if (e.key === "ArrowUp") { e.preventDefault(); sel = Math.max(0, sel - 1); render(); return; }
    if (e.key === "Enter") { e.preventDefault(); const it = filtered[sel]; if (it) choose(it); return; }
  });
  input.addEventListener("input", filter);
  filter();
  input.focus();
}
statusMode.addEventListener("click", () => {
  if (editor.getMode() === "code") openLanguagePicker();
});
function updateWrapButton() {
  statusWrapBtn.textContent = wordWrapOn ? "折り返し: あり" : "折り返し: なし";
}
function pushClosedFile(path) {
  if (!path) return;
  closedFiles.push(path);
  if (closedFiles.length > CLOSED_FILES_CAP) closedFiles.shift();
}
function setReadOnly(readOnly) {
  editor.setEditable(!readOnly);
  isReadOnly = !!readOnly;
}

// PDF/PNG/印刷では、メニューバー等のUI chromeを除外し、CodeMirrorの仮想化
// (画面内のvisibleRangesしかDOMに描画しない最適化)を一時的に解除して文書全体を
// レイアウトへ展開する(仕様書 File項目「エクスポート」「印刷」: 現在の画面だけでなく
// 文書全体が出力対象になるようにする)。CodeMirrorはスクロール領域の実測サイズを基に
// 描画範囲を決めるため、#cm-hostの高さを文書全体の高さまで広げるとCM側が自動的に
// 全行を描画する。
// ヘッダー・フッター文字列(exportHeaderText/exportFooterText)の置換文字列展開(仕様書)。
// {title} {date} {time} {path} はここでその場の値に展開する。{page} {pages}(ページ番号・総数)は
// 文書全体を印刷し終えるまで確定しないため展開せず、そのままC#側(MainForm)へ渡し、
// CSSのcounter(page)/counter(pages)を使って1ページごとに解決させる。
function expandHeaderFooterTemplate(template, fm) {
  if (!template) return "";
  const now = new Date();
  const pad2 = (n) => String(n).padStart(2, "0");
  const dateStr = `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`;
  const timeStr = `${pad2(now.getHours())}:${pad2(now.getMinutes())}`;
  const title = fm?.title ?? currentName;
  return template
    .split("{title}").join(title)
    .split("{date}").join(dateStr)
    .split("{time}").join(timeStr)
    .split("{path}").join(currentPath ?? "");
}
// エクスポート/PDF印刷のページ設定一式を組み立てる(仕様書「エクスポート・印刷」節)。
// exportReadYamlFrontMatterで読んだFront Matterの値(fm)があればexportSettingsより優先する。
function buildExportPageOptions(fm) {
  return {
    paperSize: fm.pageSize ?? exportSettings.exportPaperSize,
    orientation: fm.pageOrientation ?? exportSettings.exportOrientation,
    customWidthMm: fm.pageWidthMm ?? exportSettings.exportCustomWidthMm,
    customHeightMm: fm.pageHeightMm ?? exportSettings.exportCustomHeightMm,
    marginTopMm: fm.marginTopMm ?? exportSettings.exportMarginTopMm,
    marginBottomMm: fm.marginBottomMm ?? exportSettings.exportMarginBottomMm,
    marginLeftMm: fm.marginLeftMm ?? exportSettings.exportMarginLeftMm,
    marginRightMm: fm.marginRightMm ?? exportSettings.exportMarginRightMm,
    headerTemplate: expandHeaderFooterTemplate(fm.header ?? exportSettings.exportHeaderText, fm),
    footerTemplate: expandHeaderFooterTemplate(fm.footer ?? exportSettings.exportFooterText, fm),
    exportDefaultFolder: exportSettings.exportDefaultFolder,
    exportCustomFolder: exportSettings.exportCustomFolder,
    exportAfter: exportSettings.exportAfter,
    exportShowSaveDialog: exportSettings.exportShowSaveDialog,
  };
}
function enterExportLayout() {
  document.body.classList.add("export-layout");
  const h = Math.ceil(editor.view.contentHeight) + 40;
  host.style.height = h + "px";
  editor.view.requestMeasure();
  return h;
}
function exitExportLayout() {
  document.body.classList.remove("export-layout");
  host.style.height = "";
  editor.view.requestMeasure();
}
// 印刷ダイアログ(Ctrl+Alt+P)・PDFエクスポートはいずれもWebView2の印刷パイプラインを
// 経由するため、標準のbeforeprint/afterprintイベントで展開・復元のタイミングを取れる
// (C#側からの完了通知を待つ必要が無い)。
window.addEventListener("beforeprint", enterExportLayout);
window.addEventListener("afterprint", exitExportLayout);

const editor = createEditor(host, {
  onChange() {
    setDirty(true);
    // サイドバー(アウトラインパネル)の更新はsidebar.js側で300msデバウンスし、
    // かつ閉じている間・アウトライン以外を見ている間は再計算しない(性能要件)。
    sidebar.refresh();
    // 内容からの編集モード自動判定(仕様書 第1章の拡張)。ファイルを開く等プログラムによる
    // 内容差し替えでは走らせない(suppressNextAutoDetectChange)。判定を走らせるのは
    // ペースト直後(貼り付け文字数が閾値以上)と入力停止1.5秒後の2箇所だけ。
    if (suppressNextAutoDetectChange) {
      suppressNextAutoDetectChange = false;
      lastPasteLength = 0;
      return;
    }
    const pastedChars = lastPasteLength;
    lastPasteLength = 0;
    if (pastedChars >= AUTO_DETECT_PASTE_MIN_CHARS) runAutoDetect();
    else scheduleAutoDetectIdle();
  },
  // 文字数・行列表示(仕様書 N-03、W-01)。doc変化・カーソル移動のどちらでも軽い集計だけ
  // 行う(重い単語数・段落数集計はW-02のポップアップを開いた時にだけ行う。性能要件)。
  onSelectionChange() {
    updateCount();
    updatePosition();
  },
  // スマートペースト(仕様書 第2.9.3節): クリップボードにHTMLがあればMarkdownへ変換して挿入する。
  // プレーンテキストのみの場合は既定の貼り付け(CM6の処理)に任せる。
  // 併せて貼り付け文字数を記録する(内容からの編集モード自動判定のトリガーに使う。上のonChange参照)。
  onPaste: (e) => {
    const html = e.clipboardData?.getData("text/html");
    const plain = e.clipboardData?.getData("text/plain") || "";
    const imageFile = findClipboardImage(e.clipboardData);
    // クリップボードに画像の実体があり、かつHTML側に文章が無い(実質<img>だけ)場合は、
    // HTMLより画像を優先する。ブラウザで画像を右クリックして「画像をコピー」すると、
    // 画像のバイト列と一緒に <img src="https://..."> というHTMLも載る。HTMLを先に見ると
    // URL参照のMarkdownになってしまい、せっかく手元にある画像の実体が捨てられて
    // オフラインでは表示できなくなる。ここで画像を優先することで、外部へ一切接続せずに
    // ローカルへ保存できる(Webページの文章と画像をまとめてコピーした場合はHTMLに文章が
    // あるため、従来どおりMarkdownへの変換に回る)。
    if (imageFile && !htmlHasText(html)) {
      insertImageFile(imageFile);
      return true;
    }
    if (html) {
      const md = htmlToMarkdown(html).trim();
      if (md) {
        lastPasteLength = md.length;
        editor.pasteText(md);
        return true;
      }
    }
    // HTMLが無い(または変換結果が空)場合。プレーンテキストより画像を優先する
    // (画像をコピーしたときにファイル名だけが貼られる、という取りこぼしを防ぐ)。
    // 仕様書 docs/設定項目一覧.md「画像」節: クリップボードからの貼り付けも画像挿入の経路の1つ。
    if (imageFile) {
      insertImageFile(imageFile);
      return true;
    }
    lastPasteLength = plain.length;
    return false;
  },
  // 既定のコピー形式(仕様書 第2.9.3節、設定でHTML同時コピーに切替可能)
  onCopy: (e) => {
    if (defaultCopyFormat !== "html") return false;
    const sel = editor.view.state.selection.main;
    if (sel.from === sel.to) return false;
    const md = editor.getMarkdownForClipboard();
    const html = editor.getHtmlForClipboard();
    e.clipboardData.setData("text/plain", md);
    e.clipboardData.setData("text/html", html);
    return true;
  },
});
updateCount();
updatePosition();
updateStatusMeta();
updateStatusMode();
updateWrapButton();
updateZoom();

const searchUI = createSearchUI(editor, host);
// 文字数カウントの詳細ポップアップ(仕様書 W-02)。editorが必要なためここで生成する。
const wordCountPopup = createWordCountPopup(editor, document.body);

function getState() {
  return {
    mode: editor.getMode(),
    isReadOnly,
    pandocAvailable,
    wordWrap: wordWrapOn,
    hasClosedFile: closedFiles.length > 0,
    recentFiles,
    sidebarOpen: sidebar.isOpen(),
    sidebarPanel: sidebar.currentPanel(),
    folderLoaded: !!folderData,
    sourceMode: editor.isSourceMode(),
    focusMode: editor.isFocusMode(),
    typewriterMode: editor.isTypewriterMode(),
    fullscreen: windowState.fullscreen,
    alwaysOnTop: windowState.alwaysOnTop,
    showWordCount,
    keyBindings,
  };
}

const ctx = {
  editor,
  bridge,
  getState,
  getFolder: () => folderData, // quick-open.jsが絞り込み対象のファイル一覧を取るのに使う
  // 設定画面(settings.js)がキーバインド再設定中(「キーを押してください」状態)だけtrueにする。
  // commands.js側のbindShortcutsがこれを見て、既存のショートカット発火を一時的に止める。
  shortcutsSuppressed: false,
  actions: {
    async newDocument() {
      if (bridge) { bridge.postMessage({ type: "new" }); return; }
      if (isDirty && !window.confirm("保存されていない変更があります。新規文書を開くと失われますが、よろしいですか?")) return;
      pushClosedFile(currentPath);
      await applyNewDocumentLocal();
    },
    newWindow() {
      if (bridge) bridge.postMessage({ type: "new-window" });
      else window.open(location.href, "_blank", "noopener");
    },
    openFile,
    save: () => saveFile(false),
    saveAs: () => saveFile(true),
    reopenClosed() {
      if (!closedFiles.length || !bridge) return;
      const path = closedFiles.pop();
      bridge.postMessage({ type: "open-path", path });
    },
    openRecentFile(path) {
      bridge?.postMessage({ type: "open-path", path });
    },
    async exportAs(format) {
      if (!bridge) { window.alert("エクスポートはデスクトップアプリ版でのみ利用できます。"); return; }
      // exportReadYamlFrontMatter(仕様書): trueならFront Matterのページ設定等を読んで上書きする。
      // 読み取るキーの一覧はmd-to-html.jsのFRONT_MATTER_KEYSを参照(このファイルが正)。
      const fm = exportSettings.exportReadYamlFrontMatter ? parseFrontMatterOverrides(editor.getValue()) : {};
      let text;
      if (format === "html" || format === "html-plain") {
        // exportPageBreakBetweenTopHeadings/exportIncludeOutline/exportAppendHead/exportAppendBody/
        // exportMathAsはHTMLエクスポートにのみ適用する(PDF/印刷はライブプレビューのDOMをそのまま
        // 印刷するため、これらの構造的な変更はHTML生成側でしか意味を持たない)。
        text = await editor.getStandaloneHtml({
          title: fm.title ?? currentName,
          styled: format === "html",
          mathAs: exportSettings.exportMathAs,
          pageBreakBetweenTopHeadings: exportSettings.exportPageBreakBetweenTopHeadings,
          includeOutline: exportSettings.exportIncludeOutline,
          outlineWidthPx: exportSettings.exportOutlineWidthPx,
          appendHead: exportSettings.exportAppendHead,
          appendBody: exportSettings.exportAppendBody,
          rootUrl: fm.rootUrl ?? null,
        });
      } else {
        text = editor.getValue(); // pdfは本文を使わない。docx/epubはMarkdown原文をPandocへ渡す。
      }
      // PDF/印刷はbeforeprint/afterprintで自動的にレイアウトを展開・復元する(enterExportLayout参照)。
      // pageOptionsは主にformat==="pdf"のときC#側(CoreWebView2PrintSettings)が使う。
      // それ以外の形式でもexportDefaultFolder等の出力先設定は共通で使う。
      bridge.postMessage({ type: "export", format, text, pageOptions: buildExportPageOptions(fm) });
    },
    print() {
      // 用紙サイズ・余白・ヘッダー/フッター等の詳細設定(仕様書「エクスポート・印刷」節)は
      // WebView2のShowPrintUI(ネイティブ印刷ダイアログ)には渡せないAPI上の制約があるため、
      // この経路(File>印刷、Ctrl+Alt+P)には適用されない(PDFエクスポートにのみ適用される。
      // 詳細はMainForm.HandlePrintRequestAsyncのコメントを参照)。
      if (bridge) bridge.postMessage({ type: "print" });
      else window.print();
    },
    // 設定画面(仕様書 第2.10節 C-01〜C-14)。本体ウィンドウより大きく表示できるよう、
    // 独立した専用ウィンドウ(Pane/SettingsWindow.cs、src/settings-entry.js)をC#側に
    // 開かせる(同時に1つしか開かない。既に開いていればC#側が前面に出す)。
    // ブリッジが無いブラウザ単体動作(開発確認用)では専用ウィンドウを開かせようが無いため、
    // 従来どおりHTML製のモーダル(settings.js)を出すフォールバックを残す。
    openSettings(category) {
      if (bridge) { bridge.postMessage({ type: "open-settings-window" }); return; }
      settingsUI?.open(category);
    },
    async closeWindow() {
      // 未保存の変更がある場合の保存確認はC#側(FormClosing)が一元的に行う
      // (ネイティブのXボタン・Alt+F4で閉じた場合と挙動を揃えるため)。
      if (bridge) { bridge.postMessage({ type: "close" }); return; }
      if (isDirty && !window.confirm("保存されていない変更があります。閉じてもよろしいですか?")) return;
      window.close();
    },
    async copyAsMarkdown() {
      try { await navigator.clipboard.writeText(editor.getMarkdownForClipboard()); } catch { /* クリップボード権限が無い環境ではベストエフォート */ }
    },
    async copyAsHtml() {
      const html = editor.getHtmlForClipboard();
      const md = editor.getMarkdownForClipboard();
      try {
        await navigator.clipboard.write([
          new ClipboardItem({
            "text/html": new Blob([html], { type: "text/html" }),
            "text/plain": new Blob([md], { type: "text/plain" }),
          }),
        ]);
      } catch {
        try { await navigator.clipboard.writeText(md); } catch { /* ベストエフォート */ }
      }
    },
    async pasteAsPlainText() {
      try {
        const text = await navigator.clipboard.readText();
        editor.pasteText(text);
      } catch { /* クリップボード読み取り権限が無ければ何もしない */ }
    },
    // 右クリックメニュー「画像を開く」(docs/コンテキストメニュー仕様.md 2.4)。
    // 既定のビューアで開く操作自体はC#(WinForms)側の機能のため、ブリッジが無い
    // ブラウザ単体動作では提供できない。
    openImageFile(rawSrc) {
      if (!bridge) { window.alert("既定のビューアで開く機能はデスクトップアプリ版でのみ利用できます。"); return; }
      const resolved = resolveImageFsPath(rawSrc);
      if (!resolved) return;
      bridge.postMessage({ type: "open-in-default-app", path: resolved });
    },
    openSearch() { searchUI.open(false); },
    openReplace() { searchUI.open(true); },
    insertImageFlow() {
      if (bridge) { bridge.postMessage({ type: "insert-image" }); return; }
      imageInput.click(); // ブラウザ単体時のフォールバック
    },
    async setMode(mode) {
      await editor.setFileMode(currentPath ?? currentName, mode);
      updateStatusMode();
      // 手動でモードを選んだ文書には、以後内容からの自動判定(仕様書 第1章の拡張)を行わない。
      autoDetectState.locked = true;
      // 手動切替の記憶(仕様書 第1章)。無題(パス無し)の場合はブリッジへ送らず、その場の変更のみ行う。
      if (!currentPath) return;
      if (mode === autoFileMode(currentName)) {
        // 自動判定と同じ選択に戻した場合は記憶自体を消す(設定ファイルが不要に太るのを防ぐ)。
        delete perFileModes[currentPath];
        bridge?.postMessage({ type: "remember-file-mode", path: currentPath, mode: null });
      } else {
        perFileModes[currentPath] = mode;
        bridge?.postMessage({ type: "remember-file-mode", path: currentPath, mode });
      }
    },
    toggleWordWrap() {
      wordWrapOn = !wordWrapOn;
      editor.setWordWrap(wordWrapOn);
      updateWrapButton();
    },
    gotoLineFlow() {
      const total = editor.getValue().split("\n").length;
      const input = window.prompt(`移動する行番号を入力してください(1〜${total})`);
      if (!input) return;
      const n = parseInt(input, 10);
      if (Number.isFinite(n)) editor.gotoLine(n);
    },
    // ソースコードモード(V-05)・フォーカスモード(V-06)・タイプライターモード(V-07)。
    // いずれもcompartment切替の実体はeditor.js側に持ち、ここは単純なトグルの橋渡し。
    toggleSourceMode() { editor.setSourceMode(!editor.isSourceMode()); },
    toggleFocusMode() { editor.setFocusMode(!editor.isFocusMode()); },
    toggleTypewriterMode() { editor.setTypewriterMode(!editor.isTypewriterMode()); },
    // 全画面表示(V-08)・開いている文書を切り替え(V-11)・常に手前に表示(V-12)は
    // いずれもC#側(WinForms)が実体を持つため、メッセージを送るだけ。実際の状態は
    // "window-state"メッセージで折り返し届く(handleHostMessage参照)。
    toggleFullscreen() { bridge?.postMessage({ type: "toggle-fullscreen" }); },
    toggleAlwaysOnTop() { bridge?.postMessage({ type: "toggle-always-on-top" }); },
    switchDocument() { bridge?.postMessage({ type: "switch-document" }); },
    // 文字サイズ(V-09/V-10)。既存のCtrl+マウスホイールと同じeditor.setFontSize()を使い、
    // 変更後はCtrl+ホイールと同じくset-font-sizeメッセージで永続化する(setFontSizeAndPersist参照)。
    zoomIn() { setFontSizeAndPersist(editor.getFontSize() + 1); },
    zoomOut() { setFontSizeAndPersist(editor.getFontSize() - 1); },
    zoomReset() { setFontSizeAndPersist(DEFAULT_FONT_SIZE); },
    // 文字数カウントの表示切替(V-13)。C#側に永続化の受け口がまだ無くても支障が無いよう、
    // 送るだけで応答は待たない({ type: "set-show-word-count" }、専用メッセージ)。
    toggleWordCount() {
      showWordCount = !showWordCount;
      updateWordCountVisibility();
      bridge?.postMessage({ type: "set-show-word-count", value: showWordCount });
    },
    openDevTools() { bridge?.postMessage({ type: "open-devtools" }); },
    openFolder() {
      // フォルダ選択ダイアログ自体がC#側(WinForms)の機能のため、ブリッジが無い
      // ブラウザ単体動作では提供できない(仕様書 S-02/S-03はデスクトップアプリ前提)。
      if (!bridge) { window.alert("フォルダを開く機能はデスクトップアプリ版でのみ利用できます。"); return; }
      bridge.postMessage({ type: "open-folder" });
    },
    openFileByPath(path, line) {
      // lineが指定された場合(グローバル検索の結果クリック等)は、file-openedが届いて
      // 実際に開いたパスが一致した時点でその行へジャンプする(pendingGotoLine参照)。
      pendingGotoLine = line != null ? { path, line } : null;
      bridge?.postMessage({ type: "open-path", path });
    },
    // サイドバーのファイル一覧・ツリーからの切替専用(仕様書 saveWithoutAskingOnSwitch)。
    // 有効時は未保存の変更があっても確認せず保存してから切り替える。無効時(既定)は
    // 従来どおりopenFileByPathと同じ経路を通り、保存確認自体はC#側(ConfirmDiscardDirtyAsync)に
    // 任せる。グローバル検索結果・クイックオープンからの遷移は対象外(仕様書の範囲外のため、
    // 引き続きopenFileByPathを直接使う)。
    async switchFileFromSidebar(path) {
      if (saveWithoutAskingOnSwitch && isDirty) {
        if (bridge) await saveFileAndWait(false);
        else await saveFile(false); // bridgeが無い場合のsaveFileは同期的に完結する
      }
      ctx.actions.openFileByPath(path);
    },
    // グローバル検索(仕様書 第2.6節 G-01)。Ctrl+Shift+Fから呼ばれる。
    openGlobalSearch() { sidebar.openSearch(); },
    // 日時の挿入(仕様書 第3章 N-14、メモ帳のF5相当)。既存のpasteText(貼り付け相当の挿入)を
    // そのまま使い、editor.jsは変更しない。
    insertDateTime() { editor.pasteText(formatDateTimeStamp(new Date())); },
    // openQuickOpenはcreateQuickOpen(ctx)がctxを必要とする(sidebarと同じ循環依存)ため、
    // quickOpen生成後にctx.actionsへ追加する(下方参照)。
  },
};

// サイドバー(仕様書 第2.8節・第10.4節)。ctxを引数に取るためctx構築後に生成し、
// 開閉・パネル切替のactionsはここでctx.actionsへ追加する
// (buildCommands等はctxへの参照を保持するだけで遅延評価するため、この順序で問題ない)。
const sidebar = createSidebar(editor, ctx);
ctx.actions.toggleSidebar = () => sidebar.toggle();
ctx.actions.showSidebarPanel = (panel) => sidebar.showPanel(panel);
statusSidebarBtn.addEventListener("click", () => ctx.actions.toggleSidebar());

// クイックオープン(仕様書 F-05)。sidebarと同様、ctxを必要とするためctx構築後に生成する。
const quickOpen = createQuickOpen(ctx);
ctx.actions.openQuickOpen = () => quickOpen.open();

const commands = buildCommands(ctx);
bindShortcuts(commands, ctx);
const menuBar = initMenuBar(menubarEl, commands, ctx);
const commandPalette = initCommandPalette(document.body, commands, ctx);
// 右クリック(コンテキスト)メニュー(docs/コンテキストメニュー仕様.md)。documentに1つだけ
// 登録し、入力欄(input/textarea)かどうかはinitContextMenu自身が最優先で判定する
// (検索ボックス・設定画面の入力欄など、どこにあっても同じ最小メニューになる、第5節)。
// それ以外は本文(CodeMirror)の上かどうかで判定する(サイドバーの行別メニューは
// sidebar.js自身がshowContextMenuを使って個別に配線しており、ここには含めない)。
initContextMenu(document, ctx, (c, e) => (host.contains(e.target) ? buildEditorContextMenuTree(c, e) : null));

// 設定画面(仕様書 第2.10節)。キーバインドタブがコマンド一覧を必要とするため、
// buildCommands()の後でctx.commandsとして公開してから生成する。
ctx.commands = commands;
settingsUI = createSettings(ctx);

// 検証用の入口。ブリッジが無いとき(=WebView2ではなく素のブラウザで開いたとき)だけ公開する。
// Pane本体(WebView2)では window.chrome.webview が必ず存在するため、この分岐は常に偽になり
// 製品の動作には一切影響しない。リポジトリの検証スクリプト(.verify-*.mjs)はブラウザ上で
// エディタ内部のAPI(エクスポートHTMLの生成など、画面操作だけでは到達できないもの)を
// 直接呼ぶ必要があるため、その足場として置いている。
if (!bridge) {
  window.__paneDebugEditor = editor;
  window.__paneDebugCtx = ctx;
}

// ---- 右クリックメニュー: 本文(CodeMirror)の上(docs/コンテキストメニュー仕様.md 第2章・第3章) ----
// commands配列(File/Edit/Paragraph/Format/View)の中から、右クリックメニューでも使う項目を
// そのまま拝借する小さなヘルパー。有効/チェック状態の評価もcommands配列の定義(grayed/enabled/
// checked)にそのまま従うため、メニューバー・コマンドパレットと表示が食い違わない。
function fromCommand(id, overrides) {
  const c = commands.find((cmd) => cmd.id === id);
  if (!c) return null;
  const grayed = c.grayed?.(ctx) ?? false;
  const enabled = !grayed && (c.enabled ? c.enabled(ctx) : true);
  return { label: c.label, shortcut: c.shortcut, enabled, checked: !!c.checked?.(ctx), run: c.run, ...overrides };
}
const clip = (text) => navigator.clipboard.writeText(text).catch(() => {}); // クリップボードコピーはベストエフォート

function buildEditorContextMenuTree(c, e) {
  const mode = editor.getMode();
  const info = editor.resolveContextMenu(e.clientX, e.clientY, e.target);
  if (!info) return null;
  const hasSelection = info.hasSelection;

  // ---- コード/プレーンテキストモード(第3章): マークダウン固有の項目は一切出さない ----
  if (mode !== "markdown") {
    const tree = [
      { label: "切り取り", enabled: hasSelection, run: () => document.execCommand("cut") },
      { label: "コピー", enabled: hasSelection, run: () => document.execCommand("copy") },
      { label: "貼り付け", run: () => pasteRichFromContextMenu() },
      { label: "すべて選択", run: () => editor.applyAction("selectAll"), separatorAfter: true },
      { label: "元に戻す", run: () => editor.applyAction("undo") },
      { label: "やり直す", run: () => editor.applyAction("redo"), separatorAfter: true },
      fromCommand("edit.find"),
      { ...fromCommand("edit.replace"), separatorAfter: mode !== "code" },
    ];
    if (mode === "code") tree.push({ label: "言語を選択…", run: () => openLanguagePicker() });
    return tree;
  }

  // ---- Markdownモード(第2章) ----
  const tree = [];

  // 2.3〜2.9: 文脈固有セクション(該当する場合のみ)
  if (info.kind === "link") {
    tree.push(
      { label: "リンクを開く", run: () => editor.openLink(info.href) },
      { label: "リンクのURLをコピー", run: () => clip(info.href) },
      { label: "リンクを編集…", run: () => editor.applyAction("linkEditUrl") },
      { label: "リンクを解除", run: () => editor.applyAction("linkUnlink"), separatorAfter: true },
    );
  } else if (info.kind === "image") {
    const isOnline = /^[a-zA-Z][\w+.-]*:/.test(info.src) || info.src.startsWith("//");
    if (isOnline) {
      tree.push({ label: "このURLをコピー", run: () => clip(info.src), separatorAfter: true });
    } else {
      tree.push(
        { label: "画像を開く", enabled: !!bridge, run: () => ctx.actions.openImageFile(info.src) },
        { label: "画像のパスをコピー", run: () => clip(info.src) },
        { label: "画像のパスを編集…", run: () => editor.applyAction("imageEditPath") },
        { label: "画像を削除", run: () => editor.applyAction("imageDelete"), separatorAfter: true },
      );
    }
  } else if (info.kind === "table") {
    tree.push(
      { label: "行を上に挿入", run: () => editor.applyAction("tableInsertRowAbove", info) },
      { label: "行を下に挿入", run: () => editor.applyAction("tableInsertRowBelow", info) },
      { label: "列を左に挿入", run: () => editor.applyAction("tableInsertColLeft", info) },
      { label: "列を右に挿入", run: () => editor.applyAction("tableInsertColRight", info), separatorAfter: true },
      { label: "行を削除", enabled: info.rowKind === "body", run: () => editor.applyAction("deleteTableRow") },
      { label: "列を削除", enabled: info.cols > 1, run: () => editor.applyAction("tableDeleteCol", info) },
      { label: "表を削除", run: () => editor.applyAction("tableDelete"), separatorAfter: true },
      {
        label: "列の配置",
        submenu: [
          { label: "左揃え", run: () => editor.applyAction("tableAlignLeft", info) },
          { label: "中央揃え", run: () => editor.applyAction("tableAlignCenter", info) },
          { label: "右揃え", run: () => editor.applyAction("tableAlignRight", info) },
          { label: "指定なし", run: () => editor.applyAction("tableAlignNone", info) },
        ],
        separatorAfter: true,
      },
    );
  } else if (info.kind === "codeblock") {
    tree.push(
      { label: "言語を選択…", run: () => openLanguagePicker((id) => editor.applyAction("codeblockSetLang", { lang: id })) },
      { label: "コードブロックの内容をコピー", run: () => clip(info.code) },
      { label: "コードブロックを削除", run: () => editor.applyAction("codeblockDelete"), separatorAfter: true },
    );
  } else if (info.kind === "heading") {
    const levels = [1, 2, 3, 4, 5, 6].map((lv) => ({ label: `見出し${lv}`, checked: info.level === lv, run: () => editor.applyAction(`h${lv}`) }));
    tree.push({ label: "見出しレベル", submenu: [...levels, { label: "段落(見出し解除)", run: () => editor.applyAction("h0") }], separatorAfter: true });
  } else if (info.kind === "list") {
    // 既存のpara.listBullet/listOrdered/listCheck(いずれもcontextOnly、commands.js)を
    // そのまま使う。checkedだけは現在の種別(info.listType)から上書きする
    // (これらのコマンド定義自体にはchecked判定を持たせていないため)。
    tree.push(
      fromCommand("para.listBullet", { checked: info.listType === "bullet" }),
      fromCommand("para.listOrdered", { checked: info.listType === "ordered" }),
      fromCommand("para.listCheck", { checked: info.listType === "check" }),
      fromCommand("para.indent"),
      { ...fromCommand("para.outdent"), separatorAfter: true },
    );
  } else if (info.kind === "math") {
    tree.push(
      { label: "数式を編集", run: () => editor.applyAction("mathEditSelect") },
      { label: "数式を削除", run: () => editor.applyAction("mathDelete"), separatorAfter: true },
    );
  }

  // 2.1: 編集セクション(常時)
  tree.push(
    { label: "切り取り", enabled: hasSelection, run: () => document.execCommand("cut") },
    { label: "コピー", enabled: hasSelection, run: () => document.execCommand("copy") },
    { label: "貼り付け", run: () => pasteRichFromContextMenu() },
    fromCommand("edit.pastePlain"),
    { label: "すべて選択", run: () => editor.applyAction("selectAll") },
    { ...fromCommand("edit.copyMarkdown"), enabled: hasSelection },
    { ...fromCommand("edit.copyHtml"), enabled: hasSelection, separatorAfter: true },
  );

  // 2.2: 書式サブメニュー(選択がある場合)
  if (hasSelection) {
    tree.push({
      label: "書式",
      submenu: [
        fromCommand("format.bold"), fromCommand("format.italic"), fromCommand("format.underline"),
        fromCommand("format.code"), fromCommand("format.strike"), fromCommand("format.highlight"),
        fromCommand("format.superscript"), { ...fromCommand("format.subscript"), separatorAfter: true },
        fromCommand("format.link"), fromCommand("format.eraseFormat"),
      ],
    });
  }

  // 2.11: 段落サブメニュー(選択も文脈も無い場合のみ)
  if (!hasSelection && info.kind === "paragraph") {
    tree.push({
      label: "段落",
      submenu: [
        fromCommand("para.h1"), fromCommand("para.h2"), fromCommand("para.h3"),
        fromCommand("para.h4"), fromCommand("para.h5"), { ...fromCommand("para.h6"), separatorAfter: true },
        fromCommand("para.p"), fromCommand("para.quote"), fromCommand("para.list"), fromCommand("para.olist"),
        { label: "タスクリスト", run: () => editor.applyAction("check"), separatorAfter: true },
        fromCommand("para.table"), fromCommand("para.codeblock"), fromCommand("para.mathBlock"),
        { label: "水平線", run: () => editor.applyAction("hr") },
      ],
    });
  }

  // 2.10: その他セクション(常時)
  tree.push({ label: "元に戻す", run: () => editor.applyAction("undo") });
  tree.push({ label: "やり直す", run: () => editor.applyAction("redo"), separatorAfter: true });
  tree.push({ label: "検索…", run: () => ctx.actions.openSearch() });
  if (hasSelection) tree.push({ label: "選択箇所を検索", run: () => ctx.actions.openSearch() });

  return tree;
}

// 貼り付け(仕様書 コンテキストメニュー仕様 2.1「常時 | 既存の貼り付け経路」)。
// 通常のキー操作(Ctrl+V)はcontentDOMへの本物のpasteイベント(main.jsのonPaste)で処理されるが、
// 右クリックメニューからは本物のpasteイベントを発生させられないため、非同期Clipboard API
// (navigator.clipboard.read())でHTML/画像/プレーンテキストを順に試す。onPasteと同じ優先順位
// (HTML→画像→プレーン)に揃える。read()自体が使えない/権限が無い環境ではプレーンテキスト
// 貼り付け(既存のpasteAsPlainText経路)へフォールバックする。
async function pasteRichFromContextMenu() {
  if (!navigator.clipboard?.read) { await ctx.actions.pasteAsPlainText(); return; }
  try {
    const items = await navigator.clipboard.read();
    for (const item of items) {
      if (!item.types.includes("text/html")) continue;
      const html = await (await item.getType("text/html")).text();
      const md = htmlToMarkdown(html).trim();
      if (md) { editor.pasteText(md); return; }
    }
    for (const item of items) {
      const imgType = item.types.find((ty) => ty.startsWith("image/"));
      if (!imgType) continue;
      const blob = await item.getType(imgType);
      await insertImageFile(new File([blob], "clipboard." + imgType.split("/")[1], { type: imgType }));
      return;
    }
  } catch {
    // クリップボード読み取り権限が無い等はプレーンテキストへフォールバック
  }
  await ctx.actions.pasteAsPlainText();
}

// 画像を既定のビューアで開く(docs/コンテキストメニュー仕様.md 2.4)。ライブプレビューの<img>の
// srcはWebView2内で表示するための解決(resolveImageSrc、typora-root-url対応)であって実際の
// ファイルシステム上のパスではないため、ここでは現在の文書のフォルダを基準に別途解決する
// (front matterのtypora-root-urlまでは追わない簡易実装)。
function resolveImageFsPath(rawSrc) {
  if (!rawSrc || /^[a-zA-Z][\w+.-]*:/.test(rawSrc) || rawSrc.startsWith("//")) return null; // オンライン画像等
  if (/^[a-zA-Z]:[\\/]/.test(rawSrc) || rawSrc.startsWith("\\\\")) return rawSrc; // 既に絶対パス
  if (!currentPath) return null; // 無題文書では相対パスの基準が無い
  const dir = currentPath.replace(/[\\/][^\\/]*$/, "");
  return dir + "\\" + rawSrc.replace(/\//g, "\\");
}

// コマンドパレット(Ctrl+Shift+P、仕様書 第10.1節)。5つのメニューのどれにも属さないため
// commands.jsの宣言的なショートカット一覧ではなく、ここで直接待ち受ける。
window.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === "p") {
    e.preventDefault();
    commandPalette.open();
  }
});
statusWrapBtn.addEventListener("click", () => ctx.actions.toggleWordWrap());
statusZoom.addEventListener("click", () => ctx.actions.zoomReset());
statusCount.addEventListener("click", () => { if (showWordCount) wordCountPopup.toggle(statusCount); });

// 本文の文字サイズを変更し、ズーム率表示を更新したうえでC#側へ永続化する(仕様書 V-09/V-10)。
// Ctrl+マウスホイール(下記)とView メニューの拡大/縮小/実際のサイズ(ctx.actions)の
// どちらから呼ばれても同じ経路を通る。
function setFontSizeAndPersist(size) {
  const applied = editor.setFontSize(size);
  updateZoom();
  bridge?.postMessage({ type: "set-font-size", size: applied });
}

// Ctrl+マウスホイールで本文の文字サイズを変更する。WebView2側のページズーム
// (IsZoomControlEnabled=falseで無効化済み)はメニューバー・ステータスバーまで
// 拡大してしまうため使わず、CodeMirrorのフォントサイズだけを変える。
window.addEventListener("wheel", (e) => {
  if (!e.ctrlKey || !zoomWithCtrlWheelOn) return; // 仕様書 zoomWithCtrlWheel: falseなら何もしない
  e.preventDefault();
  setFontSizeAndPersist(editor.getFontSize() + (e.deltaY < 0 ? 1 : -1));
}, { passive: false });

// ---- WebView2ブリッジ(Phase 2) ----
if (bridge) {
  bridge.addEventListener("message", (e) => {
    if (e.data?.type !== "text-response") logToHost("log", `C#からのメッセージ受信: type=${e.data?.type}`);
    handleHostMessage(e.data);
  });
  bridge.postMessage({ type: "ready" });
}

// 拡張子既定(fileModeOverridesがあればそちらを優先)による自動判定。
// setMode()が「手動で選んだモードが自動判定と一致するか」を調べるのにも使う
// (この判定にはperFileModes自体は含めない。手動記憶を上書きするかどうかの判定のため)。
function autoFileMode(fileName) {
  const ext = fileName ? (fileName.split(".").pop() || "").toLowerCase() : null;
  if (ext && Object.prototype.hasOwnProperty.call(fileModeOverrides, ext)) {
    return fileModeOverrides[ext];
  }
  return resolveFileMode(fileName);
}
// 編集モード決定(仕様書 第1章)。優先順位: 1.そのファイルパスの手動記憶(perFileModes)
// 2.拡張子ごとの既定モード上書き(fileModeOverrides) 3.拡張子からの既定判定(resolveFileMode)。
function decideFileMode(path, fileName) {
  if (path && Object.prototype.hasOwnProperty.call(perFileModes, path)) {
    return perFileModes[path];
  }
  // 保存先がまだ無い文書(新規作成、および異常終了からの復元で元ファイルのパスが無い場合)は、
  // 無題の新規文書と同じ扱いでMarkdownにする。C#側は表示名として"無題"を送ってくるため、
  // これをそのまま拡張子判定に掛けると「"無題"という拡張子」とみなされてプレーンテキストへ
  // 落ちてしまう(復元したMarkdown文書がプレーンテキストで開く不具合の原因だった)。
  if (!path) return autoFileMode(null);
  return autoFileMode(fileName);
}

async function applyFileOpened(msg) {
  pushClosedFile(currentPath);
  resetAutoDetectState(); // 文書が変わるので内容からの自動判定の状態(仕様書 第1章の拡張)もリセット
  // 拡張子だけでなく、拡張子ごとの既定モード上書き・ファイル単位の手動記憶も考慮する(仕様書 第1章)。
  await editor.setFileMode(msg.fileName, decideFileMode(msg.path ?? null, msg.fileName));
  // 「.LOG」の自動追記(仕様書 第3章 N-15、メモ帳互換): 1行目が".LOG"だけのファイルを
  // 開いた直後、末尾へ日時を追記してdirty状態にする。読み取り専用ファイルは対象外
  // (保存できないものをdirty扱いにしても混乱を招くだけのため)。
  const firstLine = (msg.text ?? "").split(/\r?\n/, 1)[0];
  const isLogFile = firstLine === ".LOG" && !msg.readOnly;
  setEditorValueQuiet(msg.text);
  setName(msg.fileName);
  currentPath = msg.path ?? null;
  currentEncoding = msg.encoding;
  currentLineEnding = msg.lineEnding;
  setReadOnly(msg.readOnly);
  if (isLogFile) {
    const stamp = formatDateTimeStamp(new Date());
    const endPos = editor.view.state.doc.length;
    const insertText = (endPos > 0 ? "\n" : "") + stamp;
    // ファイルを開いた直後のプログラムによる変更のため、内容からの自動判定(仕様書 第1章の拡張)は
    // 走らせない(setEditorValueQuietと同じ抑制の仕組みを使う)。
    suppressNextAutoDetectChange = true;
    editor.view.dispatch({ changes: { from: endPos, insert: insertText }, selection: { anchor: endPos + insertText.length } });
    suppressNextAutoDetectChange = false;
    setDirty(true); // 追記した時点で未保存状態にする(仕様書どおり)
  } else {
    setDirty(false);
  }
  updateCount();
  updateStatusMeta();
  updateStatusMode();
  sidebar.setCurrentPath(currentPath); // files/treeパネルの現在ファイルハイライトを更新
  // グローバル検索のヒット行クリックからの遷移なら、指定行へジャンプする。
  // 開いたパスが期待と違う場合(保存確認でユーザーがキャンセルした等でC#側が別のファイルを
  // 返した/開かなかった場合)は、一致しないので保留を捨てるだけにする。
  if (pendingGotoLine) {
    if (pendingGotoLine.path === currentPath) editor.gotoLine(pendingGotoLine.line);
    pendingGotoLine = null;
  }
}
async function applyNewDocumentLocal() {
  resetAutoDetectState(); // 文書が変わるので内容からの自動判定の状態(仕様書 第1章の拡張)もリセット
  // 無題の新規文書はパス・ファイル名とも無いため、decideFileMode(null, null)は常にmarkdownを返す。
  await editor.setFileMode(null, decideFileMode(null, null));
  setEditorValueQuiet("");
  setName("無題");
  currentPath = null;
  currentEncoding = null;
  currentLineEnding = null;
  setReadOnly(false);
  setDirty(false);
  updateCount();
  updateStatusMeta();
  updateStatusMode();
  sidebar.setCurrentPath(null); // 無題の新規文書には対応するファイルが無いのでハイライトを外す
}

async function handleHostMessage(msg) {
  switch (msg?.type) {
    case "file-opened":
      await applyFileOpened(msg);
      break;
    case "new-document":
      pushClosedFile(currentPath);
      await applyNewDocumentLocal();
      break;
    case "save-result":
      if (msg.ok) {
        // 名前を付けて保存で拡張子が変わった場合はモードを再判定する(不具合修正: 従来は
        // setName()するだけでeditor.setFileMode()を呼んでおらず、モードが古いままだった)。
        const prevExt = (currentName.split(".").pop() || "").toLowerCase();
        const nextExt = (msg.fileName.split(".").pop() || "").toLowerCase();
        const wasUntitled = !currentPath;
        setName(msg.fileName);
        currentPath = msg.path ?? currentPath;
        // 無題の新規文書が拡張子付きで保存された時点で、以後の内容からの自動判定
        // (仕様書 第1章の拡張)は行わない(拡張子が優先されるべきため)。
        if (wasUntitled && currentPath) autoDetectState.locked = true;
        currentEncoding = msg.encoding;
        currentLineEnding = msg.lineEnding;
        setReadOnly(false);
        setDirty(false);
        updateStatusMeta();
        if (nextExt !== prevExt) {
          await editor.setFileMode(currentName, decideFileMode(currentPath, currentName));
          updateStatusMode();
        }
      }
      // キャンセル・失敗時はダーティ状態を維持する(msg.errorがあれば将来トースト表示等に使う)
      // switchFileFromSidebar()がsaveFileAndWait()で待っている場合はここで解決する
      // (成功・失敗いずれの場合も、待機側を永久に止めないよう解決する)。
      if (pendingSaveResolvers.length) {
        const resolvers = pendingSaveResolvers;
        pendingSaveResolvers = [];
        for (const resolve of resolvers) resolve();
      }
      break;
    case "request-text":
      // 自動保存(仕様書 N-06): C#側は本文を持たないため、要求されたら都度返す。
      bridge?.postMessage({ type: "text-response", text: editor.getValue() });
      break;
    case "request-save":
      // 未保存の変更を残したまま閉じる/新規作成する/別ファイルを開く前の保存確認
      // (C#側ConfirmDiscardDirtyAsync)から届く。通常のCtrl+Sと同じ保存フローを使う。
      saveFile(false);
      break;
    case "apply-settings":
      // マークダウン記法拡張のON/OFF(仕様書 第2.10節 C-01)・最近使ったファイル(F-09)・
      // Pandoc導入状況・既定コピー形式。起動時と設定変更時、最近使ったファイル更新時に届く。
      editor.setExtensionToggles({
        callouts: msg.calloutsEnabled,
        // 既存コードはmsg.superSubEnabledという存在しないキーを参照しており、C#側が実際に
        // 送るキー名(superSubscriptEnabled)と食い違っていたため、上付き・下付きの設定が
        // 常にundefinedになり反映されていなかった(このバグを機に修正する)。
        superSub: msg.superSubscriptEnabled,
        highlight: msg.highlightEnabled,
        inlineMath: msg.inlineMathEnabled,
        mathAutoNumber: msg.mathAutoNumber,
        // 記法サポートのON/OFF(仕様書「記法サポート」節)。diagrams/codeBlockMath/autoLinksは
        // いずれもextTogglesField経由でライブプレビュー側の描画を切り替える。
        diagrams: msg.diagramsEnabled,
        codeBlockMath: msg.codeBlockMathEnabled,
        autoLinks: msg.autoLinksEnabled,
        // 編集の挙動(仕様書「編集」節)。
        codeAutoWrap: msg.codeAutoWrap,
        liveRenderingShowSourceOnFocus: msg.liveRenderingShowSourceOnFocus,
        emojiAutocomplete: msg.emojiAutocomplete,
        copyWholeLineWhenNoSelection: msg.copyWholeLineWhenNoSelection,
        typewriterKeepCaretCentered: msg.typewriterKeepCaretCentered,
        shiftTabAutoIndent: msg.shiftTabAutoIndent,
        autoPairMarkdown: msg.autoPairMarkdown,
        // 記法の書き方(メニューバーから作るときの形。仕様書「記法の書き方」節)。
        headingStyle: msg.headingStyle,
        unorderedListMarker: msg.unorderedListMarker,
        orderedListMarker: msg.orderedListMarker,
        indentSizeOnSave: msg.indentSizeOnSave,
        defaultCodeLanguage: msg.defaultCodeLanguage,
        defaultCodeLanguageApplyWhen: msg.defaultCodeLanguageApplyWhen,
        // 空白と改行・スマート置換(仕様書「空白と改行」「スマート置換」節)。
        whitespaceWhenWriting: msg.whitespaceWhenWriting,
        whitespaceOnExport: msg.whitespaceOnExport,
        smartQuotes: msg.smartQuotes,
        smartDashes: msg.smartDashes,
        recognizeUnicodePunctuation: msg.recognizeUnicodePunctuation,
      });
      // コードブロックのインデント幅(仕様書 codeIndentSize)。CodeMirrorのindentUnitを切り替える。
      editor.setCodeIndentSize(msg.codeIndentSize);
      // 自動ペアリング(仕様書 第2.10節 C-05、括弧・引用符)。setAutoPairing自体は既に実装済みだが
      // ここからの配線が抜けていたため、他の設定と同じ流儀で追加する。
      editor.setAutoPairing(msg.autoPairing !== false);
      // スペルチェック(仕様書 spellCheckEnabled)。.cm-contentのspellcheck属性を切り替える。
      // spellCheckAutoCorrect(自動修正)はWebView2側の機能でJSからは制御できないため未実装。
      editor.setSpellCheck(!!msg.spellCheckEnabled);
      // アウトラインに出す見出しの最大レベル(仕様書 chapterLevelInOutline、既定6)。
      // sidebar.jsは編集不可のため、共有の既定値(markdown-extras.jsのoutlineMaxLevel)を
      // ここで更新することでアウトライン・[toc]記法双方の絞り込みに反映させる。
      setOutlineMaxLevel(msg.chapterLevelInOutline ?? 6);
      defaultCopyFormat = msg.defaultCopyFormat ?? "markdown";
      pandocAvailable = !!msg.pandocAvailable;
      recentFiles = msg.recentFiles ?? [];
      // エクスポート・印刷の詳細設定(仕様書「エクスポート・印刷」節)。届いたキーだけ上書きし、
      // 未指定のキーは既定値(exportSettingsの初期値)を保つ。
      for (const key of Object.keys(exportSettings)) {
        if (msg[key] !== undefined) exportSettings[key] = msg[key];
      }
      // テーマ(仕様書 第10.2節): 手動で切り替えた選択を永続化している。"system"ならOS設定
      // (index.htmlの起動時スクリプトが既に反映済み)のままにする。
      if (msg.theme === "light" || msg.theme === "dark") {
        document.documentElement.dataset.theme = msg.theme;
      }
      // テーマプリセット(仕様書 第2.10節 C-06)。src/themes.css側の
      // :root[data-theme="light"][data-light-theme="..."] 等のセレクタで上書きされる。
      // 未設定/不明な値でも属性自体は付けておき、"default"相当(上書きなし)にフォールバックする。
      document.documentElement.dataset.lightTheme = msg.lightTheme || "default";
      document.documentElement.dataset.darkTheme = msg.darkTheme || "default";
      // CodeMirror側(キャレット色・選択範囲色)はgetComputedStyleで一度だけ色を読むため、
      // ライト/ダーク切替・プリセット切替のいずれでも都度refreshThemeして反映させる。
      editor.refreshTheme();
      // 本文の文字サイズ(Ctrl+マウスホイールでの変更を永続化している)
      editor.setFontSize(msg.editorFontSize || DEFAULT_FONT_SIZE);
      updateZoom();
      // 文字数カウントの表示(仕様書 V-13)。C#側にまだ受け口が無い場合はmsg.showWordCountが
      // undefinedになるため、その場合は既定のON(showWordCountの初期値)を維持する。
      if (typeof msg.showWordCount === "boolean") {
        showWordCount = msg.showWordCount;
        updateWordCountVisibility();
      }
      // 本文フォントと等幅フォント(仕様書 第2.10節 C-08)。
      // インラインスタイルで#cm-hostへ直接当てると、コードブロック・インラインコード・
      // コードモードのように「本文とは別に等幅を当てたい」箇所まで継承で巻き込んでしまい、
      // 等幅フォントの設定がまったく効かなくなっていた。CSSカスタムプロパティを上書きする
      // 形にして、本文用(--editor-font-body)と等幅用(--editor-font-mono)を
      // それぞれの箇所で使い分けられるようにする。
      // 未設定なら変数自体を消して、style.cssの既定(--font-body / --font-mono)へ戻す。
      const rootStyle = document.documentElement.style;
      host.style.fontFamily = ""; // 旧実装のインラインスタイルが残っていたら外す
      applyFontSetting(rootStyle, "--editor-font-body", msg.editorFontFamily, "本文フォント");
      applyFontSetting(rootStyle, "--editor-font-mono", msg.editorMonospaceFontFamily, "等幅フォント");
      // 本文の最大幅(0=テーマ既定)と行の高さ(仕様書 C-08)。style.css側が
      // --editor-max-width / --editor-line-height を参照する。
      const maxWidth = Number(msg.editorMaxWidthPx);
      if (Number.isFinite(maxWidth) && maxWidth > 0) rootStyle.setProperty("--editor-max-width", `${maxWidth}px`);
      else rootStyle.removeProperty("--editor-max-width");
      const lineHeight = Number(msg.editorLineHeight);
      if (Number.isFinite(lineHeight) && lineHeight > 0) rootStyle.setProperty("--editor-line-height", String(lineHeight));
      else rootStyle.removeProperty("--editor-line-height");
      // 本文の左右余白(仕様書 editorPaddingX、既定32)。style.css側が
      // var(--editor-padding-x, 32px) を参照する想定。0以下や未指定なら変数を消してCSS既定に戻す。
      const paddingX = Number(msg.editorPaddingX);
      if (Number.isFinite(paddingX) && paddingX > 0) rootStyle.setProperty("--editor-padding-x", `${paddingX}px`);
      else rootStyle.removeProperty("--editor-padding-x");
      // カスタムCSS(仕様書 第2.10節 C-07)。C#側がファイル内容を読み込んで文字列として送ってくる
      // (file://は仮想ホスト配下から読めないため)。<head>内の専用<style>要素のtextContentへ
      // 反映する(innerHTMLは使わない)。要素が無ければここで生成する。
      applyCustomCss(msg.customCss ?? "");
      // ここまでで本文エリアの色が確定する(テーマ・プリセット・カスタムCSSのすべて)。
      // その実描画色をネイティブのタイトルバーへ反映する。
      syncTitleBarColor();
      // キーバインド(仕様書 C-10)。既存のcommands配列を直接書き換えるため、メニューバー・
      // コマンドパレット・ショートカット待受けはいずれも再起動なしに新しい割り当てを拾う。
      keyBindings = msg.keyBindings ?? {};
      applyKeyBindings(commands, keyBindings);
      // 編集モード決定(仕様書 第1章)の優先順位2・3を上書きする設定。ブリッジが無い
      // ブラウザ単体動作ではapply-settings自体が届かないため、その場合は既定の空のままになる。
      fileModeOverrides = msg.fileModeOverrides ?? {};
      perFileModes = msg.perFileModes ?? {};
      // 内容からの編集モード自動判定(仕様書 第1章の拡張)。未指定・不明値は"standard"として扱う。
      autoDetectMode = AUTO_DETECT_MODES.has(msg.autoDetectMode) ? msg.autoDetectMode : "standard";
      // ステータスバー表示(仕様書 showStatusBar、既定true)。非表示時は#main-areaがflex:1で
      // 自動的に本文エリアの高さを吸収する(index.html側のレイアウトはそのまま)。
      statusbarEl.style.display = msg.showStatusBar === false ? "none" : "";
      // Ctrl+マウスホイールでの文字サイズ変更(仕様書 zoomWithCtrlWheel、既定true)。
      zoomWithCtrlWheelOn = msg.zoomWithCtrlWheel !== false;
      // サイドバーからのファイル切替時の保存確認スキップ(仕様書 saveWithoutAskingOnSwitch、既定false)。
      saveWithoutAskingOnSwitch = !!msg.saveWithoutAskingOnSwitch;
      // 読了時間の計算に使う語/分(仕様書 readingSpeedWpm、0=自動)。text-stats.js側のモジュール
      // 状態を更新するだけで、word-count.jsの詳細ポップアップにも(editor.getDetailedStats()経由で)
      // 自動的に反映される。
      setReadingSpeedWpm(msg.readingSpeedWpm ?? 0);
      // アウトラインパネルの折りたたみ可否(仕様書 collapsibleOutline、既定true)。
      if (typeof msg.collapsibleOutline === "boolean") sidebar.setCollapsibleOutline(msg.collapsibleOutline);
      // 起動時にアウトラインを既定表示するか(仕様書 showOutlineByDefault、既定false)。
      // 「起動時1回だけ」のため、以後のapply-settings再送では判定自体を行わない
      // (ユーザーが手で閉じた後に勝手に再度開かないようにするため)。
      if (!initialSidebarAutoOpenDone) {
        initialSidebarAutoOpenDone = true;
        if (msg.showOutlineByDefault) sidebar.open("outline");
      }
      break;
    case "image-inserted":
      // 画像挿入(仕様書 R-07)。C#側でファイルコピー・相対パス解決を終えたものが届く。
      editor.applyAction("image", { alt: msg.alt ?? "", path: msg.path ?? "" });
      break;
    case "export-done":
      // PNGエクスポート完了(成功・失敗いずれでも届く)。enterExportLayout()での展開を復元する。
      exitExportLayout();
      break;
    case "folder-loaded":
      // フォルダ読み込み結果(仕様書 第2.8節 S-02/S-03)。"open-folder"/"load-folder"に加え、
      // ファイルを開いた際の親フォルダ自動読み込みでも明示操作なしに届く。
      if (msg.error) {
        // クイックオープン用のfolderData(直近の成功データ)はそのまま残し、
        // サイドバーの表示にだけ失敗した旨を伝える。
        sidebar.setFolder({ error: msg.error });
      } else {
        folderData = msg;
        sidebar.setFolder(msg);
      }
      break;
    case "search-results":
      // グローバル検索(仕様書 第2.6節 G-01/G-02)のヒットが逐次届く。
      sidebar.handleSearchResults(msg.hits ?? []);
      break;
    case "search-done":
      // グローバル検索の完了通知(打ち切り・エラー時もこのtypeで届く)。
      sidebar.handleSearchDone(msg);
      break;
    case "settings":
      // 設定画面(settings.js)からのget-settings応答。画面を開いていない/既に読み込み済みの
      // 場合は内部でno-opになる。
      settingsUI?.handleSettingsLoaded(msg);
      break;
    case "save-settings-result":
      settingsUI?.handleSaveResult(msg);
      break;
    case "window-state":
      // 全画面表示(V-08)・常に手前に表示(V-12)の実際の状態はC#側(WinForms)が持ち、
      // トグル操作のたび・起動直後に届く。ここは表示専用(メニューのcheckedに反映するだけ)。
      windowState = { fullscreen: !!msg.fullscreen, alwaysOnTop: !!msg.alwaysOnTop };
      break;
    case "menu-command":
      // ネイティブメニュー(Pane/NativeMenu.cs)で項目が選ばれた。メニューバー/右クリック
      // メニューのどちらから開いたかに応じて、最後に開いた側(commands.jsが覚えている)へ
      // ルーティングする(コマンドの実装はC#側に持たせない。commands.js参照)。
      routeNativeMenuCommand(msg.id);
      break;
    case "menu-closed":
      // ネイティブメニューが選択なしで閉じられた。見出しのハイライト解除・外側クリック監視の
      // 解除を、開いていた側(メニューバー or 右クリックメニュー)だけに委ねる。
      routeNativeMenuClosed(msg.menu);
      break;
  }
}

async function openFile() {
  if (bridge) {
    bridge.postMessage({ type: "open" });
    return;
  }
  if (window.showOpenFilePicker) {
    let handles;
    try {
      handles = await window.showOpenFilePicker({
        types: [{ description: "Markdown / テキスト", accept: { "text/plain": [".md", ".markdown", ".mdown", ".txt"] } }],
      });
    } catch {
      return; // ユーザーによるキャンセル
    }
    const [handle] = handles;
    const file = await handle.getFile();
    resetAutoDetectState();
    await editor.setFileMode(file.name);
    setEditorValueQuiet(await file.text());
    currentHandle = handle;
    setName(file.name);
    setDirty(false);
    updateCount();
    updateStatusMode();
    return;
  }
  fileInput.click();
}

fileInput.addEventListener("change", async () => {
  const file = fileInput.files[0];
  if (!file) return;
  resetAutoDetectState();
  await editor.setFileMode(file.name);
  setEditorValueQuiet(await file.text());
  currentHandle = null;
  setName(file.name);
  setDirty(false);
  updateCount();
  updateStatusMode();
  fileInput.value = "";
});

// 画像挿入(仕様書 docs/設定項目一覧.md「画像」節)の共通経路。メニュー「画像を挿入」の
// ファイルダイアログ以外(ドラッグ&ドロップ・クリップボードからの貼り付け・ブラウザ単体時の
// <input type=file>フォールバック)はいずれもWebView2の標準DOM File APIでは実パスが
// 分からないため、ここでバイト列化してC#側(imageInsertAction等の設定を反映する
// ImageInsertService)へ渡す。ブリッジが無いブラウザ単体動作ではdata URIとして直接埋め込む
// (相対パス保存ができないための開発確認用フォールバック)。
async function insertImageFile(file) {
  if (bridge) {
    const buf = await file.arrayBuffer();
    bridge.postMessage({
      type: "insert-image",
      dataBase64: arrayBufferToBase64(buf),
      name: file.name || "image.png",
    });
    return;
  }
  const dataUrl = await new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.readAsDataURL(file);
  });
  editor.applyAction("image", { alt: (file.name || "image").replace(/\.[^.]+$/, ""), path: dataUrl });
}
function isImageFile(file) {
  if (file.type && file.type.startsWith("image/")) return true;
  return /\.(png|jpe?g|gif|svg|webp|bmp)$/i.test(file.name || "");
}
// クリップボードから画像の実体を取り出す。
// filesだけでは取りこぼす場合があるためitemsも見る(スクリーンショットのように
// ファイル名を持たないビットマップは、環境によってfilesに現れないことがある)。
function findClipboardImage(clipboardData) {
  if (!clipboardData) return null;
  const fromFiles = Array.from(clipboardData.files ?? []).find((f) => isImageFile(f));
  if (fromFiles) return fromFiles;
  for (const item of Array.from(clipboardData.items ?? [])) {
    if (item.kind !== "file") continue;
    if (!item.type || !item.type.startsWith("image/")) continue;
    const file = item.getAsFile();
    if (file) return file;
  }
  return null;
}
// クリップボードのHTMLに「文章」が含まれているかどうか。
// ブラウザで画像を右クリックして「画像をコピー」した場合のHTMLは実質<img>だけで、
// タグを取り除くと何も残らない。この判定で「画像のコピー」と「文章ごとのコピー」を見分ける。
function htmlHasText(html) {
  if (!html) return false;
  const doc = new DOMParser().parseFromString(html, "text/html");
  return (doc.body?.textContent ?? "").trim().length > 0;
}
imageInput.addEventListener("change", async () => {
  const file = imageInput.files[0];
  if (!file) return;
  await insertImageFile(file);
  imageInput.value = "";
});

// ウィンドウへのファイルD&D。WebView2は本文エリアではWebページとしてドラッグ&ドロップを
// 扱うため、HTML5の標準どおりdragoverでpreventDefault()しないとブラウザが既定で
// ドロップを拒否し、禁止マークが出て何も起きない(C#側のOLEドラッグ&ドロップ設定とは
// 無関係)。標準のDOM File APIでは実パスが分からないため、ブリッジがある場合はバイト列を
// C#へ渡して開き直す(エンコーディング判定・保存はC#側で行う。パスが無いため保存時は
// 名前を付けて保存になる)。
function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}
function hasFileDrag(e) {
  return !!e.dataTransfer && Array.from(e.dataTransfer.types || []).includes("Files");
}
// captureフェーズ(第3引数true)で登録する。CodeMirror自身がエディタ内テキストの
// ドラッグ移動用にdragover/drop相当を独自処理しており、bubbleフェーズで登録すると
// そちらが先に処理してこちらまで届かない(stopPropagation等で握りつぶされる)ことがある。
window.addEventListener("dragenter", (e) => { if (hasFileDrag(e)) e.preventDefault(); }, true);
window.addEventListener("dragover", (e) => { if (hasFileDrag(e)) e.preventDefault(); }, true);
window.addEventListener("drop", async (e) => {
  logToHost("log", `drop event: hasFileDrag=${hasFileDrag(e)}, filesCount=${e.dataTransfer?.files?.length ?? 0}`);
  if (!hasFileDrag(e) || !e.dataTransfer.files.length) return;
  e.preventDefault();
  e.stopPropagation();
  const file = e.dataTransfer.files[0];
  // 画像ファイルのドロップは「このファイルを開く」ではなく「本文へ画像を挿入する」として扱う
  // (仕様書 docs/設定項目一覧.md「画像」節: 画像挿入の3経路の1つ)。
  if (isImageFile(file)) {
    await insertImageFile(file);
    return;
  }
  // 本文が空(新規ファイル等、失われる内容が無い)ならこのウィンドウで開き、
  // 何か書かれていれば新しいウィンドウで開く。
  const isEmptyDocument = editor.getValue().trim() === "";
  if (bridge) {
    const buf = await file.arrayBuffer();
    logToHost("log", `open-dropped-fileを送信: name=${file.name}, size=${buf.byteLength}, newWindow=${!isEmptyDocument}`);
    bridge.postMessage({
      type: "open-dropped-file",
      name: file.name,
      dataBase64: arrayBufferToBase64(buf),
      newWindow: !isEmptyDocument,
    });
    return;
  }
  // ブラウザ単体時は新規ウィンドウを作れないため、確認のうえこのウィンドウで開く。
  if (!isEmptyDocument && !window.confirm("現在の内容を閉じて、ドロップしたファイルを開きますか?")) return;
  resetAutoDetectState();
  await editor.setFileMode(file.name);
  setEditorValueQuiet(await file.text());
  currentHandle = null;
  currentPath = null;
  setName(file.name);
  setDirty(false);
  updateCount();
  updateStatusMode();
}, true);

// switchFileFromSidebar()専用: saveFile()を呼び出し、対応する"save-result"が届くまで待つ。
// saveFile()自体はpostMessageを送るだけで完了を待たない(結果は非同期にhandleHostMessageへ
// 届く)ため、ここでPromise化して待機できるようにする。
function saveFileAndWait(forcePicker) {
  return new Promise((resolve) => {
    pendingSaveResolvers.push(resolve);
    saveFile(forcePicker);
  });
}

async function saveFile(forcePicker) {
  const text = editor.getValue();
  if (bridge) {
    bridge.postMessage({ type: "save", text, saveAs: !!forcePicker });
    return;
  }
  if (window.showSaveFilePicker) {
    if (!currentHandle || forcePicker) {
      try {
        currentHandle = await window.showSaveFilePicker({
          suggestedName: currentName === "無題" ? "無題.md" : currentName,
          types: [{ description: "Markdown", accept: { "text/plain": [".md"] } }],
        });
      } catch {
        return; // ユーザーによるキャンセル
      }
    }
    const writable = await currentHandle.createWritable();
    await writable.write(text);
    await writable.close();
    setName(currentHandle.name);
    setDirty(false);
    return;
  }
  // File System Access API 非対応ブラウザ向けのダウンロード保存
  const blob = new Blob([text], { type: "text/plain" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = currentName === "無題" ? "無題.md" : currentName;
  a.click();
  URL.revokeObjectURL(a.href);
  setDirty(false);
}

document.getElementById("btn-theme").addEventListener("click", () => {
  const cur = document.documentElement.dataset.theme;
  const next = cur === "dark" ? "light" : "dark";
  document.documentElement.dataset.theme = next;
  editor.refreshTheme();
  // 手動選択を永続化する(仕様書 第10.2節)。次回起動時もOS設定に戻らないようにする。
  bridge?.postMessage({ type: "set-theme", theme: next });
  // タイトルバーも本文エリアと同じ色に切り替える。
  syncTitleBarColor();
});
// 設定画面(仕様書 第2.10節)はHTML製で、ブリッジが無いブラウザ単体動作でも開ける
// (保存はできないが画面自体は操作できる。ctx.actions.openSettings参照)ため、常に表示する。
const btnSettings = document.getElementById("btn-settings");
if (btnSettings) {
  btnSettings.addEventListener("click", () => ctx.actions.openSettings());
}

window.addEventListener("beforeunload", (e) => {
  if (isDirty) {
    e.preventDefault();
    e.returnValue = "";
  }
});
