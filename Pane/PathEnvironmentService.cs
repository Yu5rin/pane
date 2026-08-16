using System.Runtime.InteropServices;
using Microsoft.Win32;

namespace Pane;

/// <summary>
/// exeのあるフォルダをユーザー環境変数PATH(<c>HKCU\Environment</c>)へ追加・削除する
/// (仕様書 F-14: 「コマンドラインから開く」のPATH登録)。インストーラを使わない方針のため、
/// 管理者権限が必要なマシン全体のPATH(HKLM側)には触れず、ユーザー環境変数のみを対象にする
/// (<see cref="StartupService"/>・<see cref="FileAssociationService"/>と同じ流儀)。
/// 設定画面のトグル(addToPath)からのみ呼び出す。自動登録は行わない。
/// </summary>
internal static class PathEnvironmentService
{
    private const string EnvironmentKeyPath = "Environment";
    private const string ValueName = "Path";

    // ---- WM_SETTINGCHANGEのブロードキャスト ----
    // レジストリを書き換えただけでは実行中の他プロセス(既に開いているコマンドプロンプト等)には
    // 反映されない。これを送らないとサインアウト/再起動しないと新しいPATHが効かないため必須。
    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr SendMessageTimeout(
        IntPtr hWnd, uint msg, UIntPtr wParam, string lParam,
        uint fuFlags, uint uTimeout, out UIntPtr lpdwResult);

    private static readonly IntPtr HwndBroadcast = new(0xffff);
    private const uint WmSettingChange = 0x001A;
    private const uint SmtoAbortIfHung = 0x0002;

    /// <summary>exeが置かれているフォルダのフルパス(末尾の\無し)。単一ファイル発行時の
    /// AppContext.BaseDirectoryの問題は他サービスと同じ理由でEnvironment.ProcessPathを使う。</summary>
    private static string ExeDirectory()
    {
        string exePath = Environment.ProcessPath ?? Path.Combine(AppContext.BaseDirectory, "Pane.exe");
        return Path.GetDirectoryName(Path.GetFullPath(exePath))
            ?? throw new InvalidOperationException("exeのフォルダを特定できませんでした。");
    }

    private static bool SameDirectory(string a, string b) =>
        string.Equals(a.TrimEnd('\\'), b.TrimEnd('\\'), StringComparison.OrdinalIgnoreCase);

    /// <summary>現在のユーザーPATHに、既にexeのフォルダが含まれているか。</summary>
    public static bool IsRegistered()
    {
        string dir = ExeDirectory();
        return ReadPathEntries().Any(e => SameDirectory(e, dir));
    }

    /// <summary>exeのフォルダをユーザーPATHの末尾へ追加する。既に含まれていれば何もしない
    /// (呼び出しのたびに重複登録しないため)。</summary>
    public static void Register()
    {
        try
        {
            string dir = ExeDirectory();
            List<string> entries = ReadPathEntries();
            if (entries.Any(e => SameDirectory(e, dir)))
            {
                Logger.Write("PathEnvironmentService.Register: 既にPATHへ登録済みのためスキップ");
                return;
            }

            entries.Add(dir);
            WritePathEntries(entries);
            Logger.Write($"PathEnvironmentService.Register: {dir}");
            NotifyEnvironmentChange();
        }
        catch (Exception ex) when (ex is UnauthorizedAccessException or System.Security.SecurityException or IOException)
        {
            Logger.WriteException("PathEnvironmentService.Register失敗", ex);
            throw;
        }
    }

    /// <summary>exeのフォルダをユーザーPATHから取り除く。登録されていなければ何もしない。</summary>
    public static void Unregister()
    {
        try
        {
            string dir = ExeDirectory();
            List<string> entries = ReadPathEntries();
            int removed = entries.RemoveAll(e => SameDirectory(e, dir));
            if (removed == 0)
            {
                Logger.Write("PathEnvironmentService.Unregister: 登録されていなかったためスキップ");
                return;
            }

            WritePathEntries(entries);
            Logger.Write("PathEnvironmentService.Unregister完了");
            NotifyEnvironmentChange();
        }
        catch (Exception ex) when (ex is UnauthorizedAccessException or System.Security.SecurityException or IOException)
        {
            Logger.WriteException("PathEnvironmentService.Unregister失敗", ex);
            throw;
        }
    }

    /// <summary>
    /// HKCU\Environment\Path を「展開しない生の文字列」として読み、";"区切りで空要素を除いて返す。
    /// RegistryValueOptions.DoNotExpandEnvironmentNamesを指定しないと、%SystemRoot%等を含む
    /// REG_EXPAND_SZ値が展開された状態で読めてしまい、それをそのまま書き戻すと元の変数参照が
    /// 失われる(既存のユーザーPATHを絶対に壊さないための配慮)。
    /// </summary>
    private static List<string> ReadPathEntries()
    {
        using RegistryKey? key = Registry.CurrentUser.OpenSubKey(EnvironmentKeyPath);
        string raw = key?.GetValue(ValueName, "", RegistryValueOptions.DoNotExpandEnvironmentNames) as string ?? "";
        return raw.Split(';', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries).ToList();
    }

    /// <summary>
    /// 既存のPATH値の種別(REG_SZ / REG_EXPAND_SZ)を読み取り、その種別を維持したまま書き戻す
    /// (不具合修正: 従来は既存の種別を確認せず、常にREG_EXPAND_SZへ変えて書き戻していた。
    /// 既存のユーザーPATHがREG_SZだった場合に、無断で種別を変えてしまう副作用があった)。
    /// 値がまだ存在しない(初回登録)場合は、Windowsの一般的な既定であるREG_EXPAND_SZを使う
    /// (%変数%を含みうるPATHの一般的な種別であり、REG_SZだと展開されなくなる不具合を起こすため)。
    /// </summary>
    private static void WritePathEntries(IReadOnlyList<string> entries)
    {
        using RegistryKey key = Registry.CurrentUser.CreateSubKey(EnvironmentKeyPath);
        RegistryValueKind kind = RegistryValueKind.ExpandString;
        try
        {
            RegistryValueKind existing = key.GetValueKind(ValueName);
            if (existing == RegistryValueKind.String || existing == RegistryValueKind.ExpandString)
            {
                kind = existing;
            }
        }
        catch (IOException)
        {
            // 値がまだ存在しない場合(GetValueKindは値が無いとIOExceptionを投げる)。
            // 上で初期化済みのExpandStringのまま進む。
        }
        key.SetValue(ValueName, string.Join(';', entries), kind);
    }

    /// <summary>
    /// 環境変数の変更を実行中の全プロセスへブロードキャストする(仕様: これをしないと新しい
    /// プロセスに反映されない)。失敗してもPATH自体の変更は既に成立しているため、ログのみで握りつぶす。
    /// </summary>
    private static void NotifyEnvironmentChange()
    {
        try
        {
            SendMessageTimeout(HwndBroadcast, WmSettingChange, UIntPtr.Zero, "Environment", SmtoAbortIfHung, 5000, out _);
        }
        catch (Exception ex)
        {
            Logger.WriteException("PathEnvironmentService.NotifyEnvironmentChange失敗", ex);
        }
    }
}
