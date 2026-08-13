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

    /// <summary>--preloadで起動されたプロセスかどうか(B-1)。trueの間は、最後のウィンドウが
    /// 閉じられてもプロセスを終了させず、ウィンドウ0枚の常駐状態へ戻す(OnWindowClosed参照)。
    /// 一度trueになったらプロセスの生存期間中ずっとtrueのまま(常駐プロセスとしての性質)。</summary>
    private readonly bool _preload;

    /// <summary>preload起動直後、まだ一度もウィンドウを見せていない(復元確認・セッション復元が
    /// 未実施の)間だけtrue。名前付きパイプ経由で最初の要求が来た時点でfalseになる。</summary>
    private bool _initialOpenPending;

    public PaneApplicationContext(string? cliInitialPath, bool preload = false)
    {
        _settings = SettingsService.Load();
        _preload = preload;

        if (preload)
        {
            // プリロード起動(B-1): ユーザーが見ていないタイミングで復元確認ダイアログを
            // 出すと不快なため、ここでは一切のダイアログ・セッション復元・ウィンドウ生成を
            // 行わない。ユーザーが実際にファイルを開こうとした瞬間(OpenWindowFromPipeRequest)
            // まで先送りする。
            _initialOpenPending = true;
            Logger.Write("PaneApplicationContext: preload起動 - ウィンドウ0枚のまま待機を開始");

            // WebView2環境を先に生成しておく(B-2)。待機中に済ませておくことで、実際に
            // 最初のウィンドウを開いたときの体感速度が上がる。失敗しても致命的ではなく、
            // 実際にウィンドウを開く際にMainForm.OnLoadAsyncが改めてEnsureEnvironmentAsyncを
            // 呼ぶため、そちらでリトライされる。
            // ApplicationContext.MainForm(継承プロパティ)と型名Pane.MainFormが同名で衝突するため、
            // 名前空間で完全修飾して呼び出す。
            _ = Pane.MainForm.EnsureEnvironmentAsync().ContinueWith(
                t => Logger.WriteException("preload時のWebView2環境の事前生成に失敗", t.Exception!),
                TaskContinuationOptions.OnlyOnFaulted);
            return;
        }

        RunRecoveryAndInitialOpen(cliInitialPath);
    }

    /// <summary>
    /// 起動時(通常起動時はコンストラクタから、preload起動時は最初のウィンドウ要求が来た時点で
    /// <see cref="OpenWindowFromPipeRequest"/> から)呼ぶ、異常終了からのリカバリー提案・
    /// セッション復元・最初のウィンドウを開く処理本体。
    /// </summary>
    private void RunRecoveryAndInitialOpen(string? cliInitialPath)
    {
        var openedPaths = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        bool openedAny = false;

        // 1. 異常終了からのリカバリー提案(仕様書 N-06)。
        //    Ctrl+Sの明示保存が成功した時点でスナップショットは破棄されるため、
        //    起動時に残っているスナップショットがあるのは前回が異常終了した印。
        //    recoverUnsavedDraftsがfalseの場合は、確認ダイアログを出さずスナップショットを破棄する。
        foreach ((Guid windowId, AutoSaveSnapshot snapshot) in AutoSaveService.FindOrphanedSnapshots())
        {
            if (!_settings.RecoverUnsavedDrafts)
            {
                Logger.Write($"復元確認をスキップ(recoverUnsavedDrafts=false): スナップショットを破棄: {snapshot.OriginalPath ?? "無題のドキュメント"}");
                AutoSaveService.DeleteSnapshot(windowId);
                continue;
            }

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

        // 2. コマンドライン引数 > セッション復元 > カスタムフォルダ > 空文書、の優先順位で
        //    起動時のウィンドウを開く。
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
        else if (_settings.StartupBehavior == "customFolder")
        {
            string? folder = _settings.StartupFolderPath;
            if (!string.IsNullOrWhiteSpace(folder) && Directory.Exists(folder))
            {
                Logger.Write($"起動時のカスタムフォルダを読み込む: {folder}");
                OpenWindow(null, initialFolderPath: folder);
                openedAny = true;
            }
            else
            {
                // 指定フォルダが存在しない場合は空文書で起動する(下の!openedAnyフォールバックへ)。
                Logger.Write($"起動時のカスタムフォルダが存在しないため空文書で起動する: {folder ?? "(未設定)"}");
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
    public void OpenWindow(string? path, AutoSaveSnapshot? recoverFrom = null, DroppedFileContent? droppedFile = null, string? initialFolderPath = null)
    {
        var form = new MainForm(
            path,
            recoverFrom,
            requestNewWindow: p => OpenWindow(p),
            requestNewWindowWithContent: content => OpenWindow(null, null, content),
            requestSwitchDocument: SwitchToNextWindow,
            requestBroadcastSettings: BroadcastSettingsChanged,
            droppedFile: droppedFile,
            initialFolderPath: initialFolderPath);

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

    /// <summary>
    /// 名前付きパイプ経由の要求(多重起動時の2つ目以降のプロセスから、または
    /// preload待機中に届いた最初の要求)を受け取る入口。<see cref="Program"/> はここを通す。
    /// preload起動でまだ一度もウィンドウを見せていない場合のみ、ここで初めて
    /// 異常終了からのリカバリー提案・セッション復元を行ってからウィンドウを開く。
    /// それ以外(通常起動後、またはpreloadで既に一度ウィンドウを開いたことがある場合)は
    /// 従来どおり単純に<see cref="OpenWindow"/>を呼ぶ。
    /// </summary>
    public void OpenWindowFromPipeRequest(string? path)
    {
        if (_initialOpenPending)
        {
            _initialOpenPending = false;
            Logger.Write($"preload: 最初のウィンドウ要求を受信(path={path ?? "(なし)"})。復元確認・セッション復元を行う");
            RunRecoveryAndInitialOpen(path);
            return;
        }
        OpenWindow(path);
    }

    /// <summary>
    /// Ctrl+Tab(仕様書 V-11): 開いている他のPaneウィンドウへフォーカスを移す。
    /// ウィンドウ一覧上で自分の次のウィンドウへ、末尾なら先頭へ回る順送り。
    /// ウィンドウが1つしかない場合は何もしない。
    /// </summary>
    private void SwitchToNextWindow(MainForm current)
    {
        if (_windows.Count <= 1) return;
        int index = _windows.IndexOf(current);
        if (index < 0) return;

        MainForm next = _windows[(index + 1) % _windows.Count];
        if (next.WindowState == FormWindowState.Minimized)
        {
            next.WindowState = FormWindowState.Normal;
        }
        next.Activate();
        Logger.Write($"SwitchToNextWindow: {index} -> {_windows.IndexOf(next)}");
    }

    /// <summary>
    /// 設定画面(WinForms版・HTML製ブリッジのどちらでも)で設定が保存された後に呼ばれる。
    /// 設定はアプリ全体で共有されるため、保存した本人のウィンドウだけでなく、開いている
    /// すべてのウィンドウへ apply-settings を再送して反映させる(requestSwitchDocumentと同じ、
    /// MainFormからのコールバックとして受け取る流儀)。
    /// </summary>
    private void BroadcastSettingsChanged(MainForm origin)
    {
        foreach (MainForm window in _windows)
        {
            window.PostCapabilities();
        }
    }

    private void OnWindowClosed(MainForm form)
    {
        bool isLastWindow = _windows.Count == 1 && _windows[0] == form;
        List<string>? openFilePaths = null;
        if (isLastWindow)
        {
            // アプリ全体としての終了。次回のセッション復元用に、開いていたファイルパスを保存する
            // (仕様書 N-07: 復元スコープはファイルパスのみ、スクロール位置等は含めない)。
            openFilePaths = _windows
                .Where(w => w.CurrentPath is not null)
                .Select(w => w.CurrentPath!)
                .ToList();
        }

        _windows.Remove(form);

        if (_windows.Count == 0)
        {
            // _settingsは起動時に一度読み込んだままのスナップショットのため、そのまま保存すると
            // セッション中に他の経路(テーマ切替・最近使ったファイル・設定ダイアログ等、いずれも
            // 都度SettingsService.Load/Saveで直接ディスクへ書いている)で変更された内容を
            // 上書きして消してしまう。保存直前にディスクの最新設定を読み直し、このクラスが
            // 責務を持つ項目(ウィンドウ位置・サイズ・セッション復元用パス)だけを反映する。
            AppSettings latest = SettingsService.Load();
            latest.WindowX = _settings.WindowX;
            latest.WindowY = _settings.WindowY;
            latest.WindowWidth = _settings.WindowWidth;
            latest.WindowHeight = _settings.WindowHeight;
            if (openFilePaths is not null) latest.OpenFilePaths = openFilePaths;
            SettingsService.Save(latest);

            // preload起動の常駐プロセス、またはquitOnLastWindowClosed=falseの場合は、
            // 最後のウィンドウが閉じられてもプロセスを終了させず、再びウィンドウ0枚の待機状態へ
            // 戻る(次にファイルを開くときもWebView2環境のキャッシュを保ったまま高速に開けるため)。
            // 次にOpenWindowFromPipeRequestが呼ばれたときも、既にウィンドウを一度見せた後なので
            // 復元確認は再実行しない(_initialOpenPendingは既にfalse)。
            if (_preload || !latest.QuitOnLastWindowClosed)
            {
                string reason = _preload ? "preload起動" : "quitOnLastWindowClosed=false";
                Logger.Write($"最後のウィンドウが閉じられた({reason})。ExitThreadは呼ばず常駐状態へ戻る");
            }
            else
            {
                ExitThread();
            }
        }
    }
}
