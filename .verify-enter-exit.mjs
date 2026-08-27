// 引用・リストの空行でEnter2回で抜けられることの検証(ラウンド2の追加依頼)。ポートは8183。
// @codemirror/lang-markdownの標準Enter処理(insertNewlineContinueMarkupCommand)は、
// 空の項目でのEnterを「1回目: タイトなリストを非タイトへ変換するだけ(何も終了しない)、
// 2回目: ようやく1段のマーカーを取り除く」という2段階で扱うため、リストは実質3回、
// 引用も別の理由(直前行が既に空の引用行になっていないと解除しない)で3回かかっていた。
// editor.js の handleEnterExitEmptyMarkup がこれをPrec.highestで先取りし、
// 「マーカーだけで中身が空の行でEnter」を押した時点で即座に1段浅くする。
//
// 構成:
//   (1) 単一項目の箇条書き・引用・番号付きリスト・チェックボックスがEnter2回で抜けられる
//   (2) 通常の継続(項目を書いてEnter→マーカー継続、番号の繰り上げ、チェックボックス継続)が壊れていない
//   (3) ネストしたリストは1段だけ浅くなる(いきなり全部抜けない)
//   (4) 引用の中のリスト・リストの中の引用の混在でも、内側から順に1段ずつ正しく浅くなる
//   (5) 抜けた直後にリンク・画像・数式・Mermaidを書いても引用ブロックに取り込まれない。
//       さらにその後Enterを押しても次の行に引用マーカーが付かないこと(バグ②の再発防止)も確認する
//   (6) 多段引用(> > )も1段ずつ浅くなる
//   (7) バグ①の再発防止: 引用から完全に抜けた直後、ちょうどマーカー幅と同じ文字数を打っても
//       その文字が消えない(単純引用の2文字・多段引用の4文字の両方で確認する)
//
// ラウンド3で判明した2件の追加不具合の修正を反映して期待値を更新している:
//   バグ①(データ損失): 引用から抜けた直後にマーカー幅ちょうどの文字数を打ってEnterすると、
//     その文字が消えていた(markupContext()が幅の合計しか見ておらず、カーソル行の先頭が
//     実際にマーカーになっているかを検証していなかったため)。
//   バグ②(文書の意味が変わる): 引用から完全に抜けても次の行との間に空行が入らず、CommonMarkの
//     遅延継続により次の段落も引用に取り込まれたまま(保存した.mdを他のビューアで開くと
//     見た目が変わる)だった。引用から完全に抜けるときは空行を1つ挟むようにした。
import pw from "playwright";
const { chromium } = pw;
const PORT = 8183;
const BASE = `http://localhost:${PORT}/index.html`;
const browser = await chromium.launch();
const allErrors = [];
const allConsoleErrors = [];
let okCount = 0, ngCount = 0;
const ok = (label, cond) => { console.log(`${cond ? "OK  " : "NG  "} ${label}`); if (cond) okCount++; else ngCount++; };

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
async function newPage() {
  const page = await browser.newPage();
  page.on("pageerror", (e) => allErrors.push(String(e.stack || e)));
  page.on("console", (m) => { if (m.type() === "error") allConsoleErrors.push(m.text()); });
  await page.addInitScript(installMockBridge);
  await page.goto(BASE, { waitUntil: "load" });
  await page.waitForSelector(".cm-content", { timeout: 15000 });
  await page.waitForTimeout(300);
  return page;
}
async function newDoc(page) {
  await page.evaluate(() => window.__reply({
    type: "file-opened", fileName: null, path: null, text: "",
    encoding: "UTF-8", lineEnding: "CRLF", readOnly: false,
  }));
  await page.waitForTimeout(200);
}
// ライブプレビューはマーカーを装飾で隠す/描き換えることがあるため、.cm-lineのtextContentではなく
// request-text(main.jsのeditor.getValue()をそのまま返す経路)で生のドキュメント内容を取る。
async function rawValue(page) {
  await page.evaluate(() => { window.__sent = []; window.__reply({ type: "request-text" }); });
  await page.waitForTimeout(100);
  return page.evaluate(() => window.__sent.find((m) => m.type === "text-response")?.text);
}
async function type(page, text) {
  await page.keyboard.type(text, { delay: 3 });
}
async function enter(page, n = 1) {
  for (let i = 0; i < n; i++) {
    await page.keyboard.press("Enter");
    await page.waitForTimeout(60);
  }
}

// ============================================================
// (1) 単一項目: Enter2回で抜けられる(引用・箇条書き・番号付きリスト・チェックボックス)
// ============================================================
async function testExitInTwo(label, firstLine, expectedAfterTwo) {
  const page = await newPage();
  await newDoc(page);
  await page.click(".cm-content");
  await type(page, firstLine);
  await enter(page, 1); // 1回目: 継続(空の項目ができる)
  const midValue = await rawValue(page);
  ok(`(1-${label}) 1回目のEnterでは継続する(まだ${JSON.stringify(firstLine)}\\nの状態ではない) (${JSON.stringify(midValue)})`,
    midValue !== firstLine + "\n" && midValue.startsWith(firstLine));
  await enter(page, 1); // 2回目: 抜ける
  const afterValue = await rawValue(page);
  ok(`(1-${label}) Enter2回で抜けられる (${JSON.stringify(afterValue)})`, afterValue === expectedAfterTwo);
  await page.close();
}
await testExitInTwo("箇条書き", "- item", "- item\n");
await testExitInTwo("引用", "> quote", "> quote\n\n"); // バグ②修正: 引用から完全に抜けると空行が入る
await testExitInTwo("番号付きリスト", "1. item", "1. item\n");
await testExitInTwo("チェックボックス", "- [ ] task", "- [ ] task\n");
await testExitInTwo("アスタリスク箇条書き", "* item", "* item\n");

// ============================================================
// (2) 通常の継続が壊れていない
// ============================================================
{
  const page = await newPage();
  await newDoc(page);
  await page.click(".cm-content");
  await type(page, "- item1");
  await enter(page, 1);
  await type(page, "item2");
  ok(`(2) 箇条書きの通常継続 (${JSON.stringify(await rawValue(page))})`,
    (await rawValue(page)) === "- item1\n- item2");

  await page.keyboard.press("Control+a");
  await page.keyboard.press("Delete");
  await type(page, "1. item1");
  await enter(page, 1);
  await type(page, "item2");
  ok(`(2) 番号付きリストの番号が繰り上がる (${JSON.stringify(await rawValue(page))})`,
    (await rawValue(page)) === "1. item1\n2. item2");

  await page.keyboard.press("Control+a");
  await page.keyboard.press("Delete");
  await type(page, "- [ ] item1");
  await enter(page, 1);
  await type(page, "item2");
  ok(`(2) チェックボックスの継続(未チェックで) (${JSON.stringify(await rawValue(page))})`,
    (await rawValue(page)) === "- [ ] item1\n- [ ] item2");

  await page.keyboard.press("Control+a");
  await page.keyboard.press("Delete");
  await type(page, "> line1");
  await enter(page, 1);
  await type(page, "line2");
  ok(`(2) 引用の通常継続 (${JSON.stringify(await rawValue(page))})`,
    (await rawValue(page)) === "> line1\n> line2");
  await page.close();
}

// ============================================================
// (3) ネストしたリストは1段だけ浅くなる(いきなり全部抜けない)
// ============================================================
{
  const page = await newPage();
  await newDoc(page);
  await page.click(".cm-content");
  await type(page, "- outer");
  await enter(page, 1);
  await page.keyboard.press("Tab"); // 2階層目へインデント
  await page.waitForTimeout(80);
  await type(page, "inner");
  await enter(page, 1); // 2階層目の空項目ができる
  const nested = await rawValue(page);
  ok(`(3) 2階層目の空項目ができている (${JSON.stringify(nested)})`, nested.endsWith("- "));

  await enter(page, 1); // 1段浅くなる(2階層目→1階層目、いきなり全部は抜けない)
  const oneStepUp = await rawValue(page);
  ok(`(3) Enterで1段だけ浅くなる(1階層目の空項目"- "になる。いきなり全部抜けない) (${JSON.stringify(oneStepUp)})`,
    oneStepUp === "- outer\n    - inner\n- ");

  await enter(page, 1); // 完全に抜ける
  const fullyOut = await rawValue(page);
  ok(`(3) さらにEnterで完全に抜ける (${JSON.stringify(fullyOut)})`,
    fullyOut === "- outer\n    - inner\n");
  await page.close();
}

// ============================================================
// (4) 引用の中のリスト・リストの中の引用の混在
// ============================================================
{
  const page = await newPage();
  await newDoc(page);
  await page.click(".cm-content");
  await type(page, "> - item");
  await enter(page, 1);
  const nested = await rawValue(page);
  ok(`(4) 引用の中の空リスト項目ができている (${JSON.stringify(nested)})`, nested === "> - item\n> - ");

  await enter(page, 1); // リストだけ抜けて引用は残る(1段浅くなる)
  const listExited = await rawValue(page);
  ok(`(4) Enterでリストだけ抜けて引用は残る (${JSON.stringify(listExited)})`, listExited === "> - item\n> ");

  await enter(page, 1); // 引用も抜ける(=引用から完全に抜ける最後の1段なので、バグ②修正で空行が入る)
  const allExited = await rawValue(page);
  ok(`(4) さらにEnterで引用も抜ける(空行が入る) (${JSON.stringify(allExited)})`, allExited === "> - item\n\n");
  await page.close();
}

// ============================================================
// (5) 抜けた直後にリンク・画像・数式・Mermaidを書いても引用に取り込まれない(元の症状)
// ============================================================
async function testNotAbsorbedIntoQuote(label, textToType, expectedTail) {
  const page = await newPage();
  await newDoc(page);
  await page.click(".cm-content");
  await type(page, "> quote");
  await enter(page, 2); // 2回で引用から抜ける(バグ②修正で空行が入るため "> quote\n\n" になる)
  await type(page, textToType);
  const value = await rawValue(page);
  ok(`(5-${label}) 抜けた直後の${label}が引用に取り込まれない (${JSON.stringify(value)})`,
    value === "> quote\n\n" + expectedTail);
  // バグ②の再発防止: 旧実装は空行を挟まなかったため、ここでさらにEnterを押すと遅延継続により
  // 次の行に"> "が付いてしまっていた(このverifyの旧版はここを確認しておらず見逃していた)。
  // 打った直後の文字列がそのままdocの先頭を占め、Enterで追加された分だけが後ろに増えていること・
  // 追加分の先頭(改行を除く)が">"で始まっていないことを確認する。
  await page.keyboard.press("Enter");
  await page.waitForTimeout(60);
  const afterEnterValue = await rawValue(page);
  const appended = afterEnterValue.startsWith(value) ? afterEnterValue.slice(value.length) : null;
  ok(`(5-${label}) さらにEnterを押しても次の行に引用マーカーが付かない (${JSON.stringify(afterEnterValue)})`,
    appended !== null && !appended.replace(/^\n/, "").startsWith(">"));
  await page.close();
}
await testNotAbsorbedIntoQuote("リンク", "[link](https://example.com)", "[link](https://example.com)");
await testNotAbsorbedIntoQuote("画像", "![alt](https://example.com/a.png)", "![alt](https://example.com/a.png)");
await testNotAbsorbedIntoQuote("数式", "$x^2$", "$x^2$");
await testNotAbsorbedIntoQuote("Mermaid開始", "```mermaid", "```mermaid");

// ============================================================
// (6) 多段引用(> > )も1段ずつ浅くなる
// ============================================================
{
  const page = await newPage();
  await newDoc(page);
  await page.click(".cm-content");
  await type(page, "> > nested quote");
  await enter(page, 1);
  const nested = await rawValue(page);
  ok(`(6) 多段引用の空行ができている (${JSON.stringify(nested)})`, nested === "> > nested quote\n> > ");

  await enter(page, 1); // 1段浅くなる
  const oneStepUp = await rawValue(page);
  ok(`(6) Enterで1段浅くなる(内側の引用だけ抜ける) (${JSON.stringify(oneStepUp)})`,
    oneStepUp === "> > nested quote\n> ");

  await enter(page, 1); // 完全に抜ける(引用から完全に抜ける最後の1段なので空行が入る)
  const fullyOut = await rawValue(page);
  ok(`(6) さらにEnterで完全に抜ける(空行が入る) (${JSON.stringify(fullyOut)})`,
    fullyOut === "> > nested quote\n\n");
  await page.close();
}

// ============================================================
// (7) バグ①の再発防止: 引用から完全に抜けた直後、ちょうどマーカー幅と同じ文字数を打っても
//     消えない(単純引用の2文字だけでなく、多段引用の4文字でも確認する)
// ============================================================
async function testExactWidthNotEaten(label, firstLine, markerWidth, exitEnters) {
  const page = await newPage();
  await newDoc(page);
  await page.click(".cm-content");
  await type(page, firstLine);
  await enter(page, exitEnters); // 引用から完全に抜ける
  const exact = "x".repeat(markerWidth);
  await type(page, exact);
  const beforeEnter = await rawValue(page);
  ok(`(7-${label}) 抜けた直後にマーカー幅ちょうど(${markerWidth}文字)を打っても消えない (${JSON.stringify(beforeEnter)})`,
    beforeEnter.endsWith(exact));
  await enter(page, 1); // さらにEnterを押しても直前の文字は消えないはず(バグ①の症状そのもの)
  const afterEnter = await rawValue(page);
  ok(`(7-${label}) さらにEnterを押しても直前に打った文字が消えない (${JSON.stringify(afterEnter)})`,
    afterEnter.includes(exact));
  await page.close();
}
await testExactWidthNotEaten("単純引用(2文字)", "> quote", 2, 2);
await testExactWidthNotEaten("多段引用(4文字)", "> > nested", 4, 3);

// ============================================================
// ページエラー・コンソールエラー0件
// ============================================================
ok(`ページエラー・コンソールエラー0件 (${allErrors.length + allConsoleErrors.length}件) ${JSON.stringify([...allErrors, ...allConsoleErrors]).slice(0, 3000)}`,
  allErrors.length === 0 && allConsoleErrors.length === 0);

console.log(`\n合計: OK ${okCount} / NG ${ngCount}`);
await browser.close();
process.exit(ngCount > 0 ? 1 : 0);
