namespace Pane.Tests;

/// <summary>
/// 更新の入れ替えの前後の判断(<see cref="UpdateRestartLogic"/>。仕様書 U-04b・U-10)を固定するテスト。
///
/// ・更新で再起動すると、以前は空のウィンドウで立ち上がり、開いていた資料を開き直す手間がかかった。
/// ・常駐していたPaneを更新すると、新しい側が常駐を引き継がず、最後のウィンドウを閉じたときに
///   終わってしまっていた(ログオン時の起動からの常駐が、更新を境に途切れる)。
/// ・自動の入れ替えは、作業中のウィンドウを閉じないことが約束。本体のウィンドウや
///   設定などの補助ウィンドウが見えている間は入れ替えない。
/// </summary>
public class UpdateRestartLogicTests
{
    // ---- 新しいPaneへ渡す引数 ----

    [Fact]
    public void 常駐していなければ古い側のPIDだけを渡す()
    {
        Assert.Equal("--after-update 1234", UpdateRestartLogic.BuildArguments(1234, stayResident: false, openWindows: true));
        Assert.Equal("--after-update 1234", UpdateRestartLogic.BuildArguments(1234, stayResident: false, openWindows: false));
    }

    [Fact]
    public void 常駐していて開くものがあれば常駐を続けたままウィンドウを開く()
    {
        // --preload にすると、最初のウィンドウ要求まで何も開かず、開き直す資料が出てこない。
        Assert.Equal("--after-update 1234 --stay-resident", UpdateRestartLogic.BuildArguments(1234, stayResident: true, openWindows: true));
    }

    [Fact]
    public void 常駐していて開くものが無ければウィンドウを出さずに常駐する()
    {
        // ウィンドウをすべて閉じたあとの自動の入れ替え。利用者は何も開いていないので、何も出さない。
        Assert.Equal("--after-update 1234 --preload", UpdateRestartLogic.BuildArguments(1234, stayResident: true, openWindows: false));
    }

    // ---- 開き直す一覧 ----

    [Fact]
    public void 開いていたものと更新中に頼まれたものをこの順で集める()
    {
        List<string> paths = UpdateRestartLogic.CollectReopenPaths(
            new[] { @"C:\a.md", @"C:\b.md" }, new[] { @"C:\c.md" });
        Assert.Equal(new[] { @"C:\a.md", @"C:\b.md", @"C:\c.md" }, paths);
    }

    [Fact]
    public void 無題の文書と重複は除く()
    {
        // 無題(パス無し)の文書は開き直せない。大文字小文字だけ違うパスはWindowsでは同じファイル。
        List<string> paths = UpdateRestartLogic.CollectReopenPaths(
            new string?[] { @"C:\a.md", null, "", @"c:\A.MD" }, new string?[] { null, @"C:\a.md" });
        Assert.Equal(new[] { @"C:\a.md" }, paths);
    }

    [Fact]
    public void 控えが無ければ通常の起動に任せる()
    {
        Assert.Null(UpdateRestartLogic.DecideReopenOnStartup(null, _ => true));
    }

    [Fact]
    public void 控えのうち消えたファイルは開かない()
    {
        List<string>? paths = UpdateRestartLogic.DecideReopenOnStartup(
            new[] { @"C:\a.md", @"C:\消した.md" }, p => p == @"C:\a.md");
        Assert.Equal(new[] { @"C:\a.md" }, paths);
    }

    [Fact]
    public void 控えが空でも控えありとして扱う()
    {
        // 無題の文書だけを開いていた。前回のセッションの復元に進むと、更新の直前に開いていなかった
        // ファイルが出てくるので、空の一覧(=空の文書を1枚)として返す。
        List<string>? paths = UpdateRestartLogic.DecideReopenOnStartup(Array.Empty<string>(), _ => true);
        Assert.NotNull(paths);
        Assert.Empty(paths!);
    }

    // ---- 自動の入れ替えを始めてよいか ----

    [Fact]
    public void 設定がオフなら入れ替えない()
    {
        Assert.Equal(UpdateRestartLogic.AutoApplyDecision.None,
            UpdateRestartLogic.DecideAutoApply(autoUpdateEnabled: false, prepared: true, documentWindowCount: 0, auxiliaryWindowShown: false, applyInProgress: false));
    }

    [Fact]
    public void 用意ができていなければ入れ替えない()
    {
        Assert.Equal(UpdateRestartLogic.AutoApplyDecision.None,
            UpdateRestartLogic.DecideAutoApply(autoUpdateEnabled: true, prepared: false, documentWindowCount: 0, auxiliaryWindowShown: false, applyInProgress: false));
    }

    [Fact]
    public void 本体のウィンドウが開いている間は待つ()
    {
        // 作業中のウィンドウを閉じないことが約束(仕様書 U-10)。
        Assert.Equal(UpdateRestartLogic.AutoApplyDecision.Wait,
            UpdateRestartLogic.DecideAutoApply(autoUpdateEnabled: true, prepared: true, documentWindowCount: 1, auxiliaryWindowShown: false, applyInProgress: false));
    }

    [Fact]
    public void 設定や作成補助が見えている間は待つ()
    {
        // 入れ替えるとこれらも閉じる。作成補助は保存していない変更を持ちうる。
        Assert.Equal(UpdateRestartLogic.AutoApplyDecision.Wait,
            UpdateRestartLogic.DecideAutoApply(autoUpdateEnabled: true, prepared: true, documentWindowCount: 0, auxiliaryWindowShown: true, applyInProgress: false));
    }

    [Fact]
    public void 更新するや修復が進んでいる間は待つ()
    {
        Assert.Equal(UpdateRestartLogic.AutoApplyDecision.Wait,
            UpdateRestartLogic.DecideAutoApply(autoUpdateEnabled: true, prepared: true, documentWindowCount: 0, auxiliaryWindowShown: false, applyInProgress: true));
    }

    [Fact]
    public void 何も開いていなければ入れ替える()
    {
        Assert.Equal(UpdateRestartLogic.AutoApplyDecision.Apply,
            UpdateRestartLogic.DecideAutoApply(autoUpdateEnabled: true, prepared: true, documentWindowCount: 0, auxiliaryWindowShown: false, applyInProgress: false));
    }

    // ---- 入れ替えのあと ----

    [Fact]
    public void 常駐していなければ入れ替えたあとそのまま終わる()
    {
        // 利用者は最後のウィンドウを閉じて終わらせたところ。新しい版を起動すると勝手に常駐してしまう。
        Assert.False(UpdateRestartLogic.ShouldStartAfterAutoApply(stayResident: false, requestsDuringUpdate: 0));
    }

    [Fact]
    public void 常駐していたら入れ替えたあと常駐を続ける()
    {
        Assert.True(UpdateRestartLogic.ShouldStartAfterAutoApply(stayResident: true, requestsDuringUpdate: 0));
    }

    [Fact]
    public void 入れ替え中にファイルを開くよう頼まれたら常駐していなくても起動する()
    {
        // 頼んだ側のプロセスはもう終わっている。起動しないと、そのファイルは開かれないまま消える。
        Assert.True(UpdateRestartLogic.ShouldStartAfterAutoApply(stayResident: false, requestsDuringUpdate: 1));
    }

    // ---- 「更新しました」 ----

    [Fact]
    public void 控えの版になっていれば知らせる()
    {
        Assert.True(UpdateRestartLogic.ShouldAnnounceAutoUpdate("v1.4.0", "1.4.0"));
    }

    [Fact]
    public void 控えの版に届いていなければ知らせない()
    {
        // 入れ替えが元に戻されたなど。上がっていないのに「更新しました」と出すのは誤り。
        Assert.False(UpdateRestartLogic.ShouldAnnounceAutoUpdate("v1.4.0", "1.3.0"));
    }

    [Fact]
    public void 控えが無ければ知らせない()
    {
        Assert.False(UpdateRestartLogic.ShouldAnnounceAutoUpdate(null, "1.4.0"));
        Assert.False(UpdateRestartLogic.ShouldAnnounceAutoUpdate("", "1.4.0"));
    }
}
