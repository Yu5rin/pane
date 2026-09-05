namespace Pane.Tests;

/// <summary>
/// 仕様書 第8.3節「10MBを超えるファイルはライブプレビューを自動無効化し、プレーンモードで
/// 開く」の判定(<see cref="LargeFileGuard"/>)を固定するテスト。
///
/// この判定自体が実装から丸ごと抜けていた不具合(docs/調査記録/点検-機能と動作.md「仕様書8.3『10MB超は
/// ライブプレビュー自動無効化』が未実装」)の再発防止。docs/取扱説明書.md L390には
/// 「実装済み」と書かれていたため、この一線(「超える」の境界・設定が壊れたときの
/// フォールバック)を崩すと、また利用者の目に見えない形で数十MBのファイルがそのまま
/// ライブプレビュー付きでCodeMirrorへ渡ってしまう。
/// </summary>
public class LargeFileGuardTests
{
    [Fact]
    public void 既定のしきい値は10MB()
    {
        Assert.Equal(10L * 1024 * 1024, LargeFileGuard.DefaultThresholdBytes);
    }

    [Fact]
    public void しきい値ちょうどのサイズは大容量扱いしない()
    {
        // 仕様書の文言は「10MBを超える」であり「10MB以上」ではないため、境界値は含めない。
        Assert.False(LargeFileGuard.IsLargeFile(LargeFileGuard.DefaultThresholdBytes, LargeFileGuard.DefaultThresholdBytes));
    }

    [Fact]
    public void しきい値を1バイトでも超えると大容量扱い()
    {
        Assert.True(LargeFileGuard.IsLargeFile(LargeFileGuard.DefaultThresholdBytes + 1, LargeFileGuard.DefaultThresholdBytes));
    }

    [Fact]
    public void 小さいファイルは大容量扱いしない()
    {
        Assert.False(LargeFileGuard.IsLargeFile(1024, LargeFileGuard.DefaultThresholdBytes));
    }

    [Fact]
    public void 空ファイルは大容量扱いしない()
    {
        Assert.False(LargeFileGuard.IsLargeFile(0, LargeFileGuard.DefaultThresholdBytes));
    }

    [Theory]
    [InlineData(0)]
    [InlineData(-1)]
    [InlineData(-1024)]
    public void しきい値の設定が0以下なら既定値へフォールバックする(long configured)
    {
        // 設定ファイルの手編集による誤入力(0やマイナス)を「無制限」の意味に使わせない。
        // 0を無制限として扱うと、うっかり0を書いた利用者のファイルが常に大容量判定され、
        // ライブプレビューがまったく使えなくなる事故のほうが起きやすいため。
        Assert.Equal(LargeFileGuard.DefaultThresholdBytes, LargeFileGuard.ResolveThresholdBytes(configured));
    }

    [Fact]
    public void しきい値の設定が正の値ならそのまま使う()
    {
        long configured = 5L * 1024 * 1024; // 5MBに変更した想定
        Assert.Equal(configured, LargeFileGuard.ResolveThresholdBytes(configured));
    }

    [Fact]
    public void 設定を変更していれば5MBのファイルも大容量判定できる()
    {
        long configured = 5L * 1024 * 1024;
        long resolved = LargeFileGuard.ResolveThresholdBytes(configured);
        Assert.True(LargeFileGuard.IsLargeFile(6L * 1024 * 1024, resolved));
        Assert.False(LargeFileGuard.IsLargeFile(4L * 1024 * 1024, resolved));
    }
}
