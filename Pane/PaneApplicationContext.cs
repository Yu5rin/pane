using System.Diagnostics;

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

    /// <summary>設定ウィンドウの事前生成(体感速度対策)を始めるまでの待ち時間。起動直後の
    /// 輻輳(本体ウィンドウ自身のWebView2初期化・Navigate)を避けるため、少し間を置いてから
    /// 裏で作り始める。この値自体の妥当性(短すぎ・長すぎ)は実機ログ(SettingsWindow側の
    /// 各段階のタイムスタンプ)を見てから調整する。</summary>
    private const int SettingsPregenerateDelayMs = 2500;

    /// <summary>取扱説明書ウィンドウの事前生成を始めるまでの待ち時間。設定ウィンドウの事前生成
    /// (<see cref="SettingsPregenerateDelayMs"/>)と同時に走らせると起動直後の輻輳が増えるため、
    /// 少しずらして開始する(WebView2環境自体は共有キャッシュのため、2つ目のPrewarmが増やす
    /// コストはEnsureCoreWebView2Async呼び出し程度で小さい)。</summary>
    private const int HelpPregenerateDelayMs = 3500;

    /// <summary>起動時の更新確認(U-06)を始めるまでの待ち時間。起動直後の輻輳に通信を
    /// 混ぜないよう、事前生成(上の2つ)より後ろに置く。案内が数秒遅れて出ても困らない。</summary>
    private const int StartupUpdateCheckDelayMs = 6000;

    private readonly List<MainForm> _windows = new();
    private readonly AppSettings _settings;

    /// <summary>設定画面(独立ウィンドウ)。同時に1つしか開かないため単一の参照で持つ。
    /// <see cref="_windows"/>には含めない(ウィンドウ数の勘定・終了判定の対象外にするため。
    /// 詳細は<see cref="OpenSettingsWindow"/>と<see cref="OnWindowClosed"/>を参照)。
    /// 体感速度対策により、閉じても(ユーザー操作による通常のCloseでは)破棄されず
    /// このフィールドが指したままになる(<see cref="SettingsWindow"/>のクラスコメント参照)。
    /// nullに戻るのはアプリ終了時(<see cref="SettingsWindow.CloseForReal"/>経由)のみ。</summary>
    private SettingsWindow? _settingsWindow;

    /// <summary>取扱説明書ウィンドウ(F1)。<see cref="_settingsWindow"/>と全く同じ流儀
    /// (同時に1つしか開かない・<see cref="_windows"/>のウィンドウ数の勘定に含めない・
    /// 通常のCloseでは破棄せず非表示化のみ)。詳細は<see cref="OpenHelpWindow"/>と
    /// <see cref="OnWindowClosed"/>を参照。</summary>
    private HelpWindow? _helpWindow;

    /// <summary>設定ウィンドウの事前生成を1回だけ・遅延して行うためのワンショットタイマー。
    /// Timerのコールバックはメッセージループ経由でこのオブジェクトを作ったスレッド(UIスレッド)
    /// 上で発火するため、Application.Run()より前(コンストラクタ内)にStartしても安全。
    /// (preload起動時のWebView2環境事前生成と違い、こちらはUIスレッド上でForm/WebView2
    /// コントロールを直接作る必要があるため、Task.ContinueWithでの後続処理は使わない。)</summary>
    private readonly System.Windows.Forms.Timer _settingsPregenerateTimer;

    /// <summary>取扱説明書ウィンドウの事前生成用ワンショットタイマー。<see cref="_settingsPregenerateTimer"/>と
    /// 同じ考え方(UIスレッド上でForm/WebView2コントロールを直接作るため)。</summary>
    private readonly System.Windows.Forms.Timer _helpPregenerateTimer;

    /// <summary>起動時の更新確認(U-06)用ワンショットタイマー。</summary>
    private readonly System.Windows.Forms.Timer _startupUpdateCheckTimer;

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

        // 設定ウィンドウの事前生成(体感速度対策)。preload起動・通常起動のどちらでも同じ
        // タイマーで賄う。preload起動時は下のEnsureEnvironmentAsync(WebView2環境の事前生成)と
        // 並行して走ることになるが、EnsureEnvironmentAsync自体がロックで多重呼び出しに
        // 対応しているため競合しない(SettingsWindow.OnLoadAsyncも同じEnsureEnvironmentAsyncを
        // 呼ぶので、先に完了していればそのままキャッシュを使う)。
        _settingsPregenerateTimer = new System.Windows.Forms.Timer { Interval = SettingsPregenerateDelayMs };
        _settingsPregenerateTimer.Tick += (_, _) =>
        {
            _settingsPregenerateTimer.Stop();
            PregenerateSettingsWindow();
        };
        _settingsPregenerateTimer.Start();

        _helpPregenerateTimer = new System.Windows.Forms.Timer { Interval = HelpPregenerateDelayMs };
        _helpPregenerateTimer.Tick += (_, _) =>
        {
            _helpPregenerateTimer.Stop();
            PregenerateHelpWindow();
        };
        _helpPregenerateTimer.Start();

        _startupUpdateCheckTimer = new System.Windows.Forms.Timer { Interval = StartupUpdateCheckDelayMs };
        _startupUpdateCheckTimer.Tick += (_, _) =>
        {
            _startupUpdateCheckTimer.Stop();
            _ = CheckUpdateOnStartupAsync();
        };
        _startupUpdateCheckTimer.Start();

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
    private void RunRecoveryAndInitialOpen(string? cliInitialPath, bool forceActivate = false)
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
                OpenWindow(snapshot.OriginalPath, snapshot, forceActivate: forceActivate);
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
                OpenWindow(cliInitialPath, forceActivate: forceActivate);
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
                OpenWindow(path, forceActivate: forceActivate);
                openedAny = true;
            }
        }
        else if (_settings.StartupBehavior == "customFolder")
        {
            string? folder = _settings.StartupFolderPath;
            if (!string.IsNullOrWhiteSpace(folder) && Directory.Exists(folder))
            {
                Logger.Write($"起動時のカスタムフォルダを読み込む: {folder}");
                OpenWindow(null, initialFolderPath: folder, forceActivate: forceActivate);
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
            OpenWindow(null, forceActivate: forceActivate);
        }
    }

    /// <summary>
    /// 新しいウィンドウを開く。多重起動時の名前付きパイプ経由の要求(path=nullならアクティブ化のみ、
    /// 実際には新規ウィンドウとして扱う)からも、起動時の複数ファイルオープンからも、ここを通る。
    /// UIスレッド上で呼び出すこと(<see cref="SingleInstanceServer"/> はSynchronizationContext経由で保証する)。
    /// </summary>
    /// <param name="forceActivate">trueの場合、開いた(または既存の)ウィンドウを
    /// <see cref="WindowChrome.ForceActivate"/>で確実に前面化する。名前付きパイプ経由の要求
    /// (<see cref="OpenWindowFromPipeRequest"/>)由来のときだけtrueを渡す。受信側プロセスは
    /// フォアグラウンド権を持たないことがあり(不具合修正: エクスプローラからファイルを
    /// 開いたときにPaneのウィンドウが前面に来ないことがある対策)、通常起動(自プロセスが
    /// ユーザー操作で起動されフォアグラウンド権を持つ)では余計な副作用を避けるため既定はfalse。</param>
    public void OpenWindow(string? path, AutoSaveSnapshot? recoverFrom = null, DroppedFileContent? droppedFile = null, string? initialFolderPath = null, bool forceActivate = false)
    {
        // コマンドライン引数・多重起動時のパイプ経由でフォルダのパスが渡された場合
        // (仕様書 F-14: `Pane.exe <folder>`)。pathをそのままファイルとして読もうとすると
        // TextFileService.Load(File.ReadAllBytes)が失敗するため、フォルダを開く既存の経路
        // (initialFolderPath、サイドバーで開く)へ転送する。復元・ドロップ経由(pathがファイル
        // であることが確定している)はこの判定の対象外にする。
        if (path is not null && recoverFrom is null && droppedFile is null && initialFolderPath is null && Directory.Exists(path))
        {
            Logger.Write($"OpenWindow: 起動引数がフォルダのためフォルダとして開く: {path}");
            OpenWindow(null, initialFolderPath: path, forceActivate: forceActivate);
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
            var tabStopwatch = System.Diagnostics.Stopwatch.StartNew();
            MainForm target = _windows[^1];
            target.OpenInNewTab(path);
            // 不具合修正: 従来はActivate()のみだったため、受信側プロセスにフォアグラウンド権が
            // 無いと前面化が失効することがあった。WindowChrome.ForceActivateへ統一する
            // (最小化復元+Activate+SetForegroundWindow)。通常起動時の呼び出しでも副作用は無い
            // (自プロセスが既にフォアグラウンド権を持つため、単にActivate相当が成功するだけ)。
            WindowChrome.ForceActivate(target);
            // [計測] 仕様書 第8.4節「既存インスタンスへのファイル追加表示 300ms以内」。
            // タブ形式ではウィンドウを作らないため、ここで測れるのは「要求を受けて既存ウィンドウへ
            // 渡し終えるまで」のC#側の処理時間になる(そこから先の描画はJS側で、初回のような
            // 重い初期化は無い)。新しいウィンドウを作る経路のほうは、実際に画面へ出るまでを
            // MainForm.ReadyToUse で測っている。
            PerfWatch.Report("既存ウィンドウへのタブ追加", tabStopwatch.ElapsedMilliseconds, 300);
            Logger.Write($"[計測] 既存ウィンドウへ新しいタブとして開いた: {tabStopwatch.ElapsedMilliseconds}ms (目標300ms以内, path={path ?? "(なし)"})");
            return;
        }

        // [計測] 仕様書 第8.4節の数値目標のうち、これまで測る手立てが無かった2つを記録する。
        //   ・2枚目以降のウィンドウ追加メモリ(目標60MB以内)
        //   ・既存インスタンスへのファイル追加表示(目標300ms以内。パイプ経由の要求が対象)
        // 1枚目は「起動」であってこの目標の対象外なので、2枚目以降だけを見る。
        bool measureAdditionalWindow = _windows.Count > 0;
        long memoryBeforeBytes = measureAdditionalWindow ? MeasureTotalMemoryBytes() : 0;
        var windowStopwatch = measureAdditionalWindow ? System.Diagnostics.Stopwatch.StartNew() : null;

        var form = new MainForm(
            path,
            recoverFrom,
            requestNewWindow: p => OpenWindow(p),
            requestNewWindowWithContent: content => OpenWindow(null, null, content),
            requestSwitchDocument: SwitchToNextWindow,
            requestBroadcastSettings: BroadcastSettingsChanged,
            requestOpenSettingsWindow: (form, category) => OpenSettingsWindow(form, category),
            requestOpenHelpWindow: OpenHelpWindow,
            droppedFile: droppedFile,
            initialFolderPath: initialFolderPath,
            hasUnsavedDocuments: HasUnsavedDocuments,
            shutdownForUpdate: ShutdownForUpdate);

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

        if (measureAdditionalWindow)
        {
            // Show()の直後はまだWebView2の初期化が進行中で、メモリも増え切っていない。
            // 実際に使える状態になってから測るため、そのウィンドウの初期描画完了を待って報告する
            // (MainForm側がinitial-render-readyを受け取った時点でコールバックしてくる)。
            long beforeBytes = memoryBeforeBytes;
            System.Diagnostics.Stopwatch stopwatch = windowStopwatch!;
            form.ReadyToUse += () =>
            {
                long afterBytes = MeasureTotalMemoryBytes();
                long deltaMb = (afterBytes - beforeBytes) / (1024 * 1024);
                Logger.Write($"[計測] {_windows.Count}枚目のウィンドウ: 表示まで{stopwatch.ElapsedMilliseconds}ms, " +
                             $"メモリ増加{deltaMb}MB (目標: 表示300ms以内・メモリ60MB以内。" +
                             $"メモリはPane本体とWebView2の各プロセスの合計。他アプリのWebView2も同じ実行ファイル名のため、" +
                             $"それらが同時に動いていると多めに出る)");
                PerfWatch.Report($"{_windows.Count}枚目のウィンドウの表示", stopwatch.ElapsedMilliseconds, 300);
            };
        }

        // 不具合修正: パイプ要求由来(forceActivate=true)のときだけ、確実な前面化を行う。
        // Show()呼び出しの時点でForm本体のWin32ウィンドウハンドルは既に生成されており、
        // WebView2の初期化(OnLoadAsync/EnsureCoreWebView2Async)は非同期で後から進むため、
        // その完了を待つ必要は無い(タイトルバー等の枠は既に存在し、前面化はハンドル操作
        // だけで完結する)。通常起動(forceActivate=false)では何もせず、Show()自体が
        // 新プロセスの持つフォアグラウンド権で自然にアクティブ化するのに任せる。
        if (forceActivate)
        {
            WindowChrome.ForceActivate(form);
        }
    }

    /// <summary>
    /// 名前付きパイプ経由の要求(多重起動時の2つ目以降のプロセスから、または
    /// preload待機中に届いた最初の要求)を受け取る入口。<see cref="Program"/> はここを通す。
    /// preload起動でまだ一度もウィンドウを見せていない場合のみ、ここで初めて
    /// 異常終了からのリカバリー提案・セッション復元を行ってからウィンドウを開く。
    /// それ以外(通常起動後、またはpreloadで既に一度ウィンドウを開いたことがある場合)は
    /// 従来どおり単純に<see cref="OpenWindow"/>を呼ぶ。
    /// </summary>
    /// <summary>
    /// Pane本体と、WebView2が立てている各プロセスのメモリ使用量(ワーキングセット)の合計。
    ///
    /// WebView2はブラウザプロセス・レンダラプロセスを別プロセスとして立てるため、
    /// 自プロセスの使用量だけを見てもウィンドウを1枚増やした実際のコストは分からない。
    /// 実行ファイル名で拾う都合上、他のアプリが使っているWebView2まで数えてしまうが、
    /// 「ウィンドウを開く前後の差分」を見る用途では実用上の支障は小さい。
    /// </summary>
    private static long MeasureTotalMemoryBytes()
    {
        long total = 0;
        try
        {
            using (System.Diagnostics.Process self = System.Diagnostics.Process.GetCurrentProcess())
            {
                total += self.WorkingSet64;
            }
            foreach (System.Diagnostics.Process p in System.Diagnostics.Process.GetProcessesByName("msedgewebview2"))
            {
                using (p) total += p.WorkingSet64;
            }
        }
        catch (Exception ex)
        {
            // 計測できなくても動作には影響しない。
            Logger.Debug($"メモリ使用量を取得できなかった: {ex.GetType().Name}");
        }
        return total;
    }

    /// <summary>
    /// 開いているウィンドウのどれかに未保存の変更があるか(仕様書 U-04)。
    /// 更新の適用は再起動を伴うため、実行前にこれを確かめる。
    /// </summary>
    private bool HasUnsavedDocuments() => _windows.Any(w => w.IsDirty);

    /// <summary>
    /// 更新の適用で、新しいPaneを起動したあとに自分自身を終了させる(仕様書 U-04)。
    ///
    /// 古いプロセスが動いたままだと、退避した Pane.exe.pane-old を新しい側が削除できない。
    /// 未保存の確認は呼び出し前に済ませてあるため、ここでは確認ダイアログを出さずに閉じる
    /// (閉じる操作の途中で確認が挟まると、新旧2つのPaneが同時に残る)。
    /// </summary>
    private void ShutdownForUpdate()
    {
        Logger.Write("更新: 新しいPaneを起動したので、このプロセスを終了する");
        // 各ウィンドウのFormClosingで未保存確認が走らないよう、Disposeで直接閉じる。
        foreach (MainForm window in _windows.ToList())
        {
            try { window.Dispose(); } catch (Exception ex) { Logger.WriteException("更新: ウィンドウの終了に失敗", ex); }
        }
        // 設定・取扱説明書のウィンドウも閉じる。ExitThreadだけではこれらは開いたまま残り、
        // 新しいPaneが立ち上がったあとも古い側の窓が画面に居座って見える。
        try { _settingsWindow?.Dispose(); } catch (Exception ex) { Logger.WriteException("更新: 設定ウィンドウの終了に失敗", ex); }
        try { _helpWindow?.Dispose(); } catch (Exception ex) { Logger.WriteException("更新: 取扱説明書ウィンドウの終了に失敗", ex); }
        Logger.Shutdown();
        ExitThread();
    }

    public void OpenWindowFromPipeRequest(string? path)
    {
        // 不具合修正: パイプ経由の要求は常に、送信元プロセス(フォアグラウンド権を持つ)が
        // 自分自身を即終了させた後に届く。受信側の本プロセスはバックグラウンドにいる
        // (または--preloadで非表示常駐している)ことが多く、Windowsの仕様上
        // SetForegroundWindow(Form.Activate()が内部で呼ぶ)は失敗し得るため、
        // forceActivate: trueを渡して WindowChrome.ForceActivate による確実な前面化を通す。
        if (_initialOpenPending)
        {
            _initialOpenPending = false;
            Logger.Write($"preload: 最初のウィンドウ要求を受信(path={path ?? "(なし)"})。復元確認・セッション復元を行う");
            RunRecoveryAndInitialOpen(path, forceActivate: true);
            return;
        }
        OpenWindow(path, forceActivate: true);
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
        WindowChrome.ForceActivate(next);
        Logger.Write($"SwitchToNextWindow: {index} -> {_windows.IndexOf(next)}");
    }

    /// <summary>
    /// 設定画面(WinForms版・HTML製ブリッジのどちらでも、本体ウィンドウ内モーダル・独立した
    /// <see cref="SettingsWindow"/>のどちらからでも)で設定が保存された後に呼ばれる。
    /// 設定はアプリ全体で共有されるため、開いているすべての本体ウィンドウへ apply-settings を
    /// 再送して反映させる(requestSwitchDocumentと同じ、コールバックとして受け取る流儀)。
    /// 呼び出し元(保存した本人のウィンドウ)を区別する必要が無いため引数は取らない。
    /// </summary>
    /// <summary>
    /// 起動時の更新確認(仕様書 U-06)。1日1回だけ配布元へ問い合わせ、新しい版があれば
    /// 画面上部の帯で知らせる。実際に更新するかどうかは利用者が決める。
    ///
    /// ・preload起動(B-1)では行わない。利用者が見ていないログオン直後に通信したくないため。
    ///   ウィンドウが実際に開かれたときには、その時点でこのタイマーは既に止まっている。
    /// ・ウィンドウが1枚も無ければ知らせる先が無いので何もしない。
    /// ・確認に失敗しても何も出さない(UpdateService.CheckOnStartupAsync参照)。
    /// </summary>
    private async Task CheckUpdateOnStartupAsync()
    {
        if (_preload)
        {
            Logger.Debug("起動時の更新確認: preload起動のため行わない");
            return;
        }
        try
        {
            UpdateCheckResult? result = await UpdateService.CheckOnStartupAsync();
            if (result is null) return;

            // 開いているウィンドウのうち1枚だけに出す。全部に出すと、複数開いている人に
            // 同じ案内が何枚も並ぶことになる。
            MainForm? target = _windows.FirstOrDefault(w => !w.IsDisposed);
            if (target is null)
            {
                Logger.Debug("起動時の更新確認: 新しい版があったが、知らせる先のウィンドウが無い");
                return;
            }
            Logger.Write($"起動時の更新確認: 新しい版を画面で知らせる({result.LatestVersion})");
            target.PostUpdateAvailable(result.LatestVersion, result.Message);
        }
        catch (Exception ex)
        {
            // 更新の案内が出せないだけでアプリの動作を妨げてはいけない。
            Logger.WriteException("起動時の更新確認に失敗", ex);
        }
    }

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
    public void OpenSettingsWindow(Form owner) => OpenSettingsWindow(owner, null);

    /// <param name="category">開いた直後に表示するカテゴリ(SettingsWindow.Reveal参照)。</param>
    public void OpenSettingsWindow(Form owner, string? category)
    {
        var sw = Stopwatch.StartNew();
        bool isNew = _settingsWindow is not { IsDisposed: false };
        if (isNew)
        {
            _settingsWindow = new SettingsWindow(
                owner, BroadcastSettingsChanged, HasUnsavedDocuments, ShutdownForUpdate);
            _settingsWindow.FormClosed += (_, _) => _settingsWindow = null;
        }
        // 不具合修正(事前生成が効いていなかった件と合わせて整理): 新規作成直後の初回表示も、
        // 既存インスタンスの再表示も、どちらも「これからユーザーに見せる」という同じ意味のため
        // Revealへ統一する。以前は新規作成時だけShow()を直接呼んでいたが、フォールバック表示
        // タイマーの開始をReveal側に一本化した(SettingsWindow.Revealのコメント参照)ため、
        // ここでもRevealを通さないとそのタイマーが一生始動しない新規作成パスができてしまう。
        _settingsWindow!.Reveal(owner, category);
        Logger.Write(isNew
            ? $"OpenSettingsWindow: 新規に開いた(事前生成は間に合っていなかった, {sw.ElapsedMilliseconds}ms)"
            : $"OpenSettingsWindow: 既存インスタンスを表示({(_settingsWindow.IsRevealed ? "事前生成/前回分の読み込み完了済み" : "まだ読み込み中")}, {sw.ElapsedMilliseconds}ms)");
    }

    /// <summary>
    /// 設定ウィンドウをユーザーがまだ開いていない段階で裏で作っておく(体感速度対策)。
    /// <see cref="_settingsPregenerateTimer"/>から遅延して1回だけ呼ばれる。呼び出し時点で
    /// 本体ウィンドウが1つも無い場合(preload起動の待機中)はowner無しで作る
    /// (<see cref="SettingsWindow"/>はowner無しでも動作し、実際に表示する際の
    /// <see cref="SettingsWindow.Reveal"/>がその時点の実オーナーに合わせて位置を計算し直す)。
    /// ユーザーが既に手動で設定を開いていれば(_settingsWindowが既にある)何もしない。
    /// 例外が起きても致命的ではない: _settingsWindowをnullのままにしておけば、次回の
    /// <see cref="OpenSettingsWindow"/>が従来どおり(その場で新規作成)にフォールバックする。
    /// </summary>
    private void PregenerateSettingsWindow()
    {
        if (_settingsWindow is not null) return;
        SettingsWindow? window = null;
        try
        {
            Form? owner = _windows.Count > 0 ? _windows[0] : null;
            window = new SettingsWindow(
                owner, BroadcastSettingsChanged, HasUnsavedDocuments, ShutdownForUpdate);
            window.FormClosed += (_, _) => _settingsWindow = null;
            _settingsWindow = window;
            window.Prewarm();
            Logger.Write("PregenerateSettingsWindow: アイドル時の事前生成を開始した");
        }
        catch (Exception ex)
        {
            // 失敗しても致命的ではない: _settingsWindowをnullのままにしておけば、次回の
            // OpenSettingsWindowが従来どおり(その場で新規作成)にフォールバックする。
            // 途中まで作られたインスタンス(ネイティブハンドルが作られていた場合を含む)は
            // 取り残さずここで破棄する。
            Logger.WriteException("PregenerateSettingsWindow: 事前生成に失敗(次回OpenSettingsWindowで通常経路にフォールバック)", ex);
            _settingsWindow = null;
            window?.Dispose();
        }
    }

    /// <summary>
    /// 取扱説明書ウィンドウ(F1)を開く。<paramref name="owner"/>(呼び出し元のウィンドウ)の
    /// 中央に表示する。既に開いていれば新しく作らず<see cref="WindowChrome.ForceActivate"/>で
    /// 前面に出すだけにする(同時に1つしか開かない)。<see cref="OpenSettingsWindow"/>と同じ構成。
    /// </summary>
    public void OpenHelpWindow(Form owner)
    {
        var sw = Stopwatch.StartNew();
        bool isNew = _helpWindow is not { IsDisposed: false };
        if (isNew)
        {
            _helpWindow = new HelpWindow(owner);
            _helpWindow.FormClosed += (_, _) => _helpWindow = null;
        }
        _helpWindow!.Reveal(owner);
        Logger.Write(isNew
            ? $"OpenHelpWindow: 新規に開いた(事前生成は間に合っていなかった, {sw.ElapsedMilliseconds}ms)"
            : $"OpenHelpWindow: 既存インスタンスを表示({(_helpWindow.IsRevealed ? "事前生成/前回分の読み込み完了済み" : "まだ読み込み中")}, {sw.ElapsedMilliseconds}ms)");
    }

    /// <summary>
    /// 取扱説明書ウィンドウをユーザーがまだ開いていない段階で裏で作っておく(体感速度対策)。
    /// <see cref="_helpPregenerateTimer"/>から遅延して1回だけ呼ばれる。<see cref="PregenerateSettingsWindow"/>と
    /// 全く同じ構成・同じ理由。
    /// </summary>
    private void PregenerateHelpWindow()
    {
        if (_helpWindow is not null) return;
        HelpWindow? window = null;
        try
        {
            Form? owner = _windows.Count > 0 ? _windows[0] : null;
            window = new HelpWindow(owner);
            window.FormClosed += (_, _) => _helpWindow = null;
            _helpWindow = window;
            window.Prewarm();
            Logger.Write("PregenerateHelpWindow: アイドル時の事前生成を開始した");
        }
        catch (Exception ex)
        {
            Logger.WriteException("PregenerateHelpWindow: 事前生成に失敗(次回OpenHelpWindowで通常経路にフォールバック)", ex);
            _helpWindow = null;
            window?.Dispose();
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
                // アプリ全体を終了する。設定画面・取扱説明書画面はどちらもウィンドウ数の勘定に
                // 含めていないため(_windowsに含まれない)、開いたままExitThreadすると
                // 取り残されてしまう。明示的に閉じてからスレッドを終了する。体感速度対策
                // (インスタンス再利用)により通常のCloseは非表示化に読み替えられてしまうため、
                // ここでは本当に破棄するCloseForRealを使う(事前生成の途中で終了した場合も含め、
                // 確実に破棄する)。
                _settingsPregenerateTimer.Stop();
                _settingsPregenerateTimer.Dispose();
                _helpPregenerateTimer.Stop();
                _helpPregenerateTimer.Dispose();
                _settingsWindow?.CloseForReal();
                _helpWindow?.CloseForReal();
                ExitThread();
            }
        }
    }
}
