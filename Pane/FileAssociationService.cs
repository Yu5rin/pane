using Microsoft.Win32;

namespace Pane;

/// <summary>
/// Markdownファイルの関連付けを HKEY_CURRENT_USER 配下にのみ登録・解除する
/// (仕様書 第7.1節・N-09: インストーラ無し、管理者権限不要)。
/// 設定画面のトグルからのみ呼び出す。自動登録は行わない。
///
/// 対応拡張子は .md / .markdown / .mdown に限定する(.txt はメモ帳の領域として扱わないため対象外)。
/// 古典的な HKCU\Software\Classes\.ext 直接指定に加え、Windows の「既定のアプリ」設定に
/// 一覧表示されるための RegisteredApplications / Capabilities パターンも登録する。
/// ただし Windows 10 以降は UserChoice 保護により、登録後も設定画面での手動選択が
/// 必要になる場合がある(仕様どおりの既知の制約であり、回避策は用いない)。
/// </summary>
internal static class FileAssociationService
{
    private const string ProgId = "Pane.MarkdownFile";
    private const string AppRegisteredName = "Pane";
    private static readonly string[] Extensions = { ".md", ".markdown", ".mdown" };

    public static bool IsRegistered()
    {
        using RegistryKey? key = Registry.CurrentUser.OpenSubKey($@"Software\Classes\{ProgId}");
        return key is not null;
    }

    public static void Register()
    {
        string exePath = Environment.ProcessPath ?? Path.Combine(AppContext.BaseDirectory, "Pane.exe");

        // 1. ProgID本体 (HKCU\Software\Classes\Pane.MarkdownFile)
        using (RegistryKey progIdKey = Registry.CurrentUser.CreateSubKey($@"Software\Classes\{ProgId}"))
        {
            progIdKey.SetValue(string.Empty, "Markdown ドキュメント");
            using RegistryKey iconKey = progIdKey.CreateSubKey("DefaultIcon");
            iconKey.SetValue(string.Empty, $"\"{exePath}\",0");
            using RegistryKey commandKey = progIdKey.CreateSubKey(@"shell\open\command");
            commandKey.SetValue(string.Empty, $"\"{exePath}\" \"%1\"");
        }

        // 2. 拡張子ごとの古典的な関連付け (HKCU\Software\Classes\.md の既定値)
        foreach (string ext in Extensions)
        {
            using RegistryKey extKey = Registry.CurrentUser.CreateSubKey($@"Software\Classes\{ext}");
            extKey.SetValue(string.Empty, ProgId);
        }

        // 3. 「既定のアプリ」設定に表示するための Capabilities / RegisteredApplications
        using (RegistryKey capKey = Registry.CurrentUser.CreateSubKey($@"Software\{AppRegisteredName}\Capabilities"))
        {
            capKey.SetValue("ApplicationName", "Pane");
            capKey.SetValue("ApplicationDescription", "Markdown対応メモ帳");
            using RegistryKey fileAssocKey = capKey.CreateSubKey("FileAssociations");
            foreach (string ext in Extensions)
            {
                fileAssocKey.SetValue(ext, ProgId);
            }
        }
        using (RegistryKey registeredAppsKey = Registry.CurrentUser.CreateSubKey(@"Software\RegisteredApplications"))
        {
            registeredAppsKey.SetValue(AppRegisteredName, $@"Software\{AppRegisteredName}\Capabilities");
        }
    }

    public static void Unregister()
    {
        foreach (string ext in Extensions)
        {
            // 自分が設定した関連付けの場合のみ削除する(他アプリが横取り済みなら触らない)。
            using RegistryKey? extKey = Registry.CurrentUser.OpenSubKey($@"Software\Classes\{ext}", writable: true);
            if (extKey?.GetValue(string.Empty) as string == ProgId)
            {
                Registry.CurrentUser.DeleteSubKeyTree($@"Software\Classes\{ext}", throwOnMissingSubKey: false);
            }
        }

        Registry.CurrentUser.DeleteSubKeyTree($@"Software\Classes\{ProgId}", throwOnMissingSubKey: false);
        Registry.CurrentUser.DeleteSubKeyTree($@"Software\{AppRegisteredName}", throwOnMissingSubKey: false);

        using RegistryKey? registeredAppsKey = Registry.CurrentUser.OpenSubKey(@"Software\RegisteredApplications", writable: true);
        registeredAppsKey?.DeleteValue(AppRegisteredName, throwOnMissingValue: false);
    }
}
