// distを生成する唯一の経路。
// index.html・style.css・icon.svgをdistへコピーし、main.jsをesbuildでバンドルする
// (splitting有効)。CodeMirror等の依存はすべてここでdistに同梱するため、
// 実行時に外部CDNへは一切到達しない。開発サーバーもこのdistを配信する。
const fs = require("fs");
const path = require("path");
const esbuild = require("esbuild");

const serve = process.argv.includes("--serve");
const watch = process.argv.includes("--watch") || serve;

const staticFiles = ["index.html", "style.css", "themes.css", "icon.svg"];

function copyStaticFiles() {
  fs.mkdirSync("dist", { recursive: true });
  for (const f of staticFiles) {
    fs.copyFileSync(path.join("src", f), path.join("dist", f));
  }
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

const patchLezerMarkdownTable = {
  name: "patch-lezer-markdown-table",
  setup(build) {
    build.onLoad({ filter: /@lezer[\\/]markdown[\\/].*\.js$/ }, (args) => {
      const source = fs.readFileSync(args.path, "utf8");
      if (!source.includes("delimiterLine")) return null;
      if (!source.includes(LEZER_MD_DELIMITER_LINE_ORIGINAL)) {
        throw new Error(
          `@lezer/markdown の表の区切り行の正規表現が見つかりませんでした(${args.path})。` +
          "ライブラリの更新で該当箇所が変わった可能性があります。" +
          "scripts/build.js の patchLezerMarkdownTable を見直してください。"
        );
      }
      return {
        contents: source.replace(LEZER_MD_DELIMITER_LINE_ORIGINAL, LEZER_MD_DELIMITER_LINE_PATCHED),
        loader: "js",
      };
    });
  },
};

const buildOptions = {
  entryPoints: ["src/main.js"],
  bundle: true,
  format: "esm",
  splitting: true,
  outdir: "dist",
  define: { PACKAGE_VERSION: JSON.stringify(mathjaxVersion) },
  plugins: [patchLezerMarkdownTable],
};

async function run() {
  copyStaticFiles();
  generateFileTypesCs();

  if (watch) {
    const ctx = await esbuild.context(buildOptions);
    await ctx.watch();
    for (const f of staticFiles) {
      fs.watchFile(path.join("src", f), () => copyStaticFiles());
    }
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
