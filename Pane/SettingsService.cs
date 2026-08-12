using System.Text.Json;

namespace Pane;

/// <summary>
/// <see cref="AppSettings"/> の読み書き。%LOCALAPPDATA%\Pane\settings.json
/// (仕様書 第7.1節: ユーザー権限で書き込める場所のみを使う)。
/// </summary>
internal static class SettingsService
{
    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        WriteIndented = true,
    };

    private static string SettingsDirectory => Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Pane");

    private static string SettingsPath => Path.Combine(SettingsDirectory, "settings.json");

    public static AppSettings Load()
    {
        try
        {
            string json = File.ReadAllText(SettingsPath);
            return JsonSerializer.Deserialize<AppSettings>(json) ?? new AppSettings();
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or JsonException)
        {
            // 初回起動(ファイル未作成)や破損時は既定値から始める。
            return new AppSettings();
        }
    }

    public static void Save(AppSettings settings)
    {
        try
        {
            Directory.CreateDirectory(SettingsDirectory);
            string json = JsonSerializer.Serialize(settings, JsonOptions);

            string tempPath = Path.Combine(SettingsDirectory, $".settings.json.tmp-{Guid.NewGuid():N}");
            File.WriteAllText(tempPath, json);
            File.Move(tempPath, SettingsPath, overwrite: true);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            // 設定の保存失敗はアプリ継続を妨げない(ベストエフォート)。
        }
    }
}
