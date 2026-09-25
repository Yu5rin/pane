// カスタムCSSの作成補助(仕様書 第2.10.1節 C-16)の画面を実際に動かして確かめる。
// dist/css-editor-window.html を開き、C#(Pane/CssEditorWindow.cs)の代わりに偽のブリッジで
// css-editor-init を流し込む。見るのは次のこと:
//   ・見本(iframe の css-preview.html)に本文と同じ描画(見出し・表・コード等)が出る
//   ・入力欄で変えた値が、CSSの該当ブロックにだけ書き込まれ、見本にすぐ効く
//   ・ライト/ダークを切り替えると、書き込む先のブロックも切り替わる
//   ・編集中のCSSはこの画面そのものには当たらない(見本の中だけ)
//   ・保存でCSSがC#へ送られ、上書きの前に確認が出る。保存していない変更は閉じる前に確認する
import pw from "playwright";
const { chromium } = pw;
const PORT = 8220;
const browser = await chromium.launch();
const errors = [];
let ng = 0;
const ok = (label, cond, detail) => {
  console.log(`${cond ? "OK  " : "NG  "} ${label}${cond || detail === undefined ? "" : `\n     実際: ${JSON.stringify(detail)}`}`);
  if (!cond) ng++;
};

function installBridge() {
  const listeners = [];
  window.__sent = [];
  window.chrome = {
    webview: {
      postMessage: (m) => { window.__sent.push(JSON.parse(JSON.stringify(m))); },
      addEventListener: (_t, fn) => listeners.push(fn),
    },
  };
  window.__reply = (data) => listeners.forEach((fn) => fn({ data }));
}

const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
page.on("pageerror", (e) => errors.push(String(e.stack || e)));
page.on("console", (m) => { if (m.type() === "error") errors.push("console: " + m.text()); });
await page.addInitScript(installBridge);
await page.goto(`http://localhost:${PORT}/css-editor-window.html`);
await page.waitForFunction(() => window.__sent.some((m) => m.type === "initial-render-ready"), null, { timeout: 10000 });
ok("画面を組み立てたら initial-render-ready を送る", true);

const existing = `/* 自分で書いたメモ */
:root {
  --accent: #AA3355;
}

.cm-content blockquote { font-style: italic; }
`;
await page.evaluate((css) => window.__reply({
  type: "css-editor-init", css, source: "file", sourcePath: "C:\\\\x\\\\my.css",
  targetPath: "C:\\\\x\\\\my.css", targetExists: true, theme: "light", lightTheme: "default", darkTheme: "default",
}), existing);

const frame = await (await page.waitForSelector("#ce-preview")).contentFrame();
await frame.waitForSelector("#cm-host .cm-content", { timeout: 15000 });
await page.waitForTimeout(600);

const cssText = () => page.evaluate(() => document.querySelector("#ce-code .cm-content").innerText);
const previewVar = (name) => frame.evaluate((n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim(), name);

// ---- 見本 ----
const previewInfo = await frame.evaluate(() => ({
  h1: !!document.querySelector("#cm-host .cm-content .tok-h1, #cm-host .cm-content [class*='h1']"),
  table: !!document.querySelector("#cm-host table, #cm-host .cm-table-widget, #cm-host [class*='table']"),
  editable: document.querySelector("#cm-host .cm-content").getAttribute("contenteditable"),
  text: document.querySelector("#cm-host .cm-content").innerText.slice(0, 40),
}));
ok("見本に見本の文書が出る", previewInfo.text.includes("見出し1"), previewInfo);
ok("見本は読み取り専用", previewInfo.editable === "false", previewInfo.editable);
ok("見本に開いたCSSが効いている(--accent)", (await previewVar("--accent")).toUpperCase() === "#AA3355", await previewVar("--accent"));

// ---- 入力欄 ----
const accentInput = await page.$('.ce-row[data-name="--accent"] input');
ok("入力欄に既存の値が出る", (await accentInput.inputValue()) === "#AA3355", await accentInput.inputValue());
const paperPlaceholder = await page.$eval('.ce-row[data-name="--paper"] input', (i) => i.placeholder);
ok("空欄の項目には今のテーマの値が薄く出る", /^#FBFBFA$/i.test(paperPlaceholder), paperPlaceholder);

await page.fill('.ce-row[data-name="--paper"] input', "#FFF8E7");
await page.dispatchEvent('.ce-row[data-name="--paper"] input', "change");
await page.waitForTimeout(400);
let css = await cssText();
ok("入力欄の値がライトのブロックに書き込まれる", /:root \{[^}]*--paper: #FFF8E7;/.test(css), css);
ok("自分で書いたメモとセレクタはそのまま残る", css.includes("/* 自分で書いたメモ */") && css.includes(".cm-content blockquote { font-style: italic; }"), css);
ok("見本にすぐ効く(--paper)", (await previewVar("--paper")).toUpperCase() === "#FFF8E7", await previewVar("--paper"));
const selfPaper = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--paper").trim());
ok("編集中のCSSはこの画面そのものには当たらない", selfPaper.toUpperCase() !== "#FFF8E7", selfPaper);

// ---- ダークへ切り替え ----
await page.click('.ce-seg button[data-scope="dark"]');
await page.waitForTimeout(500);
ok("見本がダークになる", (await frame.evaluate(() => document.documentElement.dataset.theme)) === "dark");
await page.fill('.ce-row[data-name="--ink"] input', "#EEEEEE");
await page.dispatchEvent('.ce-row[data-name="--ink"] input', "change");
await page.waitForTimeout(400);
css = await cssText();
ok("ダークでの値はダークのブロックに書き込まれる", /html\[data-theme="dark"\] \{\s*--ink: #EEEEEE;\s*\}/.test(css), css);
ok("ライトのブロックには書き込まない", !/:root \{[^}]*--ink:/.test(css), css);

// 書体はライト・ダーク共通(:root)
await page.fill('.ce-row[data-name="--font-body"] input', '"Meiryo", sans-serif');
await page.dispatchEvent('.ce-row[data-name="--font-body"] input', "change");
await page.waitForTimeout(300);
css = await cssText();
ok("書体はダーク表示中でもライトのブロック(共通)に書く", /:root \{[^}]*--font-body: "Meiryo", sans-serif;/.test(css), css);

// 戻すボタン
await page.click('.ce-row[data-name="--ink"] .ce-reset');
await page.waitForTimeout(300);
css = await cssText();
ok("戻すボタンでその宣言だけ消える", !css.includes("--ink: #EEEEEE") && css.includes("--paper: #FFF8E7"), css);

// ---- 変更あり・保存 ----
const dirtyMsgs = await page.evaluate(() => window.__sent.filter((m) => m.type === "css-editor-dirty").map((m) => m.value));
ok("変更すると「保存していない変更あり」を送る", dirtyMsgs.at(-1) === true, dirtyMsgs);

await page.click("#ce-save");
await page.waitForSelector(".pane-dialog-overlay", { timeout: 3000 });
ok("既存のファイルへ保存する前に上書きの確認が出る", true);
await page.click(".pane-dialog-overlay button.primary, .pane-dialog-overlay .pane-dialog-actions button:last-child");
await page.waitForTimeout(300);
const saveMsg = await page.evaluate(() => window.__sent.filter((m) => m.type === "css-editor-save").at(-1));
ok("保存でCSSがC#へ送られる", saveMsg && saveMsg.css.includes("--paper: #FFF8E7"), saveMsg);
await page.evaluate(() => window.__reply({ type: "css-editor-saved", ok: true, targetPath: "C:\\x\\my.css" }));
await page.waitForTimeout(200);
const notice = await page.$eval("#ce-notice", (n) => n.textContent);
ok("保存したことを知らせる", notice.includes("保存しました"), notice);
const dirtyAfter = await page.evaluate(() => window.__sent.filter((m) => m.type === "css-editor-dirty").at(-1)?.value);
ok("保存すると「変更なし」に戻る", dirtyAfter === false, dirtyAfter);

// 2回目の保存では確認を出さない
const before = await page.evaluate(() => window.__sent.length);
await page.click("#ce-save");
await page.waitForTimeout(300);
ok("2回目の保存では上書きの確認を出さない", !(await page.$(".pane-dialog-overlay")) && (await page.evaluate((n) => window.__sent.slice(n).some((m) => m.type === "css-editor-save"), before)));
await page.evaluate(() => window.__reply({ type: "css-editor-saved", ok: true, targetPath: "C:\\x\\my.css" }));

// ---- 閉じる ----
await page.fill('.ce-row[data-name="--rule"] input', "#CCCCCC");
await page.dispatchEvent('.ce-row[data-name="--rule"] input', "change");
await page.waitForTimeout(300);
await page.evaluate(() => window.__reply({ type: "confirm-close" }));
await page.waitForSelector(".pane-dialog-overlay", { timeout: 3000 });
ok("保存していない変更があると、閉じる前に確認が出る", true);
await page.click(".pane-dialog-overlay .pane-dialog-actions button:last-child");
await page.waitForTimeout(200);
ok("確認して閉じると close-css-editor-window を送る", await page.evaluate(() => window.__sent.some((m) => m.type === "close-css-editor-window")));

// ---- 雛形で始める ----
const page2 = await browser.newPage({ viewport: { width: 1200, height: 800 } });
page2.on("pageerror", (e) => errors.push(String(e.stack || e)));
await page2.addInitScript(installBridge);
await page2.goto(`http://localhost:${PORT}/css-editor-window.html`);
await page2.waitForFunction(() => window.__sent.some((m) => m.type === "initial-render-ready"));
await page2.evaluate(() => window.__reply({ type: "css-editor-init", css: "", source: "template", sourcePath: "", targetPath: "C:\\t\\custom.css", targetExists: false, theme: "dark", lightTheme: "default", darkTheme: "nord" }));
await page2.waitForTimeout(500);
const tpl = await page2.evaluate(() => document.querySelector("#ce-code .cm-content").innerText);
ok("未指定なら雛形(:root とダークのブロック)で始める", tpl.includes(":root {") && tpl.includes('html[data-theme="dark"] {'), tpl);
ok("雛形のままなら「変更なし」", (await page2.evaluate(() => window.__sent.filter((m) => m.type === "css-editor-dirty").at(-1)?.value)) === false);
ok("保存先を表示する", (await page2.$eval("#ce-target", (e) => e.textContent)).includes("custom.css"));
ok("テーマに合わせてダークで始める", (await page2.$eval('.ce-seg button[data-scope="dark"]', (b) => b.getAttribute("aria-pressed"))) === "true");
const presetNotice = await page2.$eval("#ce-notice", (n) => n.textContent);
ok("プリセットのテーマを選んでいると、色が効かないことがあると知らせる", presetNotice.includes("nord"), presetNotice);
await page2.click("#ce-save");
await page2.waitForTimeout(300);
ok("新しいファイルへの保存では上書きの確認を出さない", !(await page2.$(".pane-dialog-overlay")) && (await page2.evaluate(() => window.__sent.some((m) => m.type === "css-editor-save"))));

ok(`ページのエラーが無い(${errors.length}件)`, errors.length === 0, errors.slice(0, 5));
await browser.close();
console.log(`\nNG=${ng}`);
process.exit(ng ? 1 : 0);
