namespace Pane;

/// <summary>
/// 大容量ファイルの判定(仕様書 第8.3節「10MBを超えるファイルはライブプレビューを
/// 自動無効化し、プレーンモードで開く」)。
///
/// 【なぜ独立したクラスにしたか】
/// 総点検(docs/調査記録/点検-機能と動作.md)で、この判定自体がTextFileService.Load・MainForm.OpenFile・
/// src/main.jsのどこにも存在しないことが分かった。docs/取扱説明書.md L390には
/// 「実装済み」として書かれていたため、利用者は数十MBのファイルを開いても安全だと
/// 誤解していたが、実際には本文全体がライブプレビュー付きのままJSONでWebView2へ渡り、
/// CodeMirrorが全文をパースしてUIが固まっていた(CLAUDE.md 第8章の性能要件にも反する)。
/// 判定を呼び出し側(MainForm)へ直接書くと、ファイルを開く経路が増えるたび(OpenFile /
/// OpenInNewTab / OpenDroppedContentの3か所が既にある)に書き忘れる事故が起きやすいため、
/// 通信・ファイル・時刻に一切触れない比較だけをここへ切り出し、Pane.Tests側で固定する。
/// </summary>
internal static class LargeFileGuard
{
    /// <summary>仕様書 第8.3節が定める既定のしきい値(10MB)。</summary>
    internal const long DefaultThresholdBytes = 10L * 1024 * 1024;

    /// <summary>
    /// 設定(AppSettings.LargeFileThresholdBytes)から実際に使うしきい値を決める。
    /// 0以下(未設定・設定ファイルの手編集による誤入力)は既定値へフォールバックする。
    /// マイナス値を「無制限」の意味で使わせない(0以下を許すと、うっかり0を書いた利用者の
    /// ファイルが常に「大容量」判定されてライブプレビューがまったく使えなくなる事故を防ぐため、
    /// 安全側の既定値に倒す)。
    /// </summary>
    internal static long ResolveThresholdBytes(long configuredThresholdBytes) =>
        configuredThresholdBytes > 0 ? configuredThresholdBytes : DefaultThresholdBytes;

    /// <summary>ファイルサイズ(バイト)がしきい値を超えているか。ちょうどしきい値と同じ
    /// サイズは「超えていない」扱い(仕様書の「超える」という文言どおり、境界は含めない)。</summary>
    internal static bool IsLargeFile(long sizeBytes, long thresholdBytes) => sizeBytes > thresholdBytes;
}
