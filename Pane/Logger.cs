using System.Collections.Concurrent;
using System.Text;

namespace Pane;

/// <summary>
/// ログの重要度。既定では <see cref="Info"/> 以上だけをファイルへ書き出し、
/// <see cref="Debug"/>(日常操作の逐一記録)は設定「詳細ログを記録する」を
/// 有効にしたときだけ出す。
///
/// 値の大小に意味がある(小さいほど重要)。<see cref="Logger.MinLevel"/> との比較で
/// 出力するかどうかを決めるため、並び順を入れ替えてはいけない。
/// </summary>
internal enum LogLevel
{
    /// <summary>処理が続行できなかった。例外・失敗。必ず記録する。</summary>
    Error = 0,
    /// <summary>続行はできたが想定外。不変条件の違反・異常に遅い処理など、
    /// 不具合の手がかりになるもの。必ず記録する。</summary>
    Warn = 1,
    /// <summary>起動・ファイル操作・設定変更など、後から経緯を追うのに要る節目。既定で記録する。</summary>
    Info = 2,
    /// <summary>メニューのマウス移動やJS側のlog中継など、量が多く普段は不要なもの。
    /// 既定では記録しない。</summary>
    Debug = 3,
}

/// <summary>
/// 実機での不具合調査用の簡易ファイルログ(仕様書外・デバッグ支援)。
/// %LOCALAPPDATA%\Pane\logs\pane-yyyyMMdd.log へ追記する。ログ書き込み自体の失敗が
/// アプリの動作に影響しないよう、例外はすべてこのクラス内で握りつぶす。
///
/// 【非同期化について】
/// 以前は <see cref="Write"/> のたびに File.AppendAllText を呼んでいた。これは1行ごとに
/// 「開く→書く→フラッシュ→閉じる」を行う実装で、しかも呼び出し元(ほとんどがUIスレッド)を
/// その間ブロックする。ウイルス対策ソフトがファイル操作に介入する環境では1行あたり数ms
/// かかることもあり、起動時だけで100行以上出ている現状ではログ自体が起動を遅くしていた
/// (実機ログでの起動時間調査で判明)。
///
/// そのため、書き込み要求はいったんキューへ積むだけにし(呼び出し元はマイクロ秒で戻る)、
/// 専用のバックグラウンドスレッドが一定間隔でまとめて1回のI/Oに束ねて書き出す。
/// これにより「ログを増やしても本体が遅くならない」状態にしてある。
/// ただし <see cref="Error"/> だけは、直後にプロセスが落ちても書き残せるよう
/// その場で同期的に書き出す(頻度が低いので性能上の問題にならない)。
/// </summary>
internal static class Logger
{
    /// <summary>ファイルへ実際に書き込むときの排他。ワーカースレッドと、
    /// Errorやシャットダウン時の同期フラッシュが同じファイルを触るため必要。</summary>
    private static readonly object FileGate = new();

    private static readonly string LogDirectoryPath = ResolveLogDirectoryPath();
    private static readonly string LogFilePath = ResolveLogFilePath(LogDirectoryPath);

    /// <summary>書き出し待ちの行。呼び出し元はここへ積むだけで戻る。</summary>
    private static readonly ConcurrentQueue<string> Pending = new();

    /// <summary>ワーカーを早く起こすための合図。Errorやシャットダウンで使う。</summary>
    private static readonly AutoResetEvent Signal = new(false);

    /// <summary>まとめ書きの間隔。この間隔か <see cref="Signal"/> のどちらか早い方で書き出す。</summary>
    private const int FlushIntervalMs = 250;

    /// <summary>キューに積める上限。ここを超えた分は捨てて件数だけ記録する
    /// (何らかの暴走で毎秒数万行出るような事態になっても、メモリを食い潰さないための歯止め)。</summary>
    private const int MaxPending = 50000;

    /// <summary>1回のI/Oで書き出す最大行数。巨大な文字列を一度に作らないための区切り。</summary>
    private const int MaxLinesPerBatch = 5000;

    private static int _pendingCount;
    private static int _droppedCount;
    private static volatile bool _stopping;
    private static readonly Thread Worker;

    /// <summary>これより重要度の低いものは書き出さない。既定はInfo。</summary>
    private static volatile LogLevel _minLevel = LogLevel.Info;

    static Logger()
    {
        // 環境変数での上書き。設定ファイルが読めない段階(起動直後)から詳細ログを
        // 採りたい場合や、設定画面を開けない状況での調査に使う。
        //   set PANE_LOG_LEVEL=debug & Pane.exe
        string? fromEnv = Environment.GetEnvironmentVariable("PANE_LOG_LEVEL");
        if (!string.IsNullOrWhiteSpace(fromEnv) && TryParseLevel(fromEnv, out LogLevel parsed))
        {
            _minLevel = parsed;
        }

        Worker = new Thread(WorkerLoop)
        {
            IsBackground = true,
            Name = "Pane.Logger",
            // ログはアプリ本体の邪魔をしてはいけない。
            Priority = ThreadPriority.BelowNormal,
        };
        Worker.Start();

        // 正常終了時に書き残しを出し切る。IsBackground=trueのワーカーはプロセス終了で
        // 問答無用に止まるため、この保険が無いと最後の数百msぶんのログが消える。
        AppDomain.CurrentDomain.ProcessExit += (_, _) => Shutdown();
    }

    /// <summary>ログファイルの場所。設定画面等から案内する用途にも使う。</summary>
    public static string FilePath => LogFilePath;

    /// <summary>ログファイルを格納するディレクトリ(%LOCALAPPDATA%\Pane\logs)。Paneはこの配下の
    /// ファイルへ動作中ずっと書き込み続けるため、MainForm.StartWatching側で「外部変更検知の
    /// 監視を張るかどうか」の判定に使う(自分自身のログを開いたときに無限ダイアログが
    /// 出てしまう不具合の対策)。</summary>
    public static string DirectoryPath => LogDirectoryPath;

    /// <summary>現在の出力しきい値。</summary>
    public static LogLevel MinLevel => _minLevel;

    /// <summary>
    /// 詳細ログ(Debug)を出すかどうかを切り替える。設定の読み込み後に呼ぶ。
    /// 環境変数 PANE_LOG_LEVEL が指定されている場合はそちらを優先し、ここでは変更しない
    /// (調査のために環境変数で明示指定した人の意図を、設定ファイルの既定値で
    /// 上書きしてしまわないため)。
    /// </summary>
    public static void SetVerbose(bool verbose)
    {
        if (!string.IsNullOrWhiteSpace(Environment.GetEnvironmentVariable("PANE_LOG_LEVEL"))) return;
        LogLevel next = verbose ? LogLevel.Debug : LogLevel.Info;
        if (_minLevel == next) return;
        _minLevel = next;
        // 切り替わったこと自体は必ず残す(後からログを読む人が「なぜ急に量が変わったか」
        // を追えるようにする)。
        Enqueue(LogLevel.Info, verbose ? "ログ: 詳細ログを有効にした" : "ログ: 詳細ログを無効にした");
    }

    private static bool TryParseLevel(string text, out LogLevel level)
    {
        switch (text.Trim().ToLowerInvariant())
        {
            case "error": level = LogLevel.Error; return true;
            case "warn": case "warning": level = LogLevel.Warn; return true;
            case "info": level = LogLevel.Info; return true;
            case "debug": case "verbose": case "trace": level = LogLevel.Debug; return true;
            default: level = LogLevel.Info; return false;
        }
    }

    private static string ResolveLogDirectoryPath()
    {
        try
        {
            string dir = System.IO.Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                "Pane", "logs");
            Directory.CreateDirectory(dir);
            return dir;
        }
        catch
        {
            // 万一ログフォルダを作れなくても起動は継続する。以後のWrite()は例外を握りつぶして無視される。
            return System.IO.Path.GetTempPath();
        }
    }

    private static string ResolveLogFilePath(string dir)
    {
        try
        {
            return System.IO.Path.Combine(dir, $"pane-{DateTime.Now:yyyyMMdd}.log");
        }
        catch
        {
            return System.IO.Path.Combine(System.IO.Path.GetTempPath(), "pane-fallback.log");
        }
    }

    /// <summary>
    /// 通常の記録(Info)。既存の呼び出し箇所との互換のため、レベル指定なしはInfoとして扱う。
    /// </summary>
    public static void Write(string message) => Enqueue(LogLevel.Info, message);

    /// <summary>日常操作の逐一記録。既定では書き出されない(設定「詳細ログを記録する」が必要)。</summary>
    public static void Debug(string message)
    {
        // 文字列の組み立てコストまでは肩代わりできないが、少なくともキューへ積む処理と
        // タイムスタンプ生成は省ける。Debugの呼び出し箇所は数が多いので効いてくる。
        if (_minLevel < LogLevel.Debug) return;
        Enqueue(LogLevel.Debug, message);
    }

    /// <summary>詳細ログが有効かどうか。文字列の組み立て自体が重い箇所で、
    /// 呼び出す前に確認するために使う。</summary>
    public static bool IsDebugEnabled => _minLevel >= LogLevel.Debug;

    /// <summary>想定外だが続行できた事象。不具合の手がかりとして必ず記録する。</summary>
    public static void Warn(string message) => Enqueue(LogLevel.Warn, message);

    /// <summary>
    /// 失敗・例外。直後にプロセスが落ちても書き残せるよう、その場で同期的に書き出す。
    /// </summary>
    public static void Error(string message)
    {
        Enqueue(LogLevel.Error, message);
        FlushNow();
    }

    /// <summary>
    /// WebView2の中(JS側)から中継されてきたログを、JS側が指定したレベルに応じた
    /// 重要度で記録する。3つのウィンドウ(本体・設定・取扱説明書)がまったく同じ
    /// 振り分けをするため、ここへ集約してある。
    ///
    /// JS側の "log" は日常動作の逐一記録として詳細ログ扱いにする。後から必ず読み返したい
    /// ものは、JS側で logToHost("info", ...) を使って記録すること。
    /// </summary>
    /// <param name="source">どのウィンドウから来たかを表す短い名前(例: "JS", "設定ウィンドウ JS")。</param>
    public static void WriteFromWeb(string source, string level, string message)
    {
        switch (level)
        {
            case "error": Error($"[{source}] {message}"); break;
            case "warn": Warn($"[{source}] {message}"); break;
            case "info": Write($"[{source}:info] {message}"); break;
            default: Debug($"[{source}:log] {message}"); break;
        }
    }

    public static void WriteException(string context, Exception ex)
    {
        Error($"{context}: {ex.GetType().Name}: {ex.Message}\n{ex.StackTrace}");
    }

    private static void Enqueue(LogLevel level, string message)
    {
        if (level > _minLevel) return;

        // タイムスタンプは「キューへ積んだ瞬間」で作る。実際にファイルへ書かれるのは
        // 最大250ms後になるが、ログに残る時刻は事象が起きた時刻でなければ意味がない。
        string prefix = level switch
        {
            LogLevel.Error => "[エラー] ",
            LogLevel.Warn => "[警告] ",
            LogLevel.Debug => "[詳細] ",
            _ => "",
        };
        string line = $"{DateTime.Now:HH:mm:ss.fff} [{Environment.CurrentManagedThreadId}] {prefix}{message}";

        if (Interlocked.Increment(ref _pendingCount) > MaxPending)
        {
            // 上限超過。積まずに捨て、件数だけ数えておく(次のまとめ書きで1行だけ報告する)。
            Interlocked.Decrement(ref _pendingCount);
            Interlocked.Increment(ref _droppedCount);
            return;
        }
        Pending.Enqueue(line);
    }

    private static void WorkerLoop()
    {
        while (true)
        {
            // 停止要求はWaitOneの前に読む。「停止フラグを見る→待つ→書き出す」の順にすると
            // 待っている間に積まれた最後の数行を取りこぼすため、
            // 「フラグを控える→待つ→書き出す→控えたフラグで判定」の順にしてある。
            bool stoppingBeforeWait = _stopping;
            try
            {
                Signal.WaitOne(FlushIntervalMs);
            }
            catch
            {
                // シャットダウン中にハンドルが閉じられた場合など。書き残しを出して終わる。
                DrainToFile();
                return;
            }
            DrainToFile();
            if (stoppingBeforeWait) return;
        }
    }

    /// <summary>キューの内容をファイルへ書き出す。呼び出し元スレッドで実行される。</summary>
    private static void DrainToFile()
    {
        while (true)
        {
            if (Pending.IsEmpty && Volatile.Read(ref _droppedCount) == 0) return;

            var batch = new StringBuilder(16 * 1024);
            int lines = 0;
            while (lines < MaxLinesPerBatch && Pending.TryDequeue(out string? line))
            {
                Interlocked.Decrement(ref _pendingCount);
                batch.Append(line).Append(Environment.NewLine);
                lines++;
            }

            int dropped = Interlocked.Exchange(ref _droppedCount, 0);
            if (dropped > 0)
            {
                // 捨てたこと自体を隠すと「ログが飛んでいる」原因が分からなくなる。
                batch.Append($"{DateTime.Now:HH:mm:ss.fff} [{Environment.CurrentManagedThreadId}] [警告] ログ: 書き出しが追いつかず{dropped}行を破棄した")
                     .Append(Environment.NewLine);
                lines++;
            }

            if (lines == 0) return;

            lock (FileGate)
            {
                try
                {
                    File.AppendAllText(LogFilePath, batch.ToString());
                }
                catch
                {
                    // ログ書き込みに失敗してもアプリ本体は継続する
                }
            }
        }
    }

    /// <summary>
    /// 書き残しを今すぐ出し切る。クラッシュ直前や、ログファイルを利用者に見せる直前
    /// (設定画面の「ログを開く」等)に呼ぶ。
    /// </summary>
    public static void FlushNow() => DrainToFile();

    /// <summary>
    /// 終了処理。ワーカーを止め、キューに残っているぶんを書き切る。
    /// 二重に呼ばれても安全(ProcessExitと明示呼び出しの両方から来る)。
    /// </summary>
    public static void Shutdown()
    {
        if (_stopping) { FlushNow(); return; }
        _stopping = true;
        try { Signal.Set(); } catch { }
        try
        {
            // ワーカーの終了を少しだけ待つ。待ちきれなくても、この後の FlushNow で
            // 呼び出し元スレッドが自分で書き切るため、ログが失われることはない。
            Worker.Join(TimeSpan.FromSeconds(2));
        }
        catch { }
        FlushNow();
    }
}
