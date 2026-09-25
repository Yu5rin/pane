// カスタムCSSの作成補助(仕様書 第2.10.1節 C-16)の見本で、sample.css に載っている変数を
// すべて確かめられるかを実測する。
//
// 経緯(2026-09-25): 最初の版の見本は Markdown の文書だけで、利用者から「コードモードの確認が
// できない」と指摘された。変数を1つずつ目立つ値に変えて見本を撮り直したところ、70個のうち
// 32個は見本の見た目がまったく変わらなかった(コードモード・メニューバー・サイドバー・
// ダイアログ・一部の Callout 等)。見本に「コード」「画面全体」を足して直した。
// あわせて、どこにも使われていない変数(--pre-bg 等)を style.css と sample.css から消した。
// 以後、sample.css に変数を足したとき、見本で確かめられないまま出荷しないよう、ここで見張る。
//
// やり方: css-preview.html を開き、見本の画面(markdown / code / chrome)ごとに、
// 変数をその変数に合った目立つ値に変えて撮り直す。1画素でも変わればその画面で確かめられる。
// 画面は時間とともにわずかに揺れる(描画の後追い)ため、2回続けて同じになるまで待ってから撮る。
// マウスを乗せたときだけ使われる変数は、その部品にマウスを乗せてから撮る。
import pw from "playwright";
import fs from "node:fs";

const PORT = 8221;
const VIEWS = ["markdown", "code", "chrome"];

// sample.css(Pane/ThemeFolderService.cs の SampleCssContent)の :root に並んでいる変数。
const cs = fs.readFileSync("Pane/ThemeFolderService.cs", "utf8");
const sample = cs.slice(cs.indexOf('SampleCssContent = """'));
// 説明のコメントにも「html[data-theme="dark"] { ... }」と書かれているため、:root の後ろから探す。
const rootStart = sample.indexOf("\n        :root {");
const rootBlock = sample.slice(rootStart, sample.indexOf("html[data-theme=\"dark\"] {", rootStart));
const sampleVars = [...new Set([...rootBlock.matchAll(/^\s*(--[a-z0-9-]+):/gm)].map((m) => m[1]))];
// 作成補助の入力欄に出している変数(src/css-editor-entry.js の FIELD_GROUPS)。入力欄で変えられるのに
// 見本で確かめられない、ということが無いようにする。
const entry = fs.readFileSync("src/css-editor-entry.js", "utf8");
const fieldVars = [...entry.matchAll(/\{ name: "(--[a-z0-9-]+)", label:/g)].map((m) => m[1]);
const vars = [...new Set([...sampleVars, ...fieldVars])];

// 見本では確かめられないと分かっていて、理由を画面・sample.css に書いてあるもの。
const KNOWN_ELSEWHERE = {
  // 取扱説明書の見出しにだけ使われる(本文の見出しは --font-body)。sample.css にそう書いてある。
  "--font-heading": "取扱説明書の見出しだけ",
};
// マウスを乗せたときだけ使われる変数と、乗せる場所。
const HOVER = {
  "--fold-guide-hover": { view: "code", selector: ".cm-fold-marker2" },
  "--danger-soft": { view: "chrome", selector: ".mock-popups .btn.danger" },
  "--accent-hover": { view: "chrome", selector: ".mock-popups .btn.primary" },
};

// 画面ごとに必ず確かめたい変数(下の「見本の画面ごとの要点」)。これ以外は、前の画面で
// 一度確かめられたら次の画面では測り直さない(1本200秒の制限に収めるため)。
const REQUIRED_IN_VIEW = {
  code: ["--code-kw", "--code-fn", "--code-type", "--code-regex", "--active-line-bg"],
  chrome: ["--chrome-bg", "--sidebar-bg", "--titlebar-bg"],
};

function probeValue(name) {
  if (/^--(font|editor-font)/.test(name)) return '"Courier New", serif';
  if (name === "--radius") return "0px";
  if (/padding/.test(name)) return "90px";
  if (name === "--editor-line-height") return "3";
  if (name === "--editor-max-width") return "300px";
  if (/shadow/.test(name)) return "0 0 0 10px rgb(255, 0, 255)";
  return "rgb(255, 0, 255)";
}

let ng = 0;
const ok = (label, cond, detail) => {
  console.log(`${cond ? "OK  " : "NG  "} ${label}${cond || detail === undefined ? "" : `\n     実際: ${JSON.stringify(detail)}`}`);
  if (!cond) ng++;
};

async function stableShot(page) {
  let prev = await page.screenshot();
  for (let i = 0; i < 15; i++) {
    await page.waitForTimeout(80);
    const cur = await page.screenshot();
    if (cur.equals(prev)) return cur;
    prev = cur;
  }
  return prev;
}

const browser = await pw.chromium.launch();
const seen = new Map(); // 変数 → 変化した画面の集合
const errors = [];
for (const view of VIEWS) {
  const page = await browser.newPage({ viewport: { width: 1000, height: 2600 } });
  page.on("pageerror", (e) => errors.push(String(e.stack || e)));
  await page.goto(`http://localhost:${PORT}/css-preview.html`);
  await page.waitForSelector("#cm-host .cm-content", { timeout: 15000 });
  await page.evaluate((v) => window.postMessage({ type: "view", view: v }, location.origin), view);
  await page.waitForFunction((v) => document.body.classList.contains(`view-${v}`), view);
  await page.waitForTimeout(800);
  for (const name of vars) {
    if (seen.has(name) && !REQUIRED_IN_VIEW[view]?.includes(name)) continue;
    const hover = HOVER[name];
    if (hover && hover.view === view) await page.hover(hover.selector);
    else await page.mouse.move(999, 2599);
    const base = await stableShot(page);
    await page.evaluate(([n, v]) => {
      let s = document.getElementById("coverage-probe");
      if (!s) { s = document.createElement("style"); s.id = "coverage-probe"; document.head.appendChild(s); }
      s.textContent = `html, html[data-theme][data-theme], :root:root:root { ${n}: ${v} !important; }`;
    }, [name, probeValue(name)]);
    const shot = await stableShot(page);
    if (!shot.equals(base)) {
      if (!seen.has(name)) seen.set(name, new Set());
      seen.get(name).add(view);
    }
    await page.evaluate(() => { document.getElementById("coverage-probe").textContent = ""; });
  }
  await page.close();
}
await browser.close();

ok(`sample.css の変数を読み取れた(${sampleVars.length}個)`, sampleVars.length > 40, sampleVars.length);
ok(`入力欄の変数を読み取れた(${fieldVars.length}個)`, fieldVars.length > 30, fieldVars.length);
for (const name of vars) {
  if (KNOWN_ELSEWHERE[name]) {
    ok(`${name} は見本の外(${KNOWN_ELSEWHERE[name]})で使われるもの`, !seen.has(name), [...(seen.get(name) ?? [])]);
    continue;
  }
  ok(`${name} を見本で確かめられる(${[...(seen.get(name) ?? [])].join("・") || "どの画面でも変化なし"})`, seen.has(name));
}
// 見本の画面ごとの要点(利用者の指摘の元になったもの)
ok("コードの色分けはコードの見本で確かめられる", ["--code-kw", "--code-fn", "--code-type", "--code-regex"].every((n) => seen.get(n)?.has("code")));
ok("今の行の背景はコードの見本で確かめられる", seen.get("--active-line-bg")?.has("code"));
ok("メニューバー・サイドバー・タイトルバーは画面全体の見本で確かめられる", ["--chrome-bg", "--sidebar-bg", "--titlebar-bg"].every((n) => seen.get(n)?.has("chrome")));
ok(`ページのエラーが無い(${errors.length}件)`, errors.length === 0, errors.slice(0, 3));
console.log(`\nNG=${ng}`);
process.exit(ng ? 1 : 0);
