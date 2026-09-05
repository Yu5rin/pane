namespace Pane.Tests;

/// <summary>
/// 起動済みのときに相対パスを渡すと既存プロセスのカレントディレクトリで解決されてしまう
/// 不具合(<see cref="StartupPathResolver"/>、docs/調査記録/点検-機能と動作.md「余裕があれば直すもの」)の
/// 再発防止。
/// </summary>
public class StartupPathResolverTests
{
    [Fact]
    public void nullはそのまま返す()
    {
        Assert.Null(StartupPathResolver.ResolveToFullPath(null));
    }

    [Fact]
    public void 空文字列はそのまま返す()
    {
        Assert.Equal(string.Empty, StartupPathResolver.ResolveToFullPath(string.Empty));
    }

    [Fact]
    public void 相対パスは現在の作業ディレクトリを基準に絶対パスへ直す()
    {
        string original = Directory.GetCurrentDirectory();
        string tempDir = Directory.CreateTempSubdirectory("pane-startup-path-").FullName;
        try
        {
            Directory.SetCurrentDirectory(tempDir);
            string? resolved = StartupPathResolver.ResolveToFullPath("readme.md");
            Assert.Equal(Path.GetFullPath(Path.Combine(tempDir, "readme.md")), resolved);
        }
        finally
        {
            Directory.SetCurrentDirectory(original);
            Directory.Delete(tempDir, recursive: true);
        }
    }

    [Fact]
    public void 既に絶対パスであれば実質そのまま返る()
    {
        string absolute = Path.GetFullPath(Path.Combine(Path.GetTempPath(), "readme.md"));
        Assert.Equal(absolute, StartupPathResolver.ResolveToFullPath(absolute));
    }

    [Fact]
    public void 別プロセスの作業ディレクトリではなく呼び出し時点の作業ディレクトリを基準にする()
    {
        // 多重起動時のパイプ越しに文字列のまま渡すと、受け取った既存プロセスのカレント
        // ディレクトリで解決されてしまうのが元の不具合。ここでは「呼び出した側(今まさに
        // 起動したこのプロセス)の作業ディレクトリを基準にする」という直し方そのものを、
        // 作業ディレクトリを切り替えながら確認する。
        string original = Directory.GetCurrentDirectory();
        string dirA = Directory.CreateTempSubdirectory("pane-startup-path-a-").FullName;
        string dirB = Directory.CreateTempSubdirectory("pane-startup-path-b-").FullName;
        try
        {
            Directory.SetCurrentDirectory(dirA);
            string? resolvedInA = StartupPathResolver.ResolveToFullPath("doc.md");

            Directory.SetCurrentDirectory(dirB);
            string? resolvedInB = StartupPathResolver.ResolveToFullPath("doc.md");

            Assert.Equal(Path.GetFullPath(Path.Combine(dirA, "doc.md")), resolvedInA);
            Assert.Equal(Path.GetFullPath(Path.Combine(dirB, "doc.md")), resolvedInB);
            Assert.NotEqual(resolvedInA, resolvedInB);
        }
        finally
        {
            Directory.SetCurrentDirectory(original);
            Directory.Delete(dirA, recursive: true);
            Directory.Delete(dirB, recursive: true);
        }
    }
}
