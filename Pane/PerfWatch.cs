using System.Diagnostics;
using System.Runtime.CompilerServices;

namespace Pane;

/// <summary>
/// 「遅い処理」を自動で見つけるための計測。
///
/// 不具合の報告は「なんとなく重い」「たまに固まる」という形で来ることが多く、
/// どの処理が原因かはログに残っていなければ後から追えない。かといって全処理の所要時間を
/// 常時記録するとログが読めなくなる。そこで、閾値を超えたときだけ警告として1行残す。
///
/// 使い方:
/// <code>
/// using (PerfWatch.Start("ファイル読み込み", 500))
/// {
///     ... 重いかもしれない処理 ...
/// }
/// </code>
/// 閾値(ミリ秒)を超えなければ何も記録しない。超えたときだけ
/// 「[警告] 遅い処理: ファイル読み込み が 812ms かかった (閾値500ms, 呼出元=...)」が残る。
///
/// UIスレッドを止めた時間そのものを測るものなので、非同期処理(await)をまたぐ用途には
/// 向かない(Disposeまでの実時間を測るため、待ち時間も込みの値になる)。
/// awaitを含む区間に使うときは、待ち時間込みで妥当な閾値を選ぶこと。
/// </summary>
internal static class PerfWatch
{
    /// <summary>閾値を指定しなかった場合の既定(ミリ秒)。
    /// UIが一瞬止まったと体感し始めるあたりを目安にしている。</summary>
    public const int DefaultThresholdMs = 500;

    /// <summary>
    /// 計測を開始する。戻り値を using で受け、スコープを抜けた時点の経過時間が
    /// <paramref name="thresholdMs"/> を超えていれば警告として記録する。
    /// </summary>
    public static IDisposable Start(
        string label,
        int thresholdMs = DefaultThresholdMs,
        [CallerFilePath] string callerFile = "",
        [CallerLineNumber] int callerLine = 0)
        => new Scope(label, thresholdMs, callerFile, callerLine);

    /// <summary>
    /// 既に測り終えた時間を判定だけしたい場合(自前でStopwatchを持っている・
    /// 非同期処理の完了コールバックで測っている等)の入口。
    /// </summary>
    public static void Report(
        string label,
        long elapsedMs,
        int thresholdMs = DefaultThresholdMs,
        [CallerFilePath] string callerFile = "",
        [CallerLineNumber] int callerLine = 0)
    {
        if (elapsedMs < thresholdMs) return;
        Logger.Warn($"遅い処理: {label} が {elapsedMs}ms かかった " +
                    $"(閾値{thresholdMs}ms, 呼出元={System.IO.Path.GetFileName(callerFile)}:{callerLine})");
    }

    private sealed class Scope : IDisposable
    {
        private readonly string _label;
        private readonly int _thresholdMs;
        private readonly string _callerFile;
        private readonly int _callerLine;
        private readonly long _startTimestamp;
        private bool _disposed;

        public Scope(string label, int thresholdMs, string callerFile, int callerLine)
        {
            _label = label;
            _thresholdMs = thresholdMs;
            _callerFile = callerFile;
            _callerLine = callerLine;
            _startTimestamp = Stopwatch.GetTimestamp();
        }

        public void Dispose()
        {
            if (_disposed) return;
            _disposed = true;
            long elapsedMs = (long)Stopwatch.GetElapsedTime(_startTimestamp).TotalMilliseconds;
            Report(_label, elapsedMs, _thresholdMs, _callerFile, _callerLine);
        }
    }
}
