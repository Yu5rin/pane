namespace Pane.Tests;

/// <summary>
/// WebView2にNavigationStartingの保険が無かった件(docs/調査記録/点検-セキュリティ.md C-4)の修正
/// (<see cref="NavigationGuard"/>)を固定するテスト。
///
/// 許可するのは「自分のvirtual host(https://pane.local/…)への遷移」だけであり、
/// それ以外のスキーム・ホスト・不正な文字列はすべて拒否されることを確認する。
/// </summary>
public class NavigationGuardTests
{
    private const string AllowedHost = "pane.local";

    [Fact]
    public void 自分のvirtual_hostへのhttps遷移は許可する()
    {
        Assert.True(NavigationGuard.IsAllowedTopLevelNavigation("https://pane.local/index.html", AllowedHost));
    }

    [Fact]
    public void ホスト名の大文字小文字は区別しない()
    {
        Assert.True(NavigationGuard.IsAllowedTopLevelNavigation("https://PANE.LOCAL/index.html", AllowedHost));
    }

    [Fact]
    public void 別ホストへのhttps遷移は拒否する()
    {
        Assert.False(NavigationGuard.IsAllowedTopLevelNavigation("https://evil.example.com/", AllowedHost));
    }

    [Fact]
    public void httpsではないスキームは拒否する()
    {
        // http・file・javascriptいずれも、pane.localという名前がホスト部分に無い/httpsでない。
        Assert.False(NavigationGuard.IsAllowedTopLevelNavigation("http://pane.local/index.html", AllowedHost));
        Assert.False(NavigationGuard.IsAllowedTopLevelNavigation("file:///C:/pane.local/index.html", AllowedHost));
        Assert.False(NavigationGuard.IsAllowedTopLevelNavigation("javascript:alert(1)", AllowedHost));
    }

    [Fact]
    public void about_blank等の絶対URIとして解析できてもホストが違えば拒否する()
    {
        Assert.False(NavigationGuard.IsAllowedTopLevelNavigation("about:blank", AllowedHost));
    }

    [Fact]
    public void 絶対URIとして解析できない文字列は拒否する()
    {
        Assert.False(NavigationGuard.IsAllowedTopLevelNavigation("not a uri", AllowedHost));
    }

    [Fact]
    public void nullや空文字は拒否する()
    {
        Assert.False(NavigationGuard.IsAllowedTopLevelNavigation(null, AllowedHost));
        Assert.False(NavigationGuard.IsAllowedTopLevelNavigation("", AllowedHost));
        Assert.False(NavigationGuard.IsAllowedTopLevelNavigation("https://pane.local/", ""));
    }

    [Fact]
    public void ホスト名がpane_localの部分文字列を含むだけの別ホストは拒否する()
    {
        // "pane.local.evil.com"や"notpane.local"のような紛らわしいホストを、文字列の
        // 部分一致ではなくUri.Hostの完全一致で弾けているかを確認する。
        Assert.False(NavigationGuard.IsAllowedTopLevelNavigation("https://pane.local.evil.com/", AllowedHost));
        Assert.False(NavigationGuard.IsAllowedTopLevelNavigation("https://notpane.local/", AllowedHost));
    }
}
