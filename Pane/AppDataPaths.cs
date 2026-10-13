namespace Pane;

/// <summary>
/// 設定・ログ・カスタムCSS・自動保存の置き場所(仕様書 第7.1節)。判断は<see cref="DataFolderLogic"/>。
///
/// 起動の一番はじめ(<see cref="Program"/>がログを書くより前)に<see cref="Initialize"/>を呼ぶ。
/// ログの置き場所もここで決まるため、ここで起きたことはその場では書かず控えておき、
/// <see cref="FlushStartupNotes"/>でまとめてログへ出す。
/// </summary>
internal static class AppDataPaths
{
    private static readonly object Gate = new();
    private static string? _root;
    private static bool _portable;
    private static readonly List<string> StartupNotes = new();

    /// <summary>以前の置き場所(%LOCALAPPDATA%\Pane)。WebView2の作業用データは今もここ。</summary>
    public static string LegacyRoot { get; } = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Pane");

    /// <summary>設定などを置くフォルダ。exeの隣の data か、書き込めなければ<see cref="LegacyRoot"/>。</summary>
    public static string Root
    {
        get
        {
            lock (Gate)
            {
                if (_root is null) Resolve();
                return _root!;
            }
        }
    }

    /// <summary>exeの隣の data を使っているか。</summary>
    public static bool IsPortable { get { _ = Root; return _portable; } }

    public static string LogsFolder => Path.Combine(Root, "logs");
    public static string ThemesFolder => Path.Combine(Root, "themes");
    public static string AutoSaveFolder => Path.Combine(Root, "autosave");

    /// <summary>WebView2の作業用データ。運ぶ必要が無いので<see cref="LegacyRoot"/>のまま。</summary>
    public static string WebView2Folder => Path.Combine(LegacyRoot, "WebView2");

    /// <summary>置き場所を決め、必要なら以前の置き場所から引き継ぐ。何度呼んでもよい。</summary>
    public static void Initialize() => _ = Root;

    /// <summary>起動時に控えたことをログへ書く。ログの置き場所が決まってから呼ぶ。</summary>
    public static void FlushStartupNotes()
    {
        List<string> notes;
        lock (Gate)
        {
            notes = StartupNotes.ToList();
            StartupNotes.Clear();
        }
        foreach (string note in notes) Logger.Write(note);
    }

    private static void Resolve()
    {
        string? exeDirectory = Path.GetDirectoryName(Environment.ProcessPath ?? "");
        (string root, bool portable) = DataFolderLogic.DecideRoot(exeDirectory, LegacyRoot, CanWrite);
        _root = root;
        _portable = portable;
        StartupNotes.Add($"データの置き場所: {(portable ? "exeの隣" : "%LOCALAPPDATA%(exeの隣へ書き込めないため)")} {root}");
        if (portable) MigrateFromLegacy(root);
    }

    /// <summary>そのフォルダを作り、ファイルを書いて消せるか。</summary>
    private static bool CanWrite(string folder)
    {
        try
        {
            Directory.CreateDirectory(folder);
            string probe = Path.Combine(folder, $".write-test-{Guid.NewGuid():N}");
            File.WriteAllText(probe, "");
            File.Delete(probe);
            return true;
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or NotSupportedException or ArgumentException)
        {
            return false;
        }
    }

    /// <summary>
    /// 初めて data を使うとき、%LOCALAPPDATA%\Pane にあるものをコピーする。元は消さない。
    /// 途中で失敗しても起動は続ける(コピーできたものだけで動き、元の場所には全部残っている)。
    /// </summary>
    private static void MigrateFromLegacy(string root)
    {
        try
        {
            bool portableIsEmpty = !Directory.EnumerateFileSystemEntries(root).Any();
            bool legacyHasEntries = Directory.Exists(LegacyRoot)
                && Directory.EnumerateFileSystemEntries(LegacyRoot).Any(e => DataFolderLogic.IsMigrated(Path.GetFileName(e)));
            if (!DataFolderLogic.ShouldMigrate(portable: true, portableIsEmpty, legacyHasEntries)) return;

            int copied = 0;
            foreach (string entry in Directory.EnumerateFileSystemEntries(LegacyRoot))
            {
                string name = Path.GetFileName(entry);
                if (!DataFolderLogic.IsMigrated(name)) continue;
                string target = Path.Combine(root, name);
                if (Directory.Exists(entry)) copied += CopyDirectory(entry, target);
                else { File.Copy(entry, target, overwrite: false); copied++; }
            }
            StartupNotes.Add($"データの置き場所: 以前の場所({LegacyRoot})から{copied}個のファイルを引き継いだ(元の場所はそのまま残す)");
        }
        catch (Exception ex)
        {
            StartupNotes.Add($"データの置き場所: 以前の場所からの引き継ぎが途中で失敗した(元の場所には残っている): {ex.GetType().Name}: {ex.Message}");
        }
    }

    private static int CopyDirectory(string source, string target)
    {
        int count = 0;
        Directory.CreateDirectory(target);
        foreach (string file in Directory.EnumerateFiles(source))
        {
            File.Copy(file, Path.Combine(target, Path.GetFileName(file)), overwrite: false);
            count++;
        }
        foreach (string dir in Directory.EnumerateDirectories(source))
        {
            count += CopyDirectory(dir, Path.Combine(target, Path.GetFileName(dir)));
        }
        return count;
    }

    /// <summary>
    /// 設定のカスタムCSSのパスが、引き継ぐ前の場所や、移す前のexeのフォルダを指していれば、
    /// 今のカスタムCSSフォルダへ付け替える(<see cref="DataFolderLogic.RebaseThemePath"/>)。
    /// 起動時に一度呼ぶ。
    /// </summary>
    public static void RepairCustomCssPath()
    {
        try
        {
            AppSettings settings = SettingsService.Load();
            string? rebased = DataFolderLogic.RebaseThemePath(
                settings.CustomCssPath, Path.Combine(LegacyRoot, "themes"), ThemesFolder, File.Exists);
            if (rebased is null) return;
            SettingsService.Update(s => s.CustomCssPath = rebased);
            Logger.Write($"カスタムCSSの指定を今のフォルダへ付け替えた: {PrivacyLogFormatter.ShortenPath(rebased)}");
        }
        catch (Exception ex)
        {
            Logger.WriteException("カスタムCSSの指定の付け替えに失敗(そのまま続ける)", ex);
        }
    }
}
