namespace Pane.Tests;

/// <summary>
/// 総点検(docs/調査記録/点検-使い勝手.md 指摘H1)「開くダイアログのフィルタにコードファイルが無い」の
/// 再発防止。修正前は「Markdown / テキスト」と「すべてのファイル」しか無く、Paneが対応する
/// 約60種の言語(FileTypes.OpenableExtensions)を開くたびに「すべてのファイル」へ切り替える
/// 必要があった。ここでは(1)コードファイル用のフィルタが増えていること、(2)対応拡張子が
/// 1つも漏れないこと、(3)Windowsのフィルタ書式(奇数区切り、パターンに空白を含まない)を崩さ
/// ないこと、(4)既定で選ばれる1番目が従来どおりMarkdown/テキストのままであることを固定する。
/// </summary>
public class OpenDialogFilterBuilderTests
{
    private static string[] SplitParts(string filter) => filter.Split('|');

    [Fact]
    public void フィルタは説明文とパターンが交互に並ぶ偶数個の要素になる()
    {
        string[] parts = SplitParts(OpenDialogFilterBuilder.Build());
        Assert.Equal(0, parts.Length % 2);
    }

    [Fact]
    public void フィルタは3種類になっている_Markdownテキスト_コードファイル_すべてのファイル()
    {
        string[] parts = SplitParts(OpenDialogFilterBuilder.Build());
        Assert.Equal(6, parts.Length); // (説明,パターン) の組が3つ
        Assert.StartsWith("Markdown / テキスト", parts[0]);
        Assert.StartsWith("コードファイル", parts[2]);
        Assert.Equal("すべてのファイル (*.*)", parts[4]);
        Assert.Equal("*.*", parts[5]);
    }

    [Fact]
    public void 既定で選ばれる1番目はMarkdownテキストのまま()
    {
        // OpenFileDialog.FilterIndexを明示していないため既定値の1(1番目のフィルタ)が
        // 選ばれる。ここが変わると、コードファイルを頻繁に開く人向けの修正のつもりが、
        // 逆にMarkdownを開くときの体験を悪化させてしまう。
        string[] parts = SplitParts(OpenDialogFilterBuilder.Build());
        Assert.Contains("*.md", parts[1]);
        Assert.Contains("*.txt", parts[1]);
    }

    [Fact]
    public void Markdownテキストフィルタは対応するテキスト系拡張子をすべて含む()
    {
        string[] parts = SplitParts(OpenDialogFilterBuilder.Build());
        string markdownTextPatterns = parts[1];
        foreach (string ext in OpenDialogFilterBuilder.MarkdownTextExtensions)
        {
            Assert.Contains($"*.{ext}", markdownTextPatterns.Split(';'));
        }
    }

    [Fact]
    public void コードファイルフィルタにMarkdownテキストの拡張子が重複しない()
    {
        string[] parts = SplitParts(OpenDialogFilterBuilder.Build());
        string[] codeExts = parts[3].Split(';');
        foreach (string ext in OpenDialogFilterBuilder.MarkdownTextExtensions)
        {
            Assert.DoesNotContain($"*.{ext}", codeExts);
        }
    }

    [Fact]
    public void FileTypesの対応拡張子は1つも漏れずどちらかのフィルタに入る()
    {
        string[] parts = SplitParts(OpenDialogFilterBuilder.Build());
        var covered = new HashSet<string>(parts[1].Split(';').Concat(parts[3].Split(';')), StringComparer.OrdinalIgnoreCase);
        foreach (string ext in FileTypes.OpenableExtensions)
        {
            Assert.Contains($"*.{ext}", covered);
        }
    }

    [Fact]
    public void コードファイルのパターンにも実際に拡張子が入っている()
    {
        // Markdown/テキスト側に全部吸収されて空になっていないか(=そもそも今回の修正の
        // 意味が無くなっていないか)を確認する。
        string[] parts = SplitParts(OpenDialogFilterBuilder.Build());
        Assert.Contains("*.js", parts[3]);
        Assert.Contains("*.py", parts[3]);
        Assert.Contains("*.cs", parts[3]);
        Assert.Contains("*.json", parts[3]);
    }

    [Fact]
    public void パターン部分に空白や日本語を含まない_Windowsのフィルタ書式を壊さないため()
    {
        string[] parts = SplitParts(OpenDialogFilterBuilder.Build());
        // 奇数インデックス(1,3,5)がパターン、偶数インデックス(0,2,4)が説明文。
        for (int i = 1; i < parts.Length; i += 2)
        {
            Assert.DoesNotContain(' ', parts[i]);
            foreach (char c in parts[i])
            {
                Assert.True(c < 128, $"パターンにASCII外の文字が混ざっている: '{parts[i]}'");
            }
        }
    }
}
