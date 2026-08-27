// 右クリック(コンテキスト)メニュー(docs/コンテキストメニュー仕様.md)の検証スクリプト。
// 第7節に挙げられた項目を確認する。ポートは8160。
//
// 構成:
//   (A) ブリッジあり: 右クリックで open-context-menu が送られ、.menu-dropdown は作られない
//   (B) 文脈ごとの項目: リンク/画像/表/コードブロック/見出し/リスト/素の段落/選択あり
//   (C) 入力欄(input)では最小構成になる
//   (D) ブリッジ無し: HTMLの .menu-dropdown にフォールバックする
//   (E) menu-command で実際に文書へ反映される(表の行/列挿入・削除・配置、リンク解除、画像削除)
//   (F) ページエラー・コンソールエラーが0件
import pw from "playwright";
const { chromium } = pw;

const PORT = 8160;
const BASE = `http://localhost:${PORT}/index.html`;
const browser = await chromium.launch();
const allErrors = [];
const allConsoleErrors = [];
let okCount = 0, ngCount = 0;
const ok = (label, cond) => { console.log(`${cond ? "OK  " : "NG  "} ${label}`); if (cond) okCount++; else ngCount++; };

// ---- ページ生成ヘルパー ----
// clipboard.writeTextは実OSクリップボードへの権限確認を避けるため、page.addInitScriptで
// 記録専用のモックへ差し替える(window.__clipboard に積む)。
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
    window.__clipboard = [];
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: (t) => { window.__clipboard.push(t); return Promise.resolve(); },
        readText: () => Promise.resolve(""),
        read: () => Promise.resolve([]),
      },
    });
  });
  await page.goto(BASE, { waitUntil: "load" });
  await page.waitForSelector(".cm-content", { timeout: 15000 });
  return page;
}
async function newPlainPage() {
  const page = await browser.newPage();
  page.on("pageerror", (e) => allErrors.push(String(e.stack || e)));
  page.on("console", (m) => { if (m.type() === "error") allConsoleErrors.push(m.text()); });
  await page.addInitScript(() => {
    window.__clipboard = [];
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: (t) => { window.__clipboard.push(t); return Promise.resolve(); },
        readText: () => Promise.resolve(""),
        read: () => Promise.resolve([]),
      },
    });
  });
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
async function setDocPlain(page, text) {
  await page.evaluate((t) => { window.__paneDebugEditor.setValue(t); }, text);
  await page.waitForTimeout(200);
}
function clearSent(page) { return page.evaluate(() => { window.__sent = []; }); }
async function lastMsg(page, type) {
  const arr = await page.evaluate((ty) => window.__sent.filter((m) => m.type === ty), type);
  return arr[arr.length - 1] ?? null;
}
// items(open-context-menuのitems、入れ子submenuを含む)からlabelで探す(再帰)。
function findItem(items, label) {
  for (const it of items ?? []) {
    if (it.label === label) return it;
    if (it.submenu) { const found = findItem(it.submenu, label); if (found) return found; }
  }
  return null;
}
function hasItem(items, label) { return !!findItem(items, label); }

// ============================================================
// (A)(B) ブリッジあり: 本文の右クリック
// ============================================================
{
  const page = await newBridgedPage();
  const DOC = [
    "# 見出し1",
    "",
    "普通の段落です。ここは特別な文脈を持ちません。",
    "",
    "- 箇条書きの行",
    "",
    "[リンクです](https://example.com/path)",
    "",
    "![画像です](images/sample.png)",
    "",
    "```js",
    "console.log(1);",
    "```",
    "",
    "$$",
    "x^2",
    "$$",
    "",
    "| A | B |",
    "| --- | --- |",
    "| a1 | b1 |",
    "| a2 | b2 |",
    "",
  ].join("\n");
  await openFile(page, DOC);

  // ---- (A) 素の段落を右クリック: open-context-menuが送られ、.menu-dropdownは作られない ----
  await clearSent(page);
  const paraLine = page.locator(".cm-line", { hasText: "普通の段落です" }).first();
  await paraLine.click({ button: "right" });
  await page.waitForTimeout(250);
  const paraMsg = await lastMsg(page, "open-context-menu");
  ok("(A) 本文右クリックでopen-context-menuを送信", !!paraMsg);
  ok("(A) x/yが数値で入っている", typeof paraMsg?.x === "number" && typeof paraMsg?.y === "number");
  ok("(A) .menu-dropdown(HTMLフォールバック)は作られない", (await page.$(".menu-dropdown")) === null);
  ok("(A) 素の段落: 「段落」サブメニューが出る", hasItem(paraMsg.items, "段落"));
  ok("(A) 素の段落: 「その他」の検索…が出る", hasItem(paraMsg.items, "検索…"));
  ok("(A) 素の段落: 選択が無いので「選択箇所を検索」は出ない", !hasItem(paraMsg.items, "選択箇所を検索"));
  ok("(A) 素の段落: 選択が無いので「書式」は出ない", !hasItem(paraMsg.items, "書式"));
  await page.evaluate(() => window.__reply({ type: "menu-closed", menu: "__context__" }));

  // ---- (B) 見出し行 ----
  await clearSent(page);
  await page.locator(".cm-line", { hasText: "見出し1" }).first().click({ button: "right" });
  await page.waitForTimeout(250);
  const headingMsg = await lastMsg(page, "open-context-menu");
  ok("(B) 見出し行: 「見出しレベル」サブメニューが出る", hasItem(headingMsg.items, "見出しレベル"));
  const levelSub = findItem(headingMsg.items, "見出しレベル")?.submenu ?? [];
  ok("(B) 見出し行: 「見出し1」にchecked", !!levelSub.find((i) => i.label === "見出し1" && i.checked === true));
  ok("(B) 見出し行: 段落サブメニューは出ない(文脈固有が優先)", !hasItem(headingMsg.items, "段落"));
  await page.evaluate(() => window.__reply({ type: "menu-closed", menu: "__context__" }));

  // ---- (B) リスト行 ----
  await clearSent(page);
  await page.locator(".cm-line", { hasText: "箇条書きの行" }).first().click({ button: "right" });
  await page.waitForTimeout(250);
  const listMsg = await lastMsg(page, "open-context-menu");
  ok("(B) リスト行: 「箇条書きに変換」が出てchecked", !!findItem(listMsg.items, "箇条書きに変換")?.checked);
  ok("(B) リスト行: 「番号付きリストに変換」が出る", hasItem(listMsg.items, "番号付きリストに変換"));
  ok("(B) リスト行: 「インデント」が出る", hasItem(listMsg.items, "インデント"));
  await page.evaluate(() => window.__reply({ type: "menu-closed", menu: "__context__" }));

  // ---- (B) リンクの上 ----
  await clearSent(page);
  await page.locator("[data-href]").first().click({ button: "right" });
  await page.waitForTimeout(250);
  const linkMsg = await lastMsg(page, "open-context-menu");
  ok("(B) リンク: 「リンクを開く」が出る", hasItem(linkMsg.items, "リンクを開く"));
  ok("(B) リンク: 「リンクのURLをコピー」が出る", hasItem(linkMsg.items, "リンクのURLをコピー"));
  ok("(B) リンク: 「リンクを編集…」が出る", hasItem(linkMsg.items, "リンクを編集…"));
  ok("(B) リンク: 「リンクを解除」が出る", hasItem(linkMsg.items, "リンクを解除"));
  await page.evaluate(() => window.__reply({ type: "menu-closed", menu: "__context__" }));

  // ---- (B) 画像の上 ----
  await clearSent(page);
  await page.locator(".cm-image-widget").first().click({ button: "right" });
  await page.waitForTimeout(250);
  const imgMsg = await lastMsg(page, "open-context-menu");
  ok("(B) 画像: 「画像を開く」が出る", hasItem(imgMsg.items, "画像を開く"));
  ok("(B) 画像: 「画像のパスをコピー」が出る", hasItem(imgMsg.items, "画像のパスをコピー"));
  ok("(B) 画像: 「画像のパスを編集…」が出る", hasItem(imgMsg.items, "画像のパスを編集…"));
  ok("(B) 画像: 「画像を削除」が出る", hasItem(imgMsg.items, "画像を削除"));
  await page.evaluate(() => window.__reply({ type: "menu-closed", menu: "__context__" }));

  // ---- (B) コードブロックの中 ----
  await clearSent(page);
  await page.locator(".cm-line", { hasText: "console.log" }).first().click({ button: "right" });
  await page.waitForTimeout(250);
  const codeMsg = await lastMsg(page, "open-context-menu");
  ok("(B) コードブロック: 「言語を選択…」が出る", hasItem(codeMsg.items, "言語を選択…"));
  ok("(B) コードブロック: 「コードブロックの内容をコピー」が出る", hasItem(codeMsg.items, "コードブロックの内容をコピー"));
  ok("(B) コードブロック: 「コードブロックを削除」が出る", hasItem(codeMsg.items, "コードブロックを削除"));
  await page.evaluate(() => window.__reply({ type: "menu-closed", menu: "__context__" }));

  // ---- (B) 数式ブロックの上 ----
  await clearSent(page);
  await page.locator(".cm-math-block").first().click({ button: "right" });
  await page.waitForTimeout(250);
  const mathMsg = await lastMsg(page, "open-context-menu");
  ok("(B) 数式ブロック: 「数式を編集」が出る", hasItem(mathMsg.items, "数式を編集"));
  ok("(B) 数式ブロック: 「数式を削除」が出る", hasItem(mathMsg.items, "数式を削除"));
  await page.evaluate(() => window.__reply({ type: "menu-closed", menu: "__context__" }));

  // ---- (B) 表の中 ----
  await clearSent(page);
  const cellB1 = page.locator(".cm-table td", { hasText: "b1" }).first();
  await cellB1.click({ button: "right" });
  await page.waitForTimeout(250);
  const tableMsg = await lastMsg(page, "open-context-menu");
  ok("(B) 表: 「行を上に挿入」が出る", hasItem(tableMsg.items, "行を上に挿入"));
  ok("(B) 表: 「列を左に挿入」が出る", hasItem(tableMsg.items, "列を左に挿入"));
  ok("(B) 表: 「行を削除」が出る", hasItem(tableMsg.items, "行を削除"));
  ok("(B) 表: 「列の配置」サブメニューが出る", hasItem(tableMsg.items, "列の配置"));
  const alignSub = findItem(tableMsg.items, "列の配置")?.submenu ?? [];
  ok("(B) 表: 列の配置に4項目(左揃え/中央揃え/右揃え/指定なし)",
    ["左揃え", "中央揃え", "右揃え", "指定なし"].every((l) => alignSub.some((i) => i.label === l)));
  await page.evaluate(() => window.__reply({ type: "menu-closed", menu: "__context__" }));

  // ---- (B) 選択がある場合: 書式サブメニュー・マークダウン/HTMLとしてコピーが有効 ----
  await clearSent(page);
  await page.locator(".cm-line", { hasText: "普通の段落です" }).first().dblclick(); // 単語選択
  await page.waitForTimeout(150);
  // 選択の中(2重クリックした位置)を右クリック=選択を保持したまま開く。
  await page.locator(".cm-line", { hasText: "普通の段落です" }).first().click({ button: "right" });
  await page.waitForTimeout(250);
  const selMsg = await lastMsg(page, "open-context-menu");
  ok("(B) 選択あり: 「書式」サブメニューが出る", hasItem(selMsg.items, "書式"));
  ok("(B) 選択あり: 「選択箇所を検索」が出る", hasItem(selMsg.items, "選択箇所を検索"));
  ok("(B) 選択あり: 「マークダウンとしてコピー」が有効", findItem(selMsg.items, "マークダウンとしてコピー")?.enabled === true);
  ok("(B) 選択あり: 「切り取り」が有効", findItem(selMsg.items, "切り取り")?.enabled === true);
  ok("(B) 選択あり: 段落サブメニューは出ない", !hasItem(selMsg.items, "段落"));
  await page.evaluate(() => window.__reply({ type: "menu-closed", menu: "__context__" }));

  await page.close();
}

// ============================================================
// (C) 入力欄(検索窓)では入力欄用の最小構成になる
// ============================================================
{
  const page = await newBridgedPage();
  await openFile(page, "本文です");
  await page.keyboard.press("Control+f"); // 検索を開く(edit.find)
  await page.waitForTimeout(300);
  await clearSent(page);
  await page.locator("#search-query").click({ button: "right" });
  await page.waitForTimeout(250);
  const inputMsg = await lastMsg(page, "open-context-menu");
  ok("(C) 入力欄右クリックでopen-context-menuを送信", !!inputMsg);
  const labels = (inputMsg?.items ?? []).map((i) => i.label);
  ok(`(C) 入力欄メニューの構成が仕様どおり ${JSON.stringify(labels)}`,
    JSON.stringify(labels) === JSON.stringify(["元に戻す", "やり直す", "切り取り", "コピー", "貼り付け", "削除", "すべて選択"]));
  ok("(C) マークダウン固有の項目(書式・段落等)が出ない", !hasItem(inputMsg.items, "書式") && !hasItem(inputMsg.items, "段落"));
  await page.evaluate(() => window.__reply({ type: "menu-closed", menu: "__context__" }));
  await page.close();
}

// ============================================================
// (D) ブリッジ無し: HTMLの.menu-dropdownにフォールバックする
// ============================================================
{
  const page = await newPlainPage();
  await setDocPlain(page, "# 見出し\n\n普通の段落です。");
  await page.locator(".cm-line", { hasText: "普通の段落です" }).first().click({ button: "right" });
  await page.waitForTimeout(250);
  const dropdown = await page.$(".menu-dropdown");
  ok("(D) ブリッジ無しではHTMLの.menu-dropdownが出る", dropdown !== null);
  const itemTexts = await page.$$eval(".menu-dropdown > .menu-item .menu-item-label", (els) => els.map((e) => e.textContent));
  ok(`(D) フォールバックにも「段落」サブメニューがある ${JSON.stringify(itemTexts)}`, itemTexts.includes("段落"));
  // 入力欄側もフォールバックで最小構成になることを確認する(#palette-input等は無いので
  // 動的にinputを1つ足して検証する)。
  await page.evaluate(() => {
    const input = document.createElement("input");
    input.id = "__verify_input";
    document.body.appendChild(input);
  });
  await page.locator("#__verify_input").click({ button: "right" });
  await page.waitForTimeout(200);
  const inputDropdownTexts = await page.$$eval(".menu-dropdown:last-of-type > .menu-item .menu-item-label", (els) => els.map((e) => e.textContent));
  ok(`(D) 入力欄もHTMLフォールバックで最小構成になる ${JSON.stringify(inputDropdownTexts)}`,
    JSON.stringify(inputDropdownTexts) === JSON.stringify(["元に戻す", "やり直す", "切り取り", "コピー", "貼り付け", "削除", "すべて選択"]));
  await page.close();
}

// ============================================================
// (E) menu-command で実際に文書へ反映される
// ============================================================
async function docText(page) {
  return page.evaluate(() => window.__paneDebugEditor?.getValue?.() ?? null);
}

// (E-1) ブリッジ無し・HTMLフォールバック経由: 表の行/列挿入・削除・配置、リンク解除、画像削除。
// フォールバックはクリックで即run()が呼ばれるため、ネイティブ経路のmenu-commandと同じ実行結果になる。
{
  const page = await newPlainPage();
  const TABLE = "| A | B |\n| --- | --- |\n| a1 | b1 |\n| a2 | b2 |";
  await setDocPlain(page, TABLE);
  await page.locator(".cm-table td", { hasText: "b1" }).first().click({ button: "right" });
  await page.waitForTimeout(200);
  await page.locator(".menu-dropdown .menu-item-label", { hasText: "行を上に挿入" }).click();
  await page.waitForTimeout(200);
  const afterInsertRow = await docText(page);
  ok(`(E) 表: 行を上に挿入で行数が増える\n${afterInsertRow}`, afterInsertRow.split("\n").length === TABLE.split("\n").length + 1);

  await setDocPlain(page, TABLE);
  await page.locator(".cm-table td", { hasText: "b1" }).first().click({ button: "right" });
  await page.waitForTimeout(200);
  await page.locator(".menu-dropdown .menu-item-label", { hasText: "列を左に挿入" }).click();
  await page.waitForTimeout(200);
  const afterInsertCol = await docText(page);
  // 右クリックしたのはB列(b1)のセルなので、「列を左に挿入」はA列とB列の間に空列を挿入する。
  ok(`(E) 表: 列を左に挿入でA/B列の間に空列が増える\n${afterInsertCol}`, /^\|\s*A\s*\|\s*\|\s*B\s*\|/.test(afterInsertCol.split("\n")[0]));

  await setDocPlain(page, TABLE);
  await page.locator(".cm-table td", { hasText: "b1" }).first().click({ button: "right" });
  await page.waitForTimeout(200);
  await page.locator(".menu-dropdown .menu-item-label", { hasText: "列を削除" }).click();
  await page.waitForTimeout(200);
  const afterDeleteCol = await docText(page);
  ok(`(E) 表: 列を削除でB列が消える\n${afterDeleteCol}`, !afterDeleteCol.includes("B") && !afterDeleteCol.includes("b1"));

  await setDocPlain(page, TABLE);
  await page.locator(".cm-table td", { hasText: "a1" }).first().click({ button: "right" });
  await page.waitForTimeout(200);
  await page.locator(".menu-dropdown .menu-item-label", { hasText: "行を削除" }).click();
  await page.waitForTimeout(200);
  const afterDeleteRow = await docText(page);
  ok(`(E) 表: 行を削除でその行が消える\n${afterDeleteRow}`, !afterDeleteRow.includes("a1") && afterDeleteRow.includes("a2"));

  await setDocPlain(page, TABLE);
  await page.locator(".cm-table td", { hasText: "b1" }).first().click({ button: "right" });
  await page.waitForTimeout(200);
  await page.locator(".menu-dropdown .menu-item-label", { hasText: "表を削除" }).click();
  await page.waitForTimeout(200);
  const afterDeleteTable = await docText(page);
  ok(`(E) 表: 表を削除で表が消える "${afterDeleteTable}"`, !afterDeleteTable.includes("|"));

  // 列の配置(サブメニュー: hoverしてから項目をクリック)
  await setDocPlain(page, TABLE);
  await page.locator(".cm-table th", { hasText: "B" }).first().click({ button: "right" });
  await page.waitForTimeout(200);
  await page.locator(".menu-dropdown .menu-item-label", { hasText: "列の配置" }).hover();
  await page.waitForTimeout(150);
  await page.locator(".menu-dropdown .menu-item-label", { hasText: "右揃え" }).click();
  await page.waitForTimeout(200);
  const afterAlign = await docText(page);
  // 右クリックしたのはB列(th)なので、区切り行の2列目(B列)だけが"--:"(右揃え)になる。
  const sepCols = afterAlign.split("\n")[1].split("|").map((c) => c.trim()).filter(Boolean);
  ok(`(E) 表: 列の配置(右揃え)でB列の区切りが右揃え記法になる\n${afterAlign}`, sepCols[1]?.endsWith(":") && !sepCols[1]?.startsWith(":"));

  // リンクを解除
  await setDocPlain(page, "文中に[リンク](https://example.com)があります。");
  await page.locator("[data-href]").first().click({ button: "right" });
  await page.waitForTimeout(200);
  await page.locator(".menu-dropdown .menu-item-label", { hasText: "リンクを解除" }).click();
  await page.waitForTimeout(200);
  const afterUnlink = await docText(page);
  ok(`(E) リンク: 解除でMarkdown記法が消えテキストだけ残る "${afterUnlink}"`,
    afterUnlink === "文中に[リンク](https://example.com)があります。".replace("[リンク](https://example.com)", "リンク"));

  // 画像を削除
  await setDocPlain(page, "文中に![alt](images/a.png)があります。");
  await page.locator(".cm-image-widget").first().click({ button: "right" });
  await page.waitForTimeout(200);
  await page.locator(".menu-dropdown .menu-item-label", { hasText: "画像を削除" }).click();
  await page.waitForTimeout(200);
  const afterImgDelete = await docText(page);
  ok(`(E) 画像: 削除で記法ごと消える "${afterImgDelete}"`, afterImgDelete === "文中にがあります。");

  await page.close();
}

// (E-2) ブリッジあり・ネイティブ経路: menu-commandを直接送って同じアクションが実行されることも確認する。
{
  const page = await newBridgedPage();
  const TABLE = "| A | B |\n| --- | --- |\n| a1 | b1 |";
  await openFile(page, TABLE);
  await page.locator(".cm-table td", { hasText: "b1" }).first().click({ button: "right" });
  await page.waitForTimeout(200);
  const tableMsg = await lastMsg(page, "open-context-menu");
  const deleteColItem = findItem(tableMsg.items, "列を削除");
  ok("(E-2) 「列を削除」のidが取得できる", !!deleteColItem?.id);
  await page.evaluate((id) => window.__reply({ type: "menu-command", id }), deleteColItem.id);
  await page.waitForTimeout(200);
  // ブリッジありのため getValue は無い代わりに、本文の表示内容(.cm-content、選択が表に
  // 触れているため生テキスト表示になっている)からB列が消えたことを確認する。
  const contentText = await page.locator(".cm-content").innerText();
  ok(`(E-2) menu-commandで実際に列が削除される\n${contentText}`, contentText.includes("A") && !contentText.includes("B") && !contentText.includes("b1"));
  await page.close();
}

// ============================================================
// (F) ページエラー・コンソールエラー0件
// ============================================================
// 存在しないテスト用画像パス(images/sample.png等)の読み込み失敗は意図的なもの
// (.verify-markdown.mjsと同じ扱い。Paneは外部通信を行わないアプリのため、
// 実ファイルが無いパスのimg読み込みは常に失敗する)。
const unexpectedConsoleErrors = allConsoleErrors.filter((m) => !/Failed to load resource/.test(m));
ok(`(F) ページエラー0件 ${JSON.stringify(allErrors)}`, allErrors.length === 0);
ok(`(F) コンソールエラー0件(意図的な画像読込失敗を除く) ${JSON.stringify(unexpectedConsoleErrors)}`, unexpectedConsoleErrors.length === 0);

console.log(`--- 集計: OK=${okCount} NG=${ngCount}`);
await browser.close();
process.exit(ngCount > 0 ? 1 : 0);
