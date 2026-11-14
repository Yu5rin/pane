// 2026-11 の全体点検で見つかった、編集まわりの不具合の回帰検証(docs/調査記録/点検27)。ポートは8223。
//   (1) 検索・置換: 正規表現がオフなら「\n」「\t」をそのままの文字として扱う
//   (2) 表: セルに書いた「\|」を列の区切りと数えない(表から離れたときの自動整形で列が増えない)
//   (3) 記号の自動補完: 強調のつもりでない * _ ~ に閉じ側を付けない
//   (4) 日本語入力: 太字などの直後で変換しても、直前の文字が消えない。行末の隠れた閉じ記号の手前で止まらない
//   (5) 書式つきの貼り付け: divで包まれた本文・入れ子のリスト・表のセルの「|」
//   (6) Shiftと数字のショートカット、コードモードでのMarkdown用コマンド、コマンドパレット
//   (7) 見た目: 空の文書の案内、ホバーと選択中の色の区別、表の操作ボタンのSVG
import pw from "playwright";
const { chromium } = pw;
const PORT = 8223;
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
async function open(text, fileName = "a.md") {
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
  page.on("pageerror", (e) => errors.push(String(e.stack || e)));
  await page.addInitScript(installBridge);
  await page.goto(`http://localhost:${PORT}/index.html`);
  await page.waitForFunction(() => window.__sent.some((m) => m.type === "ready"), null, { timeout: 15000 });
  await page.evaluate(({ t, fileName }) => window.__reply({ type: "file-opened", text: t, fileName, path: "C:\\" + fileName, encoding: "UTF-8", lineEnding: "LF" }), { t: text, fileName });
  await page.waitForTimeout(500);
  return page;
}
// 本文は「保存」でC#側へ送られる内容から読む(画面の文字は、ライブプレビューが記法を隠すので当てにならない)。
const value = async (page) => {
  await page.evaluate(() => { window.__sent.length = 0; });
  await page.keyboard.press("Control+S");
  await page.waitForFunction(() => window.__sent.some((m) => m.type === "save"), null, { timeout: 5000 });
  const text = await page.evaluate(() => window.__sent.find((m) => m.type === "save").text);
  await page.evaluate(() => window.__reply({ type: "save-result", ok: true, fileName: "a.md", path: "C:\\a.md" }));
  return text.replace(/\r\n/g, "\n");
};
const toEnd = async (page) => { await page.click(".cm-content"); await page.keyboard.press("Control+End"); };

// ---- (1) 検索・置換 ----
{
  const page = await open("C:\\new\\table.txt\n改行\nnew\n");
  await page.click(".cm-content");
  await page.keyboard.press("Control+H");
  await page.fill("#search-query", "\\new");
  await page.waitForTimeout(200);
  ok("(1) 正規表現オフで「\\new」を探すと、その文字のまま1件見つかる",
    /1 \/ 1|- \/ 1/.test(await page.textContent("#search-count")), await page.textContent("#search-count"));
  await page.fill("#replace-query", "\\t");
  await page.click("#replace-all");
  await page.waitForTimeout(200);
  ok("(1) 置換語の「\\t」がタブにならず、そのまま入る", (await value(page)).startsWith("C:\\t\\table.txt"), await value(page));
  await page.check("#search-regex");
  await page.fill("#search-query", "行\\nnew");
  await page.waitForTimeout(200);
  ok("(1) 正規表現オンでは「\\n」が改行として働く", /1$/.test((await page.textContent("#search-count")).trim()), await page.textContent("#search-count"));
  await page.close();
}

// ---- (2) 表の「\|」 ----
{
  // 先頭に段落を置く(開いた直後はカーソルが先頭にあり、表が先頭だと記法のまま表示される)。
  const src = "上の段落\n\n| 名前 | 説明 |\n| --- | --- |\n| a \\| b | 縦線入り |\n| c | d |\n\n下の段落\n";
  const page = await open(src);
  const shape = await page.evaluate(() => ({
    cols: document.querySelectorAll("#cm-host table thead th").length,
    first: document.querySelector("#cm-host table tbody td")?.firstChild?.textContent,
  }));
  ok("(2) 「\\|」を含む表が2列のまま描画され、セルには「|」と表示される", shape.cols === 2 && shape.first === "a | b", shape);
  // 表の中へカーソルを置いてから外へ出す(=自動整形が走る)。
  await page.click("#cm-host table tbody td");
  await page.waitForTimeout(200);
  await toEnd(page);
  await page.waitForTimeout(300);
  const after = await value(page);
  ok("(2) 表から離れても列が増えず、「\\|」が残る",
    after.split("\n")[2].split("|").length === 4 && after.includes("a \\| b"), after);
  await page.close();
}

// ---- (3) 記号の自動補完 ----
async function typed(keys, start = "") {
  const page = await open(start);
  await toEnd(page);
  await page.keyboard.type(keys, { delay: 5 });
  const v = await value(page);
  await page.close();
  return v;
}
{
  const cases = [
    ["単語の途中の _ に閉じ側を付けない", "open file_name.txt now", "open file_name.txt now"],
    ["掛け算の * に閉じ側を残さない", "2 * 3 = 6", "2 * 3 = 6"],
    ["範囲の ~ に閉じ側を付けない", "10~20", "10~20"],
    ["文の途中の太字が、閉じ側の過不足なく打てる", "a **bold** text", "a **bold** text"],
    ["行頭からの太字が、閉じ側の過不足なく打てる", "**bold** text", "**bold** text"],
    ["斜体はこれまでどおり対になり、閉じ側を乗り越えられる", "a *it* b", "a *it* b"],
    ["太字斜体が打てる", "a ***x*** b", "a ***x*** b"],
    ["全角の文字の直後でも強調が打てる", "これは**重要**です", "これは**重要**です"],
    ["同じ行の2つ目の太字も打てる", "a **b** c **d** e", "a **b** c **d** e"],
    ["箇条書きの中の太字が打てる", "* item **b** c", "* item **b** c"],
  ];
  for (const [label, keys, want] of cases) {
    const got = await typed(keys);
    ok(`(3) ${label}`, got === want, got);
  }
  // 対になること自体が失われていないこと(開いた直後に閉じ側が入っている)。
  const half = await typed("a *it");
  ok("(3) 空白のあとの * は対で入る(打っている途中は閉じ側がある)", half === "a *it*", half);
  const bold = await typed("a **bo");
  ok("(3) 空の対の中でもう一度打つと両側に足される", bold === "a **bo**", bold);
}

// ---- (4) 日本語入力(変換の途中で装飾を作り直さない) ----
// 太字・斜体・コードの直後で変換を始めると、未確定の文字が入るたびにカーソル位置の記法の
// 表示/非表示が切り替わり、ブラウザが変換中の文字を見失って、確定した文字が消えたり二重になった。
async function compose(page, steps, commit) {
  const cdp = await page.context().newCDPSession(page);
  for (const t of steps) {
    await cdp.send("Input.imeSetComposition", { text: t, selectionStart: t.length, selectionEnd: t.length });
    await page.waitForTimeout(60);
  }
  await cdp.send("Input.insertText", { text: commit });
  await page.waitForTimeout(250);
}
{
  const cases = [
    ["太字の直後", "これは**太字**", "これは**太字**日本語"],
    ["斜体の直後", "これは*斜体*", "これは*斜体*日本語"],
    ["コードの直後", "これは`code`", "これは`code`日本語"],
    ["リンクの直後", "これは[リンク](https://example.com)", "これは[リンク](https://example.com)日本語"],
  ];
  for (const [label, start, want] of cases) {
    const page = await open(start + "\n\n次の段落\n");
    await page.click(".cm-content");
    await page.keyboard.press("Control+Home");
    await page.keyboard.press("End");
    await compose(page, ["に", "にほ", "にほん", "にほんご", "日本語"], "日本語");
    const got = (await value(page)).split("\n")[0];
    ok(`(4) ${label}で変換して確定した文字が、そのまま入る`, got === want, got);
    // 確定したあとは、カーソルが行にある間は記法が見え、離れると隠れる(装飾が止まったままになっていない)。
    await page.keyboard.press("Control+End");
    await page.waitForTimeout(250);
    const firstLine = await page.evaluate(() => document.querySelector(".cm-content .cm-line").textContent);
    ok(`(4) ${label}: 確定して行を離れると記法が隠れる`, !/[*`\]]/.test(firstLine), firstLine);
    await page.close();
  }
}

// ---- (5) 書式つきの貼り付け(段落・見出し・入れ子のリスト・表が崩れない) ----
async function pasteHtml(html, plain) {
  const page = await open("");
  await page.click(".cm-content");
  await page.evaluate(({ html, plain }) => {
    const dt = new DataTransfer();
    dt.setData("text/html", html);
    dt.setData("text/plain", plain);
    document.querySelector(".cm-content").dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
  }, { html, plain });
  await page.waitForTimeout(300);
  const v = await value(page);
  await page.close();
  return v.trim();
}
{
  const page1 = await pasteHtml("<div><h2>題</h2><p>一つ目の段落。</p><p>二つ目の<b>段落</b>。</p><ul><li>項目A</li><li>項目B</li></ul></div>", "x");
  ok("(5) divで包まれた本文でも、見出し・段落・リストが分かれたまま入る",
    page1 === "## 題\n\n一つ目の段落。\n\n二つ目の**段落**。\n\n- 項目A\n- 項目B", page1);
  const nested = await pasteHtml("<ul><li>親<ul><li>子1</li><li>子2</li></ul></li><li>次</li></ul>", "x");
  ok("(5) 入れ子のリストが、字下げされた子の項目として入る", nested === "- 親\n    - 子1\n    - 子2\n- 次", nested);
  const table = await pasteHtml("<table><tr><th>名前</th><th>値</th></tr><tr><td>a|b</td><td>1<br>2</td></tr></table>", "x");
  ok("(5) 表のセルの「|」と改行で表が崩れない", table.split("\n").length === 3 && table.includes("a\\|b"), table);
}

{
  // 表のセルへ複数行を貼っても、表の行が途中で切れない。
  const page = await open("上の段落\n\n| 名前 | 説明 |\n| --- | --- |\n| a | b |\n\n下\n");
  await page.click("#cm-host table tbody td");
  await page.waitForTimeout(200);
  await page.evaluate(() => {
    const dt = new DataTransfer();
    dt.setData("text/plain", "1行目\n2行目\n3行目");
    document.querySelector(".cm-content").dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
  });
  await page.waitForTimeout(300);
  const v = await value(page);
  const rows = v.split("\n").filter((l) => l.startsWith("|"));
  ok("(5) 表のセルへ複数行を貼っても、表は3行のまま(改行は空白になる)", rows.length === 3 && /1行目 2行目 3行目/.test(v), v);
  await page.close();
}
{
  // アウトラインは、見出しの記法(** や `)を取り除いた文字を並べる。
  const page = await open("# **重要** な `設定`\n\n本文\n\n## [リンク](https://example.com) の章\n\n本文\n");
  await page.click(".cm-content");
  await page.keyboard.press("Control+Shift+L");
  await page.waitForTimeout(500);
  const labels = await page.$$eval("#sidebar .outline-item, #sidebar [data-slug]", (els) => els.map((e) => e.textContent.trim()));
  ok("(5) アウトラインの見出しに記号が残らない", labels.length >= 2 && labels.every((t) => !/[*`\]]/.test(t)) && labels.some((t) => t.includes("重要 な 設定")), labels);
  await page.close();
}

// ---- (6) ショートカットとモード ----
{
  // Shift と数字の組み合わせ。Shiftを押していると e.key は記号になるので、物理キーで見る必要がある。
  const page = await open("# 見出し\n\n本文\n");
  await page.click(".cm-content");
  const sidebarOpen = () => page.evaluate(() => { const el = document.getElementById("sidebar"); return !!el && !el.hidden && getComputedStyle(el).display !== "none" && el.getBoundingClientRect().width > 0; });
  const before = await sidebarOpen();
  await page.keyboard.press("Control+Shift+Digit1");
  await page.waitForTimeout(300);
  ok("(6) Ctrl+Shift+1 でアウトラインが開く", !before && await sidebarOpen(), { before, after: await sidebarOpen() });
  await page.click(".cm-content");
  await page.keyboard.press("Control+End");
  await page.keyboard.down("Shift"); await page.keyboard.press("Home"); await page.keyboard.up("Shift");
  await page.keyboard.press("Alt+Shift+Digit5");
  await page.waitForTimeout(200);
  const struck = await value(page);
  ok("(6) Alt+Shift+5 で取り消し線が付く", struck.includes("~~"), struck);
  await page.close();
}
{
  // Markdownの記法を書き込むコマンドは、コードモードでは動かない。
  const page = await open('{\n  "a": 1\n}\n', "data.json");
  await page.click(".cm-content");
  await page.keyboard.press("Control+End");
  for (const k of ["Control+B", "Control+Digit1", "Control+K", "Control+Shift+K", "Control+T"]) await page.keyboard.press(k);
  await page.waitForTimeout(200);
  const json = await value(page);
  ok("(6) コードモードでは Ctrl+B・Ctrl+1 などがMarkdownの記法を書き込まない", json.trim() === '{\n  "a": 1\n}', json);
  await page.close();
}
{
  // コマンドパレット: 実行できない項目を並べない(選ぶと落ちていた)。メニュー名でも探せる。
  const page = await open("本文\n");
  await page.click(".cm-content");
  await page.keyboard.press("Control+Shift+P");
  await page.waitForSelector("#palette-input", { timeout: 3000 });
  await page.fill("#palette-input", "最近使った");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(200);
  await page.keyboard.press("Escape");
  await page.keyboard.press("Control+Shift+P");
  await page.fill("#palette-input", "表示");
  const n = await page.$$eval("#palette-list li:not(.palette-empty)", (els) => els.length);
  ok("(6) コマンドパレットで「表示」と打つと、表示メニューの項目が並ぶ", n >= 5, n);
  await page.close();
}

// ---- (7) 見た目: 空の文書の案内、ホバーと選択中の色、表のボタン ----
{
  const page = await open("");
  const hint = await page.evaluate(() => document.querySelector("#cm-host .cm-placeholder")?.textContent ?? null);
  ok("(7) 何も書いていない文書に、薄い案内が出る", !!hint && hint.includes("F1"), hint);
  await page.click(".cm-content");
  await page.keyboard.type("a");
  await page.waitForTimeout(150);
  ok("(7) 1文字打つと案内が消える", await page.evaluate(() => !document.querySelector("#cm-host .cm-placeholder")));
  ok("(7) 案内の文字は文書の内容に含まれない", (await value(page)).trim() === "a");
  await page.close();
}
{
  const page = await open("x\n", "a.js");
  ok("(7) コードの文書には、Markdown向けの案内を出さない", await page.evaluate(() => !document.querySelector("#cm-host .cm-placeholder")));
  await page.close();
}
{
  // コマンドパレット: 矢印キーで選んだ行と、マウスを乗せた行が、別の濃さになる。
  const page = await open("本文\n");
  await page.click(".cm-content");
  await page.keyboard.press("Control+Shift+P");
  await page.waitForSelector("#palette-list li");
  await page.hover("#palette-list li:nth-child(4)");
  await page.waitForTimeout(150);
  const bg = await page.evaluate(() => {
    const rows = document.querySelectorAll("#palette-list li");
    return { sel: getComputedStyle(rows[0]).backgroundColor, hover: getComputedStyle(rows[3]).backgroundColor, plain: getComputedStyle(rows[6]).backgroundColor };
  });
  ok("(7) 選択中の行・マウスを乗せた行・ふつうの行が、3つとも違う地の色になる",
    bg.sel !== bg.hover && bg.hover !== bg.plain && bg.sel !== bg.plain, bg);
  await page.close();
}
{
  // 表の操作ボタンは、文字ではなくSVGで描く。
  const page = await open("上\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n\n下\n");
  const btns = await page.$$eval("#cm-host table .tbl-ctl", (els) => els.map((e) => ({ svg: !!e.querySelector("svg"), text: e.textContent.trim(), label: e.getAttribute("aria-label") })));
  ok("(7) 表の操作ボタンがSVGで、読み上げ用の名前を持つ", btns.length > 0 && btns.every((b) => b.svg && b.text === "" && b.label), btns.slice(0, 3));
  await page.close();
}

ok("ページエラー0件", errors.length === 0, errors);
console.log(`--- 集計: NG=${ng}`);
await browser.close();
process.exit(ng === 0 ? 0 : 1);
