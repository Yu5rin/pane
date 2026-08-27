import pw from "playwright";
const { chromium } = pw;
const browser = await chromium.launch();
const page = await browser.newPage();
const errors = [];
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
// 設定画面は独立ウィンドウ(settings-window.html / Pane/SettingsWindow.cs)になったため、
// 本文側のCtrl+,ではなく設定ウィンドウのページを直接開いて検証する。
await page.goto("http://localhost:8130/settings-window.html");
await page.waitForTimeout(800);
const ok = (l, c) => console.log(`${c ? "OK  " : "NG  "} ${l}`);

ok("設定画面が開く", (await page.$(".settings-modal")) !== null);
ok("get-settingsを送信", await page.evaluate(() => window.__sent.some((m) => m.type === "get-settings")));

// C#役として現在設定を返す(MainForm.csのsettingsメッセージと同じフラット構造)
await page.evaluate(() => window.__reply({
  type: "settings",
  theme: "light", editorFontSize: 15, editorFontFamily: "", startupBehavior: "blank",
  calloutsEnabled: true, superSubscriptEnabled: true, highlightEnabled: true,
  inlineMathEnabled: true, mathAutoNumberEnabled: false, strictMode: false,
  codeBlockLineNumbers: true, autoPairing: true, showWordCount: true,
  defaultCopyFormat: "markdown", preloadOnStartup: false,
  associatedExtensions: ["md", "py"], keyBindings: {},
  defaultEncoding: "utf-8", defaultLineEnding: "crlf", displayMode: "window",
  lightTheme: "default", darkTheme: "default", customCssPath: "",
}));
await page.waitForTimeout(400);

const cats = await page.$$eval(".settings-nav-item", (e) => e.map((x) => x.textContent.trim()));
ok(`サイドバーにカテゴリ ${JSON.stringify(cats)}`, cats.length >= 5);

// ---- 拡張子の関連付け(3階層ツリー) ----
const assocCat = cats.findIndex((c) => c.includes("関連付け"));
ok("「関連付け」カテゴリがある", assocCat >= 0);
if (assocCat >= 0) {
  await page.click(`.settings-nav-item >> nth=${assocCat}`);
  await page.waitForTimeout(400);
  const catRows = await page.$$eval(".ft-category", (e) => e.length);
  const langRows = await page.$$eval(".ft-lang", (e) => e.length);
  const extRows = await page.$$eval(".ft-row-ext", (e) => e.length);
  ok(`分類(第1階層)が7件 (${catRows})`, catRows === 7);
  ok(`言語(第2階層)が90件以上 (${langRows})`, langRows >= 90);
  ok(`拡張子(第3階層)が220件以上 (${extRows})`, extRows >= 220);
  const catLabels = await page.$$eval(".ft-row-category", (e) => e.map((x) => x.textContent.trim()));
  ok(`「その他」分類がある ${JSON.stringify(catLabels)}`, catLabels.some((t) => t.includes("その他")));

  // 初期チェック状態が associatedExtensions を反映しているか
  const checkedExts = await page.$$eval('input[data-ext]', (e) => e.filter((x) => x.checked).map((x) => x.dataset.ext));
  ok(`初期チェックが設定値を反映 ${JSON.stringify(checkedExts)}`, checkedExts.length === 2 && checkedExts.includes("md") && checkedExts.includes("py"));

  // 言語をチェック → 配下の拡張子が全部チェックされる
  const before = await page.$$eval('input[data-ext]', (e) => e.filter((x) => x.checked).length);
  await page.evaluate(() => {
    const inp = document.querySelector('input[data-lang]');
    inp.checked = true; inp.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await page.waitForTimeout(250);
  const after = await page.$$eval('input[data-ext]', (e) => e.filter((x) => x.checked).length);
  ok(`言語チェックで配下の拡張子が連動 (${before}->${after})`, after > before);

  // 分類をチェック → 配下すべて。1件目の分類(マークダウン)は直前の言語チェックで既に
  // 全選択済みになっているため、まだ未選択の「プログラミング言語」分類で確認する。
  const progExtCount = await page.evaluate(() => {
    const inp = document.querySelector('input[data-cat="programming"]');
    inp.checked = true; inp.dispatchEvent(new Event("change", { bubbles: true }));
    return document.querySelectorAll('[data-cat-body="programming"] input[data-ext]').length;
  });
  await page.waitForTimeout(250);
  const after2 = await page.$$eval('input[data-ext]', (e) => e.filter((x) => x.checked).length);
  const progChecked = await page.$$eval('[data-cat-body="programming"] input[data-ext]', (e) => e.filter((x) => x.checked).length);
  ok(`分類チェックで配下すべてが連動 (${after}->${after2} / 配下${progChecked}/${progExtCount})`, progChecked === progExtCount && after2 > after);

  // 一括操作
  await page.click('[data-quick="none"]');
  await page.waitForTimeout(200);
  ok("「すべて解除」で0件になる", (await page.$$eval('input[data-ext]', (e) => e.filter((x) => x.checked).length)) === 0);
  await page.click('[data-quick="markdown"]');
  await page.waitForTimeout(200);
  const mdOnly = await page.$$eval('input[data-ext]', (e) => e.filter((x) => x.checked).map((x) => x.dataset.ext));
  ok(`「Markdownのみ」で最小構成 ${JSON.stringify(mdOnly)}`, mdOnly.includes("md") && mdOnly.length <= 5);
}

// ---- キーバインドの安全性(C-10) ----
const kbCat = cats.findIndex((c) => c.includes("キー"));
if (kbCat >= 0) {
  await page.click(`.settings-nav-item >> nth=${kbCat}`);
  await page.waitForTimeout(400);
  const rows = await page.$$eval(".kb-row", (e) => e.length);
  ok(`キーバインド一覧が表示される (${rows}行)`, rows > 10);

  await page.click(".kb-row >> nth=0");
  await page.waitForTimeout(200);
  ok("クリックで捕捉待ちになる", (await page.$(".kb-row.capturing")) !== null);
  // 危険なキー(修飾なしの "a")は拒否され、捕捉状態が続く
  await page.keyboard.press("a");
  await page.waitForTimeout(250);
  const warn = await page.evaluate(() => document.querySelector(".kb-row.capturing .kb-cell-warn")?.textContent ?? "");
  ok(`修飾キーなしの文字キーを拒否 "${warn.slice(0, 50)}"`, warn.includes("Ctrl") || warn.includes("Alt"));
  ok("拒否後も捕捉待ちのまま", (await page.$(".kb-row.capturing")) !== null);
  // 安全なキー(Ctrl+Alt+9)は受け付ける
  await page.keyboard.press("Control+Alt+9");
  await page.waitForTimeout(300);
  const assigned = await page.evaluate(() => document.querySelector(".kb-row .kb-cell-shortcut")?.textContent?.trim() ?? "");
  ok(`Ctrl+Alt+9は割り当てできる "${assigned}"`, /Ctrl/.test(assigned) && /9/.test(assigned));
}

// ---- 保存 ----
await page.click('[data-act="save"]');
await page.waitForTimeout(300);
const saved = await page.evaluate(() => window.__sent.filter((m) => m.type === "save-settings").pop());
ok("save-settingsを送信", !!saved);
const savedExts = saved?.settings?.associatedExtensions ?? saved?.associatedExtensions;
ok(`関連付け拡張子が含まれる (${Array.isArray(savedExts) ? savedExts.length : "なし"}件)`, Array.isArray(savedExts));
const savedKb = saved?.settings?.keyBindings ?? saved?.keyBindings;
ok(`キーバインドが含まれる ${JSON.stringify(savedKb)}`, !!savedKb && Object.keys(savedKb).length > 0);

console.log("--- エラー:", JSON.stringify(errors));
await browser.close();
