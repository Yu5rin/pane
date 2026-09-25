namespace Pane.Tests;

/// <summary>
/// 本文の左右余白の既定値と、旧・editorPaddingX(左右共通1値)からの移行の判定
/// (<see cref="EditorPaddingDefaults"/>)を固定するテスト。
///
/// 2026-09-25に既定値を32から12へ変えた。移行の判定は既定値そのものを「まだ変えていない」の
/// 目印にしているため、既定値だけを変えて判定を「32/32のまま」にしておくと、Left/Rightのキーが
/// 無い旧い設定ファイル(読むと新しい既定値12で埋まる)の移行が起きなくなる。その再発防止。
/// </summary>
public class EditorPaddingDefaultsTests
{
    [Fact]
    public void 既定値は12()
    {
        Assert.Equal(12, EditorPaddingDefaults.DefaultPx);
    }

    [Fact]
    public void 旧Xの既定値は32のまま据え置く()
    {
        // 移行済みの設定ファイルはX=32になっている。ここを変えると移行済みの人が未移行に見える。
        Assert.Equal(32, EditorPaddingDefaults.LegacyPaddingXDefaultPx);
    }

    [Fact]
    public void 旧い設定ファイルを今の版で読むとXを左右へ引き継ぐ()
    {
        // Left/Rightのキーが無いファイルでは、Left/Rightは新しい既定値(12)で埋まる。
        Assert.Equal(50, EditorPaddingDefaults.DecideMigratedPadding(50, 12, 12));
    }

    [Fact]
    public void 以前の既定値のまま書き出されていたときもXを引き継ぐ()
    {
        Assert.Equal(50, EditorPaddingDefaults.DecideMigratedPadding(50, 32, 32));
    }

    [Fact]
    public void Xが既定値なら何もしない()
    {
        // 新規の人・移行済みの人(移行のあとXは32へ書き戻される)。
        Assert.Null(EditorPaddingDefaults.DecideMigratedPadding(32, 12, 12));
        Assert.Null(EditorPaddingDefaults.DecideMigratedPadding(32, 32, 32));
        Assert.Null(EditorPaddingDefaults.DecideMigratedPadding(32, 48, 0));
    }

    [Fact]
    public void 左右を既定値以外にしているならXで上書きしない()
    {
        Assert.Null(EditorPaddingDefaults.DecideMigratedPadding(50, 48, 48));
        Assert.Null(EditorPaddingDefaults.DecideMigratedPadding(50, 12, 32));
        Assert.Null(EditorPaddingDefaults.DecideMigratedPadding(50, 32, 0));
    }
}
