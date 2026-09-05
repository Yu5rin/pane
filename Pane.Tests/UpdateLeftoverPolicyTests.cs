namespace Pane.Tests;

/// <summary>
/// 更新の入れ替え途中で電源断・強制終了が起きたときの復旧可否を決める
/// <see cref="UpdateLeftoverPolicy"/>を固定するテスト。
///
/// 総点検(docs/調査記録/点検-機能と動作.md)「更新の入れ替え途中の電源断で復旧不能」の再発防止。
/// 「退避ファイルがあれば無条件に消す」へ戻すと、distのコピーが途中で終わった直後の
/// 初回起動で唯一の復旧材料(dist.pane-old)まで消えてしまう。
/// </summary>
public class UpdateLeftoverPolicyTests
{
    [Fact]
    public void 退避ファイルが無ければ何もしない()
    {
        Assert.Equal(
            UpdateLeftoverPolicy.Action.None,
            UpdateLeftoverPolicy.Decide(exeBackupExists: false, distBackupExists: false, markerExists: false));
        // マーカーだけ残っている(在り得ないはずだが)場合も、退避ファイルが無いなら実害は無い。
        Assert.Equal(
            UpdateLeftoverPolicy.Action.None,
            UpdateLeftoverPolicy.Decide(exeBackupExists: false, distBackupExists: false, markerExists: true));
    }

    [Fact]
    public void 完了マーカーがあれば退避ファイルを消してよい()
    {
        Assert.Equal(
            UpdateLeftoverPolicy.Action.DeleteBackups,
            UpdateLeftoverPolicy.Decide(exeBackupExists: true, distBackupExists: true, markerExists: true));
    }

    [Fact]
    public void 完了マーカーが無ければ退避ファイルは残す()
    {
        // distのコピー中に電源断が起きたケース: exeは新版に置き換わっているが、
        // マーカーはまだ書かれていない。ここで退避ファイルを消すと復旧できなくなる。
        Assert.Equal(
            UpdateLeftoverPolicy.Action.KeepBackups,
            UpdateLeftoverPolicy.Decide(exeBackupExists: true, distBackupExists: true, markerExists: false));
    }

    [Theory]
    [InlineData(true, false)]
    [InlineData(false, true)]
    public void 片方の退避ファイルだけが残っている場合もマーカー次第で判定する(bool exeBackupExists, bool distBackupExists)
    {
        Assert.Equal(
            UpdateLeftoverPolicy.Action.KeepBackups,
            UpdateLeftoverPolicy.Decide(exeBackupExists, distBackupExists, markerExists: false));
        Assert.Equal(
            UpdateLeftoverPolicy.Action.DeleteBackups,
            UpdateLeftoverPolicy.Decide(exeBackupExists, distBackupExists, markerExists: true));
    }

    [Fact]
    public void マーカーが無くても一日経ちexeが置き換わっていれば消してよい()
    {
        // 完了マーカーはv1.1.4で入れた仕組みなので、それより前の版で更新した環境には
        // 「退避ファイルはあるがマーカーは無い」が最初から存在する。これをKeepBackupsに
        // したままだと、実際には正常に更新できているのに警告が起動のたびに出続ける。
        Assert.Equal(
            UpdateLeftoverPolicy.Action.DeleteStaleBackups,
            UpdateLeftoverPolicy.Decide(
                exeBackupExists: true, distBackupExists: true, markerExists: false,
                backupAge: TimeSpan.FromHours(25), currentExeIsNewerThanBackup: true));
    }

    [Fact]
    public void 一日経っていてもexeが置き換わっていなければ残す()
    {
        // 入れ替えに失敗したまま放置された環境。退避ファイルが唯一の復旧材料なので消さない。
        Assert.Equal(
            UpdateLeftoverPolicy.Action.KeepBackups,
            UpdateLeftoverPolicy.Decide(
                exeBackupExists: true, distBackupExists: true, markerExists: false,
                backupAge: TimeSpan.FromDays(30), currentExeIsNewerThanBackup: false));
    }

    [Fact]
    public void 退避してすぐの残骸は消さない()
    {
        // 本当にdistのコピー中に力尽きた直後。ここで消すと復旧できなくなる。
        Assert.Equal(
            UpdateLeftoverPolicy.Action.KeepBackups,
            UpdateLeftoverPolicy.Decide(
                exeBackupExists: true, distBackupExists: true, markerExists: false,
                backupAge: TimeSpan.FromMinutes(5), currentExeIsNewerThanBackup: true));
    }

    [Fact]
    public void 退避時刻が読めなければ残す()
    {
        Assert.Equal(
            UpdateLeftoverPolicy.Action.KeepBackups,
            UpdateLeftoverPolicy.Decide(
                exeBackupExists: true, distBackupExists: true, markerExists: false,
                backupAge: null, currentExeIsNewerThanBackup: true));
    }

    [Fact]
    public void 古い残骸でも完了マーカーがあれば通常の削除として扱う()
    {
        Assert.Equal(
            UpdateLeftoverPolicy.Action.DeleteBackups,
            UpdateLeftoverPolicy.Decide(
                exeBackupExists: true, distBackupExists: true, markerExists: true,
                backupAge: TimeSpan.FromDays(10), currentExeIsNewerThanBackup: true));
    }

    [Fact]
    public void 完了マーカーのファイル名は固定値()
    {
        // CleanupLeftovers・ApplyUpdateの両方がこの定数を参照する前提。名前が変わると
        // 片方だけ更新し忘れて判定が常にKeepBackups側に倒れる事故になりうる。
        Assert.Equal("pane-update.ok", UpdateLeftoverPolicy.CompletionMarkerFileName);
    }
}
