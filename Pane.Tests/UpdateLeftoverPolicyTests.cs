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
    public void 完了マーカーのファイル名は固定値()
    {
        // CleanupLeftovers・ApplyUpdateの両方がこの定数を参照する前提。名前が変わると
        // 片方だけ更新し忘れて判定が常にKeepBackups側に倒れる事故になりうる。
        Assert.Equal("pane-update.ok", UpdateLeftoverPolicy.CompletionMarkerFileName);
    }
}
