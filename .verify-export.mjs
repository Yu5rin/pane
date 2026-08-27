// エクスポート・印刷の詳細設定(仕様書 docs/設定項目一覧.md「エクスポート・印刷」節)のうち、
// JS側(src/md-to-html.js)で完結する項目をPlaywrightで検証する。
//   exportPageBreakBetweenTopHeadings / exportIncludeOutline / exportAppendHead /
//   exportAppendBody / exportMathAs / whitespaceOnExport
// ブリッジ(WebView2)が無いPlaywright上ではcommands.exportAs()が早期returnしてしまうため、
// main.js側で一時公開したwindow.__paneDebugEditor(TEMP-VERIFY)経由でeditor.getStandaloneHtml()を
// 直接呼ぶ。検証が終わったらこの一時公開はmain.jsから削除する(タスク指示どおり)。
import pw from "playwright";
const { chromium } = pw;
const browser = await chromium.launch();
const page = await browser.newPage();
const errors = [];
const consoleErrors = [];
page.on("pageerror", (e) => errors.push(String(e.stack || e)));
page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });
page.on("dialog", async (d) => { await d.accept("3"); });

await page.goto("http://localhost:8157/index.html");
await page.waitForTimeout(800);

const ok = (label, cond) => console.log(`${cond ? "OK  " : "NG  "} ${label}`);

const clearDoc = async () => {
  await page.click(".cm-content");
  await page.keyboard.press("Control+a");
  await page.keyboard.press("Delete");
};
const setText = async (text) => {
  await clearDoc();
  await page.keyboard.insertText(text);
  await page.waitForTimeout(200);
};
// window.__paneDebugEditor.getStandaloneHtml(config) はPromiseを返す。
const getHtml = (config) => page.evaluate((cfg) => window.__paneDebugEditor.getStandaloneHtml(cfg), config);
const setToggles = (toggles) => page.evaluate((t) => window.__paneDebugEditor.setExtensionToggles(t), toggles);

// ---- exportPageBreakBetweenTopHeadings ----
{
  await setText("# 見出し1\n\n本文A\n\n# 見出し2\n\n本文B\n\n## 見出し2-1\n\n本文C");
  const onHtml = await getHtml({ title: "t", styled: false, pageBreakBetweenTopHeadings: true });
  const breakCount = (onHtml.match(/break-before:page/g) || []).length;
  ok(`exportPageBreakBetweenTopHeadings=true: 改ページ指定が1箇所(最上位見出しは2つ、先頭は除く) count=${breakCount}`, breakCount === 1);
  // 1つ目のh1には付かず、2つ目のh1にだけ付いていること
  const h1Match = [...onHtml.matchAll(/<h1([^>]*)>([^<]*)<\/h1>/g)];
  ok(`exportPageBreakBetweenTopHeadings=true: 先頭のh1には付かない ${JSON.stringify(h1Match.map(m=>m[1]))}`,
    h1Match.length === 2 && !h1Match[0][1].includes("break-before") && h1Match[1][1].includes("break-before"));

  const offHtml = await getHtml({ title: "t", styled: false, pageBreakBetweenTopHeadings: false });
  ok("exportPageBreakBetweenTopHeadings=false: 改ページ指定なし", !offHtml.includes("break-before:page"));
}

// ---- exportIncludeOutline / exportOutlineWidthPx ----
{
  await setText("# 見出し1\n\n本文A\n\n## 見出し1-1\n\n本文B");
  const onHtml = await getHtml({ title: "t", styled: false, includeOutline: true, outlineWidthPx: 321 });
  ok("exportIncludeOutline=true: pane-export-outlineが含まれる", onHtml.includes('class="pane-export-outline"'));
  ok("exportOutlineWidthPx=321: 指定した幅がstyleに反映される", onHtml.includes("width:321px"));
  const itemCount = (onHtml.match(/<a class="pane-outline-item/g) || []).length;
  ok(`exportIncludeOutline=true: 見出し2件ぶんのリンクがある count=${itemCount}`, itemCount === 2);
  ok("exportIncludeOutline=true: 見出し本体にid属性が振られている", /<h1 id="[^"]+"/.test(onHtml));

  const offHtml = await getHtml({ title: "t", styled: false, includeOutline: false });
  ok("exportIncludeOutline=false: pane-export-outlineが含まれない", !offHtml.includes("pane-export-outline"));
}

// ---- exportAppendHead / exportAppendBody ----
{
  await setText("# タイトル\n\n本文");
  const marker = "x-test-" + Date.now();
  const html = await getHtml({
    title: "t", styled: false,
    appendHead: `<meta name="${marker}-head" content="1">`,
    appendBody: `<div id="${marker}-body">EXTRA</div>`,
  });
  const headSection = html.slice(html.indexOf("<head>"), html.indexOf("</head>"));
  const bodySection = html.slice(html.indexOf("<body>"), html.indexOf("</body>"));
  ok("exportAppendHead: <head>内に指定したHTMLがそのまま挿入される", headSection.includes(`${marker}-head`));
  ok("exportAppendBody: <body>内に指定したHTMLがそのまま挿入される", bodySection.includes(`${marker}-body`) && bodySection.includes("EXTRA"));
  ok("exportAppendHead/Body: サニタイズしない旨のコメントが残る", html.includes("サニタイズせず"));

  const emptyHtml = await getHtml({ title: "t", styled: false, appendHead: "", appendBody: "" });
  ok("appendHead/appendBodyが空なら何も追加されない", !emptyHtml.includes(marker));
}

// ---- exportMathAs ----
{
  // 注意: インライン数式に"^"や"_"を含めると、ライブプレビュー同様に構文木側のSuperscript/
  // Subscript(またはEmphasis)記法として先に解釈されてしまい、$...$の対応する片方が別ノードに
  // 分断されて数式として認識できなくなる(既存のライブプレビューにもある制約で、今回新たに
  // 導入したものではない。詳細は報告に記載)。ここでは"^""_"を含まない数式で検証する。
  await setText("インライン数式 $\\alpha + \\beta = \\gamma$ です。\n\n$$\nE = mc2\n$$\n\n続きの本文。");
  const latexHtml = await getHtml({ title: "t", styled: false, mathAs: "latex" });
  ok("exportMathAs=latex: 元のLaTeXソースがそのまま(エスケープ済み)出力される",
    latexHtml.includes("\\alpha") && latexHtml.includes("E = mc2") && !latexHtml.includes("pane-math-ph"));
  ok("exportMathAs=latex: SVGへ変換されていない(mjx-containerが無い)", !latexHtml.includes("mjx-container"));

  const svgHtml = await getHtml({ title: "t", styled: false, mathAs: "svg" });
  ok("exportMathAs=svg: MathJaxのSVG(mjx-container)へ変換される", svgHtml.includes("mjx-container") && svgHtml.includes("<svg"));
  ok("exportMathAs=svg: プレースホルダが残っていない", !svgHtml.includes("pane-math-ph"));
  ok("exportMathAs=svg: ブロック数式はpane-math-svgでラップされる", svgHtml.includes("pane-math-svg"));
}

// ---- whitespaceOnExport ----
{
  await setToggles({ whitespaceOnExport: "preserve" });
  await setText("行1\n行2(ソフト改行)");
  const preserveHtml = await getHtml({ title: "t", styled: false });
  ok('whitespaceOnExport="preserve": 段落内の単独改行が<br>になる', preserveHtml.includes("<br>"));

  await setToggles({ whitespaceOnExport: "ignore" });
  const ignoreHtml = await getHtml({ title: "t", styled: false });
  ok('whitespaceOnExport="ignore": <br>が入らない', !ignoreHtml.includes("<br>"));
  // 既定に戻しておく(後続の検証・回帰確認に影響しないように)
  await setToggles({ whitespaceOnExport: "ignore" });
}

console.log("\n---- JSエラー ----");
errors.forEach((e) => console.log("pageerror:", e));
consoleErrors.forEach((e) => console.log("console.error:", e));
ok("JS未処理エラーが無い", errors.length === 0);

await browser.close();
