// Phase: メニューバーの設定・ヘルプアイコン / editorPaddingLeft・editorPaddingRight /
// カスタムCSSフォルダ / バージョン情報カテゴリ / 設定項目の並び替え、の検証。ポートは8155。
// 構成:
//   セッションA: index.html(ブリッジ無し) — メニューバーのアイコン並び・
//                ヘルプアイコンからの取扱説明書ウィンドウ起動(ブリッジ無しは別タブ)。
//   セッションB: index.html(ブリッジあり、モック) — 設定/ヘルプアイコンが送るメッセージ。
//   セッションC: settings-window.html(ブリッジあり、モック) — 全キーの存在確認・
//                カテゴリ11個・バージョン情報の表示内容・各ボタンの送信メッセージ・
//                editorPaddingLeft/Rightの保存。
import pw from "playwright";
const { chromium } = pw;
const browser = await chromium.launch();

let okCount = 0, ngCount = 0;
const ok = (label, cond) => { console.log(`${cond ? "OK  " : "NG  "} ${label}`); if (cond) okCount++; else ngCount++; };

const allErrors = [];
const allConsoleErrors = [];

function attachErrorCollectors(page) {
  page.on("pageerror", (e) => allErrors.push(String(e.stack || e)));
  page.on("console", (m) => { if (m.type() === "error") allConsoleErrors.push(m.text()); });
}

// docs/設定項目一覧.md の全キー(FIELD_DEFSに載る97個。editorPaddingXがeditorPaddingLeft/Rightに
// 分割されたため96→97) + 複合項目4個(keyBindings /
// associatedExtensions / fileModeOverrides / fileTreePatterns)。perFileModesは資料の指示どおり
// 意図的にUIへ出さないため対象外。displayModeも同様に、タブ形式(第2.10節 C-14)を
// ウィンドウ形式から変更できないようにするための隠し設定として、意図的にUIへ出さないため
// 対象外(docs/設定項目一覧.mdの隠し設定の注記を参照)。
const SCALAR_KEYS = [
  "startupBehavior", "startupFolderPath", "quitOnLastWindowClosed", "preloadOnStartup",
  "showStatusBar", "showOutlineByDefault", "collapsibleOutline", "recordRecentFiles",
  "zoomWithCtrlWheel",
  "autoSaveEnabled", "autoSaveIntervalSeconds", "recoverUnsavedDrafts", "saveWithoutAskingOnSwitch",
  "defaultEncoding", "defaultLineEnding", "defaultFileExtension",
  "indentSizeOnSave", "codeIndentSize", "codeAutoWrap", "shiftTabAutoIndent", "autoPairing",
  "autoPairMarkdown", "emojiAutocomplete", "liveRenderingShowSourceOnFocus", "defaultCopyFormat",
  "copyWholeLineWhenNoSelection", "typewriterKeepCaretCentered", "spellCheckEnabled",
  "spellCheckAutoCorrect", "readingSpeedWpm", "autoDetectMode",
  "inlineMathEnabled", "codeBlockMathEnabled", "superSubscriptEnabled", "highlightEnabled",
  "diagramsEnabled", "autoLinksEnabled", "calloutsEnabled",
  "strictMode", "headingStyle", "unorderedListMarker", "orderedListMarker", "codeBlockLineNumbers",
  "mathAutoNumber", "chapterLevelInOutline", "defaultCodeLanguage", "defaultCodeLanguageApplyWhen",
  "whitespaceWhenWriting", "whitespaceOnExport",
  "smartQuotes", "smartDashes", "recognizeUnicodePunctuation",
  "imageInsertAction", "imageCustomFolder", "imageApplyToLocal", "imageApplyToOnline",
  "imagePreferRelativePath", "imageAddDotSlash", "imageAutoEscapeUrl",
  "exportPaperSize", "exportCustomWidthMm", "exportCustomHeightMm", "exportOrientation",
  "exportMarginTopMm", "exportMarginBottomMm", "exportMarginLeftMm", "exportMarginRightMm",
  "exportHeaderText", "exportFooterText", "exportPageBreakBetweenTopHeadings", "exportIncludeOutline",
  "exportOutlineWidthPx", "exportAppendHead", "exportAppendBody", "exportDefaultFolder",
  "exportCustomFolder", "exportAfter", "exportShowSaveDialog", "exportMathAs",
  "exportReadYamlFrontMatter",
  "theme", "lightTheme", "darkTheme", "useSeparateThemeInDarkMode", "customCssPath",
  "editorFontFamily", "editorMonospaceFontFamily", "editorFontSize", "editorLineHeight",
  "editorMaxWidthPx", "editorPaddingLeft", "editorPaddingRight", "showWordCount",
  "explorerNewMenuEnabled",
  "enableDebug", "showHiddenFilesInTree", "addToPath",
];
const COMPOUND_KEYS = ["keyBindings", "associatedExtensions", "fileModeOverrides", "fileTreePatterns"];
const ALL_KEYS = [...SCALAR_KEYS, ...COMPOUND_KEYS];

const SETTINGS_REPLY = {
  type: "settings",
  theme: "light", editorFontSize: 15, editorFontFamily: "", editorMonospaceFontFamily: "",
  editorLineHeight: 1.95, editorMaxWidthPx: 630, editorPaddingLeft: 32, editorPaddingRight: 32,
  startupBehavior: "blank", startupFolderPath: "",
  calloutsEnabled: true, superSubscriptEnabled: true, highlightEnabled: true,
  inlineMathEnabled: true, codeBlockMathEnabled: false, diagramsEnabled: true, autoLinksEnabled: true,
  strictMode: false, headingStyle: "atx", unorderedListMarker: "-", orderedListMarker: ".",
  codeBlockLineNumbers: true, mathAutoNumber: "off", chapterLevelInOutline: 6,
  defaultCodeLanguage: "", defaultCodeLanguageApplyWhen: "menubar",
  whitespaceWhenWriting: "preserve", whitespaceOnExport: "ignore",
  smartQuotes: "off", smartDashes: "off", recognizeUnicodePunctuation: false,
  autoPairing: true, autoPairMarkdown: true, emojiAutocomplete: "auto",
  liveRenderingShowSourceOnFocus: true, defaultCopyFormat: "markdown",
  copyWholeLineWhenNoSelection: true, typewriterKeepCaretCentered: true,
  spellCheckEnabled: false, spellCheckAutoCorrect: false, readingSpeedWpm: 0, autoDetectMode: "standard",
  indentSizeOnSave: 4, codeIndentSize: 4, codeAutoWrap: true, shiftTabAutoIndent: false,
  showWordCount: true, preloadOnStartup: false, quitOnLastWindowClosed: true,
  showStatusBar: true, showOutlineByDefault: false, collapsibleOutline: true,
  recordRecentFiles: true, zoomWithCtrlWheel: true, displayMode: "window",
  autoSaveEnabled: true, autoSaveIntervalSeconds: 30, recoverUnsavedDrafts: true,
  saveWithoutAskingOnSwitch: false, defaultEncoding: "utf8", defaultLineEnding: "crlf",
  defaultFileExtension: "md",
  imageInsertAction: "none", imageCustomFolder: "", imageApplyToLocal: true, imageApplyToOnline: false,
  imagePreferRelativePath: true, imageAddDotSlash: false, imageAutoEscapeUrl: true,
  exportPaperSize: "a4", exportCustomWidthMm: 210, exportCustomHeightMm: 297,
  exportOrientation: "portrait", exportMarginTopMm: 20, exportMarginBottomMm: 20,
  exportMarginLeftMm: 20, exportMarginRightMm: 20, exportHeaderText: "", exportFooterText: "",
  exportPageBreakBetweenTopHeadings: false, exportIncludeOutline: false, exportOutlineWidthPx: 260,
  exportAppendHead: "", exportAppendBody: "", exportDefaultFolder: "sameAsFile", exportCustomFolder: "",
  exportAfter: "none", exportShowSaveDialog: true, exportMathAs: "svg", exportReadYamlFrontMatter: true,
  associatedExtensions: ["md", "py"], keyBindings: {}, fileModeOverrides: { txt: "plain" },
  fileTreePatterns: ["node_modules"], perFileModes: {},
  lightTheme: "default", darkTheme: "default", useSeparateThemeInDarkMode: true, customCssPath: "",
  explorerNewMenuEnabled: false, enableDebug: false, showHiddenFilesInTree: false,
  installedFonts: [], monospaceFonts: [], pandocAvailable: false,
  settingsFilePath: "C:\\Users\\test\\AppData\\Local\\Pane\\settings.json",
  // ---- 今回追加した「バージョン情報」用の環境情報 ----
  appVersion: "0.1.0.0",
  webView2Version: "120.0.2210.144",
  dotNetVersion: "8.0.10",
  logFolderPath: "C:\\Users\\test\\AppData\\Local\\Pane\\logs",
  themeFolderPath: "C:\\Users\\test\\AppData\\Local\\Pane\\themes",
  licenses: [
    { name: "Pane 本体", license: "プロプライエタリ(未公開)" },
    { name: "CodeMirror 6 (@codemirror/*)", license: "MIT License" },
    { name: "Lezer (@lezer/*)", license: "MIT License" },
    { name: "MathJax (mathjax-full)", license: "Apache License 2.0" },
    { name: "Mermaid", license: "MIT License" },
  ],
};

// ============================================================
// セッションA: index.html(ブリッジ無し) — メニューバーのアイコン並び、
// ヘルプアイコンからの取扱説明書ウィンドウ起動(ブリッジ無しは別タブ)。
// ============================================================
{
  const page = await browser.newPage();
  attachErrorCollectors(page);
  await page.goto("http://localhost:8155/index.html");
  await page.waitForTimeout(800);

  // (a) メニューバー右端に3つのボタンがあり、左から テーマ切替・設定・ヘルプ の順。
  const rightIds = await page.$$eval("#menubar > *", (els) =>
    els.filter((e) => e.tagName === "BUTTON" && (e.id === "btn-theme" || e.id === "btn-menu-settings" || e.id === "btn-menu-help")).map((e) => e.id));
  ok(`(a) メニューバー右端3ボタンの並び ${JSON.stringify(rightIds)}`,
    JSON.stringify(rightIds) === JSON.stringify(["btn-theme", "btn-menu-settings", "btn-menu-help"]));
  const titles = await page.$$eval("#btn-menu-settings, #btn-menu-help", (els) => els.map((e) => ({ title: e.title, aria: e.getAttribute("aria-label") })));
  ok(`(a) title/aria-labelが設定されている ${JSON.stringify(titles)}`, titles.every((t) => t.title && t.aria));

  // 設定アイコンを押すと設定モーダルが開く(ブリッジ無しのフォールバック経路)。
  await page.click("#btn-menu-settings");
  await page.waitForTimeout(400);
  ok("(b)フォールバック: 設定アイコンでモーダルが開く", (await page.$(".settings-modal")) !== null);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);

  // (c) ヘルプアイコンを押すと取扱説明書が開く。
  // 文言更新(F1ヘルプの実装に伴う): 以前はヘルプ本体が無く、暫定で設定画面の
  // 「バージョン情報」カテゴリを開いていた。取扱説明書ウィンドウ(Pane/HelpWindow.cs、
  // src/help-entry.js)を実装したため、そちらを開く動作へ変わった。ブリッジが無い
  // ブラウザ単体動作では専用ウィンドウを開かせようが無いので、help-window.htmlを
  // 別タブ(window.open)で開くのが正しい挙動(src/main.js openHelp参照)。
  await page.evaluate(() => {
    window.__opened = [];
    window.open = (url) => { window.__opened.push(url); return null; };
  });
  await page.click("#btn-menu-help");
  await page.waitForTimeout(400);
  ok("(c) ヘルプアイコンで設定モーダルは開かない(取扱説明書へ変わったため)", (await page.$(".settings-modal")) === null);
  const opened = await page.evaluate(() => window.__opened ?? []);
  ok(`(c) ヘルプアイコンでhelp-window.htmlを開く ${JSON.stringify(opened)}`,
    opened.some((u) => String(u).includes("help-window.html")));

  await page.close();
}

// ============================================================
// セッションB: index.html(ブリッジあり、モック) — 設定/ヘルプアイコンが送るメッセージ。
// ============================================================
{
  const page = await browser.newPage();
  attachErrorCollectors(page);
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
  await page.goto("http://localhost:8155/index.html");
  await page.waitForTimeout(800);

  await page.click("#btn-menu-settings");
  await page.waitForTimeout(300);
  const sentAfterSettings = await page.evaluate(() => window.__sent);
  ok("(b) ブリッジありで設定アイコンがopen-settings-windowを送る",
    sentAfterSettings.some((m) => m.type === "open-settings-window"));

  await page.click("#btn-menu-help");
  await page.waitForTimeout(300);
  const sentAfterHelp = await page.evaluate(() => window.__sent);
  // 文言更新(F1ヘルプの実装に伴う。上のセッションA(c)と同じ経緯): 以前はヘルプアイコンも
  // 設定画面(open-settings-window)を開いていたが、取扱説明書ウィンドウを開くようになった。
  const helpMsg = sentAfterHelp.filter((m) => m.type === "open-help-window").pop();
  ok(`(c) ブリッジありでヘルプアイコンがopen-help-windowを送る ${JSON.stringify(helpMsg)}`, !!helpMsg);
  ok("(c) ヘルプアイコンはもうopen-settings-windowを送らない",
    !sentAfterHelp.slice(sentAfterHelp.findIndex((m) => m.type === "open-settings-window") + 1)
      .some((m) => m.type === "open-settings-window"));

  await page.close();
}

// ============================================================
// セッションC: settings-window.html(ブリッジあり、モック) — 全キー・カテゴリ11個・
// バージョン情報の表示内容・各ボタンの送信メッセージ・editorPaddingLeft/Rightの保存。
// ============================================================
{
  const page = await browser.newPage();
  attachErrorCollectors(page);
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
  await page.goto("http://localhost:8155/settings-window.html");
  await page.waitForTimeout(800);

  ok("設定画面が開く", (await page.$(".settings-modal")) !== null);
  await page.evaluate((reply) => window.__reply(reply), SETTINGS_REPLY);
  await page.waitForTimeout(400);

  const cats = await page.$$eval(".settings-nav-item", (e) => e.map((x) => x.textContent.trim()));
  ok(`(d) カテゴリが11個 (実際=${cats.length}) ${JSON.stringify(cats)}`, cats.length === 11);
  ok(`(d) 最後が「バージョン情報」 "${cats[cats.length - 1]}"`, cats[cats.length - 1] === "バージョン情報");

  // (e) 全カテゴリを巡回し、[data-field]属性(単純項目・ツリー等の複合項目コンテナ共通)と
  // ラジオのname属性を集める。
  const foundKeys = new Set();
  for (let i = 0; i < cats.length; i++) {
    await page.click(`.settings-nav-item >> nth=${i}`);
    await page.waitForTimeout(150);
    const keysHere = await page.evaluate(() => {
      const out = new Set();
      document.querySelectorAll(".settings-content [data-field]").forEach((el) => out.add(el.dataset.field));
      document.querySelectorAll('.settings-content input[type="radio"][name]').forEach((el) => out.add(el.name));
      return [...out];
    });
    for (const k of keysHere) foundKeys.add(k);
  }
  const missing = ALL_KEYS.filter((k) => !foundKeys.has(k));
  ok(`(e) docs/設定項目一覧.mdの全キー+editorPaddingLeft/RightがUI上に存在する(欠けているキー: ${JSON.stringify(missing)})`, missing.length === 0);

  // ---- バージョン情報カテゴリの中身 ----
  const vIdx = cats.findIndex((c) => c === "バージョン情報");
  await page.click(`.settings-nav-item >> nth=${vIdx}`);
  await page.waitForTimeout(200);
  const vText = await page.evaluate(() => document.querySelector(".settings-content")?.textContent ?? "");
  ok("(f) アプリのバージョンが表示される", vText.includes("0.1.0.0"));
  ok("(f) WebView2ランタイムのバージョンが表示される", vText.includes("120.0.2210.144"));
  ok("(f) .NETのバージョンが表示される", vText.includes("8.0.10"));
  ok("(f) 設定ファイルの場所が表示される", vText.includes("settings.json"));
  ok("(f) ログファイルの場所が表示される", vText.includes("logs"));
  ok("(f) カスタムCSSフォルダの場所が表示される", vText.includes("themes"));
  ok("(f) ライセンス一覧(CodeMirror)が表示される", vText.includes("CodeMirror"));
  ok("(f) ライセンス一覧(MathJax)が表示される", vText.includes("MathJax"));
  ok("(f) ライセンス一覧(Mermaid)が表示される", vText.includes("Mermaid"));
  ok("(f) ライセンス一覧(Lezer)が表示される", vText.includes("Lezer"));
  ok("(f) Pane本体のライセンスが表示される", vText.includes("Pane"));

  // (g) 各ボタンが対応するメッセージを送る。
  const sentBeforeButtons = (await page.evaluate(() => window.__sent)).length;
  await page.click('[data-action="open-settings-file"]');
  await page.click('[data-action="open-log-folder"]');
  await page.click('[data-action="open-today-log"]');
  await page.click('[data-action="open-theme-folder"]');
  await page.waitForTimeout(200);
  const sentAfterButtons = (await page.evaluate(() => window.__sent)).slice(sentBeforeButtons);
  for (const t of ["open-settings-file", "open-log-folder", "open-today-log", "open-theme-folder"]) {
    ok(`(g) ${t} を送信`, sentAfterButtons.some((m) => m.type === t));
  }

  // 「外観」カテゴリの「サンプルのあるフォルダを開く」ボタンもopen-theme-folderを送る。
  const appearanceIdx = cats.findIndex((c) => c === "外観");
  await page.click(`.settings-nav-item >> nth=${appearanceIdx}`);
  await page.waitForTimeout(200);
  const sentBeforeAppearance = (await page.evaluate(() => window.__sent)).length;
  await page.click('[data-action="open-theme-folder"]');
  await page.waitForTimeout(200);
  const sentAfterAppearance = (await page.evaluate(() => window.__sent)).slice(sentBeforeAppearance);
  ok("(g) 外観カテゴリの「サンプルのあるフォルダを開く」もopen-theme-folderを送る",
    sentAfterAppearance.some((m) => m.type === "open-theme-folder"));

  // customCssPathの「参照…」もbrowse-pathを送る(初期フォルダの指定はC#側の挙動のため
  // ここでは送信自体のみ確認する)。
  const sentBeforeBrowse = (await page.evaluate(() => window.__sent)).length;
  await page.click('[data-browse-field="customCssPath"]');
  await page.waitForTimeout(200);
  const sentAfterBrowse = (await page.evaluate(() => window.__sent)).slice(sentBeforeBrowse);
  ok("(g) カスタムCSSの「参照…」がbrowse-pathを送る(field=customCssPath)",
    sentAfterBrowse.some((m) => m.type === "browse-path" && m.field === "customCssPath"));

  // editorPaddingLeft/Rightの数値入力欄が左右別々にある(外観カテゴリに留まっている、
  // 旧・editorPaddingXから分割されたことの確認)。
  const paddingLeftInput = await page.$('input[data-field="editorPaddingLeft"]');
  const paddingRightInput = await page.$('input[data-field="editorPaddingRight"]');
  ok("editorPaddingLeftの入力欄がある", paddingLeftInput !== null);
  ok("editorPaddingRightの入力欄がある", paddingRightInput !== null);
  const paddingLeftValueInitial = await page.evaluate(() => document.querySelector('input[data-field="editorPaddingLeft"]').value);
  const paddingRightValueInitial = await page.evaluate(() => document.querySelector('input[data-field="editorPaddingRight"]').value);
  ok(`editorPaddingLeftの初期値が32 (実際=${paddingLeftValueInitial})`, paddingLeftValueInitial === "32");
  ok(`editorPaddingRightの初期値が32 (実際=${paddingRightValueInitial})`, paddingRightValueInitial === "32");

  // (h) editorPaddingLeft/Rightを左右別々の値で保存するとsave-settingsに含まれる。
  await page.fill('input[data-field="editorPaddingLeft"]', "48");
  await page.dispatchEvent('input[data-field="editorPaddingLeft"]', "change");
  await page.fill('input[data-field="editorPaddingRight"]', "0");
  await page.dispatchEvent('input[data-field="editorPaddingRight"]', "change");
  await page.waitForTimeout(150);
  await page.click('[data-act="save"]');
  await page.waitForTimeout(300);
  const saved = await page.evaluate(() => window.__sent.filter((m) => m.type === "save-settings").pop());
  ok("(h) save-settingsを送信", !!saved);
  const savedPaddingLeft = saved?.settings?.editorPaddingLeft;
  const savedPaddingRight = saved?.settings?.editorPaddingRight;
  ok(`(h) editorPaddingLeftが保存ペイロードに含まれる (実際=${savedPaddingLeft})`, savedPaddingLeft === 48);
  ok(`(h) editorPaddingRight:0(左右非対称)も正しく保存ペイロードに含まれる (実際=${savedPaddingRight})`, savedPaddingRight === 0);

  await page.close();
}

// ============================================================
// セッションD: quitOnLastWindowClosedのUI反転(依頼: 「最後のウィンドウを閉じたら終了する」
// →「最後のウィンドウを閉じても常駐させる」。チェックの意味そのものを反転)。
// UI上のチェックON(=常駐させる)で保存される値は quitOnLastWindowClosed: false、
// チェックOFF(=常駐させない)で true になること(fieldCheckboxのinvert:true /
// wireCommonFieldsのdata-invert処理)を、実際に送られるsave-settingsメッセージの
// 中身で確認する。
// ============================================================
{
  const page = await browser.newPage();
  attachErrorCollectors(page);
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
  await page.goto("http://localhost:8155/settings-window.html");
  await page.waitForTimeout(800);
  // quitOnLastWindowClosed: true(既定=最後のウィンドウを閉じたら終了する=常駐させない)で返す。
  await page.evaluate((reply) => window.__reply(reply), SETTINGS_REPLY);
  await page.waitForTimeout(400);

  // 「一般」カテゴリが既定で開いているはずで、そこにチェックボックスがある。
  const cb = 'input[data-field="quitOnLastWindowClosed"]';
  ok("(D) quitOnLastWindowClosedのチェックボックスが「一般」カテゴリにある", (await page.$(cb)) !== null);
  ok("(D) data-invert属性が付いている(UI反転の仕組み)", await page.$eval(cb, (e) => e.hasAttribute("data-invert")));
  // preloadOnStartupは反転させていない(通常どおりチェックON=true)ことも確認する
  // (保存すると設定画面が閉じてしまうため、save前のここで確認する)。
  const preloadCb = 'input[data-field="preloadOnStartup"]';
  ok("(D) preloadOnStartupにはdata-invertが付いていない(独立した設定)", !(await page.$eval(preloadCb, (e) => e.hasAttribute("data-invert"))));

  // 初期状態: 設定値はtrue(常駐させない)なので、反転UIではチェックはOFFになっているはず。
  const initialChecked = await page.$eval(cb, (e) => e.checked);
  ok(`(D) 初期値quitOnLastWindowClosed=trueのとき、チェックはOFF(常駐させない) 実際=${initialChecked}`, initialChecked === false);

  // チェックを付ける(=常駐させる)→保存すると quitOnLastWindowClosed: false が送られる。
  // save()は応答(save-settings-result)が来るまで保存ボタンをdisabledにするため、
  // モックブリッジでも実機同様にokの応答を返してやる必要がある(でないと2回目のsaveが押せない)。
  await page.check(cb);
  await page.waitForTimeout(200);
  const sentBeforeSave1 = (await page.evaluate(() => window.__sent)).length;
  await page.click('[data-act="save"]');
  await page.waitForTimeout(300);
  await page.evaluate(() => window.__reply({ type: "save-settings-result", ok: true }));
  await page.waitForTimeout(300);
  const saved1 = (await page.evaluate(() => window.__sent)).slice(sentBeforeSave1).filter((m) => m.type === "save-settings").pop();
  ok(`(D) チェックON(常駐させる)で保存すると quitOnLastWindowClosed:false が送られる 実際=${JSON.stringify(saved1?.settings?.quitOnLastWindowClosed)}`,
    !!saved1 && saved1.settings.quitOnLastWindowClosed === false);

  await page.close();
}

// ============================================================
// セッションD': 保存成功で設定画面が閉じる(mode:"page"のdestroy())ため、逆方向
// (quitOnLastWindowClosed: false → 読み込み時チェックON → 外すとtrueで保存される)は
// 新しいページで独立に検証する。
// ============================================================
{
  const page = await browser.newPage();
  attachErrorCollectors(page);
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
  await page.goto("http://localhost:8155/settings-window.html");
  await page.waitForTimeout(800);
  // 今度はquitOnLastWindowClosed: false(=常駐させる設定が既に保存済み)で返す。
  await page.evaluate((reply) => window.__reply({ ...reply, quitOnLastWindowClosed: false }), SETTINGS_REPLY);
  await page.waitForTimeout(400);

  const cb = 'input[data-field="quitOnLastWindowClosed"]';
  const initialChecked2 = await page.$eval(cb, (e) => e.checked);
  ok(`(D') 保存値quitOnLastWindowClosed=falseのとき、チェックはON(常駐させる) 実際=${initialChecked2}`, initialChecked2 === true);

  // チェックを外す(=常駐させない)→保存すると quitOnLastWindowClosed: true が送られる。
  await page.uncheck(cb);
  await page.waitForTimeout(200);
  const sentBeforeSave = (await page.evaluate(() => window.__sent)).length;
  await page.click('[data-act="save"]');
  await page.waitForTimeout(300);
  await page.evaluate(() => window.__reply({ type: "save-settings-result", ok: true }));
  await page.waitForTimeout(300);
  const saved = (await page.evaluate(() => window.__sent)).slice(sentBeforeSave).filter((m) => m.type === "save-settings").pop();
  ok(`(D') チェックOFF(常駐させない)で保存すると quitOnLastWindowClosed:true が送られる 実際=${JSON.stringify(saved?.settings?.quitOnLastWindowClosed)}`,
    !!saved && saved.settings.quitOnLastWindowClosed === true);

  await page.close();
}

// ============================================================
// (i) ページエラー・コンソールエラーが0件
// ============================================================
ok(`(i) ページエラー0件 ${JSON.stringify(allErrors)}`, allErrors.length === 0);
ok(`(i) コンソールエラー0件 ${JSON.stringify(allConsoleErrors)}`, allConsoleErrors.length === 0);

console.log(`--- 集計: OK=${okCount} NG=${ngCount}`);
await browser.close();
process.exit(ngCount > 0 ? 1 : 0);
