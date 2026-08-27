// ファイル種別ごとの編集モード判定・表示内容の実ブラウザ検証。ポートは8130。
// (メニューはネイティブポップアップ化され、ブリッジがあるとHTMLの.menu-dropdownは
//  作られなくなったため、手動モード切替は.verify-nativemenu.mjs / .verify-filemode.mjsと
//  同じ流儀でopen-menu/menu-commandを使う。)
import pw from "playwright";
const { chromium } = pw;
const browser = await chromium.launch();
const page = await browser.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(String(e.stack || e)));
page.on("console", (m) => { if (m.type() === "error") errors.push("console: " + m.text()); });

let okCount = 0, ngCount = 0;
const ok = (l, c) => { console.log(`${c ? "OK  " : "NG  "} ${l}`); if (c) okCount++; else ngCount++; };

await page.addInitScript(() => {
  const listeners = [];
  window.__sent = [];
  window.chrome = { webview: {
    postMessage: (m) => window.__sent.push(m),
    addEventListener: (_t, fn) => listeners.push(fn),
  } };
  window.__reply = (d) => listeners.forEach((fn) => fn({ data: d }));
});
await page.goto("http://localhost:8130/index.html");
await page.waitForTimeout(700);

const SAMPLE = [
  "# 見出し1",
  "",
  "これは **太字** と *斜体* と `コード` です。",
  "",
  "- リスト項目A",
  "- リスト項目B",
  "",
  "| 列1 | 列2 |",
  "| --- | --- |",
  "| a   | b   |",
  "",
  "const x = 1; // JavaScriptのコード",
].join("\n");

async function open(fileName) {
  await page.evaluate(({ fileName, text }) => window.__reply({
    type: "file-opened", fileName, path: "C:\\work\\" + fileName, text,
    encoding: "UTF-8", lineEnding: "CRLF", readOnly: false,
  }), { fileName, text: SAMPLE });
  await page.waitForTimeout(900);
  return {
    mode: await page.textContent("#status-mode"),
    // 画面上に見えているテキスト(記法マーカーが隠れていればここから消える)
    visible: await page.evaluate(() => document.querySelector(".cm-content").innerText),
    strong: await page.$$eval(".cm-content strong, .cm-content .cm-strong", (e) => e.length),
    tableWidget: await page.$$eval(".cm-table, .cm-table-widget, table", (e) => e.length),
    gutter: await page.$$eval(".cm-lineNumbers, .cm-gutters", (e) => e.length),
    tokens: await page.$$eval(".cm-content span[class*='ͼ']", (e) => e.length),
  };
}

// mode: 期待するステータスバー表示("startsWith"判定するもの用に関数で渡す)
// hideMarkers: true=Markdownのライブレンダリングで記法マーカーが隠れる(見えない) / false=そのまま見える
const CASES = [
  ["sample.md", (m) => m === "Markdown", true, "Markdownは記法マーカーが隠れ、ガター/トークンも無い(ライブレンダリング)"],
  ["sample.js", (m) => m.startsWith("コード"), false, "コードは記法がそのまま見え、行番号ガター・ハイライトトークンがある"],
  ["sample.txt", (m) => m === "プレーンテキスト", false, "プレーンテキストは記法がそのまま見える"],
];

for (const [name, modeCheck, hideMarkers, desc] of CASES) {
  const r = await open(name);
  console.log(`\n===== ${name} (${desc}) =====`);
  ok(`${name}: ステータスバーのモード表示 "${r.mode}"`, modeCheck(r.mode));
  ok(`${name}: 見出し記号 '#' の見え方(隠れる期待=${hideMarkers}) 実際見える=${r.visible.includes("# 見出し1")}`,
    r.visible.includes("# 見出し1") === !hideMarkers);
  ok(`${name}: '**太字**' の見え方(隠れる期待=${hideMarkers}) 実際見える=${r.visible.includes("**太字**")}`,
    r.visible.includes("**太字**") === !hideMarkers);
  ok(`${name}: 表の区切り '| --- |' の見え方(隠れる期待=${hideMarkers}) 実際見える=${r.visible.includes("| --- |")}`,
    r.visible.includes("| --- |") === !hideMarkers);
  if (name === "sample.js") {
    ok(`${name}: 行番号ガターがある (${r.gutter})`, r.gutter > 0);
    ok(`${name}: シンタックスハイライトのtokenがある (${r.tokens})`, r.tokens > 0);
  }
}

// .js を開いたまま手動でMarkdownモードへ切り替えられるか
// メニューはネイティブポップアップ化され、ブリッジがあるとHTMLの.menu-dropdownは
// 作られない(.verify-nativemenu.mjs / .verify-filemode.mjsと同じ流儀)。見出しを
// クリックしてopen-menuを送らせ、C#役としてmenu-commandを返してコマンドを実行させる。
await open("sample.js");
await page.click(".cm-content");
await page.click("#menubar .menu-top:text('表示')");
await page.waitForTimeout(250);
const dropdownExists = await page.$(".menu-dropdown");
ok("表示メニュークリックでHTMLの.menu-dropdownは作られない(ネイティブポップアップ経路)", dropdownExists === null);
await page.evaluate(() => window.__reply({ type: "menu-command", id: "view.modeMarkdown" }));
await page.waitForTimeout(800);
console.log("\n===== sample.js を手動でMarkdownモードへ =====");
const modeAfterSwitch = await page.textContent("#status-mode");
ok(`手動切替後のモード表示がMarkdown "${modeAfterSwitch}"`, modeAfterSwitch === "Markdown");
const v = await page.evaluate(() => document.querySelector(".cm-content").innerText);
ok(`手動切替後は '**太字**' が隠れる(見える=${v.includes("**太字**")})`, !v.includes("**太字**"));
ok(`手動切替後は見出し記号 '#' が隠れる(見える=${v.includes("# 見出し1")})`, !v.includes("# 見出し1"));

ok(`ページエラー・コンソールエラー0件: ${JSON.stringify(errors)}`, errors.length === 0);

console.log(`\n合計: OK ${okCount} / NG ${ngCount}`);
await browser.close();
process.exit(ngCount > 0 ? 1 : 0);
