// 状態管理の競合調査で実際に再現した5件のバグの検証スクリプト。ポートは8169。
// 「状態管理の競合調査バグ修正」対応の再現手順をそのままテスト化し、修正後にNG 0件に
// なることを確認する。あわせて、競合が起きない通常の操作(正常系)が従来どおり動くことも
// 確認する(N1〜N5)。
//
// 構成:
//   (1) カラーピッカーを開いたまま編集すると文書が壊れる(最優先・データ破壊)
//   (2) 表の行/列操作を連続実行すると1回のアンドゥで全部戻る
//   (3) 言語の非同期ロード中にタブを切り替えると別タブが壊れる(タブ汚染)
//   (4) ファイルを連続で開くと後から開いた内容が消える(内容の上書き)
//   (5) モード切替時に未処理の例外が出る(ログ汚染)
//   (N1)〜(N5) 正常系: 競合が起きない通常操作が従来どおり動く
//   最後にページエラー・コンソールエラーが全体で0件であることを確認する
import pw from "playwright";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const { chromium } = pw;
const PORT = 8169;
const BASE = `http://localhost:${PORT}/index.html`;
const DIST_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "dist");

const browser = await chromium.launch();
const allErrors = [];
const allConsoleErrors = [];
let okCount = 0, ngCount = 0;
const ok = (label, cond) => { console.log(`${cond ? "OK  " : "NG  "} ${label}`); if (cond) okCount++; else ngCount++; };
const errCount = () => allErrors.length + allConsoleErrors.length;

// ---- dist/ から「言語ID→動的import先のチャンクファイル名」を逆引きする ----
// src/file-types.js の load: () => import("...") はesbuildによりコンテンツハッシュ付きの
// チャンクファイルへ変換される(ファイル名はビルドのたび変わりうる)ため、ハードコードせず
// ビルド後のdist/を実際に読んで求める。
function findLangChunkFile(langId) {
  const files = fs.readdirSync(DIST_DIR).filter((f) => f.endsWith(".js"));
  for (const f of files) {
    const content = fs.readFileSync(path.join(DIST_DIR, f), "utf8");
    // 圧縮(minify)後は `id: "python"` の空白が消えて `id:"python"` になる。
    // どちらの書き方でも拾えるよう正規表現で探す。
    const marker = new RegExp(`id:\\s*"${langId}"`);
    const markerMatch = marker.exec(content);
    if (!markerMatch) continue;
    const markerIdx = markerMatch.index;
    const windowText = content.slice(markerIdx, markerIdx + 500);
    // 圧縮後は load の値が keepNames のラッパー(t(()=>import(...),"load"))で包まれるため、
    // "load:" に続く形を決め打ちにせず、その付近にある動的importの行き先を拾う。
    const m = windowText.match(/import\("\.\/([^"]+)"\)/);
    if (m) return m[1];
  }
  throw new Error(`言語 ${langId} の動的importチャンクが見つかりません`);
}
const PYTHON_CHUNK = findLangChunkFile("python");

// 指定チャンクファイルへのリクエストを遅延させる(言語ロードの遅延を再現する)。
async function delayChunk(page, chunkFile, ms) {
  await page.route(`**/${chunkFile}`, async (route) => {
    await new Promise((r) => setTimeout(r, ms));
    await route.continue();
  });
}

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

// ブリッジをモックしない(=window.__paneDebugEditorが公開される)プレーンなページ。
// カラーピッカー・表操作等、editor.js内部APIを直接叩くテストで使う。
async function newPage() {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.on("pageerror", (e) => allErrors.push(String(e.stack || e)));
  page.on("console", (m) => { if (m.type() === "error") allConsoleErrors.push(m.text()); });
  await page.goto(BASE, { waitUntil: "load" });
  await page.waitForSelector(".cm-content", { timeout: 15000 });
  await page.waitForTimeout(250);
  return page;
}
// ブリッジをモックしたページ(C#側からのメッセージをwindow.__reply()で流し込める)。
// file-opened/open-in-tab/apply-settings等、main.js側のメッセージハンドラを検証するテストで使う。
async function newBridgedPage() {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.on("pageerror", (e) => allErrors.push(String(e.stack || e)));
  page.on("console", (m) => { if (m.type() === "error") allConsoleErrors.push(m.text()); });
  await page.addInitScript(installMockBridge);
  await page.goto(BASE, { waitUntil: "load" });
  await page.waitForSelector(".cm-content", { timeout: 15000 });
  await page.waitForTimeout(250);
  return page;
}
async function reply(page, msg) {
  await page.evaluate((m) => window.__reply(m), msg);
}
async function applySettings(page, partial) {
  await reply(page, { type: "apply-settings", ...partial });
  await page.waitForTimeout(200);
}
async function docText(page) {
  return page.$$eval(".cm-content .cm-line", (els) => els.map((e) => e.textContent).join("\n"));
}
async function tabCount(page) {
  return page.$$eval(".tab-item", (els) => els.length);
}
async function setCode(page, text, filename = "sample.css") {
  await page.evaluate((filename) => window.__paneDebugEditor.setFileMode(filename, "code"), filename);
  await page.waitForTimeout(150);
  await page.evaluate((t) => window.__paneDebugEditor.setValue(t), text);
  await page.waitForTimeout(150);
}
async function setMarkdown(page, text) {
  await page.evaluate(() => window.__paneDebugEditor.setFileMode("note.md", "markdown"));
  await page.waitForTimeout(150);
  await page.evaluate((t) => window.__paneDebugEditor.setValue(t), text);
  await page.waitForTimeout(150);
}
async function openPickerAt(page, needle, cursorOffset = 1) {
  return page.evaluate(({ needle, cursorOffset }) => {
    const text = window.__paneDebugEditor.getValue();
    const idx = text.indexOf(needle);
    if (idx < 0) return null;
    const lit = window.__paneDebugEditor.getColorLiteralAt(idx + cursorOffset);
    if (!lit) return null;
    const opened = window.__paneDebugEditor.openColorPicker(lit.from, lit.to, lit.text);
    return { lit, opened };
  }, { needle, cursorOffset });
}
function tableLineCount(text) {
  return text.split("\n").filter((l) => l.trim().startsWith("|")).length;
}

// ============================================================
// (1) 【最優先・データ破壊】カラーピッカーを開いたまま編集すると文書が壊れる
// ============================================================
{
  const page = await newPage();
  const SRC = "a { color: #ff0000; } b { color: #00ff00; }";
  await setCode(page, SRC);
  const r = await openPickerAt(page, "#ff0000");
  ok(`(1-前提) カラーピッカーが開く: ${JSON.stringify(r)}`, r?.opened === true);
  ok(`(1-前提) 座標は仕様書どおり11..18: ${JSON.stringify(r?.lit)}`, r?.lit?.from === 11 && r?.lit?.to === 18);

  // パネルを開いたまま、先頭に別の編集(通常のuserEvent付き・履歴に残る本物の編集)を行う。
  await page.evaluate(() => {
    window.__paneDebugEditor.view.dispatch({ changes: { from: 0, to: 0, insert: "/* inserted */\n" } });
  });
  await page.waitForTimeout(100);

  // パネルで色を確定する(#ff0000 → #0000ff)。
  await page.fill('input[data-ch="hex"]', "0000ff");
  await page.waitForTimeout(100);
  await page.click(".cp-apply");
  await page.waitForTimeout(200);

  const finalText = await page.evaluate(() => window.__paneDebugEditor.getValue());
  const expected = "/* inserted */\na { color: #0000ff; } b { color: #00ff00; }";
  ok(`(1) パネルを開いたまま先頭に編集があっても文書が壊れない: ${JSON.stringify(finalText)}`, finalText === expected);
  const panelGone = (await page.$$(".color-picker-panel")).length === 0;
  ok("(1) 確定後パネルは閉じる", panelGone);
  await page.close();
}

// ============================================================
// (1b) カラーピッカー: 編集で対象が消えた場合は書き込まずパネルを閉じる
// ============================================================
{
  const page = await newPage();
  const SRC = "a { color: #ff0000; }";
  await setCode(page, SRC);
  const r = await openPickerAt(page, "#ff0000");
  ok(`(1b-前提) カラーピッカーが開く`, r?.opened === true);
  // パネルを開いたまま対象の色リテラル自体を消す(全選択して空にする → 対象が消滅)。
  await page.evaluate(() => {
    window.__paneDebugEditor.view.dispatch({ changes: { from: 0, to: window.__paneDebugEditor.getValue().length, insert: "" } });
  });
  await page.waitForTimeout(100);
  await page.fill('input[data-ch="hex"]', "112233");
  await page.waitForTimeout(100);
  const panelStillOpenAfterEdit = (await page.$$(".color-picker-panel")).length;
  // 対象喪失を検知した時点でパネルは強制的に閉じられているはず。
  await page.waitForTimeout(100);
  const panelAfter = (await page.$$(".color-picker-panel")).length;
  const finalText = await page.evaluate(() => window.__paneDebugEditor.getValue());
  ok(`(1b) 対象が編集で消えたらパネルが閉じ、それ以上書き込まれない(panel=${panelAfter}, doc=${JSON.stringify(finalText)})`,
    panelAfter === 0 && finalText === "");
  await page.close();
}

// ============================================================
// (2) 【アンドゥの粒度】表の行/列操作を連続実行すると1回のアンドゥで全部戻る
// ============================================================
{
  const page = await newPage();
  const TABLE = "| A | B |\n| --- | --- |\n| a1 | b1 |\n";
  await setMarkdown(page, TABLE);
  const before = tableLineCount(await page.evaluate(() => window.__paneDebugEditor.getValue()));

  await page.evaluate(() => {
    const e = window.__paneDebugEditor;
    e.applyAction("tableInsertRowBelow", { bodyIndex: 0 });
    e.applyAction("tableInsertRowBelow", { bodyIndex: 0 });
    e.applyAction("tableInsertRowBelow", { bodyIndex: 0 });
  });
  await page.waitForTimeout(150);
  const afterInsert = await page.evaluate(() => window.__paneDebugEditor.getValue());
  ok(`(2-前提) 3回連続実行で3行増える(${before}→${tableLineCount(afterInsert)})`, tableLineCount(afterInsert) === before + 3);

  await page.evaluate(() => window.__paneDebugEditor.applyAction("undo"));
  await page.waitForTimeout(150);
  const afterUndo1 = await page.evaluate(() => window.__paneDebugEditor.getValue());
  ok(`(2) 1回のアンドゥで直前の1回だけ取り消される(残り行数=${tableLineCount(afterUndo1)})`, tableLineCount(afterUndo1) === before + 2);

  await page.evaluate(() => window.__paneDebugEditor.applyAction("undo"));
  await page.evaluate(() => window.__paneDebugEditor.applyAction("undo"));
  await page.waitForTimeout(150);
  const afterUndo3 = await page.evaluate(() => window.__paneDebugEditor.getValue());
  ok(`(2) さらに2回アンドゥすると元の表に戻る: ${JSON.stringify(afterUndo3)}`, afterUndo3 === TABLE);
  await page.close();
}

// ============================================================
// (2b) applyMdActionの他アクション(表以外)も1操作=1アンドゥになっている(見出しレベル変更)
// ============================================================
{
  const page = await newPage();
  await setMarkdown(page, "# 見出し1\n\n本文\n");
  await page.evaluate(() => {
    const e = window.__paneDebugEditor;
    e.view.dispatch({ selection: { anchor: 2 } }); // "見出し1"の行にカーソル
    e.applyAction("headingDown"); // # → ##
    e.applyAction("headingDown"); // ## → ###
  });
  await page.waitForTimeout(150);
  const afterTwo = await page.evaluate(() => window.__paneDebugEditor.getValue());
  ok(`(2b-前提) 見出しレベルを2回下げると###になる: ${JSON.stringify(afterTwo)}`, afterTwo.startsWith("### 見出し1"));
  await page.evaluate(() => window.__paneDebugEditor.applyAction("undo"));
  await page.waitForTimeout(150);
  const afterUndo = await page.evaluate(() => window.__paneDebugEditor.getValue());
  ok(`(2b) 1回のアンドゥで直前の1回だけ取り消される: ${JSON.stringify(afterUndo)}`, afterUndo.startsWith("## 見出し1"));
  await page.close();
}

// ============================================================
// (3) 【タブ汚染】言語の非同期ロード中にタブを切り替えると別タブが壊れる
// ============================================================
{
  const page = await newBridgedPage();
  await delayChunk(page, PYTHON_CHUNK, 1200);
  await applySettings(page, { displayMode: "tab" });
  // displayMode:"tab"を有効にした時点で、現在の文書(無題)が最初のタブになる。
  ok(`(3-前提) displayMode:tab化で最初のタブ(無題)ができる(タブ数=${await tabCount(page)})`, (await tabCount(page)) === 1);

  await reply(page, {
    type: "open-in-tab", fileName: "a.py", path: "C:\\work\\a.py", text: "print('hi')\n",
    encoding: "UTF-8", lineEnding: "CRLF", readOnly: false,
  });
  await page.waitForTimeout(200); // .pyの言語チャンクはまだロード中
  // タブ順序: [0]=最初からあった無題タブ, [1]=今開いた.pyタブ(アクティブ)
  ok(`(3-前提) .pyタブが開いてアクティブ(タブ数=${await tabCount(page)})`, (await tabCount(page)) === 2);

  // ロード完了前に新規タブ(無題Markdown、[2]番目)へ切替
  await page.click("#tabbar-new");
  await page.waitForTimeout(200);
  ok(`(3-前提) 新規タブが増える(タブ数=${await tabCount(page)})`, (await tabCount(page)) === 3);

  // 新規タブへ見出しを入力(ライブプレビューが有効ならMarkdownの"#"は非表示のはず)。
  // 入力直後はカーソルがその見出し行上にあり、見出し行だけは意図的に生表示になる
  // (ライブプレビューの仕様: カーソルが乗っている範囲は記法を隠さない)ため、
  // Enterで次行へ移り、見出し行からカーソルを外してから判定する。
  await page.click(".cm-content");
  await page.keyboard.type("# 見出し");
  await page.keyboard.press("Enter");
  await page.keyboard.type("本文");
  await page.waitForTimeout(150);

  // .pyの言語ロード完了を待つ(1.2秒+バッファ)
  await page.waitForTimeout(1400);

  const newTabRaw = await page.$eval(".cm-content", (el) => el.innerText);
  ok(`(3) 別タブ(新規タブ)のライブプレビュー装飾が消えない(見出し行の"#"が非表示のまま): ${JSON.stringify(newTabRaw)}`,
    !newTabRaw.includes("#"));
  const statusNewTab = await page.textContent("#status-mode");
  ok(`(3) 新規タブのステータスはMarkdownのまま(壊れていない): ${statusNewTab}`, statusNewTab === "Markdown");

  // 元の.pyタブ([1]番目)へ戻る
  await page.locator(".tab-item").nth(1).click();
  await page.waitForTimeout(400); // 戻った時点での再解決(resolveTabFileMode)を待つ
  const statusPyTab = await page.textContent("#status-mode");
  ok(`(3) .pyタブへ戻ると最終的にコード(Python)に確定する: ${statusPyTab}`, statusPyTab === "コード (Python)");
  const pyDoc = await docText(page);
  ok(`(3) .pyタブの内容自体は保たれている: ${JSON.stringify(pyDoc)}`, pyDoc.includes("print"));

  await page.close();
}

// ============================================================
// (4) 【内容の上書き】ファイルを連続で開くと後から開いた内容が消える
// ============================================================
{
  const page = await newBridgedPage();
  await delayChunk(page, PYTHON_CHUNK, 1000);

  await reply(page, {
    type: "file-opened", fileName: "a.py", path: "C:\\work\\a.py", text: "print('a')\n",
    encoding: "Shift_JIS", lineEnding: "LF", readOnly: true,
  });
  await page.waitForTimeout(100); // 100ms後、a.pyの言語ロード完了前にb.mdを開く
  await reply(page, {
    type: "file-opened", fileName: "b.md", path: "C:\\work\\b.md", text: "# B\n",
    encoding: "UTF-8", lineEnding: "CRLF", readOnly: false,
  });
  await page.waitForTimeout(200);
  const midDoc = await docText(page);
  ok(`(4-前提) b.mdが正しく表示される: ${JSON.stringify(midDoc)}`, midDoc.includes("B"));

  // a.pyの遅延ロードが解決するのを待つ
  await page.waitForTimeout(1200);

  const finalDoc = await docText(page);
  const finalEncoding = await page.textContent("#status-encoding");
  const finalLineEnding = await page.textContent("#status-line-ending");
  const finalMode = await page.textContent("#status-mode");
  const finalEditable = await page.$eval(".cm-content", (el) => el.getAttribute("contenteditable"));
  ok(`(4) b.mdの内容が後からa.pyの内容で上書きされない: ${JSON.stringify(finalDoc)}`,
    finalDoc.includes("B") && !finalDoc.includes("print"));
  ok(`(4) 文字コード表示もb.mdのまま(a.pyに巻き戻らない): ${finalEncoding}`, finalEncoding.includes("UTF-8"));
  ok(`(4) 改行コード表示もb.mdのまま: ${finalLineEnding}`, finalLineEnding.includes("CRLF"));
  ok(`(4) モード表示もMarkdownのまま: ${finalMode}`, finalMode === "Markdown");
  ok(`(4) 読み取り専用(a.py由来)に巻き戻っていない(contenteditable=${finalEditable})`, finalEditable !== "false");
  await page.close();
}

// ============================================================
// (5) 【ログ汚染】モード切替時に未処理の例外が出る
// ============================================================
{
  const page = await newBridgedPage();
  const before = errCount();
  await page.click(".cm-content");
  await page.keyboard.type("hello");
  // 直後(間を置かず)にMarkdown以外(.txt)のファイルを開く
  await reply(page, {
    type: "file-opened", fileName: "note.txt", path: "C:\\work\\note.txt", text: "plain\n",
    encoding: "UTF-8", lineEnding: "CRLF", readOnly: false,
  });
  // CodeMirror本体のupdateForFocusChangeは10ms後にsetTimeoutで動くため、それを跨いで待つ
  await page.waitForTimeout(300);
  // 実害が軽微(入力自体は続く)ことも確認する
  await page.click(".cm-content");
  await page.keyboard.type("more");
  await page.waitForTimeout(200);
  const after = errCount();
  ok(`(5) モード切替時に未処理の例外(RangeError等)が出ない(新規${after - before}件)`, after === before);
  ok("(5) 入力自体は継続できる", (await docText(page)).includes("more"));
  await page.close();
}

// ============================================================
// (N1)〜(N5) 正常系: 競合が起きない通常の操作は従来どおり動く
// ============================================================
// (N1) カラーピッカーの通常操作(競合なし): パレットクリックで確定→1回のアンドゥで戻る
{
  const page = await newPage();
  await setCode(page, "a { color: #14599f; }\nb { color: blue; }\n");
  const r = await openPickerAt(page, "#14599f");
  ok("(N1-前提) パネルが開く", r?.opened === true);
  await page.waitForTimeout(150);
  await page.click(".cp-palette-swatch");
  await page.waitForTimeout(150);
  const afterClick = await page.evaluate(() => window.__paneDebugEditor.getValue());
  ok(`(N1) パレットクリックで確定してパネルが閉じる: ${JSON.stringify(afterClick)}`,
    afterClick !== "a { color: #14599f; }\nb { color: blue; }\n" && (await page.$$(".color-picker-panel")).length === 0);
  await page.evaluate(() => window.__paneDebugEditor.applyAction("undo"));
  await page.waitForTimeout(150);
  const afterUndo = await page.evaluate(() => window.__paneDebugEditor.getValue());
  ok(`(N1) 1回のアンドゥで開いた時の色に戻る: ${JSON.stringify(afterUndo)}`,
    afterUndo === "a { color: #14599f; }\nb { color: blue; }\n");
  await page.close();
}

// (N2) 表の単発操作(競合なし): 1回実行→1回アンドゥで元に戻る
{
  const page = await newPage();
  const TABLE = "| A | B |\n| --- | --- |\n| a1 | b1 |\n";
  await setMarkdown(page, TABLE);
  await page.evaluate(() => window.__paneDebugEditor.applyAction("tableInsertRowBelow", { bodyIndex: 0 }));
  await page.waitForTimeout(150);
  const afterInsert = await page.evaluate(() => window.__paneDebugEditor.getValue());
  ok(`(N2-前提) 1回実行で1行増える`, tableLineCount(afterInsert) === tableLineCount(TABLE) + 1);
  await page.evaluate(() => window.__paneDebugEditor.applyAction("undo"));
  await page.waitForTimeout(150);
  const afterUndo = await page.evaluate(() => window.__paneDebugEditor.getValue());
  ok(`(N2) 1回のアンドゥで元の表に戻る: ${JSON.stringify(afterUndo)}`, afterUndo === TABLE);
  await page.close();
}

// (N3) 通常のタブ切替(競合なし): 内容がタブごとに保たれる
{
  const page = await newBridgedPage();
  await applySettings(page, { displayMode: "tab" });
  await page.click(".cm-content");
  await page.keyboard.type("Hello");
  await page.waitForTimeout(150);
  await page.click("#tabbar-new");
  await page.waitForTimeout(200);
  await page.click(".cm-content");
  await page.keyboard.type("World");
  await page.waitForTimeout(150);
  await page.locator(".tab-item").nth(0).click();
  await page.waitForTimeout(150);
  const tab1Text = await docText(page);
  await page.locator(".tab-item").nth(1).click();
  await page.waitForTimeout(150);
  const tab2Text = await docText(page);
  ok(`(N3) 通常のタブ切替では内容がタブごとに保たれる(tab1=${JSON.stringify(tab1Text)}, tab2=${JSON.stringify(tab2Text)})`,
    tab1Text === "Hello" && tab2Text === "World");
  await page.close();
}

// (N4) 通常のファイルを開く(競合なし): 内容・モードが正しく反映される
{
  const page = await newBridgedPage();
  await reply(page, {
    type: "file-opened", fileName: "plain.py", path: "C:\\work\\plain.py", text: "print(1)\n",
    encoding: "UTF-8", lineEnding: "CRLF", readOnly: false,
  });
  await page.waitForTimeout(400);
  const text = await docText(page);
  const mode = await page.textContent("#status-mode");
  ok(`(N4) 通常のファイルオープンで内容が反映される: ${JSON.stringify(text)}`, text.includes("print"));
  ok(`(N4) モードも正しくコード(Python)になる: ${mode}`, mode === "コード (Python)");
  await page.close();
}

// (N5) 通常のフォーカス変化(モード切替を伴わない)ではエラーが出ない
{
  const page = await newBridgedPage();
  const before = errCount();
  await page.click(".cm-content");
  await page.keyboard.type("focus test");
  await page.mouse.click(5, 5); // 本文の外をクリックしてフォーカスを外す(blur)
  await page.waitForTimeout(200);
  await page.click(".cm-content");
  await page.waitForTimeout(200);
  const after = errCount();
  ok(`(N5) 通常のフォーカス変化ではエラーが出ない(新規${after - before}件)`, after === before);
  await page.close();
}

// ============================================================
// ページエラー・コンソールエラーが全体で0件
// ============================================================
ok(`ページエラー・コンソールエラー0件(合計${errCount()}件) ${JSON.stringify([...allErrors, ...allConsoleErrors]).slice(0, 3000)}`,
  errCount() === 0);

console.log(`\n合計: OK ${okCount} / NG ${ngCount}`);
await browser.close();
process.exit(ngCount === 0 ? 0 : 1);
