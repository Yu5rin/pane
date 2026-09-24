using System.Text.RegularExpressions;

namespace Pane.Tests;

/// <summary>
/// dist の欠けの判定と、利用者へ出す文面のテスト。
///
/// 【実際に起きたこと】ある1台で dist\style.css だけが無く、画面が崩れたまま
/// 何も言わずに動き続けていた。起動時は index.html の有無しか見ていなかったためで、
/// その取りこぼしを <see cref="実際に起きた不具合_style_cssだけが欠けても気づく"/> で固定する。
/// </summary>
public class DistIntegrityTests
{
    // ---- 判定 ------------------------------------------------------------

    [Fact]
    public void 全部そろっていれば欠けは無い()
    {
        Assert.Empty(DistIntegrity.FindMissing(_ => true));
    }

    [Fact]
    public void 実際に起きた不具合_style_cssだけが欠けても気づく()
    {
        // index.html も main.js もあるので起動はするし、ボタンも押せる。見た目だけが崩れる。
        var missing = DistIntegrity.FindMissing(name => name != "style.css");
        Assert.Equal(new[] { "style.css" }, missing);
    }

    [Fact]
    public void 欠けたものは必須一覧の順に並ぶ()
    {
        var gone = new HashSet<string> { "manual.md", "index.html", "themes.css" };
        var missing = DistIntegrity.FindMissing(name => !gone.Contains(name));
        Assert.Equal(new[] { "index.html", "themes.css", "manual.md" }, missing);
    }

    [Fact]
    public void 必須一覧はbuild_jsがdistへ置くものと一致する()
    {
        // 必須一覧はbuild.jsと二重に持っている。build.jsへファイルを足したのにこちらを
        // 直し忘れると、そのファイルが欠けても気づけない(逆に、もう置かれないファイルを
        // 残すと、正常なのに毎回「欠けている」と言い出す)。ここで突き合わせて固定する。
        string buildJs = File.ReadAllText(Path.Combine(FindRepositoryRoot(), "scripts", "build.js"));

        var expected = new SortedSet<string>(StringComparer.Ordinal);

        // const staticFiles = ["index.html", ...];
        Match staticFiles = Regex.Match(buildJs, @"const\s+staticFiles\s*=\s*\[(?<list>[^\]]*)\]");
        Assert.True(staticFiles.Success, "build.js に staticFiles が見つからなかった");
        foreach (Match m in Regex.Matches(staticFiles.Groups["list"].Value, "\"(?<name>[^\"]+)\""))
            expected.Add(m.Groups["name"].Value);

        // entryPoints: ["src/main.js", "src/settings-entry.js", "src/help-entry.js"]
        //   → outdir "dist" に同じ名前の .js ができる
        Match entries = Regex.Match(buildJs, @"entryPoints:\s*\[(?<list>""src/[^\]]*)\]");
        Assert.True(entries.Success, "build.js に src/ の entryPoints が見つからなかった");
        foreach (Match m in Regex.Matches(entries.Groups["list"].Value, "\"src/(?<name>[^\"]+)\""))
            expected.Add(m.Groups["name"].Value);

        // 取扱説明書は dist/manual.md へ名前を変えて置かれる
        Assert.Contains("path.join(\"dist\", \"manual.md\")", buildJs);
        expected.Add("manual.md");

        Assert.Equal(expected, new SortedSet<string>(DistIntegrity.RequiredFiles, StringComparer.Ordinal));
    }

    // ---- 文面 ------------------------------------------------------------

    [Fact]
    public void 修復の確認には欠けたファイル名と押した先で起きることが書いてある()
    {
        string msg = DistIntegrity.BuildRepairPrompt(new[] { "style.css" });
        Assert.Contains("・style.css", msg);
        Assert.Contains("ダウンロード", msg);   // 通信すること
        Assert.Contains("75MB", msg);           // 大きさ
        Assert.Contains("再起動", msg);         // 終わったら再起動すること
        Assert.Contains("直しますか?", msg);
    }

    [Fact]
    public void 欠けたファイルが多いときは先頭だけ並べて残りは件数にする()
    {
        var many = DistIntegrity.RequiredFiles.ToList();   // 10件
        string names = DistIntegrity.FormatNames(many);
        string[] lines = names.Split('\n');
        Assert.Equal(DistIntegrity.MaxListedNames + 1, lines.Length);
        Assert.Equal($"・ほか{many.Count - DistIntegrity.MaxListedNames}件", lines[^1]);
    }

    [Fact]
    public void 上限ちょうどなら件数の行は付かない()
    {
        var five = DistIntegrity.RequiredFiles.Take(DistIntegrity.MaxListedNames).ToList();
        Assert.DoesNotContain("ほか", DistIntegrity.FormatNames(five));
    }

    [Fact]
    public void 手で直す案内には理由と手順と次の一手がある()
    {
        string msg = DistIntegrity.BuildManualRepairMessage("配布元から時間内に応答がありませんでした。");
        Assert.StartsWith("配布元から時間内に応答がありませんでした。", msg);
        Assert.Contains("dist フォルダを削除", msg);
        Assert.EndsWith("リリースページを開きますか?", msg);
    }

    [Fact]
    public void 文面に内部の用語を出さない()
    {
        foreach (string msg in new[]
        {
            DistIntegrity.BuildRepairPrompt(DistIntegrity.RequiredFiles),
            DistIntegrity.BuildManualRepairMessage("理由"),
        })
        {
            foreach (string word in new[] { "Exception", "null", "DistIntegrity", "WebView2", "HTTP" })
            {
                Assert.DoesNotContain(word, msg);
            }
        }
    }

    /// <summary>Pane.slnのある場所まで遡る。テストの実行場所(bin/Debug/net8.0)に依存させない。</summary>
    private static string FindRepositoryRoot()
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir is not null && !File.Exists(Path.Combine(dir.FullName, "Pane.sln")))
        {
            dir = dir.Parent;
        }
        Assert.True(dir is not null, "Pane.sln が見つからなかった(リポジトリの外でテストを動かしている)。");
        return dir!.FullName;
    }
}
