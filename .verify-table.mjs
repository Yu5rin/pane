// M-08(表の列幅ドラッグ調整)の検証スクリプト。Playwrightで実ブラウザを操作する。
import pw from "playwright";
const { chromium } = pw;

const PORT = 8144;
const BASE = `http://localhost:${PORT}/index.html`;
const results = [];
function report(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? "OK " : "NG "} ${name}${detail ? " - " + detail : ""}`);
}

const pageErrors = [];
const consoleErrors = [];

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
page.on("pageerror", (e) => pageErrors.push(String(e)));
page.on("console", (msg) => { if (msg.type() === "error") consoleErrors.push(msg.text()); });

await page.goto(BASE, { waitUntil: "load" });
await page.waitForSelector(".cm-content", { timeout: 15000 });

async function selectAllAndType(text) {
  await page.click(".cm-content");
  await page.keyboard.press("Control+A");
  await page.keyboard.press("Delete");
  await page.keyboard.type(text, { delay: 1 });
}

// 表1(ドラッグ対象)と表2(1度もドラッグしない対照用)、その前後に段落を置く。
const TABLE1 = "| Alpha | Beta | Gamma |\n| --- | --- | --- |\n| a1 | b1 | c1 |\n| a2 | b2 | c2 |";
const PARA_TOP = "段落トップ";
const PARA_MID = "表1と表2の間の段落";
const TABLE2 = "| X | Y |\n| --- | --- |\n| x1 | y1 |";
const PARA_BOTTOM = "末尾の段落";
const DOC = `${PARA_TOP}\n\n${TABLE1}\n\n${PARA_MID}\n\n${TABLE2}\n\n${PARA_BOTTOM}`;

await selectAllAndType(DOC);
// カーソルを表の外へ(末尾)移動してライブプレビューの表ウィジェットを表示させる。
await page.keyboard.press("Control+End");
await page.waitForTimeout(300);

// ---- (a) colgroup > col が列数ぶんある ----
const tableWidgets = await page.$$(".cm-table");
report("表ウィジェットが2つ描画されている", tableWidgets.length === 2, `count=${tableWidgets.length}`);

const t1 = tableWidgets[0];
const t2 = tableWidgets[1];

const colCount1 = await t1.$$eval("colgroup > col", (els) => els.length);
report("(a) 表1: colgroup>col が列数(3)ぶんある", colCount1 === 3, `colCount=${colCount1}`);

// ---- (b) 列境界にリサイザがあり、最終列の右端には無い ----
const resizerCountInHeader = await t1.$$eval("thead th", (ths) =>
  ths.map((th) => th.querySelectorAll(".cm-table-col-resizer").length)
);
report(
  "(b) 表1: リサイザは先頭2列にのみあり最終列には無い",
  JSON.stringify(resizerCountInHeader) === JSON.stringify([1, 1, 0]),
  `resizerCountInHeader=${JSON.stringify(resizerCountInHeader)}`
);

// ---- (g) 1度もドラッグしていない表2は自動幅のまま ----
const t2Layout = await t2.$eval("table", (tbl) => ({
  tableLayout: tbl.style.tableLayout || "",
  colWidths: [...tbl.querySelectorAll("colgroup > col")].map((c) => c.style.width || ""),
}));
report(
  "(g) 表2(未ドラッグ)は table-layout未指定・col幅未指定のまま",
  t2Layout.tableLayout === "" && t2Layout.colWidths.every((w) => w === ""),
  JSON.stringify(t2Layout)
);

// ---- ドラッグ前のテキストを記録(source modeで確認するため) ----
async function getRawText() {
  await page.keyboard.press("Control+/"); // ソースコードモードON
  await page.waitForTimeout(150);
  const text = await page.$eval(".cm-content", (el) => el.innerText);
  await page.keyboard.press("Control+/"); // ソースコードモードOFF(ライブプレビューへ戻す)
  await page.waitForTimeout(150);
  return text.replace(/​/g, ""); // CodeMirrorが行末に挿入するゼロ幅文字を除去
}
const rawBefore = await getRawText();

// source modeの往復でウィジェットDOMが作り直されるため、要素ハンドルを取り直す。
const t1b = (await page.$$(".cm-table"))[0];

// ---- (c) 1列目境界を右へ80pxドラッグすると1列目の幅が広がる ----
const resizer1 = await t1b.$("thead th:nth-child(1) .cm-table-col-resizer");
const th1Before = await t1b.$eval("thead th:nth-child(1)", (el) => el.getBoundingClientRect().width);
const box = await resizer1.boundingBox();
const startX = box.x + box.width / 2;
const startY = box.y + box.height / 2;
await page.mouse.move(startX, startY);
await page.mouse.down();
// 複数回に分けてmoveする(1回だけだとpointermoveが発火しないことがある)
for (let i = 1; i <= 8; i++) {
  await page.mouse.move(startX + (80 * i) / 8, startY, { steps: 1 });
  await page.waitForTimeout(20);
}
await page.mouse.up();
await page.waitForTimeout(200);
const th1After = await t1b.$eval("thead th:nth-child(1)", (el) => el.getBoundingClientRect().width);
report(
  "(c) 1列目境界を右へ80pxドラッグすると1列目の幅が広がる",
  th1After - th1Before > 50,
  `before=${th1Before.toFixed(1)} after=${th1After.toFixed(1)} diff=${(th1After - th1Before).toFixed(1)}`
);

// ---- (d) ドラッグしてもドキュメントのテキストが1文字も変わらない ----
const rawAfter = await getRawText();
report("(d) ドラッグ前後でドキュメントのテキストが変わらない", rawBefore === rawAfter, rawBefore === rawAfter ? "" : `before=${JSON.stringify(rawBefore)} after=${JSON.stringify(rawAfter)}`);

// ---- (e) ドラッグ後に表の下へ文字を入力しても列幅が維持される ----
await page.click(".cm-content");
await page.keyboard.press("Control+End");
await page.keyboard.type("\n追加した段落");
await page.waitForTimeout(300);
const tablesAfterEdit1 = await page.$$(".cm-table");
const t1AfterEdit = tablesAfterEdit1[0];
const th1AfterEdit = await t1AfterEdit.$eval("thead th:nth-child(1)", (el) => el.getBoundingClientRect().width);
report(
  "(e) 表の下へ文字入力後も列幅が維持される",
  Math.abs(th1AfterEdit - th1After) < 3,
  `afterDrag=${th1After.toFixed(1)} afterEdit=${th1AfterEdit.toFixed(1)}`
);

// ---- (f) 表の上に新しい行を挿入しても列幅が維持される(識別子が行番号依存でないこと) ----
await page.click(".cm-content");
await page.keyboard.press("Control+Home");
await page.keyboard.type("先頭に挿入した行\n\n");
await page.waitForTimeout(300);
const tablesAfterEdit2 = await page.$$(".cm-table");
const t1AfterInsertAbove = tablesAfterEdit2[0];
const colCountCheck = await t1AfterInsertAbove.$$eval("colgroup > col", (els) => els.length);
const th1AfterInsertAbove = await t1AfterInsertAbove.$eval("thead th:nth-child(1)", (el) => el.getBoundingClientRect().width);
report(
  "(f) 表の上に行を挿入しても列幅が維持される",
  colCountCheck === 3 && Math.abs(th1AfterInsertAbove - th1After) < 3,
  `colCount=${colCountCheck} afterDrag=${th1After.toFixed(1)} afterInsertAbove=${th1AfterInsertAbove.toFixed(1)}`
);

// ---- (h) ページエラー・コンソールエラーが0件 ----
report("(h) ページエラー0件・コンソールエラー0件", pageErrors.length === 0 && consoleErrors.length === 0, `pageErrors=${JSON.stringify(pageErrors)} consoleErrors=${JSON.stringify(consoleErrors)}`);

await browser.close();

const allOk = results.every((r) => r.ok);
console.log(`\n==== ${allOk ? "ALL OK" : "SOME FAILED"} ====`);
process.exit(allOk ? 0 : 1);
