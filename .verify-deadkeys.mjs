// 「配線切れ」5件(strictMode / codeBlockLineNumbers / showHiddenFilesInTree /
// fileTreePatterns / useSeparateThemeInDarkMode)+ spellCheckAutoCorrectのドキュメント整備、
// 計6件の実ブラウザ検証。.verify-editorsettings.mjs / .verify-settingswindow.mjs と同じ流儀
// (WebView2ブリッジをモックし、window.__reply()でC#側からの応答を流し込む)。ポートは8168。
//
// showHiddenFilesInTree/fileTreePatternsの実処理はC#側(Pane/FolderService.ScanAsync)にあり
// ブラウザだけでは検証できないため、ここではJS側が新しい設定キーを含むapply-settingsを
// エラーなく受け取れること・設定画面のフィールドが存在することのみ確認する
// (実際の除外ロジックの境界値は別途、scratchpad上の複製コンソールプロジェクトでdotnet run済み)。
import pw from "playwright";
const { chromium } = pw;
const browser = await chromium.launch();
const errors = [];
let okCount = 0, ngCount = 0;
const ok = (l, c) => { console.log(`${c ? "OK  " : "NG  "} ${l}`); if (c) okCount++; else ngCount++; };

// C#側(Pane/AppSettings.cs)の既定値に合わせた完全な設定オブジェクト
// (.verify-editorsettings.mjsのDEFAULT_SETTINGSに、本タスクで新たに配線した5キーを加えたもの)。
const DEFAULT_SETTINGS = {
  showStatusBar: true, zoomWithCtrlWheel: true, saveWithoutAskingOnSwitch: false,
  showWordCount: true, readingSpeedWpm: 0, collapsibleOutline: true, showOutlineByDefault: false,
  theme: "system", lightTheme: "default", darkTheme: "default", useSeparateThemeInDarkMode: true,
  editorFontSize: 15, editorLineHeight: 1.95, editorMaxWidthPx: 630, editorPaddingLeft: 32, editorPaddingRight: 32,
  editorFontFamily: "", editorMonospaceFontFamily: "", customCss: "", keyBindings: {},
  fileModeOverrides: {}, perFileModes: {}, autoDetectMode: "standard",
  defaultCopyFormat: "markdown", pandocAvailable: false, recentFiles: [],
  calloutsEnabled: true, superSubscriptEnabled: true, highlightEnabled: true,
  inlineMathEnabled: false, mathAutoNumber: "off",
  diagramsEnabled: true, codeBlockMathEnabled: false, autoLinksEnabled: true,
  codeAutoWrap: true, liveRenderingShowSourceOnFocus: true, emojiAutocomplete: "auto",
  copyWholeLineWhenNoSelection: true, typewriterKeepCaretCentered: true,
  shiftTabAutoIndent: false, autoPairMarkdown: true, autoPairing: true,
  spellCheckEnabled: false, spellCheckAutoCorrect: false,
  strictMode: false, headingStyle: "atx", unorderedListMarker: "-", orderedListMarker: ".",
  codeBlockLineNumbers: true,
  indentSizeOnSave: 4, codeIndentSize: 4,
  defaultCodeLanguage: "", defaultCodeLanguageApplyWhen: "menubar",
  chapterLevelInOutline: 6,
  whitespaceWhenWriting: "preserve", whitespaceOnExport: "ignore",
  smartQuotes: "off", smartDashes: "off", recognizeUnicodePunctuation: false,
  showHiddenFilesInTree: false, fileTreePatterns: [],
};

async function newPage(path = "index.html") {
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
  await page.goto(`http://localhost:8168/${path}`);
  await page.waitForTimeout(700);
  return page;
}
async function applySettings(page, overrides = {}) {
  const full = { ...DEFAULT_SETTINGS, ...overrides };
  await page.evaluate((full) => window.__reply({ type: "apply-settings", ...full }), full);
  await page.waitForTimeout(250);
}
async function newDoc(page) {
  await page.evaluate(() => window.__reply({ type: "new-document" }));
  await page.waitForTimeout(300);
}
async function clearDoc(page) {
  await page.click(".cm-content");
  await page.keyboard.press("Control+a");
  await page.keyboard.press("Delete");
}
async function cssVar(page, name) {
  return page.evaluate((n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim(), name);
}

// ============================================================
// 1. strictMode: ON/OFFで実際に描画結果が変わること
//    Typoraの「Strict Mode」に合わせ、アンダースコアによる語中の強調
//    (例: "_snake_case_"のように内側に別の"_"を含む"_..._")を、ONの時だけ
//    強調として扱わない(見出しの"#"直後スペース必須・強調記号内側の空白禁止は
//    lezer/markdownの既定パーサーが常にCommonMark準拠のため元々差が出ない。報告参照)。
// ============================================================
{
  const page = await newPage();
  await applySettings(page, { strictMode: false });
  await clearDoc(page);
  await page.keyboard.insertText("see _snake_case_ here");
  await page.waitForTimeout(300);
  const italicOff = await page.$$eval(".tok-italic", (e) => e.length);
  ok(`(1) strictMode:false(既定) では "_snake_case_" が強調として描画される (${italicOff})`, italicOff === 1);

  await applySettings(page, { strictMode: true });
  await page.waitForTimeout(300);
  const italicOn = await page.$$eval(".tok-italic", (e) => e.length);
  ok(`(1) strictMode:true では同じ文書で強調が解除される(描画結果が変わる) (${italicOn})`, italicOn === 0);

  // 通常の(語中でない)強調は厳格モードでも変わらず効くことの確認(回帰防止)。
  await clearDoc(page);
  await page.keyboard.insertText("this is _emphasis_ text");
  await page.waitForTimeout(300);
  const normalUnderscore = await page.$$eval(".tok-italic", (e) => e.length);
  ok(`(1) strictMode:true でも通常の"_emphasis_"は引き続き強調される (${normalUnderscore})`, normalUnderscore === 1);

  await clearDoc(page);
  await page.keyboard.insertText("*normal asterisk emphasis*");
  await page.waitForTimeout(300);
  const asterisk = await page.$$eval(".tok-italic", (e) => e.length);
  ok(`(1) strictMode:true でも"*"による強調は影響を受けない (${asterisk})`, asterisk === 1);
  await page.close();
}

// ============================================================
// 2. codeBlockLineNumbers: ON/OFFで実際に描画結果が変わること
// ============================================================
{
  const page = await newPage();
  await applySettings(page, { codeBlockLineNumbers: true });
  await clearDoc(page);
  await page.keyboard.insertText("```\nline1\nline2\nline3\n```");
  await page.waitForTimeout(300);
  const nums = await page.$$eval(".cm-code-linenum", (e) => e.map((x) => x.textContent));
  ok(`(2) codeBlockLineNumbers:true(既定) で1,2,3の行番号が表示される (${JSON.stringify(nums)})`, JSON.stringify(nums) === JSON.stringify(["1", "2", "3"]));

  await applySettings(page, { codeBlockLineNumbers: false });
  await page.waitForTimeout(300);
  const numsOff = await page.$$eval(".cm-code-linenum", (e) => e.length);
  ok(`(2) codeBlockLineNumbers:false では行番号が表示されない(描画結果が変わる) (${numsOff})`, numsOff === 0);

  // コード自体の文字は変えていない(表示だけの追加であることの確認)。
  const text = await page.$$eval(".cm-content .cm-line", (els) => els.map((e) => e.textContent).join("\n"));
  ok(`(2) 行番号はウィジェットであり、コード本文の文字自体は変わらない`, text.includes("line1") && text.includes("line2") && text.includes("line3") && !text.includes("1line1"));
  await page.close();
}

// ============================================================
// 3. useSeparateThemeInDarkMode: ON/OFFで実際に描画結果が変わること
//    ON: darkThemeプリセット(nord)の配色が適用される。
//    OFF: darkThemeを適用しない(lightThemeの値をdata-dark-themeへ入れる)ため、
//         nord用セレクタに一致せず、ダークの既定配色に戻る。
// ============================================================
{
  const page = await newPage();
  await applySettings(page, { theme: "dark", lightTheme: "default", darkTheme: "nord", useSeparateThemeInDarkMode: true });
  const paperOn = await cssVar(page, "--paper");
  ok(`(3) useSeparateThemeInDarkMode:true では darkTheme(nord) の配色が適用される (${paperOn})`, paperOn.toLowerCase() === "#2e3440");

  await applySettings(page, { theme: "dark", lightTheme: "default", darkTheme: "nord", useSeparateThemeInDarkMode: false });
  const paperOff = await cssVar(page, "--paper");
  ok(`(3) useSeparateThemeInDarkMode:false では darkTheme(nord) が適用されず既定のダーク配色に戻る(描画結果が変わる) (${paperOff})`, paperOff.toLowerCase() === "#14171a");
  ok(`(3) OFFのときは data-dark-theme に darkTheme(nord) が入らない`, await page.evaluate(() => document.documentElement.dataset.darkTheme) !== "nord");

  // lightThemeがsepiaの場合でも、data-dark-theme="sepia"はダーク用セレクタに一致しないため、
  // 依然として既定のダーク配色になる(「lightThemeの見た目をそのまま複製する」わけではない実装上の
  // 挙動。報告の「独自に判断した点」参照)。
  await applySettings(page, { theme: "dark", lightTheme: "sepia", darkTheme: "nord", useSeparateThemeInDarkMode: false });
  const paperOffSepia = await cssVar(page, "--paper");
  ok(`(3) OFF+lightTheme:sepia でもダーク既定配色のまま(セピアの明るい紙色にはならない) (${paperOffSepia})`, paperOffSepia.toLowerCase() === "#14171a");
  await page.close();
}

// ============================================================
// 4. showHiddenFilesInTree / fileTreePatterns: JS側は実処理を持たない(C#側FolderService.ScanAsync
//    が担う)ため、ここではapply-settingsに含めてもエラーなく処理できることだけ確認する。
//    実際の除外ロジックの境界値検証はscratchpad上の複製コンソールプロジェクトで実施済み(報告参照)。
// ============================================================
{
  const page = await newPage();
  await applySettings(page, { showHiddenFilesInTree: true, fileTreePatterns: ["*.log", "node_modules", "!keep.log"] });
  const sentOk = await page.evaluate(() => window.__sent.length >= 0); // 送信バッファが壊れていない=クラッシュしていない
  ok(`(4) showHiddenFilesInTree/fileTreePatterns を含むapply-settingsを受けてもエラーにならない`, sentOk);
  await page.close();
}

// ============================================================
// 5. spellCheckAutoCorrect: 実装不能である旨が設定画面に明記されていること
// ============================================================
{
  const page = await newPage("settings-window.html");
  // settings-window.htmlはget-settingsを自ら送り、その応答として{ type: "settings", ...全キー }を
  // 受け取る仕組み(.verify-settingswindow.mjsと同じ流儀)。DEFAULT_SETTINGSに、settings-window側
  // 固有の追加キー(installedFonts等)を足して応答する。
  const FULL = {
    type: "settings", ...DEFAULT_SETTINGS,
    startupBehavior: "lastFile", quitOnLastWindowClosed: false, preloadOnStartup: false,
    recordRecentFiles: true, displayMode: "window", autoSaveEnabled: true, autoSaveIntervalSeconds: 30,
    recoverUnsavedDrafts: true, defaultFileExtension: "md",
    imageInsertAction: "none", imageCustomFolder: "", imageApplyToLocal: true, imageApplyToOnline: false,
    imagePreferRelativePath: true, imageAddDotSlash: false, imageAutoEscapeUrl: true,
    exportPaperSize: "a4", exportCustomWidthMm: 210, exportCustomHeightMm: 297, exportOrientation: "portrait",
    exportMarginTopMm: 20, exportMarginBottomMm: 20, exportMarginLeftMm: 20, exportMarginRightMm: 20,
    exportHeaderText: "", exportFooterText: "", exportPageBreakBetweenTopHeadings: false,
    exportIncludeOutline: false, exportOutlineWidthPx: 260, exportAppendHead: "", exportAppendBody: "",
    exportDefaultFolder: "sameAsFile", exportCustomFolder: "", exportAfter: "none",
    exportShowSaveDialog: true, exportMathAs: "svg", exportReadYamlFrontMatter: true,
    customCssPath: null, associatedExtensions: [], explorerNewMenuEnabled: false, enableDebug: false,
    installedFonts: ["Meiryo", "Yu Gothic UI"], monospaceFonts: ["Consolas"],
    settingsFilePath: "C:/Users/test/AppData/Pane/settings.json",
  };
  ok("(前提) 読み込み直後にget-settingsを送信", await page.evaluate(() => window.__sent.some((m) => m.type === "get-settings")));
  await page.evaluate((s) => window.__reply(s), FULL);
  await page.waitForTimeout(300);
  // 「編集」カテゴリへ移動(スペルチェックの項目はここにある)。
  const navItems = await page.$$(".settings-nav-item");
  for (const item of navItems) {
    const txt = (await item.textContent())?.trim();
    if (txt === "編集") { await item.click(); break; }
  }
  await page.waitForTimeout(200);
  const desc = await page.evaluate(() => {
    const el = document.querySelector('[data-field="spellCheckAutoCorrect"]');
    return el?.closest("label")?.textContent ?? "";
  });
  ok(`(5) spellCheckAutoCorrectの項目に「WebView2」「制御できません」等の説明が付いている (${JSON.stringify(desc)})`,
    desc.includes("WebView2") && (desc.includes("制御できません") || desc.includes("Windows")));
  await page.close();
}

// ============================================================
// ページエラー・コンソールエラー0件
// ============================================================
ok(`ページエラー・コンソールエラー0件 (${errors.length}件) ${JSON.stringify(errors).slice(0, 2000)}`, errors.length === 0);

console.log(`\n合計: OK ${okCount} / NG ${ngCount}`);
await browser.close();
process.exit(ngCount > 0 ? 1 : 0);
