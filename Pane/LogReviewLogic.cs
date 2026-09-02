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
        string? launcherProcess = null;
        for (int i = lines.Count - 1; i >= 0; i--)
        {
            if (!lines[i].Contains("=== Pane起動")) continue;
            start = i;
            startedAt = ExtractTime(lines[i]);
            launcherProcess = ExtractProcessTag(lines[i]);
            break;
        }

        // このセッションを実際に動かしたプロセスを決める(FindBusiestProcessの説明を参照)。
        string? workerProcess = FindBusiestProcess(lines, start, launcherProcess);

        int errors = 0;
        int warnings = 0;
        int fromOtherProcesses = 0;
        var examples = new List<string>();
        for (int i = start; i < lines.Count; i++)
        {
            bool isError = lines[i].Contains("[エラー]");
            bool isWarn = !isError && lines[i].Contains("[警告]");
            if (!isError && !isWarn) continue;

            if (!BelongsToSession(ExtractProcessTag(lines[i]), launcherProcess, workerProcess))
            {
                fromOtherProcesses++;
                continue;
            }

            if (isError) errors++; else warnings++;
            if (examples.Count < MaxExamples) examples.Add(Shorten(lines[i]));
        }

        return new LogReviewSummary(startedAt, errors, warnings, fromOtherProcesses, examples);
    }

    /// <summary>
    /// その行が、いま見ているセッションのものか。
    ///
    /// 1回のセッションには2つのプロセスが登場する。起動された側(<paramref name="launcher"/>)と、
    /// 実際に動いた側(<paramref name="worker"/>)で、多くの場合これは別物になる
    /// (<see cref="FindBusiestProcess"/>の説明を参照)。どちらのものも数える。
    ///
    /// プロセスタグを読み取れない古い形式のログでは、選り分けようがないので全部数える。
    /// </summary>
    private static bool BelongsToSession(string? tag, string? launcher, string? worker)
    {
        if (launcher is null && worker is null) return true; // 古い形式のログ
        if (tag is null) return true;
        return tag == launcher || tag == worker;
    }

    /// <summary>
    /// 指定の範囲でいちばん多く行を書いているプロセスを返す。読み取れなければnull。
    ///
    /// 「=== Pane起動 ===」を書いたプロセスが、そのままウィンドウを開くとは限らない。
    /// Paneはファイルを開くたびに新しいプロセスが立ち上がるが、既にPaneが動いていれば、
    /// そのプロセスは常駐している側へ要求を渡して自分は即座に終了する(多重起動制御)。
    /// つまり起動行を書いた側は数行しか書かずに消え、以後の記録はすべて常駐している側が書く。
    ///
    /// 起動行のプロセスだけを頼りにすると、この構造では実際の警告がまるごと
    /// 「別プロセスのもの」として外れてしまう。実際、そうなっていた:
    ///   [前回の記録] 15:14:39 開始のセッションでエラー0件・警告0件を記録していた。
    ///   (別プロセスの記録が2件、同じ範囲に混ざっている)
    /// この2件こそが、そのセッションで実際に起きた警告(更新確認の403)だった。
    ///
    /// 行数がいちばん多いプロセスは、その範囲で実際に働いていた側とみなしてよい。
    ///
    /// ただし引き渡しが起きていない(自分でウィンドウまで開いた)場合もあり、そのときは
    /// 起動行を書いた側がそのまま働いている。同数で並んだときは
    /// <paramref name="launcher"/> を選ぶのはそのため。数で並ぶ状況は
    /// 「引き渡しが起きていないのに、別のプロセスが同じくらい書いている」ときで、
    /// その別プロセスは無関係な常駐側と考えるのが自然になる。
    /// </summary>
    private static string? FindBusiestProcess(IReadOnlyList<string> lines, int start, string? launcher)
    {
        var counts = new Dictionary<string, int>();
        for (int i = start; i < lines.Count; i++)
        {
            string? tag = ExtractProcessTag(lines[i]);
            if (tag is null) continue;
            counts[tag] = counts.TryGetValue(tag, out int n) ? n + 1 : 1;
        }
        if (counts.Count == 0) return null;

        // 同数で並んだときに列挙の順で結果が変わらないよう、起動側を先に置いてから比べる。
        string? best = launcher is not null && counts.ContainsKey(launcher) ? launcher : null;
        int bestCount = best is not null ? counts[best] : 0;
        foreach (KeyValuePair<string, int> pair in counts)
        {
            if (pair.Value <= bestCount) continue;
            best = pair.Key;
            bestCount = pair.Value;
        }
        return best;
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
