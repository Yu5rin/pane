namespace Pane.Tests;

/// <summary>
/// タブを「閉じる」で破棄しても自動保存スナップショットが残り、次回起動で「復元しますか」が
/// 誤って出る不具合(<see cref="TabSnapshotCleanup"/>、docs/調査記録/点検-機能と動作.md「余裕があれば
/// 直すもの」)の再発防止。
/// </summary>
public class TabSnapshotCleanupTests
{
    [Fact]
    public void 変化が無ければ何も返さない()
    {
        var previous = new[] { "a", "b" };
        var current = new[] { "a", "b" };
        Assert.Empty(TabSnapshotCleanup.FindClosedTabGuids(previous, current));
    }

    [Fact]
    public void 消えたguidだけを返す()
    {
        var previous = new[] { "a", "b", "c" };
        var current = new[] { "a", "c" };
        Assert.Equal(new[] { "b" }, TabSnapshotCleanup.FindClosedTabGuids(previous, current));
    }

    [Fact]
    public void 複数のタブが同時に閉じられても全部返す()
    {
        var previous = new[] { "a", "b", "c", "d" };
        var current = new[] { "b" };
        Assert.Equal(new[] { "a", "c", "d" }, TabSnapshotCleanup.FindClosedTabGuids(previous, current));
    }

    [Fact]
    public void 新しく増えたタブは対象にならない()
    {
        // タブを開いた(増えた)だけでは、それより前のタブは1件も閉じられていない。
        var previous = new[] { "a" };
        var current = new[] { "a", "b" };
        Assert.Empty(TabSnapshotCleanup.FindClosedTabGuids(previous, current));
    }

    [Fact]
    public void 全タブを閉じても最後の1件_新しい空タブは残る前提で判定する()
    {
        // main.jsのcloseTab()はtabs.length===0になると必ずmakeEmptyTab()を積む。
        // つまりcurrentGuidsが完全に空になることは無いが、判定自体は空集合でも壊れない。
        var previous = new[] { "a", "b" };
        var current = System.Array.Empty<string>();
        Assert.Equal(new[] { "a", "b" }, TabSnapshotCleanup.FindClosedTabGuids(previous, current));
    }

    [Fact]
    public void 元の一覧が空なら何も返さない()
    {
        Assert.Empty(TabSnapshotCleanup.FindClosedTabGuids(System.Array.Empty<string>(), new[] { "a" }));
    }
}
