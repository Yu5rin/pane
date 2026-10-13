namespace Pane.Tests;

/// <summary>
/// 設定・ログ・カスタムCSS・自動保存の置き場所(<see cref="DataFolderLogic"/>。仕様書 第7.1節)を固定するテスト。
///
/// PCを引っ越すときにexeのフォルダごと運べば済むよう、exeの隣の data に置く(2026-10-13、利用者の要望)。
/// 以前の %LOCALAPPDATA%\Pane からは初回に引き継ぎ、書き込めない場所では従来の場所に戻す。
/// </summary>
public class DataFolderLogicTests
{
    private const string Legacy = @"C:\Users\u\AppData\Local\Pane";

    [Fact]
    public void exeの隣に書き込めればdataフォルダを使う()
    {
        var (root, portable) = DataFolderLogic.DecideRoot(@"D:\Tools\Pane", Legacy, _ => true);
        Assert.Equal(@"D:\Tools\Pane\data", root);
        Assert.True(portable);
    }

    [Fact]
    public void exeの隣に書き込めなければ従来の場所を使う()
    {
        // Program Files などに置いたとき。起動できなくなるより、従来どおり動くほうがよい。
        var (root, portable) = DataFolderLogic.DecideRoot(@"C:\Program Files\Pane", Legacy, _ => false);
        Assert.Equal(Legacy, root);
        Assert.False(portable);
    }

    [Fact]
    public void exeの場所が分からなければ従来の場所を使う()
    {
        var (root, portable) = DataFolderLogic.DecideRoot(null, Legacy, _ => true);
        Assert.Equal(Legacy, root);
        Assert.False(portable);
    }

    [Fact]
    public void 初めてdataを使うときだけ引き継ぐ()
    {
        Assert.True(DataFolderLogic.ShouldMigrate(portable: true, portableIsEmpty: true, legacyHasEntries: true));
    }

    [Fact]
    public void 使い始めたdataには上書きしない()
    {
        // 引き継いだあとに変えた設定を、古い場所の内容で巻き戻さないため。
        Assert.False(DataFolderLogic.ShouldMigrate(portable: true, portableIsEmpty: false, legacyHasEntries: true));
    }

    [Fact]
    public void 従来の場所を使うときや元が空なら引き継がない()
    {
        Assert.False(DataFolderLogic.ShouldMigrate(portable: false, portableIsEmpty: true, legacyHasEntries: true));
        Assert.False(DataFolderLogic.ShouldMigrate(portable: true, portableIsEmpty: true, legacyHasEntries: false));
    }

    [Fact]
    public void ログとWebView2の作業用データは引き継がない()
    {
        Assert.False(DataFolderLogic.IsMigrated("logs"));
        Assert.False(DataFolderLogic.IsMigrated("WebView2"));
        Assert.False(DataFolderLogic.IsMigrated("webview2"));
        Assert.True(DataFolderLogic.IsMigrated("settings.json"));
        Assert.True(DataFolderLogic.IsMigrated("themes"));
        Assert.True(DataFolderLogic.IsMigrated("autosave"));
    }

    // ---- カスタムCSSのパスの付け替え ----

    private const string LegacyThemes = Legacy + @"\themes";
    private const string Themes = @"D:\Tools\Pane\data\themes";

    [Fact]
    public void 引き継ぐ前の場所を指していれば今のフォルダへ付け替える()
    {
        string? rebased = DataFolderLogic.RebaseThemePath(
            LegacyThemes + @"\custom.css", LegacyThemes, Themes, p => true);
        Assert.Equal(Themes + @"\custom.css", rebased);
    }

    [Fact]
    public void exeのフォルダを移して前のフォルダを指したままなら付け替える()
    {
        // E:\ から D:\ へ運んだ。前の場所のファイルはもう無い。
        string old = @"E:\Old\Pane\data\themes\custom.css";
        string? rebased = DataFolderLogic.RebaseThemePath(old, LegacyThemes, Themes, p => p != old);
        Assert.Equal(Themes + @"\custom.css", rebased);
    }

    [Fact]
    public void 自分で選んだ別の場所のファイルは触らない()
    {
        string mine = @"C:\Users\u\Documents\my.css";
        Assert.Null(DataFolderLogic.RebaseThemePath(mine, LegacyThemes, Themes, _ => true));
    }

    [Fact]
    public void 今のフォルダに同じ名前のファイルが無ければ付け替えない()
    {
        string old = @"E:\Old\Pane\data\themes\custom.css";
        Assert.Null(DataFolderLogic.RebaseThemePath(old, LegacyThemes, Themes, _ => false));
    }

    [Fact]
    public void 今のフォルダを指していればそのまま()
    {
        Assert.Null(DataFolderLogic.RebaseThemePath(Themes + @"\custom.css", LegacyThemes, Themes, _ => true));
        Assert.Null(DataFolderLogic.RebaseThemePath(null, LegacyThemes, Themes, _ => true));
        Assert.Null(DataFolderLogic.RebaseThemePath("", LegacyThemes, Themes, _ => true));
    }

    [Fact]
    public void 中にあるかは大文字小文字と区切りの違いを問わない()
    {
        Assert.True(DataFolderLogic.IsUnder(@"d:/tools/pane/DATA/themes/a.css", Themes));
        Assert.False(DataFolderLogic.IsUnder(@"D:\Tools\Pane\data\themes2\a.css", Themes));
    }
}
