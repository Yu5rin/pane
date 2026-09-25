namespace Pane.Tests;

/// <summary>
/// カスタムCSSの作成補助(仕様書 第2.10.1節 C-16)の保存先の決め方
/// (<see cref="CssEditorSaveLogic"/>)を固定するテスト。
/// 守りたいのは2点: 参考用の sample.css を上書きしないこと、以前に作ったファイルを
/// 黙って上書きしないこと(新しく作るときは空いている名前にする)。
/// </summary>
public class CssEditorSaveLogicTests
{
    private static readonly string Folder = Path.Combine("C:", "themes");

    private static Func<string, bool> Existing(params string[] names)
    {
        var set = new HashSet<string>(names.Select(n => Path.Combine(Folder, n)), StringComparer.OrdinalIgnoreCase);
        return set.Contains;
    }

    [Fact]
    public void 指定済みのファイルがあればそこへ上書きする()
    {
        string current = Path.Combine("D:", "my", "night.css");
        Assert.Equal(current, CssEditorSaveLogic.DecideSavePath(current, Folder, Existing()));
    }

    [Fact]
    public void 未指定ならcustom_cssを作る()
    {
        Assert.Equal(Path.Combine(Folder, "custom.css"), CssEditorSaveLogic.DecideSavePath(null, Folder, Existing()));
        Assert.Equal(Path.Combine(Folder, "custom.css"), CssEditorSaveLogic.DecideSavePath("  ", Folder, Existing()));
    }

    [Fact]
    public void sample_cssは上書きせず別名で作る()
    {
        string sample = Path.Combine(Folder, "sample.css");
        Assert.Equal(Path.Combine(Folder, "custom.css"), CssEditorSaveLogic.DecideSavePath(sample, Folder, Existing("sample.css")));
    }

    [Fact]
    public void sample_cssの判定は大文字小文字を区別しない()
    {
        Assert.True(CssEditorSaveLogic.IsSampleFile(Path.Combine(Folder, "Sample.CSS")));
        Assert.False(CssEditorSaveLogic.IsSampleFile(Path.Combine(Folder, "sample2.css")));
    }

    [Fact]
    public void 既にあれば番号を付けた空いている名前にする()
    {
        Assert.Equal(Path.Combine(Folder, "custom-2.css"), CssEditorSaveLogic.DecideSavePath(null, Folder, Existing("custom.css")));
        Assert.Equal(Path.Combine(Folder, "custom-4.css"), CssEditorSaveLogic.DecideSavePath(null, Folder, Existing("custom.css", "custom-2.css", "custom-3.css")));
    }
}
