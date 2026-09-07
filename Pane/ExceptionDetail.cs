using System.Text;

namespace Pane;

/// <summary>
/// 例外をログ1件ぶんの文字列に整える。
///
/// 【なぜ必要か】
/// 以前の<see cref="Logger.WriteException"/>は、いちばん外側の例外の型名・メッセージ・
/// スタックだけを出していた。ところがネットワーク周りの失敗は、本当の理由が
/// InnerExceptionに入っている。
///
///   HttpRequestException「送信できませんでした」
///     └ SocketException「接続が拒否されました」          ← プロキシ/ファイアウォール
///   HttpRequestException「SSL接続を確立できませんでした」
///     └ AuthenticationException「リモート証明書が無効」  ← 会社のSSL検査
///       └ Win32Exception「信頼されないルート証明書」
///
/// 外側だけでは「HttpRequestException」としか分からず、切り分けに使えない。
/// 実際、会社のPCで更新のダウンロードだけが失敗する件を調べようとして、
/// 今のログでは理由が分からないことに気づいた
/// (docs/調査記録/修正-更新の失敗を追えるようにする.md)。
///
/// 通信・ファイル・時刻に触れない整形だけをここへ切り出し、Pane.Tests側で固定する。
/// </summary>
internal static class ExceptionDetail
{
    /// <summary>入れ子をたどる上限。循環参照(自分自身をInnerExceptionに持つ等)で
    /// 無限に回らないための歯止め。</summary>
    internal const int MaxDepth = 8;

    /// <summary>
    /// 例外を「型名: メッセージ」の連鎖として1行にまとめる。内部例外は " ← " でつなぐ。
    /// AggregateExceptionは中身をすべて並べる(Taskの失敗はこの形で来ることがある)。
    /// </summary>
    internal static string Summarize(Exception? ex)
    {
        if (ex is null) return "(例外なし)";
        var sb = new StringBuilder();
        Append(sb, ex, 0);
        return sb.ToString();
    }

    private static void Append(StringBuilder sb, Exception ex, int depth)
    {
        if (depth >= MaxDepth)
        {
            sb.Append(" ← (これ以上は省略)");
            return;
        }
        if (depth > 0) sb.Append(" ← ");
        sb.Append(ex.GetType().Name).Append(": ").Append(ex.Message);

        // HttpRequestExceptionは応答のステータスコードを持っていることがある。
        // 403(拒否)・407(プロキシ認証)・404(見つからない)の区別は切り分けに直結する。
        if (ex is HttpRequestException http && http.StatusCode is System.Net.HttpStatusCode code)
        {
            sb.Append(" [HTTP ").Append((int)code).Append(' ').Append(code).Append(']');
        }

        if (ex is AggregateException aggregate)
        {
            foreach (Exception inner in aggregate.InnerExceptions)
            {
                Append(sb, inner, depth + 1);
            }
            return;
        }
        if (ex.InnerException is Exception next) Append(sb, next, depth + 1);
    }
}
