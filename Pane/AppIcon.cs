using System.Reflection;

namespace Pane;

/// <summary>
/// ウィンドウのアイコン(Assets\Pane.ico)の読み込み。
///
/// 以前は <c>AppContext.BaseDirectory</c> の下の Assets\Pane.ico をファイルとして読んでいた。
/// これは単一ファイル発行の設定 <c>IncludeAllContentForSelfExtract=true</c>(=exeの中身を
/// まるごと一時フォルダへ展開してから実行する)に依存した書き方で、その設定を外すと
/// アイコンが見つからなくなる。<c>IncludeAllContentForSelfExtract</c> は公式に非推奨で、
/// 起動のたびに200MB近い展開を伴い初回起動を大きく遅くしていたため外すことにした
/// (実機ログでの起動時間調査による)。
///
/// そこで .ico をアセンブリへ埋め込み(EmbeddedResource)、展開方式にまったく依存しない
/// 読み込み方にしてある。exeが単一ファイルでも、展開されていても、開発ビルドでも同じ動きになる。
/// </summary>
internal static class AppIcon
{
    /// <summary>埋め込みリソースの論理名(Pane.csprojのLogicalNameと一致させること)。</summary>
    private const string ResourceName = "Pane.Assets.Pane.ico";

    /// <summary>読み込んだ.icoの生バイト。1度だけ読んで使い回す。
    /// 見つからなかった場合は空配列を入れ、毎回探し直さないようにする。</summary>
    private static byte[]? _bytes;

    /// <summary>
    /// フォームに設定するアイコンを作る。見つからない・壊れている場合はnullを返すので、
    /// 呼び出し側はそのまま代入せず null チェックすること(nullを代入するとWinFormsの
    /// 既定アイコンに戻ってしまうため)。
    ///
    /// Iconインスタンスはフォームごとに作る。Formは自分のIconを破棄しない実装だが、
    /// 1つのインスタンスを複数フォームで共有すると、どこか1箇所でDisposeされたときに
    /// 他のウィンドウのアイコンまで巻き添えになるため。
    /// </summary>
    public static Icon? Create()
    {
        try
        {
            byte[] bytes = _bytes ??= ReadBytes();
            if (bytes.Length == 0) return null;
            using var stream = new MemoryStream(bytes, writable: false);
            return new Icon(stream);
        }
        catch
        {
            // アイコンが無くても起動は続ける(WinFormsの既定アイコンになるだけ)。
            return null;
        }
    }

    private static byte[] ReadBytes()
    {
        try
        {
            using Stream? stream = Assembly.GetExecutingAssembly().GetManifestResourceStream(ResourceName);
            if (stream is null)
            {
                Logger.Warn($"AppIcon: 埋め込みリソース {ResourceName} が見つからない(既定のアイコンで続行する)");
                return Array.Empty<byte>();
            }
            using var buffer = new MemoryStream();
            stream.CopyTo(buffer);
            return buffer.ToArray();
        }
        catch (Exception ex)
        {
            Logger.WriteException("AppIcon: 埋め込みアイコンの読み込みに失敗", ex);
            return Array.Empty<byte>();
        }
    }
}
