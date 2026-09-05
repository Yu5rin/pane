using System.Text;

namespace Pane;

/// <summary>
/// 選んだ文字コードで保存すると、表現できない文字が失われるかどうかの判定。
///
/// 【なぜ必要か】
/// <see cref="TextFileService"/>の読み込み側(DetectEncoding)はExceptionFallbackで厳密に
/// 判定しているのに、書き込み側(EncodeBody)は既定の置換フォールバックのままだった。
/// この非対称さのせいで、Shift_JISへ切り替えて保存すると、絵文字や一部の記号・結合文字など
/// 表現できない文字が警告なしに"?"へ静かに置き換わっていた(docs/調査記録/点検-機能と動作.md
/// 「余裕があれば直すもの」)。メモ帳は「この文字コードでは保存できない文字がある」と
/// 警告するのに対し、Paneは何も言わず書き込んで元の文字を失わせていた。
///
/// 判定そのものは通信・ファイル・時刻に一切触れないため、ここへ切り出してPane.Tests側で
/// 固定する(呼び出し元はMainForm.HandleSaveRequest。保存を実際に行う前に確認する)。
/// </summary>
internal static class EncodingLossGuard
{
    /// <summary>
    /// このエンコーディングで、Unicodeの文字が表現できずに失われることがあるか。
    /// UTF-8/UTF-16はUnicodeをそのまま表せるため(通常の文字列である限り)損失は起きない。
    /// 対象はShift_JIS(コードページ932)だけ。
    /// </summary>
    internal static bool CanLoseCharacters(FileEncodingKind encoding) => encoding == FileEncodingKind.ShiftJis;

    /// <summary>
    /// 実際にエンコードを試み、指定した文字コードで表現できない文字が含まれるかを調べる。
    /// <see cref="TextFileService"/>の書き込み(EncodeBody)は既定の置換フォールバックで
    /// 黙って"?"にしてしまうが、ここではEncoderFallback.ExceptionFallbackで試すことで
    /// 静かに化けさせずに検知する。
    ///
    /// UTF-8/UTF-16は常にfalse(<see cref="CanLoseCharacters"/>参照)。呼び出し側で
    /// Encoding.GetEncoding(932)がまだ使えない(CodePagesEncodingProviderが未登録)環境では
    /// 例外がそのまま外へ出るため、呼び出し元(Program.Main)で登録済みであることが前提。
    /// </summary>
    internal static bool HasUnsupportedCharacters(string text, FileEncodingKind encoding)
    {
        if (!CanLoseCharacters(encoding)) return false;
        if (text.Length == 0) return false;

        Encoding strict = Encoding.GetEncoding(
            932,
            EncoderFallback.ExceptionFallback,
            DecoderFallback.ReplacementFallback);
        try
        {
            strict.GetBytes(text);
            return false;
        }
        catch (EncoderFallbackException)
        {
            return true;
        }
    }
}
