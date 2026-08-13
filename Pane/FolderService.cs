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
    public static Task<FolderScanResult> ScanAsync(string rootPath, CancellationToken ct = default)
    {
        return Task.Run(() =>
        {
            string fullRoot = Path.GetFullPath(rootPath);
            var entries = new List<FolderEntry>();
            bool truncated = false;

            Logger.Write($"FolderService.ScanAsync開始: {fullRoot}");
            ScanDirectory(fullRoot, fullRoot, entries, ref truncated, ct);
            Logger.Write($"FolderService.ScanAsync完了: {fullRoot}, 件数={entries.Count}, truncated={truncated}");

            // ディレクトリ優先→名前順(大小文字を区別しない)で安定した表示順にする。
            entries.Sort((a, b) =>
            {
                if (a.IsDirectory != b.IsDirectory) return a.IsDirectory ? -1 : 1;
                return string.Compare(a.Name, b.Name, StringComparison.OrdinalIgnoreCase);
            });

            return new FolderScanResult(fullRoot, Path.GetFileName(fullRoot.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar)), entries, truncated);
        }, ct);
    }

    private static void ScanDirectory(string rootPath, string currentDir, List<FolderEntry> entries, ref bool truncated, CancellationToken ct)
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

            if (ExcludedDirectoryNames.Contains(name) || name.StartsWith('.'))
            {
                continue;
            }

            if (IsHiddenOrSystem(dir))
            {
                continue;
            }

            if (entries.Count >= MaxEntries)
            {
                truncated = true;
                return;
            }

            entries.Add(new FolderEntry(dir, name, ToRelativePath(rootPath, dir), IsDirectory: true));
            ScanDirectory(rootPath, dir, entries, ref truncated, ct);
            if (truncated) return;
        }

        foreach (string file in files)
        {
            ct.ThrowIfCancellationRequested();

            if (!HasOpenableExtension(file))
            {
                continue;
            }

            if (IsHiddenOrSystem(file))
            {
                continue;
            }

            if (entries.Count >= MaxEntries)
            {
                truncated = true;
                return;
            }

            entries.Add(new FolderEntry(file, Path.GetFileName(file), ToRelativePath(rootPath, file), IsDirectory: false));
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
            Logger.Write($"open-in-default-app: {path}");
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
            Logger.Write($"reveal-in-explorer: {path}");
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
            Logger.Write($"delete-path: ごみ箱へ送った: {path}");
            return true;
        }
        catch (Exception ex)
        {
            Logger.WriteException($"delete-path失敗: {path}", ex);
            error = ex.Message;
            return false;
        }
    }

    /// <summary>「名前の変更…」(仕様書 4.2)。同じ親フォルダ内での改名のみ許可する
    /// (移動は範囲外)。</summary>
    public static bool RenamePath(string path, string newName, out string? error)
    {
        error = null;
        try
        {
            string? dir = Path.GetDirectoryName(path);
            if (dir is null) { error = "親フォルダを特定できません。"; return false; }
            string dest = Path.Combine(dir, newName);
            if (File.Exists(dest) || Directory.Exists(dest)) { error = "同名のファイル/フォルダが既にあります。"; return false; }
            if (Directory.Exists(path)) Directory.Move(path, dest);
            else if (File.Exists(path)) File.Move(path, dest);
            else { error = "対象が見つかりません。"; return false; }
            Logger.Write($"rename-path: {path} → {dest}");
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
        error = null;
        try
        {
            string dest = Path.Combine(dirPath, name);
            if (File.Exists(dest)) { error = "同名のファイルが既にあります。"; return false; }
            if (Directory.Exists(dest)) { error = "同名のフォルダが既にあります。"; return false; }
            File.WriteAllText(dest, "");
            Logger.Write($"create-file-in-folder: {dest}");
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
