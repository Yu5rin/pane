namespace Pane.Tests;

/// <summary>
/// Pandocをパス無しの"pandoc"で起動していた不具合(docs/調査記録/点検-セキュリティ.md C-7、
/// SettingsBridge.DetectPandocAvailable / MainForm.ExportViaPandocAsync)の修正
/// (<see cref="ExternalToolLocator"/>)を固定するテスト。
///
/// Win32のCreateProcessは拡張子の無いファイル名に自動で".exe"を補ったうえで、
/// (1)実行ファイル(Pane.exe)のあるフォルダ→(2)カレントディレクトリ→(3)PATH、の順に探す。
/// Paneはポータブル配布でダウンロードフォルダに置かれがちなため、(1)(2)に紛れ込んだ
/// "pandoc.exe"が本物より先に実行されてしまう。この一線(PATHの中だけを見る。(1)(2)は
/// 見ない)を崩すと、起動しただけで得体の知れないexeが実行される事故に戻る。
/// </summary>
public class ExternalToolLocatorTests
{
    private static string J(params string[] dirs) => string.Join(Path.PathSeparator, dirs);

    [Fact]
    public void PATH上のフォルダにあれば見つかる()
    {
        var existing = new HashSet<string> { Path.Combine("C", "tools", "pandoc.exe") };
        string? found = ExternalToolLocator.ResolveFromPath("pandoc", J(Path.Combine("C", "tools")), existing.Contains);
        Assert.Equal(Path.Combine("C", "tools", "pandoc.exe"), found);
    }

    [Fact]
    public void 拡張子を書かなくても_exeを補って探す()
    {
        var existing = new HashSet<string> { Path.Combine("C", "tools", "pandoc.exe") };
        string? found = ExternalToolLocator.ResolveFromPath("pandoc", J(Path.Combine("C", "tools")), existing.Contains);
        Assert.NotNull(found);
        Assert.EndsWith(".exe", found);
    }

    [Fact]
    public void PATHの複数フォルダを先頭から順に探す()
    {
        var existing = new HashSet<string> { Path.Combine("C", "second", "pandoc.exe") };
        string? found = ExternalToolLocator.ResolveFromPath(
            "pandoc",
            J(Path.Combine("C", "first"), Path.Combine("C", "second")),
            existing.Contains);
        Assert.Equal(Path.Combine("C", "second", "pandoc.exe"), found);
    }

    [Fact]
    public void PATHのどこにも無ければnull()
    {
        string? found = ExternalToolLocator.ResolveFromPath("pandoc", J(Path.Combine("C", "tools")), _ => false);
        Assert.Null(found);
    }

    [Fact]
    public void PATH環境変数が空またはnullならnull()
    {
        Assert.Null(ExternalToolLocator.ResolveFromPath("pandoc", null, _ => true));
        Assert.Null(ExternalToolLocator.ResolveFromPath("pandoc", "", _ => true));
    }

    [Fact]
    public void カレントディレクトリを意味する_ドット_はPATHに入っていても見ない()
    {
        // "."(カレントディレクトリ)をPATHのエントリとして与えても、
        // fileExistsが呼ばれる候補には含めない(常にfalseを返すダミーで確認)。
        bool calledForDot = false;
        bool FileExists(string path)
        {
            if (path == Path.Combine(".", "pandoc.exe")) calledForDot = true;
            return false;
        }
        ExternalToolLocator.ResolveFromPath("pandoc", J("."), FileExists);
        Assert.False(calledForDot);
    }

    [Fact]
    public void 空エントリはスキップしてカレントディレクトリを見ない()
    {
        var existing = new HashSet<string> { Path.Combine("C", "tools", "pandoc.exe") };
        // 先頭が空エントリ(区切り文字が連続した場合など)でも、後続のPATHエントリはちゃんと見る。
        string? found = ExternalToolLocator.ResolveFromPath("pandoc", J("", Path.Combine("C", "tools")), existing.Contains);
        Assert.Equal(Path.Combine("C", "tools", "pandoc.exe"), found);
    }

    [Fact]
    public void 実行ファイルのフォルダやカレントディレクトリは引数として渡さない限り検索対象にならない()
    {
        // このメソッドはPATH文字列以外の場所(呼び出し元プロセスの実行ファイルのフォルダ・
        // カレントディレクトリ)を一切見ない。fileExistsに来る候補がPATHエントリ由来だけに
        // なることを、呼ばれた候補パスの記録で確認する。
        var seenCandidates = new List<string>();
        bool FileExists(string path) { seenCandidates.Add(path); return false; }

        ExternalToolLocator.ResolveFromPath("pandoc", J(Path.Combine("C", "only-this")), FileExists);

        Assert.Single(seenCandidates);
        Assert.Equal(Path.Combine("C", "only-this", "pandoc.exe"), seenCandidates[0]);
    }
}
