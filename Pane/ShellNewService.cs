using Microsoft.Win32;

namespace Pane;

/// <summary>
/// エクスプローラーの右クリック→「新規作成」メニューにMarkdownファイルを追加・削除する
/// (仕様書 第2.10節「エクスプローラーの新規作成メニュー」)。<see cref="FileAssociationService"/> と
/// 同じ流儀で HKEY_CURRENT_USER 配下にのみ登録する(インストーラ無し、管理者権限不要)。
/// 設定画面のトグルからのみ呼び出す。自動登録は行わない。
///
/// `HKCU\Software\Classes\.md\ShellNew` に空の`NullFile`値を作ると、エクスプローラーが
/// その拡張子の「新規作成」メニュー項目(中身が空のファイルを作る)を表示するようになる。
/// 対象は`.md`固定(仕様書どおり、対象拡張子を選ばせるUIは持たない)。
/// </summary>
internal static class ShellNewService
{
    private const string MdExtensionKeyPath = @"Software\Classes\.md";
    private const string ShellNewSubKeyName = "ShellNew";
    private const string NullFileValueName = "NullFile";

    public static bool IsRegistered()
    {
        using RegistryKey? key = Registry.CurrentUser.OpenSubKey($@"{MdExtensionKeyPath}\{ShellNewSubKeyName}");
        return key?.GetValue(NullFileValueName) is not null;
    }

    /// <summary>
    /// `.md\ShellNew\NullFile`(空文字列)を作成する。エクスプローラーの「新規作成」メニューに
    /// 「テキスト ドキュメント」と同じ要領で「MD ドキュメント」(拡張子の説明に依る)が並ぶようになる。
    /// </summary>
    public static void Register()
    {
        try
        {
            using RegistryKey extKey = Registry.CurrentUser.CreateSubKey(MdExtensionKeyPath);
            using RegistryKey shellNewKey = extKey.CreateSubKey(ShellNewSubKeyName);
            // NullFile値は「中身が空のファイルを作る」ことを示す規約上の空文字列。
            shellNewKey.SetValue(NullFileValueName, string.Empty);
            Logger.Write("ShellNewService.Register: .md\\ShellNew\\NullFile を作成した");

            FileAssociationService.NotifyShell();
        }
        catch (Exception ex) when (ex is UnauthorizedAccessException or System.Security.SecurityException or IOException)
        {
            Logger.WriteException("ShellNewService.Register失敗", ex);
            throw;
        }
    }

    /// <summary>
    /// `.md\ShellNew`サブキー自体を削除する。`.md`拡張子キー自体(関連付け等、他の値も
    /// 持ちうる)は削除せず、ShellNewサブキーのみを取り除く。
    /// </summary>
    public static void Unregister()
    {
        try
        {
            using RegistryKey? extKey = Registry.CurrentUser.OpenSubKey(MdExtensionKeyPath, writable: true);
            extKey?.DeleteSubKeyTree(ShellNewSubKeyName, throwOnMissingSubKey: false);
            Logger.Write("ShellNewService.Unregister完了");

            FileAssociationService.NotifyShell();
        }
        catch (Exception ex) when (ex is UnauthorizedAccessException or System.Security.SecurityException or IOException)
        {
            Logger.WriteException("ShellNewService.Unregister失敗", ex);
            throw;
        }
    }

    /// <summary>設定値に合わせて登録・解除を適用する。現在の登録状態と一致していれば何もしない
    /// (毎回のsave-settingsで無駄なレジストリ書き込みをしないため)。</summary>
    public static void Apply(bool enabled)
    {
        bool current = IsRegistered();
        if (current == enabled) return;

        if (enabled) Register();
        else Unregister();
    }
}
