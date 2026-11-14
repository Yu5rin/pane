// 開いた文書の後半(先頭の約3,000文字より後ろ)にある表・[toc]・Mermaid・生HTMLが描画されること、
// 大きな文書でアウトラインが最後の見出しまで並ぶことを確かめる。
//
// CodeMirrorは文書を作った時点では先頭の約3,000文字までしか解析せず、残りは裏で進める。
// 2026-11 の点検まで、表などの一覧は「文書が変わったとき」にしか作り直しておらず、開いた文書の
// 後半の表が記法のまま表示されていた(クリックしても、近くで文字を打っても直らない)。
// 3,000文字より手前だけで試すと必ず通ってしまうので、ここの文書は意図して長くしてある。
import pw from "playwright";
const { chromium } = pw;
const PORT = 8222;
const browser = await chromium.launch();
let ng = 0;
const ok = (label, cond, detail) => {
  console.log(`${cond ? "OK  " : "NG  "} ${label}${cond || detail === undefined ? "" : `\n     実際: ${JSON.stringify(detail)}`}`);
  if (!cond) ng++;
};
const errors = [];
function installBridge() {
  const listeners = [];
  window.__sent = [];
  window.chrome = { webview: {
    postMessage: (m) => { window.__sent.push(m); },
    addEventListener: (_t, fn) => listeners.push(fn),
  } };
  window.__reply = (data) => listeners.forEach((fn) => fn({ data }));
}
const chapter = (n) => `## 章${n}\n\n` + Array.from({ length: 20 }, (_, i) => `これは章${n}の本文の${i + 1}行目です。少し長めの文にしておきます。`).join("\n") + "\n\n";
const tail = "| 列A | 列B |\n| --- | --- |\n| 1 | 2 |\n\n[toc]\n\n```mermaid\ngraph TD; A-->B;\n```\n\n<div>生のHTML</div>\n\n最後の行\n";

async function open(text) {
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
  page.on("pageerror", (e) => errors.push(String(e.stack || e)));
  await page.addInitScript(installBridge);
  await page.goto(`http://localhost:${PORT}/index.html`);
  await page.waitForFunction(() => window.__sent.some((m) => m.type === "ready"), null, { timeout: 15000 });
  await page.evaluate((t) => window.__reply({ type: "file-opened", text: t, fileName: "a.md", path: "C:\\a.md", encoding: "UTF-8", lineEnding: "LF" }), text);
  await page.waitForTimeout(1500);
  return page;
}

{
  const text = [1, 2, 3, 4, 5, 6].map(chapter).join("") + tail;
  ok(`試す文書は3,000文字を超えている(${text.length}文字)`, text.length > 3000);
  const page = await open(text);
  await page.evaluate(() => { const s = document.querySelector(".cm-scroller"); s.scrollTop = s.scrollHeight; });
  await page.waitForTimeout(800);
  const seen = await page.evaluate(() => ({
    table: document.querySelectorAll("#cm-host table").length,
    toc: document.querySelectorAll("#cm-host .cm-toc").length,
    tocItems: document.querySelectorAll("#cm-host .cm-toc a, #cm-host .cm-toc li, #cm-host .cm-toc [data-slug]").length,
    rawPipe: [...document.querySelectorAll("#cm-host .cm-line")].some((l) => l.textContent.includes("| 列A |")),
    rawHtml: [...document.querySelectorAll("#cm-host .cm-line")].some((l) => l.textContent.includes("<div>")),
  }));
  ok("後半の表が表として描画される", seen.table === 1 && !seen.rawPipe, seen);
  ok("後半の[toc]が目次として描画され、見出しが並ぶ", seen.toc === 1 && seen.tocItems >= 3, seen);
  ok("後半の生HTMLが記法のまま残らない", !seen.rawHtml, seen);
  await page.close();
}

{
  const text = Array.from({ length: 150 }, (_, i) => chapter(i + 1)).join("");
  const page = await open(text);
  await page.keyboard.press("Control+Shift+L"); // サイドバーを開く(既定はアウトライン)
  await page.waitForTimeout(2500);
  const last = await page.evaluate(() => {
    const items = [...document.querySelectorAll("#sidebar .outline-item, #sidebar [data-slug]")];
    return { count: items.length, lastText: items.at(-1)?.textContent ?? "" };
  });
  ok("大きな文書でも、アウトラインが最後の見出し(章150)まで並ぶ", last.lastText.includes("章150"), last);
  await page.close();
}

ok(`ページのエラーが無い(${errors.length}件)`, errors.length === 0, errors.slice(0, 3));
await browser.close();
console.log(`\nNG=${ng}`);
process.exit(ng ? 1 : 0);
