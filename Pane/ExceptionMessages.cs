namespace Pane;

/// <summary>
/// 例外を、利用者にそのまま見せてよい日本語の短い説明へ言い換える。
///
/// 【なぜ独立したクラスにしたか】
/// 総点検(docs/調査記録/点検-見た目とUI.md 指摘16)で、エラーダイアログ・サイドバー・設定画面などに
/// <c>ex.Message</c>(「Access to the path 'C:\Users\...' is denied.」のような英語の
/// .NETの例外メッセージで、絶対パスやHTTPのステータスコードを含むことがある)や
/// <c>ex.GetType().Name</c>(「HttpRequestException」のような型名そのもの)が
/// そのまま出ていることが分かった。利用者はそれを見ても次に何をすればいいか分からない。
///
/// 例外の型ごとに「見つからない／使用中／権限が無い／通信できない」といった
/// 言い換えをここへ集約する(呼び出し側で文言を書くたびに表現がばらつくのを防ぐ)。
/// 通信・ファイルには一切触れない純粋な分岐なので、Pane.Testsへソースごと取り込んで固定できる。
///
/// 【Pane自身が投げた、既に日本語のメッセージは素通しする】
/// 一部の例外(PandocのCLI呼び出し失敗時の`InvalidOperationException`、
/// TextFileServiceの保存失敗時の`IOException`等)は、Pane自身が最初から利用者向けの
/// 日本語メッセージを添えて投げている(例:「Pandocの変換に失敗しました。」)。
/// これを型だけで判定して汎用文言に上書きすると、せっかくの具体的な説明が失われて
/// 逆に不親切になる。そこで、メッセージがひらがな・カタカナを含む(=Paneが日本語で
/// 書いたと分かる)場合はそのまま返す。.NETやサードパーティ(Pandoc等)が返す生の
/// メッセージは通常英語のため、この判定で機械的に区別できる。
///
/// 詳細な調査に必要な型名・メッセージ・スタックトレースは、これとは別に
/// <see cref="Logger.WriteException"/>がログへ残すため、ここで言い換えても失われない。
/// 呼び出し側は「Describeで利用者向けの文言を作る」と「Logger.WriteExceptionでログに
/// 残す」の両方を必ず行うこと(片方だけでは、利用者に伝わらないか調査ができないかになる)。
/// </summary>
internal static class ExceptionMessages
{
    /// <summary>
    /// 例外から、利用者に見せる短い言い換えを返す(句点で終わる1文)。
    /// Pane自身が日本語メッセージ付きで投げた例外(ひらがな・カタカナを含む)はそのまま
    /// 通し、それ以外(.NET・サードパーティの生の英語メッセージや型名)は型に応じた
    /// 汎用文言へ言い換える。
    /// </summary>
    internal static string Describe(Exception ex)
    {
        if (ContainsKana(ex.Message)) return ex.Message;
        return DescribeByType(ex);
    }

    private static bool ContainsKana(string text)
    {
        foreach (char c in text)
        {
            // ひらがな(U+3040-U+309F)・カタカナ(U+30A0-U+30FF)。
            // 漢字だけの判定にしないのは、英語の技術用語(製品名・識別子等)に漢字が
            // 混ざることは無いが、ラテン文字の中に漢字由来の記号が紛れる可能性を避けるため。
            if (c is >= '぀' and <= 'ヿ') return true;
        }
        return false;
    }

    private static string DescribeByType(Exception ex) => ex switch
    {
        // 見つからない
        FileNotFoundException or DirectoryNotFoundException => "指定したファイルまたはフォルダが見つかりませんでした。",
        // 権限が無い
        UnauthorizedAccessException => "アクセスする権限がありません。管理者として実行するか、保存先を変えてお試しください。",
        System.Security.SecurityException => "アクセスする権限がありません。",
        // パスが長すぎる(IOExceptionのサブクラスなので、下の汎用IOExceptionより先に判定する)
        PathTooLongException => "ファイルパスが長すぎます。保存先を変えるか、名前を短くしてお試しください。",
        // 使用中・書き込めない(共有違反、ディスク容量不足等をまとめて扱う)
        IOException => "ファイルが他のプログラムで使用中か、書き込みできない状態です。",
        // 通信できない
        System.Net.Http.HttpRequestException => "通信できませんでした。ネットワークの状態を確認してください。",
        TaskCanceledException or OperationCanceledException => "処理が時間内に終わりませんでした。ネットワークの状態を確認するか、しばらくしてからもう一度お試しください。",
        // それ以外(型名は出さない。詳細はログを参照)
        _ => "予期しない問題が発生しました。",
    };
}
