namespace Pane;

/// <summary>
/// メニュー項目のnote(「Pandoc未導入」等、<see cref="NativeMenu.MenuItemData.Note"/>)を、
/// 表示用のラベル文字列へどう反映するかだけを計算する、依存の無い純粋なクラス。
///
/// 総点検で見つかった不具合: WinFormsの<c>ToolStripMenuItem</c>は、無効(グレーアウト)な
/// 項目に対してマウスのhover系イベントを配らないため、noteを<c>ToolTipText</c>に
/// 設定するだけでは、Pandoc未導入で無効化されたエクスポート項目(「エクスポート: Word」等)の
/// 「なぜ選べないか」がツールチップとして一切出ない(Pane/NativeMenu.cs)。
///
/// WinForms(<see cref="NativeMenu"/>)から計算ロジックだけを分離してあるのは、
/// この環境(Linux、net8.0)ではWindows Forms自体をビルド・実行できず、
/// <see cref="NativeMenu"/>をそのままPane.Testsへ取り込めないため。ここには
/// WinForms型への依存を一切持ち込まないこと(Pane.Testsの`&lt;Compile Include&gt;`で
/// このファイルだけを取り込めるようにするため)。
/// </summary>
internal static class MenuNoteFormatter
{
    /// <summary>
    /// メニューに表示する文字列を返す。無効な項目にnoteがあるときだけ、
    /// ラベルの末尾へ "(note)" を付記する(有効な項目はラベルをそのまま返す。
    /// noteは引き続きToolTipTextにも設定される想定のため、有効な項目では
    /// ラベルを変えず、ホバー時のツールチップだけで案内する)。
    /// </summary>
    public static string ComputeDisplayLabel(string label, string? note, bool enabled)
    {
        if (enabled || string.IsNullOrEmpty(note)) return label;
        return $"{label} ({note})";
    }
}
