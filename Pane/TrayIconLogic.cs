namespace Pane;

/// <summary>
/// 通知領域(タスクバーの右端、時計の横)のPaneのアイコンにまつわる判断(仕様書 T-01〜T-04)。
///
/// 【なぜ置くのか】(2026-11-15、利用者の要望)
/// Paneは最後のウィンドウを閉じても常駐する(設定の既定。B-1)。常駐中はウィンドウが1枚も無く、
/// タスクバーにも何も出ないので、動いているのかどうかが見えず、終わらせる手段も無かった。
/// 動いている間はずっと通知領域にアイコンを出し、そこから新しい文書・ファイル・設定を開けて、
/// 終了もできるようにする。
///
/// 通信・ファイル・画面に触れない判断だけをここへ切り出し、Pane.Tests側で固定する。
/// </summary>
internal static class TrayIconLogic
{
    /// <summary>アイコンを左クリックしたときにすること(T-02)。</summary>
    internal enum LeftClickAction
    {
        /// <summary>開いているウィンドウをすべて前面に出す。</summary>
        BringWindowsToFront,
        /// <summary>新しい文書のウィンドウを開く。</summary>
        NewDocument,
    }

    /// <summary>
    /// 左クリック: ウィンドウがあれば前面に出し、1枚も無ければ(常駐中)新しい文書を開く。
    /// 利用者が選んだ動き(2026-11-15)。常駐中に押して何も起きないと、壊れているように見える。
    /// </summary>
    internal static LeftClickAction DecideLeftClick(int documentWindowCount)
        => documentWindowCount > 0 ? LeftClickAction.BringWindowsToFront : LeftClickAction.NewDocument;

    /// <summary>
    /// 最後のウィンドウが閉じられたとき、常駐を続けるか。
    /// 右クリックの「Paneを終了」で閉じた場合は、常駐の設定にかかわらず終わる(T-04)。
    /// 以前は常駐を終わらせる手段が無く、タスクマネージャーで止めるしかなかった。
    /// </summary>
    /// <param name="stayResident">ログオン時の起動(--preload)や、常駐していたPaneの更新後の後継か。</param>
    /// <param name="quitOnLastWindowClosed">設定「最後のウィンドウを閉じても常駐させる」の裏返し。</param>
    /// <param name="quitRequested">「Paneを終了」が選ばれたか。</param>
    internal static bool ShouldStayResident(bool stayResident, bool quitOnLastWindowClosed, bool quitRequested)
        => !quitRequested && (stayResident || !quitOnLastWindowClosed);

    /// <summary>右クリックの「最近使ったファイル」に並べる件数の上限。</summary>
    internal const int MaxRecentFiles = 10;

    /// <summary>
    /// 右クリックの「最近使ったファイル」に並べるパス。新しい順のまま、空と重複
    /// (大文字小文字の違いだけのものを含む)を除き、上限まで。
    /// </summary>
    internal static List<string> RecentFileEntries(IEnumerable<string?> recentFiles)
    {
        var result = new List<string>();
        var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (string? path in recentFiles)
        {
            if (string.IsNullOrWhiteSpace(path) || !seen.Add(path)) continue;
            result.Add(path);
            if (result.Count >= MaxRecentFiles) break;
        }
        return result;
    }

    /// <summary>メニューの1項目に出せる文字数の上限。ウィンドウの題名が長いと、メニューが画面の幅を超える。</summary>
    internal const int MaxWindowLabelLength = 60;

    /// <summary>
    /// 右クリックの「開いているウィンドウ」に出す名前。題名(ファイル名 - Pane)をそのまま使い、
    /// 長すぎるものは末尾を「…」で切る。題名が空なら「無題」。
    /// メニューの「&amp;」は次の文字に下線を付ける印として読まれるので、「&amp;&amp;」にして文字のまま出す。
    /// </summary>
    internal static string WindowLabel(string? title)
    {
        string label = string.IsNullOrWhiteSpace(title) ? "無題" : title.Trim();
        if (label.Length > MaxWindowLabelLength) label = label[..(MaxWindowLabelLength - 1)] + "…";
        return label.Replace("&", "&&");
    }

    /// <summary>
    /// アイコンに乗せたときに出す説明。Windowsの制限で63文字まで。
    /// 常駐中(ウィンドウ0枚)なのか、何枚開いているのかが分かるようにする。
    /// </summary>
    internal static string Tooltip(int documentWindowCount)
    {
        string text = documentWindowCount == 0
            ? "Pane(待機中。クリックで新しい文書を開きます)"
            : $"Pane({documentWindowCount}個のウィンドウ)";
        return text.Length <= 63 ? text : text[..63];
    }
}
