using System.Diagnostics;

namespace Pane;

/// <summary>サイドバーのファイル一覧・ツリー表示に使う1エントリ。</summary>
internal sealed record FolderEntry(string Path, string Name, string RelativePath, bool IsDirectory);

/// <summary>フォルダ走査の結果。</summary>
internal sealed record FolderScanResult(string RootPath, string RootName, List<FolderEntry> Entries, bool Truncated);

/// <summary>
/// 読み込んだフォルダ配下のファイル一覧を非同期で収集するサービス(仕様書 第2.8節・第8.3節)。
/// サイドバーのファイルリスト・ファイルツリーの両方をこの結果1つでまかなう
/// (ツリー化はJS側でRelativePathの区切りから組み立てる)。
/// </summary>
internal static class FolderService
{
    // Paneが開けるファイルの拡張子一覧は src/file-types.js を単一の情報源(single source of
    // truth)とし、scripts/build.js がそこから Pane/FileTypes.generated.cs を自動生成している。
    // ここでは重複定義せず、FileTypes.OpenableExtensions をそのまま参照する
    // (仕様書 第2.8節「ツリーに表示するのは、Paneが開けるファイルのみ」)。

    /// <summary>
    /// 走査から除外するフォルダ名。仕様書には明記が無いが、これらを含めると
    /// (特にnode_modulesやbin/obj)エントリ数が爆発して上限にすぐ達したり、
    /// バージョン管理・ビルド成果物が延々と列挙されてしまい実用にならないため除外する。
    /// </summary>
    private static readonly HashSet<string> ExcludedDirectoryNames = new(StringComparer.OrdinalIgnoreCase)
    {
        ".git", ".svn", ".hg", "node_modules", "bin", "obj", "dist", ".vs", ".idea",
    };

    /// <summary>
    /// 巨大なフォルダ(例: ホームディレクトリを誤って開いた場合)を走査して固まるのを防ぐ
    /// ための安全弁。この件数に達したら打ち切り、Truncated=trueを返す。
    /// </summary>
    private const int MaxEntries = 10000;

    /// <summary>
    /// rootPath配下を再帰的に走査する。仕様書 第8.3節「フォルダ読み込みは非同期。
    /// ファイル数が多い場合も編集操作をブロックしない」に基づき、Task.Runで
    /// バックグラウンドスレッド上で実行する。
    /// </summary>
    /// <param name="rootPath">走査対象のルートフォルダ。</param>
    /// <param name="showHiddenFiles">設定 showHiddenFilesInTree。trueなら隠し・システム属性の
    /// ファイル/フォルダ、およびドット始まりの名前も含める(既定false=従来どおり除外)。</param>
    /// <param name="excludePatterns">設定 fileTreePatterns。GlobMatcherで判定し、除外に該当する
    /// ファイル・フォルダを走査結果から取り除く(既定は空=何も除外しない)。</param>
    public static Task<FolderScanResult> ScanAsync(
        string rootPath, bool showHiddenFiles = false, IReadOnlyList<string>? excludePatterns = null, CancellationToken ct = default)
    {
        excludePatterns ??= Array.Empty<string>();
        return Task.Run(() =>
        {
            string fullRoot = Path.GetFullPath(rootPath);
            var entries = new List<FolderEntry>();
            bool truncated = false;

            // フォルダの走査はファイル数しだいでいくらでも重くなる。所要時間を必ず添え、
            // 一定を超えたらPerfWatchが警告として別行を残す。
            long startTimestamp = System.Diagnostics.Stopwatch.GetTimestamp();
            ScanDirectory(fullRoot, fullRoot, entries, ref truncated, showHiddenFiles, excludePatterns, ct);
            long elapsedMs = (long)System.Diagnostics.Stopwatch.GetElapsedTime(startTimestamp).TotalMilliseconds;
            Logger.Write($"FolderService.ScanAsync: {fullRoot}, 件数={entries.Count}, truncated={truncated}, " +
                         $"showHiddenFiles={showHiddenFiles}, excludePatterns={excludePatterns.Count}件, {elapsedMs}ms");
            PerfWatch.Report($"フォルダの走査({entries.Count}件)", elapsedMs, 1000);

            // ディレクトリ優先→名前順(大小文字を区別しない)で安定した表示順にする。
            entries.Sort((a, b) =>
            {
                if (a.IsDirectory != b.IsDirectory) return a.IsDirectory ? -1 : 1;
                return string.Compare(a.Name, b.Name, StringComparison.OrdinalIgnoreCase);
            });

            return new FolderScanResult(fullRoot, Path.GetFileName(fullRoot.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar)), entries, truncated);
        }, ct);
    }

    private static void ScanDirectory(
        string rootPath, string currentDir, List<FolderEntry> entries, ref bool truncated,
        bool showHiddenFiles, IReadOnlyList<string> excludePatterns, CancellationToken ct)
    {
        if (truncated) return;
        ct.ThrowIfCancellationRequested();

        IEnumerable<string> subDirs;
        IEnumerable<string> files;
        try
        {
            subDirs = Directory.EnumerateDirectories(currentDir);
            files = Directory.EnumerateFiles(currentDir);
        }
        catch (Exception ex) when (ex is UnauthorizedAccessException or IOException)
        {
            // アクセス拒否等が起きたフォルダはスキップして走査を継続する
            // (1つの権限エラーで走査全体が失敗しないようにするため)。
            Logger.Write($"FolderService.ScanDirectory: アクセス不可のためスキップ: {currentDir} ({ex.GetType().Name})");
            return;
        }

        foreach (string dir in subDirs)
        {
            ct.ThrowIfCancellationRequested();
            string name = Path.GetFileName(dir);

            // VCS・ビルド成果物のフォルダは、隠しファイル表示の設定に関わらず常に除外する
            // (「隠しファイルを表示する」は"見えないファイルを見せる"設定であり、.gitの中身のような
            // ノイズをあえて列挙したいという意図ではないと判断したため。既存のこの判断はそのまま残す)。
            if (ExcludedDirectoryNames.Contains(name))
            {
                continue;
            }

            // 隠しファイル表示がOFF(既定)のときだけ、ドット始まりの名前・Hidden/System属性を除外する。
            // ドット始まりの判定はOS非依存(Windows以外の開発・テスト環境でも同じ結果になる)なので、
            // FileAttributes.Hiddenが実際には付いていない環境でも一貫して隠しファイル扱いにできる。
            if (!showHiddenFiles && (name.StartsWith('.') || IsHiddenOrSystem(dir)))
            {
                continue;
            }

            string dirRelativePath = ToRelativePath(rootPath, dir);
            if (GlobMatcher.IsExcluded(dirRelativePath, excludePatterns))
            {
                continue; // 除外パターンに一致したフォルダは、配下ごと走査しない(.gitignoreと同じ考え方)
            }

            if (entries.Count >= MaxEntries)
            {
                truncated = true;
                return;
            }

            entries.Add(new FolderEntry(dir, name, dirRelativePath, IsDirectory: true));
            ScanDirectory(rootPath, dir, entries, ref truncated, showHiddenFiles, excludePatterns, ct);
            if (truncated) return;
        }

        foreach (string file in files)
        {
            ct.ThrowIfCancellationRequested();

            if (!HasOpenableExtension(file))
            {
                continue;
            }

            // ファイル側は元々ドット始まりを特別扱いしていなかった(隠しフォルダの除外とは非対称だが、
            // showHiddenFiles=false時の「従来の見た目」を保つため、その非対称性はそのまま残す)。
            if (!showHiddenFiles && IsHiddenOrSystem(file))
            {
                continue;
            }

            string name = Path.GetFileName(file);
            string relativePath = ToRelativePath(rootPath, file);
            if (GlobMatcher.IsExcluded(relativePath, excludePatterns))
            {
                continue;
            }

            if (entries.Count >= MaxEntries)
            {
                truncated = true;
                return;
            }

            entries.Add(new FolderEntry(file, name, relativePath, IsDirectory: false));
        }
    }

    private static bool HasOpenableExtension(string path)
    {
        string ext = Path.GetExtension(path);
        if (ext.Length <= 1) return false; // 拡張子なしのファイルは対象外
        return FileTypes.OpenableExtensions.Contains(ext[1..]); // 先頭の'.'を除く
    }

    private static bool IsHiddenOrSystem(string path)
    {
        try
        {
            FileAttributes attrs = File.GetAttributes(path);
            return attrs.HasFlag(FileAttributes.Hidden) || attrs.HasFlag(FileAttributes.System);
        }
        catch (Exception ex) when (ex is UnauthorizedAccessException or IOException)
        {
            // 属性すら取得できない場合は安全側に倒して除外する
            return true;
        }
    }

    /// <summary>rootPathからの相対パス。JS側で扱いやすいよう区切り文字を'/'に正規化する。</summary>
    private static string ToRelativePath(string rootPath, string fullPath)
    {
        return Path.GetRelativePath(rootPath, fullPath).Replace(Path.DirectorySeparatorChar, '/').Replace(Path.AltDirectorySeparatorChar, '/');
    }

    // ---- サイドバーの右クリックメニュー(docs/コンテキストメニュー仕様.md 第4.2節・第4.3節) ----

    /// <summary>「開く」(既定のビューアで開く。仕様書 2.4「画像を開く」)。
    /// エクスポート後の「開く」(MainForm.ApplyExportAfter)と同じ流儀(UseShellExecute=true)。</summary>
    public static void OpenInDefaultApp(string path)
    {
        try
        {
            using var proc = Process.Start(new ProcessStartInfo(path) { UseShellExecute = true });
            Logger.Write($"open-in-default-app: {PrivacyLogFormatter.ShortenPathOrUri(path)}");
            Logger.Debug($"open-in-default-app(完全な形): {path}");
        }
        catch (Exception ex)
        {
            Logger.WriteException($"open-in-default-app失敗: {path}", ex);
        }
    }

    /// <summary>「エクスプローラーで表示」(仕様書 4.2・4.3)。SettingsBridge.OpenSettingsFileInExplorer
    /// と同じ /select, 方式。</summary>
    public static void RevealInExplorer(string path)
    {
        try
        {
            using var proc = Process.Start(new ProcessStartInfo("explorer.exe", $"/select,\"{path}\"") { UseShellExecute = true });
            Logger.Write($"reveal-in-explorer: {PrivacyLogFormatter.ShortenPath(path)}");
            Logger.Debug($"reveal-in-explorer(フルパス): {path}");
        }
        catch (Exception ex)
        {
            Logger.WriteException($"reveal-in-explorer失敗: {path}", ex);
        }
    }

    /// <summary>「削除(ごみ箱へ)」(仕様書 4.2)。Microsoft.VisualBasic.FileIOの
    /// RecycleOption.SendToRecycleBinで、完全削除ではなくごみ箱へ送る(誤操作からの復旧余地を残す)。</summary>
    public static bool DeleteToRecycleBin(string path, out string? error)
    {
        error = null;
        try
        {
            if (Directory.Exists(path))
            {
                Microsoft.VisualBasic.FileIO.FileSystem.DeleteDirectory(
                    path, Microsoft.VisualBasic.FileIO.UIOption.OnlyErrorDialogs, Microsoft.VisualBasic.FileIO.RecycleOption.SendToRecycleBin);
            }
            else if (File.Exists(path))
            {
                Microsoft.VisualBasic.FileIO.FileSystem.DeleteFile(
                    path, Microsoft.VisualBasic.FileIO.UIOption.OnlyErrorDialogs, Microsoft.VisualBasic.FileIO.RecycleOption.SendToRecycleBin);
            }
            else
            {
                error = "対象が見つかりません。";
                return false;
            }
            Logger.Write($"delete-path: ごみ箱へ送った: {PrivacyLogFormatter.ShortenPath(path)}");
            Logger.Debug($"delete-path(フルパス): {path}");
            return true;
        }
        catch (Exception ex)
        {
            Logger.WriteException($"delete-path失敗: {path}", ex);
            error = ex.Message;
            return false;
        }
    }

    /// <summary>Windowsのデバイス予約名(拡張子を除いた部分がこれに一致すると使えない)。
    /// 大文字小文字は区別しない。</summary>
    private static readonly HashSet<string> ReservedDeviceNames = new(StringComparer.OrdinalIgnoreCase)
    {
        "CON", "PRN", "AUX", "NUL",
        "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9",
        "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
    };

    /// <summary>
    /// Windowsのファイル名として使えない文字。Path.GetInvalidFileNameChars()は実行環境のOSに
    /// よって結果が変わる(Linux上の.NETでは"/"以外ほとんど許可される)ため、常にWindowsの
    /// ルールで検証したいここでは使わず、明示的に列挙する
    /// (":"を含めているため、"C:\..."のようなドライブ文字付き絶対パスも自動的に弾かれる)。
    /// </summary>
    private static readonly char[] WindowsInvalidNameChars = "\\/:*?\"<>|".ToCharArray();

    /// <summary>
    /// リネーム・新規作成で受け取った名前が「同じ親フォルダの中の単なる名前」として妥当かを検証する。
    /// RenamePath/CreateFileは「同じ親フォルダ内での改名/新規作成のみ許可する」設計だが、
    /// Path.Combine(dir, name)はnameが絶対パスだとそれをそのまま返してしまう(dirを無視する)ため、
    /// パス区切り・".."・絶対パス・Windowsで使えない文字・予約デバイス名を明示的に拒否する
    /// (JS側 src/sidebar.js の paneInput の validate でも同じ規則を使って入力中に弾くが、
    /// ここはその最終防衛線であり、こちらが本当のガード)。
    /// </summary>
    public static bool IsValidEntryName(string? name, out string? error)
    {
        if (string.IsNullOrWhiteSpace(name))
        {
            error = "名前を入力してください。";
            return false;
        }
        if (name.IndexOfAny(new[] { '\\', '/' }) >= 0)
        {
            error = "名前に \\ や / を含めることはできません。";
            return false;
        }
        if (name is "." or "..")
        {
            error = "この名前は使用できません。";
            return false;
        }
        if (Path.IsPathRooted(name))
        {
            // 上のパス区切りチェックで大半は弾けるが、念のため実行環境のルールでも検証する
            // (defense-in-depth。通常はここに到達する前に上の分岐で弾かれる)。
            error = "絶対パスは指定できません。";
            return false;
        }
        foreach (char c in name)
        {
            if (c < 0x20 || Array.IndexOf(WindowsInvalidNameChars, c) >= 0)
            {
                error = "名前に使用できない文字が含まれています。";
                return false;
            }
        }
        string baseName = name.IndexOf('.') is int dot && dot >= 0 ? name[..dot] : name;
        if (ReservedDeviceNames.Contains(baseName))
        {
            error = $"「{baseName}」はWindowsの予約名のため使用できません。";
            return false;
        }
        error = null;
        return true;
    }

    /// <summary>「名前の変更…」(仕様書 4.2)。同じ親フォルダ内での改名のみ許可する
    /// (移動は範囲外)。</summary>
    public static bool RenamePath(string path, string newName, out string? error)
    {
        if (!IsValidEntryName(newName, out error)) return false;
        try
        {
            string? dir = Path.GetDirectoryName(path);
            if (dir is null) { error = "親フォルダを特定できません。"; return false; }
            string dest = Path.Combine(dir, newName);
            if (File.Exists(dest) || Directory.Exists(dest)) { error = "同名のファイル/フォルダが既にあります。"; return false; }
            if (Directory.Exists(path)) Directory.Move(path, dest);
            else if (File.Exists(path)) File.Move(path, dest);
            else { error = "対象が見つかりません。"; return false; }
            Logger.Write($"rename-path: {PrivacyLogFormatter.ShortenPath(path)} → {PrivacyLogFormatter.ShortenPath(dest)}");
            Logger.Debug($"rename-path(フルパス): {path} → {dest}");
            return true;
        }
        catch (Exception ex)
        {
            Logger.WriteException($"rename-path失敗: {path} → {newName}", ex);
            error = ex.Message;
            return false;
        }
    }

    /// <summary>「ここに新しいファイルを作成…」(仕様書 4.3)。既に同名のファイルがある場合は
    /// 上書きしない(エラーにする)。</summary>
    public static bool CreateFile(string dirPath, string name, out string? error)
    {
        if (!IsValidEntryName(name, out error)) return false;
        try
        {
            string dest = Path.Combine(dirPath, name);
            if (File.Exists(dest)) { error = "同名のファイルが既にあります。"; return false; }
            if (Directory.Exists(dest)) { error = "同名のフォルダが既にあります。"; return false; }
            File.WriteAllText(dest, "");
            Logger.Write($"create-file-in-folder: {PrivacyLogFormatter.ShortenPath(dest)}");
            Logger.Debug($"create-file-in-folder(フルパス): {dest}");
            return true;
        }
        catch (Exception ex)
        {
            Logger.WriteException($"create-file-in-folder失敗: {dirPath}/{name}", ex);
            error = ex.Message;
            return false;
        }
    }
}
