using Microsoft.Web.WebView2.Core;

namespace Pane;

/// <summary>
/// 外部リンク(「新しいウィンドウを開く」要求)の共通処理。
///
/// Paneが持つWebView2は3つ(<see cref="MainForm"/>・<see cref="SettingsWindow"/>・
/// <see cref="HelpWindow"/>)あり、いずれもCoreWebView2.NewWindowRequestedに対して
/// まったく同じ挙動を取る必要があるため、その中身をこのクラス1か所に集約する
/// (3ウィンドウへ同じコードを書き写さない。片方だけ直し忘れる事故を防ぐ)。
///
/// 実機で確認された不具合の修正: NewWindowRequestedを購読していなかったため、本文中の
/// 外部リンクをクリックすると既定ブラウザではなくPane内に制御不能なWebView2ポップアップ
/// ウィンドウが開いていた。公式ドキュメントにも「If this is false and no NewWindow is set,
/// the WebView opens a popup window ... there is no avenue to control the popup window from
/// the app」と明記されている。そのポップアップは別のCoreWebView2なので、各ウィンドウが
/// 設定しているAreDefaultContextMenusEnabled=falseもAreBrowserAcceleratorKeysEnabled=falseも
/// 一切効かず、docs/コンテキストメニュー仕様.md 第0章「ブラウザの既定コンテキストメニューは
/// 一切表示しない」がその窓の中で完全に破れる。
/// </summary>
internal static class ExternalLinkService
{
    /// <summary>
    /// NewWindowRequestedの共通ハンドラ。例外なく<c>e.Handled = true</c>にしてWebView2に
    /// ポップアップを開かせず、開いてよいURLだけをOSの既定ブラウザへ委譲する
    /// (取扱説明書ウィンドウが"open-in-default-app"で行っているのと同じ
    /// <see cref="FolderService.OpenInDefaultApp"/>を使う)。
    ///
    /// URLスキームの検証について: JS側(src/editor.js)はhtml-sanitize.jsのisSafeUrl()を通してから
    /// window.openしているが、このイベントはiframe内のリンクやHTMLのtarget="_blank"、リンクの
    /// 中クリック・Ctrl+クリックのように、JS側を一切経由しない経路でも発火するため、C#側でも
    /// 独立に検証する(<see cref="IsExternalBrowserSafeUri"/>)。委譲先のOpenInDefaultAppは
    /// Process.Start+UseShellExecute=trueであり、file:や任意のカスタムスキームをそのまま渡すと、
    /// 開いているMarkdown(第三者から受け取ったものでありうる)にローカルファイルや任意の
    /// プロトコルハンドラを起動させる余地を与えてしまう。よってhttp/https以外は開かずログだけ残す。
    ///
    /// e.IsUserInitiated(ユーザー操作起因かどうか)は、ログに記録するだけで開く/開かないの判定には
    /// 使わない。理由は2つ: (1) Paneの正規経路はJS側の確認ダイアログ(confirmOpenExternal)の
    /// 「開く」クリック/Enter内から同期的にwindow.openを呼ぶためtrueになるはずだが、Chromiumの
    /// ユーザーアクティベーション判定の細部に依存して「外部リンクが開かなくなる」回帰を起こすと、
    /// 実機で確認済みのこの不具合の修正目的そのものを損なう。(2) ブロックで得られる利益が小さい——
    /// 本文のHTMLはサニタイズ済みで&lt;script&gt;が残らず、iframeは常にsandbox=""(allow-popups無し・
    /// allow-scripts無し)で埋め込むため、スクリプトが勝手にポップアップを開く経路が事実上存在しない。
    /// ログには残すので、実機で想定外の自動ポップアップが観測されたら判断を見直せる。
    /// </summary>
    /// <param name="e">NewWindowRequestedのイベント引数。</param>
    /// <param name="logPrefix">ログ行の接頭辞。どのウィンドウからの要求かを判別できるようにする。
    /// 既存のログ書式に合わせ、サブウィンドウは"[設定ウィンドウ] "・"[取扱説明書ウィンドウ] "を渡し、
    /// 本体ウィンドウ(MainForm)は接頭辞なし("")を渡す(MainFormのログは元から接頭辞を持たない)。</param>
    internal static void HandleNewWindowRequested(CoreWebView2NewWindowRequestedEventArgs e, string logPrefix)
    {
        // 先に必ずHandledを立てる(この後URLを弾く場合も、WebView2にポップアップを開かせない)。
        e.Handled = true;

        string uri = e.Uri ?? "";
        Logger.Write($"{logPrefix}new-window-requested: uri={uri}, isUserInitiated={e.IsUserInitiated}");

        if (!IsExternalBrowserSafeUri(uri))
        {
            Logger.Write($"{logPrefix}new-window-requested: http/https以外のため開かなかった: {uri}");
            return;
        }

        FolderService.OpenInDefaultApp(uri);
    }

    /// <summary>
    /// 既定ブラウザへ渡してよいURLか(http/httpsのみ許可)。file:・javascript:・data:・
    /// mailto:やカスタムスキームはすべて拒否する。
    /// <see cref="HandleNewWindowRequested"/>のコメントに書いた理由により、JS側のisSafeUrl()とは
    /// 独立にC#側でも検証する。
    /// </summary>
    internal static bool IsExternalBrowserSafeUri(string uri)
    {
        if (string.IsNullOrWhiteSpace(uri)) return false;
        if (!Uri.TryCreate(uri, UriKind.Absolute, out Uri? parsed)) return false;
        // Uri.Schemeは小文字へ正規化済みのため、"HTTPS:"のような表記でも一致する。
        return parsed.Scheme == Uri.UriSchemeHttp || parsed.Scheme == Uri.UriSchemeHttps;
    }
}
