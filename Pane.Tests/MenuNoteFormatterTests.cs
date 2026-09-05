namespace Pane.Tests;

/// <summary>
/// 総点検(docs/調査記録/点検-使い勝手.md 3章「使い勝手のうち、小さく直せるもの」)の指摘:
/// 「Pandoc未導入の理由がToolTipTextにしかなく、無効項目では表示されない」の再発防止。
///
/// WinFormsの<c>ToolStripMenuItem</c>は無効(グレーアウト)な項目にマウスのhover系
/// イベントを配らないため、noteを<c>ToolTipText</c>へ設定するだけでは表示されない
/// (Pane/NativeMenu.cs)。修正後は、無効な項目に限りラベル自体へ note を付記する。
/// </summary>
public class MenuNoteFormatterTests
{
    [Fact]
    public void 無効な項目でnoteがあればラベルへ括弧書きで付記する()
    {
        string result = MenuNoteFormatter.ComputeDisplayLabel("エクスポート: Word", "Pandoc未導入", enabled: false);
        Assert.Equal("エクスポート: Word (Pandoc未導入)", result);
    }

    [Fact]
    public void 有効な項目はnoteがあってもラベルを変えない()
    {
        // 有効な項目はToolTipTextのホバー表示で案内する想定(ラベルへ二重に出さない)。
        string result = MenuNoteFormatter.ComputeDisplayLabel("エクスポート: PDF", "参考情報", enabled: true);
        Assert.Equal("エクスポート: PDF", result);
    }

    [Fact]
    public void 無効でもnoteが無ければラベルを変えない()
    {
        string result = MenuNoteFormatter.ComputeDisplayLabel("印刷", null, enabled: false);
        Assert.Equal("印刷", result);
    }

    [Fact]
    public void noteが空文字でもラベルを変えない()
    {
        string result = MenuNoteFormatter.ComputeDisplayLabel("印刷", "", enabled: false);
        Assert.Equal("印刷", result);
    }

    [Fact]
    public void 有効かつnote無しはそのまま()
    {
        string result = MenuNoteFormatter.ComputeDisplayLabel("保存", null, enabled: true);
        Assert.Equal("保存", result);
    }
}
