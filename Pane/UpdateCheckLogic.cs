using System.Xml.Linq;

namespace Pane;

/// <summary>
/// 更新の確認のうち、外の世界に触れない部分だけを集めたもの。
///
/// 通信・ファイル・ログ・設定から切り離してあるので、値を渡して戻り値を見るだけで
/// 試せる(Pane.Tests/UpdateCheckLogicTests.cs)。<see cref="UpdateService"/> 側には
/// 通信と入れ替えの手順だけを残し、判断の中身はここへ寄せている。
///
/// ここを間違えると「新しい版があるのに気づかない」「古い版を新しいと判断する」
/// といった、利用者からは見えにくいまま長く残る不具合になる。実際に
///   ・タグの "v" を落とし忘れてバージョンを読み取れず、確認が必ず失敗した(v1.0.5)
///   ・文字列比較だと 1.0.10 が 1.0.9 より古く見える
/// という誤りが起きているため、判断の部分は必ずここを通し、テストで固定する。
/// </summary>
internal static class UpdateCheckLogic
{
    /// <summary>
    /// バージョン表記を比較できる形にする。読めなければnull。
    ///
    /// 吸収するもの:
    ///   ・先頭の "v"(Gitのタグの慣例。"v1.0.4" → 1.0.4)
    ///   ・"+&lt;ハッシュ&gt;" / "-beta" のような追記
    ///   ・桁数の違い(1.0.1 と 1.0.1.0 を同じものとして扱う)
    /// </summary>
    internal static Version? ParseVersion(string? text)
    {
        if (string.IsNullOrWhiteSpace(text)) return null;

        string core = StripVersionPrefix(text.Trim());
        int plus = core.IndexOf('+');
        if (plus >= 0) core = core[..plus];
        int hyphen = core.IndexOf('-');
        if (hyphen >= 0) core = core[..hyphen];

        if (!Version.TryParse(core, out Version? v)) return null;
        return new Version(
            Math.Max(v.Major, 0),
            Math.Max(v.Minor, 0),
            Math.Max(v.Build, 0),
            Math.Max(v.Revision, 0));
    }

    /// <summary>タグ名の先頭の "v" を落とす("v1.0.4" → "1.0.4")。</summary>
    internal static string StripVersionPrefix(string tag)
    {
        string t = tag.Trim();
        return t.Length > 1 && (t[0] == 'v' || t[0] == 'V') ? t[1..] : t;
    }

    /// <summary>
    /// APIの問い合わせ先から、同じリポジトリのAtomフィードのURLを組み立てる。
    /// 形が違って組み立てられない場合(GitHub以外の配布元を設定している場合など)はnull。
    ///
    ///   https://api.github.com/repos/{owner}/{repo}/releases/latest
    ///     → https://github.com/{owner}/{repo}/releases.atom
    /// </summary>
    internal static string? TryBuildAtomUrl(string apiUrl)
    {
        try
        {
            if (!Uri.TryCreate(apiUrl, UriKind.Absolute, out Uri? uri)) return null;
            if (!string.Equals(uri.Host, "api.github.com", StringComparison.OrdinalIgnoreCase)) return null;

            string[] parts = uri.AbsolutePath.Trim('/').Split('/');
            // repos / {owner} / {repo} / releases / latest
            if (parts.Length < 4 || !string.Equals(parts[0], "repos", StringComparison.OrdinalIgnoreCase)) return null;
            if (string.IsNullOrEmpty(parts[1]) || string.IsNullOrEmpty(parts[2])) return null;

            return $"https://github.com/{parts[1]}/{parts[2]}/releases.atom";
        }
        catch
        {
            return null;
        }
    }

    /// <summary>AtomフィードのURLから、あるタグのリリースページのURLを組み立てる。</summary>
    internal static string BuildReleasePageUrl(string atomUrl, string tag)
        => atomUrl.EndsWith(".atom", StringComparison.OrdinalIgnoreCase)
            ? $"{atomUrl[..^".atom".Length]}/tag/{Uri.EscapeDataString(tag)}"
            : "";

    /// <summary>
    /// Atomフィードのxmlから、いちばん新しいリリースのタグ名を取り出す。読めなければnull。
    ///
    /// 並び順に頼らず、読み取れたタグのうちバージョンとして最大のものを選ぶ。フィードは
    /// 普通は新しい順に並ぶが、それに依存すると、並びが変わったときに古い版を「最新」と
    /// 判断してしまう。バージョンとして読めないタグ(下書き用の名前など)は無視する。
    ///
    /// タグ名はリリースページのURL(entryのlinkのhref)の末尾に出る。
    /// </summary>
    internal static string? ExtractLatestTagFromAtom(string xml)
    {
        try
        {
            var feed = XDocument.Parse(xml);
            XNamespace atom = "http://www.w3.org/2005/Atom";

            string? bestTag = null;
            Version? bestVersion = null;
            foreach (XElement entry in feed.Root?.Elements(atom + "entry") ?? Enumerable.Empty<XElement>())
            {
                string? href = entry.Elements(atom + "link")
                    .Select(e => (string?)e.Attribute("href"))
                    .FirstOrDefault(h => !string.IsNullOrEmpty(h));
                if (string.IsNullOrEmpty(href)) continue;

                string tag = Uri.UnescapeDataString(href.TrimEnd('/').Split('/').Last());
                if (string.IsNullOrEmpty(tag)) continue;

                Version? version = ParseVersion(tag);
                if (version is null) continue;
                if (bestVersion is not null && version <= bestVersion) continue;

                bestVersion = version;
                bestTag = tag;
            }
            return bestTag;
        }
        catch
        {
            // 壊れたxmlが返ってきても、呼び出し元はAPIで確認できる。ここでは黙って諦める。
            return null;
        }
    }

    /// <summary>
    /// 配布元のタグと、いま動いている版を見比べて、更新があるかどうかを決める。
    /// どちらかが読み取れない場合はnull(=判断できない)を返す。
    /// </summary>
    internal static bool? IsNewerThanCurrent(string? latestTag, string? currentVersionText)
    {
        Version? latest = ParseVersion(latestTag);
        Version? current = ParseVersion(currentVersionText);
        if (latest is null || current is null) return null;
        return latest > current;
    }
}
