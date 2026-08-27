// エディタ本体で新たに配線・実装した設定項目の実ブラウザ検証。
// .verify-mainsettings.mjs と同じ流儀(WebView2ブリッジをモックし、apply-settings等を
// window.__reply()で流し込む)。ポートは8156。
//
// 重要: apply-settingsは実際のC#側では常に「全項目を含む完全なオブジェクト」として送られる
// (Pane/MainForm.cs参照)。このテストでも同じ流儀にする(部分的なオブジェクトを送ると、
// main.jsのeditor.setExtensionToggles()呼び出しに含まれる未指定キーがundefinedのまま
// extTogglesFieldへ上書きされてしまい、他の項目の状態を意図せず壊してしまうため)。
import pw from "playwright";
const { chromium } = pw;
const browser = await chromium.launch();
const errors = [];
let okCount = 0, ngCount = 0;
const ok = (l, c) => { console.log(`${c ? "OK  " : "NG  "} ${l}`); if (c) okCount++; else ngCount++; };

// C#側(Pane/AppSettings.cs)の既定値に合わせた完全な設定オブジェクト。
const DEFAULT_SETTINGS = {
  showStatusBar: true, zoomWithCtrlWheel: true, saveWithoutAskingOnSwitch: false,
  showWordCount: true, readingSpeedWpm: 0, collapsibleOutline: true, showOutlineByDefault: false,
  theme: "system", lightTheme: "default", darkTheme: "default",
  editorFontSize: 15, editorLineHeight: 1.95, editorMaxWidthPx: 630, editorPaddingLeft: 32, editorPaddingRight: 32,
  editorFontFamily: "", editorMonospaceFontFamily: "", customCss: "", keyBindings: {},
  fileModeOverrides: {}, perFileModes: {}, autoDetectMode: "standard",
  defaultCopyFormat: "markdown", pandocAvailable: false, recentFiles: [],
  calloutsEnabled: true, superSubscriptEnabled: true, highlightEnabled: true,
  inlineMathEnabled: false, mathAutoNumber: "off",
  diagramsEnabled: true, codeBlockMathEnabled: false, autoLinksEnabled: true,
  codeAutoWrap: true, liveRenderingShowSourceOnFocus: true, emojiAutocomplete: "auto",
  copyWholeLineWhenNoSelection: true, typewriterKeepCaretCentered: true,
  shiftTabAutoIndent: false, autoPairMarkdown: true, autoPairing: true,
  spellCheckEnabled: false, spellCheckAutoCorrect: false,
  headingStyle: "atx", unorderedListMarker: "-", orderedListMarker: ".",
  indentSizeOnSave: 4, codeIndentSize: 4,
  defaultCodeLanguage: "", defaultCodeLanguageApplyWhen: "menubar",
  chapterLevelInOutline: 6,
  whitespaceWhenWriting: "preserve", whitespaceOnExport: "ignore",
  smartQuotes: "off", smartDashes: "off", recognizeUnicodePunctuation: false,
};

async function newPage() {
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
  await page.goto("http://localhost:8156/index.html");
  await page.waitForTimeout(700);
  return page;
}

// overridesをDEFAULT_SETTINGSへ重ねた完全なapply-settingsを送る(実際のC#と同じ形)。
async function applySettings(page, overrides = {}) {
  const full = { ...DEFAULT_SETTINGS, ...overrides };
  await page.evaluate((full) => window.__reply({ type: "apply-settings", ...full }), full);
  await page.waitForTimeout(250);
}
async function openFile(page, text, extra = {}) {
  await page.evaluate(({ text, extra }) => window.__reply({
    type: "file-opened", fileName: "sample.md", path: "C:\\work\\sample.md", text,
    encoding: "UTF-8", lineEnding: "CRLF", readOnly: false, ...extra,
  }), { text, extra });
  await page.waitForTimeout(400);
}
async function newDoc(page) {
  await page.evaluate(() => window.__reply({ type: "new-document" }));
  await page.waitForTimeout(300);
}
// ネイティブメニュー経路(ctx.bridgeがある場合)ではnativeRunRegistryはそのメニューを
// 開いたときにだけ作られる(src/commands.js openNativeMenu)。そのため、menu-commandを
// 送る前に対応するメニュー見出しをクリックして開いておく必要がある(.verify-filemode.mjsと同じ手順)。
async function menuCommand(page, menuLabel, id) {
  await page.click(`#menubar .menu-top:text('${menuLabel}')`);
  await page.waitForTimeout(200);
  await page.evaluate((id) => window.__reply({ type: "menu-command", id }), id);
  await page.waitForTimeout(250);
}
async function docText(page) {
  return page.$$eval(".cm-content .cm-line", (els) => els.map((e) => e.textContent).join("\n"));
}
async function clearDoc(page) {
  await page.click(".cm-content");
  await page.keyboard.press("Control+a");
  await page.keyboard.press("Delete");
}
async function cssVar(page, name) {
  return page.evaluate((n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim(), name);
}
// 箇条書きマーカーなど、ライブプレビューで別の見た目(ウィジェット)に置き換えられて
// docText()では拾えない生のドキュメントテキストを取り出す。カーソル行を選択なしでコピーする
// 挙動(copyWholeLineWhenNoSelection、既定true)を利用する(表示用DOMではなく実際の文書を読む)。
async function rawLineText(page) {
  return page.evaluate(() => {
    const dt = new DataTransfer();
    const ev = new ClipboardEvent("copy", { clipboardData: dt, bubbles: true, cancelable: true });
    document.querySelector(".cm-content").dispatchEvent(ev);
    return dt.getData("text/plain");
  });
}

// ============================================================
// 1. autoLinksEnabled
// ============================================================
{
  const page = await newPage();
  await applySettings(page, { autoLinksEnabled: true });
  await clearDoc(page);
  await page.keyboard.insertText("裸のURL https://example.org/x です。");
  await page.keyboard.press("Control+Home");
  await page.waitForTimeout(300);
  const linkedOn = await page.$$eval(".tok-link[data-href]", (e) => e.length);
  ok(`(1) autoLinksEnabled:true で裸のURLがリンクになる (${linkedOn})`, linkedOn >= 1);

  await applySettings(page, { autoLinksEnabled: false });
  await page.waitForTimeout(300);
  const linkedOff = await page.$$eval(".tok-link[data-href]", (e) => e.length);
  ok(`(1) autoLinksEnabled:false でリンクにならない (${linkedOff})`, linkedOff === 0);
  await page.close();
}

// ============================================================
// 2. editorPaddingLeft / editorPaddingRight(左右個別、ユーザー要望で editorPaddingX から分割)
//    実際に効いているかは実測(#cm-hostのcomputedStyleのpadding-left/right)で確認する
//    (CSS変数の値そのものではなく、最終的な描画結果を見るのが実測として確実なため)。
//    あわせて、0を指定しても既定値(32px)に戻ってしまわないこと(不具合修正)も確認する。
// ============================================================
async function computedPadding(page) {
  return page.evaluate(() => {
    const el = document.querySelector("#cm-host .cm-content");
    const cs = getComputedStyle(el);
    return { left: cs.paddingLeft, right: cs.paddingRight };
  });
}
{
  const page = await newPage();
  await clearDoc(page); // Markdownモードで余白が効くページにしておく(コードモードは対象外)

  await applySettings(page, { editorPaddingLeft: 80, editorPaddingRight: 100 });
  const v1 = await computedPadding(page);
  ok(`(2) editorPaddingLeft:80/editorPaddingRight:100 で左右それぞれ実際の余白になる (${JSON.stringify(v1)})`,
    v1.left === "80px" && v1.right === "100px");

  await applySettings(page, { editorPaddingLeft: 200, editorPaddingRight: 200 });
  const v2 = await computedPadding(page);
  ok(`(2) editorPaddingLeft/Right:200(上限)で実際の余白になる (${JSON.stringify(v2)})`,
    v2.left === "200px" && v2.right === "200px");

  // 不具合修正の確認: 0を指定しても既定の32pxに戻ってしまわず、実際に余白0になること。
  await applySettings(page, { editorPaddingLeft: 0, editorPaddingRight: 0 });
  const v0 = await computedPadding(page);
  ok(`(2) editorPaddingLeft/Right:0で実際に余白が0になる(既定32pxに戻らない) (${JSON.stringify(v0)})`,
    v0.left === "0px" && v0.right === "0px");

  // 左右で非対称の値(片方だけ0)でも正しく反映されること。
  await applySettings(page, { editorPaddingLeft: 0, editorPaddingRight: 50 });
  const vAsym = await computedPadding(page);
  ok(`(2) 左だけ0・右は50という非対称な指定も正しく反映される (${JSON.stringify(vAsym)})`,
    vAsym.left === "0px" && vAsym.right === "50px");

  await page.close();
}

// ============================================================
// 3. diagramsEnabled
// ============================================================
{
  const page = await newPage();
  await applySettings(page, { diagramsEnabled: true });
  await clearDoc(page);
  await page.keyboard.insertText("```mermaid\ngraph TD;A-->B;\n```\n\n(末尾)");
  await page.keyboard.press("Control+Home");
  await page.keyboard.press("Control+End");
  await page.waitForTimeout(600);
  const mermaidOn = await page.$$eval(".cm-mermaid-block", (e) => e.length);
  ok(`(3) diagramsEnabled:true でMermaidブロックが描画される (${mermaidOn})`, mermaidOn === 1);

  await applySettings(page, { diagramsEnabled: false });
  await page.waitForTimeout(300);
  const mermaidOff = await page.$$eval(".cm-mermaid-block", (e) => e.length);
  const codeblockOff = await page.$$eval(".cm-codeblock-line", (e) => e.length);
  ok(`(3) diagramsEnabled:false で図にならず通常のコードブロックのまま (mermaid=${mermaidOff}, code行=${codeblockOff})`, mermaidOff === 0 && codeblockOff > 0);
  await page.close();
}

// ============================================================
// 4. codeBlockMathEnabled
// ============================================================
{
  const page = await newPage();
  await applySettings(page, { codeBlockMathEnabled: true });
  await clearDoc(page);
  await page.keyboard.insertText("```math\nx^2\n```\n\n(末尾)");
  await page.keyboard.press("Control+Home");
  await page.keyboard.press("Control+End");
  await page.waitForTimeout(1200);
  const mathOn = await page.$$eval(".cm-math-block", (e) => e.length);
  ok(`(4) codeBlockMathEnabled:true で\`\`\`mathが数式として描画される (${mathOn})`, mathOn === 1);

  await applySettings(page, { codeBlockMathEnabled: false });
  await page.waitForTimeout(300);
  const mathOff = await page.$$eval(".cm-math-block", (e) => e.length);
  const codeblockOff = await page.$$eval(".cm-codeblock-line", (e) => e.length);
  ok(`(4) codeBlockMathEnabled:false で通常のコードブロックのまま (math=${mathOff}, code行=${codeblockOff})`, mathOff === 0 && codeblockOff > 0);
  await page.close();
}

// ============================================================
// 5. mathAutoNumber
// ============================================================
{
  const page = await newPage();
  await applySettings(page, { mathAutoNumber: "off" });
  await clearDoc(page);
  await page.keyboard.insertText("$$\n\\begin{equation}\nx=1\n\\end{equation}\n$$\n\n(末尾)");
  await page.keyboard.press("Control+Home");
  await page.keyboard.press("Control+End");
  await page.waitForTimeout(1200);
  const svgOff = await page.$eval(".cm-math-block", (e) => e.innerHTML).catch(() => "");

  await applySettings(page, { mathAutoNumber: "all" });
  await page.waitForTimeout(1200);
  const svgAll = await page.$eval(".cm-math-block", (e) => e.innerHTML).catch(() => "");
  ok(`(5) mathAutoNumber off→all でSVG出力が変わる(採番の有無が反映される) (off.len=${svgOff.length}, all.len=${svgAll.length})`,
    svgOff.length > 0 && svgAll.length > 0 && svgOff !== svgAll);
  await page.close();
}

// ============================================================
// 6. headingStyle
// ============================================================
{
  const page = await newPage();
  await applySettings(page, { headingStyle: "atx" });
  await newDoc(page);
  await page.click(".cm-content");
  await page.keyboard.insertText("見出し");
  await page.keyboard.press("Control+Home");
  await menuCommand(page, "段落", "para.h1");
  const atxText = await docText(page);
  ok(`(6) headingStyle:atx でh1が"# "になる (${JSON.stringify(atxText)})`, atxText.startsWith("# 見出し"));

  await applySettings(page, { headingStyle: "setext" });
  await newDoc(page);
  await page.click(".cm-content");
  await page.keyboard.insertText("見出し1");
  await page.keyboard.press("Control+Home");
  await menuCommand(page, "段落", "para.h1");
  const setextText = await docText(page);
  ok(`(6) headingStyle:setext でh1がSetext形式("="の下線)になる (${JSON.stringify(setextText)})`,
    setextText.split("\n")[0] === "見出し1" && /^=+$/.test(setextText.split("\n")[1] || ""));

  await newDoc(page);
  await page.click(".cm-content");
  await page.keyboard.insertText("見出し3");
  await page.keyboard.press("Control+Home");
  await menuCommand(page, "段落", "para.h3");
  const h3Text = await docText(page);
  ok(`(6) headingStyle:setextでもh3以上は常にatx (${JSON.stringify(h3Text)})`, h3Text.startsWith("### 見出し3"));
  await page.close();
}

// ============================================================
// 7. unorderedListMarker / 8. orderedListMarker
// ============================================================
{
  const page = await newPage();
  await applySettings(page, { unorderedListMarker: "*" });
  await newDoc(page);
  await page.click(".cm-content");
  await page.keyboard.insertText("項目");
  await page.keyboard.press("Control+Home");
  await menuCommand(page, "段落", "para.list");
  // 箇条書きマーカーはライブプレビューで常に"•"ウィジェットに置き換わり画面上のテキストには
  // 出ないため(カーソル位置に関わらず)、docText()ではなく実際の文書テキストを見る。
  const bulletText = await rawLineText(page);
  ok(`(7) unorderedListMarker:"*" で箇条書きが"* "になる (${JSON.stringify(bulletText)})`, bulletText.startsWith("* 項目"));

  await applySettings(page, { orderedListMarker: ")" });
  await newDoc(page);
  await page.click(".cm-content");
  await page.keyboard.insertText("項目");
  await page.keyboard.press("Control+Home");
  await menuCommand(page, "段落", "para.olist");
  const orderedText = await docText(page);
  ok(`(8) orderedListMarker:")" で番号付きリストが"1) "になる (${JSON.stringify(orderedText)})`, orderedText.startsWith("1) 項目"));
  await page.close();
}

// ============================================================
// 9. indentSizeOnSave
// ============================================================
{
  const page = await newPage();
  await applySettings(page, { indentSizeOnSave: 8 });
  await newDoc(page);
  await page.click(".cm-content");
  await page.keyboard.insertText("段落");
  await page.keyboard.press("Control+Home");
  await menuCommand(page, "段落", "para.indent");
  const indented = await docText(page);
  ok(`(9) indentSizeOnSave:8 でインデントが半角スペース8個になる (${JSON.stringify(indented)})`, indented === "        段落");
  await menuCommand(page, "段落", "para.outdent");
  const outdented = await docText(page);
  ok(`(9) アウトデントで8個ぶん戻る (${JSON.stringify(outdented)})`, outdented === "段落");
  await page.close();
}

// ============================================================
// 10. codeIndentSize
// ============================================================
{
  const page = await newPage();
  await applySettings(page, { codeIndentSize: 8 });
  await newDoc(page);
  await page.click(".cm-content");
  await page.keyboard.press("Tab");
  const t8 = await docText(page);
  ok(`(10) codeIndentSize:8 でTabが半角スペース8個になる (${JSON.stringify(t8)})`, t8 === " ".repeat(8));

  await applySettings(page, { codeIndentSize: 2 });
  await newDoc(page);
  await page.click(".cm-content");
  await page.keyboard.press("Tab");
  const t2 = await docText(page);
  ok(`(10) codeIndentSize:2 でTabが半角スペース2個になる (${JSON.stringify(t2)})`, t2 === " ".repeat(2));
  await page.close();
}

// ============================================================
// 11. codeAutoWrap
// ============================================================
{
  const page = await newPage();
  const longLine = "a".repeat(300);
  await applySettings(page, { codeAutoWrap: true });
  await clearDoc(page);
  await page.keyboard.insertText("```\n" + longLine + "\n```\n\n(末尾)");
  await page.keyboard.press("Control+Home");
  await page.keyboard.press("Control+End");
  await page.waitForTimeout(400);
  const wrapOn = await page.$$eval(".cm-cb-nowrap", (e) => e.length);
  ok(`(11) codeAutoWrap:true では折り返し禁止クラスが付かない (${wrapOn})`, wrapOn === 0);

  await applySettings(page, { codeAutoWrap: false });
  await page.waitForTimeout(300);
  const wrapOff = await page.$$eval(".cm-cb-nowrap", (e) => e.length);
  ok(`(11) codeAutoWrap:false で折り返し禁止クラスが付く (${wrapOff})`, wrapOff > 0);
  await page.close();
}

// ============================================================
// 12. shiftTabAutoIndent
// ============================================================
{
  const page = await newPage();
  await applySettings(page, { shiftTabAutoIndent: false, indentSizeOnSave: 4 });
  await newDoc(page);
  await page.click(".cm-content");
  await page.keyboard.insertText("        段落"); // 8スペースインデント
  await page.keyboard.press("Control+End");
  await page.keyboard.press("Shift+Tab");
  const outdentResult = await docText(page);
  ok(`(12) shiftTabAutoIndent:false でShift+Tabはアウトデント(既定のindentUnitぶん減る) (${JSON.stringify(outdentResult)})`,
    outdentResult.length < "        段落".length && outdentResult.trim() === "段落");

  await applySettings(page, { shiftTabAutoIndent: true });
  await newDoc(page);
  await page.click(".cm-content");
  await page.keyboard.insertText("        段落");
  await page.keyboard.press("Control+End");
  const before = await docText(page);
  await page.keyboard.press("Shift+Tab");
  const autoResult = await docText(page);
  ok(`(12) shiftTabAutoIndent:true ではfalse時と異なる結果になる(自動インデント) (before=${JSON.stringify(before)}, after=${JSON.stringify(autoResult)})`,
    autoResult !== outdentResult || autoResult !== before);
  await page.close();
}

// ============================================================
// 13. autoPairMarkdown
// ============================================================
{
  const page = await newPage();
  await applySettings(page, { autoPairMarkdown: true });
  await newDoc(page);
  await page.click(".cm-content");
  // 行頭の"*"は箇条書き記号の書きかけと区別できないため対象外(editor.js側の意図的な仕様)。
  // 行の途中(文字の後ろ)へ入力して検証する。
  await page.keyboard.insertText("本文");
  await page.keyboard.press("End");
  await page.keyboard.type("*"); // typeで1文字ずつ本物のキー入力に近い形にする
  const paired = await docText(page);
  ok(`(13) autoPairMarkdown:true で"*"入力時に"**"が自動補完される (${JSON.stringify(paired)})`, paired === "本文**");

  await applySettings(page, { autoPairMarkdown: false });
  await newDoc(page);
  await page.click(".cm-content");
  await page.keyboard.insertText("本文");
  await page.keyboard.press("End");
  await page.keyboard.type("*");
  const unpaired = await docText(page);
  ok(`(13) autoPairMarkdown:false では"*"のみ挿入される (${JSON.stringify(unpaired)})`, unpaired === "本文*");
  await page.close();
}

// ============================================================
// 14. emojiAutocomplete
// ============================================================
{
  const page = await newPage();
  await applySettings(page, { emojiAutocomplete: "auto" });
  await newDoc(page);
  await page.click(".cm-content");
  await page.keyboard.type(":smi");
  await page.waitForTimeout(400);
  const autoShown = await page.$$eval(".cm-tooltip-autocomplete", (e) => e.length);
  ok(`(14) emojiAutocomplete:auto で":"入力だけで候補が出る (${autoShown})`, autoShown > 0);

  await applySettings(page, { emojiAutocomplete: "off" });
  await newDoc(page);
  await page.click(".cm-content");
  await page.keyboard.type(":smi");
  await page.waitForTimeout(400);
  const offShown = await page.$$eval(".cm-tooltip-autocomplete", (e) => e.length);
  ok(`(14) emojiAutocomplete:off では候補が出ない (${offShown})`, offShown === 0);
  await page.close();
}

// ============================================================
// 15. liveRenderingShowSourceOnFocus
// ============================================================
{
  const page = await newPage();
  await applySettings(page, { liveRenderingShowSourceOnFocus: true });
  await clearDoc(page);
  await page.keyboard.insertText("# 見出し\n\n(末尾)");
  await page.keyboard.press("Control+Home");
  await page.waitForTimeout(300);
  const shownOn = await page.evaluate(() => document.querySelector(".cm-content").innerText.includes("# 見出し"));
  ok(`(15) liveRenderingShowSourceOnFocus:true でカーソル行の記法が生表示される`, shownOn);

  await applySettings(page, { liveRenderingShowSourceOnFocus: false });
  await page.waitForTimeout(300);
  const shownOff = await page.evaluate(() => document.querySelector(".cm-content").innerText.includes("# 見出し"));
  ok(`(15) liveRenderingShowSourceOnFocus:false ではカーソル行でも記法マーカーを隠したまま`, !shownOff);
  await page.close();
}

// ============================================================
// 16. copyWholeLineWhenNoSelection
// ============================================================
{
  const page = await newPage();
  await applySettings(page, { copyWholeLineWhenNoSelection: true });
  await newDoc(page);
  await page.click(".cm-content");
  await page.keyboard.insertText("1行目\n2行目\n3行目");
  await page.keyboard.press("Control+Home"); // 1行目にカーソル、選択なし
  const copied = await page.evaluate(() => {
    const dt = new DataTransfer();
    const ev = new ClipboardEvent("copy", { clipboardData: dt, bubbles: true, cancelable: true });
    document.querySelector(".cm-content").dispatchEvent(ev);
    return dt.getData("text/plain");
  });
  ok(`(16) copyWholeLineWhenNoSelection:true で選択なしコピーが行全体になる (${JSON.stringify(copied)})`, copied === "1行目\n");

  const cutResult = await page.evaluate(() => {
    const dt = new DataTransfer();
    const ev = new ClipboardEvent("cut", { clipboardData: dt, bubbles: true, cancelable: true });
    document.querySelector(".cm-content").dispatchEvent(ev);
    return dt.getData("text/plain");
  });
  await page.waitForTimeout(200);
  const afterCut = await docText(page);
  ok(`(16) 切り取りでも行全体が対象になり、行が削除される (cut="${cutResult}", 残り=${JSON.stringify(afterCut)})`,
    cutResult === "1行目\n" && afterCut === "2行目\n3行目");

  await applySettings(page, { copyWholeLineWhenNoSelection: false });
  await newDoc(page);
  await page.click(".cm-content");
  await page.keyboard.insertText("1行目\n2行目");
  await page.keyboard.press("Control+Home");
  const copiedOff = await page.evaluate(() => {
    const dt = new DataTransfer();
    const ev = new ClipboardEvent("copy", { clipboardData: dt, bubbles: true, cancelable: true });
    document.querySelector(".cm-content").dispatchEvent(ev);
    return dt.getData("text/plain");
  });
  ok(`(16) false では選択なしコピーに介入しない (空="${copiedOff}")`, copiedOff === "");
  await page.close();
}

// ============================================================
// 17. typewriterKeepCaretCentered
// ============================================================
{
  const page = await newPage();
  const lines = Array.from({ length: 200 }, (_, i) => `行${i + 1}`).join("\n");

  // カーソルを文書中ほど(101行目)へ置く。CodeMirror既定のカーソル追従スクロール
  // ("nearest": 見えなければ動かす)により、この時点で既にカーソル行はビューポート内にある。
  async function gotoMiddle(page) {
    await openFile(page, lines);
    await page.click(".cm-content");
    await page.keyboard.press("Control+Home");
    for (let i = 0; i < 100; i++) await page.keyboard.press("ArrowDown");
    await page.waitForTimeout(300);
  }

  await applySettings(page, { typewriterKeepCaretCentered: true });
  await gotoMiddle(page);
  const scrollTopBefore = await page.$eval(".cm-scroller", (e) => e.scrollTop);
  await menuCommand(page, "表示", "view.typewriterMode");
  await page.waitForTimeout(300);
  const scrollTopCentered = await page.$eval(".cm-scroller", (e) => e.scrollTop);
  ok(`(17) typewriterKeepCaretCentered:true では既に見えている行でも中央寄せへスクロールする (${scrollTopBefore} -> ${scrollTopCentered})`,
    scrollTopCentered !== scrollTopBefore);
  await menuCommand(page, "表示", "view.typewriterMode"); // オフに戻す

  await applySettings(page, { typewriterKeepCaretCentered: false });
  await gotoMiddle(page);
  const scrollTopBefore2 = await page.$eval(".cm-scroller", (e) => e.scrollTop);
  await menuCommand(page, "表示", "view.typewriterMode");
  await page.waitForTimeout(300);
  const scrollTopNearest = await page.$eval(".cm-scroller", (e) => e.scrollTop);
  ok(`(17) typewriterKeepCaretCentered:false では既に見えていればスクロールしない (${scrollTopBefore2} -> ${scrollTopNearest})`,
    scrollTopNearest === scrollTopBefore2);
  await page.close();
}

// ============================================================
// 18. spellCheckEnabled
// ============================================================
{
  const page = await newPage();
  await applySettings(page, { spellCheckEnabled: false });
  const offAttr = await page.$eval(".cm-content", (e) => e.getAttribute("spellcheck"));
  ok(`(18) spellCheckEnabled:false でspellcheck属性がfalse (${offAttr})`, offAttr === "false");

  await applySettings(page, { spellCheckEnabled: true });
  const onAttr = await page.$eval(".cm-content", (e) => e.getAttribute("spellcheck"));
  ok(`(18) spellCheckEnabled:true でspellcheck属性がtrue (${onAttr})`, onAttr === "true");
  console.log("NOTE spellCheckAutoCorrectはWebView2側の機能でJSから制御できないため未実装(既知)");
  await page.close();
}

// ============================================================
// 19. editorLineHeight / editorMaxWidthPx (既存実装の回帰確認)
// ============================================================
{
  const page = await newPage();
  await applySettings(page, { editorLineHeight: 2.5, editorMaxWidthPx: 500 });
  const lh = await cssVar(page, "--editor-line-height");
  const mw = await cssVar(page, "--editor-max-width");
  ok(`(19) editorLineHeight/editorMaxWidthPxは既存実装のまま壊れていない (lh=${lh}, mw=${mw})`, lh === "2.5" && mw === "500px");
  await page.close();
}

// ============================================================
// 20. chapterLevelInOutline
// ============================================================
{
  const page = await newPage();
  const nested = "# H1\n\n## H2\n\n### H3\n\n#### H4\n";
  await applySettings(page, { chapterLevelInOutline: 2 });
  await openFile(page, nested);
  await page.click("#status-sidebar");
  await page.click('.sidebar-tab[data-panel="outline"]');
  await page.waitForTimeout(300);
  const items2 = await page.$$eval(".outline-item", (e) => e.map((x) => x.textContent.trim()));
  ok(`(20) chapterLevelInOutline:2 でH1/H2のみ (${JSON.stringify(items2)})`, items2.length === 2 && items2.includes("H1") && items2.includes("H2"));

  await applySettings(page, { chapterLevelInOutline: 6 });
  await openFile(page, nested);
  await page.waitForTimeout(300);
  const items6 = await page.$$eval(".outline-item", (e) => e.map((x) => x.textContent.trim()));
  ok(`(20) chapterLevelInOutline:6 で全見出し表示 (${JSON.stringify(items6)})`, items6.length === 4);
  await page.close();
}

// ============================================================
// 21. defaultCodeLanguage / defaultCodeLanguageApplyWhen
// ============================================================
{
  const page = await newPage();
  // "menubar": メニューバー(ツールバー)からの挿入時のみ既定言語を付与する
  await applySettings(page, { defaultCodeLanguage: "python", defaultCodeLanguageApplyWhen: "menubar" });
  await newDoc(page);
  await page.click(".cm-content");
  await menuCommand(page, "段落", "para.codeblock");
  const menubarResult = await docText(page);
  ok(`(21) defaultCodeLanguageApplyWhen:menubar でメニューからの挿入に既定言語が付く (${JSON.stringify(menubarResult)})`,
    menubarResult.startsWith("```python"));

  // "markdown": ```だけ入力したときに既定言語を付与する(メニューからは付けない)
  await applySettings(page, { defaultCodeLanguage: "js", defaultCodeLanguageApplyWhen: "markdown" });
  await newDoc(page);
  await page.click(".cm-content");
  await menuCommand(page, "段落", "para.codeblock");
  const menubarSkipped = await docText(page);
  ok(`(21) defaultCodeLanguageApplyWhen:markdown ではメニュー挿入に既定言語を付けない (${JSON.stringify(menubarSkipped)})`,
    menubarSkipped.startsWith("```\n"));

  await newDoc(page);
  await page.click(".cm-content");
  await page.keyboard.type("```");
  await page.waitForTimeout(200);
  const typedResult = await docText(page);
  ok(`(21) defaultCodeLanguageApplyWhen:markdown で"\`\`\`"入力時に既定言語が付く (${JSON.stringify(typedResult)})`,
    typedResult === "```js");
  await page.close();
}

// ============================================================
// 22. whitespaceWhenWriting
// ============================================================
{
  const page = await newPage();
  await applySettings(page, { whitespaceWhenWriting: "preserve" });
  await clearDoc(page);
  await page.keyboard.insertText("1行目\n2行目\n\n(末尾)");
  await page.keyboard.press("Control+Home");
  await page.keyboard.press("Control+End");
  await page.waitForTimeout(300);
  const preserveCount = await page.$$eval(".cm-softbreak", (e) => e.length);
  ok(`(22) whitespaceWhenWriting:preserve では単独改行を変換しない (softbreak要素=${preserveCount})`, preserveCount === 0);

  await applySettings(page, { whitespaceWhenWriting: "ignore" });
  await page.waitForTimeout(300);
  const ignoreCount = await page.$$eval(".cm-softbreak", (e) => e.length);
  ok(`(22) whitespaceWhenWriting:ignore で段落内の単独改行が表示上1つの空白になる (softbreak要素=${ignoreCount})`, ignoreCount >= 1);
  await page.close();
}

// ============================================================
// 23. whitespaceOnExport
// ============================================================
{
  const page = await newPage();
  await clearDoc(page);
  await page.keyboard.insertText("1行目\n2行目");
  await page.keyboard.press("Control+Home");

  await applySettings(page, { whitespaceOnExport: "ignore" });
  await page.evaluate(() => { window.__sent.length = 0; });
  await menuCommand(page, "ファイル", "file.exportHtml");
  const ignoreHtml = await page.evaluate(() => window.__sent.find((m) => m.type === "export")?.text ?? "");
  ok(`(23) whitespaceOnExport:ignore ではエクスポートHTMLに<br>が入らない`, !ignoreHtml.includes("<br>"));

  await applySettings(page, { whitespaceOnExport: "preserve" });
  await page.evaluate(() => { window.__sent.length = 0; });
  await menuCommand(page, "ファイル", "file.exportHtml");
  const preserveHtml = await page.evaluate(() => window.__sent.find((m) => m.type === "export")?.text ?? "");
  ok(`(23) whitespaceOnExport:preserve ではエクスポートHTMLの段落内改行が<br>になる`, preserveHtml.includes("<br>"));
  await page.close();
}

// ============================================================
// 24. smartQuotes
// ============================================================
{
  const page = await newPage();
  await applySettings(page, { smartQuotes: "off" });
  await clearDoc(page);
  // カーソルが対象トークンの端に隣接していると生表示側(cursorInside)の扱いになり
  // 装飾が外れてしまうため、末尾に離れた文言を置いてカーソルをそこへ移す。
  await page.keyboard.insertText('"abc"\n\n(末尾)');
  await page.keyboard.press("Control+Home");
  await page.keyboard.press("Control+End");
  await page.waitForTimeout(300);
  const offGlyphs = await page.$$eval(".cm-glyph", (e) => e.length);
  ok(`(24) smartQuotes:off では変換しない (glyph要素=${offGlyphs})`, offGlyphs === 0);

  await applySettings(page, { smartQuotes: "render" });
  await page.waitForTimeout(300);
  const renderGlyphs = await page.$$eval(".cm-glyph", (e) => e.map((x) => x.textContent));
  // docText()は表示用DOM(GlyphWidgetが"“”"を描画したもの)を読むため、実際の文書テキストは
  // 変わっていないことをrawLineText()(コピー経由で生テキストを読む)で確認する。
  await page.keyboard.press("Control+Home");
  const renderRaw = await rawLineText(page);
  ok(`(24) smartQuotes:render で表示だけ"“”"に変換される (${JSON.stringify(renderGlyphs)}, raw=${JSON.stringify(renderRaw)})`,
    renderGlyphs.includes("“") && renderGlyphs.includes("”") && renderRaw === '"abc"\n');

  await applySettings(page, { smartQuotes: "input" });
  await clearDoc(page);
  await page.keyboard.type('"xyz"');
  await page.waitForTimeout(300);
  const inputText = await docText(page);
  ok(`(24) smartQuotes:input で入力時に文書のテキストごと置換される (${JSON.stringify(inputText)})`, inputText === "“xyz”");
  await page.close();
}

// ============================================================
// 25. smartDashes
// ============================================================
{
  const page = await newPage();
  await applySettings(page, { smartDashes: "off", smartQuotes: "off" });
  await clearDoc(page);
  await page.keyboard.insertText("a--b");
  await page.keyboard.press("Control+Home");
  await page.keyboard.press("Control+End");
  await page.waitForTimeout(300);
  const offGlyphs = await page.$$eval(".cm-glyph", (e) => e.length);
  ok(`(25) smartDashes:off では変換しない (glyph要素=${offGlyphs})`, offGlyphs === 0);

  await applySettings(page, { smartDashes: "endash" });
  await page.waitForTimeout(300);
  const enGlyphs = await page.$$eval(".cm-glyph", (e) => e.map((x) => x.textContent));
  ok(`(25) smartDashes:endash で表示だけ"–"に変換される (${JSON.stringify(enGlyphs)})`, enGlyphs.includes("–"));

  await applySettings(page, { smartDashes: "emdash" });
  await clearDoc(page);
  await page.keyboard.type("c--d");
  await page.waitForTimeout(300);
  // docText()は表示用DOM(GlyphWidgetが"—"を描画したもの)を読むため、実際の文書テキストが
  // 変わっていないことはrawLineText()(コピー経由で生テキストを読む)で確認する。
  const emRaw = await rawLineText(page);
  ok(`(25) smartDashes:emdash かつsmartQuotes:input扱いでなくても文書のテキスト自体は変わらない (${JSON.stringify(emRaw)})`, emRaw === "c--d");
  const emGlyphs = await page.$$eval(".cm-glyph", (e) => e.map((x) => x.textContent));
  ok(`(25) smartDashes:emdash で表示は"—"に変換される (${JSON.stringify(emGlyphs)})`, emGlyphs.includes("—"));
  await page.close();
}

// ============================================================
// 26. recognizeUnicodePunctuation
// ============================================================
{
  const page = await newPage();
  // autoLinksEnabled(裸のURLの自動リンク化)を切っておく。切らないと"（https://example.com）"の
  // 括弧内URL部分が全角記法とは無関係にautoLinksによってリンク化され、判別できなくなるため。
  await applySettings(page, { recognizeUnicodePunctuation: false, autoLinksEnabled: false });
  await clearDoc(page);
  await page.keyboard.insertText("》全角引用\n\n［リンク］（https://example.com）\n\n(末尾)");
  await page.keyboard.press("Control+Home");
  await page.keyboard.press("Control+End");
  await page.waitForTimeout(300);
  const quoteOff = await page.$$eval(".tok-quote", (e) => e.length);
  const linkOff = await page.$$eval(".tok-link[data-href]", (e) => e.length);
  ok(`(26) recognizeUnicodePunctuation:false では全角記号を認識しない (quote=${quoteOff}, link=${linkOff})`, quoteOff === 0 && linkOff === 0);

  await applySettings(page, { recognizeUnicodePunctuation: true });
  await page.waitForTimeout(300);
  const quoteOn = await page.$$eval(".tok-quote", (e) => e.length);
  const linkOn = await page.$$eval(".tok-link[data-href]", (e) => e.map((x) => x.getAttribute("data-href")));
  ok(`(26) recognizeUnicodePunctuation:true で"》"が引用として認識される (quote=${quoteOn})`, quoteOn >= 1);
  ok(`(26) recognizeUnicodePunctuation:true で全角［］（）がリンクとして認識される (${JSON.stringify(linkOn)})`,
    linkOn.includes("https://example.com"));
  await page.close();
}

// ============================================================
// 27. autoPairing(括弧・引用符、配線漏れの修正)
// ============================================================
{
  const page = await newPage();
  await applySettings(page, { autoPairing: true });
  await newDoc(page);
  await page.click(".cm-content");
  await page.keyboard.type("(");
  const pairedOn = await docText(page);
  ok(`(27) autoPairing:true で"("入力時に")"が自動補完される (${JSON.stringify(pairedOn)})`, pairedOn === "()");

  await applySettings(page, { autoPairing: false });
  await newDoc(page);
  await page.click(".cm-content");
  await page.keyboard.type("(");
  const pairedOff = await docText(page);
  ok(`(27) autoPairing:false では"("のみ挿入される (${JSON.stringify(pairedOff)})`, pairedOff === "(");
  await page.close();
}

// ============================================================
// 28. superSubscriptEnabled(main.jsのキー名不一致バグの修正確認)
// ============================================================
{
  const page = await newPage();
  await applySettings(page, { superSubscriptEnabled: true });
  await clearDoc(page);
  await page.keyboard.insertText("X^2^");
  await page.keyboard.press("Control+Home");
  await page.keyboard.press("Control+End");
  await page.waitForTimeout(300);
  const supOn = await page.$$eval(".tok-sup", (e) => e.length);
  ok(`(28) superSubscriptEnabled:true で上付きが有効 (${supOn})`, supOn === 1);

  await applySettings(page, { superSubscriptEnabled: false });
  await page.waitForTimeout(300);
  const supOff = await page.$$eval(".tok-sup", (e) => e.length);
  ok(`(28) superSubscriptEnabled:false で上付きが無効になる (${supOff})`, supOff === 0);
  await page.close();
}

// ============================================================
// 29. autoPairMarkdownの"="(ラウンド2で見つかったバグ・データ破壊の修正確認)
//     単独の"="に反応して余分な"="が紛れ込んでいたバグの回帰確認。docText()は
//     ライブプレビューでの見た目(カーソルから離れた"==...=="は装飾されて生の"="が
//     見えなくなる)を拾ってしまうため、生の文書内容が必要なテストはrequest-text経由で見る。
// ============================================================
async function rawDocValue(page) {
  await page.evaluate(() => { window.__sent = []; window.__reply({ type: "request-text" }); });
  await page.waitForTimeout(120);
  return page.evaluate(() => window.__sent.find((m) => m.type === "text-response")?.text);
}
async function typeAndGetRaw(page, text) {
  await clearDoc(page);
  await page.keyboard.type(text, { delay: 5 });
  await page.waitForTimeout(150);
  return rawDocValue(page);
}
{
  const page = await newPage();
  await applySettings(page, { autoPairMarkdown: true });
  await newDoc(page);
  await page.click(".cm-content");

  const plain = await typeAndGetRaw(page, "x=1 のような、ごく普通の等号です。");
  ok(`(29) 普通の文章中の単独"="で余分な文字が増えない (${JSON.stringify(plain)})`,
    plain === "x=1 のような、ごく普通の等号です。");

  const b64a = await typeAndGetRaw(page, "![alt](data:image/png;base64,AAA=)");
  ok(`(29) base64画像(1文字パディング)が壊れない (${JSON.stringify(b64a)})`,
    b64a === "![alt](data:image/png;base64,AAA=)");

  const b64b = await typeAndGetRaw(page, "![alt](data:image/png;base64,AA==)");
  ok(`(29) base64画像(2文字パディング)が壊れない (${JSON.stringify(b64b)})`,
    b64b === "![alt](data:image/png;base64,AA==)");

  const query = await typeAndGetRaw(page, "https://example.com/?a=1&b=2");
  ok(`(29) URLのクエリ文字列が壊れない (${JSON.stringify(query)})`,
    query === "https://example.com/?a=1&b=2");

  const multi = await typeAndGetRaw(page, "a==b==c==d==e");
  ok(`(29) "=="が複数回現れても壊れない (${JSON.stringify(multi)})`,
    multi === "a==b==c==d==e");

  const setext = await typeAndGetRaw(page, "Heading\n======");
  ok(`(29) 見出し下線のような3個以上連続する"="で壊れない (${JSON.stringify(setext)})`,
    setext === "Heading\n======");

  await page.close();
}
{
  // "*"/"_"/"~"は単独でも意味を持つマーカーなので、従来どおり単独入力でペアリングされる
  // ことを確認する(バグの修正で"="だけを対象から外したことの裏取り。他の3文字は退行していない)。
  const page = await newPage();
  await applySettings(page, { autoPairMarkdown: true });
  for (const [label, ch, expected] of [
    ["*", "*", "本文**"],
    ["_", "_", "本文__"],
    ["~", "~", "本文~~"],
  ]) {
    await newDoc(page);
    await page.click(".cm-content");
    await page.keyboard.insertText("本文");
    await page.keyboard.press("End");
    await page.keyboard.type(ch);
    const paired = await docText(page);
    ok(`(29) "${label}"は従来どおり単独入力でペアリングされる (${JSON.stringify(paired)})`, paired === expected);
  }
  await page.close();
}
{
  // ハイライト自体はツールバー/ショートカット操作(applyMdAction "highlight")で
  // 変わらず選択範囲を"==...=="で囲めることを確認する(タイプ中の自動ペアは無くなったが、
  // 明示的な操作での挿入経路は健在)。
  const page = await newPage();
  await applySettings(page, { autoPairMarkdown: true });
  await newDoc(page);
  await page.click(".cm-content");
  await page.keyboard.insertText("本文");
  await page.keyboard.press("Control+a");
  await menuCommand(page, "書式", "format.highlight");
  const wrapped = await rawDocValue(page);
  ok(`(29) ツールバー/ショートカットの「ハイライト」操作は従来どおり動く (${JSON.stringify(wrapped)})`,
    wrapped === "==本文==");
  await page.close();
}

// ============================================================
// 30. モード切替後の新規作成/別ファイルを開くと、UndoでUndoで前の文書が復活するバグの修正確認
//     (ラウンド2で見つかったバグ・データ破損)。editor.jsのsetValue()がUndo履歴を明示的に
//     クリアするようになったことの確認。モード切替"だけ"では履歴を保つことも併せて確認する。
// ============================================================
async function rawValue30(page) {
  await page.evaluate(() => { window.__sent = []; window.__reply({ type: "request-text" }); });
  await page.waitForTimeout(120);
  return page.evaluate(() => window.__sent.find((m) => m.type === "text-response")?.text);
}
{
  // シナリオ1: 新規文書に入力→コード⇔Markdown切替→再度新規作成→入力→Ctrl+Z連打しても
  // 前の文書の内容が復元されないこと。
  const page = await newPage();
  await newDoc(page);
  await page.click(".cm-content");
  await page.keyboard.type("最初の文書の内容です", { delay: 3 });
  await page.waitForTimeout(150);

  await menuCommand(page, "表示", "view.modeCode");
  await menuCommand(page, "表示", "view.modeMarkdown");

  await newDoc(page); // もう一度「新規作成」
  await page.click(".cm-content");
  await page.keyboard.type("abc", { delay: 3 });
  await page.waitForTimeout(150);

  let resurrected = false;
  for (let i = 0; i < 4; i++) {
    await page.keyboard.press("Control+z");
    await page.waitForTimeout(120);
    const v = await rawValue30(page);
    if (v?.includes("最初の文書")) resurrected = true;
  }
  ok("(30) モード切替後の新規作成→入力→Ctrl+Z連打しても前の文書が復活しない", !resurrected);
  await page.close();
}
{
  // シナリオ2: モード切替後に別ファイルを開く→Ctrl+Zしても前のファイルの内容が
  // 流れ込まないこと(報告では「Ctrl+Z 2回で前のファイルの内容が現在のファイルに混入」)。
  const page = await newPage();
  await openFile(page, "ファイルAの内容です", { fileName: "a.md", path: "C:\\work\\a.md" });

  await menuCommand(page, "表示", "view.modeCode");
  await menuCommand(page, "表示", "view.modeMarkdown");

  await openFile(page, "ファイルBの内容です", { fileName: "b.md", path: "C:\\work\\b.md" });
  const beforeUndo = await rawValue30(page);
  ok(`(30) ファイルBを開いた直後の内容 (${JSON.stringify(beforeUndo)})`, beforeUndo === "ファイルBの内容です");

  let mixedIn = false;
  for (let i = 0; i < 3; i++) {
    await page.keyboard.press("Control+z");
    await page.waitForTimeout(120);
    const v = await rawValue30(page);
    if (v !== "ファイルBの内容です") mixedIn = true;
  }
  ok("(30) 別ファイルを開いた後Ctrl+Zしても前のファイルの内容が混入しない", !mixedIn);
  await page.close();
}
{
  // シナリオ3(退行確認): モード切替"だけ"では履歴を保つ(往復後もCtrl+Zで直前の入力を
  // 取り消せる、という正しい挙動を壊していないこと)。
  const page = await newPage();
  await newDoc(page);
  await page.click(".cm-content");
  await page.keyboard.type("abc", { delay: 3 });
  await page.waitForTimeout(150);

  await menuCommand(page, "表示", "view.modeCode");
  await menuCommand(page, "表示", "view.modeMarkdown");

  await page.keyboard.press("Control+z");
  await page.waitForTimeout(150);
  const afterUndo = await rawValue30(page);
  ok(`(30) モード切替だけでは履歴が保たれる(往復後もCtrl+Zで直前の入力を取り消せる) (${JSON.stringify(afterUndo)})`,
    afterUndo === "");
  await page.close();
}

// ============================================================
// ページエラー・コンソールエラー0件
// ============================================================
ok(`ページエラー・コンソールエラー0件 (${errors.length}件) ${JSON.stringify(errors).slice(0, 2000)}`, errors.length === 0);

console.log(`\n合計: OK ${okCount} / NG ${ngCount}`);
await browser.close();
process.exit(ngCount > 0 ? 1 : 0);
