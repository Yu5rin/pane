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
    public static void Show(
        Point screenLocation,
        bool isDark,
        IReadOnlyList<MenuItemData> items,
        Action<string> onCommand,
        Action onClosed)
    {
        var renderer = new PaneMenuRenderer(isDark);
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

        dropDown.Closed += (_, _) =>
        {
            if (!commandFired) onClosed();
        };

        dropDown.Show(screenLocation, ToolStripDropDownDirection.BelowRight);
    }
}

/// <summary>
/// <see cref="NativeMenu"/>用の配色レンダラー。<see cref="ToolStripRenderer"/>は既定では
/// 何も描画しない(各OnRenderXは空実装。実際の描画はRenderer側が担う設計のため)ため、
/// ここで必要な要素をすべて手描きする。
///
/// 色はPane/WindowChrome.csが持っているライト/ダークの定数と同じ考え方で、
/// src/style.cssの実際の値に合わせている(色の対応表は最終報告に記載)。
/// </summary>
internal sealed class PaneMenuRenderer : ToolStripRenderer
{
    private readonly Color _surface;
    private readonly Color _ink;
    private readonly Color _inkSub;
    private readonly Color _line;
    private readonly Color _rule;
    private readonly Color _accent;
    private readonly Color _accentSoft;
    /// <summary>無効項目の文字色。src/style.cssの.menu-item.disabled { opacity:.5 } と同じ見た目に
    /// なるよう、--ink-subを背景(--surface)へ50%だけ寄せて事前合成しておく(GDIのTextRenderer.DrawText
    /// はアルファ値を正しく合成しないため、あらかじめ不透明色として計算する)。</summary>
    private readonly Color _inkDisabled;

    public PaneMenuRenderer(bool isDark)
    {
        if (isDark)
        {
            // src/style.css html[data-theme="dark"] の実値(:rootの2つ目のブロックが最終的に
            // 効いている値。Pane/WindowChrome.csのコメントと同じ考え方)。
            _surface = ColorTranslator.FromHtml("#1C2226");
            _ink = ColorTranslator.FromHtml("#E4E7E5");
            _inkSub = ColorTranslator.FromHtml("#93A0A8");
            _line = ColorTranslator.FromHtml("#2C343A");
            _rule = ColorTranslator.FromHtml("#242A2E");
            _accent = ColorTranslator.FromHtml("#6FB3A8");
            _accentSoft = ColorTranslator.FromHtml("#1E2C2B");
        }
        else
        {
            // src/style.css :root の実値。
            _surface = ColorTranslator.FromHtml("#FFFFFF");
            _ink = ColorTranslator.FromHtml("#1F2428");
            _inkSub = ColorTranslator.FromHtml("#66707A");
            _line = ColorTranslator.FromHtml("#DCE2E0");
            _rule = ColorTranslator.FromHtml("#E4E7E6");
            _accent = ColorTranslator.FromHtml("#2F6F68");
            _accentSoft = ColorTranslator.FromHtml("#E1EFED");
        }
        _inkDisabled = Blend(_inkSub, _surface, 0.5);
    }

    private static Color Blend(Color fg, Color bg, double fgRatio)
    {
        int r = (int)Math.Round(fg.R * fgRatio + bg.R * (1 - fgRatio));
        int g = (int)Math.Round(fg.G * fgRatio + bg.G * (1 - fgRatio));
        int b = (int)Math.Round(fg.B * fgRatio + bg.B * (1 - fgRatio));
        return Color.FromArgb(r, g, b);
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
            color = _accent;
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
        using var pen = new Pen(_accent, 2f) { StartCap = LineCap.Round, EndCap = LineCap.Round, LineJoin = LineJoin.Round };
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
        Rectangle bounds = e.ArrowRectangle;
        Point p1 = new(bounds.Left, bounds.Top);
        Point p2 = new(bounds.Left, bounds.Bottom);
        Point p3 = new(bounds.Right, bounds.Top + bounds.Height / 2);
        e.Graphics.FillPolygon(brush, new[] { p1, p2, p3 });
        e.Graphics.SmoothingMode = oldSmoothing;
    }
}
