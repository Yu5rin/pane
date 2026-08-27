// 修正1の検証: codeIndentGuides="all" が、"fold"と同じ表示にしかならない不具合の
// 再現・修正確認。ポートは8195(.verify-codefold.mjsと同じdistを使う。並行実行しない前提)。
//
// 再現条件(実測で特定): 波括弧を持たない単文if("if (a) doSomething();"のように{}が無い)の
// 本体行は、構文木上は折りたたみ可能な範囲(foldNodeProp)を持たない。旧実装の"all"モードは
// 「構造的な折りたたみ範囲をcodeIndentSizeの倍数グリッドで先に描き、そのグリッドに乗らない
// 列だけを埋める」設計だったため、行の実インデント幅がcodeIndentSize(既定4)の倍数からずれる
// 組み合わせ(例: 2幅インデントのファイル+既定のcodeIndentSize=4)で、埋めのMath.floor計算が
// 深さを過小に見積もり、本来引くべき単文if本体の縦線を取りこぼしていた。結果、その行では
// "all"と"fold"が完全に同じ本数・同じ位置になっていた。
import pw from "playwright";
const { chromium } = pw;
const browser = await chromium.launch();
const PORT = 8195;
const BASE = `http://localhost:${PORT}/index.html`;
const errors = [];
let okCount = 0, ngCount = 0;
const ok = (l, c) => { console.log(`${c ? "OK  " : "NG  "} ${l}`); if (c) okCount++; else ngCount++; };

async function newPage() {
  const page = await browser.newPage();
  page.on("pageerror", (e) => errors.push(String(e.stack || e)));
  page.on("console", (m) => { if (m.type() === "error") errors.push("console: " + m.text()); });
  await page.addInitScript(() => {
    const listeners = [];
    window.chrome = { webview: { postMessage: () => {}, addEventListener: (_t, fn) => listeners.push(fn) } };
    window.__reply = (data) => listeners.forEach((fn) => fn({ data }));
  });
  await page.goto(BASE, { waitUntil: "load" });
  await page.waitForSelector(".cm-content", { timeout: 15000 });
  await page.waitForTimeout(400);
  return page;
}
async function openFile(page, fileName, text) {
  await page.evaluate(({ fileName, text }) => window.__reply({
    type: "file-opened", fileName, path: "C:\\work\\" + fileName, text,
    encoding: "UTF-8", lineEnding: "CRLF", readOnly: false,
  }), { fileName, text });
  await page.waitForTimeout(400);
}
async function applySettings(page, extra) {
  await page.evaluate((extra) => window.__reply({ type: "apply-settings", ...extra }), extra);
  await page.waitForTimeout(200);
}
async function guidesByLine(page) {
  return page.evaluate(() => {
    const lines = [...document.querySelectorAll(".cm-content > .cm-line")];
    return lines.map((l) => [...l.querySelectorAll(".cm-guide-line")].length);
  });
}

// ================= 再現1: 波括弧なし単文ifの本体行(codeIndentSize既定=4のまま) =================
const JS_NOBRACE = "function outer() {\n  if (a)\n    doSomething();\n  while (b) {\n    x++;\n  }\n}\n";
{
  const page = await newPage();
  await openFile(page, "guideall1.js", JS_NOBRACE);
  // codeIndentSizeは既定(4)のまま変更しない(実際のファイルは2幅インデント=不一致の
  // 組み合わせのまま。ユーザーが特別な設定をしなくても再現・修正されることを確認する)。
  await applySettings(page, { codeIndentGuides: "fold", codeFoldingEnabled: true });
  const fold = await guidesByLine(page);
  await applySettings(page, { codeIndentGuides: "all", codeFoldingEnabled: true });
  const all = await guidesByLine(page);
  console.log(`  [実測] fold本数/行=${JSON.stringify(fold)}`);
  console.log(`  [実測] all 本数/行=${JSON.stringify(all)}`);
  // "doSomething();"の行(単文ifの本体、波括弧が無いため構文木上は折りたためない)は
  // インデックス2("function outer() {"=0, "  if (a)"=1, "    doSomething();"=2)。
  const targetIdx = 2;
  ok(`(1) 前提: "doSomething();"行の実測テキストが期待どおり`,
    (await page.locator(".cm-content > .cm-line").nth(targetIdx).textContent()).includes("doSomething"));
  ok(`(1) 修正確認: "doSomething();"行で all(${all[targetIdx]}本) が fold(${fold[targetIdx]}本) より多い(単文ifの内側にも縦線が引かれる)`,
    all[targetIdx] > fold[targetIdx]);
  // 全体としても、allはfold以上の本数になっている(依頼②の不変条件の再確認)。
  const totalFold = fold.reduce((a, b) => a + b, 0);
  const totalAll = all.reduce((a, b) => a + b, 0);
  ok(`(1) 全体本数: all(${totalAll}) >= fold(${totalFold})`, totalAll >= totalFold);
  ok(`(1) 全体本数: all(${totalAll}) が fold(${totalFold}) と完全一致にはならない(名前どおり"all"が"fold"より多くを示す)`,
    totalAll > totalFold);
  await page.close();
}

// ================= 回帰確認: 空行をまたいでも縦線が途切れない(fold本数と一致すること) =================
// 深いネストの内側にある空行で、allがfoldより「少なく」なる回帰(スタック方式へ書き換えた際に
// 実際に踏んだ不具合)が無いことを確認する。
const NEST_WITH_BLANK = [
  "function outer() {",
  "  if (a > 0) {",
  "    for (let i = 0; i < 10; i++) {",
  "",
  "      if (i % 2 === 0) {",
  "        console.log(i);",
  "      }",
  "    }",
  "  }",
  "  return a;",
  "}",
].join("\n");
{
  const page = await newPage();
  await openFile(page, "guideall2.js", NEST_WITH_BLANK);
  await applySettings(page, { codeIndentGuides: "fold", codeFoldingEnabled: true, codeIndentSize: 2 });
  const fold = await guidesByLine(page);
  await applySettings(page, { codeIndentGuides: "all", codeFoldingEnabled: true, codeIndentSize: 2 });
  const all = await guidesByLine(page);
  console.log(`  [実測] fold本数/行=${JSON.stringify(fold)}`);
  console.log(`  [実測] all 本数/行=${JSON.stringify(all)}`);
  // 3行目(0始まりでインデックス3)が空行("for"の内側、"if"のさらに手前)。
  const blankIdx = 3;
  const blankText = await page.locator(".cm-content > .cm-line").nth(blankIdx).textContent();
  ok(`(2) 前提: インデックス${blankIdx}行が空行`, blankText.trim() === "");
  ok(`(2) 空行をまたいでもallの本数がfoldを下回らない(空行の行=fold:${fold[blankIdx]}本 / all:${all[blankIdx]}本)`,
    all[blankIdx] >= fold[blankIdx]);
  ok(`(2) この空行ではallとfoldが完全に一致する(構造的な範囲を全てカバーしている。fold=${fold[blankIdx]}, all=${all[blankIdx]})`,
    all[blankIdx] === fold[blankIdx]);
  await page.close();
}

ok(`ページエラー・コンソールエラーが0件: ${errors.length}件${errors.length ? " " + JSON.stringify(errors.slice(0, 3)) : ""}`, errors.length === 0);
console.log(`\n合計: OK=${okCount} NG=${ngCount}`);
await browser.close();
process.exit(ngCount > 0 ? 1 : 0);
