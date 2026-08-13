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
//
// 拡張子の「ドットファイル」対応について(2026-08 拡張子網羅の見直しで確認):
//
// ".gitignore" のように先頭の "." しか持たないファイル名は、
// Pane/FolderService.cs の HasOpenableExtension()(C#の Path.GetExtension を使用)、
// および src/languages.js の resolveFileMode() が使う
// CodeMirrorの LanguageDescription.matchFilename()(内部で /\.([^.]+)$/ を使用)の
// どちらでも「最後の(=唯一の)"." より後ろ」が "gitignore" として抽出される。
// そのため extensions 配列に拡張子を持たない語(例: "gitignore")を1つ足すだけで、
// ドットファイルの判定にそのまま使い回せる。本ファイルはこの性質を利用して
// .gitignore / .npmrc 等のドットファイルにも対応している(詳細は各エントリのコメント参照)。
//
// 一方、"Dockerfile" や "Makefile" のように "." を一切含まないファイル名は、
// この2箇所で扱いが異なる:
//   - resolveFileMode() の Markdown 判定だけは String.split(".").pop() で素朴に
//     文字列を割っているため、"." が無ければファイル名全体("dockerfile"等)が
//     ラベルとして得られる。
//   - しかし resolveFileMode() の「コードモードか」の判定は
//     LanguageDescription.matchFilename() に委ねられており、これは
//     `/\.([^.]+)$/`(＝ "." を必ず要求する正規表現)でしか拡張子を取り出さない。
//     "." を含まないファイル名ではこの正規表現が一切マッチしないため、
//     extensions配列に "dockerfile" 等を登録していても、コードモードとしては
//     絶対に検出されない(常にプレーンテキスト扱いになる)。
//   - さらに Pane/FolderService.cs 側は
//       `if (ext.Length <= 1) return false; // 拡張子なしのファイルは対象外`
//     という明示的なガードを持っており、"." を含まないファイル名はそもそも
//     フォルダツリーの一覧に出てこない。
// これら2箇所(src/languages.js が依存する @codemirror/language 本体の実装、および
// Pane/FolderService.cs)はいずれも本タスクでの編集が禁止されているため、
// "Dockerfile" "Makefile" "Gemfile" "Rakefile" "Procfile" のような
// 拡張子を持たないファイル名そのものについては、拡張子ベースの現在の仕組みでは
// コードモード化・フォルダツリー表示のどちらも実現できない(=対応できない)。
// 直接開けば例外なくプレーンテキストとして開けるので壊れはしないが、それ以上の
// 恩恵は無い。それでも本ファイルでは "dockerfile" "makefile" 等の語を
// extensions に残してある。これは「app.dockerfile」「build.makefile」のように
// “実際に "." を伴うファイル名の末尾” として使われる実務上の命名慣習
// (例: VSCode Docker拡張機能が認識する "*.dockerfile" 等)には引き続き有効に
// 効くためであり、詳細は各エントリのコメントを参照。
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
    // nfo: 昔ながらのリリースノート等で使われるプレーンテキスト(装飾なしでよい)。
    extensions: ["txt", "text", "log", "nfo"],
    load: null, // ハイライト無し。プレーンテキストとして開く。
  },
  {
    id: "rst",
    label: "reStructuredText",
    category: "text",
    // "rest" という別名の拡張子も存在するが、その他分類のHTTPリクエストファイル
    // (.http/.rest。REST Clientプラグイン等の慣習)と衝突するため、本ファイルでは
        // ".rest" は HTTPリクエスト側に割り当てる(下記 http エントリのコメント参照)。
    // ここでは曖昧さの無い "rst" のみを登録する。
    extensions: ["rst"],
    load: null, // @codemirror/lang-* にもlegacy-modesにも対応モードが無いため。
  },
  {
    id: "asciidoc",
    label: "AsciiDoc",
    category: "text",
    extensions: ["adoc", "asciidoc"],
    load: null, // 対応モード無し。
  },
  {
    id: "orgmode",
    label: "Org-mode",
    category: "text",
    extensions: ["org"],
    load: null, // 対応モード無し。
  },
  {
    id: "bibtex",
    label: "BibTeX",
    category: "text",
    extensions: ["bib"],
    // legacy-modes の stex はLaTeX地の文用であり、@entrytype{...} 形式のBibTeXを
    // 誤ったハイライトで表示するくらいなら、プレーンテキストのままにする。
    load: null,
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
    // pyx: Cython。Pythonのシンタックスに近く専用モードも無いため流用する。
    extensions: ["py", "pyw", "pyi", "pyx"],
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
    // ino: Arduinoスケッチファイル。C++に近い文法で専用モードが無いため流用する。
    extensions: ["cpp", "cc", "cxx", "hpp", "hh", "hxx", "ino"],
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
    // 拡張子が言語をまたぐ例(仕様書指定): ".m" は Objective-C と MATLAB の両方で
    // 使われる。本プロジェクトでは以下の理由からObjective-Cに固定する。
    //   - legacy-modes に Objective-C 用のモード(clike.objectiveC)が実在し、
    //     既に採用済みで動作実績がある。
    //   - MATLAB専用のCodeMirrorモードは @codemirror/lang-* にも legacy-modes にも
    //     存在しない(近縁の octave モードはあるがMATLABそのものではなく、
    //     構文の差異で誤ハイライトの懸念がある)。
    //   - 存在しないモードを無理に割り当てるより、実在するObjective-C側に倒す方が
    //     安全(壊れたハイライトより「対応言語ではない」方がまし)。
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
    // gemfile / rakefile: "Gemfile" "Rakefile" はRubyのコード(DSL)そのものだが、
    // "." を含まないファイル名なのでコードモードの自動判定には効かない
    // (本ファイル冒頭のコメント参照)。「foo.gemfile」のような "." を伴う
    // 命名や設定画面の一覧に出す目的で、それでも登録しておく。
    extensions: ["rb", "rake", "gemspec", "gemfile", "rakefile"],
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
    // 拡張子が言語をまたぐ例(仕様書指定): ".pl" は Perl と Prolog の両方で
    // 使われる。以下の理由からPerlに固定する。
    //   - legacy-modes に Perl 用のモードが実在し、既に採用済みで動作実績がある。
    //   - Prolog用のCodeMirrorモードは @codemirror/lang-* にも legacy-modes にも
    //     存在せず、そもそも代替の当てが無い。
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
    // sbt: Scalaで書かれたsbtのビルド定義ファイル。文法はScala本体と同じ。
    extensions: ["scala", "sc", "sbt"],
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
    // 拡張子が言語をまたぐ例(仕様書指定): ".v" は Verilog と V言語(vlang.io)の
    // 両方で使われる。以下の理由からVerilogに固定する。
    //   - legacy-modes に Verilog 用のモードが実在し、既に採用済みで動作実績がある。
    //   - V言語用のCodeMirrorモードは @codemirror/lang-* にも legacy-modes にも
    //     存在せず、そもそも代替の当てが無い。
    //   - ハードウェア記述言語としてのVerilogの方が実務での遭遇頻度が高い。
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
  {
    id: "starlark",
    label: "Starlark (Bazel)",
    category: "programming",
    // "BUILD.bazel" のようなファイル名の末尾(最後の "." 以降)を拾うと "bazel" になる。
    extensions: ["bzl", "bazel"],
    // Starlarkの専用モードは無いが、Pythonのサブセットに近い構文のため
    // @codemirror/lang-python を流用する(既に依存関係に含まれている)。
    load: () => import("@codemirror/lang-python").then((m) => m.python()),
  },
  {
    id: "vue",
    label: "Vue",
    category: "programming",
    // Vueの単一ファイルコンポーネント(<template>/<script>/<style>)専用モードは無い。
    // 外枠はHTMLに近いため @codemirror/lang-html を流用する。
    extensions: ["vue"],
    load: () => import("@codemirror/lang-html").then((m) => m.html()),
  },
  {
    id: "svelte",
    label: "Svelte",
    category: "programming",
    // Vueと同様、専用モードが無いためHTMLベースの近似で代用する。
    extensions: ["svelte"],
    load: () => import("@codemirror/lang-html").then((m) => m.html()),
  },
  {
    id: "astro",
    label: "Astro",
    category: "programming",
    // フロントマター(---)+HTMLテンプレートという構成のため、HTMLベースの近似で代用する。
    extensions: ["astro"],
    load: () => import("@codemirror/lang-html").then((m) => m.html()),
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
    // makefile: "Makefile" というファイル名(拡張子なし)自体はコードモードの
    // 自動判定には効かない(本ファイル冒頭のコメント参照)が、設定画面での一覧性と
    // "foo.makefile" のような "." を伴う命名のために登録しておく。
    // mak も同じくMakefileの別拡張子として使われる。
    extensions: ["mk", "make", "makefile", "mak"],
    // legacy-modes に Makefile 専用モードが無いため、仕様書の指示どおりシェルの
    // ストリームモードで代用する(タブ区切りのコマンド部分だけでも色が付けば十分)。
    load: () => import("@codemirror/legacy-modes/mode/shell").then((m) => StreamLanguage.define(m.shell)),
  },
  {
    id: "dockerfile",
    label: "Dockerfile",
    category: "script",
    // "dockerfile": 拡張子なしの "Dockerfile" というファイル名自体はコードモードの
    // 自動判定には効かない(本ファイル冒頭のコメント参照)が、"web.dockerfile" の
    // ような "." を伴う命名(VSCodeのDocker拡張機能等が認識する慣習)には効くため、
    // 元から登録されていたこのエントリをそのまま維持する。
    extensions: ["dockerfile"],
    load: () => import("@codemirror/legacy-modes/mode/dockerfile").then((m) => StreamLanguage.define(m.dockerFile)),
  },
  {
    id: "cmake",
    label: "CMake",
    category: "script",
    extensions: ["cmake"],
    load: () => import("@codemirror/legacy-modes/mode/cmake").then((m) => StreamLanguage.define(m.cmake)),
  },
  {
    id: "ninja",
    label: "Ninjaビルドファイル",
    category: "script",
    extensions: ["ninja"],
    load: null, // 対応モード無し。
  },
  {
    id: "awk",
    label: "AWK",
    category: "script",
    extensions: ["awk"],
    load: null, // 対応モード無し。
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
  {
    id: "xaml",
    label: "XAML",
    category: "markup",
    // axaml: Avalonia UI が使うXAML方言。WPF/UWPのXAMLと同じくXMLベース。
    extensions: ["xaml", "axaml"],
    load: () => import("@codemirror/lang-xml").then((m) => m.xml()),
  },
  {
    id: "razor",
    label: "Razor (cshtml/vbhtml)",
    category: "markup",
    // ASP.NET CoreのRazor構文(@で始まるC#/VB埋め込み)専用モードは無いが、
    // 地の文はHTMLなのでHTMLモードで近似する。
    extensions: ["cshtml", "vbhtml", "razor"],
    load: () => import("@codemirror/lang-html").then((m) => m.html()),
  },
  {
    id: "aspnet",
    label: "ASP.NET Web Forms",
    category: "markup",
    // aspx/ascx/ashx/asmx: 従来のASP.NET Web Forms。<% %>等のサーバータグを含む
    // HTMLベースのマークアップなので、Razorと同様HTMLモードで近似する。
    extensions: ["aspx", "ascx", "ashx", "asmx"],
    load: () => import("@codemirror/lang-html").then((m) => m.html()),
  },
  {
    id: "ejs",
    label: "EJSテンプレート",
    category: "markup",
    extensions: ["ejs"],
    load: () => import("@codemirror/lang-html").then((m) => m.html()),
  },
  {
    id: "erb",
    label: "ERBテンプレート",
    category: "markup",
    extensions: ["erb"],
    load: () => import("@codemirror/lang-html").then((m) => m.html()),
  },
  {
    id: "handlebars",
    label: "Handlebars/Mustache",
    category: "markup",
    extensions: ["hbs", "handlebars", "mustache"],
    load: () => import("@codemirror/lang-html").then((m) => m.html()),
  },
  {
    id: "jinja",
    label: "Jinja2/Twig/Liquid",
    category: "markup",
    // Jinja2・Twig・Liquidはいずれも {{ }} / {% %} 系のテンプレート構文を持つ、
    // 互いに近縁なテンプレート言語。専用モードがLiquid/Twigには無いため、
    // legacy-modesのJinja2モードで代用する(構文が近く実用上問題が少ない)。
    extensions: ["jinja", "jinja2", "j2", "twig", "liquid"],
    load: () => import("@codemirror/legacy-modes/mode/jinja2").then((m) => StreamLanguage.define(m.jinja2)),
  },

  // ── データ・設定ファイル ──────────────────────────────────
  {
    id: "json",
    label: "JSON",
    category: "data",
    // 以下はいずれも中身がJSON(またはJSONの派生)であるため、
    // 拡張子・慣習は異なってもまとめてJSONハイライトを適用する:
    //   json/jsonc/json5 … JSON本体とそのコメント・末尾カンマ許容方言
    //   ndjson/jsonl      … 改行区切りJSON(1行1オブジェクト)
    //   avsc              … Avroスキーマ(中身はJSON)
    //   geojson           … GeoJSON(中身はJSON)
    //   webmanifest       … Web App Manifest(中身はJSON)
    //   babelrc/eslintrc/prettierrc … 拡張子なしの設定ファイル。歴史的にJSON形式が
    //     主流のため既定でJSONとして扱う(YAML/JS版は ".eslintrc.yml" 等
    //     別拡張子を持つため、そちらは各言語のエントリで別途解決される)。
    extensions: [
      "json", "jsonc", "json5", "ndjson", "jsonl", "avsc", "geojson", "webmanifest",
      "babelrc", "eslintrc", "prettierrc",
    ],
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
    // env: .env(dotenv)は KEY=VALUE 形式でproperties/ini方言に近い。
    // reg: Windowsレジストリファイル(REGEDIT4等)。[キー]見出し+値の形がINIに近似。
    // npmrc: .npmrc も KEY=VALUE 形式(拡張子なしファイル名の仕組みは本ファイル冒頭参照)。
    // service/desktop: systemdユニットファイル・Linuxデスクトップエントリは
    //   どちらも [Section] 見出し+KEY=VALUE のINI方言そのもの。
    extensions: ["ini", "cfg", "conf", "properties", "editorconfig", "env", "reg", "npmrc", "service", "desktop"],
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
    id: "pgsql",
    label: "PostgreSQL",
    category: "data",
    extensions: ["pgsql"],
    load: () => import("@codemirror/lang-sql").then((m) => m.sql({ dialect: m.PostgreSQL })),
  },
  {
    id: "plsql",
    label: "PL/SQL (Oracle)",
    category: "data",
    extensions: ["plsql", "pls", "pkb", "pks"],
    load: () => import("@codemirror/lang-sql").then((m) => m.sql({ dialect: m.PLSQL })),
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
  {
    id: "graphql",
    label: "GraphQL",
    category: "data",
    // @codemirror/legacy-modes に対応モードが無いため、拡張子としては受け付けつつも
    // プレーンテキスト扱いにする(全く未収録にするより、設定画面で選べる方が親切)。
    extensions: ["graphql", "gql"],
    load: null,
  },
  {
    id: "msbuild",
    label: "MSBuildプロジェクト",
    category: "data",
    // .NETのプロジェクトファイル・共通プロパティファイル群。中身はすべてXML。
    extensions: ["csproj", "vbproj", "fsproj", "props", "targets", "nuspec"],
    load: () => import("@codemirror/lang-xml").then((m) => m.xml()),
  },
  {
    id: "dotnetconfig",
    label: ".NET設定ファイル",
    category: "data",
    // config: App.config/Web.config はいずれもXML形式(汎用の設定ファイルという
    //   意味の "config" 拡張子も世の中には存在するが、本プロジェクトの.NET開発文脈
    //   ではXML形式の.NET設定ファイルである頻度が圧倒的に高いためこちらに倒す)。
    // manifest: アプリケーションマニフェスト(app.manifest)もXML。
    // settings: Visual StudioのSettings.settingsファイルもXML。
    // ruleset: RoslynアナライザールールセットファイルもXML。
    // resx: .NETのリソースファイルもXML。
    extensions: ["config", "manifest", "settings", "ruleset", "resx"],
    load: () => import("@codemirror/lang-xml").then((m) => m.xml()),
  },

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
  {
    id: "solution",
    label: "Visual Studio ソリューション",
    category: "other",
    // .slnはXMLでもなく独自の(BOM付き)テキスト形式のため、対応モードを持たせず
    // プレーンテキストとして開く。
    extensions: ["sln"],
    load: null,
  },
  {
    id: "http",
    label: "HTTPリクエスト",
    category: "other",
    // http/rest: IDE組み込みまたはREST Client系拡張機能で使われるリクエスト定義形式。
    // ".rest" は reStructuredText の別名拡張子としても使われて衝突しうるが、
    // 本プロジェクトではHTTPリクエスト側に割り当てる(上記 rst エントリのコメント参照)。
    extensions: ["http", "rest"],
    load: () => import("@codemirror/legacy-modes/mode/http").then((m) => StreamLanguage.define(m.http)),
  },
  {
    id: "rpmspec",
    label: "RPM Spec",
    category: "other",
    extensions: ["spec"],
    load: () => import("@codemirror/legacy-modes/mode/rpm").then((m) => StreamLanguage.define(m.rpmSpec)),
  },
  {
    id: "lockfile",
    label: "ロック・モジュールファイル",
    category: "other",
    // lock: yarn.lock/Cargo.lock/Gemfile.lock等、ツールごとに書式が異なる
    //   ロックファイルの総称。中身の書式がまちまちなためプレーンテキストとする。
    // sum: go.sum(モジュールのハッシュ一覧)。
    // mod: go.mod(モジュール定義)。専用モードは無いためプレーンテキスト。
    extensions: ["lock", "sum", "mod"],
    load: null,
  },
  {
    id: "procfile",
    label: "Procfile",
    category: "other",
    // Procfile: Heroku等で使われる "プロセス種別: 起動コマンド" 形式。専用モードは無い
    // (load: null)ためコードモード自動判定への影響はそもそも無いが、設定画面での
    // 一覧性のために拡張子として登録している(本ファイル冒頭のコメントも参照)。
    extensions: ["procfile"],
    load: null,
  },
  {
    id: "ignorefiles",
    label: "無視ファイル(.gitignore等)",
    category: "other",
    // いずれも拡張子を持たないドットファイルで、gitignore用のパターン構文を使う。
    // 専用モードは無いためプレーンテキストとして開く。
    extensions: ["gitignore", "gitattributes", "dockerignore"],
    load: null,
  },
  {
    id: "binarylike",
    label: "その他(バイナリ系)",
    category: "other",
    // db/cache: SQLiteデータベースやビルドキャッシュ等、実体はバイナリのことが多い
    // 拡張子。テキストエディタで開くと文字化けする可能性が高いため、
    // ハイライトは持たせずプレーンテキストとして開く(装飾なし)。
    // 既定でチェックが入る設定はどこにも無い(associatedExtensionsの初期値は空配列)
    // ため、ここに載せても既定で関連付けされることはない。
    extensions: ["db", "cache"],
    load: null,
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
