// 取扱説明書ウィンドウ(F1、Pane/HelpWindow.cs、src/help-entry.js)の実ブラウザ検証。
// .verify-settingswindow.mjsと同じ流儀(WebView2ブリッジをモックし、window.__reply()で
// C#側からの応答を流し込む)。ポートは8199(タスク指定のsrv.shのポートに合わせる)。
//
// 検証項目(タスクの完了条件4点):
//   (a) 説明書が表示されること
//   (b) 目次のリンクをクリックすると該当見出しへ移動すること
//   (c) サイドバーの目次が見出しから生成されていること
//   (d) テーマを変えると配色が変わること
// 加えて、F1/「?」ボタン/コマンドパレットからの導線・Ctrl+F検索・エラー0件も確認する。
import pw from "playwright";
const { chromium } = pw;
const browser = await chromium.launch();
const errors = [];
let okCount = 0, ngCount = 0;
const ok = (l, c) => { console.log(`${c ? "OK  " : "NG  "} ${l}`); if (c) okCount++; else ngCount++; };

const PORT = 8199;
const BASE = `http://localhost:${PORT}`;

function installMockBridge() {
  const listeners = [];
  window.__sent = [];
  window.chrome = {
    webview: {
      postMessage: (m) => { window.__sent.push(m); },
      addEventListener: (_t, fn) => listeners.push(fn),
    },
  };
  window.__reply = (data) => listeners.forEach((fn) => fn({ data }));
}

function newPage(browserRef, label) {
  return browserRef.newPage().then((page) => {
    page.on("pageerror", (e) => errors.push(`${label}: ${String(e.stack || e)}`));
    page.on("console", (m) => { if (m.type() === "error") errors.push(`console(${label}): ${m.text()}`); });
    return page;
  });
}

// ============================================================
// (a)(b)(c) help-window.htmlを直接開いて確認する
// ============================================================
const page = await newPage(browser, "main");
await page.addInitScript(installMockBridge);
await page.goto(`${BASE}/help-window.html`);
await page.waitForTimeout(900);

// (前提) initial-render-readyが送られている(説明書の読み込み・変換・初期描画が完了した合図)
const sentReady = await page.evaluate(() => window.__sent.some((m) => m.type === "initial-render-ready"));
ok("(前提) 読み込み完了後にinitial-render-readyを送信", sentReady);

// (a) 説明書が表示されている(本文に見出し・段落が実際に描画されている)
const articleText = await page.$eval("#help-article", (e) => e.textContent || "");
const h1Text = await page.$eval("#help-article h1", (e) => e.textContent || "").catch(() => "");
ok(`(a) 本文が空でなく表示されている(${articleText.length}文字)`, articleText.length > 200);
ok(`(a) 見出し(h1)が実際に描画されている("${h1Text.trim()}")`, h1Text.trim().length > 0);

// (a付随・網羅) docs/取扱説明書.md内の「## 目次」節にある全リンク([text](#slug))について、
// 実際にその見出しのidが本文に存在することを確認する(1件だけでなく全件)。
const allTocLinks = await page.$$eval('#help-article a[href^="#"]', (els) =>
  els.map((e) => decodeURIComponent((e.getAttribute("href") || "").slice(1))).filter(Boolean)
);
const missingTargets = await page.evaluate((slugs) =>
  slugs.filter((s) => !document.getElementById(s)), allTocLinks);
ok(`(a付随) 本文内の#リンク(${allTocLinks.length}件)がすべて対応する見出しidを持つ(不足: ${JSON.stringify(missingTargets)})`, allTocLinks.length > 0 && missingTargets.length === 0);

// (c) サイドバーの目次が見出しから生成されている(#help-toc内の項目数がarticle内の見出し数と一致)
const tocCount = await page.$$eval(".help-toc-item", (els) => els.length);
const headingCount = await page.$$eval("#help-article h1,#help-article h2,#help-article h3,#help-article h4,#help-article h5,#help-article h6", (els) => els.length);
ok(`(c) サイドバーの目次項目数(${tocCount})が本文の見出し数(${headingCount})と一致する`, tocCount > 0 && tocCount === headingCount);
// 見出しに対応するid(スラグ)が実際に振られている
const headingIds = await page.$$eval("#help-article h1,#help-article h2,#help-article h3", (els) => els.map((e) => e.id));
ok(`(c) 見出しにid(スラグ)が振られている ${JSON.stringify(headingIds.slice(0, 3))}`, headingIds.every((id) => !!id));

// (b) 目次のリンク(本文中の"1. [xxx](#slug)")をクリックすると該当見出しへ移動する
// 説明書内の実際の目次リンク(docs/取扱説明書.mdの「## 目次」節にあるリンク)をクリックする。
const firstTocLink = await page.$('#help-article a[href^="#"]');
ok("(前提) 本文内に#始まりの目次リンクが存在する", !!firstTocLink);
if (firstTocLink) {
  const href = await firstTocLink.getAttribute("href");
  const slug = decodeURIComponent(href.slice(1));
  const beforeScroll = await page.evaluate(() => document.getElementById("help-content").scrollTop);
  await firstTocLink.click();
  await page.waitForTimeout(600); // scrollIntoView(behavior:"smooth")の完了待ち
  const afterScroll = await page.evaluate(() => document.getElementById("help-content").scrollTop);
  const targetInView = await page.evaluate((s) => {
    const el = document.getElementById(s);
    if (!el) return false;
    const r = el.getBoundingClientRect();
    const c = document.getElementById("help-content").getBoundingClientRect();
    return r.top >= c.top - 40 && r.top <= c.top + 200;
  }, slug);
  ok(`(b) 本文内の目次リンク(#${slug})クリックでスクロール位置が変わる (${beforeScroll} -> ${afterScroll})`, afterScroll !== beforeScroll);
  ok(`(b) 目標の見出しが表示領域の上部付近に来る`, targetInView);
  // サイドバー目次側もアクティブ表示に切り替わる
  const activeSlug = await page.$eval(".help-toc-item.active", (e) => e.dataset.slug).catch(() => null);
  ok(`(b) サイドバー目次側のアクティブ表示も追従する(active=${activeSlug})`, activeSlug === slug);
}

// サイドバーの目次項目自体をクリックしても同じように移動する
const tocItems = await page.$$(".help-toc-item");
if (tocItems.length > 1) {
  const targetSlug = await tocItems[1].evaluate((e) => e.dataset.slug);
  await tocItems[1].click();
  await page.waitForTimeout(600);
  const activeAfterTocClick = await page.$eval(".help-toc-item.active", (e) => e.dataset.slug).catch(() => null);
  ok(`(b付随) サイドバー目次のクリックでも該当見出しへ移動する(${targetSlug})`, activeAfterTocClick === targetSlug);
}

// ============================================================
// (d) テーマを変えると配色が変わる
// ============================================================
const themePage = await newPage(browser, "theme");
await themePage.emulateMedia({ colorScheme: "light" });
await themePage.addInitScript(installMockBridge);
await themePage.goto(`${BASE}/help-window.html`);
await themePage.waitForTimeout(900);
const bgBefore = await themePage.$eval("body", (e) => getComputedStyle(e).backgroundColor);
const inkBefore = await themePage.$eval("#help-article", (e) => getComputedStyle(e).color);
await themePage.evaluate(() => window.__reply({ type: "theme", theme: "dark", lightTheme: "default", darkTheme: "nord" }));
await themePage.waitForTimeout(300);
const bgAfter = await themePage.$eval("body", (e) => getComputedStyle(e).backgroundColor);
const inkAfter = await themePage.$eval("#help-article", (e) => getComputedStyle(e).color);
const themeAttrAfter = await themePage.evaluate(() => ({
  theme: document.documentElement.dataset.theme,
  darkTheme: document.documentElement.dataset.darkTheme,
}));
ok(`(d) theme:"dark"がdata-themeへ反映される (${JSON.stringify(themeAttrAfter)})`, themeAttrAfter.theme === "dark" && themeAttrAfter.darkTheme === "nord");
ok(`(d) 背景色が変わる (${bgBefore} -> ${bgAfter})`, bgBefore !== bgAfter);
ok(`(d) 本文の文字色が変わる (${inkBefore} -> ${inkAfter})`, inkBefore !== inkAfter);

// C#からのthemeメッセージが無くても、起動時スクリプト(prefers-color-scheme)でダークになる確認
const osDarkPage = await newPage(browser, "os-dark");
await osDarkPage.emulateMedia({ colorScheme: "dark" });
await osDarkPage.addInitScript(installMockBridge);
await osDarkPage.goto(`${BASE}/help-window.html`);
await osDarkPage.waitForTimeout(500);
const osDarkAttr = await osDarkPage.evaluate(() => document.documentElement.dataset.theme);
ok(`(d付随) OS設定がダークならbridge応答前でもdata-theme=darkになる(起動時スクリプト)`, osDarkAttr === "dark");

// ============================================================
// Ctrl+Fで説明書内を検索できる
// ============================================================
const searchPage = await newPage(browser, "search");
await searchPage.addInitScript(installMockBridge);
await searchPage.goto(`${BASE}/help-window.html`);
await searchPage.waitForTimeout(900);
const searchTerm = await searchPage.$eval("#help-article h2", (e) => (e.textContent || "").trim().slice(0, 4));
ok(`(前提) 検索語を本文見出しから採取("${searchTerm}")`, searchTerm.length > 0);
await searchPage.click("#help-article");
await searchPage.keyboard.press("Control+f");
await searchPage.waitForTimeout(150);
const barVisible = await searchPage.$eval("#help-search-bar", (e) => !e.hidden);
ok("Ctrl+Fで検索バーが開く", barVisible);
await searchPage.fill("#help-search-input", searchTerm);
await searchPage.waitForTimeout(200);
const hitCount = await searchPage.$$eval("mark.help-search-hit", (els) => els.length);
ok(`検索語でハイライトが作られる(${hitCount}件)`, hitCount > 0);
const countText = await searchPage.$eval("#help-search-count", (e) => e.textContent);
ok(`件数表示が更新される("${countText}")`, /^\d+\/\d+$/.test(countText) && countText !== "0/0");
await searchPage.keyboard.press("Escape");
await searchPage.waitForTimeout(150);
const barHiddenAfterEscape = await searchPage.$eval("#help-search-bar", (e) => e.hidden);
ok("Escapeで検索バーが閉じる", barHiddenAfterEscape);

// ============================================================
// F1・「?」ボタン・コマンドパレットからの導線(index.html側)
// ============================================================
const indexPage = await newPage(browser, "index");
await indexPage.addInitScript(installMockBridge);
await indexPage.goto(`${BASE}/index.html`);
await indexPage.waitForTimeout(800);

await indexPage.click(".cm-content");
await indexPage.keyboard.press("F1");
await indexPage.waitForTimeout(200);
const sentByF1 = await indexPage.evaluate(() => window.__sent.some((m) => m.type === "open-help-window"));
ok('F1キーで{ type: "open-help-window" }が送られる(本文にフォーカスがある状態)', sentByF1);

// サイドバー(アウトラインパネル等)にフォーカスがあってもF1が効くことの確認。
// サイドバーを開いてから、その内部の要素(検索欄等の実在するinput)へフォーカスしてF1を押す。
await indexPage.evaluate(() => { window.__sent.length = 0; });
await indexPage.click("#status-sidebar");
await indexPage.waitForTimeout(300);
await indexPage.evaluate(() => {
  const sidebar = document.getElementById("sidebar");
  const focusable = sidebar?.querySelector("input, button, [tabindex]");
  (focusable || sidebar || document.body)?.focus();
});
await indexPage.keyboard.press("F1");
await indexPage.waitForTimeout(200);
const sentByF1FromSidebar = await indexPage.evaluate(() => window.__sent.some((m) => m.type === "open-help-window"));
ok('F1キーで{ type: "open-help-window" }が送られる(サイドバーにフォーカスがある状態)', sentByF1FromSidebar);

// 「?」ボタン
await indexPage.evaluate(() => { window.__sent.length = 0; });
const helpBtn = await indexPage.$("#btn-menu-help");
ok('メニューバー右上に「?」ボタンが存在する', !!helpBtn);
if (helpBtn) {
  await helpBtn.click();
  await indexPage.waitForTimeout(200);
  const sentByBtn = await indexPage.evaluate(() => window.__sent.some((m) => m.type === "open-help-window"));
  const sentOldVersionInfo = await indexPage.evaluate(() => window.__sent.some((m) => m.type === "open-settings-window"));
  ok('「?」ボタンで{ type: "open-help-window" }が送られる', sentByBtn);
  ok('「?」ボタンはもう設定画面(open-settings-window)を開かない', !sentOldVersionInfo);
}

// コマンドパレット(Ctrl+Shift+P)から help.manual を検索して実行できる
await indexPage.evaluate(() => { window.__sent.length = 0; });
await indexPage.keyboard.press("Control+Shift+P");
await indexPage.waitForTimeout(250);
const paletteOpen = (await indexPage.$(".palette-overlay")) !== null;
ok("コマンドパレットが開く", paletteOpen);
if (paletteOpen) {
  await indexPage.fill("#palette-input", "取扱説明書");
  await indexPage.waitForTimeout(150);
  const items = await indexPage.$$eval("#palette-list li", (els) => els.map((e) => e.textContent));
  ok(`コマンドパレットに取扱説明書を開く項目が出る ${JSON.stringify(items)}`, items.some((t) => t.includes("取扱説明書")));
  await indexPage.click("#palette-list li >> nth=0");
  await indexPage.waitForTimeout(200);
  const sentByPalette = await indexPage.evaluate(() => window.__sent.some((m) => m.type === "open-help-window"));
  ok('コマンドパレットからの実行で{ type: "open-help-window" }が送られる', sentByPalette);
}

// ============================================================
// エラー0件
// ============================================================
console.log("--- エラー:", JSON.stringify(errors));
ok("ページエラー・コンソールエラーが0件", errors.length === 0);

console.log(`\n合計: OK ${okCount} / NG ${ngCount}`);
await browser.close();
process.exit(ngCount > 0 ? 1 : 0);
