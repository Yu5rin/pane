// 品質確認で見つかった仕様書と実装の不一致5件の検証スクリプト。ポートは8167。
//
// 構成:
//   (A) ステータスバーの文字コード・改行コードが<button>であること
//   (B) クリックでopen-context-menuが送られ、期待する項目とチェック状態が入っていること
//   (C) 選ぶとステータスバーの表示が変わり、未保存状態になり、C#へ通知(set-encoding/
//       set-line-ending)が飛ぶこと
//   (D) 改行コードが「混在」のときにどれかを選ぶと統一操作になること(チェックは付かず、
//       選ぶとset-line-endingが送られ表示が確定する)
//   (E) ブリッジ無し環境ではHTMLの.menu-dropdownにフォールバックすること
//   (F) エクスポートメニューにRTF/LaTeX/Textileがあり、Pandoc未導入時は無効表示になること
//       (導入時は有効になること)
//   (G) 行送りの既定が1.95、最大幅の既定が42文字相当(630px = 既定フォントサイズ15px×42)
//       であること(設定画面の既定表示で確認)
//   (H) Markdownモードでのみ最大幅が効き、コード/プレーンテキストモードでは無制限になること
//   (I) 最大幅を0にすると(Markdownモードでも)無制限に戻ること
//   (J) ページエラー・コンソールエラーが0件であること
import pw from "playwright";
const { chromium } = pw;

const PORT = 8167;
const BASE = `http://localhost:${PORT}/index.html`;
const browser = await chromium.launch();
const allErrors = [];
const allConsoleErrors = [];
let okCount = 0, ngCount = 0;
const ok = (label, cond) => { console.log(`${cond ? "OK  " : "NG  "} ${label}`); if (cond) okCount++; else ngCount++; };

// ---- ページ生成ヘルパー(.verify-contextmenu.mjsと同じ流儀) ----
async function newBridgedPage() {
  // ステータスバーはウィンドウ下端にあり、そこから下向きに開くメニューは既定の
  // viewport高さ(720px)だと画面外へはみ出してPlaywrightからクリックできなくなるため、
  // 縦を広めに取る。
  const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
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
  await page.goto(BASE, { waitUntil: "load" });
  await page.waitForSelector(".cm-content", { timeout: 15000 });
  return page;
}
async function newPlainPage() {
  // ステータスバーはウィンドウ下端にあり、そこから下向きに開くメニューは既定の
  // viewport高さ(720px)だと画面外へはみ出してPlaywrightからクリックできなくなるため、
  // 縦を広めに取る。
  const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
  page.on("pageerror", (e) => allErrors.push(String(e.stack || e)));
  page.on("console", (m) => { if (m.type() === "error") allConsoleErrors.push(m.text()); });
  await page.goto(BASE, { waitUntil: "load" });
  await page.waitForSelector(".cm-content", { timeout: 15000 });
  return page;
}
async function openFile(page, text, extra = {}) {
  await page.evaluate(({ text, extra }) => window.__reply({
    type: "file-opened", fileName: "sample.md", path: "C:\\work\\sample.md", text,
    encoding: "UTF-8", lineEnding: "CRLF", readOnly: false, ...extra,
  }), { text, extra });
  await page.waitForTimeout(400);
}
function clearSent(page) { return page.evaluate(() => { window.__sent = []; }); }
async function lastMsg(page, type) {
  const arr = await page.evaluate((ty) => window.__sent.filter((m) => m.type === ty), type);
  return arr[arr.length - 1] ?? null;
}
function findItem(items, label) {
  for (const it of items ?? []) {
    if (it.label === label) return it;
  }
  return null;
}

// ============================================================
// (A)(B)(C) ブリッジあり: ステータスバーの文字コード・改行コード
// ============================================================
{
  const page = await newBridgedPage();
  await openFile(page, "本文です", { encoding: "UTF-8", lineEnding: "CRLF" });

  // ---- (A) <button>であること ----
  const encTag = await page.$eval("#status-encoding", (e) => e.tagName.toLowerCase());
  const leTag = await page.$eval("#status-line-ending", (e) => e.tagName.toLowerCase());
  ok(`(A) #status-encodingがbutton要素 (実際=${encTag})`, encTag === "button");
  ok(`(A) #status-line-endingがbutton要素 (実際=${leTag})`, leTag === "button");
  ok("(A) 文字コードの表示テキストにUTF-8を含む", (await page.textContent("#status-encoding")).includes("UTF-8"));
  ok("(A) 改行コードの表示テキストにCRLFを含む", (await page.textContent("#status-line-ending")).includes("CRLF"));

  // ---- (B) クリックでopen-context-menuが送られ、期待する項目とチェック状態が入っている ----
  await clearSent(page);
  await page.click("#status-encoding");
  await page.waitForTimeout(250);
  const encMsg = await lastMsg(page, "open-context-menu");
  ok("(B) 文字コードクリックでopen-context-menuを送信", !!encMsg);
  const encLabels = (encMsg?.items ?? []).map((i) => i.label);
  ok(`(B) 文字コードの5択が揃っている ${JSON.stringify(encLabels)}`,
    JSON.stringify(encLabels) === JSON.stringify(["UTF-8", "UTF-8 (BOM付き)", "UTF-16 LE", "UTF-16 BE", "Shift_JIS"]));
  ok("(B) 現在の文字コード(UTF-8)にchecked", findItem(encMsg.items, "UTF-8")?.checked === true);
  ok("(B) 他の文字コードにはcheckedが付かない", findItem(encMsg.items, "Shift_JIS")?.checked === false);
  await page.evaluate(() => window.__reply({ type: "menu-closed", menu: "__context__" }));

  await clearSent(page);
  await page.click("#status-line-ending");
  await page.waitForTimeout(250);
  const leMsg = await lastMsg(page, "open-context-menu");
  ok("(B) 改行コードクリックでopen-context-menuを送信", !!leMsg);
  const leLabels = (leMsg?.items ?? []).map((i) => i.label);
  ok(`(B) 改行コードの3択が揃っている ${JSON.stringify(leLabels)}`, JSON.stringify(leLabels) === JSON.stringify(["CRLF", "LF", "CR"]));
  ok("(B) 現在の改行コード(CRLF)にchecked", findItem(leMsg.items, "CRLF")?.checked === true);
  ok("(B) LF/CRにはcheckedが付かない",
    findItem(leMsg.items, "LF")?.checked === false && findItem(leMsg.items, "CR")?.checked === false);

  // ---- (C) 選ぶとステータスバーの表示が変わり、未保存状態になり、C#へ通知が飛ぶ ----
  await clearSent(page);
  const lfItem = findItem(leMsg.items, "LF");
  await page.evaluate((id) => window.__reply({ type: "menu-command", id }), lfItem.id);
  await page.waitForTimeout(200);
  ok("(C) ステータスバーの改行コード表示がLFに変わる", (await page.textContent("#status-line-ending")).includes("LF"));
  const dirtyMsg = await lastMsg(page, "dirty");
  ok("(C) 未保存(dirty:true)がC#へ通知される", dirtyMsg?.value === true);
  const setLeMsg = await lastMsg(page, "set-line-ending");
  ok(`(C) set-line-endingがC#へ通知される ${JSON.stringify(setLeMsg)}`, setLeMsg?.lineEnding === "LF");
  const dirtyIndicatorVisible = await page.$eval("#status-dirty", (e) => !e.hidden);
  ok("(C) ステータスバーの未保存インジケータが表示される", dirtyIndicatorVisible);

  await page.evaluate(() => window.__reply({ type: "menu-closed", menu: "__context__" }));
  await clearSent(page);
  await page.click("#status-encoding");
  await page.waitForTimeout(200);
  const encMsg2 = await lastMsg(page, "open-context-menu");
  const sjisItem = findItem(encMsg2.items, "Shift_JIS");
  await page.evaluate((id) => window.__reply({ type: "menu-command", id }), sjisItem.id);
  await page.waitForTimeout(200);
  ok("(C) ステータスバーの文字コード表示がShift_JISに変わる", (await page.textContent("#status-encoding")).includes("Shift_JIS"));
  const setEncMsg = await lastMsg(page, "set-encoding");
  ok(`(C) set-encodingがC#へ通知される ${JSON.stringify(setEncMsg)}`, setEncMsg?.encoding === "Shift_JIS");
  await page.evaluate(() => window.__reply({ type: "menu-closed", menu: "__context__" }));

  await page.close();
}

// ============================================================
// (D) 改行コードが「混在」のときの統一操作
// ============================================================
{
  const page = await newBridgedPage();
  await openFile(page, "行1\n行2", { encoding: "UTF-8", lineEnding: "混在" });
  ok("(D) 「混在」がステータスバーに表示される", (await page.textContent("#status-line-ending")).includes("混在"));

  await clearSent(page);
  await page.click("#status-line-ending");
  await page.waitForTimeout(200);
  const mixedMsg = await lastMsg(page, "open-context-menu");
  ok("(D) 「混在」時はCRLF/LF/CRのどれにもcheckedが付かない",
    (mixedMsg.items ?? []).every((i) => i.checked === false));

  const crlfItem = findItem(mixedMsg.items, "CRLF");
  await page.evaluate((id) => window.__reply({ type: "menu-command", id }), crlfItem.id);
  await page.waitForTimeout(200);
  ok("(D) CRLFを選ぶと統一され、ステータスバーが「混在」から変わる",
    (await page.textContent("#status-line-ending")).includes("CRLF") && !(await page.textContent("#status-line-ending")).includes("混在"));
  const setLeMsg = await lastMsg(page, "set-line-ending");
  ok(`(D) set-line-ending(CRLF)がC#へ通知される ${JSON.stringify(setLeMsg)}`, setLeMsg?.lineEnding === "CRLF");
  await page.evaluate(() => window.__reply({ type: "menu-closed", menu: "__context__" }));
  await page.close();
}

// ============================================================
// (E) ブリッジ無し: HTMLの.menu-dropdownへフォールバックする
// ============================================================
{
  const page = await newPlainPage();
  await page.click("#status-encoding");
  await page.waitForTimeout(200);
  const dropdown = await page.$(".menu-dropdown");
  ok("(E) ブリッジ無しではHTMLの.menu-dropdownが出る", dropdown !== null);
  const itemTexts = await page.$$eval(".menu-dropdown > .menu-item .menu-item-label", (els) => els.map((e) => e.textContent));
  ok(`(E) フォールバックにも文字コードの5択がある ${JSON.stringify(itemTexts)}`,
    JSON.stringify(itemTexts) === JSON.stringify(["UTF-8", "UTF-8 (BOM付き)", "UTF-16 LE", "UTF-16 BE", "Shift_JIS"]));
  // クリックで実際に選べる(表示が変わる)ことも確認する。ステータスバーが画面最下部にあるため
  // 下向きに開いたメニューがviewport外へはみ出すことがある(HTMLフォールバックは画面内補正を
  // 行わない。実機のネイティブポップアップならOSが自動調整する)。Playwrightのlocator.click()は
  // viewport外の要素を拒否する(force:trueでも拒否される)ため、DOM上のclick()を直接呼ぶ。
  await page.evaluate(() => {
    const item = [...document.querySelectorAll(".menu-dropdown .menu-item-label")].find((e) => e.textContent === "Shift_JIS");
    item.closest(".menu-item").click();
  });
  await page.waitForTimeout(150);
  ok("(E) フォールバック経由でも選択すると表示が変わる", (await page.textContent("#status-encoding")).includes("Shift_JIS"));
  await page.close();
}

// ============================================================
// (F) エクスポートメニュー: RTF/LaTeX/Textile、Pandoc未導入時は無効表示
// ============================================================
{
  const page = await newBridgedPage();
  await openFile(page, "本文です");

  await clearSent(page);
  await page.click("#menubar .menu-top:text('ファイル')");
  await page.waitForTimeout(200);
  const fileMsg = await lastMsg(page, "open-menu");
  const labels = (fileMsg?.items ?? []).map((i) => i.label);
  ok(`(F) Fileメニューに「エクスポート: RTF」がある ${JSON.stringify(labels)}`, labels.includes("エクスポート: RTF"));
  ok("(F) Fileメニューに「エクスポート: LaTeX」がある", labels.includes("エクスポート: LaTeX"));
  ok("(F) Fileメニューに「エクスポート: Textile」がある", labels.includes("エクスポート: Textile"));
  const rtfItem = findItem(fileMsg.items, "エクスポート: RTF");
  const latexItem = findItem(fileMsg.items, "エクスポート: LaTeX");
  const textileItem = findItem(fileMsg.items, "エクスポート: Textile");
  ok("(F) Pandoc未導入時、RTFは無効表示", rtfItem?.enabled === false && rtfItem?.note === "Pandoc未導入");
  ok("(F) Pandoc未導入時、LaTeXは無効表示", latexItem?.enabled === false && latexItem?.note === "Pandoc未導入");
  ok("(F) Pandoc未導入時、Textileは無効表示", textileItem?.enabled === false && textileItem?.note === "Pandoc未導入");
  await page.evaluate(() => window.__reply({ type: "menu-closed", menu: "File" }));

  // Pandoc導入時(apply-settingsでpandocAvailable:true)は有効になる。
  await page.evaluate(() => window.__reply({ type: "apply-settings", pandocAvailable: true }));
  await page.waitForTimeout(150);
  await clearSent(page);
  await page.click("#menubar .menu-top:text('ファイル')");
  await page.waitForTimeout(200);
  const fileMsg2 = await lastMsg(page, "open-menu");
  ok("(F) Pandoc導入時、RTFは有効", findItem(fileMsg2.items, "エクスポート: RTF")?.enabled === true);
  ok("(F) Pandoc導入時、LaTeXは有効", findItem(fileMsg2.items, "エクスポート: LaTeX")?.enabled === true);
  ok("(F) Pandoc導入時、Textileは有効", findItem(fileMsg2.items, "エクスポート: Textile")?.enabled === true);
  await page.evaluate(() => window.__reply({ type: "menu-closed", menu: "File" }));
  await page.close();
}

// ============================================================
// (G) 行送りの既定が1.95、最大幅の既定が42文字相当(630px)であること
//     (設定画面をブリッジ無しで開くとsrc/settings.jsのDEFAULTSがそのまま表示される)
// ============================================================
{
  const page = await newPlainPage();
  // editorLineHeight/editorMaxWidthPxは「外観」カテゴリにある(docs/設定項目一覧.md)。
  await page.evaluate(() => window.__paneDebugCtx.actions.openSettings("appearance"));
  await page.waitForTimeout(200);
  const lineHeightVal = await page.$eval('[data-field="editorLineHeight"]', (e) => e.value);
  const maxWidthVal = await page.$eval('[data-field="editorMaxWidthPx"]', (e) => e.value);
  ok(`(G) editorLineHeightの既定が1.95 (実際=${lineHeightVal})`, Number(lineHeightVal) === 1.95);
  ok(`(G) editorMaxWidthPxの既定が630(全角42文字×15px) (実際=${maxWidthVal})`, Number(maxWidthVal) === 630);
  await page.close();
}

// ============================================================
// (H)(I) Markdownモードでのみ最大幅が効き、コード/プレーンでは無制限。0で無制限に戻る。
// ============================================================
{
  // apply-settingsはブリッジ経由のメッセージのため、ブリッジをモックしたページを使う
  // (newPlainPageではwindow.__replyが定義されない)。モードの切り替えは実際のC#からの
  // フローに合わせ、拡張子違いのファイルを開くこと(file-opened)で行う
  // (.js→コード、.txt→プレーンテキスト、.md→Markdown。src/languages.jsのresolveFileMode)。
  const page = await newBridgedPage();
  await openFile(page, "# 見出し\n\n本文です。", { fileName: "sample.md", path: "C:\\work\\sample.md" });

  async function applyMaxWidth(px) {
    await page.evaluate((px) => window.__reply({ type: "apply-settings", editorMaxWidthPx: px }), px);
    await page.waitForTimeout(200);
  }
  async function currentMode() { return page.evaluate(() => document.documentElement.getAttribute("data-editor-mode")); }
  async function contentMaxWidth() { return page.$eval("#cm-host .cm-content", (e) => getComputedStyle(e).maxWidth); }

  await applyMaxWidth(400);
  ok(`(H) Markdownモードであること (実際=${await currentMode()})`, (await currentMode()) === "markdown");
  ok(`(H) Markdownモードでは400pxの最大幅が効く (実際=${await contentMaxWidth()})`, (await contentMaxWidth()) === "400px");

  await openFile(page, "console.log(1);", { fileName: "sample.js", path: "C:\\work\\sample.js" });
  ok(`(H) コードモードに切り替わる (実際=${await currentMode()})`, (await currentMode()) === "code");
  ok(`(H) コードモードでは最大幅が無制限(none) (実際=${await contentMaxWidth()})`, (await contentMaxWidth()) === "none");

  await openFile(page, "ただのテキストです。", { fileName: "sample.txt", path: "C:\\work\\sample.txt" });
  ok(`(H) プレーンテキストモードに切り替わる (実際=${await currentMode()})`, (await currentMode()) === "plain");
  ok(`(H) プレーンテキストモードでは最大幅が無制限(none) (実際=${await contentMaxWidth()})`, (await contentMaxWidth()) === "none");

  // ---- (I) Markdownの文書に戻し、0を指定すると無制限になる ----
  await openFile(page, "# 見出し\n\n本文です。", { fileName: "sample2.md", path: "C:\\work\\sample2.md" });
  await applyMaxWidth(0);
  ok(`(I) editorMaxWidthPx:0で無制限に戻る (実際=${await contentMaxWidth()})`, (await contentMaxWidth()) === "none");

  await page.close();
}

// ============================================================
// (J) ページエラー・コンソールエラー0件
// ============================================================
const unexpectedConsoleErrors = allConsoleErrors.filter((m) => !/Failed to load resource/.test(m));
ok(`(J) ページエラー0件 ${JSON.stringify(allErrors)}`, allErrors.length === 0);
ok(`(J) コンソールエラー0件(意図的な画像読込失敗を除く) ${JSON.stringify(unexpectedConsoleErrors)}`, unexpectedConsoleErrors.length === 0);

console.log(`--- 集計: OK=${okCount} NG=${ngCount}`);
await browser.close();
process.exit(ngCount > 0 ? 1 : 0);
