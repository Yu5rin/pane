// 内容からの編集モード自動判定(仕様書 第1章の拡張)のPlaywright検証。
// 静的サーバはポート8145でdistを配信していることを前提とする。
import pw from "playwright";
const { chromium } = pw;
const browser = await chromium.launch();
const page = await browser.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push("PAGEERROR: " + String(e.stack || e)));
page.on("console", (m) => { if (m.type() === "error") errors.push("CONSOLE: " + m.text()); });

await page.addInitScript(() => {
  const listeners = [];
  window.__sent = [];
  window.chrome = {
    webview: {
      postMessage: (m) => { window.__sent.push(m); },
      addEventListener: (_t, fn) => listeners.push(fn),
    },
  };
  window.__reply = (data) => listeners.forEach((fn) => fn({ data }));
});
await page.goto("http://localhost:8145/index.html");
await page.waitForTimeout(800);

const ok = (l, c) => { console.log(`${c ? "OK  " : "NG  "} ${l}`); return c; };
let allOk = true;
function check(label, cond) { allOk = ok(label, cond) && allOk; }

function mode() { return page.textContent("#status-mode"); }

// apply-settingsは毎回フルペイロードで送る(一部フィールドだけ送るとundefinedで
// 他の設定を意図せず上書きしてしまうため)。
const BASE_SETTINGS = {
  type: "apply-settings",
  calloutsEnabled: true, superSubEnabled: true, highlightEnabled: true,
  inlineMathEnabled: false, mathAutoNumberEnabled: false,
  defaultCopyFormat: "markdown", pandocAvailable: false, recentFiles: [],
  theme: "light", lightTheme: "default", darkTheme: "default",
  editorFontSize: 15, showWordCount: true, editorFontFamily: "",
  customCss: "", keyBindings: {}, fileModeOverrides: {}, perFileModes: {},
  autoDetectMode: "standard",
};
async function applySettings(overrides) {
  await page.evaluate((msg) => window.__reply(msg), { ...BASE_SETTINGS, ...overrides });
  await page.waitForTimeout(150);
}
async function newDoc() {
  await page.evaluate(() => window.__reply({ type: "new-document" }));
  await page.waitForTimeout(200);
}
async function openNamed(fileName, path, text) {
  await page.evaluate(({ fileName, path, text }) => window.__reply({
    type: "file-opened", fileName, path, text, encoding: "UTF-8", lineEnding: "CRLF", readOnly: false,
  }), { fileName, path, text });
  await page.waitForTimeout(300);
}
// ペーストの再現: CodeMirrorへ実際にpasteイベントを合成して発火させる(main.jsのonPaste/onChange
// 経路をそのまま通す。navigator.clipboardには依存しない)。
async function pasteText(text) {
  await page.click(".cm-content");
  await page.evaluate((t) => {
    const dt = new DataTransfer();
    dt.setData("text/plain", t);
    const el = document.querySelector(".cm-content");
    const ev = new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: dt });
    el.dispatchEvent(ev);
  }, text);
  await page.waitForTimeout(600); // ペースト直後トリガーの反映待ち
}
function bannerVisible() { return page.evaluate(() => !document.getElementById("ad-banner").hidden); }
function bannerText() { return page.textContent("#ad-banner-text"); }

const PY_CODE = `import os
import sys


class DataProcessor:
    def __init__(self, name):
        self.name = name
        self.items = []

    def add_item(self, item):
        self.items.append(item)
        return self

    def process(self):
        for item in self.items:
            if item is None:
                continue
            elif isinstance(item, str):
                print(item.upper())
            else:
                print(item)


def main():
    processor = DataProcessor("demo")
    processor.add_item("hello")
    processor.process()


if __name__ == "__main__":
    main()
`;

const JS_CODE = `const state = {
  count: 0,
  items: [],
};

function addItem(item) {
  state.items.push(item);
  state.count += 1;
  return state.count;
}

const removeItem = (index) => {
  state.items.splice(index, 1);
  console.log(\`removed index \${index}\`);
};

export default function run() {
  addItem("first");
  addItem("second");
  removeItem(0);
  console.log(state.count);
}
`;

const MD_CONTENT = `# タイトル

これはテストです。

- 項目1
- 項目2
- 項目3

## 表

| 名前 | 値 |
| --- | --- |
| a | 1 |
| b | 2 |

\`\`\`python
def f():
    return 1
\`\`\`

続きの本文です。
`;

// (a) 無題の新規文書にPythonコードを貼ると「コード (Python)」になる(standard、既定)
await applySettings({ autoDetectMode: "standard" });
await newDoc();
await pasteText(PY_CODE);
check("(a) 無題+Python貼り付け → コード(Python)", (await mode()) === "コード (Python)");

// (b) 同じくJavaScriptコードを貼ると「コード (JavaScript)」になる
await newDoc();
await pasteText(JS_CODE);
check("(b) 無題+JavaScript貼り付け → コード(JavaScript)", (await mode()) === "コード (JavaScript)");

// (c) 無題の新規文書にMarkdownを貼ってもMarkdownのまま
await newDoc();
await pasteText(MD_CONTENT);
check("(c) 無題+Markdown貼り付け → Markdownのまま", (await mode()) === "Markdown");

// (d) 切り替え後に通知が出て、「元に戻す」でMarkdownへ戻る
await newDoc();
await pasteText(PY_CODE);
const dModeAfterSwitch = await mode();
const dBannerShown = await bannerVisible();
const dBannerText = await bannerText();
await page.click("#ad-banner-action");
await page.waitForTimeout(300);
const dModeAfterUndo = await mode();
check("(d) 切り替え後にコード(Python)になる", dModeAfterSwitch === "コード (Python)");
check(`(d) 通知バナーが表示される: shown=${dBannerShown} text=${JSON.stringify(dBannerText)}`,
  dBannerShown && dBannerText.includes("切り替えました"));
check("(d) 元に戻すでMarkdownへ戻る", dModeAfterUndo === "Markdown");

// (e) 元に戻した後に再度コードを貼っても自動判定が走らない
await pasteText(JS_CODE);
const eMode = await mode();
check(`(e) 元に戻した後は再貼り付けしてもMarkdownのまま: ${JSON.stringify(eMode)}`, eMode === "Markdown");

// (f) autoDetectMode:"off" では貼り付けても切り替わらない
await applySettings({ autoDetectMode: "off" });
await newDoc();
await pasteText(PY_CODE);
check("(f) off設定では切り替わらない", (await mode()) === "Markdown");

// (g) autoDetectMode:"suggest" では切り替わらず提案だけ出る。「切り替える」で切り替わる
await applySettings({ autoDetectMode: "suggest" });
await newDoc();
await pasteText(PY_CODE);
const gModeBefore = await mode();
const gBannerShown = await bannerVisible();
const gBannerText = await bannerText();
check("(g) suggestでは貼り付けても切り替わらない", gModeBefore === "Markdown");
check(`(g) 提案バナーが表示される: shown=${gBannerShown} text=${JSON.stringify(gBannerText)}`,
  gBannerShown && gBannerText.includes("表示しますか"));
await page.click("#ad-banner-action");
await page.waitForTimeout(300);
check("(g) 「切り替える」を押すと切り替わる", (await mode()) === "コード (Python)");

// (h) 拡張子のあるファイル(sample.md)を開いてPythonコードを貼っても、standardでは切り替わらない
await applySettings({ autoDetectMode: "standard" });
await openNamed("sample.md", "C:\\work\\sample.md", "# 見出し\n\n本文です。\n");
check("(h-前提) sample.mdはMarkdownで開かれる", (await mode()) === "Markdown");
await pasteText(PY_CODE);
check("(h) 拡張子ありファイルはstandardでは切り替わらない", (await mode()) === "Markdown");

// (i) 40文字未満の短い入力では判定が走らない
await newDoc();
await pasteText("def f(): pass"); // 80文字未満なので即時トリガーの対象外、かつ40文字未満
await page.waitForTimeout(1800); // 念のためデバウンス分も待つ
check("(i) 短い入力では切り替わらない", (await mode()) === "Markdown");

// (j) #status-mode クリックで言語ピッカーが開き、絞り込んで別言語を選ぶと表示が変わる
await newDoc();
await pasteText(PY_CODE);
check("(j-前提) コード(Python)になっている", (await mode()) === "コード (Python)");
await page.click("#status-mode");
await page.waitForTimeout(200);
const pickerOpen = await page.evaluate(() => !!document.querySelector(".palette-overlay #palette-input"));
await page.fill("#palette-input", "Rust");
await page.waitForTimeout(150);
await page.keyboard.press("Enter");
await page.waitForTimeout(300);
check(`(j) 言語ピッカーが開く: ${pickerOpen}`, pickerOpen);
check(`(j) Rustを選ぶと表示が変わる: ${JSON.stringify(await mode())}`, (await mode()) === "コード (Rust)");

// (k) 未知のフェンス言語名(```mermaidx / ```zzz)を含むフェンスを入力してもコンソールエラーが0件
await newDoc();
await page.click(".cm-content");
await page.keyboard.type("```mermaidx\nhello\n```\n\nafter\n", { delay: 4 });
await page.waitForTimeout(1200);
await newDoc();
await page.click(".cm-content");
await page.keyboard.type("```zzz\nhello\n```\n\nafter\n", { delay: 4 });
await page.waitForTimeout(1200);
check(`(k) mermaidx/zzzフェンスでコンソールエラー0件: ${JSON.stringify(errors)}`, errors.length === 0);

// (n) バグチェック①の回帰確認: 「見出し+説明文+フェンス1個」を1文字ずつタイプして
// 手を止める(貼り付けではなく実際の再現手順どおり入力停止のデバウンス経路を通す)と、
// フェンスの中身の言語に関わらずMarkdownのまま変わらないこと。
// AUTO_DETECT_IDLE_MS(1500ms)を超えて待つことで、入力停止トリガーを確実に発火させる。
async function typeAndWaitIdle(text) {
  await page.click(".cm-content");
  await page.keyboard.type(text, { delay: 2 });
  await page.waitForTimeout(2000);
}
const FENCE_CASES = [
  ["python", "# Pythonの使い方メモ\n\n次のように書きます。\n\n```python\ndef main():\n    print('hi')\n```\n"],
  ["JavaScript", "# JSの使い方メモ\n\n次のように書きます。\n\n```js\nfunction main() {\n  console.log('hi');\n}\n```\n"],
  ["CSS", "# CSSの使い方メモ\n\n次のように書きます。\n\n```css\n.box {\n  color: red;\n  display: flex;\n}\n```\n"],
];
for (const [lang, text] of FENCE_CASES) {
  await newDoc();
  await typeAndWaitIdle(text);
  check(`(n) 見出し+段落+${lang}フェンスを1文字ずつ入力してもMarkdownのまま: ${JSON.stringify(await mode())}`, (await mode()) === "Markdown");
}

// (o) 見出し+箇条書き+フェンス(壊してはいけない既存の正解パターン)も同様にMarkdownのまま
await newDoc();
await typeAndWaitIdle("# メモ\n\n- 項目1\n- 項目2\n\n```python\ndef f():\n    return 1\n```\n");
check(`(o) 見出し+箇条書き+フェンスは引き続きMarkdownのまま: ${JSON.stringify(await mode())}`, (await mode()) === "Markdown");

// (p) 逆に、本当にJavaScriptのコードだけの無題文書は、これまでどおりコードと判定される
// (判定機能自体を殺していないことの確認。1文字ずつ入力する経路でも同じ結果になること)
await newDoc();
await typeAndWaitIdle(JS_CODE);
check(`(p) JavaScriptコードのみを1文字ずつ入力するとコード(JavaScript)になる: ${JSON.stringify(await mode())}`, (await mode()) === "コード (JavaScript)");

await browser.close();

// (l) 既存のモード判定検証(.verify-filemode.mjs)がポート8145でも全項目OKであること
// 依存する一時コピーは他スイートやスクラッチパッドの置き土産に頼らず、このスクリプト自身が
// 実行のたびに.verify-filemode.mjs(ポート8142版・正本)から動的に生成する(自己完結)。
// ポート番号だけ書き換えた一時ファイルを書き出し、別プロセスとして実行する。
//
// 一時ファイルはリポジトリ直下に置く。os.tmpdir()配下に置くと、スイートが読み込む
// playwright を Node が見つけられない(node_modules を親フォルダへ遡って探すため、
// リポジトリの外に出た時点で解決できなくなる)。以前はスイートが playwright を
// 絶対パスで import していたためどこに置いても動いていたが、環境に依存しない
// 書き方(import "playwright")へ改めた際にこの前提が崩れ、ここが落ちるようになった。
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = dirname(fileURLToPath(import.meta.url));
const FILEMODE_SRC = new URL("./.verify-filemode.mjs", import.meta.url);
const filemodeSource = readFileSync(FILEMODE_SRC, "utf8");
if (!filemodeSource.includes("localhost:8142")) {
  check("(l-前提) .verify-filemode.mjsの正本からポート8142を検出できる", false);
} else {
  const workDir = mkdtempSync(join(REPO_ROOT, ".verify-tmp-filemode-8145-"));
  try {
    const legacyPath = join(workDir, "verify-filemode-8145.mjs");
    writeFileSync(legacyPath, filemodeSource.replace("localhost:8142", "localhost:8145"), "utf8");
    const legacy = spawnSync(process.execPath, [legacyPath], { encoding: "utf8" });
    console.log(legacy.stdout);
    if (legacy.stderr) console.error(legacy.stderr);
    const legacyOk = legacy.status === 0 && !/^NG /m.test(legacy.stdout);
    check(`(l) 既存検証(.verify-filemode.mjs相当)が全項目OK`, legacyOk);
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

// (m) このスクリプト全体を通じてページエラー・コンソールエラーが0件
check(`(m) 全体を通じてページエラー・コンソールエラー0件: ${JSON.stringify(errors)}`, errors.length === 0);

console.log(allOk ? "\n=== ALL OK ===" : "\n=== SOME CHECKS FAILED ===");
process.exit(allOk ? 0 : 1);
