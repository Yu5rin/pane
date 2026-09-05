// 外部リソースの自動読み込み既定OFF化(docs/調査記録/修正-セキュリティ.md「外部リソースの自動読み込みを、
// 既定でオフにしてください」/docs/調査記録/点検-セキュリティ.md C-5)の回帰確認。
//
// 確認する項目:
//   (A) 既定(loadRemoteResources未指定/false)では、文書中のhttp(s)画像がプレースホルダに
//       なり、実際にはそのURLへ一切通信しない(page.route()で横取りし、リクエストの
//       発生回数そのものを数える)。
//   (B) プレースホルダをクリックすると、そのURL"だけ"読み込まれる(1回だけ通信が発生)。
//   (C) ローカル画像(相対パス→pane-file.local経由)は既定のままでも影響を受けず、
//       従来どおりその場で読み込まれる。
//   (D) 設定でON(loadRemoteResources:true)にすると、クリックしなくても最初から
//       読み込まれる(通信が即座に発生する)。
//   (E) 「この文書の外部リソースをすべて読み込む」(ステータスバー#status-remote-blocked)を
//       押すと、その文書内の残りのプレースホルダもまとめて読み込まれる。
//   (F) 生HTML(<iframe>)も同じ既定OFFの対象になる(html-sanitize.js側)。
//   (G) 文書が入れ替わる(別のファイルを開く)と、同意状態は既定のブロックへ戻る
//       (文書ごとの一時的な同意であり、アプリ全体の設定ではないことの確認)。
// ポートは8217。
//
// 注意: このテストは外部への実通信を一切発生させない。すべてのhttp(s)リクエストは
// page.route()で横取りし、実際のネットワークには出ない(localhost:8217以外へは
// そもそもリクエストが飛ばないことも(A)(F)で確認する)。
import pw from "playwright";
const { chromium } = pw;

const PORT = 8217;
const BASE = `http://localhost:${PORT}/index.html`;
const browser = await chromium.launch();
const allErrors = [];
const allConsoleErrors = [];
let okCount = 0, ngCount = 0;
const ok = (label, cond, extra = "") => { console.log(`${cond ? "OK  " : "NG  "} ${label}${extra ? " " + extra : ""}`); if (cond) okCount++; else ngCount++; };

// C#側(Pane/AppSettings.cs)の既定値に合わせた完全な設定オブジェクト
// (.verify-editorsettings.mjsと同じ流儀。apply-settingsは実際には常に全項目を含む
// 完全なオブジェクトとして送られるため、部分的なオブジェクトを送って他の項目を
// 意図せずundefinedにしない)。
const DEFAULT_SETTINGS = {
  showStatusBar: true, zoomWithCtrlWheel: true, saveWithoutAskingOnSwitch: false,
  showWordCount: true, readingSpeedWpm: 0, collapsibleOutline: true, showOutlineByDefault: false,
  theme: "system", lightTheme: "default", darkTheme: "default",
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
  headingStyle: "atx", unorderedListMarker: "-", orderedListMarker: ".",
  indentSizeOnSave: 4, codeIndentSize: 4,
  defaultCodeLanguage: "", defaultCodeLanguageApplyWhen: "menubar",
  chapterLevelInOutline: 6,
  whitespaceWhenWriting: "preserve", whitespaceOnExport: "ignore",
  smartQuotes: "off", smartDashes: "off", recognizeUnicodePunctuation: false,
  // 検証対象の設定項目(既定false。src/settings.js FIELD_DEFS参照)。
  loadRemoteResources: false,
};

const tinyPng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

// ---- ページ生成(.verify-images.mjs等と同じ流儀) ----
async function newBridgedPage() {
  const page = await browser.newPage();
  page.on("pageerror", (e) => allErrors.push(String(e.stack || e)));
  page.on("console", (m) => { if (m.type() === "error") allConsoleErrors.push(m.text()); });
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
  // 外部への実通信を一切発生させない: このテストで使う外部ホストへのリクエストは
  // すべてここで横取りして記録し、tinyPngで200応答する(実DNS/ネットワークに依存しない)。
  const requestLog = [];
  page.on("request", (req) => {
    const u = req.url();
    if (!u.startsWith(`http://localhost:${PORT}/`)) requestLog.push(u);
  });
  await page.route("https://blocked.example.test/**", (route) => route.fulfill({ status: 200, contentType: "image/png", body: tinyPng }));
  await page.route("https://blocked2.example.test/**", (route) => route.fulfill({ status: 200, contentType: "image/png", body: tinyPng }));
  // pane-file.local(ローカル画像。実体はC#側)はテスト環境には無いため、テスト用に
  // 常に200のtinyPngを返す(「ローカル画像は既定のまま読み込まれる」ことの確認に使う)。
  await page.route("https://pane-file.local/**", (route) => route.fulfill({ status: 200, contentType: "image/png", body: tinyPng }));
  await page.goto(BASE, { waitUntil: "load" });
  await page.waitForSelector(".cm-content", { timeout: 15000 });
  page.__requestLog = requestLog;
  return page;
}

async function applySettings(page, overrides = {}) {
  const full = { ...DEFAULT_SETTINGS, ...overrides };
  await page.evaluate((full) => window.__reply({ type: "apply-settings", ...full }), full);
  await page.waitForTimeout(200);
}
async function openFile(page, path, text, extra = {}) {
  await page.evaluate(({ path, text, extra }) => window.__reply({
    type: "file-opened",
    fileName: path ? path.split(/[\\/]/).pop() : "無題",
    path, text,
    encoding: "UTF-8", lineEnding: "CRLF", readOnly: false, ...extra,
  }), { path, text, extra });
  await page.waitForTimeout(400);
}
function countRequestsTo(page, host) {
  return page.__requestLog.filter((u) => u.includes(host)).length;
}
async function statusRemoteBlockedHidden(page) {
  return page.$eval("#status-remote-blocked", (el) => el.hidden).catch(() => null);
}

// ============================================================
// (A) 既定OFF: プレースホルダになり、実際には一切通信しない
// ============================================================
{
  const page = await newBridgedPage();
  await applySettings(page); // 既定(loadRemoteResources:false)
  await openFile(page, "C:\\work\\note.md", "![外部画像](https://blocked.example.test/a.png)\n\n(末尾)");

  const widget = await page.$eval(".cm-image-widget", (el) => ({
    blocked: el.classList.contains("cm-image-blocked"),
    hasImg: !!el.querySelector("img"),
    text: el.textContent,
  }));
  ok("(A) 既定OFFでは外部画像がプレースホルダ(cm-image-blocked)になる", widget.blocked, JSON.stringify(widget));
  ok("(A) プレースホルダの中に<img>要素が無い(=一切fetchしていない)", !widget.hasImg);
  ok('(A) プレースホルダの文言に"読み込んでいません"が含まれる', /読み込んでいません/.test(widget.text), widget.text);
  ok("(A) 実際にblocked.example.testへは1回もリクエストしていない", countRequestsTo(page, "blocked.example.test") === 0);
  ok("(A) ステータスバー「外部リソースを読み込む」が表示される", (await statusRemoteBlockedHidden(page)) === false);

  // ---- (B) プレースホルダをクリックするとそのURLだけ読み込まれる ----
  await page.click(".cm-image-widget.cm-image-blocked");
  await page.waitForTimeout(300);
  const afterClick = await page.$eval(".cm-image-widget", (el) => ({
    blocked: el.classList.contains("cm-image-blocked"),
    hasImg: !!el.querySelector("img"),
  }));
  ok("(B) クリック後はプレースホルダでなくなる", !afterClick.blocked, JSON.stringify(afterClick));
  ok("(B) クリック後は<img>要素が生成される", afterClick.hasImg);
  ok("(B) クリックしたぶんだけ1回リクエストが発生する", countRequestsTo(page, "blocked.example.test") === 1);
  ok("(B) 読み込み後はステータスバーの表示が消える(この文書に他の未読み込みが無いため)", (await statusRemoteBlockedHidden(page)) === true);

  await page.close();
}

// ============================================================
// (C) ローカル画像(相対パス)は既定のままでも影響を受けない
// ============================================================
{
  const page = await newBridgedPage();
  await applySettings(page);
  await openFile(page, "C:\\work\\note.md", "![ローカル](rel.png)\n\n(末尾)");
  const widget = await page.$eval(".cm-image-widget", (el) => ({
    blocked: el.classList.contains("cm-image-blocked"),
    hasImg: !!el.querySelector("img"),
    resolvedSrc: el.dataset.resolvedSrc,
  }));
  ok("(C) 既定OFFでもローカル画像はプレースホルダにならない", !widget.blocked, JSON.stringify(widget));
  ok("(C) ローカル画像は最初から<img>要素がある", widget.hasImg);
  ok("(C) ローカル画像はpane-file.local経由のまま(素通し対象外)", widget.resolvedSrc.startsWith("https://pane-file.local/"));
  ok("(C) ローカル画像なのでステータスバーの表示は出ない", (await statusRemoteBlockedHidden(page)) === true);
  await page.close();
}

// ============================================================
// (D) 設定でONにすると最初から読み込まれる
// ============================================================
{
  const page = await newBridgedPage();
  await applySettings(page, { loadRemoteResources: true });
  await openFile(page, "C:\\work\\note.md", "![外部画像](https://blocked.example.test/on.png)\n\n(末尾)");
  const widget = await page.$eval(".cm-image-widget", (el) => ({
    blocked: el.classList.contains("cm-image-blocked"),
    hasImg: !!el.querySelector("img"),
  }));
  ok("(D) loadRemoteResources:trueなら最初からプレースホルダにならない", !widget.blocked, JSON.stringify(widget));
  ok("(D) loadRemoteResources:trueなら最初から<img>要素がある", widget.hasImg);
  ok("(D) loadRemoteResources:trueなら最初からリクエストが発生する", countRequestsTo(page, "blocked.example.test") === 1);
  ok("(D) 設定でONの間はステータスバーの表示も出ない", (await statusRemoteBlockedHidden(page)) === true);
  await page.close();
}

// ============================================================
// (E) 「この文書の外部リソースをすべて読み込む」でまとめて読み込む
// ============================================================
{
  const page = await newBridgedPage();
  await applySettings(page);
  await openFile(page, "C:\\work\\note.md", [
    "![1枚目](https://blocked.example.test/1.png)",
    "",
    "![2枚目](https://blocked2.example.test/2.png)",
    "",
    "(末尾)",
  ].join("\n"));

  const beforeBlocked = await page.$$eval(".cm-image-widget.cm-image-blocked", (els) => els.length);
  ok("(E) 2枚とも最初はプレースホルダ", beforeBlocked === 2);
  ok("(E) ステータスバーのボタンが見える", (await statusRemoteBlockedHidden(page)) === false);

  await page.click("#status-remote-blocked");
  await page.waitForTimeout(300);

  const afterBlocked = await page.$$eval(".cm-image-widget.cm-image-blocked", (els) => els.length);
  const afterImgs = await page.$$eval(".cm-image-widget img", (els) => els.length);
  ok("(E) 「すべて読み込む」を押すと2枚ともプレースホルダでなくなる", afterBlocked === 0, `afterBlocked=${afterBlocked}`);
  ok("(E) 2枚とも<img>要素になる", afterImgs === 2);
  ok("(E) 1枚目・2枚目それぞれのURLへ1回ずつリクエストが発生する",
    countRequestsTo(page, "blocked.example.test/1.png") === 1 && countRequestsTo(page, "blocked2.example.test/2.png") === 1);
  ok("(E) 読み込み後はステータスバーの表示が消える", (await statusRemoteBlockedHidden(page)) === true);

  // まとめて許可した後に本文へさらに外部画像を追記しても、この文書のうちは自動で読み込まれる
  // (allowAll=trueがこの文書のremoteConsentFieldに残っているため)。
  await page.click(".cm-content");
  await page.keyboard.press("Control+End");
  await page.keyboard.insertText("\n\n![3枚目](https://blocked.example.test/3.png)");
  await page.waitForTimeout(300);
  const thirdBlocked = await page.$$eval(".cm-image-widget.cm-image-blocked", (els) => els.length);
  ok("(E) 「すべて読み込む」後にこの文書へ追記した外部画像も自動で読み込まれる", thirdBlocked === 0, `thirdBlocked=${thirdBlocked}`);

  await page.close();
}

// ============================================================
// (F) 生HTML(<iframe>)も既定OFFの対象になる
// ============================================================
{
  const page = await newBridgedPage();
  await applySettings(page);
  await openFile(page, "C:\\work\\note.md", [
    "本文の前",
    "",
    '<iframe src="https://blocked.example.test/embed"></iframe>',
    "",
    "本文の後",
  ].join("\n"));

  const before = await page.evaluate(() => {
    const block = document.querySelector(".cm-html-block");
    return block ? {
      hasIframe: !!block.querySelector("iframe"),
      hasPlaceholder: !!block.querySelector(".cm-remote-blocked-inline"),
      placeholderText: block.querySelector(".cm-remote-blocked-inline")?.textContent ?? null,
    } : null;
  });
  ok("(F) 既定OFFではiframeが生成されずプレースホルダになる", before && !before.hasIframe && before.hasPlaceholder, JSON.stringify(before));
  ok('(F) プレースホルダの文言に"読み込んでいません"が含まれる', before && /読み込んでいません/.test(before.placeholderText || ""), before?.placeholderText);
  ok("(F) 実際にはiframeのURLへリクエストしていない", countRequestsTo(page, "blocked.example.test/embed") === 0);

  await page.click(".cm-remote-blocked-inline");
  await page.waitForTimeout(300);
  const after = await page.evaluate(() => {
    const block = document.querySelector(".cm-html-block");
    return block ? { hasIframe: !!block.querySelector("iframe"), hasPlaceholder: !!block.querySelector(".cm-remote-blocked-inline") } : null;
  });
  ok("(F) クリック後はiframeが生成される", after && after.hasIframe, JSON.stringify(after));
  ok("(F) クリック後はプレースホルダが無くなる", after && !after.hasPlaceholder);
  ok("(F) iframeのsandbox属性は常に空(スクリプト等を許可しない、既存方針のまま)",
    await page.$eval(".cm-html-block iframe", (el) => el.getAttribute("sandbox")) === "");

  await page.close();
}

// ============================================================
// (G) 文書が入れ替わると同意状態は既定へ戻る(文書ごとの一時的な同意)
// ============================================================
{
  const page = await newBridgedPage();
  await applySettings(page);
  await openFile(page, "C:\\work\\a.md", "![外部画像](https://blocked.example.test/reset.png)");
  await page.click("#status-remote-blocked"); // この文書だけ「すべて読み込む」
  await page.waitForTimeout(300);
  ok("(G) 1つ目の文書ではすべて読み込む操作でプレースホルダが消える",
    (await page.$$eval(".cm-image-widget.cm-image-blocked", (els) => els.length)) === 0);

  // 別のファイルを開く(同じdocDirでも文書そのものは入れ替わる)。
  await openFile(page, "C:\\work\\b.md", "![外部画像](https://blocked.example.test/reset.png)");
  const blockedAgain = await page.$$eval(".cm-image-widget.cm-image-blocked", (els) => els.length);
  ok("(G) 別の文書を開くと同意は引き継がれず再びプレースホルダになる", blockedAgain === 1, `blockedAgain=${blockedAgain}`);
  ok("(G) ステータスバーのボタンも再び表示される", (await statusRemoteBlockedHidden(page)) === false);

  await page.close();
}

// ============================================================
// まとめ
// ============================================================
console.log("\n---- JSエラー ----");
allErrors.forEach((e) => console.log("pageerror:", e));
allConsoleErrors.forEach((e) => console.log("console.error:", e));
ok("ページエラーが無い", allErrors.length === 0);
const unexpectedConsoleErrors = allConsoleErrors.filter((t) => !t.includes("Failed to load resource"));
ok("想定外のconsole.errorが無い", unexpectedConsoleErrors.length === 0, JSON.stringify(unexpectedConsoleErrors.slice(0, 5)));

console.log(`\n結果: OK=${okCount} NG=${ngCount}`);
await browser.close();
process.exit(ngCount === 0 ? 0 : 1);
