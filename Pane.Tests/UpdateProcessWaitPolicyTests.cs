namespace Pane.Tests;

/// <summary>
/// 更新直後の起動で「相手の終了を待つか」を決める<see cref="UpdateProcessWaitPolicy"/>を
/// 固定するテスト。
///
/// 実機ログ(2026-09-05)で、ファイルを開くたびに15秒待たされ、その間ウィンドウが出ず、
/// さらに待っているあいだにフォアグラウンドの委譲権が失効して既存ウィンドウの前面化まで
/// 失敗していた。原因は「同じフォルダで動いている自分以外のPane.exe」を、起動時刻を見ずに
/// すべて『入れ替えられた古いプロセス』とみなしていたこと。
/// 「起動時刻を見ずに待つ」へ戻すと同じことが起きる。
/// </summary>
public class UpdateProcessWaitPolicyTests
{
    private static readonly DateTime 入れ替え時刻 = new(2026, 9, 5, 12, 0, 0, DateTimeKind.Utc);

    [Fact]
    public void 入れ替えより前から動いているプロセスは待つ()
    {
        // 入れ替えられた古いexeから起動したプロセス。終了を待つ必要がある。
        Assert.True(UpdateProcessWaitPolicy.ShouldWait(入れ替え時刻, 入れ替え時刻.AddMinutes(-3)));
    }

    [Fact]
    public void 入れ替えより後に起動したプロセスは待たない()
    {
        // 更新から5分以内に2枚目のウィンドウを開いたときの相手がこれにあたる。
        // 新しいexeから起動した現役の常駐プロセスなので、待ってはいけない。
        Assert.False(UpdateProcessWaitPolicy.ShouldWait(入れ替え時刻, 入れ替え時刻.AddSeconds(1)));
    }

    [Fact]
    public void 入れ替えと同時刻のプロセスは待たない()
    {
        // 境界は「待たない」側へ倒す。誤って待つ害(毎回15秒の足止め)のほうが、
        // 誤って待たない害(更新直後の1回だけ)より実機で重い。
        Assert.False(UpdateProcessWaitPolicy.ShouldWait(入れ替え時刻, 入れ替え時刻));
    }

    [Fact]
    public void 起動時刻が読めない相手は安全側で待つ()
    {
        Assert.True(UpdateProcessWaitPolicy.ShouldWait(入れ替え時刻, null));
    }
}
