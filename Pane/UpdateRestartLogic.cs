namespace Pane;

/// <summary>
/// 更新の入れ替えの前後で何をするかの判断(仕様書 U-04b・U-10)。
///
/// ・入れ替えて再起動したあと、更新の直前に開いていた資料を開き直す(U-04b)。
///   以前は再起動すると空のウィンドウで立ち上がり、開いていたファイルを開き直す手間がかかった
///   (起動時の動作を「前回のセッションを復元」にしている人だけは戻っていたが、それは
///   最後に全部閉じたときの一覧で、更新の直前の一覧ではない)。
/// ・設定でオンにした人だけ、新しい版を裏で用意しておき、本体のウィンドウをすべて閉じたときに
///   入れ替える(U-10)。作業中のウィンドウが突然閉じて開き直されることはない。
///
/// 通信・ファイル・時刻・プロセスに触れない判定だけをここへ切り出し、Pane.Tests側で固定する。
/// </summary>
internal static class UpdateRestartLogic
{
    /// <summary>更新で入れ替わった新しい側として起動されたことを示す引数。次に古い側のPIDが続く。</summary>
    internal const string AfterUpdateArg = "--after-update";

    /// <summary>ウィンドウを出さずに常駐で待つ(B-1)。</summary>
    internal const string PreloadArg = "--preload";

    /// <summary>
    /// 常駐はするが、起動時のウィンドウは普通に開く。常駐していたPaneを、開いていた資料ごと
    /// 入れ替えるときに使う。<see cref="PreloadArg"/>のままだと最初のウィンドウ要求まで何も開かず、
    /// 常駐を外して起動すると、最後のウィンドウを閉じたときに常駐が終わってしまう
    /// (ログオン時の起動からの常駐が、更新を境に途切れていた)。
    /// </summary>
    internal const string StayResidentArg = "--stay-resident";

    /// <summary>
    /// 新しいPaneへ渡す起動引数。
    /// </summary>
    /// <param name="processId">古い側(自分)のPID。新しい側はこれが終わるのを待つ。</param>
    /// <param name="stayResident">古い側が常駐していたか。</param>
    /// <param name="openWindows">新しい側で起動時のウィンドウを開くか(開き直す資料がある・
    /// 利用者が「更新する」を押した)。常駐していなければ常に開くので見ない。</param>
    internal static string BuildArguments(int processId, bool stayResident, bool openWindows)
    {
        string arguments = $"{AfterUpdateArg} {processId}";
        if (!stayResident) return arguments;
        return $"{arguments} {(openWindows ? StayResidentArg : PreloadArg)}";
    }

    /// <summary>
    /// 再起動のあとに開き直すファイルの一覧。開いていたもの、更新の途中で開くよう頼まれたもの、の順。
    /// 空や重複(大文字小文字の違いだけのものを含む)は除く。
    /// </summary>
    internal static List<string> CollectReopenPaths(IEnumerable<string?> openPaths, IEnumerable<string?> requestedDuringUpdate)
    {
        var result = new List<string>();
        var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (string? path in openPaths.Concat(requestedDuringUpdate))
        {
            if (string.IsNullOrWhiteSpace(path)) continue;
            if (seen.Add(path)) result.Add(path);
        }
        return result;
    }

    /// <summary>
    /// 起動時に、更新の前に控えた一覧から開くものを決める。
    /// 控えが無ければnull(通常の起動手順に任せる)。控えがあれば、まだ存在するものだけを返す。
    /// 空の一覧が返ったときは、通常の起動手順(前回のセッションの復元など)には進まず、
    /// 空の文書を1枚開く。更新の直前に開いていなかったものを持ち出さないため。
    /// </summary>
    internal static List<string>? DecideReopenOnStartup(IReadOnlyList<string>? record, Func<string, bool> fileExists)
    {
        if (record is null) return null;
        return record.Where(p => !string.IsNullOrWhiteSpace(p) && fileExists(p)).ToList();
    }

    /// <summary>自動の入れ替え(U-10)をどうするか。</summary>
    internal enum AutoApplyDecision
    {
        /// <summary>入れ替えない(設定がオフ、または用意ができていない)。</summary>
        None,
        /// <summary>今は入れ替えない。条件がそろったら改めて判断する。</summary>
        Wait,
        /// <summary>入れ替える。</summary>
        Apply,
    }

    /// <summary>
    /// 自動の入れ替えを今始めてよいか。
    /// </summary>
    /// <param name="autoUpdateEnabled">設定「新しい版を自動で入れる」。</param>
    /// <param name="prepared">新しい版のダウンロードと照合が済んでいるか。</param>
    /// <param name="documentWindowCount">開いている本体のウィンドウの数。</param>
    /// <param name="auxiliaryWindowShown">設定・取扱説明書・カスタムCSSの作成補助のどれかが見えているか。
    /// 入れ替えるとこれらも閉じるため、見えている間は待つ(作成補助は保存していない変更を持ちうる)。</param>
    /// <param name="applyInProgress">「更新する」や配布物の修復が進んでいるか。</param>
    internal static AutoApplyDecision DecideAutoApply(
        bool autoUpdateEnabled, bool prepared, int documentWindowCount, bool auxiliaryWindowShown, bool applyInProgress)
    {
        if (!autoUpdateEnabled || !prepared) return AutoApplyDecision.None;
        if (documentWindowCount > 0 || auxiliaryWindowShown || applyInProgress) return AutoApplyDecision.Wait;
        return AutoApplyDecision.Apply;
    }

    /// <summary>
    /// 自動の入れ替えのあと、新しいPaneを起動するか。起動しなければ、そのまま終了する
    /// (次に利用者が起動したときには新しい版になっている)。
    /// 常駐していたなら常駐を続けるために起動する。入れ替えの途中に開くよう頼まれていたら、
    /// それを開くために起動する(頼んだ側のプロセスはもう終わっているので、捨てると開かれない)。
    /// </summary>
    internal static bool ShouldStartAfterAutoApply(bool stayResident, int requestsDuringUpdate)
        => stayResident || requestsDuringUpdate > 0;

    /// <summary>
    /// 自動で入れ替えたことを知らせるか。控えた版より手元の版が古ければ、入れ替えが
    /// 元に戻されたなどで実際には上がっていないので知らせない。
    /// </summary>
    internal static bool ShouldAnnounceAutoUpdate(string? updatedTag, string currentVersion)
    {
        if (string.IsNullOrWhiteSpace(updatedTag)) return false;
        return UpdateCheckLogic.IsNewerThanCurrent(updatedTag, currentVersion) == false;
    }
}
