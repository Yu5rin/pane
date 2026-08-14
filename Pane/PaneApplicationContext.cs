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

    /// <summary>設定画面(独立ウィンドウ)。同時に1つしか開かないため単一の参照で持つ。
    /// <see cref="_windows"/>には含めない(ウィンドウ数の勘定・終了判定の対象外にするため。
    /// 詳細は<see cref="OpenSettingsWindow"/>と<see cref="OnWindowClosed"/>を参照)。</summary>
    private SettingsWindow? _settingsWindow;

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
            // この時点ではまだ本体ウィンドウが1つも無い(起動直後)ため、オーナー無しで表示する
            // (PaneDialog.Show側は画面中央にフォールバックする)。
            DialogResult choice = PaneDialog.Show(
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
            // タブ形式(仕様書 第2.10節 C-14、隠し設定)のときは、前回終了時に開いていた
            // 全パスを1つのウィンドウへまとめてタブとして復元する(ウィンドウ形式では
            // 従来どおりパスごとに別ウィンドウを開く)。1件目はOpenWindowで最初のウィンドウを
            // 作り、以後はそのウィンドウのOpenWindow内タブ振り分け(_windows.Count > 0)に
            // 自然に乗るため、2件目以降も同じOpenWindow呼び出しで構わない。
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
        // コマンドライン引数・多重起動時のパイプ経由でフォルダのパスが渡された場合
        // (仕様書 F-14: `Pane.exe <folder>`)。pathをそのままファイルとして読もうとすると
        // TextFileService.Load(File.ReadAllBytes)が失敗するため、フォルダを開く既存の経路
        // (initialFolderPath、サイドバーで開く)へ転送する。復元・ドロップ経由(pathがファイル
        // であることが確定している)はこの判定の対象外にする。
        if (path is not null && recoverFrom is null && droppedFile is null && initialFolderPath is null && Directory.Exists(path))
        {
            Logger.Write($"OpenWindow: 起動引数がフォルダのためフォルダとして開く: {path}");
            OpenWindow(null, initialFolderPath: path);
            return;
        }

        // タブ形式(仕様書 第2.10節 C-14、隠し設定): 既存のウィンドウがあれば新規ウィンドウを
        // 作らず、そちらへ新しいタブとして開くよう依頼する(ユーザー指示:
        // 「ファイルを開く要求は新しいウィンドウではなく既存ウィンドウの新しいタブへ送る」)。
        // 異常終了からの復元(recoverFrom)・起動時のカスタムフォルダ(initialFolderPath)は
        // タブ1枚には収まらない情報のため対象外とし、従来どおり新規ウィンドウを作る。
        // 起動直後(_windows.Count==0)は当然対象外(振り分け先が無いため)。
        if (_settings.DisplayMode == "tab" && recoverFrom is null && initialFolderPath is null && _windows.Count > 0)
        {
            MainForm target = _windows[^1];
            target.OpenInNewTab(path);
            if (target.WindowState == FormWindowState.Minimized) target.WindowState = FormWindowState.Normal;
            target.Activate();
            Logger.Write($"OpenWindow: タブ形式のため既存ウィンドウへ新しいタブとして開く(path={path ?? "(なし)"})");
            return;
        }

        var form = new MainForm(
            path,
            recoverFrom,
            requestNewWindow: p => OpenWindow(p),
            requestNewWindowWithContent: content => OpenWindow(null, null, content),
            requestSwitchDocument: SwitchToNextWindow,
            requestBroadcastSettings: BroadcastSettingsChanged,
            requestOpenSettingsWindow: OpenSettingsWindow,
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
            // 右・下方向のはみ出し補正(元からある処理。カスケード配置がウィンドウの外に出ないように)。
            if (x + width > area.Right) x = area.Left + (offset % Math.Max(1, area.Width - width));
            if (y + height > area.Bottom) y = area.Top + (offset % Math.Max(1, area.Height - height));
            // 左・上方向のはみ出し補正(右・下方向しか見ていなかった不具合の修正)。設定ファイルの
            // 破損や、多モニタ環境で外部ディスプレイを外した後にその副モニタ側の座標が
            // 保存されたままだったりすると、baseX/baseYが大きく負の値になりうる。
            if (x < area.Left) x = area.Left;
            if (y < area.Top) y = area.Top;

            var candidate = new Rectangle(x, y, width, height);
            // 上の補正だけでは救えないケース(例: Screen.FromPointが返した画面自体が既に
            // 現在のモニタ構成に存在しない等)に備え、最終的な配置がどの画面にも一切
            // 掛かっていない場合は主画面の中央へフォールバックする。
            if (!Screen.AllScreens.Any(s => s.WorkingArea.IntersectsWith(candidate)))
            {
                Rectangle primary = Screen.PrimaryScreen?.WorkingArea ?? area;
                x = primary.Left + Math.Max(0, (primary.Width - width) / 2);
                y = primary.Top + Math.Max(0, (primary.Height - height) / 2);
            }

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
    /// 設定画面(WinForms版・HTML製ブリッジのどちらでも、本体ウィンドウ内モーダル・独立した
    /// <see cref="SettingsWindow"/>のどちらからでも)で設定が保存された後に呼ばれる。
    /// 設定はアプリ全体で共有されるため、開いているすべての本体ウィンドウへ apply-settings を
    /// 再送して反映させる(requestSwitchDocumentと同じ、コールバックとして受け取る流儀)。
    /// 呼び出し元(保存した本人のウィンドウ)を区別する必要が無いため引数は取らない。
    /// </summary>
    private void BroadcastSettingsChanged()
    {
        foreach (MainForm window in _windows)
        {
            window.PostCapabilities();
        }
    }

    /// <summary>
    /// 設定画面(独立ウィンドウ)を開く。<paramref name="owner"/>(呼び出し元のウィンドウ)の
    /// 中央に表示する。既に開いていれば新しく作らず前面に出してフォーカスするだけにする
    /// (同時に1つしか開かない)。
    /// </summary>
    public void OpenSettingsWindow(Form owner)
    {
        if (_settingsWindow is { IsDisposed: false })
        {
            if (_settingsWindow.WindowState == FormWindowState.Minimized)
            {
                _settingsWindow.WindowState = FormWindowState.Normal;
            }
            _settingsWindow.Activate();
            Logger.Write("OpenSettingsWindow: 既に開いているため前面へ");
            return;
        }

        _settingsWindow = new SettingsWindow(owner, BroadcastSettingsChanged);
        _settingsWindow.FormClosed += (_, _) => _settingsWindow = null;
        _settingsWindow.Show();
        Logger.Write("OpenSettingsWindow: 新規に開いた");
    }

    private void OnWindowClosed(MainForm form)
    {
        bool isLastWindow = _windows.Count == 1 && _windows[0] == form;
        List<string>? openFilePaths = null;
        if (isLastWindow)
        {
            // アプリ全体としての終了。次回のセッション復元用に、開いていたファイルパスを保存する
            // (仕様書 N-07: 復元スコープはファイルパスのみ、スクロール位置等は含めない)。
            // タブ形式(第2.10節 C-14)ではGetOpenFilePathsが各ウィンドウの全タブぶんのパスを
            // 返すため、ウィンドウ形式・タブ形式どちらでも同じ呼び出しで正しく集まる。
            openFilePaths = _windows
                .SelectMany(w => w.GetOpenFilePaths())
                .ToList();
        }

        _windows.Remove(form);

        if (_windows.Count == 0)
        {
            // _settingsは起動時に一度読み込んだままのスナップショットのため、そのまま保存すると
            // セッション中に他の経路(テーマ切替・最近使ったファイル・設定ダイアログ等、いずれも
            // 都度SettingsService.Updateで直接ディスクへ書いている)で変更された内容を
            // 上書きして消してしまう。SettingsService.Updateが保存直前にディスクの最新設定を
            // 読み直すため、ここではこのクラスが責務を持つ項目(ウィンドウ位置・サイズ・
            // セッション復元用パス)だけを最新設定へ適用すればよい(Lost Update対策)。
            // quitOnLastWindowClosedはUpdateのmodify内でしか読めない(latestはmodifyの外へ
            // 出せない)ため、後続の分岐で使えるようクロージャで捕まえておく。
            bool quitOnLastWindowClosed = true;
            SettingsService.Update(latest =>
            {
                latest.WindowX = _settings.WindowX;
                latest.WindowY = _settings.WindowY;
                latest.WindowWidth = _settings.WindowWidth;
                latest.WindowHeight = _settings.WindowHeight;
                if (openFilePaths is not null) latest.OpenFilePaths = openFilePaths;
                quitOnLastWindowClosed = latest.QuitOnLastWindowClosed;
            });

            // preload起動の常駐プロセス、またはquitOnLastWindowClosed=falseの場合は、
            // 最後のウィンドウが閉じられてもプロセスを終了させず、再びウィンドウ0枚の待機状態へ
            // 戻る(次にファイルを開くときもWebView2環境のキャッシュを保ったまま高速に開けるため)。
            // 次にOpenWindowFromPipeRequestが呼ばれたときも、既にウィンドウを一度見せた後なので
            // 復元確認は再実行しない(_initialOpenPendingは既にfalse)。
            if (_preload || !quitOnLastWindowClosed)
            {
                string reason = _preload ? "preload起動" : "quitOnLastWindowClosed=false";
                Logger.Write($"最後のウィンドウが閉じられた({reason})。ExitThreadは呼ばず常駐状態へ戻る" +
                    "(設定画面が開いていればそのまま開いた状態を維持する)");
            }
            else
            {
                // アプリ全体を終了する。設定画面はウィンドウ数の勘定に含めていないため
                // (_windowsに含まれない)、開いたままExitThreadすると取り残されてしまう。
                // 明示的に閉じてからスレッドを終了する。
                _settingsWindow?.Close();
                ExitThread();
            }
        }
    }
}
