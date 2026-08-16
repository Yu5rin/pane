using System.Runtime.InteropServices;

namespace Pane;

/// <summary>
/// Windowsの「既定のアプリ」(UserChoice)を変更するための導線を提供する。
///
/// 前提として、<b>アプリが自分で既定のアプリを書き換えることはWindowsが禁止している</b>。
/// Windows 10 (1803頃)以降、<c>HKCU\Software\Microsoft\Windows\CurrentVersion\Explorer\
/// FileExts\.&lt;ext&gt;\UserChoice</c> はユーザーSID・拡張子・ProgID・タイムスタンプから
/// 計算されるハッシュで保護されており、正しいハッシュを付けずに書き込むとWindowsが
/// その設定を無効と判断して破棄する(ブラウザの既定を勝手に奪うマルウェアへの対策として
/// 意図的に導入された仕組み)。ハッシュの計算方法は非公開で、これを再現して書き込むのは
/// 規約上も技術上も取るべき手段ではない。
///
/// そのため、正規のアプリに残された手段は「ユーザー自身に選んでもらう画面を出す」ことだけ。
/// このクラスはその画面を、可能な限り少ない手数で出すためのもの。
///
/// 1. <see cref="OpenWithDialog"/> — Windows標準の「このファイルを開く方法を選んでください」
///    ダイアログを、対象の拡張子を指定して直接出す。ユーザーがPaneを選べばその場で既定になる。
///    拡張子ごとに個別に設定できるため、通常はこちらが最短。
/// 2. <see cref="OpenDefaultAppsSettings"/> — Windowsの設定アプリの「既定のアプリ」を開く。
///    Windows 11ではPaneのページへ直接飛ばせるため、そこから拡張子ごとに変更できる。
/// </summary>
internal static class DefaultAppsHelper
{
    [Flags]
    private enum OpenAsInfoFlags
    {
        AllowRegistration = 0x00000001,
        RegisterExtension = 0x00000002,
        Exec = 0x00000004,
        ForceOpenWith = 0x00000008,
        HideRegistration = 0x00000020,
        UrlProtocol = 0x00000040,
        FileIsUri = 0x00000080,
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct OpenAsInfo
    {
        [MarshalAs(UnmanagedType.LPWStr)] public string FileName;
        [MarshalAs(UnmanagedType.LPWStr)] public string? FileClass;
        [MarshalAs(UnmanagedType.I4)] public OpenAsInfoFlags InFlags;
    }

    // PreserveSig=false にすると、HRESULTが失敗値のときに例外へ変換される。
    // ユーザーがダイアログをキャンセルした場合も失敗(E_ABORT)として返るため、
    // 呼び出し側で必ず捕捉すること。
    [DllImport("shell32.dll", CharSet = CharSet.Unicode, ExactSpelling = true, PreserveSig = false)]
    private static extern void SHOpenWithDialog(IntPtr hwndParent, ref OpenAsInfo oai);

    /// <summary>
    /// 指定した拡張子について、Windows標準の「開く方法を選んでください」ダイアログを出す。
    /// ユーザーがPaneを選ぶと、その拡張子の既定のアプリがPaneになる。
    ///
    /// ダイアログは実在するファイルを対象にする必要があるため、一時フォルダへ空のサンプル
    /// ファイルを作って渡す。<see cref="OpenAsInfoFlags.Exec"/> は指定しない
    /// (選択した瞬間にそのサンプルファイルを開いてしまうのを避けるため)。
    /// </summary>
    /// <returns>ダイアログを出せたらtrue。ユーザーのキャンセルもtrue(操作は成立している)。
    /// OSが対応していない等で出せなかった場合はfalse。</returns>
    public static bool OpenWithDialog(IntPtr ownerHandle, string extension)
    {
        string ext = extension.TrimStart('.').ToLowerInvariant();
        if (ext.Length == 0) return false;

        try
        {
            // 一時フォルダに空のサンプルを作る。ダイアログはファイルの中身を見ないので空でよい。
            string dir = Path.Combine(Path.GetTempPath(), "Pane", "default-app");
            Directory.CreateDirectory(dir);
            string sample = Path.Combine(dir, $"sample.{ext}");
            if (!File.Exists(sample)) File.WriteAllText(sample, string.Empty);

            var info = new OpenAsInfo
            {
                FileName = sample,
                FileClass = null,
                InFlags = OpenAsInfoFlags.AllowRegistration
                          | OpenAsInfoFlags.RegisterExtension
                          | OpenAsInfoFlags.ForceOpenWith,
            };
            SHOpenWithDialog(ownerHandle, ref info);
            Logger.Write($"DefaultAppsHelper: .{ext} の「開く方法を選ぶ」ダイアログを閉じた");
            return true;
        }
        catch (OperationCanceledException)
        {
            Logger.Write($"DefaultAppsHelper: .{ext} の選択がキャンセルされた");
            return true;
        }
        catch (Exception ex)
        {
            // ユーザーがキャンセルするとE_ABORT(0x80004004)がCOMException等として飛んでくる。
            // 失敗ではないので、それだけは成功扱いにする。
            if (ex is COMException com && (uint)com.HResult == 0x80004004)
            {
                Logger.Write($"DefaultAppsHelper: .{ext} の選択がキャンセルされた");
                return true;
            }
            Logger.WriteException($"DefaultAppsHelper: .{ext} の「開く方法を選ぶ」ダイアログを出せなかった", ex);
            return false;
        }
    }

    /// <summary>
    /// Windowsの設定アプリの「既定のアプリ」を開く。Windows 11ではPaneのページへ直接飛ばす
    /// (registeredAppUserにはRegisteredApplicationsに登録した名前を渡す。
    /// <see cref="FileAssociationService"/> が "Pane" で登録している)。
    /// 未対応のWindowsではクエリが無視されて一覧が開くだけなので、そのままでも害はない。
    /// </summary>
    public static void OpenDefaultAppsSettings()
    {
        foreach (string uri in new[] { "ms-settings:defaultapps?registeredAppUser=Pane", "ms-settings:defaultapps" })
        {
            try
            {
                using var proc = System.Diagnostics.Process.Start(
                    new System.Diagnostics.ProcessStartInfo(uri) { UseShellExecute = true });
                Logger.Write($"DefaultAppsHelper: 設定アプリを開いた({uri})");
                return;
            }
            catch (Exception ex)
            {
                Logger.WriteException($"DefaultAppsHelper: 設定アプリを開けなかった({uri})", ex);
            }
        }
    }
}
