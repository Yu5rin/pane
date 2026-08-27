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
/// 集計するのは「1つ前の <c>=== Pane起動</c> 行から末尾まで」のうち、<b>その起動行と同じ
/// プロセスが書いた行だけ</b>。Paneは常駐(B-1)や更新後の入れ替えで複数のプロセスが同時に
/// 動くことがあり、同じ日のログファイルへ混ざって書き込まれる。プロセスを区別せずに数えると、
/// 別のプロセスの警告を「前回のセッションの問題」として数えてしまい、件数も例も当てにならなくなる。
/// 行頭のプロセスタグ(<see cref="Logger"/>が付ける <c>[PPPP:TT]</c> の左側)で選り分ける。
///
/// 何も見つからなければ何も書かない(問題が無いときにログを増やさない)。
/// </summary>
internal static class StartupLogReview
{
    /// <summary>末尾から読み返す最大バイト数。1回の起動ぶんを賄えれば十分で、
    /// 巨大なログ全体を読んで起動を遅くしないための上限。</summary>
    private const int MaxTailBytes = 512 * 1024;

    /// <summary>ログファイルがこのサイズを超えたら、肥大化として警告する。</summary>
    private const long LargeLogWarnBytes = 20L * 1024 * 1024;

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
                            $"古いぶんは{Logger.RetentionDays}日で自動的に消えるが、今日のこのファイルは対象外。" +
                            "不要ならそのまま削除してよい");
            }

            List<string> lines = ReadTailLines(path);
            if (lines.Count == 0) return;

            LogReviewSummary summary = LogReviewLogic.Summarize(lines);
            if (summary.IsEmpty) return;

            string line = LogReviewLogic.Format(summary);
            // 前回の話であって今回の異常ではないため、警告ではなく通常の記録として残す。
            // ただしエラーがあった場合だけは見落とさないよう警告にする。
            if (summary.Errors > 0) Logger.Warn(line);
            else Logger.Write(line);
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

    /// <summary>
    /// 古いログファイルを削除する。起動時に一度だけ呼ぶ。
    ///
    /// ログは日付ごとのファイル(pane-yyyyMMdd.log)へ追記していくため、放っておくと
    /// 使った日数ぶんだけ溜まり続ける。調査に使うのはせいぜい直近の数日で、それより前は
    /// 誰も読まないまま残る。<see cref="Logger.RetentionDays"/> 日より古いものを消す。
    ///
    /// 消すのは Pane 自身が作った名前(pane-yyyyMMdd.log)に一致し、かつ日付として読める
    /// ファイルだけ。利用者が同じフォルダへ置いた別のファイルには触れない。
    /// 今日のぶん(と、まだ動いている他プロセスが書いている可能性のある今日のぶん)は対象外。
    /// </summary>
    public static void CleanupOldLogs()
    {
        try
        {
            string dir = Logger.DirectoryPath;
            if (!Directory.Exists(dir)) return;

            DateTime limit = DateTime.Now.Date.AddDays(-Logger.RetentionDays);
            int removed = 0;
            foreach (string file in Directory.EnumerateFiles(dir, "pane-*.log"))
            {
                if (!Logger.TryParseLogFileDate(Path.GetFileName(file), out DateTime day)) continue;
                if (day >= limit) continue;
                try
                {
                    File.Delete(file);
                    removed++;
                }
                catch (Exception ex)
                {
                    // 別のプロセスが掴んでいる等。次回また試すので騒がない。
                    Logger.Debug($"古いログの削除に失敗(次回また試す): {Path.GetFileName(file)} ({ex.GetType().Name})");
                }
            }
            if (removed > 0) Logger.Write($"古いログを{removed}件削除した({Logger.RetentionDays}日より前のぶん)");
        }
        catch (Exception ex)
        {
            Logger.Debug($"古いログの掃除に失敗: {ex.GetType().Name}");
        }
    }
}
