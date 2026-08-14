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

    /// <summary>
    /// プロセス内でのLoad→変更→Saveの排他用ロック。設定ファイルの実体は他プロセスからの
    /// 同時書き込みを想定していない(仕様書どおり単一ユーザーの単一マシン運用)ため、
    /// 対象は同一プロセス内の複数ウィンドウ・タイマー・非同期処理からの同時アクセスのみでよい。
    /// <see cref="Update"/> はこのロックの下で「最新を読み直す→変更を適用する→書き出す」を
    /// 1操作として行うことで、Load()した時点のスナップショットを保持したまま長時間経ってから
    /// Save()する呼び出し元同士が互いの変更を消し合う(Lost Update)のを防ぐ。
    /// </summary>
    private static readonly object UpdateLock = new();

    private static string SettingsDirectory => Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Pane");

    private static string SettingsPath => Path.Combine(SettingsDirectory, "settings.json");

    /// <summary>設定ファイルの実際のフルパス。設定画面の「設定ファイルを開く」ボタンや、
    /// settingsスナップショット(settingsFilePath)から参照する。</summary>
    public static string SettingsFilePath => SettingsPath;

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

            // 一時ファイルへ書き切ってからFile.Moveで置き換える(同一ボリューム内のFile.Moveは
            // MoveFileEx+MOVEFILE_REPLACE_EXISTINGによりアトミックに行われる)。書き込み中に
            // プロセスが落ちても、被害は一時ファイルどまりで settings.json 自体は旧内容のまま
            // 残るため、設定ファイルが半端な内容で壊れることはない。
            string tempPath = Path.Combine(SettingsDirectory, $".settings.json.tmp-{Guid.NewGuid():N}");
            File.WriteAllText(tempPath, json);
            File.Move(tempPath, SettingsPath, overwrite: true);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            // 設定の保存失敗はアプリ継続を妨げない(ベストエフォート)。
        }
    }

    /// <summary>
    /// read-modify-writeを安全に行うための入口。設定の保存経路(設定画面・最近使ったファイル・
    /// テーマ切替・フォントサイズ変更等)はすべてここを通すことで、Load()した時点のスナップショットを
    /// 長時間(ユーザー操作待ち等)保持したまま丸ごとSave()する呼び出し元同士が、互いの変更を
    /// 消し合う(Lost Update)のを防ぐ。
    ///
    /// <paramref name="modify"/> には「ディスクの最新設定に対して行いたい変更だけ」を書く
    /// (例: <c>s => s.Theme = "dark"</c>)。<see cref="Load"/>で読み込んだ古いsettingsを
    /// 保持している側から丸ごとコピーしてはいけない(それこそがLost Updateの原因になる)。
    ///
    /// <see cref="UpdateLock"/> により、(1)最新を読み直す、(2)変更を適用する、(3)書き出す、の
    /// 3手順を1つの操作として直列化する。ロック粒度は「同一プロセス内のUpdate呼び出し全体」と
    /// 粗いが、設定ファイルはせいぜい数KB・modify自体も軽い代入処理のみのため、UIの応答性に
    /// 影響するほどの待ち時間にはならない。
    /// </summary>
    public static void Update(Action<AppSettings> modify)
    {
        lock (UpdateLock)
        {
            AppSettings latest = Load();
            modify(latest);
            Save(latest);
        }
    }

    /// <summary>
    /// <paramref name="source"/>の全公開プロパティの値を<paramref name="destination"/>へ
    /// 上書きコピーする(get/set両方を持つものだけが対象。<see cref="AppSettings"/>の
    /// GetEffectiveAssociatedExtensions等のメソッドは対象外)。
    ///
    /// リセット処理(reset-settings)は「新しいAppSettingsのインスタンスをそのまま使う」のではなく
    /// 「<see cref="Update"/>が読み直した最新のインスタンスへ、既定値を上書きする」形でなければ
    /// Lost Update対策の効果が無くなってしまう。かといって手作業でプロパティを1つずつ
    /// 列挙して代入すると、AppSettingsに項目が増えるたびにここも直し忘れる恐れがある
    /// (「保存し忘れる項目が出ないよう注意する」という方針に反する)ため、リフレクションで
    /// 全プロパティを機械的にコピーする。
    /// </summary>
    internal static void CopyAllProperties(AppSettings source, AppSettings destination)
    {
        foreach (System.Reflection.PropertyInfo prop in typeof(AppSettings).GetProperties())
        {
            if (!prop.CanRead || !prop.CanWrite) continue;
            prop.SetValue(destination, prop.GetValue(source));
        }
    }
}
