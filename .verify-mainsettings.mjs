// main.js / sidebar.js / text-stats.js / word-count.js が担当する設定項目・小機能の実ブラウザ検証。
// .verify-filemode.mjs / .verify-bridge.mjs と同じ流儀(WebView2ブリッジをモックし、
// file-opened / apply-settings 等をwindow.__reply()で流し込む)。ポートは8149。
import pw from "playwright";
const { chromium } = pw;
const browser = await chromium.launch();
const errors = [];
let okCount = 0, ngCount = 0;
const ok = (l, c) => { console.log(`${c ? "OK  " : "NG  "} ${l}`); if (c) okCount++; else ngCount++; };

async function newPage() {
  const page = await browser.newPage();
  page.on("pageerror", (e) => errors.push(String(e.stack || e)));
  page.on("console", (m) => { if (m.type() === "error") errors.push("console: " + m.text()); });
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
  await page.goto("http://localhost:8149/index.html");
  await page.waitForTimeout(700);
  return page;
}

async function applySettings(page, partial) {
  await page.evaluate((partial) => window.__reply({ type: "apply-settings", ...partial }), partial);
  await page.waitForTimeout(300);
}
async function openFile(page, text, extra = {}) {
  await page.evaluate(({ text, extra }) => window.__reply({
    type: "file-opened", fileName: "sample.md", path: "C:\\work\\sample.md", text,
    encoding: "UTF-8", lineEnding: "CRLF", readOnly: false, ...extra,
  }), { text, extra });
  await page.waitForTimeout(400);
}
async function cmHostHeight(page) {
  return page.$eval("#cm-host", (el) => el.getBoundingClientRect().height);
}
async function statusZoomText(page) {
  return page.textContent("#status-zoom");
}
async function docText(page) {
  // CodeMirrorは行ごとに別のdiv(.cm-line)としてDOM化するため、.cm-content全体の
  // textContentをそのまま取ると改行が失われる。行要素を個別に取り、\nで連結する。
  return page.$$eval(".cm-content .cm-line", (els) => els.map((e) => e.textContent).join("\n"));
}

// ============================================================
// (a) showStatusBar
// ============================================================
{
  const page = await newPage();
  const baseline = await cmHostHeight(page);
  const statusbarVisible = await page.$eval("#statusbar", (el) => getComputedStyle(el).display !== "none");
  ok(`(a-前提) 既定でステータスバーが表示されている`, statusbarVisible);

  await applySettings(page, { showStatusBar: false });
  const hiddenNow = await page.$eval("#statusbar", (el) => getComputedStyle(el).display === "none");
  const heightAfterHide = await cmHostHeight(page);
  ok(`(a) showStatusBar:false でステータスバーが消える`, hiddenNow);
  ok(`(a) 非表示で本文エリアの高さが増える (${baseline} -> ${heightAfterHide})`, heightAfterHide > baseline);

  await applySettings(page, { showStatusBar: true });
  const visibleAgain = await page.$eval("#statusbar", (el) => getComputedStyle(el).display !== "none");
  const heightRestored = await cmHostHeight(page);
  ok(`(a) trueに戻すとステータスバーが再表示される`, visibleAgain);
  ok(`(a) 高さも元に戻る (${heightRestored} ≈ ${baseline})`, Math.abs(heightRestored - baseline) < 2);
  await page.close();
}

// ============================================================
// (b) zoomWithCtrlWheel
// ============================================================
{
  const page = await newPage();
  await page.click(".cm-content");
  await applySettings(page, { zoomWithCtrlWheel: false });
  const before = await statusZoomText(page);
  await page.keyboard.down("Control");
  await page.mouse.wheel(0, -120);
  await page.keyboard.up("Control");
  await page.waitForTimeout(200);
  const afterDisabled = await statusZoomText(page);
  ok(`(b) zoomWithCtrlWheel:false でCtrl+ホイールしても変わらない (${before} -> ${afterDisabled})`, before === afterDisabled);

  await applySettings(page, { zoomWithCtrlWheel: true });
  await page.keyboard.down("Control");
  await page.mouse.wheel(0, -120);
  await page.keyboard.up("Control");
  await page.waitForTimeout(200);
  const afterEnabled = await statusZoomText(page);
  ok(`(b) zoomWithCtrlWheel:true ならCtrl+ホイールで変わる (${before} -> ${afterEnabled})`, afterEnabled !== before);
  await page.close();
}

// ============================================================
// (c)(d) showOutlineByDefault は起動時1回だけ
// ============================================================
{
  const page = await newPage();
  await applySettings(page, { showOutlineByDefault: true });
  const collapsedAfterFirst = await page.$eval("#sidebar", (el) => el.classList.contains("collapsed"));
  const activePanel = await page.$eval(".sidebar-tab.active", (el) => el.dataset.panel).catch(() => null);
  ok(`(c) showOutlineByDefault:true で起動時にサイドバーが開く`, !collapsedAfterFirst);
  ok(`(c) アウトラインパネルが選択されている (panel=${activePanel})`, activePanel === "outline");

  // 手で閉じる
  await page.click("#status-sidebar");
  await page.waitForTimeout(300);
  const closedManually = await page.$eval("#sidebar", (el) => el.classList.contains("collapsed"));
  ok(`(d-前提) 手動で閉じられる`, closedManually);

  // apply-settingsが再送されても勝手に開かない
  await applySettings(page, { showOutlineByDefault: true });
  const stillClosed = await page.$eval("#sidebar", (el) => el.classList.contains("collapsed"));
  ok(`(d) 手で閉じた後はapply-settings再送でも再度開かない`, stillClosed);
  await page.close();
}

// ============================================================
// (e)(f) collapsibleOutline
// ============================================================
{
  const page = await newPage();
  const nested = "# H1\n\n## H1a\n\n### H1a-i\n\n## H1b\n\n# H2\n";
  await openFile(page, nested);
  await page.click("#status-sidebar");
  await page.click('.sidebar-tab[data-panel="outline"]');
  await page.waitForTimeout(300);

  // (e) collapsibleOutline:true(既定)
  await applySettings(page, { collapsibleOutline: true });
  const totalItems = await page.$$eval(".outline-item", (e) => e.length);
  const chevronCount = await page.$$eval(".outline-item svg.tree-chevron", (e) => e.length);
  ok(`(e) 見出し5件が表示される (${totalItems})`, totalItems === 5);
  ok(`(e) 下位見出しを持つ項目(H1)に折りたたみ操作がある (${chevronCount}件)`, chevronCount >= 1);

  // H1のシェブロンをクリックして折りたたむ
  await page.click(".outline-item svg.tree-chevron");
  await page.waitForTimeout(200);
  const afterCollapse = await page.$$eval(".outline-item", (e) => e.map((x) => x.textContent.trim()));
  ok(`(e) 折りたたむと子(H1a/H1a-i/H1b)が隠れる ${JSON.stringify(afterCollapse)}`,
    afterCollapse.length === 2 && afterCollapse.includes("H1") && afterCollapse.includes("H2"));

  // (f) collapsibleOutline:false
  await applySettings(page, { collapsibleOutline: false });
  const itemsAllExpanded = await page.$$eval(".outline-item", (e) => e.length);
  const chevronCountOff = await page.$$eval(".outline-item svg.tree-chevron", (e) => e.length);
  ok(`(f) collapsibleOutline:false で折りたたみ操作が出ない (${chevronCountOff})`, chevronCountOff === 0);
  ok(`(f) 全見出しが展開表示される (${itemsAllExpanded})`, itemsAllExpanded === 5);
  await page.close();
}

// ============================================================
// (g) readingSpeedWpm
// ============================================================
{
  const page = await newPage();
  const text = "a ".repeat(3000).trim(); // 単語数3000、1語1文字(空白除く文字数も3000)
  await openFile(page, text);

  async function readingTimeValue() {
    await page.click("#status-count");
    await page.waitForTimeout(200);
    const rows = await page.$$eval(".wc-pop .wc-row", (els) => els.map((e) => ({
      label: e.querySelector(".wc-label")?.textContent, val: e.querySelector(".wc-val")?.textContent,
    })));
    await page.click("#status-count");
    await page.waitForTimeout(150);
    return rows.find((r) => r.label === "読了時間")?.val;
  }

  await applySettings(page, { readingSpeedWpm: 0 });
  const defaultTime = await readingTimeValue();
  await applySettings(page, { readingSpeedWpm: 120 });
  const wpm120Time = await readingTimeValue();
  const parseMin = (s) => parseInt(String(s).replace(/[^0-9]/g, ""), 10) || 0;
  ok(`(g) readingSpeedWpm:120 で読了時間が既定より長くなる (${defaultTime} -> ${wpm120Time})`,
    parseMin(wpm120Time) > parseMin(defaultTime));
  await page.close();
}

// ============================================================
// (h) F5 日時の挿入
// ============================================================
{
  const page = await newPage();
  await page.evaluate(() => window.__reply({ type: "new-document" }));
  await page.waitForTimeout(300);
  await page.click(".cm-content");
  await page.keyboard.press("F5");
  await page.waitForTimeout(300);
  const inserted = await docText(page);
  const matched = /^\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}$/.test(inserted.trim());
  ok(`(h) F5で YYYY/MM/DD HH:mm 形式の日時が挿入される: ${JSON.stringify(inserted)}`, matched);
  await page.close();
}

// ============================================================
// (i)(j) .LOG の自動追記
// ============================================================
{
  const page = await newPage();

  // (i) 1行目が.LOGだけのファイル
  await openFile(page, ".LOG", { fileName: "note.txt", path: "C:\\work\\note.txt" });
  const textAfterLog = await docText(page);
  const lines = textAfterLog.split("\n");
  const lastDirtyLog = await page.evaluate(() => {
    const dirtyMsgs = window.__sent.filter((m) => m.type === "dirty");
    return dirtyMsgs.length ? dirtyMsgs[dirtyMsgs.length - 1].value : null;
  });
  ok(`(i) .LOGファイルを開くと2行になり末尾が日時 ${JSON.stringify(lines)}`,
    lines.length === 2 && lines[0] === ".LOG" && /^\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}$/.test(lines[1]));
  ok(`(i) 追記後はdirty状態になる (dirty=${lastDirtyLog})`, lastDirtyLog === true);

  // (j) 1行目が.LOGでないファイル
  await openFile(page, "普通のメモです。\n2行目。", { fileName: "note2.txt", path: "C:\\work\\note2.txt" });
  const textNormal = await docText(page);
  const lastDirtyNormal = await page.evaluate(() => {
    const dirtyMsgs = window.__sent.filter((m) => m.type === "dirty");
    return dirtyMsgs.length ? dirtyMsgs[dirtyMsgs.length - 1].value : null;
  });
  ok(`(j) .LOGでないファイルは内容が変わらない: ${JSON.stringify(textNormal)}`, textNormal.includes("普通のメモです。") && !/\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}/.test(textNormal));
  ok(`(j) dirtyにならない (dirty=${lastDirtyNormal})`, lastDirtyNormal === false);
  await page.close();
}

// ============================================================
// (k) ページエラー・コンソールエラー0件
// ============================================================
ok(`(k) ページエラー・コンソールエラー0件: ${JSON.stringify(errors)}`, errors.length === 0);

console.log(`\n合計: OK ${okCount} / NG ${ngCount}`);
await browser.close();
process.exit(ngCount > 0 ? 1 : 0);
