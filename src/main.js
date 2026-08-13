// Pane エントリポイント。
// WebView2(window.chrome.webview)が使える場合はpostMessageブリッジでC#側に
// ファイルの開閉・保存・エクスポート・印刷・画像挿入等を委譲する(仕様書 第7章)。
// 使えない場合(単体のブラウザで動作確認する場合)は File System Access API /
// File API による仮実装にフォールバックする(Phase 1からの経路をそのまま維持)。
import { createEditor, DEFAULT_FONT_SIZE } from "./editor.js";
import { buildCommands, initMenuBar, initCommandPalette, initContextMenu, bindShortcuts, applyKeyBindings } from "./commands.js";
import { createSearchUI } from "./search-ui.js";
import { createSidebar } from "./sidebar.js";
import { createQuickOpen } from "./quick-open.js";
import { createWordCountPopup } from "./word-count.js";
import { createSettings } from "./settings.js";
import { htmlToMarkdown } from "./html-to-markdown.js";
import { resolveFileMode, codeLanguages } from "./languages.js";
import { FILE_TYPES } from "./file-types.js";
import { detectContentMode } from "./detect-mode.js";
import { setReadingSpeedWpm } from "./text-stats.js";

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
function openLanguagePicker() {
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
    if (html) {
      const md = htmlToMarkdown(html).trim();
      if (md) {
        lastPasteLength = md.length;
        editor.pasteText(md);
        return true;
      }
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
      let text;
      if (format === "html") text = editor.getStandaloneHtml(currentName, true);
      else if (format === "html-plain") text = editor.getStandaloneHtml(currentName, false);
      else text = editor.getValue(); // pdfは本文を使わない。docx/epubはMarkdown原文をPandocへ渡す。
      // PDF/印刷はbeforeprint/afterprintで自動的にレイアウトを展開・復元する(enterExportLayout参照)。
      bridge.postMessage({ type: "export", format, text });
    },
    print() {
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
initContextMenu(host, commands, ctx, resolveContextCommandIds);

// 設定画面(仕様書 第2.10節)。キーバインドタブがコマンド一覧を必要とするため、
// buildCommands()の後でctx.commandsとして公開してから生成する。
ctx.commands = commands;
settingsUI = createSettings(ctx);

// 右クリックメニュー: リスト行の上ではリスト種別の相互変換(仕様書 P-13)を提示する。
// それ以外は既定のブラウザメニューに任せる(コンテキストメニューの対応範囲はPhase 5時点ではここまで)。
function resolveContextCommandIds(_ctx, e) {
  const view = editor.view;
  const pos = view.posAtCoords({ x: e.clientX, y: e.clientY });
  if (pos == null) return null;
  const line = view.state.doc.lineAt(pos);
  if (/^\s*(?:[-*+]\s+(?:\[[ xX]\]\s*)?|\d+\.\s+)/.test(line.text)) {
    return ["para.listBullet", "para.listOrdered", "para.listCheck"];
  }
  return null;
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
        superSub: msg.superSubEnabled,
        highlight: msg.highlightEnabled,
        inlineMath: msg.inlineMathEnabled,
        mathAutoNumber: msg.mathAutoNumberEnabled,
      });
      defaultCopyFormat = msg.defaultCopyFormat ?? "markdown";
      pandocAvailable = !!msg.pandocAvailable;
      recentFiles = msg.recentFiles ?? [];
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
      if (msg.editorFontFamily) rootStyle.setProperty("--editor-font-body", msg.editorFontFamily);
      else rootStyle.removeProperty("--editor-font-body");
      if (msg.editorMonospaceFontFamily) rootStyle.setProperty("--editor-font-mono", msg.editorMonospaceFontFamily);
      else rootStyle.removeProperty("--editor-font-mono");
      // カスタムCSS(仕様書 第2.10節 C-07)。C#側がファイル内容を読み込んで文字列として送ってくる
      // (file://は仮想ホスト配下から読めないため)。<head>内の専用<style>要素のtextContentへ
      // 反映する(innerHTMLは使わない)。要素が無ければここで生成する。
      applyCustomCss(msg.customCss ?? "");
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
      // ネイティブメニュー(Pane/NativeMenu.cs)で項目が選ばれた。既存のcommands配列から
      // idで引いて実行する(コマンドの実装はC#側に持たせない。commands.js参照)。
      menuBar.handleMenuCommand(msg.id);
      break;
    case "menu-closed":
      // ネイティブメニューが選択なしで閉じられた。見出しのハイライトを解除するだけ。
      menuBar.handleMenuClosed(msg.menu);
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

// 画像挿入のブラウザ単体フォールバック(仕様書 R-07): ブリッジが無い場合は
// 相対パス保存ができないため、data URIとして直接埋め込む(開発確認用の簡易対応)。
imageInput.addEventListener("change", async () => {
  const file = imageInput.files[0];
  if (!file) return;
  const dataUrl = await new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.readAsDataURL(file);
  });
  editor.applyAction("image", { alt: file.name.replace(/\.[^.]+$/, ""), path: dataUrl });
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
