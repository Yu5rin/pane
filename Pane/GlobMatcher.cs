using System.Text;
using System.Text.RegularExpressions;

namespace Pane;

/// <summary>
/// ファイルツリー除外パターン(設定 fileTreePatterns)用の単純なglobマッチャ。
/// Microsoft.Extensions.FileSystemGlobbing は依存パッケージが増えるため使わず、
/// 必要な範囲('*' '?' '**' とディレクトリ区切り、'!'による否定)だけを自前で実装する
/// (docs/設定項目一覧.md 「詳細」節、src/settings.js の説明「1行に1パターン(glob)。
/// `!`で始めると除外の否定になります」)。
///
/// 対応するワイルドカード:
///   '*'  区切り文字'/'を含まない任意の文字列(0文字も可)
///   '?'  区切り文字'/'を含まない任意の1文字
///   '**' 0個以上のパスセグメント(ディレクトリ境界をまたいでよい)
/// '/'を含まないパターン(例: "*.log")は.gitignoreと同じ考え方で、深さに関わらず
/// どのセグメント(ファイル名/フォルダ名そのもの)にも一致できるよう扱う。
///
/// 副作用の無い純粋関数として切り出してあり、単体で境界値を確認できる
/// (呼び出し側はFolderService.ScanAsync)。
/// </summary>
internal static class GlobMatcher
{
    /// <summary>
    /// patternsの一覧をもとに、relativePath(走査ルートからの相対パス。区切りは'/')を
    /// 除外すべきかどうかを判定する。
    /// 先頭が'!'のパターンは「除外の否定」(そのパターンに一致したら除外を解除する)。
    /// 複数のパターンが一致した場合は、後に書かれたパターンを優先する(.gitignoreと同じ考え方)。
    /// patternsが空、またはすべて空行/空白行なら常にfalse(何も除外しない)。
    /// </summary>
    public static bool IsExcluded(string relativePath, IReadOnlyList<string> patterns)
    {
        if (patterns.Count == 0) return false;

        bool excluded = false;
        foreach (string raw in patterns)
        {
            string line = raw.Trim();
            if (line.Length == 0) continue;

            bool negate = line[0] == '!';
            string pattern = negate ? line[1..].TrimStart() : line;
            if (pattern.Length == 0) continue;

            if (IsMatch(relativePath, pattern))
            {
                excluded = !negate;
            }
        }
        return excluded;
    }

    /// <summary>1つのglobパターンがrelativePathに一致するかどうか。</summary>
    public static bool IsMatch(string relativePath, string pattern)
    {
        if (string.IsNullOrEmpty(pattern)) return false;

        string normalizedPath = relativePath.Replace('\\', '/').Trim('/');
        string normalizedPattern = pattern.Replace('\\', '/').Trim('/');
        if (normalizedPattern.Length == 0) return false;

        // '/'を含まないパターンは、.gitignoreと同じく先頭に "**/" を補って
        // どの深さのセグメントにも一致できるようにする(例: "*.log" は "**/*.log" と同義)。
        if (!normalizedPattern.Contains('/'))
        {
            normalizedPattern = "**/" + normalizedPattern;
        }

        string[] pathSegments = normalizedPath.Length == 0 ? Array.Empty<string>() : normalizedPath.Split('/');
        string[] patternSegments = normalizedPattern.Split('/');
        return SegmentsMatch(pathSegments, 0, patternSegments, 0);
    }

    /// <summary>
    /// パス・パターンをそれぞれ'/'区切りのセグメント列にしたうえでの再帰マッチ。
    /// '**'セグメントは「0個以上のセグメントに一致」を、0個の場合と1個以上消費して
    /// 再試行する場合の両方を試すことで表現する。
    /// </summary>
    private static bool SegmentsMatch(string[] path, int pi, string[] pattern, int gi)
    {
        if (gi == pattern.Length) return pi == path.Length;

        if (pattern[gi] == "**")
        {
            if (SegmentsMatch(path, pi, pattern, gi + 1)) return true; // 0個消費
            if (pi < path.Length && SegmentsMatch(path, pi + 1, pattern, gi)) return true; // 1個消費してさらに**を続ける
            return false;
        }

        if (pi == path.Length) return false;
        if (!SegmentGlobMatch(path[pi], pattern[gi])) return false;
        return SegmentsMatch(path, pi + 1, pattern, gi + 1);
    }

    /// <summary>
    /// 1セグメント同士の比較。'*'は0文字以上、'?'は1文字に一致する('/'はセグメント分割済みのため
    /// 現れない)。Windowsのファイルシステムは大文字小文字を区別しないため、常に無視して比較する。
    /// </summary>
    private static bool SegmentGlobMatch(string text, string pattern)
    {
        var regex = new StringBuilder("^");
        foreach (char c in pattern)
        {
            if (c == '*') regex.Append(".*");
            else if (c == '?') regex.Append('.');
            else regex.Append(Regex.Escape(c.ToString()));
        }
        regex.Append('$');
        return Regex.IsMatch(text, regex.ToString(), RegexOptions.IgnoreCase);
    }
}
