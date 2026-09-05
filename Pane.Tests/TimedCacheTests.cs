namespace Pane.Tests;

/// <summary>
/// <see cref="TimedCache{TKey, TValue}"/>を固定するテスト。
///
/// 期限の判定を「以下」と「未満」で取り違えたり、期限切れの項目を捨て忘れたりすると、
/// フォルダ一覧が古いまま返り続ける("消したはずのファイルが消えない")ことになる。
/// </summary>
public class TimedCacheTests
{
    /// <summary>テストから進められる時計。</summary>
    private sealed class 手動時計
    {
        internal DateTime NowUtc { get; private set; } = new(2026, 9, 5, 12, 0, 0, DateTimeKind.Utc);
        internal void 進める(TimeSpan span) => NowUtc += span;
    }

    private static (TimedCache<string, int> Cache, 手動時計 Clock) 作る(TimeSpan lifetime)
    {
        var clock = new 手動時計();
        return (new TimedCache<string, int>(lifetime, nowUtc: () => clock.NowUtc), clock);
    }

    [Fact]
    public void 覚えていない値は取り出せない()
    {
        var (cache, _) = 作る(TimeSpan.FromMinutes(2));
        Assert.False(cache.TryGet("a", out _));
    }

    [Fact]
    public void 覚えた値をそのまま取り出せる()
    {
        var (cache, _) = 作る(TimeSpan.FromMinutes(2));
        cache.Set("a", 1);
        Assert.True(cache.TryGet("a", out int value));
        Assert.Equal(1, value);
    }

    [Fact]
    public void 期限内なら取り出せる()
    {
        var (cache, clock) = 作る(TimeSpan.FromMinutes(2));
        cache.Set("a", 1);
        clock.進める(TimeSpan.FromSeconds(119));
        Assert.True(cache.TryGet("a", out _));
    }

    [Fact]
    public void 期限ちょうどで切れる()
    {
        var (cache, clock) = 作る(TimeSpan.FromMinutes(2));
        cache.Set("a", 1);
        clock.進める(TimeSpan.FromMinutes(2));
        Assert.False(cache.TryGet("a", out _));
    }

    [Fact]
    public void 同じキーへ入れ直すと期限も新しくなる()
    {
        var (cache, clock) = 作る(TimeSpan.FromMinutes(2));
        cache.Set("a", 1);
        clock.進める(TimeSpan.FromMinutes(1));
        cache.Set("a", 2);
        clock.進める(TimeSpan.FromMinutes(1));
        Assert.True(cache.TryGet("a", out int value));
        Assert.Equal(2, value);
    }

    [Fact]
    public void キーごとに別々に覚える()
    {
        var (cache, _) = 作る(TimeSpan.FromMinutes(2));
        cache.Set("a", 1);
        cache.Set("b", 2);
        Assert.True(cache.TryGet("a", out int a));
        Assert.True(cache.TryGet("b", out int b));
        Assert.Equal(1, a);
        Assert.Equal(2, b);
    }

    [Fact]
    public void 捨てれば取り出せなくなる()
    {
        var (cache, _) = 作る(TimeSpan.FromMinutes(2));
        cache.Set("a", 1);
        cache.Clear();
        Assert.False(cache.TryGet("a", out _));
    }

    [Fact]
    public void 比較方法を渡せば大小文字を区別しない()
    {
        // フォルダのパスをキーにするため、Windowsに合わせた比較ができる必要がある。
        var cache = new TimedCache<string, int>(TimeSpan.FromMinutes(2), StringComparer.OrdinalIgnoreCase);
        cache.Set(@"C:\Users\Test", 1);
        Assert.True(cache.TryGet(@"c:\users\test", out int value));
        Assert.Equal(1, value);
    }
}
