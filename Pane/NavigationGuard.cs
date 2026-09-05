namespace Pane;

/// <summary>
/// WebView2のトップレベル遷移(<c>CoreWebView2.NavigationStarting</c>)を許可してよいかどうかの判定
/// (docs/調査記録/点検-セキュリティ.md C-4「NavigationStartingを購読していない」への対応)。
///
/// 【なぜ要るか】本体・設定・取扱説明書の3ウィンドウは、起動時に一度だけ自分のvirtual host
/// (<c>https://pane.local/…</c>、<see cref="MainForm"/>等のVirtualHostName)へ<c>Navigate</c>し、
/// 以降は同一ページ内のSPAとして完結する設計になっている。本文中の外部リンクは
/// <see cref="ExternalLinkService"/>(NewWindowRequested)に集約し、editor.jsも
/// <c>window.open(_blank)</c>に寄せ、生HTMLの<c>&lt;a&gt;</c>はhtml-sanitize.jsが
/// <c>target="_blank"</c>を強制し、iframeは<c>sandbox=""</c>でトップレベル遷移を起こせない
/// ため、点検の時点では「同一タブでの外部遷移が起きる経路は見つからなかった」
/// (docs/調査記録/点検-セキュリティ.md C-4)。しかしそれは現状のJS実装を読んだ結果であって、
/// <c>NavigationStarting</c>そのものを止める保険は1行も無かった。将来editor.js等の
/// 実装変更で<c>location.href</c>への代入のような経路が紛れ込んでも、ここで必ず食い止める
/// ための最後の防波堤として追加する。
///
/// WebView2の型(NavigationStartingEventArgs等)に一切依存させない。Uri文字列と許可ホスト名
/// だけを受け取る純粋な判定にすることで、Pane.Tests(net8.0、Windows非依存)へソースごと
/// 取り込んでテストで固定できる(ExternalToolLocator/PrivacyLogFormatterと同じ流儀)。
/// </summary>
internal static class NavigationGuard
{
    /// <summary>
    /// トップレベル遷移として許可してよいか。許可するのは、自分のvirtual host
    /// (<c>https://&lt;allowedHost&gt;/…</c>)への遷移だけ。about:blankや
    /// アプリ内で使わない他のスキーム・ホストはすべて拒否する。
    /// </summary>
    /// <param name="uri">NavigationStartingEventArgs.Uri相当の遷移先URL。</param>
    /// <param name="allowedHost">そのウィンドウのvirtual host名(例: "pane.local")。</param>
    internal static bool IsAllowedTopLevelNavigation(string? uri, string? allowedHost)
    {
        if (string.IsNullOrWhiteSpace(uri) || string.IsNullOrWhiteSpace(allowedHost)) return false;
        if (!Uri.TryCreate(uri, UriKind.Absolute, out Uri? parsed)) return false;
        // Uri.Schemeは小文字へ正規化済みのため"HTTPS:"表記でも一致する。ホスト名の比較は
        // 大文字小文字を無視する(DNSホスト名の一致に大文字小文字は関係しないため)。
        return parsed.Scheme == Uri.UriSchemeHttps
            && string.Equals(parsed.Host, allowedHost, StringComparison.OrdinalIgnoreCase);
    }
}
