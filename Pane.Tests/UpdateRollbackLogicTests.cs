namespace Pane.Tests;

/// <summary>
/// 更新の入れ替えが途中で失敗したときの後始末(<see cref="UpdateRollbackLogic"/>)を固定するテスト。
///
/// 以前は失敗したら無条件に今のdistを消していたので、まだ何も置き換えていない段階で失敗すると、
/// 手つかずの正しいdistを消し、戻すものも無い状態になった。
/// </summary>
public class UpdateRollbackLogicTests
{
    [Fact]
    public void 最初の退避で失敗したら何も消さない()
    {
        // 今のexeを退避できなかった(他のプロセスが握っている等)。まだ何も変えていない。
        var plan = UpdateRollbackLogic.Decide(exeMoved: false, distMoved: false, newExeStarted: false, newDistStarted: false);
        Assert.False(plan.DeleteCurrentExe);
        Assert.False(plan.DeleteCurrentDist);
        Assert.False(plan.RestoreExe);
        Assert.False(plan.RestoreDist);
    }

    [Fact]
    public void distの退避で失敗したら今のdistは消さずexeだけ戻す()
    {
        // exeは退避したが、distを退避できなかった。今のdistは手つかずの正しいもの。
        var plan = UpdateRollbackLogic.Decide(exeMoved: true, distMoved: false, newExeStarted: false, newDistStarted: false);
        Assert.False(plan.DeleteCurrentDist);
        Assert.False(plan.DeleteCurrentExe);
        Assert.True(plan.RestoreExe);
        Assert.False(plan.RestoreDist);
    }

    [Fact]
    public void 新しいexeを置く途中で失敗したら置きかけを消して両方戻す()
    {
        var plan = UpdateRollbackLogic.Decide(exeMoved: true, distMoved: true, newExeStarted: true, newDistStarted: false);
        Assert.True(plan.DeleteCurrentExe);
        Assert.False(plan.DeleteCurrentDist);
        Assert.True(plan.RestoreExe);
        Assert.True(plan.RestoreDist);
    }

    [Fact]
    public void 新しいdistを置く途中で失敗したら置きかけを消して両方戻す()
    {
        var plan = UpdateRollbackLogic.Decide(exeMoved: true, distMoved: true, newExeStarted: true, newDistStarted: true);
        Assert.True(plan.DeleteCurrentExe);
        Assert.True(plan.DeleteCurrentDist);
        Assert.True(plan.RestoreExe);
        Assert.True(plan.RestoreDist);
    }

    [Fact]
    public void もともとdistが無かった環境では置きかけのdistだけ消す()
    {
        // distの欠けた環境からの更新。退避するdistが無いので戻すものは無いが、置きかけは残さない。
        var plan = UpdateRollbackLogic.Decide(exeMoved: true, distMoved: false, newExeStarted: true, newDistStarted: true);
        Assert.True(plan.DeleteCurrentDist);
        Assert.False(plan.RestoreDist);
    }
}
