namespace Pane.Tests;

/// <summary>
/// ウィンドウが開いている(これから開く)ファイルの一覧(<see cref="OpenPathsLogic"/>)を固定するテスト。
///
/// 2026-10-22 の実機ログで、1つのファイルをほぼ同時に2回開くと同じファイルのウィンドウが2枚開いた。
/// ウィンドウを作ってからファイルを読み込むまでの間、一覧が空だったため。
/// 「これから開く予定のファイル」を一覧から外すと同じことが起きる。
/// </summary>
public class OpenPathsLogicTests
{
    [Fact]
    public void 読み込む前でも起動時に開く予定のファイルを含める()
    {
        Assert.Equal(new[] { @"C:\a.txt" }, OpenPathsLogic.Collect(Array.Empty<string?>(), null, @"C:\a.txt"));
    }

    [Fact]
    public void 読み込んだあとは今開いているファイルだけ()
    {
        Assert.Equal(new[] { @"C:\a.txt" }, OpenPathsLogic.Collect(Array.Empty<string?>(), @"C:\a.txt", null));
        Assert.Empty(OpenPathsLogic.Collect(Array.Empty<string?>(), null, null));
    }

    [Fact]
    public void 予定と今開いているものが同じなら1つにまとめる()
    {
        Assert.Equal(new[] { @"C:\a.txt" }, OpenPathsLogic.Collect(Array.Empty<string?>(), @"C:\a.txt", @"c:\A.TXT"));
    }

    [Fact]
    public void タブ形式なら各タブのファイルを無題を除いて返す()
    {
        Assert.Equal(new[] { @"C:\a.txt", @"C:\b.txt" },
            OpenPathsLogic.Collect(new string?[] { @"C:\a.txt", null, @"C:\b.txt" }, @"C:\b.txt", null));
    }
}
