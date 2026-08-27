// 修正2の検証: マウスホバーで表示したコードブロックのコピーボタンが、キー入力(=装飾の
// 再構築)で消えてしまう不具合の再現・修正確認。ポートは8196(.verify-codecopy-activeline.mjsと
// 同じdistを使う)。
//
// 再現条件(実測で特定): 旧実装はcodeCopyHoverPlugin(view.contentDOMへ直接
// addEventListener)がホバー中のブロックの開始行(.cm-cb-first)へ
// classList.add("cm-cb-hot")するだけの、CodeMirrorの装飾システムを経由しない実装だった。
// CodeMirrorのDecoration.line({class})は装飾が再構築されるたびに行DOMのclass属性ごと
// 上書きするため、livePreview(ドキュメントへのほぼ全dispatchで装飾を作り直す)がキー入力の
// たびに再構築を起こし、DOMへ直接付けたcm-cb-hotクラスが消えていた。マウスは一切動かして
// いないため、ユーザー視点では「ホバーしたままなのにボタンが消える」不具合になる。
import pw from "playwright";
const { chromium } = pw;
const browser = await chromium.launch();
const PORT = 8196;
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
async function copyBtnState(page) {
  return page.locator(".cm-code-copy").evaluate((el) => ({
    opacity: getComputedStyle(el).opacity,
    hasHot: el.closest(".cm-cb-first")?.classList.contains("cm-cb-hot") ?? null,
  }));
}

const MD_WITH_CODE =
  "# 見出し\n\n本文です。\n\n```js\nconst a = 1;\nconst b = 2;\n```\n\nおわり。\n";

// ================= (1) ホバーしたまま、コードブロックより手前(見出し)へキー入力 =================
// 見出しへの入力でコードブロックの開始フェンス位置(open.from)自体がずれる(=StateFieldに
// 保持した位置をmapPos()で追従させているかどうかも同時に確認できるケース)。
{
  const page = await newPage();
  await applySettings(page, { showStatusBar: true, displayMode: "window" });
  await openFile(page, "fix2-a.md", MD_WITH_CODE);

  await page.locator(".cm-content").getByText("const a = 1;").hover();
  await page.waitForTimeout(200);
  const before = await copyBtnState(page);
  ok(`(1) 前提: ホバー直後はコピーボタンが不透明度1・cm-cb-hot付き(実際=${JSON.stringify(before)})`,
    before.opacity === "1" && before.hasHot === true);

  // マウスは動かさない(.focus()はmousemove/mouseoverを発生させない)。
  await page.locator(".cm-content").focus();
  await page.keyboard.press("Control+Home");
  await page.keyboard.press("End");
  await page.keyboard.type("x", { delay: 20 });
  await page.waitForTimeout(200);
  const after = await copyBtnState(page);
  console.log(`  [実測] 見出しへ1文字入力した後(マウス位置は不変): ${JSON.stringify(after)}`);
  ok(`(1) 修正確認: 見出しへ1文字入力してもコピーボタンが消えない(実際=${JSON.stringify(after)})`,
    after.opacity === "1" && after.hasHot === true);
  await page.close();
}

// ================= (2) ホバーしたまま、同じコードブロックの中へキー入力 =================
{
  const page = await newPage();
  await applySettings(page, { showStatusBar: true, displayMode: "window" });
  await openFile(page, "fix2-b.md", MD_WITH_CODE);

  await page.locator(".cm-content").getByText("const a = 1;").hover();
  await page.waitForTimeout(200);
  const before = await copyBtnState(page);
  ok(`(2) 前提: ホバー直後はコピーボタンが不透明度1・cm-cb-hot付き(実際=${JSON.stringify(before)})`,
    before.opacity === "1" && before.hasHot === true);

  await page.locator(".cm-content").focus();
  await page.keyboard.press("Control+Home");
  for (let i = 0; i < 5; i++) await page.keyboard.press("ArrowDown");
  await page.keyboard.press("End");
  await page.keyboard.type("9", { delay: 20 });
  await page.waitForTimeout(200);
  const after = await copyBtnState(page);
  console.log(`  [実測] ブロック内へ1文字入力した後(マウス位置は不変): ${JSON.stringify(after)}`);
  ok(`(2) 修正確認: ブロック内へ1文字入力してもcm-cb-hotが消えない(実際=${JSON.stringify(after)})`,
    after.hasHot === true);
  await page.close();
}

// ================= (3) 回帰確認: マウスが実際にブロックから離れれば、ちゃんと消える =================
{
  const page = await newPage();
  await applySettings(page, { showStatusBar: true, displayMode: "window" });
  await openFile(page, "fix2-c.md", MD_WITH_CODE);
  await page.locator(".cm-content").getByText("const a = 1;").hover();
  await page.waitForTimeout(200);
  ok("(3) 前提: ホバー中はcm-cb-hotが付く", (await copyBtnState(page)).hasHot === true);
  await page.mouse.move(2, 2);
  await page.waitForTimeout(200);
  const left = await copyBtnState(page);
  ok(`(3) マウスが実際に離れるとcm-cb-hotが消える(不透明度0に戻る。実際=${JSON.stringify(left)})`,
    left.opacity === "0" && left.hasHot === false);
  await page.close();
}

ok(`ページエラー・コンソールエラーが0件: ${errors.length}件${errors.length ? " " + JSON.stringify(errors.slice(0, 3)) : ""}`, errors.length === 0);
console.log(`\n合計: OK=${okCount} NG=${ngCount}`);
await browser.close();
process.exit(ngCount > 0 ? 1 : 0);
