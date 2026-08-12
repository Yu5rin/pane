using System.Text.Json;

namespace Pane;

/// <summary>
/// ウィンドウ(ドキュメント)ごとのスナップショット。異常終了時の復元に使う(仕様書 N-06)。
/// </summary>
internal sealed record AutoSaveSnapshot(
    string? OriginalPath,
    string Text,
    FileEncodingKind Encoding,
    LineEndingKind LineEnding,
    bool HasTrailingNewline,
    DateTime SavedAtUtc);

/// <summary>
/// 自動保存スナップショットの読み書き。%LOCALAPPDATA%\Pane\autosave\{windowId}.json に、
/// ウィンドウがダーティな間だけ定期的に書き込む。
/// 明示的な保存(Ctrl+S)成功時・正常終了時にはスナップショットを削除するため、
/// 次回起動時にファイルが残っていること自体が「前回は異常終了した」ことの印になる
/// (別途ロックファイル等は用いない、意図的に最小の実装)。
/// </summary>
internal static class AutoSaveService
{
    private static readonly JsonSerializerOptions JsonOptions = new() { WriteIndented = true };

    private static string AutoSaveDirectory => Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Pane", "autosave");

    private static string SnapshotPath(Guid windowId) => Path.Combine(AutoSaveDirectory, $"{windowId:N}.json");

    public static void WriteSnapshot(Guid windowId, AutoSaveSnapshot snapshot)
    {
        try
        {
            Directory.CreateDirectory(AutoSaveDirectory);
            string json = JsonSerializer.Serialize(snapshot, JsonOptions);
            string path = SnapshotPath(windowId);
            string tempPath = Path.Combine(AutoSaveDirectory, $".{windowId:N}.tmp-{Guid.NewGuid():N}");
            File.WriteAllText(tempPath, json);
            File.Move(tempPath, path, overwrite: true);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            // 自動保存の失敗はアプリ継続を妨げない(ベストエフォート)。
        }
    }

    public static void DeleteSnapshot(Guid windowId)
    {
        try { File.Delete(SnapshotPath(windowId)); }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException) { }
    }

    /// <summary>
    /// 前回起動が異常終了したために残っているスナップショットを、
    /// (ウィンドウID, スナップショット) の形で全件返す。起動直後に1回だけ呼ぶ。
    /// </summary>
    public static List<(Guid WindowId, AutoSaveSnapshot Snapshot)> FindOrphanedSnapshots()
    {
        var result = new List<(Guid, AutoSaveSnapshot)>();
        try
        {
            if (!Directory.Exists(AutoSaveDirectory)) return result;

            foreach (string file in Directory.EnumerateFiles(AutoSaveDirectory, "*.json"))
            {
                string name = Path.GetFileNameWithoutExtension(file);
                if (!Guid.TryParse(name, out Guid id)) continue;

                try
                {
                    string json = File.ReadAllText(file);
                    AutoSaveSnapshot? snapshot = JsonSerializer.Deserialize<AutoSaveSnapshot>(json);
                    if (snapshot is not null)
                    {
                        result.Add((id, snapshot));
                    }
                }
                catch (Exception ex) when (ex is IOException or JsonException)
                {
                    // 壊れたスナップショットは無視する。
                }
            }
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
        }

        return result;
    }
}
