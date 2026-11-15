namespace Pane;

/// <summary>
/// 通知領域(タスクバーの右端、時計の横)のPaneのアイコン(仕様書 T-01〜T-04)。
/// 判断は<see cref="TrayIconLogic"/>、実際に窓を開く・終了するなどの処理は
/// <see cref="PaneApplicationContext"/>が持ち、ここはアイコンとメニューを出すだけにする。
///
/// ・Paneが動いている間はずっと出す(設定「通知領域にアイコンを表示する」でオフにできる)。T-01
/// ・左クリック: ウィンドウがあれば前面に、無ければ新しい文書を開く。T-02
/// ・右クリック: 新規作成・開く・最近使ったファイル・開いているウィンドウ・設定・取扱説明書・
///   更新の確認・Paneを終了。T-03・T-04
/// メニューの配色は、メニューバーと同じ<see cref="PaneMenuRenderer"/>で、開くたびにその時のテーマで作る。
/// </summary>
internal sealed class TrayIcon : IDisposable
{
    /// <summary>アイコンから頼まれる処理。どれもUIスレッドで呼ばれる。</summary>
    internal sealed record Actions(
        Func<IReadOnlyList<Form>> DocumentWindows,
        Action<string?> OpenDocument,
        Action OpenFileDialog,
        Action<string?> OpenSettings,
        Action OpenHelp,
        Action Quit);

    private readonly NotifyIcon _icon;
    private readonly ContextMenuStrip _menu;
    private readonly Actions _actions;

    public TrayIcon(Actions actions)
    {
        _actions = actions;
        _menu = new ContextMenuStrip();
        // 中身は開くたびに作り直す(最近使ったファイル・開いているウィンドウ・テーマが変わるため)。
        _menu.Opening += (_, e) =>
        {
            try { RebuildMenu(); }
            catch (Exception ex)
            {
                Logger.WriteException("通知領域のメニューの作成に失敗", ex);
                e.Cancel = true;
            }
        };
        _icon = new NotifyIcon
        {
            Icon = AppIcon.Create() ?? SystemIcons.Application,
            Text = TrayIconLogic.Tooltip(0),
            ContextMenuStrip = _menu,
            Visible = false,
        };
        _icon.MouseClick += OnMouseClick;
    }

    /// <summary>出すか消すか(設定「通知領域にアイコンを表示する」)。</summary>
    public bool Visible
    {
        get => _icon.Visible;
        set => _icon.Visible = value;
    }

    /// <summary>乗せたときの説明を、今のウィンドウの数に合わせる。ウィンドウが開いた・閉じたときに呼ぶ。</summary>
    public void Refresh()
    {
        try { _icon.Text = TrayIconLogic.Tooltip(_actions.DocumentWindows().Count); }
        catch (Exception ex) { Logger.WriteException("通知領域のアイコンの説明の更新に失敗", ex); }
    }

    private void OnMouseClick(object? sender, MouseEventArgs e)
    {
        if (e.Button != MouseButtons.Left) return;
        IReadOnlyList<Form> windows = _actions.DocumentWindows();
        switch (TrayIconLogic.DecideLeftClick(windows.Count))
        {
            case TrayIconLogic.LeftClickAction.BringWindowsToFront:
                Logger.Write($"通知領域のアイコン: 左クリックで{windows.Count}個のウィンドウを前面に出す");
                // 最後に出したものがいちばん手前に来る。最後に使っていたもの(一覧の末尾)を最後にする。
                foreach (Form window in windows)
                {
                    if (window.WindowState == FormWindowState.Minimized) window.WindowState = FormWindowState.Normal;
                    WindowChrome.ForceActivate(window);
                }
                break;
            case TrayIconLogic.LeftClickAction.NewDocument:
                Logger.Write("通知領域のアイコン: 左クリックで新しい文書を開く(ウィンドウが無いため)");
                _actions.OpenDocument(null);
                break;
        }
    }

    private void RebuildMenu()
    {
        AppSettings settings = SettingsService.Load();
        bool isDark = MainForm.ResolveIsDarkTheme(settings.Theme);
        var renderer = new PaneMenuRenderer(isDark, MainForm.ResolveThemeId(settings, isDark));
        _menu.Renderer = renderer;
        _menu.ShowImageMargin = false;
        foreach (ToolStripItem old in _menu.Items.Cast<ToolStripItem>().ToList()) old.Dispose();
        _menu.Items.Clear();

        ToolStripMenuItem Item(string label, Action run, bool enabled = true)
        {
            var item = new ToolStripMenuItem(label) { Enabled = enabled };
            item.Click += (_, _) => Run(label, run);
            return item;
        }

        _menu.Items.Add(Item("新規作成", () => _actions.OpenDocument(null)));
        _menu.Items.Add(Item("開く…", _actions.OpenFileDialog));

        var recent = new ToolStripMenuItem("最近使ったファイル");
        List<string> recentFiles = TrayIconLogic.RecentFileEntries(settings.RecentFiles);
        if (recentFiles.Count == 0) recent.Enabled = false;
        foreach (string path in recentFiles)
        {
            recent.DropDownItems.Add(Item(path.Replace("&", "&&"), () => _actions.OpenDocument(path)));
        }
        SetUpSubmenu(recent, renderer);
        _menu.Items.Add(recent);

        _menu.Items.Add(new ToolStripSeparator());

        var windowsItem = new ToolStripMenuItem("開いているウィンドウ");
        IReadOnlyList<Form> windows = _actions.DocumentWindows();
        if (windows.Count == 0) windowsItem.Enabled = false;
        foreach (Form window in windows)
        {
            Form target = window;
            windowsItem.DropDownItems.Add(Item(TrayIconLogic.WindowLabel(target.Text), () =>
            {
                if (target.IsDisposed) return;
                if (target.WindowState == FormWindowState.Minimized) target.WindowState = FormWindowState.Normal;
                WindowChrome.ForceActivate(target);
            }));
        }
        SetUpSubmenu(windowsItem, renderer);
        _menu.Items.Add(windowsItem);

        _menu.Items.Add(new ToolStripSeparator());
        _menu.Items.Add(Item("設定…", () => _actions.OpenSettings(null)));
        _menu.Items.Add(Item("取扱説明書", _actions.OpenHelp));
        // バージョン情報(更新を確認するボタンがある)を開く。ここから直接は通信しない
        // (利用者がボタンを押したときにだけ問い合わせる。仕様書 4.1a)。
        _menu.Items.Add(Item("更新を確認…", () => _actions.OpenSettings("versionInfo")));
        _menu.Items.Add(new ToolStripSeparator());
        _menu.Items.Add(Item("Paneを終了", _actions.Quit));
    }

    private static void SetUpSubmenu(ToolStripMenuItem parent, ToolStripRenderer renderer)
    {
        if (parent.DropDown is ToolStripDropDownMenu sub)
        {
            sub.Renderer = renderer;
            sub.ShowImageMargin = false;
        }
    }

    /// <summary>メニューの項目を実行する。失敗しても常駐しているPaneごと落とさない。</summary>
    private static void Run(string label, Action run)
    {
        Logger.Write($"通知領域のメニュー: {label.Replace("&&", "&")}");
        try { run(); }
        catch (Exception ex) { Logger.WriteException($"通知領域のメニューの実行に失敗({label})", ex); }
    }

    public void Dispose()
    {
        // 消さずに終わると、マウスを乗せるまでアイコンが通知領域に残って見える。
        _icon.Visible = false;
        _icon.Dispose();
        _menu.Dispose();
    }
}
