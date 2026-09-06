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

    /// <summary>
    /// 設定ウィンドウの事前生成(体感速度対策)を始めるまでの待ち時間。
    ///
    /// 本来の合図は「最初の本体ウィンドウが使える状態になったこと」(<see cref="MainForm.ReadyToUse"/>)
    /// で、この時間はそれが来なかったときの保険。起動直後の輻輳(本体ウィンドウ自身の
    /// WebView2初期化・Navigate)に事前生成を重ねると、肝心の本体の表示が遅くなる。
    ///
    /// 以前はこの固定の待ち時間だけが合図だった。しかし本体の初期描画が終わるまでの時間は
    /// 環境によって大きく違い(実機で2.7秒かかることもあった)、短いと輻輳し、長いと
    /// 「待っている間に利用者が設定を開いてしまう」ことになる。時間で当て推量するより、
    /// 実際に本体が落ち着いたことを見てから始めるほうが確実なため、合図を切り替えた。
    /// </summary>
    private const int SettingsPregenerateFallbackMs = 8000;

    /// <summary>取扱説明書ウィンドウの事前生成を始めるまでの保険の待ち時間。設定ウィンドウの
    /// 事前生成(<see cref="SettingsPregenerateFallbackMs"/>)と同時に走らせると起動直後の輻輳が
    /// 増えるため、少しずらして開始する(WebView2環境自体は共有キャッシュのため、2つ目の
    /// Prewarmが増やすコストはEnsureCoreWebView2Async呼び出し程度で小さい)。</summary>
    private const int HelpPregenerateFallbackMs = 9000;

    /// <summary>本体ウィンドウが使える状態になってから設定ウィンドウの事前生成を始めるまでの間。
    /// 初期描画が終わった直後はまだ後片付け(遅延読み込みの続き等)が動いているため、
    /// ひと呼吸置いてから始める。</summary>
    private const int PregenerateAfterReadyMs = 600;

    /// <summary>取扱説明書ウィンドウの事前生成を、設定ウィンドウの事前生成からどれだけ後ろに置くか。</summary>
    private const int HelpPregenerateAfterSettingsMs = 1200;

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

    /// <summary>
    /// 新しい版が見つかったが、まだ画面に出せていない案内(U-06)。出せたらnullに戻す。
    ///
    /// 確認が終わった時点で、知らせる先のウィンドウが無い(まだ開いていない・もう閉じられた)
    /// ことがある。以前はそこで諦めていたため、案内が誰にも届かないまま消えていた。
    /// ここに控えておき、ウィンドウが使える状態になった時点で出す。
    /// </summary>
    private UpdateCheckResult? _pendingUpdateNotice;

    /// <summary>
    /// 最後に配布元へ問い合わせた時刻。まだ一度も問い合わせていなければ <see cref="DateTime.MinValue"/>。
    /// 常駐プロセス(B-1)が何日も生き続けるときに、確認が最初の一度きりで終わらないようにするため
    /// (<see cref="StartStartupUpdateCheckTimer"/>)。
    /// </summary>
    private DateTime _lastUpdateCheckAt = DateTime.MinValue;

    /// <summary>
    /// 常駐したまま使い続けている場合に、次の確認までどれだけ空けるか。
    /// 「起動のたびに確認する」という約束(U-06)を、起動しっぱなしの人にも同じ意味で届ける
    /// ための間隔であり、確認そのものを増やす意図ではない。
    /// </summary>
    private static readonly TimeSpan UpdateRecheckInterval = TimeSpan.FromHours(24);

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

        // 設定ウィンドウの事前生成(体感速度対策)。本来の合図は最初の本体ウィンドウが使える
        // 状態になったこと(OpenWindowでReadyToUseを購読する)で、このタイマーはそれが来なかった
        // ときの保険。preload起動では本体ウィンドウがそもそも無いため、常にこちらが働く。
        // preload起動時は下のEnsureEnvironmentAsync(WebView2環境の事前生成)と並行して走ることに
        // なるが、EnsureEnvironmentAsync自体がロックで多重呼び出しに対応しているため競合しない
        // (SettingsWindow.OnLoadAsyncも同じEnsureEnvironmentAsyncを呼ぶので、先に完了していれば
        // そのままキャッシュを使う)。
        // 設定「設定と取扱説明書の画面をあらかじめ用意しておく」(仕様書 C-15)がオフなら、
        // タイマー自体を回さない(実行側でも同じ判定をするが、無駄に起こさないため)。
        bool pregenerate = IsPregenerationEnabled();

        _settingsPregenerateTimer = new System.Windows.Forms.Timer { Interval = SettingsPregenerateFallbackMs };
        _settingsPregenerateTimer.Tick += (_, _) =>
        {
            _settingsPregenerateTimer.Stop();
            PregenerateSettingsWindow();
        };
        if (pregenerate) _settingsPregenerateTimer.Start();

        _helpPregenerateTimer = new System.Windows.Forms.Timer { Interval = HelpPregenerateFallbackMs };
        _helpPregenerateTimer.Tick += (_, _) =>
        {
            _helpPregenerateTimer.Stop();
            PregenerateHelpWindow();
        };
        if (pregenerate) _helpPregenerateTimer.Start();

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
                Logger.Write($"復元確認をスキップ(recoverUnsavedDrafts=false): スナップショットを破棄: {(snapshot.OriginalPath is null ? "無題" : PrivacyLogFormatter.ShortenPath(snapshot.OriginalPath))}");
                AutoSaveService.DeleteSnapshot(windowId);
                continue;
            }

            string label = snapshot.OriginalPath ?? "無題";
            // この時点ではまだ本体ウィンドウが1つも無い(起動直後)ため、オーナー無しで表示する
            // (PaneDialog.Show側は画面中央にフォールバックする)。
            DialogResult choice = PaneDialog.Show(
                $"前回のPaneは正常に終了しませんでした。\n未保存の内容を復元しますか?\n\n{label}",
                "Pane - 復元の確認",
                MessageBoxButtons.YesNo,
                MessageBoxIcon.Warning);

            if (choice == DialogResult.Yes)
            {
                // 【不具合修正】以前はここで単にOpenWindow(...)するだけで、下のDeleteSnapshot(windowId)
                // (旧WindowIdのスナップショット削除)を「はい」「いいえ」どちらでも無条件に実行していた。
                // コメントには「はいの場合は復元後のウィンドウが新しいGuidで新規に書き直す」とあったが、
                // 実際には次の自動保存Tick(既定30秒後)まで新ウィンドウ側は何も書いておらず、
                // 「旧スナップショットは既に消えた・新スナップショットはまだ無い」という空白ができていた。
                // 復元ダイアログで「はい」を選んだ直後(このアプリがいちばん不安定な瞬間、
                // WebView2の初期化に失敗して"ready"が来ない場合も含む)にもう一度落ちると、
                // その空白の間は未保存内容がどこにも残っておらず完全に失われる
                // (docs/調査記録/点検-機能と動作.md「復元「はい」直後に元スナップショットを消すため、
                // データが失われうる」参照)。
                //
                // 対策: 新しいウィンドウのWindowIdをここで先に確定させ、その下へ復元内容の
                // コピーを書いてから(この時点で新旧2つの場所に同じ内容がある)、旧ファイルを
                // 削除する。OpenWindow側にはそのWindowIdをそのまま使わせる
                // (MainForm(windowId:...)、"ready"が届いてWebView2の準備が整うのを待たずに
                // 済むため、WebView2の初期化自体が失敗するケースも救える)。
                // MainForm.RestoreFromSnapshot側でも"ready"受信時に同じ内容を書き直しており
                // (SavedAtUtcの更新を兼ねる)、そちらは二重の安全策として残してある。
                Guid newWindowId = Guid.NewGuid();
                AutoSaveService.WriteSnapshot(newWindowId, snapshot with { SavedAtUtc = DateTime.UtcNow });
                OpenWindow(snapshot.OriginalPath, snapshot, forceActivate: forceActivate, windowId: newWindowId);
                openedAny = true;
                if (snapshot.OriginalPath is not null) openedPaths.Add(snapshot.OriginalPath);
            }
            // 復元元の古いスナップショットファイルは、いいえの場合はここで、
            // はいの場合は新しいWindowId側へ既にコピーを書き終えた後にここで、それぞれ消す
            // (はいの場合にここを先に実行してしまうと、上の空白がそのまま復活してしまう)。
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
                Logger.Write($"起動時のカスタムフォルダを読み込む: {PrivacyLogFormatter.ShortenPath(folder)}");
                Logger.Debug($"起動時のカスタムフォルダ(フルパス): {folder}");
                OpenWindow(null, initialFolderPath: folder, forceActivate: forceActivate);
                openedAny = true;
            }
            else
            {
                // 指定フォルダが存在しない場合は空文書で起動する(下の!openedAnyフォールバックへ)。
                Logger.Write($"起動時のカスタムフォルダが存在しないため空文書で起動する: {(folder is null ? "(未設定)" : PrivacyLogFormatter.ShortenPath(folder))}");
            }
        }

        if (!openedAny)
        {
            OpenWindow(null, forceActivate: forceActivate);
        }

        // 前回の起動で見つけたのに出せなかった更新の案内があれば、通信を待たずにここで出す。
        // まだWebView2の初期化中なので、実際に画面へ出るのはウィンドウが使える状態になった時点
        // (OpenWindowで登録したReadyToUse)。
        ShowRememberedUpdateNoticeIfAny();
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
    public void OpenWindow(
        string? path,
        AutoSaveSnapshot? recoverFrom = null,
        DroppedFileContent? droppedFile = null,
        string? initialFolderPath = null,
        bool forceActivate = false,
        Guid? windowId = null)
    {
        // コマンドライン引数・多重起動時のパイプ経由でフォルダのパスが渡された場合
        // (仕様書 F-14: `Pane.exe <folder>`)。pathをそのままファイルとして読もうとすると
        // TextFileService.Load(File.ReadAllBytes)が失敗するため、フォルダを開く既存の経路
        // (initialFolderPath、サイドバーで開く)へ転送する。復元・ドロップ経由(pathがファイル
        // であることが確定している)はこの判定の対象外にする。
        if (path is not null && recoverFrom is null && droppedFile is null && initialFolderPath is null && Directory.Exists(path))
        {
            Logger.Write($"OpenWindow: 起動引数がフォルダのためフォルダとして開く: {PrivacyLogFormatter.ShortenPath(path)}");
            Logger.Debug($"OpenWindow(フルパス): {path}");
            OpenWindow(null, initialFolderPath: path, forceActivate: forceActivate);
            return;
        }

        // 総点検(docs/調査記録/点検-機能と動作.md)「同じファイルを2ウィンドウで開けて後勝ち上書き」対策。
        // 新しいウィンドウ・タブを作る前に、既にどこかのウィンドウ(タブ形式ならタブも含む)で
        // 同じファイルを開いていないか確認する。見つかればそちらを前面に出すだけにして
        // 新規には開かない(VS Code等と同じ「既存を前面化」方式。メモ帳のように無警告のまま
        // 複数開かせて後勝ち上書きを許すよりも、上書き事故を未然に防げると判断した)。
        // エクスプローラーで同じファイルを2回開く(2回目は多重起動のパイプ経由でここへ来る)・
        // 「最近使ったファイル」やコマンドライン引数で同じファイルを重ねて指定する、といった
        // 経路はいずれも_requestNewWindow(=OpenWindow)を経由するため、ここ1か所で防げる。
        // 異常終了からの復元(recoverFrom)は復元先の内容がディスク上の現在の内容と異なる
        // (それが復元の目的)ため対象外、ドロップ(droppedFile)はパス不定のことも多いため対象外。
        if (path is not null && recoverFrom is null && droppedFile is null)
        {
            MainForm? existing = _windows.FirstOrDefault(w =>
                !w.IsDisposed && w.GetOpenFilePaths().Any(p => string.Equals(p, path, StringComparison.OrdinalIgnoreCase)));
            if (existing is not null)
            {
                Logger.Write($"OpenWindow: 既に開いているウィンドウ/タブへ切り替える: {PrivacyLogFormatter.ShortenPath(path)}");
                Logger.Debug($"OpenWindow(フルパス): {path}");
                existing.ActivateTabForPathIfPresent(path);
                WindowChrome.ForceActivate(existing);
                return;
            }
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
            Logger.Write($"[計測] 既存ウィンドウへ新しいタブとして開いた: {tabStopwatch.ElapsedMilliseconds}ms (目標300ms以内, path={(path is null ? "(なし)" : PrivacyLogFormatter.ShortenPath(path))})");
            return;
        }

        // [計測] 仕様書 第8.4節の数値目標のうち、これまで測る手立てが無かった2つを記録する。
        //   ・2枚目以降のウィンドウ追加メモリ(目標110MB以内)
        //   ・既存インスタンスへのファイル追加表示(目標300ms以内。パイプ経由の要求が対象)
        // 1枚目は「起動」であってこの目標の対象外なので、2枚目以降だけを見る。
        //
        // 【実際に困ったこと】以前は枚数の上限を設けず、開くたびに毎回測っていた。
        // メモリの計測(MeasureTotalMemoryBytes)はWebView2のプロセスを1つずつ開いて
        // WorkingSetを足す処理で、ウィンドウが増えるほど数えるプロセスも増える。
        // 実機ログ(2026-09-06)では2枚目で53ms、17枚目では157msかかっており、しかも
        // ウィンドウを開く前と後の2回、UIスレッドの上で走っていた。
        // 目標そのものは「2枚目以降のウィンドウ」であって17枚目を測る必要はないため、
        // 確認に足りる枚数で打ち切る。
        bool measureAdditionalWindow = _windows.Count > 0 && _windows.Count < MeasuredWindowLimit;
        bool memoryBeforeOwnOnly = false;
        long memoryBeforeBytes = measureAdditionalWindow ? MeasureTotalMemoryBytes(out memoryBeforeOwnOnly) : 0;
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
            shutdownForUpdate: ShutdownForUpdate,
            windowId: windowId);

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

        // 最大化状態の復元(docs/調査記録/点検-機能と動作.md「余裕があれば直すもの」)。カスケード配置
        // (複数ウィンドウを少しずつずらして並べる、上のWindowX/WindowY分岐)とは相性が悪いため、
        // このセッションで最初に開くウィンドウ(_windows.Count==0)だけに適用する。2枚目以降は
        // 従来どおりNormalで並べる。
        if (_windows.Count == 0 && _settings.WindowMaximized)
        {
            form.WindowState = FormWindowState.Maximized;
        }

        form.FormClosing += (_, _) =>
        {
            // docs/調査記録/点検-機能と動作.md「余裕があれば直すもの」: 最大化状態は従来保存していなかった
            // ため、最大化して閉じても次回はNormal時代の位置・サイズで開いていた。
            // 位置・サイズ自体はNormal時のものだけを引き続き記録する(最大化中のLocationは
            // 意味が無いため)。
            _settings.WindowMaximized = form.WindowState == FormWindowState.Maximized;
            if (form.WindowState == FormWindowState.Normal)
            {
                _settings.WindowX = form.Location.X;
                _settings.WindowY = form.Location.Y;
                _settings.WindowWidth = form.Width;
                _settings.WindowHeight = form.Height;
            }
        };
        form.FormClosed += (_, _) => OnWindowClosed(form);

        // 更新の案内(U-06)は、このウィンドウが使える状態になってからでないと届かない。
        // まだ控えが残っていれば、その時点で出す(TryShowPendingUpdateNotice参照)。
        form.ReadyToUse += TryShowPendingUpdateNotice;

        // 設定・取扱説明書の事前生成は、本体ウィンドウが落ち着いてから始める
        // (SchedulePregenerationAfterFirstWindow参照)。
        form.ReadyToUse += SchedulePregenerationAfterFirstWindow;

        _windows.Add(form);
        form.Show();

        if (measureAdditionalWindow)
        {
            // Show()の直後はまだWebView2の初期化が進行中で、メモリも増え切っていない。
            // 実際に使える状態になってから測るため、そのウィンドウの初期描画完了を待って報告する
            // (MainForm側がinitial-render-readyを受け取った時点でコールバックしてくる)。
            long beforeBytes = memoryBeforeBytes;
            bool beforeOwnOnly = memoryBeforeOwnOnly;
            System.Diagnostics.Stopwatch stopwatch = windowStopwatch!;
            form.ReadyToUse += () =>
            {
                // 【実際に間違えたこと】以前はこの下のMeasureTotalMemoryBytesを先に呼び、
                // そのあとで stopwatch.ElapsedMilliseconds を読んでいた。メモリの計測は
                // WebView2のプロセスを1つずつ開いてWorkingSetを足す処理で、ウィンドウが
                // 増えるほど数えるプロセスも増える。その所要時間(実機で56〜82ms)が
                // 「表示まで」に足し込まれ、2枚目302ms・6枚目357msと、目標の300msを
                // 超えたように見えていた(実際は246〜278msで収まっていた)。
                // 枚数が増えるほど報告値だけが伸びるのが、その兆候だった。
                // 測り終えた時刻は、他のことをする前にここで確定させる。
                long elapsedMs = stopwatch.ElapsedMilliseconds;

                long measureStart = System.Diagnostics.Stopwatch.GetTimestamp();
                long afterBytes = MeasureTotalMemoryBytes(out bool ownOnly);
                long measureMs = (long)System.Diagnostics.Stopwatch.GetElapsedTime(measureStart).TotalMilliseconds;
                long deltaMb = (afterBytes - beforeBytes) / (1024 * 1024);
                // 前後で数え方が変わっていたら、その差は比べられない(片方に他アプリのぶんが
                // 入っている)。黙って数字だけ出すと読み違えるので、その旨を添える。
                string memoryNote = (ownOnly, beforeOwnOnly) switch
                {
                    (true, true) => "メモリはPane本体と、Pane自身のWebView2プロセスだけの合計",
                    (_, _) when ownOnly != beforeOwnOnly =>
                        "メモリは前後で数え方が変わったため比較できない(開く前はWebView2環境がまだ無かった)。参考値",
                    _ => "メモリはPane本体とWebView2の各プロセスの合計。WebView2環境がまだ無く実行ファイル名で数えたため、" +
                         "他のアプリのWebView2が動いていると多めに出る",
                };
                Logger.Write($"[計測] {_windows.Count}枚目のウィンドウ: 表示まで{elapsedMs}ms, " +
                             $"メモリ増加{deltaMb}MB (目標: 表示300ms以内・メモリ110MB以内。{memoryNote}。" +
                             $"このメモリ計測自体に{measureMs}msかかっており、表示までの時間には含めていない)");
                PerfWatch.Report($"{_windows.Count}枚目のウィンドウの表示", elapsedMs, 300);
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
    /// <summary>
    /// Paneが今使っているメモリの合計(本体のプロセスと、自分のWebView2のプロセス群)。
    /// 測れたかどうかも一緒に返す(<paramref name="measuredOwnProcessesOnly"/>)。
    ///
    /// 数える相手は「自分のWebView2環境に属するプロセス」に限る。以前は実行ファイル名で
    /// msedgewebview2 を全部拾っていたが、WebView2はEdge本体や他のアプリも使う共通の部品で、
    /// それらのプロセスも同じ名前で並ぶ。実機では2枚目のウィンドウのメモリ増加が373MBと
    /// 出ていたが、これは他のアプリのぶんを一緒に数えていた疑いが強く、数字として当てにならない。
    /// </summary>
    /// <summary>
    /// [計測] 仕様書8.4節の確認としてメモリと表示時間を測るウィンドウの上限。
    /// この枚数に達したら測らない(理由は<see cref="OpenWindow"/>の該当箇所を参照)。
    /// 2枚目から5枚目までを見れば、目標(2枚目以降のウィンドウ)の確認には足りる。
    /// </summary>
    private const int MeasuredWindowLimit = 5;

    private static long MeasureTotalMemoryBytes(out bool measuredOwnProcessesOnly)
    {
        long total = 0;
        measuredOwnProcessesOnly = false;
        try
        {
            using (System.Diagnostics.Process self = System.Diagnostics.Process.GetCurrentProcess())
            {
                total += self.WorkingSet64;
            }

            Microsoft.Web.WebView2.Core.CoreWebView2Environment? env = Pane.MainForm.CachedEnvironment;
            if (env is not null)
            {
                // この環境が持っているプロセスだけを数える。他のアプリのWebView2は別の環境なので
                // ここには出てこない。
                //
                // 種別ごとの内訳も残す。実機ログ(2026-09-06)でこの内訳を採ったところ、
                // ウィンドウを1枚増やすと Renderer が1つ増えて84〜97MB、Browser(147→160MB)・
                // Gpu(78→82MB)・Utility(59MB)はほぼ一定だった。つまり増えるぶんはすべて
                // レンダラーで、同じプロセス内でも共有されない。これを根拠に仕様書8.4節の
                // 目標を60MB以内から110MB以内へ改めている。
                // 今後この数字が変わったとき(WebView2の更新など)に気づけるよう、内訳は残す。
                var byKind = new Dictionary<string, (int Count, long Bytes)>();
                foreach (Microsoft.Web.WebView2.Core.CoreWebView2ProcessInfo info in env.GetProcessInfos())
                {
                    try
                    {
                        using System.Diagnostics.Process p = System.Diagnostics.Process.GetProcessById(info.ProcessId);
                        total += p.WorkingSet64;

                        string kind = info.Kind.ToString();
                        (int Count, long Bytes) sum = byKind.TryGetValue(kind, out var current) ? current : (0, 0L);
                        byKind[kind] = (sum.Count + 1, sum.Bytes + p.WorkingSet64);
                    }
                    catch (ArgumentException)
                    {
                        // 数え終わる前に終了したプロセス。数に入れないだけでよい。
                    }
                }
                if (byKind.Count > 0)
                {
                    string breakdown = string.Join(", ", byKind
                        .OrderByDescending(entry => entry.Value.Bytes)
                        .Select(entry => $"{entry.Key}×{entry.Value.Count}={entry.Value.Bytes / (1024 * 1024)}MB"));
                    // 詳細ログ(Debug)にすると、実機で確かめてもらうたびに設定の変更をお願いする
                    // ことになる。測るのは最初の数枚だけ(MeasuredWindowLimit)で行数も増えないため、
                    // 既定のログに出す。
                    Logger.Write($"[計測] メモリの内訳(WebView2): {breakdown}");
                }
                measuredOwnProcessesOnly = true;
                return total;
            }

            // WebView2環境がまだ無い(1枚目のウィンドウを作っている最中など)。名前で拾う従来の
            // やり方に落とす。他のアプリのぶんが混ざるため、呼び出し元はその旨を添えて記録する。
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
            Logger.Write($"preload: 最初のウィンドウ要求を受信(path={(path is null ? "(なし)" : PrivacyLogFormatter.ShortenPath(path))})。復元確認・セッション復元を行う");
            RunRecoveryAndInitialOpen(path, forceActivate: true);
            // ログオン直後の待機中は見送っていた更新確認を、ここから改めて動かす
            // (StartStartupUpdateCheckTimerのコメント参照)。
            StartStartupUpdateCheckTimer();
            return;
        }
        OpenWindow(path, forceActivate: true);
        RecheckUpdateIfDue();
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
    /// 起動時の更新確認(仕様書 U-06)。起動のたびに配布元へ問い合わせ、新しい版があれば
    /// 画面上部の帯で知らせる。実際に更新するかどうかは利用者が決める。
    ///
    /// ・preload起動(B-1)の待機中は行わない。利用者が見ていないログオン直後に通信したくない
    ///   ため。代わりに、最初のウィンドウを開く時点で改めてこのタイマーを動かす
    ///   (<see cref="StartStartupUpdateCheckTimer"/>)。
    /// ・確認が終わった時点で知らせる先が無ければ、案内を控えておいて後で出す
    ///   (<see cref="_pendingUpdateNotice"/>)。
    /// ・確認に失敗しても何も出さない(UpdateService.CheckOnStartupAsync参照)。
    /// </summary>
    private async Task CheckUpdateOnStartupAsync()
    {
        if (_preload && _initialOpenPending)
        {
            Logger.Debug("起動時の更新確認: preloadの待機中のため行わない(最初のウィンドウを開く時点で改めて確認する)");
            return;
        }
        try
        {
            _lastUpdateCheckAt = DateTime.UtcNow;
            UpdateCheckResult? result = await UpdateService.CheckOnStartupAsync();
            if (result is null) return;

            _pendingUpdateNotice = result;
            // 案内を出せないまま終了することもあるため、先に控えておく。出せた時点で消す。
            RememberPendingUpdateNotice(result);
            TryShowPendingUpdateNotice();
        }
        catch (Exception ex)
        {
            // 更新の案内が出せないだけでアプリの動作を妨げてはいけない。
            Logger.WriteException("起動時の更新確認に失敗", ex);
        }
    }

    /// <summary>
    /// 控えてある更新の案内を、使える状態のウィンドウへ出す。出せたら控えを消す。
    /// 出せる先が無ければ何もしない(次にウィンドウが使える状態になったとき、または
    /// 次回の起動でまた試される)。
    ///
    /// 開いているウィンドウのうち1枚にだけ出す。全部に出すと、複数開いている人の画面に
    /// 同じ案内が何枚も並ぶことになる。
    /// </summary>
    private void TryShowPendingUpdateNotice()
    {
        UpdateCheckResult? notice = _pendingUpdateNotice;
        if (notice is null) return;

        // まだ描画が終わっていないウィンドウへ送っても、受け手がいないので消えてしまう
        // (MainForm.PostUpdateAvailable参照)。使える状態になったものだけを相手にする。
        MainForm? target = _windows.FirstOrDefault(w => !w.IsDisposed && w.IsReadyToUse);
        if (target is null)
        {
            Logger.Debug($"更新の案内: 新しい版({notice.LatestVersion})が見つかっているが、まだ出せる先が無いので控えておく");
            return;
        }

        _pendingUpdateNotice = null;
        Logger.Write($"更新の案内: 新しい版を画面で知らせる({notice.LatestVersion})");
        target.PostUpdateAvailable(notice.LatestVersion, notice.Message);
        ForgetPendingUpdateNotice();
    }

    /// <summary>
    /// まだ出せていない案内を設定ファイルへ控える。次回の起動では、通信の完了を待たずに
    /// これを出せる(<see cref="ShowRememberedUpdateNoticeIfAny"/>)。
    /// </summary>
    private static void RememberPendingUpdateNotice(UpdateCheckResult result)
    {
        try
        {
            SettingsService.Update(s =>
            {
                s.PendingUpdateNoticeTag = result.LatestVersion;
                s.PendingUpdateNoticeMessage = result.Message;
            });
        }
        catch (Exception ex)
        {
            // 控えられなくても、この起動の中で出せるなら困らない。
            Logger.Debug($"更新の案内: 控えの保存に失敗(この起動では出せる): {ex.GetType().Name}");
        }
    }

    /// <summary>控えを消す。案内を実際に画面へ出せたときに呼ぶ。</summary>
    private static void ForgetPendingUpdateNotice()
    {
        try
        {
            SettingsService.Update(s =>
            {
                s.PendingUpdateNoticeTag = null;
                s.PendingUpdateNoticeMessage = null;
            });
        }
        catch (Exception ex)
        {
            Logger.Debug($"更新の案内: 控えの削除に失敗(次回もう一度出るだけ): {ex.GetType().Name}");
        }
    }

    /// <summary>
    /// 前回の起動で見つけたのに出せなかった案内があれば、通信を待たずに出す。
    ///
    /// 起動時の確認は数秒おいてから始まり、結果が返るまでにも待ちがある。その間に閉じられると
    /// 案内が誰にも届かないまま消えていた。控えを先に出しておけば、通信の速さや繋がりやすさに
    /// 関係なく届く。控えより新しい版が確認で見つかれば、そちらで上書きされる。
    /// </summary>
    private void ShowRememberedUpdateNoticeIfAny()
    {
        if (_pendingUpdateNotice is not null) return; // この起動で見つけたものを優先する

        AppSettings settings = SettingsService.Load();
        string? tag = settings.PendingUpdateNoticeTag;
        if (string.IsNullOrWhiteSpace(tag)) return;

        // 前回の案内より後に更新を済ませていれば、もう知らせる必要はない。
        string currentVersion = SettingsBridge.DetectAppVersion();
        if (UpdateCheckLogic.IsNewerThanCurrent(tag, currentVersion) != true)
        {
            Logger.Write($"更新の案内: 前回の控え({tag})は今の版({currentVersion})に追いつかれているので捨てる");
            ForgetPendingUpdateNotice();
            return;
        }

        Logger.Write($"更新の案内: 前回出せなかった案内({tag})を先に出す");
        _pendingUpdateNotice = new UpdateCheckResult(
            Status: "available",
            CurrentVersion: currentVersion,
            LatestVersion: tag,
            DownloadUrl: "",
            Sha256: "",
            SizeBytes: 0,
            ReleaseUrl: "",
            Message: settings.PendingUpdateNoticeMessage ?? $"新しい版 {tag} があります。");
        TryShowPendingUpdateNotice();
    }

    /// <summary>
    /// 起動時の更新確認(U-06)のタイマーを動かす。既に動いていれば何もしない。
    ///
    /// 2つの場面から呼ぶ。
    ///   ・preload起動(B-1)で最初のウィンドウを開いたとき。ログオン直後の待機中は通信を
    ///     見送っているため、ここで改めて動かす。以前はコンストラクタで一度動かしたきりで、
    ///     待機中に何もせず止まっていた。常駐を使っている人には起動時の確認が一度も走らなかった。
    ///   ・常駐したまま次のウィンドウを開いたとき。前回の確認から
    ///     <see cref="UpdateRecheckInterval"/> 以上空いていれば、また確認する。
    ///     常駐プロセスは何日も生き続けるので、これが無いと最初の一度きりで終わってしまう。
    /// </summary>
    private void StartStartupUpdateCheckTimer()
    {
        if (_startupUpdateCheckTimer.Enabled) return;
        _startupUpdateCheckTimer.Start();
    }

    /// <summary>
    /// 常駐したまま使い続けている場合に、頃合いを見て更新確認をやり直す。
    /// ウィンドウを開くたびに呼ばれるが、実際に動くのは前回の確認から十分に間が空いたときだけ。
    /// </summary>
    private void RecheckUpdateIfDue()
    {
        if (_lastUpdateCheckAt == DateTime.MinValue) return; // まだ最初の確認が済んでいない
        if (DateTime.UtcNow - _lastUpdateCheckAt < UpdateRecheckInterval) return;

        Logger.Write($"更新の確認: 前回から{(int)(DateTime.UtcNow - _lastUpdateCheckAt).TotalHours}時間経ったので確認し直す(常駐したまま使い続けている)");
        StartStartupUpdateCheckTimer();
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
        // 事前生成が設定でオフのときに「間に合っていなかった」と書くと、走ったのに遅れたように
        // 読める(実機ログ2026-09-06で実際に紛らわしかった)。オフのときはそう書く。
        string pregenerateNote = IsPregenerationEnabled() ? "事前生成は間に合っていなかった" : "事前生成は設定でオフ";
        Logger.Write(isNew
            ? $"OpenSettingsWindow: 新規に開いた({pregenerateNote}, {sw.ElapsedMilliseconds}ms)"
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
    /// <summary>
    /// 本体ウィンドウが使える状態になったのを受けて、設定・取扱説明書の事前生成を始める。
    ///
    /// 起動直後は本体ウィンドウ自身のWebView2初期化とHTMLの読み込みで手一杯で、そこへ
    /// 事前生成を重ねると本体の表示そのものが遅れる。かといって固定の待ち時間で当て推量すると、
    /// 環境によって短すぎたり長すぎたりする。本体が実際に描き終わったこの瞬間から数えるのが
    /// いちばん確実なので、保険のタイマーを止めて、短い間を置いて始め直す。
    ///
    /// 2枚目以降のウィンドウが開かれたときにも呼ばれ、事前生成がまだなら数え直しになる。
    /// これは意図したとおりで、ウィンドウが立て続けに開いている間はやはり忙しく、
    /// そこへ事前生成を割り込ませたくない。既に作り終えていれば何もしない。
    /// </summary>
    private void SchedulePregenerationAfterFirstWindow()
    {
        if (_settingsWindow is not null && _helpWindow is not null) return;

        // 設定「設定と取扱説明書の画面をあらかじめ用意しておく」(仕様書 C-15、既定オン)。
        // オフのときは何も先回りしない。開いたその場で作る従来の経路(OpenSettingsWindow /
        // OpenHelpWindow)に落ちるだけで、初回の表示が遅くなる代わりに、まだ開いていない
        // 画面ぶんのWebView2描画プロセス(実機で約160MB)を使わずに済む。
        if (!IsPregenerationEnabled())
        {
            Logger.Debug("事前生成: 設定で無効になっているため行わない");
            return;
        }

        if (_settingsWindow is null)
        {
            _settingsPregenerateTimer.Stop();
            _settingsPregenerateTimer.Interval = PregenerateAfterReadyMs;
            _settingsPregenerateTimer.Start();
        }
        if (_helpWindow is null)
        {
            _helpPregenerateTimer.Stop();
            _helpPregenerateTimer.Interval = PregenerateAfterReadyMs + HelpPregenerateAfterSettingsMs;
            _helpPregenerateTimer.Start();
        }
        Logger.Debug("事前生成: 本体ウィンドウが使える状態になったので、ここから数え直す");
    }

    /// <summary>設定「設定と取扱説明書の画面をあらかじめ用意しておく」の現在値。
    /// 設定が読めなければ既定(用意する)に倒す。</summary>
    private static bool IsPregenerationEnabled()
    {
        try
        {
            return SettingsService.Load().PregenerateWindows;
        }
        catch (Exception ex)
        {
            Logger.WriteException("事前生成: 設定を読めなかったため既定(用意する)で続ける", ex);
            return true;
        }
    }

    private void PregenerateSettingsWindow()
    {
        // 【実際に漏らしたこと】最初はSchedulePregenerationAfterFirstWindowにだけ
        // 設定の判定を置いていた。だが事前生成にはもう1つ、コンストラクタで始まる
        // タイマー(本体ウィンドウのReadyToUseが来なかったときの保険。preload起動では
        // 常にこちらが働く)からの経路がある。実機ログ(2026-09-06)で、設定をオフに
        // したのに取扱説明書の事前生成が走っていた。
        // 入口が複数あるものは、入口ごとではなく実行する側で塞ぐ。
        if (!IsPregenerationEnabled()) return;

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
        string helpPregenerateNote = IsPregenerationEnabled() ? "事前生成は間に合っていなかった" : "事前生成は設定でオフ";
        Logger.Write(isNew
            ? $"OpenHelpWindow: 新規に開いた({helpPregenerateNote}, {sw.ElapsedMilliseconds}ms)"
            : $"OpenHelpWindow: 既存インスタンスを表示({(_helpWindow.IsRevealed ? "事前生成/前回分の読み込み完了済み" : "まだ読み込み中")}, {sw.ElapsedMilliseconds}ms)");
    }

    /// <summary>
    /// 取扱説明書ウィンドウをユーザーがまだ開いていない段階で裏で作っておく(体感速度対策)。
    /// <see cref="_helpPregenerateTimer"/>から遅延して1回だけ呼ばれる。<see cref="PregenerateSettingsWindow"/>と
    /// 全く同じ構成・同じ理由。
    /// </summary>
    private void PregenerateHelpWindow()
    {
        // 設定の判定はここでも行う(理由はPregenerateSettingsWindowの説明を参照)。
        if (!IsPregenerationEnabled()) return;

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
                latest.WindowMaximized = _settings.WindowMaximized;
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
