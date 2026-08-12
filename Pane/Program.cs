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

        ApplicationConfiguration.Initialize();

        // コマンドライン引数でのファイル指定(仕様書 N-25 / F-14): Pane.exe <file>
        string? initialPath = args.Length > 0 ? args[0] : null;

        Application.Run(new MainForm(initialPath));
    }
}
