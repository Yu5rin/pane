namespace Pane;

/// <summary>
/// ウィンドウが開いている(これから開く)ファイルの一覧。同じファイルを2つのウィンドウで
/// 開かないための判定(<see cref="PaneApplicationContext.OpenWindow"/>)に使う。
///
/// 【実機で起きたこと】2026-10-22 のログで、1つのファイルをほぼ同時に2回開く要求が来て
/// (Pane.exe が同じ引数で2つ起動し、片方が常駐プロセスへ渡した)、同じファイルのウィンドウが
/// 2枚開いた。重複の判定は「ウィンドウが今開いているファイル」を見ていたが、ウィンドウを
/// 作ってから実際にファイルを読み込むまで(画面の準備が済むまで)の約1.6秒は、その一覧が空のままだった。
/// その間に届いた2回目の要求は「まだ誰も開いていない」とみなされ、新しいウィンドウになった。
/// これから開く予定のファイルも一覧に含めて、その間の要求も既存のウィンドウへ寄せる。
///
/// 通信・ファイルに触れない判定だけをここへ切り出し、Pane.Tests側で固定する。
/// </summary>
internal static class OpenPathsLogic
{
    /// <param name="tabPaths">タブ形式のときの各タブのファイル(無題はnull)。ウィンドウ形式なら空。</param>
    /// <param name="currentPath">ウィンドウ形式で今開いているファイル。</param>
    /// <param name="pendingInitialPath">まだ読み込んでいない、起動時に開く予定のファイル。読み込んだらnull。</param>
    internal static IReadOnlyList<string> Collect(
        IReadOnlyList<string?> tabPaths, string? currentPath, string? pendingInitialPath)
    {
        var result = new List<string>();
        if (tabPaths.Count > 0) result.AddRange(tabPaths.Where(p => p is not null).Select(p => p!));
        else if (currentPath is not null) result.Add(currentPath);
        if (pendingInitialPath is not null
            && !result.Any(p => string.Equals(p, pendingInitialPath, StringComparison.OrdinalIgnoreCase)))
        {
            result.Add(pendingInitialPath);
        }
        return result;
    }
}
