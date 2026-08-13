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
}
