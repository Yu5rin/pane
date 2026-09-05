using System.Runtime.CompilerServices;
using System.Text;

namespace Pane.Tests;

/// <summary>
/// Shift_JISへ切り替えて保存すると表現できない文字が黙って"?"になる不具合
/// (<see cref="EncodingLossGuard"/>、docs/調査記録/点検-機能と動作.md「余裕があれば直すもの」)を
/// 固定するテスト。
/// </summary>
public class EncodingLossGuardTests
{
    /// <summary>
    /// コードページ932(Shift_JIS)は.NETに既定で同梱されないため、本体(Pane.csproj/Program.cs)
    /// と同じくCodePagesEncodingProviderを登録してから使う必要がある。テストプロジェクトは
    /// Program.Mainを経由しないため、xunitがこのアセンブリを読み込んだ時点で一度だけ
    /// 走るモジュール初期化子でここに登録する。
    /// </summary>
    [ModuleInitializer]
    internal static void RegisterCodePages()
    {
        Encoding.RegisterProvider(CodePagesEncodingProvider.Instance);
    }

    [Fact]
    public void UTF8では損失は起きないと判定する()
    {
        Assert.False(EncodingLossGuard.CanLoseCharacters(FileEncodingKind.Utf8));
        Assert.False(EncodingLossGuard.CanLoseCharacters(FileEncodingKind.Utf8Bom));
    }

    [Fact]
    public void UTF16では損失は起きないと判定する()
    {
        Assert.False(EncodingLossGuard.CanLoseCharacters(FileEncodingKind.Utf16Le));
        Assert.False(EncodingLossGuard.CanLoseCharacters(FileEncodingKind.Utf16Be));
    }

    [Fact]
    public void ShiftJISだけ損失が起こりうると判定する()
    {
        Assert.True(EncodingLossGuard.CanLoseCharacters(FileEncodingKind.ShiftJis));
    }

    [Fact]
    public void ShiftJIS以外は表現できない文字があっても検知しない()
    {
        // FileEncodingKindはinternalなため、xunitのTheory/InlineData(公開メンバーの引数に
        // 使えない)ではなく、列挙値ごとに直接呼び出す形にしてある。
        // UTF系はCanLoseCharacters自体がfalseを返す前提のため、絵文字を含めても常にfalse。
        const string textWithEmoji = "絵文字😀入り";
        Assert.False(EncodingLossGuard.HasUnsupportedCharacters(textWithEmoji, FileEncodingKind.Utf8));
        Assert.False(EncodingLossGuard.HasUnsupportedCharacters(textWithEmoji, FileEncodingKind.Utf8Bom));
        Assert.False(EncodingLossGuard.HasUnsupportedCharacters(textWithEmoji, FileEncodingKind.Utf16Le));
        Assert.False(EncodingLossGuard.HasUnsupportedCharacters(textWithEmoji, FileEncodingKind.Utf16Be));
    }

    [Fact]
    public void 通常の日本語だけならShiftJISで保存できると判定する()
    {
        Assert.False(EncodingLossGuard.HasUnsupportedCharacters("こんにちは、世界。", FileEncodingKind.ShiftJis));
    }

    [Fact]
    public void 半角全角英数字はShiftJISで保存できると判定する()
    {
        Assert.False(EncodingLossGuard.HasUnsupportedCharacters("Pane v1.1.3", FileEncodingKind.ShiftJis));
    }

    [Fact]
    public void 絵文字はShiftJISで表現できないと判定する()
    {
        // サロゲートペア(U+1F600)。既定の置換フォールバックだと警告なしに"?"×2になっていた文字。
        Assert.True(EncodingLossGuard.HasUnsupportedCharacters("メモ😀", FileEncodingKind.ShiftJis));
    }

    [Fact]
    public void 対応外のCJK統合漢字はShiftJISで表現できないと判定する()
    {
        // 判定を見た目の合字などの特殊ケースだけに頼っていないことの確認として、
        // JIS X 0208に含まれない拡張漢字(𠮟る等ではなく、確実に落ちる合字)の代わりに
        // ハングルを使う(コードページ932に無いことが明確なため)。
        Assert.True(EncodingLossGuard.HasUnsupportedCharacters("한국어", FileEncodingKind.ShiftJis));
    }

    [Fact]
    public void 空文字列は損失なしと判定する()
    {
        Assert.False(EncodingLossGuard.HasUnsupportedCharacters("", FileEncodingKind.ShiftJis));
    }

    [Fact]
    public void 不正なShiftJISとして読み込んだ結果の置換文字も表現できないと判定する()
    {
        // TextFileService.DecodeBodyがShiftJISとして不正なバイト列を非厳密デコードすると
        // U+FFFD(置換文字)が混じる。これも932では表現できないため、そのまま保存すれば
        // 気づかれずに"?"へ変わっていた(docs/調査記録/点検-機能と動作.md「Shift_JISとしても不正なバイト列」)。
        Assert.True(EncodingLossGuard.HasUnsupportedCharacters("あ�い", FileEncodingKind.ShiftJis));
    }
}
