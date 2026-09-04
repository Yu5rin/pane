// 総点検 指摘18の回帰確認: フォルダを開いてから走査完了(folder-loaded)までの間、
// サイドバーが「フォルダが読み込まれていません」のまま(=失敗したように見える)ままにならず、
// 「フォルダを読み込んでいます…」という走査中の状態を示すこと。
//   - src/main.js の "folder-loading" 受信 → sidebar.setFolderLoading(true)
//   - src/sidebar.js の renderFolderLoading()/appendLoadingNotice()
//   - Pane/MainForm.cs の LoadFolderAsync が走査開始時に "folder-loading" を送る(autoLoaded=falseのみ)
// ポートは8215(他の.verify-*.mjsと重複しない値をrun-verify.shのポート収集ロジックに
// 合わせてリテラルで直書きする)。
import pw from "playwright";
const { chromium } = pw;
const browser = await chromium.launch();
const page = await browser.newPage();
const errors = [];
const consoleErrors = [];
page.on("pageerror", (e) => errors.push(String(e.stack || e)));
page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });

// .verify-bridge.mjsと同じモック手順(ブリッジのpostMessageを記録し、C#役として応答する)。
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
await page.goto("http://localhost:8215/index.html");
await page.waitForTimeout(800);

let okCount = 0, ngCount = 0;
const ok = (label, cond) => { console.log(`${cond ? "OK  " : "NG  "} ${label}`); if (cond) okCount++; else ngCount++; };

const bodyText = () => page.$eval("#sidebar-body", (el) => el.textContent);

// サイドバーを開き、ファイルツリーのタブへ切り替える(フォルダ未読み込み時の空状態が
// 出るのはfiles/treeパネルのみ。outlineは別の空状態を持つため対象外)。
await page.click("#status-sidebar");
await page.waitForTimeout(200);
await page.click('.sidebar-tab[data-panel="tree"]');
await page.waitForTimeout(200);

// ---- (1) 未読み込み・未走査: 従来からある空状態 ----
ok("フォルダ未読み込み時は「フォルダが読み込まれていません」", (await bodyText()).includes("フォルダが読み込まれていません"));
ok("フォルダ未読み込み時は「フォルダを開く」ボタンがある", await page.$(".sidebar-open-folder-btn") !== null);

// ---- (2) 走査開始(folder-loading)を受けたら、走査中である旨に切り替わる ----
// 総点検 指摘18の本体: これが無いと、ここでも(1)と同じ「フォルダが読み込まれていません」の
// ままになり(=失敗したように見える)、もう一度「フォルダを開く」ボタンを押せてしまっていた。
await page.evaluate(() => window.__reply({ type: "folder-loading" }));
await page.waitForTimeout(200);
const loadingText = await bodyText();
ok('走査中は「フォルダを読み込んでいます…」に切り替わる', loadingText.includes("フォルダを読み込んでいます"));
ok('走査中は「フォルダが読み込まれていません」ではない(失敗したように見えない)', !loadingText.includes("フォルダが読み込まれていません"));
ok("走査中は「フォルダを開く」ボタンが出ない(2重に走査を始められない)", await page.$(".sidebar-open-folder-btn") === null);

// ---- (3) 走査完了(folder-loaded、成功)で一覧が表示され、走査中の表示は消える ----
await page.evaluate(() => window.__reply({
  type: "folder-loaded", rootPath: "C:\\work", rootName: "work", truncated: false,
  entries: [
    { path: "C:\\work\\a.md", name: "a.md", relativePath: "a.md", isDirectory: false },
    { path: "C:\\work\\b.md", name: "b.md", relativePath: "b.md", isDirectory: false },
  ],
}));
await page.waitForTimeout(300);
await page.click('.sidebar-tab[data-panel="tree"]');
await page.waitForTimeout(200);
const loadedText = await bodyText();
ok('走査完了後は「フォルダを読み込んでいます…」が消える', !loadedText.includes("フォルダを読み込んでいます"));
ok("走査完了後はルート名(work)が表示される", loadedText.includes("work"));

// ---- (4) 既にフォルダが読み込み済みの状態で再走査が始まった場合: 前の一覧を消さずに
//          末尾へ「フォルダを読み込んでいます…」を注記として添える(グローバル検索が既存の
//          ヒットを残したまま「検索中…」を添える見せ方と同じ考え方) ----
await page.evaluate(() => window.__reply({ type: "folder-loading" }));
await page.waitForTimeout(200);
const reloadingText = await bodyText();
ok("再走査中も直前の一覧(work)は消えない", reloadingText.includes("work"));
ok("再走査中は末尾に「フォルダを読み込んでいます…」の注記が付く", reloadingText.includes("フォルダを読み込んでいます"));

// ---- (5) 失敗(folder-loaded、error)でも走査中の表示は解除される ----
await page.evaluate(() => window.__reply({ type: "folder-loaded", error: "アクセスが拒否されました。" }));
await page.waitForTimeout(200);
const errorText = await bodyText();
ok("失敗時は走査中の表示が残らない", !errorText.includes("フォルダを読み込んでいます"));
ok("失敗時はエラーメッセージが表示される", errorText.includes("アクセスが拒否されました"));

console.log("\n---- JSエラー ----");
errors.forEach((e) => console.log("pageerror:", e));
consoleErrors.forEach((e) => console.log("console.error:", e));
ok("JS未処理エラーが無い", errors.length === 0);

console.log(`\n合計 OK=${okCount} NG=${ngCount}`);
await browser.close();
