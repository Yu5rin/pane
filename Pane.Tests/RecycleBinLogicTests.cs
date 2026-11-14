namespace Pane.Tests;

/// <summary>
/// 「ごみ箱へ移動」が本当にごみ箱へ入る場所か(<see cref="RecycleBinLogic"/>)を固定するテスト。
///
/// ネットワークドライブ・共有フォルダ・USBメモリにはごみ箱が無く、Windowsは黙って完全に削除する。
/// 「ごみ箱へ移動しますか?」とだけ尋ねて消すと、元に戻せるつもりの利用者を裏切る。
/// </summary>
public class RecycleBinLogicTests
{
    [Fact]
    public void 内蔵のドライブにはごみ箱がある()
    {
        Assert.True(RecycleBinLogic.HasRecycleBin(@"C:\Users\u\Documents\a.md", isFixedDrive: true));
    }

    [Fact]
    public void ネットワークドライブやUSBメモリにはごみ箱が無い()
    {
        // Z: に割り当てたネットワークドライブ、E: のUSBメモリ。どちらも内蔵のドライブではない。
        Assert.False(RecycleBinLogic.HasRecycleBin(@"Z:\share\a.md", isFixedDrive: false));
    }

    [Fact]
    public void 共有フォルダのパスにはごみ箱が無い()
    {
        // ドライブの種類を調べた結果が何であっても、\\server\share はごみ箱を持たない。
        Assert.False(RecycleBinLogic.HasRecycleBin(@"\\server\share\a.md", isFixedDrive: true));
        Assert.False(RecycleBinLogic.HasRecycleBin("//server/share/a.md", isFixedDrive: true));
    }

    [Fact]
    public void パスが分からなければごみ箱は無いものとして確かめる()
    {
        // 分からないときは「完全に削除されるかもしれない」と尋ねる側に倒す。
        Assert.False(RecycleBinLogic.HasRecycleBin(null, isFixedDrive: true));
        Assert.False(RecycleBinLogic.HasRecycleBin("", isFixedDrive: true));
    }
}
