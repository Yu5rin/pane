namespace Pane;

/// <summary>
/// 設定・ログ・カスタムCSS・自動保存をどこに置くかの判断(仕様書 第7.1節)。
///
/// 以前は %LOCALAPPDATA%\Pane に置いていた。PCを引っ越すときに、exeのフォルダとは別に
/// そちらも探して運ばなければならず、運び忘れると設定やカスタムCSSが消えたように見える。
/// exeの隣の data フォルダに置けば、exeのフォルダごと運ぶだけで済む(2026-10-13、利用者の要望)。
///
/// ・exeの隣へ書き込めない場所(Program Files など)では、従来どおり %LOCALAPPDATA%\Pane を使う。
/// ・初めて data フォルダを使うときは、%LOCALAPPDATA%\Pane にあるものをコピーして引き継ぐ。
///   元の場所は消さない(コピーに失敗しても元が残るように)。
/// ・WebView2の作業用データ(表示の一時ファイル。消えても作り直される)は運ぶ必要が無いので、
///   %LOCALAPPDATA%\Pane\WebView2 のまま。ログも運ばない(過去のログは調査の役目を終えている)。
///
/// ファイルに触れない判定だけをここへ切り出し、Pane.Tests側で固定する。テストはLinuxでも回るので、
/// Windowsのパス(区切りが \)を System.IO.Path に頼らず文字列として扱う。
/// </summary>
internal static class DataFolderLogic
{
    /// <summary>exeの隣に作るフォルダの名前。</summary>
    internal const string PortableFolderName = "data";

    /// <summary>引き継ぎのときにコピーしないもの(%LOCALAPPDATA%\Pane の直下の名前)。</summary>
    internal static readonly IReadOnlyList<string> NotMigrated = new[] { "logs", "WebView2" };

    /// <summary>
    /// 置き場所を決める。
    /// </summary>
    /// <param name="exeDirectory">exeのあるフォルダ。分からなければnull。</param>
    /// <param name="legacyRoot">%LOCALAPPDATA%\Pane。</param>
    /// <param name="canWrite">そのフォルダを作って書き込めるか。</param>
    /// <returns>使うフォルダと、それがexeの隣か。</returns>
    internal static (string Root, bool Portable) DecideRoot(string? exeDirectory, string legacyRoot, Func<string, bool> canWrite)
    {
        if (!string.IsNullOrWhiteSpace(exeDirectory))
        {
            string portable = Join(exeDirectory, PortableFolderName);
            if (canWrite(portable)) return (portable, true);
        }
        return (legacyRoot, false);
    }

    /// <summary>
    /// %LOCALAPPDATA%\Pane から引き継ぐか。exeの隣を使うことになり、そこがまだ空で、
    /// 元の場所に何かあるときだけ。一度でも使い始めた data フォルダには上書きしない。
    /// </summary>
    internal static bool ShouldMigrate(bool portable, bool portableIsEmpty, bool legacyHasEntries)
        => portable && portableIsEmpty && legacyHasEntries;

    /// <summary>引き継ぐ対象か(%LOCALAPPDATA%\Pane の直下の名前で判断する)。</summary>
    internal static bool IsMigrated(string entryName)
        => !NotMigrated.Any(n => string.Equals(n, entryName, StringComparison.OrdinalIgnoreCase));

    /// <summary>
    /// 設定のカスタムCSSのパスを、今のカスタムCSSフォルダへ付け替えるか。付け替えるなら新しいパス、
    /// そのままでよければnull。
    ///
    /// 付け替えるのは次の2つの場合だけ(どちらも、今のフォルダに同じ名前のファイルがあるとき)。
    ///   ・引き継ぐ前の %LOCALAPPDATA%\Pane\themes を指している(引き継いだので今のフォルダにコピーがある)
    ///   ・指しているファイルが無い(exeのフォルダを別の場所やPCへ移したので、前のフォルダを指したままになった)
    /// 利用者が自分で選んだ別の場所のファイル(存在するもの)は触らない。
    /// </summary>
    internal static string? RebaseThemePath(string? path, string legacyThemes, string currentThemes, Func<string, bool> fileExists)
    {
        if (string.IsNullOrWhiteSpace(path)) return null;
        if (IsUnder(path, currentThemes)) return null;
        string name = FileName(path);
        if (name.Length == 0) return null;
        string candidate = Join(currentThemes, name);
        if (!fileExists(candidate)) return null;
        if (IsUnder(path, legacyThemes) || !fileExists(path)) return candidate;
        return null;
    }

    /// <summary>区切りを \ に揃えて連結する。</summary>
    internal static string Join(string directory, string name)
        => directory.TrimEnd('\\', '/') + "\\" + name;

    /// <summary><paramref name="path"/>が<paramref name="directory"/>の中にあるか(大文字小文字と区切りの違いは問わない)。</summary>
    internal static bool IsUnder(string path, string directory)
    {
        string p = Normalize(path);
        string d = Normalize(directory).TrimEnd('\\') + "\\";
        return p.StartsWith(d, StringComparison.OrdinalIgnoreCase);
    }

    private static string FileName(string path)
    {
        string p = Normalize(path).TrimEnd('\\');
        int index = p.LastIndexOf('\\');
        return index < 0 ? p : p[(index + 1)..];
    }

    private static string Normalize(string path) => path.Replace('/', '\\');
}
