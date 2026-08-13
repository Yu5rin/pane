namespace Pane;

/// <summary>
/// Phase 3〜今回時点での最小設定ダイアログ。
/// 起動時の動作・既定のMarkdownエディタ登録に加え、マークダウン記法拡張(仕様書 第2.10節 C-01)の
/// ON/OFFを扱う。本格的な設定UI(第10章のPreferences画面)はPhase 8で実装する。
/// </summary>
internal sealed class SettingsForm : Form
{
    private readonly RadioButton _radioRestoreSession;
    private readonly RadioButton _radioBlank;
    private readonly CheckBox _checkFileAssociation;
    private readonly CheckBox _checkCallouts;
    private readonly CheckBox _checkSuperSubscript;
    private readonly CheckBox _checkHighlight;
    private readonly CheckBox _checkInlineMath;
    private readonly CheckBox _checkMathAutoNumber;

    public bool RestoreSessionOnStartup => _radioRestoreSession.Checked;
    public bool FileAssociationEnabled => _checkFileAssociation.Checked;
    public bool CalloutsEnabled => _checkCallouts.Checked;
    public bool SuperSubscriptEnabled => _checkSuperSubscript.Checked;
    public bool HighlightEnabled => _checkHighlight.Checked;
    public bool InlineMathEnabled => _checkInlineMath.Checked;
    public bool MathAutoNumberEnabled => _checkMathAutoNumber.Checked;

    public SettingsForm(AppSettings current)
    {
        Text = "設定";
        FormBorderStyle = FormBorderStyle.FixedDialog;
        MaximizeBox = false;
        MinimizeBox = false;
        StartPosition = FormStartPosition.CenterParent;
        Width = 400;
        Height = 520;
        Font = new Font("Yu Gothic UI", 9f);

        var groupStartup = new GroupBox
        {
            Text = "起動時の動作",
            Left = 16,
            Top = 16,
            Width = 356,
            Height = 90,
        };
        _radioRestoreSession = new RadioButton
        {
            Text = "前回開いていたファイルを復元する",
            Left = 12,
            Top = 24,
            Width = 320,
            Checked = current.StartupBehavior == "restoreSession",
        };
        _radioBlank = new RadioButton
        {
            Text = "何も開かない(新規ドキュメントのみ)",
            Left = 12,
            Top = 52,
            Width = 320,
            Checked = current.StartupBehavior != "restoreSession",
        };
        groupStartup.Controls.Add(_radioRestoreSession);
        groupStartup.Controls.Add(_radioBlank);

        // マークダウン記法拡張(仕様書 第2.10節 C-01)
        var groupMarkdownExt = new GroupBox
        {
            Text = "マークダウン記法拡張",
            Left = 16,
            Top = 114,
            Width = 356,
            Height = 118,
        };
        _checkCallouts = new CheckBox
        {
            Text = "Callouts( > [!NOTE] 等のGitHub式アラート)",
            Left = 12,
            Top = 24,
            Width = 320,
            Checked = current.CalloutsEnabled,
        };
        _checkSuperSubscript = new CheckBox
        {
            Text = "上付き文字( ^text^ )・下付き文字( ~text~ )",
            Left = 12,
            Top = 52,
            Width = 320,
            Checked = current.SuperSubscriptEnabled,
        };
        _checkHighlight = new CheckBox
        {
            Text = "ハイライト( ==text== )",
            Left = 12,
            Top = 80,
            Width = 320,
            Checked = current.HighlightEnabled,
        };
        groupMarkdownExt.Controls.Add(_checkCallouts);
        groupMarkdownExt.Controls.Add(_checkSuperSubscript);
        groupMarkdownExt.Controls.Add(_checkHighlight);

        // 数式(仕様書 第2.9.1節・第5章・MathJax)
        var groupMath = new GroupBox
        {
            Text = "数式(MathJax)",
            Left = 16,
            Top = 240,
            Width = 356,
            Height = 90,
        };
        _checkInlineMath = new CheckBox
        {
            Text = "インライン数式( $...$ )を有効化する",
            Left = 12,
            Top = 24,
            Width = 320,
            Checked = current.InlineMathEnabled,
        };
        _checkMathAutoNumber = new CheckBox
        {
            Text = "数式番号を自動採番する",
            Left = 12,
            Top = 52,
            Width = 320,
            Checked = current.MathAutoNumberEnabled,
        };
        groupMath.Controls.Add(_checkInlineMath);
        groupMath.Controls.Add(_checkMathAutoNumber);

        _checkFileAssociation = new CheckBox
        {
            Text = "既定のMarkdownエディタとして登録する (.md / .markdown / .mdown)",
            Left = 16,
            Top = 340,
            Width = 356,
            Height = 40,
            Checked = current.FileAssociationEnabled,
        };

        var note = new Label
        {
            Text = "登録後、Windowsの設定画面で手動確認が必要な場合があります。",
            Left = 16,
            Top = 382,
            Width = 356,
            Height = 32,
            ForeColor = SystemColors.GrayText,
        };

        var btnOk = new Button
        {
            Text = "OK",
            DialogResult = DialogResult.OK,
            Left = 210,
            Top = 424,
            Width = 80,
        };
        var btnCancel = new Button
        {
            Text = "キャンセル",
            DialogResult = DialogResult.Cancel,
            Left = 296,
            Top = 424,
            Width = 80,
        };

        Controls.Add(groupStartup);
        Controls.Add(groupMarkdownExt);
        Controls.Add(groupMath);
        Controls.Add(_checkFileAssociation);
        Controls.Add(note);
        Controls.Add(btnOk);
        Controls.Add(btnCancel);

        AcceptButton = btnOk;
        CancelButton = btnCancel;
    }
}
