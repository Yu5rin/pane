namespace Pane;

/// <summary>
/// 既定(Info)のログに絶対パスやURLをそのまま書かず、個人・所属を推測できる部分
/// (ユーザー名を含むディレクトリ階層、URLのクエリ文字列)を落とした短い形へ整形する。
///
/// 【なぜ必要か】
/// 総点検(docs/調査記録/点検-セキュリティ.md B「ログに文書の絶対パスが大量に出る」
/// 「文書中のリンク先URLがログに残る」)で、既定(Info)のログに
/// <c>C:\Users\&lt;本名や社員番号&gt;\...</c> 形式の文書の絶対パスや、クリックした外部リンクの
/// URL(クエリ文字列にトークンが入ることもある社内URL等)がそのまま平文で大量に残ることが
/// 分かった。Paneはログ(%LOCALAPPDATA%\Pane\logs)を利用者が開発者へ送る運用があり
/// (実際に3日分が共有された実績がある)、この形では利用者名・所属・文書名(プロジェクト名・
/// 顧客名等)が意図せず第三者に渡ってしまう。
///
/// 一方で、不具合調査には完全なパスが要る場面もあるため「全部消す」のは正解ではない
/// (docs/調査記録/点検-セキュリティ.md の指摘どおり)。そこで既定(Info)は短い形にし、詳細ログ
/// (Logger.Debug。設定「詳細ログを記録する」または環境変数PANE_LOG_LEVEL=debugで有効)
/// では完全な形をあわせて書く、という使い分けを選んだ(呼び出し側でLogger.Write→短い形、
/// Logger.Debug→完全な形、の2行を書く形にしている)。
///
/// 【対象外にしたもの】
/// 失敗時のLogger.WriteException(Errorレベル)はこの整形の対象にしていない。Errorは
/// 頻度が低く「大量に出る」問題には当たらず、失敗の原因調査にはむしろ完全なパスが
/// 要る場面が多いため、そのまま残す。
/// </summary>
internal static class PrivacyLogFormatter
{
    /// <summary>Windowsのパス区切り文字("\")と、まれにPane内部で使われる"/"の両方を
    /// 区切りとみなす。<see cref="System.IO.Path.GetFileName(string?)"/>を使わない理由は、
    /// それがOSごとに扱う区切り文字を変える(LinuxではWindowsパスの"\"を区切りと見ず、
    /// 分割できない)ため。Paneは常にWindowsパスだけを扱うが、この判定自体はPane.Tests
    /// (CIではLinux上でも実行される)で固定するため、区切り文字を自前で判定する。</summary>
    private static readonly char[] PathSeparators = { '\\', '/' };

    /// <summary>
    /// 既定ログ用にファイルパス(またはフォルダパス)を短くする。ディレクトリ部分
    /// (ユーザー名を含む)を落とし、末尾の要素(ファイル名、またはフォルダ名)だけを返す。
    /// null・空文字列はそのまま返す。
    /// </summary>
    internal static string ShortenPath(string? path)
    {
        if (string.IsNullOrEmpty(path)) return path ?? "";

        int lastSeparator = path.LastIndexOfAny(PathSeparators);
        string name = lastSeparator >= 0 ? path[(lastSeparator + 1)..] : path;

        // ドライブのルート("C:\"等、末尾が区切り文字そのものの形)は末尾要素が空文字列に
        // なる。この形はユーザー名等の個人情報を含まないため、隠す理由が無くそのまま返す。
        return name.Length > 0 ? name : path;
    }

    /// <summary>
    /// 既定ログ用にURLを短くする。スキームとホスト(+ポート)だけを残し、パス・
    /// クエリ文字列(トークンを含みうる)・フラグメントは落とす。絶対URLとして解析できない
    /// 文字列はそのまま返す(整形できないだけで、情報は増やさない)。
    /// </summary>
    internal static string ShortenUri(string? uri)
    {
        if (string.IsNullOrEmpty(uri)) return uri ?? "";
        if (!Uri.TryCreate(uri, UriKind.Absolute, out Uri? parsed)) return uri;
        return $"{parsed.Scheme}://{parsed.Authority}";
    }

    /// <summary>
    /// <see cref="FolderService.OpenInDefaultApp"/>のように、ファイルパスとURLの両方を
    /// 引数に取りうる箇所向け。http/https の絶対URLとして解釈できれば<see cref="ShortenUri"/>、
    /// それ以外はファイルパスとみなして<see cref="ShortenPath"/>を適用する。
    /// </summary>
    internal static string ShortenPathOrUri(string? value)
    {
        if (string.IsNullOrEmpty(value)) return value ?? "";
        if (Uri.TryCreate(value, UriKind.Absolute, out Uri? parsed) &&
            (parsed.Scheme == Uri.UriSchemeHttp || parsed.Scheme == Uri.UriSchemeHttps))
        {
            return ShortenUri(value);
        }
        return ShortenPath(value);
    }
}
