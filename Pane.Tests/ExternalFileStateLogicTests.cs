namespace Pane.Tests;

/// <summary>
/// 開いているファイルが外部で削除・リネームされた状態の判定のテスト。
///
/// 【なぜここを固定するか】この判定は、以前は「監視が削除イベントを受け取ったか」という
/// フラグで持っていた。フラグは取りこぼす(監視を張れていない・フォルダごと消された)し、
/// 逆に古くなる(消された後で同じ名前のファイルが作り直された)。いまは「保存する時点で
/// 実際に在るか」で判断する形にしてあり、その境目を崩さないための記録である。
/// </summary>
public class ExternalFileStateLogicTests
{
    // ---- 判定 ------------------------------------------------------------

    [Fact]
    public void 保存先がそのまま在れば何も言わない()
    {
        Assert.Equal(
            ExternalFileState.Present,
            ExternalFileStateLogic.Evaluate(targetExists: true, renamedToPath: null, renamedToExists: false));
    }

    [Fact]
    public void 保存先が無く名前の変更先も無ければ削除として扱う()
    {
        Assert.Equal(
            ExternalFileState.Deleted,
            ExternalFileStateLogic.Evaluate(targetExists: false, renamedToPath: null, renamedToExists: false));
    }

    [Fact]
    public void 保存先が無く名前の変更先が在ればリネームとして扱う()
    {
        Assert.Equal(
            ExternalFileState.Renamed,
            ExternalFileStateLogic.Evaluate(
                targetExists: false, renamedToPath: @"C:\work\新しい名前.txt", renamedToExists: true));
    }

    [Fact]
    public void 名前の変更先を覚えていても既に消えていれば削除として扱う()
    {
        // 名前を変えた後さらに削除された/また別の名前になった場合。いま言えるのは
        // 「元の名前のファイルが無い」ことだけなので、無い名前を文面に出さない。
        Assert.Equal(
            ExternalFileState.Deleted,
            ExternalFileStateLogic.Evaluate(
                targetExists: false, renamedToPath: @"C:\work\消えた名前.txt", renamedToExists: false));
    }

    [Fact]
    public void 名前を変えられた後に元の名前へ戻されたら止めない()
    {
        // 覚えている変更先が在っても、元の名前が在るなら利用者から見れば「ある」。
        Assert.Equal(
            ExternalFileState.Present,
            ExternalFileStateLogic.Evaluate(
                targetExists: true, renamedToPath: @"C:\work\別名.txt", renamedToExists: true));
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    public void 名前の変更先が空なら在ることになっていても削除として扱う(string? renamedToPath)
    {
        Assert.Equal(
            ExternalFileState.Deleted,
            ExternalFileStateLogic.Evaluate(
                targetExists: false, renamedToPath: renamedToPath, renamedToExists: true));
    }

    // ---- 文面 ------------------------------------------------------------

    [Fact]
    public void 削除の文面には開いているファイルの名前と結果が入る()
    {
        string msg = ExternalFileStateLogic.BuildSaveConfirmMessage(
            ExternalFileState.Deleted, "メモ.txt", renamedToFileName: null);
        Assert.Contains("メモ.txt", msg);
        Assert.Contains("削除", msg);
        Assert.Contains("新しく作成", msg);
        Assert.EndsWith("保存しますか?", msg);
    }

    [Fact]
    public void リネームの文面には変更後と元の名前が両方入る()
    {
        string msg = ExternalFileStateLogic.BuildSaveConfirmMessage(
            ExternalFileState.Renamed, "メモ.txt", "メモ_old.txt");
        Assert.Contains("メモ_old.txt", msg);  // 変更後の名前
        Assert.Contains("メモ.txt", msg);      // このまま保存したときに作られる名前
        Assert.Contains("別のファイル", msg);
        Assert.EndsWith("保存しますか?", msg);
    }

    [Fact]
    public void リネームでも変更後の名前が無ければ削除の文面にする()
    {
        // 名前を出せないのに「名前を変更されています」とだけ言うと、利用者は
        // どこへ行ったのか確かめようがない。
        string msg = ExternalFileStateLogic.BuildSaveConfirmMessage(
            ExternalFileState.Renamed, "メモ.txt", renamedToFileName: null);
        Assert.Contains("削除", msg);
    }

    [Fact]
    public void 文面に内部の用語を出さない()
    {
        foreach (string msg in new[]
        {
            ExternalFileStateLogic.BuildSaveConfirmMessage(ExternalFileState.Deleted, "メモ.txt", null),
            ExternalFileStateLogic.BuildSaveConfirmMessage(ExternalFileState.Renamed, "メモ.txt", "別名.txt"),
        })
        {
            foreach (string word in new[] { "FileSystemWatcher", "null", "path", "Path", "Exception" })
            {
                Assert.DoesNotContain(word, msg);
            }
        }
    }
}
