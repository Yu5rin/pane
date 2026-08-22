using System.Diagnostics;
using System.Reflection;
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
/// <summary>
/// 現在レジストリに登録されている「ファイルをダブルクリックしたときに起動するexe」の状態。
/// 設定画面(src/settings.js)へそのまま渡して表示するためのもの。
///
/// Paneはインストーラ無しのポータブル配布(仕様書 第7.1節)で置き場所が自由。関連付けは
/// 登録した時点のexeのフルパスをレジストリへ書くため、新しいバージョンを別の場所に置いて
/// 使い始めても、ダブルクリックでは古いバージョンが起動し続ける。実際に v1.0.0 を掴んだまま
/// v1.0.1 を使っているつもりになる事故が起きたため、判定は「パスが違うかどうか」ではなく
/// 「関連付け先のexeのバージョンが今より古いかどうか」で行う(同じバージョンが別の場所に
/// あるだけなら問題は起きないので警告しない)。
/// </summary>
/// <param name="Status">
/// "older"   … 関連付け先が今より古いバージョン(これが主な警告対象)。
/// "same"    … 今と同じバージョン(パスが違っていても問題なし)。
/// "newer"   … 今より新しいバージョン。上書きすると新しい版が起動しなくなるため文言を分ける。
/// "unknown" … exeはあるがバージョンを読み取れなかった。
/// "missing" … 登録はあるが、そのパスにexeが存在しない(壊れている)。
/// "none"    … 関連付けが1つも登録されていない。
/// </param>
/// <param name="RegisteredPath">レジストリに登録されている代表的なexeのパス(未登録なら空文字)。</param>
/// <param name="CurrentPath">今動いているPaneのexeのパス。</param>
/// <param name="ExtensionCount">実際に登録が見つかった拡張子の数。</param>
/// <param name="RegisteredVersion">関連付け先exeのバージョン表記(読めなければ空文字)。</param>
/// <param name="CurrentVersion">今動いているPaneのバージョン表記(読めなければ空文字)。</param>
internal sealed record AssociationTarget(
    string Status,
    string RegisteredPath,
    string CurrentPath,
    int ExtensionCount,
    string RegisteredVersion,
    string CurrentVersion);

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

    /// <summary>
    /// 今動いているPaneのexeのフルパス。関連付けの登録時に書き込む値であり、
    /// 「現在の登録先が自分自身かどうか」の比較の基準でもあるため、
    /// 両者で必ず同じ値を使うようここへ一本化する。
    /// </summary>
    public static string CurrentExePath => Environment.ProcessPath ?? Path.Combine(AppContext.BaseDirectory, "Pane.exe");

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
    /// 1つの拡張子について、いまレジストリに登録されている起動コマンドのexeパスを返す。
    /// 読むのは登録時に書いたのと同じ
    /// <c>HKCU\Software\Classes\Pane.File.&lt;ext&gt;\shell\open\command</c> の既定値で、
    /// 値は <c>"C:\...\Pane.exe" "%1"</c> の形なので先頭の引用符で囲まれた部分を取り出す。
    /// 未登録・読めない場合はnullを返す(読み取りだけなので例外は投げない)。
    /// </summary>
    public static string? ReadRegisteredExePath(string extension)
    {
        string ext = extension.TrimStart('.').ToLowerInvariant();
        if (ext.Length == 0) return null;

        try
        {
            using RegistryKey? key = Registry.CurrentUser.OpenSubKey($@"Software\Classes\{ProgIdFor(ext)}\shell\open\command");
            if (key?.GetValue(string.Empty) is not string command) return null;
            return ExtractExePath(command);
        }
        catch (Exception ex)
        {
            // 表示のための読み取りにすぎないので、失敗しても「不明(未登録扱い)」として続ける。
            Logger.WriteException($"FileAssociationService: .{ext} の登録先exeパスの読み取りに失敗", ex);
            return null;
        }
    }

    /// <summary>
    /// レジストリの起動コマンド文字列からexeのパスだけを取り出す。
    /// 通常は <c>"C:\...\Pane.exe" "%1"</c> のように引用符で囲まれているが、
    /// 手で書き換えられて引用符が無い場合もあるため、その場合は最初の空白までを採る。
    /// </summary>
    internal static string? ExtractExePath(string command)
    {
        string text = (command ?? string.Empty).Trim();
        if (text.Length == 0) return null;

        if (text[0] == '"')
        {
            int end = text.IndexOf('"', 1);
            if (end <= 1) return null;
            return text.Substring(1, end - 1);
        }

        int space = text.IndexOf(' ');
        string candidate = space < 0 ? text : text.Substring(0, space);
        return candidate.Length == 0 ? null : candidate;
    }

    /// <summary>
    /// Windowsのパスは大文字小文字を区別せず、相対要素("..")や末尾の区切りでも同じ場所を指すため、
    /// 比較前に <see cref="Path.GetFullPath(string)"/> で正規化する。
    /// 正規化できない文字列(不正なパス)はそのまま返し、比較で一致しない側へ倒す。
    /// </summary>
    private static string NormalizeForCompare(string path)
    {
        try
        {
            return Path.GetFullPath(path).TrimEnd('\\', '/');
        }
        catch (Exception ex) when (ex is ArgumentException or NotSupportedException or PathTooLongException or System.Security.SecurityException)
        {
            return path;
        }
    }

    /// <summary>
    /// 今動いているPane自身のバージョン表記("1.0.1")を返す。読めなければnull。
    ///
    /// .NETの AssemblyName.Version は仕様上どうしても4桁(1.0.1.0)になるため、
    /// csprojの&lt;Version&gt;から作られる InformationalVersion("1.0.1")を優先して使う
    /// (Pane.csproj のコメント参照)。設定の「バージョン情報」に出る表記
    /// (SettingsBridge.DetectAppVersion)と必ず同じ値になるよう、取得はここへ一本化し、
    /// 向こうからもこれを呼ぶ。関連付け先exeのバージョンは ProductVersion から読むので、
    /// どちらも「csprojの&lt;Version&gt;由来の3桁表記」という同じ土俵で比較できる。
    /// </summary>
    public static string? ReadOwnVersionText()
    {
        string? informational = Assembly.GetExecutingAssembly()
            .GetCustomAttribute<AssemblyInformationalVersionAttribute>()?.InformationalVersion;
        if (!string.IsNullOrWhiteSpace(informational))
        {
            // ビルド環境によっては "1.0.1+<コミットハッシュ>" の形になるため、"+"以降は落とす。
            int plus = informational.IndexOf('+');
            return plus >= 0 ? informational[..plus] : informational;
        }

        // InformationalVersionが取れない場合は4桁から先頭3つだけを使う。
        Version? v = Assembly.GetExecutingAssembly().GetName().Version;
        return v?.ToString(3);
    }

    /// <summary>
    /// 指定したexeのバージョン表記を返す。読めなければnull。
    /// ProductVersion は AssemblyInformationalVersion から作られるため3桁("1.0.1")で、
    /// 自分自身のバージョン(<see cref="ReadOwnVersionText"/>)とそのまま比較できる。
    /// 取れない場合のみ、4桁になる FileVersion("1.0.1.0")へフォールバックする
    /// (桁数の違いは <see cref="ParseVersion"/> が4桁へ揃えて吸収する)。
    /// </summary>
    public static string? ReadExeVersionText(string exePath)
    {
        try
        {
            FileVersionInfo info = FileVersionInfo.GetVersionInfo(exePath);
            string? text = info.ProductVersion;
            if (string.IsNullOrWhiteSpace(text)) text = info.FileVersion;
            return string.IsNullOrWhiteSpace(text) ? null : text.Trim();
        }
        catch (Exception ex)
        {
            // 表示のための読み取りにすぎないので、失敗しても「バージョン不明」として続ける。
            Logger.WriteException($"FileAssociationService: exeのバージョン読み取りに失敗: {exePath}", ex);
            return null;
        }
    }

    /// <summary>
    /// バージョン表記を比較可能な <see cref="Version"/> に変換する。読めなければnull。
    ///
    /// 比較は必ずここを通す(文字列一致では "1.0.10" と "1.0.9" の大小を誤るため)。
    /// あわせて次の2点を吸収する。
    ///   ・"1.0.1+&lt;ハッシュ&gt;" / "1.0.1-beta" のような追記を落とす。
    ///   ・Versionは桁数が違うと同じ番号でも等しくならない(1.0.1 と 1.0.1.0)ので、
    ///     欠けている桁を0で埋めて必ず4桁に揃える。
    /// </summary>
    internal static Version? ParseVersion(string? text)
    {
        if (string.IsNullOrWhiteSpace(text)) return null;

        string core = text.Trim();
        int plus = core.IndexOf('+');
        if (plus >= 0) core = core[..plus];
        int hyphen = core.IndexOf('-');
        if (hyphen >= 0) core = core[..hyphen];

        if (!Version.TryParse(core, out Version? v)) return null;
        return new Version(
            Math.Max(v.Major, 0),
            Math.Max(v.Minor, 0),
            Math.Max(v.Build, 0),
            Math.Max(v.Revision, 0));
    }

    /// <summary>
    /// 状態の深刻さ(小さいほど深刻)。複数の拡張子でバラバラの登録が残っている場合に、
    /// いちばん問題のあるものを代表として画面に出すために使う。
    /// </summary>
    private static int SeverityRank(string status) => status switch
    {
        "missing" => 0,
        "older" => 1,
        "unknown" => 2,
        "newer" => 3,
        _ => 4, // same
    };

    /// <summary>
    /// 登録先exeのパス1つを、今動いているPaneと比べて状態へ分類する。
    /// </summary>
    private static (string Status, string? VersionText) ClassifyRegistered(
        string registeredPath, string currentPath, Version? currentVersion, string? currentVersionText)
    {
        // 今動いているexe自身を指しているなら、ファイルを読み直すまでもなく同じバージョン。
        if (NormalizeForCompare(registeredPath).Equals(NormalizeForCompare(currentPath), StringComparison.OrdinalIgnoreCase))
        {
            return ("same", currentVersionText);
        }

        bool exists;
        try
        {
            exists = File.Exists(registeredPath);
        }
        catch (Exception ex)
        {
            // 存在確認そのものに失敗した場合は「壊れている」と断定せず、バージョン不明として扱う。
            Logger.WriteException($"FileAssociationService: 登録先exeの存在確認に失敗: {registeredPath}", ex);
            return ("unknown", null);
        }
        if (!exists) return ("missing", null);

        string? versionText = ReadExeVersionText(registeredPath);
        Version? registeredVersion = ParseVersion(versionText);
        if (registeredVersion is null || currentVersion is null) return ("unknown", versionText);

        int cmp = registeredVersion.CompareTo(currentVersion);
        if (cmp < 0) return ("older", versionText);
        if (cmp > 0) return ("newer", versionText);
        return ("same", versionText);
    }

    /// <summary>
    /// 渡した拡張子群について、いまレジストリに登録されている関連付け先を調べて返す
    /// (設定画面の「現在の関連付け先」表示用)。レジストリへの書き込みは一切行わない
    /// (設定画面を開いただけで関連付けが変わることは無い)。
    ///
    /// 登録が1つも見つからなければ "none"。見つかった場合は拡張子ごとに状態を求め、
    /// いちばん深刻なもの(<see cref="SeverityRank"/>)を代表として返す
    /// (一部の拡張子だけ古いバージョンを指したまま残っている状態を見逃さないため)。
    /// </summary>
    public static AssociationTarget GetCurrentTarget(IReadOnlyCollection<string> extensions)
    {
        string currentPath = CurrentExePath;
        string? currentVersionText = ReadOwnVersionText();
        Version? currentVersion = ParseVersion(currentVersionText);

        string bestStatus = "none";
        string? bestPath = null;
        string? bestVersionText = null;
        int bestRank = int.MaxValue;
        int registeredCount = 0;

        foreach (string ext in Normalize(extensions))
        {
            string? registeredPath = ReadRegisteredExePath(ext);
            if (registeredPath is null) continue;
            registeredCount++;

            (string status, string? versionText) = ClassifyRegistered(registeredPath, currentPath, currentVersion, currentVersionText);
            int rank = SeverityRank(status);
            if (rank >= bestRank) continue;

            bestRank = rank;
            bestStatus = status;
            bestPath = registeredPath;
            bestVersionText = versionText;
        }

        if (registeredCount == 0)
        {
            // 「1つも登録していない」は初期状態そのもので異常ではない。設定画面を開くたびに
            // 出るため詳細ログへ回す。
            Logger.Debug("FileAssociationService.GetCurrentTarget: 関連付けの登録は見つからなかった");
            return new AssociationTarget("none", string.Empty, currentPath, 0, string.Empty, currentVersionText ?? string.Empty);
        }

        string summary = $"FileAssociationService.GetCurrentTarget: status={bestStatus}, 登録先={bestPath}, " +
                         $"登録先バージョン={bestVersionText ?? "不明"}, 現在={currentPath}({currentVersionText ?? "不明"}), 対象拡張子数={registeredCount}";
        // 状態によって重要度を変える。"same"(今のexeが関連付けられている=正常)は設定画面を
        // 開くたび・保存するたびに出るため詳細ログへ落とし、そうでないものは既定のログに残す。
        // 特に "older"/"missing" は、ファイルをダブルクリックすると古い版や存在しないexeが
        // 起動しようとする状態で、実機で実際に起きた不具合そのもの。ログを一目見て
        // 気づけるよう警告として記録する。
        if (bestStatus is "older" or "missing") Logger.Warn(summary);
        else if (bestStatus == "same") Logger.Debug(summary);
        else Logger.Write(summary);

        return new AssociationTarget(
            bestStatus,
            bestPath ?? string.Empty,
            currentPath,
            registeredCount,
            bestVersionText ?? string.Empty,
            currentVersionText ?? string.Empty);
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
            string exePath = CurrentExePath;

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
