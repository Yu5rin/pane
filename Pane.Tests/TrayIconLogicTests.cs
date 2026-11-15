namespace Pane.Tests;

/// <summary>
/// 通知領域のアイコン(<see cref="TrayIconLogic"/>。仕様書 T-01〜T-04)の判断を固定するテスト。
///
/// 常駐中はウィンドウが1枚も無く、動いているのかが見えず、終わらせる手段も無かった
/// (2026-11-15、利用者の要望でアイコンを置いた)。
/// </summary>
public class TrayIconLogicTests
{
    // ---- 左クリック ----

    [Fact]
    public void ウィンドウがあれば左クリックで前面に出す()
    {
        Assert.Equal(TrayIconLogic.LeftClickAction.BringWindowsToFront, TrayIconLogic.DecideLeftClick(1));
        Assert.Equal(TrayIconLogic.LeftClickAction.BringWindowsToFront, TrayIconLogic.DecideLeftClick(3));
    }

    [Fact]
    public void 常駐中に左クリックしたら新しい文書を開く()
    {
        // 何も起きないと、壊れているように見える。
        Assert.Equal(TrayIconLogic.LeftClickAction.NewDocument, TrayIconLogic.DecideLeftClick(0));
    }

    // ---- 常駐を続けるか ----

    [Fact]
    public void 常駐の設定なら最後のウィンドウを閉じても常駐を続ける()
    {
        Assert.True(TrayIconLogic.ShouldStayResident(stayResident: false, quitOnLastWindowClosed: false, quitRequested: false));
        Assert.True(TrayIconLogic.ShouldStayResident(stayResident: true, quitOnLastWindowClosed: true, quitRequested: false));
    }

    [Fact]
    public void 常駐しない設定なら最後のウィンドウで終わる()
    {
        Assert.False(TrayIconLogic.ShouldStayResident(stayResident: false, quitOnLastWindowClosed: true, quitRequested: false));
    }

    [Fact]
    public void Paneを終了を選んだら常駐の設定にかかわらず終わる()
    {
        // 以前は常駐を終わらせる手段が無く、タスクマネージャーで止めるしかなかった。
        Assert.False(TrayIconLogic.ShouldStayResident(stayResident: true, quitOnLastWindowClosed: false, quitRequested: true));
        Assert.False(TrayIconLogic.ShouldStayResident(stayResident: false, quitOnLastWindowClosed: false, quitRequested: true));
    }

    // ---- 最近使ったファイル ----

    [Fact]
    public void 最近使ったファイルは空と重複を除いて新しい順に並べる()
    {
        List<string> entries = TrayIconLogic.RecentFileEntries(new string?[] { @"C:\a.md", null, "", @"C:\b.md", @"c:\A.MD" });
        Assert.Equal(new[] { @"C:\a.md", @"C:\b.md" }, entries);
    }

    [Fact]
    public void 最近使ったファイルは上限までしか並べない()
    {
        IEnumerable<string> many = Enumerable.Range(1, 25).Select(i => $@"C:\f{i}.md");
        List<string> entries = TrayIconLogic.RecentFileEntries(many);
        Assert.Equal(TrayIconLogic.MaxRecentFiles, entries.Count);
        Assert.Equal(@"C:\f1.md", entries[0]);
    }

    // ---- 開いているウィンドウの名前 ----

    [Fact]
    public void 題名が空のウィンドウは無題と出す()
    {
        Assert.Equal("無題", TrayIconLogic.WindowLabel(null));
        Assert.Equal("無題", TrayIconLogic.WindowLabel("  "));
    }

    [Fact]
    public void 長い題名は末尾を切る()
    {
        string label = TrayIconLogic.WindowLabel(new string('あ', 100));
        Assert.Equal(TrayIconLogic.MaxWindowLabelLength, label.Length);
        Assert.EndsWith("…", label);
    }

    [Fact]
    public void アンパサンドは文字のまま出す()
    {
        // メニューでは「&」が次の文字に下線を付ける印として読まれ、「A&B」が「AB」(Bに下線)に見える。
        Assert.Equal("A&&B.md - Pane", TrayIconLogic.WindowLabel("A&B.md - Pane"));
    }

    // ---- 乗せたときの説明 ----

    [Fact]
    public void 説明は常駐中かどうかが分かり63文字以内()
    {
        Assert.Contains("待機中", TrayIconLogic.Tooltip(0));
        Assert.Contains("2個", TrayIconLogic.Tooltip(2));
        Assert.True(TrayIconLogic.Tooltip(0).Length <= 63);
    }
}
