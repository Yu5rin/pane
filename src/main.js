// Pane エントリポイント。
// WebView2(window.chrome.webview)が使える場合はpostMessageブリッジでC#側に
// ファイルの開閉・保存を委譲する(Phase 2、仕様書 第7章)。
// 使えない場合(単体のブラウザで動作確認する場合)は File System Access API /
// File API による仮実装にフォールバックする(Phase 1からの経路をそのまま維持)。
import { createEditor } from "./editor.js";

const host = document.getElementById("cm-host");
const titlebar = document.getElementById("titlebar");
const filenameEl = document.getElementById("filename");
const statusCount = document.getElementById("status-count");
const statusEncoding = document.getElementById("status-encoding");
const statusLineEnding = document.getElementById("status-line-ending");
const fileInput = document.getElementById("file-input");

const bridge = window.chrome?.webview ?? null;

let currentHandle = null; // File System Access API(ブラウザ単体時のみ使用)
let currentName = "無題";
let currentEncoding = null;
let currentLineEnding = null;

function setDirty(v) {
  titlebar.classList.toggle("dirty", v);
  bridge?.postMessage({ type: "dirty", value: v });
}
function setName(name) {
  currentName = name;
  filenameEl.textContent = name;
}
function updateCount() {
  statusCount.textContent = `${editor.getValue().length}文字`;
}
function updateStatusMeta() {
  statusEncoding.textContent = currentEncoding ?? "";
  statusLineEnding.textContent = currentLineEnding ?? "";
}

const editor = createEditor(host, {
  onChange() {
    setDirty(true);
    updateCount();
  },
});
updateCount();
updateStatusMeta();

// ---- WebView2ブリッジ(Phase 2) ----
if (bridge) {
  bridge.addEventListener("message", (e) => handleHostMessage(e.data));
  bridge.postMessage({ type: "ready" });
}

function handleHostMessage(msg) {
  switch (msg?.type) {
    case "file-opened":
      editor.setValue(msg.text);
      setName(msg.fileName);
      currentEncoding = msg.encoding;
      currentLineEnding = msg.lineEnding;
      setDirty(false);
      updateCount();
      updateStatusMeta();
      break;
    case "new-document":
      editor.setValue("");
      setName("無題");
      currentEncoding = null;
      currentLineEnding = null;
      setDirty(false);
      updateCount();
      updateStatusMeta();
      break;
    case "save-result":
      if (msg.ok) {
        setName(msg.fileName);
        currentEncoding = msg.encoding;
        currentLineEnding = msg.lineEnding;
        setDirty(false);
        updateStatusMeta();
      }
      // キャンセル・失敗時はダーティ状態を維持する(msg.errorがあれば将来トースト表示等に使う)
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
    editor.setValue(await file.text());
    currentHandle = handle;
    setName(file.name);
    setDirty(false);
    updateCount();
    return;
  }
  fileInput.click();
}

fileInput.addEventListener("change", async () => {
  const file = fileInput.files[0];
  if (!file) return;
  editor.setValue(await file.text());
  currentHandle = null;
  setName(file.name);
  setDirty(false);
  updateCount();
  fileInput.value = "";
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

document.getElementById("btn-open").addEventListener("click", openFile);
document.getElementById("btn-save").addEventListener("click", () => saveFile(false));
document.getElementById("btn-save-as").addEventListener("click", () => saveFile(true));
document.getElementById("btn-theme").addEventListener("click", () => {
  const cur = document.documentElement.dataset.theme;
  document.documentElement.dataset.theme = cur === "dark" ? "light" : "dark";
});

window.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
    e.preventDefault();
    saveFile(e.shiftKey);
  }
});

window.addEventListener("beforeunload", (e) => {
  if (titlebar.classList.contains("dirty")) {
    e.preventDefault();
    e.returnValue = "";
  }
});
