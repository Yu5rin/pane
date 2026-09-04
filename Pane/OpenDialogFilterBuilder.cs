namespace Pane;

/// <summary>
/// 「開く」ダイアログ(OpenFileDialog.Filter)の文字列組み立て。
///
/// 【なぜ独立したクラスにしたか】
/// 総点検(.review-usability.md 指摘H1)で、「開く」ダイアログのフィルタが
/// 「Markdown / テキスト」と「すべてのファイル」の2つしか無いことが分かった。Paneは
/// 約60種の言語のシンタックスハイライトに対応したコードエディタでもある(FileTypes.
/// OpenableExtensions、npm run buildでsrc/file-types.jsから自動生成)のに、.js や .py を
/// 開くたびに「すべてのファイル」へ切り替える必要があった。
/// 組み立てロジック自体はOpenFileDialog(Windows専用)に一切触れない文字列操作なので、
/// MainFormから切り出してPane.Testsで固定する(CLAUDE.md「外の世界に触れない判断ロジックは
/// 依存の無いクラスへ切り出す」の方針どおり)。
/// </summary>
internal static class OpenDialogFilterBuilder
{
    /// <summary>
    /// 「Markdown / テキスト」フィルタに入れる拡張子。FileTypes.generated.cs の「マークダウン」
    /// 「テキスト」区分(reStructuredText・AsciiDoc・Org-mode・BibTeXを含む)と対応させてある。
    /// これに含まれない拡張子は、すべて「コードファイル」フィルタ側にまとめて入る。
    /// </summary>
    internal static readonly string[] MarkdownTextExtensions =
    {
        "md", "markdown", "mdown", "mkd", "mmd",
        "txt", "text", "log", "nfo",
        "rst", "adoc", "asciidoc", "org", "bib",
    };

    /// <summary>
    /// 「開く」ダイアログのFilter文字列を組み立てる。約60種の対応拡張子を1つずつ並べると
    /// 選びにくいため(総点検 指摘H1)、Markdown/テキスト以外はすべて「コードファイル」という
    /// 1つのフィルタにまとめる。既定で選ばれるフィルタ(FilterIndex省略時の1番目)は、
    /// これまでどおり「Markdown / テキスト」のまま変えない。
    /// </summary>
    internal static string Build()
    {
        string markdownTextPatterns = string.Join(";", MarkdownTextExtensions.Select(ext => $"*.{ext}"));
        string codePatterns = string.Join(";",
            FileTypes.OpenableExtensions
                .Where(ext => !MarkdownTextExtensions.Contains(ext, StringComparer.OrdinalIgnoreCase))
                .OrderBy(ext => ext, StringComparer.OrdinalIgnoreCase)
                .Select(ext => $"*.{ext}"));
        return string.Join("|", new[]
        {
            $"Markdown / テキスト ({markdownTextPatterns})", markdownTextPatterns,
            "コードファイル (*.js;*.py;*.cs;*.json 等)", codePatterns,
            "すべてのファイル (*.*)", "*.*",
        });
    }
}
