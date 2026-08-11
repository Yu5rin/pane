// Pane 単体動作確認用エントリポイント(Phase 1)。
// ファイルの開閉は File API / File System Access API による仮実装。
// Phase 2 で C#(WebView2)側の実装に置き換える。
import { createEditor } from "./editor.js";

const host = document.getElementById("cm-host");
const titlebar = document.getElementById("titlebar");
const filenameEl = document.getElementById("filename");
const statusCount = document.getElementById("status-count");
const fileInput = document.getElementById("file-input");

let currentHandle = null;
let currentName = "無題";

function setDirty(v) {
  titlebar.classList.toggle("dirty", v);
}
function setName(name) {
  currentName = name;
  filenameEl.textContent = name;
}
function updateCount() {
  statusCount.textContent = `${editor.getValue().length}文字`;
}

const editor = createEditor(host, {
  onChange() {
    setDirty(true);
    updateCount();
  },
});
updateCount();

async function openFile() {
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
