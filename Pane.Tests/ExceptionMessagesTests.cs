namespace Pane.Tests;

/// <summary>
/// 総点検(docs/調査記録/点検-見た目とUI.md 指摘16)「エラー表示に例外の型名・例外メッセージがそのまま出る」の
/// 再発防止。<see cref="ExceptionMessages.Describe"/>が、利用者に見せてよい日本語だけを
/// 返し、型名や.NETの生の例外メッセージを漏らさないことを固定する。
/// </summary>
public class ExceptionMessagesTests
{
    [Theory]
    [InlineData(typeof(Exception))]
    [InlineData(typeof(InvalidOperationException))]
    [InlineData(typeof(ArgumentException))]
    [InlineData(typeof(FileNotFoundException))]
    [InlineData(typeof(DirectoryNotFoundException))]
    [InlineData(typeof(UnauthorizedAccessException))]
    [InlineData(typeof(IOException))]
    [InlineData(typeof(PathTooLongException))]
    [InlineData(typeof(TaskCanceledException))]
    public void 型名を文言に含めない(Type exceptionType)
    {
        var ex = (Exception)Activator.CreateInstance(exceptionType)!;
        string message = ExceptionMessages.Describe(ex);
        Assert.DoesNotContain(exceptionType.Name, message);
    }

    [Fact]
    public void 例外メッセージ自体は文言に含めない_ロケール依存の生テキストを漏らさないため()
    {
        // 実際の.NET例外メッセージは英語で、パスやHTTPステータスコードを含みうる
        // (例: "Access to the path 'C:\Users\...' is denied.")。これが利用者向けの
        // 文言にそのまま混ざっていないかを、わざと不自然な文字列で確認する。
        var ex = new IOException("__RAW_DOTNET_MESSAGE_MARKER__");
        string message = ExceptionMessages.Describe(ex);
        Assert.DoesNotContain("__RAW_DOTNET_MESSAGE_MARKER__", message);
    }

    [Fact]
    public void ファイルが見つからない場合は_見つからない_と伝える()
    {
        Assert.Contains("見つかりません", ExceptionMessages.Describe(new FileNotFoundException()));
        Assert.Contains("見つかりません", ExceptionMessages.Describe(new DirectoryNotFoundException()));
    }

    [Fact]
    public void 権限が無い場合は_権限_と伝える()
    {
        Assert.Contains("権限", ExceptionMessages.Describe(new UnauthorizedAccessException()));
        Assert.Contains("権限", ExceptionMessages.Describe(new System.Security.SecurityException()));
    }

    [Fact]
    public void 使用中や書き込めない場合はIOExceptionとして伝える()
    {
        // 共有違反・ディスク容量不足など、IOExceptionの具体的なサブクラスを持たない
        // ケースをまとめて拾う枠。FileNotFoundException等の特定サブクラスに埋もれず、
        // ちゃんと汎用IOExceptionの分岐へ落ちることを確認する。
        Assert.Contains("使用中", ExceptionMessages.Describe(new IOException()));
    }

    [Fact]
    public void パスが長すぎる場合は汎用のIOException文言に埋もれず専用の文言になる()
    {
        // PathTooLongExceptionはIOExceptionのサブクラスなので、判定順を間違えると
        // 「使用中」という不正確な文言になってしまう(このテストは順序のリグレッション防止)。
        string message = ExceptionMessages.Describe(new PathTooLongException());
        Assert.Contains("長すぎ", message);
        Assert.DoesNotContain("使用中", message);
    }

    [Fact]
    public void 通信できない場合は_通信_と伝える()
    {
        Assert.Contains("通信", ExceptionMessages.Describe(new System.Net.Http.HttpRequestException()));
    }

    [Fact]
    public void タイムアウト_キャンセルは時間内に終わらなかった旨を伝える()
    {
        Assert.Contains("時間内", ExceptionMessages.Describe(new TaskCanceledException()));
        Assert.Contains("時間内", ExceptionMessages.Describe(new OperationCanceledException()));
    }

    [Fact]
    public void 分類できない例外は汎用文言になる_型名を出さない()
    {
        string message = ExceptionMessages.Describe(new InvalidOperationException("some internal .NET detail"));
        Assert.Equal("予期しない問題が発生しました。", message);
    }

    // ---- Pane自身が日本語メッセージ付きで投げた例外は素通しする ----
    // (例: Pandocの呼び出し失敗、TextFileServiceの保存失敗)。型だけで一律に汎用文言へ
    // 差し替えると、せっかくの具体的な説明が消えて逆に不親切になるための回帰防止。

    [Fact]
    public void Pane自身が投げた日本語メッセージはそのまま返す_Pandoc呼び出し失敗の想定()
    {
        var ex = new InvalidOperationException("Pandocを起動できませんでした。");
        Assert.Equal("Pandocを起動できませんでした。", ExceptionMessages.Describe(ex));
    }

    [Fact]
    public void Pane自身が投げた日本語メッセージはそのまま返す_保存先フォルダ特定失敗の想定()
    {
        // TextFileService.SaveAtomicが投げる想定のIOException。型だけで判定すると
        // 「ファイルが他のプログラムで使用中か、書き込みできない状態です。」という
        // 見当違いの文言に上書きされてしまう(このテストはその回帰を防ぐ)。
        var ex = new IOException("保存先の親フォルダを特定できません: C:\\work\\note.md");
        Assert.Equal("保存先の親フォルダを特定できません: C:\\work\\note.md", ExceptionMessages.Describe(ex));
    }

    [Fact]
    public void Pandocの生のstderr_英語のみ_は汎用文言に言い換える()
    {
        // Pandoc自体が返す英語のエラー出力(カナを含まない)は、利用者には読めない技術的な
        // テキストなので、型名と同様に汎用文言へ言い換えて構わない(素通ししない)。
        var ex = new InvalidOperationException("pandoc: Could not find data file templates/default.latex");
        Assert.Equal("予期しない問題が発生しました。", ExceptionMessages.Describe(ex));
    }

    [Fact]
    public void すべての文言が句点で終わる_ダイアログやパネルに単独で表示されるため()
    {
        Type[] types =
        {
            typeof(Exception), typeof(FileNotFoundException), typeof(DirectoryNotFoundException),
            typeof(UnauthorizedAccessException), typeof(System.Security.SecurityException),
            typeof(PathTooLongException), typeof(IOException),
            typeof(System.Net.Http.HttpRequestException), typeof(TaskCanceledException),
            typeof(OperationCanceledException),
        };
        foreach (Type t in types)
        {
            var ex = (Exception)Activator.CreateInstance(t)!;
            string message = ExceptionMessages.Describe(ex);
            Assert.EndsWith("。", message);
        }
    }
}
