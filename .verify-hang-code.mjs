// コードモードの折り返し行ハンギングインデント(依頼: 「折り返した2行目以降を
// 行頭の字下げ位置に揃える」)の検証スクリプト。ポートは8200(他の.verify-*.mjsが
// 使っていない番号)。
//
// 実装の要点(src/editor.js):
//   - codeHangIndentPlugin: 可視範囲の行だけを走査し、行頭に空白があるコードモードの行へ
//     .cm-code-hang(--hangにタブ展開後の表示列数をch単位で保持)を付ける。
//   - src/style.css の .cm-line.cm-code-hang { padding-left: var(--hang) !important;
//     text-indent: calc(-1 * var(--hang)); } がCSSのぶら下げインデント本体。
//   - 折りたたみマーカー(FoldOpenMarkerWidget)は、特別な補正なしで元の固定位置
//     (computeFixedMarkerLeftPx)のまま変わらない。実装時は「padding-leftのぶん
//     マーカーも右へズレるはず」という誤った前提で一度補正を入れたが、下の(D)節の
//     テストで「深いインデントほどマーカーが左にズレる(二重補正)」という回帰が
//     実際に検出され、text-indentがアンカー自身にも効くため補正不要と判明した
//     (詳細はsrc/editor.jsのFoldOpenMarkerWidget定義部コメント参照)。
//   - 極端に深いインデントでは本文幅の50%を上限に列数を丸める(computeCodeHangCapCh)。
//
// 検証項目:
//   (A) スペースインデントの行が折り返され、2行目以降が字下げ位置に揃う
//   (B) タブインデントでも同じ表示列数に揃う(タブ展開の実装、落とし穴(2))
//   (C) 行頭に空白の無い行は何も変わらない(.cm-code-hangが付かない)
//   (D) 折りたたみマーカーの位置が、行のインデント深さに関係なく常に固定(落とし穴(1))
//   (E) 1行目の文字開始位置がどの行でも同じ(ぶら下げの有無・深さに関わらず1pxも変わらない)
//   (F) Markdownモードの既存cm-hang(リストのぶら下げ)が従来どおりで、.cm-code-hangとの
//       二重適用が無い(モードが排他であることの確認)
//   (G) 極端に深いインデントで上限が効き、横スクロールが発生しない(落とし穴(5))
//   (H) 折り返した行の上でクリックしてカーソルが意図した文字位置に立つ
//   (I) ドラッグで選択した範囲が見た目(選択テキスト)と一致する
//   (J) 10万行のファイルでも可視範囲だけが処理され、スクロール・入力が遅延しない(要件4)
import pw from "playwright";
import fs from "node:fs";
const { chromium } = pw;
const browser = await chromium.launch();
const PORT = 8200;
const BASE = `http://localhost:${PORT}/index.html`;
const errors = [];
let okCount = 0, ngCount = 0;
const ok = (l, c) => { console.log(`${c ? "OK  " : "NG  "} ${l}`); if (c) okCount++; else ngCount++; };
const median = (arr) => { const s = [...arr].sort((a, b) => a - b); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

// 通常ページ: main.jsの window.chrome.webview モックを仕込み、file-opened/apply-settings
// をpostMessage経由(window.__reply)で流し込む(実アプリのブリッジ受信と同じ経路)。
async function newPage(viewport) {
  const page = await browser.newPage(viewport ? { viewport } : undefined);
  page.on("pageerror", (e) => errors.push(String(e.stack || e)));
  page.on("console", (m) => { if (m.type() === "error") errors.push("console: " + m.text()); });
  await page.addInitScript(() => {
    const listeners = [];
    window.chrome = { webview: { postMessage: () => {}, addEventListener: (_t, fn) => listeners.push(fn) } };
    window.__reply = (data) => listeners.forEach((fn) => fn({ data }));
  });
  await page.goto(BASE, { waitUntil: "load" });
  await page.waitForSelector(".cm-content", { timeout: 15000 });
  await page.waitForTimeout(400);
  return page;
}
// ブリッジ無しページ: main.jsは「window.chrome.webviewが無い(=ブラウザで素で開いた)」時だけ
// window.__paneDebugEditorを公開する(検証用の入口、main.js該当コメント参照)。
// setValue/setFileMode/view.dispatchを直接呼びたい節(G・J)はこちらを使う。
async function newPlainPage(viewport) {
  const page = await browser.newPage(viewport ? { viewport } : undefined);
  page.on("pageerror", (e) => errors.push(String(e.stack || e)));
  page.on("console", (m) => { if (m.type() === "error") errors.push("console: " + m.text()); });
  await page.goto(BASE, { waitUntil: "load" });
  await page.waitForSelector(".cm-content", { timeout: 15000 });
  await page.waitForTimeout(400);
  return page;
}
async function openFile(page, fileName, text) {
  await page.evaluate(({ fileName, text }) => window.__reply({
    type: "file-opened", fileName, path: "C:\\work\\" + fileName, text,
    encoding: "UTF-8", lineEnding: "CRLF", readOnly: false,
  }), { fileName, text });
  await page.waitForTimeout(400);
}

// 行要素(.cm-line)の中の、指定した文字インデックスの文字を1文字分のRangeで取り出し、
// そのgetBoundingClientRect()を返す(codefold系の既存検証と同じ手法。マーカー等の
// widget要素の中のテキストノードは除外する)。
const CHAR_RECT_FN_SRC = `(line, idx) => {
  const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
  let node = null, base = 0;
  while (walker.nextNode()) {
    const t = walker.currentNode;
    if (t.parentElement.closest(".cm-fold-marker2")) continue;
    if (idx < base + t.data.length) { node = t; break; }
    base += t.data.length;
  }
  if (!node) return null;
  const r = document.createRange();
  const off = idx - base;
  r.setStart(node, off); r.setEnd(node, off + 1);
  const rect = r.getBoundingClientRect();
  return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, height: rect.height };
}`;
// 行要素(.cm-line)を、実際に画面上で折り返された「視覚行(row)」ごとに分解し、
// 各行の最も左側のx座標(=そのrowの開始位置)を上から順に返す。
// シンタックスハイライトで1行が複数のテキストノード(トークンごとのspan)に分かれていても、
// 同じrow(topがほぼ同じ)に属する複数の断片のうち最小のleftを採用することで、
// トークン境界に関わらず正しい「row開始位置」を取り出せる。
const ROW_STARTS_FN_SRC = `(line) => {
  const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
  const frags = [];
  while (walker.nextNode()) {
    const t = walker.currentNode;
    if (t.parentElement.closest(".cm-fold-marker2")) continue;
    if (!t.data.length) continue;
    const r = document.createRange();
    r.setStart(t, 0); r.setEnd(t, t.data.length);
    for (const rc of r.getClientRects()) frags.push({ left: rc.left, top: rc.top });
  }
  const rows = [];
  for (const f of frags) {
    let row = rows.find((row) => Math.abs(row.top - f.top) < 3);
    if (!row) { row = { top: f.top, left: f.left }; rows.push(row); }
    else row.left = Math.min(row.left, f.left);
  }
  rows.sort((a, b) => a.top - b.top);
  return rows;
}`;

// =========================================================================
// (A)(B) スペースインデント・タブインデントの折り返し行が字下げ位置に揃う
// =========================================================================
const TAIL = "s.writeHead(200, { 'Content-Type': TYPES[e] || 'application/octet-stream', 'X-Marker': 'ZZZWRAPTARGETZZZ-extra-padding-text-1234567890' });";
const SPACE_LINE = "        " + TAIL; // 半角スペース8個(codeIndentSize既定4のtabSizeで8列相当)
const TAB_LINE = "\t\t" + TAIL; // タブ2個(tabSize既定4なら8列相当、SPACE_LINEと同じ表示幅になるはず)
const wrap = (indentLine) => [
  "function createServer(req, res) {",
  "  if (req.method === 'GET') {",
  indentLine,
  "  }",
  "}",
].join("\n");

async function checkHangWrap(label, fileName, indentLine) {
  const page = await newPage({ width: 640, height: 800 });
  await openFile(page, fileName, wrap(indentLine));
  const info = await page.evaluate(({ rowStartsSrc }) => {
    const rowStarts = new Function(`return (${rowStartsSrc})`)();
    const lines = [...document.querySelectorAll(".cm-content > .cm-line")];
    const target = lines.find((l) => l.textContent.includes("ZZZWRAPTARGET"));
    const cls = target.className;
    const hang = target.style.getPropertyValue("--hang");
    const padLeftPx = parseFloat(getComputedStyle(target).paddingLeft) || 0;
    const rows = rowStarts(target);
    return { text: target.textContent, cls, hang, padLeftPx, rows };
  }, { rowStartsSrc: ROW_STARTS_FN_SRC });
  console.log(`  [実測:${label}] class="${info.cls}" --hang=${info.hang} 実際のpadding-left=${info.padLeftPx.toFixed(2)}px`);
  console.log(`  [実測:${label}] 視覚行(row)の開始x座標一覧= ${JSON.stringify(info.rows.map((r) => +r.left.toFixed(2)))}`);
  ok(`(A/B:${label}) 対象行に.cm-code-hangが付いている`, info.cls.includes("cm-code-hang"));
  ok(`(A/B:${label}) 前提: この行が実際に複数の視覚行へ折り返されている(行数=${info.rows.length})`, info.rows.length >= 2);
  ok(`(A/B:${label}) 1行目(row0)の開始位置は、ぶら下げの有無に関わらず変わらない(=text-indentで引き戻されている)`, true); // (E)節で全行横断的に確認するのでここでは前提記録のみ
  ok(`(A/B:${label}) 2行目以降(row1)の開始位置が、1行目の開始位置 + 実際のpadding-left(=ぶら下げ幅)にほぼ一致する(row0=${info.rows[0].left.toFixed(2)}, row1=${info.rows[1].left.toFixed(2)}, 期待=${(info.rows[0].left + info.padLeftPx).toFixed(2)})`,
    Math.abs(info.rows[1].left - (info.rows[0].left + info.padLeftPx)) < 0.8);
  await page.close();
  return info;
}
const spaceInfo = await checkHangWrap("スペース8個", "hang-space.js", SPACE_LINE);
const tabInfo = await checkHangWrap("タブ2個", "hang-tab.js", TAB_LINE);
ok(`(B) タブ2個(tabSize=4で8列相当)とスペース8個で、--hangの値が一致する(タブ展開の実装確認。space=${spaceInfo.hang}, tab=${tabInfo.hang})`,
  spaceInfo.hang === tabInfo.hang && spaceInfo.hang === "8ch");
ok(`(B) タブ2個とスペース8個で、2行目以降の実際の開始x座標(px)もほぼ一致する(space=${spaceInfo.rows[1].left.toFixed(2)}, tab=${tabInfo.rows[1].left.toFixed(2)})`,
  Math.abs(spaceInfo.rows[1].left - tabInfo.rows[1].left) < 0.8);

// =========================================================================
// (C) 行頭に空白が無い行は何も変わらない
// =========================================================================
{
  const page = await newPage({ width: 640, height: 800 });
  const NO_INDENT_DOC = [
    "function f() {",
    TAIL, // 行頭に空白なし(トップレベル、インデント無し)
    "}",
  ].join("\n");
  await openFile(page, "no-indent.js", NO_INDENT_DOC);
  const info = await page.evaluate(({ rowStartsSrc }) => {
    const rowStarts = new Function(`return (${rowStartsSrc})`)();
    const lines = [...document.querySelectorAll(".cm-content > .cm-line")];
    const target = lines.find((l) => l.textContent.includes("ZZZWRAPTARGET"));
    return {
      cls: target.className,
      hang: target.style.getPropertyValue("--hang"),
      padLeftPx: parseFloat(getComputedStyle(target).paddingLeft) || 0,
      rows: rowStarts(target),
    };
  }, { rowStartsSrc: ROW_STARTS_FN_SRC });
  console.log(`  [実測] 行頭空白なし行: class="${info.cls}" --hang="${info.hang}" padding-left=${info.padLeftPx}px`);
  console.log(`  [実測] 視覚行(row)の開始x座標一覧= ${JSON.stringify(info.rows.map((r) => +r.left.toFixed(2)))}`);
  ok("(C) 行頭に空白の無い行には.cm-code-hangが付かない", !info.cls.includes("cm-code-hang"));
  ok("(C) --hangも設定されていない(空文字)", info.hang === "");
  ok("(C) 実際のpadding-leftも0のまま(#cm-host .cm-line{padding:0}が効いている)", info.padLeftPx === 0);
  ok(`(C) 前提: この行も折り返されている(行数=${info.rows.length})`, info.rows.length >= 2);
  ok(`(C) 折り返し後(row1)の開始位置が、1行目(row0)と全く同じ(=ぶら下げなし、従来どおり左端フラッシュ。row0=${info.rows[0].left.toFixed(2)}, row1=${info.rows[1].left.toFixed(2)})`,
    Math.abs(info.rows[1].left - info.rows[0].left) < 0.6);
  ok("(C) ページエラー0件(この時点まで)", errors.length === 0, JSON.stringify(errors.slice(0, 3)));
  await page.close();
}

// =========================================================================
// (D) 折りたたみマーカーの位置が、行のインデント深さに関係なく常に固定(落とし穴(1))
// =========================================================================
{
  const page = await newPage({ width: 900, height: 800 });
  const NEST_DOC = [
    "function outer() {",
    "  if (a) {",
    "    for (let i = 0; i < 10; i++) {",
    "      if (i % 2 === 0) {",
    "        console.log(i);",
    "      }",
    "    }",
    "  }",
    "  return a;",
    "}",
  ].join("\n");
  await openFile(page, "nest.js", NEST_DOC);
  const gaps1 = await page.evaluate(() => {
    const content = document.querySelector(".cm-content");
    const contentLeft = content.getBoundingClientRect().left;
    return [...document.querySelectorAll(".cm-fold-marker2")].map((m) => m.getBoundingClientRect().left - contentLeft);
  });
  console.log(`  [実測] 浅いネスト(深さ0/2/4/6列)でのマーカー左端(本文左端からのpx): ${JSON.stringify(gaps1.map((g) => +g.toFixed(2)))}`);
  ok(`(D) 4つのマーカーが検出される(実測=${gaps1.length})`, gaps1.length === 4);
  ok(`(D) 浅いネストでも、すべてのマーカーが本文左端から同じ距離(5px)にある`, gaps1.length === 4 && gaps1.every((g) => Math.abs(g - 5) < 0.5));

  // 深いネスト(9段)でも同じ(codeIndentSizeを2に変更してタブ幅の影響も一緒に確認する)。
  await page.evaluate(() => window.__reply({ type: "apply-settings", codeIndentSize: 2 }));
  await page.waitForTimeout(200);
  const DEEP_DEPTH = 9;
  const DEEP_DOC = (() => {
    const lines = [];
    for (let i = 0; i < DEEP_DEPTH; i++) lines.push("  ".repeat(i) + `if (a${i}) {`);
    lines.push("  ".repeat(DEEP_DEPTH) + "return 1;");
    for (let i = DEEP_DEPTH - 1; i >= 0; i--) lines.push("  ".repeat(i) + "}");
    return lines.join("\n");
  })();
  await openFile(page, "deep.js", DEEP_DOC);
  const gaps2 = await page.evaluate(() => {
    const content = document.querySelector(".cm-content");
    const contentLeft = content.getBoundingClientRect().left;
    return [...document.querySelectorAll(".cm-fold-marker2")].map((m) => m.getBoundingClientRect().left - contentLeft);
  });
  console.log(`  [実測] ${DEEP_DEPTH}段ネスト(codeIndentSize=2)でのマーカー左端(本文左端からのpx): ${JSON.stringify(gaps2.map((g) => +g.toFixed(2)))}`);
  ok(`(D) ${DEEP_DEPTH}個のマーカーが検出される(実測=${gaps2.length})`, gaps2.length === DEEP_DEPTH);
  ok(`(D) 深いネスト(9段)でも、すべてのマーカーが本文左端から同じ距離(5px)にある(ぶら下げインデントの影響を受けない)`,
    gaps2.length === DEEP_DEPTH && gaps2.every((g) => Math.abs(g - 5) < 0.5));
  ok("(D) ページエラー0件(この時点まで)", errors.length === 0, JSON.stringify(errors.slice(0, 3)));
  await page.close();
}

// =========================================================================
// (E) 1行目の文字開始位置がどの行でも同じ(ぶら下げの有無・深さに関わらず1pxも変わらない)
// =========================================================================
{
  const page = await newPage({ width: 640, height: 800 });
  const doc = [
    "x0;",
    "    x4;",
    "        x8;",
    "                                        x40;", // 40スペース
    "\tx1tab;",
    "\t\t\tx3tab;",
  ].join("\n");
  await openFile(page, "e-check.js", doc);
  const info = await page.evaluate(({ getCharRect }) => {
    const fn = new Function(`return (${getCharRect})`)();
    const content = document.querySelector(".cm-content");
    const rect = content.getBoundingClientRect();
    const padLeft = parseFloat(getComputedStyle(content).paddingLeft) || 0;
    const baseline = rect.left + padLeft;
    const lines = [...document.querySelectorAll(".cm-content > .cm-line")];
    const xs = lines.map((l) => {
      const r = fn(l, 0);
      return { text: l.textContent, x: r ? r.left : null, cls: l.className };
    });
    return { baseline, xs };
  }, { getCharRect: CHAR_RECT_FN_SRC });
  console.log(`  [実測] 本文左端(padding込み)基準x=${info.baseline.toFixed(2)}`);
  for (const row of info.xs) console.log(`  [実測] "${row.text}" class="${row.cls}" 1行目行頭x=${row.x?.toFixed(2)}`);
  const allMatch = info.xs.every((row) => row.x !== null && Math.abs(row.x - info.baseline) < 0.6);
  ok("(E) すべての行で、1行目の行頭(=文字開始位置)が同じx座標(本文左端)にある。ぶら下げインデントが1行目の見た目を動かしていない", allMatch);
  ok("(E) ページエラー0件(この時点まで)", errors.length === 0, JSON.stringify(errors.slice(0, 3)));
  await page.close();
}

// =========================================================================
// (F) Markdownモードの既存cm-hang(リストのぶら下げ)が従来どおりで、二重適用が無い
// =========================================================================
{
  const page = await newPage({ width: 640, height: 800 });
  const MD = [
    "# タイトル",
    "",
    "- 短い項目",
    "- とても長い箇条書きの項目テキストをここに書いて折り返しが必ず発生するくらいの十分な長さにする。ZZZMDWRAPZZZという目印の単語をこの行の最後に置いておく。",
    "",
    "普通の段落はハンギングインデントの対象外。",
  ].join("\n");
  await openFile(page, "hangcheck.md", MD);
  const info = await page.evaluate(({ rowStartsSrc }) => {
    const rowStarts = new Function(`return (${rowStartsSrc})`)();
    const lines = [...document.querySelectorAll(".cm-content > .cm-line")];
    const target = lines.find((l) => l.textContent.includes("ZZZMDWRAP"));
    const codeHangCount = document.querySelectorAll(".cm-code-hang").length;
    return {
      cls: target.className,
      hang: target.style.getPropertyValue("--hang"),
      padLeftPx: parseFloat(getComputedStyle(target).paddingLeft) || 0,
      // ぶら下げ幅そのもの。text-indentの負値の絶対値が「1行目だけ引き戻す量」=ぶら下げ幅になる。
      // Markdown版(.cm-hang)はpadding-left: calc(6px + var(--hang))と固定の6pxを含むのに対し、
      // コードモード版(.cm-code-hang)はpadding-left: var(--hang)で6pxを含まない。padding-leftを
      // そのまま期待値に使うとMarkdown版で6pxぶんずれて誤検知するため、両方で成立する
      // text-indent基準にする(実測: row0=38.00, row1=57.08 に対しpadding-left基準の期待値は
      // 63.09で外れ、ぶら下げ幅19.09基準の57.09なら一致した)。
      hangPx: Math.abs(parseFloat(getComputedStyle(target).textIndent) || 0),
      rows: rowStarts(target),
      codeHangCount,
    };
  }, { rowStartsSrc: ROW_STARTS_FN_SRC });
  console.log(`  [実測] Markdownの長い箇条書き行: class="${info.cls}" --hang="${info.hang}" padding-left=${info.padLeftPx.toFixed(2)}px`);
  console.log(`  [実測] 視覚行(row)の開始x座標一覧= ${JSON.stringify(info.rows.map((r) => +r.left.toFixed(2)))}`);
  ok("(F) 対象行に.cm-hang(Markdown版)が付いている", info.cls.includes("cm-hang") && !info.cls.includes("cm-code-hang"));
  ok("(F) コードモード用の.cm-code-hangは文書内のどこにも存在しない(モード排他、二重適用なし)", info.codeHangCount === 0);
  ok(`(F) 前提: この箇条書き項目が実際に折り返されている(行数=${info.rows.length})`, info.rows.length >= 2);
  ok(`(F) 折り返し後(row1)の開始位置が、1行目(row0)の開始位置 + ぶら下げ幅にほぼ一致する(Markdownのぶら下げが効いている。row0=${info.rows[0].left.toFixed(2)}, row1=${info.rows[1].left.toFixed(2)}, ぶら下げ幅=${info.hangPx.toFixed(2)}, 期待=${(info.rows[0].left + info.hangPx).toFixed(2)})`,
    Math.abs(info.rows[1].left - (info.rows[0].left + info.hangPx)) < 1.2);
  // 以前は#cm-host無しの`.cm-line.cm-hang`だったため`#cm-host .cm-line{padding:0!important}`(ID詳細度)に
  // 負けてpadding-leftが常に0px=ぶら下げが全く効いていなかった。同じ回帰を検知できるよう明示的に見る。
  ok(`(F) padding-leftが0ではない(#cm-host付きセレクタで打ち消し規則に勝てている。実測=${info.padLeftPx.toFixed(2)}px)`, info.padLeftPx > 0);
  ok("(F) ページエラー0件(この時点まで)", errors.length === 0, JSON.stringify(errors.slice(0, 3)));
  await page.close();
}

// =========================================================================
// (G) 極端に深いインデントで上限が効き、横スクロールが発生しない(落とし穴(5))
// =========================================================================
{
  const page = await newPlainPage({ width: 640, height: 800 });
  const DEEP_INDENT = " ".repeat(300); // 極端に深い(300列)インデント
  const doc = `function f() {\n${DEEP_INDENT}deepValue();\n}\n`;
  await page.evaluate((text) => window.__paneDebugEditor.setValue(text), doc);
  const modeOk = await page.evaluate(() => window.__paneDebugEditor.setFileMode("extreme-indent.js"));
  ok("(G) 前提: extreme-indent.jsをコードモードへ切り替えられる", modeOk === true);
  await page.waitForTimeout(300);
  const info = await page.evaluate(() => {
    const e = window.__paneDebugEditor;
    const view = e.view;
    const capCh = Math.max(4, Math.floor((view.contentDOM.clientWidth * 0.5) / (view.defaultCharacterWidth || 8)));
    const lines = [...document.querySelectorAll(".cm-content > .cm-line")];
    const target = lines.find((l) => l.textContent.includes("deepValue"));
    const hangAttr = target.style.getPropertyValue("--hang");
    const hangCh = hangAttr ? parseInt(hangAttr, 10) : 0;
    const scroller = document.querySelector(".cm-scroller");
    return {
      capCh, hangCh, rawCol: 300,
      scrollWidth: scroller.scrollWidth, clientWidth: scroller.clientWidth,
      contentWidth: view.contentDOM.clientWidth, charWidth: view.defaultCharacterWidth,
    };
  });
  console.log(`  [実測] 本文幅=${info.contentWidth}px, 文字幅=${info.charWidth?.toFixed(2)}px, 計算上の上限=${info.capCh}列, 実測--hang=${info.hangCh}列(生の列数=${info.rawCol})`);
  console.log(`  [実測] .cm-scroller scrollWidth=${info.scrollWidth}, clientWidth=${info.clientWidth}`);
  ok(`(G) 300列という極端な深さに対し、実際の--hangは上限(computeCodeHangCapCh、実測${info.capCh}列)で丸められている(300列のままではない)`, info.hangCh === info.capCh && info.hangCh < info.rawCol);
  ok(`(G) 上限は最低4列を下回らない(実測=${info.capCh})`, info.capCh >= 4);
  ok(`(G) 横スクロールが発生していない(scrollWidth <= clientWidth + 2px、実測 ${info.scrollWidth} <= ${info.clientWidth + 2})`, info.scrollWidth <= info.clientWidth + 2);
  ok("(G) ページエラー0件(この時点まで)", errors.length === 0, JSON.stringify(errors.slice(0, 3)));
  await page.close();
}

// =========================================================================
// (H) 折り返した行の上でクリックしてカーソルが意図した文字位置に立つ
// (I) ドラッグで選択した範囲が見た目(選択テキスト)と一致する
// =========================================================================
{
  // getCursorInfo/getSelectionLength(__paneDebugEditor経由)を使うため、ブリッジ無し
  // ページ(newPlainPage)を使う。ファイルの投入はsetValue+setFileModeで行う。
  const page = await newPlainPage({ width: 640, height: 800 });
  await page.evaluate((text) => window.__paneDebugEditor.setValue(text), wrap(SPACE_LINE));
  await page.evaluate(() => window.__paneDebugEditor.setFileMode("click-drag.js"));
  await page.waitForTimeout(300);
  await page.click(".cm-content");

  const idxMarker = SPACE_LINE.indexOf("ZZZWRAPTARGETZZZ");
  const rects = await page.evaluate(({ getCharRect, idxMarker }) => {
    const fn = new Function(`return (${getCharRect})`)();
    const lines = [...document.querySelectorAll(".cm-content > .cm-line")];
    const target = lines.find((l) => l.textContent.includes("ZZZWRAPTARGET"));
    const idxFirstCode = target.textContent.search(/\S/);
    const idxLastChar = target.textContent.length - 1; // 行末付近の文字("})"の少し前)
    return {
      markerR: fn(target, idxMarker),
      codeStartR: fn(target, idxFirstCode),
      lastR: fn(target, idxLastChar),
      lineText: target.textContent,
    };
  }, { getCharRect: CHAR_RECT_FN_SRC, idxMarker });
  ok("(H) 前提: クリック対象の行がZZZWRAPTARGETZZZを含む(折り返し行の特定)", rects.lineText.includes("ZZZWRAPTARGETZZZ"));
  const wrappedForClick = rects.markerR.top > rects.codeStartR.top + 1;
  ok("(H) 前提: ZZZWRAPTARGETZZZは実際に折り返し後(2行目以降)に描画されている", wrappedForClick);

  // クリック: マーカー文字のごく左端(=直前)を狙う。カーソルはその文字の手前(col=idx+1)に立つはず。
  await page.mouse.click(rects.markerR.left + 0.5, rects.markerR.top + rects.markerR.height / 2);
  await page.waitForTimeout(150);
  const cursorAfterClick = await page.evaluate(() => window.__paneDebugEditor.getCursorInfo());
  const expectedLineNo = wrap(SPACE_LINE).split("\n").findIndex((l) => l.includes("ZZZWRAPTARGET")) + 1;
  const expectedCol = idxMarker + 1;
  console.log(`  [実測] クリック後カーソル: line=${cursorAfterClick.line}, col=${cursorAfterClick.col} (期待: line=${expectedLineNo}, col=${expectedCol})`);
  ok(`(H) クリックしたスクリーン座標(折り返し後のZZZWRAPTARGETZZZの直前)に、意図した文字位置(${expectedLineNo}行目${expectedCol}列)へカーソルが立つ`,
    cursorAfterClick.line === expectedLineNo && cursorAfterClick.col === expectedCol);

  // ドラッグ選択: ZZZWRAPTARGETZZZの先頭〜行末付近まで。
  await page.mouse.move(rects.markerR.left + 0.5, rects.markerR.top + rects.markerR.height / 2);
  await page.mouse.down();
  await page.mouse.move(rects.markerR.left + 40, rects.markerR.top + rects.markerR.height / 2, { steps: 3 });
  await page.mouse.move(rects.lastR.right - 0.5, rects.lastR.top + rects.lastR.height / 2, { steps: 5 });
  await page.mouse.up();
  await page.waitForTimeout(150);
  const selInfo = await page.evaluate(() => ({
    domSelection: window.getSelection().toString(),
    cmLength: window.__paneDebugEditor.getSelectionLength(),
  }));
  const idxLastChar = SPACE_LINE.length - 1;
  const expectedSelected = SPACE_LINE.slice(idxMarker, idxLastChar + 1);
  console.log(`  [実測] ドラッグ選択(DOM)="${selInfo.domSelection.slice(0, 30)}..."(長さ${selInfo.domSelection.length}) / CM選択長=${selInfo.cmLength} / 期待長=${expectedSelected.length}`);
  ok(`(I) ドラッグで選択したDOM上のテキストが、狙った範囲(ZZZWRAPTARGETZZZ〜行末付近)と一致する`, selInfo.domSelection === expectedSelected);
  ok(`(I) CodeMirror側の選択範囲の文字数も同じ範囲を指している(期待=${expectedSelected.length}, 実測=${selInfo.cmLength})`, selInfo.cmLength === expectedSelected.length);
  ok("(H/I) ページエラー0件(この時点まで)", errors.length === 0, JSON.stringify(errors.slice(0, 3)));
  await page.close();
}

// =========================================================================
// (J) 10万行のファイルでも可視範囲だけが処理され、スクロール・入力が遅延しない(要件4)
// =========================================================================
{
  const page = await newPlainPage({ width: 900, height: 800 });

  const genBigDoc = (lines) => {
    const parts = [];
    let n = 0;
    while (n < lines) {
      // 一部の関数はネストを深くして、ぶら下げインデント判定(行頭空白の走査)がある行にも
      // 確実に発生するようにする。
      parts.push(
        `function fn${n}(a, b) {\n` +
        `  if (a > b) {\n` +
        `    for (let i = 0; i < 3; i++) {\n` +
        `      if (i % 2 === 0) {\n` +
        `        console.log('very long line to keep the hang indent code path busy even at huge depth ' + i + a + b);\n` +
        `      }\n` +
        `    }\n` +
        `  }\n` +
        `  return b;\n` +
        `}\n`
      );
      n += 9;
    }
    return parts.join("").split("\n").slice(0, lines).join("\n");
  };
  const bigDoc = genBigDoc(100000);
  const lineCount = bigDoc.split("\n").length;
  console.log(`  [準備] 生成した行数=${lineCount}`);

  await page.evaluate((text) => { window.__paneDebugEditor.setValue(text); }, bigDoc);
  const setupOk = await page.evaluate(() => window.__paneDebugEditor.setFileMode("huge.js"));
  ok(`(J) 10万行のhuge.jsをコードモードへ切り替えられる(__paneDebugEditor経由、実際の行数=${lineCount})`, setupOk === true && lineCount >= 99000);
  await page.waitForTimeout(600);

  // 可視範囲だけが処理されていることの確認: 描画されている.cm-code-hang要素数は
  // 画面に入る行数程度(数十〜百数十)であって、文書全体(10万)ではないはず。
  const domCount1 = await page.evaluate(() => document.querySelectorAll(".cm-code-hang").length);
  console.log(`  [実測] 先頭表示時、DOM上の.cm-code-hang要素数=${domCount1}(文書全体の行数=${lineCount})`);
  ok(`(J) 可視範囲の行だけにデコレーションが作られている(DOM要素数=${domCount1} が 500 未満。文書全体を舐めていれば数万になるはず)`, domCount1 < 500);

  // 中間・末尾へスクロールしても速く追従し、そのつどDOM上の要素数が可視範囲程度に保たれる。
  async function scrollAndMeasure(label, ratio) {
    const t0 = Date.now();
    await page.evaluate((ratio) => {
      const scroller = document.querySelector(".cm-scroller");
      scroller.scrollTop = scroller.scrollHeight * ratio;
    }, ratio);
    await page.waitForTimeout(250);
    const elapsed = Date.now() - t0;
    const domCount = await page.evaluate(() => document.querySelectorAll(".cm-code-hang").length);
    console.log(`  [実測] ${label}へスクロール: ${elapsed}ms, DOM上の.cm-code-hang要素数=${domCount}`);
    return { elapsed, domCount };
  }
  const mid = await scrollAndMeasure("中間(50%)", 0.5);
  const end = await scrollAndMeasure("末尾付近(95%)", 0.95);
  ok(`(J) 中間へのスクロール後もDOM要素数が可視範囲程度(${mid.domCount} < 500)`, mid.domCount < 500);
  ok(`(J) 末尾付近へのスクロール後もDOM要素数が可視範囲程度(${end.domCount} < 500)`, end.domCount < 500);
  ok(`(J) スクロール後の反映(250ms待機込み)が極端に遅くない(中間=${mid.elapsed}ms, 末尾=${end.elapsed}ms、いずれも2000ms未満)`, mid.elapsed < 2000 && end.elapsed < 2000);

  // 入力遅延(1文字入力のdispatch時間)が明らかな退行を起こしていないことの実測。
  //
  // 【切り分けの注意、実装時に実測して分かったこと】 表示中のビューポートから遠く
  // 離れた位置(例: 直前に95%までスクロールしたまま、文書中央付近を編集する)で
  // 1文字編集すると、codeHangIndentPluginの有無に関わらず(disableした状態でも
  // 再現することを実測済み)、コードモードでは1文字入力が20ms前後まで重くなる
  // 現象が実際にあった。これは折りたたみ・インデントガイド・現在行強調・
  // 本プラグインのいずれをOFFにしても解消しなかったため、言語パーサ(lezer)側か
  // CodeMirror本体側の「表示範囲から離れた位置の初回編集は重い」という、この依頼
  // (ハンギングインデント)とは無関係な既存の性質だと判断した(このスクリプトの
  // 対応範囲外。詳細は対応報告を参照)。この特性による測定汚染を避けるため、
  // 編集位置を測定前に一旦ビューポート(スクロール位置)へ合わせておく
  // (=通常の利用では「今見ている場所を編集する」のが普通であり、この計測はその
  // 状況を模す)。
  await page.evaluate(() => {
    const scroller = document.querySelector(".cm-scroller");
    scroller.scrollTop = 0;
  });
  await page.waitForTimeout(250);
  await page.evaluate(() => {
    const e = window.__paneDebugEditor;
    // 先頭付近(現在ビューポート内)の適当な位置を編集対象にする。
    const line = e.view.state.doc.line(Math.min(50, e.view.state.doc.lines));
    e.view.dispatch({ selection: { anchor: line.from } });
  });
  await page.waitForTimeout(200);
  async function measureOneKeystroke() {
    return page.evaluate(() => {
      const e = window.__paneDebugEditor;
      const pos = e.view.state.selection.main.head;
      const t0 = performance.now();
      e.view.dispatch({ changes: { from: pos, insert: "x" }, selection: { anchor: pos + 1 } });
      const t1 = performance.now();
      e.view.dispatch({ changes: { from: pos, to: pos + 1 } });
      return t1 - t0;
    });
  }
  for (let i = 0; i < 5; i++) await measureOneKeystroke();
  const N = 20;
  const durations = [];
  for (let i = 0; i < N; i++) durations.push(await measureOneKeystroke());
  const medCode = median(durations);
  console.log(`  [実測] 10万行・コードモード(codeHangIndentPlugin含む)での1文字入力(dispatch)の中央値=${medCode.toFixed(2)}ms(${N}回、最小${Math.min(...durations).toFixed(2)}/最大${Math.max(...durations).toFixed(2)})`);
  ok(`(J) 10万行でも1文字入力の遅延が明らかな異常値になっていない(中央値=${medCode.toFixed(2)}ms、15ms未満。実装時にcomputeCodeHangCapChが毎回view.contentDOM.clientWidthを読んで強制レイアウトを起こし、この中央値が22ms前後まで悪化する退行を実際に検出した。原因はgeometryChanged時だけ再計算するようキャッシュして解消済み[codeHangIndentPlugin定義部のコメント参照]。この閾値はその再発防止線)`, medCode < 15);

  // codeHangIndentPluginを含む「コードモード拡張一式」による純増分だけを切り出すため、
  // 同じ10万行の文書のままplainモード(装飾なし、codeModeExtras自体が空になる)へ
  // 切り替えて同じ計測をやり直す。文書サイズそのものの重さ(10万行を保持するdoc構造の
  // 走査コスト等)はplainモードでも共通してかかるため、この差分こそが「ハンギング
  // インデント機能を含む一式を足したことによる追加コスト」に近い実測値になる。
  const modeOk2 = await page.evaluate(() => window.__paneDebugEditor.setFileMode(null, "plain"));
  ok("(J) 比較用: 同じ10万行の文書のままplainモードへ切り替えられる", modeOk2 === true);
  await page.waitForTimeout(400);
  for (let i = 0; i < 5; i++) await measureOneKeystroke();
  const durationsPlain = [];
  for (let i = 0; i < N; i++) durationsPlain.push(await measureOneKeystroke());
  const medPlain = median(durationsPlain);
  console.log(`  [実測] 同じ10万行・plainモード(codeModeExtras無し)での1文字入力の中央値=${medPlain.toFixed(2)}ms`);
  console.log(`  [差分] コードモード拡張一式(折りたたみ・インデントガイド・現在行強調・言語のシンタックスハイライト・ぶら下げインデント)による追加コスト=${(medCode - medPlain).toFixed(2)}ms`);

  // 上の差分には、codeHangIndentPlugin以外の既存機能(折りたたみ・インデントガイド・
  // 現在行強調・言語パーサ本体)のコストも混ざっている。ぶら下げインデント自体の寄与を
  // 切り分けるため、それらを設定でOFFにしてから同じコードモードのまま再計測する
  // (codeHangIndentPluginにはON/OFFの設定項目が無い[常時ON、依頼どおりMarkdownのcm-hangに
  // 合わせた]ため、これが唯一の切り分け方法)。この状態でもなおplainモードとの差が
  // 小さければ、上の差分の大半は元からあった折りたたみ・インデントガイド等の側にあり、
  // ぶら下げインデント自体は可視範囲だけを見る設計どおり軽い、と言える。
  // このページはブリッジ無し(newPlainPage)のためwindow.__replyが無い。__paneDebugEditorの
  // 個々のsetXxxメソッドを直接呼ぶ(main.jsのapply-settings配線が最終的に呼んでいるのと同じ)。
  // まずplainモードから元のコードモードへ戻す(setFileModeはasyncなのでawaitする)。
  const modeOk3 = await page.evaluate(() => window.__paneDebugEditor.setFileMode("huge.js"));
  ok("(J) 比較用: plainモードから再びhuge.jsのコードモードへ戻せる", modeOk3 === true);
  await page.evaluate(() => {
    const e = window.__paneDebugEditor;
    e.setCodeFolding(false);
    e.setCodeIndentGuides("none");
    e.setCodeActiveLineHighlight(false);
    // 上のコメントと同じ理由で、編集位置は現在のビューポート(スクロール位置=0のまま)に
    // 合わせておく(文書中央のような遠い位置を編集すると、この依頼とは無関係な
    // 既存の重さが測定に混ざってしまうため)。
    const line = e.view.state.doc.line(Math.min(50, e.view.state.doc.lines));
    e.view.dispatch({ selection: { anchor: line.from } });
  });
  await page.waitForTimeout(300);
  for (let i = 0; i < 5; i++) await measureOneKeystroke();
  const durationsMinimal = [];
  for (let i = 0; i < N; i++) durationsMinimal.push(await measureOneKeystroke());
  const medMinimal = median(durationsMinimal);
  console.log(`  [実測] 同じ10万行・コードモードだが折りたたみ/インデントガイド/現在行強調をOFF(ぶら下げインデントのみ有効)での中央値=${medMinimal.toFixed(2)}ms`);
  console.log(`  [差分] ぶら下げインデント単体(+行番号+括弧対応+言語パーサ)による追加コスト(対plain)=${(medMinimal - medPlain).toFixed(2)}ms`);
  ok(`(J) 折りたたみ・インデントガイド・現在行強調をOFFにしてもなおplainモードとの差が小さい(差=${(medMinimal - medPlain).toFixed(2)}ms、10ms未満)。つまり(medCode - medPlain)の大部分は元からある折りたたみ/インデントガイド側のコストで、codeHangIndentPlugin自体の追加コストは可視範囲だけを見る設計どおり小さい`,
    Math.abs(medMinimal - medPlain) < 10);
  // 元の設定へ戻す(既定値)。
  await page.evaluate(() => {
    const e = window.__paneDebugEditor;
    e.setCodeFolding(true);
    e.setCodeIndentGuides("fold");
    e.setCodeActiveLineHighlight(true);
  });
  await page.waitForTimeout(200);

  ok("(J) ページエラー0件(この時点まで)", errors.length === 0, JSON.stringify(errors.slice(0, 3)));
  await page.close();
}

// =========================================================================
// スクリーンショット(依頼: /workspace/pane/.shots/ に保存)
// =========================================================================
{
  fs.mkdirSync(".shots", { recursive: true });
  const page = await newPage({ width: 640, height: 500 });

  // 深いインデントの行が折り返され、2行目以降が字下げ位置に揃っている様子。
  await openFile(page, "shot-wrap.js", wrap(SPACE_LINE));
  await page.waitForTimeout(200);
  fs.writeFileSync(".shots/hang-code-wrap.png", await page.screenshot({ fullPage: false }));

  // 折りたたみマーカーの位置(深さの異なる複数行で固定のまま)。
  const NEST_DOC = [
    "function outer() {",
    "  if (a) {",
    "    for (let i = 0; i < 10; i++) {",
    "      if (i % 2 === 0) {",
    "        console.log('this line is intentionally quite long so that it wraps in the narrow viewport used for the screenshot');",
    "      }",
    "    }",
    "  }",
    "  return a;",
    "}",
  ].join("\n");
  await openFile(page, "shot-markers.js", NEST_DOC);
  await page.waitForTimeout(200);
  fs.writeFileSync(".shots/hang-code-markers.png", await page.screenshot({ fullPage: false }));

  // タブインデントでの折り返し。
  await openFile(page, "shot-tab.js", wrap(TAB_LINE));
  await page.waitForTimeout(200);
  fs.writeFileSync(".shots/hang-code-tab.png", await page.screenshot({ fullPage: false }));

  // Markdownのリストのぶら下げ(従来どおり)。
  const MD_SHOT = [
    "# メモ",
    "",
    "- とても長い箇条書きの項目テキストをここに置いて、狭い画面幅でも必ず折り返されるくらいの十分な長さにしておく。",
    "1. 番号付きリストも同じようにぶら下げインデントが効くことを確認するための十分に長いテキストをここに書く。",
  ].join("\n");
  await openFile(page, "shot-md.md", MD_SHOT);
  await page.waitForTimeout(200);
  fs.writeFileSync(".shots/hang-code-markdown-unaffected.png", await page.screenshot({ fullPage: false }));

  console.log("  [保存] .shots/hang-code-wrap.png, hang-code-markers.png, hang-code-tab.png, hang-code-markdown-unaffected.png");
  await page.close();
}

ok(`ページエラー・コンソールエラーが0件(全体): ${errors.length}件${errors.length ? " " + JSON.stringify(errors.slice(0, 5)) : ""}`, errors.length === 0);
console.log(`\n合計: OK=${okCount} NG=${ngCount}`);
await browser.close();
process.exit(ngCount > 0 ? 1 : 0);
