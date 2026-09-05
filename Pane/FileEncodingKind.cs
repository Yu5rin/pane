namespace Pane;

/// <summary>
/// 仕様書 第6章で定めるエンコーディング。既定はUTF-8(BOMなし)。
///
/// <see cref="TextFileService"/>から独立したファイルに置いているのは、
/// <see cref="EncodingLossGuard"/>(Shift_JISで表現できない文字の検知)がPane.Tests側で
/// テストされるため。TextFileService自体はFile.ReadAllBytes等に依存しておりテスト対象へは
/// 取り込めないが、この列挙型そのものは通信・ファイルに一切触れないため単独で取り込める。
/// </summary>
internal enum FileEncodingKind
{
    Utf8,
    Utf8Bom,
    Utf16Le,
    Utf16Be,
    ShiftJis,
}
