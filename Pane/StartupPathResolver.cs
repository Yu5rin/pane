namespace Pane;

/// <summary>
/// 起動引数のファイル/フォルダパスを、絶対パスへ直すべきタイミングを1か所にまとめる。
///
/// 【なぜ必要か】
/// 従来はコマンドライン引数の相対パスをそのまま保持しており、多重起動の判定
/// (<see cref="Program"/>のMutexチェック)で既に他のPaneが起動中だった場合、名前付き
/// パイプで文字列としてそのまま既存プロセスへ渡していた。既存プロセス側でパスを解決する
/// (<see cref="PaneApplicationContext.OpenWindow"/> → <c>Directory.Exists</c> →
/// <c>File.ReadAllBytes</c>)ため、相対パスは「今まさにこの2つ目のPaneを起動した
/// コマンドプロンプトのカレントディレクトリ」ではなく「既存プロセスのカレントディレクトリ
/// (通常はexeの場所か、そのプロセスを最初に起動したときのカレントディレクトリ)」を基準に
/// 解決されてしまい、「ファイルを開けませんでした」または別フォルダの同名ファイルが開く事故に
/// なっていた(docs/調査記録/点検-機能と動作.md「余裕があれば直すもの」)。単独起動(1プロセス目)では
/// 自分自身のカレントディレクトリのままなので偶然正しく動き、気づかれにくい。
///
/// 直し方は単純で、パイプへ渡す前・自プロセスで使う前の1か所(<see cref="Program.Main"/>)で
/// 一度だけ絶対パス化すればよい。この呼び出しは「今まさに起動したこのプロセスの
/// カレントディレクトリ」を基準にするため、常に利用者の意図どおりに解決される。
///
/// 絶対パス化そのものはEnvironment.CurrentDirectory(=呼び出し元プロセスの作業ディレクトリ)
/// に依存するため純粋関数ではないが、判断ロジック自体(nullはそのまま・例外時はそのまま)は
/// 通信・ファイルの読み書きに触れないため、ここへ切り出してPane.Tests側で固定する。
/// </summary>
internal static class StartupPathResolver
{
    /// <summary>
    /// 起動引数のパスを、現在の作業ディレクトリを基準に絶対パスへ直す。
    /// null・空文字はそのまま返す(引数が無い起動)。既に絶対パスであれば
    /// Path.GetFullPathの性質上、実質的にそのまま返る。
    /// 不正な文字などでGetFullPathが例外を投げた場合は、起動そのものを止めないよう
    /// 元の文字列をそのまま返す(この後の実際に開く処理でどのみち同種のエラーとして扱われる)。
    /// </summary>
    internal static string? ResolveToFullPath(string? rawPath)
    {
        if (string.IsNullOrEmpty(rawPath)) return rawPath;
        try
        {
            return Path.GetFullPath(rawPath);
        }
        catch (Exception ex) when (ex is ArgumentException or NotSupportedException or System.Security.SecurityException or PathTooLongException)
        {
            return rawPath;
        }
    }
}
