// カスタムCSSの作成補助(仕様書 第2.10.1節 C-16)の見本。css-editor-window.html の iframe の中で、
// 本文ウィンドウと同じエディタ部品(editor.js)を読み取り専用で置き、見本の文書を表示する。
//
// 見本を iframe に分けているのは、編集中のCSSを作成補助の画面そのもの(フォームやボタン)に
// 当てないため(仕様書)。同じオリジン(pane.local)なので、親とは postMessage でやり取りする。
// このページは C# とは直接話さない(WebView2 の chrome.webview は最上位のフレームにしか無い)。
import { createEditor } from "./editor.js";

// 見本の文書。見た目を決める要素をひととおり含める(仕様書 第2.10.1節の一覧)。
const SAMPLE = `# 見出し1

本文の段落です。**太字**、*斜体*、~~取り消し線~~、==ハイライト==、\`インラインコード\`、[リンク](https://example.com) を含みます。

## 見出し2

- 箇条書きの項目
- もう1つの項目
  - 入れ子の項目

1. 番号付きの項目
2. 2つ目

- [x] 済んだタスク
- [ ] まだのタスク

### 見出し3

> 引用です。引用の中の文章も本文と同じ書体で表示されます。

> [!NOTE]
> Callout(注記)です。

> [!WARNING]
> Callout(警告)です。

| 項目 | 説明 |
| --- | --- |
| 紙面 | 背景の色 |
| アクセント | リンクや強調の色 |

\`\`\`js
// コードブロック
function greet(name) {
  const message = "Hello, " + name;
  return message.length > 0 ? message : null;
}
\`\`\`

---

#### 見出し4

最後の段落です。
`;

const host = document.getElementById("cm-host");
const editor = createEditor(host);
editor.setValue(SAMPLE);
editor.setEditable(false);

const customCssEl = document.getElementById("custom-css");

function applyTheme(msg) {
  const root = document.documentElement;
  if (msg.theme === "light" || msg.theme === "dark") root.dataset.theme = msg.theme;
  root.dataset.lightTheme = msg.lightTheme || "default";
  root.dataset.darkTheme = msg.darkTheme || "default";
}

window.addEventListener("message", (e) => {
  // 親(同じオリジンの作成補助の画面)からのものだけを受け取る。
  if (e.origin !== location.origin || e.source !== window.parent) return;
  const msg = e.data;
  if (!msg || typeof msg !== "object") return;
  if (msg.type === "css") {
    customCssEl.textContent = String(msg.css ?? "");
  } else if (msg.type === "theme") {
    applyTheme(msg);
  } else {
    return;
  }
  // キャレットや選択範囲の色は getComputedStyle で一度だけ読まれるため、配色が変わるたびに
  // 読み直させる(main.js の apply-settings と同じ)。
  editor.refreshTheme();
  window.parent.postMessage({ type: "preview-applied" }, location.origin);
});

window.parent.postMessage({ type: "preview-ready" }, location.origin);
