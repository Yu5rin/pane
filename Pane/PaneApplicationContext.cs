namespace Pane;

/// <summary>
/// 複数ウィンドウを1プロセス内で管理する(仕様書 第8.1節)。
/// 既定は1ウィンドウ=1ファイル。新規ウィンドウは名前付きパイプ経由の要求も含め、
/// すべてこのクラスの <see cref="OpenWindow"/> を通って作られる。
/// ウィンドウ位置・サイズは(ファイルごとではなく)アプリ全体で1組だけ記憶し、
/// 2つ目以降のウィンドウはそこから少しずつずらして(カスケード)配置する。
/// </summary>
internal sealed class PaneApplicationContext : ApplicationContext
{
    private const int CascadeOffset = 28;
    private const int DefaultWidth = 960;
    private const int DefaultHeight = 720;

    private readonly List<MainForm> _windows = new();
    private readonly AppSettings _settings;

    public PaneApplicationContext(string? cliInitialPath)
    {
        _settings = SettingsService.Load();

        var openedPaths = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        bool openedAny = false;

        // 1. 異常終了からのリカバリー提案(仕様書 N-06)。
        //    Ctrl+Sの明示保存が成功した時点でスナップショットは破棄されるため、
        //    起動時に残っているスナップショットがあるのは前回が異常終了した印。
        foreach ((Guid windowId, AutoSaveSnapshot snapshot) in AutoSaveService.FindOrphanedSnapshots())
        {
            string label = snapshot.OriginalPath ?? "無題のドキュメント";
            DialogResult choice = MessageBox.Show(
                $"前回のPaneは正常に終了しませんでした。\n未保存の内容を復元しますか?\n\n{label}",
                "Pane - 復元の確認",
                MessageBoxButtons.YesNo,
                MessageBoxIcon.Warning);

            if (choice == DialogResult.Yes)
            {
                OpenWindow(snapshot.OriginalPath, snapshot);
                openedAny = true;
                if (snapshot.OriginalPath is not null) openedPaths.Add(snapshot.OriginalPath);
            }
            // 復元元の古いスナップショットファイルは、いいえの場合はここで、
            // はいの場合は復元後のウィンドウが新しいGuidで新規に書き直すか、
            // 次回の明示保存成功時に削除されるため、ここで明示的に消す。
            AutoSaveService.DeleteSnapshot(windowId);
        }

        // 2. コマンドライン引数 > セッション復元 > 空文書、の優先順位で起動時のウィンドウを開く。
        if (cliInitialPath is not null)
        {
            if (openedPaths.Add(cliInitialPath))
            {
                OpenWindow(cliInitialPath);
                openedAny = true;
            }
        }
        else if (_settings.StartupBehavior == "restoreSession" && _settings.OpenFilePaths.Count > 0)
        {
            foreach (string path in _settings.OpenFilePaths)
            {
                if (!File.Exists(path)) continue;
                if (!openedPaths.Add(path)) continue;
                OpenWindow(path);
                openedAny = true;
            }
        }

        if (!openedAny)
        {
            OpenWindow(null);
        }
    }

    /// <summary>
    /// 新しいウィンドウを開く。多重起動時の名前付きパイプ経由の要求(path=nullならアクティブ化のみ、
    /// 実際には新規ウィンドウとして扱う)からも、起動時の複数ファイルオープンからも、ここを通る。
    /// UIスレッド上で呼び出すこと(<see cref="SingleInstanceServer"/> はSynchronizationContext経由で保証する)。
    /// </summary>
    public void OpenWindow(string? path, AutoSaveSnapshot? recoverFrom = null)
    {
        var form = new MainForm(path, recoverFrom, requestNewWindow: p => OpenWindow(p));

        int width = _settings.WindowWidth ?? DefaultWidth;
        int height = _settings.WindowHeight ?? DefaultHeight;
        form.Width = width;
        form.Height = height;

        if (_settings.WindowX is int baseX && _settings.WindowY is int baseY)
        {
            int offset = _windows.Count * CascadeOffset;
            Rectangle area = Screen.FromPoint(new Point(baseX, baseY)).WorkingArea;
            int x = baseX + offset;
            int y = baseY + offset;
            if (x + width > area.Right) x = area.Left + (offset % Math.Max(1, area.Width - width));
            if (y + height > area.Bottom) y = area.Top + (offset % Math.Max(1, area.Height - height));
            form.StartPosition = FormStartPosition.Manual;
            form.Location = new Point(x, y);
        }
        else
        {
            form.StartPosition = FormStartPosition.WindowsDefaultLocation;
        }

        form.FormClosing += (_, _) =>
        {
            if (form.WindowState == FormWindowState.Normal)
            {
                _settings.WindowX = form.Location.X;
                _settings.WindowY = form.Location.Y;
                _settings.WindowWidth = form.Width;
                _settings.WindowHeight = form.Height;
            }
        };
        form.FormClosed += (_, _) => OnWindowClosed(form);

        _windows.Add(form);
        form.Show();
    }

    private void OnWindowClosed(MainForm form)
    {
        bool isLastWindow = _windows.Count == 1 && _windows[0] == form;
        if (isLastWindow)
        {
            // アプリ全体としての終了。次回のセッション復元用に、開いていたファイルパスを保存する
            // (仕様書 N-07: 復元スコープはファイルパスのみ、スクロール位置等は含めない)。
            _settings.OpenFilePaths = _windows
                .Where(w => w.CurrentPath is not null)
                .Select(w => w.CurrentPath!)
                .ToList();
        }

        _windows.Remove(form);

        if (_windows.Count == 0)
        {
            SettingsService.Save(_settings);
            ExitThread();
        }
    }
}
