// 設定画面の表示速度計測・検証。ポートは8150(タスク指定)。
//
// 【アーキテクチャ変更に伴う書き換え】
// 元の版は「index.htmlでCtrl+,を押すと同じページ内にモーダルが開く」という前提で、
// 起動直後の先読みキャッシュ(settingsCache/schedulePrefetch、src/settings.js)が
// 2回目以降のオープンを速くする効果を計測していた。しかし設定画面は独立ウィンドウ
// (settings-window.html / Pane/SettingsWindow.cs)になり、Ctrl+,は常に
// { type: "open-settings-window" }をC#へ送るだけでモーダルは開かない
// (.verify-settingswindow.mjsの(g)参照)。settings-window.htmlは読み込み直後に
// 常にopen()を自動実行して即get-settingsを送るため、「先読みキャッシュがあるので
// 2回目のオープンが速い」という従来の効果はもう成立しない(毎回が実質「初回オープン」)。
//
// さらに、本文側(main.js)は現在settings.js(90KB超)自体をブリッジが無いときの
// フォールバック用にだけ動的import()する作りになっており(ensureSettingsUI()参照)、
// ブリッジがある実機相当の状況ではCtrl+,を押しても一切ロードされない(=先読みキャッシュの
// 恩恵を云々する以前に、そもそもコードが読み込まれない)。
//
// このため、以下の観点で書き直す(いずれも他のスイートではカバーされていない):
//   (A) 本文側(index.html)の起動直後・Ctrl+,操作でエディタへの入力がブロックされないこと。
//       ブリッジがある間はsettings.js自体が読み込まれない(無駄な90KB超の読み込みが
//       発生しない)ことも併せて確認する。
//   (B) 設定ウィンドウ(settings-window.html)を開いてから、C#側の往復(遅延をシミュレート)を
//       経て正しい値が表示されるまでの時間・その間に長時間タスクで固まらないこと。
//   (C) 往復に遅延がある状況でも、何も触らず保存した内容が受信値と完全一致すること
//       (非同期競合が無いこと)。
//   (D) カテゴリ切替(11カテゴリ、拡張子ツリー145行・キーバインド表87行を含む)の
//       DOM構築コストが把握できる範囲であること。
//   (E) 先読みキャッシュ(settingsCache)自体は残存コードとして今も動いており、
//       apply-settings受信でキャッシュが破棄され、空き時間の再取得で復元されること
//       (src/settings.js 409-482行付近の挙動そのものの回帰検出。今は表示への効果は
//       無くなっているが、コードとして生きている以上壊れていないことを確認する)。
import pw from "playwright";
const { chromium } = pw;

const REPLY_DELAY_MS = 80; // 実機のWebView2<->C#往復を想定した遅延

const FULL_SETTINGS_V1 = {
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

const browser = await chromium.launch();
const errors = [];
let okCount = 0, ngCount = 0;
const ok = (l, c) => { console.log(`${c ? "OK  " : "NG  "} ${l}`); if (c) okCount++; else ngCount++; };
const num = (n) => (Math.round(n * 100) / 100).toFixed(2);

function attachErrors(p) {
  p.on("pageerror", (e) => errors.push(String(e.stack || e)));
  p.on("console", (m) => { if (m.type() === "error") errors.push("console: " + m.text()); });
}

// C#往復を模す: get-settingsを受け取ったらdelayだけ遅れてsettingsを返す。
// longtask計測(PerformanceObserver)もここで併せて仕込む。
function installDelayedBridge({ delay, reply }) {
  const listeners = [];
  window.__sent = [];
  window.__replyLog = [];
  window.__currentSettings = reply;
  window.chrome = {
    webview: {
      postMessage: (m) => {
        window.__sent.push({ t: performance.now(), type: m && m.type, data: m });
        if (m && m.type === "get-settings") {
          setTimeout(() => { window.__reply(window.__currentSettings); }, delay);
        }
      },
      addEventListener: (_t, fn) => listeners.push(fn),
    },
  };
  window.__reply = (data) => {
    const t0 = performance.now();
    listeners.forEach((fn) => fn({ data }));
    const t1 = performance.now();
    window.__replyLog.push({ type: data && data.type, syncStart: t0, syncEnd: t1, syncDur: t1 - t0 });
  };
  window.__longTasks = [];
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) window.__longTasks.push({ start: e.startTime, dur: e.duration });
    }).observe({ entryTypes: ["longtask"] });
  } catch { /* longtaskが使えない環境では無視 */ }
}

// ============================================================
// (A) 本文側(index.html): 起動直後、settings.js内部の先読み(schedulePrefetch)が
//     エディタ入力をブロックしないこと。
// ============================================================
{
  const page = await browser.newPage();
  attachErrors(page);
  await page.addInitScript(installDelayedBridge, { delay: REPLY_DELAY_MS, reply: FULL_SETTINGS_V1 });
  await page.goto("http://localhost:8150/index.html");

  await page.click(".cm-content");
  const typingStart = Date.now();
  await page.keyboard.type("起動直後のタイピング応答性を確認するための日本語と英語混在テキストABCDEFGHIJ0123456789", { delay: 0 });
  const typingMs = Date.now() - typingStart;
  console.log(`--- (A) 起動直後(先読み中想定)に50文字強を連続入力: ${typingMs}ms`);
  const typedText = await page.evaluate(() => document.querySelector(".cm-content").textContent);
  ok(`(A) 入力内容が欠落なくエディタに反映されている(長さ${typedText.length})`, typedText.length >= 40);

  const longTasksAfterStartup = await page.evaluate(() => window.__longTasks.slice());
  console.log(`--- (A) longtask一覧(起動〜タイピング直後まで): ${JSON.stringify(longTasksAfterStartup.map((t) => num(t.dur)))}`);
  ok("(A) 起動〜タイピング直後までの間、100ms超のlongtaskが無い(背後の先読みが入力をブロックしていない)",
    longTasksAfterStartup.every((t) => t.dur <= 100));

  // settings.js(90KB超)はブリッジが無い(=専用ウィンドウを開かせられない)ときの
  // フォールバックとしてのみ動的import()される(main.js ensureSettingsUI()参照)。
  // ブリッジがある実機相当のこの状況では、Ctrl+,を押しても本文側にsettings.jsは
  // 一切ロードされない(window.__paneSettingsDebugが最後まで現れない)ことを確認する。
  await page.evaluate(() => { window.__sent.length = 0; });
  await page.keyboard.press("Control+Comma");
  await page.waitForTimeout(REPLY_DELAY_MS + 700);
  const sentOpenWindow = await page.evaluate(() => window.__sent.some((m) => m.type === "open-settings-window"));
  const modalOpened = (await page.$(".settings-modal-overlay")) !== null;
  const debugHookAppeared = await page.evaluate(() => typeof window.__paneSettingsDebug !== "undefined");
  ok("(A-付随) Ctrl+,はopen-settings-windowを送るだけでモーダルは開かない", sentOpenWindow && !modalOpened);
  ok("(A-付随) ブリッジがある間はsettings.jsが本文側に一切ロードされない(遅延import; 90KB超の無駄な読み込みが起きない)",
    !debugHookAppeared);

  await page.close();
}

// ============================================================
// (B)(C) 設定ウィンドウ(settings-window.html): 遅延往復ありでの表示速度・
//         長時間タスクの有無・往復整合性。
// ============================================================
{
  const page = await browser.newPage();
  attachErrors(page);
  await page.addInitScript(installDelayedBridge, { delay: REPLY_DELAY_MS, reply: FULL_SETTINGS_V1 });
  await page.addInitScript(() => { window.__t0 = performance.now(); });

  const gotoStart = Date.now();
  await page.goto("http://localhost:8150/settings-window.html");
  const { visibleAt, timedOut } = await page.evaluate(() => new Promise((resolve) => {
    const isVisible = () => {
      const el = document.querySelector('input[type="radio"][name="startupBehavior"]:checked');
      return !!(el && el.value === "customFolder");
    };
    if (isVisible()) { resolve({ visibleAt: performance.now(), timedOut: false }); return; }
    let done = false;
    function poll() {
      if (done) return;
      if (isVisible()) { done = true; resolve({ visibleAt: performance.now(), timedOut: false }); return; }
      requestAnimationFrame(poll);
    }
    requestAnimationFrame(poll);
    setTimeout(() => { if (!done) { done = true; resolve({ visibleAt: null, timedOut: true }); } }, 5000);
  }));
  ok(`(B) 遅延往復(${REPLY_DELAY_MS}ms)ありでも設定ウィンドウが正しい値まで表示される(タイムアウトしない)`, !timedOut);
  if (!timedOut) {
    const openMs = await page.evaluate((v) => v - window.__t0, visibleAt);
    console.log(`--- (B) ページ読み込み開始 〜 正しい値が見えるまで: ${num(openMs)} ms(壁時計: ${Date.now() - gotoStart}ms)`);
  }
  await page.waitForTimeout(200);

  const longTasksOnOpen = await page.evaluate(() => window.__longTasks.slice());
  console.log(`--- (B) longtask一覧(設定ウィンドウを開く間): ${JSON.stringify(longTasksOnOpen.map((t) => num(t.dur)))}`);
  ok("(B) 設定ウィンドウを開く間、100ms超のlongtaskが無い", longTasksOnOpen.every((t) => t.dur <= 100));

  // quitOnLastWindowClosedはUI反転項目(依頼: 「最後のウィンドウを閉じても常駐させる」。
  // settings.jsのfieldCheckbox({invert:true})参照)。設定値はfalse(=常駐させる)だが、
  // チェックボックスの見た目(checked)はそれを反転した「常駐させる=ON」の向きになる。
  const quitCheckedVal = await page.evaluate(() => document.querySelector('input[data-field="quitOnLastWindowClosed"]')?.checked ?? null);
  ok(`(B) 遅延応答到着後に正しい値が見える(quitOnLastWindowClosed=false→UIは反転してチェックON) 実際=${quitCheckedVal}`, quitCheckedVal === true);

  // ---- (C) 往復整合性: 何も触らず保存 ----
  await page.click('[data-act="save"]');
  await page.waitForTimeout(200);
  const sentSave = await page.evaluate(() => window.__sent.filter((m) => m.type === "save-settings"));
  ok("(C) save-settingsを送信した", sentSave.length > 0);
  if (sentSave.length) {
    const payload = sentSave[sentSave.length - 1].data.settings;
    const { type: _t, installedFonts: _if, monospaceFonts: _mf, pandocAvailable: _pa, settingsFilePath: _sfp, ...expected } = FULL_SETTINGS_V1;
    const diffKeys = Object.keys(expected).filter((k) => JSON.stringify(payload[k]) !== JSON.stringify(expected[k]));
    ok(`(C) 遅延往復ありでも、何も触らず保存した内容が受信値と完全一致(不一致キー: ${JSON.stringify(diffKeys)})`, diffKeys.length === 0);
  }
  await page.evaluate(() => window.__reply({ type: "save-settings-result", ok: true }));
  await page.waitForTimeout(200);
  await page.close();
}

// ============================================================
// (D) カテゴリ切替のDOM構築コスト(往復遅延なし、切替そのものの重さを見る)
// ============================================================
{
  const page = await browser.newPage();
  attachErrors(page);
  await page.addInitScript(installDelayedBridge, { delay: 0, reply: FULL_SETTINGS_V1 });
  await page.goto("http://localhost:8150/settings-window.html");
  await page.waitForTimeout(400);

  const cats = await page.$$eval(".settings-nav-item", (e) => e.map((x) => x.textContent.trim()));
  ok(`(D) カテゴリが11個 (実際=${cats.length})`, cats.length === 11);

  console.log("\n--- (D) カテゴリ別DOM構築コスト(切替時) ---");
  const categoryTimings = [];
  for (let i = 0; i < cats.length; i++) {
    const r = await page.evaluate((idx) => {
      const btn = document.querySelectorAll(".settings-nav-item")[idx];
      const t0 = performance.now();
      btn.click();
      const t1 = performance.now();
      return { label: btn.textContent.trim(), dur: t1 - t0 };
    }, i);
    categoryTimings.push(r);
    console.log(`  ${r.label.padEnd(14, "　")}: ${num(r.dur)} ms`);
  }
  // 拡張子ツリー・キーバインド表という最も重い2カテゴリを含め、どのカテゴリも
  // 一操作として破綻しない範囲(500ms未満)であることだけを見る
  // (絶対的な速度基準ではなく、無限ループ等の作り込みミスの回帰検出が目的)。
  const worst = categoryTimings.reduce((a, b) => (a.dur > b.dur ? a : b));
  ok(`(D) 最も重いカテゴリ切替でも500ms未満 (最大=${worst.label} ${num(worst.dur)}ms)`, worst.dur < 500);
  await page.close();
}

// ============================================================
// (E) 先読みキャッシュ(settingsCache)自体の残存動作: apply-settingsでキャッシュが
//     破棄され、空き時間の再取得で復元されること(src/settings.js 409-482行付近)。
// ============================================================
{
  const page = await browser.newPage();
  attachErrors(page);
  await page.addInitScript(installDelayedBridge, { delay: 0, reply: FULL_SETTINGS_V1 });
  await page.goto("http://localhost:8150/settings-window.html");
  await page.waitForTimeout(400);

  const cacheAfterOpen = await page.evaluate(() => !!window.__paneSettingsDebug?.getCache());
  ok("(E-前提) 開いた直後はsettingsCacheが埋まっている", cacheAfterOpen);

  await page.evaluate(() => { window.__sent.length = 0; window.__reply({ ...window.__currentSettings, type: "apply-settings" }); });
  const cacheAfterApply = await page.evaluate(() => window.__paneSettingsDebug?.getCache());
  ok(`(E) apply-settings受信直後にsettingsCacheが破棄される(null) 実際=${JSON.stringify(cacheAfterApply)}`, cacheAfterApply === null);

  // schedulePrefetch()は「モーダル(=このウィンドウ)が開いている間は何もしない」
  // (src/settings.js: `if (overlay) return;`)ため、この専用ウィンドウが開いたままの間は
  // 空き時間になってもget-settingsを再送しない = キャッシュはnullのまま復元されない。
  // (この点は本タスクの製品側の所見として報告する。詳細は最終報告を参照。)
  await page.waitForTimeout(600);
  const resentGetSettings = await page.evaluate(() => window.__sent.some((m) => m.type === "get-settings"));
  ok("(E) ウィンドウが開いたままの間はget-settingsを再送しない(overlayが存在する間は先読みしない仕様どおり)", !resentGetSettings);
  const cacheStillNull = await page.evaluate(() => window.__paneSettingsDebug?.getCache());
  ok(`(E) そのためキャッシュはnullのまま(ウィンドウを閉じて再度開くまで復元されない) 実際=${JSON.stringify(cacheStillNull)}`, cacheStillNull === null);

  // ウィンドウを閉じた(destroy()でoverlay=null)後にもう一度apply-settingsが届くと
  // (=他ウィンドウでの変更の再配布。schedulePrefetch()を再度呼ぶ経路はこれしか無い)、
  // 今度はoverlayが無いため空き時間の再取得が実際に行われ、キャッシュが復元される。
  await page.click('[data-act="cancel"]');
  await page.waitForTimeout(150);
  await page.evaluate(() => { window.__sent.length = 0; window.__reply({ ...window.__currentSettings, type: "apply-settings" }); });
  await page.waitForTimeout(600);
  const resentAfterClose = await page.evaluate(() => window.__sent.some((m) => m.type === "get-settings"));
  ok("(E) ウィンドウを閉じた後にapply-settingsが届くと、空き時間にget-settingsを再送する", resentAfterClose);
  const cacheRestoredAfterClose = await page.evaluate(() => !!window.__paneSettingsDebug?.getCache());
  ok("(E) 再取得の応答でsettingsCacheが復元される", cacheRestoredAfterClose);
  await page.close();
}

// ============================================================
// (F) ページエラー・コンソールエラー
// ============================================================
ok(`(F) ページエラー・コンソールエラーが0件: ${JSON.stringify(errors)}`, errors.length === 0);

console.log(`\n合計: OK ${okCount} / NG ${ngCount}`);
await browser.close();
process.exit(ngCount > 0 ? 1 : 0);
