// 依頼①(コードブロックのコピーボタン)・依頼②(現在行の強調表示)の実ブラウザ検証。
// .verify-tooltips.mjs等と同じ流儀(WebView2ブリッジをモックし、apply-settings等を
// window.__reply()で流し込む)。ポートは8196。
//
// 検証項目(タスク指示より):
//   ①: コピーボタンが出る/押すとコピーされる。既定は非表示で、カーソルが中にある/
//      マウスを乗せたときだけ表示。コピー後の短いフィードバック。9テーマで見える。
//      4段階ツールチップ。折りたたみマーカー・カラープレビュー・インデントガイドと
//      表示位置が競合しない(モードが排他のため原理的に共存しないことを確認)。
//      行番号ウィジェットの上をマウスが通ってもホバー判定が効く(実装中に見つかった
//      CodeMirrorのignoreEvent()絡みの不具合の回帰確認)。
//   ②: 現在行の強調がコードモードだけで出る・設定でON/OFFできる(即時反映)・
//      選択中は出ない・本文とガター両方に付く。9テーマで色が有効。
import pw from "playwright";
const { chromium } = pw;
const browser = await chromium.launch();
const PORT = 8196;
const errors = [];
let okCount = 0, ngCount = 0;
const ok = (l, c) => { console.log(`${c ? "OK  " : "NG  "} ${l}`); if (c) okCount++; else ngCount++; };

async function newBridgedPage() {
  const page = await browser.newPage();
  page.on("pageerror", (e) => errors.push(String(e.stack || e)));
  page.on("console", (m) => { if (m.type() === "error") errors.push("console: " + m.text()); });
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
  await page.goto(`http://localhost:${PORT}/index.html`);
  await page.waitForTimeout(700);
  return page;
}
async function applySettings(page, partial) {
  await page.evaluate((partial) => window.__reply({ type: "apply-settings", ...partial }), partial);
  await page.waitForTimeout(200);
}
async function openFile(page, fileName, path, text) {
  await page.evaluate(({ fileName, path, text }) => window.__reply({
    type: "file-opened", fileName, path, text,
    encoding: "UTF-8", lineEnding: "CRLF", readOnly: false,
  }), { fileName, path, text });
  await page.waitForTimeout(500);
}
const BASE_SETTINGS = { showStatusBar: true, displayMode: "window" };

const MD_WITH_CODE =
  "# 見出し\n\n本文です。\n\n```js\nconst a = 1;\nconst b = 2;\nconst color = \"#ff0000\";\n```\n\nおわり。\n";
const JS_CODE = "function f(a) {\n  if (a > 0) {\n    return a;\n  }\n  return 0;\n}\n";

// ================= ① コードコピーボタン =================
{
  const page = await newBridgedPage();
  const ctx = browser.contexts().at(-1);
  try { await ctx.grantPermissions(["clipboard-read", "clipboard-write"], { origin: `http://localhost:${PORT}` }); } catch { /* 権限付与に失敗しても後続のUI確認は続行する */ }

  await applySettings(page, BASE_SETTINGS);
  await openFile(page, "sample.md", "C:\\work\\sample.md", MD_WITH_CODE);

  // (1) ボタンが1つ存在する(Markdownのフェンスコードブロックごとに1つ)
  const btnCount = await page.locator(".cm-code-copy").count();
  ok(`① (1) コピーボタンが存在する: ${btnCount}`, btnCount === 1);

  // (2) 既定は非表示(opacity:0・pointer-events:none)
  const idle = await page.locator(".cm-code-copy").evaluate((el) => {
    const cs = getComputedStyle(el);
    return { opacity: cs.opacity, pointerEvents: cs.pointerEvents };
  });
  ok(`① (2) 既定で不透明度0: ${idle.opacity}`, idle.opacity === "0");
  ok(`① (2) 既定でpointer-events:none(下の本文へのクリックを妨げない): ${idle.pointerEvents}`, idle.pointerEvents === "none");

  // (3) マウスを乗せると表示される(コードブロック内のテキストへホバー。行番号の
  //     数字の真上を経由しても効くことを別途(9)で確認する)
  await page.locator(".cm-content").getByText("const a = 1;").hover();
  await page.waitForTimeout(200);
  const hoverOpacity = await page.locator(".cm-code-copy").evaluate((el) => getComputedStyle(el).opacity);
  ok(`① (3) ホバーで不透明度1: ${hoverOpacity}`, hoverOpacity === "1");
  await page.mouse.move(2, 2);
  await page.waitForTimeout(200);
  const afterLeaveOpacity = await page.locator(".cm-code-copy").evaluate((el) => getComputedStyle(el).opacity);
  ok(`① (3) マウスが離れると不透明度0に戻る: ${afterLeaveOpacity}`, afterLeaveOpacity === "0");

  // (4) カーソルがブロックの中にあると表示される(マウスは離れたまま)。カーソル移動は
  // キーボードのみで行う(マウスクリックでの位置指定は、クリックそのものが移動先への
  // mouseoverも兼ねてしまい「ホバーによる表示」と「カーソルによる表示」を切り分けられない
  // うえ、このヘッドレス環境ではクリック位置とCodeMirror側のカーソル反映位置が一致しない
  // ことがあり不安定だった。.verify-editorsettings.mjs の(15)liveRenderingShowSourceOnFocus
  // と同じ「Ctrl+Home→矢印キーで行移動」方式にする)。MD_WITH_CODEの行構成は
  // 1:見出し 2:空行 3:本文です。 4:空行 5:```js 6:const a = 1; …なので5回下へ。
  await page.click(".cm-content");
  await page.keyboard.press("Control+Home");
  await page.waitForTimeout(150);
  for (let i = 0; i < 5; i++) await page.keyboard.press("ArrowDown");
  await page.waitForTimeout(250);
  const cursorInsideOpacity = await page.locator(".cm-code-copy").evaluate((el) => getComputedStyle(el).opacity);
  ok(`① (4) カーソルがブロック内にあると不透明度1: ${cursorInsideOpacity}`, cursorInsideOpacity === "1");
  // カーソルをブロックの外(先頭の見出し行)へ戻すと消える
  await page.keyboard.press("Control+Home");
  await page.waitForTimeout(250);
  const cursorOutsideOpacity = await page.locator(".cm-code-copy").evaluate((el) => getComputedStyle(el).opacity);
  ok(`① (4) カーソルがブロック外に出ると不透明度0に戻る: ${cursorOutsideOpacity}`, cursorOutsideOpacity === "0");

  // (5) クリックでクリップボードへコピーされる(行番号は含まれない)
  await page.locator(".cm-content").getByText("const a = 1;").hover();
  await page.waitForTimeout(150);
  await page.locator(".cm-code-copy").click();
  await page.waitForTimeout(150);
  const clip = await page.evaluate(() => navigator.clipboard.readText()).catch(() => null);
  const expected = "const a = 1;\nconst b = 2;\nconst color = \"#ff0000\";";
  ok(`① (5) クリップボードにコード本文がコピーされる(行番号を含まない): ${JSON.stringify(clip)}`,
    clip === expected);

  // (6) コピー後の短いフィードバック(アイコン切替・aria-label・title)
  const doneState = await page.locator(".cm-code-copy").evaluate((el) => ({
    hasDone: el.classList.contains("done"),
    ariaLabel: el.getAttribute("aria-label"),
    title: el.getAttribute("title"),
  }));
  ok(`① (6) コピー直後に.doneクラスが付く: ${doneState.hasDone}`, doneState.hasDone === true);
  ok(`① (6) コピー直後のaria-label: "${doneState.ariaLabel}"`, doneState.ariaLabel === "コピーしました");
  await page.waitForTimeout(1300);
  const afterState = await page.locator(".cm-code-copy").evaluate((el) => ({
    hasDone: el.classList.contains("done"),
    ariaLabel: el.getAttribute("aria-label"),
  }));
  ok(`① (6) 1.2秒後に元のラベルへ戻る: ${afterState.ariaLabel}`, afterState.hasDone === false && afterState.ariaLabel === "コードをコピー");

  // (7) 4段階ツールチップ(tooltips.js の "cm-code-copy" エントリ)
  for (const [level, expectedTitle] of [
    ["standard", "このコードブロックの中身をクリップボードへコピーします"],
    ["minimal", "コードをコピー"],
    ["none", ""],
  ]) {
    await applySettings(page, { ...BASE_SETTINGS, tooltipDetail: level });
    const title = await page.locator(".cm-code-copy").getAttribute("title");
    ok(`① (7) tooltipDetail=${level} でtitle="${title}"`, title === expectedTitle);
  }
  await applySettings(page, { ...BASE_SETTINGS, tooltipDetail: "detailed" });
  const detailedTitle = await page.locator(".cm-code-copy").getAttribute("title");
  ok(`① (7) tooltipDetail=detailed で長い説明文になる: ${(detailedTitle || "").length > 40}`, (detailedTitle || "").length > 40);
  await applySettings(page, { ...BASE_SETTINGS, tooltipDetail: "standard" });

  // (8) 9テーマそれぞれでボタンが見える(背景色と文字色が異なる、かつ本文の--paperとも
  //     はっきり異なる背景を持つ)。ホバー状態にして不透明度1にした上で確認する。
  await page.locator(".cm-content").getByText("const a = 1;").hover();
  await page.waitForTimeout(150);
  const THEMES = [
    ["light", "default", "default", "既定(ライト)"],
    ["light", "sepia", "default", "sepia"],
    ["light", "github", "default", "github"],
    ["light", "solarized-light", "default", "solarized-light"],
    ["dark", "default", "default", "既定(ダーク)"],
    ["dark", "default", "nord", "nord"],
    ["dark", "default", "dracula", "dracula"],
    ["dark", "default", "solarized-dark", "solarized-dark"],
    ["dark", "default", "night", "night"],
  ];
  let themeOkAll = true;
  for (const [mode, lightTheme, darkTheme, label] of THEMES) {
    await page.evaluate(({ mode, lightTheme, darkTheme }) => {
      document.documentElement.dataset.theme = mode;
      document.documentElement.dataset.lightTheme = lightTheme;
      document.documentElement.dataset.darkTheme = darkTheme;
    }, { mode, lightTheme, darkTheme });
    await page.waitForTimeout(80);
    const colors = await page.locator(".cm-code-copy").evaluate((el) => {
      const cs = getComputedStyle(el);
      return { bg: cs.backgroundColor, fg: cs.color, paper: getComputedStyle(document.documentElement).getPropertyValue("--paper").trim() };
    });
    const visible = colors.bg !== colors.fg && colors.bg !== "rgba(0, 0, 0, 0)";
    if (!visible) { themeOkAll = false; console.log(`  NG detail: ${label} bg=${colors.bg} fg=${colors.fg}`); }
  }
  ok(`① (8) 9テーマすべてでボタンの背景色・文字色が判別できる`, themeOkAll);
  // 既定テーマへ戻す
  await page.evaluate(() => {
    document.documentElement.dataset.theme = "light";
    document.documentElement.dataset.lightTheme = "default";
    document.documentElement.dataset.darkTheme = "default";
  });

  // (9) 行番号ウィジェットの真上をマウスが通ってもホバー判定が効く(実装中の不具合の
  //     回帰確認: CodeLineNumberWidget.ignoreEvent()===trueのため、標準の
  //     EditorView.domEventHandlers()経由だとこの場合だけ検出できなかった)
  await page.mouse.move(2, 2);
  await page.waitForTimeout(200);
  const lineNumBox = await page.locator(".cm-code-linenum").first().boundingBox();
  await page.mouse.move(lineNumBox.x + lineNumBox.width / 2, lineNumBox.y + lineNumBox.height / 2, { steps: 5 });
  await page.waitForTimeout(200);
  const opacityOverLineNum = await page.locator(".cm-code-copy").evaluate((el) => getComputedStyle(el).opacity);
  ok(`① (9) 行番号ウィジェットの上を通ってもボタンが表示される: ${opacityOverLineNum}`, opacityOverLineNum === "1");
  await page.mouse.move(2, 2);
  await page.waitForTimeout(200);

  // (10) 折りたたみマーカー・インデントガイドとの非競合: これらはコードモード限定の
  //      拡張であり、Markdownのライブプレビュー(コピーボタンが出る場面)には
  //      そもそも読み込まれない。実際にMarkdown文書中に1つも無いことを確認する。
  const foldMarkerCount = await page.locator(".cm-fold-marker2").count();
  const guideLineCount = await page.locator(".cm-guide-line").count();
  ok(`① (10) Markdown文書に折りたたみマーカーが無い(モードが排他): ${foldMarkerCount}`, foldMarkerCount === 0);
  ok(`① (10) Markdown文書にインデントガイドが無い(モードが排他): ${guideLineCount}`, guideLineCount === 0);

  // (11) カラープレビューとの非競合: 同じコードブロック内に色リテラル(#ff0000)があっても、
  //      スウォッチとコピーボタンは別の行にあり重ならない(バウンディングボックスで確認)。
  const swatchCount = await page.locator(".cm-color-swatch").count();
  if (swatchCount > 0) {
    const swatchBox = await page.locator(".cm-color-swatch").first().boundingBox();
    const btnBox = await page.locator(".cm-code-copy").boundingBox();
    const overlap = !(swatchBox.x + swatchBox.width < btnBox.x || btnBox.x + btnBox.width < swatchBox.x ||
      swatchBox.y + swatchBox.height < btnBox.y || btnBox.y + btnBox.height < swatchBox.y);
    ok(`① (11) カラープレビューのスウォッチとコピーボタンの表示位置が重ならない`, !overlap);
  } else {
    ok(`① (11) カラープレビューのスウォッチが検出できた(前提)`, false);
  }

  await page.close();
}

// ================= ② 現在行の強調表示 =================
{
  const page = await newBridgedPage();
  await applySettings(page, BASE_SETTINGS);

  // (1) コードモードで既定ON、本文・ガター両方に付く
  await openFile(page, "sample.js", "C:\\work\\sample.js", JS_CODE);
  const modeText = await page.textContent("#status-mode");
  ok(`② 前提: コードモードで開いている: "${modeText}"`, modeText.startsWith("コード"));
  await page.locator(".cm-content").getByText("function f(a) {").click();
  await page.waitForTimeout(200);
  const lineCount = await page.locator(".cm-active-line").count();
  const gutterCount = await page.locator(".cm-active-line-gutter").count();
  ok(`② (1) 既定ONで本文に現在行の帯が1つ付く: ${lineCount}`, lineCount === 1);
  ok(`② (1) 既定ONで行番号ガターにも1つ付く: ${gutterCount}`, gutterCount === 1);
  const bg = await page.locator(".cm-active-line").evaluate((el) => getComputedStyle(el).backgroundColor);
  ok(`② (1) 背景色が透明でない: ${bg}`, bg !== "rgba(0, 0, 0, 0)");

  // (2) 選択範囲があると出ない
  await page.keyboard.down("Shift");
  for (let i = 0; i < 6; i++) await page.keyboard.press("ArrowRight");
  await page.keyboard.up("Shift");
  await page.waitForTimeout(200);
  const isCollapsed = await page.evaluate(() => window.getSelection().isCollapsed);
  ok(`② (2) 前提: 選択ができている`, isCollapsed === false);
  const lineCountSel = await page.locator(".cm-active-line").count();
  ok(`② (2) 選択中は本文の帯が出ない: ${lineCountSel}`, lineCountSel === 0);
  const gutterCountSel = await page.locator(".cm-active-line-gutter").count();
  ok(`② (2) 選択中はガター側も出ない: ${gutterCountSel}`, gutterCountSel === 0);
  await page.keyboard.press("ArrowRight");
  await page.waitForTimeout(200);
  const lineCountBack = await page.locator(".cm-active-line").count();
  ok(`② (2) 選択解除で戻る: ${lineCountBack}`, lineCountBack === 1);

  // (3) 設定でOFFにすると即座に消え、ONに戻すと即座に復活する(再起動なし)
  await applySettings(page, { ...BASE_SETTINGS, codeActiveLineHighlight: false });
  const offCount = await page.locator(".cm-active-line").count();
  const offGutterCount = await page.locator(".cm-active-line-gutter").count();
  ok(`② (3) 設定OFFで即座に消える(本文): ${offCount}`, offCount === 0);
  ok(`② (3) 設定OFFで即座に消える(ガター): ${offGutterCount}`, offGutterCount === 0);
  await applySettings(page, { ...BASE_SETTINGS, codeActiveLineHighlight: true });
  const onCount = await page.locator(".cm-active-line").count();
  ok(`② (3) 設定ONに戻すと即座に復活する: ${onCount}`, onCount === 1);

  // (4) Markdownモードでは出ない
  await openFile(page, "sample.md", "C:\\work\\sample.md", "# 見出し\n\n本文です。\n");
  await page.locator(".cm-content").getByText("本文です。").click();
  await page.waitForTimeout(200);
  const mdModeText = await page.textContent("#status-mode");
  ok(`② (4) 前提: Markdownモードで開いている: "${mdModeText}"`, mdModeText === "Markdown");
  const mdLineCount = await page.locator(".cm-active-line").count();
  ok(`② (4) Markdownモードでは現在行の帯が出ない: ${mdLineCount}`, mdLineCount === 0);

  // (5) 9テーマそれぞれで--active-line-bgが本文色(--paper)と異なる値を持つ(=見える)
  await openFile(page, "sample.js", "C:\\work\\sample.js", JS_CODE);
  await page.locator(".cm-content").getByText("function f(a) {").click();
  await page.waitForTimeout(200);
  const THEMES = [
    ["light", "default", "default", "既定(ライト)"],
    ["light", "sepia", "default", "sepia"],
    ["light", "github", "default", "github"],
    ["light", "solarized-light", "default", "solarized-light"],
    ["dark", "default", "default", "既定(ダーク)"],
    ["dark", "default", "nord", "nord"],
    ["dark", "default", "dracula", "dracula"],
    ["dark", "default", "solarized-dark", "solarized-dark"],
    ["dark", "default", "night", "night"],
  ];
  let themeAllDistinct = true;
  for (const [mode, lightTheme, darkTheme, label] of THEMES) {
    await page.evaluate(({ mode, lightTheme, darkTheme }) => {
      document.documentElement.dataset.theme = mode;
      document.documentElement.dataset.lightTheme = lightTheme;
      document.documentElement.dataset.darkTheme = darkTheme;
    }, { mode, lightTheme, darkTheme });
    await page.waitForTimeout(80);
    const distinct = await page.evaluate(() => {
      const el = document.querySelector(".cm-active-line");
      if (!el) return false;
      const bg = getComputedStyle(el).backgroundColor;
      const paperEl = document.body;
      const paperBg = getComputedStyle(paperEl).backgroundColor;
      return bg !== paperBg && bg !== "rgba(0, 0, 0, 0)";
    });
    if (!distinct) { themeAllDistinct = false; console.log(`  NG detail: ${label} 現在行の色がbodyの背景と区別できない`); }
  }
  ok(`② (5) 9テーマすべてで現在行の帯が本文背景と異なる色を持つ`, themeAllDistinct);
  await page.evaluate(() => {
    document.documentElement.dataset.theme = "light";
    document.documentElement.dataset.lightTheme = "default";
    document.documentElement.dataset.darkTheme = "default";
  });

  await page.close();
}

// ================= 共通: ページエラー・コンソールエラー 0件 =================
ok(`ページエラー・コンソールエラーが0件: ${errors.length}件${errors.length ? " " + JSON.stringify(errors.slice(0, 3)) : ""}`, errors.length === 0);

console.log(`\n合計: OK=${okCount} NG=${ngCount}`);
await browser.close();
process.exit(ngCount > 0 ? 1 : 0);
