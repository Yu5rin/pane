namespace Pane.Tests;

/// <summary>
/// ログの冒頭に出る「前回の記録」の集計のテスト。
///
/// この1行は、ログを開いた人が最初に読むもので、そこに出た件数がそのまま
/// 「前回は問題があったのか」の判断になる。数が実態とずれると、無い問題を追いかけたり、
/// あった問題を見落としたりする。特に、常駐しているPaneと新しく起動したPaneが同じ
/// ファイルへ書くため、プロセスを区別せずに数えると他人の警告を数えてしまう。
/// </summary>
public class LogReviewLogicTests
{
    // 実際のログと同じ形。"HH:mm:ss.fff [プロセス:スレッド] 本文"
    private static string Line(string time, string process, string body) => $"{time} [{process}:5] {body}";
    private static string Start(string time, string process) => Line(time, process, "=== Pane起動 (v1.0.9) ===");
    private static string Warn(string time, string process, string body = "何かがうまくいかなかった")
        => Line(time, process, $"[警告] {body}");
    private static string Error(string time, string process, string body = "処理に失敗した")
        => Line(time, process, $"[エラー] {body}");

    [Fact]
    public void 問題が無ければ何も報告しない()
    {
        var lines = new[]
        {
            Start("10:00:00.000", "0100"),
            Line("10:00:01.000", "0100", "MainForm生成"),
            Line("10:00:02.000", "0100", "WebView2を表示"),
        };
        Assert.True(LogReviewLogic.Summarize(lines).IsEmpty);
    }

    [Fact]
    public void 直前のセッションのエラーと警告を数える()
    {
        var lines = new[]
        {
            Start("09:00:00.000", "0100"),
            Warn("09:00:01.000", "0100", "前のセッションの警告(数えない)"),
            Start("10:00:00.000", "0200"),
            Warn("10:00:01.000", "0200"),
            Error("10:00:02.000", "0200"),
            Warn("10:00:03.000", "0200"),
        };

        LogReviewSummary summary = LogReviewLogic.Summarize(lines);
        Assert.Equal(1, summary.Errors);
        Assert.Equal(2, summary.Warnings);
        Assert.Equal("10:00:00.000 ", summary.StartedAt);
    }

    [Fact]
    public void 別のプロセスが書いた行は数に入れず件数だけ添える()
    {
        // 常駐しているPane(0100)が動いたまま、新しいPane(0200)が起動した場面。
        var lines = new[]
        {
            Start("10:00:00.000", "0200"),
            Warn("10:00:01.000", "0200", "このセッションの警告"),
            Warn("10:00:01.500", "0100", "常駐している別プロセスの警告"),
            Error("10:00:02.000", "0100", "常駐している別プロセスのエラー"),
        };

        LogReviewSummary summary = LogReviewLogic.Summarize(lines);
        Assert.Equal(0, summary.Errors);
        Assert.Equal(1, summary.Warnings);
        Assert.Equal(2, summary.FromOtherProcesses);

        // 例として載るのも自分のぶんだけ。
        Assert.Single(summary.Examples);
        Assert.Contains("このセッションの警告", summary.Examples[0]);
    }

    [Fact]
    public void 別のプロセスの記録は要約の文にも出る()
    {
        // 「ログには警告があるのに要約は0件」と食い違って見えないようにする。
        var lines = new[]
        {
            Start("10:00:00.000", "0200"),
            Warn("10:00:01.000", "0100", "別プロセスの警告"),
        };

        LogReviewSummary summary = LogReviewLogic.Summarize(lines);
        Assert.False(summary.IsEmpty);
        Assert.Contains("別プロセスの記録が1件", LogReviewLogic.Format(summary));
    }

    [Fact]
    public void プロセスタグが無い古いログでは全部を数える()
    {
        // タグを付ける前(v1.0.8以前)のログ。選り分けようがないので、従来どおり全部数える。
        var lines = new[]
        {
            "10:00:00.000 === Pane起動 (v1.0.8) ===",
            "10:00:01.000 [警告] 警告1",
            "10:00:02.000 [エラー] エラー1",
        };

        LogReviewSummary summary = LogReviewLogic.Summarize(lines);
        Assert.Equal(1, summary.Errors);
        Assert.Equal(1, summary.Warnings);
        Assert.Equal(0, summary.FromOtherProcesses);
    }

    [Fact]
    public void 起動行が見つからなければ渡された範囲すべてを数える()
    {
        // 1回の起動が読み取り上限を超えるほど記録され、起動行まで遡れなかった場合。
        var lines = new[]
        {
            Warn("10:00:01.000", "0200"),
            Error("10:00:02.000", "0200"),
        };

        LogReviewSummary summary = LogReviewLogic.Summarize(lines);
        Assert.Equal(1, summary.Errors);
        Assert.Equal(1, summary.Warnings);
        Assert.Equal("", summary.StartedAt);
        Assert.Contains("(開始時刻不明の)", LogReviewLogic.Format(summary));
    }

    [Fact]
    public void 行が一つも無くても落ちない()
    {
        Assert.True(LogReviewLogic.Summarize(Array.Empty<string>()).IsEmpty);
    }

    [Fact]
    public void 例は先頭の三件までにとどめる()
    {
        var lines = new List<string> { Start("10:00:00.000", "0200") };
        for (int i = 0; i < 10; i++) lines.Add(Warn($"10:00:0{i}.000", "0200", $"警告{i}"));

        LogReviewSummary summary = LogReviewLogic.Summarize(lines);
        Assert.Equal(10, summary.Warnings);
        Assert.Equal(3, summary.Examples.Count);
    }

    [Fact]
    public void 長すぎる行は切り詰める()
    {
        var lines = new[] { Start("10:00:00.000", "0200"), Warn("10:00:01.000", "0200", new string('あ', 500)) };
        string example = LogReviewLogic.Summarize(lines).Examples[0];
        Assert.EndsWith("…", example);
        Assert.True(example.Length <= 121, $"切り詰めが効いていない(長さ={example.Length})");
    }

    [Fact]
    public void エラーと警告の両方を含む行はエラーとして数える()
    {
        // 「[エラー] …警告…」のような本文でも二重に数えない。
        var lines = new[] { Start("10:00:00.000", "0200"), Error("10:00:01.000", "0200", "[警告]という語を含む本文") };
        LogReviewSummary summary = LogReviewLogic.Summarize(lines);
        Assert.Equal(1, summary.Errors);
        Assert.Equal(0, summary.Warnings);
    }

    // ---- 行の読み取り ----------------------------------------------------

    [Theory]
    [InlineData("10:23:45.678 [0432:7] 何か", "0432")]
    [InlineData("10:23:45.678 [12:1] 何か", "12")]
    [InlineData("10:23:45.678 何か", null)]          // タグを付ける前の形
    [InlineData("10:23:45.678 [壊れている", null)]   // 閉じていない
    [InlineData("短い", null)]
    [InlineData("", null)]
    public void 行頭のプロセスタグを取り出せる(string line, string? expected)
    {
        Assert.Equal(expected, LogReviewLogic.ExtractProcessTag(line));
    }

    [Theory]
    [InlineData("10:23:45.678 [0432:7] 何か", "10:23:45.678 ")]
    [InlineData("時刻ではない行", "")]
    [InlineData("", "")]
    public void 行頭の時刻を取り出せる(string line, string expected)
    {
        Assert.Equal(expected, LogReviewLogic.ExtractTime(line));
    }
}
