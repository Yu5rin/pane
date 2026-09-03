namespace Pane.Tests;

/// <summary>
/// ログに文書の絶対パスやリンク先URLが大量に平文で残っていた不具合
/// (.review-security.md B、<see cref="PrivacyLogFormatter"/>)の修正を固定するテスト。
///
/// Paneのログ(%LOCALAPPDATA%\Pane\logs)は利用者が開発者へ送る運用があり、既定(Info)の
/// ログに Windows のユーザーフォルダ(C:\Users\本名\...)や外部リンクのクエリ文字列
/// (トークンを含みうる)がそのまま残ると、利用者名・所属・文書名・第三者のURLが
/// 意図せず渡ってしまう。この一線(既定は短く)を崩すと元の不具合に戻る。
/// </summary>
public class PrivacyLogFormatterTests
{
    [Fact]
    public void Windowsのフルパスからファイル名だけを残す()
    {
        Assert.Equal("報告書.md", PrivacyLogFormatter.ShortenPath(@"C:\Users\山田太郎\Documents\顧客A案件\報告書.md"));
    }

    [Fact]
    public void フォルダパスは末尾のフォルダ名だけを残す()
    {
        Assert.Equal("顧客A案件", PrivacyLogFormatter.ShortenPath(@"C:\Users\山田太郎\Documents\顧客A案件"));
    }

    [Fact]
    public void null_空文字はそのまま返す()
    {
        Assert.Equal("", PrivacyLogFormatter.ShortenPath(null));
        Assert.Equal("", PrivacyLogFormatter.ShortenPath(""));
    }

    [Fact]
    public void ドライブのルートは短くする理由が無いのでそのまま返す()
    {
        // "C:\"はユーザー名等の個人情報を含まないため、隠す理由が無い。
        Assert.Equal(@"C:\", PrivacyLogFormatter.ShortenPath(@"C:\"));
    }

    [Fact]
    public void URLはスキームとホストだけを残しクエリ文字列を落とす()
    {
        Assert.Equal("https://example.com", PrivacyLogFormatter.ShortenUri("https://example.com/report?token=abc123&user=yamada"));
    }

    [Fact]
    public void URLのポートは残す()
    {
        Assert.Equal("http://internal.example.com:8080", PrivacyLogFormatter.ShortenUri("http://internal.example.com:8080/path?token=secret"));
    }

    [Fact]
    public void 絶対URLとして解析できない文字列はそのまま返す()
    {
        Assert.Equal("not-a-url", PrivacyLogFormatter.ShortenUri("not-a-url"));
    }

    [Fact]
    public void ShortenPathOrUriはhttpのURLをURLとして短くする()
    {
        Assert.Equal("https://example.com", PrivacyLogFormatter.ShortenPathOrUri("https://example.com/a/b?x=1"));
    }

    [Fact]
    public void ShortenPathOrUriはファイルパスをパスとして短くする()
    {
        Assert.Equal("image.png", PrivacyLogFormatter.ShortenPathOrUri(@"C:\Users\山田太郎\Pictures\image.png"));
    }
}
