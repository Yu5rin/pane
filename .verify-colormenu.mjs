// カラープレビューの右クリックメニュー配線(main.jsのbuildEditorContextMenuTree)の検証。ポートは8163。
// docs/カラープレビュー仕様.md 第4章「色リテラルを右クリックすると先頭に『色を変更…』が出る」。
import pw from "playwright";
const { chromium } = pw;
const browser = await chromium.launch();
let okCount = 0, ngCount = 0;
const errors = [], consoleErrors = [];
const ok = (label, cond, extra = "") => { console.log(`${cond ? "OK  " : "NG  "} ${label}${extra ? " " + extra : ""}`); if (cond) okCount++; else ngCount++; };

const page = await browser.newPage();
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
await page.goto("http://localhost:8163/index.html");
await page.waitForTimeout(900);

// 右クリックして、送られた open-context-menu の items を返す。
async function contextMenuAt(selectorOrPoint) {
  await page.evaluate(() => { window.__sent.length = 0; });
  if (typeof selectorOrPoint === "string") await page.click(selectorOrPoint, { button: "right" });
  else await page.mouse.click(selectorOrPoint.x, selectorOrPoint.y, { button: "right" });
  await page.waitForTimeout(350);
  const msg = await page.evaluate(() => window.__sent.find((m) => m.type === "open-context-menu") ?? null);
  return msg?.items ?? null;
}
// 文書中の文字列の中央座標をDOMから求める(その文字を狙って右クリックするため)。
async function coordsOfText(needle) {
  return page.evaluate((n) => {
    const walker = document.createTreeWalker(document.querySelector(".cm-content"), NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const i = node.textContent.indexOf(n);
      if (i < 0) continue;
      const range = document.createRange();
      range.setStart(node, i);
      range.setEnd(node, i + n.length);
      const r = range.getBoundingClientRect();
      if (r.width <= 0) continue;
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    }
    return null;
  }, needle);
}
async function setDoc(mode, text) {
  // モードの切替はメニュー経由(C#役からmenu-commandを返す)。ブリッジありの状態では
  // window.__paneDebugCtx が公開されないため、実際の操作と同じ経路を使う。
  // menu-commandの実行表(nativeRunRegistry)はメニューを開いたときに作られるため、
  // 先に「表示」メニューを開いてからidを返す必要がある。
  const id = mode === "code" ? "view.modeCode" : mode === "plain" ? "view.modePlain" : "view.modeMarkdown";
  await page.click("#menubar .menu-top:text('表示')");
  await page.waitForTimeout(200);
  await page.evaluate((i) => window.__reply({ type: "menu-command", id: i }), id);
  await page.waitForTimeout(400);
  await page.click(".cm-content");
  await page.keyboard.press("Control+a");
  await page.keyboard.press("Delete");
  await page.keyboard.insertText(text);
  await page.waitForTimeout(600);
}
const labels = (items) => (items ?? []).map((i) => i.label);

// ---- (1) コードモード ----
await setDoc("code", "body {\n  color: #14599F;\n  background: rgb(20, 89, 159);\n  margin: 0;\n}\n");
let pt = await coordsOfText("#14599F");
ok("(1) 対象の色リテラルの座標が取れる", !!pt, JSON.stringify(pt));
let items = await contextMenuAt(pt);
ok("(1) コードモード: 16進の上で右クリックすると先頭が「色を変更…」", (labels(items)[0] ?? "").startsWith("色を変更…"), JSON.stringify(labels(items).slice(0, 3)));
ok("(1) ラベルに元の色番号(16進)が入っている", (labels(items)[0] ?? "").includes("#14599F"), labels(items)[0]);

pt = await coordsOfText("rgb(20, 89, 159)");
items = await contextMenuAt(pt);
ok("(1) コードモード: rgb記法の上でも「色を変更…」が出る", (labels(items)[0] ?? "").startsWith("色を変更…"), labels(items)[0]);
ok("(1) ラベルに元の色番号(rgb)がそのまま入っている", (labels(items)[0] ?? "").includes("rgb(20, 89, 159)"), labels(items)[0]);

pt = await coordsOfText("margin");
items = await contextMenuAt(pt);
ok("(1) 色でない場所では「色を変更…」が出ない", !labels(items).some((l) => l.startsWith("色を変更…")), JSON.stringify(labels(items).slice(0, 3)));
ok("(1) 色でない場所でも通常のメニューは出る", labels(items).includes("すべて選択"), JSON.stringify(labels(items)));

// ---- (2) Markdownモードのコードフェンス内 ----
await setDoc("markdown", "本文の #123456 は色ではない\n\n```css\na { color: #ff6600; }\n```\n");
pt = await coordsOfText("#ff6600");
items = await contextMenuAt(pt);
ok("(2) Markdownのコードフェンス内では「色を変更…」が出る", (labels(items)[0] ?? "").startsWith("色を変更…"), labels(items)[0]);

pt = await coordsOfText("#123456");
items = await contextMenuAt(pt);
ok("(2) Markdown本文の #123456 では出ない(色として扱わない)", !labels(items).some((l) => l.startsWith("色を変更…")), JSON.stringify(labels(items).slice(0, 3)));

// ---- (3) 設定OFFのとき ----
await page.evaluate(() => window.__reply({ type: "apply-settings", colorPreviewInCode: false }));
await page.waitForTimeout(400);
await setDoc("code", "body { color: #14599F; }\n");
pt = await coordsOfText("#14599F");
items = await contextMenuAt(pt);
ok("(3) colorPreviewInCode=false では「色を変更…」が出ない", !labels(items).some((l) => l.startsWith("色を変更…")), JSON.stringify(labels(items).slice(0, 3)));
ok("(3) スウォッチも表示されない", (await page.$$(".cm-color-swatch")).length === 0);

await page.evaluate(() => window.__reply({ type: "apply-settings", colorPreviewInCode: true }));
await page.waitForTimeout(400);
ok("(3) trueに戻すとスウォッチが表示される", (await page.$$(".cm-color-swatch")).length > 0);

ok("ページエラー0件", errors.length === 0, JSON.stringify(errors));
ok("コンソールエラー0件", consoleErrors.length === 0, JSON.stringify(consoleErrors));
console.log(`--- 集計: OK=${okCount} NG=${ngCount}`);
await browser.close();
process.exit(ngCount === 0 ? 0 : 1);
