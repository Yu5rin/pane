namespace Pane;

/// <summary>
/// 本文の左右余白(設定 editorPaddingLeft/editorPaddingRight)の既定値と、旧設定
/// (左右共通1値の editorPaddingX)からの移行の判定。
///
/// 【なぜ独立したクラスにしたか】
/// 2026-09-25、既定値を32pxから12pxへ変えた(ユーザー要望)。移行の判定は「左右が既定値の
/// ままなら、旧いXの値を引き継ぐ」という形で既定値そのものを目印にしているため、既定値を
/// 変えるとこの判定が黙って壊れる。旧い設定ファイル(Xしか持たず、Left/Rightのキーが無い)を
/// 読むと、Left/Rightは新しい既定値(12)で埋まるので、判定を「32のまま」のままにしておくと
/// 移行が二度と起きず、利用者が以前に選んだXの値が失われる。
/// 通信・ファイル・時刻に触れない比較だけなので、ここへ切り出して Pane.Tests で固定する。
///
/// 【既存の利用者の余白は変えない】
/// Pane は設定を全項目 settings.json へ書き出すため、今の利用者のファイルには
/// "EditorPaddingLeft": 32 が明示的に残っている。これは12へ移さない(ユーザー判断:
/// 新しく入れた人と「既定に戻す」だけを12にする)。32を自分で選んだ人と区別できないため。
/// </summary>
internal static class EditorPaddingDefaults
{
    /// <summary>本文の左右余白の既定値(px)。src/settings.js の FIELD_DEFS・src/style.css の
    /// var() の予備値・docs/設定項目一覧.md と同じ値に揃えること。</summary>
    internal const int DefaultPx = 12;

    /// <summary>2026-09-25 より前の既定値(px)。旧設定ファイルの判定にだけ使う。</summary>
    internal const int PreviousDefaultPx = 32;

    /// <summary>旧・editorPaddingX の既定値(px)。Xが「移行済み・未設定」であることの印も兼ねる
    /// (<see cref="AppSettings.MigrateEditorPadding"/>参照)。既定値の変更とは関係なく32のまま
    /// 据え置く。変えると、移行済みの設定ファイル(X=32)が「未移行」に見えてしまう。</summary>
    internal const int LegacyPaddingXDefaultPx = 32;

    /// <summary>
    /// 旧・editorPaddingX を左右へ引き継ぐかを決める。引き継ぐときはその値を、引き継がないときは
    /// null を返す。
    ///
    /// 引き継ぐのは、Xが既定値以外に設定されていて、かつ左右が「そろって既定値のまま」のとき。
    /// 「既定値のまま」は、今の既定値(12)と以前の既定値(32)のどちらも含める。
    ///   - 12/12: Left/Rightのキーが無い旧い設定ファイルを今の版で読んだとき
    ///   - 32/32: 以前の版が既定値のままLeft/Rightを書き出していたとき
    /// </summary>
    internal static int? DecideMigratedPadding(int paddingX, int left, int right)
    {
        if (paddingX == LegacyPaddingXDefaultPx) return null;
        bool bothDefault = left == right && (left == DefaultPx || left == PreviousDefaultPx);
        return bothDefault ? paddingX : null;
    }
}
