// タイトルバー色のテーマ追従と、クリップボード画像の貼り付け優先順位の検証。ポートは8162。
//
// (1)の前提について: 既定(プリセット無し)テーマは当初--chrome-bg/--titlebar-bgを
// 持たず、titlebar-colorは常に本文エリアの実描画色と一致していた。その後「他の
// カラーモードも本文・サイドバー・メニューバー+タイトルバーで色を変えてほしい」
// という要望が既定にも及ぶと明確化されたため、既定にも独自の--chrome-bg/
// --titlebar-bg(本文とは別の色)を与えた(src/style.css参照)。そのため(1)では
// 「titlebar-colorの背景は--titlebar-bgの実効値と一致する」ことを検証する
// (本文エリアの実描画色とは一致しなくなった点もあわせて確認する)。
// カスタムCSSでの追従(このスイートの本質)は、--titlebar-bg自体をカスタムCSSで
// 上書きしたときにtitlebar-colorがそれに追従することを検証する形に更新した
// (foregroundは既定が--titlebar-fgを持たない設計のままなので、従来どおり本文の
// 実描画色への追従を検証する)。
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
await page.goto("http://localhost:8162/index.html");
await page.waitForTimeout(800);

const lastTitlebar = () => page.evaluate(() => {
  const m = window.__sent.filter((x) => x.type === "titlebar-color");
  return m.length ? m[m.length - 1] : null;
});
const bodyColors = () => page.evaluate(() => {
  const pick = (sels, prop) => {
    for (const s of sels) {
      const el = s === "body" ? document.body : document.querySelector(s);
      if (!el) continue;
      const v = getComputedStyle(el)[prop];
      if (!v || v === "transparent" || /rgba\(\s*0,\s*0,\s*0,\s*0\s*\)/.test(v)) continue;
      return v;
    }
    return null;
  };
  return {
    background: pick([".cm-editor", "#cm-host", "body"], "backgroundColor"),
    foreground: pick([".cm-content", ".cm-editor", "body"], "color"),
  };
});
const toHex = (rgb) => {
  const m = /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/.exec(rgb || "");
  if (!m) return null;
  const h = (n) => Math.round(Number(n)).toString(16).padStart(2, "0");
  return `#${h(m[1])}${h(m[2])}${h(m[3])}`;
};
// CSSカスタムプロパティ(--titlebar-bg等)の値を、実際にブラウザへ解釈させたうえで
// rgb()文字列として取り出す(.verify-theme-ui.mjsのresolveVarColorと同じロジック)。
// この経路はgetComputedStyle(probe).backgroundColor(rgb()形式)を通るため常に小文字の
// 16進になるのに対し、titlebar-colorのmsg?.backgroundはCSS変数の生の値(getPropertyValue、
// style.css記述どおりの大文字/小文字)をそのまま使うため、比較前にtoLowerCase()で揃える
// (色として同じでも文字列としては一致しないことがあるため)。
const resolveVarColor = (varName) => page.evaluate((name) => {
  const raw = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  if (!raw) return null;
  const probe = document.createElement("div");
  probe.style.backgroundColor = raw;
  document.body.appendChild(probe);
  const rgb = getComputedStyle(probe).backgroundColor;
  probe.remove();
  return rgb;
}, varName);

// ---- (1) タイトルバー色 ----
// apply-settings(ライトテーマ)で送られること。
await page.evaluate(() => window.__reply({ type: "apply-settings", theme: "light", lightTheme: "default", darkTheme: "default" }));
await page.waitForTimeout(600);
let msg = await lastTitlebar();
ok("(1) apply-settingsでtitlebar-colorが送られる", !!msg, JSON.stringify(msg));
let painted = await bodyColors();
let titlebarVar = await resolveVarColor("--titlebar-bg");
ok("(1) ライト: backgroundが--titlebar-bgの実効値と一致", msg?.background?.toLowerCase() === toHex(titlebarVar),
  `送信=${msg?.background} --titlebar-bg=${toHex(titlebarVar)}`);
ok("(1) ライト: backgroundは本文エリアの実描画色とは別(既定にも部位別配色を適用済み)", msg?.background !== toHex(painted.background),
  `titlebar=${msg?.background} 本文=${toHex(painted.background)}`);
// 実バグ2の修正で既定にも--titlebar-fg(=var(--ink))を明示したため、送信元は
// 本文の実描画色フォールバックではなくCSS変数の直接参照になった(値自体は--inkで
// 同じなので一致するが、CSS変数の生の値は元の記述の大文字/小文字のまま返るのに対し
// painted側はgetComputedStyleのrgb()経由で小文字化されるため、比較はtoLowerCase()で揃える)。
ok("(1) ライト: foregroundが--titlebar-fg(=--ink)の実効値と一致", msg?.foreground?.toLowerCase() === toHex(painted.foreground),
  `送信=${msg?.foreground} 実際=${toHex(painted.foreground)}`);
const lightBg = msg?.background;

// ダークテーマへ切り替えると色が変わること。
await page.evaluate(() => window.__reply({ type: "apply-settings", theme: "dark", lightTheme: "default", darkTheme: "default" }));
await page.waitForTimeout(600);
msg = await lastTitlebar();
painted = await bodyColors();
titlebarVar = await resolveVarColor("--titlebar-bg");
ok("(1) ダーク: backgroundが--titlebar-bgの実効値と一致", msg?.background?.toLowerCase() === toHex(titlebarVar),
  `送信=${msg?.background} --titlebar-bg=${toHex(titlebarVar)}`);
ok("(1) ダーク: foregroundが--titlebar-fg(=--ink)の実効値と一致", msg?.foreground?.toLowerCase() === toHex(painted.foreground),
  `送信=${msg?.foreground} 実際=${toHex(painted.foreground)}`);
ok("(1) ダーク: ライトとは違う色になっている", msg?.background !== lightBg, `${lightBg} -> ${msg?.background}`);

// テーマ切替ボタンでも送られること。
const before = await page.evaluate(() => window.__sent.filter((x) => x.type === "titlebar-color").length);
await page.click("#btn-theme");
await page.waitForTimeout(600);
const after = await page.evaluate(() => window.__sent.filter((x) => x.type === "titlebar-color").length);
ok("(1) テーマ切替ボタンでもtitlebar-colorが送られる", after === before + 1, `(${before}->${after})`);
msg = await lastTitlebar();
titlebarVar = await resolveVarColor("--titlebar-bg");
ok("(1) 切替後もbackgroundが--titlebar-bgの実効値と一致", msg?.background?.toLowerCase() === toHex(titlebarVar),
  `送信=${msg?.background} --titlebar-bg=${toHex(titlebarVar)}`);

// カスタムCSSでタイトルバーの色を変えたら追従すること。実バグ2の修正で既定にも
// --titlebar-bg/--titlebar-fgの両方を明示したため(以前はforeground側だけ未定義で
// 本文の実描画色にフォールバックしていた)、単純な本文色(body/.cm-editorのcolor)の
// 上書きだけではもうforegroundに届かない(--titlebar-fgが優先されるため。これは
// 意図した変更——WebView2非表示中のCSSトランジション停止に影響されない、より
// 堅牢な経路にするための修正、詳細はsrc/style.css :rootブロックのコメント参照)。
// backgroundと同じく、--titlebar-bg/--titlebar-fg自体をカスタムCSSで上書きした
// ときにそれへ追従することを検証する。
await page.evaluate(() => window.__reply({
  type: "apply-settings", theme: "light", lightTheme: "default", darkTheme: "default",
  customCss: "body, .cm-editor { background: rgb(18, 52, 86) !important; color: rgb(171, 205, 239) !important; } html[data-theme] { --titlebar-bg: rgb(9, 33, 45) !important; --titlebar-fg: rgb(171, 205, 239) !important; }",
}));
await page.waitForTimeout(600);
msg = await lastTitlebar();
ok("(1) カスタムCSSの色にも追従する(background、--titlebar-bgの上書き経由)", msg?.background === "#09212d", `送信=${msg?.background}`);
ok("(1) カスタムCSSの色にも追従する(foreground、--titlebar-fgの上書き経由)", msg?.foreground === "#abcdef", `送信=${msg?.foreground}`);
// 後片付け(以降のテストへ影響させない)
await page.evaluate(() => window.__reply({ type: "apply-settings", theme: "light", lightTheme: "default", darkTheme: "default", customCss: "" }));
await page.waitForTimeout(300);

// ---- (2) クリップボード画像の貼り付け ----
// DataTransferを組み立ててpasteイベントを発火し、insert-imageが送られるかを見る。
async function paste({ html, plain, withImage }) {
  await page.evaluate(() => { window.__sent.length = 0; });
  await page.click(".cm-content");
  await page.evaluate(async ({ html, plain, withImage }) => {
    const dt = new DataTransfer();
    if (html) dt.setData("text/html", html);
    if (plain) dt.setData("text/plain", plain);
    if (withImage) {
      // 1x1のPNG(透明)。実バイト列をクリップボード上の画像に見立てる。
      const b64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
      const bin = atob(b64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      dt.items.add(new File([bytes], "image.png", { type: "image/png" }));
    }
    document.querySelector(".cm-content").dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
  }, { html, plain, withImage });
  await page.waitForTimeout(600);
  return page.evaluate(() => window.__sent.map((m) => m.type));
}

let types = await paste({ withImage: true });
ok("(2) 画像のみ → insert-imageが送られる", types.includes("insert-image"), JSON.stringify(types));

types = await paste({ withImage: true, html: '<meta charset="utf-8"><img src="https://example.com/a.png">' });
ok("(2) 画像+imgだけのHTML → HTMLではなく画像が優先される", types.includes("insert-image"), JSON.stringify(types));

const docBefore = await page.evaluate(() => window.__paneDebugEditor?.getValue?.() ?? "");
types = await paste({ withImage: true, html: '<meta charset="utf-8"><p>説明文</p><img src="https://example.com/a.png">' });
ok("(2) 画像+文章入りHTML → 従来どおりHTMLからMarkdownへ変換する", !types.includes("insert-image"), JSON.stringify(types));

types = await paste({ html: "<b>太字</b>", plain: "太字" });
ok("(2) HTMLのみ → insert-imageは送られない", !types.includes("insert-image"), JSON.stringify(types));

types = await paste({ withImage: true, plain: "image.png" });
ok("(2) 画像+ファイル名のプレーンテキスト → 画像が優先される", types.includes("insert-image"), JSON.stringify(types));

ok("ページエラー0件", errors.length === 0, JSON.stringify(errors));
ok("コンソールエラー0件", consoleErrors.length === 0, JSON.stringify(consoleErrors));
console.log(`--- 集計: OK=${okCount} NG=${ngCount}`);
await browser.close();
process.exit(ngCount === 0 ? 0 : 1);
