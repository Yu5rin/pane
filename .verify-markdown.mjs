import pw from "playwright";
const { chromium } = pw;
const browser = await chromium.launch();
const page = await browser.newPage();
const errors = [];
const consoleErrors = [];
page.on("pageerror", (e) => errors.push(String(e.stack || e)));
page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });
page.on("dialog", async (d) => { await d.accept("3"); });

await page.goto("http://localhost:8148/index.html");
await page.waitForTimeout(800);

const ok = (label, cond) => console.log(`${cond ? "OK  " : "NG  "} ${label}`);

const clearDoc = async () => {
  await page.click(".cm-content");
  await page.keyboard.press("Control+a");
  await page.keyboard.press("Delete");
};

// ---- (a)(b)(c)(d) 画像のライブプレビュー ----
{
  await clearDoc();
  await page.keyboard.insertText("![ロゴ](icon.svg)\n\n本文中に ![inline](icon.svg) 画像。");
  await page.keyboard.press("Control+End");
  await page.waitForTimeout(400);
  const imgs = await page.$$eval(".cm-image-widget img", (els) => els.map((e) => ({ w: e.naturalWidth, src: e.getAttribute("src") })));
  ok(`(a) img要素が生成され幅が0でない ${JSON.stringify(imgs)}`, imgs.length === 2 && imgs.every((i) => i.w > 0));
  const rawVisible = await page.evaluate(() => document.querySelector(".cm-content").innerText.includes("![ロゴ]"));
  ok("(a) 生記法が画面テキストに残っていない", !rawVisible);

  // (b) カーソルを画像記法内へ
  await page.evaluate(() => {
    const cm = document.querySelector(".cm-content");
    cm.dispatchEvent(new Event("focus"));
  });
  await page.click(".cm-content");
  await page.keyboard.press("Control+Home");
  await page.waitForTimeout(300);
  const rawAtCursor = await page.evaluate(() => document.querySelector(".cm-content").innerText.includes("![ロゴ]"));
  ok("(b) カーソルを画像記法内に置くと生記法に戻る", rawAtCursor);
  await page.keyboard.press("Control+End");
  await page.waitForTimeout(300);

  // (c) 描画された画像をクリックすると記法が展開される
  const firstImg = await page.$(".cm-image-widget img");
  await firstImg.click();
  await page.waitForTimeout(300);
  const rawAfterClick = await page.evaluate(() => document.querySelector(".cm-content").innerText.includes("![ロゴ]"));
  ok("(c) 描画された画像をクリックすると記法が展開される", rawAfterClick);
  await page.keyboard.press("Control+End");
  await page.waitForTimeout(300);

  // (d) 外部リソースの自動読み込み既定OFF(docs/調査記録/修正-セキュリティ.md参照)。以前はここで
  //     https://example.com/none.png への実際の読み込み失敗(404/接続不可)を長時間
  //     待っていたが、既定変更により「試みて失敗する」ではなく「そもそも試みない」に
  //     変わったため、外部への実通信も待ち時間も無くなった(詳しい検証は.verify-extres.mjs)。
  await clearDoc();
  await page.keyboard.insertText("![x](https://example.com/none.png)\n\n(末尾)");
  await page.keyboard.press("Control+Home");
  await page.waitForTimeout(300);
  await page.keyboard.press("Control+End");
  await page.waitForTimeout(300);
  const blockedState = await page.evaluate(() => {
    const w = document.querySelector(".cm-image-widget");
    return w ? { isBlocked: w.classList.contains("cm-image-blocked"), text: w.textContent, hasImg: !!w.querySelector("img"), rect: w.getBoundingClientRect() } : null;
  });
  ok(`(d) 既定OFFの外部画像は通信を試みずプレースホルダになる ${JSON.stringify(blockedState)}`, blockedState && blockedState.isBlocked && !blockedState.hasImg && /読み込んでいません/.test(blockedState.text) && blockedState.rect.width < 600 && blockedState.rect.height < 100);
}

// ---- (e) typora-root-url ----
{
  await clearDoc();
  await page.keyboard.insertText("![a](/sub/x.png)\n\n(末尾)");
  await page.keyboard.press("Control+Home");
  await page.keyboard.press("Control+End");
  await page.waitForTimeout(300);
  const before = await page.$eval(".cm-image-widget", (e) => e.dataset.resolvedSrc);
  await clearDoc();
  await page.keyboard.insertText("---\ntitle: t\ntypora-root-url: /base/dir\n---\n\n![a](/sub/x.png)\n\n(末尾)");
  await page.keyboard.press("Control+Home");
  await page.keyboard.press("Control+End");
  await page.waitForTimeout(300);
  const after = await page.$eval(".cm-image-widget", (e) => e.dataset.resolvedSrc);
  // 解決後のsrcは pane-file.local/?path=<encodeURIComponentした実パス> 形式のため、比較はデコードしてから行う。
ok(`(e) typora-root-url指定で解決先が変わる before="${before}" after="${after}"`, before !== after && decodeURIComponent(after).includes("/base/dir/sub/x.png"));
}

// ---- (f)(g)(h) 自動リンク ----
{
  await clearDoc();
  await page.keyboard.insertText("<https://example.com>\n\n裸のURL https://example.org/path も。\n\n```\nコード内 https://codeblock.example.com\n```\n\nインライン `https://inline.example.com` コード。");
  await page.keyboard.press("Control+Home");
  await page.keyboard.press("Control+End");
  await page.waitForTimeout(400);
  const links = await page.$$eval(".tok-link[data-href]", (els) => els.map((e) => e.getAttribute("data-href")));
  ok(`(f) <https://example.com> がリンクになる ${JSON.stringify(links)}`, links.includes("https://example.com"));
  ok(`(g) 裸のURLがリンクになる ${JSON.stringify(links)}`, links.some((h) => h.includes("example.org/path")));
  const codeText = await page.evaluate(() => document.querySelector(".cm-content").innerText);
  const codeHasLink = links.some((h) => h.includes("codeblock.example.com") || h.includes("inline.example.com"));
  ok(`(h) コードブロック・インラインコード内はリンクにならない (該当リンク無し=${!codeHasLink})`, !codeHasLink && codeText.includes("codeblock.example.com") && codeText.includes("inline.example.com"));
}

// ---- (i)(j) 引用の入れ子 ----
{
  await clearDoc();
  await page.keyboard.insertText("> 一段目\n> > 二段目\n> > > 三段目\n\n(末尾)");
  await page.keyboard.press("Control+Home");
  await page.keyboard.press("Control+End");
  await page.waitForTimeout(400);
  const quoteInfo = await page.evaluate(() => {
    const lines = [...document.querySelectorAll(".cm-line")].filter((l) => l.querySelector(".tok-quote"));
    return lines.map((l) => ({ text: l.innerText, nested: !!l.querySelector(".cm-quote-nested"), rawGt: (l.innerText.match(/>/g) || []).length }));
  });
  ok(`(i)(j) 多段引用が入れ子として描画され内側の">"が見えない ${JSON.stringify(quoteInfo)}`, quoteInfo.length === 3 && quoteInfo.every((l) => l.rawGt === 0) && quoteInfo[1].nested && quoteInfo[2].nested);
}

// ---- (k) BBox ----
{
  await clearDoc();
  await page.keyboard.insertText("$$\n\\bbox[yellow]{x}\n$$\n\n(末尾)");
  await page.keyboard.press("Control+Home");
  await page.keyboard.press("Control+End");
  await page.waitForTimeout(1200);
  const mathState = await page.evaluate(() => {
    const w = document.querySelector(".cm-math-block");
    return w ? { hasError: w.classList.contains("cm-math-error"), hasSvg: !!w.querySelector("svg"), text: w.textContent } : null;
  });
  ok(`(k) $$\\bbox[yellow]{x}$$ がエラーにならず描画される ${JSON.stringify(mathState)}`, mathState && !mathState.hasError && mathState.hasSvg);
}

// ---- (l) 既存記法の回帰確認(1つずつ) ----
{
  await clearDoc();
  await page.keyboard.insertText([
    "# 見出し1",
    "",
    "- 箇条書きA",
    "- 箇条書きB",
    "",
    "1. 番号A",
    "2. 番号B",
    "",
    "- [ ] タスク未完了",
    "- [x] タスク完了",
    "",
    "| a | b |",
    "| --- | --- |",
    "| 1 | 2 |",
    "",
    "$$",
    "x^2",
    "$$",
    "",
    "脚注参照[^1]",
    "",
    "[^1]: 脚注の内容",
    "",
    "[toc]",
    "",
    "> [!NOTE]",
    "> コールアウト",
    "",
    "絵文字 :smile:",
    "",
    "上付きX^2^ 下付きH~2~O",
    "",
    "打消し ~~消し線~~ ハイライト ==目立つ==",
  ].join("\n"));
  await page.keyboard.press("Control+Home");
  await page.keyboard.press("Control+End");
  await page.waitForTimeout(1200);

  const checks = await page.evaluate(() => {
    const html = document.querySelector(".cm-content").innerHTML;
    const text = document.querySelector(".cm-content").innerText;
    return {
      heading: !!document.querySelector(".tok-h1"),
      bullet: !!document.querySelector(".cm-bullet"),
      checkbox: document.querySelectorAll(".cm-checkbox").length === 2,
      table: !!document.querySelector(".cm-table table"),
      mathBlock: !!document.querySelector(".cm-math-block svg"),
      footnoteRef: !!document.querySelector(".cm-footnote-ref"),
      footnoteDef: !!document.querySelector(".cm-footnote-def-label"),
      toc: !!document.querySelector(".cm-toc"),
      callout: !!document.querySelector(".cm-callout-note"),
      emoji: !!document.querySelector(".cm-emoji"),
      sup: !!document.querySelector(".tok-sup"),
      sub: !!document.querySelector(".tok-sub"),
      strike: !!document.querySelector(".tok-strike"),
      mark: !!document.querySelector(".tok-mark"),
    };
  });
  for (const [k, v] of Object.entries(checks)) ok(`(l) 既存記法 ${k}`, v);
}

// ---- (n) UI点検第2弾 指摘19: 脚注ポップアップが文書先頭付近で上に切れない ----
{
  await clearDoc();
  // 1行目(スクロール領域の上端)に脚注参照を置く。上方向に出す余白がほぼ無い状態を作る。
  const lines = ["先頭の行に脚注[^1]があります", ""];
  for (let i = 0; i < 40; i++) lines.push(`本文${i}`);
  lines.push("", "[^1]: 脚注の内容テキスト");
  await page.keyboard.insertText(lines.join("\n"));
  await page.keyboard.press("Control+Home");
  await page.waitForTimeout(400);

  const ref = await page.$(".cm-footnote-ref");
  await ref.hover();
  await page.waitForTimeout(200);
  const info = await page.evaluate(() => {
    const el = document.querySelector(".cm-footnote-ref");
    const pop = el.querySelector(".cm-footnote-popup");
    const scroller = el.closest(".cm-scroller");
    const popRect = pop.getBoundingClientRect();
    const scrollerRect = scroller.getBoundingClientRect();
    return { below: pop.classList.contains("cm-footnote-popup-below"), popTop: popRect.top, scrollerTop: scrollerRect.top, visibility: getComputedStyle(pop).visibility };
  });
  ok(`(n) 文書先頭付近の脚注ホバーで下方向へ出すクラスが付く(below=${info.below})`, info.below === true);
  ok(`(n) ホバー中はポップアップが実際に見える(visibility=visible)`, info.visibility === "visible");
  ok(`(n) ポップアップがスクロール領域(.cm-scroller)の上端より内側に収まる(popTop=${info.popTop.toFixed(1)} scrollerTop=${info.scrollerTop.toFixed(1)})`, info.popTop >= info.scrollerTop - 0.5);
  await page.keyboard.press("Control+End");
  await page.waitForTimeout(200);
}

// ---- (m) エラー0件 ----
// "Failed to load resource"は(d)(e)で意図的に読み込ませた壊れた画像のもの(検証の一部)なので除外する。
const unexpectedConsoleErrors = consoleErrors.filter((m) => !/Failed to load resource/.test(m));
ok(`(m) ページエラー0件 ${JSON.stringify(errors)}`, errors.length === 0);
ok(`(m) コンソールエラー0件(意図的な画像読込失敗を除く) ${JSON.stringify(unexpectedConsoleErrors)} (除外分: ${JSON.stringify(consoleErrors)})`, unexpectedConsoleErrors.length === 0);

await browser.close();
