namespace Pane;

/// <summary>
/// 実機での不具合調査用の簡易ファイルログ(仕様書外・デバッグ支援)。
/// %LOCALAPPDATA%\Pane\logs\pane-yyyyMMdd.log へ追記する。ログ書き込み自体の失敗が
/// アプリの動作に影響しないよう、例外はすべてこのクラス内で握りつぶす。
/// </summary>
internal static class Logger
{
    private static readonly object Gate = new();
    private static readonly string LogFilePath = ResolveLogFilePath();

    /// <summary>ログファイルの場所。設定画面等から案内する用途にも使う。</summary>
    public static string FilePath => LogFilePath;

    private static string ResolveLogFilePath()
    {
        try
        {
            string dir = System.IO.Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                "Pane", "logs");
            Directory.CreateDirectory(dir);
            return System.IO.Path.Combine(dir, $"pane-{DateTime.Now:yyyyMMdd}.log");
        }
        catch
        {
            // 万一ログフォルダを作れなくても起動は継続する。以後のWrite()は例外を握りつぶして無視される。
            return System.IO.Path.Combine(System.IO.Path.GetTempPath(), "pane-fallback.log");
        }
    }

    public static void Write(string message)
    {
        string line = $"{DateTime.Now:HH:mm:ss.fff} [{Environment.CurrentManagedThreadId}] {message}";
        lock (Gate)
        {
            try
            {
                File.AppendAllText(LogFilePath, line + Environment.NewLine);
            }
            catch
            {
                // ログ書き込みに失敗してもアプリ本体は継続する
            }
        }
    }

    public static void WriteException(string context, Exception ex)
    {
        Write($"{context}: {ex.GetType().Name}: {ex.Message}\n{ex.StackTrace}");
    }
}
