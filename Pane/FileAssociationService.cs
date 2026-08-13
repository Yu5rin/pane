using System.Runtime.InteropServices;
using Microsoft.Win32;

namespace Pane;

/// <summary>
/// 任意の拡張子に対するファイル関連付けを HKEY_CURRENT_USER 配下にのみ登録・解除する
/// (仕様書 第2.10節 C-13・第7.1節 N-09: インストーラ無し、管理者権限不要)。設定画面からのみ
/// 呼び出す。自動登録は行わない。
///
/// 対応拡張子はハードコードせず、設定画面のチェックボックスで選ばれた任意の拡張子
/// (約50言語・200拡張子)を呼び出し側から受け取る形にする。拡張子は「ドット無し・小文字」で
/// 受け渡しする前提とし、内部で HKCU\Software\Classes\.&lt;ext&gt; を扱う。
///
/// ProgIDは拡張子ごとに "Pane.File.&lt;ext&gt;" と分ける。1つのProgIDを複数拡張子で共有すると、
/// 片方だけ関連付けを解除したときに ProgID 自体を消してしまいもう片方まで壊れるため。
///
/// 古典的な HKCU\Software\Classes\.ext 直接指定に加え、Windows の「既定のアプリ」設定に
/// 一覧表示されるための RegisteredApplications / Capabilities パターンも登録する。
/// ただし Windows 10 以降は UserChoice 保護により、登録後も設定画面での手動選択が
/// 必要になる場合がある(仕様どおりの既知の制約であり、回避策は用いない)。
/// </summary>
internal static class FileAssociationService
{
    /// <summary>拡張子ごとのProgIDの接頭辞。実際のProgIDは "Pane.File.md" のようになる。</summary>
    private const string ProgIdPrefix = "Pane.File.";

    /// <summary>
    /// 本改修前の旧実装が使っていた、全拡張子共有の単一ProgID。既にこのProgIDで登録済みの
    /// ユーザーがいる可能性があるため、Unregister時にこれが残っていれば併せて掃除する
    /// (フォールバック)。
    /// </summary>
    private const string LegacyProgId = "Pane.MarkdownFile";

    private const string AppRegisteredName = "Pane";

    /// <summary>
    /// エクスプローラーへ「関連付けが変わった」ことを通知するためのシェルAPI。
    /// レジストリを書き換えただけではエクスプローラーは古い関連付け(とアイコン)を
    /// キャッシュしたままで、アイコンが切り替わらない。登録・解除の直後に必ず呼ぶ。
    /// </summary>
    [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
    private static extern void SHChangeNotify(int wEventId, uint uFlags, IntPtr dwItem1, IntPtr dwItem2);

    private const int SHCNE_ASSOCCHANGED = 0x08000000;
    private const uint SHCNF_IDLIST = 0x0000;
    private const uint SHCNF_FLUSH = 0x1000; // 通知が処理されるまで待つ(戻った時点で反映済みにする)

    /// <summary>
    /// Windows 10以降で、ユーザーが「既定のアプリ」を明示的に選んだ場合に作られるキー。
    /// ここに他アプリのProgIDが入っていると、HKCU\Software\Classes\.ext の設定よりも
    /// 優先されるため、Paneの関連付け(とアイコン)は反映されない。
    /// </summary>
    private const string FileExtsKeyPath = @"Software\Microsoft\Windows\CurrentVersion\Explorer\FileExts";

    /// <summary>
    /// 旧実装(拡張子固定)からの移行措置用の既定拡張子一覧。AppSettings.FileAssociationEnabled が
    /// trueなのに AssociatedExtensions が空(=この改修より前に関連付けを有効化したユーザーの
    /// 設定ファイル)の場合、この3つが対象だったとみなす。詳細は AppSettings 側のコメントを参照。
    /// </summary>
    public static readonly IReadOnlyCollection<string> LegacyDefaultExtensions = new[] { "md", "markdown", "mdown" };

    private static string ProgIdFor(string ext) => $"{ProgIdPrefix}{ext}";

    /// <summary>拡張子表記を「ドット無し・小文字」に正規化する。呼び出し元の表記揺れ(先頭ドット有無・大文字)を吸収する。</summary>
    private static HashSet<string> Normalize(IReadOnlyCollection<string> extensions) =>
        new(extensions.Select(e => e.TrimStart('.').ToLowerInvariant()).Where(e => e.Length > 0), StringComparer.Ordinal);

    public static bool IsRegistered(string extension)
    {
        string ext = extension.TrimStart('.').ToLowerInvariant();
        using RegistryKey? key = Registry.CurrentUser.OpenSubKey($@"Software\Classes\{ProgIdFor(ext)}");
        return key is not null;
    }

    /// <summary>
    /// 設定画面で選ばれた拡張子集合(desired)と、直前まで登録していた拡張子集合(previous)を
    /// 比較し、差分だけを適用する。previousにあってdesiredに無いものは解除、その逆は登録する。
    /// 登録が変わらない拡張子についても、旧ProgID("Pane.MarkdownFile")を指したままの
    /// レジストリが残っている可能性があるため、desired全体に対して毎回Registerを実行し
    /// 新ProgIDへ上書きする(冪等な処理のため無害)。
    /// 呼び出し側は成功した場合、desiredをそのままAppSettings.AssociatedExtensionsへ保存すること。
    /// </summary>
    public static void Apply(IReadOnlyCollection<string> desired, IReadOnlyCollection<string> previous)
    {
        HashSet<string> desiredSet = Normalize(desired);
        HashSet<string> previousSet = Normalize(previous);

        List<string> toUnregister = previousSet.Except(desiredSet).ToList();

        if (toUnregister.Count > 0) Unregister(toUnregister);
        if (desiredSet.Count > 0) Register(desiredSet);

        UpdateCapabilities(desiredSet);

        // レジストリを書いただけではエクスプローラーの表示(特にアイコン)は切り替わらない。
        // ここで明示的に通知して、開いているエクスプローラーのウィンドウにも反映させる。
        NotifyShell();
    }

    /// <summary>
    /// エクスプローラーへ関連付けの変更を通知する。失敗してもアプリの動作には影響しないため、
    /// 例外はログに記録するだけで握りつぶす(shell32.dllが無い環境での実行など)。
    /// </summary>
    public static void NotifyShell()
    {
        try
        {
            SHChangeNotify(SHCNE_ASSOCCHANGED, SHCNF_IDLIST | SHCNF_FLUSH, IntPtr.Zero, IntPtr.Zero);
            Logger.Write("FileAssociationService: SHChangeNotifyでエクスプローラーへ関連付けの変更を通知した");
        }
        catch (Exception ex)
        {
            Logger.WriteException("FileAssociationService.NotifyShell失敗", ex);
        }
    }

    /// <summary>
    /// 渡した拡張子のうち、Windowsの「既定のアプリ」設定(UserChoice)で他アプリが選ばれているため
    /// Paneの関連付けが反映されないものを返す。UserChoiceはHKCU\Software\Classes\.extより優先され、
    /// かつWindows 10以降はハッシュ保護されていてアプリ側から書き換えられない(書き換えるべきでもない)。
    /// 該当した場合はユーザーに手動での切り替えを案内するしかないため、その判定材料として使う。
    /// </summary>
    public static IReadOnlyList<string> FindExtensionsBlockedByUserChoice(IReadOnlyCollection<string> extensions)
    {
        var blocked = new List<string>();
        foreach (string ext in Normalize(extensions))
        {
            try
            {
                using RegistryKey? userChoice = Registry.CurrentUser.OpenSubKey($@"{FileExtsKeyPath}\.{ext}\UserChoice");
                if (userChoice?.GetValue("ProgId") is not string progId) continue;
                if (progId == ProgIdFor(ext)) continue;
                blocked.Add(ext);
            }
            catch (Exception ex)
            {
                // 読み取れないだけなら「不明」として扱い、案内対象には入れない。
                Logger.WriteException($"FileAssociationService: .{ext} のUserChoice読み取りに失敗", ex);
            }
        }

        if (blocked.Count > 0)
        {
            Logger.Write($"FileAssociationService: UserChoiceで他アプリが既定になっている拡張子: {string.Join(",", blocked)}");
        }
        return blocked;
    }

    /// <summary>
    /// 拡張子集合を関連付ける。ProgIDの作成と、拡張子キーの既定値をそのProgIDへ向ける処理のみを行う
    /// (Capabilities/RegisteredApplications はここでは更新しない。<see cref="Apply"/> または
    /// <see cref="UpdateCapabilities"/> 経由で「対象拡張子すべて」の状態を書き直すこと)。
    /// </summary>
    public static void Register(IReadOnlyCollection<string> extensions)
    {
        HashSet<string> exts = Normalize(extensions);
        if (exts.Count == 0) return;

        try
        {
            string exePath = Environment.ProcessPath ?? Path.Combine(AppContext.BaseDirectory, "Pane.exe");

            foreach (string ext in exts)
            {
                string progId = ProgIdFor(ext);

                // 1. ProgID本体 (HKCU\Software\Classes\Pane.File.<ext>)
                using (RegistryKey progIdKey = Registry.CurrentUser.CreateSubKey($@"Software\Classes\{progId}"))
                {
                    progIdKey.SetValue(string.Empty, $"{ext.ToUpperInvariant()} ドキュメント");
                    using RegistryKey iconKey = progIdKey.CreateSubKey("DefaultIcon");
                    iconKey.SetValue(string.Empty, $"\"{exePath}\",0");
                    using RegistryKey commandKey = progIdKey.CreateSubKey(@"shell\open\command");
                    commandKey.SetValue(string.Empty, $"\"{exePath}\" \"%1\"");
                }

                // 2. 拡張子ごとの古典的な関連付け (HKCU\Software\Classes\.<ext> の既定値)
                using RegistryKey extKey = Registry.CurrentUser.CreateSubKey($@"Software\Classes\.{ext}");
                extKey.SetValue(string.Empty, progId);
            }

            Logger.Write($"FileAssociationService.Register: {string.Join(",", exts)}");
        }
        catch (Exception ex) when (ex is UnauthorizedAccessException or System.Security.SecurityException or IOException)
        {
            Logger.WriteException("FileAssociationService.Register失敗", ex);
            throw;
        }
    }

    /// <summary>
    /// 拡張子集合の関連付けを解除する。自分(Pane)が設定した関連付けの場合のみ削除する
    /// (他アプリが横取り済みなら触らない)。あわせて、旧ProgID("Pane.MarkdownFile")が
    /// 残っていれば掃除するフォールバックも実行する。
    /// </summary>
    public static void Unregister(IReadOnlyCollection<string> extensions)
    {
        HashSet<string> exts = Normalize(extensions);
        if (exts.Count == 0) return;

        try
        {
            foreach (string ext in exts)
            {
                string progId = ProgIdFor(ext);

                using (RegistryKey? extKey = Registry.CurrentUser.OpenSubKey($@"Software\Classes\.{ext}", writable: true))
                {
                    string? current = extKey?.GetValue(string.Empty) as string;
                    // 新ProgID・旧ProgIDのどちらでも、自分が設定したものであれば削除する。
                    if (current == progId || current == LegacyProgId)
                    {
                        Registry.CurrentUser.DeleteSubKeyTree($@"Software\Classes\.{ext}", throwOnMissingSubKey: false);
                    }
                }

                Registry.CurrentUser.DeleteSubKeyTree($@"Software\Classes\{progId}", throwOnMissingSubKey: false);
            }

            // フォールバック: 旧実装の単一ProgIDキー自体が残っていれば、もう使われていないので
            // ここで併せて削除する(片方の拡張子だけ解除してももう片方を壊さないようにするための後始末)。
            Registry.CurrentUser.DeleteSubKeyTree($@"Software\Classes\{LegacyProgId}", throwOnMissingSubKey: false);

            Logger.Write($"FileAssociationService.Unregister: {string.Join(",", exts)}");
        }
        catch (Exception ex) when (ex is UnauthorizedAccessException or System.Security.SecurityException or IOException)
        {
            Logger.WriteException("FileAssociationService.Unregister失敗", ex);
            throw;
        }
    }

    /// <summary>
    /// 「既定のアプリ」設定に表示するための Capabilities / RegisteredApplications を、
    /// 渡された拡張子集合「すべて」で書き直す(部分更新ではなく、常に全体を反映する)。
    /// 対象拡張子が0件になった場合はCapabilitiesキー自体を削除し、一覧からも消す。
    /// </summary>
    private static void UpdateCapabilities(IReadOnlyCollection<string> allExtensions)
    {
        HashSet<string> exts = Normalize(allExtensions);

        try
        {
            if (exts.Count == 0)
            {
                Registry.CurrentUser.DeleteSubKeyTree($@"Software\{AppRegisteredName}", throwOnMissingSubKey: false);
                using RegistryKey? registeredAppsKey = Registry.CurrentUser.OpenSubKey(@"Software\RegisteredApplications", writable: true);
                registeredAppsKey?.DeleteValue(AppRegisteredName, throwOnMissingValue: false);
                return;
            }

            using (RegistryKey capKey = Registry.CurrentUser.CreateSubKey($@"Software\{AppRegisteredName}\Capabilities"))
            {
                capKey.SetValue("ApplicationName", "Pane");
                capKey.SetValue("ApplicationDescription", "Markdown対応メモ帳");

                // 前回より減った拡張子の値が残留しないよう、一旦削除してから全件書き直す。
                capKey.DeleteSubKeyTree("FileAssociations", throwOnMissingSubKey: false);
                using RegistryKey fileAssocKey = capKey.CreateSubKey("FileAssociations");
                foreach (string ext in exts)
                {
                    fileAssocKey.SetValue($".{ext}", ProgIdFor(ext));
                }
            }

            using (RegistryKey registeredAppsKey = Registry.CurrentUser.CreateSubKey(@"Software\RegisteredApplications"))
            {
                registeredAppsKey.SetValue(AppRegisteredName, $@"Software\{AppRegisteredName}\Capabilities");
            }
        }
        catch (Exception ex) when (ex is UnauthorizedAccessException or System.Security.SecurityException or IOException)
        {
            Logger.WriteException("FileAssociationService.UpdateCapabilities失敗", ex);
            throw;
        }
    }
}
