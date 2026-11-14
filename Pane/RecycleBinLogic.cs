namespace Pane;

/// <summary>
/// 「ごみ箱へ移動」が、本当にごみ箱へ入る場所かどうかの判断(仕様書 4.2)。
///
/// Windowsのごみ箱は、内蔵のドライブにしか無い。ネットワークドライブ・共有フォルダ(\\server\share)・
/// USBメモリのファイルを「ごみ箱へ送る」と、Windowsは黙ってその場で完全に削除する。
/// 以前はどこでも「ごみ箱へ移動しますか?」とだけ尋ねていたので、利用者は元に戻せるつもりで
/// 押し、戻せないことにあとから気づく(2026-11 の点検)。
/// ごみ箱が無い場所では、完全に削除されることを伝えて、もう一度確かめる。
///
/// ファイルに触れない判定だけをここへ切り出し、Pane.Tests側で固定する。
/// </summary>
internal static class RecycleBinLogic
{
    /// <summary>
    /// その場所にごみ箱があると見てよいか。
    /// </summary>
    /// <param name="fullPath">削除する対象の絶対パス。</param>
    /// <param name="isFixedDrive">そのドライブが内蔵の(取り外さない)ドライブか。
    /// ドライブ文字が無い・調べられないときは false を渡す。</param>
    internal static bool HasRecycleBin(string? fullPath, bool isFixedDrive)
    {
        if (string.IsNullOrWhiteSpace(fullPath)) return false;
        string p = fullPath.Replace('/', '\\');
        // \\server\share\... はドライブ文字が無く、ごみ箱も無い。
        if (p.StartsWith(@"\\", StringComparison.Ordinal)) return false;
        return isFixedDrive;
    }
}
