// Pane エントリポイント。
// WebView2(window.chrome.webview)が使える場合はpostMessageブリッジでC#側に
// ファイルの開閉・保存・エクスポート・印刷・画像挿入等を委譲する(仕様書 第7章)。
// 使えない場合(単体のブラウザで動作確認する場合)は File System Access API /
// File API による仮実装にフォールバックする(Phase 1からの経路をそのまま維持)。
import { createEditor } from "./editor.js";
import { buildCommands, initMenuBar, initCommandPalette, initContextMenu, bindShortcuts } from "./commands.js";
import { createSearchUI } from "./search-ui.js";
import { htmlToMarkdown } from "./html-to-markdown.js";

const host = document.getElementById("cm-host");
const menubarEl = document.getElementById("menubar");
const statusMode = document.getElementById("status-mode");
const statusCount = document.getElementById("status-count");
const statusEncoding = document.getElementById("status-encoding");
const statusLineEnding = document.getElementById("status-line-ending");
const statusWrapBtn = document.getElementById("status-wrap");
const fileInput = document.getElementById("file-input");
const imageInput = document.getElementById("image-input");

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
// ダーティ・読み取り専用の表示はOSネイティブのウィンドウタイトルが兼ねる(C#側UpdateTitle)ため、
// HTML側は確認ダイアログの判定等に使う内部状態としてのみ保持する。
let isDirty = false;
let isReadOnly = false;
const closedFiles = []; // 閉じたファイルを再度開く(このウィンドウ内での置き換え履歴、ブリッジ利用時のみ)
const CLOSED_FILES_CAP = 20;

function setDirty(v) {
  isDirty = v;
  bridge?.postMessage({ type: "dirty", value: v });
}
function setName(name) {
  currentName = name;
}
function updateCount() {
  statusCount.textContent = `${editor.getValue().length}文字`;
}
function updateStatusMeta() {
  statusEncoding.textContent = currentEncoding ? `文字コード: ${currentEncoding}` : "";
  statusLineEnding.textContent = currentLineEnding ? `改行コード: ${currentLineEnding}` : "";
}
const MODE_LABELS = { markdown: "Markdown", code: "コード", plain: "プレーンテキスト" };
function updateStatusMode() {
  const mode = editor.getMode();
  statusMode.textContent = MODE_LABELS[mode] ?? mode;
  host.classList.toggle("mode-code", mode === "code");
}
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
    updateCount();
  },
  // スマートペースト(仕様書 第2.9.3節): クリップボードにHTMLがあればMarkdownへ変換して挿入する。
  // プレーンテキストのみの場合は既定の貼り付け(CM6の処理)に任せる。
  onPaste: (e) => {
    const html = e.clipboardData?.getData("text/html");
    if (!html) return false;
    const md = htmlToMarkdown(html).trim();
    if (!md) return false;
    editor.pasteText(md);
    return true;
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
updateStatusMeta();
updateStatusMode();
updateWrapButton();

const searchUI = createSearchUI(editor, host);

function getState() {
  return {
    mode: editor.getMode(),
    isReadOnly,
    pandocAvailable,
    wordWrap: wordWrapOn,
    hasClosedFile: closedFiles.length > 0,
    recentFiles,
  };
}

const ctx = {
  editor,
  bridge,
  getState,
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
      else text = editor.getValue(); // pdf/pngは本文を使わない。docx/epubはMarkdown原文をPandocへ渡す。
      let captureHeight;
      if (format === "png") {
        // PDF/印刷はbeforeprint/afterprintで自動的に展開・復元されるが、PNGは印刷パイプラインを
        // 経由しないため、ここで明示的に展開し、C#側からの"export-done"到着時に復元する。
        captureHeight = enterExportLayout();
        await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      }
      bridge.postMessage({ type: "export", format, text, captureHeight });
    },
    print() {
      if (bridge) bridge.postMessage({ type: "print" });
      else window.print();
    },
    openSettings() { bridge?.postMessage({ type: "open-settings" }); },
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
    openDevTools() { bridge?.postMessage({ type: "open-devtools" }); },
  },
};

const commands = buildCommands(ctx);
bindShortcuts(commands, ctx);
initMenuBar(menubarEl, commands, ctx);
const commandPalette = initCommandPalette(document.body, commands, ctx);
initContextMenu(host, commands, ctx, resolveContextCommandIds);

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

// ---- WebView2ブリッジ(Phase 2) ----
if (bridge) {
  bridge.addEventListener("message", (e) => {
    if (e.data?.type !== "text-response") logToHost("log", `C#からのメッセージ受信: type=${e.data?.type}`);
    handleHostMessage(e.data);
  });
  bridge.postMessage({ type: "ready" });
}

async function applyFileOpened(msg) {
  pushClosedFile(currentPath);
  await editor.setFileMode(msg.fileName); // 拡張子から編集モードを切替(仕様書 第1章)
  editor.setValue(msg.text);
  setName(msg.fileName);
  currentPath = msg.path ?? null;
  currentEncoding = msg.encoding;
  currentLineEnding = msg.lineEnding;
  setReadOnly(msg.readOnly);
  setDirty(false);
  updateCount();
  updateStatusMeta();
  updateStatusMode();
}
async function applyNewDocumentLocal() {
  await editor.setFileMode(null); // 無題の新規文書は既定でMarkdownモード
  editor.setValue("");
  setName("無題");
  currentPath = null;
  currentEncoding = null;
  currentLineEnding = null;
  setReadOnly(false);
  setDirty(false);
  updateCount();
  updateStatusMeta();
  updateStatusMode();
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
        setName(msg.fileName);
        currentPath = msg.path ?? currentPath;
        currentEncoding = msg.encoding;
        currentLineEnding = msg.lineEnding;
        setReadOnly(false);
        setDirty(false);
        updateStatusMeta();
      }
      // キャンセル・失敗時はダーティ状態を維持する(msg.errorがあれば将来トースト表示等に使う)
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
      break;
    case "image-inserted":
      // 画像挿入(仕様書 R-07)。C#側でファイルコピー・相対パス解決を終えたものが届く。
      editor.applyAction("image", { alt: msg.alt ?? "", path: msg.path ?? "" });
      break;
    case "export-done":
      // PNGエクスポート完了(成功・失敗いずれでも届く)。enterExportLayout()での展開を復元する。
      exitExportLayout();
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
    await editor.setFileMode(file.name);
    editor.setValue(await file.text());
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
  await editor.setFileMode(file.name);
  editor.setValue(await file.text());
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
  document.documentElement.dataset.theme = cur === "dark" ? "light" : "dark";
  editor.refreshTheme();
});
// 設定ダイアログはC#側のネイティブウィンドウで表示する(Phase 3時点の最小実装、Phase 8で置き換え)。
const btnSettings = document.getElementById("btn-settings");
if (btnSettings) {
  btnSettings.hidden = !bridge;
  btnSettings.addEventListener("click", () => ctx.actions.openSettings());
}

window.addEventListener("beforeunload", (e) => {
  if (isDirty) {
    e.preventDefault();
    e.returnValue = "";
  }
});
