namespace Pane.Tests;

/// <summary>
/// 更新の確認で「新しい版があるか」を決める部分のテスト。
///
/// ここが静かに壊れると、利用者からは「更新が来ない」としか見えず、気づくまでに
/// 何週間もかかる。実際に v1.0.5 では、タグの "v" を落とし忘れたせいでバージョンを
/// 読み取れず、更新の確認が必ず失敗していた。過去に起きた誤りは
/// <see cref="実際に起きた不具合"/> にまとめて、二度と戻らないようにしてある。
/// </summary>
public class UpdateCheckLogicTests
{
    // ---- バージョン表記の読み取り ----------------------------------------

    [Theory]
    [InlineData("1.0.4", 1, 0, 4)]
    [InlineData("v1.0.4", 1, 0, 4)]        // Gitのタグの慣例
    [InlineData("V1.0.4", 1, 0, 4)]        // 大文字で付ける流儀もある
    [InlineData(" v1.0.4 ", 1, 0, 4)]      // 前後の空白
    [InlineData("1.0.9+a1b2c3", 1, 0, 9)]  // ビルドのハッシュ付き
    [InlineData("1.0.9-beta", 1, 0, 9)]    // 事前公開の印付き
    [InlineData("v2.10.0", 2, 10, 0)]
    public void バージョン表記を読み取れる(string text, int major, int minor, int build)
    {
        Version? v = UpdateCheckLogic.ParseVersion(text);
        Assert.NotNull(v);
        Assert.Equal(new Version(major, minor, build, 0), v);
    }

    [Fact]
    public void 桁数が違っても同じ版として扱う()
    {
        Assert.Equal(UpdateCheckLogic.ParseVersion("1.0.1"), UpdateCheckLogic.ParseVersion("1.0.1.0"));
        Assert.Equal(UpdateCheckLogic.ParseVersion("1.2"), UpdateCheckLogic.ParseVersion("1.2.0.0"));
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("   ")]
    [InlineData("latest")]
    [InlineData("リリース版")]
    [InlineData("v")]
    public void 読み取れない表記はnullを返す(string? text)
    {
        Assert.Null(UpdateCheckLogic.ParseVersion(text));
    }

    [Fact]
    public void 実際に起きた不具合_タグのvを落とさないと版を読み取れない()
    {
        // v1.0.5 でこれを取りこぼし、更新の確認が必ず失敗していた。
        Assert.NotNull(UpdateCheckLogic.ParseVersion("v1.0.4"));
        Assert.Equal(new Version(1, 0, 4, 0), UpdateCheckLogic.ParseVersion("v1.0.4"));
    }

    [Fact]
    public void 実際に起きた不具合_文字列の比較では1_0_10が1_0_9より古く見える()
    {
        // 文字列として並べると "1.0.10" < "1.0.9" になってしまう。数として比べる。
        Assert.True(string.CompareOrdinal("1.0.10", "1.0.9") < 0);
        Assert.True(UpdateCheckLogic.ParseVersion("1.0.10") > UpdateCheckLogic.ParseVersion("1.0.9"));
        Assert.True(UpdateCheckLogic.IsNewerThanCurrent("v1.0.10", "1.0.9"));
    }

    // ---- タグの先頭の "v" ------------------------------------------------

    [Theory]
    [InlineData("v1.0.4", "1.0.4")]
    [InlineData("V1.0.4", "1.0.4")]
    [InlineData("1.0.4", "1.0.4")]
    [InlineData(" v1.0.4 ", "1.0.4")]
    [InlineData("v", "v")]                 // 1文字だけなら落とさない
    [InlineData("version", "ersion")]      // 素朴に落とすだけ。版として読めないので後段で弾かれる
    public void タグの先頭のvを落とせる(string tag, string expected)
    {
        Assert.Equal(expected, UpdateCheckLogic.StripVersionPrefix(tag));
    }

    // ---- AtomフィードのURLの組み立て --------------------------------------

    [Fact]
    public void APIのURLからAtomのURLを組み立てられる()
    {
        Assert.Equal(
            "https://github.com/Yu5rin/pane/releases.atom",
            UpdateCheckLogic.TryBuildAtomUrl("https://api.github.com/repos/Yu5rin/pane/releases/latest"));
    }

    [Theory]
    [InlineData("https://example.com/repos/Yu5rin/pane/releases/latest")]  // GitHub以外の配布元
    [InlineData("https://api.github.com/users/Yu5rin")]                    // reposで始まらない
    [InlineData("https://api.github.com/repos/Yu5rin")]                    // 途中までしかない
    [InlineData("これはURLではない")]
    [InlineData("")]
    public void 組み立てられない形ならnullを返す(string apiUrl)
    {
        Assert.Null(UpdateCheckLogic.TryBuildAtomUrl(apiUrl));
    }

    [Fact]
    public void 配布元がGitHub以外でも落ちない()
    {
        // 設定で配布元を差し替えられる。Atomが使えないだけで、APIでの確認は続けられる。
        Assert.Null(UpdateCheckLogic.TryBuildAtomUrl("https://example.com/pane/latest.json"));
    }

    // ---- リリースページのURL ---------------------------------------------

    [Fact]
    public void AtomのURLからリリースページのURLを組み立てられる()
    {
        Assert.Equal(
            "https://github.com/Yu5rin/pane/releases/tag/v1.0.8",
            UpdateCheckLogic.BuildReleasePageUrl("https://github.com/Yu5rin/pane/releases.atom", "v1.0.8"));
    }

    [Fact]
    public void atomで終わらないURLからは組み立てない()
    {
        Assert.Equal("", UpdateCheckLogic.BuildReleasePageUrl("https://github.com/Yu5rin/pane/releases", "v1.0.8"));
    }

    // ---- Atomフィードの読み取り ------------------------------------------

    /// <summary>GitHubのreleases.atomと同じ形。実物から要らない部分を削ったもの。</summary>
    private static string Feed(params string[] tags)
    {
        var entries = string.Concat(tags.Select(t => $"""
              <entry>
                <id>tag:github.com,2008:Repository/1000000/{t}</id>
                <updated>2026-08-20T00:00:00Z</updated>
                <link rel="alternate" type="text/html" href="https://github.com/Yu5rin/pane/releases/tag/{t}"/>
                <title>{t}</title>
                <content type="html">&lt;p&gt;更新の内容&lt;/p&gt;</content>
              </entry>
            """));
        return $"""
            <?xml version="1.0" encoding="UTF-8"?>
            <feed xmlns="http://www.w3.org/2005/Atom" xml:lang="en-US">
              <id>tag:github.com,2008:https://github.com/Yu5rin/pane/releases</id>
              <link type="text/html" rel="alternate" href="https://github.com/Yu5rin/pane/releases"/>
              <title>Release notes from pane</title>
            {entries}
            </feed>
            """;
    }

    [Fact]
    public void 実物と同じ形のフィードから最新のタグを取れる()
    {
        Assert.Equal("v1.0.8", UpdateCheckLogic.ExtractLatestTagFromAtom(Feed("v1.0.8", "v1.0.7", "v1.0.6")));
    }

    [Fact]
    public void 並びが新しい順でなくても最大の版を選ぶ()
    {
        // フィードは普通は新しい順だが、それに頼ると並びが変わったときに古い版を
        // 「最新」と判断してしまう。
        Assert.Equal("v1.0.8", UpdateCheckLogic.ExtractLatestTagFromAtom(Feed("v1.0.6", "v1.0.8", "v1.0.7")));
        Assert.Equal("v1.0.10", UpdateCheckLogic.ExtractLatestTagFromAtom(Feed("v1.0.9", "v1.0.10")));
    }

    [Fact]
    public void 版として読めないタグは無視する()
    {
        // 下書き用の名前が混ざっていても、読める中での最大を返す。
        Assert.Equal("v1.0.7", UpdateCheckLogic.ExtractLatestTagFromAtom(Feed("nightly", "v1.0.7", "wip")));
    }

    [Fact]
    public void 読めるタグが一つも無ければnullを返す()
    {
        Assert.Null(UpdateCheckLogic.ExtractLatestTagFromAtom(Feed("nightly", "wip")));
    }

    [Fact]
    public void リリースが一件も無ければnullを返す()
    {
        Assert.Null(UpdateCheckLogic.ExtractLatestTagFromAtom(Feed()));
    }

    [Theory]
    [InlineData("")]
    [InlineData("<feed>閉じていない")]
    [InlineData("これはxmlではない")]
    [InlineData("<html><body>502 Bad Gateway</body></html>")]
    public void 壊れた応答でも落ちずにnullを返す(string xml)
    {
        // 配布元が一時的におかしな応答を返しても、呼び出し元はAPIで確認し直せる。
        Assert.Null(UpdateCheckLogic.ExtractLatestTagFromAtom(xml));
    }

    [Fact]
    public void linkが無いentryは飛ばす()
    {
        string xml = """
            <?xml version="1.0" encoding="UTF-8"?>
            <feed xmlns="http://www.w3.org/2005/Atom">
              <entry><title>v9.9.9</title></entry>
              <entry>
                <link rel="alternate" type="text/html" href="https://github.com/Yu5rin/pane/releases/tag/v1.0.8"/>
                <title>v1.0.8</title>
              </entry>
            </feed>
            """;
        // タグ名はlinkのhrefから取る。titleだけのentryは当てにしない。
        Assert.Equal("v1.0.8", UpdateCheckLogic.ExtractLatestTagFromAtom(xml));
    }

    [Fact]
    public void URLとして符号化されたタグ名を戻す()
    {
        string xml = """
            <?xml version="1.0" encoding="UTF-8"?>
            <feed xmlns="http://www.w3.org/2005/Atom">
              <entry>
                <link rel="alternate" type="text/html" href="https://github.com/Yu5rin/pane/releases/tag/v1.0.9%2Bwin"/>
              </entry>
            </feed>
            """;
        Assert.Equal("v1.0.9+win", UpdateCheckLogic.ExtractLatestTagFromAtom(xml));
    }

    // ---- 更新があるかどうかの判断 ----------------------------------------

    [Theory]
    [InlineData("v1.0.9", "1.0.8", true)]
    [InlineData("v1.0.8", "1.0.8", false)]
    [InlineData("v1.0.7", "1.0.8", false)]   // 配布元を古い版に戻したとき
    [InlineData("v1.0.10", "1.0.9", true)]
    [InlineData("v1.1.0", "1.0.99", true)]
    [InlineData("v1.0.8", "1.0.8.0", false)] // 桁数の違いで「更新あり」にしない
    public void 更新があるかを判断できる(string latestTag, string current, bool expected)
    {
        Assert.Equal(expected, UpdateCheckLogic.IsNewerThanCurrent(latestTag, current));
    }

    [Theory]
    [InlineData(null, "1.0.8")]
    [InlineData("v1.0.9", null)]
    [InlineData("nightly", "1.0.8")]
    [InlineData("v1.0.9", "開発中")]
    public void どちらかが読めなければ判断しない(string? latestTag, string? current)
    {
        // ここで false を返すと「最新です」と誤って伝えることになる。判断しないことを
        // はっきり返して、呼び出し元に確認を諦めさせる。
        Assert.Null(UpdateCheckLogic.IsNewerThanCurrent(latestTag, current));
    }
}
