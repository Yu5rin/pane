namespace Pane;

/// <summary>
/// 前回のセッションの集計結果。
/// </summary>
/// <param name="StartedAt">セッションの開始時刻("HH:mm:ss.fff "。読み取れなければ空文字)。</param>
/// <param name="Errors">そのセッションが記録したエラーの件数。</param>
/// <param name="Warnings">そのセッションが記録した警告の件数。</param>
/// <param name="FromOtherProcesses">同じ範囲に混ざっていた、別プロセスのエラー・警告の件数。</param>
/// <param name="Examples">要約に添える具体例(先頭から数件)。</param>
internal sealed record LogReviewSummary(
    string StartedAt,
    int Errors,
    int Warnings,
    int FromOtherProcesses,
    IReadOnlyList<string> Examples)
{
    /// <summary>記録すべきことが何も無い(前回は問題なく終わった)か。</summary>
    internal bool IsEmpty => Errors == 0 && Warnings == 0 && FromOtherProcesses == 0;
}

/// <summary>
/// ログの読み返し(<see cref="StartupLogReview"/>)のうち、ファイルにもLoggerにも触れない部分。
///
/// 行の並びを渡して結果を見るだけで試せる(Pane.Tests/LogReviewLogicTests.cs)。
/// ここが間違っていると、ログの冒頭に出る「前回の記録」が実態と食い違う。要約は
/// 「ログを開いた人が冒頭を見るだけで前回の状態が分かる」ためのものなので、数が違えば
/// 目的をまるごと損なう。実際に、複数プロセスの行が混ざったまま数えていた時期がある。
/// </summary>
internal static class LogReviewLogic
{
    /// <summary>要約に添える具体例の最大件数。</summary>
    private const int MaxExamples = 3;

    /// <summary>要約に載せる1行の最大文字数。</summary>
    private const int MaxExampleLength = 120;

    /// <summary>
    /// 読み取ったログの行から、直前の起動セッションを集計する。
    ///
    /// 範囲は「末尾から遡って最初に見つかる <c>=== Pane起動</c> 行から末尾まで」。起動行が
    /// 見つからなければ、渡された範囲すべてを前回のぶんとして扱う(1回の起動が読み取り上限を
    /// 超えるほど記録された場合など)。
    ///
    /// その範囲のうち、起動行と同じプロセスが書いた行だけを数える。Paneは常駐(B-1)や更新後の
    /// 入れ替えで複数のプロセスが同時に動き、同じログファイルへ混ざって書き込む。区別せずに
    /// 数えると、別プロセスの警告を「前回のセッションの問題」として数えてしまう。
    /// 起動行にプロセスタグが無い(タグを付ける前の古いログ)場合は選り分けようがないので、
    /// 従来どおり全部を数える。
    /// </summary>
    internal static LogReviewSummary Summarize(IReadOnlyList<string> lines)
    {
        int start = 0;
        string startedAt = "";
        string? sessionProcess = null;
        for (int i = lines.Count - 1; i >= 0; i--)
        {
            if (!lines[i].Contains("=== Pane起動")) continue;
            start = i;
            startedAt = ExtractTime(lines[i]);
            sessionProcess = ExtractProcessTag(lines[i]);
            break;
        }

        int errors = 0;
        int warnings = 0;
        int fromOtherProcesses = 0;
        var examples = new List<string>();
        for (int i = start; i < lines.Count; i++)
        {
            bool isError = lines[i].Contains("[エラー]");
            bool isWarn = !isError && lines[i].Contains("[警告]");
            if (!isError && !isWarn) continue;

            if (sessionProcess is not null && ExtractProcessTag(lines[i]) != sessionProcess)
            {
                fromOtherProcesses++;
                continue;
            }

            if (isError) errors++; else warnings++;
            if (examples.Count < MaxExamples) examples.Add(Shorten(lines[i]));
        }

        return new LogReviewSummary(startedAt, errors, warnings, fromOtherProcesses, examples);
    }

    /// <summary>集計結果を、ログの冒頭に残す1行にする。</summary>
    internal static string Format(LogReviewSummary summary)
    {
        string when = string.IsNullOrEmpty(summary.StartedAt) ? "(開始時刻不明の)" : summary.StartedAt;
        // 同じ時間帯に別のプロセス(常駐や更新後の入れ替え)が書いた分は、数だけ添えて区別する。
        // 黙って捨てると「ログには警告があるのに要約は0件」という食い違いに見えてしまう。
        string others = summary.FromOtherProcesses > 0
            ? $" (別プロセスの記録が{summary.FromOtherProcesses}件、同じ範囲に混ざっている)"
            : "";
        string detail = summary.Examples.Count > 0 ? $" 例: {string.Join(" / ", summary.Examples)}" : "";
        return $"[前回の記録] {when}開始のセッションでエラー{summary.Errors}件・警告{summary.Warnings}件を記録していた。{others}{detail}";
    }

    /// <summary>行頭の "HH:mm:ss.fff" を取り出す(末尾に空白を付ける)。取れなければ空文字。</summary>
    internal static string ExtractTime(string line)
        => line.Length >= 12 && line[2] == ':' && line[5] == ':' ? line[..12] + " " : "";

    /// <summary>
    /// 行頭のプロセスタグを取り出す("12:34:56.789 [0432:7] …" なら "0432")。
    /// 形が違う行(プロセスタグを付ける前の古いログ)ではnull。
    ///
    /// このタグはプロセスIDの下4桁なので(<see cref="Logger"/>)、桁が一周すれば別のプロセスと
    /// 同じ値になりうる。ただしここで見るのは同じログファイルの、しかも直近1回ぶんの範囲だけ
    /// なので、その中で衝突する見込みは小さい(衝突しても、要約の件数が多めに出るだけ)。
    /// </summary>
    internal static string? ExtractProcessTag(string line)
    {
        // "HH:mm:ss.fff [" の直後からプロセスタグが始まり、":" までが該当部分。
        const int tagStart = 14;
        if (line.Length <= tagStart || line[tagStart - 1] != '[') return null;
        int colon = line.IndexOf(':', tagStart);
        int close = line.IndexOf(']', tagStart);
        if (colon < 0 || close < 0 || colon > close) return null;
        return line[tagStart..colon];
    }

    /// <summary>要約に載せるため1行を短く切り詰める。</summary>
    private static string Shorten(string line)
    {
        string trimmed = line.Replace('\n', ' ').Replace('\r', ' ');
        return trimmed.Length <= MaxExampleLength ? trimmed : trimmed[..MaxExampleLength] + "…";
    }
}
