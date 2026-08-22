// distを生成する唯一の経路。
// index.html・style.css・icon.svgをdistへコピーし、main.jsをesbuildでバンドルする
// (splitting有効)。CodeMirror等の依存はすべてここでdistに同梱するため、
// 実行時に外部CDNへは一切到達しない。開発サーバーもこのdistを配信する。
const fs = require("fs");
const path = require("path");
const esbuild = require("esbuild");

const serve = process.argv.includes("--serve");
const watch = process.argv.includes("--watch") || serve;

const staticFiles = ["index.html", "settings-window.html", "help-window.html", "style.css", "themes.css", "icon.svg"];

function copyStaticFiles() {
  fs.mkdirSync("dist", { recursive: true });
  for (const f of staticFiles) {
    fs.copyFileSync(path.join("src", f), path.join("dist", f));
  }
}

// 取扱説明書(docs/取扱説明書.md)をdist/manual.mdへコピーする(F1ヘルプ画面用)。
// dist/に置くのは次の理由から:
//   ・Pane.csproj CopyDistToPublishDirがdist/以下を丸ごとpublish出力へコピーするため、
//     追加のcsproj変更なしにZip配布物(scripts/release.ps1)へ確実に含まれる。
//   ・開発中(npm run buildしてdist/を静的サーバで配信する形)でも、他のstaticFilesと
//     同じ経路でそのまま読める(fetch("manual.md")で取得できる)。
//   ・WebView2のSetVirtualHostNameToFolderMapping(Pane/MainForm.cs等)は既にdist/を
//     pane.localへマッピング済みのため、ここに置くだけでhelp-entry.jsから
//     追加のマッピング設定なしに読み込める。
// ファイル名をmanual.mdへ変える(日本語ファイル名のままコピーしない)のは、fetch呼び出し側の
// URLエンコード・大文字小文字を気にせず済ませるため。
// 別エージェントが同時に執筆中でdocs/取扱説明書.mdがまだ存在しない場合もビルドを失敗させず、
// 警告を出すだけにする(存在しなければコピーをスキップし、次回のcopyManualMarkdown呼び出しで
// 改めて拾う。watchモード中に後から作成された場合は下のfs.watchFileが検知する)。
const MANUAL_SOURCE = path.join("docs", "取扱説明書.md");
const MANUAL_DEST = path.join("dist", "manual.md");
function copyManualMarkdown() {
  fs.mkdirSync("dist", { recursive: true });
  if (!fs.existsSync(MANUAL_SOURCE)) {
    console.warn(`警告: ${MANUAL_SOURCE} が見つかりません(ヘルプ画面は表示できません)`);
    return;
  }
  fs.copyFileSync(MANUAL_SOURCE, MANUAL_DEST);
}

// mathjax-full の components/version.js は、バンドル時に PACKAGE_VERSION が定義されて
// いないと eval("require") 経由でNode専用コード(package.jsonの動的読み込み)を実行しよう
// とし、ブラウザ上で "require is not defined" を投げる。MathJax公式のwebpack設定と同様に、
// ビルド時定数として注入して回避する(mathjax-full自身のドキュメントに明記された対処法)。
const mathjaxVersion = require("mathjax-full/package.json").version;

const FILE_TYPES_SOURCE = path.join("src", "file-types.js");
const FILE_TYPES_CS_OUTPUT = path.join("Pane", "FileTypes.generated.cs");

// src/file-types.js(対応ファイル種別の単一ソース)を読み込み、
// { FILE_TYPES, CATEGORIES } を取り出す。
//
// src/file-types.js はESM(export構文)で書かれており、各言語の load フィールドは
// @codemirror/lang-* 等への動的importを含む。これを素朴に require() すると
// export構文でSyntaxErrorになり、かといってNodeの動的import()に頼ると
// package.jsonに "type": "module" が無い環境では実行するNodeのバージョンによって
// 挙動が変わってしまう(モジュール種別の自動判定に対応していない古いNodeでは
// 失敗し、対応していても "MODULE_TYPELESS_PACKAGE_JSON" 警告と再パースの
// オーバーヘッドが出る)。
//
// そのためNode側の挙動には頼らず、プロジェクトが既にビルドに使っている
// esbuildでCommonJS形式に変換してから読み込む。@codemirror/* 等のパッケージは
// packages: "external" によりバンドルへ含めず require(...) 呼び出しのまま残す
// (呼ばれた場合はそれぞれのpackage.jsonが持つ"require"条件で解決できる)。
// ここで実際に使うのは FILE_TYPES のメタデータ(id/label/category/extensions)
// だけで load 関数そのものは一度も呼び出さないため、legacy-modes側のimportが
// 解決できるかどうかはここでは問題にならない(呼ばれなければ評価されない)。
function loadFileTypes() {
  const result = esbuild.buildSync({
    entryPoints: [FILE_TYPES_SOURCE],
    bundle: true,
    platform: "node",
    format: "cjs",
    packages: "external",
    write: false,
    logLevel: "silent",
  });
  const code = result.outputFiles[0].text;
  const mod = { exports: {} };
  const fn = new Function("module", "exports", "require", code);
  fn(mod, mod.exports, require);
  return mod.exports;
}

// C#の文字列リテラルとして安全な形にエスケープする
// (拡張子は英数字のみの想定だが、念のため最低限の対応をしておく)。
function csharpStringLiteral(value) {
  return `"${String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

// src/file-types.js の FILE_TYPES から Pane/FileTypes.generated.cs を生成する。
// C#側(Pane/FolderService.cs)がPaneを開けるファイルの拡張子一覧を判定するのに使う
// HashSet<string> をここから供給し、JS/C#間の二重管理を解消する。
// 内容が変わっていない場合はファイルへ書き込まない(タイムスタンプだけ更新して
// 無駄にC#側の再ビルドを走らせないため)。
function generateFileTypesCs() {
  const { FILE_TYPES, CATEGORIES } = loadFileTypes();

  const lines = [];
  lines.push("// このファイルは scripts/build.js が src/file-types.js から自動生成する。");
  lines.push("// 直接編集しないこと(次回ビルド時に内容が上書きされます)。");
  lines.push("// 生成元: src/file-types.js の FILE_TYPES(対応ファイル種別の単一ソース)");
  lines.push("");
  lines.push("namespace Pane;");
  lines.push("");
  lines.push("/// <summary>");
  lines.push("/// Paneが開けるファイルの拡張子(拡張子なし・小文字)の一覧。");
  lines.push("/// src/file-types.js の FILE_TYPES から自動生成される、拡張子分類の単一ソース。");
  lines.push("/// </summary>");
  lines.push("internal static class FileTypes");
  lines.push("{");
  lines.push("    public static readonly HashSet<string> OpenableExtensions = new(StringComparer.OrdinalIgnoreCase)");
  lines.push("    {");
  // カテゴリ→言語の順に並べ、生成元(file-types.js)と同じ見通しのコメントを付ける。
  for (const categoryId of Object.keys(CATEGORIES)) {
    const typesInCategory = FILE_TYPES.filter((t) => t.category === categoryId);
    if (typesInCategory.length === 0) continue;
    lines.push(`        // ${CATEGORIES[categoryId]}`);
    for (const type of typesInCategory) {
      const exts = type.extensions.map(csharpStringLiteral).join(", ");
      lines.push(`        ${exts}, // ${type.label}`);
    }
  }
  lines.push("    };");
  lines.push("}");
  lines.push("");

  const content = lines.join("\n");
  const existing = fs.existsSync(FILE_TYPES_CS_OUTPUT) ? fs.readFileSync(FILE_TYPES_CS_OUTPUT, "utf8") : null;
  if (existing !== content) {
    fs.writeFileSync(FILE_TYPES_CS_OUTPUT, content);
    console.log(`generated: ${FILE_TYPES_CS_OUTPUT}`);
  }
}

// @lezer/markdown の表(GFM Table)の区切り行判定を修正するesbuildプラグイン。
//
// 上流の正規表現が、区切り行の末尾にある空白・タブを許していない:
//   /^[>\s]*\|?(\s*:?-+:?\s*\|)+(\s*:?-+:?\s*)?$/
// このため「| --- | --- |   」のように末尾へ空白が付いた表が、まったく表として
// 認識されなくなる。表を桁揃えして整形するツールやエディタは末尾に空白を残すことが
// あり、実際にユーザーの文書で表が描画されない原因になっていた。
// GFMの仕様では行末の空白は無視されるべきなので、末尾に \s* を足して許容する。
//
// 依存を書き換えるため、対象の正規表現が見つからなければ**ビルドを失敗させる**。
// ライブラリ更新で該当箇所が変わったことに気づかないまま、修正が黙って外れるのを防ぐ。
const LEZER_MD_DELIMITER_LINE_ORIGINAL =
  String.raw`/^[>\s]*\|?(\s*:?-+:?\s*\|)+(\s*:?-+:?\s*)?$/`;
const LEZER_MD_DELIMITER_LINE_PATCHED =
  String.raw`/^[>\s]*\|?(\s*:?-+:?\s*\|)+(\s*:?-+:?\s*)?\s*$/`;

// 同じく @lezer/markdown の不具合。表の直後に空行を挟まず「---」を書くと、
// その行がsetext見出しの下線として先に解釈され、表全体がH2見出しに化けてしまう。
//
//   | 項目 | 内容 |
//   | --- | --- |
//   | a | b |
//   ---            ← ここで表が見出しに化ける
//
// SetextHeadingParser.nextLine が、同じリーフブロックを既に表パーサが掴んでいるか
// どうかを見ていないのが原因。表として確定している(TableParserのrowsが配列)場合は
// setext見出しとして扱わないようにする。GitHubでは同じ入力が表+水平線として描画される。
const LEZER_MD_SETEXT_ORIGINAL =
  "let underline = line.depth < cx.stack.length ? -1 : isSetextUnderline(line);";
const LEZER_MD_SETEXT_PATCHED =
  "let underline = (line.depth < cx.stack.length || (leaf.parsers && leaf.parsers.some(p => p && Array.isArray(p.rows)))) ? -1 : isSetextUnderline(line);";

// 上記だけだと表は壊れなくなるものの、今度は「---」の行が表の3列目のない行として
// 表の中に吸い込まれてしまう(表の最後に「---」だけの行が増えて見える)。
// リーフブロックの終了判定(endLeafBlock)にある水平線の判定が、breaking=true のときに
// 「setext見出しの下線を優先する」例外を通ってしまい、水平線として表を終わらせられない
// のが原因。表として確定しているリーフでは、その例外を通さない(breaking=false)ようにして
// 「---」で表を終わらせ、水平線として描画されるようにする。
const LEZER_MD_ENDLEAF_HR_ORIGINAL =
  "(p, line) => isHorizontalRule(line, p, true) >= 0,";
const LEZER_MD_ENDLEAF_HR_PATCHED =
  "(p, line, leaf) => isHorizontalRule(line, p, !(leaf && leaf.parsers && leaf.parsers.some(x => x && Array.isArray(x.rows)))) >= 0,";

const patchLezerMarkdownTable = {
  name: "patch-lezer-markdown-table",
  setup(build) {
    build.onLoad({ filter: /@lezer[\\/]markdown[\\/].*\.js$/ }, (args) => {
      const source = fs.readFileSync(args.path, "utf8");
      if (!source.includes("delimiterLine")) return null;
      for (const [label, needle] of [
        ["表の区切り行の正規表現", LEZER_MD_DELIMITER_LINE_ORIGINAL],
        ["setext見出しの判定", LEZER_MD_SETEXT_ORIGINAL],
        ["リーフブロック終了判定の水平線", LEZER_MD_ENDLEAF_HR_ORIGINAL],
      ]) {
        if (!source.includes(needle)) {
          throw new Error(
            `@lezer/markdown の「${label}」が見つかりませんでした(${args.path})。` +
            "ライブラリの更新で該当箇所が変わった可能性があります。" +
            "scripts/build.js の patchLezerMarkdownTable を見直してください。"
          );
        }
      }
      return {
        contents: source
          .replace(LEZER_MD_DELIMITER_LINE_ORIGINAL, LEZER_MD_DELIMITER_LINE_PATCHED)
          .replace(LEZER_MD_SETEXT_ORIGINAL, LEZER_MD_SETEXT_PATCHED)
          .replace(LEZER_MD_ENDLEAF_HR_ORIGINAL, LEZER_MD_ENDLEAF_HR_PATCHED),
        loader: "js",
      };
    });
  },
};

const buildOptions = {
  // main.js: 本体ウィンドウ(index.html)。settings-entry.js: 設定専用ウィンドウ
  // (settings-window.html、Pane/SettingsWindow.cs)。help-entry.js: 取扱説明書専用ウィンドウ
  // (help-window.html、Pane/HelpWindow.cs)。splitting: trueのため、
  // settings.js/commands.js/file-types.js/md-to-html.js等の共通コードはチャンクとして自動的に共有される
  // (help-entry.jsはCodeMirrorのエディタ本体(@codemirror/view)は一切importしないため、
  // Markdown→HTML変換に必要な@codemirror/state・@codemirror/language・@codemirror/lang-markdown・
  // @lezer/markdownだけがバンドルに含まれる)。
  entryPoints: ["src/main.js", "src/settings-entry.js", "src/help-entry.js"],
  bundle: true,
  format: "esm",
  splitting: true,
  outdir: "dist",

  // ---- 圧縮 ----
  // これまで一切圧縮せずに出していたため main.js が424KBあり、仕様書 第8.4節の
  // 「初期ロードJS 分割後300KB以内」を満たしていなかった。JSはダウンロードだけでなく
  // 構文解析とコンパイルの時間もソースの量にほぼ比例するため、起動時間(実機の計測では
  // Navigateから初期描画完了までの約2.7秒が起動全体の8割)に直接効く。
  //
  // esbuildの minify: true は3つの処理をまとめて有効にするが、ここでは
  // minifyIdentifiers(ローカル変数・関数名を1〜2文字へ短縮する処理)だけを外している。
  // 理由は2つ:
  //
  //   1. 例外のスタックトレースが読めなくなる。実機の不具合調査はログが頼りで、
  //      JSエラーの発生箇所が1文字の名前だらけになると原因を追えない。
  //
  //   2. 名前を保つesbuildの機能(keepNames: true)は使えない。keepNamesは関数定義ごとに
  //      __name(fn, "名前")というラッパーを挟む実装で、CodeMirrorのように更新のたび
  //      大量のクロージャを生成するコードでは実行時のコストになる。実測すると
  //      1万行文書での1文字入力が 5.8ms → 13.2ms と2倍以上に悪化し、
  //      仕様書 第8.4節の入力遅延の要件を脅かした(.verify-blockfield-recompute.mjsで検出)。
  //
  // 空白・コメントの除去と構文の圧縮だけでも 424KB → 290KB になり、300KB以内に収まる。
  // 入力遅延にも悪化はない(実測 5.6〜5.8ms)。
  //
  // legalComments は既定("eof")のまま。OSSライセンスの表記コメントはファイル末尾へ
  // まとめられ、消えはしない。
  minifyWhitespace: true,
  minifySyntax: true,
  minifyIdentifiers: false,
  define: { PACKAGE_VERSION: JSON.stringify(mathjaxVersion) },
  plugins: [patchLezerMarkdownTable],
};

async function run() {
  copyStaticFiles();
  copyManualMarkdown();
  generateFileTypesCs();

  if (watch) {
    const ctx = await esbuild.context(buildOptions);
    await ctx.watch();
    for (const f of staticFiles) {
      fs.watchFile(path.join("src", f), () => copyStaticFiles());
    }
    fs.watchFile(MANUAL_SOURCE, () => copyManualMarkdown());
    fs.watchFile(FILE_TYPES_SOURCE, () => generateFileTypesCs());
    if (serve) {
      const { host, port } = await ctx.serve({ servedir: "dist", port: 8000 });
      console.log(`Pane dev server: http://${host}:${port}`);
    } else {
      console.log("watching for changes...");
    }
  } else {
    await esbuild.build(buildOptions);
  }
}

run();
