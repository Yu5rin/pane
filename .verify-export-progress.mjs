// 総点検 指摘20の回帰確認: エクスポート(PDF・Pandoc委譲のWord/EPUB等)の実行中、
//   (a) 進行中であることが画面に表示される(ステータスバー #status-export)
//   (b) メニュー(ファイル > エクスポート: *)がグレーになり、押しても実行できない
//       (src/commands.js の enabled: () => !ctx.getState().exporting)
//   (c) ネイティブメニューはJS側でクリックの可否を判定しない(disabled化はC#側の
//       ToolStripMenuItemが行う)ため、万一"menu-command"がもう一度届いても
//       src/main.js exportAs()自身が二重に実行しない(exportInProgressフラグ)
// ことを確認する。Pandoc/PrintToPdfAsyncを実際に二重起動しない本体側の防御
// (Pane/MainForm.cs _exportInProgress)はC#ランタイムが無いこの検証では確認できないため、
// dotnet build/testと本体のコードレビューで確認する(報告参照)。
// ポートは8216。
import pw from "playwright";
const { chromium } = pw;
const browser = await chromium.launch();
const page = await browser.newPage();
const errors = [];
const consoleErrors = [];
page.on("pageerror", (e) => errors.push(String(e.stack || e)));
page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });

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
await page.goto("http://localhost:8216/index.html");
await page.waitForTimeout(800);

let okCount = 0, ngCount = 0;
const ok = (label, cond) => { console.log(`${cond ? "OK  " : "NG  "} ${label}`); if (cond) okCount++; else ngCount++; };

// ファイルメニューを開き、open-menuで送られたitemsから"file.exportPdf"の状態を取り出す。
// (src/commands.js buildNativeItem。ネイティブメニューはメニューを開くたびに作り直すため、
// 直前の状態がここへ反映される。)
async function openFileMenuAndGetExportPdfItem() {
  await page.click("#menubar .menu-top:text('ファイル')");
  await page.waitForTimeout(200);
  const sent = await page.evaluate(() => window.__sent);
  const openMsgs = sent.filter((m) => m.type === "open-menu" && m.menu === "File");
  const items = openMsgs[openMsgs.length - 1]?.items ?? [];
  // メニューは開けっぱなしのまま(次のwindow.__replyで閉じる or 次のopen-menuで作り直る)
  // にすると以後のクリックが邪魔されるため、選ばずに閉じておく。
  await page.evaluate(() => window.__reply({ type: "menu-closed", menu: "File" }));
  await page.waitForTimeout(100);
  return items.find((it) => it.id === "file.exportPdf");
}

const exportSentCount = () => page.evaluate(() => window.__sent.filter((m) => m.type === "export").length);
const statusExportHidden = () => page.$eval("#status-export", (el) => el.hidden);

// ---- (0) 実行前: メニュー項目は有効、進行中表示は出ていない ----
const beforeItem = await openFileMenuAndGetExportPdfItem();
ok("実行前は「エクスポート: PDF」が有効", beforeItem?.enabled === true);
ok("実行前は#status-exportが隠れている(進行中表示なし)", await statusExportHidden());
ok("実行前はexportメッセージが0件", (await exportSentCount()) === 0);

// ---- (1) 実行: メニューを開き直してから"file.exportPdf"を選ぶ(実機でのクリックと同じ経路) ----
await page.click("#menubar .menu-top:text('ファイル')");
await page.waitForTimeout(200);
await page.evaluate(() => window.__reply({ type: "menu-command", id: "file.exportPdf" }));
await page.waitForTimeout(200);
ok("実行直後にexportメッセージが1件送られる", (await exportSentCount()) === 1);
ok('実行中は#status-exportが表示される(「エクスポートしています…」)', !(await statusExportHidden()));
ok('#status-exportの文言が「エクスポートしています…」', await page.$eval("#status-export", (el) => el.textContent) === "エクスポートしています…");

// ---- (2) 進行中: メニューを開き直すと「エクスポート: PDF」を含む全項目がグレーになる ----
// (見た目の防御。src/commands.js enabled: () => !ctx.getState().exporting)
const duringItem = await openFileMenuAndGetExportPdfItem();
ok("進行中は「エクスポート: PDF」がグレー(enabled=false)", duringItem?.enabled === false);

// ---- (3) 実行の実体(JS側)での二重実行防止: ネイティブメニューはenabledをJS側で
//          再チェックしない(disabled化はC#側のToolStripMenuItemの役目)ため、
//          万一"menu-command"がもう一度届いても、main.js exportAs()自身のガード
//          (exportInProgress)で弾かれ、2件目のexportメッセージは送られない ----
await page.evaluate(() => window.__reply({ type: "menu-command", id: "file.exportPdf" }));
await page.waitForTimeout(200);
ok("進行中にもう一度選んでもexportメッセージは増えない(1件のまま)", (await exportSentCount()) === 1);

// ---- (4) 完了(export-done)で進行中表示・メニューの無効化が解除される ----
await page.evaluate(() => window.__reply({ type: "export-done" }));
await page.waitForTimeout(200);
ok("完了後は#status-exportが隠れる", await statusExportHidden());
const afterItem = await openFileMenuAndGetExportPdfItem();
ok("完了後は「エクスポート: PDF」が再び有効", afterItem?.enabled === true);

// ---- (5) 完了後は改めて実行できる(2件目のexportメッセージが送られる) ----
await page.click("#menubar .menu-top:text('ファイル')");
await page.waitForTimeout(200);
await page.evaluate(() => window.__reply({ type: "menu-command", id: "file.exportPdf" }));
await page.waitForTimeout(200);
ok("完了後は改めて実行でき、exportメッセージが2件になる", (await exportSentCount()) === 2);
await page.evaluate(() => window.__reply({ type: "export-done" }));
await page.waitForTimeout(200);

console.log("\n---- JSエラー ----");
errors.forEach((e) => console.log("pageerror:", e));
consoleErrors.forEach((e) => console.log("console.error:", e));
ok("JS未処理エラーが無い", errors.length === 0);

console.log(`\n合計 OK=${okCount} NG=${ngCount}`);
await browser.close();
