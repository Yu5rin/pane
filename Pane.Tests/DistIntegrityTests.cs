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

    /// <summary>一覧(dist-files.json)の中身を組み立てる。</summary>
    private static string ListJson(params string[] files)
        => System.Text.Json.JsonSerializer.Serialize(new { format = 1, files });

    /// <summary>必須10個と、分割ファイル2個が載った正しい一覧。</summary>
    private static readonly string[] Chunks = { "chunk-AAAAAAAA.js", "mermaid-BBBBBBBB.js" };
    private static string FullList() => ListJson(DistIntegrity.RequiredFiles.Concat(Chunks).ToArray());

    [Fact]
    public void 全部そろっていれば欠けは無い()
    {
        Assert.Empty(DistIntegrity.FindMissing(FullList(), _ => true));
    }

    [Fact]
    public void 実際に起きた不具合_style_cssだけが欠けても気づく()
    {
        // index.html も main.js もあるので起動はするし、ボタンも押せる。見た目だけが崩れる。
        var missing = DistIntegrity.FindMissing(FullList(), name => name != "style.css");
        Assert.Equal(new[] { "style.css" }, missing);
    }

    [Fact]
    public void 一覧にある分割ファイルの欠けにも気づく()
    {
        // 名前にハッシュが付く分割ファイルは Pane 側で名前を決め打ちできない。一覧に載って
        // いれば確かめられる(利用者要望: 全ファイルの一覧で突き合わせる)。
        var missing = DistIntegrity.FindMissing(FullList(), name => name != "mermaid-BBBBBBBB.js");
        Assert.Equal(new[] { "mermaid-BBBBBBBB.js" }, missing);
    }

    [Fact]
    public void 欠けたものは必須一覧の順_そのあと一覧の順に並ぶ()
    {
        var gone = new HashSet<string> { "mermaid-BBBBBBBB.js", "manual.md", "chunk-AAAAAAAA.js", "index.html" };
        var missing = DistIntegrity.FindMissing(FullList(), name => !gone.Contains(name));
        Assert.Equal(new[] { "index.html", "manual.md", "chunk-AAAAAAAA.js", "mermaid-BBBBBBBB.js" }, missing);
    }

    [Fact]
    public void 一覧と必須一覧の両方に載っているものは1回だけ数える()
    {
        var missing = DistIntegrity.FindMissing(FullList(), name => name != "style.css");
        Assert.Single(missing);
    }

    [Fact]
    public void 一覧が無ければ一覧そのものを欠けとして返し_必須ファイルは確かめる()
    {
        // 一覧が無いと全部は確かめられない。直せば一覧も戻るので、欠けとして修復へ進める。
        var missing = DistIntegrity.FindMissing(null, name => name != "themes.css");
        Assert.Equal(new[] { "themes.css", DistIntegrity.FileListName }, missing);
    }

    [Fact]
    public void 一覧が無くても他が全部あれば欠けは一覧だけ()
    {
        Assert.Equal(new[] { DistIntegrity.FileListName }, DistIntegrity.FindMissing(null, _ => true));
    }

    [Theory]
    [InlineData("")]                                                        // 空
    [InlineData("これはJSONではない")]                                      // 壊れている
    [InlineData("[\"index.html\"]")]                                      // 形が違う(配列だけ)
    [InlineData("{\"files\":[\"index.html\"]}")]                        // 版が無い
    [InlineData("{\"format\":2,\"files\":[\"index.html\"]}")]         // 知らない版
    [InlineData("{\"format\":1}")]                                        // 一覧が無い
    [InlineData("{\"format\":1,\"files\":[1,2]}")]                      // 名前が文字列でない
    [InlineData("{\"format\":1,\"files\":[\"../Pane.exe\"]}")]         // distの外
    [InlineData("{\"format\":1,\"files\":[\"C:/Windows/win.ini\"]}")]  // 絶対パス
    public void 読めない一覧は壊れた一覧として扱う(string json)
    {
        Assert.Null(DistIntegrity.ParseFileList(json));
        // 壊れた一覧は信じず、一覧そのものを欠けとして修復へ進める。必須ファイルは確かめる。
        Assert.Equal(new[] { DistIntegrity.FileListName }, DistIntegrity.FindMissing(json, _ => true));
    }

    [Theory]
    [InlineData("style.css", true)]
    [InlineData("fonts/a.woff2", true)]      // サブフォルダ(今は無いが、あっても扱える)
    [InlineData("", false)]
    [InlineData(" ", false)]
    [InlineData("/etc/passwd", false)]       // 絶対パス
    [InlineData("..", false)]
    [InlineData("a/../../x", false)]         // 途中で外へ出る
    [InlineData("./style.css", false)]
    [InlineData("a//b", false)]              // 空の区切り
    [InlineData("fonts\\a.woff2", false)]  // 区切りは "/" だけ
    [InlineData("C:x", false)]               // ドライブ指定
    public void distの中を指す名前だけを受け付ける(string name, bool expected)
    {
        Assert.Equal(expected, DistIntegrity.IsSafeRelativeName(name));
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

    [Fact]
    public void 一覧のファイル名がbuild_jsの書き出すものと一致する()
    {
        // 名前がずれると、Pane は一覧を見つけられず、正常な dist でも毎回「欠けている」と言い出す。
        string buildJs = File.ReadAllText(Path.Combine(FindRepositoryRoot(), "scripts", "build.js"));
        Assert.Contains($"const DIST_FILE_LIST = \"{DistIntegrity.FileListName}\";", buildJs);
        Assert.Contains($"format: {DistIntegrity.SupportedFileListFormat},", buildJs);
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
