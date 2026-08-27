// テーマの部位別配色(Typora Night移植→night改称・実機フィードバックによる配色修正・
// 他プリセットへの部位別配色の展開・night再修正でTypora非準拠の3階調化)・
// ステータスバーの幅対応・フォーカストラップ(設定画面/コマンドパレット)の
// 検証スクリプト。ポートは8178。
//
// 構成:
//   (A) nightプリセット(旧typora-night。実機フィードバックによりid/ラベルを改称した):
//       本文・サイドバー・メニュー/タイトルバーがそれぞれ異なる色であること。
//       【方針転換の経緯、詳細はsrc/themes.css側nightブロックのコメント参照】
//       当初はTypora公式night.cssに忠実にし、メニュー/タイトルバーを本文と同じ色
//       にしていた(Typora本体の#top-titlebarが背景指定を持たず本文色を継承する
//       ため)。しかしユーザーから「メリハリが失われた(色が戻っている)」という
//       指摘を受け、Typora本体との完全一致より他プリセットと揃えた3階調の
//       メリハリを優先する方針に変えた。そのため本テストも「本文とメニューバーは
//       同じ色」ではなく「異なる色」を検証するよう更新している。
//   (B) titlebar-colorメッセージに--titlebar-bgの色が優先して送られること。
//       nightは(A)と同じ理由で--titlebar-bgに本文とは別の値(#26282B)を明示している
//       ため、送られる色が本文の実描画色ではなく--titlebar-bgの実効値と一致することを
//       確認する(他の部位別配色プリセットと同じ検証の形)。
//   (C) 部位ごとの色分け(ユーザー要望2、および「既定も対象に含む」という念押し):
//       night含む全プリセット(sepia/github/solarized-light/nord/dracula/
//       solarized-dark/night)に加え、既定(プリセット無し)のライト/ダークも含めて、
//       本文とは異なる色をメニュー・ステータス・タイトルバーにも持つこと
//       (--chrome-bg/--sidebar-bgの実際の解決値と一致するかをハードコードの16進値
//       ではなくCSS変数の解決結果そのもので照合するため、値を書き換えても本テストの
//       追従修正が要らない)。いずれのプリセットもサイドバーの色が本文と異なること。
//   (D) ステータスバーの幅対応: 幅を段階的に狭めてheight24pxを超えない・本文と重ならない、
//       優先度の低い項目から順に隠れる、幅を戻すと再表示される、常に残す項目は残る
//   (E) 設定画面のフォーカストラップ(Tab10回で外へ出ない・閉じたら元の要素へ戻る)
//   (F) コマンドパレットのフォーカストラップ(同様)
import pw from "playwright";
const { chromium } = pw;

const PORT = 8178;
const BASE = `http://localhost:${PORT}/index.html`;
const browser = await chromium.launch();
const allErrors = [];
const allConsoleErrors = [];
let okCount = 0, ngCount = 0;
const ok = (label, cond, extra = "") => { console.log(`${cond ? "OK  " : "NG  "} ${label}${extra ? " " + extra : ""}`); if (cond) okCount++; else ngCount++; };

async function newPlainPage() {
  const page = await browser.newPage();
  page.on("pageerror", (e) => allErrors.push(String(e.stack || e)));
  page.on("console", (m) => { if (m.type() === "error") allConsoleErrors.push(m.text()); });
  await page.goto(BASE, { waitUntil: "load" });
  await page.waitForSelector(".cm-content", { timeout: 15000 });
  return page;
}

async function newBridgedPage() {
  const page = await browser.newPage();
  page.on("pageerror", (e) => allErrors.push(String(e.stack || e)));
  page.on("console", (m) => { if (m.type() === "error") allConsoleErrors.push(m.text()); });
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
  await page.goto(BASE, { waitUntil: "load" });
  await page.waitForSelector(".cm-content", { timeout: 15000 });
  return page;
}

// main.jsのreadPaintedColorと同じロジック(本文エリアの実描画色)をテスト側でも再現する。
function bodyColors(page) {
  return page.evaluate(() => {
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
}
function partColors(page) {
  return page.evaluate(() => {
    const bg = (sel) => getComputedStyle(document.querySelector(sel)).backgroundColor;
    return { sidebar: bg("#sidebar"), menubar: bg("#menubar"), statusbar: bg("#statusbar") };
  });
}
// CSSカスタムプロパティ(--surface等)の値を、実際にブラウザへ解釈させたうえでrgb()文字列
// として取り出す(themes.css側の値が#RRGGBBでもrgb()でも同じ形式で比較できるようにする)。
function resolveVarColor(page, varName) {
  return page.evaluate((name) => {
    const raw = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    if (!raw) return null;
    const probe = document.createElement("div");
    probe.style.backgroundColor = raw;
    document.body.appendChild(probe);
    const rgb = getComputedStyle(probe).backgroundColor;
    probe.remove();
    return rgb;
  }, varName);
}
function setPreset(page, { theme, lightTheme = "default", darkTheme = "default" }) {
  return page.evaluate(({ theme, lightTheme, darkTheme }) => {
    document.documentElement.dataset.theme = theme;
    document.documentElement.dataset.lightTheme = lightTheme;
    document.documentElement.dataset.darkTheme = darkTheme;
  }, { theme, lightTheme, darkTheme });
}

// ============================================================
// (A) nightプリセット(旧typora-night): 本文・サイドバー・メニュー/ステータスバーが
//     それぞれ異なる色であること(実機フィードバックにより3階調のメリハリを優先する
//     方針に転換。経緯はファイル先頭のコメント・src/themes.css側nightブロック参照)
// ============================================================
{
  const page = await newPlainPage();
  await setPreset(page, { theme: "dark", darkTheme: "night" });
  await page.waitForTimeout(300);
  const body = await bodyColors(page);
  const parts = await partColors(page);
  console.log(`    body=${body.background} sidebar=${parts.sidebar} menubar=${parts.menubar} statusbar=${parts.statusbar}`);
  ok("(A) 本文とサイドバーが異なる色", body.background !== parts.sidebar);
  ok("(A) 本文とメニューバーが異なる色(3階調のメリハリ、Typora本体とはあえて異なる)", body.background !== parts.menubar);
  ok("(A) 本文とステータスバーが異なる色(同上)", body.background !== parts.statusbar);
  ok("(A) メニューバーとサイドバーも異なる色(本文<サイドバー<メニューの3階調)", parts.menubar !== parts.sidebar);
  ok("(A) 本文の背景が指定どおり#363B40", body.background === "rgb(54, 59, 64)", `(実際=${body.background})`);
  ok("(A) 本文の文字色が指定どおり#b8bfc6", body.foreground === "rgb(184, 191, 198)", `(実際=${body.foreground})`);
  ok("(A) サイドバーが指定どおり#2E3033", parts.sidebar === "rgb(46, 48, 51)", `(実際=${parts.sidebar})`);
  ok("(A) メニューバーが指定どおり#26282B", parts.menubar === "rgb(38, 40, 43)", `(実際=${parts.menubar})`);
  await page.close();
}

// ============================================================
// (B) titlebar-colorメッセージに--titlebar-bg/--titlebar-fgの色が優先して送られること
// ============================================================
{
  const page = await newBridgedPage();
  const lastTitlebar = () => page.evaluate(() => {
    const m = window.__sent.filter((x) => x.type === "titlebar-color");
    return m.length ? m[m.length - 1] : null;
  });
  const toHex = (rgb) => {
    const m = /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/.exec(rgb || "");
    if (!m) return null;
    const h = (n) => Math.round(Number(n)).toString(16).padStart(2, "0");
    return `#${h(m[1])}${h(m[2])}${h(m[3])}`;
  };

  // ---- nord: --titlebar-bgが定義されているので最優先で使われる。--titlebar-fgも
  //     実バグ2の修正で全9テーマに明示したため、そちらも本文の実描画色(=--ink)と
  //     同じ値になるはず(値は同じでも、経路がCSS変数の直接参照になったことで
  //     WebView2非表示中のCSSトランジション停止の影響を受けなくなった、というのが
  //     今回の修正の要点。詳細はsrc/style.css :rootブロック・main.jsのコメント参照)。
  //     CSS変数の生の値は元の記述の大文字/小文字のまま返る(painted側はgetComputedStyleの
  //     rgb()経由で小文字化される)ため、比較はtoLowerCase()で揃える。 ----
  await page.evaluate(() => window.__reply({ type: "apply-settings", theme: "dark", lightTheme: "default", darkTheme: "nord" }));
  await page.waitForTimeout(600);
  let msg = await lastTitlebar();
  let painted = await bodyColors(page);
  ok("(B) nordでtitlebar-colorが送られる", !!msg, JSON.stringify(msg));
  // nordのchrome-bg/titlebar-bgは「メニュー・タイトルバーは本文・サイドバーより濃く」
  // という方針転換で#434C5E(nord2、旧値)から#242932(nord0を黒へ寄せた独自値)へ
  // 変更したため、ハードコードの16進値ではなく--titlebar-bgの実効値と照合する。
  const titlebarVarNord = await resolveVarColor(page, "--titlebar-bg");
  ok("(B) backgroundが--titlebar-bgの実効値と一致", msg?.background?.toLowerCase() === toHex(titlebarVarNord), `(msg=${msg?.background} var=${toHex(titlebarVarNord)})`);
  ok("(B) foregroundが--titlebar-fgの実効値(=本文の実描画色と同値)と一致", msg?.foreground?.toLowerCase() === toHex(painted.foreground), `(msg=${msg?.foreground} painted=${toHex(painted.foreground)})`);

  // ---- night: --titlebar-bgは【方針転換により変更】以前はvar(--paper)(本文と同色、
  //     Typora本体の#top-titlebarに倣った値)を明示していたが、「メリハリが失われた」
  //     という実機フィードバックを受けて本文とは異なる第3の色#26282Bへ変更した(詳細な
  //     経緯はthemes.css側nightブロックのコメント参照)。そのため送られる色は
  //     本文の実描画色とは一致せず、--titlebar-bgの実効値(#26282B)と一致するはず。
  //     --titlebar-fgは実バグ2の修正で全9テーマに明示したため(nightは実機で不具合が
  //     再現した当のテーマ)、こちらは--ink(=本文の実描画色)と同値になるはず。
  //     CSS変数の生の値(getPropertyValue)は#RRGGBBのような大文字/小文字が元の
  //     記述のまま返るのに対し、painted側はgetComputedStyleのrgb()経由で
  //     小文字化されるため、比較はtoLowerCase()で揃える。 ----
  await page.evaluate(() => window.__reply({ type: "apply-settings", theme: "dark", lightTheme: "default", darkTheme: "night" }));
  await page.waitForTimeout(600);
  msg = await lastTitlebar();
  painted = await bodyColors(page);
  const titlebarVarNight = await resolveVarColor(page, "--titlebar-bg");
  ok("(B) nightのtitlebar-bgが--titlebar-bgの実効値(#26282B)と一致する(background)", msg?.background?.toLowerCase() === toHex(titlebarVarNight), `(msg=${msg?.background} var=${toHex(titlebarVarNight)})`);
  ok("(B) nightのtitlebar-bgが本文の実描画色とは異なる(3階調のメリハリが効いている)", toHex(titlebarVarNight) !== toHex(painted.background), `(titlebar=${toHex(titlebarVarNight)} body=${toHex(painted.background)})`);
  ok("(B) nightの--titlebar-fgが本文の実描画色と同値(foreground)", msg?.foreground?.toLowerCase() === toHex(painted.foreground), `(msg=${msg?.foreground} painted=${toHex(painted.foreground)})`);

  // ---- default: 既定も--chrome-bg/--titlebar-bgを持つため(本文とは別の色)、
  //     titlebar-colorは--titlebar-bgの実効値と一致するはず(本文の実描画色とは
  //     一致しない)。CSS変数の生の値は元の記述の大文字/小文字のまま返るため、
  //     比較はtoLowerCase()で揃える。 ----
  await page.evaluate(() => window.__reply({ type: "apply-settings", theme: "dark", lightTheme: "default", darkTheme: "default" }));
  await page.waitForTimeout(600);
  msg = await lastTitlebar();
  painted = await bodyColors(page);
  const titlebarVarDark = await resolveVarColor(page, "--titlebar-bg");
  ok("(B) default: backgroundが--titlebar-bg(実効値)と一致", msg?.background?.toLowerCase() === toHex(titlebarVarDark), `(msg=${msg?.background} var=${toHex(titlebarVarDark)})`);
  ok("(B) default: --titlebar-bgが本文の実描画色とは異なる(部位分けが効いている)", toHex(titlebarVarDark) !== toHex(painted.background), `(titlebar=${toHex(titlebarVarDark)} body=${toHex(painted.background)})`);
  await page.close();
}

// ============================================================
// (C) 部位ごとの色分け: 全プリセット(既定を含む、nightも今回の方針転換で含める)で、
//     本文・サイドバー・メニュー/ステータスバーがそれぞれ--paper/--sidebar-bg/
//     --chrome-bgの実効値と一致し、かつ本文とは異なる色になっていること
// ============================================================
{
  const page = await newPlainPage();
  const presets = [
    { label: "default(dark)", theme: "dark", darkTheme: "default" },
    { label: "nord", theme: "dark", darkTheme: "nord" },
    { label: "dracula", theme: "dark", darkTheme: "dracula" },
    { label: "solarized-dark", theme: "dark", darkTheme: "solarized-dark" },
    { label: "night", theme: "dark", darkTheme: "night" },
    { label: "default(light)", theme: "light", lightTheme: "default" },
    { label: "sepia", theme: "light", lightTheme: "sepia" },
    { label: "github", theme: "light", lightTheme: "github" },
    { label: "solarized-light", theme: "light", lightTheme: "solarized-light" },
  ];
  for (const p of presets) {
    await setPreset(page, p);
    // body(background/colorそれぞれtransition .2s)が確実に収束してから読む。
    await page.waitForTimeout(450);
    const body = await bodyColors(page);
    const parts = await partColors(page);
    const sidebarRgb = await resolveVarColor(page, "--sidebar-bg");
    const chromeRgb = await resolveVarColor(page, "--chrome-bg");
    console.log(`    ${p.label}: body=${body.background} sidebar=${parts.sidebar} menubar=${parts.menubar} statusbar=${parts.statusbar}`);
    ok(`(C) ${p.label}: メニューバーが--chrome-bgの実効値と一致`, parts.menubar === chromeRgb, `(menubar=${parts.menubar} chrome-bg=${chromeRgb})`);
    ok(`(C) ${p.label}: ステータスバーが--chrome-bgの実効値と一致`, parts.statusbar === chromeRgb, `(statusbar=${parts.statusbar} chrome-bg=${chromeRgb})`);
    ok(`(C) ${p.label}: サイドバーが--sidebar-bgの実効値と一致`, parts.sidebar === sidebarRgb, `(sidebar=${parts.sidebar} sidebar-bg=${sidebarRgb})`);
    ok(`(C) ${p.label}: メニューバーが本文と異なる色(部位分けが効いている)`, parts.menubar !== body.background, `(menubar=${parts.menubar} body=${body.background})`);
    ok(`(C) ${p.label}: サイドバーが本文と異なる色`, parts.sidebar !== body.background, `(sidebar=${parts.sidebar} body=${body.background})`);
  }
  await page.close();
}

// ============================================================
// (D) ステータスバーの幅対応
// ============================================================
{
  const page = await newBridgedPage();
  await page.evaluate(() => window.__reply({
    type: "file-opened", fileName: "sample.md", path: "C:\\work\\sample.md",
    text: "本文です\n2行目です", encoding: "UTF-8", lineEnding: "CRLF", readOnly: false,
  }));
  await page.waitForTimeout(300);
  // 未保存表示(#status-dirty)も「常に残す」対象なので、編集して未保存状態を作る。
  await page.locator(".cm-content").click();
  await page.keyboard.type("追記");
  await page.waitForTimeout(200);

  // 不具合修正(ユーザー要望): 幅を狭めたときの畳む順序を明示指定に変更した
  // (src/main.js STATUS_FIT_STAGES参照)。改行コード・文字コードはまずラベルを落とす
  // 「コンパクト」段階を経てから完全に消えるため、要素が実際に.hidden=trueになる
  // (=完全に消える)順序はzoom→position→count→wrap→lineEnding→encodingになる
  // (コンパクト段階の途中経過はこのテストでは見ず、.verify-statusbar-meta.mjs側で見る)。
  // また、ステータスバーの「設定」ボタン(#btn-settings)はユーザー要望により削除した
  // (設定を開く手段はメニューバーの歯車ボタン・Ctrl+,に残る)ため、常時表示チェックからも外す。
  const FIT_ORDER = ["status-zoom", "status-position", "status-count", "status-wrap", "status-line-ending", "status-encoding"];
  const ALWAYS = ["status-sidebar", "status-mode", "status-dirty"];
  const hiddenSet = () => page.evaluate((ids) => ids.filter((id) => document.getElementById(id)?.hidden), FIT_ORDER);
  const visibleAlways = () => page.evaluate((ids) => ids.every((id) => document.getElementById(id) && !document.getElementById(id).hidden), ALWAYS);

  await page.setViewportSize({ width: 1100, height: 700 });
  await page.waitForTimeout(200);
  ok("(D) 事前: 十分な幅では全項目が表示されている", (await hiddenSet()).length === 0, JSON.stringify(await hiddenSet()));
  ok("(D) 事前: #status-dirtyが表示されている(未保存を作った)", await page.evaluate(() => !document.getElementById("status-dirty").hidden));

  const seenOrder = [];
  let prevHidden = [];
  let maxHeight = 0;
  let overlapFound = false;
  for (let w = 1100; w >= 160; w -= 15) {
    await page.setViewportSize({ width: w, height: 700 });
    await page.waitForTimeout(80);
    const rect = await page.evaluate(() => {
      const sb = document.getElementById("statusbar").getBoundingClientRect();
      const cm = document.getElementById("cm-host").getBoundingClientRect();
      return { h: sb.height, sbTop: sb.top, cmBottom: cm.bottom };
    });
    maxHeight = Math.max(maxHeight, rect.h);
    if (rect.cmBottom > rect.sbTop + 0.5) overlapFound = true;
    const hidden = await hiddenSet();
    for (const id of hidden) {
      if (!prevHidden.includes(id) && !seenOrder.includes(id)) seenOrder.push(id);
    }
    prevHidden = hidden;
  }
  ok("(D) 幅を狭めてもステータスバーのheightが24pxを超えない", maxHeight <= 24.5, `(最大=${maxHeight})`);
  ok("(D) 幅を狭めても本文エリアと重ならない", !overlapFound);
  ok("(D) 幅を狭めると少なくとも1項目は隠れる", seenOrder.length > 0, JSON.stringify(seenOrder));
  // seenOrderはFIT_ORDERの先頭からの部分列になっているはず(優先度の低い項目から順に隠れる)。
  const isPriorityOrder = JSON.stringify(seenOrder) === JSON.stringify(FIT_ORDER.slice(0, seenOrder.length));
  ok("(D) 隠れる順序が優先度どおり(zoom→position→count→wrap→line-ending→encoding)", isPriorityOrder, JSON.stringify(seenOrder));
  ok("(D) 最も狭い状態でもサイドバー切替/編集モード/未保存表示は残る", await visibleAlways());

  // ---- 幅を戻すと再表示される ----
  await page.setViewportSize({ width: 1100, height: 700 });
  await page.waitForTimeout(200);
  ok("(D) 幅を戻すと再表示される", (await hiddenSet()).length === 0, JSON.stringify(await hiddenSet()));
  await page.close();
}

// ============================================================
// (E) 設定画面のフォーカストラップ
// ============================================================
{
  const page = await newPlainPage();
  await page.evaluate(() => document.getElementById("btn-menu-settings").focus());
  await page.evaluate(() => window.__paneDebugCtx.actions.openSettings());
  await page.waitForTimeout(300);
  ok("(E) 開いた直後、初期フォーカスは検索欄", (await page.evaluate(() => document.activeElement.className)).includes("settings-search-input"));
  for (let i = 0; i < 10; i++) await page.keyboard.press("Tab");
  const outside = await page.evaluate(() => !document.querySelector(".settings-modal").contains(document.activeElement));
  ok("(E) Tabを10回押してもフォーカスが外へ出ない", !outside);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(250);
  ok("(E) 設定画面が閉じる", (await page.$(".settings-modal-overlay")) === null);
  ok("(E) 閉じたあと元の要素(設定ボタン)へフォーカスが戻る", await page.evaluate(() => document.activeElement.id === "btn-menu-settings"));
  await page.close();
}

// ============================================================
// (F) コマンドパレットのフォーカストラップ
// ============================================================
{
  const page = await newPlainPage();
  await page.evaluate(() => document.getElementById("btn-menu-help").focus());
  await page.keyboard.press("Control+Shift+P");
  await page.waitForTimeout(250);
  ok("(F) 開いた直後、初期フォーカスは検索欄", await page.evaluate(() => document.activeElement.id === "palette-input"));
  for (let i = 0; i < 10; i++) await page.keyboard.press("Tab");
  const outside = await page.evaluate(() => !document.querySelector(".palette").contains(document.activeElement));
  ok("(F) Tabを10回押してもフォーカスが外へ出ない", !outside);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(200);
  ok("(F) コマンドパレットが閉じる", (await page.$(".palette-overlay")) === null);
  ok("(F) 閉じたあと元の要素(ヘルプボタン)へフォーカスが戻る", await page.evaluate(() => document.activeElement.id === "btn-menu-help"));
  await page.close();
}

// ============================================================
// エラー確認
// ============================================================
ok("ページエラーが0件", allErrors.length === 0, JSON.stringify(allErrors));
ok("コンソールエラーが0件", allConsoleErrors.length === 0, JSON.stringify(allConsoleErrors));

await browser.close();
console.log(`\n合計: OK ${okCount} / NG ${ngCount}`);
process.exit(ngCount > 0 ? 1 : 0);
