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

  // 【ここは実際に見えているかを見る】以前はSVGの`hidden`プロパティだけを確かめていたが、
  // `hidden`はHTMLElementのものでSVGElementには無く、JSから代入しても属性は変わらない。
  // そのためチェックマークは一度も表示されていないのにテストは通っていた。
  // 見た目の確認は、実際に描画されているか(computedStyleのdisplay)で行う。
  const iconState = () => page.evaluate(() => {
    const btn = document.querySelector("#btn-menu-copyall");
    const disp = (sel) => {
      const el = btn.querySelector(sel);
      return el ? getComputedStyle(el).display : null;
    };
    return {
      idle: disp(".icon-idle"),
      done: disp(".icon-done"),
      label: btn.getAttribute("aria-label"),
      copied: btn.classList.contains("copied"),
      // 動き(アニメーション)が実際に走っているか。名前だけでなく再生中であることまで見る。
      anims: btn.getAnimations({ subtree: true })
        .filter((a) => a.animationName)
        .map((a) => `${a.animationName}:${a.playState}`),
    };
  });
  const during = await iconState();
  ok(`(E) 押した直後はチェックマークが実際に表示される(コピー前=${during.idle}, チェック=${during.done}, label="${during.label}")`,
    during.idle === "none" && during.done !== "none" && during.label === "コピーしました");
  // 利用者要望: コピーできたことが分かるアニメーション。ボタンの弾みとチェックマークの
  // 描き進めの2つが同時に走る。
  ok(`(E) コピーできたことが分かる動きが走る(実際=${JSON.stringify(during.anims)})`,
    during.anims.some((a) => a.startsWith("copy-pop:running"))
    && during.anims.some((a) => a.startsWith("copy-draw:running")));

  // 連打しても毎回やり直す(同じ場所で続けて押したときに何も起きないように見えない)。
  await page.waitForTimeout(500);
  await page.click("#btn-menu-copyall");
  await page.waitForTimeout(30);
  const again = await page.evaluate(() => {
    const btn = document.querySelector("#btn-menu-copyall");
    const a = btn.getAnimations({ subtree: true }).find((x) => x.animationName === "copy-pop");
    return a ? Math.round(a.currentTime) : null;
  });
  ok(`(E) 連打しても動きが最初からやり直す(2回目の経過=${again}ms)`, again !== null && again < 120);

  await page.waitForTimeout(1400);
  const after = await iconState();
  ok(`(E) 1.2秒で元のアイコンへ戻る(コピー前=${after.idle}, チェック=${after.done}, label="${after.label}")`,
    after.idle !== "none" && after.done === "none" && after.label === "全文をコピー" && after.copied === false);

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

// ---- (G) 起動したら本文の先頭にカーソルがある(利用者要望) ----
// 起動直後のフォーカスはbody(実測: view.hasFocusがfalse、activeElementがBODY)で、
// 一度クリックしないとキー入力もCtrl+Z等のショートカットも効かなかった。
// 呼ぶ場所が2か所ある理由(bridgeの有無)は src/main.js のコメント参照。
{
  const fresh = await context.newPage();
  fresh.on("pageerror", (e) => allErrors.push(String(e.stack || e)));
  await fresh.goto(BASE, { waitUntil: "load" });
  await fresh.waitForSelector(".cm-content", { timeout: 15000 });
  await fresh.waitForTimeout(600);

  const st = await fresh.evaluate(() => ({
    フォーカス: window.__paneDebugEditor.view.hasFocus,
    位置: window.__paneDebugEditor.view.state.selection.main.head,
  }));
  ok(`(G) 起動直後、本文にフォーカスがありカーソルが先頭にある(フォーカス=${st.フォーカス}, 位置=${st.位置})`,
    st.フォーカス === true && st.位置 === 0);

  // 要点は「クリックせずにそのまま書き始められること」。フォーカスの有無だけでなく
  // 実際に文字が入るところまで見る。
  await fresh.keyboard.type("すぐ書ける");
  await fresh.waitForTimeout(200);
  const typed = await fresh.evaluate(() => window.__paneDebugEditor.view.state.doc.toString());
  ok(`(G) クリックせずにそのまま入力できる(実際="${typed}")`, typed === "すぐ書ける");

  // 本文がある状態でも先頭に来ること(末尾やスクロール位置に飛ばない)。
  await fresh.evaluate(() => window.__paneDebugEditor.setValue("一行目\n二行目\n三行目\n"));
  await fresh.waitForTimeout(300);
  const st2 = await fresh.evaluate(() => ({
    位置: window.__paneDebugEditor.view.state.selection.main.head,
    長さ: window.__paneDebugEditor.view.state.doc.length,
  }));
  ok(`(G) 本文があっても先頭のまま(位置=${st2.位置}, 長さ=${st2.長さ})`, st2.位置 === 0 && st2.長さ > 0);
  await fresh.close();
}

// 先に別の場所へフォーカスがあれば奪わないこと。
{
  const fresh = await context.newPage();
  fresh.on("pageerror", (e) => allErrors.push(String(e.stack || e)));
  await fresh.addInitScript(() => {
    document.addEventListener("DOMContentLoaded", () => {
      document.querySelector("#btn-menu-settings")?.focus();
    }, { once: true });
  });
  await fresh.goto(BASE, { waitUntil: "load" });
  await fresh.waitForSelector(".cm-content", { timeout: 15000 });
  await fresh.waitForTimeout(600);
  const who = await fresh.evaluate(() => document.activeElement?.id || document.activeElement?.className);
  ok(`(G) 先に別の場所へフォーカスがあれば奪わない(実際=${who})`, who === "btn-menu-settings");
  await fresh.close();
}

// ---- (H) 本文を差し替えてもフォーカスの状態が食い違わない(起動時フォーカスで表面化した不具合) ----
// view.setState()はstateを丸ごと作り直すため、フォーカス状態を持つStateFieldが既定値(false)へ
// 戻る。DOMのフォーカスは変わらないので通知も飛ばず、「実際にはフォーカスがあるのにfalse」が
// 残り続ける。するとカーソルの真下でブロック([toc]・表・Mermaid等)が描画され、カーソルが
// 置き換え範囲の外へ押し出されて、次に打った1文字が別の行へ紛れ込む。
// 起動時に本文へフォーカスするようにしたこと(上の(G))で表面化したが、原因はsetState側にある。
// 詳しくは src/editor.js の syncFocusFieldToDom 定義部のコメントを参照。
async function testTypingAfterDocSwap(label, swap) {
  const fresh = await context.newPage();
  fresh.on("pageerror", (e) => allErrors.push(String(e.stack || e)));
  await fresh.goto(BASE, { waitUntil: "load" });
  await fresh.waitForSelector(".cm-content", { timeout: 15000 });
  await fresh.waitForTimeout(600); // 起動時フォーカスが当たるのを待つ(クリックはしない)
  await fresh.evaluate(swap);
  await fresh.waitForTimeout(200);
  await fresh.keyboard.press("Control+End");
  await fresh.keyboard.type("[toc]", { delay: 8 }); // 1文字ずつ。途中で"[toc]"が完成する
  await fresh.waitForTimeout(200);
  const doc = await fresh.evaluate(() => window.__paneDebugEditor.view.state.doc.toString());
  ok(`(H) ${label}のあと、クリックせず打った文字が崩れない(実際=${JSON.stringify(doc)})`,
    doc === "park\n\n[toc]");
  // 本来の表示(カーソルを外せば目次として描画される)も壊れていないこと。
  await fresh.evaluate(() => window.__paneDebugEditor.blur());
  await fresh.waitForTimeout(400);
  const tocCount = await fresh.evaluate(() => document.querySelectorAll(".cm-toc").length);
  ok(`(H) ${label}のあとでもカーソルを外せば目次として描画される(個数=${tocCount})`, tocCount >= 1);
  await fresh.close();
}
await testTypingAfterDocSwap("setValue(別ファイルを開く相当)",
  () => window.__paneDebugEditor.setValue("park\n\n"));
await testTypingAfterDocSwap("setEditorState(タブ切替相当)",
  () => window.__paneDebugEditor.setEditorState(window.__paneDebugEditor.createFreshState("park\n\n")));

ok(`ページエラー0件 ${JSON.stringify(allErrors.slice(0, 2))}`, allErrors.length === 0);
await browser.close();
console.log(`\n合計: OK ${okCount} / NG ${ngCount}`);
process.exit(ngCount > 0 ? 1 : 0);
