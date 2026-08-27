// 設定画面を独立ウィンドウ化したことの実ブラウザ検証。
// .verify-settings4.mjs と同じ流儀(WebView2ブリッジをモックし、window.__reply()で
// C#側からの応答を流し込む)。ポートは8153(タスク指定)。
//
// (a)〜(f)(h) は settings-window.html を直接開いて確認する(SettingsWindowが読み込むHTML)。
// (g) は index.html を開いて Ctrl+, の送信先が変わったことを確認する。
import pw from "playwright";
const { chromium } = pw;
const browser = await chromium.launch();
const errors = [];
let okCount = 0, ngCount = 0;
const ok = (l, c) => { console.log(`${c ? "OK  " : "NG  "} ${l}`); if (c) okCount++; else ngCount++; };

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

// ---- 資料(docs/設定項目一覧.md)由来の全キー・全設定値。.verify-settings4.mjsと同じもの。
// displayModeは意図的にUIへ出さない隠し設定(タブ形式、第2.10節 C-14。docs/設定項目一覧.mdの
// 注記を参照)のため、ALL_KEYSには含めない(下のFULL_SETTINGSにはキー自体は残す)。 ----
const EXPECTED_CATEGORIES = ["一般", "ファイル", "編集", "Markdown", "画像", "エクスポート・印刷", "外観", "ファイルの関連付け", "キーボード", "詳細", "バージョン情報"];
const ALL_KEYS = [
  "startupBehavior", "startupFolderPath", "quitOnLastWindowClosed", "preloadOnStartup", "showStatusBar",
  "showOutlineByDefault", "collapsibleOutline", "recordRecentFiles", "zoomWithCtrlWheel",
  "autoSaveEnabled", "autoSaveIntervalSeconds", "recoverUnsavedDrafts", "saveWithoutAskingOnSwitch",
  "defaultEncoding", "defaultLineEnding", "defaultFileExtension",
  "indentSizeOnSave", "codeIndentSize", "codeAutoWrap", "shiftTabAutoIndent", "autoPairing", "autoPairMarkdown",
  "emojiAutocomplete", "liveRenderingShowSourceOnFocus", "defaultCopyFormat", "copyWholeLineWhenNoSelection",
  "typewriterKeepCaretCentered", "spellCheckEnabled", "spellCheckAutoCorrect", "readingSpeedWpm",
  "autoDetectMode", "fileModeOverrides",
  "inlineMathEnabled", "codeBlockMathEnabled", "superSubscriptEnabled", "highlightEnabled", "diagramsEnabled",
  "autoLinksEnabled", "calloutsEnabled", "strictMode", "headingStyle", "unorderedListMarker", "orderedListMarker",
  "codeBlockLineNumbers", "mathAutoNumber", "chapterLevelInOutline", "defaultCodeLanguage",
  "defaultCodeLanguageApplyWhen", "whitespaceWhenWriting", "whitespaceOnExport", "smartQuotes", "smartDashes",
  "recognizeUnicodePunctuation",
  "imageInsertAction", "imageCustomFolder", "imageApplyToLocal", "imageApplyToOnline", "imagePreferRelativePath",
  "imageAddDotSlash", "imageAutoEscapeUrl",
  "exportPaperSize", "exportCustomWidthMm", "exportCustomHeightMm", "exportOrientation", "exportMarginTopMm",
  "exportMarginBottomMm", "exportMarginLeftMm", "exportMarginRightMm", "exportHeaderText", "exportFooterText",
  "exportPageBreakBetweenTopHeadings", "exportIncludeOutline", "exportOutlineWidthPx", "exportAppendHead",
  "exportAppendBody", "exportDefaultFolder", "exportCustomFolder", "exportAfter", "exportShowSaveDialog",
  "exportMathAs", "exportReadYamlFrontMatter",
  "theme", "lightTheme", "darkTheme", "useSeparateThemeInDarkMode", "customCssPath", "editorFontFamily",
  "editorMonospaceFontFamily", "editorFontSize", "editorLineHeight", "editorMaxWidthPx", "showWordCount",
  "associatedExtensions", "explorerNewMenuEnabled",
  "keyBindings",
  "enableDebug", "showHiddenFilesInTree", "fileTreePatterns",
];
const FULL_SETTINGS = {
  type: "settings",
  startupBehavior: "customFolder", startupFolderPath: "D:/Notes", quitOnLastWindowClosed: false,
  preloadOnStartup: true, showStatusBar: false, showOutlineByDefault: true, collapsibleOutline: false,
  recordRecentFiles: false, zoomWithCtrlWheel: false, displayMode: "window",
  autoSaveEnabled: false, autoSaveIntervalSeconds: 90, recoverUnsavedDrafts: false, saveWithoutAskingOnSwitch: true,
  defaultEncoding: "utf8bom", defaultLineEnding: "lf", defaultFileExtension: "txt",
  indentSizeOnSave: 2, codeIndentSize: 8, codeAutoWrap: false, shiftTabAutoIndent: true, autoPairing: false,
  autoPairMarkdown: false, emojiAutocomplete: "esc", liveRenderingShowSourceOnFocus: false,
  defaultCopyFormat: "html", copyWholeLineWhenNoSelection: false, typewriterKeepCaretCentered: false,
  spellCheckEnabled: true, spellCheckAutoCorrect: true, readingSpeedWpm: 500, autoDetectMode: "aggressive",
  inlineMathEnabled: true, codeBlockMathEnabled: true, superSubscriptEnabled: false, highlightEnabled: false,
  diagramsEnabled: false, autoLinksEnabled: false, calloutsEnabled: false, strictMode: true,
  headingStyle: "setext", unorderedListMarker: "*", orderedListMarker: ")", codeBlockLineNumbers: false,
  mathAutoNumber: "all", chapterLevelInOutline: 3, defaultCodeLanguage: "python",
  defaultCodeLanguageApplyWhen: "both", whitespaceWhenWriting: "ignore", whitespaceOnExport: "preserve",
  smartQuotes: "render", smartDashes: "emdash", recognizeUnicodePunctuation: true,
  imageInsertAction: "assets", imageCustomFolder: "./img", imageApplyToLocal: false, imageApplyToOnline: true,
  imagePreferRelativePath: false, imageAddDotSlash: true, imageAutoEscapeUrl: false,
  exportPaperSize: "letter", exportCustomWidthMm: 300, exportCustomHeightMm: 400, exportOrientation: "landscape",
  exportMarginTopMm: 15, exportMarginBottomMm: 25, exportMarginLeftMm: 12, exportMarginRightMm: 18,
  exportHeaderText: "{title} - {page}/{pages}", exportFooterText: "{date} {time}",
  exportPageBreakBetweenTopHeadings: true, exportIncludeOutline: true, exportOutlineWidthPx: 320,
  exportAppendHead: "<style>.x{color:red}</style>", exportAppendBody: "<script>console.log(1)</script>",
  exportDefaultFolder: "custom", exportCustomFolder: "D:/Export", exportAfter: "openFolder",
  exportShowSaveDialog: false, exportMathAs: "latex", exportReadYamlFrontMatter: false,
  theme: "dark", lightTheme: "github", darkTheme: "nord", useSeparateThemeInDarkMode: false,
  customCssPath: "D:/custom.css", editorFontFamily: "Meiryo", editorMonospaceFontFamily: "Consolas",
  editorFontSize: 22, editorLineHeight: 2.1, editorMaxWidthPx: 900, showWordCount: false,
  associatedExtensions: ["md", "txt"], explorerNewMenuEnabled: true,
  keyBindings: { "file.save": "Ctrl+Alt+S" },
  enableDebug: true, showHiddenFilesInTree: true, fileTreePatterns: ["node_modules", "!keep.md"],
  fileModeOverrides: { js: "code" }, perFileModes: { "C:/a.txt": "plain" },
  installedFonts: ["Meiryo", "Yu Gothic UI", "Consolas"], monospaceFonts: ["Consolas"],
  pandocAvailable: true, settingsFilePath: "C:/Users/test/AppData/Pane/settings.json",
};

// ============================================================
// settings-window.html を直接開いて (a)〜(f)(h) を検証する
// ============================================================
const page = await browser.newPage();
page.on("pageerror", (e) => errors.push(String(e.stack || e)));
page.on("console", (m) => { if (m.type() === "error") errors.push("console(settings-window): " + m.text()); });
await page.addInitScript(installMockBridge);
await page.goto("http://localhost:8153/settings-window.html");
await page.waitForTimeout(500);

// (a) ウィンドウ全体に広がって表示される(オーバーレイの黒背景や角丸が無い)
const overlayBg = await page.$eval(".settings-modal-overlay", (e) => getComputedStyle(e).backgroundColor);
const modalRadius = await page.$eval(".settings-modal", (e) => getComputedStyle(e).borderRadius);
const modalBoxShadow = await page.$eval(".settings-modal", (e) => getComputedStyle(e).boxShadow);
const modalFillsViewport = await page.evaluate(() => {
  const r = document.querySelector(".settings-modal").getBoundingClientRect();
  return Math.abs(r.width - window.innerWidth) < 2 && Math.abs(r.height - window.innerHeight) < 2;
});
ok(`(a) オーバーレイに黒背景が無い (background-color=${overlayBg})`, overlayBg === "rgba(0, 0, 0, 0)" || overlayBg === "transparent");
ok(`(a) モーダルに角丸が無い (border-radius=${modalRadius})`, modalRadius === "0px");
ok(`(a) モーダルに影が無い (box-shadow=${modalBoxShadow})`, modalBoxShadow === "none");
ok(`(a) ウィンドウ全体に広がって表示される`, modalFillsViewport);

// get-settingsが自動的に送られている(open()が読み込み直後に呼ばれるため)ことを確認してから応答する
ok("(前提) 読み込み直後にget-settingsを送信", await page.evaluate(() => window.__sent.some((m) => m.type === "get-settings")));
await page.evaluate((s) => window.__reply(s), FULL_SETTINGS);
await page.waitForTimeout(300);

// (b) 10カテゴリすべて・資料の全キーがUI上に存在する
const cats = await page.$$eval(".settings-nav-item", (e) => e.map((x) => x.textContent.trim()));
ok(`(b) カテゴリが11個、資料の並び順どおり ${JSON.stringify(cats)}`, JSON.stringify(cats) === JSON.stringify(EXPECTED_CATEGORIES));

const foundKeys = new Set();
for (let i = 0; i < cats.length; i++) {
  await page.click(`.settings-nav-item >> nth=${i}`);
  await page.waitForTimeout(120);
  const keysHere = await page.$$eval(
    "[data-field], input[type=radio][name]",
    (els) => els.map((e) => e.getAttribute("data-field") || e.getAttribute("name"))
  );
  for (const k of keysHere) foundKeys.add(k);
}
const missing = ALL_KEYS.filter((k) => !foundKeys.has(k));
ok(`(b) 資料の全設定キーがUI上に存在する(不足0件) 不足: ${JSON.stringify(missing)}`, missing.length === 0);

// (d) 拡張子ツリーが既定で折りたたまれており、分類をクリックすると開く
async function gotoCategory(label) {
  const idx = cats.findIndex((c) => c === label);
  await page.click(`.settings-nav-item >> nth=${idx}`);
  await page.waitForTimeout(150);
}
await gotoCategory("ファイルの関連付け");
const collapsedByDefault = await page.$$eval(".ft-lang-list, .ft-ext-list", (els) => els.every((e) => e.hasAttribute("hidden")));
ok("(d) 拡張子ツリーが既定で折りたたまれている", collapsedByDefault);
await page.click(".ft-category:first-child [data-toggle-cat]");
await page.waitForTimeout(150);
const firstCatExpanded = await page.$eval(".ft-category:first-child .ft-lang-list", (e) => !e.hasAttribute("hidden"));
ok("(d) 分類をクリックすると開く", firstCatExpanded);

// (e) 開いて何も触らず保存 → save-settingsの内容がsettingsで流した値と完全一致する
await page.click('[data-act="save"]');
await page.waitForTimeout(200);
const sentSave = await page.evaluate(() => window.__sent.filter((m) => m.type === "save-settings").pop());
ok("(e) save-settingsを送信", !!sentSave);
const { type: _t, installedFonts: _if, monospaceFonts: _mf, pandocAvailable: _pa, settingsFilePath: _sfp, ...expectedPayload } = FULL_SETTINGS;
const actualPayload = sentSave?.settings ?? {};
const diffKeys = Object.keys(expectedPayload).filter((k) => JSON.stringify(actualPayload[k]) !== JSON.stringify(expectedPayload[k]));
ok(`(e) 何も触らず保存した内容がsettingsで流した値と完全一致する(不一致: ${JSON.stringify(diffKeys)})`, diffKeys.length === 0);
// 保存成功で画面(=ウィンドウ)を閉じようとするため、close-settings-windowが送られる
await page.evaluate(() => window.__reply({ type: "save-settings-result", ok: true }));
await page.waitForTimeout(200);
const sentClose = await page.evaluate(() => window.__sent.some((m) => m.type === "close-settings-window"));
ok("(e-付随) 保存成功後、pageモードはclose-settings-windowを送ってウィンドウを閉じようとする", sentClose);

// ============================================================
// (c) 640x480の小さいビューポートでも、左のカテゴリ一覧と右の内容の両方が操作できる
// ============================================================
const smallPage = await browser.newPage();
smallPage.on("pageerror", (e) => errors.push(String(e.stack || e)));
smallPage.on("console", (m) => { if (m.type() === "error") errors.push("console(small): " + m.text()); });
await smallPage.setViewportSize({ width: 640, height: 480 });
await smallPage.addInitScript(installMockBridge);
await smallPage.goto("http://localhost:8153/settings-window.html");
await smallPage.waitForTimeout(400);
await smallPage.evaluate((s) => window.__reply(s), FULL_SETTINGS);
await smallPage.waitForTimeout(300);

const navBox = await smallPage.$eval(".settings-nav", (e) => e.getBoundingClientRect());
const contentBox = await smallPage.$eval(".settings-content", (e) => e.getBoundingClientRect());
ok(`(c) 640x480でカテゴリ一覧が操作可能な大きさで見える (w=${navBox.width}, h=${navBox.height})`, navBox.width > 50 && navBox.height > 50);
ok(`(c) 640x480で内容欄が操作可能な大きさで見える (w=${contentBox.width}, h=${contentBox.height})`, contentBox.width > 100 && contentBox.height > 50);
// 実際にカテゴリを切り替えて、切り替え後の内容がクリックできることまで確認する
const catsSmall = await smallPage.$$eval(".settings-nav-item", (e) => e.map((x) => x.textContent.trim()));
const fileIdx = catsSmall.indexOf("ファイル");
await smallPage.click(`.settings-nav-item >> nth=${fileIdx}`);
await smallPage.waitForTimeout(150);
const autoSaveCheckboxVisible = await smallPage.$eval('input[data-field="autoSaveEnabled"]', (e) => e.getBoundingClientRect().width > 0);
ok("(c) 640x480でカテゴリ切替後、右側の項目が操作できる", autoSaveCheckboxVisible);

// ============================================================
// (f) テーマ(theme: "dark", darkTheme: "nord")を流すと背景色が変わる
// ============================================================
const themePage = await browser.newPage();
themePage.on("pageerror", (e) => errors.push(String(e.stack || e)));
themePage.on("console", (m) => { if (m.type() === "error") errors.push("console(theme): " + m.text()); });
await themePage.emulateMedia({ colorScheme: "light" });
await themePage.addInitScript(installMockBridge);
await themePage.goto("http://localhost:8153/settings-window.html");
await themePage.waitForTimeout(400);
const bgBefore = await themePage.$eval("body", (e) => getComputedStyle(e).backgroundColor);
await themePage.evaluate((s) => window.__reply(s), { ...FULL_SETTINGS, theme: "dark", darkTheme: "nord" });
await themePage.waitForTimeout(300);
const bgAfter = await themePage.$eval("body", (e) => getComputedStyle(e).backgroundColor);
const themeAttr = await themePage.evaluate(() => ({
  theme: document.documentElement.dataset.theme,
  darkTheme: document.documentElement.dataset.darkTheme,
}));
ok(`(f) theme:"dark"がdata-themeへ反映される (${JSON.stringify(themeAttr)})`, themeAttr.theme === "dark" && themeAttr.darkTheme === "nord");
ok(`(f) 背景色が変わる (${bgBefore} -> ${bgAfter})`, bgBefore !== bgAfter);

// ============================================================
// (g) index.html側でCtrl+,を押すと{ type: "open-settings-window" }が送られる(モーダルは開かない)
// ============================================================
const indexPage = await browser.newPage();
indexPage.on("pageerror", (e) => errors.push(String(e.stack || e)));
indexPage.on("console", (m) => { if (m.type() === "error") errors.push("console(index): " + m.text()); });
await indexPage.addInitScript(installMockBridge);
await indexPage.goto("http://localhost:8153/index.html");
await indexPage.waitForTimeout(700);
await indexPage.click(".cm-content");
await indexPage.keyboard.press("Control+Comma");
await indexPage.waitForTimeout(300);
const sentOpenSettingsWindow = await indexPage.evaluate(() => window.__sent.some((m) => m.type === "open-settings-window"));
const modalOpened = (await indexPage.$(".settings-modal-overlay")) !== null;
ok("(g) Ctrl+,で{ type: \"open-settings-window\" }が送られる", sentOpenSettingsWindow);
ok("(g) モーダルは開かない", !modalOpened);

// ============================================================
// (h) ページエラー・コンソールエラーが0件
// ============================================================
console.log("--- エラー:", JSON.stringify(errors));
ok("(h) ページエラー・コンソールエラーが0件", errors.length === 0);

console.log(`\n合計: OK ${okCount} / NG ${ngCount}`);
await browser.close();
process.exit(ngCount > 0 ? 1 : 0);
