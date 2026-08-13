// 対応ファイル種別の単一ソース(Single Source of Truth)。
//
// これまで「コードモードの対応言語一覧」は src/languages.js に、
// 「サイドバーに表示してよい拡張子一覧」は Pane/FolderService.cs に、それぞれ
// 個別にハードコードされており二重管理になっていた。本ファイルは両者が参照する
// 唯一の定義元とし、
//   - src/languages.js         … ここから CodeMirror 用の LanguageDescription を組み立てる
//   - Pane/FileTypes.generated.cs … scripts/build.js がビルド時にここから自動生成する
// という形に一本化する。設定画面の「関連付ける拡張子」選択(カテゴリ→言語→拡張子の
// 3階層チェックボックス)にもこの配列をそのまま使う想定。
//
// 各エントリの形:
//   id         内部ID(英数字・小文字)。LanguageDescription.name にもそのまま使う。
//   label      設定画面のチェックボックスに出す表示名。
//   category   下記 CATEGORIES のいずれかのキー。
//   extensions ドットなし・小文字の拡張子配列。全エントリを通して重複禁止(後述)。
//   load       CodeMirror の言語サポートを返す非同期ローダー。動的importにして、
//              使われない言語のコードを初期バンドルに含めない(既存方針を踏襲)。
//              シンタックスハイライト対象にしない場合(プレーンテキスト扱い)は null。
//
// 注意(Node側で本ファイルを読み込む scripts/build.js 向け):
// load は @codemirror/lang-* 等への動的import式を「クロージャとして」保持しているだけで、
// このモジュール自体を読み込んだだけでは一切実行・解決されない。そのため
// ブラウザ専用パッケージが read できるかどうかを Node 側は気にする必要はない。
// ただし StreamLanguage.define(...) の形を作るために本ファイル冒頭で
// "@codemirror/language" を静的importしている点だけは、読み込み元(Node/バンドラ)
// 双方でこのパッケージ自体は解決できる必要がある(package.json の dependencies に
// 既に含まれており、CJS/ESM 両方のエントリを持つため問題にならない)。
import { StreamLanguage } from "@codemirror/language";

// カテゴリID→日本語表示名。設定画面の3階層チェックボックスの最上位に使う。
export const CATEGORIES = {
  markdown: "マークダウン",
  text: "テキスト",
  programming: "プログラミング言語",
  script: "スクリプト・シェル",
  markup: "マークアップ・スタイルシート",
  data: "データ・設定ファイル",
  other: "その他",
};

export const FILE_TYPES = [
  // ── マークダウン ──────────────────────────────────────────
  {
    id: "markdown",
    label: "Markdown",
    category: "markdown",
    extensions: ["md", "markdown", "mdown", "mkd", "mmd"],
    load: () => import("@codemirror/lang-markdown").then((m) => m.markdown()),
  },

  // ── テキスト ──────────────────────────────────────────────
  {
    id: "plaintext",
    label: "プレーンテキスト",
    category: "text",
    extensions: ["txt", "text", "log"],
    load: null, // ハイライト無し。プレーンテキストとして開く。
  },

  // ── プログラミング言語 ────────────────────────────────────
  {
    id: "javascript",
    label: "JavaScript",
    category: "programming",
    extensions: ["js", "jsx", "mjs", "cjs"],
    load: () => import("@codemirror/lang-javascript").then((m) => m.javascript({ jsx: true })),
  },
  {
    id: "typescript",
    label: "TypeScript",
    category: "programming",
    extensions: ["ts", "tsx", "mts", "cts"],
    load: () => import("@codemirror/lang-javascript").then((m) => m.javascript({ typescript: true, jsx: true })),
  },
  {
    id: "python",
    label: "Python",
    category: "programming",
    extensions: ["py", "pyw", "pyi"],
    load: () => import("@codemirror/lang-python").then((m) => m.python()),
  },
  {
    id: "java",
    label: "Java",
    category: "programming",
    extensions: ["java"],
    load: () => import("@codemirror/lang-java").then((m) => m.java()),
  },
  {
    id: "c",
    label: "C",
    category: "programming",
    // C++ 側は cpp/cc/cxx/hpp/hh/hxx を持つので "h" はC専用として扱う(重複回避)。
    extensions: ["c", "h"],
    load: () => import("@codemirror/lang-cpp").then((m) => m.cpp()),
  },
  {
    id: "cpp",
    label: "C++",
    category: "programming",
    extensions: ["cpp", "cc", "cxx", "hpp", "hh", "hxx"],
    load: () => import("@codemirror/lang-cpp").then((m) => m.cpp()),
  },
  {
    id: "csharp",
    label: "C#",
    category: "programming",
    extensions: ["cs", "csx"],
    load: () => import("@codemirror/legacy-modes/mode/clike").then((m) => StreamLanguage.define(m.csharp)),
  },
  {
    id: "objectivec",
    label: "Objective-C",
    category: "programming",
    extensions: ["m", "mm"],
    load: () => import("@codemirror/legacy-modes/mode/clike").then((m) => StreamLanguage.define(m.objectiveC)),
  },
  {
    id: "go",
    label: "Go",
    category: "programming",
    extensions: ["go"],
    load: () => import("@codemirror/legacy-modes/mode/go").then((m) => StreamLanguage.define(m.go)),
  },
  {
    id: "rust",
    label: "Rust",
    category: "programming",
    extensions: ["rs"],
    load: () => import("@codemirror/lang-rust").then((m) => m.rust()),
  },
  {
    id: "ruby",
    label: "Ruby",
    category: "programming",
    extensions: ["rb", "rake", "gemspec"],
    load: () => import("@codemirror/legacy-modes/mode/ruby").then((m) => StreamLanguage.define(m.ruby)),
  },
  {
    id: "php",
    label: "PHP",
    category: "programming",
    extensions: ["php", "phtml"],
    load: () => import("@codemirror/lang-php").then((m) => m.php()),
  },
  {
    id: "perl",
    label: "Perl",
    category: "programming",
    extensions: ["pl", "pm", "t"],
    load: () => import("@codemirror/legacy-modes/mode/perl").then((m) => StreamLanguage.define(m.perl)),
  },
  {
    id: "swift",
    label: "Swift",
    category: "programming",
    extensions: ["swift"],
    load: () => import("@codemirror/legacy-modes/mode/swift").then((m) => StreamLanguage.define(m.swift)),
  },
  {
    id: "kotlin",
    label: "Kotlin",
    category: "programming",
    extensions: ["kt", "kts"],
    load: () => import("@codemirror/legacy-modes/mode/clike").then((m) => StreamLanguage.define(m.kotlin)),
  },
  {
    id: "scala",
    label: "Scala",
    category: "programming",
    extensions: ["scala", "sc"],
    load: () => import("@codemirror/legacy-modes/mode/clike").then((m) => StreamLanguage.define(m.scala)),
  },
  {
    id: "vb",
    label: "Visual Basic",
    category: "programming",
    extensions: ["vb"],
    load: () => import("@codemirror/legacy-modes/mode/vb").then((m) => StreamLanguage.define(m.vb)),
  },
  {
    id: "vbscript",
    label: "VBScript",
    category: "programming",
    extensions: ["vbs"],
    load: () => import("@codemirror/legacy-modes/mode/vbscript").then((m) => StreamLanguage.define(m.vbScript)),
  },
  {
    id: "lua",
    label: "Lua",
    category: "programming",
    extensions: ["lua"],
    load: () => import("@codemirror/legacy-modes/mode/lua").then((m) => StreamLanguage.define(m.lua)),
  },
  {
    id: "r",
    label: "R",
    category: "programming",
    extensions: ["r"],
    load: () => import("@codemirror/legacy-modes/mode/r").then((m) => StreamLanguage.define(m.r)),
  },
  {
    id: "julia",
    label: "Julia",
    category: "programming",
    extensions: ["jl"],
    load: () => import("@codemirror/legacy-modes/mode/julia").then((m) => StreamLanguage.define(m.julia)),
  },
  {
    id: "haskell",
    label: "Haskell",
    category: "programming",
    extensions: ["hs", "lhs"],
    load: () => import("@codemirror/legacy-modes/mode/haskell").then((m) => StreamLanguage.define(m.haskell)),
  },
  {
    id: "erlang",
    label: "Erlang",
    category: "programming",
    extensions: ["erl", "hrl"],
    load: () => import("@codemirror/legacy-modes/mode/erlang").then((m) => StreamLanguage.define(m.erlang)),
  },
  {
    id: "clojure",
    label: "Clojure",
    category: "programming",
    extensions: ["clj", "cljs", "cljc", "edn"],
    load: () => import("@codemirror/legacy-modes/mode/clojure").then((m) => StreamLanguage.define(m.clojure)),
  },
  {
    id: "commonlisp",
    label: "Common Lisp",
    category: "programming",
    extensions: ["lisp", "cl", "el"],
    load: () => import("@codemirror/legacy-modes/mode/commonlisp").then((m) => StreamLanguage.define(m.commonLisp)),
  },
  {
    id: "scheme",
    label: "Scheme",
    category: "programming",
    extensions: ["scm", "ss"],
    load: () => import("@codemirror/legacy-modes/mode/scheme").then((m) => StreamLanguage.define(m.scheme)),
  },
  {
    id: "groovy",
    label: "Groovy",
    category: "programming",
    extensions: ["groovy", "gradle"],
    load: () => import("@codemirror/legacy-modes/mode/groovy").then((m) => StreamLanguage.define(m.groovy)),
  },
  {
    id: "coffeescript",
    label: "CoffeeScript",
    category: "programming",
    extensions: ["coffee"],
    load: () => import("@codemirror/legacy-modes/mode/coffeescript").then((m) => StreamLanguage.define(m.coffeeScript)),
  },
  {
    id: "pascal",
    label: "Pascal",
    category: "programming",
    extensions: ["pas", "pp"],
    load: () => import("@codemirror/legacy-modes/mode/pascal").then((m) => StreamLanguage.define(m.pascal)),
  },
  {
    id: "fortran",
    label: "Fortran",
    category: "programming",
    extensions: ["f", "f90", "f95", "f03"],
    load: () => import("@codemirror/legacy-modes/mode/fortran").then((m) => StreamLanguage.define(m.fortran)),
  },
  {
    id: "cobol",
    label: "COBOL",
    category: "programming",
    extensions: ["cob", "cbl", "cpy"],
    load: () => import("@codemirror/legacy-modes/mode/cobol").then((m) => StreamLanguage.define(m.cobol)),
  },
  {
    id: "tcl",
    label: "Tcl",
    category: "programming",
    extensions: ["tcl"],
    load: () => import("@codemirror/legacy-modes/mode/tcl").then((m) => StreamLanguage.define(m.tcl)),
  },
  {
    id: "verilog",
    label: "Verilog",
    category: "programming",
    extensions: ["v", "sv", "svh"],
    load: () => import("@codemirror/legacy-modes/mode/verilog").then((m) => StreamLanguage.define(m.verilog)),
  },
  {
    id: "vhdl",
    label: "VHDL",
    category: "programming",
    extensions: ["vhd", "vhdl"],
    load: () => import("@codemirror/legacy-modes/mode/vhdl").then((m) => StreamLanguage.define(m.vhdl)),
  },
  {
    id: "asm",
    label: "アセンブリ",
    category: "programming",
    extensions: ["s", "asm"],
    load: () => import("@codemirror/legacy-modes/mode/gas").then((m) => StreamLanguage.define(m.gas)),
  },
  {
    id: "d",
    label: "D",
    category: "programming",
    extensions: ["d"],
    load: () => import("@codemirror/legacy-modes/mode/d").then((m) => StreamLanguage.define(m.d)),
  },
  {
    id: "crystal",
    label: "Crystal",
    category: "programming",
    extensions: ["cr"],
    load: () => import("@codemirror/legacy-modes/mode/crystal").then((m) => StreamLanguage.define(m.crystal)),
  },
  {
    id: "elm",
    label: "Elm",
    category: "programming",
    extensions: ["elm"],
    load: () => import("@codemirror/legacy-modes/mode/elm").then((m) => StreamLanguage.define(m.elm)),
  },
  {
    // OCaml と F# は legacy-modes/mllike では別関数(oCaml/fSharp)として提供されており、
    // 拡張子の意味も異なる(.ml/.mli は OCaml、.fs/.fsi/.fsx は F#)ため、
    // 仕様書の但し書きに従いあえて別エントリに分けた(1エントリにまとめると
    // 「.fsx を開いたのに oCaml ハイライトになる」といった誤りを生むため)。
    id: "ocaml",
    label: "OCaml",
    category: "programming",
    extensions: ["ml", "mli"],
    load: () => import("@codemirror/legacy-modes/mode/mllike").then((m) => StreamLanguage.define(m.oCaml)),
  },
  {
    id: "fsharp",
    label: "F#",
    category: "programming",
    extensions: ["fs", "fsi", "fsx"],
    load: () => import("@codemirror/legacy-modes/mode/mllike").then((m) => StreamLanguage.define(m.fSharp)),
  },

  // ── スクリプト・シェル ────────────────────────────────────
  {
    id: "shell",
    label: "シェルスクリプト",
    category: "script",
    extensions: ["sh", "bash", "zsh", "ksh", "fish"],
    load: () => import("@codemirror/legacy-modes/mode/shell").then((m) => StreamLanguage.define(m.shell)),
  },
  {
    id: "powershell",
    label: "PowerShell",
    category: "script",
    extensions: ["ps1", "psm1", "psd1"],
    load: () => import("@codemirror/legacy-modes/mode/powershell").then((m) => StreamLanguage.define(m.powerShell)),
  },
  {
    id: "batch",
    label: "バッチファイル",
    category: "script",
    extensions: ["bat", "cmd"],
    // @codemirror/lang-* にも legacy-modes にもBatch用のモードが存在しないため、
    // 既存の自作モード(src/lang-batch.js)をそのまま使い続ける。
    load: () => import("./lang-batch.js").then((m) => StreamLanguage.define(m.batch)),
  },
  {
    id: "makefile",
    label: "Makefile",
    category: "script",
    extensions: ["mk", "make"],
    // legacy-modes に Makefile 専用モードが無いため、仕様書の指示どおりシェルの
    // ストリームモードで代用する(タブ区切りのコマンド部分だけでも色が付けば十分)。
    load: () => import("@codemirror/legacy-modes/mode/shell").then((m) => StreamLanguage.define(m.shell)),
  },
  {
    id: "dockerfile",
    label: "Dockerfile",
    category: "script",
    extensions: ["dockerfile"],
    load: () => import("@codemirror/legacy-modes/mode/dockerfile").then((m) => StreamLanguage.define(m.dockerFile)),
  },

  // ── マークアップ・スタイルシート ──────────────────────────
  {
    id: "html",
    label: "HTML",
    category: "markup",
    extensions: ["html", "htm", "xhtml"],
    load: () => import("@codemirror/lang-html").then((m) => m.html()),
  },
  {
    id: "css",
    label: "CSS",
    category: "markup",
    extensions: ["css"],
    load: () => import("@codemirror/lang-css").then((m) => m.css()),
  },
  {
    id: "scss",
    label: "SCSS/Sass",
    category: "markup",
    extensions: ["scss", "sass"],
    load: () => import("@codemirror/legacy-modes/mode/sass").then((m) => StreamLanguage.define(m.sass)),
  },
  {
    id: "less",
    label: "Less",
    category: "markup",
    extensions: ["less"],
    load: () => import("@codemirror/legacy-modes/mode/css").then((m) => StreamLanguage.define(m.less)),
  },
  {
    id: "stylus",
    label: "Stylus",
    category: "markup",
    extensions: ["styl"],
    load: () => import("@codemirror/legacy-modes/mode/stylus").then((m) => StreamLanguage.define(m.stylus)),
  },
  {
    id: "xml",
    label: "XML",
    category: "markup",
    extensions: ["xml", "xsl", "xslt", "xsd", "plist"],
    load: () => import("@codemirror/lang-xml").then((m) => m.xml()),
  },
  {
    id: "pug",
    label: "Pug",
    category: "markup",
    extensions: ["pug", "jade"],
    load: () => import("@codemirror/legacy-modes/mode/pug").then((m) => StreamLanguage.define(m.pug)),
  },
  {
    id: "latex",
    label: "LaTeX",
    category: "markup",
    extensions: ["tex", "latex", "sty", "cls"],
    load: () => import("@codemirror/legacy-modes/mode/stex").then((m) => StreamLanguage.define(m.stex)),
  },
  {
    id: "textile",
    label: "Textile",
    category: "markup",
    extensions: ["textile"],
    load: () => import("@codemirror/legacy-modes/mode/textile").then((m) => StreamLanguage.define(m.textile)),
  },

  // ── データ・設定ファイル ──────────────────────────────────
  {
    id: "json",
    label: "JSON",
    category: "data",
    extensions: ["json", "jsonc", "json5"],
    load: () => import("@codemirror/lang-json").then((m) => m.json()),
  },
  {
    id: "yaml",
    label: "YAML",
    category: "data",
    extensions: ["yaml", "yml"],
    load: () => import("@codemirror/lang-yaml").then((m) => m.yaml()),
  },
  {
    id: "toml",
    label: "TOML",
    category: "data",
    extensions: ["toml"],
    load: () => import("@codemirror/legacy-modes/mode/toml").then((m) => StreamLanguage.define(m.toml)),
  },
  {
    id: "ini",
    label: "INI/設定ファイル",
    category: "data",
    extensions: ["ini", "cfg", "conf", "properties", "editorconfig"],
    load: () => import("@codemirror/legacy-modes/mode/properties").then((m) => StreamLanguage.define(m.properties)),
  },
  {
    id: "sql",
    label: "SQL",
    category: "data",
    extensions: ["sql"],
    load: () => import("@codemirror/lang-sql").then((m) => m.sql()),
  },
  {
    id: "csv",
    label: "CSV/TSV",
    category: "data",
    extensions: ["csv", "tsv"],
    load: null, // プレーンテキスト扱い(専用ハイライトは持たない)。
  },
  {
    id: "protobuf",
    label: "Protocol Buffers",
    category: "data",
    extensions: ["proto"],
    load: () => import("@codemirror/legacy-modes/mode/protobuf").then((m) => StreamLanguage.define(m.protobuf)),
  },
  // GraphQL は @codemirror/legacy-modes に対応モードが無いため今回は収録しない
  // (仕様書の指示どおり)。

  // ── その他 ────────────────────────────────────────────────
  {
    id: "diff",
    label: "差分",
    category: "other",
    extensions: ["diff", "patch"],
    load: () => import("@codemirror/legacy-modes/mode/diff").then((m) => StreamLanguage.define(m.diff)),
  },
  {
    id: "nginx",
    label: "nginx設定",
    category: "other",
    extensions: ["nginx"],
    load: () => import("@codemirror/legacy-modes/mode/nginx").then((m) => StreamLanguage.define(m.nginx)),
  },
  {
    id: "gherkin",
    label: "Gherkin",
    category: "other",
    extensions: ["feature"],
    load: () => import("@codemirror/legacy-modes/mode/gherkin").then((m) => StreamLanguage.define(m.gherkin)),
  },
];

// 開発時の安全弁: 拡張子は全体を通して重複してはいけない
// (同じ拡張子が2つの言語に属すると、どちらのハイライトが使われるか不定になったり、
// 設定画面のチェックボックスで同じ拡張子が2箇所に出て紛らわしくなったりするため)。
// 実際に確認した結果、上記一覧に重複は無かった(C/C++で "h" 系が競合しないよう
// C++側は hpp/hh/hxx のみとし、"h" はC専用にする、といった調整は各エントリの
// コメントに理由を書いた上で反映済み)。今後エントリを追加した際に重複が
// 混入していないか、ここで機械的に検知する。
{
  const seen = new Map();
  for (const type of FILE_TYPES) {
    for (const ext of type.extensions) {
      const owner = seen.get(ext);
      if (owner) {
        console.warn(`[file-types] 拡張子 "${ext}" が "${owner}" と "${type.id}" で重複しています。`);
      } else {
        seen.set(ext, type.id);
      }
    }
  }
}
