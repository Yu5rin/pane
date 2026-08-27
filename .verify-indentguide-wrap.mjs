// 不具合修正の検証: コードモードで長い行が折り返されたとき、インデントガイド(縦線)が
// 折り返し部分で途切れる問題。ポートは8201(このファイル専用。他の.verify-*.mjsと
// 重ならないよう新規に採番)。
//
// 原因(調査済み): buildFoldGuideLines/buildAllIndentGuidesがGuideLineWidgetへ渡す縦線の
// 高さに、view.defaultLineHeight(1行ぶん固定)を使っていた。折り返して2行以上の高さに
// なった行でも線は1行ぶんしか描かれず、折り返し部分で途切れていた。
// 修正: view.viewportLineBlocks(既にCodeMirrorが持っている値)のblock.heightを、行の
// 実際の描画高さとして縦線本体(絶対配置の子要素)にだけ使う。GuideLineWidgetのanchor
// 自身の高さは1行ぶんのまま据え置くことで、折り返しによる行の高さそのものへの副作用
// (行が余計に間延びする等)が起きないようにしている(詳細はsrc/editor.jsの
// GuideLineWidget定義部の大きなコメント参照)。
//
// 検証項目:
//   (A) 折り返した行(2行ぶんの高さ)で、縦線が行の上端から下端まで途切れず伸びている
//       (.cm-guide-lineの高さが.cm-lineの実際の高さとほぼ一致する)
//   (B) 折り返した行の前後の行との継続性(隣接行の同じ深さの縦線とtop/bottomが接する)
//   (C) 折り返していない行の縦線は従来どおり(1行ぶんの高さ)であること(回帰確認)
//   (D) 折りたたみ(fold)を開閉しても縦線が正しいこと(畳んだ行の前後で途切れない、
//       畳んだ範囲内に折り返し行があっても不自然に伸びない)
//   (E) ネストが深い(3〜4段)場合も、各深さの縦線がすべて折り返し行の下端まで届くこと
//   (F) "fold"モードでも同様に修正されていること("all"だけでなく)
//   (G) 空行をまたぐケースとの整合(既存の仕組みを壊していないこと)
//   (H) Markdownモード(コードブロック外)ではインデントガイド自体が出ないこと
//       (コードモード専用であることの確認。折り返しがあっても縦線要素が無いこと)
import pw from "playwright";
const { chromium } = pw;
const browser = await chromium.launch();
const PORT = 8201;
const BASE = `http://localhost:${PORT}/index.html`;
const errors = [];
let okCount = 0, ngCount = 0;
const ok = (l, c) => { console.log(`${c ? "OK  " : "NG  "} ${l}`); if (c) okCount++; else ngCount++; };

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
async function openFile(page, fileName, text) {
  await page.evaluate(({ fileName, text }) => window.__reply({
    type: "file-opened", fileName, path: "C:\\work\\" + fileName, text,
    encoding: "UTF-8", lineEnding: "CRLF", readOnly: false,
  }), { fileName, text });
  await page.waitForTimeout(400);
}
async function applySettings(page, extra) {
  await page.evaluate((extra) => window.__reply({ type: "apply-settings", ...extra }), extra);
  await page.waitForTimeout(200);
}
// 各.cm-lineの実際の高さと、その行に乗っている.cm-guide-lineのtop/bottom/leftを集める。
async function guideGeometry(page) {
  return page.evaluate(() => {
    const lines = [...document.querySelectorAll(".cm-content > .cm-line")];
    return lines.map((l) => {
      const r = l.getBoundingClientRect();
      const guides = [...l.querySelectorAll(".cm-guide-line")].map((g) => {
        const gr = g.getBoundingClientRect();
        return { left: gr.left, top: gr.top, bottom: gr.bottom, height: gr.height };
      });
      return { text: l.textContent, top: r.top, bottom: r.bottom, height: r.height, guides };
    });
  });
}

// ユーザー報告のスクリーンショットに近い題材(BulletWidgetのtoDOM()相当)。1つのメソッド
// 本体が長く、折り返しが必ず起きるようにする(狭いビューポートで確実に発生させる)。
const WRAP_DOC = [
  "class BulletWidget extends WidgetType {",
  '  toDOM() { const s = document.createElement("span"); s.textContent = "• "; s.className = "cm-bullet";',
  "  return s; }",
  "}",
].join("\n");

// ================= (A)(B)(C) 基本: 折り返し行で縦線が途切れないこと =================
{
  // 700pxの狭いビューポートで確実に折り返しを起こす。
  const page = await newPage({ width: 700, height: 800 });
  await openFile(page, "wrap1.js", WRAP_DOC);
  await applySettings(page, { codeIndentGuides: "all", codeFoldingEnabled: true });
  const geo = await guideGeometry(page);
  console.log(`  [実測] 行ごとの高さ・縦線本数: ${JSON.stringify(geo.map((g) => ({ h: g.height.toFixed(1), guides: g.guides.length, text: g.text.slice(0, 40) })))}`);

  const toDomIdx = geo.findIndex((g) => g.text.includes("toDOM()"));
  ok(`(A) 前提: "toDOM()"の行が見つかる`, toDomIdx >= 0);
  const toDomRow = geo[toDomIdx];
  ok(`(A) 前提: "toDOM()"の行が実際に折り返されている(高さ=${toDomRow?.height.toFixed(1)}px が1行の1.5倍以上)`,
    toDomRow && toDomRow.height > (geo[0]?.height ?? 0) * 1.5);
  ok(`(A) "toDOM()"の行に縦線が乗っている(本数=${toDomRow?.guides.length})`, (toDomRow?.guides.length ?? 0) > 0);
  for (const g of toDomRow?.guides ?? []) {
    const topGap = Math.abs(g.top - toDomRow.top);
    const bottomGap = Math.abs(g.bottom - toDomRow.bottom);
    ok(`(A) 折り返し行(x=${g.left.toFixed(1)})の縦線が行の上端に接している(誤差=${topGap.toFixed(2)}px)`, topGap < 1.0);
    ok(`(A) 折り返し行(x=${g.left.toFixed(1)})の縦線が行の下端まで届いている(誤差=${bottomGap.toFixed(2)}px、途切れていれば大きくずれるはず)`, bottomGap < 1.0);
  }

  // (B) 前後の行との継続性(同じ深さの縦線がtop/bottomで接している)。
  let allTouching = true;
  let checkedCount = 0;
  for (let i = 0; i < geo.length - 1; i++) {
    const cur = geo[i], next = geo[i + 1];
    for (const g of cur.guides) {
      const match = next.guides.find((ng) => Math.abs(ng.left - g.left) < 0.5);
      if (!match) continue;
      checkedCount++;
      const gap = Math.abs(match.top - g.bottom);
      if (gap >= 0.6) { allTouching = false; console.log(`  [NG詳細] 行${i}→${i + 1} x=${g.left.toFixed(1)} 隙間=${gap.toFixed(2)}px`); }
    }
  }
  ok(`(B) 折り返し行を挟んでも縦線が隙間なく接続している(判定対象=${checkedCount}件)`, allTouching && checkedCount > 0);

  // (C) 折り返していない行(1行目 "class ...")の縦線は1行ぶんの高さのまま(回帰確認)。
  const classRow = geo[0];
  for (const g of classRow.guides) {
    ok(`(C) 折り返していない行の縦線の高さ(${g.height.toFixed(1)}px)が行自体の高さ(${classRow.height.toFixed(1)}px)とほぼ一致する`,
      Math.abs(g.height - classRow.height) < 1.0);
  }
  ok("(A)(B)(C) ページエラー・コンソールエラー0件", errors.length === 0, JSON.stringify(errors));
  await page.close();
}

// ================= (F) "fold"モードでも同様であること =================
{
  const page = await newPage({ width: 700, height: 800 });
  await openFile(page, "wrap2.js", WRAP_DOC);
  await applySettings(page, { codeIndentGuides: "fold", codeFoldingEnabled: true });
  const geo = await guideGeometry(page);
  const toDomIdx = geo.findIndex((g) => g.text.includes("toDOM()"));
  const toDomRow = geo[toDomIdx];
  console.log(`  [実測/fold] "toDOM()"行 高さ=${toDomRow?.height.toFixed(1)}px 縦線本数=${toDomRow?.guides.length}`);
  if ((toDomRow?.guides.length ?? 0) > 0) {
    for (const g of toDomRow.guides) {
      const bottomGap = Math.abs(g.bottom - toDomRow.bottom);
      ok(`(F) foldモードでも折り返し行(x=${g.left.toFixed(1)})の縦線が下端まで届く(誤差=${bottomGap.toFixed(2)}px)`, bottomGap < 1.0);
    }
  } else {
    // classの中(1階層)だけなのでfoldモードでは開始行の次から線が引かれる。BulletWidgetの
    // 本体(toDOM行はclassの2行目=開始行の直後)には線が乗るはずだが、念のため前提を明示的に
    // 確認しておく(0本ならこのチェック自体が無意味になるため、その旨をNGとして残す)。
    ok("(F) foldモードで\"toDOM()\"行に縦線が最低1本乗っている(class Xの内側のため)", false);
  }
  ok("(F) ページエラー・コンソールエラー0件", errors.length === 0, JSON.stringify(errors));
  await page.close();
}

// ================= (E) ネストが深い(4段)場合、各深さすべてが折り返し行の下端まで届くこと =================
{
  const DEEP_DOC = [
    "function outer() {",
    "  if (a) {",
    "    for (let i = 0; i < 10; i++) {",
    "      if (i % 2 === 0) {",
    '        console.log("this is a fairly long line that should wrap across multiple visual rows when the viewport is narrow enough", i, outer, a);',
    "      }",
    "    }",
    "  }",
    "}",
  ].join("\n");
  const page = await newPage({ width: 700, height: 800 });
  await openFile(page, "wrap3.js", DEEP_DOC);
  await applySettings(page, { codeIndentGuides: "all", codeFoldingEnabled: true, codeIndentSize: 2 });
  const geo = await guideGeometry(page);
  const longIdx = geo.findIndex((g) => g.text.includes("console.log"));
  const longRow = geo[longIdx];
  console.log(`  [実測/深いネスト] console.log行 高さ=${longRow?.height.toFixed(1)}px 縦線本数=${longRow?.guides.length}`);
  ok(`(E) 4段ネストの折り返し行に4本の縦線が乗っている(本数=${longRow?.guides.length})`, (longRow?.guides.length ?? 0) === 4);
  ok(`(E) 前提: 実際に折り返されている(高さ=${longRow?.height.toFixed(1)}px)`, longRow && longRow.height > (geo[0]?.height ?? 0) * 1.5);
  for (const g of longRow?.guides ?? []) {
    const bottomGap = Math.abs(g.bottom - longRow.bottom);
    ok(`(E) 深さx=${g.left.toFixed(1)}の縦線が折り返し行の下端まで届く(誤差=${bottomGap.toFixed(2)}px)`, bottomGap < 1.0);
  }
  ok("(E) ページエラー・コンソールエラー0件", errors.length === 0, JSON.stringify(errors));
  await page.close();
}

// ================= (D) 折りたたみの開閉と組み合わせても正しいこと =================
{
  const DOC = [
    "function outer() {",
    "  if (a) {",
    '    console.log("this is a fairly long line that should wrap across multiple visual rows when the viewport is narrow", a, outer);',
    "    return a;",
    "  }",
    "  return 0;",
    "}",
  ].join("\n");
  const page = await newPage({ width: 700, height: 800 });
  await openFile(page, "wrap4.js", DOC);
  await applySettings(page, { codeIndentGuides: "all", codeFoldingEnabled: true, codeIndentSize: 2 });
  const before = await guideGeometry(page);
  const longIdx = before.findIndex((g) => g.text.includes("console.log"));
  ok(`(D) 前提: console.log行が折り返されている(高さ=${before[longIdx]?.height.toFixed(1)}px)`,
    before[longIdx] && before[longIdx].height > (before[0]?.height ?? 0) * 1.5);

  // "if (a) {"の範囲(console.log行を含む)を畳む → 折り返し行ごと非表示になるはず。
  await page.locator(".cm-line", { hasText: "if (a)" }).first().click();
  await page.keyboard.press("Alt+BracketLeft");
  await page.waitForTimeout(300);
  const folded = await guideGeometry(page);
  const stillThere = folded.some((g) => g.text.includes("this is a fairly long line"));
  ok("(D) 折りたたみ範囲内の折り返し行は畳むと非表示になる", !stillThere);
  // 畳んだプレースホルダ行自体は1行ぶんの高さのまま(不自然に伸びていないこと)。
  const ifRow = folded.find((g) => g.text.includes("if (a)"));
  const outerRow = folded.find((g) => g.text.includes("function outer"));
  ok(`(D) 畳んだ行(高さ=${ifRow?.height.toFixed(1)}px)が1行ぶんの高さのまま(不自然に伸びていない。基準=${outerRow?.height.toFixed(1)}px)`,
    ifRow && outerRow && Math.abs(ifRow.height - outerRow.height) < 1.0);
  for (const g of ifRow?.guides ?? []) {
    ok(`(D) 畳んだ行の縦線(x=${g.left.toFixed(1)})の高さも1行ぶんのまま(${g.height.toFixed(1)}px)`,
      Math.abs(g.height - ifRow.height) < 1.0);
  }

  // 再度展開 → 折り返し行が復活し、縦線がまた下端まで届くこと。
  await page.keyboard.press("Alt+BracketRight");
  await page.waitForTimeout(300);
  const reopened = await guideGeometry(page);
  const longIdx2 = reopened.findIndex((g) => g.text.includes("this is a fairly long line"));
  ok("(D) 再展開で折り返し行が戻る", longIdx2 >= 0);
  if (longIdx2 >= 0) {
    const row = reopened[longIdx2];
    for (const g of row.guides) {
      const bottomGap = Math.abs(g.bottom - row.bottom);
      ok(`(D) 再展開後、折り返し行(x=${g.left.toFixed(1)})の縦線が下端まで届く(誤差=${bottomGap.toFixed(2)}px)`, bottomGap < 1.0);
    }
  }
  ok("(D) ページエラー・コンソールエラー0件", errors.length === 0, JSON.stringify(errors));
  await page.close();
}

// ================= (G) 空行をまたぐケースとの回帰確認(折り返し行+空行の組み合わせ) =================
{
  const DOC = [
    "function outer() {",
    "  if (a) {",
    '    console.log("this line wraps because it is long enough to exceed the narrow viewport width available here", a);',
    "",
    "    return a;",
    "  }",
    "}",
  ].join("\n");
  const page = await newPage({ width: 700, height: 800 });
  await openFile(page, "wrap5.js", DOC);
  await applySettings(page, { codeIndentGuides: "all", codeFoldingEnabled: true, codeIndentSize: 2 });
  const geo = await guideGeometry(page);
  const blankIdx = geo.findIndex((g) => g.text.trim() === "");
  ok("(G) 前提: 空行が見つかる", blankIdx >= 0);
  ok(`(G) 空行にも縦線が乗っている(空行をまたいでも途切れない、本数=${geo[blankIdx]?.guides.length})`, (geo[blankIdx]?.guides.length ?? 0) > 0);
  // 折り返し行(空行の直前)と空行との接続も途切れていないこと。
  const wrapIdx = geo.findIndex((g) => g.text.includes("this line wraps"));
  if (wrapIdx >= 0 && blankIdx === wrapIdx + 1) {
    let touching = true;
    for (const g of geo[wrapIdx].guides) {
      const match = geo[blankIdx].guides.find((ng) => Math.abs(ng.left - g.left) < 0.5);
      if (match && Math.abs(match.top - g.bottom) >= 0.6) touching = false;
    }
    ok("(G) 折り返し行→直後の空行への接続も途切れていない", touching);
  }
  ok("(G) ページエラー・コンソールエラー0件", errors.length === 0, JSON.stringify(errors));
  await page.close();
}

// ================= (H) Markdownモードでは縦線自体が出ないこと(コードモード専用の確認) =================
{
  const page = await newPage({ width: 700, height: 800 });
  const MD = "# 見出し\n\nこれは十分に長い段落で、狭いビューポートでは折り返しが起きるはずのテキストです。foo bar baz qux quux corge grault garply waldo fred plugh xyzzy thud.\n\n- 箇条書き1\n- 箇条書き2\n";
  await openFile(page, "wrap6.md", MD);
  await page.waitForTimeout(300);
  const guideCount = await page.evaluate(() => document.querySelectorAll(".cm-guide-line").length);
  ok(`(H) Markdownモードでは.cm-guide-line要素が1つも無い(件数=${guideCount})`, guideCount === 0);
  ok("(H) ページエラー・コンソールエラー0件", errors.length === 0, JSON.stringify(errors));
  await page.close();
}

console.log(`\n合計: OK=${okCount} NG=${ngCount}`);
await browser.close();
process.exit(ngCount > 0 ? 1 : 0);
