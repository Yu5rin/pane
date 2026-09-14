namespace Pane;

/// <summary>保存しようとしている相手が、開いたときのファイルのままかどうか。</summary>
internal enum ExternalFileState
{
    /// <summary>開いたときのファイルがそのままある(通常)。</summary>
    Present,

    /// <summary>外部で削除された(名前の変更先も見つからない)。</summary>
    Deleted,

    /// <summary>外部で別の名前に変更された(変更先が実在する)。</summary>
    Renamed,
}

/// <summary>
/// 開いているファイルが外部で削除・リネームされた状態の判定と、保存前に出す確認の文面。
///
/// 【この形にした理由】以前は、FileSystemWatcherが削除・リネームを検知した瞬間に
/// 「このファイルは外部で削除されました」というOKだけのダイアログを出していた。これは
/// 押す以外に選びようのない知らせをモーダルで割り込ませるもので、書いている最中に
/// 前面を奪い、キー入力を飲み込む(Enter/Spaceが「OK」に吸われる)。しかもOKを押せば
/// 消えてしまうので、後から「あのファイルはまだ無いのか」を確かめる手立ても残らない。
/// 利用者の判断で、知らせ自体をやめ、実際に判断が必要になる瞬間——上書き保存しようと
/// した時——にだけ確認することにした。
///
/// 判定を監視イベントのフラグではなく「保存する時点で実際に在るか」で行うのは、
/// 監視が張れていない場合(ログディレクトリ配下・監視の例外・フォルダごと消された等)でも
/// 同じように効かせるため。監視は名前の変更先を覚えておくためだけに使う。
///
/// ファイルシステムに触れない判定だけをここへ切り出してテストで固定する
/// (Pane.Testsへソースごと取り込むため、Windows専用のAPIもSystem.IO.Pathも使わない。
/// パスの区切りはOSで違うので、ファイル名は呼び出し側でPath.GetFileNameして渡す)。
/// </summary>
internal static class ExternalFileStateLogic
{
    /// <summary>
    /// 上書き保存の直前に、保存先が開いたときのファイルのままかを判断する。
    /// </summary>
    /// <param name="targetExists">保存先(開いているファイルのパス)が実在するか。</param>
    /// <param name="renamedToPath">監視が覚えている「名前の変更先」。無ければnull。</param>
    /// <param name="renamedToExists">その変更先が実在するか。</param>
    public static ExternalFileState Evaluate(bool targetExists, string? renamedToPath, bool renamedToExists)
    {
        // 在るならそれ以上は問わない。いったん名前を変えられた後で元の名前に戻された場合や、
        // 同じ名前で作り直された場合も、利用者から見れば「ある」ので止める理由が無い。
        if (targetExists) return ExternalFileState.Present;

        // 変更先が実在するときだけ「名前を変えられた」と言い切る。覚えている変更先が
        // 既に消えている(さらに削除された・また別の名前になった)なら、いま言えるのは
        // 「元の名前のファイルが無い」ことだけなので、削除として扱う。
        if (!string.IsNullOrEmpty(renamedToPath) && renamedToExists) return ExternalFileState.Renamed;

        return ExternalFileState.Deleted;
    }

    /// <summary>
    /// 保存前の確認に出す文面。押した先で何が起きるかを先に書く
    /// (「はい」で何ができるのかが分からない確認にしない)。
    /// </summary>
    /// <param name="state"><see cref="Evaluate"/>の結果。<see cref="ExternalFileState.Present"/>は呼ばない。</param>
    /// <param name="targetFileName">開いているファイルの名前(パスではなく名前だけ)。</param>
    /// <param name="renamedToFileName">名前の変更先の名前。削除ならnull。</param>
    public static string BuildSaveConfirmMessage(
        ExternalFileState state, string targetFileName, string? renamedToFileName)
    {
        if (state == ExternalFileState.Renamed && !string.IsNullOrEmpty(renamedToFileName))
        {
            return $"このファイルは外部で「{renamedToFileName}」に名前を変更されています。"
                + $"\nこのまま保存すると、元の名前「{targetFileName}」で別のファイルが新しく作成されます。"
                + "\n保存しますか?";
        }
        return $"このファイル「{targetFileName}」は外部で削除されています。"
            + "\nこのまま保存すると、同じ名前で新しく作成されます。"
            + "\n保存しますか?";
    }
}
