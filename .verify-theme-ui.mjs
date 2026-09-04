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
//   (G) UI点検(.review-ui.md 指摘1・2・3・6・17)の修正確認: var(--accent)を文字色や
//       (明るい文字を乗せる)背景色として使っていた箇所のコントラスト不足、および
//       ステータスバー(var(--ink-mute) on var(--chrome-bg))のコントラスト不足。
//       9テーマすべてで、新設した--accent-ink/--chrome-fgがWCAG AA(4.5:1、いずれも
//       18.66px未満の小さい文字のため通常文字の基準を適用)を満たすことを、
//       (a)CSS変数の実測値そのもの、(b)実際にレンダリングされたDOM要素の
//       computed style、の両方で確認する。
//       .fix-contrast.mdに、修正前に実際にNGになることを確認した記録がある。
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
// (G) UI点検 指摘1・2・3・6・17: --accent-ink / --chrome-fg のコントラスト確認
// ============================================================
// WCAG相対輝度・コントラスト比の計算(.verify-codefold.mjs (Z)節と同じ式)。
function relLum(colorStr) {
  // 未定義のCSS変数(トークンを導入する前のコードを検証するときなど)を解決しようとすると
  // resolveVarColor/probeVar側が空文字列相当(null)を返すことがあるため、ここで弾く
  // (弾かないとcolorStr.matchで例外になり、後続のテストが実行されないまま落ちてしまう)。
  if (!colorStr) return null;
  // color-mix()の解決結果はブラウザによって"color(srgb r g b)"形式(0-1)で
  // 返ることがある(rgb()の0-255表記とは別形式なので、両対応させる)。
  const cm = colorStr.match(/color\(srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)/);
  let vals;
  if (cm) vals = [1, 2, 3].map((i) => parseFloat(cm[i]));
  else {
    const m = colorStr.match(/rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)/);
    if (!m) return null;
    vals = [1, 2, 3].map((i) => parseFloat(m[i]) / 255);
  }
  const [r, g, b] = vals.map((v) => (v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function contrastRatio(a, b) {
  const L1 = relLum(a), L2 = relLum(b);
  if (L1 == null || L2 == null) return null;
  const [hi, lo] = L1 > L2 ? [L1, L2] : [L2, L1];
  return (hi + 0.05) / (lo + 0.05);
}
const GTHEMES = [
  { label: "default-light", theme: "light", lightTheme: "default", darkTheme: "default" },
  { label: "default-dark", theme: "dark", lightTheme: "default", darkTheme: "default" },
  { label: "sepia", theme: "light", lightTheme: "sepia", darkTheme: "default" },
  { label: "github", theme: "light", lightTheme: "github", darkTheme: "default" },
  { label: "solarized-light", theme: "light", lightTheme: "solarized-light", darkTheme: "default" },
  { label: "nord", theme: "dark", lightTheme: "default", darkTheme: "nord" },
  { label: "dracula", theme: "dark", lightTheme: "default", darkTheme: "dracula" },
  { label: "solarized-dark", theme: "dark", lightTheme: "default", darkTheme: "solarized-dark" },
  { label: "night", theme: "dark", lightTheme: "default", darkTheme: "night" },
];
const AA_NORMAL = 4.5; // 対象はいずれも18.66px未満の小さい文字のため、大きな文字用の3.0ではなく通常文字の基準を使う

// ---- (G-1) --accent-ink / --chrome-fg というCSS変数自体の実測値 ----
// var(--accent)を文字色に使っていた箇所は、乗る背景がvar(--paper)(本文中のリンク・
// 脚注番号等)/var(--surface)(メニュー・パレット等の浮遊パネル)/var(--accent-soft)
// (サイドバーの選択行・設定の選択中カテゴリ等)のいずれかで、かつvar(--accent)を
// 背景にして明るい文字(var(--surface)/var(--paper))を乗せるボタン類
// (.pane-dialog-btn-primary等)も存在する。コントラスト比はA vs BもB vs Aも同じ値
// (WCAGの計算式は対称)なので、--accent-ink自体がこの3つの背景いずれに対しても
// 4.5以上であることを確認すれば、上記の「文字として使う」「背景にして明るい文字を
// 乗せる」の両方向を一括して保証できる。
{
  const page = await newPlainPage();
  for (const th of GTHEMES) {
    await setPreset(page, th);
    const accentInk = await resolveVarColor(page, "--accent-ink");
    const paper = await resolveVarColor(page, "--paper");
    const surface = await resolveVarColor(page, "--surface");
    const accentSoft = await resolveVarColor(page, "--accent-soft");
    const chromeFg = await resolveVarColor(page, "--chrome-fg");
    const chromeBg = await resolveVarColor(page, "--chrome-bg");
    const rPaper = contrastRatio(accentInk, paper);
    const rSurface = contrastRatio(accentInk, surface);
    const rSoft = contrastRatio(accentInk, accentSoft);
    const rChrome = contrastRatio(chromeFg, chromeBg);
    ok(`(G-1) ${th.label}: --accent-ink vs --paper >= 4.5 (実測${rPaper?.toFixed(2)})`, rPaper >= AA_NORMAL);
    ok(`(G-1) ${th.label}: --accent-ink vs --surface >= 4.5 (実測${rSurface?.toFixed(2)})`, rSurface >= AA_NORMAL);
    ok(`(G-1) ${th.label}: --accent-ink vs --accent-soft >= 4.5 (実測${rSoft?.toFixed(2)})`, rSoft >= AA_NORMAL);
    ok(`(G-1) ${th.label}: --chrome-fg vs --chrome-bg >= 4.5 (実測${rChrome?.toFixed(2)})`, rChrome >= AA_NORMAL);
  }
  await page.close();
}

// ---- (G-2) 実際にレンダリングされたDOM要素での確認(トークンの配線ミスを検出) ----
// (G-1)はCSS変数の値そのものを見るだけなので、「トークンは正しく定義したが、
// 実際のセレクタにvar(--accent-ink)を適用し忘れた」ような取り違えは検出できない。
// 実際に該当セレクタを画面に出し、getComputedStyleで実測することで配線を確認する。
{
  const page = await newBridgedPage();
  await page.evaluate(() => window.__reply({
    type: "file-opened", fileName: "contrast.md", path: "C:\\work\\contrast.md",
    text: "見出し\n\n[リンク文字列](https://example.com)\n\n- 箇条書き項目",
    encoding: "UTF-8", lineEnding: "CRLF", readOnly: false,
  }));
  await page.waitForTimeout(400);

  for (const th of GTHEMES) {
    await page.evaluate((th) => window.__reply({ type: "apply-settings", ...th }), th);
    // body { transition: background .2s, color .2s; }(index.html)が効いているため、
    // 待ちが短いと遷移アニメーションの途中の色を読んでしまい、正しいテーマの色を
    // 読めない(実際に120msで読んだところ、遷移前後の中間色になり誤ってNGを検出した
    // ことがある)。0.2sの遷移時間より長い350ms待つ。
    await page.waitForTimeout(350);

    // .tok-link(本文リンク、指摘17)・.cm-bullet(箇条書き記号、指摘17)がvar(--paper)上で4.5以上
    const linkInfo = await page.evaluate(() => {
      const link = document.querySelector(".tok-link");
      const bullet = document.querySelector(".cm-bullet");
      const paper = getComputedStyle(document.body).backgroundColor;
      return { link: link && getComputedStyle(link).color, bullet: bullet && getComputedStyle(bullet).color, paper };
    });
    ok(`(G-2) ${th.label}: .tok-link が見つかる`, !!linkInfo.link);
    ok(`(G-2) ${th.label}: .tok-link の文字色が--paperに対し4.5以上(実測${contrastRatio(linkInfo.link, linkInfo.paper)?.toFixed(2)})`, contrastRatio(linkInfo.link, linkInfo.paper) >= AA_NORMAL);
    ok(`(G-2) ${th.label}: .cm-bullet が見つかる`, !!linkInfo.bullet);
    ok(`(G-2) ${th.label}: .cm-bullet の文字色が--paperに対し4.5以上(実測${contrastRatio(linkInfo.bullet, linkInfo.paper)?.toFixed(2)})`, contrastRatio(linkInfo.bullet, linkInfo.paper) >= AA_NORMAL);

    // #statusbar(指摘3)の文字色が実際の背景に対し4.5以上
    const sb = await page.evaluate(() => {
      const el = document.getElementById("statusbar");
      const cs = getComputedStyle(el);
      return { color: cs.color, background: cs.backgroundColor };
    });
    ok(`(G-2) ${th.label}: #statusbar の文字色が実背景に対し4.5以上(実測${contrastRatio(sb.color, sb.background)?.toFixed(2)})`, contrastRatio(sb.color, sb.background) >= AA_NORMAL);
  }
  await page.close();
}

// ---- (G-3) ダイアログの主ボタン(指摘2)・取説検索の現在ヒット(指摘6) ----
// .pane-dialog-btn-primary(background: var(--accent-ink), color: var(--surface))を
// gotoLineFlow()(行番号を指定ダイアログ、.verify-dialog.mjsと同じ呼び出し方)で
// 実際に開いて確認する。取説側(mark.help-search-hit.current)は別ウィンドウ
// (help-window.html)のため、.verify-help.mjs側の対象外だったこの回帰確認は
// (G-1)のvar(--accent-ink) vs var(--paper)実測(mark.help-search-hit.currentは
// background: var(--accent-ink), color: var(--paper)で、コントラスト比は対称の
// ため同じ値になる)で兼ねる。
{
  // window.__paneDebugCtx はブリッジ(window.chrome.webview)が無いときだけmain.js側で
  // 公開される(src/main.js "if (!bridge) { ... window.__paneDebugCtx = ctx; }"参照)ため、
  // ここではnewBridgedPageではなくnewPlainPageを使う(.verify-dialog.mjs (B)節と同じ作法)。
  // テーマ切り替えも、ブリッジ経由のapply-settingsメッセージではなく、setPreset()
  // ((A)(C)節で使っているdata-theme属性の直接操作)を使う。
  const page = await newPlainPage();
  await page.evaluate(() => { window.__paneDebugEditor.setValue("1行目\n2行目\n3行目"); });
  await page.waitForTimeout(200);

  for (const th of GTHEMES) {
    await setPreset(page, th);
    // body { transition: background .2s, color .2s; }(index.html)の遷移時間より長く待つ
    // (G-2節と同じ理由。詳細は同節のコメント参照)。
    await page.waitForTimeout(350);
    await page.evaluate(() => { window.__paneDebugCtx.actions.gotoLineFlow(); });
    await page.waitForTimeout(200);
    const info = await page.evaluate(() => {
      const btn = document.querySelector(".pane-dialog-btn-primary");
      if (!btn) return null;
      const cs = getComputedStyle(btn);
      return { color: cs.color, background: cs.backgroundColor };
    });
    ok(`(G-3) ${th.label}: .pane-dialog-btn-primary が見つかる`, !!info);
    if (info) {
      ok(`(G-3) ${th.label}: .pane-dialog-btn-primary の文字色が背景に対し4.5以上(実測${contrastRatio(info.color, info.background)?.toFixed(2)})`, contrastRatio(info.color, info.background) >= AA_NORMAL);
    }
    await page.keyboard.press("Escape");
    await page.waitForTimeout(150);
  }
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
