// セキュリティ・堅牢性の不具合5件のうち、JS側で完結する項目(#1〜#3)をPlaywrightで検証する。
// ポートは8166。#4・#5(C#側)はLinux上の別コンソールプロジェクトで別途検証済み(報告参照)。
//   #1 Markdown記法のリンク・画像で javascript:/data:text/html が素通りしない
//      (html-sanitize.jsのisSafeUrl()をmd-to-html.jsが共用する)
//   #2 openOrJumpLink()にもisSafeUrl()による検証がある(防御目的)
//   #3 深くネストしたHTML(60,000段)を開いても/貼り付けても2秒以内に打ち切ること
// window.__paneDebugEditor はmain.jsが恒久的に(ブリッジが無いときだけ)公開しているデバッグ用の
// 入口であり、検証後に取り除く必要は無い(.verify-export.mjs等、他の検証スクリプトも同じ前提)。
import pw from "playwright";
const { chromium } = pw;

const browser = await chromium.launch();
const page = await browser.newPage();

let okCount = 0, ngCount = 0;
const pageErrors = [];
const consoleErrors = [];
const consoleLogs = [];
page.on("pageerror", (e) => pageErrors.push(String(e.stack || e)));
page.on("console", (m) => {
  if (m.type() === "error") consoleErrors.push(m.text());
  else consoleLogs.push(m.text());
});

const ok = (label, cond, extra = "") => {
  console.log(`${cond ? "OK  " : "NG  "} ${label}${extra ? " " + extra : ""}`);
  if (cond) okCount++; else ngCount++;
};

await page.goto("http://localhost:8166/index.html");
await page.waitForTimeout(800);

// ---- ヘルパー ----
const setText = (text) => page.evaluate((t) => {
  window.__paneDebugEditor.blur(); // フォーカスが無い状態(=文書を開いた直後相当)でHTMLブロックのウィジェットが描画される
  window.__paneDebugEditor.setValue(t);
}, text);
const getStandaloneHtml = (config) => page.evaluate((cfg) => window.__paneDebugEditor.getStandaloneHtml(cfg), config);
const getClipboardHtml = () => page.evaluate(() => window.__paneDebugEditor.getHtmlForClipboard());
const getValue = () => page.evaluate(() => window.__paneDebugEditor.getValue());

async function pasteHtml(html) {
  await page.evaluate(() => { window.__pasteDone = false; });
  await page.evaluate((h) => {
    const dt = new DataTransfer();
    dt.setData("text/html", h);
    document.querySelector(".cm-content").dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
    window.__pasteDone = true;
  }, html);
}

// ============================================================
// #1 Markdown記法のリンク・画像: javascript:/data:text/html が素通りしないこと
// ============================================================
console.log("\n==== #1 Markdown記法のリンク・画像のスキーム検証 ====");

// ---- javascript: リンク ----
{
  await setText("[click me](javascript:document.title='HACKED')");
  await page.waitForTimeout(150);
  const exported = await getStandaloneHtml({ title: "t", styled: false });
  const copied = await getClipboardHtml();
  for (const [label, html] of [["HTMLエクスポート", exported], ["HTMLコピー", copied]]) {
    ok(`javascript:リンク(${label}): <a>タグが出力されない`, !/<a[ >]/.test(html), html);
    ok(`javascript:リンク(${label}): href="javascript:...が含まれない`, !html.includes('href="javascript:'), html);
    ok(`javascript:リンク(${label}): リンクテキストは残る(黙って消えていない)`, html.includes("click me"), html);
  }
}

// ---- javascript: 画像 ----
{
  await setText("![x](javascript:alert(1))");
  await page.waitForTimeout(150);
  const exported = await getStandaloneHtml({ title: "t", styled: false });
  const copied = await getClipboardHtml();
  for (const [label, html] of [["HTMLエクスポート", exported], ["HTMLコピー", copied]]) {
    ok(`javascript:画像(${label}): <img>タグが出力されない`, !/<img[ >]/.test(html), html);
    ok(`javascript:画像(${label}): src="javascript:...が含まれない`, !html.includes('src="javascript:'), html);
  }
}

// ---- data:text/html リンク ----
{
  await setText("[y](data:text/html,<script>alert(1)</script>)");
  await page.waitForTimeout(150);
  const exported = await getStandaloneHtml({ title: "t", styled: false });
  const copied = await getClipboardHtml();
  for (const [label, html] of [["HTMLエクスポート", exported], ["HTMLコピー", copied]]) {
    ok(`data:text/html リンク(${label}): <a>タグが出力されない`, !/<a[ >]/.test(html), html);
    ok(`data:text/html リンク(${label}): href="data:text/html...が含まれない`, !html.includes('href="data:text/html'), html);
  }
}

// ---- vbscript: リンク(isSafeUrl()のもう一方の禁止スキーム) ----
{
  await setText("[z](vbscript:msgbox(1))");
  await page.waitForTimeout(150);
  const exported = await getStandaloneHtml({ title: "t", styled: false });
  ok("vbscript:リンク: <a>タグが出力されない", !/<a[ >]/.test(exported), exported);
}

// ---- 正常なURL(従来どおりリンクになること) ----
{
  await setText([
    "[a](https://example.com/path)",
    "",
    "[b](http://example.com)",
    "",
    "[c](mailto:test@example.com)",
    "",
    "[d](./relative/path.md)",
    "",
    "[e](#anchor)",
  ].join("\n"));
  await page.waitForTimeout(150);
  const html = await getStandaloneHtml({ title: "t", styled: false });
  const hrefCount = (html.match(/<a href="/g) || []).length;
  ok(`正常なURL: 5件すべてリンクとして出力される count=${hrefCount}`, hrefCount === 5, html);
  ok("正常なURL: https", html.includes('<a href="https://example.com/path">a</a>'), html);
  ok("正常なURL: http", html.includes('<a href="http://example.com">b</a>'), html);
  ok("正常なURL: mailto", html.includes('<a href="mailto:test@example.com">c</a>'), html);
  ok("正常なURL: 相対パス", html.includes('<a href="./relative/path.md">d</a>'), html);
  ok("正常なURL: #アンカー", html.includes('<a href="#anchor">e</a>'), html);
}

// ---- data:image/png;base64 の画像(壊していないこと) ----
{
  const b64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
  await setText(`![img](data:image/png;base64,${b64})`);
  await page.waitForTimeout(150);
  const exported = await getStandaloneHtml({ title: "t", styled: false });
  const copied = await getClipboardHtml();
  ok("data:image/png(エクスポート): <img>として表示される", exported.includes(`<img src="data:image/png;base64,${b64}"`), exported);
  ok("data:image/png(コピー): <img>として表示される", copied.includes(`<img src="data:image/png;base64,${b64}"`), copied);
}

// ============================================================
// #2 openOrJumpLink() の防御的スキーム検証
// ============================================================
console.log("\n==== #2 openOrJumpLink() の防御的検証 ====");
{
  await page.evaluate(() => { document.querySelector(".extlink-overlay")?.remove(); });
  await page.evaluate(() => window.__paneDebugEditor.openLink("javascript:document.title='HACKED'"));
  await page.waitForTimeout(150);
  const overlay = await page.$(".extlink-overlay");
  ok("javascript:リンクをopenLink()しても確認ダイアログすら出ない(開かれない)", overlay === null);
  const blockedLog = consoleLogs.some((l) => l.includes("安全でないURLのため開きませんでした"));
  ok("openOrJumpLink(): 拒否した理由をコンソールへ記録する", blockedLog, JSON.stringify(consoleLogs.slice(-5)));
}
{
  // 正常なURLは従来どおり確認ダイアログ(confirmOpenExternal)まで到達すること(回帰確認)。
  // 実際に確認して開く(window.open→外部通信)ところまでは行わない。
  await page.evaluate(() => window.__paneDebugEditor.openLink("https://example.com/"));
  await page.waitForTimeout(150);
  const overlay = await page.$(".extlink-overlay");
  ok("正常なURLはopenLink()で確認ダイアログまで到達する(回帰確認)", overlay !== null);
  await page.evaluate(() => { document.querySelector(".extlink-overlay")?.remove(); });
}

// ============================================================
// #3 深くネストしたHTMLでフリーズしないこと
// ============================================================
console.log("\n==== #3 深くネストしたHTMLの安全な打ち切り ====");

const DEEP_NEST_COUNT = 60000;
const deepHtml = "<div>".repeat(DEEP_NEST_COUNT) + "X" + "</div>".repeat(DEEP_NEST_COUNT);
const TIME_BUDGET_MS = 2000;

// ---- (a) 文書を開くだけで2秒以内に完了すること(html-sanitize.js経由) ----
{
  consoleLogs.length = 0;
  const t0 = Date.now();
  await setText(deepHtml);
  // 【テストの既知の脆さの修正】この直後のwaitForTimeoutは「setText自体の完了を待つ」
  // ためではなく、CodeMirror(@lezer/markdown)がこの直後もバックグラウンドで続けている
  // 可能性のある増分パース作業を落ち着かせるためのもの。60,000段という極端な深さの
  // 文書は、たとえ最終的にプレーンテキスト表示に倒れるとしても、構文木の増分パース
  // 自体は(アイドル時間を使って少しずつ進める仕組みのため)完了までに数百ms単位の
  // 時間がかかることがある。ここが短すぎると、次のsetText/pasteHtmlですぐに別の文書
  // (今回のような50段程度の普通の生HTML)へ差し替えたときに、前の巨大文書ぶんの
  // パース作業がまだ残っていて新しい文書の構文木が正しく確定しない(=HTMLBlock
  // ノードとして認識されない)という別のテスト(#3(d))の見かけ上の不具合を引き起こす
  // (実際のアプリの不具合ではなく、テスト側の待ち時間が短すぎたことが原因だった。
  // 実機並みの待ち時間(800ms)を空けるだけで解消することを確認済み)。
  await page.waitForTimeout(800);
  const elapsed = Date.now() - t0;
  ok(`60,000段ネストの文書を開く: ${elapsed}ms (予算${TIME_BUDGET_MS}ms)`, elapsed < TIME_BUDGET_MS, `elapsed=${elapsed}ms`);
  const truncLog = consoleLogs.some((l) => l.includes("パースを打ち切り"));
  ok("開いたとき: 打ち切りをconsole.logへ日本語で記録する(エラーではない)", truncLog, JSON.stringify(consoleLogs.slice(-5)));
  // 見た目上プレーンテキストとして表示され、DOMを実際に60,000段組み立てていないこと。
  const blockText = await page.evaluate(() => document.querySelector(".cm-html-block")?.textContent ?? null);
  ok("開いたとき: HTMLとして解釈されずプレーンテキストとして表示される", blockText !== null && blockText.startsWith("<div><div>"), `length=${blockText?.length}`);
  const nestedDivCount = await page.evaluate(() => document.querySelectorAll(".cm-html-block div").length);
  ok("開いたとき: 実際にはdiv要素を60,000個組み立てていない", nestedDivCount === 0, `count=${nestedDivCount}`);
}
await setText(""); // 後片付け(巨大なDOMを残さない)
await page.waitForTimeout(800); // 上のコメントと同じ理由(バックグラウンドのパース作業を落ち着かせる)

// ---- (b) 貼り付けでも2秒以内に完了すること(html-to-markdown.js経由) ----
{
  consoleLogs.length = 0;
  const t0 = Date.now();
  await pasteHtml(deepHtml);
  await page.waitForTimeout(800); // 上のコメントと同じ理由
  const elapsed = Date.now() - t0;
  ok(`60,000段ネストのHTMLを貼り付け: ${elapsed}ms (予算${TIME_BUDGET_MS}ms)`, elapsed < TIME_BUDGET_MS, `elapsed=${elapsed}ms`);
  const truncLog = consoleLogs.some((l) => l.includes("変換を打ち切りました"));
  ok("貼り付け: 打ち切りをconsole.logへ日本語で記録する(エラーではない)", truncLog, JSON.stringify(consoleLogs.slice(-5)));
}

// ---- (c) 通常のHTML貼り付け(数十段のネスト)は従来どおりMarkdownへ変換されること(回帰確認) ----
{
  await setText("");
  await page.click(".cm-content");
  await page.keyboard.press("Control+End");
  let nested = "<p><b>深いネストの本文</b></p>";
  for (let i = 0; i < 50; i++) nested = `<div>${nested}</div>`; // 50段(MAX_HTML_NEST_DEPTH=500の内側)
  await pasteHtml(nested);
  await page.waitForTimeout(300);
  const value = await getValue();
  ok("通常のネスト(50段)のHTML貼り付け: 従来どおりMarkdownへ変換される", value.includes("**深いネストの本文**"), value);
}

// ---- (d) 通常のブロックHTML(数十段)は従来どおりサニタイズして表示されること(回帰確認) ----
{
  let nested = "<span>安全な入れ子</span>";
  for (let i = 0; i < 50; i++) nested = `<div>${nested}</div>`;
  await setText(nested);
  // 【テストの既知の脆さの修正】直前まで60,000段という極端な深さのHTMLを何度も
  // 開閉していたため、@lezer/markdownの増分パース(アイドル時間を使って少しずつ進める
  // 仕組み)がバックグラウンドでまだ落ち着いていない場合がある。固定のwaitForTimeoutだと
  // 実行環境の負荷(このコンテナは他のエージェントの検証と同時実行されることがある)
  // 次第で必要な時間が変わり、短すぎるとまだ古い巨大文書ぶんの構文木が整理し切って
  // いない状態を掴んでしまう(見かけ上の不具合。実際のアプリの構文木は最終的に
  // 正しく確定する)。固定時間を当てずっぽうに伸ばすのではなく、実際に構文木が
  // 確定してspanが現れるまでポーリングして待つ(最大5秒、通常は数百ms以内に収まる)。
  await page.waitForFunction(
    () => document.querySelector(".cm-html-block span")?.textContent === "安全な入れ子",
    { timeout: 5000 },
  ).catch(() => {}); // タイムアウトしても後続のok()側の判定でNGとして報告させる(ここでは例外にしない)
  const spanText = await page.evaluate(() => document.querySelector(".cm-html-block span")?.textContent ?? null);
  ok("通常のネスト(50段)のブロックHTML: 従来どおりDOMとして描画される", spanText === "安全な入れ子", spanText);
}
await setText("");
await page.waitForTimeout(100);

// ============================================================
// まとめ
// ============================================================
console.log("\n---- JSエラー ----");
pageErrors.forEach((e) => console.log("pageerror:", e));
consoleErrors.forEach((e) => console.log("console.error:", e));
ok("ページエラーが無い", pageErrors.length === 0, JSON.stringify(pageErrors));
ok("コンソールエラーが無い(打ち切りの記録はconsole.logでありconsole.errorではない)", consoleErrors.length === 0, JSON.stringify(consoleErrors));

console.log(`\n--- 集計: OK=${okCount} NG=${ngCount}`);
await browser.close();
process.exit(ngCount === 0 ? 0 : 1);
