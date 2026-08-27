// テーマプリセット選択(C-06)・拡張子ごとの編集モード上書き(fileModeOverrides)の検証。
// .verify-settings.mjs / .verify-settingswindow.mjs と同じ流儀。設定画面は独立ウィンドウ
// (settings-window.html / Pane/SettingsWindow.cs)になったため、本文側のCtrl+,ではなく
// 設定ウィンドウのページを直接開いて検証する。ポートのみ8143を使う。
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
await page.goto("http://localhost:8143/settings-window.html");
await page.waitForTimeout(800);
let okCount = 0, ngCount = 0;
const ok = (l, c) => { console.log(`${c ? "OK  " : "NG  "} ${l}`); if (c) okCount++; else ngCount++; };

ok("設定画面が開く", (await page.$(".settings-modal")) !== null);
ok("get-settingsを送信", await page.evaluate(() => window.__sent.some((m) => m.type === "get-settings")));

await page.evaluate(() => window.__reply({
  type: "settings",
  theme: "light", editorFontSize: 15, editorFontFamily: "", startupBehavior: "blank",
  calloutsEnabled: true, superSubscriptEnabled: true, highlightEnabled: true,
  inlineMathEnabled: true, mathAutoNumberEnabled: false, strictMode: false,
  codeBlockLineNumbers: true, autoPairing: true, showWordCount: true,
  defaultCopyFormat: "markdown", preloadOnStartup: false,
  associatedExtensions: ["md", "py"], keyBindings: {},
  defaultEncoding: "utf-8", defaultLineEnding: "crlf", displayMode: "window",
  lightTheme: "sepia", darkTheme: "default", customCssPath: "",
  fileModeOverrides: { js: "markdown" },
}));
await page.waitForTimeout(400);

const cats = await page.$$eval(".settings-nav-item", (e) => e.map((x) => x.textContent.trim()));

// ---- (a)(b) 外観カテゴリのテーマプリセット ----
const appearanceIdx = cats.findIndex((c) => c.includes("外観"));
ok(`「外観」カテゴリがある ${JSON.stringify(cats)}`, appearanceIdx >= 0);
if (appearanceIdx >= 0) {
  await page.click(`.settings-nav-item >> nth=${appearanceIdx}`);
  await page.waitForTimeout(300);
  const lightOptions = await page.$$eval('select[data-field="lightTheme"] option', (e) => e.map((o) => o.value));
  const darkOptions = await page.$$eval('select[data-field="darkTheme"] option', (e) => e.map((o) => o.value));
  ok(`ライトテーマの選択肢がthemes.cssと一致 ${JSON.stringify(lightOptions)}`,
    JSON.stringify(lightOptions.slice().sort()) === JSON.stringify(["default", "github", "sepia", "solarized-light"].sort()));
  // 実機フィードバックによりプリセットid "typora-night" を "night" へ改称した
  // (ラベルも「Typora Night」→「Night」、Pane/AppSettings.csで旧idからの移行あり)。
  ok(`ダークテーマの選択肢がthemes.cssと一致 ${JSON.stringify(darkOptions)}`,
    JSON.stringify(darkOptions.slice().sort()) === JSON.stringify(["default", "dracula", "nord", "solarized-dark", "night"].sort()));

  const lightVal = await page.$eval('select[data-field="lightTheme"]', (e) => e.value);
  ok(`settingsのlightTheme:"sepia"がselectの初期値に反映 (${lightVal})`, lightVal === "sepia");

  // (c) ダークテーマをnordに変更して保存 → save-settingsにdarkTheme:"nord"
  await page.selectOption('select[data-field="darkTheme"]', "nord");
  await page.waitForTimeout(100);
}

// ---- (d)(e)(f) 編集カテゴリの拡張子ごとの編集モード ----
const editIdx = cats.findIndex((c) => c === "編集" || c.includes("編集"));
ok(`「編集」カテゴリがある ${JSON.stringify(cats)}`, editIdx >= 0);
if (editIdx >= 0) {
  await page.click(`.settings-nav-item >> nth=${editIdx}`);
  await page.waitForTimeout(300);
  ok("拡張子ごとの編集モードのグループタイトルがある",
    (await page.$$eval(".settings-group-title", (e) => e.map((x) => x.textContent.trim()))).includes("拡張子ごとの編集モード"));

  let rows = await page.$$(".fm-row");
  ok(`fileModeOverrides:{"js":"markdown"}で1行表示 (${rows.length}行)`, rows.length === 1);
  const rowExt = await page.$eval(".fm-row .fm-ext", (e) => e.value);
  const rowMode = await page.$eval(".fm-row .fm-mode", (e) => e.value);
  ok(`初期行の拡張子とモードが反映 (ext="${rowExt}", mode="${rowMode}")`, rowExt === "js" && rowMode === "markdown");

  // (e) +追加で行が増え、.LOG(ドット付き大文字)→プレーンテキストで保存
  await page.click(".fm-add");
  await page.waitForTimeout(150);
  rows = await page.$$(".fm-row");
  ok(`「＋追加」で行が増える (${rows.length}行)`, rows.length === 2);
  const newExtInput = (await page.$$(".fm-row .fm-ext"))[1];
  const newModeSelect = (await page.$$(".fm-row .fm-mode"))[1];
  await newExtInput.fill(".LOG");
  await newModeSelect.selectOption("plain");
  await page.waitForTimeout(100);
}

// (f) 削除ボタンで行が消える
if (editIdx >= 0) {
  await page.click(`.settings-nav-item >> nth=${editIdx}`);
  await page.waitForTimeout(200);
  const beforeDel = await page.$$(".fm-row");
  await page.click(".fm-row:first-child .fm-remove");
  await page.waitForTimeout(150);
  const afterDel = await page.$$(".fm-row");
  ok(`削除ボタンで行が消える (${beforeDel.length}->${afterDel.length})`, afterDel.length === beforeDel.length - 1);
}

// ---- 保存 ----
await page.click('[data-act="save"]');
await page.waitForTimeout(300);
const saved = await page.evaluate(() => window.__sent.filter((m) => m.type === "save-settings").pop());
ok("save-settingsを送信", !!saved);
const savedSettings = saved?.settings ?? saved;
ok(`darkTheme:"nord"が保存内容に含まれる (${savedSettings?.darkTheme})`, savedSettings?.darkTheme === "nord");
ok(`lightTheme:"sepia"が保存内容に維持されている (${savedSettings?.lightTheme})`, savedSettings?.lightTheme === "sepia");
const savedOverrides = savedSettings?.fileModeOverrides;
ok(`fileModeOverridesに"log":"plain"がドット無し小文字で含まれる ${JSON.stringify(savedOverrides)}`,
  !!savedOverrides && savedOverrides.log === "plain");
ok(`削除した"js"は保存内容から消えている ${JSON.stringify(savedOverrides)}`,
  savedOverrides && !("js" in savedOverrides));
ok(`fileModeOverridesのキー数が1件(削除後) ${JSON.stringify(savedOverrides)}`,
  savedOverrides && Object.keys(savedOverrides).length === 1);

ok(`ページエラー・コンソールエラー0件: ${JSON.stringify(errors)}`, errors.length === 0);

console.log(`\n合計: OK ${okCount} / NG ${ngCount}`);
await browser.close();
process.exit(ngCount > 0 ? 1 : 0);
