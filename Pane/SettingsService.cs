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
        AppSettings settings;
        try
        {
            string json = File.ReadAllText(SettingsPath);
            settings = JsonSerializer.Deserialize<AppSettings>(json) ?? new AppSettings();
        }
        catch (JsonException ex)
        {
            // 【不具合修正】settings.jsonはあるが中身が壊れている(構文エラー・型不一致等)場合。
            // File.ReadAllText自体が失敗する場合(ファイル未作成・アクセス不可)はJsonExceptionには
            // ならず下のcatchへ落ちるため、ここへ来る時点で「ファイルは読めたが中身が壊れていた」
            // と確定してよい。
            //
            // 以前はここで無言(バックアップも警告ログも無し)に既定値を返すだけで終わっていた
            // (.review-behavior.md「settings.jsonが壊れていると、最初の設定書き込みで
            // 全設定が既定値で上書きされる」)。System.Text.Jsonは1項目でも型が合わないと
            // ファイル全体をJsonExceptionにするため、例えば手で"editorFontSize"を
            // 文字列にしただけでも同じ経路に入る。Load()自体はこの場で既定値を返して起動を
            // 継続できていた(仕様どおり)が、次にLoad→変更→Saveの流れ(Update、例えば
            // テーマを1回切り替えるだけ)が来た瞬間、「壊れたファイル」ではなく
            // 「たった今作った既定値ベースの設定」がsettings.jsonへ上書き保存され、最近使った
            // ファイル・関連付け・フォント等、本来壊れていなかったはずの他の設定まで
            // まとめて消えていた。
            //
            // RecoverFromBrokenFileが、この場で(1)壊れた内容をタイムスタンプ付きで退避し、
            // (2)警告をログに残し、(3)既定値をこの時点で書き戻すところまで済ませる。
            // (3)を後回しにせずここで行うのは、それ以降のUpdate()を「1項目だけの通常の変更」に
            // 戻すため(そうしないと、次のUpdate()が結局同じ「既定値の上書き」を無警告で
            // 行ってしまい、退避の意味が薄れる)。
            settings = RecoverFromBrokenFile(ex);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            // 初回起動(ファイル未作成)やアクセス不可。中身を読めていないため「壊れていた」とは
            // 言えず、退避のしようも無いので、従来どおり無言で既定値から始める。
            settings = new AppSettings();
        }
        // 【実バグ③の修正】Load()はアプリ内の至る所(MainForm/SettingsWindow/SettingsBridge等)
        // から都度呼ばれ、ここが「設定ファイルをデシリアライズした直後・アプリが使い始める前」の
        // 唯一の共通の入口になる。旧・EditorPaddingXからの移行はGetEffectiveEditorPaddingLeft/Right側の
        // 毎回判定ではなく、ここで一度だけ確定させる(AppSettings.MigrateEditorPadding参照。
        // 「新規AppSettings()」のフォールバック経路でも呼んでおく必要がある。既定値どうしなら
        // 判定は成立せず単にEditorPaddingX=32を再代入するだけなので無害)。
        settings.MigrateEditorPadding();
        return settings;
    }

    /// <summary>
    /// settings.jsonの中身が壊れていたときの退避処理本体(Load()のJsonExceptionから呼ぶ)。
    /// 1. 壊れたファイルをタイムスタンプ付きの名前でこのままコピーする(調査・手動復旧用。
    ///    ファイル名の組み立ては<see cref="SettingsRecoveryLogic"/>、Pane.Testsで固定)。
    /// 2. 警告をログに残す。
    /// 3. 既定値をこの場でsettings.jsonへ書き戻す(理由は呼び出し元のコメント参照)。
    ///
    /// <see cref="UpdateLock"/>を取るのは、この一連の処理の途中に他スレッドの<see cref="Update"/>が
    /// 割り込んで同じsettings.jsonへ書き込み、退避直後の書き戻しと競合するのを防ぐため。
    /// <see cref="Update"/>自身がこのLoad()を(既にUpdateLockを保持した状態で)呼ぶ経路があるが、
    /// C#の<c>lock</c>は同一スレッドに対して再入可能なため、その場合もデッドロックしない。
    /// </summary>
    private static AppSettings RecoverFromBrokenFile(JsonException parseError)
    {
        lock (UpdateLock)
        {
            var fresh = new AppSettings();
            try
            {
                Directory.CreateDirectory(SettingsDirectory);
                string backupPath = Path.Combine(
                    SettingsDirectory,
                    SettingsRecoveryLogic.BuildBrokenBackupFileName(DateTime.UtcNow));
                File.Copy(SettingsPath, backupPath, overwrite: true);
                Logger.Write(
                    $"SettingsService: settings.jsonが壊れていたため既定値で復旧しました" +
                    $"(壊れた内容は{backupPath}へ退避)。詳細: {parseError.Message}");
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
            {
                // 退避コピー自体が失敗しても(権限問題等)、既定値での復旧は続行する。
                Logger.Write(
                    $"SettingsService: settings.jsonが壊れていたため既定値で復旧しました" +
                    $"(壊れた内容の退避コピーには失敗: {ex.Message})。詳細: {parseError.Message}");
            }
            Save(fresh);
            return fresh;
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
