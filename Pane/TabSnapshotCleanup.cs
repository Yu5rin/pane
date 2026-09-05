namespace Pane;

/// <summary>
/// タブ形式(仕様書 第2.10節 C-14)で、閉じられたタブのguidを見つける判定。
///
/// 【なぜ必要か】
/// タブを「閉じる」で破棄しても、そのタブの自動保存スナップショット
/// (<see cref="AutoSaveService"/>、タブのguidをファイル名にする)が残ったままだった。
/// <see cref="MainForm.HandleAllTabsTextResponse"/>はdirty=falseのタブについてのみ
/// DeleteSnapshotするが、閉じられたタブは以後"tabs-changed"の一覧に二度と現れないため
/// そこには乗らず、ファイルが残り続ける。すると次回起動時、正常終了したにもかかわらず
/// 「前回は正常に終了しませんでした。復元しますか?」と誤って表示されてしまう
/// (docs/調査記録/点検-機能と動作.md「余裕があれば直すもの」)。
///
/// "tabs-changed"は常に「今の全タブ」の一覧を送ってくるため、直前に持っていた一覧と
/// 突き合わせれば、消えたguid=閉じられたタブだと分かる(保存して閉じた・保存せず破棄した、
/// いずれの場合も含む。理由を問わずそのタブ専用のスナップショットはもう不要)。
///
/// 通信・ファイルに一切触れない突き合わせだけをここへ切り出し、Pane.Tests側で固定する。
/// </summary>
internal static class TabSnapshotCleanup
{
    /// <summary>
    /// <paramref name="previousGuids"/>にはあって<paramref name="currentGuids"/>には無いguid
    /// (=閉じられたタブ)を、元の順序を保ったまま列挙する。
    /// </summary>
    internal static IEnumerable<string> FindClosedTabGuids(
        IEnumerable<string> previousGuids,
        IEnumerable<string> currentGuids)
    {
        var currentSet = new HashSet<string>(currentGuids, StringComparer.Ordinal);
        foreach (string guid in previousGuids)
        {
            if (!currentSet.Contains(guid))
            {
                yield return guid;
            }
        }
    }
}
