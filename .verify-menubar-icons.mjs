// 右上のアイコン(依頼): サイドバーの表示切替・記法を隠さない表示・全文コピーを追加した分の
// 回帰確認。
//
// 【このスイートが見張っていること】
//  (A) 並び。左3つ=文書への操作、右3つ=アプリへの操作。既存3つ(テーマ・設定・取扱説明書)は
//      位置を覚えて使われているため動かさない、という決めごとを固定する。
//  (B) ON/OFFの反映。サイドバーと記法を隠さない表示は状態を持つ。
//  (C) **ボタン以外の経路でも同期されること**。状態が変わる経路は、ボタン・メニュー・
//      ショートカット・コマンドパレット・ファイルを開いたときの自動判定と複数ある。
//      経路ごとに同期を足すと必ずどれかを忘れる(docs/調査記録/README.md「繰り返し出てきた
//      誤り」8番)。実装はctx.actions側を包んで1か所で塞いでいるので、ここでは
//      ショートカット経由とactions直呼びの両方で追従することを確かめる。
//  (D) 記法を隠さない表示はMarkdownモード限定。それ以外では押せなくする(隠さない。
//      アイコンが消えると右隣が左へ動いて押し間違えるため)。
//  (E) 全文コピー。クリップボードへ本文がそのまま入り、押した実感としてアイコンが
//      1.2秒だけチェックマークに変わって戻る。
import pw from "playwright";
const { chromium } = pw;

const PORT = 8217;
const BASE = `http://localhost:${PORT}/index.html`;
const browser = await chromium.launch();
const allErrors = [];
let okCount = 0, ngCount = 0;
const ok = (label, cond) => { console.log(`${cond ? "OK  " : "NG  "} ${label}`); if (cond) okCount++; else ngCount++; };

const context = await browser.newContext({ permissions: ["clipboard-read", "clipboard-write"] });
const page = await context.newPage();
page.on("pageerror", (e) => allErrors.push(String(e.stack || e)));
await page.goto(BASE, { waitUntil: "load" });
await page.waitForSelector(".cm-content", { timeout: 15000 });
await page.waitForTimeout(400);

const btnState = () => page.evaluate(() => ({
  sidebar: document.querySelector("#btn-menu-sidebar")?.getAttribute("aria-pressed"),
  source: document.querySelector("#btn-menu-source")?.getAttribute("aria-pressed"),
  sourceDisabled: document.querySelector("#btn-menu-source")?.disabled,
  mode: window.__paneDebugCtx?.getState?.().mode,
  sidebarOpen: window.__paneDebugCtx?.getState?.().sidebarOpen,
  sourceMode: window.__paneDebugCtx?.getState?.().sourceMode,
}));

// ---- (A) 並び ----
{
  const order = await page.evaluate(() => [...document.querySelectorAll("#menubar button")].map((b) => b.id).filter(Boolean));
  const want = ["btn-menu-sidebar", "btn-menu-source", "btn-menu-copyall", "btn-theme", "btn-menu-settings", "btn-menu-help"];
  ok(`(A) 右上のアイコンの並びが決めどおり(実際=${order.join(" → ")})`, JSON.stringify(order) === JSON.stringify(want));

  // 区切り(利用者要望)。全文コピーとテーマ切替のあいだに、文字ではなく罫線で入れる。
  const sep = await page.evaluate(() => {
    const s = document.querySelector(".menubar-sep");
    if (!s) return null;
    const r = s.getBoundingClientRect();
    const kids = [...document.querySelector("#menubar").children];
    return {
      w: Math.round(r.width), h: Math.round(r.height),
      前: kids[kids.indexOf(s) - 1]?.id, 後: kids[kids.indexOf(s) + 1]?.id,
      文字: s.textContent.trim(), 読み上げ除外: s.getAttribute("aria-hidden"),
    };
  });
  ok(`(A) 全文コピーとテーマ切替のあいだに区切りがある(前=${sep?.前}, 後=${sep?.後})`,
    sep?.前 === "btn-menu-copyall" && sep?.後 === "btn-theme");
  ok(`(A) 区切りは文字ではなく線で描き、読み上げ対象から外している(${sep?.w}x${sep?.h}px, 文字="${sep?.文字}")`,
    sep?.文字 === "" && sep?.読み上げ除外 === "true" && sep?.w >= 1 && sep?.h > 0);

  const labels = await page.evaluate(() => ["#btn-menu-sidebar", "#btn-menu-source", "#btn-menu-copyall"]
    .map((s) => document.querySelector(s)?.getAttribute("aria-label")));
  ok(`(A) 3つとも読み上げ用の名前が付いている(実際=${JSON.stringify(labels)})`,
    labels.every((l) => typeof l === "string" && l.length > 0));

  // アイコンは文字ではなくSVGで描く(仕様書10.1節・CLAUDE.md。折りたたみマーカーが
  // フォント依存で読めなくなった件と同じ轍を踏まない)。
  const svgOnly = await page.evaluate(() => ["#btn-menu-sidebar", "#btn-menu-source", "#btn-menu-copyall"]
    .every((s) => { const b = document.querySelector(s); return b && b.textContent.trim() === "" && b.querySelectorAll("svg").length >= 1; }));
  ok("(A) 3つとも記号を文字ではなくSVGで描いている", svgOnly);
}

// ---- (B)(C) ON/OFFの反映と、ボタン以外の経路での同期 ----
{
  const before = await btnState();
  ok(`(B) 初期はサイドバーOFF・記法表示OFF(実際 sidebar=${before.sidebar}, source=${before.source})`,
    before.sidebar === "false" && before.source === "false");

  await page.click("#btn-menu-sidebar"); await page.waitForTimeout(250);
  const s1 = await btnState();
  ok(`(B) ボタンでサイドバーが開き、見た目もONになる(aria-pressed=${s1.sidebar}, 実際の開閉=${s1.sidebarOpen})`,
    s1.sidebar === "true" && s1.sidebarOpen === true);

  await page.click("#btn-menu-sidebar"); await page.waitForTimeout(250);
  const s2 = await btnState();
  ok(`(B) もう一度押すと閉じ、OFFへ戻る(aria-pressed=${s2.sidebar})`, s2.sidebar === "false" && s2.sidebarOpen === false);

  // (C) ショートカット経由。ボタンを押していないのに見た目が追従すること。
  await page.keyboard.press("Control+Shift+L"); await page.waitForTimeout(300);
  const s3 = await btnState();
  ok(`(C) Ctrl+Shift+L でもボタンの見た目が追従する(aria-pressed=${s3.sidebar}, 実際の開閉=${s3.sidebarOpen})`,
    s3.sidebar === "true" && s3.sidebarOpen === true);

  await page.keyboard.press("Control+Slash"); await page.waitForTimeout(300);
  const s4 = await btnState();
  ok(`(C) Ctrl+/ でも記法表示のボタンが追従する(aria-pressed=${s4.source}, 実際=${s4.sourceMode})`,
    s4.source === "true" && s4.sourceMode === true);

  // (C) コマンドパレット等が最後に通るctx.actions直呼び。
  await page.evaluate(() => window.__paneDebugCtx.actions.toggleSidebar());
  await page.waitForTimeout(300);
  const s5 = await btnState();
  ok(`(C) ctx.actionsを直接呼んでも追従する(aria-pressed=${s5.sidebar}, 実際の開閉=${s5.sidebarOpen})`,
    s5.sidebar === "false" && s5.sidebarOpen === false);

  await page.keyboard.press("Control+Slash"); await page.waitForTimeout(300);  // 記法表示をOFFへ戻す
}

// ---- (D) 記法を隠さない表示はMarkdownモード限定 ----
{
  const md = await btnState();
  ok(`(D) Markdownモードでは押せる(disabled=${md.sourceDisabled}, mode=${md.mode})`,
    md.sourceDisabled === false && md.mode === "markdown");

  for (const m of ["code", "plain"]) {
    await page.evaluate((mm) => window.__paneDebugCtx.actions.setMode(mm), m);
    await page.waitForTimeout(300);
    const st = await btnState();
    ok(`(D) ${m}モードでは押せなくなる(disabled=${st.sourceDisabled}, mode=${st.mode})`,
      st.sourceDisabled === true && st.mode === m);
    // 位置がずれないこと(隠すのではなく薄くする、という判断の固定)。
    const visible = await page.evaluate(() => {
      const b = document.querySelector("#btn-menu-source");
      const r = b.getBoundingClientRect();
      return { hidden: b.hidden, w: Math.round(r.width), h: Math.round(r.height) };
    });
    ok(`(D) ${m}モードでもアイコンは消えない(hidden=${visible.hidden}, 大きさ=${visible.w}x${visible.h})`,
      visible.hidden === false && visible.w > 0 && visible.h > 0);
  }

  await page.evaluate(() => window.__paneDebugCtx.actions.setMode("markdown"));
  await page.waitForTimeout(300);
  const back = await btnState();
  ok(`(D) Markdownへ戻すと再び押せる(disabled=${back.sourceDisabled})`, back.sourceDisabled === false);
}

// ---- (E) 全文コピー ----
{
  const BODY = "# 見出し\n\n本文です。\n\n- 箇条書き\n";
  await page.evaluate((t) => window.__paneDebugEditor.setValue(t), BODY);
  await page.waitForTimeout(300);

  await page.click("#btn-menu-copyall");
  await page.waitForTimeout(200);
  const clip = await page.evaluate(() => navigator.clipboard.readText());
  ok(`(E) 本文がそのままクリップボードへ入る(${JSON.stringify(clip.slice(0, 18))}…)`, clip === BODY);

  const during = await page.evaluate(() => ({
    idle: document.querySelector("#btn-menu-copyall .icon-idle")?.hidden,
    done: document.querySelector("#btn-menu-copyall .icon-done")?.hidden,
    label: document.querySelector("#btn-menu-copyall")?.getAttribute("aria-label"),
  }));
  ok(`(E) 押した直後はチェックマークに変わる(label="${during.label}")`,
    during.idle === true && during.done === false && during.label === "コピーしました");

  await page.waitForTimeout(1400);
  const after = await page.evaluate(() => ({
    idle: document.querySelector("#btn-menu-copyall .icon-idle")?.hidden,
    done: document.querySelector("#btn-menu-copyall .icon-done")?.hidden,
    label: document.querySelector("#btn-menu-copyall")?.getAttribute("aria-label"),
  }));
  ok(`(E) 1.2秒で元のアイコンへ戻る(label="${after.label}")`,
    after.idle === false && after.done === true && after.label === "全文をコピー");

  // メニュー・コマンドパレットからも同じ動作になること(ボタンだけの機能にしない)。
  await page.evaluate(() => window.__paneDebugEditor.setValue("別の本文\n"));
  await page.waitForTimeout(200);
  await page.evaluate(() => window.__paneDebugCtx.actions.copyAll());
  await page.waitForTimeout(200);
  const clip2 = await page.evaluate(() => navigator.clipboard.readText());
  ok(`(E) コマンド(ctx.actions.copyAll)からも同じ結果になる(${JSON.stringify(clip2)})`, clip2 === "別の本文\n");
}

// ---- (F) 押しても本文のカーソルが外れない(利用者要望) ----
// 既定では、ボタンを押した時点でフォーカスがボタンへ移り、本文のカーソルが消える。
// 書きかけの位置を見失うため、mousedownを止めてフォーカスを動かさないようにしている。
// 設定・取扱説明書は別ウィンドウを開くので対象外。
{
  await page.evaluate(() => window.__paneDebugEditor.setValue("あいうえお\n"));
  await page.click(".cm-content");
  await page.keyboard.press("End");
  await page.waitForTimeout(200);
  const head0 = await page.evaluate(() => window.__paneDebugEditor.view.state.selection.main.head);

  for (const id of ["#btn-menu-sidebar", "#btn-menu-source", "#btn-menu-copyall", "#btn-theme"]) {
    await page.click(id);
    await page.waitForTimeout(250);
    const st = await page.evaluate(() => ({
      本文にフォーカス: window.__paneDebugEditor.view.hasFocus,
      位置: window.__paneDebugEditor.view.state.selection.main.head,
    }));
    ok(`(F) ${id} を押しても本文のカーソルが残る(フォーカス=${st.本文にフォーカス}, 位置=${st.位置})`,
      st.本文にフォーカス === true && st.位置 === head0);
  }

  // マウスを止めてもキーボードからは押せること(Tabで移動してEnter)。
  const before = await page.evaluate(() => window.__paneDebugCtx.getState().sidebarOpen);
  await page.evaluate(() => document.querySelector("#btn-menu-sidebar").focus());
  await page.keyboard.press("Enter");
  await page.waitForTimeout(300);
  const after = await page.evaluate(() => window.__paneDebugCtx.getState().sidebarOpen);
  ok(`(F) キーボード(Enter)でも押せる(${before} → ${after})`, before !== after);

  // サイドバーを開いたあと、その中の要素へフォーカスを移せること
  // (本文へ固定しすぎて、サイドバーが操作できなくなっていないか)。
  const canFocus = await page.evaluate(() => {
    const el = document.querySelector("#sidebar input, #sidebar button, .sidebar input, .sidebar button");
    if (!el) return null;
    el.focus();
    return document.activeElement === el;
  });
  ok("(F) サイドバーを開いたあと、その中の要素へフォーカスを移せる", canFocus === true);
}

ok(`ページエラー0件 ${JSON.stringify(allErrors.slice(0, 2))}`, allErrors.length === 0);
await browser.close();
console.log(`\n合計: OK ${okCount} / NG ${ngCount}`);
process.exit(ngCount > 0 ? 1 : 0);
