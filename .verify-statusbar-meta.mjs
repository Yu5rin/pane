// ステータスバーに文字コード・改行コードが表示されない不具合の検証。ポートは8180。
//
// 構成:
//   (A) 起動直後の無題文書で、ステータスバーに「文字コード: UTF-8」「改行コード: CRLF」が
//       表示されること(new-document等のメッセージが届く前、モジュール初期化直後の時点)
//   (B) C#側がencoding/lineEnding付きでnew-documentを送ってきたとき、その値が表示されること
//       (Pane/MainForm.cs OpenNewDocumentの修正が効いていることの確認)
//   (C) encoding/lineEnding無しでnew-documentが届いても空にならず、設定(apply-settings)の
//       defaultEncoding/defaultLineEndingから作った既定値へフォールバックすること
//   (D) 設定(apply-settings)がまだ一度も届いていない状態でnew-documentがencoding/lineEnding
//       無しで届いても、最終フォールバックのUTF-8/CRLFになること
//   (E) ステータスバーの文字コード/改行コードをクリックして明示的に変更したあと、その値が
//       保持されること。かつ、その後に設定変更(apply-settings)が届いても明示変更した値を
//       設定側の値で勝手に上書きしないこと(仕様書6.1「明示的に変更でき」を優先する判断)
//   (F) 無題かつ未編集の文書は、設定変更(apply-settings)のdefaultEncoding/defaultLineEnding
//       に追従すること(まだ何もタイプしていない場合のみ)
//   (G) ページエラー・コンソールエラーが0件であること
//   (H) ステータスバーの幅対応(ユーザー要望): ウィンドウ幅を段階的に狭めていくと、
//       1.改行コードのラベル省略 2.文字コードのラベル省略 3.拡大率を非表示
//       4.行・列を非表示 5.文字数を非表示 6.折り返しを非表示 7.改行コード(値ごと)を非表示
//       8.文字コード(値ごと)を非表示 の順に畳まれること。どの幅でもステータスバーの高さが
//       24pxを超えないこと。「設定」ボタン(#btn-settings)が存在しないこと。Ctrl+,で
//       設定を開く操作(ブリッジありなのでopen-settings-window送信)が引き続き効くこと
import pw from "playwright";
const { chromium } = pw;

const PORT = 8180;
const BASE = `http://localhost:${PORT}/index.html`;
const browser = await chromium.launch();
const allErrors = [];
const allConsoleErrors = [];
let okCount = 0, ngCount = 0;
const ok = (label, cond) => { console.log(`${cond ? "OK  " : "NG  "} ${label}`); if (cond) okCount++; else ngCount++; };

async function newBridgedPage() {
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
const encodingText = (page) => page.textContent("#status-encoding");
const lineEndingText = (page) => page.textContent("#status-line-ending");

// ============================================================
// (A) 起動直後(new-document等が届く前)の表示
// ============================================================
{
  const page = await newBridgedPage();
  // waitForSelectorの時点でモジュールの初期化(main.js末尾近くのupdateStatusMeta()呼び出し)は
  // 完了しているはずだが、明示的にreadyメッセージ送信より前であることを確認したうえで見る。
  const readySent = await page.evaluate(() => window.__sent.some((m) => m.type === "ready"));
  ok("(A) 起動時にreadyを送信済み(ブリッジあり)", readySent);
  ok(`(A) 起動直後の文字コード表示 (実際="${await encodingText(page)}")`, (await encodingText(page)).includes("文字コード: UTF-8"));
  ok(`(A) 起動直後の改行コード表示 (実際="${await lineEndingText(page)}")`, (await lineEndingText(page)).includes("改行コード: CRLF"));
  await page.close();
}

// ============================================================
// (B) new-documentにencoding/lineEndingが載っている場合、その値が反映される
// ============================================================
{
  const page = await newBridgedPage();
  await page.evaluate(() => window.__reply({ type: "new-document", encoding: "Shift_JIS", lineEnding: "LF" }));
  await page.waitForTimeout(300);
  ok(`(B) new-documentのencodingが反映される (実際="${await encodingText(page)}")`, (await encodingText(page)).includes("Shift_JIS"));
  ok(`(B) new-documentのlineEndingが反映される (実際="${await lineEndingText(page)}")`, (await lineEndingText(page)).includes("LF") && !(await lineEndingText(page)).includes("CRLF"));
  await page.close();
}

// ============================================================
// (C) apply-settings受信後、encoding/lineEnding無しのnew-documentは設定由来の既定値へ倒れる
// ============================================================
{
  const page = await newBridgedPage();
  await page.evaluate(() => window.__reply({
    type: "apply-settings",
    defaultEncoding: "utf8bom", defaultLineEnding: "lf",
    recentFiles: [], displayMode: "window",
  }));
  await page.waitForTimeout(200);
  await page.evaluate(() => window.__reply({ type: "new-document" }));
  await page.waitForTimeout(300);
  ok(`(C) encoding無しのnew-documentは設定のdefaultEncoding(UTF-8 (BOM付き))へ倒れる (実際="${await encodingText(page)}")`,
    (await encodingText(page)).includes("UTF-8 (BOM付き)"));
  ok(`(C) lineEnding無しのnew-documentは設定のdefaultLineEnding(LF)へ倒れる (実際="${await lineEndingText(page)}")`,
    (await lineEndingText(page)).includes("改行コード: LF"));
  await page.close();
}

// ============================================================
// (D) apply-settingsが一度も届いていない状態でencoding/lineEnding無しのnew-documentが届いても
//     最終フォールバックのUTF-8/CRLFになる(空にならない)
// ============================================================
{
  const page = await newBridgedPage();
  await page.evaluate(() => window.__reply({ type: "new-document" }));
  await page.waitForTimeout(300);
  ok(`(D) 設定未受信でも文字コードが空にならずUTF-8になる (実際="${await encodingText(page)}")`, (await encodingText(page)).includes("文字コード: UTF-8"));
  ok(`(D) 設定未受信でも改行コードが空にならずCRLFになる (実際="${await lineEndingText(page)}")`, (await lineEndingText(page)).includes("改行コード: CRLF"));
  await page.close();
}

// ============================================================
// (E) ステータスバーから明示的に変更した値は保持され、その後のapply-settingsで上書きされない
// ============================================================
{
  const page = await newBridgedPage();
  await page.evaluate(() => window.__reply({ type: "new-document", encoding: "UTF-8", lineEnding: "CRLF" }));
  await page.waitForTimeout(300);

  await clearSent(page);
  await page.click("#status-encoding");
  await page.waitForTimeout(200);
  const encMsg = await lastMsg(page, "open-context-menu");
  const sjisItem = findItem(encMsg?.items, "Shift_JIS");
  await page.evaluate((id) => window.__reply({ type: "menu-command", id }), sjisItem.id);
  await page.waitForTimeout(200);
  await page.evaluate(() => window.__reply({ type: "menu-closed", menu: "__context__" }));
  ok(`(E) クリックで選んだ文字コード(Shift_JIS)が表示に反映される (実際="${await encodingText(page)}")`, (await encodingText(page)).includes("Shift_JIS"));

  await clearSent(page);
  await page.click("#status-line-ending");
  await page.waitForTimeout(200);
  const leMsg = await lastMsg(page, "open-context-menu");
  const lfItem = findItem(leMsg?.items, "LF");
  await page.evaluate((id) => window.__reply({ type: "menu-command", id }), lfItem.id);
  await page.waitForTimeout(200);
  await page.evaluate(() => window.__reply({ type: "menu-closed", menu: "__context__" }));
  ok(`(E) クリックで選んだ改行コード(LF)が表示に反映される (実際="${await lineEndingText(page)}")`, (await lineEndingText(page)).includes("改行コード: LF"));

  // 明示変更後にapply-settingsが別の既定値で届いても、明示変更した値を優先し上書きしない
  await page.evaluate(() => window.__reply({
    type: "apply-settings",
    defaultEncoding: "utf16le", defaultLineEnding: "crlf",
    recentFiles: [], displayMode: "window",
  }));
  await page.waitForTimeout(200);
  ok(`(E) 明示変更後の文字コードは設定変更で上書きされない (実際="${await encodingText(page)}")`, (await encodingText(page)).includes("Shift_JIS"));
  ok(`(E) 明示変更後の改行コードは設定変更で上書きされない (実際="${await lineEndingText(page)}")`, (await lineEndingText(page)).includes("改行コード: LF"));

  await page.close();
}

// ============================================================
// (F) 無題かつ未編集の文書は、設定変更(apply-settings)のdefaultEncoding/defaultLineEndingに追従する
// ============================================================
{
  const page = await newBridgedPage();
  await page.evaluate(() => window.__reply({ type: "new-document", encoding: "UTF-8", lineEnding: "CRLF" }));
  await page.waitForTimeout(300);
  ok(`(F) 変更前は既定のUTF-8/CRLF (実際="${await encodingText(page)}" / "${await lineEndingText(page)}")`,
    (await encodingText(page)).includes("UTF-8") && (await lineEndingText(page)).includes("CRLF"));

  await page.evaluate(() => window.__reply({
    type: "apply-settings",
    defaultEncoding: "shiftjis", defaultLineEnding: "lf",
    recentFiles: [], displayMode: "window",
  }));
  await page.waitForTimeout(200);
  ok(`(F) 未編集の無題文書は設定変更(Shift_JIS)に追従する (実際="${await encodingText(page)}")`, (await encodingText(page)).includes("Shift_JIS"));
  ok(`(F) 未編集の無題文書は設定変更(LF)に追従する (実際="${await lineEndingText(page)}")`, (await lineEndingText(page)).includes("改行コード: LF"));

  await page.close();
}

// ============================================================
// (H) ステータスバーの幅対応: 畳む順序・高さ上限・設定ボタン削除・Ctrl+,
// ============================================================
{
  const page = await newBridgedPage();
  // ラベル省略(compact)・値ごと非表示(hidden)の両方がはっきり判別できるよう、
  // ラベルを含むフル文字列がある程度長い組み合わせで開く。
  await page.evaluate(() => window.__reply({
    type: "new-document", encoding: "UTF-8 (BOM付き)", lineEnding: "CRLF",
  }));
  await page.waitForTimeout(200);
  // 文字数・折り返し表示も畳む順序の対象に含めるため、少し入力しておく。
  await page.click(".cm-content");
  await page.keyboard.type("テスト入力です");
  await page.waitForTimeout(200);

  ok("(H) #btn-settingsが存在しない(ステータスバーの設定ボタンは削除済み)", (await page.$("#btn-settings")) === null);

  await page.setViewportSize({ width: 1100, height: 900 });
  await page.waitForTimeout(200);

  const snapshot = () => page.evaluate(() => {
    const g = (id) => document.getElementById(id);
    const sb = g("statusbar").getBoundingClientRect();
    const cm = g("cm-host").getBoundingClientRect();
    const textIfVisible = (id) => (g(id)?.hidden ? null : (g(id)?.textContent ?? ""));
    return {
      height: sb.height,
      overlap: cm.bottom > sb.top + 0.5,
      lineEndingText: textIfVisible("status-line-ending"),
      encodingText: textIfVisible("status-encoding"),
      zoomHidden: !!g("status-zoom")?.hidden,
      positionHidden: !!g("status-position")?.hidden,
      countHidden: !!g("status-count")?.hidden,
      wrapHidden: !!g("status-wrap")?.hidden,
      lineEndingHidden: !!g("status-line-ending")?.hidden,
      encodingHidden: !!g("status-encoding")?.hidden,
    };
  });

  // ユーザー指定の畳む順序(src/main.js STATUS_FIT_STAGES)どおりに1つずつ検出する。
  // 1回の幅ステップで複数段階を一気に通過することがあっても、このチェック自体を
  // STATUS_FIT_STAGESと同じ順で行うことで、seenへ積まれる順序が実際の優先順位からは
  // ずれないようにしている。
  const EVENTS = [
    "lineEndingCompact", "encodingCompact", "zoomHidden", "positionHidden",
    "countHidden", "wrapHidden", "lineEndingHidden", "encodingHidden",
  ];
  const seen = [];
  let maxHeight = 0;
  let overlapFound = false;
  for (let w = 1100; w >= 150; w -= 10) {
    await page.setViewportSize({ width: w, height: 900 });
    await page.waitForTimeout(60);
    const cur = await snapshot();
    maxHeight = Math.max(maxHeight, cur.height);
    if (cur.overlap) overlapFound = true;
    if (!seen.includes("lineEndingCompact") && cur.lineEndingText !== null && cur.lineEndingText !== "" && !cur.lineEndingText.startsWith("改行コード: "))
      seen.push("lineEndingCompact");
    if (!seen.includes("encodingCompact") && cur.encodingText !== null && cur.encodingText !== "" && !cur.encodingText.startsWith("文字コード: "))
      seen.push("encodingCompact");
    if (!seen.includes("zoomHidden") && cur.zoomHidden) seen.push("zoomHidden");
    if (!seen.includes("positionHidden") && cur.positionHidden) seen.push("positionHidden");
    if (!seen.includes("countHidden") && cur.countHidden) seen.push("countHidden");
    if (!seen.includes("wrapHidden") && cur.wrapHidden) seen.push("wrapHidden");
    if (!seen.includes("lineEndingHidden") && cur.lineEndingHidden) seen.push("lineEndingHidden");
    if (!seen.includes("encodingHidden") && cur.encodingHidden) seen.push("encodingHidden");
  }
  ok(`(H) 幅を狭めてもステータスバーの高さが24pxを超えない (最大=${maxHeight})`, maxHeight <= 24.5);
  ok("(H) 幅を狭めても本文エリア(#cm-host)と重ならない", !overlapFound);
  ok(`(H) 畳まれる順序が指定どおり(改行ラベル→文字コードラベル→拡大率→行列→文字数→折り返し→改行コード→文字コード) ${JSON.stringify(seen)}`,
    JSON.stringify(seen) === JSON.stringify(EVENTS));

  // ---- 幅を戻すと全項目が復元される ----
  await page.setViewportSize({ width: 1100, height: 900 });
  await page.waitForTimeout(200);
  const restored = await snapshot();
  ok("(H) 幅を戻すと文字コード・改行コードにラベルが戻る",
    !!restored.lineEndingText?.startsWith("改行コード: ") && !!restored.encodingText?.startsWith("文字コード: "));
  ok("(H) 幅を戻すと拡大率・行列・文字数・折り返しが再表示される",
    !restored.zoomHidden && !restored.positionHidden && !restored.countHidden && !restored.wrapHidden);

  // ---- Ctrl+,で設定を開く操作は引き続き効く(ブリッジありなのでopen-settings-windowを送る。
  //      設定ボタンを削除しても、メニューバーの歯車ボタンとこのショートカットで入口は残る) ----
  await clearSent(page);
  await page.click(".cm-content");
  await page.keyboard.press("Control+Comma");
  await page.waitForTimeout(300);
  const openSettingsMsg = await lastMsg(page, "open-settings-window");
  ok("(H) Ctrl+,でopen-settings-windowが送られる(設定ボタン削除後も設定を開く手段が残っている)", !!openSettingsMsg);

  await page.close();
}

console.log("--- ページエラー:", JSON.stringify(allErrors));
console.log("--- コンソールエラー:", JSON.stringify(allConsoleErrors));
ok("(G) ページエラーが0件", allErrors.length === 0);
ok("(G) コンソールエラーが0件", allConsoleErrors.length === 0);

console.log(`\n合計: OK=${okCount} NG=${ngCount}`);
await browser.close();
process.exit(ngCount > 0 ? 1 : 0);
