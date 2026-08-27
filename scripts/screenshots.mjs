// README に載せる画面写真を撮り直すためのスクリプト。
//
//   npm run build && node scripts/screenshots.mjs
//
// dist/ を使い捨てのHTTPサーバで配信し、Playwrightのブラウザで開いて、
// 用意した文面を流し込んでから docs/images/ へ書き出す。
//
// Paneの画面はWebView2(=同じChromium)で描いているため、ここで撮れる中身は実機と同じもの。
// ただしタイトルバーとメニューバーはWinForms側(Pane/NativeMenu.cs)が描くので写らない。
// 実機の見た目そのままが要るときは、Windowsで動かしてOSの画面キャプチャを使うこと。
//
// 画面写真は説明の一部なので、UIの見た目を変えたら撮り直してdocs/images/を差し替える。
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pw from "playwright";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIST = path.join(ROOT, "dist");
const OUT = path.join(ROOT, "docs", "images");
const PORT = 8399; // .verify-*.mjs が使っていない番号(run-verify.shと同時に走らせても衝突しない)

// 見た目を固定するために大きさを決め打ちにする。撮り直しても差分が中身だけになるように。
const WIDTH = 1200;
const HEIGHT = 760;

const MARKDOWN_SAMPLE = `# 週次レポート

Markdown を**書いたまま**整形して見せます。記号は消さずに、
カーソルがその行に来たときだけ元の記法が現れます。

## 今週やったこと

| 項目 | 状態 | 備考 |
| --- | --- | --- |
| 起動の高速化 | 完了 | 2.7秒 → 1.1秒 |
| 更新の確認 | 完了 | 起動時に自動で確認 |
| 検証スイート | 進行中 | 60本 / 約2400件 |

> [!NOTE]
> Callouts(GitHub式のアラート)にも対応しています。

数式も書けます(インライン数式は設定でオンにできます)。

$$
E = mc^2 \\quad \\Rightarrow \\quad \\int_{0}^{\\infty} e^{-x^2}\\,dx = \\frac{\\sqrt{\\pi}}{2}
$$

\`\`\`js
// コードブロックはシンタックスハイライト付き
export function greet(name) {
  return \`こんにちは、\${name}さん\`;
}
\`\`\`

- [x] 箇条書きとチェックボックス
- [ ] 脚注[^1]・目次・参照リンク

[^1]: 脚注はこの位置に定義を書きます。

`;

const CODE_SAMPLE = `import { EditorView } from "@codemirror/view";
import { EditorState } from "@codemirror/state";

/**
 * コードファイルを開くと、行番号付きのコードエディタとして振る舞う。
 * 対応しているのは約60種類の言語。
 */
export function createEditor(parent, doc, extensions = []) {
  const state = EditorState.create({
    doc,
    extensions: [
      EditorView.lineWrapping,
      ...extensions,
    ],
  });

  const view = new EditorView({ state, parent });
  const theme = { accent: "#3B82F6", warning: "#F59E0B" };
  return { view, theme };
}

const LANGUAGES = ["javascript", "python", "csharp", "rust", "go", "sql"];
for (const lang of LANGUAGES) {
  console.log(\`\${lang} は対応済み\`);
}
`;

function serveDist() {
  const types = {
    ".html": "text/html",
    ".js": "text/javascript",
    ".css": "text/css",
    ".json": "application/json",
    ".svg": "image/svg+xml",
  };
  const server = http.createServer((req, res) => {
    const file = path.join(DIST, decodeURIComponent(req.url.split("?")[0]));
    try {
      const body = fs.readFileSync(file);
      res.writeHead(200, { "Content-Type": types[path.extname(file)] || "application/octet-stream" });
      res.end(body);
    } catch {
      res.writeHead(404);
      res.end("not found");
    }
  });
  return new Promise((resolve) => server.listen(PORT, () => resolve(server)));
}

/** 文書を丸ごと入れ替える。1文字ずつ打つと時間がかかるのでまとめて入れる。 */
async function setDocument(page, text) {
  await page.click(".cm-content");
  await page.keyboard.press("Control+a");
  await page.keyboard.press("Delete");
  await page.keyboard.insertText(text);
  // カーソルがある行だけは元の記法が現れる(それがPaneの仕様)。写真では整形後の姿を
  // 見せたいので、カーソルを末尾の空行へ置いて、どの行の記法も出ないようにする。
  await page.keyboard.press("Control+End");
  // 数式(MathJax)と図は必要になってから読み込むため、描き終わるまで少し待つ。
  await page.waitForTimeout(2500);
  // 末尾へ移動したぶん画面も下がっているので、文書の先頭が写るよう巻き戻す。
  await page.evaluate(() => {
    const scroller = document.querySelector(".cm-scroller");
    if (scroller) scroller.scrollTop = 0;
  });
  await page.waitForTimeout(400);
}

/**
 * 画面下部の通知バナーを閉じる。コードを流し込むと「自動判定: コード に切り替えました」が
 * 出て、写真では文面に重なってしまうため(実際の動作としては正しい)。
 */
async function dismissBanner(page) {
  await page.evaluate(() => document.getElementById("ad-banner-close")?.click());
  await page.waitForTimeout(300);
}

async function shoot(page, name) {
  const file = path.join(OUT, name);
  await page.screenshot({ path: file });
  const kb = Math.round(fs.statSync(file).size / 1024);
  console.log(`撮影: docs/images/${name} (${kb}KB)`);
}

if (!fs.existsSync(DIST)) {
  console.error("dist/ がありません。先に npm run build を実行してください。");
  process.exit(1);
}
fs.mkdirSync(OUT, { recursive: true });

const server = await serveDist();
const browser = await pw.chromium.launch();
const page = await browser.newPage({ viewport: { width: WIDTH, height: HEIGHT } });
const problems = [];
page.on("pageerror", (e) => problems.push(String(e.message || e)));

try {
  await page.goto(`http://localhost:${PORT}/index.html`);
  await page.waitForSelector(".cm-content", { timeout: 20000 });
  await page.waitForTimeout(1000);

  await setDocument(page, MARKDOWN_SAMPLE);
  await shoot(page, "01-markdown.png");

  // 暗いテーマ。テーマの切り替えはhtml要素のdata-theme属性で効く(src/themes.css)。
  await page.evaluate(() => document.documentElement.setAttribute("data-theme", "dark"));
  await page.waitForTimeout(600);
  await shoot(page, "02-markdown-dark.png");

  await page.evaluate(() => document.documentElement.setAttribute("data-theme", "light"));
  await page.waitForTimeout(400);
  await setDocument(page, CODE_SAMPLE);
  await dismissBanner(page);
  await shoot(page, "03-code.png");

  if (problems.length > 0) {
    console.error("ページで例外が出ました:", problems);
    process.exitCode = 1;
  }
} finally {
  await browser.close();
  server.close();
}
