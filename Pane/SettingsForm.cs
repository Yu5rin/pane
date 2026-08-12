namespace Pane;

/// <summary>
/// Phase 3 時点での最小設定ダイアログ。
/// 起動時の動作(セッション復元 / 何も開かない)と、既定のMarkdownエディタ登録のみを扱う。
/// 本格的な設定UI(第10章のPreferences画面)はPhase 8で実装する。
/// </summary>
internal sealed class SettingsForm : Form
{
    private readonly RadioButton _radioRestoreSession;
    private readonly RadioButton _radioBlank;
    private readonly CheckBox _checkFileAssociation;

    public bool RestoreSessionOnStartup => _radioRestoreSession.Checked;
    public bool FileAssociationEnabled => _checkFileAssociation.Checked;

    public SettingsForm(AppSettings current)
    {
        Text = "設定";
        FormBorderStyle = FormBorderStyle.FixedDialog;
        MaximizeBox = false;
        MinimizeBox = false;
        StartPosition = FormStartPosition.CenterParent;
        Width = 380;
        Height = 260;
        Font = new Font("Yu Gothic UI", 9f);

        var groupStartup = new GroupBox
        {
            Text = "起動時の動作",
            Left = 16,
            Top = 16,
            Width = 336,
            Height = 90,
        };
        _radioRestoreSession = new RadioButton
        {
            Text = "前回開いていたファイルを復元する",
            Left = 12,
            Top = 24,
            Width = 300,
            Checked = current.StartupBehavior == "restoreSession",
        };
        _radioBlank = new RadioButton
        {
            Text = "何も開かない(新規ドキュメントのみ)",
            Left = 12,
            Top = 52,
            Width = 300,
            Checked = current.StartupBehavior != "restoreSession",
        };
        groupStartup.Controls.Add(_radioRestoreSession);
        groupStartup.Controls.Add(_radioBlank);

        _checkFileAssociation = new CheckBox
        {
            Text = "既定のMarkdownエディタとして登録する (.md / .markdown / .mdown)",
            Left = 16,
            Top = 118,
            Width = 336,
            Height = 40,
            Checked = current.FileAssociationEnabled,
        };

        var note = new Label
        {
            Text = "登録後、Windowsの設定画面で手動確認が必要な場合があります。",
            Left = 16,
            Top = 158,
            Width = 336,
            Height = 32,
            ForeColor = SystemColors.GrayText,
        };

        var btnOk = new Button
        {
            Text = "OK",
            DialogResult = DialogResult.OK,
            Left = 190,
            Top = 190,
            Width = 80,
        };
        var btnCancel = new Button
        {
            Text = "キャンセル",
            DialogResult = DialogResult.Cancel,
            Left = 276,
            Top = 190,
            Width = 80,
        };

        Controls.Add(groupStartup);
        Controls.Add(_checkFileAssociation);
        Controls.Add(note);
        Controls.Add(btnOk);
        Controls.Add(btnCancel);

        AcceptButton = btnOk;
        CancelButton = btnCancel;
    }
}
