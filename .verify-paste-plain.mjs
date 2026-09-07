// 貼り付けの検証。ポートは8201。
//
// 【実際に起きたこと】メールソフトから複数行のテキストを貼り付けると、行の間に空行が
// 入って行数がほぼ倍になった(実機で21行→35行)。原因は、送り元が text/plain と一緒に
// 載せる text/html を必ずMarkdownへ変換していたこと。その中身は各行を <div> や <p> で
// 包んだだけで、htmlToMarkdown は段落の区切りとして空行を入れる。
// 行頭の全角スペースが消える・連続した半角スペースが1つに縮む、という副作用もあった。
//
// 書式(見出し・リスト・表・引用・コード・リンク・画像・強調)が1つも無いHTMLは、
// 変換しても得るものが無いためプレーンテキストをそのまま貼る(htmlIsPlainTextLike)。
// このスイートは「書式なしは素通しする」ことと「書式ありは従来どおり変換する」ことの
// 両方を固定する。片方だけだと、素通しを広げすぎて書式を殺す変更に気づけない。
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
await page.goto("http://localhost:8201/index.html");
await page.waitForTimeout(800);

// 本文は request-text で取る。.cm-content の innerText はCSSの影響で余分な改行が入り、
// 行数を数える用途には使えない(この件を調べている最中に実際に誤った数字を出した)。
async function paste(html, plain) {
  await page.evaluate(() => window.__reply({ type: "new-document" }));
  await page.waitForTimeout(150);
  await page.evaluate(({ html, plain }) => {
    const dt = new DataTransfer();
    if (html) dt.setData("text/html", html);
    dt.setData("text/plain", plain);
    document.querySelector(".cm-content").dispatchEvent(
      new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
  }, { html, plain });
  await page.waitForTimeout(250);
  return page.evaluate(async () => {
    window.__sent.length = 0;
    window.__reply({ type: "request-text" });
    for (let i = 0; i < 60; i++) {
      const m = window.__sent.find((x) => x.type === "text-response");
      if (m) return m.text;
      await new Promise((r) => setTimeout(r, 20));
    }
    return "(取得できず)";
  });
}

// ---- (A) 書式の無いHTMLは、プレーンテキストをそのまま貼る ----
const PLAIN = [
  "〈電気回答〉",
  "■追加設計時間",
  "・超多芯制御ケーブル（HS1-3のみ）：15時間/バンク",
  "",
  "■追加機器",
  "　　制御ケーブル116芯(YE205C844-26、90m  2本/台",
].join("\n");

const wrappers = {
  "各行が<div>(Outlook/Gmail風)": (l) => `<div>${l || "<br>"}</div>`,
  "各行が<p>(Word風)": (l) => `<p>${l || "&nbsp;"}</p>`,
  "<span>入り(装飾のないstyleだけ)": (l) => `<div><span style="color:#000">${l || "<br>"}</span></div>`,
};
for (const [name, wrap] of Object.entries(wrappers)) {
  const html = PLAIN.split("\n").map(wrap).join("");
  const got = await paste(html, PLAIN);
  ok(`(A) ${name}: 行数が変わらない`, got.split("\n").length === PLAIN.split("\n").length,
    `(期待 ${PLAIN.split("\n").length}行, 実際 ${got.split("\n").length}行)`);
  ok(`(A) ${name}: 中身がそのまま`, got === PLAIN);
}
{
  const got = await paste(null, PLAIN);
  ok("(A) HTMLが無い場合もそのまま", got === PLAIN);
}
// 行頭の全角スペース・連続した半角スペースが保たれること(HTML変換では失われていた)
{
  const html = PLAIN.split("\n").map((l) => `<div>${l || "<br>"}</div>`).join("");
  const got = await paste(html, PLAIN);
  ok("(A) 行頭の全角スペースが残る", got.includes("　　制御ケーブル116芯"));
  ok("(A) 連続した半角スペースが残る", got.includes("90m  2本/台"));
  ok("(A) 空行が消えない", got.split("\n").filter((l) => l === "").length === 1);
}

// ---- (B) 書式のあるHTMLは、従来どおりMarkdownへ変換する ----
const formatted = [
  ["見出し", "<h2>見出し</h2><p>本文</p>", (t) => t.startsWith("## 見出し")],
  ["リンク", "<div>参考: <a href='https://example.com'>例</a></div>", (t) => t.includes("[例](https://example.com)")],
  ["強調", "<div>これは<strong>太字</strong>です</div>", (t) => t.includes("**太字**")],
  ["引用", "<blockquote>引用文</blockquote>", (t) => t.startsWith("> 引用文")],
  ["表", "<table><tr><td>a</td><td>b</td></tr></table>", (t) => t.includes("| a | b |")],
  ["コード", "<pre><code>x = 1</code></pre>", (t) => t.includes("```")],
  ["画像", "<div><img src='https://example.com/a.png' alt='図'></div>", (t) => t.includes("![図](https://example.com/a.png)")],
  ["区切り線", "<div>あ</div><hr><div>い</div>", (t) => t.includes("---")],
];
for (const [name, html, check] of formatted) {
  const got = await paste(html, "(プレーン)");
  ok(`(B) ${name}: Markdownへ変換される`, check(got), `→ ${JSON.stringify(got.slice(0, 60))}`);
}

// リストは項目の間に空行を入れない(以前は1項目ずつ積んでいたため空行が入り、
// Markdownとして「ゆるいリスト」=各項目が段落、になっていた)
{
  const got = await paste("<ul><li>あ</li><li>い</li><li>う</li></ul>", "あ\nい\nう");
  ok("(B) 箇条書き: 記号が付く", got.startsWith("- あ"));
  ok("(B) 箇条書き: 項目の間に空行が入らない", got === "- あ\n- い\n- う", `→ ${JSON.stringify(got)}`);
}
{
  const got = await paste("<ol><li>あ</li><li>い</li></ol>", "あ\nい");
  ok("(B) 番号付き: 項目の間に空行が入らない", got === "1. あ\n2. い", `→ ${JSON.stringify(got)}`);
}
// 段落どうしは空行で区切る(こちらはMarkdownとして正しいので変えない)
{
  const got = await paste("<h2>見出し</h2><p>1段落目</p><p>2段落目</p>", "見出し\n1段落目\n2段落目");
  ok("(B) 段落の間には空行が入る", got.includes("1段落目\n\n2段落目"), `→ ${JSON.stringify(got)}`);
}

ok("ページエラーが無い", errors.length === 0, errors.join(" / "));
ok("consoleエラーが無い", consoleErrors.length === 0, consoleErrors.join(" / "));
console.log(`\n合計: OK=${okCount} NG=${ngCount}`);
await browser.close();
process.exit(ngCount ? 1 : 0);
