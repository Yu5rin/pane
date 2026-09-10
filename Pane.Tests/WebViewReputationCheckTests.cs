using System;
using System.IO;
using System.Linq;
using Xunit;

namespace Pane.Tests;

/// <summary>
/// 「WebView2を作るところは、必ずSmartScreenを止めている」ことを、ソースを走査して確かめる。
///
/// 【なぜこんなテストが要るか】
/// SmartScreenの有効・無効は、同じユーザーデータフォルダを使うWebView2すべてで共有される。
/// 公式ドキュメントいわく "If IsReputationCheckingRequired is true for any CoreWebView2
/// using the same user data folder, then SmartScreen is enabled." つまり
/// **1つでも設定を漏らすと、そのウィンドウが動き出した時点で全体が有効に戻る**。
/// PaneのWebView2は3つ(本文・設定・取扱説明書)あり、3つとも止めなければ意味がない。
///
/// これは docs/調査記録/README.md の「繰り返し出てきた誤り」8番
/// (入口が複数あるものを、入口ごとに塞ごうとする)とまったく同じ形で、実際に2回やっている。
/// 対象がWindows専用APIでテストから直接呼べないため、代わりに「呼び忘れ」そのものを
/// ソースの走査で捕まえる。4つ目のウィンドウが増えたとき、このテストが落ちる。
/// </summary>
public class WebViewReputationCheckTests
{
    private const string CreatesWebView = "EnsureCoreWebView2Async";
    private const string DisablesReputation = "WebViewReputationCheck.Disable";

    [Fact]
    public void WebView2を作るファイルはすべて評判チェックを止めている()
    {
        string paneDir = Path.Combine(FindRepositoryRoot(), "Pane");
        string[] creators = Directory.GetFiles(paneDir, "*.cs")
            .Where(f => ContainsInCode(f, CreatesWebView))
            .OrderBy(f => f, StringComparer.Ordinal)
            .ToArray();

        // 0件でうっかり通らないようにする。いまは本文・設定・取扱説明書の3つ。
        Assert.True(creators.Length >= 3,
            $"WebView2を作るファイルが{creators.Length}件しか見つからない。走査の条件が壊れていないか確かめること。");

        string[] missing = creators
            .Where(f => !ContainsInCode(f, DisablesReputation))
            .Select(Path.GetFileName)
            .ToArray()!;

        Assert.True(missing.Length == 0,
            $"WebView2を作っているのに{DisablesReputation}を呼んでいないファイルがある: {string.Join(", ", missing)}。" +
            "1つでも漏れると、同じユーザーデータフォルダを使う全ウィンドウでSmartScreenが有効に戻る" +
            "(Pane/WebViewReputationCheck.cs 参照)。");
    }

    /// <summary>
    /// コメント行を除いて探す。この2つの名前はどちらも説明の中で言及されるため
    /// (このファイル自身も、Pane/WebViewReputationCheck.csも)、素朴に全文を検索すると
    /// 「説明に書いてあるだけのファイル」まで対象に数えてしまう。
    /// </summary>
    private static bool ContainsInCode(string path, string needle)
        => File.ReadLines(path).Any(line =>
        {
            string trimmed = line.TrimStart();
            if (trimmed.StartsWith("//", StringComparison.Ordinal)) return false;
            if (trimmed.StartsWith("*", StringComparison.Ordinal)) return false;
            return line.Contains(needle, StringComparison.Ordinal);
        });

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
