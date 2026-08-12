using System.Text;

namespace Pane;

internal static class Program
{
    [STAThread]
    private static void Main(string[] args)
    {
        // Shift_JIS(コードページ932)等のANSI系エンコーディングを使えるようにする。
        // .NET (Core以降) は既定でこれらのコードページを同梱していないため必須。
        Encoding.RegisterProvider(CodePagesEncodingProvider.Instance);

        // コマンドライン引数でのファイル指定(仕様書 N-25 / F-14): Pane.exe <file>
        string? initialPath = args.Length > 0 ? args[0] : null;

        // 多重起動制御(仕様書 第8.1節): 名前付きMutexで既存プロセスの有無を判定する。
        // 既に起動中なら、名前付きパイプでファイルパスを渡して新規ウィンドウを頼み、
        // 自分自身はWebView2を含むUIを一切起動せずに即終了する
        // (第8.4節「既存プロセスへのファイルオープン: 300ms以内」・「WebView2プロセスを増やさない」)。
        using var mutex = new Mutex(initiallyOwned: true, SingleInstance.MutexName, out bool createdNew);
        if (!createdNew)
        {
            if (SingleInstance.TrySendToExistingInstance(initialPath))
            {
                return;
            }
            // 既存プロセスが応答しなかった(クラッシュ後の残留Mutex等)場合は、
            // 自プロセスとして通常どおり起動を続行する。
        }

        ApplicationConfiguration.Initialize();

        var context = new PaneApplicationContext(initialPath);

        // PaneApplicationContext が最初のウィンドウを生成した時点で
        // WindowsFormsSynchronizationContext がインストール済みになる。
        var server = new SingleInstanceServer(SynchronizationContext.Current!);
        server.FileRequested += path => context.OpenWindow(path);
        server.Start();

        Application.Run(context);

        server.Stop();
    }
}
