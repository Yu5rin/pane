using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Security;
using System.Text;
using System.Text.Json;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace Pane;

/// <summary>
/// 本文エリアへドラッグ&amp;ドロップされたファイルの中身。WebView2は標準のDOM File APIでは
/// 実パスを公開しないため、パスではなくファイル名とバイト列で受け渡す。
/// </summary>
internal sealed record DroppedFileContent(string Name, byte[] Bytes);

/// <summary>
/// Paneのウィンドウ。WebView2でPhase 1のエディタ(dist/index.html)を表示し、
/// postMessageのJSONブリッジでファイルの開閉・保存を仲介する。
/// ファイルの実体はこのクラス(C#側)だけが触り、JS側へは本文文字列とモード情報のみを渡す。
///
/// Phase 3: 1ウィンドウ=1ファイルを基本とし、複数ウィンドウ管理は
/// <see cref="PaneApplicationContext"/> が担う。このクラス自身は自分のウィンドウの
/// ファイルI/O・自動保存・外部変更検知・読み取り専用検知のみに責務を持つ。
/// </summary>
internal sealed class MainForm : Form
{
    private const string VirtualHostName = "pane.local";
    private const int AutoSaveIntervalMs = 30_000;
    private const int ExternalChangeDebounceMs = 300;

    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
    };

    private readonly WebView2 _webView = new();
    private readonly string? _initialPath;
    /// <summary>起動時の動作(startupBehavior)が"customFolder"のときに読み込むフォルダ。
    /// <see cref="PaneApplicationContext"/> から渡される。</summary>
    private readonly string? _initialFolderPath;
    private readonly AutoSaveSnapshot? _recoverFrom;
    private readonly DroppedFileContent? _droppedFile;
    private readonly Action<string?>? _requestNewWindow;
    private readonly Action<DroppedFileContent>? _requestNewWindowWithContent;
    private readonly Action<MainForm>? _requestSwitchDocument;
    /// <summary>設定の保存後、自分のウィンドウ以外にも変更を反映してもらうためのコールバック
    /// (設定はアプリ全体で共有されるため)。<see cref="PaneApplicationContext"/> が全ウィンドウへ
    /// apply-settingsを再送する処理を渡す。requestSwitchDocumentと同じ流儀。</summary>
    private readonly Action? _requestBroadcastSettings;
    /// <summary>設定画面(独立ウィンドウ)を開く要求。<see cref="PaneApplicationContext"/> が
    /// 「既に開いていれば前面へ、無ければ新規に開く」処理を渡す。呼び出し元ウィンドウ(このMainForm)
    /// を中央配置の基準として渡す必要があるため、requestNewWindowと違い自分自身を渡す形。</summary>
    private readonly Action<MainForm>? _requestOpenSettingsWindow;
    private readonly System.Windows.Forms.Timer _autoSaveTimer;
    private readonly System.Windows.Forms.Timer _externalChangeDebounceTimer;

    // ---- 全画面表示(仕様書 第2.5節 V-08)。解除時に元のスタイル・状態へ正確に戻すため退避しておく。 ----
    private bool _isFullscreen;
    private FormBorderStyle _preFullscreenBorderStyle;
    private FormWindowState _preFullscreenWindowState;

    // WebView2環境をプロセス全体で1回だけ生成してキャッシュする(B-2: プリロード常駐時の高速化)。
    // preload待機中にPaneApplicationContextが先取りで生成しておき、実際にウィンドウを開いたときは
    // ここで再利用することでCreateAsyncの待ち時間を省く。通常起動時もこの経路を通って構わない。
    private static readonly SemaphoreSlim EnvironmentLock = new(1, 1);
    private static CoreWebView2Environment? _cachedEnvironment;

    private FileSystemWatcher? _watcher;
    private bool _suppressWatcher;
    private bool _externalChangePending;

    private string? _currentPath;
    private FileEncodingKind _currentEncoding = FileEncodingKind.Utf8;
    private LineEndingKind _currentLineEnding = LineEndingKind.Crlf;
    private bool _hasTrailingNewline = true;
    private bool _isDirty;
    private bool _isReadOnly;

    /// <summary>現在サイドバーに読み込み済みのフォルダのルートパス(仕様書 第2.8節)。
    /// ファイルを開くたびに同じフォルダを再走査しないよう、これと比較する。</summary>
    private string? _loadedFolderRootPath;
    /// <summary>実行中のフォルダ走査を中断するためのトークン。新しい走査を始める際に前のものをキャンセルする。</summary>
    private CancellationTokenSource? _folderScanCts;
    /// <summary>実行中のグローバル検索を中断するためのトークン。フォルダ走査用とは独立させ、
    /// 検索中に別のフォルダ走査(ファイルを開いた際の自動読み込み等)が走っても互いに干渉しないようにする。</summary>
    private CancellationTokenSource? _searchCts;

    /// <summary>ConfirmDiscardDirtyAsyncの「保存する」選択時、JS側の保存完了(save-result)を待つための待機口。</summary>
    private TaskCompletionSource<bool>? _saveCompletionSource;
    /// <summary>ConfirmDiscardDirtyAsyncを通過した後、確認を再表示せずにClose()を通すためのフラグ。</summary>
    private bool _forceClose;

    /// <summary>タイトルバーの配色(案A): JS側("titlebar-color"メッセージ)から届いた実際の描画色。
    /// 未受信の間はnullのままで、その場合<see cref="WindowChrome"/>側の既定色(案B)が使われる。</summary>
    private string? _titlebarBackgroundOverride;
    private string? _titlebarForegroundOverride;

    /// <summary>自動保存スナップショットの識別子。ウィンドウごとに一意。</summary>
    public Guid WindowId { get; } = Guid.NewGuid();

    public string? CurrentPath => _currentPath;

    public bool IsDirty => _isDirty;

    public MainForm(
        string? initialPath,
        AutoSaveSnapshot? recoverFrom = null,
        Action<string?>? requestNewWindow = null,
        Action<DroppedFileContent>? requestNewWindowWithContent = null,
        Action<MainForm>? requestSwitchDocument = null,
        Action? requestBroadcastSettings = null,
        Action<MainForm>? requestOpenSettingsWindow = null,
        DroppedFileContent? droppedFile = null,
        string? initialFolderPath = null)
    {
        _initialPath = initialPath;
        _initialFolderPath = initialFolderPath;
        _recoverFrom = recoverFrom;
        _droppedFile = droppedFile;
        _requestNewWindow = requestNewWindow;
        _requestNewWindowWithContent = requestNewWindowWithContent;
        _requestSwitchDocument = requestSwitchDocument;
        _requestBroadcastSettings = requestBroadcastSettings;
        _requestOpenSettingsWindow = requestOpenSettingsWindow;
        Logger.Write($"MainForm生成: initialPath={initialPath ?? "(なし)"}, recoverFrom={(recoverFrom is null ? "なし" : recoverFrom.OriginalPath ?? "無題")}, droppedFile={droppedFile?.Name ?? "なし"}");

        Text = "Pane";
        Width = 960;
        Height = 720;
        StartPosition = FormStartPosition.WindowsDefaultLocation;
        try
        {
            Icon = new Icon(Path.Combine(AppContext.BaseDirectory, "Assets", "Pane.ico"));
        }
        catch
        {
            // 仮アイコンが見つからなくても起動は継続する(実行ファイル埋め込みアイコンが使われる)
        }

        // ウィンドウのうちWebView2に覆われていない部分(タイトルバー等)へのD&D用。
        // クライアント領域はWebView2が全面を覆うため、そちらへのドロップは下記のとおり
        // WebView2(Webページ側のJavaScript)が受け取る。
        AllowDrop = true;
        DragEnter += OnDragEnter;
        DragOver += OnDragEnter;
        DragDrop += OnDragDrop;
        DragLeave += OnDragLeave;

        _webView.Dock = DockStyle.Fill;
        // AllowExternalDropは既定のtrueのままにする(明示的に設定しない)。
        // falseにすると「外部からのドロップを無効化」する設定となり、WebView2が
        // ドロップを受け付けない旨をOSへ表明するため、本文エリア上では常に禁止マークが出て、
        // Webページ側のJavaScript(main.jsのdragover/dropハンドラ)にもイベントが一切届かない。
        // ファイルのD&DはJavaScript側で受け取り、open-dropped-fileメッセージでC#へ渡す。
        Controls.Add(_webView);

        // 起動直後・ウィンドウ切替後の初回キー入力がWebView2内のコンテンツへ届かない
        // (フォーカスがネイティブのフォーム側に留まる)ことがあるため、明示的にフォーカスを移す。
        Shown += (_, _) => { Logger.Write("Form.Shown: _webView.Focus()"); _webView.Focus(); };
        Activated += (_, _) => { Logger.Write("Form.Activated: _webView.Focus()"); _webView.Focus(); };

        _autoSaveTimer = new System.Windows.Forms.Timer { Interval = AutoSaveIntervalMs };
        _autoSaveTimer.Tick += (_, _) => RequestAutoSaveSnapshot();

        _externalChangeDebounceTimer = new System.Windows.Forms.Timer { Interval = ExternalChangeDebounceMs };
        _externalChangeDebounceTimer.Tick += OnExternalChangeDebounceElapsed;

        Load += OnLoadAsync;
        // ウィンドウを閉じる操作(Xボタン・Alt+F4・File>閉じる)すべてがここを通る。
        // 未保存の変更があれば保存するか確認してから閉じる(仕様書: 編集中のファイルを
        // 閉じるときに保存を確認する)。
        FormClosing += OnFormClosingAsync;
        FormClosed += (_, _) =>
        {
            Logger.Write("Form.FormClosed");
            _autoSaveTimer.Stop();
            _watcher?.Dispose();
            // 自動保存のスナップショットを消す(仕様書 N-06)。
            // 従来は「明示保存が成功したとき」だけ消していたため、未保存のまま
            // 「保存しない」を選んで閉じた場合にスナップショットが残り、次回起動時に
            // 異常終了とみなされて復元確認ダイアログが出てしまっていた。
            // ここまで到達するのは正常に閉じた場合だけ(異常終了ならFormClosedは走らない)
            // なので、残っているスナップショット=前回が異常終了、という判定が正しくなる。
            AutoSaveService.DeleteSnapshot(WindowId);
        };
    }

    /// <summary>
    /// ウィンドウのネイティブハンドルが生成された直後(タイトルバーの配色を反映できる最初のタイミング)。
    /// この時点ではまだJS側からの実描画色(titlebar-color)は届いていないため、案B(既定色)で塗る。
    /// </summary>
    protected override void OnHandleCreated(EventArgs e)
    {
        base.OnHandleCreated(e);
        ApplyTitleBarTheme();
    }

    /// <summary>
    /// タイトルバー(ネイティブキャプション)の配色を現在の設定に合わせて塗り直す。
    /// 呼び出しタイミング: (1)ウィンドウ生成直後(<see cref="OnHandleCreated"/>)、
    /// (2)JS側からのテーマ変更("set-theme")受信時、(3)設定の再配信(<see cref="PostCapabilities"/>)。
    /// 実際の色は案B(既定の代表色)でまず決め、JS側から届いた実描画色(<see cref="_titlebarBackgroundOverride"/>等)
    /// があればそちらで上書きする。<see cref="WindowChrome"/>側で例外はすべて握りつぶされるため、
    /// ここから先で失敗してもアプリは落ちない。
    /// </summary>
    private void ApplyTitleBarTheme() => ApplyTitleBarTheme(SettingsService.Load());

    private void ApplyTitleBarTheme(AppSettings settings)
    {
        if (!IsHandleCreated) return;
        bool isDark = ResolveIsDarkTheme(settings.Theme);
        WindowChrome.ApplyTheme(Handle, isDark, _titlebarBackgroundOverride, _titlebarForegroundOverride);
    }

    /// <summary>設定の"theme"("system"/"light"/"dark")を実際のダーク/ライト判定に解決する。
    /// "system"のときはWindowsのアプリ配色設定(レジストリ)に従う。想定外の値もsystem扱い。</summary>
    internal static bool ResolveIsDarkTheme(string theme) => theme switch
    {
        "dark" => true,
        "light" => false,
        _ => WindowChrome.IsSystemDarkTheme(),
    };

    /// <summary>
    /// 未保存の変更がある場合、閉じる・新規作成・別のファイルを開く等、現在の文書を
    /// 置き換えるあらゆる操作の前に呼ぶ。保存する/しない/キャンセルを確認し、「保存する」が
    /// 選ばれた場合はJS側に保存を依頼してその完了(save-result)を待つ。
    /// 戻り値がtrueなら呼び出し元の操作を続行してよい。falseなら中止する。
    /// </summary>
    private async Task<bool> ConfirmDiscardDirtyAsync()
    {
        if (!_isDirty) return true;

        DialogResult choice = MessageBox.Show(
            this,
            "保存されていない変更があります。保存しますか?",
            "Pane",
            MessageBoxButtons.YesNoCancel,
            MessageBoxIcon.Warning);
        Logger.Write($"ConfirmDiscardDirtyAsync: 選択={choice}");

        if (choice == DialogResult.Cancel) return false;
        if (choice == DialogResult.No) return true;

        // 保存する: 本文はJS(CodeMirror)側にしか無いため、保存を要求して完了を待つ。
        _saveCompletionSource = new TaskCompletionSource<bool>();
        PostToWeb(new { type = "request-save" });
        bool saved = await _saveCompletionSource.Task;
        Logger.Write($"ConfirmDiscardDirtyAsync: 保存結果={saved}");
        return saved;
    }

    private async void OnFormClosingAsync(object? sender, FormClosingEventArgs e)
    {
        if (_forceClose) return;
        Logger.Write($"FormClosing: isDirty={_isDirty}");
        e.Cancel = true; // 非同期の確認・保存が終わるまでいったん保留する
        if (!await ConfirmDiscardDirtyAsync()) return;
        _forceClose = true;
        Close();
    }

    private async void OnLoadAsync(object? sender, EventArgs e)
    {
        Logger.Write("OnLoadAsync開始");

        CoreWebView2Environment env = await EnsureEnvironmentAsync();
        await _webView.EnsureCoreWebView2Async(env);
        Logger.Write($"WebView2初期化完了: バージョン={_webView.CoreWebView2.Environment.BrowserVersionString}");

        // ブラウザ既定のアクセラレータキー(Ctrl+U=ソース表示、Ctrl+F=検索、Ctrl+P=印刷、
        // F3=検索、F12=DevTools等)を無効化する。無効化しないとPane独自のショートカット
        // (仕様書 第2章のCtrl+U下線・Ctrl+F検索・Ctrl+Alt+P印刷等)より先にWebView2側の
        // 既定動作が奪ってしまい、JS側のkeydownハンドラに届かない。開発者ツールは
        // Viewメニュー(Shift+F12、独自ハンドラ)から明示的に開けるようにしている。
        _webView.CoreWebView2.Settings.AreBrowserAcceleratorKeysEnabled = false;
        // Ctrl+マウスホイールによるページ全体のズームを無効化する。有効なままだと
        // 本文だけでなくメニューバー・ステータスバーまで拡大縮小されてしまうため、
        // 文字サイズの変更はJS側で本文(CodeMirror)のフォントサイズのみを変える。
        _webView.CoreWebView2.Settings.IsZoomControlEnabled = false;
        _webView.CoreWebView2.WebMessageReceived += OnWebMessageReceived;

        string distPath = ResolveDistPath();
        Logger.Write($"distPath={distPath} (存在={Directory.Exists(distPath)}, index.html存在={File.Exists(Path.Combine(distPath, "index.html"))})");
        _webView.CoreWebView2.SetVirtualHostNameToFolderMapping(
            VirtualHostName, distPath, CoreWebView2HostResourceAccessKind.Allow);
        _webView.CoreWebView2.Navigate($"https://{VirtualHostName}/index.html");
        Logger.Write("Navigate呼び出し完了");
    }

    /// <summary>
    /// CoreWebView2Environmentの生成はプロセス全体で1回だけ行い、以後は使い回す(B-2)。
    /// プリロード常駐時は<see cref="PaneApplicationContext"/>がウィンドウ生成前にこれを呼んで
    /// 先にWebView2の初期化を済ませておくため、実際にウィンドウを表示する段になってから
    /// CreateAsyncを待つ必要が無くなり、体感の起動速度が上がる。通常起動時もこの経路で構わない
    /// (初回呼び出しがOnLoadAsync自身になるだけで、動作は従来どおり)。
    /// </summary>
    public static async Task<CoreWebView2Environment> EnsureEnvironmentAsync()
    {
        if (_cachedEnvironment is not null) return _cachedEnvironment;

        await EnvironmentLock.WaitAsync();
        try
        {
            if (_cachedEnvironment is not null) return _cachedEnvironment;

            string userDataFolder = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                "Pane", "WebView2");
            _cachedEnvironment = await CoreWebView2Environment.CreateAsync(userDataFolder: userDataFolder);
            Logger.Write("CoreWebView2Environment生成完了(プロセス全体でキャッシュ)");
            return _cachedEnvironment;
        }
        finally
        {
            EnvironmentLock.Release();
        }
    }

    /// <summary>dist/ フォルダの実パスを解決する。<see cref="SettingsWindow"/> も同じ流儀で
    /// 仮想ホスト名のマッピングを行うため、internal static として共有する。</summary>
    internal static string ResolveDistPath()
    {
#if DEBUG
        // 開発時: リポジトリ直下の dist/(`npm run build` の成果物)をプロジェクトツリーを
        // 遡って探す。bin出力のフォルダ階層に依存しないようにするための探索。
        string? dir = AppContext.BaseDirectory;
        for (int i = 0; i < 8 && !string.IsNullOrEmpty(dir); i++)
        {
            string candidate = Path.Combine(dir, "dist");
            if (File.Exists(Path.Combine(candidate, "index.html")))
            {
                return candidate;
            }
            dir = Path.GetDirectoryName(dir.TrimEnd(Path.DirectorySeparatorChar));
        }
        throw new DirectoryNotFoundException(
            "開発ビルド用のdist/が見つかりません。リポジトリ直下で `npm run build` を実行してください。");
#else
        // リリース時: exeと同階層のdist/(仕様書 第7章)。
        // 単一ファイル発行(PublishSingleFile + IncludeAllContentForSelfExtract)では、
        // AppContext.BaseDirectoryは実行のたびに自己展開される一時フォルダ
        // (%TEMP%\.net\Pane\...)を指してしまい、exeの隣に置いたdist/には辿り着けない。
        // 実際にexeが置かれている場所はEnvironment.ProcessPathから取得する。
        string? exeDir = Path.GetDirectoryName(Environment.ProcessPath);
        return Path.Combine(exeDir ?? AppContext.BaseDirectory, "dist");
#endif
    }

    private void OnWebMessageReceived(object? sender, CoreWebView2WebMessageReceivedEventArgs e)
    {
        using JsonDocument doc = JsonDocument.Parse(e.WebMessageAsJson);
        JsonElement root = doc.RootElement;
        string type = root.TryGetProperty("type", out JsonElement typeProp) ? typeProp.GetString() ?? "" : "";
        // "dirty"は入力のたびに飛んでくるため、ログが埋もれないよう対象外にする。
        if (type != "dirty") Logger.Write($"JSからのメッセージ受信: type={type}");

        switch (type)
        {
            case "ready":
                PostCapabilities();
                PostWindowState();
                if (_recoverFrom is not null) RestoreFromSnapshot(_recoverFrom);
                else if (_droppedFile is not null) OpenDroppedContent(_droppedFile.Name, _droppedFile.Bytes);
                else if (_initialPath is not null) OpenFile(_initialPath);
                else OpenNewDocument();
                // startupBehaviorが"customFolder"のとき、PaneApplicationContextから渡されたフォルダを
                // サイドバーへ読み込む(仕様書 一般 startupFolderPath)。自動保存タイマーの起動可否・間隔は
                // PostCapabilities内のApplyAutoSaveSettingsで設定済み(autoSaveEnabled=falseなら動かさない)。
                if (_initialFolderPath is not null) _ = LoadFolderAsync(_initialFolderPath);
                break;
            case "open":
                // 新規作成・開くは現在のウィンドウを置き換えず、常に新しいウィンドウで開く。
                HandleOpenRequest();
                break;
            case "open-path":
                if (root.TryGetProperty("path", out JsonElement openPathProp))
                {
                    _ = HandleOpenPathRequestAsync(openPathProp.GetString() ?? "");
                }
                break;
            case "save":
                HandleSaveRequest(root);
                break;
            case "dirty":
                if (root.TryGetProperty("value", out JsonElement dirtyProp))
                {
                    SetDirty(dirtyProp.GetBoolean());
                }
                break;
            case "text-response":
                if (root.TryGetProperty("text", out JsonElement textProp))
                {
                    WriteAutoSaveSnapshot(textProp.GetString() ?? "");
                }
                break;
            case "open-settings":
                ShowSettingsDialog();
                break;
            case "new":
                // 現在のウィンドウの内容には触れず、新しいウィンドウで空の文書を開く。
                _requestNewWindow?.Invoke(null);
                break;
            case "new-window":
                _requestNewWindow?.Invoke(null);
                break;
            case "close":
                Close();
                break;
            case "print":
                _ = HandlePrintRequestAsync();
                break;
            case "open-devtools":
                HandleOpenDevToolsRequest();
                break;
            case "open-default-apps-settings":
                SettingsBridge.OpenDefaultAppsSettings();
                break;
            case "open-with-dialog":
                SettingsBridge.HandleOpenWithDialog(root, this);
                break;
            case "close-menu":
                // 本文側でクリックされた。ネイティブポップアップはWebView2内のクリックを
                // 検知できないため、JS側から閉じる指示を受けて閉じる(src/commands.js)。
                NativeMenu.CloseCurrent();
                break;
            case "export":
                _ = HandleExportRequestAsync(root);
                break;
            case "insert-image":
                HandleInsertImageRequest(root);
                break;
            case "open-dropped-file":
                HandleOpenDroppedFile(root);
                break;
            case "log":
                // JS側の不具合調査ログ(main.jsのlogToHost)をC#側と同じログファイルへ集約する。
                string level = root.TryGetProperty("level", out JsonElement levelProp) ? levelProp.GetString() ?? "log" : "log";
                string logMessage = root.TryGetProperty("message", out JsonElement msgProp) ? msgProp.GetString() ?? "" : "";
                Logger.Write($"[JS:{level}] {logMessage}");
                break;
            case "set-theme":
                if (root.TryGetProperty("theme", out JsonElement themeProp))
                {
                    SaveTheme(themeProp.GetString() ?? "system");
                    ApplyTitleBarTheme(); // テーマ変更を即座にタイトルバーへも反映する
                }
                break;
            case "titlebar-color":
                // 案A: JS側から実際の描画色(--paper/--inkの計算結果)が届いた場合の受け口。
                // { type: "titlebar-color", background: "#RRGGBB", foreground: "#RRGGBB" }
                string? titlebarBackground = root.TryGetProperty("background", out JsonElement tbBgProp) ? tbBgProp.GetString() : null;
                string? titlebarForeground = root.TryGetProperty("foreground", out JsonElement tbFgProp) ? tbFgProp.GetString() : null;
                Logger.Write($"titlebar-color受信: background={titlebarBackground ?? "(なし)"}, foreground={titlebarForeground ?? "(なし)"}");
                if (!string.IsNullOrWhiteSpace(titlebarBackground)) _titlebarBackgroundOverride = titlebarBackground;
                if (!string.IsNullOrWhiteSpace(titlebarForeground)) _titlebarForegroundOverride = titlebarForeground;
                ApplyTitleBarTheme();
                break;
            case "set-font-size":
                if (root.TryGetProperty("size", out JsonElement sizeProp) && sizeProp.ValueKind == JsonValueKind.Number)
                {
                    SaveFontSize(sizeProp.GetInt32());
                }
                break;
            case "open-folder":
                HandleOpenFolderRequest();
                break;
            case "load-folder":
                if (root.TryGetProperty("path", out JsonElement loadFolderPathProp))
                {
                    string? folderPath = loadFolderPathProp.GetString();
                    if (!string.IsNullOrEmpty(folderPath))
                    {
                        _ = LoadFolderAsync(folderPath);
                    }
                }
                break;
            case "global-search":
                HandleGlobalSearchRequest(root);
                break;
            case "cancel-search":
                Logger.Write("cancel-search受信: 実行中の検索をキャンセル");
                _searchCts?.Cancel();
                break;
            case "toggle-fullscreen":
                ToggleFullscreen();
                break;
            case "toggle-always-on-top":
                ToggleAlwaysOnTop();
                break;
            case "switch-document":
                _requestSwitchDocument?.Invoke(this);
                break;
            case "get-settings":
                // HTML製の設定画面からの読み込み要求。既存のopen-settings/SettingsForm
                // とは独立した経路として追加する(置き換えはしない)。実処理はSettingsWindowと
                // 共有するためSettingsBridgeへ切り出してある。
                SettingsBridge.PostSettingsSnapshot(PostToWeb);
                break;
            case "save-settings":
                SettingsBridge.HandleSaveSettingsRequest(root, PostToWeb, BroadcastOrRefreshSelf);
                break;
            case "browse-path":
                SettingsBridge.HandleBrowsePathRequest(root, this, PostToWeb);
                break;
            case "remember-file-mode":
                HandleRememberFileModeRequest(root);
                break;
            case "clear-recent-files":
                SettingsBridge.HandleClearRecentFilesRequest(BroadcastOrRefreshSelf);
                break;
            case "clear-per-file-modes":
                SettingsBridge.HandleClearPerFileModesRequest(BroadcastOrRefreshSelf);
                break;
            case "open-settings-file":
                SettingsBridge.OpenSettingsFileInExplorer();
                break;
            case "reset-settings":
                SettingsBridge.HandleResetSettingsRequest(PostToWeb, BroadcastOrRefreshSelf);
                break;
            case "open-settings-window":
                // 設定画面を独立ウィンドウとして開く(または既に開いていれば前面へ)。
                // 実体はPaneApplicationContext.OpenSettingsWindowが持つ(同時に1つしか開かない)。
                _requestOpenSettingsWindow?.Invoke(this);
                break;
            case "open-menu":
                // メニューバーの見出しがクリックされた(またはAltキー操作で開かれた)。
                // ネイティブなポップアップ(Pane/NativeMenu.cs)で表示する(ユーザー要望:
                // ウィンドウを小さくしても項目数の多いメニューが画面外へはみ出さないように)。
                HandleOpenMenuRequest(root);
                break;
        }
    }

    // ---- ネイティブメニュー(仕様書外・ユーザー要望。Pane/NativeMenu.cs) ----

    /// <summary>
    /// { type: "open-menu", menu, x, y, items } を受け取り、ToolStripDropDownMenuを表示する。
    /// x/yはJS側(src/commands.js)がWebView2内のCSSピクセル座標(見出しボタンのgetBoundingClientRect()の
    /// left/bottom)で送ってくる。画面座標への変換は次の2段階:
    ///   1. CSSピクセル → WebView2コントロール内のデバイスピクセルへ、DeviceDpi(96分率)倍率を掛けて変換する。
    ///      WebView2(Chromium)はホストHWNDのDPIに合わせて内部的にページを実ピクセルへ拡大縮小して描画しており、
    ///      WinForms側のControl座標系(_webView.Width/Height等)は常にそのデバイスピクセルで表現されるため、
    ///      CSSピクセルをそのまま使うとDPI125%/150%等の環境でクリック位置とズレる。
    ///   2. _webView.PointToScreen(...)で、WebView2コントロール内のデバイスピクセル座標を画面座標(スクリーン座標)へ変換する。
    /// 選ばれた項目は"menu-command"、選ばずに閉じられた場合は"menu-closed"としてJSへ返す
    /// (実際のコマンド実行は引き続きJS側のcommand.run()が行う。C#側はコマンドの実装を一切持たない)。
    /// </summary>
    private void HandleOpenMenuRequest(JsonElement root)
    {
        string menuName = root.TryGetProperty("menu", out JsonElement menuProp) ? menuProp.GetString() ?? "" : "";
        double cssX = root.TryGetProperty("x", out JsonElement xProp) && xProp.ValueKind == JsonValueKind.Number ? xProp.GetDouble() : 0;
        double cssY = root.TryGetProperty("y", out JsonElement yProp) && yProp.ValueKind == JsonValueKind.Number ? yProp.GetDouble() : 0;
        List<NativeMenu.MenuItemData> items = root.TryGetProperty("items", out JsonElement itemsProp) && itemsProp.ValueKind == JsonValueKind.Array
            ? ParseMenuItems(itemsProp)
            : new List<NativeMenu.MenuItemData>();

        double dpiScale = DeviceDpi / 96.0;
        var clientPoint = new Point((int)Math.Round(cssX * dpiScale), (int)Math.Round(cssY * dpiScale));
        Point screenPoint = _webView.PointToScreen(clientPoint);
        Logger.Write($"open-menu: menu={menuName}, 項目数={items.Count}, cssPoint=({cssX},{cssY}), DeviceDpi={DeviceDpi}, clientPoint=({clientPoint.X},{clientPoint.Y}), screenPoint=({screenPoint.X},{screenPoint.Y})");

        bool isDark = ResolveIsDarkTheme(SettingsService.Load().Theme);
        NativeMenu.Show(
            screenPoint,
            isDark,
            items,
            onCommand: id => PostToWeb(new { type = "menu-command", id }),
            onClosed: () => PostToWeb(new { type = "menu-closed", menu = menuName }));
    }

    /// <summary>"open-menu"のitems配列(入れ子のsubmenuを含む)をJSONから<see cref="NativeMenu.MenuItemData"/>へ変換する。</summary>
    private static List<NativeMenu.MenuItemData> ParseMenuItems(JsonElement arrayElement)
    {
        var list = new List<NativeMenu.MenuItemData>();
        foreach (JsonElement el in arrayElement.EnumerateArray())
        {
            string? id = el.TryGetProperty("id", out JsonElement idProp) && idProp.ValueKind == JsonValueKind.String ? idProp.GetString() : null;
            string label = el.TryGetProperty("label", out JsonElement labelProp) ? labelProp.GetString() ?? "" : "";
            string shortcut = el.TryGetProperty("shortcut", out JsonElement scProp) ? scProp.GetString() ?? "" : "";
            bool enabled = !el.TryGetProperty("enabled", out JsonElement enProp) || enProp.ValueKind != JsonValueKind.False;
            bool isChecked = el.TryGetProperty("checked", out JsonElement chProp) && chProp.ValueKind == JsonValueKind.True;
            bool separatorAfter = el.TryGetProperty("separatorAfter", out JsonElement sepProp) && sepProp.ValueKind == JsonValueKind.True;
            string note = el.TryGetProperty("note", out JsonElement noteProp) ? noteProp.GetString() ?? "" : "";
            List<NativeMenu.MenuItemData>? submenu = el.TryGetProperty("submenu", out JsonElement subProp) && subProp.ValueKind == JsonValueKind.Array
                ? ParseMenuItems(subProp)
                : null;
            list.Add(new NativeMenu.MenuItemData(id, label, shortcut, enabled, isChecked, separatorAfter, note, submenu));
        }
        return list;
    }

    // ---- ウィンドウ制御(仕様書 第2.5節 V-08・V-11・V-12) ----

    /// <summary>
    /// 全画面表示のトグル(F11)。全画面にする際はFormBorderStyle=NoneかつWindowState=Maximizedとし、
    /// 解除時に正しく戻せるよう元のFormBorderStyle・WindowStateを退避しておく。
    /// 既に最大化されていた状態から全画面→解除した場合も、最大化へ戻す(単純にNormalへ戻すと縮む)。
    /// </summary>
    private void ToggleFullscreen()
    {
        if (_isFullscreen)
        {
            // 復元: 先に外枠を戻してからWindowStateを戻す。WindowStateを先に戻すと
            // (元がMaximizedの場合)枠の無いまま最大化された状態を経由してしまうため。
            FormBorderStyle = _preFullscreenBorderStyle;
            WindowState = _preFullscreenWindowState;
            _isFullscreen = false;
        }
        else
        {
            _preFullscreenBorderStyle = FormBorderStyle;
            _preFullscreenWindowState = WindowState;
            FormBorderStyle = FormBorderStyle.None;
            WindowState = FormWindowState.Maximized;
            _isFullscreen = true;
        }
        Logger.Write($"ToggleFullscreen: fullscreen={_isFullscreen}");
        PostWindowState();
    }

    /// <summary>常に手前に表示のトグル(仕様書 V-12)。</summary>
    private void ToggleAlwaysOnTop()
    {
        TopMost = !TopMost;
        Logger.Write($"ToggleAlwaysOnTop: alwaysOnTop={TopMost}");
        PostWindowState();
    }

    /// <summary>全画面・常に手前に表示の現在値をメニューのチェック表示用にJS側へ通知する。</summary>
    private void PostWindowState()
    {
        PostToWeb(new { type = "window-state", fullscreen = _isFullscreen, alwaysOnTop = TopMost });
    }

    private async Task HandleOpenPathRequestAsync(string path)
    {
        if (!await ConfirmDiscardDirtyAsync()) return;
        OpenFile(path);
    }

    /// <summary>
    /// File &gt; 開く。選ばれたファイルは現在のウィンドウを置き換えず、新しいウィンドウで開く
    /// (仕様書外・ユーザー要望: 新規作成・開くは常に別ウィンドウ)。
    /// </summary>
    private void HandleOpenRequest()
    {
        using var dialog = new OpenFileDialog
        {
            Filter = "Markdown / テキスト (*.md;*.markdown;*.mdown;*.txt)|*.md;*.markdown;*.mdown;*.txt|すべてのファイル (*.*)|*.*",
        };
        if (dialog.ShowDialog(this) == DialogResult.OK)
        {
            _requestNewWindow?.Invoke(dialog.FileName);
        }
    }

    private void HandleSaveRequest(JsonElement message)
    {
        string text = message.TryGetProperty("text", out JsonElement textProp) ? textProp.GetString() ?? "" : "";
        bool saveAs = message.TryGetProperty("saveAs", out JsonElement saveAsProp) && saveAsProp.GetBoolean();

        if (_isReadOnly && !saveAs)
        {
            DialogResult choice = MessageBox.Show(
                this,
                "このファイルは読み取り専用です。上書きできません。\n名前を付けて別のファイルとして保存しますか?",
                "Pane",
                MessageBoxButtons.YesNo,
                MessageBoxIcon.Warning);
            if (choice != DialogResult.Yes)
            {
                CompleteSave(ok: false);
                PostToWeb(new { type = "save-result", ok = false, canceled = true });
                return;
            }
            saveAs = true;
        }

        string? targetPath = _currentPath;
        if (saveAs || targetPath is null)
        {
            string defaultExt = SettingsService.Load().DefaultFileExtension;
            using var dialog = new SaveFileDialog
            {
                Filter = BuildSaveFilter(defaultExt),
                FilterIndex = 1,
                DefaultExt = defaultExt,
                FileName = _currentPath is null ? $"無題.{defaultExt}" : Path.GetFileName(_currentPath),
            };
            if (_currentPath is not null)
            {
                dialog.InitialDirectory = Path.GetDirectoryName(_currentPath);
            }
            if (dialog.ShowDialog(this) != DialogResult.OK)
            {
                CompleteSave(ok: false);
                PostToWeb(new { type = "save-result", ok = false, canceled = true });
                return;
            }
            targetPath = dialog.FileName;
        }

        try
        {
            SuppressWatcherDuring(() =>
                TextFileService.SaveAtomic(targetPath, text, _currentEncoding, _currentLineEnding, _hasTrailingNewline));
            _currentPath = targetPath;
            _isReadOnly = false;
            SetDirty(false);
            AutoSaveService.DeleteSnapshot(WindowId);
            StartWatching(targetPath);
            Logger.Write($"保存成功: {targetPath}");
            CompleteSave(ok: true);
            PostToWeb(new
            {
                type = "save-result",
                ok = true,
                fileName = Path.GetFileName(targetPath),
                path = targetPath,
                encoding = TextFileService.EncodingLabel(_currentEncoding),
                lineEnding = TextFileService.LineEndingLabel(_currentLineEnding),
            });
        }
        catch (Exception ex)
        {
            Logger.WriteException($"保存失敗: {targetPath}", ex);
            CompleteSave(ok: false);
            PostToWeb(new { type = "save-result", ok = false, error = ex.Message });
        }
    }

    /// <summary>
    /// 「名前を付けて保存」ダイアログのフィルタ文字列を組み立てる。設定の既定拡張子
    /// (defaultFileExtension)を先頭に置き、"md"/"txt"であれば重複を避けて他方も候補に加える。
    /// </summary>
    private static string BuildSaveFilter(string defaultExt)
    {
        var parts = new List<string> { $"{defaultExt.ToUpperInvariant()} (*.{defaultExt})|*.{defaultExt}" };
        if (!string.Equals(defaultExt, "md", StringComparison.OrdinalIgnoreCase))
        {
            parts.Add("Markdown (*.md)|*.md");
        }
        if (!string.Equals(defaultExt, "txt", StringComparison.OrdinalIgnoreCase))
        {
            parts.Add("テキスト (*.txt)|*.txt");
        }
        parts.Add("すべてのファイル (*.*)|*.*");
        return string.Join("|", parts);
    }

    /// <summary>ConfirmDiscardDirtyAsyncが保存完了を待っていれば、その結果を通知する。</summary>
    private void CompleteSave(bool ok)
    {
        _saveCompletionSource?.TrySetResult(ok);
        _saveCompletionSource = null;
    }

    /// <summary>
    /// ファイルダイアログ・コマンドライン引数・D&amp;D の3経路がすべてここを呼ぶ。
    /// </summary>
    public void OpenFile(string path)
    {
        Logger.Write($"OpenFile: {path}");
        try
        {
            LoadResult result = TextFileService.Load(path);
            _currentPath = path;
            _currentEncoding = result.Encoding;
            _currentLineEnding = result.LineEnding;
            _hasTrailingNewline = result.HasTrailingNewline;
            _isReadOnly = IsFileReadOnly(path);
            SetDirty(false);
            StartWatching(path);
            AddRecentFile(path);
            PostToWeb(new
            {
                type = "file-opened",
                text = result.Text,
                fileName = Path.GetFileName(path),
                path,
                encoding = TextFileService.EncodingLabel(result.Encoding),
                lineEnding = TextFileService.LineEndingLabel(result.LineEnding),
                readOnly = _isReadOnly,
            });
            // ファイルを開くと、その親フォルダを自動でサイドバーに読み込む
            // (仕様書 第2.8節「ファイルを開くと、その親フォルダが自動的に読み込まれる」)。
            AutoLoadParentFolder(path);
        }
        catch (Exception ex)
        {
            Logger.WriteException($"ファイルを開けなかった: {path}", ex);
            MessageBox.Show(
                this,
                $"ファイルを開けませんでした。\n{ex.Message}",
                "Pane",
                MessageBoxButtons.OK,
                MessageBoxIcon.Error);
        }
    }

    // ---- サイドバー用フォルダ走査(仕様書 第2.8節)。実体はFolderServiceに委譲する。 ----

    /// <summary>
    /// File &gt; フォルダを開く。<see cref="FolderBrowserDialog"/> で選ばせ、選ばれたら走査する。
    /// </summary>
    private void HandleOpenFolderRequest()
    {
        using var dialog = new FolderBrowserDialog();
        if (dialog.ShowDialog(this) == DialogResult.OK)
        {
            _ = LoadFolderAsync(dialog.SelectedPath);
        }
    }

    /// <summary>
    /// ファイルを開いた際、その親フォルダを自動で読み込む(Typoraと同じ挙動)。
    /// 既に同じフォルダを読み込み済みなら、ファイルを開くたびに毎回走査すると重いため
    /// 再走査しない。
    /// </summary>
    private void AutoLoadParentFolder(string filePath)
    {
        string? parentDir = Path.GetDirectoryName(Path.GetFullPath(filePath));
        if (parentDir is null) return;

        if (_loadedFolderRootPath is not null && PathsEqual(_loadedFolderRootPath, parentDir))
        {
            Logger.Write($"AutoLoadParentFolder: 読み込み済みのため再走査をスキップ: {parentDir}");
            return;
        }

        _ = LoadFolderAsync(parentDir);
    }

    private static bool PathsEqual(string a, string b)
    {
        static string Normalize(string p) => Path.GetFullPath(p).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
        return string.Equals(Normalize(a), Normalize(b), StringComparison.OrdinalIgnoreCase);
    }

    /// <summary>
    /// 指定フォルダをFolderServiceで走査し、結果をJS側へfolder-loadedとして送る。
    /// "open-folder"(ダイアログ選択)・"load-folder"(JSからのパス指定)・
    /// AutoLoadParentFolder(ファイルを開いた際の自動読み込み)の3経路がすべてここを通る。
    /// 走査中に別のフォルダ読み込みが始まった場合は、前の走査をキャンセルする。
    /// </summary>
    private async Task LoadFolderAsync(string path)
    {
        Logger.Write($"LoadFolderAsync開始: {path}");
        _folderScanCts?.Cancel();
        var cts = new CancellationTokenSource();
        _folderScanCts = cts;
        try
        {
            FolderScanResult result = await FolderService.ScanAsync(path, cts.Token);
            if (cts.IsCancellationRequested) return;

            _loadedFolderRootPath = result.RootPath;
            Logger.Write($"LoadFolderAsync完了: {result.RootPath}, 件数={result.Entries.Count}, truncated={result.Truncated}");
            PostToWeb(new
            {
                type = "folder-loaded",
                rootPath = result.RootPath,
                rootName = result.RootName,
                entries = result.Entries.Select(entry => new
                {
                    path = entry.Path,
                    name = entry.Name,
                    relativePath = entry.RelativePath,
                    isDirectory = entry.IsDirectory,
                }),
                truncated = result.Truncated,
            });
        }
        catch (OperationCanceledException)
        {
            // 後続のフォルダ読み込みに置き換えられた場合の正常なキャンセル。何もしない。
            Logger.Write($"LoadFolderAsync: キャンセルされた: {path}");
        }
        catch (Exception ex)
        {
            Logger.WriteException($"フォルダの読み込みに失敗: {path}", ex);
            PostToWeb(new { type = "folder-loaded", error = ex.Message });
        }
        finally
        {
            if (ReferenceEquals(_folderScanCts, cts)) _folderScanCts = null;
        }
    }

    // ---- グローバル検索(仕様書 第2.6節・第8.3節)。実体はSearchServiceに委譲する。 ----

    /// <summary>
    /// "global-search"メッセージを処理する。読み込み済みフォルダが無い・クエリが空の場合は
    /// 検索を行わずsearch-doneのみ返す。新しい検索が始まったら前の検索は必ずキャンセルする
    /// (検索欄への連続入力のたびに呼ばれるため)。
    /// </summary>
    private void HandleGlobalSearchRequest(JsonElement message)
    {
        string queryText = message.TryGetProperty("query", out JsonElement queryProp) ? queryProp.GetString() ?? "" : "";
        bool caseSensitive = message.TryGetProperty("caseSensitive", out JsonElement csProp) && csProp.ValueKind == JsonValueKind.True;
        bool regexp = message.TryGetProperty("regexp", out JsonElement reProp) && reProp.ValueKind == JsonValueKind.True;
        bool wholeWord = message.TryGetProperty("wholeWord", out JsonElement wwProp) && wwProp.ValueKind == JsonValueKind.True;

        _searchCts?.Cancel();

        if (_loadedFolderRootPath is null)
        {
            Logger.Write("global-search: フォルダ未読込のため検索できない");
            PostToWeb(new { type = "search-done", error = "フォルダが読み込まれていません" });
            return;
        }

        if (string.IsNullOrEmpty(queryText))
        {
            PostToWeb(new { type = "search-done", total = 0, truncated = false });
            return;
        }

        var cts = new CancellationTokenSource();
        _searchCts = cts;
        string rootPath = _loadedFolderRootPath;
        var query = new SearchQuery(queryText, caseSensitive, regexp, wholeWord);
        Logger.Write($"global-search開始: root={rootPath}, text=\"{queryText}\", caseSensitive={caseSensitive}, regexp={regexp}, wholeWord={wholeWord}");

        _ = RunGlobalSearchAsync(rootPath, query, cts);
    }

    private async Task RunGlobalSearchAsync(string rootPath, SearchQuery query, CancellationTokenSource cts)
    {
        // totalはonBatchのラムダから直接インクリメントする(クロージャによる参照キャプチャ)。
        // SearchService側はバッチを1つ処理し終えてから次のバッチへ進む(await onBatch(...))ため、
        // 複数スレッドから同時に触られることはなく、単純なローカル変数で安全に積算できる。
        int total = 0;
        try
        {
            await SearchService.SearchAsync(
                rootPath,
                query,
                onBatch: hits =>
                {
                    total += hits.Count;
                    return PostSearchResultsToUiThreadAsync(hits);
                },
                cts.Token);
        }
        catch (OperationCanceledException)
        {
            Logger.Write($"global-search: キャンセルされた: root={rootPath}");
            return; // 後続の検索に置き換えられた・キャンセルされた場合は何も返さない
        }
        catch (Exception ex)
        {
            Logger.WriteException($"global-search失敗: root={rootPath}", ex);
            if (ReferenceEquals(_searchCts, cts))
            {
                PostToWeb(new { type = "search-done", error = ex.Message });
            }
            return;
        }
        finally
        {
            if (ReferenceEquals(_searchCts, cts)) _searchCts = null;
        }

        // SearchAsyncはヒット総数を戻り値では返さない(仕様どおりTask)ため、
        // SearchService.MaxHitsに達したかどうかで打ち切りの有無を判定する。
        bool truncated = total >= SearchService.MaxHits;
        Logger.Write($"global-search完了: root={rootPath}, total={total}, truncated={truncated}");
        PostToWeb(new { type = "search-done", total, truncated });
    }

    /// <summary>
    /// SearchServiceからのonBatchコールバックはワーカースレッドから呼ばれるため、
    /// PostWebMessageAsJson(WebView2)の呼び出しはBeginInvokeでUIスレッドへマーシャリングする
    /// (OnFileChangedExternallyと同じ作法)。
    /// </summary>
    private Task PostSearchResultsToUiThreadAsync(IReadOnlyList<SearchHit> hits)
    {
        Logger.Write($"global-search: バッチ送信 件数={hits.Count}");
        BeginInvoke(new MethodInvoker(() =>
        {
            PostToWeb(new
            {
                type = "search-results",
                hits = hits.Select(hit => new
                {
                    path = hit.Path,
                    name = hit.Name,
                    relativePath = hit.RelativePath,
                    line = hit.Line,
                    column = hit.Column,
                    lineText = hit.LineText,
                    // 強調位置はcolumn(元の行の列番号)ではなくmatchOffset/matchLengthを使う。
                    // LineTextはSearchService側で前後100文字に切り詰められることがあり、
                    // columnは元の行基準のままずれてしまうため(不具合1)。
                    matchOffset = hit.MatchOffset,
                    matchLength = hit.MatchLength,
                }),
            });
        }));
        return Task.CompletedTask;
    }

    /// <summary>
    /// WebView2の本文エリア(Webページ側)へドラッグ&ドロップされたファイルを開く。
    /// 現在の本文が空(失われる内容が無い)ならこのウィンドウで、何か書かれていれば
    /// 新しいウィンドウで開く(空かどうかの判定はJS側が行い、newWindowで伝えてくる)。
    /// </summary>
    private void HandleOpenDroppedFile(JsonElement message)
    {
        string name = message.TryGetProperty("name", out JsonElement nameProp) ? nameProp.GetString() ?? "無題" : "無題";
        string dataBase64 = message.TryGetProperty("dataBase64", out JsonElement dataProp) ? dataProp.GetString() ?? "" : "";
        bool newWindow = message.TryGetProperty("newWindow", out JsonElement nwProp) && nwProp.ValueKind == JsonValueKind.True;
        Logger.Write($"HandleOpenDroppedFile: name={name}, newWindow={newWindow}");
        try
        {
            byte[] bytes = Convert.FromBase64String(dataBase64);
            if (newWindow)
            {
                _requestNewWindowWithContent?.Invoke(new DroppedFileContent(name, bytes));
                return;
            }
            OpenDroppedContent(name, bytes);
        }
        catch (Exception ex)
        {
            Logger.WriteException($"ドロップされたファイルを開けなかった: {name}", ex);
            MessageBox.Show(this, $"ファイルを開けませんでした。\n{ex.Message}", "Pane", MessageBoxButtons.OK, MessageBoxIcon.Error);
        }
    }

    /// <summary>
    /// ドロップされたファイルの中身をこのウィンドウで開く。標準のDOM File APIでは実パスが
    /// 分からないため、JS側でバイト列化して送ってもらい、ここで通常のOpenFile(path)と同じ
    /// エンコーディング判定にかける。パスが無いため外部変更監視・上書き保存はできず、
    /// 保存時は名前を付けて保存になる(仕様書外の代替経路)。
    /// </summary>
    private void OpenDroppedContent(string name, byte[] bytes)
    {
        LoadResult result = TextFileService.LoadBytes(bytes);
        _currentPath = null;
        _currentEncoding = result.Encoding;
        _currentLineEnding = result.LineEnding;
        _hasTrailingNewline = result.HasTrailingNewline;
        _isReadOnly = false;
        StopWatching();
        SetDirty(false);
        PostToWeb(new
        {
            type = "file-opened",
            text = result.Text,
            fileName = name,
            path = (string?)null,
            encoding = TextFileService.EncodingLabel(result.Encoding),
            lineEnding = TextFileService.LineEndingLabel(result.LineEnding),
            readOnly = false,
        });
    }

    private void OpenNewDocument()
    {
        // 新規文書の既定エンコーディング・改行コードは設定(defaultEncoding/defaultLineEnding)に従う
        // (仕様書 保存と復元)。未設定時はTextFileService側の既定でUTF-8 BOMなし・CRLFになる。
        AppSettings settings = SettingsService.Load();
        _currentPath = null;
        _currentEncoding = TextFileService.ParseEncodingKey(settings.DefaultEncoding);
        _currentLineEnding = TextFileService.ParseLineEndingKey(settings.DefaultLineEnding);
        _hasTrailingNewline = true;
        _isReadOnly = false;
        StopWatching();
        SetDirty(false);
        PostToWeb(new { type = "new-document" });
    }

    /// <summary>
    /// 異常終了後の自動保存スナップショットから復元する(仕様書 N-06)。
    /// 元ファイルの内容ではなく未保存の編集内容を表示するため、ダーティ状態で開始する。
    /// </summary>
    private void RestoreFromSnapshot(AutoSaveSnapshot snapshot)
    {
        _currentPath = snapshot.OriginalPath;
        _currentEncoding = snapshot.Encoding;
        _currentLineEnding = snapshot.LineEnding;
        _hasTrailingNewline = snapshot.HasTrailingNewline;
        _isReadOnly = snapshot.OriginalPath is not null && IsFileReadOnly(snapshot.OriginalPath);
        if (snapshot.OriginalPath is not null)
        {
            StartWatching(snapshot.OriginalPath);
        }
        PostToWeb(new
        {
            type = "file-opened",
            text = snapshot.Text,
            fileName = snapshot.OriginalPath is null ? "無題" : Path.GetFileName(snapshot.OriginalPath),
            path = snapshot.OriginalPath,
            encoding = TextFileService.EncodingLabel(snapshot.Encoding),
            lineEnding = TextFileService.LineEndingLabel(snapshot.LineEnding),
            readOnly = _isReadOnly,
        });
        SetDirty(true);
    }

    private static bool IsFileReadOnly(string path)
    {
        try
        {
            return File.GetAttributes(path).HasFlag(FileAttributes.ReadOnly);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            return false;
        }
    }

    private void SetDirty(bool value)
    {
        _isDirty = value;
        UpdateTitle();
    }

    private void UpdateTitle()
    {
        string name = _currentPath is null ? "無題" : Path.GetFileName(_currentPath);
        // 未保存であることは記号(以前は"●")ではなく文字で示す。記号だと何を意味するのか
        // 伝わらないため。ファイル名の直後に置くのは、タスクバーで幅が足りず末尾から
        // 削られても「どのファイルか」が先に残るようにするため。
        string dirtyMark = _isDirty ? "(未保存)" : string.Empty;
        string readOnlyMark = _isReadOnly ? "[読み取り専用] " : string.Empty;
        Text = $"{readOnlyMark}{name}{dirtyMark} - Pane";
    }

    private void PostToWeb(object message)
    {
        if (_webView.CoreWebView2 is null) return;
        string json = JsonSerializer.Serialize(message, JsonOptions);
        _webView.CoreWebView2.PostWebMessageAsJson(json);
    }

    private string? _lastDragLogKey;

    private void OnDragEnter(object? sender, DragEventArgs e)
    {
        // DragEnter/DragOverの両方に登録しているため、ドラッグ中は同じ内容で大量に呼ばれる。
        // 状態が変わった時だけログに残す(sender種別の切り替わりが分かれば十分な調査目的のため)。
        bool hasFileDrop = e.Data?.GetDataPresent(DataFormats.FileDrop) == true;
        string key = $"{sender?.GetType().Name}:{hasFileDrop}";
        if (key != _lastDragLogKey)
        {
            _lastDragLogKey = key;
            // e.X/e.Yは画面座標(スクリーン座標)。本文エリアの中央付近で失敗する/端で成功する、
            // といった位置依存の切り分けをするため、フォーム内座標も一緒に記録する。
            Point screenPos = new Point(e.X, e.Y);
            Point formOrigin = PointToScreen(Point.Empty);
            Point formRelative = new Point(screenPos.X - formOrigin.X, screenPos.Y - formOrigin.Y);
            Logger.Write($"OnDragEnter/Over (sender={sender?.GetType().Name}): hasFileDrop={hasFileDrop}, " +
                $"screenPos=({screenPos.X},{screenPos.Y}), formRelativePos=({formRelative.X},{formRelative.Y}), " +
                $"formBounds={Bounds}, webViewBounds={_webView.Bounds}");
        }
        e.Effect = hasFileDrop ? DragDropEffects.Copy : DragDropEffects.None;
    }

    private void OnDragLeave(object? sender, EventArgs e)
    {
        Logger.Write($"OnDragLeave (sender={sender?.GetType().Name})");
        _lastDragLogKey = null;
    }

    private async void OnDragDrop(object? sender, DragEventArgs e)
    {
        _lastDragLogKey = null; // 次のドラッグ操作でまた最初の状態からログを記録できるようにする
        Logger.Write($"OnDragDrop (sender={sender?.GetType().Name}): dataPresent={e.Data?.GetDataPresent(DataFormats.FileDrop)}");
        if (e.Data?.GetData(DataFormats.FileDrop) is string[] { Length: > 0 } paths)
        {
            Logger.Write($"OnDragDrop: paths=[{string.Join(",", paths)}]");
            if (!await ConfirmDiscardDirtyAsync()) return;
            // このウィンドウには先頭の1件を開く。複数ファイルは呼び出し元(D&D)が
            // 別ウィンドウとして開くかどうかを判断する(Phase 3のカスケード配置)。
            OpenFile(paths[0]);
        }
    }

    // ---- 自動保存(仕様書 N-06) ----

    /// <summary>
    /// 設定(autoSaveEnabled / autoSaveIntervalSeconds)を自動保存タイマーへ反映する。
    /// 設定変更時に動作中のタイマーへ即座に反映するため、PostCapabilities(設定読み込み・
    /// 全ウィンドウへの再配信のたび)から必ず呼ぶ。既定30秒(AutoSaveIntervalMs)は
    /// このメソッドが一度も呼ばれる前(コンストラクタ直後)の暫定値として使うのみ。
    /// </summary>
    private void ApplyAutoSaveSettings(AppSettings settings)
    {
        int intervalMs = settings.AutoSaveIntervalSeconds * 1000;
        if (_autoSaveTimer.Interval != intervalMs)
        {
            _autoSaveTimer.Interval = intervalMs;
        }

        if (settings.AutoSaveEnabled)
        {
            if (!_autoSaveTimer.Enabled) _autoSaveTimer.Start();
        }
        else if (_autoSaveTimer.Enabled)
        {
            _autoSaveTimer.Stop();
        }
    }

    private void RequestAutoSaveSnapshot()
    {
        if (!_isDirty) return;
        // 本文はJS(CodeMirror)側にしかないため、都度取得を依頼する。
        // 頻繁なキー入力のたびには送らず、タイマー間隔(既定30秒)でのみ発生させる。
        PostToWeb(new { type = "request-text" });
    }

    private void WriteAutoSaveSnapshot(string text)
    {
        var snapshot = new AutoSaveSnapshot(
            _currentPath, text, _currentEncoding, _currentLineEnding, _hasTrailingNewline, DateTime.UtcNow);
        AutoSaveService.WriteSnapshot(WindowId, snapshot);
    }

    // ---- 外部変更検知・読み取り専用検知(仕様書 N-11・N-12) ----

    private void StartWatching(string path)
    {
        StopWatching();
        try
        {
            string? dir = Path.GetDirectoryName(Path.GetFullPath(path));
            if (dir is null) return;

            _watcher = new FileSystemWatcher(dir, Path.GetFileName(path))
            {
                NotifyFilter = NotifyFilters.LastWrite | NotifyFilters.Size | NotifyFilters.Attributes,
            };
            _watcher.Changed += OnFileChangedExternally;
            _watcher.EnableRaisingEvents = true;
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or ArgumentException)
        {
            // 監視できなくても編集自体は継続できるようにする(ベストエフォート)。
            _watcher = null;
        }
    }

    private void StopWatching()
    {
        _watcher?.Dispose();
        _watcher = null;
    }

    private void SuppressWatcherDuring(Action action)
    {
        _suppressWatcher = true;
        if (_watcher is not null) _watcher.EnableRaisingEvents = false;
        try
        {
            action();
        }
        finally
        {
            _suppressWatcher = false;
            if (_watcher is not null) _watcher.EnableRaisingEvents = true;
        }
    }

    private void OnFileChangedExternally(object sender, FileSystemEventArgs e)
    {
        if (_suppressWatcher) return;

        // 保存操作1回でも複数のファイルシステムイベントが飛んでくることがあるため、
        // UIスレッドで短時間デバウンスしてからまとめて1回だけ確認する。
        BeginInvoke(new MethodInvoker(() =>
        {
            _externalChangePending = true;
            _externalChangeDebounceTimer.Stop();
            _externalChangeDebounceTimer.Start();
        }));
    }

    private void OnExternalChangeDebounceElapsed(object? sender, EventArgs e)
    {
        _externalChangeDebounceTimer.Stop();
        if (!_externalChangePending || _currentPath is null) return;
        _externalChangePending = false;

        string unsavedWarning = _isDirty
            ? "\n(このウィンドウには未保存の変更があります。再読み込みすると失われます。)"
            : string.Empty;

        DialogResult choice = MessageBox.Show(
            this,
            $"このファイルは他のアプリケーションによって変更されました。再読み込みしますか?{unsavedWarning}",
            "Pane",
            MessageBoxButtons.YesNo,
            MessageBoxIcon.Warning);

        if (choice == DialogResult.Yes)
        {
            OpenFile(_currentPath);
        }
        // いいえの場合は現在の編集内容を保持したまま、次の変更検知まで何もしない
        // (仕様書どおり、無断で上書き・自動再読み込みはしない)。
    }

    // ---- 設定(仕様書 N-07・N-09、Phase 3時点は最小ダイアログ) ----

    private void ShowSettingsDialog()
    {
        AppSettings settings = SettingsService.Load();
        using var dialog = new SettingsForm(settings);
        if (dialog.ShowDialog(this) != DialogResult.OK) return;

        bool wantsAssociation = dialog.FileAssociationEnabled;
        if (wantsAssociation != settings.FileAssociationEnabled)
        {
            try
            {
                // WinForms版の設定画面(SettingsForm)はON/OFFの単一チェックボックスしか持たず、
                // 拡張子ごとの選択肢はまだ無いため、有効化時は従来どおり .md/.markdown/.mdown の
                // 3つを対象にする(任意拡張子の選択は後続のHTML製設定画面(B節)で行う)。
                IReadOnlyCollection<string> desiredExtensions = wantsAssociation
                    ? FileAssociationService.LegacyDefaultExtensions
                    : Array.Empty<string>();
                FileAssociationService.Apply(desiredExtensions, settings.GetEffectiveAssociatedExtensions());
                settings.FileAssociationEnabled = wantsAssociation;
                settings.AssociatedExtensions = desiredExtensions.ToList();
            }
            catch (Exception ex)
            {
                Logger.WriteException("ファイルの関連付け設定の変更に失敗", ex);
                MessageBox.Show(
                    this,
                    $"ファイルの関連付け設定を変更できませんでした。\n{ex.Message}",
                    "Pane",
                    MessageBoxButtons.OK,
                    MessageBoxIcon.Error);
            }
        }

        bool wantsPreload = dialog.PreloadOnStartup;
        if (wantsPreload != settings.PreloadOnStartup)
        {
            try
            {
                if (wantsPreload) StartupService.Register();
                else StartupService.Unregister();
                settings.PreloadOnStartup = wantsPreload;
            }
            catch (Exception ex)
            {
                // StartupService側で既にLogger.WriteException済みのため、ここではUI表示のみ。
                MessageBox.Show(
                    this,
                    $"スタートアップ登録を変更できませんでした。\n{ex.Message}",
                    "Pane",
                    MessageBoxButtons.OK,
                    MessageBoxIcon.Error);
            }
        }

        settings.StartupBehavior = dialog.RestoreSessionOnStartup ? "restoreSession" : "blank";
        settings.CalloutsEnabled = dialog.CalloutsEnabled;
        settings.SuperSubscriptEnabled = dialog.SuperSubscriptEnabled;
        settings.HighlightEnabled = dialog.HighlightEnabled;
        settings.InlineMathEnabled = dialog.InlineMathEnabled;
        // 旧WinForms設定画面はON/OFFの単一チェックボックスのみのため、3値のMathAutoNumberへは
        // "off"/"all"の二値でのみ対応する("ams"はHTML製設定画面からのみ選べる)。
        settings.MathAutoNumber = dialog.MathAutoNumberEnabled ? "all" : "off";
        settings.MathAutoNumberEnabled = dialog.MathAutoNumberEnabled;
        settings.DefaultCopyFormat = dialog.DefaultCopyFormat;
        SettingsService.Save(settings);

        // 設定はアプリ全体で共有されるため、自分のウィンドウだけでなく他のウィンドウにも反映する。
        BroadcastOrRefreshSelf();
    }

    /// <summary>
    /// 設定の保存後、他ウィンドウへの再配信(<see cref="_requestBroadcastSettings"/>)があれば
    /// それを呼び、無ければ(想定外の生成経路)自分のウィンドウだけでも最新化しておく。
    /// SettingsBridgeの各メソッドへ渡すbroadcastSettingsChangedはこれで統一する。
    /// </summary>
    private void BroadcastOrRefreshSelf()
    {
        if (_requestBroadcastSettings is not null) _requestBroadcastSettings();
        else PostCapabilities();
    }

    /// <summary>
    /// 設定のうちJS側(main.js / editor.js / sidebar.js等)で効かせる項目をまとめて伝える
    /// (docs/設定項目一覧.md「送受信の約束」)。一覧系(installedFonts等)は含めない。
    /// 起動時("ready"受信直後)、設定画面で保存されるたび、最近使ったファイルが更新されるたびに送る。
    /// あわせて、設定を読み込んだこのタイミングで自動保存タイマーへも反映する
    /// (<see cref="ApplyAutoSaveSettings"/>)。
    /// <see cref="PaneApplicationContext"/> が全ウィンドウへ再送する際にも呼ぶため internal。
    /// </summary>
    internal void PostCapabilities()
    {
        AppSettings settings = SettingsService.Load();
        ApplyAutoSaveSettings(settings);
        ApplyTitleBarTheme(settings); // 設定の再配信(テーマ変更含む)のたびにタイトルバーも塗り直す
        PostToWeb(new
        {
            type = "apply-settings",

            // ---- 一般 ----
            showStatusBar = settings.ShowStatusBar,
            showOutlineByDefault = settings.ShowOutlineByDefault,
            collapsibleOutline = settings.CollapsibleOutline,
            zoomWithCtrlWheel = settings.ZoomWithCtrlWheel,
            displayMode = settings.DisplayMode,
            recentFiles = settings.RecentFiles,
            theme = settings.Theme,

            // ---- 保存と復元 ----
            saveWithoutAskingOnSwitch = settings.SaveWithoutAskingOnSwitch,
            defaultEncoding = settings.DefaultEncoding,
            defaultLineEnding = settings.DefaultLineEnding,

            // ---- 編集 ----
            indentSizeOnSave = settings.IndentSizeOnSave,
            codeIndentSize = settings.CodeIndentSize,
            codeAutoWrap = settings.CodeAutoWrap,
            shiftTabAutoIndent = settings.ShiftTabAutoIndent,
            autoPairing = settings.AutoPairing,
            autoPairMarkdown = settings.AutoPairMarkdown,
            emojiAutocomplete = settings.EmojiAutocomplete,
            liveRenderingShowSourceOnFocus = settings.LiveRenderingShowSourceOnFocus,
            defaultCopyFormat = settings.DefaultCopyFormat,
            copyWholeLineWhenNoSelection = settings.CopyWholeLineWhenNoSelection,
            typewriterKeepCaretCentered = settings.TypewriterKeepCaretCentered,
            spellCheckEnabled = settings.SpellCheckEnabled,
            spellCheckAutoCorrect = settings.SpellCheckAutoCorrect,
            readingSpeedWpm = settings.ReadingSpeedWpm,
            autoDetectMode = settings.AutoDetectMode,
            fileModeOverrides = settings.FileModeOverrides,
            perFileModes = settings.PerFileModes,

            // ---- Markdown: 記法サポート ----
            inlineMathEnabled = settings.InlineMathEnabled,
            codeBlockMathEnabled = settings.CodeBlockMathEnabled,
            superSubscriptEnabled = settings.SuperSubscriptEnabled,
            highlightEnabled = settings.HighlightEnabled,
            diagramsEnabled = settings.DiagramsEnabled,
            autoLinksEnabled = settings.AutoLinksEnabled,
            calloutsEnabled = settings.CalloutsEnabled,

            // ---- Markdown: 記法の書き方 ----
            strictMode = settings.StrictMode,
            headingStyle = settings.HeadingStyle,
            unorderedListMarker = settings.UnorderedListMarker,
            orderedListMarker = settings.OrderedListMarker,
            codeBlockLineNumbers = settings.CodeBlockLineNumbers,
            mathAutoNumber = settings.GetEffectiveMathAutoNumber(),
            chapterLevelInOutline = settings.ChapterLevelInOutline,
            defaultCodeLanguage = settings.DefaultCodeLanguage,
            defaultCodeLanguageApplyWhen = settings.DefaultCodeLanguageApplyWhen,

            // ---- Markdown: 空白と改行 ----
            whitespaceWhenWriting = settings.WhitespaceWhenWriting,
            whitespaceOnExport = settings.WhitespaceOnExport,

            // ---- Markdown: スマート置換 ----
            smartQuotes = settings.SmartQuotes,
            smartDashes = settings.SmartDashes,
            recognizeUnicodePunctuation = settings.RecognizeUnicodePunctuation,

            // ---- 画像 ----
            imageInsertAction = settings.ImageInsertAction,
            imageCustomFolder = settings.ImageCustomFolder,
            imageApplyToLocal = settings.ImageApplyToLocal,
            imageApplyToOnline = settings.ImageApplyToOnline,
            imagePreferRelativePath = settings.ImagePreferRelativePath,
            imageAddDotSlash = settings.ImageAddDotSlash,
            imageAutoEscapeUrl = settings.ImageAutoEscapeUrl,

            // ---- エクスポート・印刷 ----
            exportPaperSize = settings.ExportPaperSize,
            exportCustomWidthMm = settings.ExportCustomWidthMm,
            exportCustomHeightMm = settings.ExportCustomHeightMm,
            exportOrientation = settings.ExportOrientation,
            exportMarginTopMm = settings.ExportMarginTopMm,
            exportMarginBottomMm = settings.ExportMarginBottomMm,
            exportMarginLeftMm = settings.ExportMarginLeftMm,
            exportMarginRightMm = settings.ExportMarginRightMm,
            exportHeaderText = settings.ExportHeaderText,
            exportFooterText = settings.ExportFooterText,
            exportPageBreakBetweenTopHeadings = settings.ExportPageBreakBetweenTopHeadings,
            exportIncludeOutline = settings.ExportIncludeOutline,
            exportOutlineWidthPx = settings.ExportOutlineWidthPx,
            exportAppendHead = settings.ExportAppendHead,
            exportAppendBody = settings.ExportAppendBody,
            exportDefaultFolder = settings.ExportDefaultFolder,
            exportCustomFolder = settings.ExportCustomFolder,
            exportAfter = settings.ExportAfter,
            exportShowSaveDialog = settings.ExportShowSaveDialog,
            exportMathAs = settings.ExportMathAs,
            exportReadYamlFrontMatter = settings.ExportReadYamlFrontMatter,
            pandocAvailable = SettingsBridge.DetectPandocAvailable(),

            // ---- 外観 ----
            lightTheme = settings.LightTheme,
            darkTheme = settings.DarkTheme,
            useSeparateThemeInDarkMode = settings.UseSeparateThemeInDarkMode,
            customCssPath = settings.CustomCssPath,
            customCss = ReadCustomCss(settings.CustomCssPath),
            editorFontFamily = settings.EditorFontFamily,
            editorMonospaceFontFamily = settings.EditorMonospaceFontFamily,
            editorFontSize = settings.EditorFontSize,
            editorLineHeight = settings.EditorLineHeight,
            editorMaxWidthPx = settings.EditorMaxWidthPx,
            showWordCount = settings.ShowWordCount,

            // ---- キーボード ----
            keyBindings = settings.KeyBindings,

            // ---- 詳細(サイドバーのファイルツリー表示に関わる部分のみ。enableDebugはC#専用のため含めない) ----
            showHiddenFilesInTree = settings.ShowHiddenFilesInTree,
            fileTreePatterns = settings.FileTreePatterns,
        });
    }

    /// <summary>カスタムCSS(仕様書 第2.10節 C-07)の読み込み上限。これを超えるファイルは読み込まない。</summary>
    private const long CustomCssMaxBytes = 1024 * 1024; // 1MB

    /// <summary>
    /// カスタムCSSファイルの中身を読み込んで返す。WebView2の仮想ホスト配下からは
    /// file://パスを直接読めないため、C#側でファイルを読んでテキストとしてJSへ渡す。
    /// パス未設定・ファイルが存在しない・読み取り不可・サイズ上限超過の場合は例外を投げず
    /// 空文字を返し、理由をLogger.Writeに記録する。
    /// </summary>
    private static string ReadCustomCss(string? path)
    {
        if (string.IsNullOrWhiteSpace(path)) return "";
        try
        {
            var info = new FileInfo(path);
            if (!info.Exists)
            {
                Logger.Write($"カスタムCSS: ファイルが存在しないため読み込みをスキップ: {path}");
                return "";
            }
            if (info.Length > CustomCssMaxBytes)
            {
                Logger.Write($"カスタムCSS: サイズ上限({CustomCssMaxBytes}バイト)を超えるため読み込みをスキップ: {path} ({info.Length}バイト)");
                return "";
            }
            return File.ReadAllText(path);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or ArgumentException or NotSupportedException or SecurityException)
        {
            Logger.WriteException($"カスタムCSSの読み込みに失敗: {path}", ex);
            return "";
        }
    }

    /// <summary>PerFileModes(ファイル単位の手動モード記憶)の最大件数。超過分は古いものから捨てる。</summary>
    private const int PerFileModesMaxEntries = 100;

    /// <summary>
    /// { type: "remember-file-mode", path, mode } を受け取り、PerFileModesを更新する
    /// (仕様書 第1章: 表示メニューで手動切替したモードを記憶する)。
    /// modeがnull/空ならそのpathのエントリを削除する(=自動判定に戻す)。
    /// 不正なmode値("markdown"/"code"/"plain"以外)は保存せずログに記録するだけにする。
    /// </summary>
    private void HandleRememberFileModeRequest(JsonElement root)
    {
        if (!root.TryGetProperty("path", out JsonElement pathProp) || pathProp.ValueKind != JsonValueKind.String)
        {
            Logger.Write("remember-file-mode受信: pathが無いため無視");
            return;
        }
        string path = pathProp.GetString() ?? "";
        if (path.Length == 0)
        {
            Logger.Write("remember-file-mode受信: pathが空のため無視");
            return;
        }

        string? mode = null;
        if (root.TryGetProperty("mode", out JsonElement modeProp) && modeProp.ValueKind == JsonValueKind.String)
        {
            mode = modeProp.GetString();
        }

        if (!string.IsNullOrEmpty(mode) && mode is not ("markdown" or "code" or "plain"))
        {
            Logger.Write($"remember-file-mode受信: 不正なmode値のため無視: {mode}");
            return;
        }

        AppSettings settings = SettingsService.Load();
        settings.PerFileModes = UpdatePerFileModes(settings.PerFileModes, path, mode);
        SettingsService.Save(settings);
    }

    /// <summary>
    /// PerFileModesへ1件挿入/更新/削除し、上限<see cref="PerFileModesMaxEntries"/>件を超えた
    /// 古いものから捨てた新しいDictionaryを返す。
    /// 既存のDictionaryに対して直接Remove/Addを行うと、内部スロットの再利用により
    /// 列挙順(=挿入順)が崩れる可能性があるため、必ず現在の列挙順を保ったリストから
    /// 作り直す(このメソッド自身はcurrentへ副作用を与えない)。
    /// </summary>
    private static Dictionary<string, string> UpdatePerFileModes(Dictionary<string, string> current, string path, string? mode)
    {
        var ordered = current.Where(kv => kv.Key != path).ToList();
        if (!string.IsNullOrEmpty(mode))
        {
            ordered.Add(new KeyValuePair<string, string>(path, mode));
        }
        if (ordered.Count > PerFileModesMaxEntries)
        {
            ordered = ordered.Skip(ordered.Count - PerFileModesMaxEntries).ToList();
        }
        return ordered.ToDictionary(kv => kv.Key, kv => kv.Value);
    }

    /// <summary>テーマ切替(仕様書 第10.2節)の手動選択を永続化する。"system"ならOS設定に追従したまま何もしない。</summary>
    private static void SaveTheme(string theme)
    {
        if (theme != "light" && theme != "dark" && theme != "system") return;
        AppSettings settings = SettingsService.Load();
        settings.Theme = theme;
        SettingsService.Save(settings);
    }

    /// <summary>本文の文字サイズ(Ctrl+マウスホイールでの変更)を永続化する。</summary>
    private static void SaveFontSize(int size)
    {
        if (size < 8 || size > 40) return; // JS側(editor.js)と同じ範囲。想定外の値は無視する
        AppSettings settings = SettingsService.Load();
        settings.EditorFontSize = size;
        SettingsService.Save(settings);
    }

    /// <summary>最近使ったファイル一覧(仕様書 F-09)を更新する。先頭が最新、重複除去、最大10件。
    /// recordRecentFilesがfalseの場合は記録しない。</summary>
    private static void AddRecentFile(string path)
    {
        AppSettings settings = SettingsService.Load();
        if (!settings.RecordRecentFiles) return;
        settings.RecentFiles.RemoveAll(p => string.Equals(p, path, StringComparison.OrdinalIgnoreCase));
        settings.RecentFiles.Insert(0, path);
        if (settings.RecentFiles.Count > 10)
        {
            settings.RecentFiles.RemoveRange(10, settings.RecentFiles.Count - 10);
        }
        SettingsService.Save(settings);
    }

    /// <summary>
    /// { type: "open-devtools" } を受け取り、開発者ツールを開く。enableDebugがtrueのときのみ許可する。
    /// 開発ビルド(DEBUG)では設定値に関わらず常に許可する(デバッグ作業を妨げないため)。
    /// </summary>
    private void HandleOpenDevToolsRequest()
    {
#if DEBUG
        _webView.CoreWebView2.OpenDevToolsWindow();
#else
        AppSettings settings = SettingsService.Load();
        if (settings.EnableDebug)
        {
            _webView.CoreWebView2.OpenDevToolsWindow();
        }
        else
        {
            Logger.Write("open-devtools: enableDebug=falseのため開発者ツールの要求を無視した");
        }
#endif
    }

    // ---- 印刷(仕様書 File項目「印刷」)。WebView2既定の印刷ダイアログを開く。 ----
    private Task HandlePrintRequestAsync()
    {
        try
        {
            _webView.CoreWebView2.ShowPrintUI(CoreWebView2PrintDialogKind.Browser);
        }
        catch (Exception ex) when (ex is COMException or InvalidOperationException)
        {
            // 印刷ダイアログを開けない環境ではベストエフォートで諦める
        }
        return Task.CompletedTask;
    }

    // ---- エクスポート(仕様書 F-XX)。PDFはWebView2のネイティブ機能、HTMLは
    // JS側で組み立て済みのHTML文字列をそのまま保存、Word/EPUBはPandocに委譲する。
    // PDFはJS側が"export"送信前にメニューバー等を隠し文書全体をレイアウトへ展開している
    // (enterExportLayout)ため、このメソッドを抜ける経路(保存キャンセルを含む)すべてで
    // 必ず"export-done"を返し、JS側の表示を元に戻せるようにする。 ----
    private async Task HandleExportRequestAsync(JsonElement message)
    {
        string format = message.TryGetProperty("format", out JsonElement fmtProp) ? fmtProp.GetString() ?? "" : "";
        string text = message.TryGetProperty("text", out JsonElement textProp) ? textProp.GetString() ?? "" : "";
        string baseName = _currentPath is null ? "無題" : Path.GetFileNameWithoutExtension(_currentPath);

        (string filter, string ext) = format switch
        {
            "pdf" => ("PDF (*.pdf)|*.pdf", ".pdf"),
            "html" or "html-plain" => ("HTML (*.html)|*.html", ".html"),
            "docx" => ("Word文書 (*.docx)|*.docx", ".docx"),
            "epub" => ("EPUB (*.epub)|*.epub", ".epub"),
            _ => ("すべてのファイル (*.*)|*.*", ""),
        };
        try
        {
            using var dialog = new SaveFileDialog { Filter = filter, FileName = baseName + ext };
            if (dialog.ShowDialog(this) != DialogResult.OK) return;
            string targetPath = dialog.FileName;

            switch (format)
            {
                case "pdf":
                    await _webView.CoreWebView2.PrintToPdfAsync(targetPath);
                    break;
                case "html":
                case "html-plain":
                    await File.WriteAllTextAsync(targetPath, text, new UTF8Encoding(false));
                    break;
                case "docx":
                case "epub":
                    await ExportViaPandocAsync(text, targetPath);
                    break;
            }
        }
        catch (Exception ex)
        {
            MessageBox.Show(this, $"エクスポートに失敗しました。\n{ex.Message}", "Pane", MessageBoxButtons.OK, MessageBoxIcon.Error);
        }
        finally
        {
            PostToWeb(new { type = "export-done" });
        }
    }

    private static async Task ExportViaPandocAsync(string markdownText, string targetPath)
    {
        string tempMd = Path.Combine(Path.GetTempPath(), $"pane-export-{Guid.NewGuid():N}.md");
        try
        {
            await File.WriteAllTextAsync(tempMd, markdownText, new UTF8Encoding(false));
            var psi = new ProcessStartInfo("pandoc")
            {
                UseShellExecute = false,
                RedirectStandardError = true,
                CreateNoWindow = true,
            };
            psi.ArgumentList.Add(tempMd);
            psi.ArgumentList.Add("-o");
            psi.ArgumentList.Add(targetPath);
            using var proc = Process.Start(psi);
            if (proc is null) throw new InvalidOperationException("Pandocを起動できませんでした。");
            string stderr = await proc.StandardError.ReadToEndAsync();
            await proc.WaitForExitAsync();
            if (proc.ExitCode != 0) throw new InvalidOperationException(string.IsNullOrWhiteSpace(stderr) ? "Pandocの変換に失敗しました。" : stderr);
        }
        finally
        {
            try { File.Delete(tempMd); } catch (IOException) { /* ベストエフォート */ }
        }
    }

    // ---- 画像挿入(仕様書 R-07)。文書と同じフォルダの images/ 配下へコピーし、相対パスを返す。 ----
    private void HandleInsertImageRequest(JsonElement message)
    {
        if (_currentPath is null)
        {
            MessageBox.Show(this, "画像を挿入する前に、文書を一度保存してください。", "Pane", MessageBoxButtons.OK, MessageBoxIcon.Warning);
            return;
        }
        string docDir = Path.GetDirectoryName(Path.GetFullPath(_currentPath))!;
        string imagesDir = Path.Combine(docDir, "images");

        string? sourcePath = null;
        byte[]? bytes = null;
        string suggestedName = "image.png";

        if (message.TryGetProperty("dataBase64", out JsonElement dataProp) && dataProp.ValueKind == JsonValueKind.String)
        {
            bytes = Convert.FromBase64String(dataProp.GetString() ?? "");
            if (message.TryGetProperty("name", out JsonElement nameProp) && nameProp.GetString() is string n && n.Length > 0)
            {
                suggestedName = n;
            }
        }
        else
        {
            using var dialog = new OpenFileDialog
            {
                Filter = "画像ファイル (*.png;*.jpg;*.jpeg;*.gif;*.svg;*.webp)|*.png;*.jpg;*.jpeg;*.gif;*.svg;*.webp",
            };
            if (dialog.ShowDialog(this) != DialogResult.OK) return;
            sourcePath = dialog.FileName;
            suggestedName = Path.GetFileName(sourcePath);
        }

        try
        {
            Directory.CreateDirectory(imagesDir);
            string destPath = UniqueDestinationPath(imagesDir, suggestedName);
            if (sourcePath is not null) File.Copy(sourcePath, destPath);
            else File.WriteAllBytes(destPath, bytes!);

            string relative = Path.GetRelativePath(docDir, destPath).Replace(Path.DirectorySeparatorChar, '/');
            PostToWeb(new { type = "image-inserted", alt = Path.GetFileNameWithoutExtension(destPath), path = relative });
        }
        catch (Exception ex)
        {
            MessageBox.Show(this, $"画像を挿入できませんでした。\n{ex.Message}", "Pane", MessageBoxButtons.OK, MessageBoxIcon.Error);
        }
    }

    private static string UniqueDestinationPath(string dir, string fileName)
    {
        string name = Path.GetFileNameWithoutExtension(fileName);
        string ext = Path.GetExtension(fileName);
        string candidate = Path.Combine(dir, fileName);
        for (int i = 1; File.Exists(candidate); i++)
        {
            candidate = Path.Combine(dir, $"{name}-{i}{ext}");
        }
        return candidate;
    }
}
