// 本文検索(Ctrl+F)のヒットのハイライトと、スクロールバー上のヒット位置の印の検証。ポートは9210。
//
// 【背景】 @codemirror/search の search() 拡張が内蔵するハイライト用ViewPluginは
// `if (!panel || !query.spec.valid) return Decoration.none` という実装で、CodeMirror標準の
// 検索パネル(openSearchPanel)が開いている間しか装飾を作らない。Paneは検索UIを自前で持ち
// openSearchPanelを呼ばないため、件数表示は正しいのに本文には一切色が付いていなかった
// (実測: document.querySelectorAll(".cm-searchMatch").length === 0)。
// editor.js に searchHighlightPlugin(本文の装飾) と searchRulerPlugin(スクロールバー上の印)を
// 自前で実装したので、その回帰検証。
//
// 確認する内容:
//   (A) 検索するとヒットの数だけ .cm-search-hit が出る(全ヒットが可視範囲に収まる文書)
//   (B) Enter/∨で .cm-search-hit-active が移動し、常に1つだけであること
//   (C) 検索を閉じるとハイライトも印も消えること
//   (D) 大文字小文字/単語単位/正規表現のどのオプションでも数が件数表示と一致すること
//   (E) コードモードでも出ること・シンタックスハイライトの色を消さないこと
//   (F) 長い文書では可視範囲だけを走査していること(画面内のヒットは漏れなく色が付く)
//   (G) スクロールバーの印: 件数と対応する・現在のヒットの印が移動する・
//       画面外にしかヒットが無くても出る・閉じると消える・クリックでジャンプできる
//   (H) 走査上限(SEARCH_RULER_MAX_MARKS=1000)で打ち切られること
//   (I) 10万行の文書で、検索語の入力・スクロール・本文入力がもたつかないこと
import pw from "playwright";
const { chromium } = pw;
const PORT = 9210;
const browser = await chromium.launch();
let okCount = 0, ngCount = 0;
const ok = (label, cond, extra = "") => { console.log(`${cond ? "OK  " : "NG  "} ${label}${extra ? " " + extra : ""}`); if (cond) okCount++; else ngCount++; };

const allErrors = [];
// withBridge=false のときはWebView2ブリッジのモックを入れない。main.jsは「ブリッジが
// 無いとき」だけ window.__paneDebugEditor を公開する作りなので、10万行の文書投入や
// view.dispatch の所要時間の実測(性能計測、(I)節)はこちらのページで行う。
async function newPage(withBridge = true) {
  const page = await browser.newPage({ viewport: { width: 1200, height: 760 } });
  page.on("pageerror", (e) => allErrors.push(String(e.stack || e)));
  page.on("console", (m) => { if (m.type() === "error") allErrors.push("console.error: " + m.text()); });
  if (withBridge) await page.addInitScript(() => {
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
  await page.goto(`http://localhost:${PORT}/index.html`);
  await page.waitForTimeout(700);
  return page;
}
async function openFile(page, text, fileName = "sample.md") {
  await page.evaluate(({ text, fileName }) => window.__reply({
    type: "file-opened", fileName, path: "C:\\work\\" + fileName, text,
    encoding: "UTF-8", lineEnding: "LF", readOnly: false,
  }), { text, fileName });
  await page.waitForTimeout(400);
}
async function openSearch(page) {
  await page.click(".cm-content");
  await page.keyboard.press("Control+f");
  await page.waitForTimeout(200);
}
// 検索欄へ入力する。ルーラーの走査はデバウンス(150ms)されるので少し長めに待つ。
async function typeQuery(page, q) {
  await page.fill("#search-query", q);
  await page.waitForTimeout(450);
}
// 件数表示("3 / 25" または "見つかりません")から総数を読む。
async function totalCount(page) {
  const t = (await page.textContent("#search-count")) || "";
  const m = t.match(/\/\s*(\d+)/);
  return m ? Number(m[1]) : 0;
}
const snap = (page) => page.evaluate(() => ({
  hits: document.querySelectorAll(".cm-search-hit").length,
  active: document.querySelectorAll(".cm-search-hit-active").length,
  marks: document.querySelectorAll(".cm-search-ruler-mark").length,
  activeMarks: document.querySelectorAll(".cm-search-ruler-mark.is-active").length,
  rulerHidden: document.querySelector(".cm-search-ruler")?.hidden ?? null,
  truncated: document.querySelector(".cm-search-ruler")?.dataset.truncated ?? null,
}));

// =========================================================================
// (A) 全ヒットが画面に収まる短い文書で、ハイライトの数 = 件数
// =========================================================================
{
  const page = await newPage();
  const doc = ["test one", "line two", "TEST three", "a testing line", "line five", "the test."].join("\n");
  await openFile(page, doc);
  await openSearch(page);
  await typeQuery(page, "test");
  const total = await totalCount(page);
  const s = await snap(page);
  ok(`(A-1) 件数表示が4件(test/TEST/testing/test。大文字小文字を区別しない既定) → ${total}`, total === 4);
  ok(`(A-2) .cm-search-hit が件数と同じ数だけ出る → hit=${s.hits} / 件数=${total}`, s.hits === total && s.hits > 0);
  // 修正前の状態(装飾が1つも出ない)を明確に落とすための確認。
  ok(`(A-3) 修正前は0件だった(=装飾が実際に描かれている)`, s.hits > 0);
  await page.close();
}

// =========================================================================
// (B) Enter / ∨ボタンで「現在のヒット」が移動し、常に1つだけ
// =========================================================================
{
  const page = await newPage();
  await openFile(page, ["test one", "line two", "test three", "line four", "test five"].join("\n"));
  await openSearch(page);
  await typeQuery(page, "test");
  const before = await snap(page);
  ok(`(B-1) 検索直後は現在のヒットがまだ無い(選択がヒットと一致していない) → active=${before.active}`, before.active === 0);
  const positions = [];
  for (let i = 0; i < 3; i++) {
    await page.keyboard.press("Enter");
    await page.waitForTimeout(250);
    const s = await snap(page);
    ok(`(B-2-${i + 1}) Enter ${i + 1}回目: .cm-search-hit-active がちょうど1つ → ${s.active}`, s.active === 1);
    positions.push(await page.evaluate(() => {
      const e = document.querySelector(".cm-search-hit-active");
      return e ? Math.round(e.getBoundingClientRect().top) : -1;
    }));
  }
  ok(`(B-3) Enterのたびに現在のヒットの位置が変わる → top=${positions.join(",")}`,
    positions[0] !== positions[1] && positions[1] !== positions[2]);
  // ∨ボタン(パネル内の「次を検索」)でも同じこと。
  await page.click("#search-next");
  await page.waitForTimeout(250);
  const s2 = await snap(page);
  ok(`(B-4) ∨ボタンでも現在のヒットはちょうど1つ → ${s2.active}`, s2.active === 1);
  // 現在のヒットも .cm-search-hit を併せ持つ(=総数に含まれる)。
  const both = await page.evaluate(() => {
    const e = document.querySelector(".cm-search-hit-active");
    return !!e && e.classList.contains("cm-search-hit");
  });
  ok(`(B-5) 現在のヒットも .cm-search-hit を持つ(総数に含まれる)`, both);
  await page.close();
}

// =========================================================================
// (C) 検索を閉じるとハイライト・印が消える
// =========================================================================
{
  const page = await newPage();
  const doc = [];
  for (let i = 0; i < 200; i++) doc.push(i % 9 === 0 ? `${i}: test line` : `${i}: plain line`);
  await openFile(page, doc.join("\n"));
  await openSearch(page);
  await typeQuery(page, "test");
  const on = await snap(page);
  ok(`(C-1) 検索中はハイライトも印も出ている → hit=${on.hits}, mark=${on.marks}`, on.hits > 0 && on.marks > 0);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(450);
  const off = await snap(page);
  ok(`(C-2) Escapeで閉じるとハイライトが消える → hit=${off.hits}`, off.hits === 0);
  ok(`(C-3) Escapeで閉じると印も消える → mark=${off.marks}, hidden=${off.rulerHidden}`, off.marks === 0 && off.rulerHidden === true);
  // ×ボタンでも同じ。
  await openSearch(page);
  await typeQuery(page, "test");
  await page.click("#search-close");
  await page.waitForTimeout(450);
  const off2 = await snap(page);
  ok(`(C-4) ×ボタンで閉じてもハイライト・印が消える → hit=${off2.hits}, mark=${off2.marks}`, off2.hits === 0 && off2.marks === 0);
  await page.close();
}

// =========================================================================
// (D) 大文字小文字 / 単語単位 / 正規表現の各オプションでも件数と一致
// =========================================================================
{
  const page = await newPage();
  const doc = ["test one", "TEST two", "testing three", "a Test.", "no match here", "test42"].join("\n");
  await openFile(page, doc);
  await openSearch(page);

  await typeQuery(page, "test");
  let total = await totalCount(page), s = await snap(page);
  ok(`(D-1) 既定(大文字小文字を区別しない): hit=${s.hits} / 件数=${total}`, s.hits === total && total === 5);

  await page.check("#search-case");
  await page.waitForTimeout(450);
  total = await totalCount(page); s = await snap(page);
  ok(`(D-2) Aa(大文字小文字を区別): hit=${s.hits} / 件数=${total}`, s.hits === total && total === 3);
  ok(`(D-3) Aa: 印の数も件数と一致 → mark=${s.marks}`, s.marks === total);
  await page.uncheck("#search-case");
  await page.waitForTimeout(300);

  await page.check("#search-word");
  await page.waitForTimeout(450);
  total = await totalCount(page); s = await snap(page);
  ok(`(D-4) 単語単位: hit=${s.hits} / 件数=${total}`, s.hits === total && total === 3);
  ok(`(D-5) 単語単位: 印の数も件数と一致 → mark=${s.marks}`, s.marks === total);
  await page.uncheck("#search-word");
  await page.waitForTimeout(300);

  await page.check("#search-regex");
  await typeQuery(page, "test\\d+");
  total = await totalCount(page); s = await snap(page);
  ok(`(D-6) 正規表現 test\\d+: hit=${s.hits} / 件数=${total}`, s.hits === total && total === 1);
  await typeQuery(page, "^te");
  total = await totalCount(page); s = await snap(page);
  // "test one" / "TEST two" / "testing three" / "test42" の4行が行頭で一致する。
  ok(`(D-7) 正規表現 ^te(行頭): hit=${s.hits} / 件数=${total}`, s.hits === total && total === 4);
  // 不正な正規表現ではハイライトを出さない(クエリが無効なので装飾も0)。
  await typeQuery(page, "test(");
  s = await snap(page);
  ok(`(D-8) 不正な正規表現ではハイライトを出さない → hit=${s.hits}, mark=${s.marks}`, s.hits === 0 && s.marks === 0);
  await page.close();
}

// =========================================================================
// (E) コードモードでも出る / シンタックスハイライトの色を消さない
// =========================================================================
{
  const page = await newPage();
  const js = [];
  for (let i = 0; i < 12; i++) js.push(`function test${i}(a, b) { const s = "test value"; return a + b; }`);
  await openFile(page, js.join("\n"), "sample.js");
  await page.waitForTimeout(500);
  const mode = await page.textContent("#status-mode");
  ok(`(E-1) コードモードで開けている → ${mode}`, /コード/.test(mode || ""));
  await openSearch(page);
  await typeQuery(page, "test");
  const total = await totalCount(page), s = await snap(page);
  ok(`(E-2) コードモードでもハイライトが件数と一致 → hit=${s.hits} / 件数=${total}`, s.hits === total && s.hits > 0);
  // ハイライトした要素の文字色が、テーマの本文色一色に潰れていない(=シンタックス色が残る)。
  // 装飾は <span class="cm-search-hit"><span class="ͼy">test</span></span> の入れ子になる
  // (ハイライトが外側、シンタックスハイライトが内側)。外側のcolorは継承値になるため、
  // 実際に文字を描いている内側の要素の色を数える。
  const colors = await page.evaluate(() => {
    const set = new Set();
    for (const e of document.querySelectorAll(".cm-search-hit:not(.cm-search-hit-active)")) {
      const inner = e.firstElementChild || e;
      set.add(getComputedStyle(inner).color);
    }
    return [...set];
  });
  ok(`(E-3) ハイライト内の文字色が複数残る(関数名と文字列で違う色) → ${colors.length}種`, colors.length >= 2, JSON.stringify(colors));
  // 現在のヒットだけは、濃い面の上での可読性を優先して文字色を固定する。
  await page.keyboard.press("Enter");
  await page.waitForTimeout(250);
  const activeColor = await page.evaluate(() => {
    const e = document.querySelector(".cm-search-hit-active");
    return e ? getComputedStyle(e).color : null;
  });
  ok(`(E-4) 現在のヒットは文字色を固定している → ${activeColor}`, activeColor === "rgb(26, 18, 0)");
  await page.close();
}

// =========================================================================
// (F) 長い文書では可視範囲だけを走査する(画面に見えているヒットは漏れなく色が付く)
// =========================================================================
{
  const page = await newPage();
  const doc = [];
  for (let i = 0; i < 3000; i++) doc.push(i % 4 === 0 ? `${i}: test line` : `${i}: plain line`);
  await openFile(page, doc.join("\n"));
  await openSearch(page);
  await typeQuery(page, "test");
  const total = await totalCount(page);
  const s = await snap(page);
  ok(`(F-1) 全体の件数は750件 → ${total}`, total === 750);
  ok(`(F-2) ハイライトは可視範囲ぶんだけ(文書全体を走査していない) → hit=${s.hits}`, s.hits > 0 && s.hits < total);
  // 画面に見えているヒットが漏れなくハイライトされていること:
  // 画面内の行のテキストに含まれる"test"の数 = 画面内にある .cm-search-hit の数。
  const cmp = await page.evaluate(() => {
    const sc = document.querySelector(".cm-scroller").getBoundingClientRect();
    const inView = (r) => r.top >= sc.top && r.bottom <= sc.bottom;
    let expected = 0;
    for (const line of document.querySelectorAll(".cm-content .cm-line")) {
      if (!inView(line.getBoundingClientRect())) continue;
      expected += (line.textContent.match(/test/gi) || []).length;
    }
    let got = 0;
    for (const h of document.querySelectorAll(".cm-search-hit")) if (inView(h.getBoundingClientRect())) got++;
    return { expected, got };
  });
  ok(`(F-3) 画面内のヒットは漏れなくハイライトされる → 期待${cmp.expected} / 実際${cmp.got}`,
    cmp.expected > 0 && cmp.expected === cmp.got);
  await page.close();
}

// =========================================================================
// (G) スクロールバー上の印
// =========================================================================
{
  const page = await newPage();
  const doc = [];
  for (let i = 0; i < 600; i++) doc.push(i % 25 === 0 ? `${i}: test line` : `${i}: plain line`);
  await openFile(page, doc.join("\n"));
  await openSearch(page);
  await typeQuery(page, "test");
  const total = await totalCount(page);
  let s = await snap(page);
  ok(`(G-1) 印の数が件数と一致(上限内) → mark=${s.marks} / 件数=${total}`, s.marks === total && total === 24);
  ok(`(G-2) 印は打ち切られていない → truncated=${s.truncated}`, s.truncated === "false");
  // 印が縦に散らばっている(=文書全体の位置を表している)。
  const spread = await page.evaluate(() => {
    const tops = [...document.querySelectorAll(".cm-search-ruler-mark")].map((e) => e.getBoundingClientRect().top);
    return { min: Math.round(Math.min(...tops)), max: Math.round(Math.max(...tops)), n: tops.length };
  });
  ok(`(G-3) 印が縦方向に散らばっている → top ${spread.min}〜${spread.max}`, spread.max - spread.min > 300);
  // 印がスクロールバーの位置(エディタの右端)にある。
  const geom = await page.evaluate(() => {
    const ed = document.querySelector(".cm-editor").getBoundingClientRect();
    const r = document.querySelector(".cm-search-ruler").getBoundingClientRect();
    return { edRight: Math.round(ed.right), rulerRight: Math.round(r.right), w: Math.round(r.width) };
  });
  ok(`(G-4) 印の帯がエディタの右端(標準スクロールバーの上)にある → 帯right=${geom.rulerRight} / エディタright=${geom.edRight}, 幅=${geom.w}`,
    Math.abs(geom.rulerRight - geom.edRight) <= 1 && geom.w === 17);
  // 帯自体はクリックを透過する(スクロールバーの操作を妨げない)。
  const pe = await page.evaluate(() => getComputedStyle(document.querySelector(".cm-search-ruler")).pointerEvents);
  ok(`(G-5) 帯は pointer-events:none でスクロールバー操作を妨げない → ${pe}`, pe === "none");

  // 次/前への移動で「現在のヒット」の印が移動する。
  await page.keyboard.press("Enter");
  await page.waitForTimeout(250);
  const a1 = await page.evaluate(() => {
    const e = document.querySelector(".cm-search-ruler-mark.is-active");
    return e ? Math.round(e.getBoundingClientRect().top) : -1;
  });
  s = await snap(page);
  ok(`(G-6) 現在のヒットの印がちょうど1つ → ${s.activeMarks}`, s.activeMarks === 1);
  await page.keyboard.press("Enter");
  await page.waitForTimeout(250);
  const a2 = await page.evaluate(() => {
    const e = document.querySelector(".cm-search-ruler-mark.is-active");
    return e ? Math.round(e.getBoundingClientRect().top) : -1;
  });
  s = await snap(page);
  ok(`(G-7) 次へ移動すると現在の印も移動する → ${a1} → ${a2}`, a1 >= 0 && a2 >= 0 && a1 !== a2 && s.activeMarks === 1);

  // 画面外にしかヒットが無い状態でも印が出る(この機能の主目的)。
  await typeQuery(page, "599: plain");
  const s3 = await snap(page);
  const offscreen = await page.evaluate(() => {
    const sc = document.querySelector(".cm-scroller").getBoundingClientRect();
    let visible = 0;
    for (const h of document.querySelectorAll(".cm-search-hit")) {
      const r = h.getBoundingClientRect();
      if (r.top >= sc.top && r.bottom <= sc.bottom) visible++;
    }
    return visible;
  });
  ok(`(G-8) 画面内にヒットが1つも無い(最終行だけが一致) → 画面内のハイライト=${offscreen}`, offscreen === 0);
  ok(`(G-9) 画面外にしかヒットが無くても印は出る → mark=${s3.marks}, hidden=${s3.rulerHidden}`, s3.marks === 1 && s3.rulerHidden === false);

  // 印をクリックするとその位置へジャンプする。
  const scrollBefore = await page.evaluate(() => document.querySelector(".cm-scroller").scrollTop);
  await page.click(".cm-search-ruler-mark", { force: true });
  await page.waitForTimeout(400);
  const after = await page.evaluate(() => ({
    scroll: document.querySelector(".cm-scroller").scrollTop,
    // 行番号はステータスバーの「行 N, 列 M」表示から読む(__paneDebugEditorはブリッジが
    // 無いときしか公開されず、このスイートはブリッジをモックしているため使えない)。
    line: Number((document.getElementById("status-position").textContent.match(/行\s*(\d+)/) || [])[1] || -1),
    activeMarks: document.querySelectorAll(".cm-search-ruler-mark.is-active").length,
  }));
  ok(`(G-10) 印のクリックでその位置へジャンプする → scroll ${Math.round(scrollBefore)} → ${Math.round(after.scroll)}, 行=${after.line}`,
    after.scroll > scrollBefore && after.line === 600);
  ok(`(G-11) ジャンプ先が現在のヒットになる → activeMark=${after.activeMarks}`, after.activeMarks === 1);

  // 文書が短くスクロール不要なときは帯を出さない(本文の右端に重ならないように)。
  await openFile(page, "short test doc\nsecond test line", "short.md");
  await openSearch(page);
  await typeQuery(page, "test");
  const s4 = await snap(page);
  ok(`(G-12) スクロール不要な短い文書では印の帯を出さない → hidden=${s4.rulerHidden}, hit=${s4.hits}`,
    s4.rulerHidden === true && s4.hits === 2);
  await page.close();
}

// =========================================================================
// (H) 走査上限(SEARCH_RULER_MAX_MARKS = 1000件)で打ち切る
// =========================================================================
{
  const page = await newPage();
  const doc = [];
  for (let i = 0; i < 2500; i++) doc.push(`${i}: test line`);
  await openFile(page, doc.join("\n"));
  await openSearch(page);
  await typeQuery(page, "test");
  const total = await totalCount(page);
  const s = await snap(page);
  ok(`(H-1) 件数は2500件 → ${total}`, total === 2500);
  ok(`(H-2) 印は上限の1000件で打ち切られる → mark=${s.marks}`, s.marks === 1000);
  ok(`(H-3) 打ち切ったことが分かる印(data-truncated)が付く → ${s.truncated}`, s.truncated === "true");
  await page.close();
}

// =========================================================================
// (I) 10万行の文書での性能
//   このスイートが増やした処理(本文のハイライト=可視範囲のみ、スクロールバーの印=
//   デバウンス+チャンク分割の全文走査)が、10万行の文書で操作をもたつかせないことを実測する。
//   なお検索欄への入力では、これとは別に既存のsearch-ui.js側の件数表示更新
//   (editor.getSearchMatchInfo() = 文書全体を同期で走査する。10万行での実測は1回あたり
//   340〜360ms)が毎入力で走る。ここではその既存分と、今回追加した分を分けて測る。
// =========================================================================
{
  const page = await newPage(false);
  const doc = await page.evaluate(() => {
    const a = [];
    for (let i = 0; i < 100000; i++) a.push(i % 50 === 0 ? `${i}: これは test を含む行です。` : `${i}: ふつうの本文の行です。abc def`);
    return a.join("\n");
  });
  await page.evaluate((t) => window.__paneDebugEditor.setValue(t), doc);
  await page.waitForTimeout(1500);
  const lines = await page.evaluate(() => window.__paneDebugEditor.view.state.doc.lines);
  ok(`(I-0) 10万行の文書を読み込めている → ${lines}行`, lines === 100000);

  // 画面のカクつきを測るための、requestAnimationFrameの間隔の記録器。
  await page.evaluate(() => {
    window.__frames = [];
    let last = performance.now();
    const tick = () => { const t = performance.now(); window.__frames.push(t - last); last = t; requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
  });
  const worstFrame = async () => page.evaluate(() => {
    const f = window.__frames.slice(1); window.__frames = [];
    return f.length ? Math.round(Math.max(...f)) : 0;
  });

  // (I-1) 今回追加した処理だけのコスト。検索クエリを直接差し込み(件数表示の更新は
  // 経由しない)、装飾の再構築とスクロールバーの印の全文走査が終わるまでの間に
  // メインスレッドがどれだけ止まるかを見る。
  //   ・"t" は一致が非常に多い(上限1000件で早々に打ち切られる)ケース
  //   ・"存在しない文字列zzz" は一致が1件も無い(文書の最後まで走査する)最悪ケース
  const scanWorst = {};
  for (const q of ["t", "test", "存在しない文字列zzz"]) {
    await page.evaluate((q) => { window.__frames = []; window.__paneDebugEditor.setSearchQuery({ search: q }); }, q);
    await page.waitForTimeout(900);
    scanWorst[q] = await worstFrame();
  }
  console.log(`[性能] 10万行: 検索クエリ適用〜印の走査完了までの最大フレーム間隔 ${JSON.stringify(scanWorst)}`);
  ok(`(I-1) 一致が多い検索でもUIが固まらない("t": ${scanWorst["t"]}ms < 120ms)`, scanWorst["t"] < 120);
  ok(`(I-2) 一致が1件も無い検索(全文を最後まで走査)でもUIが固まらない(${scanWorst["存在しない文字列zzz"]}ms < 120ms)`,
    scanWorst["存在しない文字列zzz"] < 120);

  // (I-3) 実際の検索欄へ1文字ずつ打った場合(既存の件数表示の更新も含む、通しの体感)。
  await openSearch(page);
  await page.click("#search-query");
  await page.evaluate(() => { window.__frames = []; });
  const t0 = Date.now();
  for (const ch of "test") {
    await page.keyboard.type(ch);
    await page.waitForTimeout(120);
  }
  await page.waitForTimeout(900);
  const typeMs = Date.now() - t0;
  const worstType = await worstFrame();
  const total = await totalCount(page);
  const s = await snap(page);
  // 既存の件数表示更新(getSearchMatchInfo)だけの所要時間も測っておき、内訳を示す。
  const countMs = await page.evaluate(() => {
    const t = performance.now();
    window.__paneDebugEditor.getSearchMatchInfo();
    return Math.round(performance.now() - t);
  });
  console.log(`[性能] 10万行: 検索欄へ"test"を1文字ずつ入力 計${typeMs}ms、最大フレーム間隔=${worstType}ms ` +
    `(うち既存のgetSearchMatchInfo1回=${countMs}ms。今回追加した走査分は上の(I-1)(I-2)のとおり100ms未満)`);
  ok(`(I-3) 4文字の入力が待たされずに完了する(${typeMs}ms < 3000ms)`, typeMs < 3000);
  ok(`(I-4) 10万行でも件数と印が出る → 件数=${total}, 印=${s.marks}(上限1000)`, total === 2000 && s.marks === 1000);

  // (I-5) 検索したままスクロールしてももたつかない。
  await page.evaluate(() => { window.__frames = []; });
  const scrollStart = Date.now();
  for (let i = 1; i <= 12; i++) {
    await page.evaluate((n) => { window.__paneDebugEditor.view.scrollDOM.scrollTop = n * 4000; }, i);
    await page.waitForTimeout(80);
  }
  const scrollMs = Date.now() - scrollStart;
  const worstScroll = await worstFrame();
  console.log(`[性能] 10万行: 検索中のスクロール12回(計${scrollMs}ms) 最大フレーム間隔=${worstScroll}ms`);
  ok(`(I-5) 検索中のスクロールがもたつかない(最大フレーム間隔 ${worstScroll}ms < 200ms)`, worstScroll < 200);

  // (I-6) 検索したまま本文へ入力しても、1文字あたりの処理が重くならない。
  //       既存の .perf-typing.mjs と同じく view.dispatch 単体の所要時間を測る
  //       (1回ずつ evaluate を分ける。まとめて回すとレイアウトの繰り越しで値が跳ねる)。
  const typingMedian = async () => {
    await page.evaluate(() => {
      const view = window.__paneDebugEditor.view;
      view.dispatch({ selection: { anchor: Math.floor(view.state.doc.length / 2) } });
    });
    await page.waitForTimeout(200);
    const times = [];
    for (let i = 0; i < 15; i++) {
      times.push(await page.evaluate(() => {
        const view = window.__paneDebugEditor.view;
        const pos = view.state.selection.main.head;
        const t = performance.now();
        view.dispatch({ changes: { from: pos, insert: "x" }, selection: { anchor: pos + 1 } });
        return performance.now() - t;
      }));
      await page.waitForTimeout(30);
    }
    times.sort((a, b) => a - b);
    return Math.round(times[Math.floor(times.length / 2)] * 100) / 100;
  };
  await page.evaluate(() => window.__paneDebugEditor.setSearchQuery({ search: "test" }));
  await page.waitForTimeout(900);
  const withSearch = await typingMedian();
  await page.evaluate(() => window.__paneDebugEditor.setSearchQuery({ search: "" }));
  await page.waitForTimeout(900);
  const noSearch = await typingMedian();
  console.log(`[性能] 10万行: 本文へ1文字入力(view.dispatch)の中央値 検索あり=${withSearch}ms / 検索なし=${noSearch}ms`);
  ok(`(I-6) 検索中でも1文字入力が重くならない(検索あり ${withSearch}ms ≦ 検索なし ${noSearch}ms + 15ms)`,
    withSearch <= noSearch + 15);
  await page.close();
}

// =========================================================================
// (J) 通しでページエラー・コンソールエラーが出ていないこと
// =========================================================================
ok(`(J) ページエラー・コンソールエラーが0件 (${allErrors.length}件)`, allErrors.length === 0);
if (allErrors.length) console.log(allErrors.slice(0, 5).join("\n"));

console.log(`\n合計: OK ${okCount} / NG ${ngCount}`);
await browser.close();
process.exit(ngCount ? 1 : 0);
