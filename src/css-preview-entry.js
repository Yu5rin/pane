// カスタムCSSの作成補助(仕様書 第2.10.1節 C-16)の見本。css-editor-window.html の iframe の中で、
// 本文ウィンドウと同じエディタ部品(editor.js)を読み取り専用で置き、見本を表示する。
//
// 見せる画面は3つ(親から "view" で切り替える)。どれも本物と同じ部品・同じ id とクラスで描く:
//   markdown: Markdown の文書(ライブプレビュー)
//   code    : コードファイル(コードモード。行番号・今の行・折りたたみ・インデントの線)
//   chrome  : 画面全体(タイトルバー・メニューバー・サイドバー・ステータスバー・
//             コマンドパレット・ダイアログ・設定画面のボタン)
// 見本に何を並べるかは .verify-css-preview-coverage.mjs が見張っている。sample.css に載っている
// 変数は、どれかの画面で必ず見た目が変わること(=作成補助で確かめられること)を確かめる。
//
// 見本を iframe に分けているのは、編集中のCSSを作成補助の画面そのもの(フォームやボタン)に
// 当てないため(仕様書)。同じオリジン(pane.local)なので、親とは postMessage でやり取りする。
// このページは C# とは直接話さない(WebView2 の chrome.webview は最上位のフレームにしか無い)。
import { createEditor } from "./editor.js";

// Markdown の見本。見た目を決める要素をひととおり含める(仕様書 第2.10.1節の一覧)。
// Callout は5種類すべて、Front Matter は先頭に置く。
const SAMPLE_MARKDOWN = `---
title: 見本
tags: [pane, css]
---

# 見出し1

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
> 注記(NOTE)です。

> [!TIP]
> ヒント(TIP)です。

> [!IMPORTANT]
> 重要(IMPORTANT)です。

> [!WARNING]
> 警告(WARNING)です。

> [!CAUTION]
> 注意(CAUTION)です。

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

// コードモードの見本。コードの色分けの変数(--code-*)がすべて出るよう、キーワード・制御構文・
// 変数・関数・文字列・数値・コメント・型・プロパティ・演算子・正規表現を含める。
// 入れ子を深くして、インデントの線と折りたたみの印も出す。
const SAMPLE_CODE = `// コードモードの見本です
import { readFile } from "node:fs/promises";

class Greeter {
  constructor(name) {
    this.name = name;
    this.count = 0;
  }

  greet(times = 3) {
    const pattern = /^[a-z]+$/i;
    const shade = "rgba(47, 111, 104, 0.5)";
    for (let i = 0; i < times; i++) {
      if (pattern.test(this.name)) {
        this.count += 1;
      } else {
        return null;
      }
    }
    return \`Hello, \${this.name}!\`;
  }
}

export async function load(path) {
  const text = await readFile(path, "utf8");
  return text.split("\\n").length * 2;
}
`;
// コードモードでカーソルを置いておく行(今の行の背景を見せるため)。
const CODE_CURSOR_LINE = 12;

// 画面全体の見本の本文。短い Markdown にする。
const SAMPLE_CHROME = `# 見出し1

画面全体の見本です。左がサイドバー、上がメニューバー、下がステータスバーです。

## 見出し2(今いる所)

本文の段落です。**太字**と[リンク](https://example.com)を含みます。

### 見出し3

#### 見出し4
`;

const host = document.getElementById("cm-host");
const editor = createEditor(host);
editor.setEditable(false);

const customCssEl = document.getElementById("custom-css");
let currentView = "";

async function showView(view) {
  const next = view === "code" || view === "chrome" ? view : "markdown";
  if (next === currentView) return;
  currentView = next;
  document.body.classList.toggle("view-markdown", next === "markdown");
  document.body.classList.toggle("view-code", next === "code");
  document.body.classList.toggle("view-chrome", next === "chrome");
  if (next === "code") {
    editor.setValue(SAMPLE_CODE);
    await editor.setFileMode("sample.js");
    const line = editor.view.state.doc.line(CODE_CURSOR_LINE);
    editor.view.dispatch({ selection: { anchor: line.from + 4 } });
  } else {
    editor.setValue(next === "chrome" ? SAMPLE_CHROME : SAMPLE_MARKDOWN);
    await editor.setFileMode("sample.md");
    // 選択範囲の色(--accent-soft)は、見本がフォーカスを持たないため本文では見えない。
    // 同じ変数を使うサイドバーの「今いる所」・パレットの選択行で、画面全体の見本から確かめられる。
  }
  // 本文ウィンドウの main.js と同じく、コードモードのときだけ #cm-host に印を付ける
  // (style.css のコードモード用の指定がこれを見る)。
  host.classList.toggle("mode-code", next === "code");
  document.documentElement.setAttribute("data-editor-mode", next === "code" ? "code" : "markdown");
  editor.view.scrollDOM.scrollTop = 0;
}

function applyTheme(msg) {
  const root = document.documentElement;
  if (msg.theme === "light" || msg.theme === "dark") root.dataset.theme = msg.theme;
  root.dataset.lightTheme = msg.lightTheme || "default";
  root.dataset.darkTheme = msg.darkTheme || "default";
}

window.addEventListener("message", async (e) => {
  // 親(同じオリジンの作成補助の画面)からのものだけを受け取る。
  if (e.origin !== location.origin || e.source !== window.parent) return;
  const msg = e.data;
  if (!msg || typeof msg !== "object") return;
  if (msg.type === "css") {
    customCssEl.textContent = String(msg.css ?? "");
  } else if (msg.type === "theme") {
    applyTheme(msg);
  } else if (msg.type === "view") {
    await showView(msg.view);
  } else {
    return;
  }
  // キャレットや選択範囲の色は getComputedStyle で一度だけ読まれるため、配色が変わるたびに
  // 読み直させる(main.js の apply-settings と同じ)。
  editor.refreshTheme();
  window.parent.postMessage({ type: "preview-applied", view: currentView }, location.origin);
});

showView("markdown").then(() => {
  window.parent.postMessage({ type: "preview-ready" }, location.origin);
});
