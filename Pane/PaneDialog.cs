using System.Drawing.Drawing2D;

namespace Pane;

/// <summary>
/// Windows標準の<see cref="MessageBox"/>クラスの置き換え。
///
/// MessageBoxクラスの各Showオーバーロードは実体をOS(コモンダイアログ)が描画するため、
/// アプリがダークテーマ・カスタムCSS等で配色を変えていても常に既定の明るいグレーで表示されて
/// しまう(ユーザー報告)。このクラスは本文エリアと同じ配色の自前のダイアログをForm継承で描き、
/// 元々の各Showオーバーロードと同じ引数・同じ戻り値(<see cref="DialogResult"/>)で呼べるように
/// することで、呼び出し側の分岐コード(<c>if (choice == DialogResult.Yes)</c> 等)を一切
/// 書き換えずに済むようにする。
///
/// 配色: オーナーが<see cref="MainForm"/>であれば<see cref="MainForm.TitlebarBackgroundOverride"/>/
/// <see cref="MainForm.TitlebarForegroundOverride"/>(JS側から届いた本文エリアの実描画色)を使う。
/// 届いていない・オーナーがMainFormでない場合は<see cref="WindowChrome"/>側の既定色へフォールバックする。
/// ウィンドウ枠(細い輪郭)は本体ウィンドウ・設定ウィンドウ(<see cref="SettingsWindow"/>)と同じく、
/// 必ず<see cref="WindowChrome.ApplyTheme"/>を経由して付ける(DWMWA_BORDER_COLOR)。
/// </summary>
internal static class PaneDialog
{
    /// <summary>4引数版(本文・タイトル・ボタン構成・アイコン)相当。オーナー無し
    /// (アプリ起動直後、まだウィンドウが無い時点の確認ダイアログ等)から呼ぶ。</summary>
    public static DialogResult Show(string? text, string caption, MessageBoxButtons buttons, MessageBoxIcon icon)
        => ShowCore(null, text, caption, buttons, icon, defaultToCancel: false);

    /// <summary>オーナー付きの5引数版相当。</summary>
    public static DialogResult Show(IWin32Window? owner, string? text, string caption, MessageBoxButtons buttons, MessageBoxIcon icon)
        => ShowCore(owner, text, caption, buttons, icon, defaultToCancel: false);

    /// <summary>
    /// データが失われる可能性のある確認ダイアログ用。<paramref name="defaultToCancel"/>にtrueを渡すと、
    /// Enterキー(既定ボタン)とダイアログを開いた直後のフォーカスを「キャンセル相当のボタン」
    /// (OKCancelならCancel、YesNo/YesNoCancelならいいえ/キャンセル)へ向ける。
    ///
    /// src/dialog.js の paneConfirm({ danger: true }) と揃えた方針(「保存せずに閉じる」
    /// 「削除」等はうっかりEnterを押すとデータが失われるため、既定側を安全な選択肢にする)だが、
    /// 実現方法はJS版とは異なる。JS版はEnterキー自体の意味(常にOKを試みる)を変えず、
    /// フォーカスの初期位置だけキャンセル側へ退避させている(Tabで一度OK側へ移動してから
    /// 押す一手間を要求する設計)。WinFormsではEnterキーの意味そのものをAcceptButtonが担うため、
    /// ここでは既定ボタン自体をキャンセル相当へ切り替えることで「うっかりEnterでデータを失わせない」
    /// という同じ目的を(JS版よりも直接的に安全な形で)達成する。
    /// </summary>
    public static DialogResult Show(IWin32Window? owner, string? text, string caption, MessageBoxButtons buttons, MessageBoxIcon icon, bool defaultToCancel)
        => ShowCore(owner, text, caption, buttons, icon, defaultToCancel);

    private static DialogResult ShowCore(IWin32Window? owner, string? text, string caption, MessageBoxButtons buttons, MessageBoxIcon icon, bool defaultToCancel)
    {
        Form? ownerForm = owner as Form;
        using var dialog = new PaneDialogForm(ownerForm, text, caption, buttons, icon, defaultToCancel);
        // ownerFormがまだハンドルを持たない(表示前)場合にShowDialog(owner)へ渡すと例外になるため、
        // その場合は画面中央にフォールバックする(PaneDialogForm.ComputeCenteredLocation参照)。
        return ownerForm is { IsHandleCreated: true }
            ? dialog.ShowDialog(ownerForm)
            : dialog.ShowDialog();
    }

    /// <summary>
    /// 自前ダイアログの実体。MessageBoxButtons/MessageBoxIconの値をそのまま受け取り、
    /// ボタン構成・アイコンを再現する。配色・ウィンドウ枠はコンストラクタ〜OnHandleCreatedで
    /// 本体ウィンドウと同じ手順(WindowChrome.ApplyTheme)を踏む。
    /// </summary>
    private sealed class PaneDialogForm : Form
    {
        // ---- レイアウトの基準値(96DPI・スケール1.0での値。DPIスケールは末尾でScale()により
        //      まとめて適用する。MainForm/SettingsWindowが個々の描画のたびにDeviceDpi/96.0で
        //      都度換算しているのに対し、このダイアログは生成時に一度だけ組み立てる作りのため、
        //      Control.Scale(SizeF)へ丸ごと委ねたほうがシンプルになる)。 ----
        private const int DialogPad = 20;
        private const int IconSize = 32;
        private const int GapAfterIcon = 16;
        private const int MessageMaxWidth = 320;
        private const int ButtonWidth = 92;
        private const int ButtonHeight = 30;
        private const int ButtonSpacing = 8;
        private const int GapBeforeButtons = 24;

        private readonly MessageBoxIcon _icon;
        private readonly bool _isDark;

        public PaneDialogForm(Form? owner, string? text, string caption, MessageBoxButtons buttons, MessageBoxIcon icon, bool defaultToCancel)
        {
            text ??= ""; // 本物のMessageBoxもnullは空文字として扱う。
            _icon = icon;

            // 設定は読み取りのみ(この後に書き戻さない)ため、Lost Updateの対象外。
            AppSettings settings = SettingsService.Load();
            _isDark = MainForm.ResolveIsDarkTheme(settings.Theme);

            string? backgroundHex = null;
            string? foregroundHex = null;
            if (owner is MainForm mainForm)
            {
                backgroundHex = mainForm.TitlebarBackgroundOverride;
                foregroundHex = mainForm.TitlebarForegroundOverride;
            }
            Color background = ParseColorOrDefault(backgroundHex, _isDark ? WindowChrome.DefaultDarkBackground : WindowChrome.DefaultLightBackground);
            Color foreground = ParseColorOrDefault(foregroundHex, _isDark ? WindowChrome.DefaultDarkForeground : WindowChrome.DefaultLightForeground);
            Color border = ParseColorOrDefault(null, _isDark ? WindowChrome.DefaultDarkBorder : WindowChrome.DefaultLightBorder);

            Text = caption;
            FormBorderStyle = FormBorderStyle.FixedDialog;
            MaximizeBox = false;
            MinimizeBox = false;
            ShowInTaskbar = false;
            StartPosition = FormStartPosition.Manual; // OnLoadでオーナー中央へ自前配置する
            KeyPreview = true;
            Font = SystemFonts.MessageBoxFont ?? Font;
            BackColor = background;
            ForeColor = foreground;

            try
            {
                Icon = new Icon(Path.Combine(AppContext.BaseDirectory, "Assets", "Pane.ico"));
            }
            catch
            {
                // 仮アイコンが見つからなくても表示は継続する(既定色のフォールバックと同じ考え方)。
            }

            // ---- アイコン(GDI+の単純な図形で自前描画。MessageBoxIcon.Noneなら描かない) ----
            int textLeft = DialogPad;
            if (icon != MessageBoxIcon.None)
            {
                var iconPanel = new Panel
                {
                    Size = new Size(IconSize, IconSize),
                    Location = new Point(DialogPad, DialogPad),
                    TabStop = false,
                };
                iconPanel.Paint += (_, e) => DrawIcon(e.Graphics, icon, iconPanel.ClientRectangle);
                Controls.Add(iconPanel);
                textLeft = DialogPad + IconSize + GapAfterIcon;
            }

            // ---- 本文(長文では自動的に高さが伸びる。UseMnemonic=falseは必須: エラーメッセージや
            //      ファイルパスに'&'が含まれていても、ボタンのアクセスキーのように誤解釈させない
            //      ためで、本物のMessageBoxも本文中の'&'はそのまま表示する) ----
            var messageLabel = new Label
            {
                Text = text,
                UseMnemonic = false,
                AutoSize = true,
                MaximumSize = new Size(MessageMaxWidth, 0),
                Location = new Point(textLeft, DialogPad),
                ForeColor = foreground,
                BackColor = Color.Transparent,
                TabStop = false,
            };
            Controls.Add(messageLabel);

            int contentBottom = Math.Max(messageLabel.Bottom, DialogPad + IconSize);

            // ---- ボタン ----
            (string Label, DialogResult Result)[] specs = ButtonSpecs(buttons);
            var buttonControls = new List<Button>();
            foreach ((string label, DialogResult result) in specs)
            {
                var btn = new Button
                {
                    Text = label,
                    DialogResult = result,
                    AutoSize = false,
                    Size = new Size(ButtonWidth, ButtonHeight),
                    FlatStyle = FlatStyle.Flat,
                    BackColor = background,
                    ForeColor = foreground,
                    UseVisualStyleBackColor = false,
                };
                btn.FlatAppearance.BorderColor = border;
                buttonControls.Add(btn);
                Controls.Add(btn);
            }

            int buttonsTop = contentBottom + GapBeforeButtons;
            int totalButtonsWidth = buttonControls.Count * ButtonWidth + (buttonControls.Count - 1) * ButtonSpacing;
            int contentWidth = textLeft + MessageMaxWidth + DialogPad;
            // 本文が短くボタン幅の合計のほうが大きい場合は、ボタン基準でクライアント幅を決める
            // (実際の本文幅はLabel.Widthのほうが正確だが、AutoSizeの折り返し結果はMaximumSize以下に
            // なるため、常にMaximumSize基準で確保しても表示上の破綻はない)。
            int clientWidth = Math.Max(textLeft + messageLabel.Width + DialogPad, Math.Max(contentWidth, DialogPad * 2 + totalButtonsWidth));

            int bx = clientWidth - DialogPad - totalButtonsWidth;
            foreach (Button b in buttonControls)
            {
                b.Location = new Point(bx, buttonsTop);
                bx += b.Width + ButtonSpacing;
            }

            ClientSize = new Size(clientWidth, buttonsTop + ButtonHeight + DialogPad);

            // ---- キーボード操作: Enterで既定ボタン・Escでキャンセル相当・Tabでループ ----
            // TabによるフォーカスのループはWinFormsの標準の挙動(ContainerControl.ProcessTabKeyが
            // 最後のコントロールの次を先頭へ折り返す)にそのまま乗るため、ここでの追加実装は不要。
            // アクセスキー(はい(&Y)/いいえ(&N)等)もButton.Textの'&'記法だけで有効になる。
            int cancelIndex = CancelEquivalentIndex(buttons);
            Button cancelEquivalent = buttonControls[cancelIndex];
            CancelButton = cancelEquivalent;
            AcceptButton = defaultToCancel ? cancelEquivalent : buttonControls[0];
            _initialFocusButton = (Button)AcceptButton;

            // ---- DPIスケーリング。上のレイアウトはすべて96DPI基準の値のため、実際のDPIとの比を
            //      Control.Scale(SizeF)で一括反映する(位置・サイズ・フォントをまとめて再計算してくれる)。 ----
            double dpiScale = ResolveDpiScale(owner);
            if (Math.Abs(dpiScale - 1.0) > 0.01)
            {
                Scale(new SizeF((float)dpiScale, (float)dpiScale));
            }

            _owner = owner;
        }

        private readonly Form? _owner;
        private readonly Button? _initialFocusButton;

        /// <summary>
        /// ウィンドウのネイティブハンドル生成直後にタイトルバー・ウィンドウ枠の配色を塗る
        /// (MainForm.OnHandleCreated / SettingsWindow.OnHandleCreatedと同じ作法)。
        /// 本体・設定ウィンドウと同じ薄い枠を付けるため、必ずWindowChrome.ApplyTheme経由にする
        /// (DWMWA_BORDER_COLORはこの中でのみ設定される)。
        /// </summary>
        protected override void OnHandleCreated(EventArgs e)
        {
            base.OnHandleCreated(e);
            string? backgroundHex = (_owner as MainForm)?.TitlebarBackgroundOverride;
            string? foregroundHex = (_owner as MainForm)?.TitlebarForegroundOverride;
            WindowChrome.ApplyTheme(Handle, _isDark, backgroundHex, foregroundHex);
        }

        protected override void OnLoad(EventArgs e)
        {
            base.OnLoad(e);
            Location = ComputeCenteredLocation(_owner, Size);
            if (_initialFocusButton is not null) ActiveControl = _initialFocusButton;
        }

        /// <summary>オーナーウィンドウの中央、無ければ主画面の中央(SettingsWindowと同じ考え方)。
        /// 画面外へはみ出す場合は作業領域内に収める。</summary>
        private static Point ComputeCenteredLocation(Form? owner, Size size)
        {
            Rectangle area = owner is { IsHandleCreated: true }
                ? Screen.FromControl(owner).WorkingArea
                : Screen.PrimaryScreen?.WorkingArea ?? Screen.AllScreens[0].WorkingArea;

            int centerX = owner is { IsHandleCreated: true } ? owner.Bounds.Left + owner.Bounds.Width / 2 : area.Left + area.Width / 2;
            int centerY = owner is { IsHandleCreated: true } ? owner.Bounds.Top + owner.Bounds.Height / 2 : area.Top + area.Height / 2;
            int x = centerX - size.Width / 2;
            int y = centerY - size.Height / 2;
            x = Math.Max(area.Left, Math.Min(x, area.Right - size.Width));
            y = Math.Max(area.Top, Math.Min(y, area.Bottom - size.Height));
            return new Point(x, y);
        }

        /// <summary>オーナーのDeviceDpiを基準にした96DPIからの倍率。オーナーがまだ無い/ハンドル未生成の
        /// 場合は主画面のDPIへフォールバックする(MainForm/SettingsWindowのDeviceDpi参照と同じ考え方)。</summary>
        private static double ResolveDpiScale(Form? owner)
        {
            if (owner is { IsHandleCreated: true }) return owner.DeviceDpi / 96.0;
            try
            {
                using Graphics g = Graphics.FromHwnd(IntPtr.Zero);
                return g.DpiX / 96.0;
            }
            catch
            {
                return 1.0;
            }
        }

        /// <summary>"#RRGGBB"をColorへ変換する。null/空/不正な形式は既定色(fallbackHex)へ倒す。</summary>
        private static Color ParseColorOrDefault(string? hex, string fallbackHex)
        {
            if (!string.IsNullOrWhiteSpace(hex) && TryParseHex(hex!, out Color parsed)) return parsed;
            return TryParseHex(fallbackHex, out Color fallback) ? fallback : Color.Black;
        }

        private static bool TryParseHex(string hex, out Color color)
        {
            try
            {
                color = ColorTranslator.FromHtml(hex.StartsWith('#') ? hex : $"#{hex}");
                return true;
            }
            catch (Exception)
            {
                color = Color.Black;
                return false;
            }
        }

        /// <summary>MessageBoxButtonsをボタンの(ラベル, DialogResult)列へ変換する。
        /// 仕様どおりOK/OKCancel/YesNo/YesNoCancelのみ対応(このアプリで実際に使うのはこの4つ)。
        /// 未対応の値が来た場合はOK単独へフォールバックする(呼び出し側の想定外入力で落とさないため)。</summary>
        private static (string Label, DialogResult Result)[] ButtonSpecs(MessageBoxButtons buttons) => buttons switch
        {
            MessageBoxButtons.OK => new[] { ("OK", DialogResult.OK) },
            MessageBoxButtons.OKCancel => new[] { ("OK", DialogResult.OK), ("キャンセル(&C)", DialogResult.Cancel) },
            MessageBoxButtons.YesNo => new[] { ("はい(&Y)", DialogResult.Yes), ("いいえ(&N)", DialogResult.No) },
            MessageBoxButtons.YesNoCancel => new[]
            {
                ("はい(&Y)", DialogResult.Yes),
                ("いいえ(&N)", DialogResult.No),
                ("キャンセル(&C)", DialogResult.Cancel),
            },
            _ => new[] { ("OK", DialogResult.OK) },
        };

        /// <summary>ボタン列の中で「キャンセル相当」(安全側)のインデックス。
        /// Escキー・危険操作確認(defaultToCancel)の既定ボタンに使う。</summary>
        private static int CancelEquivalentIndex(MessageBoxButtons buttons) => buttons switch
        {
            MessageBoxButtons.OK => 0,
            MessageBoxButtons.OKCancel => 1,
            MessageBoxButtons.YesNo => 1, // 「いいえ」
            MessageBoxButtons.YesNoCancel => 2, // 「キャンセル」
            _ => 0,
        };

        // ---- アイコン描画(GDI+の単純な図形。MessageBoxIconと同じ4種+実質同値の別名を吸収) ----

        private static void DrawIcon(Graphics g, MessageBoxIcon icon, Rectangle bounds)
        {
            g.SmoothingMode = SmoothingMode.AntiAlias;
            g.TextRenderingHint = System.Drawing.Text.TextRenderingHint.AntiAlias;
            switch (icon)
            {
                case MessageBoxIcon.Error: // Hand/Stopと同値
                    DrawGlyph(g, bounds, Color.FromArgb(211, 69, 62), Color.White, "×");
                    break;
                case MessageBoxIcon.Warning: // Exclamationと同値。三角形にする以外はDrawGlyphと同じ考え方
                    DrawWarningTriangle(g, bounds);
                    break;
                case MessageBoxIcon.Question:
                    DrawGlyph(g, bounds, Color.FromArgb(108, 99, 181), Color.White, "?");
                    break;
                case MessageBoxIcon.Information: // Asteriskと同値
                    DrawGlyph(g, bounds, Color.FromArgb(59, 130, 196), Color.White, "i");
                    break;
            }
        }

        /// <summary>円形の背景に1文字を中央揃えで描く(エラー・質問・情報アイコン共通の下地)。</summary>
        private static void DrawGlyph(Graphics g, Rectangle bounds, Color fill, Color textColor, string glyph)
        {
            using var brush = new SolidBrush(fill);
            g.FillEllipse(brush, bounds);
            using var font = new Font(SystemFonts.MessageBoxFont?.FontFamily ?? FontFamily.GenericSansSerif, bounds.Height * 0.55f, FontStyle.Bold, GraphicsUnit.Pixel);
            using var textBrush = new SolidBrush(textColor);
            var format = new StringFormat { Alignment = StringAlignment.Center, LineAlignment = StringAlignment.Center };
            g.DrawString(glyph, font, textBrush, bounds, format);
        }

        /// <summary>警告アイコン: 三角形の背景に"!"。</summary>
        private static void DrawWarningTriangle(Graphics g, Rectangle bounds)
        {
            Point top = new(bounds.Left + bounds.Width / 2, bounds.Top);
            Point right = new(bounds.Right, bounds.Bottom);
            Point left = new(bounds.Left, bounds.Bottom);
            using var path = new GraphicsPath();
            path.AddPolygon(new[] { top, right, left });
            using var brush = new SolidBrush(Color.FromArgb(230, 168, 46));
            g.FillPath(brush, path);

            using var font = new Font(SystemFonts.MessageBoxFont?.FontFamily ?? FontFamily.GenericSansSerif, bounds.Height * 0.45f, FontStyle.Bold, GraphicsUnit.Pixel);
            using var textBrush = new SolidBrush(Color.FromArgb(51, 38, 0));
            var format = new StringFormat { Alignment = StringAlignment.Center, LineAlignment = StringAlignment.Center };
            // 三角形の重心はやや下寄りのため、文字は下側3分の2に寄せて視覚的な中央に近づける。
            var textRect = new RectangleF(bounds.Left, bounds.Top + bounds.Height * 0.3f, bounds.Width, bounds.Height * 0.7f);
            g.DrawString("!", font, textBrush, textRect, format);
        }
    }
}
