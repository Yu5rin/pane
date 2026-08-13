using System.Text;

namespace Pane;

internal static class Program
{
    [STAThread]
    private static void Main(string[] args)
    {
        // 実機での不具合調査用ログ(%LOCALAPPDATA%\Pane\logs\)。ハンドルされない例外を
        // JITデバッグダイアログだけでなくログにも残し、後から原因を追いやすくする。
        AppDomain.CurrentDomain.UnhandledException += (_, e) =>
            Logger.Write($"未処理例外(AppDomain): {e.ExceptionObject}");
        Application.ThreadException += (_, e) =>
            Logger.WriteException("未処理例外(UIスレッド)", e.Exception);
        Logger.Write($"=== Pane起動 args=[{string.Join(",", args)}] ===");
        Application.SetUnhandledExceptionMode(UnhandledExceptionMode.CatchException);

        // Shift_JIS(コードページ932)等のANSI系エンコーディングを使えるようにする。
        // .NET (Core以降) は既定でこれらのコードページを同梱していないため必須。
        Encoding.RegisterProvider(CodePagesEncodingProvider.Instance);

        // コマンドライン引数でのファイル指定(仕様書 N-25 / F-14): Pane.exe <file>
        // "--preload"(B-1: スタートアップ登録から起動されるプリロード常駐フラグ)は
        // ファイルパスではなくフラグとして別扱いにし、それ以外の最初の引数をファイルパスとして扱う。
        bool preload = false;
        string? initialPath = null;
        foreach (string arg in args)
        {
            if (string.Equals(arg, "--preload", StringComparison.OrdinalIgnoreCase))
            {
                preload = true;
            }
            else if (initialPath is null)
            {
                initialPath = arg;
            }
        }

        // 多重起動制御(仕様書 第8.1節): 名前付きMutexで既存プロセスの有無を判定する。
        // 既に起動中なら、名前付きパイプでファイルパスを渡して新規ウィンドウを頼み、
        // 自分自身はWebView2を含むUIを一切起動せずに即終了する
        // (第8.4節「既存プロセスへのファイルオープン: 300ms以内」・「WebView2プロセスを増やさない」)。
        using var mutex = new Mutex(initiallyOwned: true, SingleInstance.MutexName, out bool createdNew);
        if (!createdNew)
        {
            if (preload)
            {
                // 既に他プロセスが起動済み(ユーザーが手動で起動済み、または既にpreload常駐中)
                // なら、ログオン時のスタートアップ起動としてこれ以上何もする必要は無い。
                // パイプ経由で新規ウィンドウを頼んでしまうと、ユーザーが見ていないログオン
                // 直後に空のウィンドウが出てしまうため、何も送らずに終了する。
                Logger.Write("--preload起動だが既存プロセスが起動済みのため、何もせず終了する");
                return;
            }
            if (SingleInstance.TrySendToExistingInstance(initialPath))
            {
                return;
            }
            // 既存プロセスが応答しなかった(クラッシュ後の残留Mutex等)場合は、
            // 自プロセスとして通常どおり起動を続行する。
        }

        ApplicationConfiguration.Initialize();

        // preload起動時はPaneApplicationContextがウィンドウを1枚も作らないまま待機し続けるため、
        // フォーム生成をトリガーに自動インストールされるWindowsFormsSynchronizationContextが
        // いつまで経ってもインストールされない可能性がある。SingleInstanceServerがUIスレッドへ
        // 安全にPostできるよう、フォームの有無に関わらずここで明示的にインストールしておく
        // (通常起動時に先に済ませておいても副作用は無い)。
        // WindowsFormsSynchronizationContext.InstallIfNeeded()相当はassembly内部限定公開のため
        // 直接呼べず、同じ効果をSetSynchronizationContextで自前実装する。
        if (SynchronizationContext.Current is not WindowsFormsSynchronizationContext)
        {
            SynchronizationContext.SetSynchronizationContext(new WindowsFormsSynchronizationContext());
        }

        var context = new PaneApplicationContext(initialPath, preload);

        var server = new SingleInstanceServer(SynchronizationContext.Current!);
        server.FileRequested += path => context.OpenWindowFromPipeRequest(path);
        server.Start();

        Application.Run(context);

        server.Stop();
    }
}
