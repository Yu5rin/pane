using System.Text;

namespace Pane;

/// <summary>
/// 起動時に「前回の起動で何か問題が記録されていなかったか」を自分で読み返し、要約を1行残す。
///
/// これまで不具合の発見は、利用者が違和感に気づいてログを送ってくれるかどうかに依存していた。
/// 警告やエラーはログの奥に埋もれてしまい、誰も読み返さなければ無かったことになる。
/// 起動のたびに直前のセッションを機械的に集計しておけば、ログを開いた人が冒頭を見るだけで
/// 「前回は問題があったのか、無かったのか」が分かる。
///
/// 集計するのは「1つ前の <c>=== Pane起動</c> 行から、その次の起動行(または末尾)まで」。
/// 何も見つからなければ何も書かない(問題が無いときにログを増やさない)。
/// </summary>
internal static class StartupLogReview
{
    /// <summary>末尾から読み返す最大バイト数。1回の起動ぶんを賄えれば十分で、
    /// 巨大なログ全体を読んで起動を遅くしないための上限。</summary>
    private const int MaxTailBytes = 512 * 1024;

    /// <summary>ログファイルがこのサイズを超えたら、肥大化として警告する。</summary>
    private const long LargeLogWarnBytes = 20L * 1024 * 1024;

    /// <summary>要約に添える具体例の最大件数。</summary>
    private const int MaxExamples = 3;

    /// <summary>
    /// 直前の起動セッションを集計して要約を記録する。
    ///
    /// 呼ぶ位置: <see cref="Program.Main"/> が自分の「=== Pane起動」行を書く<b>前</b>。
    /// 後に呼ぶと、末尾にある最後の起動行が自分自身になり、集計範囲が空になってしまう。
    /// </summary>
    public static void ReviewPreviousRun()
    {
        try
        {
            string path = Logger.FilePath;
            if (!File.Exists(path)) return;

            var info = new FileInfo(path);
            if (info.Length == 0) return;
            if (info.Length >= LargeLogWarnBytes)
            {
                Logger.Warn($"ログファイルが大きくなっている({info.Length / (1024 * 1024)}MB): {path}。" +
                            "不要なら削除してよい(Paneが自動で消すことはない)");
            }

            List<string> lines = ReadTailLines(path);
            if (lines.Count == 0) return;

            // 末尾から遡って直近の起動行を探す。見つからなければ、読み取った範囲すべてを
            // 「前回のぶん」として扱う(1回の起動が512KBを超えるほど記録された場合など)。
            int start = 0;
            string sessionStartedAt = "(不明)";
            for (int i = lines.Count - 1; i >= 0; i--)
            {
                if (!lines[i].Contains("=== Pane起動")) continue;
                start = i;
                sessionStartedAt = ExtractTime(lines[i]);
                break;
            }

            int errors = 0;
            int warnings = 0;
            var examples = new List<string>();
            for (int i = start; i < lines.Count; i++)
            {
                bool isError = lines[i].Contains("[エラー]");
                bool isWarn = !isError && lines[i].Contains("[警告]");
                if (!isError && !isWarn) continue;
                if (isError) errors++; else warnings++;
                if (examples.Count < MaxExamples) examples.Add(Shorten(lines[i]));
            }

            if (errors == 0 && warnings == 0) return;

            string detail = examples.Count > 0 ? $" 例: {string.Join(" / ", examples)}" : "";
            string summary = $"[前回の記録] {sessionStartedAt}開始のセッションでエラー{errors}件・警告{warnings}件を記録していた。{detail}";
            // 前回の話であって今回の異常ではないため、警告ではなく通常の記録として残す。
            // ただしエラーがあった場合だけは見落とさないよう警告にする。
            if (errors > 0) Logger.Warn(summary);
            else Logger.Write(summary);
        }
        catch (Exception ex)
        {
            // 読み返しに失敗しても起動には影響しない。
            Logger.WriteException("StartupLogReview: 前回のログの読み返しに失敗", ex);
        }
    }

    private static List<string> ReadTailLines(string path)
    {
        var lines = new List<string>();
        // 動作中の自分自身(および他プロセス)が書き込み中でも読めるようShareを広く取る。
        using var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
        long offset = Math.Max(0, stream.Length - MaxTailBytes);
        stream.Seek(offset, SeekOrigin.Begin);
        using var reader = new StreamReader(stream, Encoding.UTF8);
        // 途中から読み始めた場合、最初の1行は行の途中で切れている可能性があるので捨てる。
        if (offset > 0) reader.ReadLine();
        while (reader.ReadLine() is { } line) lines.Add(line);
        return lines;
    }

    /// <summary>行頭の "HH:mm:ss.fff" を取り出す。取れなければ空文字。</summary>
    private static string ExtractTime(string line)
        => line.Length >= 12 && line[2] == ':' && line[5] == ':' ? line[..12] + " " : "";

    /// <summary>要約に載せるため1行を短く切り詰める。</summary>
    private static string Shorten(string line)
    {
        const int max = 120;
        string trimmed = line.Replace('\n', ' ').Replace('\r', ' ');
        return trimmed.Length <= max ? trimmed : trimmed[..max] + "…";
    }
}
