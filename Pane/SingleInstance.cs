using System.IO.Pipes;
using System.Security.Principal;

namespace Pane;

/// <summary>
/// 多重起動制御(仕様書 第8.1節)で使う名前付きMutex・名前付きパイプの命名規則と、
/// 既存プロセスへファイルパスを送信するクライアント側のヘルパー。
/// 名前にはユーザーSIDを含め、同一マシンを共有する別ユーザー間での衝突を防ぐ。
/// </summary>
internal static class SingleInstance
{
    private const string BaseName = "Pane.SingleInstance";
    private const string PipeBaseName = "Pane.IPC";

    /// <summary>
    /// 名前付きパイプでの1回のやり取りに許すタイムアウト(ミリ秒)。
    /// 仕様書 第8.4節「既存プロセスへのファイルオープン依頼: 300ms以内」の予算に収める。
    /// </summary>
    public const int TimeoutMilliseconds = 2000;

    public static string MutexName => $@"Local\{BaseName}.{GetUserScopeId()}";

    public static string PipeName => $"{PipeBaseName}.{GetUserScopeId()}";

    private static string GetUserScopeId()
    {
        try
        {
            return WindowsIdentity.GetCurrent().User?.Value ?? Environment.UserName;
        }
        catch
        {
            // Windows以外(このリポジトリの開発・CI環境)や取得失敗時のフォールバック。
            return Environment.UserName;
        }
    }

    /// <summary>
    /// 既に起動している既存プロセスへ、開いてほしいファイルパスを1件通知する。
    /// path が null の場合はウィンドウのアクティブ化のみを依頼する(新規ウィンドウ扱い)。
    /// 成功したら true。既存プロセスが応答しない場合は false を返し、
    /// 呼び出し元(Program.cs)は自プロセスとして起動を続行する。
    /// </summary>
    public static bool TrySendToExistingInstance(string? path)
    {
        try
        {
            using var client = new NamedPipeClientStream(".", PipeName, PipeDirection.InOut);
            client.Connect(TimeoutMilliseconds);

            using var writer = new StreamWriter(client, leaveOpen: true) { AutoFlush = true };
            using var reader = new StreamReader(client, leaveOpen: true);

            writer.WriteLine(path ?? string.Empty);
            string? ack = reader.ReadLine();
            return ack == "OK";
        }
        catch (Exception ex) when (ex is IOException or TimeoutException or UnauthorizedAccessException)
        {
            return false;
        }
    }
}
