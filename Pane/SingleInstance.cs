using System.IO.Pipes;
using System.Runtime.InteropServices;
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

    // 不具合修正: 「エクスプローラからファイルを開いたとき、Paneのウィンドウが前面に来ない
    // ことがある」対策。Windowsでは SetForegroundWindow (Form.Activate() が内部で呼ぶ) は、
    // 呼び出し元プロセスがフォアグラウンド権を持っていないと失敗し、タスクバーボタンが
    // 点滅するだけになる。エクスプローラ起動の新プロセスはフォアグラウンド権を持つが、
    // 多重起動検知後は自分自身をパイプ送信のみで即終了させ、実際にウィンドウを出す既存
    // プロセス側にはフォアグラウンド権が無い。そこで、既存プロセス(サーバ)のPIDを
    // 新プロセス(クライアント)がAllowSetForegroundWindowで教えてもらい、
    // AllowSetForegroundWindowでフォアグラウンド権を明示的に譲渡する。
    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool AllowSetForegroundWindow(int dwProcessId);

    /// <summary>
    /// 指定PIDのプロセスへフォアグラウンド権を譲渡する。ASFW_ANY(-1)は任意のプロセスに
    /// 許可を与えてしまうため使わず、必ず実際に受け取ったPIDを渡す。Windows以外の環境
    /// (このリポジトリの開発・CI環境はLinux)ではuser32.dll自体が無く呼び出し自体が
    /// 例外になり得るため、丸ごとtry-catchして呼び出し元へは伝播させない。
    /// </summary>
    private static void TryAllowSetForegroundWindow(int pid)
    {
        try
        {
            if (!AllowSetForegroundWindow(pid))
            {
                Logger.Write($"SingleInstance: AllowSetForegroundWindow({pid})が失敗(GetLastError=0x{Marshal.GetLastWin32Error():X8})。前面化できない可能性があるが続行する");
            }
        }
        catch (Exception ex)
        {
            // DllNotFoundException(非Windows環境)等。前面化は諦めるが、後続のファイルパス
            // 送信は続行する(前面化できなくてもファイルは開けるべき)。
            Logger.WriteException("SingleInstance: TryAllowSetForegroundWindow", ex);
        }
    }

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

            // プロトコル: まずサーバ(既存プロセス)のPIDを1行受け取り、フォアグラウンド権を
            // 譲渡してからファイルパスを送る。PIDの読み取り・解釈に失敗しても、そこで諦めず
            // 従来どおりパスの送信は続行する(前面化はできなくてもファイルは開けるべき)。
            string? pidLine = reader.ReadLine();
            if (int.TryParse(pidLine, out int serverPid))
            {
                TryAllowSetForegroundWindow(serverPid);
            }
            else
            {
                Logger.Write($"SingleInstance: サーバからのPID行を解釈できなかった(pidLine='{pidLine}')。前面化の譲渡はスキップして続行する");
            }

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
