// このファイルは scripts/build.js が src/file-types.js から自動生成する。
// 直接編集しないこと(次回ビルド時に内容が上書きされます)。
// 生成元: src/file-types.js の FILE_TYPES(対応ファイル種別の単一ソース)

namespace Pane;

/// <summary>
/// Paneが開けるファイルの拡張子(拡張子なし・小文字)の一覧。
/// src/file-types.js の FILE_TYPES から自動生成される、拡張子分類の単一ソース。
/// </summary>
internal static class FileTypes
{
    public static readonly HashSet<string> OpenableExtensions = new(StringComparer.OrdinalIgnoreCase)
    {
        // マークダウン
        "md", "markdown", "mdown", "mkd", "mmd", // Markdown
        // テキスト
        "txt", "text", "log", // プレーンテキスト
        // プログラミング言語
        "js", "jsx", "mjs", "cjs", // JavaScript
        "ts", "tsx", "mts", "cts", // TypeScript
        "py", "pyw", "pyi", // Python
        "java", // Java
        "c", "h", // C
        "cpp", "cc", "cxx", "hpp", "hh", "hxx", // C++
        "cs", "csx", // C#
        "m", "mm", // Objective-C
        "go", // Go
        "rs", // Rust
        "rb", "rake", "gemspec", // Ruby
        "php", "phtml", // PHP
        "pl", "pm", "t", // Perl
        "swift", // Swift
        "kt", "kts", // Kotlin
        "scala", "sc", // Scala
        "vb", // Visual Basic
        "vbs", // VBScript
        "lua", // Lua
        "r", // R
        "jl", // Julia
        "hs", "lhs", // Haskell
        "erl", "hrl", // Erlang
        "clj", "cljs", "cljc", "edn", // Clojure
        "lisp", "cl", "el", // Common Lisp
        "scm", "ss", // Scheme
        "groovy", "gradle", // Groovy
        "coffee", // CoffeeScript
        "pas", "pp", // Pascal
        "f", "f90", "f95", "f03", // Fortran
        "cob", "cbl", "cpy", // COBOL
        "tcl", // Tcl
        "v", "sv", "svh", // Verilog
        "vhd", "vhdl", // VHDL
        "s", "asm", // アセンブリ
        "d", // D
        "cr", // Crystal
        "elm", // Elm
        "ml", "mli", // OCaml
        "fs", "fsi", "fsx", // F#
        // スクリプト・シェル
        "sh", "bash", "zsh", "ksh", "fish", // シェルスクリプト
        "ps1", "psm1", "psd1", // PowerShell
        "bat", "cmd", // バッチファイル
        "mk", "make", // Makefile
        "dockerfile", // Dockerfile
        // マークアップ・スタイルシート
        "html", "htm", "xhtml", // HTML
        "css", // CSS
        "scss", "sass", // SCSS/Sass
        "less", // Less
        "styl", // Stylus
        "xml", "xsl", "xslt", "xsd", "plist", // XML
        "pug", "jade", // Pug
        "tex", "latex", "sty", "cls", // LaTeX
        "textile", // Textile
        // データ・設定ファイル
        "json", "jsonc", "json5", // JSON
        "yaml", "yml", // YAML
        "toml", // TOML
        "ini", "cfg", "conf", "properties", "editorconfig", // INI/設定ファイル
        "sql", // SQL
        "csv", "tsv", // CSV/TSV
        "proto", // Protocol Buffers
        // その他
        "diff", "patch", // 差分
        "nginx", // nginx設定
        "feature", // Gherkin
    };
}
