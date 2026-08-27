// バグチェック③(複数行を選択しても段落系の操作が先頭行にしか効かない)の実ブラウザ検証。
// ポートは8198。
//
// 原因: src/editor.js の linePrefix()(applyMdAction内)・convertListType()・
// indent/outdentの各caseが、いずれも選択開始行(state.doc.lineAt(state.selection.main.from)
// または同main.from)だけを対象にしており、複数行選択の残りの行を無視していた。
//
// 検証項目(依頼より):
//   - 3行選択して箇条書き/番号付きリスト/引用/見出し/インデント/アウトデントを実行すると
//     3行すべてに適用されること
//   - 番号付きリストは選択範囲内で連番(1. 2. 3.)になること
//   - トグルの判定: 選択範囲がすべて該当形式なら解除、そうでなければ全部その形式にする
//   - 複数行への適用が1回のdispatchにまとまっており、Ctrl+Z 1回で操作全体が戻ること
//   - 選択範囲が操作後も保たれること
//   - 選択の終端がちょうど行頭にある場合はその行を含めない(一般的なエディタの作法)
//   - 右クリックメニュー経由(para.listBullet/listOrdered/listCheck、convertListType側)でも
//     同じく複数行に効くこと
//   - 単一行(カーソルのみ、選択なし)では従来どおり1行だけに効く(退行していないこと)
import pw from "playwright";
const { chromium } = pw;
const browser = await chromium.launch();
const PORT = 8198;
const errors = [];
let okCount = 0, ngCount = 0;
const ok = (l, c) => { console.log(`${c ? "OK  " : "NG  "} ${l}`); if (c) okCount++; else ngCount++; };

async function newBridgedPage() {
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
  await page.goto(`http://localhost:${PORT}/index.html`);
  await page.waitForTimeout(700);
  return page;
}
async function newDoc(page) {
  await page.evaluate(() => window.__reply({ type: "new-document" }));
  await page.waitForTimeout(200);
}
async function typeText(page, text) {
  await page.click(".cm-content");
  await page.keyboard.type(text, { delay: 2 });
  await page.waitForTimeout(150);
}
// 実際の文書テキスト(ライブプレビューでウィジェットに置き換わる前の生テキスト)を取り出す。
// Ctrl+Aで全選択してからcopyイベントを合成発火させる(.verify-editorsettings.mjsの
// rawLineText()と同じ「copyイベントを合成する」考え方。選択がある場合はCodeMirror本体の
// 既定のcopyハンドラがstate.sliceDoc()の結果をそのままclipboardDataへ入れる)。
async function rawDocText(page) {
  await page.keyboard.press("Control+a");
  await page.waitForTimeout(80);
  return page.evaluate(() => {
    const dt = new DataTransfer();
    const ev = new ClipboardEvent("copy", { clipboardData: dt, bubbles: true, cancelable: true });
    document.querySelector(".cm-content").dispatchEvent(ev);
    return dt.getData("text/plain");
  });
}
// 「牛乳」〜「パン」の3行(先頭行を除く)をちょうど全部選択する: 2行目行頭→4行目行末。
async function selectLines2to4(page) {
  await page.keyboard.press("Control+Home");
  await page.keyboard.press("ArrowDown"); // 2行目(牛乳)の行頭へ
  await page.keyboard.down("Shift");
  await page.keyboard.press("ArrowDown"); // 3行目(卵)
  await page.keyboard.press("ArrowDown"); // 4行目(パン)行頭
  await page.keyboard.press("End");       // 4行目の行末まで伸ばす(行を含めるため)
  await page.keyboard.up("Shift");
  await page.waitForTimeout(100);
}
async function isSelectionActive(page) {
  return page.evaluate(() => !window.getSelection().isCollapsed);
}

const BASE_LIST_TEXT = "買い物リスト\n牛乳\n卵\nパン";

// ================= (1) 箇条書きリスト(para.list, Ctrl+Shift+]) =================
{
  const page = await newBridgedPage();
  await newDoc(page);
  await typeText(page, BASE_LIST_TEXT);
  await selectLines2to4(page);
  const selBefore = await isSelectionActive(page);
  ok(`(1) 前提: 3行が選択されている: ${selBefore}`, selBefore === true);

  await page.keyboard.press("Control+Shift+BracketRight"); // Ctrl+Shift+]
  await page.waitForTimeout(150);
  const text1 = await rawDocText(page);
  ok(`(1) 3行すべてに"- "が付く: ${JSON.stringify(text1)}`,
    text1 === "買い物リスト\n- 牛乳\n- 卵\n- パン");

  const selAfter = await isSelectionActive(page);
  ok(`(1) 操作後も選択範囲が保たれる: ${selAfter}`, selAfter === true);

  // トグル: 対象3行がすべて箇条書きになった状態でもう一度押すと全部解除される
  await selectLines2to4(page);
  await page.keyboard.press("Control+Shift+BracketRight");
  await page.waitForTimeout(150);
  const text1b = await rawDocText(page);
  ok(`(1) トグル: 全行が該当形式なら解除される: ${JSON.stringify(text1b)}`,
    text1b === "買い物リスト\n牛乳\n卵\nパン");

  // Ctrl+Z 1回で「解除」操作全体が戻る(1回のdispatchにまとまっていることの確認)
  await page.keyboard.press("Control+z");
  await page.waitForTimeout(150);
  const textUndo1 = await rawDocText(page);
  ok(`(1) Ctrl+Z 1回で解除操作全体(3行ぶん)が戻る: ${JSON.stringify(textUndo1)}`,
    textUndo1 === "買い物リスト\n- 牛乳\n- 卵\n- パン");
  // さらにもう1回で最初の箇条書き化も戻る(2操作=2回のundoで元に戻ることの確認)
  await page.keyboard.press("Control+z");
  await page.waitForTimeout(150);
  const textUndo2 = await rawDocText(page);
  ok(`(1) さらにCtrl+Zでもとの箇条書き化も戻る: ${JSON.stringify(textUndo2)}`,
    textUndo2 === "買い物リスト\n牛乳\n卵\nパン");

  await page.close();
}

// ================= (2) 番号付きリスト(para.olist, Ctrl+Shift+[): 連番になること =================
{
  const page = await newBridgedPage();
  await newDoc(page);
  await typeText(page, BASE_LIST_TEXT);
  await selectLines2to4(page);
  await page.keyboard.press("Control+Shift+BracketLeft"); // Ctrl+Shift+[
  await page.waitForTimeout(150);
  const text2 = await rawDocText(page);
  ok(`(2) 3行が連番(1. 2. 3.)になる(全部"1."にならない): ${JSON.stringify(text2)}`,
    text2 === "買い物リスト\n1. 牛乳\n2. 卵\n3. パン");
  const selAfter2 = await isSelectionActive(page);
  ok(`(2) 操作後も選択範囲が保たれる: ${selAfter2}`, selAfter2 === true);
  await page.close();
}

// ================= (3) 引用(para.quote, Ctrl+Shift+Q) =================
{
  const page = await newBridgedPage();
  await newDoc(page);
  await typeText(page, BASE_LIST_TEXT);
  await selectLines2to4(page);
  await page.keyboard.press("Control+Shift+Q");
  await page.waitForTimeout(150);
  const text3 = await rawDocText(page);
  ok(`(3) 3行すべてに"> "が付く: ${JSON.stringify(text3)}`,
    text3 === "買い物リスト\n> 牛乳\n> 卵\n> パン");
  await page.close();
}

// ================= (4) 見出し1(para.h1, Ctrl+1) =================
{
  const page = await newBridgedPage();
  await newDoc(page);
  await typeText(page, BASE_LIST_TEXT);
  await selectLines2to4(page);
  await page.keyboard.press("Control+1");
  await page.waitForTimeout(150);
  const text4 = await rawDocText(page);
  ok(`(4) 3行すべてに"# "が付く: ${JSON.stringify(text4)}`,
    text4 === "買い物リスト\n# 牛乳\n# 卵\n# パン");
  await page.close();
}

// ================= (5) インデント/アウトデント(Ctrl+[ / Ctrl+]) =================
{
  const page = await newBridgedPage();
  await newDoc(page);
  await typeText(page, BASE_LIST_TEXT);
  await selectLines2to4(page);
  await page.keyboard.press("Control+BracketLeft"); // Ctrl+[ インデント(既定4スペース)
  await page.waitForTimeout(150);
  const text5 = await rawDocText(page);
  ok(`(5) 3行すべてがインデントされる: ${JSON.stringify(text5)}`,
    text5 === "買い物リスト\n    牛乳\n    卵\n    パン");

  await selectLines2to4(page);
  await page.keyboard.press("Control+BracketRight"); // Ctrl+] アウトデント
  await page.waitForTimeout(150);
  const text5b = await rawDocText(page);
  ok(`(5) アウトデントで3行すべて戻る: ${JSON.stringify(text5b)}`,
    text5b === "買い物リスト\n牛乳\n卵\nパン");
  await page.close();
}

// ================= (6) 部分的に該当形式(1行だけ既にリスト)な場合は全部その形式にする =================
{
  const page = await newBridgedPage();
  await newDoc(page);
  await typeText(page, BASE_LIST_TEXT);
  // 2行目(牛乳)だけを先に箇条書き化する。選択なし(カーソルのみ)での単一行適用のため、
  // Enterによるリスト継続(次行への自動"- "付与)を経由せずに「1行だけ既にリスト」の
  // 状態を作れる(typeText()でいきなり"- 牛乳\n卵\nパン"と打つと、Markdownのリスト継続
  // 機能が3行目・4行目にも自動で"- "を補ってしまい前提が壊れるため、この経路にした)。
  await page.keyboard.press("Control+Home");
  await page.keyboard.press("ArrowDown"); // 2行目(牛乳)、選択なし
  await page.waitForTimeout(80);
  await page.keyboard.press("Control+Shift+BracketRight");
  await page.waitForTimeout(150);
  const pre6 = await rawDocText(page);
  ok(`(6-前提) 2行目だけが箇条書きになっている: ${JSON.stringify(pre6)}`,
    pre6 === "買い物リスト\n- 牛乳\n卵\nパン");

  await selectLines2to4(page);
  await page.keyboard.press("Control+Shift+BracketRight");
  await page.waitForTimeout(150);
  const text6 = await rawDocText(page);
  ok(`(6) 一部だけ該当形式のときは解除ではなく全部その形式にする: ${JSON.stringify(text6)}`,
    text6 === "買い物リスト\n- 牛乳\n- 卵\n- パン");
  await page.close();
}

// ================= (7) 選択終端がちょうど行頭にある場合はその行を含めない =================
{
  const page = await newBridgedPage();
  await newDoc(page);
  await typeText(page, BASE_LIST_TEXT);
  // 2行目(牛乳)行頭 〜 4行目(パン)の"行頭ちょうど"まで選択する(3行目末の改行の直後で止める)
  await page.keyboard.press("Control+Home");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.down("Shift");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown"); // ここで4行目(パン)の行頭ちょうどに達する(Homeは押さない)
  await page.keyboard.up("Shift");
  await page.waitForTimeout(100);
  await page.keyboard.press("Control+Shift+BracketRight");
  await page.waitForTimeout(150);
  const text7 = await rawDocText(page);
  ok(`(7) 選択終端がちょうど行頭の行(パン)は対象に含めない: ${JSON.stringify(text7)}`,
    text7 === "買い物リスト\n- 牛乳\n- 卵\nパン");
  await page.close();
}

// ================= (8) 右クリックメニュー経由(convertListType側)でも複数行に効く =================
{
  const page = await newBridgedPage();
  await newDoc(page);
  // "- 牛乳\n- 卵\n- パン"をそのままtypeText()で打つと、Enterによるリスト継続機能
  // (直前行がリスト項目だと次行に自動で"- "を補う)が働いてしまい、そこへさらに自分の
  // "- "が重なって二重になる(前提が壊れる)。プレーンな3行を打ってから(1)と同じ
  // Ctrl+Shift+]で箇条書き化する経路にする。
  await typeText(page, "牛乳\n卵\nパン");
  await page.keyboard.press("Control+Home");
  await page.keyboard.down("Shift");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("End");
  await page.keyboard.up("Shift");
  await page.waitForTimeout(100);
  await page.keyboard.press("Control+Shift+BracketRight");
  await page.waitForTimeout(150);
  const pre8 = await rawDocText(page);
  ok(`(8-前提) 3行とも箇条書きになっている: ${JSON.stringify(pre8)}`, pre8 === "- 牛乳\n- 卵\n- パン");

  // 3行すべてを選択し直す(1行目行頭〜3行目行末)
  await page.keyboard.press("Control+Home");
  await page.keyboard.down("Shift");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("End");
  await page.keyboard.up("Shift");
  await page.waitForTimeout(100);

  const box = await page.locator(".cm-content").getByText("卵").boundingBox();
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2, { button: "right" });
  await page.waitForTimeout(250);
  const sent = await page.evaluate(() => window.__sent);
  const menuMsg = [...sent].reverse().find((m) => m.type === "open-context-menu");
  const item = menuMsg?.items?.find((it) => it.label === "番号付きリストに変換");
  ok(`(8) 右クリックメニューに「番号付きリストに変換」が出る: ${JSON.stringify(item)}`, !!item);

  if (item) {
    await page.evaluate((id) => window.__reply({ type: "menu-command", id }), item.id);
    await page.waitForTimeout(200);
    const text8 = await rawDocText(page);
    ok(`(8) 右クリックメニュー経由でも3行が連番になる: ${JSON.stringify(text8)}`,
      text8 === "1. 牛乳\n2. 卵\n3. パン");
  } else {
    ok(`(8) 右クリックメニュー経由でも3行が連番になる`, false);
  }
  await page.close();
}

// ================= (9) 単一行(選択なし・カーソルのみ)は従来どおり1行だけに効く(退行確認) =================
{
  const page = await newBridgedPage();
  await newDoc(page);
  await typeText(page, BASE_LIST_TEXT);
  await page.keyboard.press("Control+Home");
  await page.keyboard.press("ArrowDown"); // 2行目(牛乳)へ、選択なし
  await page.waitForTimeout(100);
  await page.keyboard.press("Control+Shift+BracketRight");
  await page.waitForTimeout(150);
  const text9 = await rawDocText(page);
  ok(`(9) 選択なしのときは従来どおりカーソル行だけに効く: ${JSON.stringify(text9)}`,
    text9 === "買い物リスト\n- 牛乳\n卵\nパン");
  await page.close();
}

// ================= 共通: ページエラー・コンソールエラー 0件 =================
ok(`ページエラー・コンソールエラーが0件: ${errors.length}件${errors.length ? " " + JSON.stringify(errors.slice(0, 3)) : ""}`, errors.length === 0);

console.log(`\n合計: OK=${okCount} NG=${ngCount}`);
await browser.close();
process.exit(ngCount > 0 ? 1 : 0);
