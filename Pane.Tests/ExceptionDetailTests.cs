namespace Pane.Tests;

/// <summary>
/// <see cref="ExceptionDetail"/>を固定するテスト。
///
/// 会社のPCで更新のダウンロードだけが失敗する件を調べようとしたとき、ログには
/// 「HttpRequestException」としか残っておらず、理由が分からなかった。
/// ネットワークの失敗は本当の理由がInnerExceptionに入るため、外側だけを出す実装へ
/// 戻すと同じことが起きる。
/// </summary>
public class ExceptionDetailTests
{
    [Fact]
    public void 内部例外が無ければ型名とメッセージだけ()
    {
        Assert.Equal("InvalidOperationException: だめでした",
            ExceptionDetail.Summarize(new InvalidOperationException("だめでした")));
    }

    [Fact]
    public void 内部例外を矢印でつなぐ()
    {
        var ex = new InvalidOperationException("外側", new TimeoutException("内側"));
        Assert.Equal("InvalidOperationException: 外側 ← TimeoutException: 内側",
            ExceptionDetail.Summarize(ex));
    }

    [Fact]
    public void 三段の入れ子もすべて出す()
    {
        var ex = new InvalidOperationException("1段目",
            new IOException("2段目", new TimeoutException("3段目")));
        Assert.Equal("InvalidOperationException: 1段目 ← IOException: 2段目 ← TimeoutException: 3段目",
            ExceptionDetail.Summarize(ex));
    }

    [Fact]
    public void HTTPの状態コードを添える()
    {
        // 403(拒否)と407(プロキシ認証)の区別が、会社のネットワークの切り分けに直結する。
        var ex = new HttpRequestException("拒否されました", null, System.Net.HttpStatusCode.Forbidden);
        Assert.Equal("HttpRequestException: 拒否されました [HTTP 403 Forbidden]",
            ExceptionDetail.Summarize(ex));
    }

    [Fact]
    public void 状態コードが無いHTTP例外は素のまま()
    {
        Assert.Equal("HttpRequestException: 接続できません",
            ExceptionDetail.Summarize(new HttpRequestException("接続できません")));
    }

    [Fact]
    public void AggregateExceptionは中身をすべて並べる()
    {
        var ex = new AggregateException(new TimeoutException("あ"), new IOException("い"));
        string got = ExceptionDetail.Summarize(ex);
        Assert.Contains("TimeoutException: あ", got);
        Assert.Contains("IOException: い", got);
    }

    [Fact]
    public void 深すぎる入れ子は途中で打ち切る()
    {
        Exception ex = new InvalidOperationException("最内");
        for (int i = 0; i < 20; i++) ex = new InvalidOperationException($"{i}段目", ex);
        string got = ExceptionDetail.Summarize(ex);
        Assert.Contains("(これ以上は省略)", got);
        // 打ち切っても、区切りの数は上限ぶんに収まる(無限に伸びない)。
        Assert.True(got.Split(" ← ").Length <= ExceptionDetail.MaxDepth + 1, got);
    }

    [Fact]
    public void nullでも落ちない()
    {
        Assert.Equal("(例外なし)", ExceptionDetail.Summarize(null));
    }
}
