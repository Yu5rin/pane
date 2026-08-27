// バグ修正の検証: コードモードで .sh(シェルスクリプト)等の StreamLanguage 系言語を
// 開いても折りたたみマーカーが出ない問題。ポートは8970。
//
// 背景(ユーザー実機報告):
//   legacy-modes 由来の言語(file-types.js で StreamLanguage.define(...) しているもの。
//   shell・PowerShell・バッチ等)は Lezer の構文木を持たず foldNodeProp ベースの
//   折りたたみ情報を提供しない。ところが旧実装は「言語が有るか」だけで構文木ベースと
//   インデントベース(indentFoldService、改善③)を切り替えていたため、「言語は有る→
//   構文木ベースを使う→しかし範囲が1件も取れない」となり、マーカーが一切出なかった。
//   修正: 判定を「構文木ベースの折りたたみが使える言語か(= StreamLanguage でないか)」
//   (treeFoldingAvailable、state.facet(language) instanceof StreamLanguage)に改め、
//   StreamLanguage 系言語ではインデントベースの折りたたみへフォールバックする。
//
// 検証項目:
//   (A) .sh を開くと言語が「シェルスクリプト」として認識され、if/for/関数などの
//       インデント構造の開始行に折りたたみマーカー(.cm-fold-marker2)が出る
//   (B) マーカーをクリックすると畳まれ(内容が非表示)、再クリックで開く。
//       Alt-[(foldable()経由の標準コマンド)でも畳める
//   (C) .ps1(PowerShell、StreamLanguage 系の代表としてもう1言語)でもマーカーが出る
//   (D) .js(Lezer言語)の回帰確認: 折りたたみが従来どおり構文木ベースで動く。
//       構文ブロックの開始行にだけマーカーが出て、「インデントだけ深くて構文ブロックで
//       ない行」(演算子継続行)にはマーカーが増えていないこと
//   (E) .md(Markdownモード)に影響がない(マーカー0個・コードモード用ガター無し)こと
//   (F) スクリーンショットを .shots/shellfold-*.png へ保存
//   (G) ページエラー・コンソールエラー0件(各節に分散)
import pw from "playwright";
import fs from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const { chromium } = pw;

const PORT = 8970;
const BASE = `http://localhost:${PORT}/index.html`;
// スクリーンショットの置き場は、このファイルの場所から決める。以前は開発環境の絶対パス
// (/workspace/pane/.shots)を直書きしていたため、別の場所へ置いたリポジトリでは
// フォルダを作れずスクリプトが起動直後に落ちていた(CIで実際にこれで失敗した)。
const SHOTS = join(dirname(fileURLToPath(import.meta.url)), ".shots");
const browser = await chromium.launch();
let okCount = 0, ngCount = 0;
const ok = (label, cond, extra = "") => { console.log(`${cond ? "OK  " : "NG  "} ${label}${extra ? " " + extra : ""}`); if (cond) okCount++; else ngCount++; };

// ---- 共通ヘルパー(.verify-codefold.mjs のモック手法を流用) ----
async function newPage() {
  const page = await browser.newPage();
  const errors = [];
  const consoleErrors = [];
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
  await page.goto(BASE, { waitUntil: "load" });
  await page.waitForSelector(".cm-content", { timeout: 15000 });
  await page.waitForTimeout(400);
  return { page, errors, consoleErrors };
}
async function openFile(page, fileName, text) {
  await page.evaluate(({ fileName, text }) => window.__reply({
    type: "file-opened", fileName, path: "C:\\work\\" + fileName, text,
    encoding: "UTF-8", lineEnding: "CRLF", readOnly: false,
  }), { fileName, text });
  await page.waitForTimeout(500);
}
// マーカー記号("+"/"−")を一時的に隠してから本文テキストを読む(.verify-codefold.mjs と同じ手法)
async function contentText(page) {
  return page.evaluate(() => {
    const markers = [...document.querySelectorAll(".cm-fold-marker2")];
    const prevDisplay = markers.map((m) => m.style.display);
    markers.forEach((m) => { m.style.display = "none"; });
    const text = document.querySelector(".cm-content").innerText;
    markers.forEach((m, i) => { m.style.display = prevDisplay[i]; });
    return text;
  });
}
async function clickFirstMarker(page, wantTitle) {
  return page.evaluate((wantTitle) => {
    const span = document.querySelector(`.cm-fold-marker2[title="${wantTitle}"]`);
    if (span) { span.click(); return true; }
    return false;
  }, wantTitle);
}
// 各マーカーが付いている行のテキスト一覧(行頭に混ざるマーカー記号は除去して返す)
async function markerLines(page) {
  return page.evaluate(() =>
    [...document.querySelectorAll(".cm-fold-marker2")].map((m) => {
      const line = m.closest(".cm-line");
      return line ? line.textContent.replace(/[+\u2212]/g, "") : "";
    })
  );
}
async function markerCount(page) {
  return page.evaluate(() => document.querySelectorAll(".cm-fold-marker2").length);
}
async function statusMode(page) { return page.textContent("#status-mode"); }

fs.mkdirSync(SHOTS, { recursive: true });

const SH_DOC = [
  "#!/bin/sh",
  "# デプロイ前の確認スクリプト",
  'if [ -f /etc/passwd ]; then',
  '    echo "found"',
  "    for i in 1 2 3; do",
  '        echo "loop $i"',
  "    done",
  "fi",
  "",
  "deploy() {",
  '    local target="$1"',
  '    echo "deploy to $target"',
  "}",
].join("\n");

const PS1_DOC = [
  "function Get-Total {",
  "    $sum = 0",
  "    foreach ($i in 1..5) {",
  "        $sum += $i",
  "    }",
  "    return $sum",
  "}",
].join("\n");

// (D)用: 構文ブロック(関数・if・オブジェクト)と、「インデントだけ深くて構文ブロックで
// ない」演算子継続行(const sum)を混在させる。構文木ベースなら継続行の先頭にマーカーは
// 出ない(BinaryExpression に foldNodeProp が無い)が、インデントベースだと出てしまう。
const JS_DOC = [
  "function toast(msg) {",
  "  console.log(msg);",
  "  if (msg) {",
  "    return true;",
  "  }",
  "  return false;",
  "}",
  "",
  "const sum = 1 +",
  "    2 +",
  "    3;",
  "",
  "const config = {",
  "  retries: 3,",
  "};",
].join("\n");

const MD_DOC = [
  "# 見出し",
  "",
  "- 親項目",
  "    - 子項目",
  "        - 孫項目",
  "",
  "本文の段落。",
].join("\n");

// ========================================================================
// (A) .sh: 言語認識と折りたたみマーカーの出現
// ========================================================================
{
  const { page, errors, consoleErrors } = await newPage();
  await openFile(page, "check.sh", SH_DOC);
  const sm = await statusMode(page);
  ok(`(A) .shを開くと言語が「シェルスクリプト」(実際="${sm}")`, (sm || "").includes("シェルスクリプト"));
  const lines = await markerLines(page);
  ok(`(A) マーカー総数=3(if/for/関数)(実際=${lines.length})`, lines.length === 3, `[${lines.join(" | ")}]`);
  ok("(A) if行にマーカー", lines.some((t) => t.includes("if [ -f /etc/passwd ]")));
  ok("(A) for行にマーカー", lines.some((t) => t.includes("for i in 1 2 3")));
  ok("(A) 関数定義行(deploy)にマーカー", lines.some((t) => t.includes("deploy() {")));
  await page.screenshot({ path: `${SHOTS}/shellfold-sh-markers.png` });

  // ---- (B) クリックで畳む・開く ----
  const clicked = await clickFirstMarker(page, "Fold line");
  await page.waitForTimeout(300);
  ok("(B) 最初のマーカー(if行)をクリックできた", clicked);
  let text = await contentText(page);
  ok('(B) 畳んだ後、内側の行(echo "found")が非表示', !text.includes('echo "found"'));
  ok("(B) 畳んだ後も後続の関数(deploy)は見えている", text.includes("deploy() {"));
  await page.screenshot({ path: `${SHOTS}/shellfold-sh-folded.png` });
  const reopened = await clickFirstMarker(page, "Unfold line");
  await page.waitForTimeout(300);
  ok("(B) 「+」マーカーを再クリックできた", reopened);
  text = await contentText(page);
  ok('(B) 再クリックで開き、内側の行が再表示', text.includes('echo "found"'));

  // ---- (B) Alt-[ (foldable()経由の標準コマンド)でも畳める ----
  await page.click(".cm-line:has-text('deploy() {')");
  await page.keyboard.press("Alt+[");
  await page.waitForTimeout(300);
  text = await contentText(page);
  ok("(B) Alt-[で関数(deploy)を畳める", !text.includes("local target"));
  await page.keyboard.press("Alt+]");
  await page.waitForTimeout(300);
  text = await contentText(page);
  ok("(B) Alt-]で開ける", text.includes("local target"));

  ok("(G) [.sh] ページエラー0件", errors.length === 0, errors.join(" / "));
  ok("(G) [.sh] コンソールエラー0件", consoleErrors.length === 0, consoleErrors.join(" / "));
  await page.close();
}

// ========================================================================
// (C) .ps1 (PowerShell、StreamLanguage 系の代表としてもう1言語)
// ========================================================================
{
  const { page, errors, consoleErrors } = await newPage();
  await openFile(page, "total.ps1", PS1_DOC);
  const sm = await statusMode(page);
  ok(`(C) .ps1を開くと言語がPowerShell(実際="${sm}")`, (sm || "").includes("PowerShell"));
  const lines = await markerLines(page);
  ok(`(C) マーカー総数=2(function/foreach)(実際=${lines.length})`, lines.length === 2, `[${lines.join(" | ")}]`);
  ok("(C) function行にマーカー", lines.some((t) => t.includes("function Get-Total")));
  ok("(C) foreach行にマーカー", lines.some((t) => t.includes("foreach ($i in 1..5)")));
  const clicked = await clickFirstMarker(page, "Fold line");
  await page.waitForTimeout(300);
  const text = await contentText(page);
  ok("(C) クリックで畳める", clicked && !text.includes("$sum = 0"));
  ok("(G) [.ps1] ページエラー0件", errors.length === 0, errors.join(" / "));
  ok("(G) [.ps1] コンソールエラー0件", consoleErrors.length === 0, consoleErrors.join(" / "));
  await page.close();
}

// ========================================================================
// (D) .js (Lezer言語)の回帰確認: 構文木ベースのまま・マーカーが増えていない
// ========================================================================
{
  const { page, errors, consoleErrors } = await newPage();
  await openFile(page, "app.js", JS_DOC);
  const lines = await markerLines(page);
  // 構文木ベースで畳める行は function / if / オブジェクトリテラルの3行だけのはず。
  // インデントベースが誤って効いていると「const sum = 1 +」(演算子継続行)にも
  // マーカーが出てしまい、総数が4になる。
  ok(`(D) マーカー総数=3(構文ブロックのみ)(実際=${lines.length})`, lines.length === 3, `[${lines.join(" | ")}]`);
  ok("(D) function行にマーカー", lines.some((t) => t.includes("function toast")));
  ok("(D) if行にマーカー", lines.some((t) => t.includes("if (msg)")));
  ok("(D) オブジェクトリテラル行にマーカー", lines.some((t) => t.includes("const config = {")));
  ok("(D) 演算子継続行(const sum)にマーカーが増えていない", !lines.some((t) => t.includes("const sum")));
  // 畳む挙動も従来どおりであること(構文木ベース: if を畳むと「{...}」相当で中身が隠れる)
  const clicked = await clickFirstMarker(page, "Fold line");
  await page.waitForTimeout(300);
  const text = await contentText(page);
  ok("(D) クリックで従来どおり畳める", clicked && !text.includes("console.log(msg)"));
  ok("(G) [.js] ページエラー0件", errors.length === 0, errors.join(" / "));
  ok("(G) [.js] コンソールエラー0件", consoleErrors.length === 0, consoleErrors.join(" / "));
  await page.close();
}

// ========================================================================
// (E) .md (Markdownモード)に影響がないこと
// ========================================================================
{
  const { page, errors, consoleErrors } = await newPage();
  await openFile(page, "note.md", MD_DOC);
  const sm = await statusMode(page);
  ok(`(E) .mdはMarkdownモード(実際="${sm}")`, (sm || "").includes("Markdown"));
  const n = await markerCount(page);
  ok(`(E) 折りたたみマーカー0個(実際=${n})`, n === 0);
  // コードモード用の行番号ガターが出ていないこと(codeModeExtrasが空のまま)
  const hasLineNumbers = await page.evaluate(() => !!document.querySelector(".cm-lineNumbers"));
  ok("(E) 行番号ガター(コードモード用)が無い", !hasLineNumbers);
  // ライブプレビュー(見出し装飾。実DOMのクラスは.tok-h1)が生きていること
  const hasHeaderDeco = await page.evaluate(() => !!document.querySelector(".cm-content .tok-h1"));
  ok("(E) 見出しのライブプレビュー装飾が生きている", hasHeaderDeco);
  ok("(G) [.md] ページエラー0件", errors.length === 0, errors.join(" / "));
  ok("(G) [.md] コンソールエラー0件", consoleErrors.length === 0, consoleErrors.join(" / "));
  await page.close();
}

await browser.close();
console.log(`\n合計: OK=${okCount} NG=${ngCount}`);
process.exit(ngCount === 0 ? 0 : 1);
