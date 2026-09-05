namespace Pane;

/// <summary>
/// 外部コマンド(Pandoc等)の実行ファイルを、PATH環境変数に列挙されたフォルダの中からだけ探す。
///
/// 【なぜこのクラスが要るか】
/// 総点検(docs/調査記録/点検-セキュリティ.md C-7)で、DetectPandocAvailable(SettingsBridge.cs)と
/// ExportViaPandocAsync(MainForm.cs)が <c>Process.Start(new ProcessStartInfo("pandoc", ...))</c>
/// のように拡張子・パス無しのファイル名だけでプロセスを起動していたことが分かった。
/// UseShellExecute=false でも、Win32の CreateProcess は拡張子の無いファイル名に自動で
/// ".exe" を補ったうえで、(1)自プロセスの実行ファイル(Pane.exe)のあるフォルダ →
/// (2)呼び出し元プロセスのカレントディレクトリ → (3)System32等 → (4)PATH、の順に探す。
/// Paneは「好きな場所に置くだけ」で使えるポータブル配布であり、ダウンロードフォルダに
/// そのまま置く利用者も多い。そこに"pandoc.exe"という名前の別ファイルが紛れ込んでいると、
/// 本物のPandocより先にそれが検索・実行されてしまう。しかもDetectPandocAvailableは
/// 起動直後のPostCapabilities(MainForm.PostCapabilities)からも呼ばれるため、
/// 「エクスポート操作をしていないのに、Paneを起動しただけで得体の知れないexeが実行される」
/// ことになる(zip同梱のpandoc.exeがある文書フォルダの.mdをダブルクリックして開く、など)。
///
/// 対策として、(1)実行ファイルのフォルダと(2)カレントディレクトリを検索対象から明示的に
/// 除外し、PATH環境変数に列挙されたフォルダだけを自前で走査する。見つかった絶対パスの
/// ファイルだけを起動対象にし、見つからなければ従来どおり「Pandocが無い」扱いにする。
/// </summary>
internal static class ExternalToolLocator
{
    /// <summary>
    /// PATH環境変数(<paramref name="pathEnvironmentVariable"/>)に列挙されたフォルダの中だけを
    /// 先頭から順に調べ、<paramref name="exeBaseName"/>(拡張子無し。例: "pandoc")に ".exe" を
    /// 補ったファイルが実在する最初の絶対パスを返す。見つからなければnull。
    ///
    /// 実行ファイルのあるフォルダ・カレントディレクトリは意図的に見ない(Win32の既定の検索順の
    /// うち、攻撃者が紛れ込ませやすい2箇所を外すのがこの関数の目的そのもののため)。
    ///
    /// PATHの1エントリが空文字列または"."(カレントディレクトリを意味する)の場合もスキップする。
    /// 空文字列はWindowsの一部の文脈(cmd.exe等)でカレントディレクトリと解釈される歴史的挙動が
    /// あり、"."を許すとカレントディレクトリ除外の意図が崩れるため。
    ///
    /// fileExistsを引数で受け取り、このクラス自体はファイルシステムに一切触れないようにしている
    /// (=依存の無い判定ロジックとしてPane.Testsで固定できる)。実際の呼び出し元
    /// (SettingsBridge/MainForm)からは File.Exists を渡す。
    /// </summary>
    internal static string? ResolveFromPath(string exeBaseName, string? pathEnvironmentVariable, Func<string, bool> fileExists)
    {
        if (string.IsNullOrEmpty(exeBaseName) || string.IsNullOrEmpty(pathEnvironmentVariable)) return null;

        string fileName = exeBaseName.EndsWith(".exe", StringComparison.OrdinalIgnoreCase)
            ? exeBaseName
            : exeBaseName + ".exe";

        foreach (string rawDir in pathEnvironmentVariable.Split(Path.PathSeparator))
        {
            string dir = rawDir.Trim();
            if (dir.Length == 0 || dir == ".") continue;

            string candidate;
            try
            {
                // PATHの1エントリに不正な文字が含まれていてもPath.CombineがArgumentExceptionを
                // 投げることがあるため、そのエントリだけ読み飛ばして次へ進む。
                candidate = Path.Combine(dir, fileName);
            }
            catch (ArgumentException)
            {
                continue;
            }

            if (fileExists(candidate)) return candidate;
        }

        return null;
    }
}
