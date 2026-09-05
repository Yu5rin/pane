namespace Pane.Tests;

/// <summary>
/// settings.jsonが壊れていた場合の退避ファイル名(<see cref="SettingsRecoveryLogic"/>)を
/// 固定するテスト。
///
/// 対応する不具合(docs/調査記録/点検-機能と動作.md「settings.jsonが壊れていると、最初の設定書き込みで
/// 全設定が既定値で上書きされる」): 以前はLoad()がJsonExceptionを無言で握りつぶして
/// 既定値を返すだけで、バックアップも警告ログも残らなかった。次のUpdate()(設定を1項目
/// 変えるだけの操作)が、壊れたファイルの上から既定値ベースの設定を書き込み、最近使った
/// ファイル・関連付け・テーマ・フォント等、無関係な設定まで巻き添えで消えていた。
/// SettingsService.RecoverFromBrokenFile自体は実際のファイルI/O・ログ・現在時刻取得を伴うため
/// ここではテストせず(SettingsServiceは意図的にPane.Testsへ取り込まない)、
/// 「どんな名前で退避するか」という純粋な部分だけをここで固定する。
/// </summary>
public class SettingsRecoveryLogicTests
{
    [Fact]
    public void 退避ファイル名にbrokenという印と分単位までの時刻が入る()
    {
        var utc = new DateTime(2026, 9, 3, 12, 34, 56, DateTimeKind.Utc);
        string name = SettingsRecoveryLogic.BuildBrokenBackupFileName(utc);
        Assert.Equal("settings.json.broken-20260903-123456.json", name);
    }

    [Fact]
    public void 異なる時刻なら異なるファイル名になる()
    {
        var first = SettingsRecoveryLogic.BuildBrokenBackupFileName(new DateTime(2026, 9, 3, 0, 0, 0, DateTimeKind.Utc));
        var second = SettingsRecoveryLogic.BuildBrokenBackupFileName(new DateTime(2026, 9, 3, 0, 0, 1, DateTimeKind.Utc));
        Assert.NotEqual(first, second);
    }

    [Fact]
    public void 退避ファイル名は常にjson拡張子で終わる()
    {
        string name = SettingsRecoveryLogic.BuildBrokenBackupFileName(DateTime.UtcNow);
        Assert.EndsWith(".json", name);
        Assert.StartsWith("settings.json.broken-", name);
    }
}
