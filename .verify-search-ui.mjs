// 検索・置換パネル(src/search-ui.js)まわりの不具合修正の回帰検証。ポートは8181。
//   不具合1: 「すべて置換」「置換」「次を検索」「前を検索」を押した直後、エディタを
//            クリックし直さなくてもCtrl+Zが効くこと(フォーカスが本文へ戻ること)。
//            ただし検索欄でタイプ中にフォーカスを奪わないこと。
//   不具合2: F3(次を検索)/Shift+F3(前を検索)のグローバルショートカット経由でも
//            件数表示(n / 総数)が更新されること。
//   不具合3: 検索パネルを開いたまま本文を編集すると、件数表示が(デバウンスの後)
//            自動的に追従すること。1万行の文書で入力が重くならないこと。
//   バグ2(ラウンド1): タブ形式(隠し設定displayMode:"tab")でタブを切り替えた後も、
//            検索パネルを開いたまま本文を編集すると件数表示が自動的に追従し続けること。
//            タブ切替はEditorStateを丸ごと差し替えるため、切替後のタブでも自動更新の
//            仕組みが生き続けている必要がある(何度タブを往復しても効き続けること)。
import pw from "playwright";
const { chromium } = pw;
const browser = await chromium.launch();
let okCount = 0, ngCount = 0;
const ok = (label, cond, extra = "") => { console.log(`${cond ? "OK  " : "NG  "} ${label}${extra ? " " + extra : ""}`); if (cond) okCount++; else ngCount++; };

async function newPage() {
  const page = await browser.newPage();
  const errors = [];
  const consoleErrors = [];
  page.on("pageerror", (e) => errors.push(String(e.stack || e)));
  page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });
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
  await page.goto("http://localhost:8181/index.html");
  await page.waitForTimeout(700);
  return { page, errors, consoleErrors };
}

async function openFile(page, text, fileName = "sample.md") {
  await page.evaluate(({ text, fileName }) => window.__reply({
    type: "file-opened", fileName, path: "C:\\work\\" + fileName, text,
    encoding: "UTF-8", lineEnding: "CRLF", readOnly: false,
  }), { text, fileName });
  await page.waitForTimeout(300);
}
async function docText(page) {
  return page.$$eval(".cm-content .cm-line", (els) => els.map((e) => e.textContent).join("\n"));
}
async function activeElId(page) {
  return page.evaluate(() => document.activeElement?.id ?? document.activeElement?.tagName ?? "");
}
async function isSearchOpen(page) {
  return page.evaluate(() => !document.getElementById("search-panel").hidden);
}
async function countText(page) {
  return page.textContent("#search-count");
}
async function openSearchPanel(page, withReplace) {
  await page.click(".cm-content");
  await page.keyboard.press(withReplace ? "Control+h" : "Control+f");
  await page.waitForTimeout(200);
}

// ---- 準備: サンプル文書(「test」を複数含む) ----
const SAMPLE = ["test one", "line two", "test three", "line four", "test five"].join("\n");

// =========================================================================
// (1) 「次を検索」ボタン直後にCtrl+Zが効く(フォーカスが本文へ戻る)
// =========================================================================
{
  const { page, errors, consoleErrors } = await newPage();
  await openFile(page, SAMPLE);
  // まず本文へ直接編集を1つ加えておく(元に戻す対象を作る)。
  await page.click(".cm-content");
  await page.keyboard.press("Control+End");
  await page.keyboard.type("UNDOMARK");
  await page.waitForTimeout(200);
  ok("(1-次) 事前準備: UNDOMARKを追記", (await docText(page)).includes("UNDOMARK"));

  await openSearchPanel(page, false);
  await page.fill("#search-query", "test");
  await page.waitForTimeout(150);
  await page.click("#search-next");
  await page.waitForTimeout(150);
  ok("(1-次) クリック直後のフォーカスは本文(cm-content)側", (await activeElId(page)) !== "search-query");

  // エディタをクリックし直さず、そのままCtrl+Z。
  await page.keyboard.press("Control+z");
  await page.waitForTimeout(200);
  ok("(1-次) エディタへ再クリックせずにCtrl+Zが効く(UNDOMARKが消える)", !(await docText(page)).includes("UNDOMARK"));
  ok("(1-次) ページエラー0件", errors.length === 0, JSON.stringify(errors));
  ok("(1-次) コンソールエラー0件", consoleErrors.length === 0, JSON.stringify(consoleErrors));
  await page.close();
}

// =========================================================================
// (2) 「前を検索」ボタン直後にCtrl+Zが効く
// =========================================================================
{
  const { page, errors, consoleErrors } = await newPage();
  await openFile(page, SAMPLE);
  await page.click(".cm-content");
  await page.keyboard.press("Control+End");
  await page.keyboard.type("UNDOMARK");
  await page.waitForTimeout(200);

  await openSearchPanel(page, false);
  await page.fill("#search-query", "test");
  await page.waitForTimeout(150);
  await page.click("#search-prev");
  await page.waitForTimeout(150);

  await page.keyboard.press("Control+z");
  await page.waitForTimeout(200);
  ok("(2-前) 「前を検索」直後もCtrl+Zが効く", !(await docText(page)).includes("UNDOMARK"));
  ok("(2-前) ページエラー0件", errors.length === 0, JSON.stringify(errors));
  ok("(2-前) コンソールエラー0件", consoleErrors.length === 0, JSON.stringify(consoleErrors));
  await page.close();
}

// =========================================================================
// (3) 「置換」ボタン直後にCtrl+Zが効く(置換自体を元に戻す)
// =========================================================================
{
  const { page, errors, consoleErrors } = await newPage();
  await openFile(page, SAMPLE);
  await openSearchPanel(page, true);
  await page.fill("#search-query", "test");
  await page.fill("#replace-query", "REPLACED");
  await page.waitForTimeout(150);
  // @codemirror/searchのreplaceNextは「選択が既にマッチと一致していなければ置換せず
  // 選択だけを合わせる」動作のため、実際のユーザー操作(まず検索で1件目に合わせてから
  // 置換する)に合わせ、先に「次を検索」で1件目を選択してから置換する。
  await page.click("#search-next");
  await page.waitForTimeout(150);
  await page.click("#replace-one");
  await page.waitForTimeout(150);
  const afterReplace = await docText(page);
  ok("(3-置換) 1件だけ置換される", afterReplace.includes("REPLACED") && afterReplace.split("test").length === 3 /* 元3件-1件 */);

  await page.keyboard.press("Control+z");
  await page.waitForTimeout(200);
  ok("(3-置換) クリック直後Ctrl+Zで置換前に戻る", (await docText(page)) === SAMPLE);
  ok("(3-置換) ページエラー0件", errors.length === 0, JSON.stringify(errors));
  ok("(3-置換) コンソールエラー0件", consoleErrors.length === 0, JSON.stringify(consoleErrors));
  await page.close();
}

// =========================================================================
// (4) 「すべて置換」ボタン直後にCtrl+Zが効く
// =========================================================================
{
  const { page, errors, consoleErrors } = await newPage();
  await openFile(page, SAMPLE);
  await openSearchPanel(page, true);
  await page.fill("#search-query", "test");
  await page.fill("#replace-query", "REPLACED");
  await page.waitForTimeout(150);
  await page.click("#replace-all");
  await page.waitForTimeout(150);
  const afterReplaceAll = await docText(page);
  ok("(4-全置換) 全件置換される", !afterReplaceAll.includes("test") && afterReplaceAll.includes("REPLACED"));

  await page.keyboard.press("Control+z");
  await page.waitForTimeout(200);
  ok("(4-全置換) クリック直後Ctrl+Zで一括置換前に戻る", (await docText(page)) === SAMPLE);
  ok("(4-全置換) ページエラー0件", errors.length === 0, JSON.stringify(errors));
  ok("(4-全置換) コンソールエラー0件", consoleErrors.length === 0, JSON.stringify(consoleErrors));
  await page.close();
}

// =========================================================================
// (5) 検索欄でタイプ中にフォーカスが奪われない
// =========================================================================
{
  const { page, errors, consoleErrors } = await newPage();
  await openFile(page, SAMPLE);
  await openSearchPanel(page, false);
  await page.click("#search-query");
  await page.fill("#search-query", "");
  let stolen = false;
  for (const ch of "test") {
    await page.keyboard.type(ch, { delay: 30 });
    await page.waitForTimeout(30);
    const id = await activeElId(page);
    if (id !== "search-query") stolen = true;
  }
  ok("(5) 検索欄でのタイプ中、一度もフォーカスが奪われない", !stolen);
  ok("(5) ページエラー0件", errors.length === 0, JSON.stringify(errors));
  ok("(5) コンソールエラー0件", consoleErrors.length === 0, JSON.stringify(consoleErrors));
  await page.close();
}

// =========================================================================
// (6) F3 / Shift+F3 で件数表示が更新される
// =========================================================================
{
  const { page, errors, consoleErrors } = await newPage();
  await openFile(page, SAMPLE); // "test"が3件
  await page.click(".cm-content");
  await page.keyboard.press("Control+Home"); // カーソルを先頭へ(結果を決定的にする)
  await openSearchPanel(page, false);
  await page.fill("#search-query", "test");
  await page.waitForTimeout(150);
  // 起点を揃えるため、まずボタンで1件目に合わせる。
  await page.click("#search-next");
  await page.waitForTimeout(150);
  const c1 = await countText(page);
  ok(`(6-F3) 起点の件数表示 "${c1}"`, /1\s*\/\s*3/.test(c1));

  await page.keyboard.press("F3");
  await page.waitForTimeout(200);
  const c2 = await countText(page);
  ok(`(6-F3) F3後に件数表示が更新される "${c1}" -> "${c2}"`, /2\s*\/\s*3/.test(c2) && c2 !== c1);

  await page.keyboard.press("Shift+F3");
  await page.waitForTimeout(200);
  const c3 = await countText(page);
  ok(`(6-Shift+F3) Shift+F3後に件数表示が更新される "${c2}" -> "${c3}"`, /1\s*\/\s*3/.test(c3));

  ok("(6) ページエラー0件", errors.length === 0, JSON.stringify(errors));
  ok("(6) コンソールエラー0件", consoleErrors.length === 0, JSON.stringify(consoleErrors));
  await page.close();
}

// =========================================================================
// (7) 検索パネルを開いたまま本文を編集すると件数表示が追従する(デバウンス後)
// =========================================================================
{
  const { page, errors, consoleErrors } = await newPage();
  await openFile(page, SAMPLE); // "test"が3件
  await openSearchPanel(page, false);
  await page.fill("#search-query", "test");
  await page.waitForTimeout(150);
  const before = await countText(page);
  ok(`(7) 編集前の件数表示 "${before}"`, /3/.test(before));

  // 検索欄から本文へ切り替えて末尾に一致語を追記する(検索欄の再入力やnext/prevボタンには触れない)。
  await page.click(".cm-content");
  await page.keyboard.press("Control+End");
  await page.keyboard.type("\ntest six");
  // デバウンス(150ms)より短い時点では、直後の描画がまだ間に合っていない可能性があるため
  // 十分待ってから確認する。
  await page.waitForTimeout(400);
  const after = await countText(page);
  ok(`(7) 追記後、検索欄やボタンに触れずに件数表示が追従する "${before}" -> "${after}"`, /4/.test(after) && after !== before);

  ok("(7) ページエラー0件", errors.length === 0, JSON.stringify(errors));
  ok("(7) コンソールエラー0件", consoleErrors.length === 0, JSON.stringify(consoleErrors));
  await page.close();
}

// =========================================================================
// (8) 性能: 1万行の文書で、検索パネルを開いたままの入力が重くならない
// =========================================================================
{
  const { page, errors, consoleErrors } = await newPage();
  const LINES = 10000;
  const bigText = Array.from({ length: LINES }, (_, i) => `line ${i} test`).join("\n");
  await openFile(page, bigText, "big.md");
  await openSearchPanel(page, false);
  await page.fill("#search-query", "test");
  await page.waitForTimeout(400); // 初回の一致数計算(1万件)を先に落ち着かせる

  await page.click(".cm-content");
  await page.keyboard.press("Control+End");
  const typed = " more test words here";
  const t0 = Date.now();
  await page.keyboard.type(typed, { delay: 15 });
  const typeElapsed = Date.now() - t0;
  // デバウンス完了(150ms)まで含めて、件数表示が最終的に反映されるまでの時間も計測する。
  await page.waitForFunction(
    (expected) => document.querySelector("#search-count")?.textContent?.includes(expected),
    "10001",
    { timeout: 5000 },
  ).catch(() => {});
  const settleElapsed = Date.now() - t0;
  const finalCount = await countText(page);

  ok(`(8) 1万行文書: ${typed.length}文字の入力(delay15ms/文字)が ${typeElapsed}ms で完了(ブロックしない)`, typeElapsed < 3000, `(${typeElapsed}ms)`);
  ok(`(8) 件数表示のデバウンス反映まで ${settleElapsed}ms(参考値)`, settleElapsed < 5000, `(${settleElapsed}ms, 最終表示="${finalCount}")`);
  ok(`(8) 最終的な件数表示が新しい一致数(10001件)に追従する "${finalCount}"`, finalCount.includes("10001"));

  ok("(8) ページエラー0件", errors.length === 0, JSON.stringify(errors));
  ok("(8) コンソールエラー0件", consoleErrors.length === 0, JSON.stringify(consoleErrors));
  await page.close();
}

// =========================================================================
// (9) バグ2(ラウンド1): タブ切替後も検索の件数自動更新が効き続ける
// =========================================================================
{
  // タブ形式(隠し設定)を使うため、.verify-tabs.mjsと同じ流儀でapply-settings/
  // open-in-tabを送る。openFile()(file-opened)ではなくopen-in-tabを使う点が
  // このスイートの他のテストと異なる。
  const { page, errors, consoleErrors } = await newPage();
  async function applySettings(partial) {
    await page.evaluate((partial) => window.__reply({ type: "apply-settings", ...partial }), partial);
    await page.waitForTimeout(200);
  }
  async function openInTab(text, fileName, path) {
    await page.evaluate(({ text, fileName, path }) => window.__reply({
      type: "open-in-tab", fileName, path, text,
      encoding: "UTF-8", lineEnding: "CRLF", readOnly: false,
    }), { text, fileName, path });
    await page.waitForTimeout(300);
  }

  await applySettings({ displayMode: "tab" });
  // コーディネーター報告の再現手順どおり: a.md("hello world\nhello again")とb.mdを開く。
  await openInTab("hello world\nhello again", "a.md", "C:\\work\\a.md");
  await openInTab("just b content", "b.md", "C:\\work\\b.md");

  // b.md表示中にCtrl+Fでhelloを検索(0件)。
  await page.click(".cm-content");
  await page.keyboard.press("Control+f");
  await page.waitForTimeout(200);
  await page.fill("#search-query", "hello");
  await page.waitForTimeout(200);
  const bCount = await countText(page);
  ok(`(9) b.md表示中は"hello"が0件 "${bCount}"`, /見つかりません/.test(bCount));

  // タブ一覧は既定タブ("無題")+a.md+b.mdの3つ。a.mdタブ(2番目)へ切り替える。
  await page.click(".tab-item:nth-child(2)");
  await page.waitForTimeout(200);

  // a.mdの本文にキーボードでhelloを追記する(検索欄やnext/prevボタンには一切触れない)。
  await page.click(".cm-content");
  await page.keyboard.press("Control+End");
  await page.keyboard.type("hello");
  await page.waitForTimeout(600); // デバウンス(150ms)より十分待つ
  const aCount = await countText(page);
  ok(`(9) a.mdタブ切替後に本文を編集すると件数表示が自動的に追従する(- / 3になる) "${aCount}"`,
    /3/.test(aCount) && !/見つかりません/.test(aCount));

  // タブを何度も往復しても効き続けることを確認する(1回だけの偶然の成功ではないことの確認)。
  for (let round = 1; round <= 3; round++) {
    await page.click(".tab-item:nth-child(3)"); // b.mdへ
    await page.waitForTimeout(150);
    await page.click(".tab-item:nth-child(2)"); // a.mdへ戻る
    await page.waitForTimeout(150);
    await page.click(".cm-content");
    await page.keyboard.press("Control+End");
    await page.keyboard.type(" hello");
    await page.waitForTimeout(500);
    const roundCount = await countText(page);
    const expected = 3 + round; // 初期2件+追記した"hello"の累計
    ok(`(9) タブ往復${round}回目でも件数自動更新が効き続ける(期待${expected}件) "${roundCount}"`,
      new RegExp(String(expected)).test(roundCount) && !/見つかりません/.test(roundCount));
  }

  ok("(9) ページエラー0件", errors.length === 0, JSON.stringify(errors));
  ok("(9) コンソールエラー0件", consoleErrors.length === 0, JSON.stringify(consoleErrors));
  await page.close();
}

console.log(`--- 集計: OK=${okCount} NG=${ngCount}`);
await browser.close();
process.exit(ngCount === 0 ? 0 : 1);
