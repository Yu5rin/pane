using Microsoft.Win32;

namespace Pane;

/// <summary>
/// PCログオン時にPaneを"--preload"付きで常駐起動するためのスタートアップ登録・解除を
/// HKEY_CURRENT_USER 配下にのみ行う(<see cref="FileAssociationService"/> と同じ流儀:
/// インストーラ無し、管理者権限不要)。設定画面のトグルからのみ呼び出す。自動登録は行わない。
///
/// 登録先は HKCU\Software\Microsoft\Windows\CurrentVersion\Run。値の名前は "Pane"、
/// 値の内容は "&lt;exeのフルパス&gt;" --preload とする(B-1)。
/// </summary>
internal static class StartupService
{
    private const string RunKeyPath = @"Software\Microsoft\Windows\CurrentVersion\Run";
    private const string ValueName = "Pane";
    private const string PreloadArg = "--preload";

    public static bool IsRegistered()
    {
        using RegistryKey? key = Registry.CurrentUser.OpenSubKey(RunKeyPath);
        return key?.GetValue(ValueName) is string;
    }

    public static void Register()
    {
        try
        {
            // 単一ファイル発行(PublishSingleFile)ではAppContext.BaseDirectoryが実行のたびに
            // 自己展開される一時フォルダを指してしまうため、exeパスはEnvironment.ProcessPathから
            // 取得する(MainForm.ResolveDistPathと同じ理由)。
            string exePath = Environment.ProcessPath ?? Path.Combine(AppContext.BaseDirectory, "Pane.exe");
            string command = $"\"{exePath}\" {PreloadArg}";

            using RegistryKey key = Registry.CurrentUser.CreateSubKey(RunKeyPath);
            key.SetValue(ValueName, command);
            Logger.Write($"StartupService.Register: {command}");
        }
        catch (Exception ex) when (ex is UnauthorizedAccessException or System.Security.SecurityException or IOException)
        {
            // 例外は握りつぶさずログへ残したうえで、呼び出し元(設定画面)にも伝播させて
            // ユーザーへエラーを表示させる。
            Logger.WriteException("StartupService.Register失敗", ex);
            throw;
        }
    }

    public static void Unregister()
    {
        try
        {
            using RegistryKey? key = Registry.CurrentUser.OpenSubKey(RunKeyPath, writable: true);
            key?.DeleteValue(ValueName, throwOnMissingValue: false);
            Logger.Write("StartupService.Unregister完了");
        }
        catch (Exception ex) when (ex is UnauthorizedAccessException or System.Security.SecurityException or IOException)
        {
            Logger.WriteException("StartupService.Unregister失敗", ex);
            throw;
        }
    }
}
