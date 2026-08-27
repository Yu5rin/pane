import pw from "playwright";
const { chromium } = pw;
const browser = await chromium.launch();
const page = await browser.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(String(e.stack || e)));

// WebView2ブリッジをモックしてから読み込む(送信メッセージを記録し、C#役として応答する)
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
await page.goto("http://localhost:8130/index.html");
await page.waitForTimeout(800);
const ok = (l, c) => console.log(`${c ? "OK  " : "NG  "} ${l}`);

ok("起動時にreadyを送信", await page.evaluate(() => window.__sent.some((m) => m.type === "ready")));

// ---- フォルダ読み込み(folder-loaded) ----
await page.evaluate(() => window.__reply({
  type: "folder-loaded", rootPath: "C:\\work", rootName: "work", truncated: false,
  entries: [
    { path: "C:\\work\\docs", name: "docs", relativePath: "docs", isDirectory: true },
    { path: "C:\\work\\docs\\a.md", name: "a.md", relativePath: "docs/a.md", isDirectory: false },
    { path: "C:\\work\\main.py", name: "main.py", relativePath: "main.py", isDirectory: false },
    { path: "C:\\work\\util.pl", name: "util.pl", relativePath: "util.pl", isDirectory: false },
  ],
}));
await page.waitForTimeout(400);
// フォルダ読み込み成功時、サイドバーは自動で開いてファイルツリータブへ切り替わる
// (ユーザー要望3、src/main.jsのfolder-loadedハンドラ参照)ため、ここでの
// #status-sidebarクリックは不要(むしろ開いているサイドバーを閉じてしまう)。
await page.click('.sidebar-tab[data-panel="files"]');
await page.waitForTimeout(400);
const files = await page.$$eval(".file-item", (e) => e.map((x) => x.textContent.trim()));
ok(`ファイル一覧に3件 ${JSON.stringify(files)}`, files.length === 3);

await page.click('.sidebar-tab[data-panel="tree"]');
await page.waitForTimeout(400);
const treeCount = await page.$$eval(".tree-item, .tree-folder", (e) => e.length);
ok(`ツリー表示が描画される (${treeCount}要素)`, treeCount > 0);

// ---- クイックオープン(Ctrl+P) ----
await page.click(".cm-content");
await page.keyboard.press("Control+p");
await page.waitForTimeout(400);
const qoOpen = await page.$(".palette-overlay") !== null;
ok("クイックオープンが開く", qoOpen);
await page.fill("#palette-input", "pl");
await page.waitForTimeout(300);
const qoItems = await page.$$eval("#palette-list li", (e) => e.map((x) => x.textContent));
ok(`あいまい一致で絞り込み ${JSON.stringify(qoItems)}`, qoItems.length > 0);
await page.keyboard.press("Escape");
await page.waitForTimeout(200);

// ---- グローバル検索(Ctrl+Shift+F) ----
await page.click(".cm-content");
await page.keyboard.press("Control+Shift+F");
await page.waitForTimeout(400);
const searchFocused = await page.evaluate(() => document.activeElement?.closest("#sidebar") !== null);
ok("Ctrl+Shift+Fでサイドバー検索欄にフォーカス", searchFocused);
await page.keyboard.type("hello");
await page.waitForTimeout(700);
ok("global-searchを送信", await page.evaluate(() => window.__sent.some((m) => m.type === "global-search" && m.query === "hello")));

await page.evaluate(() => {
  window.__reply({ type: "search-results", hits: [
    { path: "C:\\work\\docs\\a.md", name: "a.md", relativePath: "docs/a.md", line: 3, column: 5, matchOffset: 4, matchLength: 5, lineText: "say hello world" },
    { path: "C:\\work\\docs\\a.md", name: "a.md", relativePath: "docs/a.md", line: 9, column: 1, matchOffset: 0, matchLength: 5, lineText: "hello again" },
    { path: "C:\\work\\main.py", name: "main.py", relativePath: "main.py", line: 2, column: 7, matchOffset: 7, matchLength: 5, lineText: "print('hello')" },
  ]});
  window.__reply({ type: "search-done", total: 3, truncated: false });
});
await page.waitForTimeout(500);
const groups = await page.$$eval(".search-result-group", (e) => e.length);
const hits = await page.$$eval(".search-result-hit", (e) => e.length);
const marks = await page.$$eval(".search-result-hit mark", (e) => e.map((x) => x.textContent));
ok(`検索結果がファイル別に2グループ (${groups})`, groups === 2);
ok(`ヒット3件を表示 (${hits})`, hits === 3);
ok(`ヒット箇所を強調 ${JSON.stringify(marks)}`, marks.length === 3 && marks.every((m) => m === "hello"));

// ---- ウィンドウ制御 ----
// ブリッジがある状態では、メニューバーの見出しクリックはHTMLドロップダウンではなく
// ネイティブポップアップ経路(open-menuメッセージ、Pane/NativeMenu.cs)を使う
// (src/commands.js initMenuBar)。そのため.menu-dropdown DOMは作られず、代わりに
// C#へ送られるopen-menuメッセージのitems配列でチェック状態を確認する。
await page.evaluate(() => window.__reply({ type: "window-state", fullscreen: true, alwaysOnTop: false }));
await page.waitForTimeout(200);
await page.click("#menubar .menu-top:text('表示')");
await page.waitForTimeout(300);
const openMenuMsgs = await page.evaluate(() => window.__sent.filter((m) => m.type === "open-menu" && m.menu === "View"));
const lastOpenMenuMsg = openMenuMsgs[openMenuMsgs.length - 1];
ok("ブリッジありでは表示メニューのクリックでopen-menuを送信し、HTMLドロップダウンは作らない",
  !!lastOpenMenuMsg && (await page.$(".menu-dropdown")) === null);
const checkedItems = (lastOpenMenuMsg?.items ?? []).filter((it) => it.checked).map((it) => it.label);
ok(`全画面のチェックが反映 ${JSON.stringify(checkedItems)}`, checkedItems.includes("全画面表示"));
await page.evaluate(() => window.__reply({ type: "menu-closed", menu: "View" }));
await page.waitForTimeout(200);

console.log("--- ページエラー:", JSON.stringify(errors));
await browser.close();
