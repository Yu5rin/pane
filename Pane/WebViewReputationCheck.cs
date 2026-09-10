using System;
using Microsoft.Web.WebView2.Core;

namespace Pane;

/// <summary>
/// WebView2のSmartScreen(URLの評判チェック)を止める。
///
/// 【なぜ止めるか】
/// 会社のPCで、ウィンドウを開くたびに毎回きっかり2秒待たされていた。DevToolsの
/// トレース(2026-09-10, 会社実機)を読むと、原因はPaneでもJSでもファイル読み取りでも
/// なかった。
///
///   4.8ms    NavigationRequest::WillProcessResponse 開始
///   5.0ms    SmartScreenNavThrottle が保留を返す      ← ここで審査の列が止まる
///   2005.6ms Resume。残りのスロットルが動きだす
///   2094ms   DOMContentLoaded
///
/// ナビゲーションの審査は列になっていて、SmartScreenがそこで「保留」を返したまま
/// 2秒戻ってこない。その間CPUは完全にアイドル(15.5秒の記録でScripting 75ms)で、
/// ファイルの取得は16件すべて合計3ms、index.htmlに至ってはStalled 1.71msで
/// 取れている。ただ待っているだけだった。
///
/// SmartScreenは「このURLは安全か」をマイクロソフトのサーバーへ問い合わせる。
/// 会社のネットワークからはそこへ届かず、毎回タイムアウトの2秒を使い切っていた
/// (届かないので結果もキャッシュされず、何度起動しても毎回2秒)。自宅では即答が
/// 返るため一度も表面化しなかった。
///
/// Paneのウィンドウが読むのは https://pane.local/ ただ1つ、中身は自分のPCの
/// distフォルダである(MainForm.SetVirtualHostNameToFolderMapping)。外部サイトは
/// WebView2では開かず、OSの既定ブラウザへ渡している(ExternalLinkService)。
/// 評判を問い合わせる相手がそもそもいないので、切っても守られる範囲は変わらない。
///
/// 【なぜ3つのウィンドウすべてで呼ぶ必要があるか】
/// 公式ドキュメントより:
///   "SmartScreen is enabled or disabled for all CoreWebView2s using the same user
///    data folder. If IsReputationCheckingRequired is true for any CoreWebView2
///    using the same user data folder, then SmartScreen is enabled."
///   "If the newly created CoreWebview2 does not set SmartScreen to false, when
///    navigating ... the default value will be applied to all CoreWebview2 using
///    the same user data folder."
///
/// つまり1つでも設定を漏らすと、そのウィンドウが動き出した時点で全体が有効に戻る。
/// PaneのWebView2は MainForm・SettingsWindow・HelpWindow の3つあり、**3つとも**
/// 呼ばなければ意味がない。呼び忘れを機械的に見つけられるよう、
/// Pane.Tests/WebViewReputationCheckTests.cs がソースを走査して
/// 「EnsureCoreWebView2Asyncを呼ぶファイルは、必ずこのクラスも呼ぶ」ことを確かめている
/// (docs/調査記録/README.md の「繰り返し出てきた誤り」8番と同じ形の抜けを防ぐため)。
/// </summary>
internal static class WebViewReputationCheck
{
    /// <summary>
    /// 評判チェックを止める。古いWebView2ランタイムにはこのプロパティが無いことが
    /// あるため、失敗しても起動は続ける(その環境では従来どおり有効なまま動く)。
    /// 効いたかどうかを実機のログで確かめられるように、結果は必ず記録する。
    /// </summary>
    /// <param name="core">対象のCoreWebView2。</param>
    /// <param name="windowName">ログに出す呼び出し元の名前(「本文」「設定」など)。</param>
    public static void Disable(CoreWebView2 core, string windowName)
    {
        try
        {
            core.Settings.IsReputationCheckingRequired = false;
            Logger.Write($"WebView2: 評判チェック(SmartScreen)を止めた({windowName})");
        }
        catch (Exception ex)
        {
            // NotImplementedException(古いランタイム)を想定しているが、種類を問わず
            // 起動を止めない。ここで失敗しても、遅くなるだけで動作はする。
            Logger.Warn($"WebView2: 評判チェックを止められなかった({windowName}): {ExceptionDetail.Summarize(ex)}");
        }
    }
}
