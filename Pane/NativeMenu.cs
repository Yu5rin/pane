using System.Drawing.Drawing2D;

namespace Pane;

/// <summary>
/// メニューバーのドロップダウンを、WinFormsのネイティブなポップアップ(ToolStripDropDownMenu)として
/// 表示する(仕様書外・ユーザー要望: 「表示」メニュー等、項目数の多いメニューがウィンドウの高さを
/// 超えると画面外へはみ出して届かなくなる問題への対応)。
///
/// メニューバーの見出し自体(ファイル/編集/表示/段落/書式)は従来どおりHTML(WebView2内)のまま。
/// 見出しがクリックされた時点でJS側(src/commands.js)がその時点の状態(有効/無効・チェック状態等)を
/// 評価してJSONにし、"open-menu"メッセージでこのクラスへ届く(受け口は<see cref="MainForm"/>)。
/// ToolStripDropDownMenuはウィンドウの外(画面の端)にもはみ出して表示できるネイティブのポップアップの
/// ため、これでウィンドウを小さくしても全項目に到達できるようになる。
///
/// コマンドの実装はここには一切持たない。項目が選ばれたら選ばれたidをJSへ返すだけで、
/// 実際の実行(command.run())は引き続きJS側(commands.js)が行う。
/// </summary>
internal static class NativeMenu
{
    /// <summary>
    /// JS(src/commands.js の buildNativeItem)から届く1メニュー項目分のデータ。
    /// プロパティ名はJSON側(camelCase)と対応するようMainForm側でパースする。
    /// </summary>
    public sealed record MenuItemData(
        string? Id,
        string Label,
        string Shortcut,
        bool Enabled,
        bool Checked,
        bool SeparatorAfter,
        string Note,
        IReadOnlyList<MenuItemData>? Submenu);

    /// <summary>
    /// 指定した画面座標(<paramref name="screenLocation"/>)にポップアップを表示する。
    /// ・配色は<see cref="PaneMenuRenderer"/>でPaneの配色(src/style.cssの実値)に合わせる。
    /// ・ショートカット文字列は表示のみ(<see cref="ToolStripMenuItem.ShortcutKeyDisplayString"/>)。
    ///   実際のキー処理はJS側(commands.js の bindShortcuts)が行っているため、
    ///   <see cref="ToolStripMenuItem.ShortcutKeys"/>は一切設定しない(二重に効くのを防ぐため)。
    /// ・項目が画面の高さを超える場合の折り返し・スクロール矢印表示は
    ///   <see cref="ToolStripDropDownMenu"/>の既定の挙動に任せる(MaximumSize等は設定しない)。
    /// ・項目を選ぶと<paramref name="onCommand"/>(id)を、選ばずに閉じると<paramref name="onClosed"/>を
    ///   呼ぶ(どちらか一方だけが必ず1回呼ばれる)。
    /// </summary>
    /// <summary>いま表示しているポップアップ。WebView2の中(本文・ステータスバー)がクリック
    /// されたときは、ポップアップ側からはそれを検知できないため、JS側から close-menu を
    /// 受け取ってここから閉じる。</summary>
    private static ToolStripDropDown? _current;

    /// <summary>開いているポップアップがあれば閉じる。無ければ何もしない。</summary>
    public static void CloseCurrent()
    {
        ToolStripDropDown? current = _current;
        _current = null;
        try { current?.Close(); }
        catch (Exception ex) { Logger.WriteException("NativeMenu.CloseCurrent失敗", ex); }
    }

    /// <summary>
    /// メニューバーのホバー切り替え(ユーザー要望: クリックしなくても隣の見出しへ切り替わる)用。
    /// <paramref name="onMouseMove"/>を渡すと、表示中のポップアップが受け取るマウス移動を
    /// 画面座標に変換して都度通知する。<see cref="ToolStripDropDown"/>は表示中マウスを
    /// キャプチャする(下記Showのコメント参照)ため、この移動通知はポップアップの外・画面の
    /// どこにカーソルがあっても発火する。判定(どの見出しの上か)・遅延・実際の切り替えは
    /// すべて呼び出し側(<see cref="MainForm"/>・src/commands.js)の責務とし、ここでは一切持たない
    /// (コマンドの実装はここに持たせない、というこのクラスの原則と同じ)。
    /// </summary>
    public static void Show(
        Point screenLocation,
        bool isDark,
        string? themeId,
        IReadOnlyList<MenuItemData> items,
        Action<string> onCommand,
        Action onClosed,
        Action<Point>? onMouseMove = null)
    {
        var renderer = new PaneMenuRenderer(isDark, themeId);
        var dropDown = new ToolStripDropDownMenu
        {
            Renderer = renderer,
            ShowImageMargin = true, // チェックマーク用の左マージン(HTML版の.menu-item-checkに相当)
            ShowCheckMargin = false,
        };

        // 項目を選んだ場合はonCommandを呼ぶが、Closedイベントは選択の有無に関わらず必ず発火する
        // (ToolStripの仕様)。選択済みかどうかをここで覚えておき、Closed時にonClosedを二重に
        // 呼ばないようにする。
        bool commandFired = false;

        void AddItems(ToolStripDropDown target, IReadOnlyList<MenuItemData> data)
        {
            foreach (MenuItemData item in data)
            {
                var menuItem = new ToolStripMenuItem(item.Label)
                {
                    Enabled = item.Enabled,
                    Checked = item.Checked,
                    ShowShortcutKeys = !string.IsNullOrEmpty(item.Shortcut),
                    ShortcutKeyDisplayString = string.IsNullOrEmpty(item.Shortcut) ? null : item.Shortcut,
                };
                if (!string.IsNullOrEmpty(item.Note))
                {
                    // note(「Pandoc未導入」等)の表示は最小対応としてツールチップに入れる。
                    menuItem.ToolTipText = item.Note;
                }

                if (item.Submenu is { Count: > 0 } submenu)
                {
                    // 「最近使ったファイル」のような入れ子。DropDownはToolStripMenuItemが
                    // 初回アクセス時に自動生成する(既定でToolStripDropDownMenu)。
                    if (menuItem.DropDown is ToolStripDropDownMenu subMenu)
                    {
                        subMenu.Renderer = renderer;
                        subMenu.ShowImageMargin = dropDown.ShowImageMargin;
                        subMenu.ShowCheckMargin = dropDown.ShowCheckMargin;
                    }
                    AddItems(menuItem.DropDown, submenu);
                }
                else if (item.Id is not null)
                {
                    string id = item.Id;
                    menuItem.Click += (_, _) =>
                    {
                        commandFired = true;
                        onCommand(id);
                    };
                }

                target.Items.Add(menuItem);
                if (item.SeparatorAfter)
                {
                    target.Items.Add(new ToolStripSeparator());
                }
            }
        }

        AddItems(dropDown, items);

        if (onMouseMove is not null)
        {
            // ToolStripDropDownは表示中(Show後)マウスをキャプチャするため(Windowsの
            // メニュー全般の既定動作。画面のどこをクリックしても「メニューの外へのクリック」を
            // 検知できるようにするための挙動)、MouseMoveは画面全体で発火する。逆に言うと
            // この間、WebView2側は(ポップアップの真上にカーソルがあろうがなかろうが)
            // マウスメッセージを一切受け取れない。e.Locationはポップアップのクライアント座標
            // (カーソルがポップアップの外にあれば負値・外側の値になる)なので、呼び出し側が
            // 使いやすいよう画面座標へ変換してから渡す。
            dropDown.MouseMove += (_, e) => onMouseMove(dropDown.PointToScreen(e.Location));
        }

        dropDown.Closed += (_, _) =>
        {
            if (ReferenceEquals(_current, dropDown)) _current = null;
            if (!commandFired) onClosed();
        };

        // メニューの文字はWindowsのメニューフォントに合わせつつ、わずかに大きくする
        // (既定のままだと本文やメニューバーの文字に対して小さく見えるため)。
        try
        {
            Font baseFont = SystemFonts.MenuFont ?? Control.DefaultFont;
            dropDown.Font = new Font(baseFont.FontFamily, baseFont.SizeInPoints + 0.5f, baseFont.Style);
        }
        catch (Exception ex)
        {
            Logger.WriteException("NativeMenu: メニューフォントの設定に失敗", ex);
        }

        // 同時に開くポップアップは常に1つだけにする。見出しを連打したときに
        // ポップアップが積み重なって消すのに手間取る、という状態を防ぐ。
        CloseCurrent();
        _current = dropDown;
        dropDown.Show(screenLocation, ToolStripDropDownDirection.BelowRight);
    }
}

/// <summary>
/// <see cref="NativeMenu"/>用の配色レンダラー。<see cref="ToolStripRenderer"/>は既定では
/// 何も描画しない(各OnRenderXは空実装。実際の描画はRenderer側が担う設計のため)ため、
/// ここで必要な要素をすべて手描きする。
///
/// 色はPane/WindowChrome.csが持っているライト/ダークの定数と同じ考え方で、
/// src/style.css・src/themes.cssの実際の値に合わせている(色の対応表は最終報告に記載)。
///
/// 【実バグ3の修正】以前はisDark(ライト/ダークの2値)だけを見て、既定テーマの配色
/// (2パターン)固定で描いていた。そのためユーザーがnord/dracula/night等のテーマ
/// プリセットを選んでいても、ネイティブのドロップダウンだけは常に既定のteal系の色の
/// ままで、実際のテーマ(水色・紫・シアン等)と食い違って見えていた
/// (「メニューホバー時の水色や緑色はテーマと合っていない」という指摘の原因)。
/// isDarkに加えてテーマプリセットID(themeId、main.jsがhtml[data-light-theme]/
/// [data-dark-theme]へ入れているものと同じ値)を受け取り、9テーマぶんの実配色から
/// 選ぶようにした。
/// </summary>
internal sealed class PaneMenuRenderer : ToolStripRenderer
{
    private readonly Color _surface;
    private readonly Color _ink;
    private readonly Color _inkSub;
    private readonly Color _line;
    private readonly Color _rule;
    private readonly Color _accentSoft;
    /// <summary>無効項目の文字色。src/style.cssの.menu-item.disabled { opacity:.5 } と同じ見た目に
    /// なるよう、--ink-subを背景(--surface)へ50%だけ寄せて事前合成しておく(GDIのTextRenderer.DrawText
    /// はアルファ値を正しく合成しないため、あらかじめ不透明色として計算する)。</summary>
    private readonly Color _inkDisabled;
    /// <summary>選択中の項目の文字色。テーマの--accentをそのまま使えるならそれを使うが、
    /// 背景(_accentSoft)とのコントラスト比がWCAG AA(4.5)を割り込むプリセットでは
    /// --ink、それでも足りなければ白/黒へ補正する(PickAccessibleColor参照)。
    /// 「テーマと合っていない色」の修正と「読める配色である」ことの両立のため。</summary>
    private readonly Color _selectedText;
    /// <summary>チェックマークの色。背景は常に_surface(OnRenderImageMargin参照)のため、
    /// それに対してPickAccessibleColorで選ぶ(考え方は_selectedTextと同じ)。</summary>
    private readonly Color _checkColor;

    public PaneMenuRenderer(bool isDark, string? themeId)
    {
        var p = ResolvePalette(isDark, themeId);
        _surface = p.Surface;
        _ink = p.Ink;
        _inkSub = p.InkSub;
        _line = p.Line;
        _rule = p.Rule;
        _accentSoft = p.AccentSoft;
        _inkDisabled = Blend(_inkSub, _surface, 0.5);
        _selectedText = PickAccessibleColor(_accentSoft, p.Accent, _ink);
        _checkColor = PickAccessibleColor(_surface, p.Accent, _ink);
    }

    private readonly record struct Palette(Color Surface, Color Ink, Color InkSub, Color Line, Color Rule, Color Accent, Color AccentSoft);

    /// <summary>
    /// isDark・themeIdから配色を選ぶ。値はsrc/style.css(既定ライト/ダーク)・
    /// src/themes.css(7プリセット)の実値をそのまま転記したもの(9テーマぶん)。
    /// 未知のthemeId("default"含む)はisDarkに応じた既定配色にフォールバックする。
    /// </summary>
    private static Palette ResolvePalette(bool isDark, string? themeId) => (isDark, themeId) switch
    {
        // ---- ダーク側プリセット(src/themes.css) ----
        (true, "nord") => new(
            ColorTranslator.FromHtml("#3B4252"), ColorTranslator.FromHtml("#ECEFF4"), ColorTranslator.FromHtml("#D8DEE9"),
            ColorTranslator.FromHtml("#434C5E"), ColorTranslator.FromHtml("#434C5E"),
            ColorTranslator.FromHtml("#88C0D0"), ColorTranslator.FromHtml("#3B4A52")),
        (true, "dracula") => new(
            ColorTranslator.FromHtml("#343746"), ColorTranslator.FromHtml("#F8F8F2"), ColorTranslator.FromHtml("#B4B9D6"),
            ColorTranslator.FromHtml("#44475A"), ColorTranslator.FromHtml("#44475A"),
            ColorTranslator.FromHtml("#BD93F9"), ColorTranslator.FromHtml("#3B3D52")),
        (true, "solarized-dark") => new(
            ColorTranslator.FromHtml("#073642"), ColorTranslator.FromHtml("#93A1A1"), ColorTranslator.FromHtml("#839496"),
            ColorTranslator.FromHtml("#0A3C4A"), ColorTranslator.FromHtml("#0A3C4A"),
            ColorTranslator.FromHtml("#268BD2"), ColorTranslator.FromHtml("#0E4B5E")),
        (true, "night") => new(
            ColorTranslator.FromHtml("#2E3033"), ColorTranslator.FromHtml("#b8bfc6"), ColorTranslator.FromHtml("#838A92"),
            ColorTranslator.FromHtml("#555555"), ColorTranslator.FromHtml("#555555"),
            ColorTranslator.FromHtml("#6dc1e7"), ColorTranslator.FromHtml("#3C4851")),
        // ---- ライト側プリセット(src/themes.css) ----
        (false, "sepia") => new(
            ColorTranslator.FromHtml("#FBF3E3"), ColorTranslator.FromHtml("#3B2F22"), ColorTranslator.FromHtml("#7A6A55"),
            ColorTranslator.FromHtml("#E3D5B8"), ColorTranslator.FromHtml("#E3D5B8"),
            ColorTranslator.FromHtml("#A9762C"), ColorTranslator.FromHtml("#EDE0C0")),
        (false, "github") => new(
            ColorTranslator.FromHtml("#F6F8FA"), ColorTranslator.FromHtml("#1F2328"), ColorTranslator.FromHtml("#59636E"),
            ColorTranslator.FromHtml("#D0D7DE"), ColorTranslator.FromHtml("#D0D7DE"),
            ColorTranslator.FromHtml("#0969DA"), ColorTranslator.FromHtml("#DDF4FF")),
        (false, "solarized-light") => new(
            ColorTranslator.FromHtml("#EEE8D5"), ColorTranslator.FromHtml("#073642"), ColorTranslator.FromHtml("#657B83"),
            ColorTranslator.FromHtml("#D3CBB7"), ColorTranslator.FromHtml("#D3CBB7"),
            ColorTranslator.FromHtml("#268BD2"), ColorTranslator.FromHtml("#E3EFFA")),
        // ---- 既定(プリセット無し。src/style.css) ----
        (true, _) => new(
            ColorTranslator.FromHtml("#1C2226"), ColorTranslator.FromHtml("#E4E7E5"), ColorTranslator.FromHtml("#93A0A8"),
            ColorTranslator.FromHtml("#2C343A"), ColorTranslator.FromHtml("#242A2E"),
            ColorTranslator.FromHtml("#6FB3A8"), ColorTranslator.FromHtml("#1E2C2B")),
        (false, _) => new(
            ColorTranslator.FromHtml("#FFFFFF"), ColorTranslator.FromHtml("#1F2428"), ColorTranslator.FromHtml("#66707A"),
            ColorTranslator.FromHtml("#DCE2E0"), ColorTranslator.FromHtml("#E4E7E6"),
            ColorTranslator.FromHtml("#2F6F68"), ColorTranslator.FromHtml("#E1EFED")),
    };

    private static Color Blend(Color fg, Color bg, double fgRatio)
    {
        int r = (int)Math.Round(fg.R * fgRatio + bg.R * (1 - fgRatio));
        int g = (int)Math.Round(fg.G * fgRatio + bg.G * (1 - fgRatio));
        int b = (int)Math.Round(fg.B * fgRatio + bg.B * (1 - fgRatio));
        return Color.FromArgb(r, g, b);
    }

    /// <summary>sRGB相対輝度(WCAG方式)。src/main.jsのrelativeLuminance()と同じ式。</summary>
    private static double RelativeLuminance(Color c)
    {
        double Chan(byte v)
        {
            double x = v / 255.0;
            return x <= 0.04045 ? x / 12.92 : Math.Pow((x + 0.055) / 1.055, 2.4);
        }
        return 0.2126 * Chan(c.R) + 0.7152 * Chan(c.G) + 0.0722 * Chan(c.B);
    }

    /// <summary>WCAGのコントラスト比((明るい方+0.05)/(暗い方+0.05))。</summary>
    private static double ContrastRatio(Color a, Color b)
    {
        double la = RelativeLuminance(a) + 0.05;
        double lb = RelativeLuminance(b) + 0.05;
        return la > lb ? la / lb : lb / la;
    }

    /// <summary>実バグ3の安全策(src/main.jsのタイトルバー向け補正と同じ考え方):
    /// 背景(background)に対して、候補(candidates、優先順)のうち最初にWCAG AA(4.5)を
    /// 満たす色を返す。テーマの--accentをそのまま使えれば一番良い(選択時に主張色が
    /// 出て「テーマに合っている」と感じられる)ので最優先候補にし、それが読めない
    /// プリセットでは--ink、それでも読めなければ白/黒のうちコントラストが高い方へ
    /// 落とす(最後の砦。ここまで来ることは実際には無い)。</summary>
    private static Color PickAccessibleColor(Color background, params Color[] candidates)
    {
        const double MinContrast = 4.5;
        foreach (Color c in candidates)
        {
            if (ContrastRatio(c, background) >= MinContrast) return c;
        }
        double white = ContrastRatio(Color.White, background);
        double black = ContrastRatio(Color.Black, background);
        return white >= black ? Color.White : Color.Black;
    }

    /// <summary>ポップアップの背景(src/style.css .menu-dropdown { background: var(--surface) }相当)。</summary>
    protected override void OnRenderToolStripBackground(ToolStripRenderEventArgs e)
    {
        e.Graphics.Clear(_surface);
    }

    /// <summary>ポップアップの枠線(.menu-dropdown { border: 1px solid var(--line) }相当)。</summary>
    protected override void OnRenderToolStripBorder(ToolStripRenderEventArgs e)
    {
        Rectangle rect = e.ToolStrip.ClientRectangle;
        rect.Width -= 1;
        rect.Height -= 1;
        using var pen = new Pen(_line);
        e.Graphics.DrawRectangle(pen, rect);
    }

    /// <summary>チェックマーク用の左マージンもポップアップ本体と同じ背景色にする。</summary>
    protected override void OnRenderImageMargin(ToolStripRenderEventArgs e)
    {
        using var brush = new SolidBrush(_surface);
        e.Graphics.FillRectangle(brush, e.AffectedBounds);
    }

    /// <summary>項目の背景(既定は--surfaceのまま。ホバー時のみ.menu-item:hover相当の--accent-soft)。</summary>
    protected override void OnRenderMenuItemBackground(ToolStripItemRenderEventArgs e)
    {
        var bounds = new Rectangle(Point.Empty, e.Item.Size);
        bool hovered = e.Item.Enabled && e.Item.Selected;
        using var brush = new SolidBrush(hovered ? _accentSoft : _surface);
        e.Graphics.FillRectangle(brush, bounds);
    }

    /// <summary>区切り線(.menu-separator { background: var(--rule) }相当)。</summary>
    protected override void OnRenderSeparator(ToolStripSeparatorRenderEventArgs e)
    {
        var bounds = new Rectangle(Point.Empty, e.Item.Size);
        using var bgBrush = new SolidBrush(_surface);
        e.Graphics.FillRectangle(bgBrush, bounds);
        using var pen = new Pen(_rule);
        int y = bounds.Height / 2;
        e.Graphics.DrawLine(pen, bounds.Left + 4, y, bounds.Right - 4, y);
    }

    /// <summary>
    /// 項目の文字色・ショートカット文字列の色。
    /// ToolStripMenuItemは1項目につき本文とショートカット文字列とで、このメソッドを
    /// (テキストと描画矩形を変えて)2回呼び出す。ショートカット文字列側はitem.Textと一致しない
    /// ため、この比較でどちらの呼び出しかを判別する。
    ///   本文(有効・非ホバー)   → --ink
    ///   本文(有効・ホバー)     → --accent(.menu-item:hover相当)
    ///   本文(無効)             → --ink-subを--surfaceへ50%寄せた色(.menu-item.disabled { opacity:.5 }相当)
    ///   ショートカット文字列   → --ink-sub(.menu-item-shortcut相当。無効時は本文と同じ薄い色)
    /// </summary>
    protected override void OnRenderItemText(ToolStripItemTextRenderEventArgs e)
    {
        bool isShortcut = !string.Equals(e.Text, e.Item.Text, StringComparison.Ordinal);
        Color color;
        if (!e.Item.Enabled)
        {
            color = _inkDisabled;
        }
        else if (isShortcut)
        {
            color = _inkSub;
        }
        else if (e.Item.Selected)
        {
            color = _selectedText;
        }
        else
        {
            color = _ink;
        }

        TextFormatFlags flags = TextFormatFlags.VerticalCenter | TextFormatFlags.SingleLine | TextFormatFlags.EndEllipsis;
        flags |= isShortcut ? TextFormatFlags.Right : TextFormatFlags.Left;
        TextRenderer.DrawText(e.Graphics, e.Text, e.TextFont, e.TextRectangle, color, flags);
    }

    /// <summary>チェックマーク(.menu-item-check「✓」相当。色は--accent)。</summary>
    protected override void OnRenderItemCheck(ToolStripItemImageRenderEventArgs e)
    {
        Rectangle bounds = e.ImageRectangle;
        if (bounds.Width <= 0 || bounds.Height <= 0) return;

        var oldSmoothing = e.Graphics.SmoothingMode;
        e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;
        using var pen = new Pen(_checkColor, 2f) { StartCap = LineCap.Round, EndCap = LineCap.Round, LineJoin = LineJoin.Round };
        int x = bounds.X, y = bounds.Y, w = bounds.Width, h = bounds.Height;
        Point p1 = new(x + (int)(w * 0.2), y + (int)(h * 0.55));
        Point p2 = new(x + (int)(w * 0.42), y + (int)(h * 0.75));
        Point p3 = new(x + (int)(w * 0.8), y + (int)(h * 0.3));
        e.Graphics.DrawLines(pen, new[] { p1, p2, p3 });
        e.Graphics.SmoothingMode = oldSmoothing;
    }

    /// <summary>サブメニュー(「最近使ったファイル」)の▶矢印。文字色に合わせる。</summary>
    protected override void OnRenderArrow(ToolStripArrowRenderEventArgs e)
    {
        using var brush = new SolidBrush(e.Item?.Enabled != false ? _ink : _inkDisabled);
        var oldSmoothing = e.Graphics.SmoothingMode;
        e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;
        // ArrowRectangle をそのまま使うと三角が大きくなりすぎるため、中央に小さく描く
        // (文字の高さに対して控えめな大きさにする)。
        Rectangle r = e.ArrowRectangle;
        int size = Math.Max(4, Math.Min(7, r.Height / 2));
        int cx = r.Left + r.Width / 2;
        int cy = r.Top + r.Height / 2;
        Rectangle bounds = new(cx - size / 2, cy - size, size, size * 2);
        Point p1 = new(bounds.Left, bounds.Top);
        Point p2 = new(bounds.Left, bounds.Bottom);
        Point p3 = new(bounds.Right, bounds.Top + bounds.Height / 2);
        e.Graphics.FillPolygon(brush, new[] { p1, p2, p3 });
        e.Graphics.SmoothingMode = oldSmoothing;
    }
}
