import pw from "playwright";
const { chromium } = pw;
const browser = await chromium.launch();
const page = await browser.newPage();
const errors = [];
const consoleErrors = [];
page.on("pageerror", (e) => errors.push(String(e.stack || e)));
page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });
page.on("dialog", async (d) => { await d.accept("3"); });

await page.goto("http://localhost:8130/index.html");
await page.waitForTimeout(800);

const ok = (label, cond) => console.log(`${cond ? "OK  " : "NG  "} ${label}`);

// ---- 起動時の健全性 ----
ok("ページエラーなし", errors.length === 0);
const menus = await page.$$eval("#menubar .menu-top", (e) => e.map((x) => x.textContent));
ok(`メニューバー日本語5項目 ${JSON.stringify(menus)}`, menus.join() === "ファイル,編集,表示,段落,書式");

// ---- サイドバー ----
ok("サイドバーは初期状態で閉じている", await page.evaluate(() => document.getElementById("sidebar").classList.contains("collapsed")));
await page.click("#status-sidebar");
await page.waitForTimeout(300);
ok("ステータスバーのボタンで開く", await page.evaluate(() => !document.getElementById("sidebar").classList.contains("collapsed")));
const tabCount = await page.$$eval(".sidebar-tab", (e) => e.length);
ok(`パネル切替タブが3つ (${tabCount})`, tabCount === 3);
ok("サイドバー上端に検索欄がある", await page.$("#sidebar input") !== null);

// ---- アウトライン ----
await page.click(".cm-content");
await page.keyboard.type("# 第一章\n本文A\n\n## 節1\n本文B\n\n# 第二章\n本文C");
await page.waitForTimeout(600);
const outlineItems = await page.$$eval(".outline-item", (e) => e.map((x) => x.textContent.trim()));
ok(`アウトラインに見出し3件 ${JSON.stringify(outlineItems)}`, outlineItems.length === 3);

// ---- ステータスバー(行/列・ズーム率) ----
const pos = await page.textContent("#status-position");
const zoom = await page.textContent("#status-zoom");
ok(`行/列を表示 "${pos}"`, /\d/.test(pos || ""));
ok(`ズーム率を表示 "${zoom}"`, /%/.test(zoom || ""));

// ---- 文字数カウント詳細ポップアップ (W-02) ----
await page.click("#status-count");
await page.waitForTimeout(300);
const popText = await page.evaluate(() => document.querySelector(".wc-pop")?.textContent ?? "");
ok(`詳細ポップアップに単語数 (${popText.includes("単語")})`, popText.includes("単語"));
ok(`詳細ポップアップに段落数`, popText.includes("段落"));
ok(`詳細ポップアップに読了時間`, popText.includes("分"));
await page.keyboard.press("Escape");
await page.waitForTimeout(200);

// ---- View: ソースコードモード (Ctrl+/) ----
await page.click(".cm-content");
await page.keyboard.press("Control+/");
await page.waitForTimeout(400);
const srcModeShowsMarks = await page.evaluate(() => document.querySelector(".cm-content").innerText.includes("#"));
ok("ソースコードモードで記法マーカーが見える", srcModeShowsMarks);
await page.keyboard.press("Control+/");
await page.waitForTimeout(400);

// ---- View: フォーカスモード (F8) ----
await page.keyboard.press("F8");
await page.waitForTimeout(400);
const dimmed = await page.evaluate(() => document.querySelectorAll(".cm-dimmed").length);
ok(`フォーカスモードで他段落が減光 (${dimmed}行)`, dimmed > 0);
await page.keyboard.press("F8");
await page.waitForTimeout(300);
ok("フォーカスモード解除で減光が消える", await page.evaluate(() => document.querySelectorAll(".cm-dimmed").length === 0));

// ---- View: 拡大縮小 ----
const fs0 = await page.evaluate(() => getComputedStyle(document.querySelector(".cm-editor")).fontSize);
await page.keyboard.press("Control+Shift+Equal");
await page.waitForTimeout(200);
const fs1 = await page.evaluate(() => getComputedStyle(document.querySelector(".cm-editor")).fontSize);
await page.keyboard.press("Control+Shift+Digit0");
await page.waitForTimeout(200);
const fs2 = await page.evaluate(() => getComputedStyle(document.querySelector(".cm-editor")).fontSize);
ok(`拡大 ${fs0}->${fs1}`, fs0 !== fs1);
ok(`実際のサイズで戻る ${fs1}->${fs2}`, fs2 === fs0);
const menubarFs = await page.evaluate(() => getComputedStyle(document.getElementById("menubar")).fontSize);
ok(`メニューバーは拡大の影響を受けない (${menubarFs})`, menubarFs === "12.5px");

// ---- 既存機能の回帰 ----
await page.keyboard.press("Control+a");
await page.keyboard.press("Control+b");
await page.waitForTimeout(300);
ok("太字(Ctrl+B)が効く", (await page.evaluate(() => document.querySelector(".cm-content").innerText)).includes("**"));
await page.keyboard.press("Control+z");
await page.waitForTimeout(200);

await page.keyboard.press("Control+f");
await page.waitForTimeout(300);
ok("文書内検索(Ctrl+F)が開く", await page.evaluate(() => !document.getElementById("search-panel").hidden));
await page.keyboard.press("Escape");

await page.keyboard.press("Control+Shift+P");
await page.waitForTimeout(300);
const paletteOpen = await page.$(".palette-overlay") !== null;
ok("コマンドパレット(Ctrl+Shift+P)が開く", paletteOpen);
await page.keyboard.press("Escape");

// Viewメニューの項目数
await page.click("#menubar .menu-top:text('表示')");
await page.waitForTimeout(300);
const viewItems = await page.$$eval(".menu-dropdown .menu-item-label", (e) => e.map((x) => x.textContent));
console.log("Viewメニュー:", JSON.stringify(viewItems));
await page.keyboard.press("Escape");

console.log("--- コンソールエラー:", JSON.stringify(consoleErrors));
console.log("--- ページエラー:", JSON.stringify(errors));
await browser.close();
