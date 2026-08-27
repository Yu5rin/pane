// src/file-types.js 全面洗い直しの検証スクリプト(ローカル検証用・コミット対象外)。
// ポート8151で配信中の dist/ (node scripts/build.js 済み)に対して実行する。
//
// (a)は設定画面(拡張子の関連付けツリー)の検証のため、独立ウィンドウ化された
// settings-window.htmlを直接開く(.verify-settings.mjs / .verify-settingswindow.mjsと
// 同じ流儀)。(b)(c)(d)はCodeMirror本体(エディタ)が要るため、従来どおりindex.htmlを使う。
import pw from "playwright";
const { chromium } = pw;
const browser = await chromium.launch();
const errors = [];

const ok = (l, c) => console.log(`${c ? "OK  " : "NG  "} ${l}`);
const results = [];
const record = (l, c) => { results.push([l, !!c]); ok(l, c); };

function attachErrors(p) {
  p.on("pageerror", (e) => errors.push(String(e.stack || e)));
  p.on("console", (m) => { if (m.type() === "error") errors.push("console: " + m.text()); });
}
function installBridge() {
  const listeners = [];
  window.__sent = [];
  window.chrome = {
    webview: {
      postMessage: (m) => { window.__sent.push(m); },
      addEventListener: (_t, fn) => listeners.push(fn),
    },
  };
  window.__reply = (data) => listeners.forEach((fn) => fn({ data }));
}

// ==================================================================
// (a) ユーザー報告の10件が設定画面のツリーに存在する
// ==================================================================
{
  const settingsPage = await browser.newPage();
  attachErrors(settingsPage);
  await settingsPage.addInitScript(installBridge);
  await settingsPage.goto("http://localhost:8151/settings-window.html");
  await settingsPage.waitForTimeout(800);
  record("設定画面が開く", (await settingsPage.$(".settings-modal")) !== null);

  await settingsPage.evaluate(() => window.__reply({
    type: "settings",
    theme: "light", editorFontSize: 15, editorFontFamily: "", startupBehavior: "blank",
    calloutsEnabled: true, superSubscriptEnabled: true, highlightEnabled: true,
    inlineMathEnabled: true, mathAutoNumberEnabled: false, strictMode: false,
    codeBlockLineNumbers: true, autoPairing: true, showWordCount: true,
    defaultCopyFormat: "markdown", preloadOnStartup: false,
    associatedExtensions: [], keyBindings: {},
    defaultEncoding: "utf-8", defaultLineEnding: "crlf", displayMode: "window",
    lightTheme: "default", darkTheme: "default", customCssPath: "",
  }));
  await settingsPage.waitForTimeout(400);

  const cats = await settingsPage.$$eval(".settings-nav-item", (e) => e.map((x) => x.textContent.trim()));
  const assocCat = cats.findIndex((c) => c.includes("関連付け"));
  record("「関連付け」カテゴリがある", assocCat >= 0);
  await settingsPage.click(`.settings-nav-item >> nth=${assocCat}`);
  await settingsPage.waitForTimeout(400);

  const catRows = await settingsPage.$$eval(".ft-category", (e) => e.length);
  const langRows = await settingsPage.$$eval(".ft-lang", (e) => e.length);
  const extRows = await settingsPage.$$eval(".ft-row-ext", (e) => e.length);
  record(`分類(第1階層)が7件 (${catRows})`, catRows === 7);
  record(`言語(第2階層)が90件以上 (${langRows})`, langRows >= 90);
  record(`拡張子(第3階層)が220件以上 (${extRows})`, extRows >= 220);

  const REPORTED = ["manifest", "axaml", "csproj", "css", "json", "js", "props", "cache", "db", "config"];
  const allExts = await settingsPage.$$eval('input[data-ext]', (e) => e.map((x) => x.dataset.ext));
  for (const ext of REPORTED) {
    record(`(a) ユーザー報告の拡張子 ".${ext}" がツリーに存在する`, allExts.includes(ext));
  }
  await settingsPage.close();
}

const page = await browser.newPage();
attachErrors(page);
await page.addInitScript(installBridge);
await page.goto("http://localhost:8151/index.html");
await page.waitForTimeout(700);

// ==================================================================
// (b) 代表的な拡張子でファイルを開いたとき、期待どおりのモードになる(20種類以上)
// ==================================================================
async function open(fileName) {
  await page.evaluate(({ fileName, text }) => window.__reply({
    type: "file-opened", fileName, path: "C:\\work\\" + fileName, text,
    encoding: "UTF-8", lineEnding: "CRLF", readOnly: false,
  }), { fileName, text: "sample content\nline2\n" });
  await page.waitForTimeout(300);
}
function mode() { return page.textContent("#status-mode"); }

// 期待値は "startsWith" で判定する(コードモードは「コード (言語名)」のように
// 言語名が付記されるため。src/main.js の formatModeLabel 相当の仕様)。
const MODE_CASES = [
  ["a.csproj", "コード"],
  ["a.axaml", "コード"],
  ["a.props", "コード"],
  ["a.config", "コード"],
  ["a.manifest", "コード"],
  ["a.db", "プレーンテキスト"],
  ["a.cache", "プレーンテキスト"],
  ["a.vue", "コード"],
  ["a.svelte", "コード"],
  ["a.astro", "コード"],
  ["a.cshtml", "コード"],
  ["a.aspx", "コード"],
  ["a.sln", "プレーンテキスト"],
  ["a.http", "コード"],
  ["a.rest", "コード"],
  ["a.rst", "プレーンテキスト"],
  ["a.md", "Markdown"],
  ["a.cmake", "コード"],
  ["a.pgsql", "コード"],
  ["a.plsql", "コード"],
  ["a.graphql", "プレーンテキスト"],
  ["a.gitignore", "プレーンテキスト"],
  // Dockerfile/Makefile: "." を含まないファイル名は @codemirror/language の
  // LanguageDescription.matchFilename が要求する正規表現 /\.([^.]+)$/ に
  // そもそもマッチしないため、拡張子をfile-types.jsに登録していても
  // コードモードとしては検出できない(既知の制約。詳細は src/file-types.js
  // 冒頭のコメント、および今回の最終報告を参照)。よってプレーンテキストが正。
  ["Dockerfile", "プレーンテキスト"],
  ["Makefile", "プレーンテキスト"],
  ["a.js", "コード"],
];
for (const [fn, expected] of MODE_CASES) {
  await open(fn);
  const m = await mode();
  const c = expected === "Markdown" ? m === "Markdown" : m.startsWith(expected);
  record(`(b) ${fn} が ${expected}: (実際: ${m})`, c);
}

// ==================================================================
// (c) load を持つ言語で実際にシンタックスハイライトが効く(代表5言語)
// ==================================================================
const HIGHLIGHT_CASES = [
  ["a.csproj", "namespace Foo { public class Bar {} }\n<Project></Project>"],
  ["a.py", "def foo():\n    return 1\n"],
  ["a.rs", "fn main() {\n    let x = 1;\n}\n"],
  ["a.yaml", "key: value\nlist:\n  - a\n  - b\n"],
  ["a.sql", "SELECT * FROM foo WHERE id = 1;\n"],
];
for (const [fn, text] of HIGHLIGHT_CASES) {
  await page.evaluate(({ fileName, text }) => window.__reply({
    type: "file-opened", fileName, path: "C:\\work\\" + fileName, text,
    encoding: "UTF-8", lineEnding: "CRLF", readOnly: false,
  }), { fileName: fn, text });
  await page.waitForTimeout(400);
  // CodeMirrorのHighlightStyle.define()は "ͼX" のようなハッシュ化クラス名を
  // 生成する(cm-*固定ではない)ため、.cm-line内のspan要素の有無で判定する。
  const spanCount = await page.$$eval(".cm-content .cm-line span", (e) => e.length);
  record(`(c) ${fn} でハイライトのspanが生成される (${spanCount}個)`, spanCount > 0);
}

// ==================================================================
// (d) load が失敗する言語が無いこと(全言語で load() を呼ぶ)
// ==================================================================
// 専用の検証用エンドポイント(/__verify/loaders-entry.js)はビルド成果物(dist/)に
// 存在しないため、代わりにindex.html読み込み時に実際にブラウザへ読み込まれた
// ESMチャンク(esbuildのcode splittingでハッシュ化されたファイル名になる)を
// performance資源エントリから洗い出し、FILE_TYPESをexportしているものを
// 動的import()して直接使う(製品コードには一切手を入れない)。
const loaderResult = await page.evaluate(async () => {
  const jsUrls = performance.getEntriesByType("resource")
    .map((e) => e.name)
    .filter((u) => /\.js(\?|$)/.test(u));
  let FILE_TYPES = null;
  let foundUrl = null;
  // export名(FILE_TYPES)では探せない。バンドルを圧縮(minify)するとチャンク間のexport名は
  // 短い別名へ置き換えられるため。中身の形——「id(文字列)とextensions(配列)を持つ
  // オブジェクトが多数入った配列」——で判定する。
  const looksLikeFileTypes = (v) =>
    Array.isArray(v) && v.length > 20 &&
    v.every((t) => t && typeof t.id === "string" && Array.isArray(t.extensions));
  for (const url of jsUrls) {
    try {
      const mod = await import(url);
      for (const value of Object.values(mod)) {
        if (!looksLikeFileTypes(value)) continue;
        FILE_TYPES = value;
        foundUrl = url;
        break;
      }
      if (FILE_TYPES) break;
    } catch { /* このチャンクはFILE_TYPESを持たない、または直接importできない */ }
  }
  if (!FILE_TYPES) return { error: "FILE_TYPESをexportするモジュールが見つからない", candidates: jsUrls };
  const failures = [];
  let checked = 0;
  for (const type of FILE_TYPES) {
    if (!type.load) continue;
    checked++;
    try {
      const res = await type.load();
      if (!res) failures.push([type.id, "returned falsy"]);
    } catch (e) {
      failures.push([type.id, String(e && e.message || e)]);
    }
  }
  return { checked, total: FILE_TYPES.length, failures, foundUrl };
});
record(`(d-前提) FILE_TYPESをexportするモジュールを発見 (${loaderResult.foundUrl ?? loaderResult.error})`, !loaderResult.error);
if (!loaderResult.error) {
  record(`(d) load保持言語 ${loaderResult.checked}/${loaderResult.total} 件すべて成功`, loaderResult.failures.length === 0);
  if (loaderResult.failures.length > 0) {
    for (const [id, msg] of loaderResult.failures) console.log(`  NG load: ${id} -> ${msg}`);
  }
}

// ==================================================================
// (e) ページエラー・コンソールエラーが0件
// ==================================================================
record(`(e) ページエラー・コンソールエラー0件: ${JSON.stringify(errors)}`, errors.length === 0);

// ==================================================================
// まとめ
// ==================================================================
const failCount = results.filter(([, c]) => !c).length;
console.log(`\n--- 合計 ${results.length}件中 NG ${failCount}件 ---`);
await browser.close();
process.exit(failCount > 0 ? 1 : 0);
