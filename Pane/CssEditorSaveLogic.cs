namespace Pane;

/// <summary>
/// カスタムCSSの作成補助(仕様書 第2.10.1節 C-16)で、保存先のファイルを決める判断。
/// ファイルの有無は呼び出し側が関数で渡し、ここでは通信・ファイル・時刻に触れない
/// (Pane.Tests へソースごと取り込んで固定している)。
///
/// 決め方:
///   - 設定のカスタムCSSにファイルが指定されていれば、そのファイルへ上書きする
///   - ただし sample.css(<see cref="ThemeFolderService"/>が用意する参考用)は上書きしない。
///     sample.css は「無いときだけ書き出す」ため、書き換えると元の見本に戻せなくなる
///   - 未指定・sample.css のときは、カスタムCSSフォルダに custom.css を新しく作る。
///     既にあれば custom-2.css、custom-3.css… と空いている名前にする
///     (以前に作ったものを黙って上書きしないため)
/// </summary>
internal static class CssEditorSaveLogic
{
    /// <summary>ThemeFolderService が書き出す参考用のファイル名。</summary>
    internal const string SampleFileName = "sample.css";

    /// <summary>新しく作るときのファイル名(拡張子なし)。</summary>
    internal const string NewFileBaseName = "custom";

    /// <summary>空いている名前を探す上限。ここまで埋まっていることは実際には無いが、
    /// 無限に回らないよう区切る。</summary>
    internal const int MaxNumberedCandidates = 999;

    internal static bool IsSampleFile(string path) =>
        string.Equals(Path.GetFileName(path), SampleFileName, StringComparison.OrdinalIgnoreCase);

    /// <summary>保存先のフルパスを決める。</summary>
    /// <param name="currentCustomCssPath">設定のカスタムCSS(未指定なら null か空)。</param>
    /// <param name="themeFolder">カスタムCSSフォルダ(%LOCALAPPDATA%\Pane\themes)。</param>
    /// <param name="fileExists">ファイルがあるかを返す関数(File.Exists)。</param>
    internal static string DecideSavePath(string? currentCustomCssPath, string themeFolder, Func<string, bool> fileExists)
    {
        if (!string.IsNullOrWhiteSpace(currentCustomCssPath) && !IsSampleFile(currentCustomCssPath))
        {
            return currentCustomCssPath;
        }

        string first = Path.Combine(themeFolder, NewFileBaseName + ".css");
        if (!fileExists(first)) return first;
        for (int i = 2; i <= MaxNumberedCandidates; i++)
        {
            string candidate = Path.Combine(themeFolder, $"{NewFileBaseName}-{i}.css");
            if (!fileExists(candidate)) return candidate;
        }
        // すべて埋まっている(現実には起きない)。最初の名前へ上書きする形に倒す。
        // 上書きの前には画面側で確認を出す(targetExists が true になるため)。
        return first;
    }
}
