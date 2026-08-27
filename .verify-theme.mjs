import pw from "playwright";
const { chromium } = pw;
const browser = await chromium.launch();
const page = await browser.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(String(e.stack || e)));
page.on("console", (m) => {
  if (m.type() === "error") errors.push(`console.error: ${m.text()}`);
});

// WebView2ブリッジをモック(.verify-bridge.mjsと同じ形)。
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
await page.goto("http://localhost:8141/index.html");
await page.waitForTimeout(500);

const ok = (l, c) => console.log(`${c ? "OK  " : "NG  "} ${l}`);

// 本文を開いておく(.cm-content にテキストが無いと見た目の差分が分かりにくいため)。
await page.evaluate(() => window.__reply({
  type: "file-opened",
  fileName: "test.md",
  text: "# 見出し\n\n本文テキストです。",
  path: "C:\\work\\test.md",
  encoding: "UTF-8",
  lineEnding: "LF",
  readOnly: false,
}));
await page.waitForTimeout(300);

const bodyBg = async () => page.evaluate(() => getComputedStyle(document.body).backgroundColor);

// ---- (a) lightTheme: "sepia" で本文背景色が既定と変わる ----
const bgDefaultLight = await bodyBg();
await page.evaluate(() => window.__reply({ type: "apply-settings", theme: "light", lightTheme: "sepia" }));
await page.waitForTimeout(200);
const bgSepia = await bodyBg();
ok(`(a) lightTheme=sepia で本文背景色が既定(${bgDefaultLight})と変わる → ${bgSepia}`, bgSepia !== bgDefaultLight);
const attrLight = await page.evaluate(() => document.documentElement.getAttribute("data-light-theme"));
ok(`(a-2) data-light-theme=sepia が付与される → ${attrLight}`, attrLight === "sepia");

// sepia解除(defaultへ)して次のケースに備える
await page.evaluate(() => window.__reply({ type: "apply-settings", theme: "light", lightTheme: "default" }));
await page.waitForTimeout(200);

// ---- (b) darkTheme: "nord" + theme: "dark" で同様に変わる ----
await page.evaluate(() => window.__reply({ type: "apply-settings", theme: "dark", darkTheme: "default" }));
await page.waitForTimeout(200);
const bgDefaultDark = await bodyBg();
await page.evaluate(() => window.__reply({ type: "apply-settings", theme: "dark", darkTheme: "nord" }));
await page.waitForTimeout(200);
const bgNord = await bodyBg();
ok(`(b) darkTheme=nord で本文背景色が既定(${bgDefaultDark})と変わる → ${bgNord}`, bgNord !== bgDefaultDark);
const themeAttr = await page.evaluate(() => document.documentElement.getAttribute("data-theme"));
const attrDark = await page.evaluate(() => document.documentElement.getAttribute("data-dark-theme"));
ok(`(b-2) data-theme=dark, data-dark-theme=nord が付与される → theme=${themeAttr}, dark=${attrDark}`, themeAttr === "dark" && attrDark === "nord");

// ライトに戻しておく(以降のケースへの影響を避ける)
await page.evaluate(() => window.__reply({ type: "apply-settings", theme: "light", lightTheme: "default", darkTheme: "default" }));
await page.waitForTimeout(200);

// ---- (c) customCss で .cm-content に letter-spacing 3px が実際に適用される ----
const lsBefore = await page.evaluate(() => getComputedStyle(document.querySelector(".cm-content")).letterSpacing);
await page.evaluate(() => window.__reply({ type: "apply-settings", customCss: ".cm-content { letter-spacing: 3px }" }));
await page.waitForTimeout(200);
const lsAfter = await page.evaluate(() => getComputedStyle(document.querySelector(".cm-content")).letterSpacing);
ok(`(c) customCssで letter-spacing が適用される (${lsBefore} → ${lsAfter})`, lsAfter === "3px" && lsAfter !== lsBefore);
const styleElText = await page.evaluate(() => document.getElementById("custom-css")?.textContent ?? null);
ok(`(c-2) #custom-css の textContent に反映される → "${styleElText}"`, styleElText === ".cm-content { letter-spacing: 3px }");

// ---- (d) customCss を空にすると元に戻る ----
await page.evaluate(() => window.__reply({ type: "apply-settings", customCss: "" }));
await page.waitForTimeout(200);
const lsCleared = await page.evaluate(() => getComputedStyle(document.querySelector(".cm-content")).letterSpacing);
ok(`(d) customCssを空にすると letter-spacing が元(${lsBefore})に戻る → ${lsCleared}`, lsCleared === lsBefore);
const styleElTextCleared = await page.evaluate(() => document.getElementById("custom-css")?.textContent ?? null);
ok(`(d-2) #custom-css の textContent が空になる → "${styleElTextCleared}"`, styleElTextCleared === "");

// ---- (e) ページエラー・コンソールエラーが0件 ----
ok(`(e) ページエラー・コンソールエラーが0件 (${errors.length}件)`, errors.length === 0);
if (errors.length) console.log(errors.join("\n"));

await browser.close();
