// ローカル画像表示の不具合修正(pane-file.localホスト経由での解決)の検証スクリプト。
// ポートは8176。
//
// 構成:
//   (A) ウィンドウ形式: 相対パス・"./"付き相対・"../"・Windows絶対パス・URLエスケープ済み
//       パス・生の日本語ファイル名・外部URL(https://)・"/"始まり(typora-root-url相当)が
//       それぞれ期待どおり https://pane-file.local/?path=<実パス> へ書き換わること
//   (A') 無題文書(パス無し)では相対パスを解決できず元のままになること
//   (B) typora-root-url(front matter)指定時の"/"始まりパスの基準切替(相対/絶対の両方)
//   (C) 読み込み失敗時のエラー表示がURLエスケープをデコードした読める文字列になること
//   (D) タブ形式: タブごとに基準フォルダが異なり、切り替えるたび正しく解決し直されること
//   (E) 複数ウィンドウ(=複数ページ)で状態が混線しないこと
//   (F) ページエラー・コンソールエラーが0件
import pw from "playwright";
const { chromium } = pw;

const PORT = 8176;
const BASE = `http://localhost:${PORT}/index.html`;
const browser = await chromium.launch();
const allErrors = [];
const allConsoleErrors = [];
let okCount = 0, ngCount = 0;
const ok = (label, cond) => { console.log(`${cond ? "OK  " : "NG  "} ${label}`); if (cond) okCount++; else ngCount++; };

// ---- ページ生成ヘルパー(.verify-contextmenu.mjs等と同じ流儀) ----
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
  // pane-file.localは実際にはC#側(Pane/MainForm.cs OnLocalFileResourceRequested)が応答する
  // 仮想ホストで、テスト環境には実体が無い。ここでは常に404で応答させ、(1)<img>のsrcが
  // 期待どおりのURLへ書き換わっているかを検証しつつ、(2)404によって発火するerrorイベント経由で
  // エラー表示のデコードも検証できるようにする(実DNS解決を待つ実装よりも高速・決定的)。
  await page.route("https://pane-file.local/**", (route) => route.fulfill({ status: 404, body: "not found" }));
  // https://はこのアプリからは(ホスト側で)そもそも到達させない方針だが、この検証環境では
  // 実際のDNS/ネットワークに依存させたくないため、常に1x1のPNGで200応答させて決定的にする
  // (「外部URLはpane-file.local経由にしない」という検証自体はsrc属性の値だけで完結する)。
  const tinyPng = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    "base64",
  );
  await page.route("https://example.com/**", (route) => route.fulfill({ status: 200, contentType: "image/png", body: tinyPng }));
  await page.goto(BASE, { waitUntil: "load" });
  await page.waitForSelector(".cm-content", { timeout: 15000 });
  return page;
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
async function openInTab(page, { path, text }) {
  await page.evaluate(({ path, text }) => window.__reply({
    type: "open-in-tab", fileName: path.split(/[\\/]/).pop(), path, text,
    encoding: "UTF-8", lineEnding: "CRLF", readOnly: false,
  }), { path, text });
  await page.waitForTimeout(400);
}
async function applySettings(page, partial) {
  await page.evaluate((partial) => window.__reply({ type: "apply-settings", ...partial }), partial);
  await page.waitForTimeout(200);
}

// .cm-image-widgetの解決済みsrcを文書内の出現順で返す。読み込み失敗時<img>要素自体は
// (エラー表示に差し替えるため)DOMから削除されるが、wrap要素のdata-resolved-src属性は
// エラー後も残る(src/editor.js ImageWidget.toDOM参照)ため、こちらから読む方が
// エラー発火のタイミングに依存せず安定する。
async function widgetResolvedSrcs(page) {
  return page.$$eval(".cm-image-widget", (els) => els.map((e) => e.dataset.resolvedSrc ?? null));
}
function pathParam(url) {
  if (!url) return null;
  try { return new URL(url).searchParams.get("path"); } catch { return null; }
}

// resolveImageSrc(src/editor.js)のアルゴリズムどおりに「期待される?pathの中身(実ファイル
// システムパス)」を手計算する。実装との一致を確認するテストのため、意図的に別実装として書く。
function safeDecodeURIComponent(s) { try { return decodeURIComponent(s); } catch { return s; } }
function isAbsoluteLocalPath(p) { return /^[a-zA-Z]:[\\/]/.test(p) || p.startsWith("\\\\"); }
function expectedFsPath(rawSrc, rootUrl, docDir) {
  let effective = rawSrc;
  if (rawSrc.startsWith("/")) {
    effective = rootUrl
      ? rootUrl.replace(/\/+$/, "") + "/" + rawSrc.replace(/^\/+/, "")
      : rawSrc.replace(/^\/+/, "");
  }
  effective = safeDecodeURIComponent(effective);
  if (isAbsoluteLocalPath(effective)) return effective;
  return docDir.replace(/[\\/]+$/, "") + "/" + effective;
}

// ================= A. ウィンドウ形式: ローカル画像のURL書き換え =================
{
  const page = await newBridgedPage();
  const docPath = "C:\\work\\notes\\note.md";
  const docDir = "C:\\work\\notes";
  const body = [
    "![case-rel](image-1.png)",
    "",
    "![case-relsub](./sub/pic.png)",
    "",
    "![case-updir](../outside/pic2.png)",
    "",
    "![case-abs](C:\\abs\\path\\pic3.png)",
    "",
    "![case-escaped](%E7%84%A1%E9%A1%8C-1.png)",
    "",
    "![case-unicode](無題-2.png)",
    "",
    "![case-external](https://example.com/x.png)",
    "",
    "![case-rootslash](/abs-root.png)",
    "",
  ].join("\n");
  await openFile(page, docPath, body);
  const resolvedSrcs = await widgetResolvedSrcs(page);

  // bodyに書いた順(0始まり)。case-externalも含む(DOM上の出現順を保つため)。
  const cases = [
    ["case-rel", "image-1.png", 0],
    ["case-relsub", "./sub/pic.png", 1],
    ["case-updir", "../outside/pic2.png", 2],
    ["case-abs", "C:\\abs\\path\\pic3.png", 3],
    ["case-escaped", "%E7%84%A1%E9%A1%8C-1.png", 4],
    ["case-unicode", "無題-2.png", 5],
    ["case-rootslash", "/abs-root.png", 7],
  ];
  ok("(A) 画像ウィジェットが期待どおり8件描画される", resolvedSrcs.length === 8);
  for (const [label, rawSrc, idx] of cases) {
    const src = resolvedSrcs[idx];
    const expected = expectedFsPath(rawSrc, null, docDir);
    ok(`(A) ${label}: pane-file.local経由のURLへ書き換わる`, !!src && src.startsWith("https://pane-file.local/"));
    ok(`(A) ${label}: ?pathの実パスが期待どおり(${JSON.stringify(expected)}になる)`, pathParam(src) === expected);
  }

  const extSrc = resolvedSrcs[6];
  ok("(A) 外部URL(https://)はpane-file.local経由にせずそのまま", extSrc === "https://example.com/x.png");

  // (C) エラー表示のデコード: URLエスケープ済みのcase-escapedが読める文字列で表示されること。
  await page.waitForFunction(() => {
    const w = document.querySelector('.cm-image-widget.cm-image-error');
    return !!w;
  }, { timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(300);
  const errorTexts = await page.$$eval(".cm-image-widget.cm-image-error", (els) => els.map((e) => e.textContent));
  ok("(C) 読み込み失敗した画像がすべてエラー表示に切り替わる(404モック)", errorTexts.length === cases.length);
  ok("(C) URLエスケープ済みパスがデコードされて読める形で表示される",
    errorTexts.some((t) => t === "画像を読み込めません: 無題-1.png"));
  ok("(C) 日本語ファイル名(元々未エスケープ)もそのまま表示される",
    errorTexts.some((t) => t === "画像を読み込めません: 無題-2.png"));
  ok("(C) 相対パスもそのまま(生のMarkdown記法どおり)表示される",
    errorTexts.some((t) => t === "画像を読み込めません: image-1.png"));

  await page.close();
}

// ================= A'. 無題文書では相対パスを解決できず元のまま =================
{
  const page = await newBridgedPage();
  // file-openedをpath:nullで送る(main.jsのapplyFileOpened相当。無題文書としての扱いは
  // currentPath=nullで再現できる。newTab等の"new-document"経路と実質同じ状態になる)。
  await openFile(page, null, "![untitled](image-1.png)");
  const [src] = await widgetResolvedSrcs(page);
  ok("(A') 無題文書では基準フォルダが無く相対パスを解決できない(元のまま)", src === "image-1.png");
  await page.close();
}

// ================= B. typora-root-url(front matter)による"/"始まりパスの基準切替 =================
{
  const page = await newBridgedPage();
  const docPath = "C:\\work\\notes\\note.md";
  const docDir = "C:\\work\\notes";
  const bodyRel = [
    "---",
    "typora-root-url: ./assets",
    "---",
    "",
    "![case-root-rel](/pic.png)",
    "",
  ].join("\n");
  await openFile(page, docPath, bodyRel);
  const [srcRel] = await widgetResolvedSrcs(page);
  const expectedRel = expectedFsPath("/pic.png", "./assets", docDir);
  ok("(B) typora-root-url(相対)指定時、\"/\"始まりパスがそこを基準に解決される",
    pathParam(srcRel) === expectedRel);

  const bodyAbs = [
    "---",
    "typora-root-url: C:\\assets",
    "---",
    "",
    "![case-root-abs](/pic2.png)",
    "",
  ].join("\n");
  await openFile(page, docPath, bodyAbs);
  const [srcAbs] = await widgetResolvedSrcs(page);
  const expectedAbs = expectedFsPath("/pic2.png", "C:\\assets", docDir);
  ok("(B) typora-root-url(絶対)指定時、\"/\"始まりパスがそこを基準(絶対パスのまま)に解決される",
    pathParam(srcAbs) === expectedAbs);

  await page.close();
}

// ================= D. タブ形式: タブごとに基準フォルダが異なる =================
{
  const page = await newBridgedPage();
  // switchToTabは末尾でeditor.focus()する(タブクリック後にキー入力が効くようにするため、
  // src/main.js参照)。新規タブのEditorStateはeditor.createFreshState()経由で作られ、
  // liveRenderingShowSourceOnFocus等の拡張トグルは常にDEFAULT_EXT_TOGGLES(既定true)から
  // 始まる(apply-settingsは"今アクティブなview"にしか効かず、まだ存在しない新規タブの
  // 状態には遡って反映されない)ため、文書の先頭(カーソルの既定位置)が画像記法と重なると
  // 「フォーカス中は生記法のまま」という仕様どおりの動作でウィジェットが出ない
  // (今回の不具合とは無関係)。ここでの検証をその挙動に左右されないよう、画像の前に
  // 別の行を1つ置いてカーソル(位置0)が画像記法と重ならないようにする。
  await applySettings(page, { displayMode: "tab" });

  await openInTab(page, { path: "C:\\proj1\\a.md", text: "note\n\n![tab-img](rel.png)" });
  await openInTab(page, { path: "D:\\proj2\\sub\\b.md", text: "note\n\n![tab-img](rel2.png)" });
  // openInTabは新しいタブを追加してそこへ切り替える(applyOpenInTab→switchToTab)。
  // この時点でアクティブなのは2番目に開いたタブ(b.md)のはず。
  {
    const [src] = await widgetResolvedSrcs(page);
    const expected = expectedFsPath("rel2.png", null, "D:\\proj2\\sub");
    ok("(D) 2番目のタブ(切替直後)は自分のフォルダを基準に解決される", pathParam(src) === expected);
  }

  // "a.md"のタブへ戻る。displayModeが"tab"へ切り替わった瞬間、それまでウィンドウ形式で
  // 開いていた(空の)「無題」文書が1番目のタブとして移行されている(applyDisplayMode参照)ため、
  // タブの並びは [無題, a.md, b.md] の3枚になっている。
  await page.locator(".tab-item").nth(1).click();
  await page.waitForTimeout(300);
  {
    const [src] = await widgetResolvedSrcs(page);
    const expected = expectedFsPath("rel.png", null, "C:\\proj1");
    ok("(D) a.mdのタブへ切り替えると基準フォルダも切り替わる(混線しない)", pathParam(src) === expected);
  }

  // もう一度b.mdのタブへ(往復させても正しいままか)。
  await page.locator(".tab-item").nth(2).click();
  await page.waitForTimeout(300);
  {
    const [src] = await widgetResolvedSrcs(page);
    const expected = expectedFsPath("rel2.png", null, "D:\\proj2\\sub");
    ok("(D) b.mdのタブへ戻っても正しいまま(往復後も一致)", pathParam(src) === expected);
  }

  await page.close();
}

// ================= E. 複数ウィンドウ(複数ページ)で状態が混線しないこと =================
{
  const pageA = await newBridgedPage();
  const pageB = await newBridgedPage();
  await openFile(pageA, "C:\\winA\\a.md", "![w](rel.png)");
  await openFile(pageB, "D:\\winB\\sub\\b.md", "![w](rel.png)");

  const [srcA] = await widgetResolvedSrcs(pageA);
  const [srcB] = await widgetResolvedSrcs(pageB);
  const expectedA = expectedFsPath("rel.png", null, "C:\\winA");
  const expectedB = expectedFsPath("rel.png", null, "D:\\winB\\sub");
  ok("(E) ウィンドウAは自分のフォルダを基準に解決される", pathParam(srcA) === expectedA);
  ok("(E) ウィンドウBは自分のフォルダを基準に解決される(Aと混線しない)", pathParam(srcB) === expectedB);
  ok("(E) 2つのウィンドウの解決結果は異なる", pathParam(srcA) !== pathParam(srcB));

  await pageA.close();
  await pageB.close();
}

// ================= F. ページエラー・コンソールエラー =================
ok("(F) pageerrorが0件", allErrors.length === 0);
if (allErrors.length) console.log(allErrors.slice(0, 5).join("\n---\n"));
// "Failed to load resource: ...404..."は、このスクリプト自身がpane-file.localを常に404で
// モックしている(=読み込み失敗を意図的に起こしてエラー表示を検証する)ことによる想定内の
// ブラウザログであり、JS側の不具合ではないため除外する。
const unexpectedConsoleErrors = allConsoleErrors.filter((t) => !t.includes("Failed to load resource"));
ok("(F) 想定外のconsole.errorが0件(404モックによる読み込み失敗ログは除く)", unexpectedConsoleErrors.length === 0);
if (unexpectedConsoleErrors.length) console.log(unexpectedConsoleErrors.slice(0, 5).join("\n---\n"));

await browser.close();
console.log(`\n結果: OK=${okCount} NG=${ngCount}`);
process.exit(ngCount === 0 ? 0 : 1);
