using System.Diagnostics;
using System.Runtime.CompilerServices;
using System.Runtime.InteropServices;
using System.Security;
using System.Text;
using System.Text.Json;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;
using static Pane.JsonMessageHelpers;

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
    /// <summary>ローカル画像配信専用の仮想ホスト名(不具合修正、OnLoadAsync/OnLocalFileResourceRequested参照)。
    /// <see cref="VirtualHostName"/>(dist/固定割り当て)とは別に、都度リクエストされた実ファイルを
    /// 検証のうえ返す。src/editor.js resolveImageSrcが生成するURLと対応させる。</summary>
    private const string LocalFileHostName = "pane-file.local";
    private const int AutoSaveIntervalMs = 30_000;
    private const int ExternalChangeDebounceMs = 300;
    /// <summary>起動時の白フラッシュ対策(新方式)のフォールバック猶予(ミリ秒)。
    /// JS側("initial-render-ready")からの通知を待たずにこれだけ経過したら、
    /// <see cref="RevealWebView"/>がWebView2を強制的に表示する。JS側が例外で止まる等
    /// 通知が永久に来ない場合の保険であり、実機でしか再現しないシナリオのため
    /// (このリポジトリのヘッドレス環境ではWebView2自体が動かせず検証できない)、
    /// 長すぎず短すぎない値として3秒を選んだ。</summary>
    private const int WebViewRevealFallbackMs = 3000;
    /// <summary>ローカル画像配信(<see cref="OnLocalFileResourceRequested"/>)・エクスポート時の
    /// data:埋め込み(<see cref="HandleReadLocalImageRequest"/>)、双方に共通の1ファイルあたりの
    /// サイズ上限(不具合修正: 従来は前者にだけ上限が無く非対称だった)。エクスポート側と
    /// 同じ25MBに揃える。</summary>
    private const long LocalFileMaxServeBytes = 25 * 1024 * 1024;

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
    /// <summary>設定画面を開く依頼。2つ目の引数は開いた直後に表示するカテゴリ
    /// (nullなら前回のまま)。更新の案内(U-06)から「バージョン情報」を直接開くために使う。</summary>
    private readonly Action<MainForm, string?>? _requestOpenSettingsWindow;
    /// <summary>更新の適用(U-04)の前提確認・後始末。実体はPaneApplicationContextが持つ
    /// (未保存の有無・終了処理はアプリ全体の話で、1ウィンドウでは判断できないため)。</summary>
    private readonly Func<bool>? _hasUnsavedDocuments;
    private readonly Action? _shutdownForUpdate;
    /// <summary>取扱説明書ウィンドウ(F1)を開く要求。<see cref="_requestOpenSettingsWindow"/>と
    /// 全く同じ流儀(<see cref="PaneApplicationContext.OpenHelpWindow"/>参照)。</summary>
    private readonly Action<MainForm>? _requestOpenHelpWindow;
    private readonly System.Windows.Forms.Timer _autoSaveTimer;
    private readonly System.Windows.Forms.Timer _externalChangeDebounceTimer;
    /// <summary>起動時の白フラッシュ対策(新方式)のフォールバックタイマー。<see cref="RevealWebView"/>参照。</summary>
    private readonly System.Windows.Forms.Timer _webViewRevealFallbackTimer;
    /// <summary>WebView2を既に表示済みかどうか。JS側の通知とフォールバックタイマーの
    /// どちらが先に来ても二重に処理しないためのガード(<see cref="RevealWebView"/>参照)。</summary>
    private bool _webViewRevealed;

    // メニューバーのホバー切り替え(ユーザー要望: クリックしなくても隣の見出しへ切り替わる)は、
    // 以前はここ(C#側)でネイティブポップアップのMouseMoveを監視して実装していたが、実機で
    // 一度も発火せず機能していなかったため撤去した。現在はJS側(src/commands.js)がメニューバーの
    // 見出しボタン自体のmouseenterでホバーを検知し、クリックと同じopenNativeMenu()経路で
    // 開き直す方式に変更している(詳細はPane/NativeMenu.cs Show()のコメント参照)。C#側は
    // 判定・タイマー等の状態を一切持たなくなった。

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

    /// <summary>外部変更ダイアログで「いいえ」を選んだファイルのパス(このウィンドウが自分で
    /// 保存する、または別のファイルを開くまで、そのファイルについては再度ダイアログを
    /// 出さないための抑止)。<see cref="_suppressWatcher"/>とは役割が異なる別物なので混同しない
    /// こと(_suppressWatcherは「自分の保存中だけ」FileSystemWatcher自体を止めるためのフラグで、
    /// 保存が終われば自動的に解除される。こちらは保存が終わった"後"もユーザーの選択が続く)。
    /// 解除(null化)は<see cref="StartWatching"/>・<see cref="StopWatching"/>で行う。
    /// この2つは「監視対象が変わった=保存した or 別のファイルを開いた」タイミングでのみ
    /// 呼ばれるため、抑止の解除条件とちょうど一致する。</summary>
    private string? _suppressedExternalChangePath;

    private string? _currentPath;
    private FileEncodingKind _currentEncoding = FileEncodingKind.Utf8;
    private LineEndingKind _currentLineEnding = LineEndingKind.Crlf;
    private bool _hasTrailingNewline = true;
    private bool _isDirty;
    private bool _isReadOnly;

    /// <summary>タブ形式(仕様書 第2.10節 C-14、隠し設定)のとき、JS側(main.js)の"tabs-changed"で
    /// 更新される、現在このウィンドウで開いている全タブの情報。タブ形式でない、またはまだ
    /// 一度もtabs-changedを受信していない間は空のまま(この場合は_currentPath等、従来どおり
    /// 「1ウィンドウ=1ファイル」のフィールドだけを見ればよい)。</summary>
    private readonly record struct TabInfo(string Guid, string? Path, bool Dirty);
    private List<TabInfo> _tabInfos = new();

    /// <summary>現在サイドバーに読み込み済みのフォルダのルートパス(仕様書 第2.8節)。
    /// ファイルを開くたびに同じフォルダを再走査しないよう、これと比較する。</summary>
    private string? _loadedFolderRootPath;
    /// <summary>実行中のフォルダ走査を中断するためのトークン。新しい走査を始める際に前のものをキャンセルする。</summary>
    private CancellationTokenSource? _folderScanCts;
    /// <summary>実行中のグローバル検索を中断するためのトークン。フォルダ走査用とは独立させ、
    /// 検索中に別のフォルダ走査(ファイルを開いた際の自動読み込み等)が走っても互いに干渉しないようにする。</summary>
    private CancellationTokenSource? _searchCts;

    /// <summary><see cref="ResolveOneLevelCached"/>が使う、パス1階層ぶんのリンク解決結果キャッシュ
    /// (不具合修正: 中間ディレクトリのシンボリックリンク対策)。キーは解決前のパス、値は解決後の
    /// 実パスと有効期限。画像を多数含む文書では同じ祖先ディレクトリに対する判定が画像1枚ごとに
    /// 繰り返し走るため、短時間だけ結果を使い回して都度のstatコストを避ける。
    /// TTLを短く抑えている理由・上限を設けている理由は<see cref="ResolveOneLevelCached"/>参照。</summary>
    private readonly Dictionary<string, (string ResolvedPath, DateTime ExpiresAtUtc)> _pathResolutionCache =
        new(StringComparer.OrdinalIgnoreCase);
    private const int PathResolutionCacheTtlMs = 3000;
    private const int PathResolutionCacheMaxEntries = 4096;

    /// <summary>ConfirmDiscardDirtyAsyncの「保存する」選択時、JS側の保存完了(save-result)を待つための待機口。</summary>
    private TaskCompletionSource<bool>? _saveCompletionSource;
    /// <summary>ConfirmDiscardDirtyAsyncを通過した後、確認を再表示せずにClose()を通すためのフラグ。</summary>
    private bool _forceClose;

    /// <summary>RequestIsDocumentEmptyAsyncが「本文が空か」をJS側へ問い合わせた際の応答待ち
    /// (ネイティブD&amp;D=OnDragDropが、現在のウィンドウを置き換えてよいかを判断するために使う。
    /// _saveCompletionSourceと同じ、request/response往復の待機口パターン)。</summary>
    private TaskCompletionSource<bool>? _isDocumentEmptyCompletionSource;

    /// <summary>上の問い合わせに付ける通し番号。応答(is-document-empty-response)が
    /// 「どの問い合わせに対するものか」を区別するために使う。これが無いと、
    /// 「前の問い合わせがタイムアウト→次のドロップ→前の応答が遅れて到着」という順序のとき、
    /// 遅れて来た古い応答が次の待機を誤って解決してしまう(古い値で上書きされる)。</summary>
    private int _isDocumentEmptyRequestId;

    /// <summary>タイトルバーの配色(案A): JS側("titlebar-color"メッセージ)から届いた実際の描画色。
    /// 未受信の間はnullのままで、その場合<see cref="WindowChrome"/>側の既定色(案B)が使われる。</summary>
    private string? _titlebarBackgroundOverride;
    private string? _titlebarForegroundOverride;

    /// <summary><see cref="_titlebarBackgroundOverride"/>の読み取り専用公開。<see cref="PaneDialog"/>が
    /// 自前ダイアログの配色を本文エリアと同じ色に揃えるために参照する(オーナーがこのウィンドウの場合のみ)。</summary>
    internal string? TitlebarBackgroundOverride => _titlebarBackgroundOverride;

    /// <summary><see cref="_titlebarForegroundOverride"/>の読み取り専用公開。用途は上記と同じ。</summary>
    internal string? TitlebarForegroundOverride => _titlebarForegroundOverride;

    /// <summary>自動保存スナップショットの識別子。ウィンドウごとに一意。</summary>
    public Guid WindowId { get; } = Guid.NewGuid();

    public string? CurrentPath => _currentPath;

    public bool IsDirty => _isDirty;

    /// <summary>
    /// セッション復元(仕様書 N-07)用。タブ形式(第2.10節 C-14)ならこのウィンドウで開いている
    /// 全タブのパス(パスがあるものだけ)を、そうでなければ従来どおり<see cref="CurrentPath"/>
    /// 1件(あれば)を返す。<see cref="PaneApplicationContext"/>が全ウィンドウぶんを集約する。
    /// </summary>
    public IReadOnlyList<string> GetOpenFilePaths()
    {
        if (_tabInfos.Count > 0)
        {
            return _tabInfos.Where(t => t.Path is not null).Select(t => t.Path!).ToList();
        }
        return _currentPath is not null ? new List<string> { _currentPath } : Array.Empty<string>();
    }

    public MainForm(
        string? initialPath,
        AutoSaveSnapshot? recoverFrom = null,
        Action<string?>? requestNewWindow = null,
        Action<DroppedFileContent>? requestNewWindowWithContent = null,
        Action<MainForm>? requestSwitchDocument = null,
        Action? requestBroadcastSettings = null,
        Action<MainForm, string?>? requestOpenSettingsWindow = null,
        Action<MainForm>? requestOpenHelpWindow = null,
        DroppedFileContent? droppedFile = null,
        string? initialFolderPath = null,
        Func<bool>? hasUnsavedDocuments = null,
        Action? shutdownForUpdate = null)
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
        _requestOpenHelpWindow = requestOpenHelpWindow;
        _hasUnsavedDocuments = hasUnsavedDocuments;
        _shutdownForUpdate = shutdownForUpdate;
        Logger.Write($"MainForm生成: initialPath={initialPath ?? "(なし)"}, recoverFrom={(recoverFrom is null ? "なし" : recoverFrom.OriginalPath ?? "無題")}, droppedFile={droppedFile?.Name ?? "なし"}");
        // カスタムCSSの参考サンプルを既定フォルダへ用意しておく(無ければ作るだけで、
        // 既にあれば何もしない。ThemeFolderService.EnsureSampleCss参照)。
        ThemeFolderService.EnsureSampleCss();

        Text = "Pane";
        Width = 960;
        Height = 720;
        StartPosition = FormStartPosition.WindowsDefaultLocation;
        // アイコンはアセンブリへ埋め込んである(AppIcon参照)。読めなかった場合は
        // 代入せずWinFormsの既定アイコンのままにする。
        Icon? icon = AppIcon.Create();
        if (icon is not null) Icon = icon;

        // 起動時の白フラッシュ対策(実機不具合の修正)。WebView2がHTMLを描画する時点では
        // まだC#側から設定(テーマ)が届いておらず、既定のライト配色(またはWebView2自体の
        // 既定背景色である白)が一瞬見えてしまっていた。原因は複数の層にまたがりうるため、
        // ここではまず「WebView2に覆われる前に見えうる2つの層」——WinFormsコントロール
        // 自体の背景色(BackColor)と、WebView2/CoreWebView2Controllerの既定背景色
        // (DefaultBackgroundColor、HTML/CSSが読み込まれる前にWebView2自体が塗る色)——を
        // 保存されているテーマ設定に合わせて塗っておく。DefaultBackgroundColorはCoreWebView2
        // 生成前でも設定でき、生成後にそのまま引き継がれる。もう1つの層(HTML自体の初期表示色)は
        // OnLoadAsync側でNavigate前にdata-theme属性を注入することで対処する(そちらを参照)。
        ApplyInitialWebViewBackground();

        // ---- [計測] 「初回起動だけこの区間に約8.7秒かかる」問題の切り分け用 ----
        // 実機ログでは ApplyInitialWebViewBackground のログ行と「WebView2を非表示で生成」の
        // ログ行の間に約8.68秒の空白があるが、その間に実際にあるコードは以下の数行しかない。
        // 同じプロセス内で2枚目のウィンドウを作ると同じ区間が0msになるため、原因はコードでは
        // なく「プロセス初回だけの外的コスト」(WebView2アセンブリの遅延ロード・ランタイム検出等)
        // と分かっている。どの行でそれが起きているのかを実機ログだけで特定できるよう、
        // 1ステップずつ経過ミリ秒を残す。特に Controls.Add(_webView) の前後は必ず分ける
        // (親コントロールへの追加時にWebView2側の初期化が走りうるため)。
        // 常時出力。後からgrepできるよう接頭辞を[計測]に揃える。
        var buildStopwatch = Stopwatch.StartNew();
        long lastStepMs = 0;
        void LogBuildStep(string step)
        {
            long now = buildStopwatch.ElapsedMilliseconds;
            Logger.Write($"[計測] MainForm構築 {step}: +{now - lastStepMs}ms (計測開始から{now}ms)");
            lastStepMs = now;
        }

        // ウィンドウ全体(タイトルバー等の非クライアント領域)へのD&D用。
        // 不具合修正の経緯: 一度は「WebView2のAllowExternalDropをfalseにして、クライアント領域上の
        // ドロップもすべてこのフォーム自身のDragDrop(OnDragDrop)で受け切る」方式を試みた。
        // これならDataFormats.FileDropからフルパスが取得できるが、副作用として本文エリア上に
        // ドラッグしている間ずっとカーソルが禁止マーク(🚫)になってしまい(WebView2が
        // 「外部ドロップを受け付けない」旨をOSへ表明する結果、OS側のドラッグカーソルが
        // 拒否扱いになる)、実機で確認されたため撤回した。
        // 現在の方式: AllowExternalDropは既定のtrue(=WebView2が本文エリア上のドロップを
        // 自分で受け取る)のまま保つ。その代わり、ドラッグがウィンドウに入った時点で発火する
        // OnDragEnter(WebView2の領域内であっても、まずこのフォーム自身のDragEnterが先に届く)で
        // DataFormats.FileDropからフルパスを先に読み取り、フィールド(_pendingDragFiles)へ
        // 覚えておく。実際のドロップ自体はWebView2内のJS(src/main.js)が受け取るが、JSは
        // ファイル名(+サイズ)だけをC#へ送り返してくるので、ここで覚えておいたパス一覧と
        // 名前・サイズで照合すればフルパスが分かる(詳細はOnDragEnter/HandleOpenDroppedFileByName
        // 参照)。
        AllowDrop = true;
        DragEnter += OnDragEnter;
        DragOver += OnDragEnter;
        DragDrop += OnDragDrop;
        DragLeave += OnDragLeave;
        LogBuildStep("AllowDrop=true+D&Dイベント購読");

        _webView.Dock = DockStyle.Fill;
        LogBuildStep("_webView.Dock=Fill");
        Controls.Add(_webView);
        LogBuildStep("Controls.Add(_webView)");

        // 起動時の白フラッシュ対策(新方式、実機不具合の再修正): 従来の「背景色を先に塗る
        // +HTML側のタイミング調整」だけでは実機で直らなかった(ヘッドレス環境では実機の
        // タイミングを再現できず、この2層だけでは不十分だった)。そこで、原理的に白が
        // 出ようがない方式に切り替える——WebView2コントロール自体を、JS側の初期描画が
        // 完了したと分かるまで非表示のままにする。非表示の間はこのフォーム自体の背景色
        // (BackColor、直前でテーマ色に塗り済み。ApplyInitialWebViewBackground参照)だけが
        // 見えるため、WebView2の既定背景色やHTMLの初期表示色が何であっても画面に出ない。
        // 表示に切り替えるのはRevealWebView(JS側の"initial-render-ready"、または
        // フォールバックタイマー)。
        _webView.Visible = false;
        LogBuildStep("_webView.Visible=false");
        Logger.Write("WebView2を非表示で生成(initial-render-ready受信まで表示しない)");
        _webViewRevealFallbackTimer = new System.Windows.Forms.Timer { Interval = WebViewRevealFallbackMs };
        _webViewRevealFallbackTimer.Tick += (_, _) => RevealWebView(viaFallback: true);

        // 起動直後・ウィンドウ切替後の初回キー入力がWebView2内のコンテンツへ届かない
        // (フォーカスがネイティブのフォーム側に留まる)ことがあるため、明示的にフォーカスを移す。
        Shown += (_, _) => { Logger.Write("Form.Shown: _webView.Focus()"); _webView.Focus(); };
        Activated += (_, _) => { Logger.Debug("Form.Activated: _webView.Focus()"); _webView.Focus(); };

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
            // タイマーの停止漏れ対策(不具合修正)。従来は_autoSaveTimerのStopのみで、
            // _externalChangeDebounceTimerはStop/Disposeともに行っていなかった。
            // 閉じた直後にTickが走ると、破棄済みのFormに対してOnExternalChangeDebounceElapsedから
            // PaneDialog.Show(this, ...)を呼ぶ経路が残ってしまう。また、どのTimerも
            // コンポーネントコレクションに登録していないためForm.Dispose()では解放されず、
            // ここで明示的にDisposeしておく必要がある。
            _autoSaveTimer.Stop();
            _autoSaveTimer.Dispose();
            _externalChangeDebounceTimer.Stop();
            _externalChangeDebounceTimer.Dispose();
            _webViewRevealFallbackTimer.Stop();
            _webViewRevealFallbackTimer.Dispose();
            _watcher?.Dispose();
            // フォルダ走査・グローバル検索は非同期のfire-and-forgetで、ウィンドウを閉じても
            // キャンセルしなければ走り続け、完了後にPostToWeb/BeginInvokeで(既に閉じた)
            // このウィンドウへ結果を返そうとしてしまう(不具合修正)。CTSはCancelだけでは
            // 解放されない(コンポーネントコレクション同様、こちらも明示的なDisposeが要る)ため、
            // ここでキャンセルしたうえで破棄する。
            _folderScanCts?.Cancel();
            _folderScanCts?.Dispose();
            _folderScanCts = null;
            _searchCts?.Cancel();
            _searchCts?.Dispose();
            _searchCts = null;
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

    private const int WM_SYSCOMMAND = 0x0112;
    private const int SC_KEYMENU = 0xF100;

    /// <summary>
    /// Altの単押しでWindowsが「メニューモード」へ入るのを止める。
    ///
    /// PaneのメニューバーはWebView2の中のHTMLで、Alt単押しはその表示/非表示の切替に
    /// 割り当てている(src/commands.js)。ところがAltがこのウィンドウのウィンドウプロシージャまで
    /// 届くと、DefWindowProcがWM_SYSCOMMAND(SC_KEYMENU)を投げてシステムメニューの
    /// メニューモードに入ってしまう。その間はキーボードフォーカスがWebView2から外れるため、
    /// 次のAltはメニューモードを抜けるだけでJS側に届かず、「初回は1回、以降は2回押さないと
    /// 切り替わらない」という挙動になっていた。
    ///
    /// JS側でもAltのkeydown/keyupをpreventDefault()して外へ通さないようにしているが、
    /// WebView2の版によっては素通りし得るため、ここでも保険として捨てる。
    /// このアプリはWinForms側にメニューストリップを持たないため、SC_KEYMENUを無視しても
    /// 失われる機能は無い(Alt+F4のSC_CLOSE等は別のwParamなので影響しない)。
    /// </summary>
    protected override void WndProc(ref Message m)
    {
        if (m.Msg == WM_SYSCOMMAND && ((int)m.WParam & 0xFFF0) == SC_KEYMENU)
        {
            return;
        }
        base.WndProc(ref m);
    }

    /// <summary>
    /// タイトルバー(ネイティブキャプション)の配色を現在の設定に合わせて塗り直す。
    /// 呼び出しタイミング: (1)ウィンドウ生成直後(<see cref="OnHandleCreated"/>)、
    /// (2)JS側からのテーマ変更("set-theme")受信時、(3)設定の再配信(<see cref="PostCapabilities"/>)。
    /// 実際の色は案B(既定の代表色)でまず決め、JS側から届いた実描画色(<see cref="_titlebarBackgroundOverride"/>等)
    /// があればそちらで上書きする。<see cref="WindowChrome"/>側で例外はすべて握りつぶされるため、
    /// ここから先で失敗してもアプリは落ちない。
    /// </summary>
    /// <remarks>
    /// callerは「このウィンドウのタイトルバー塗り直しを誰が要求したか」(OnHandleCreated /
    /// PostCapabilities / OnWebMessageReceived 等)を、コンパイラが自動で埋める呼び出し元名。
    /// このメソッド自体が中継役なので、そのままWindowChrome側へ素通しして実機ログに残す
    /// (そうしないとログ上の呼び出し元がいつもApplyTitleBarThemeになってしまい、
    /// 「0.37秒ごとに呼ばれ続ける」経路の特定に使えない)。
    /// </remarks>
    private void ApplyTitleBarTheme([CallerMemberName] string caller = "")
        => ApplyTitleBarTheme(SettingsService.Load(), caller);

    private void ApplyTitleBarTheme(AppSettings settings, [CallerMemberName] string caller = "")
    {
        if (!IsHandleCreated) return;
        bool isDark = ResolveIsDarkTheme(settings.Theme);
        // callerFile/callerLineはコンパイラの自動補完に任せず明示的に渡す(自動補完だと
        // 中継役であるこのメソッドの位置が入ってしまうため)。行番号は意味を持たないので0。
        WindowChrome.ApplyTheme(
            this, isDark, _titlebarBackgroundOverride, _titlebarForegroundOverride,
            callerMember: caller, callerFile: "MainForm.cs", callerLine: 0);
    }

    /// <summary>設定の"theme"("system"/"light"/"dark")を実際のダーク/ライト判定に解決する。
    /// "system"のときはWindowsのアプリ配色設定(レジストリ)に従う。想定外の値もsystem扱い。</summary>
    internal static bool ResolveIsDarkTheme(string theme) => theme switch
    {
        "dark" => true,
        "light" => false,
        _ => WindowChrome.IsSystemDarkTheme(),
    };

    /// <summary>実バグ3の修正で追加。いま実際に効いているテーマプリセットID("default"/
    /// "night"/"nord"等)を、src/main.jsの適用ロジック(apply-settings受信時に
    /// document.documentElement.dataset.lightTheme/darkThemeへ入れる値)と同じ規則で解決する。
    /// ネイティブメニュー(Pane/NativeMenu.cs PaneMenuRenderer)がHTML側と同じ配色を
    /// 選べるようにするためのもの。
    ///   ライト: settings.LightTheme
    ///   ダーク: useSeparateThemeInDarkMode===false ならLightThemeを流用、それ以外はDarkTheme
    /// (main.js側コメント「useSeparateThemeInDarkMode(既定true)がfalseのときは、ダーク
    /// モードでもdarkThemeのプリセットを適用しない」と同じ挙動)。</summary>
    internal static string ResolveThemeId(AppSettings settings, bool isDark)
    {
        string id = isDark
            ? (settings.UseSeparateThemeInDarkMode ? settings.DarkTheme : settings.LightTheme)
            : settings.LightTheme;
        return string.IsNullOrEmpty(id) ? "default" : id;
    }

    /// <summary>
    /// 起動時の白フラッシュ対策(実機不具合の修正、新方式での位置づけ): 保存されているテーマ
    /// 設定に応じて、WebView2に覆われる前に見えうる2つの背景(WinFormsコントロール自体の
    /// BackColorと、CoreWebView2ControllerのDefaultBackgroundColor)を先に塗っておく。
    ///
    /// 新方式(WebView2を"initial-render-ready"受信まで非表示にする、コンストラクタ・
    /// RevealWebView参照)では、ここで塗るBackColorが主役になる——WebView2が非表示の間、
    /// ユーザーに実際に見えているのはこの色そのものだからである(白が出ないことの直接の
    /// 根拠)。DefaultBackgroundColorは、表示に切り替わった直後・まだCSSが完全に反映しきる
    /// 前の一瞬の保険として引き続き塗っておく(多層防御。無くても新方式の正しさには
    /// 影響しないが、あって困る理由も無い)。
    /// </summary>
    private void ApplyInitialWebViewBackground()
    {
        Color background = ResolveInitialThemeBackgroundColor(out bool isDark);
        BackColor = background;
        _webView.DefaultBackgroundColor = background;
        Logger.Write($"ApplyInitialWebViewBackground: isDark={isDark}, color={ColorTranslator.ToHtml(background)}");
    }

    /// <summary>
    /// 保存済み設定のテーマから「起動直後に見せるべき背景色」を解決する。
    /// <see cref="ApplyInitialWebViewBackground"/>(BackColor/DefaultBackgroundColor)と
    /// <see cref="Program"/>のWEBVIEW2_DEFAULT_BACKGROUND_COLOR環境変数が必ず同じ色になるよう、
    /// 「設定を読む→ダーク判定→色に変換」という手順をここ1か所に集約する
    /// (色の値そのものの定義は<see cref="ResolveThemeBackgroundColor"/>が唯一の出どころ)。
    /// </summary>
    internal static Color ResolveInitialThemeBackgroundColor(out bool isDark)
    {
        AppSettings settings = SettingsService.Load();
        isDark = ResolveIsDarkTheme(settings.Theme);
        return ResolveThemeBackgroundColor(isDark);
    }

    /// <summary>
    /// テーマ(ダーク/ライト)に対応する、起動直後の背景色。src/style.cssの:root(ライト既定)・
    /// html[data-theme="dark"]それぞれの--paperと揃える(CSSファイル自体を読めないので
    /// ここでは値を決め打ちにする。style.cssには同じセレクタ(:root / html[data-theme="dark"])の
    /// ブロックが複数あり、後方のブロックがカスケードで--paperを上書きしているため、値は
    /// 実際にブラウザで解決される最終値(Playwrightでcomputed styleを実測して確認済み)を
    /// 使うこと。既定テーマの色がstyle.css側で変わった場合はここも合わせて直すこと。
    /// テーマプリセット(lightTheme/darkTheme)による上書きまでは反映していない(近似値で十分なため)。
    /// <see cref="MainForm"/>・<see cref="SettingsWindow"/>の双方が同じ色を使う必要があるため
    /// (どちらも起動時に同じ白フラッシュ対策を行う)、internal staticとして共有する。
    /// </summary>
    internal static Color ResolveThemeBackgroundColor(bool isDark) => isDark
        ? Color.FromArgb(0x14, 0x17, 0x1A) // src/style.css: html[data-theme="dark"] --paper(最終値)
        : Color.FromArgb(0xFB, 0xFB, 0xFA); // src/style.css: :root --paper(最終値)

    /// <summary>
    /// 起動時の白フラッシュ対策(新方式)の要: WebView2コントロールを実際に表示する。
    /// 呼び出し経路は2つ:
    ///   (1) JS側("initial-render-ready")からの正常な通知。テーマ・メニューバー・
    ///       ステータスバー・本文エリアの初期描画が完了した時点で送られてくる
    ///       (src/main.js trySignalInitialRenderReady参照)。
    ///   (2) フォールバックタイマー(<see cref="_webViewRevealFallbackTimer"/>)が
    ///       <see cref="WebViewRevealFallbackMs"/>だけ待っても(1)が来なかった場合の保険。
    ///       JS側が例外で止まる等、通知が永久に来ないケースに備える(無いと、非表示のまま
    ///       ウィンドウがテーマ色一色で固まって見えてしまう)。
    /// どちらが先に来ても、2回目以降は<see cref="_webViewRevealed"/>で二重処理を防ぐ。
    /// </summary>
    /// <summary>
    /// このウィンドウが実際に使える状態(本文が描画され、WebView2が見えている状態)になった
    /// ときに1度だけ発火する。PaneApplicationContextが、仕様書 第8.4節の数値目標
    /// 「既存インスタンスへのファイル追加表示 300ms以内」「2枚目以降のウィンドウ追加メモリ
    /// 60MB以内」を実測するために購読する。
    ///
    /// 初期描画完了の通知(initial-render-ready)が届かずフォールバックで表示した場合も、
    /// 利用者から見れば「使える状態になった」ことに変わりはないため同じく発火する。
    /// </summary>
    public event Action? ReadyToUse;

    private void RevealWebView(bool viaFallback)
    {
        if (_webViewRevealed) return;
        _webViewRevealed = true;
        _webViewRevealFallbackTimer.Stop();
        _webView.Visible = true;
        Logger.Write(viaFallback
            ? $"WebView2を表示(フォールバック: {WebViewRevealFallbackMs}ms以内にinitial-render-readyが届かなかったため強制表示)"
            : "WebView2を表示(JS側からinitial-render-ready受信)");

        try
        {
            ReadyToUse?.Invoke();
        }
        catch (Exception ex)
        {
            // 購読側(計測)の失敗で表示処理を巻き添えにしない。
            Logger.WriteException("ReadyToUseの通知に失敗", ex);
        }
    }

    /// <summary>
    /// 未保存の変更がある場合、閉じる・新規作成・別のファイルを開く等、現在の文書を
    /// 置き換えるあらゆる操作の前に呼ぶ。保存する/しない/キャンセルを確認し、「保存する」が
    /// 選ばれた場合はJS側に保存を依頼してその完了(save-result)を待つ。
    /// 戻り値がtrueなら呼び出し元の操作を続行してよい。falseなら中止する。
    /// </summary>
    private async Task<bool> ConfirmDiscardDirtyAsync()
    {
        if (!_isDirty) return true;

        DialogResult choice = PaneDialog.Show(
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
        // フォールバックタイマーはここ(WebView2初期化・Navigateを含む一連の起動処理の起点)から
        // 数える。JS側からのinitial-render-ready通知が無くても、この時点からWebViewRevealFallbackMsが
        // 過ぎれば強制的に表示する(RevealWebView参照)。
        _webViewRevealFallbackTimer.Start();

        CoreWebView2Environment env = await EnsureEnvironmentAsync();
        await _webView.EnsureCoreWebView2Async(env);
        Logger.Write($"WebView2初期化完了: バージョン={_webView.CoreWebView2.Environment.BrowserVersionString}");

        // ファイルのD&D: AllowExternalDropは既定のtrueのまま変更しない。
        //
        // 経緯(不具合修正、計4回の試行を経た最終形):
        // 1回目: AllowExternalDrop=falseでこのフォームのOnDragDropへ流す方式は、本文エリア上で
        // ドラッグ中ずっと禁止マーク(🚫)が出る副作用が実機で確認され撤回。
        // 2回目: フォームのOnDragEnterでフルパスを先取りし、JSからの名前+サイズと照合する方式は、
        // WebView2がクライアント領域をほぼ覆っているためOnDragEnter自体が本文エリア上では
        // 発火しない(OSレベルD&Dは「カーソル直下のHWNDに登録されたIDropTarget」だけを見るため、
        // 通知が常にWebView2側で止まる)ことが実機ログで判明。ウィンドウ端の数pxを通過した
        // ときしか動かなかった。
        // 3回目: Win32のRevokeDragDrop(ole32.dll)でWebView2子ウィンドウのIDropTarget登録を
        // 解除する方式は、肝心のChrome_WidgetWin_1だけがHRESULT=0x8001010E(RPC_E_WRONG_THREAD)で
        // 失敗し効果ゼロと実機ログで確定(ウィンドウの所有が別プロセスmsedgewebview2.exeのため
        // 原理的に不成立)。関連コードは撤去済み。
        // 4回目(現在の方式): WebView2公式のpostMessageWithAdditionalObjects(SDK 1.0.1774.30
        // 以降)を使う。JS側(src/main.js)のdropハンドラがDOMのFileを添えて
        // "open-dropped-file-with-path"を送り、C#側はAdditionalObjectsに届く
        // CoreWebView2File.Pathからフルパスを直接取得する(HandleOpenDroppedFileWithPath参照)。
        // C#側でのドラッグの横取りが一切不要なため、禁止マークも発火しない問題も起きない。
        //
        // 保険として、JS側の「名前+サイズをC#へ送り、照合できなければバイト列でフォールバック」
        // という従来の2段構え(HandleOpenDroppedFileByName/TryResolveDraggedPath/
        // HandleOpenDroppedFile)はそのまま残してある。postMessageWithAdditionalObjectsが
        // 使えない古いランタイムでも、そちらの経路で開けるため、デグレードはしない。

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
        // ブラウザ既定の右クリックメニューを一切表示しない(docs/コンテキストメニュー仕様.md
        // 大原則1)。代わりにJS側(src/main.js)が独自メニューを組み立て、"open-context-menu"で
        // ネイティブポップアップ(Pane/NativeMenu.cs)を表示させる(HandleOpenContextMenuRequest参照)。
        _webView.CoreWebView2.Settings.AreDefaultContextMenusEnabled = false;
        // ブラウザ標準のスクリプトダイアログ(alert/confirm/prompt/beforeunloadの離脱確認)を出さない。
        // src/main.jsのbeforeunloadハンドラは、未保存時にブラウザ標準の離脱確認を出しうるが、
        // 保存確認はC#側のFormClosing(ConfirmDiscardDirtyAsync)で一元的に行っているため、
        // 塞いでも実害は無く、二重にダイアログが出る方が問題になる。第三者ライブラリが
        // alert()を呼んだ場合もPaneのデザインと無関係な標準ダイアログを出さずに黙殺できる。
        _webView.CoreWebView2.Settings.AreDefaultScriptDialogsEnabled = false;
        // タッチ/プレシジョンタッチパッドの2本指ピンチによるズームを無効化する。
        // IsZoomControlEnabled=false(上)はCtrl+ホイール等のブラウザズームUIを塞ぐだけで、
        // ピンチズームは塞がらない(公式ドキュメントにも「has no effect on the existing browser
        // zoom properties」と明記)。有効なままだとページがクリップされ、スクロールバーでは
        // 到達できない領域が生まれるうえ、Pane独自のズーム(本文フォントサイズ変更)と二重に効く。
        _webView.CoreWebView2.Settings.IsPinchZoomEnabled = false;
        // リンクにマウスを乗せたときChromium標準のURLチップ(左下に出る小さな帯)を出さない。
        // Pane独自のステータスバーと同じ位置に重なって表示されてしまうため。
        _webView.CoreWebView2.Settings.IsStatusBarEnabled = false;
        // Chromium標準のオートフィル候補(住所・氏名等)を出さない。Paneのデザインと無関係な
        // 見た目のポップアップが入力欄に出るうえ、メモ帳アプリとして入力内容をブラウザ
        // プロファイルへ保存しないのが妥当なため。
        _webView.CoreWebView2.Settings.IsGeneralAutofillEnabled = false;
        _webView.CoreWebView2.WebMessageReceived += OnWebMessageReceived;
        // 外部リンク(window.open・target="_blank"・iframe内のリンク・中クリック等)は、Pane内に
        // 新しいWebView2ウィンドウを作らせず、OSの既定ブラウザで開く(実機で確認された不具合の修正)。
        // 購読しない(あるいはHandledをfalseのままにする)と、公式ドキュメントのとおり
        // 「If this is false and no NewWindow is set, the WebView opens a popup window ...
        // there is no avenue to control the popup window from the app」となり、Pane内に
        // 制御不能なポップアップウィンドウが開いてしまう。処理の中身とURL検証・IsUserInitiatedに
        // ついての判断は、3ウィンドウ共通のExternalLinkServiceを参照。
        // 本体ウィンドウのログは元から接頭辞を持たないため、接頭辞には空文字を渡す。
        _webView.CoreWebView2.NewWindowRequested += (_, e) => ExternalLinkService.HandleNewWindowRequested(e, "");

        // ローカル画像配信用の専用ホスト(不具合修正: 本文はhttps://pane.local/index.htmlとして
        // 表示されており、そこ(pane.local、下でdist/へマッピング)には編集中の.mdと同じフォルダの
        // 画像は存在しないため、"![](image-1.png)"のような相対パスが必ず404していた)。
        // SetVirtualHostNameToFolderMapping(固定フォルダへの割り当て)ではなく
        // AddWebResourceRequestedFilter + WebResourceRequestedで都度応答する方式にするのは、
        // "../images/x.png"のように文書フォルダの外を指す相対パスや、"C:\..."のような絶対パスも
        // 扱う必要があり、固定フォルダ割り当てだとそのフォルダの外を一切見せられないため。
        // 範囲外アクセスの遮断はOnLocalFileResourceRequested/ResolveAllowedLocalFilePath参照。
        _webView.CoreWebView2.AddWebResourceRequestedFilter($"https://{LocalFileHostName}/*", CoreWebView2WebResourceContext.All);
        _webView.CoreWebView2.WebResourceRequested += OnLocalFileResourceRequested;

        // 起動時の白フラッシュ対策(実機不具合の修正、続き)。ApplyInitialWebViewBackground
        // (コンストラクタで実行済み)はWebView2自体の背景色を塗るだけで、実際にHTML/CSSが
        // 読み込まれた後はindex.html側の初期スクリプトがdata-theme属性を決めるまで、その
        // 属性の有無で切り替わるCSS変数(--paper等)は「未設定時の既定値」で描画される。
        // index.html冒頭の<script>は元々OS設定(prefers-color-scheme)だけを見てdata-themeを
        // 決めており、ユーザーが保存済みでOS設定と異なるテーマ(例: OSはライトだがPaneは
        // ダーク運用)を選んでいる場合、初回描画がOS設定側の配色になり、直後にapply-settingsが
        // 届いて選択済みテーマへ切り替わる、という一瞬のチラつきが起きていた。
        // AddScriptToExecuteOnDocumentCreatedAsyncで登録したスクリプトは、ナビゲート先の
        // 新しいdocumentが作られた直後・そのdocument内の他のどのスクリプト(index.html自身の
        // <script>を含む)よりも先に実行されるため、ここでdata-theme属性を確定させておけば
        // index.html側はOS設定を見る前にそれを尊重できる(index.html側もその判定に更新済み)。
        AppSettings navigateSettings = SettingsService.Load();
        bool navigateIsDark = ResolveIsDarkTheme(navigateSettings.Theme);
        string initialThemeAttr = navigateIsDark ? "dark" : "light";
        await _webView.CoreWebView2.AddScriptToExecuteOnDocumentCreatedAsync(
            $"document.documentElement.dataset.theme = '{initialThemeAttr}';");

        string distPath = ResolveDistPath();
        bool distExists = Directory.Exists(distPath);
        bool indexExists = File.Exists(Path.Combine(distPath, "index.html"));
        string distLine = $"distPath={distPath} (存在={distExists}, index.html存在={indexExists})";
        // dist/ が無いとエディタ本体がまったく表示されない(利用者から見れば「起動しない」)。
        // 配布物からdistフォルダだけ移動・削除された場合に起きるため、原因がすぐ分かるよう
        // エラーとして残す。
        if (distExists && indexExists) Logger.Write(distLine);
        else Logger.Error($"{distLine} ← dist/が見つからないため画面を表示できない。Pane.exeとdistフォルダは同じ場所に置く必要がある");
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

        // WebView2の初期化を待っている間に、これから読まれるdistのファイルを先に読んでおく
        // (StartWarmingUpDistの説明を参照)。WebView2の初期化とは無関係なので待たない。
        StartWarmingUpDist();

        await EnvironmentLock.WaitAsync();
        try
        {
            if (_cachedEnvironment is not null) return _cachedEnvironment;

            string userDataFolder = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                "Pane", "WebView2");

            // CreateAsyncが返ってこないと、ウィンドウが出ないまま無言で止まる。実機では
            // 更新直後の再起動でこれが起きたが、ログには「OnLoadAsync開始」までしか残らず
            // 何が起きたのか分からなかった。返るまでに時間がかかっている場合はその事実を
            // 記録しておき、次に起きたときに切り分けられるようにする。
            Task<CoreWebView2Environment> creating = CoreWebView2Environment.CreateAsync(userDataFolder: userDataFolder);
            var stopwatch = System.Diagnostics.Stopwatch.StartNew();
            if (await Task.WhenAny(creating, Task.Delay(5000)) != creating)
            {
                Logger.Warn($"CoreWebView2Environment生成が5秒経っても返らない(userDataFolder={userDataFolder})。" +
                            "他のPaneがまだ終了しきっていない可能性がある。このまま待ち続ける");
            }
            _cachedEnvironment = await creating;
            Logger.Write($"CoreWebView2Environment生成完了(プロセス全体でキャッシュ, {stopwatch.ElapsedMilliseconds}ms)");
            return _cachedEnvironment;
        }
        finally
        {
            EnvironmentLock.Release();
        }
    }

    /// <summary>distの先読みをプロセスで一度だけ行うためのフラグ。</summary>
    private static int _distWarmUpStarted;

    /// <summary>
    /// 起動時にWebView2が読むことになるdistのファイルを、先にディスクから読んでおく。
    ///
    /// 実機のログでは、起動の内訳のうち「バンドル評価」が2.1〜2.7秒を占めており、
    /// その内訳を計測したところ2.06秒はファイルの取得待ちで、JSの実行自体は約120msだった。
    /// 同じ処理が別のPCでは68msで終わっているため、置いてあるファイルを初めて読むときの
    /// 走査(ウイルス対策の常時監視)を待たされていると考えられる。
    ///
    /// ここで先に読み通しておくと、その待ちを「まだ画面を出していない今」へ寄せられる。
    /// WebView2の初期化と並行して走らせるので、全体としては待ち時間が重なって短くなる。
    ///
    /// 読むのは起動時に実際に使われるものだけ。distには言語ごとのパーサ等が200個以上
    /// 入っていて、それらは必要になったときに初めて読まれるため、ここで触ると逆に無駄が出る。
    /// index.htmlとmain.jsから静的なimportを辿って、その範囲に絞る。
    /// </summary>
    private static void StartWarmingUpDist()
    {
        if (Interlocked.Exchange(ref _distWarmUpStarted, 1) != 0) return;

        _ = Task.Run(() =>
        {
            try
            {
                string dist = ResolveDistPath();
                if (!Directory.Exists(dist)) return;

                var stopwatch = System.Diagnostics.Stopwatch.StartNew();
                var visited = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
                long total = 0;

                foreach (string name in new[] { "index.html", "style.css", "themes.css", "main.js" })
                {
                    total += WarmUpFileAndImports(dist, name, visited, depth: 0);
                }
                Logger.Debug($"distの先読み: {visited.Count}ファイル, 約{total / 1024}KB, {stopwatch.ElapsedMilliseconds}ms");
            }
            catch (Exception ex)
            {
                // 先読みは速くするためだけのもの。失敗しても起動には何の影響も無い。
                Logger.Debug($"distの先読みに失敗(無視して続行): {ex.GetType().Name}");
            }
        });
    }

    /// <summary>
    /// ファイルを1つ読み通し、その中の静的importを辿って同じことをする。
    /// 動的import(必要になってから読まれる言語パーサ等)は辿らない。
    /// </summary>
    private static long WarmUpFileAndImports(string distFolder, string name, HashSet<string> visited, int depth)
    {
        // 実際の依存は2段程度。深追いしても得るものが無いので打ち切る。
        if (depth > 3 || !visited.Add(name)) return 0;

        try
        {
            byte[] bytes = File.ReadAllBytes(Path.Combine(distFolder, name));
            long size = bytes.Length;
            if (!name.EndsWith(".js", StringComparison.OrdinalIgnoreCase)) return size;

            string text = System.Text.Encoding.UTF8.GetString(bytes);
            foreach (System.Text.RegularExpressions.Match m in StaticImportPattern.Matches(text))
            {
                size += WarmUpFileAndImports(distFolder, m.Groups[1].Value, visited, depth + 1);
            }
            return size;
        }
        catch
        {
            // 1つ読めなくても続ける(先読みなので取りこぼしても構わない)。
            return 0;
        }
    }

    /// <summary>バンドル済みJSの静的import(from"./chunk-XXXX.js" / import"./x.js")を拾う。</summary>
    private static readonly System.Text.RegularExpressions.Regex StaticImportPattern =
        new("(?:from|import)\\s*\"\\./([^\"]+\\.js)\"", System.Text.RegularExpressions.RegexOptions.Compiled);

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

    /// <summary>
    /// <see cref="LocalFileHostName"/>(ローカル画像配信用ホスト、OnLoadAsync参照)への
    /// リクエストへ、実ファイルを都度読んで応答する。src/editor.js resolveImageSrcが
    /// "https://pane-file.local/?path=&lt;実パスをencodeURIComponentしたもの&gt;" の形で
    /// 相対パス・絶対パス双方をここへ投げてくる(クエリ文字列にした理由は同関数のコメント参照)。
    ///
    /// セキュリティ(必須): 読める範囲は<see cref="ResolveAllowedLocalFilePath"/>が判定する
    /// 「編集中の全タブのフォルダ」と「サイドバーで開いているフォルダ」配下だけに限定する。
    /// 範囲外・存在しないファイルはエラー応答を返しログに残す(悪意ある文書が
    /// ![](C:\Users\...\秘密.txt) のように任意のローカルファイルを読ませようとする可能性を
    /// 考慮したもの。任意のローカルファイルが読めるようになってはいけない)。
    /// </summary>
    private void OnLocalFileResourceRequested(object? sender, CoreWebView2WebResourceRequestedEventArgs e)
    {
        string requestedRaw = "(不明)";
        try
        {
            var uri = new Uri(e.Request.Uri);
            string? rawPath = ExtractPathQueryParam(uri);
            if (rawPath is null)
            {
                e.Response = MakeLocalFileErrorResponse(400, "Bad Request");
                return;
            }
            requestedRaw = rawPath;

            string? resolved = ResolveAllowedLocalFilePath(rawPath);
            if (resolved is null)
            {
                Logger.Write($"pane-file.local: 範囲外または不正なパスへのアクセスを拒否: {rawPath}");
                e.Response = MakeLocalFileErrorResponse(403, "Forbidden");
                return;
            }
            var info = new FileInfo(resolved);
            if (!info.Exists)
            {
                e.Response = MakeLocalFileErrorResponse(404, "Not Found");
                return;
            }
            if (info.Length > LocalFileMaxServeBytes)
            {
                // 不具合修正: 従来はここにサイズ上限が無く、HandleReadLocalImageRequest
                // (エクスポート用、25MB上限あり)と非対称だった。丸ごとFile.ReadAllBytesで
                // メモリに読み込む前に弾く。範囲外アクセス(403)と同様にログへ残し、
                // レスポンスは意味の近い413(Payload Too Large)を返す。
                Logger.Write($"pane-file.local: サイズが大きいため配信を拒否({info.Length}バイト): {resolved}");
                e.Response = MakeLocalFileErrorResponse(413, "Payload Too Large");
                return;
            }

            byte[] bytes = File.ReadAllBytes(resolved);
            string contentType = ImageContentTypeFromExtension(Path.GetExtension(resolved));
            e.Response = _webView.CoreWebView2.Environment.CreateWebResourceResponse(
                new MemoryStream(bytes), 200, "OK", $"Content-Type: {contentType}\r\nCache-Control: no-store");
        }
        catch (Exception ex)
        {
            Logger.WriteException($"pane-file.localリクエストの処理に失敗: {requestedRaw}", ex);
            try { e.Response = MakeLocalFileErrorResponse(500, "Internal Server Error"); }
            catch { /* 応答生成自体の失敗はこれ以上どうしようもないため無視する */ }
        }
    }

    private CoreWebView2WebResourceResponse MakeLocalFileErrorResponse(int statusCode, string reasonPhrase) =>
        _webView.CoreWebView2.Environment.CreateWebResourceResponse(null, statusCode, reasonPhrase, "");

    /// <summary>URIのクエリ文字列から"path"パラメータを取り出し、URLデコードして返す。無ければnull。</summary>
    private static string? ExtractPathQueryParam(Uri uri)
    {
        string query = uri.Query; // 例: "?path=..."(先頭に"?"を含む)。無ければ""。
        if (query.Length < 2 || query[0] != '?') return null;
        foreach (string part in query[1..].Split('&'))
        {
            int eq = part.IndexOf('=');
            string key = eq >= 0 ? part[..eq] : part;
            if (key != "path") continue;
            return Uri.UnescapeDataString(eq >= 0 ? part[(eq + 1)..] : "");
        }
        return null;
    }

    /// <summary>
    /// 要求されたパスが「現在編集中の全タブのフォルダ」または「サイドバーで開いているフォルダ」
    /// 配下にあるかを検証し、あれば正規化した絶対パスを、範囲外またはパス自体が不正なら
    /// nullを返す。Path.GetFullPathで".."等を解決してから判定するため、
    /// "許可フォルダ\..\..\外部"のような脱出パスも正しく拒否できる
    /// (<see cref="OnLocalFileResourceRequested"/>・<see cref="HandleReadLocalImageRequest"/>共用)。
    ///
    /// シンボリックリンク対策: Path.GetFullPathはリンクを解決せず文字列上のパスを正規化する
    /// だけなので、「表面上は許可フォルダ配下に見えるが実体は外を指すリンク」を見逃してしまう
    /// (実際のファイル読み込みはOSがリンクをそのまま辿るため)。
    ///
    /// ラウンド3レビューでの指摘: File.ResolveLinkTargetは「引数に渡したパス自身」がリンクか
    /// どうかしか見ないため、対象ファイル自体がリンクの場合は正しく拒否できる一方、
    /// "許可フォルダ\link_dir\secret.txt" のように途中のディレクトリ(link_dir)だけが
    /// リンクの場合を見逃してしまう(fullPathそのものはリンクではないため)。
    /// これを塞ぐため、<see cref="ResolveRealPathAllLevels"/>でパスの各階層を根元から
    /// 一段ずつ実体化しながら辿り、最終的な実体パスが許可フォルダ配下かを判定する
    /// (対象ファイル自体がリンクの場合も、最後の階層としてこの中で解決されるため
    /// 従来どおり拒否できる)。
    /// </summary>
    private string? ResolveAllowedLocalFilePath(string requestedPath)
    {
        if (string.IsNullOrEmpty(requestedPath)) return null;
        string fullPath;
        try
        {
            fullPath = Path.GetFullPath(requestedPath);
        }
        catch (Exception ex) when (ex is ArgumentException or NotSupportedException or PathTooLongException)
        {
            return null;
        }

        List<string> roots = GetAllowedLocalFileRoots().ToList();
        if (!roots.Any(root => IsWithinRoot(fullPath, root))) return null;

        try
        {
            string realPath = ResolveRealPathAllLevels(fullPath);
            if (!roots.Any(root => IsWithinRoot(realPath, root)))
            {
                Logger.Write($"pane-file.local: シンボリックリンクの実体が範囲外のため拒否: {fullPath} -> {realPath}");
                return null;
            }
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            // リンク解決自体に失敗した場合は安全側に倒して拒否する。
            return null;
        }

        // 呼び出し元へ返すのは(実体パスではなく)元の正規化済みパス。File.ReadAllBytes等の
        // 実際の読み込みはOS自身が改めてリンクを辿って実体へ到達するため、ここでの実体パスは
        // あくまで「許可範囲内かどうかの判定」だけに使う(従来の挙動を踏襲)。
        return fullPath;
    }

    /// <summary>
    /// fullPath(<see cref="Path.GetFullPath(string)"/>済みの絶対パス)の各階層をルートから
    /// 順に辿り、途中のディレクトリがシンボリックリンク/ジャンクションであれば都度実体へ解決した
    /// うえで、最終的に指し示す実パスを返す。存在しない階層はリンク判定のしようがないため
    /// そのまま素通りする(存在しないファイルの404判定は呼び出し元の責務)。
    ///
    /// 【採用理由】1階層ずつ実体化しながら進む方式にした。パスの各段でFileSystemInfoを見れば
    /// 良いだけで.NET標準API(File.Exists/Directory.Exists/File.ResolveLinkTarget)のみで完結し、
    /// Windows/Linuxどちらでも同じロジックで動く。
    ///
    /// 【不採用にした代替案】
    /// ・Win32 GetFinalPathNameByHandle: カーネルが中間リンクも含めて一括で解決してくれ、
    ///   呼び出し回数の面では本来こちらの方が有利。しかしWindows専用のP/Invokeとなり、
    ///   今回の検証手順(ロジックを抽出しLinux上でdotnet run実行してシンボリックリンクを
    ///   実際に張って確認する)ができなくなる。このアプリ自体はWinForms/WebView2で元々
    ///   Windows専用だが、ロジック単体はOS非依存のまま検証・保守できる方が価値が高いと判断した。
    /// ・都度キャッシュ無しでフル解決: 正しく動くが、画像を多数含む文書では1画像ごとに
    ///   全階層をstatし直すことになりコストが積み上がる。<see cref="ResolveOneLevelCached"/>で
    ///   短時間のキャッシュを挟むことで緩和する。
    /// </summary>
    private string ResolveRealPathAllLevels(string fullPath)
    {
        string? root = Path.GetPathRoot(fullPath);
        if (string.IsNullOrEmpty(root))
        {
            // ルートが取れない異常なパスはここでは解決を諦め、呼び出し元のroots判定に委ねる
            // (許可フォルダ配下と一致しなければ結局そこで拒否される)。
            return fullPath;
        }

        string relative = fullPath[root.Length..];
        string[] segments = relative.Split(
            new[] { Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar },
            StringSplitOptions.RemoveEmptyEntries);

        string current = root;
        foreach (string segment in segments)
        {
            current = ResolveOneLevelCached(Path.Combine(current, segment));
        }
        return current;
    }

    /// <summary>
    /// pathがシンボリックリンク/ジャンクションであれば実体の絶対パスを、そうでなければ(または
    /// 存在しなければ)pathそのものを返す。<see cref="ResolveRealPathAllLevels"/>から
    /// 1階層ぶんずつ呼ばれる。
    ///
    /// 結果は<see cref="_pathResolutionCache"/>へ<see cref="PathResolutionCacheTtlMs"/>だけ
    /// キャッシュする。画像を多数含む文書ではこの判定が画像1枚ごとに、しかも同じ祖先
    /// ディレクトリに対して繰り返し走るため、都度stat/ResolveLinkTargetし直すコストが
    /// 効いてくる(1文書の描画バーストの間だけキャッシュが効けば十分)。
    ///
    /// TTLをあえて短く(数秒)している理由: キャッシュが古くなって「実は範囲外を指す
    /// リンクに張り替わっていた」場合に見逃すと安全性に関わるため、古い結果を長く
    /// 使い回さない。ローカルの正規ユーザーがその場でリンクを張り替えるような操作を
    /// しても数秒以内には反映される。エントリ数にも上限を設け、上限に達したら全消去する
    /// (キャッシュはあくまで性能最適化であり、消えても次回また計算されるだけで
    /// 安全性には影響しない)。
    /// </summary>
    private string ResolveOneLevelCached(string path)
    {
        if (_pathResolutionCache.TryGetValue(path, out var cached) && cached.ExpiresAtUtc > DateTime.UtcNow)
        {
            return cached.ResolvedPath;
        }

        string resolved = path;
        // File.ResolveLinkTargetは対象が存在しないとFileNotFoundExceptionを投げるため、
        // 実在するときだけ呼ぶ(存在しない階層はリンクのしようがなく、素通りしてよい)。
        if (File.Exists(path) || Directory.Exists(path))
        {
            FileSystemInfo? finalTarget = File.ResolveLinkTarget(path, returnFinalTarget: true);
            if (finalTarget is not null)
            {
                resolved = Path.GetFullPath(finalTarget.FullName);
            }
        }

        if (_pathResolutionCache.Count >= PathResolutionCacheMaxEntries)
        {
            _pathResolutionCache.Clear();
        }
        _pathResolutionCache[path] = (resolved, DateTime.UtcNow.AddMilliseconds(PathResolutionCacheTtlMs));
        return resolved;
    }

    /// <summary>許可フォルダの一覧: 現在編集中のファイルのフォルダ(タブ形式なら開いている
    /// 全タブぶん)と、サイドバーで開いているフォルダ。パスとして不正なタブは無視する。</summary>
    private IEnumerable<string> GetAllowedLocalFileRoots()
    {
        var roots = new List<string>();
        void AddDirOf(string? filePath)
        {
            if (filePath is null) return;
            try
            {
                string? dir = Path.GetDirectoryName(Path.GetFullPath(filePath));
                if (dir is not null) roots.Add(dir);
            }
            catch (Exception ex) when (ex is ArgumentException or NotSupportedException or PathTooLongException)
            {
                // 不正なパスは許可対象に加えない(単に無視する)。
            }
        }

        AddDirOf(_currentPath);
        foreach (TabInfo tab in _tabInfos) AddDirOf(tab.Path);
        if (_loadedFolderRootPath is not null)
        {
            try { roots.Add(Path.GetFullPath(_loadedFolderRootPath)); }
            catch (Exception ex) when (ex is ArgumentException or NotSupportedException or PathTooLongException) { }
        }
        return roots;
    }

    /// <summary>fullPathがroot配下(root自身を含む)かどうか。Windowsのファイルシステムは
    /// 既定で大文字小文字を区別しないため、比較もOrdinalIgnoreCaseで行う
    /// (別ドライブの大文字小文字違いだけの別フォルダを誤って許可することはない。
    /// ドライブレターを含むフルパス同士の比較のため)。</summary>
    private static bool IsWithinRoot(string fullPath, string root)
    {
        string normalizedRoot = root.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar) + Path.DirectorySeparatorChar;
        string normalizedTarget = fullPath.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar) + Path.DirectorySeparatorChar;
        return normalizedTarget.StartsWith(normalizedRoot, StringComparison.OrdinalIgnoreCase);
    }

    /// <summary>拡張子からContent-Typeを決める。未知の拡張子はoctet-streamにする
    /// (直接&lt;img&gt;のsrcにできず壊れたアイコン表示になるだけで、任意のファイルが
    /// 「画像として」実行される等の実害は無い。読める範囲自体はResolveAllowedLocalFilePathで
    /// 別途制限済み)。</summary>
    private static string ImageContentTypeFromExtension(string ext) => ext.ToLowerInvariant() switch
    {
        ".png" => "image/png",
        ".jpg" or ".jpeg" => "image/jpeg",
        ".gif" => "image/gif",
        ".webp" => "image/webp",
        ".svg" => "image/svg+xml",
        ".bmp" => "image/bmp",
        ".avif" => "image/avif",
        ".ico" => "image/x-icon",
        _ => "application/octet-stream",
    };

    /// <summary>
    /// HTMLエクスポート(仕様書 X-02/X-03)でローカル画像をdata:として埋め込むための読み取り要求
    /// (src/main.js requestLocalImageDataUri参照)。エクスポート後のHTMLは単体のファイルとして
    /// 開かれ、pane-file.localホストは実行中のPaneアプリ内でしか使えないため、エクスポート時点で
    /// base64化して埋め込む。範囲判定は<see cref="OnLocalFileResourceRequested"/>と全く同じ
    /// <see cref="ResolveAllowedLocalFilePath"/>を使う(任意のローカルファイルを読めてはいけない、
    /// という制約はエクスポート経由でも変わらないため)。
    /// </summary>
    private void HandleReadLocalImageRequest(JsonElement root)
    {
        TryGetInt(root, "requestId", out int requestId);
        TryGetString(root, "path", out string path);

        // 埋め込み画像1枚あたりの上限(base64化するとサイズが約1.33倍になるうえ、
        // エクスポート結果のHTML自体に丸ごと同梱されるため、際限なく巨大なファイルを
        // 埋め込んでしまわないよう上限を設ける。超えた場合はdata:埋め込みを諦め、
        // JS側(md-to-html.js substituteImagePlaceholders)が元のパスへフォールバックする)。
        // 上限値はOnLocalFileResourceRequestedと共通(LocalFileMaxServeBytes)。
        const long maxEmbedBytes = LocalFileMaxServeBytes;

        string? resolved = ResolveAllowedLocalFilePath(path);
        if (resolved is null)
        {
            Logger.Write($"read-local-image: 範囲外または不正なパスへのアクセスを拒否: {path}");
            PostToWeb(new { type = "read-local-image-result", requestId, dataUri = (string?)null });
            return;
        }

        try
        {
            var info = new FileInfo(resolved);
            if (!info.Exists)
            {
                PostToWeb(new { type = "read-local-image-result", requestId, dataUri = (string?)null });
                return;
            }
            if (info.Length > maxEmbedBytes)
            {
                Logger.Write($"read-local-image: サイズが大きいため埋め込みを省略({info.Length}バイト): {resolved}");
                PostToWeb(new { type = "read-local-image-result", requestId, dataUri = (string?)null });
                return;
            }

            byte[] bytes = File.ReadAllBytes(resolved);
            string contentType = ImageContentTypeFromExtension(Path.GetExtension(resolved));
            string base64 = Convert.ToBase64String(bytes);
            PostToWeb(new { type = "read-local-image-result", requestId, dataUri = $"data:{contentType};base64,{base64}" });
        }
        catch (Exception ex)
        {
            Logger.WriteException($"read-local-image: 読み込みに失敗: {resolved}", ex);
            PostToWeb(new { type = "read-local-image-result", requestId, dataUri = (string?)null });
        }
    }

    /// <summary>
    /// 「届いたこと自体」の記録価値が低く、量だけが多いメッセージ種別かどうか。
    ///
    /// 入力・スクロール・ドラッグのたびに飛んでくるもの(dirty/set-font-size/set-sidebar-width)、
    /// 内容が直後に別の行として出るためタイプ名の記録が完全に重複するもの(log)、
    /// こちらからの要求に対する応答で要求側の行を見れば足りるもの(*-response)が対象。
    /// これらを常に記録していると、1回の起動で数百行のうち大半がこれで埋まり、
    /// 肝心の不具合の手がかりが読み取れなくなる(実機ログの実測で185行/1275行が
    /// "type=log" の1種類だけで占められていた)。
    ///
    /// 出さないのではなく詳細ログ(<see cref="Logger.Debug"/>)へ落としているだけなので、
    /// 設定「詳細ログを記録する」を有効にすればすべて記録される。
    /// </summary>
    private static bool IsHighFrequencyMessageType(string type) => type switch
    {
        "dirty" => true,
        "log" => true,
        "titlebar-color" => true,
        "set-font-size" => true,
        "set-sidebar-width" => true,
        "open-menu" => true,
        "close-menu" => true,
        "text-response" => true,
        "all-tabs-text-response" => true,
        "is-document-empty-response" => true,
        _ => false,
    };

    /// <summary>
    /// { type: "duplicate", name, text } を受け取り、いま開いている文書の複製を
    /// 新しいウィンドウ(タブ形式ならタブ)で開く(仕様書 F-08「名前を付けて保存／複製」の複製)。
    ///
    /// 複製はファイルとして保存はせず、内容だけを引き継いだ未保存の文書として開く。
    /// 元のファイルには一切触れないため、元を残したまま試し書きしたい場合に使える。
    /// D&Dのフォールバック経路と同じ「名前+中身で新しいウィンドウを開く」仕組み
    /// (DroppedFileContent)に相乗りしており、開いた先の表示形式(ウィンドウ/タブ)の判断も
    /// そちらと同じ扱いになる。
    /// </summary>
    private void HandleDuplicate(JsonElement root)
    {
        if (!TryGetString(root, "text", out string text))
        {
            Logger.Warn("duplicate: textが無いため複製できない");
            return;
        }
        TryGetString(root, "name", out string name);
        string copyName = MakeCopyName(name);
        // UTF-8で渡す。受け取る側(TextFileService.LoadBytes)がバイト列から文字コードを
        // 判定するため、日本語を含む文書はUTF-8として、ASCIIだけの文書はどう判定されても
        // 同じ文字列になる。
        byte[] bytes = System.Text.Encoding.UTF8.GetBytes(text);
        Logger.Write($"duplicate: 「{copyName}」として複製を開く({bytes.Length}バイト)");
        _requestNewWindowWithContent?.Invoke(new DroppedFileContent(copyName, bytes));
    }

    /// <summary>
    /// 複製に付ける名前を作る。拡張子は元のまま残す("sample.md" → "sample のコピー.md")。
    /// 名前が無い(無題の)場合は「無題 のコピー.md」にする。
    /// </summary>
    private static string MakeCopyName(string? name)
    {
        string source = string.IsNullOrWhiteSpace(name) ? "無題.md" : name.Trim();
        string extension = Path.GetExtension(source);
        string stem = Path.GetFileNameWithoutExtension(source);
        if (string.IsNullOrEmpty(stem)) stem = "無題";
        if (string.IsNullOrEmpty(extension)) extension = ".md";
        return $"{stem} のコピー{extension}";
    }

    private void OnWebMessageReceived(object? sender, CoreWebView2WebMessageReceivedEventArgs e)
    {
        // JS側から届くメッセージは外部入力として扱う。個々のcase内は共有ヘルパー
        // (JsonMessageHelpers)でValueKindを確認して安全に読み取っているが、それでも
        // 想定していない経路(JSON自体が壊れている・ロジック側の不具合等)で例外が
        // 漏れた場合に備え、メッセージ1件の処理全体を保険としてtry/catchで囲む。
        // ここが無いと、1つの不正なメッセージでOnWebMessageReceivedの外(WebView2の
        // イベントディスパッチ元)まで例外が伝播し、アプリ全体が落ちる。
        string type = "(unknown)";
        try
        {
            using JsonDocument doc = JsonDocument.Parse(e.WebMessageAsJson);
            JsonElement root = doc.RootElement;
            TryGetString(root, "type", out type);
            // 入力のたび・スクロールのたびに飛んでくる種類は詳細ログ(既定では出さない)へ回す。
            // 以前は "dirty" だけを完全に握りつぶしていたが、それでは詳細に追いたいときにも
            // 一切見られなかった。レベルを下げるだけにして、設定「詳細ログを記録する」を
            // 有効にすれば全部見えるようにしてある。
            if (IsHighFrequencyMessageType(type)) Logger.Debug($"JSからのメッセージ受信: type={type}");
            else Logger.Write($"JSからのメッセージ受信: type={type}");

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
            case "initial-render-ready":
                // 起動時の白フラッシュ対策(新方式)の本体。JS側(src/main.js)がテーマ・
                // メニューバー・ステータスバー・本文エリアの初期描画を終えた時点で送ってくる。
                // これを受けて初めてWebView2コントロールを表示する(RevealWebView参照)。
                Logger.Write("initial-render-ready受信(JS側の初期描画完了通知)");
                RevealWebView(viaFallback: false);
                break;
            case "open":
                // 新規作成・開くは現在のウィンドウを置き換えず、常に新しいウィンドウで開く。
                HandleOpenRequest();
                break;
            case "open-path":
                if (TryGetString(root, "path", out string openPath))
                {
                    _ = HandleOpenPathRequestAsync(openPath);
                }
                break;
            case "save":
                HandleSaveRequest(root);
                break;
            case "set-encoding":
                // ステータスバーからの明示的な文字コード変更(仕様書 第6.1節)。ここでは
                // _currentEncodingを更新するだけでファイルへは書き込まない。次回保存
                // (HandleSaveRequest)がこの値を使って再エンコードする。「dirty」通知は
                // JS側main.jsのsetEncoding()が別途送る(未保存の変更としてタイトルへ反映するため)。
                if (root.TryGetProperty("encoding", out JsonElement setEncProp) && setEncProp.ValueKind == JsonValueKind.String)
                {
                    _currentEncoding = TextFileService.ParseEncodingLabel(setEncProp.GetString() ?? "");
                    Logger.Write($"set-encoding: {TextFileService.EncodingLabel(_currentEncoding)}");
                }
                break;
            case "set-line-ending":
                // ステータスバーからの明示的な改行コード変更(仕様書 第6.2節)。「混在」からの
                // 統一操作も含め、実体はここで_currentLineEndingを差し替えるだけ(本文は読み込み時
                // 点で既に\nへ正規化済みのため、保存時にDenormalizeFromLfが選んだ改行コードで
                // 全体を書き出す=統一される)。
                if (root.TryGetProperty("lineEnding", out JsonElement setLeProp) && setLeProp.ValueKind == JsonValueKind.String)
                {
                    _currentLineEnding = TextFileService.ParseLineEndingLabel(setLeProp.GetString() ?? "");
                    Logger.Write($"set-line-ending: {TextFileService.LineEndingLabel(_currentLineEnding)}");
                }
                break;
            case "dirty":
                if (TryGetBool(root, "value", out bool dirtyValue))
                {
                    SetDirty(dirtyValue);
                }
                break;
            case "text-response":
                if (TryGetString(root, "text", out string autoSaveText))
                {
                    WriteAutoSaveSnapshot(autoSaveText);
                }
                break;
            case "is-document-empty-response":
                // ネイティブD&D(OnDragDrop)がRequestIsDocumentEmptyAsyncで送った
                // "request-is-document-empty"への応答。本文はJS(CodeMirror)側にしか無いため、
                // request-text/text-responseと同じ考え方の往復メッセージで取得する。
                // requestIdが現在待っている問い合わせのものと一致する応答だけを受け付ける
                // (_isDocumentEmptyRequestIdの説明参照)。番号が無い/食い違う応答は、
                // タイムアウト後に遅れて届いた古いものなので黙って捨てる。
                if (TryGetBool(root, "isEmpty", out bool documentIsEmpty)
                    && TryGetInt(root, "requestId", out int respondedRequestId)
                    && respondedRequestId == _isDocumentEmptyRequestId)
                {
                    _isDocumentEmptyCompletionSource?.TrySetResult(documentIsEmpty);
                }
                break;
            case "tabs-changed":
                // タブ形式(仕様書 第2.10節 C-14、隠し設定)。タブの一覧・アクティブタブが
                // 変わるたびJS側(main.js)から届く。
                HandleTabsChanged(root);
                break;
            case "all-tabs-text-response":
                // タブ形式の自動保存(仕様書 N-06)。"request-all-tabs-text"の応答。
                HandleAllTabsTextResponse(root);
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
            case "duplicate":
                HandleDuplicate(root);
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
            case "read-local-image":
                // HTMLエクスポートでのローカル画像data:埋め込み(仕様: エクスポート後のHTMLは
                // pane-file.localホストが存在しない環境で単体のファイルとして開かれるため)。
                HandleReadLocalImageRequest(root);
                break;
            case "open-dropped-file-with-path":
                // 実アプリでのD&Dの主経路(第1経路)。JS側がWebView2公式の
                // postMessageWithAdditionalObjectsでDOMのFileを添えて送ってきており、
                // AdditionalObjectsのCoreWebView2File.Pathからフルパスを直接取得できる
                // (詳細はHandleOpenDroppedFileWithPathのコメント参照)。
                HandleOpenDroppedFileWithPath(root, e);
                break;
            case "open-dropped-file-by-name":
                // 実アプリでのD&Dの第2経路(保険。postMessageWithAdditionalObjectsが使えない
                // 古いランタイム向け。AllowExternalDrop=trueのまま、名前+サイズの照合で
                // フルパスを復元する。詳細はHandleOpenDroppedFileByNameのコメント参照)。
                HandleOpenDroppedFileByName(root);
                break;
            case "open-dropped-file":
                // 上記の照合に失敗した場合のフォールバック経路。JS側がrequest-dropped-file-fallback
                // を受けて、名前+バイト列を添えてこちらへ送り直してくる。
                HandleOpenDroppedFile(root);
                break;
            case "log":
                // JS側の不具合調査ログ(main.jsのlogToHost)をC#側と同じログファイルへ集約する。
                string level = TryGetString(root, "level", out string levelValue) ? levelValue : "log";
                TryGetString(root, "message", out string logMessage);
                // JS側のレベルに応じた重要度で記録する(振り分けはLogger.WriteFromWeb)。
                Logger.WriteFromWeb("JS", level, logMessage);
                break;
            case "set-theme":
                if (TryGetString(root, "theme", out string themeValue))
                {
                    SaveTheme(themeValue);
                    ApplyTitleBarTheme(); // テーマ変更を即座にタイトルバーへも反映する
                }
                break;
            case "titlebar-color":
                // 案A: JS側から実際の描画色(--paper/--inkの計算結果)が届いた場合の受け口。
                // { type: "titlebar-color", background: "#RRGGBB", foreground: "#RRGGBB" }
                string? titlebarBackground = TryGetNullableString(root, "background");
                string? titlebarForeground = TryGetNullableString(root, "foreground");
                // テーマ適用のたびに飛んでくる(実際に色が変わったかどうかはWindowChrome側が判定する)。
                Logger.Debug($"titlebar-color受信: background={titlebarBackground ?? "(なし)"}, foreground={titlebarForeground ?? "(なし)"}");
                if (!string.IsNullOrWhiteSpace(titlebarBackground)) _titlebarBackgroundOverride = titlebarBackground;
                if (!string.IsNullOrWhiteSpace(titlebarForeground)) _titlebarForegroundOverride = titlebarForeground;
                ApplyTitleBarTheme();
                break;
            case "set-font-size":
                if (TryGetInt(root, "size", out int fontSize))
                {
                    SaveFontSize(fontSize);
                }
                break;
            case "set-sidebar-width":
                // サイドバー幅のドラッグリサイズ(ユーザー要望2)。ドラッグ終了時・既定幅への
                // ダブルクリック復帰時にJS側(sidebar.js)から送られてくる。他ウィンドウへの
                // 再配信は不要(サイドバー幅はウィンドウごとの見た目の好みのため、
                // ウィンドウ位置・サイズと同じくbroadcastはしない)。
                if (TryGetInt(root, "width", out int sidebarWidth))
                {
                    SaveSidebarWidth(sidebarWidth);
                }
                break;
            case "open-folder":
                // newWindow: JS側(main.js openFolder())が本文の空判定(D&Dのopen-dropped-file
                // と同じ考え方)で送ってくる。trueなら新しいウィンドウでフォルダを開く。
                bool openFolderNewWindow = root.TryGetProperty("newWindow", out JsonElement openFolderNewWindowProp)
                    && openFolderNewWindowProp.ValueKind == JsonValueKind.True;
                HandleOpenFolderRequest(openFolderNewWindow);
                break;
            case "load-folder":
                string? folderPath = TryGetNullableString(root, "path");
                if (!string.IsNullOrEmpty(folderPath))
                {
                    _ = LoadFolderAsync(folderPath);
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
            case "open-log-folder":
                // 設定画面「バージョン情報」カテゴリ: ログフォルダをエクスプローラーで開く。
                SettingsBridge.OpenLogFolderInExplorer();
                break;
            case "open-today-log":
                // 設定画面「バージョン情報」カテゴリ: 今日のログファイルを既定のアプリで開く。
                SettingsBridge.OpenTodayLogFile();
                break;
            case "open-theme-folder":
                // 設定画面「外観」「バージョン情報」カテゴリ: カスタムCSSのサンプルが
                // 置いてあるフォルダ(ThemeFolderService.FolderPath)をエクスプローラーで開く。
                SettingsBridge.OpenThemeFolderInExplorer();
                break;
            case "reset-settings":
                SettingsBridge.HandleResetSettingsRequest(PostToWeb, BroadcastOrRefreshSelf);
                break;
            // 更新の確認と適用(仕様書 U-01・U-04)。設定画面をモーダルで開いている場合は
            // この経路を通る(独立ウィンドウで開いている場合はSettingsWindow側)。
            // どちらも待ち時間があるため非同期で走らせ、結果は update-check-result /
            // update-progress として画面へ返す(ここでawaitするとUIが固まる)。
            case "check-update":
                _ = SettingsBridge.HandleCheckUpdateRequestAsync(PostToWeb);
                break;
            case "apply-update":
                _ = SettingsBridge.HandleApplyUpdateRequestAsync(
                    PostToWeb,
                    _hasUnsavedDocuments ?? (() => IsDirty),
                    _shutdownForUpdate ?? (() => { }));
                break;
            case "open-release-page":
                // 開くURLはC#側が直前の確認で受け取った値だけを使う
                // (SettingsBridge.OpenReleasePage参照)。
                SettingsBridge.OpenReleasePage();
                break;
            case "open-settings-window":
                // 設定画面を独立ウィンドウとして開く(または既に開いていれば前面へ)。
                // 実体はPaneApplicationContext.OpenSettingsWindowが持つ(同時に1つしか開かない)。
                // categoryは任意。更新の案内(U-06)の「更新する」からは "versionInfo" が付く。
                _requestOpenSettingsWindow?.Invoke(
                    this, TryGetString(root, "category", out string settingsCategory) ? settingsCategory : null);
                break;
            case "open-help-window":
                // 取扱説明書ウィンドウ(F1、メニューバー右上の「?」ボタン、コマンドパレットの
                // help.manual)を独立ウィンドウとして開く(または既に開いていれば前面へ)。
                // 実体はPaneApplicationContext.OpenHelpWindowが持つ(同時に1つしか開かない)。
                _requestOpenHelpWindow?.Invoke(this);
                break;
            case "open-menu":
                // メニューバーの見出しがクリックされた(またはAltキー操作で開かれた)。
                // ネイティブなポップアップ(Pane/NativeMenu.cs)で表示する(ユーザー要望:
                // ウィンドウを小さくしても項目数の多いメニューが画面外へはみ出さないように)。
                HandleOpenMenuRequest(root);
                break;
            case "open-context-menu":
                // 本文・サイドバー等での右クリック(docs/コンテキストメニュー仕様.md)。
                // メニューバーと同じネイティブポップアップを、クリック位置そのものに出す。
                HandleOpenContextMenuRequest(root);
                break;
            case "open-in-default-app":
                // 右クリックメニュー「画像を開く」(仕様書 2.4)。OSの既定アプリで開くだけで、
                // 現在の編集内容には触れない(open-pathとは異なりウィンドウの中身は置き換えない)。
                if (TryGetString(root, "path", out string openDefaultPath))
                {
                    FolderService.OpenInDefaultApp(openDefaultPath);
                }
                break;
            case "reveal-in-explorer":
                // サイドバーの右クリックメニュー「エクスプローラーで表示」(仕様書 4.2・4.3)。
                if (TryGetString(root, "path", out string revealPath))
                {
                    FolderService.RevealInExplorer(revealPath);
                }
                break;
            case "open-path-new-window":
                // サイドバーの右クリックメニュー「新しいウィンドウで開く」(仕様書 4.2)。
                // File > 開く(HandleOpenRequest)と同じ経路(_requestNewWindow)を使う。
                // pathプロパティさえ存在すれば(型が違ってもnullとして)開く、という従来の挙動を保つ。
                if (root.TryGetProperty("path", out _))
                {
                    _requestNewWindow?.Invoke(TryGetNullableString(root, "path"));
                }
                break;
            case "delete-path":
                HandleDeletePathRequest(root);
                break;
            case "rename-path":
                HandleRenamePathRequest(root);
                break;
            case "create-file-in-folder":
                HandleCreateFileInFolderRequest(root);
                break;
            }
        }
        catch (Exception ex)
        {
            // 1つの不正なメッセージ(壊れたJSON・想定外の型・処理中の予期しない例外)で
            // アプリ全体が落ちないようにする最終防波堤。どのメッセージ種別(type)を処理していて
            // 何が起きたかをログへ残す(typeの取得自体に失敗していれば"(unknown)"のまま)。
            Logger.WriteException($"OnWebMessageReceivedで未処理の例外が発生した(type={type})", ex);
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
        TryGetString(root, "menu", out string menuName);
        TryGetDouble(root, "x", out double cssX);
        TryGetDouble(root, "y", out double cssY);
        List<NativeMenu.MenuItemData> items = root.TryGetProperty("items", out JsonElement itemsProp) && itemsProp.ValueKind == JsonValueKind.Array
            ? ParseMenuItems(itemsProp)
            : new List<NativeMenu.MenuItemData>();

        Point screenPoint = CssPointToScreenPoint(cssX, cssY);
        Logger.Write($"open-menu: menu={menuName}, 項目数={items.Count}, cssPoint=({cssX},{cssY}), DeviceDpi={DeviceDpi}, screenPoint=({screenPoint.X},{screenPoint.Y})");

        AppSettings menuSettings = SettingsService.Load();
        bool isDark = ResolveIsDarkTheme(menuSettings.Theme);
        string themeId = ResolveThemeId(menuSettings, isDark);
        NativeMenu.Show(
            screenPoint,
            isDark,
            themeId,
            items,
            onCommand: id => PostToWeb(new { type = "menu-command", id }),
            onClosed: () => PostToWeb(new { type = "menu-closed", menu = menuName }),
            onArrowSwitch: direction =>
            {
                // ←→キーでの隣のメニューへの切り替え要求(NativeMenu.Show onArrowSwitch参照)。
                // どのメニュー名が「次/前」にあたるかはメニューバーの並び順(JS側のcommands.js
                // が唯一保持している)次第のため、ここでは方向だけをJSへ伝え、実際にどの
                // メニュー名へ切り替えるかの決定と実行(openNativeMenu)はJS側(handleMenuHoverSwitch
                // と同じ経路を再利用するhandleMenuArrowSwitch)に委ねる。
                string dirLabel = direction == NativeMenu.MenuArrowDirection.Next ? "次" : "前";
                Logger.Write($"キーボードでメニュー切り替え要求: {menuName} → {dirLabel}");
                PostToWeb(new { type = "menu-arrow-switch", menu = menuName, direction = direction == NativeMenu.MenuArrowDirection.Next ? "next" : "prev" });
            });
    }

    /// <summary>
    /// { type: "open-context-menu", x, y, items } を受け取り、ToolStripDropDownMenuを表示する
    /// (docs/コンテキストメニュー仕様.md 第1章)。座標変換は<see cref="HandleOpenMenuRequest"/>と
    /// 全く同じ(<see cref="CssPointToScreenPoint"/>を共用)だが、"menu"というキー(見出し名)を
    /// 持たない代わりに、menu-closedのmenuには固定値"__context__"を入れる(src/commands.js の
    /// nativeOpenMenuName/showContextMenu との突き合わせにそのまま乗る。ここを外すと
    /// 「メニュー外クリックで閉じない」という既知の不具合が再発するため、必ずこの値にすること)。
    /// </summary>
    private void HandleOpenContextMenuRequest(JsonElement root)
    {
        double cssX = root.TryGetProperty("x", out JsonElement xProp) && xProp.ValueKind == JsonValueKind.Number ? xProp.GetDouble() : 0;
        double cssY = root.TryGetProperty("y", out JsonElement yProp) && yProp.ValueKind == JsonValueKind.Number ? yProp.GetDouble() : 0;
        List<NativeMenu.MenuItemData> items = root.TryGetProperty("items", out JsonElement itemsProp) && itemsProp.ValueKind == JsonValueKind.Array
            ? ParseMenuItems(itemsProp)
            : new List<NativeMenu.MenuItemData>();

        Point screenPoint = CssPointToScreenPoint(cssX, cssY);
        Logger.Write($"open-context-menu: 項目数={items.Count}, cssPoint=({cssX},{cssY}), DeviceDpi={DeviceDpi}, screenPoint=({screenPoint.X},{screenPoint.Y})");

        AppSettings contextMenuSettings = SettingsService.Load();
        bool isDark = ResolveIsDarkTheme(contextMenuSettings.Theme);
        string themeId = ResolveThemeId(contextMenuSettings, isDark);
        NativeMenu.Show(
            screenPoint,
            isDark,
            themeId,
            items,
            onCommand: id => PostToWeb(new { type = "menu-command", id }),
            onClosed: () => PostToWeb(new { type = "menu-closed", menu = "__context__" }));
    }

    /// <summary>
    /// WebView2内のCSSピクセル座標を画面座標(スクリーン座標)へ変換する。
    /// open-menu/open-context-menu共通の座標変換ロジック(<see cref="HandleOpenMenuRequest"/>の
    /// XMLコメントに詳細あり): DeviceDpi(96分率)でデバイスピクセルへ換算してから
    /// <see cref="Control.PointToScreen"/>で画面座標へ変換する2段階。
    /// </summary>
    private Point CssPointToScreenPoint(double cssX, double cssY)
    {
        double dpiScale = DeviceDpi / 96.0;
        var clientPoint = new Point((int)Math.Round(cssX * dpiScale), (int)Math.Round(cssY * dpiScale));
        return _webView.PointToScreen(clientPoint);
    }

    /// <summary>"open-menu"/"open-context-menu"のitems配列(入れ子のsubmenuを含む)をJSONから<see cref="NativeMenu.MenuItemData"/>へ変換する。</summary>
    private static List<NativeMenu.MenuItemData> ParseMenuItems(JsonElement arrayElement)
    {
        var list = new List<NativeMenu.MenuItemData>();
        foreach (JsonElement el in arrayElement.EnumerateArray())
        {
            string? id = TryGetNullableString(el, "id");
            TryGetString(el, "label", out string label);
            TryGetString(el, "shortcut", out string shortcut);
            bool enabled = !el.TryGetProperty("enabled", out JsonElement enProp) || enProp.ValueKind != JsonValueKind.False;
            bool isChecked = el.TryGetProperty("checked", out JsonElement chProp) && chProp.ValueKind == JsonValueKind.True;
            bool separatorAfter = el.TryGetProperty("separatorAfter", out JsonElement sepProp) && sepProp.ValueKind == JsonValueKind.True;
            TryGetString(el, "note", out string note);
            List<NativeMenu.MenuItemData>? submenu = el.TryGetProperty("submenu", out JsonElement subProp) && subProp.ValueKind == JsonValueKind.Array
                ? ParseMenuItems(subProp)
                : null;
            list.Add(new NativeMenu.MenuItemData(id, label, shortcut, enabled, isChecked, separatorAfter, note, submenu));
        }
        return list;
    }

    // ---- サイドバーの右クリックメニュー(docs/コンテキストメニュー仕様.md 第4.2節・第4.3節) ----
    // 実処理はFolderService(既存のフォルダ走査サービス)へ集約し、ここではJSONの取り出しと
    // 完了後のフォルダ再読み込み・エラー表示だけを行う。

    /// <summary>"delete-path": ファイル/フォルダをごみ箱へ送る。</summary>
    private void HandleDeletePathRequest(JsonElement root)
    {
        TryGetString(root, "path", out string path);
        if (path.Length == 0) return;
        if (!FolderService.DeleteToRecycleBin(path, out string? error))
        {
            PaneDialog.Show(this, $"削除できませんでした。\n{error}", "Pane", MessageBoxButtons.OK, MessageBoxIcon.Error);
        }
        ReloadLoadedFolderIfAny();
    }

    /// <summary>"rename-path": 同じ親フォルダ内でファイル/フォルダの名前を変更する。</summary>
    private void HandleRenamePathRequest(JsonElement root)
    {
        TryGetString(root, "path", out string path);
        TryGetString(root, "newName", out string newName);
        if (path.Length == 0 || newName.Length == 0) return;
        if (!FolderService.RenamePath(path, newName, out string? error))
        {
            PaneDialog.Show(this, $"名前を変更できませんでした。\n{error}", "Pane", MessageBoxButtons.OK, MessageBoxIcon.Error);
        }
        ReloadLoadedFolderIfAny();
    }

    /// <summary>"create-file-in-folder": 指定フォルダ直下に空の新規ファイルを作る。</summary>
    private void HandleCreateFileInFolderRequest(JsonElement root)
    {
        TryGetString(root, "dirPath", out string dirPath);
        TryGetString(root, "name", out string name);
        if (dirPath.Length == 0 || name.Length == 0) return;
        if (!FolderService.CreateFile(dirPath, name, out string? error))
        {
            PaneDialog.Show(this, $"ファイルを作成できませんでした。\n{error}", "Pane", MessageBoxButtons.OK, MessageBoxIcon.Error);
        }
        ReloadLoadedFolderIfAny();
    }

    /// <summary>サイドバーに読み込み済みのフォルダがあれば再走査してJSへ送り直す
    /// (削除/名前変更/新規作成の結果を一覧へ反映する)。</summary>
    private void ReloadLoadedFolderIfAny()
    {
        // 既に読み込み済みのフォルダの再走査(削除/名前変更/新規作成の反映、設定変更の反映)
        // であり、ユーザーが新たに「フォルダを開いた」わけではないためautoLoaded: trueにする。
        if (_loadedFolderRootPath is not null) _ = LoadFolderAsync(_loadedFolderRootPath, autoLoaded: true);
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
        // タブ形式(仕様書 第2.10節 C-14、隠し設定)のときは、現在のタブを置き換えず
        // 新しいタブとして開く(保存確認も不要。既存の文書はそのまま残るため)。
        // 「最近使ったファイル」・サイドバーのファイル一覧/ツリー・クイックオープン・
        // グローバル検索結果のクリックは、いずれもこの経路(open-path)を通る。
        if (SettingsService.Load().DisplayMode == "tab")
        {
            OpenInNewTab(path);
            return;
        }
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
        TryGetString(message, "text", out string text);
        TryGetBool(message, "saveAs", out bool saveAs);

        if (_isReadOnly && !saveAs)
        {
            DialogResult choice = PaneDialog.Show(
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
            PaneDialog.Show(
                this,
                $"ファイルを開けませんでした。\n{ex.Message}",
                "Pane",
                MessageBoxButtons.OK,
                MessageBoxIcon.Error);
        }
    }

    /// <summary>
    /// タブ形式(仕様書 第2.10節 C-14、隠し設定)のとき、新規ウィンドウの代わりにこのウィンドウへ
    /// 新しいタブとしてファイルを開く。<see cref="OpenFile"/>と違い、このウィンドウの現在の文書
    /// (アクティブタブ)には一切触れない(_currentPath等は更新しない。アクティブタブの情報は
    /// JS側からの直後の"tabs-changed"で反映される)。
    /// 呼び出し元: <see cref="PaneApplicationContext.OpenWindow"/>(コマンドライン引数・
    /// 多重起動時のパイプ・File&gt;開く等、本来新規ウィンドウを作る経路すべて)、
    /// <see cref="HandleOpenPathRequestAsync"/>(最近使ったファイル・サイドバー・
    /// クイックオープン・グローバル検索結果等)、<see cref="OnDragDrop"/>(D&amp;D)。
    /// pathがnullなら新規の空文書タブを開く(File&gt;新規作成に相当)。
    /// </summary>
    public void OpenInNewTab(string? path)
    {
        if (path is null)
        {
            AppSettings newDocSettings = SettingsService.Load();
            PostToWeb(new
            {
                type = "open-in-tab",
                text = "",
                fileName = "無題",
                path = (string?)null,
                encoding = TextFileService.EncodingLabel(TextFileService.ParseEncodingKey(newDocSettings.DefaultEncoding)),
                lineEnding = TextFileService.LineEndingLabel(TextFileService.ParseLineEndingKey(newDocSettings.DefaultLineEnding)),
                readOnly = false,
            });
            return;
        }

        Logger.Write($"OpenInNewTab: {path}");
        try
        {
            LoadResult result = TextFileService.Load(path);
            bool readOnly = IsFileReadOnly(path);
            AddRecentFile(path);
            PostToWeb(new
            {
                type = "open-in-tab",
                text = result.Text,
                fileName = Path.GetFileName(path),
                path,
                encoding = TextFileService.EncodingLabel(result.Encoding),
                lineEnding = TextFileService.LineEndingLabel(result.LineEnding),
                readOnly,
            });
            AutoLoadParentFolder(path);
        }
        catch (Exception ex)
        {
            Logger.WriteException($"タブとして開けなかった: {path}", ex);
            PaneDialog.Show(
                this,
                $"ファイルを開けませんでした。\n{ex.Message}",
                "Pane",
                MessageBoxButtons.OK,
                MessageBoxIcon.Error);
        }
    }

    /// <summary>
    /// タブ形式(仕様書 第2.10節 C-14)。JS側(main.js)からタブの一覧・アクティブタブが
    /// 変わるたびに届く"tabs-changed"を受け取り、(1)セッション復元・自動保存対象として
    /// <see cref="_tabInfos"/>を更新し、(2)アクティブタブの情報でこのクラスが元々持っている
    /// 「現在の文書」を表すフィールド(_currentPath等)を更新する。これにより
    /// <see cref="UpdateTitle"/>・外部変更監視(<see cref="StartWatching"/>)など、
    /// 元々1ウィンドウ=1ファイル前提だったロジックをタブ形式でもそのまま使い回せる。
    /// </summary>
    private void HandleTabsChanged(JsonElement root)
    {
        string? activeGuid = root.TryGetProperty("activeGuid", out JsonElement agProp) && agProp.ValueKind == JsonValueKind.String
            ? agProp.GetString()
            : null;

        var tabInfos = new List<TabInfo>();
        string? activePath = null;
        bool activeDirty = false;
        bool activeReadOnly = false;
        FileEncodingKind activeEncoding = _currentEncoding;
        LineEndingKind activeLineEnding = _currentLineEnding;
        bool foundActive = false;

        if (root.TryGetProperty("tabs", out JsonElement tabsProp) && tabsProp.ValueKind == JsonValueKind.Array)
        {
            foreach (JsonElement t in tabsProp.EnumerateArray())
            {
                TryGetString(t, "guid", out string guid);
                string? tPath = t.TryGetProperty("path", out JsonElement pProp) && pProp.ValueKind == JsonValueKind.String ? pProp.GetString() : null;
                TryGetBool(t, "dirty", out bool dirty);
                tabInfos.Add(new TabInfo(guid, tPath, dirty));

                if (activeGuid is not null && guid == activeGuid)
                {
                    foundActive = true;
                    activePath = tPath;
                    activeDirty = dirty;
                    TryGetBool(t, "readOnly", out activeReadOnly);
                    if (t.TryGetProperty("encoding", out JsonElement eProp) && eProp.ValueKind == JsonValueKind.String)
                    {
                        activeEncoding = TextFileService.ParseEncodingLabel(eProp.GetString() ?? "");
                    }
                    if (t.TryGetProperty("lineEnding", out JsonElement leProp) && leProp.ValueKind == JsonValueKind.String)
                    {
                        activeLineEnding = TextFileService.ParseLineEndingLabel(leProp.GetString() ?? "");
                    }
                }
            }
        }

        _tabInfos = tabInfos;
        if (!foundActive) return; // アクティブタブ不明時は_currentPath等を不用意に消さない

        bool pathChanged = !string.Equals(_currentPath, activePath, StringComparison.OrdinalIgnoreCase);
        _currentPath = activePath;
        _currentEncoding = activeEncoding;
        _currentLineEnding = activeLineEnding;
        _isReadOnly = activeReadOnly;
        _isDirty = activeDirty;
        UpdateTitle();
        // アクティブタブが切り替わった/パスが変わった場合のみ外部変更監視を張り直す
        // (同じタブのdirty変化だけで毎回FileSystemWatcherを作り直すのは無駄なため)。
        if (pathChanged)
        {
            if (activePath is not null) StartWatching(activePath);
            else StopWatching();
        }
    }

    /// <summary>
    /// タブ形式の自動保存(仕様書 N-06)。<see cref="RequestAutoSaveSnapshot"/>が送った
    /// "request-all-tabs-text"の応答。タブごとにdirtyならスナップショットを書き、
    /// dirtyでなければ(明示保存済み・元々未変更)残っているスナップショットを消す。
    /// タブのGuidはJS側(main.js)がタブ作成時に発行した文字列をそのまま使う。
    /// </summary>
    private void HandleAllTabsTextResponse(JsonElement root)
    {
        if (!root.TryGetProperty("tabs", out JsonElement tabsProp) || tabsProp.ValueKind != JsonValueKind.Array) return;

        foreach (JsonElement t in tabsProp.EnumerateArray())
        {
            string? guidStr = TryGetNullableString(t, "guid");
            if (guidStr is null || !Guid.TryParse(guidStr, out Guid tabId)) continue;

            TryGetBool(t, "dirty", out bool dirty);
            if (!dirty)
            {
                AutoSaveService.DeleteSnapshot(tabId);
                continue;
            }

            TryGetString(t, "text", out string text);
            string? path = t.TryGetProperty("path", out JsonElement pProp) && pProp.ValueKind == JsonValueKind.String ? pProp.GetString() : null;
            FileEncodingKind encoding = t.TryGetProperty("encoding", out JsonElement eProp) && eProp.ValueKind == JsonValueKind.String
                ? TextFileService.ParseEncodingLabel(eProp.GetString() ?? "")
                : FileEncodingKind.Utf8;
            LineEndingKind lineEnding = t.TryGetProperty("lineEnding", out JsonElement leProp) && leProp.ValueKind == JsonValueKind.String
                ? TextFileService.ParseLineEndingLabel(leProp.GetString() ?? "")
                : LineEndingKind.Crlf;

            var snapshot = new AutoSaveSnapshot(path, text, encoding, lineEnding, true, DateTime.UtcNow);
            AutoSaveService.WriteSnapshot(tabId, snapshot);
        }
    }

    // ---- サイドバー用フォルダ走査(仕様書 第2.8節)。実体はFolderServiceに委譲する。 ----

    /// <summary>
    /// File &gt; フォルダを開く。<see cref="FolderBrowserDialog"/> で選ばせ、選ばれたら走査する。
    /// newWindow: trueなら、このウィンドウを置き換えず新しいウィンドウでフォルダを開く
    /// (ユーザー指示: 新規ファイル(未編集)から開いたときは現在のウィンドウを使い、
    /// それ以外は新しいウィンドウで開く。判定自体はJS側main.jsのopenFolder()が行う)。
    /// </summary>
    private void HandleOpenFolderRequest(bool newWindow)
    {
        using var dialog = new FolderBrowserDialog();
        if (dialog.ShowDialog(this) != DialogResult.OK) return;

        if (newWindow)
        {
            // _requestNewWindow(OpenWindow)はpathがDirectory.Existsなら自動的に
            // initialFolderPathとして新しいウィンドウを開く(PaneApplicationContext.OpenWindow参照)。
            // ドロップされたファイルの新規ウィンドウ経路(_requestNewWindowWithContent)とは
            // 別だが、既存の判定を素直に再利用できるためこの経路を使う。
            _requestNewWindow?.Invoke(dialog.SelectedPath);
            return;
        }
        _ = LoadFolderAsync(dialog.SelectedPath);
    }

    /// <summary>
    /// ファイルを開いた際、その親フォルダを自動で読み込む(Typoraと同じ挙動)。
    /// 既に読み込み済みのフォルダの配下(子孫を含む)にあるファイルなら、ファイルを開くたびに
    /// 毎回走査すると重いうえ、サイドバーのルートが孫階層のフォルダへ意図せず変わってしまう
    /// (ツリーの展開状態やスクロール位置も失われる)ため再走査しない。配下判定は
    /// <see cref="ResolveAllowedLocalFilePath"/>と同じ<see cref="IsWithinRoot"/>を再利用する
    /// (ここはセキュリティ境界ではなく再走査を省くための判定なので、シンボリックリンクの
    /// 実体解決は行わない=<see cref="ResolveRealPathAllLevels"/>は使わない)。
    /// </summary>
    private void AutoLoadParentFolder(string filePath)
    {
        string? parentDir = Path.GetDirectoryName(Path.GetFullPath(filePath));
        if (parentDir is null) return;

        if (_loadedFolderRootPath is not null && IsWithinRoot(parentDir, Path.GetFullPath(_loadedFolderRootPath)))
        {
            Logger.Write($"AutoLoadParentFolder: 読み込み済みフォルダの配下のため再走査をスキップ: {parentDir}");
            return;
        }

        // ファイルを開いた副作用としての自動読み込みであり、ユーザーが「フォルダを開いた」
        // わけではないためautoLoaded: trueにする(サイドバーを勝手に開いたり、見ている
        // パネルをファイルツリーへ強制的に切り替えたりしない)。
        _ = LoadFolderAsync(parentDir, autoLoaded: true);
    }

    /// <summary>
    /// 指定フォルダをFolderServiceで走査し、結果をJS側へfolder-loadedとして送る。
    /// "open-folder"(ダイアログ選択)・"load-folder"(JSからのパス指定)・
    /// AutoLoadParentFolder(ファイルを開いた際の自動読み込み)の3経路がすべてここを通る。
    /// 走査中に別のフォルダ読み込みが始まった場合は、前の走査をキャンセルする。
    /// </summary>
    /// <summary>
    /// autoLoaded: trueなら「ユーザーが明示的にフォルダを開いた」わけではない再走査
    /// (ファイルを開いた際の親フォルダ自動読み込み・削除/名前変更/新規作成後の再走査・
    /// 設定変更後の再走査)であることをJS側へ伝える。folder-loadedのペイロードへそのまま
    /// 乗せ、JS側(main.js)はこのフラグがtrueのときサイドバーの自動表示(仕様: フォルダを開いた
    /// 直後はサイドバーを開いてファイルツリータブへ切り替える)を行わない。既に見ている
    /// パネルを勝手にツリーへ切り替えたり、閉じているサイドバーを毎回開いたりしないための区別。
    /// </summary>
    private async Task LoadFolderAsync(string path, bool autoLoaded = false)
    {
        Logger.Write($"LoadFolderAsync開始: {path}, autoLoaded={autoLoaded}");
        // 走査中に別のフォルダ読み込みが始まった場合、前のCTSはCancelするだけでなく
        // ここでDisposeまで行う(不具合修正: 従来はCancelのみで、置き換えられた前のCTSが
        // 誰にもDisposeされないまま残っていた)。
        CancellationTokenSource? previousFolderScanCts = _folderScanCts;
        previousFolderScanCts?.Cancel();
        var cts = new CancellationTokenSource();
        _folderScanCts = cts;
        previousFolderScanCts?.Dispose();
        try
        {
            // 隠しファイル表示・除外パターン(仕様書「詳細」節 showHiddenFilesInTree/fileTreePatterns)は
            // 走査のたびに最新の設定を読み直す(設定画面を開いたまま値を変えても、次の再走査から
            // 反映されるようにするため。ReloadLoadedFolderIfAny/PostCapabilities側で再走査をトリガーする)。
            AppSettings settings = SettingsService.Load();
            FolderScanResult result = await FolderService.ScanAsync(path, settings.ShowHiddenFilesInTree, settings.FileTreePatterns, cts.Token);
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
                autoLoaded,
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
            // ここで自分が最新のCTSのままであれば、後続の走査にもFormClosedにも置き換えられて
            // いないということなので、役目を終えたCTSとして自分でDisposeする
            // (置き換えられていた場合は、置き換えた側またはFormClosedが既にDispose済み)。
            if (ReferenceEquals(_folderScanCts, cts))
            {
                _folderScanCts = null;
                cts.Dispose();
            }
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
        TryGetString(message, "query", out string queryText);
        bool caseSensitive = message.TryGetProperty("caseSensitive", out JsonElement csProp) && csProp.ValueKind == JsonValueKind.True;
        bool regexp = message.TryGetProperty("regexp", out JsonElement reProp) && reProp.ValueKind == JsonValueKind.True;
        bool wholeWord = message.TryGetProperty("wholeWord", out JsonElement wwProp) && wwProp.ValueKind == JsonValueKind.True;

        // 新しい検索が始まったら前の検索は必ずキャンセルする。CancelだけでDisposeしないと
        // 置き換えられた前のCTSが誰にもDisposeされないまま残ってしまう(不具合修正)ため、
        // このメソッドを抜けるすべての経路でDisposeする。
        CancellationTokenSource? previousSearchCts = _searchCts;
        previousSearchCts?.Cancel();

        if (_loadedFolderRootPath is null)
        {
            Logger.Write("global-search: フォルダ未読込のため検索できない");
            previousSearchCts?.Dispose();
            _searchCts = null;
            PostToWeb(new { type = "search-done", error = "フォルダが読み込まれていません" });
            return;
        }

        if (string.IsNullOrEmpty(queryText))
        {
            previousSearchCts?.Dispose();
            _searchCts = null;
            PostToWeb(new { type = "search-done", total = 0, truncated = false });
            return;
        }

        var cts = new CancellationTokenSource();
        _searchCts = cts;
        previousSearchCts?.Dispose();
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
            // ここで自分が最新のCTSのままであれば、後続の検索にもFormClosedにも置き換えられて
            // いないということなので、役目を終えたCTSとして自分でDisposeする
            // (置き換えられていた場合は、置き換えた側またはFormClosedが既にDispose済み)。
            if (ReferenceEquals(_searchCts, cts))
            {
                _searchCts = null;
                cts.Dispose();
            }
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
        // ワーカースレッドからの呼び出しなので、ウィンドウを閉じた直後に呼ばれる可能性がある。
        // IsDisposedを見ずにBeginInvokeすると、破棄済みのコントロールに対する呼び出しで
        // 例外になりうるため、先に確認してから触る(不具合修正)。
        // それでも「確認した直後に閉じられる」レースは原理的に残るため、PostToWeb側でも
        // 二重に防御している。
        if (IsDisposed || !IsHandleCreated)
        {
            Logger.Write("global-search: ウィンドウが破棄済みのためバッチ送信をスキップ");
            return Task.CompletedTask;
        }
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
    /// WebView2の本文エリア(Webページ側)へドラッグ&ドロップされたファイルを開く
    /// (名前+バイト列のみによる「無題」文書としての開き方。フルパスは分からない)。
    /// 現在の本文が空(失われる内容が無い)ならこのウィンドウで、何か書かれていれば
    /// 新しいウィンドウで開く(空かどうかの判定はJS側が行い、newWindowで伝えてくる)。
    ///
    /// 呼び出されるタイミング: AllowExternalDropは既定のtrueのままにしているため、
    /// 実際のドロップはWebView2内のJSが受け取り、通常はまずファイル名+サイズだけを
    /// "open-dropped-file-by-name"としてC#へ送ってくる(HandleOpenDroppedFileByName参照)。
    /// そこでDragEnterで先に得ていたフルパス一覧と照合できれば、そちらの正規の経路
    /// (OpenDroppedPathAsync、拡張子に基づくコードモード判定等が効く)で開かれ、この
    /// メソッドは使われない。このメソッドが実際に呼ばれるのは、その照合に失敗した場合
    /// (DragEnterを経由しなかった、WebView2のバージョン差等の想定外経路)にJS側が
    /// "request-dropped-file-fallback"を受けて送り直してくる"open-dropped-file"のみ。
    /// 「照合できなければ何も起きない」を避けるための最後の砦であり、標準のDOM File API
    /// しか使えない経路として、あえて削除せず残してある。DroppedFileContent/
    /// _requestNewWindowWithContent/OpenDroppedContentも同じ理由で残す。
    /// </summary>
    private void HandleOpenDroppedFile(JsonElement message)
    {
        string name = TryGetString(message, "name", out string droppedName) ? droppedName : "無題";
        TryGetString(message, "dataBase64", out string dataBase64);
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
            PaneDialog.Show(this, $"ファイルを開けませんでした。\n{ex.Message}", "Pane", MessageBoxButtons.OK, MessageBoxIcon.Error);
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
            // 保存先(path)は無いが、fileNameはドロップされた実ファイルの名前そのもの。
            // JS側decideFileModeは既定では「pathが無い=無題の新規文書」とみなして
            // Markdownで開くため、そのままだと.js等をドロップしてもMarkdownになってしまう
            // (実機で発覚)。この印を付けて、拡張子からモードを決めてよいことを伝える。
            fileNameIsReal = true,
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
        // 不具合修正: ここでencoding/lineEndingをPostToWebに載せていなかったため、
        // ウィンドウ形式の新規文書だけステータスバーの文字コード・改行コードが空になっていた
        // (OpenInNewTabは同じ値を送っており、タブ形式では発生しない)。
        PostToWeb(new
        {
            type = "new-document",
            encoding = TextFileService.EncodingLabel(_currentEncoding),
            lineEnding = TextFileService.LineEndingLabel(_currentLineEnding),
        });
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
            // JS側(main.js)へ「クラッシュリカバリからの復元である」ことを伝える。通常の
            // file-openedは読み込んだ内容を未保存表示の基準にするが、これは元ファイルの内容
            // ではなく未保存の編集内容を表示しているため、JS側は基準を確定させず
            // 復元直後から常にdirty扱いにする(src/main.js applyFileOpened参照)。
            recovered = true,
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
        // (B) 外部変更ダイアログで「いいえ」を選んだ後の抑止中であることをタイトルに示す。
        // ステータスバーはJS側(src/)の実装であり今回は変更できないため、C#側だけで完結する
        // 手段としてタイトルバーを使う(readOnlyMarkと同じ手法)。
        bool suppressed = _suppressedExternalChangePath is not null
            && string.Equals(_currentPath, _suppressedExternalChangePath, StringComparison.OrdinalIgnoreCase);
        string suppressMark = suppressed ? "[変更通知オフ] " : string.Empty;
        Text = $"{readOnlyMark}{suppressMark}{name}{dirtyMark} - Pane";
    }

    private void PostToWeb(object message)
    {
        // フォルダ走査・グローバル検索等の非同期処理は、ウィンドウを閉じた後に完了して
        // ここへ結果を送ってくることがある。IsDisposedを見ずにCoreWebView2だけ確認していると、
        // 破棄済みのWebView2/Formに対して操作してしまう可能性があるため、まずIsDisposedを確認する
        // (不具合修正: 従来はCoreWebView2 is nullのチェックのみだった)。
        if (IsDisposed || _webView.IsDisposed || _webView.CoreWebView2 is null) return;
        string json = JsonSerializer.Serialize(message, JsonOptions);
        _webView.CoreWebView2.PostWebMessageAsJson(json);
    }

    // ---- (撤去済み) WebView2子ウィンドウのOSドロップ先(IDropTarget)登録解除 ----
    //
    // かつてここにRevokeWebView2ChildDragDrop(Win32のRevokeDragDrop/EnumChildWindows/
    // GetClassNameのP/Invoke)があったが、実機ログで肝心のChrome_WidgetWin_1だけが
    // HRESULT=0x8001010E(RPC_E_WRONG_THREAD)で解除できず(ウィンドウの所有が別プロセス
    // msedgewebview2.exeのため原理的に不成立)、効果ゼロと確定したため全て削除した。
    // 現在のD&Dのフルパス取得はpostMessageWithAdditionalObjects経由
    // (HandleOpenDroppedFileWithPath参照)。

    private string? _lastDragLogKey;

    /// <summary>DragEnterで得た、直近1回のドラッグ操作ぶんのファイルパス一覧と、
    /// それを取得した時刻。JS側(src/main.js)から届く"open-dropped-file-by-name"
    /// (ファイル名+サイズのみ、標準のDOM File APIはフルパスを返さないため)と名前・サイズで
    /// 照合し、一致すればここからフルパスを取り出す(<see cref="TryResolveDraggedPath"/>)。
    ///
    /// 「直近1回ぶんだけ」保持する(配列を丸ごと上書きする)ことで、別フォルダにある同名ファイルを
    /// 続けてドラッグした場合の取り違えを防ぐ(常に直前のDragEnterで得た一覧だけが候補になり、
    /// さらに古い一覧とは絶対に混ざらない)。加えてファイルサイズも照合条件に含めており、
    /// 万一同一ドラッグ操作の複数ファイル中に同名ファイルがあっても、サイズが違えば別物として
    /// 区別できる(名前だけの照合よりも取り違えの確率を下げる)。
    ///
    /// 寿命(<see cref="PendingDragFilesLifetime"/>)を設けているのは、ドラッグを最後まで
    /// 完了させずに中断した場合(Escキー、ウィンドウ外でドロップ)にパスが残り続け、
    /// 後で無関係な操作(例えばブラウザ単体動作や別の経路からのopen-dropped-file-by-name)と
    /// 誤って照合されることを防ぐため。</summary>
    private (string[] Paths, DateTime CapturedAtUtc)? _pendingDragFiles;

    /// <summary><see cref="_pendingDragFiles"/>の有効期間。実機ログ上、DragEnterから実際の
    /// dropまでは1秒に満たない(コンマ数秒)ため、通常のドラッグ操作を妨げない範囲で
    /// 十分に短い値として5秒を選んだ(「短すぎて通常操作でも稀に無効化される」ことと
    /// 「長すぎて中断後の古いパスがいつまでも残る」ことの中間を狙った目安値。
    /// 数秒程度、というだけの根拠でありシビアな計測値ではない)。</summary>
    private static readonly TimeSpan PendingDragFilesLifetime = TimeSpan.FromSeconds(5);

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

        // AllowExternalDropを既定(true)のままにしたことで、ドラッグはこの後WebView2の領域へ
        // 入りDragLeaveが飛ぶが、それより前にここでフルパスを取れているうちに保持しておく
        // (実機ログで、AllowExternalDropが既定のときもOnDragEnter自体は確実に発火し、
        // DataFormats.FileDropが取得できることを確認済み)。DragEnter/DragOver両方から呼ばれる
        // ため毎回上書きになるが、内容は同じドラッグ操作の同じパス一覧のはずなので問題ない。
        if (hasFileDrop && e.Data?.GetData(DataFormats.FileDrop) is string[] { Length: > 0 } enterPaths)
        {
            _pendingDragFiles = (enterPaths, DateTime.UtcNow);
        }
    }

    private void OnDragLeave(object? sender, EventArgs e)
    {
        Logger.Write($"OnDragLeave (sender={sender?.GetType().Name})");
        _lastDragLogKey = null;
        // 注意: ここで_pendingDragFilesをクリアしてはいけない。実機ログで確認済みのとおり、
        // ドラッグがWebView2の領域(=本文エリア)へ入った時点でこのDragLeaveが飛ぶが、
        // 実際のドロップはその後WebView2内のJSが受け取る。ここでクリアすると、
        // 肝心のフルパスがドロップより前に消えてしまい、常にフォールバック経路
        // (バイト列による「無題」開き)行きになってしまう。クリアするのは
        // 「ドロップを処理し終えたとき」(HandleOpenDroppedFileByName)と
        // 「一定時間が過ぎたとき」(PendingDragFilesLifetime、TryResolveDraggedPath)のみ。
    }

    /// <summary>ネイティブD&amp;D(WinFormsのDragDrop)経路。現在はAllowExternalDropが既定のtrueの
    /// ため通常ここには来ず、実際のドロップはWebView2内のJS経由(open-dropped-file-by-name→
    /// <see cref="HandleOpenDroppedFileByName"/>)で処理される。それでも、WebView2のバージョン差や
    /// 何らかの事情でAllowExternalDropが効かない/OSからこのフォームへ直接ドロップが来た場合の
    /// 保険としてハンドラ自体は残してある(あえて削除しない)。</summary>
    private async void OnDragDrop(object? sender, DragEventArgs e)
    {
        _lastDragLogKey = null; // 次のドラッグ操作でまた最初の状態からログを記録できるようにする
        Logger.Write($"OnDragDrop (sender={sender?.GetType().Name}): dataPresent={e.Data?.GetDataPresent(DataFormats.FileDrop)}");
        if (e.Data?.GetData(DataFormats.FileDrop) is not string[] { Length: > 0 } paths) return;

        // このウィンドウ・この操作で扱うのは先頭の1件のみ(src/main.jsの旧JS側実装
        // =files[0]のみを見る、と同じ判断を踏襲)。複数ファイルを一度に別ウィンドウ・別タブへ
        // カスケード展開する機能は現時点では未実装(将来のPhase 3相当の拡張候補として送り、
        // 今回は「複数選択時は先頭のみ開き、残りは無視する」という既存の挙動を変えない)。
        string path = paths[0];
        Logger.Write(paths.Length > 1
            ? $"OnDragDrop: paths=[{string.Join(",", paths)}] (複数{paths.Length}件がドロップされたが先頭のみ開く)"
            : $"OnDragDrop: paths=[{string.Join(",", paths)}]");
        await OpenDroppedPathAsync(path);
    }

    /// <summary>フルパスが分かっているドロップ済みファイルを開く本体。ネイティブD&amp;D
    /// (<see cref="OnDragDrop"/>)と、JSからのファイル名照合が成功した経路
    /// (<see cref="HandleOpenDroppedFileByName"/>)の両方から呼ばれる、パスの入手経路に
    /// 依存しない共通処理。エクスプローラからファイルを開くのと同じOpenFile(path)系の経路に
    /// 乗せるため、拡張子に応じたコードモード判定・保存先の特定が正しく行われる。</summary>
    private async Task OpenDroppedPathAsync(string path)
    {
        // 画像ファイルのドロップは「このファイルを開く」ではなく「本文へ画像を挿入する」として
        // 扱う(仕様書 docs/設定項目一覧.md「画像」節。src/main.jsのisImageFile/insertImageFileと
        // 同じ判定・同じ考え方)。タブ形式かどうか・本文が空かどうかに関わらず常にこちらを優先する
        // (JS側の旧実装も、開く/新規ウィンドウの判定より前に画像判定を行っていた)。
        // Directory.Existsを先に見ているのは、拡張子に見える名前のフォルダ(稀だが例:
        // "screenshot.png"という名前のフォルダ)を誤って画像として扱わないための保険。
        if (!Directory.Exists(path) && IsImageFileForDrop(path))
        {
            InsertLocalImageAndNotify(path, null, Path.GetFileName(path));
            return;
        }

        // タブ形式(仕様書 第2.10節 C-14、隠し設定)のときは、現在の文書を保存確認なしに
        // 置き換えず、新しいタブとして開く。
        if (SettingsService.Load().DisplayMode == "tab")
        {
            OpenInNewTab(path);
            return;
        }

        // 本文が空(新規文書等、失われる内容が無い)ならこのウィンドウで開き、何か書かれていれば
        // 新しいウィンドウで開く(src/main.jsのisEmptyDocument判定と同じ基準に揃える。
        // エクスプローラからの二重クリックでは常に新規ウィンドウだが、D&Dはウィンドウ形式でも
        // 「空の無題文書へドロップしたときだけは現在のウィンドウを使う」という従来からの
        // JS側の挙動を保つ)。本文はJS(CodeMirror)側にしか無いため、request-textと同じ考え方の
        // 往復メッセージで問い合わせる。どちらの分岐でも現在の文書を壊さない(空なら失うものが無く、
        // 空でなければ現在のウィンドウには一切触れない)ため、ConfirmDiscardDirtyAsyncによる
        // 保存確認は不要(旧実装はここで確認ダイアログを出したうえで常に置き換えていたが、
        // それだとJS側=WebView2内ブラウザD&Dの挙動と食い違っていたため、この往復方式に揃えた)。
        bool isEmpty = await RequestIsDocumentEmptyAsync();
        if (!isEmpty)
        {
            // 現在のウィンドウには触れず、新しいウィンドウで開く。pathがフォルダなら
            // PaneApplicationContext.OpenWindowがDirectory.Existsで自動判定し、フォルダとして開く。
            _requestNewWindow?.Invoke(path);
            return;
        }
        if (Directory.Exists(path))
        {
            // フォルダをドロップした場合はフォルダとして開く。本文が空(=失うものが無い)ため、
            // File>フォルダを開く(newWindow=false)と同じ経路でこのウィンドウのサイドバーへ読み込む。
            _ = LoadFolderAsync(path);
            return;
        }
        OpenFile(path);
    }

    /// <summary>JS側(src/main.js)から届く"open-dropped-file-with-path"の受け口(D&amp;Dの第1経路)。
    /// JSはWebView2公式のpostMessageWithAdditionalObjects(SDK 1.0.1774.30以降)でDOMのFileを
    /// 添えて送ってきており、<see cref="CoreWebView2WebMessageReceivedEventArgs.AdditionalObjects"/>
    /// の各要素が<see cref="CoreWebView2File"/>として届く。そのPathプロパティがフルパスで、
    /// そのまま正規の経路(<see cref="OpenDroppedPathAsync"/>: 画像分岐・フォルダ分岐・
    /// 空文書判定→現ウィンドウ/新ウィンドウ)へ渡せる。複数ドロップは先頭の1件のみ使う
    /// (既存挙動の維持。JS側・<see cref="OnDragDrop"/>と同じ判断)。
    /// AdditionalObjectsがnull/空・キャスト失敗・Pathが空のときは、メッセージ本体の
    /// name/sizeを使って従来の名前+サイズ照合(<see cref="HandleDroppedFileByNameCore"/>)へ倒す。</summary>
    private void HandleOpenDroppedFileWithPath(JsonElement message, CoreWebView2WebMessageReceivedEventArgs e)
    {
        string name = TryGetString(message, "name", out string nameValue) ? nameValue : "";
        // サイズの受け取り方の理由はHandleOpenDroppedFileByName参照。
        long size = TryGetDouble(message, "size", out double sizeValue) ? (long)sizeValue : -1;
        int count = e.AdditionalObjects?.Count ?? -1;
        Logger.Write($"open-dropped-file-with-path受信: name={name}, size={size}, " +
            $"AdditionalObjects件数={(count < 0 ? "(null)" : count.ToString())}");

        if (e.AdditionalObjects is { Count: > 0 } objects)
        {
            // 先頭の1件のみ使う(複数ドロップ時は残りを無視する既存挙動を維持)。
            if (objects[0] is CoreWebView2File file && !string.IsNullOrEmpty(file.Path))
            {
                Logger.Write($"open-dropped-file-with-path: AdditionalObjects経由でフルパス取得: {file.Path}");
                _pendingDragFiles = null; // 保険経路用の保持パスはもう不要(次回以降の誤照合を防ぐ)
                _ = OpenDroppedPathAsync(file.Path);
                return;
            }
            Logger.Write($"open-dropped-file-with-path: AdditionalObjects[0]がCoreWebView2Fileでない、" +
                $"またはPathが空(実際の型={objects[0]?.GetType().FullName ?? "(null)"})。名前+サイズ照合へ倒す");
        }
        else
        {
            Logger.Write("open-dropped-file-with-path: AdditionalObjectsがnullまたは空。名前+サイズ照合へ倒す");
        }

        // フォールバック: 従来の"open-dropped-file-by-name"と同じ処理
        // (DragEnterで先取りしたパスとの照合→駄目ならバイト列フォールバック要求)。
        HandleDroppedFileByNameCore("open-dropped-file-with-path(フォールバック)", name, size);
    }

    /// <summary>JS側(src/main.js)から届く"open-dropped-file-by-name"の受け口(D&amp;Dの第2経路。
    /// postMessageWithAdditionalObjectsが使えない古いランタイム向けの保険)。標準のDOM File
    /// APIはセキュリティ上フルパスを返さないため、JSはファイル名(+サイズ)しか送ってこない。
    /// 照合・フォールバックの本体は<see cref="HandleDroppedFileByNameCore"/>参照。</summary>
    private void HandleOpenDroppedFileByName(JsonElement message)
    {
        string name = TryGetString(message, "name", out string nameValue) ? nameValue : "";
        // サイズは32bit精度を超えることがありうる(数GB相当のファイル)ため、TryGetIntではなく
        // TryGetDoubleで受け取る(doubleは2^53までの整数を正確に表現できるため、
        // 現実的なファイルサイズの照合には十分)。
        long size = TryGetDouble(message, "size", out double sizeValue) ? (long)sizeValue : -1;
        Logger.Write($"open-dropped-file-by-name受信: name={name}, size={size}");
        HandleDroppedFileByNameCore("open-dropped-file-by-name", name, size);
    }

    /// <summary>名前+サイズによるドロップ済みファイルの解決処理の本体。
    /// <see cref="_pendingDragFiles"/>(DragEnterで先に取得済みのフルパス一覧)と名前・サイズで
    /// 照合し、一致すればフルパス経由の正規の経路(<see cref="OpenDroppedPathAsync"/>)へ、
    /// 一致しなければJSへバイト列を要求し、名前+中身だけの「無題」文書として開く従来経路
    /// (<see cref="HandleOpenDroppedFile"/>)へフォールバックする(照合に失敗する経路でも
    /// 何も起きないのは最悪のため必ずどちらかへ倒す)。
    /// "open-dropped-file-by-name"(第2経路)と、"open-dropped-file-with-path"(第1経路)で
    /// AdditionalObjectsが取れなかった場合の両方から呼ばれる。</summary>
    /// <param name="logPrefix">ログ用: どの経路から来たか。</param>
    private void HandleDroppedFileByNameCore(string logPrefix, string name, long size)
    {
        string? matchedPath = TryResolveDraggedPath(name, size);
        if (matchedPath is not null)
        {
            Logger.Write($"{logPrefix}: DragEnterで保持済みのパスと照合成功 -> {matchedPath}");
            _pendingDragFiles = null; // 使い終わったのでクリア(次回以降の誤照合を防ぐ)
            _ = OpenDroppedPathAsync(matchedPath);
            return;
        }

        Logger.Write($"{logPrefix}: フルパスの照合に失敗したため、バイト列によるフォールバックを要求する");
        PostToWeb(new { type = "request-dropped-file-fallback" });
    }

    /// <summary><see cref="_pendingDragFiles"/>から、名前(と分かればサイズ)が一致するフルパスを
    /// 探す。見つからない場合(保持していない・期限切れ・一致するものが無い)はnull。</summary>
    private string? TryResolveDraggedPath(string name, long size)
    {
        if (_pendingDragFiles is not { } pending) return null;
        TimeSpan age = DateTime.UtcNow - pending.CapturedAtUtc;
        if (age > PendingDragFilesLifetime)
        {
            Logger.Write($"TryResolveDraggedPath: 保持していたパスが{age.TotalSeconds:F1}秒経過し" +
                $"期限({PendingDragFilesLifetime.TotalSeconds}秒)を超えているため無効化する" +
                "(ドラッグを中断した後の無関係なドロップとの誤照合を防ぐ)");
            _pendingDragFiles = null;
            return null;
        }

        foreach (string path in pending.Paths)
        {
            if (!string.Equals(Path.GetFileName(path), name, StringComparison.Ordinal)) continue;
            if (size < 0) return path; // サイズが分からない場合は名前一致のみで採用
            try
            {
                if (new FileInfo(path).Length == size) return path;
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
            {
                // ファイル情報を読めない場合は不一致扱いにして次の候補を見る
                Logger.WriteException($"TryResolveDraggedPath: {path} のサイズ取得に失敗", ex);
            }
        }
        return null;
    }

    /// <summary>本文が空かどうかをJS側(main.js)へ問い合わせる(request-text/text-responseと
    /// 同じ考え方の往復メッセージ)。JS側main.jsのisEmptyDocument判定
    /// (editor.getValue().trim() === "")と同じ基準の値が返る。</summary>
    private async Task<bool> RequestIsDocumentEmptyAsync()
    {
        // UIスレッドでTrySetResultを呼ぶため(is-document-empty-responseハンドラ参照)、
        // 継続処理を同期的に走らせるとUIスレッドを塞ぎうる。RunContinuationsAsynchronously
        // で継続をスレッドプールへ逃がす。
        var tcs = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
        // 通し番号を進めてから待機口を差し替える。応答側はこの番号が一致するときだけ
        // TrySetResultするので、遅れて届いた古い応答が次の待機を解決することはない。
        int requestId = ++_isDocumentEmptyRequestId;
        _isDocumentEmptyCompletionSource = tcs;
        PostToWeb(new { type = "request-is-document-empty", requestId });

        // JS側はeditor.getValue()を読んで返すだけの処理のため本来は一瞬(数ms~数十ms)で
        // 返るはずだが、(1)WebView2の初期化が終わる前にドロップされた、(2)JS側で未処理例外が
        // 起きてメッセージループが止まっている、(3)ウィンドウを閉じる操作と重なった、等の場合は
        // 応答が永久に返らないことがある。無期限にawaitし続けると「ドロップしたのに何も起きない」
        // まま操作不能になるため、上限を設けて安全側の既定値で先へ進める。
        // 1000msは、通常あり得る応答時間(数十ms)に十分な余裕を持たせつつ、異常時にユーザーを
        // 待たせすぎない長さとして選んだ目安値。
        const int TimeoutMs = 1000;
        Task winner = await Task.WhenAny(tcs.Task, Task.Delay(TimeoutMs));
        if (winner != tcs.Task)
        {
            // タイムアウト。安全側の既定値(false="本文は空ではない")で進める。呼び出し元は
            // false側で「現在の文書には触れず新しいウィンドウで開く」経路を通るため、応答が
            // 来なかっただけでユーザーの書きかけを失うことがない(true側は現在のウィンドウの
            // 内容を置き換えてしまうため、応答不明時の既定値にはできない)。
            Logger.Write("RequestIsDocumentEmptyAsync: JS側からの応答がタイムアウトしたため既定値(false)で続行");
            // 後から本来の応答が遅れて届いてもTrySetResultは二重設定を無視するだけなので安全。
            tcs.TrySetResult(false);
        }

        bool result = await tcs.Task;

        // 使い終わったら必ずnullへ戻す。ReferenceEqualsで確認しているのは、連続で素早く
        // ドロップされて次のRequestIsDocumentEmptyAsync呼び出しが既に新しいTaskCompletionSource
        // をセットし直している場合に、それを誤って消してしまわないため。
        // (「直前の問い合わせがタイムアウトした直後に次のドロップが発生し、直前の応答が遅れて
        // 届く」ケースは、requestId(_isDocumentEmptyRequestId)の一致判定で弾いているため、
        // 古い応答が次の待機を解決してしまうことはない。)
        if (ReferenceEquals(_isDocumentEmptyCompletionSource, tcs))
        {
            _isDocumentEmptyCompletionSource = null;
        }
        return result;
    }

    /// <summary>src/main.jsのisImageFile(拡張子: png/jpg/jpeg/gif/svg/webp/bmp)と同じ判定を
    /// C#側で行う(ネイティブD&amp;Dはブラウザのdrop eventを経由しないため、JS側のisImageFileを
    /// 呼べない)。2箇所の判定が食い違わないよう、対応関係をこのコメントで明記しておく。</summary>
    private static readonly string[] ImageDropExtensions = { ".png", ".jpg", ".jpeg", ".gif", ".svg", ".webp", ".bmp" };
    private static bool IsImageFileForDrop(string path) =>
        ImageDropExtensions.Contains(Path.GetExtension(path), StringComparer.OrdinalIgnoreCase);

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

    /// <summary>request-textを送った時点の_currentPath。応答(text-response)が届くまでの間に
    /// ユーザーが別ファイルを開くと_currentPathが変わってしまうため、<see cref="WriteAutoSaveSnapshot"/>
    /// 側でこれと応答時点の_currentPathを突き合わせ、一致しなければそのスナップショットを
    /// 別ファイルのものとして破棄する。JS側(dist)は変更できないため、この照合はC#側だけで完結させる。</summary>
    private string? _autoSaveSnapshotRequestPath;

    /// <summary>request-textを送ってから応答を待っている間だけtrue。要求していないのに届いた
    /// text-response(想定外の経路)を誤って書き込まないための保険。</summary>
    private bool _autoSaveSnapshotRequestPending;

    private void RequestAutoSaveSnapshot()
    {
        // タブ形式(仕様書 第2.10節 C-14)。一度でもtabs-changedを受信していれば
        // (=タブ形式で運用中)、全タブぶんまとめて要求する(request-text/text-responseの
        // 単一文書版とは別経路。HandleAllTabsTextResponse参照)。
        // こちらは応答にタブ自身のGuid/pathが含まれる自己完結した経路のため、
        // 単一文書版と違って「要求後に別ファイルを開く」ような取り違えは起こらない。
        if (_tabInfos.Count > 0)
        {
            if (_tabInfos.Any(t => t.Dirty)) PostToWeb(new { type = "request-all-tabs-text" });
            return;
        }
        if (!_isDirty) return;
        // 本文はJS(CodeMirror)側にしかないため、都度取得を依頼する。
        // 頻繁なキー入力のたびには送らず、タイマー間隔(既定30秒)でのみ発生させる。
        // 要求した時点のパスを覚えておく(WriteAutoSaveSnapshot参照)。
        _autoSaveSnapshotRequestPath = _currentPath;
        _autoSaveSnapshotRequestPending = true;
        PostToWeb(new { type = "request-text" });
    }

    private void WriteAutoSaveSnapshot(string text)
    {
        if (!_autoSaveSnapshotRequestPending)
        {
            // 要求していないtext-response(想定外の経路)は対象外。
            return;
        }
        _autoSaveSnapshotRequestPending = false;

        if (!string.Equals(_autoSaveSnapshotRequestPath, _currentPath, StringComparison.OrdinalIgnoreCase))
        {
            // request-textを送ってから応答が届くまでの間に、このウィンドウで別のファイルが
            // 開かれた(OpenFile等で_currentPathが変わった)。そのままWriteSnapshotすると
            // OriginalPath(要求時のパス、または現在のパス)とText(応答時点の本文)が
            // 別ファイルのものとして組み合わさってしまうため、このスナップショットは書き込まず
            // 破棄する。次回のタイマー間隔で改めて(今開いているファイルに対して)要求し直される。
            Logger.Write(
                $"WriteAutoSaveSnapshot: 要求時と応答時でパスが一致しないため破棄 " +
                $"(要求時={_autoSaveSnapshotRequestPath ?? "(無題)"}, 応答時={_currentPath ?? "(無題)"})");
            return;
        }

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
            string fullPath = Path.GetFullPath(path);
            string? dir = Path.GetDirectoryName(fullPath);
            if (dir is null) return;

            // (A) 自分自身のログファイル(%LOCALAPPDATA%\Pane\logs\pane-yyyyMMdd.log)を開くと、
            // Paneが動作中ずっとそこへ書き込み続けるため、外部変更検知が絶えず発火し、
            // ダイアログの表示・非表示自体がForm.Activated経由でさらにログへ書き込まれる
            // 自己駆動ループに陥る不具合があった。これを断つため、開こうとしているファイルが
            // 自分のログディレクトリ配下であれば、そもそも監視を張らない。
            // 判定は単純な文字列の前方一致ではなく、Path.GetFullPathで正規化してから行う
            // (相対パス中の".."や大文字小文字の違いで判定をすり抜けないようにするため)。
            // Windowsのパスは大文字小文字を区別しないためOrdinalIgnoreCaseで比較する。
            // なお、シンボリックリンク/ジャンクション経由で結果的に同じ場所を指す場合までは
            // ここでは検出できない(実体パスの解決までは行っていない)。そこは完全には防げない
            // 前提とし、その保険として_suppressedExternalChangePath(「いいえ」選択後の抑止)を
            // 別途用意している。
            string logDirFull = Path.GetFullPath(Logger.DirectoryPath);
            string logDirPrefix = logDirFull.EndsWith(Path.DirectorySeparatorChar)
                ? logDirFull
                : logDirFull + Path.DirectorySeparatorChar;
            if (fullPath.StartsWith(logDirPrefix, StringComparison.OrdinalIgnoreCase))
            {
                // なぜ監視されていないのかを後から追えるように1行残す。
                Logger.Write($"StartWatching: ログディレクトリ配下のため外部変更監視を張らない ({fullPath})");
                return;
            }

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
        finally
        {
            // StartWatchingは「監視対象が変わった(=このファイルを保存した、または別のファイルを
            // 開いた)」ときにのみ呼ばれるため、(B)の抑止(_suppressedExternalChangePath)を
            // 解除するタイミングとちょうど一致する。監視を張れたかどうかに関わらず解除する。
            ClearSuppressedExternalChangePath();
        }
    }

    private void StopWatching()
    {
        _watcher?.Dispose();
        _watcher = null;
        // StartWatchingと同じ理由で、監視を止める(=文書がなくなった等)タイミングでも解除する。
        ClearSuppressedExternalChangePath();
    }

    /// <summary>(B) 外部変更ダイアログの「いいえ」による抑止を解除する。値が変わる場合のみ
    /// タイトルを更新する(無駄な再描画を避ける)。</summary>
    private void ClearSuppressedExternalChangePath()
    {
        if (_suppressedExternalChangePath is null) return;
        _suppressedExternalChangePath = null;
        UpdateTitle();
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
        // FileSystemWatcherのイベントはワーカースレッド発火であり、Formを閉じた直後
        // (_watcher.Dispose()が呼ばれた直後)に飛んでくることがある。IsDisposedを見ずに
        // BeginInvokeすると、破棄済みのコントロールに対する呼び出しで例外になりうるため、
        // 先に確認してから触る(不具合修正。それでも確認直後に閉じられるレースは残るため、
        // 呼び出し先のOnExternalChangeDebounceElapsed側でも安全に倒す)。
        if (IsDisposed || !IsHandleCreated) return;

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
        if (IsDisposed) return; // Form破棄後にTickが走った場合の保険(FormClosedで基本は止めているが念のため)
        _externalChangeDebounceTimer.Stop();
        if (!_externalChangePending || _currentPath is null) return;
        _externalChangePending = false;

        // (B) 前回このファイルで「いいえ」を選んでいれば、次に自分が保存する/別のファイルを
        // 開くまで(_suppressedExternalChangePathの解除はStartWatching/StopWatching参照)、
        // 再度ダイアログを出さない。(A)(StartWatchingでのログディレクトリ除外)をすり抜ける
        // 経路(別の場所へコピーしたログ、他アプリが高頻度で書き換えるファイル一般)への保険。
        if (_suppressedExternalChangePath is not null
            && string.Equals(_currentPath, _suppressedExternalChangePath, StringComparison.OrdinalIgnoreCase))
        {
            Logger.Write($"OnExternalChangeDebounceElapsed: 前回「いいえ」を選択済みのため再表示を抑止 ({_currentPath})");
            return;
        }

        string unsavedWarning = _isDirty
            ? "\n(このウィンドウには未保存の変更があります。再読み込みすると失われます。)"
            : string.Empty;

        // 「はい」は現在の編集内容をディスクの内容で上書きする(未保存の変更があれば失われる)ため、
        // データが失われうる確認としてキャンセル相当側(「いいえ」)を既定にする
        // (src/dialog.jsのdanger:trueと揃えた方針。詳細はPaneDialog.ShowのdefaultToCancel引数を参照)。
        DialogResult choice = PaneDialog.Show(
            this,
            $"このファイルは他のアプリケーションによって変更されました。再読み込みしますか?{unsavedWarning}",
            "Pane",
            MessageBoxButtons.YesNo,
            MessageBoxIcon.Warning,
            defaultToCancel: true);

        if (choice == DialogResult.Yes)
        {
            // 読み込み直した後の変更は改めて知らせるべきなので、抑止はしない
            // (以前「いいえ」で抑止していた場合でもOpenFile→StartWatchingで解除される)。
            OpenFile(_currentPath);
        }
        else
        {
            // (B) このファイルについては、次に自分が保存する/別のファイルを開くまで
            // 再度ダイアログを出さない(仕様書どおり、無断で上書き・自動再読み込みはしない)。
            _suppressedExternalChangePath = _currentPath;
            UpdateTitle();
        }
    }

    // ---- 設定(仕様書 N-07・N-09、Phase 3時点は最小ダイアログ) ----

    private void ShowSettingsDialog()
    {
        // dialogはユーザー操作待ちで開いたままモーダルになるため、ここで読み込んだinitialは
        // 非常に長い間古いスナップショットのままになりうる(Lost Updateの原因)。そのため
        // initialは「ダイアログの初期表示」と「ユーザーが何を変更したか(トグルの前後比較)」の
        // 判定にのみ使い、実際にディスクへ書き込む段(SettingsService.Update)では最新の設定を
        // 読み直し、このダイアログが変更した項目だけをそこへ適用する
        // (PaneApplicationContext.OnWindowClosedと同じ考え方)。
        AppSettings initial = SettingsService.Load();
        using var dialog = new SettingsForm(initial);
        if (dialog.ShowDialog(this) != DialogResult.OK) return;

        string? errorMessage = null;
        SettingsService.Update(settings =>
        {
            bool wantsAssociation = dialog.FileAssociationEnabled;
            if (wantsAssociation != initial.FileAssociationEnabled)
            {
                try
                {
                    // WinForms版の設定画面(SettingsForm)はON/OFFの単一チェックボックスしか持たず、
                    // 拡張子ごとの選択肢はまだ無いため、有効化時は従来どおり .md/.markdown/.mdown の
                    // 3つを対象にする(任意拡張子の選択は後続のHTML製設定画面(B節)で行う)。
                    // 解除対象(previous)は最新の設定(settings)から求める。initialのAssociatedExtensions
                    // は古いスナップショットのため、これを使うとダイアログを開いている間に他所で
                    // 変わった関連付けを正しく解除できない場合がある。
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
                    errorMessage = $"ファイルの関連付け設定を変更できませんでした。\n{ex.Message}";
                }
            }

            bool wantsPreload = dialog.PreloadOnStartup;
            if (wantsPreload != initial.PreloadOnStartup)
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
                    string msg = $"スタートアップ登録を変更できませんでした。\n{ex.Message}";
                    errorMessage = errorMessage is null ? msg : $"{errorMessage}\n{msg}";
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
        });

        if (errorMessage is not null)
        {
            PaneDialog.Show(this, errorMessage, "Pane", MessageBoxButtons.OK, MessageBoxIcon.Error);
        }

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
    /// <summary>
    /// 起動時の更新確認(仕様書 U-06)で新しい版が見つかったことを画面へ知らせる。
    /// 受け取ったJS側は画面上部の帯に案内を出すだけで、勝手に更新は始めない。
    /// </summary>
    internal void PostUpdateAvailable(string latestVersion, string message)
        => PostToWeb(new { type = "update-available", latestVersion, message });

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
            sidebarWidthPx = settings.SidebarWidthPx,
            zoomWithCtrlWheel = settings.ZoomWithCtrlWheel,
            tooltipDetail = settings.TooltipDetail,
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
            codeFoldingEnabled = settings.CodeFoldingEnabled,
            codeIndentGuides = settings.CodeIndentGuides,
            codeAutoWrap = settings.CodeAutoWrap,
            codeActiveLineHighlight = settings.CodeActiveLineHighlight,
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
            colorPreviewInCode = settings.ColorPreviewInCode,
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
            editorPaddingLeft = settings.GetEffectiveEditorPaddingLeft(),
            editorPaddingRight = settings.GetEffectiveEditorPaddingRight(),
            showWordCount = settings.ShowWordCount,

            // ---- キーボード ----
            keyBindings = settings.KeyBindings,

            // ---- 詳細(サイドバーのファイルツリー表示に関わる部分のみ。enableDebugはC#専用のため含めない) ----
            showHiddenFilesInTree = settings.ShowHiddenFilesInTree,
            fileTreePatterns = settings.FileTreePatterns,
        });

        // showHiddenFilesInTree/fileTreePatterns(隠しファイル表示・除外パターン)は走査結果自体に
        // 影響するため、apply-settingsを送るだけでは反映されない。読み込み済みのフォルダがあれば
        // ここで再走査させ、設定画面で切り替えた結果がすぐツリーに反映されるようにする。
        ReloadLoadedFolderIfAny();
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

        // Lost Update対策(SettingsService.Update参照)。ここは「最新のPerFileModesに対して
        // 1件だけ挿入/更新/削除する」差分操作のため、Update経由にするだけで安全になる。
        SettingsService.Update(settings => settings.PerFileModes = UpdatePerFileModes(settings.PerFileModes, path, mode));
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
        // Lost Update対策(SettingsService.Update参照)。
        SettingsService.Update(settings => settings.Theme = theme);
    }

    /// <summary>本文の文字サイズ(Ctrl+マウスホイールでの変更)を永続化する。</summary>
    private static void SaveFontSize(int size)
    {
        if (size < 8 || size > 40) return; // JS側(editor.js)と同じ範囲。想定外の値は無視する
        // Lost Update対策(SettingsService.Update参照)。
        SettingsService.Update(settings => settings.EditorFontSize = size);
    }

    /// <summary>サイドバー幅のドラッグリサイズ(ユーザー要望2)を永続化する。
    /// 範囲外の値はAppSettings.SidebarWidthPxのsetterがクランプするため、ここでは
    /// そのまま渡すだけでよい(SaveFontSizeのように呼び出し前で弾く必要はない)。</summary>
    private static void SaveSidebarWidth(int width)
    {
        // Lost Update対策(SettingsService.Update参照)。
        SettingsService.Update(settings => settings.SidebarWidthPx = width);
    }

    /// <summary>最近使ったファイル一覧(仕様書 F-09)を更新する。先頭が最新、重複除去、最大10件。
    /// recordRecentFilesがfalseの場合は記録しない。</summary>
    private static void AddRecentFile(string path)
    {
        // ファイルを開くたびに呼ばれる経路。複数ウィンドウで同時にファイルを開いたり、
        // 設定画面での保存と重なったりすると容易に競合するため、Lost Update対策として
        // 必ずSettingsService.Update経由にする(最新のRecentFilesに対して差分操作するだけで、
        // このメソッドが呼ばれた時点のsettings丸ごとを書き戻さない)。
        SettingsService.Update(settings =>
        {
            if (!settings.RecordRecentFiles) return;
            settings.RecentFiles.RemoveAll(p => string.Equals(p, path, StringComparison.OrdinalIgnoreCase));
            settings.RecentFiles.Insert(0, path);
            if (settings.RecentFiles.Count > 10)
            {
                settings.RecentFiles.RemoveRange(10, settings.RecentFiles.Count - 10);
            }
        });
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

    // ---- 印刷(仕様書 File項目「印刷」)。WebView2既定の印刷ダイアログを開く。
    //
    // 設計判断(なぜ詳細設定が反映されないか): ShowPrintUI()は「印刷ダイアログを表示する」だけの
    // メソッドで、CoreWebView2PrintSettingsを渡す引数が無い(これは事実。用紙サイズ・余白・
    // ヘッダー/フッター等の既定値を事前設定する手段がこのAPIには存在しない)。
    // 一方でCoreWebView2.PrintAsync(CoreWebView2PrintSettings)は存在し(SDK 1.0.1518.46以降。
    // Paneが参照する1.0.2903.40で利用可能)、公式にも「Print the current web page asynchronously
    // to the specified printer with the provided settings」と記載されているとおり、設定を反映した
    // 印刷自体は技術的に可能である。ただしPrintAsyncは印刷ダイアログを一切出さず、プリンタ名も
    // 設定側で指定する必要があるため、採用するならプリンタ選択UI(既定プリンタの列挙・選択・
    // 部数指定等)をPane側で自前に用意しなければならない。現状はそこまで作らず、ユーザーが
    // 慣れているOS/ブラウザの印刷ダイアログをそのまま出すShowPrintUIを採用している。
    // その結果として、docs/設定項目一覧.md「エクスポート・印刷」節の詳細設定はPDFエクスポート
    // (HandleExportRequestAsync、PrintToPdfAsync(path, printSettings))にのみ適用され、この
    // 「印刷」コマンド(Ctrl+Alt+P・File>印刷)には適用されない。印刷ダイアログ上でユーザー自身が
    // 設定し直す前提。 ----
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

    /// <summary>1インチ=25.4mm。CoreWebView2PrintSettingsの寸法・余白はすべてインチ単位のため、
    /// 設定(mm単位)からの変換に使う。</summary>
    private const double MmPerInch = 25.4;

    // ---- エクスポート(仕様書「エクスポート・印刷」節)。PDFはWebView2のネイティブ機能(用紙サイズ・
    // 余白・ヘッダー/フッターをCoreWebView2PrintSettings+CSSで反映)、HTMLはJS側で組み立て済みの
    // HTML文字列をそのまま保存、Word/EPUBはPandocに委譲する。
    // PDFはJS側が"export"送信前にメニューバー等を隠し文書全体をレイアウトへ展開している
    // (enterExportLayout)ため、このメソッドを抜ける経路(保存キャンセルを含む)すべてで
    // 必ず"export-done"を返し、JS側の表示を元に戻せるようにする。 ----
    private async Task HandleExportRequestAsync(JsonElement message)
    {
        TryGetString(message, "format", out string format);
        TryGetString(message, "text", out string text);
        JsonElement pageOptions = message.TryGetProperty("pageOptions", out JsonElement poProp) && poProp.ValueKind == JsonValueKind.Object
            ? poProp
            : default;
        string baseName = _currentPath is null ? "無題" : Path.GetFileNameWithoutExtension(_currentPath);

        (string filter, string ext) = format switch
        {
            "pdf" => ("PDF (*.pdf)|*.pdf", ".pdf"),
            "html" or "html-plain" => ("HTML (*.html)|*.html", ".html"),
            "docx" => ("Word文書 (*.docx)|*.docx", ".docx"),
            "epub" => ("EPUB (*.epub)|*.epub", ".epub"),
            // 仕様書 第2.11節 X-05「Word / RTF / LaTeX / EPUB / Textile 等」。docx/epubと同じく
            // Pandocに委譲する(出力形式はtargetPathの拡張子からPandocが自動判別する)。
            "rtf" => ("リッチテキスト (*.rtf)|*.rtf", ".rtf"),
            "latex" => ("LaTeX (*.tex)|*.tex", ".tex"),
            "textile" => ("Textile (*.textile)|*.textile", ".textile"),
            _ => ("すべてのファイル (*.*)|*.*", ""),
        };
        string? targetPath = null;
        try
        {
            // exportShowSaveDialog(既定true): falseならダイアログを出さずexportDefaultFolder/
            // exportCustomFolderの場所へ直接書き出す。
            targetPath = ResolveExportTargetPath(filter, baseName, ext, pageOptions);
            if (targetPath is null) return; // ダイアログでキャンセルされた

            switch (format)
            {
                case "pdf":
                    // ヘッダー・フッター(仕様書 exportHeaderText/exportFooterText、{page}/{pages}を含む)は
                    // CoreWebView2PrintSettings.ShouldPrintHeaderAndFooter(HeaderTitle/FooterUri)では
                    // 日時・タイトル・URL・ページ番号という固定書式しか出せず、置換文字列を自由な位置に
                    // 差し込めないため使わない。代わりにCSSの @page 内マージンボックス(@top-center等)へ
                    // counter(page)/counter(pages)を使って差し込む(印刷対象はライブプレビューのDOMその
                    // ものなので、印刷直前にスタイルを注入する)。
                    await InjectPrintHeaderFooterCssAsync(pageOptions);
                    CoreWebView2PrintSettings printSettings = BuildPrintSettings(pageOptions);
                    await _webView.CoreWebView2.PrintToPdfAsync(targetPath, printSettings);
                    break;
                case "html":
                case "html-plain":
                    await File.WriteAllTextAsync(targetPath, text, new UTF8Encoding(false));
                    break;
                case "docx":
                case "epub":
                case "rtf":
                case "latex":
                case "textile":
                    await ExportViaPandocAsync(text, targetPath);
                    break;
            }

            // exportAfter(仕様書、既定none): 書き出し後にファイル/フォルダを開く。
            string exportAfter = GetStringProp(pageOptions, "exportAfter", "none");
            ApplyExportAfter(exportAfter, targetPath);
        }
        catch (Exception ex)
        {
            Logger.WriteException($"エクスポートに失敗: format={format}, targetPath={targetPath}", ex);
            PaneDialog.Show(this, $"エクスポートに失敗しました。\n{ex.Message}", "Pane", MessageBoxButtons.OK, MessageBoxIcon.Error);
        }
        finally
        {
            PostToWeb(new { type = "export-done" });
        }
    }

    /// <summary>
    /// エクスポート先のファイルパスを決める。exportShowSaveDialogがtrue(既定)ならダイアログを表示し
    /// (初期フォルダはexportDefaultFolder/exportCustomFolderから)、falseならダイアログを出さず
    /// その場所へ直接書き出す(ファイル名は文書名のまま。既存ファイルは上書きする)。
    /// ダイアログでキャンセルされた場合のみnullを返す。
    /// </summary>
    private string? ResolveExportTargetPath(string filter, string baseName, string ext, JsonElement pageOptions)
    {
        string defaultFolder = GetStringProp(pageOptions, "exportDefaultFolder", "sameAsFile");
        string customFolder = GetStringProp(pageOptions, "exportCustomFolder", "");
        string suggestedDir = ResolveExportFolder(defaultFolder, customFolder);

        bool showDialog = !(pageOptions.ValueKind == JsonValueKind.Object &&
            pageOptions.TryGetProperty("exportShowSaveDialog", out JsonElement sd) && sd.ValueKind == JsonValueKind.False);
        if (!showDialog)
        {
            try
            {
                Directory.CreateDirectory(suggestedDir);
            }
            catch (Exception ex)
            {
                Logger.WriteException($"エクスポート先フォルダを作成できませんでした: {suggestedDir}", ex);
            }
            return Path.Combine(suggestedDir, baseName + ext);
        }

        using var dialog = new SaveFileDialog { Filter = filter, FileName = baseName + ext };
        if (Directory.Exists(suggestedDir)) dialog.InitialDirectory = suggestedDir;
        return dialog.ShowDialog(this) == DialogResult.OK ? dialog.FileName : null;
    }

    /// <summary>exportDefaultFolder("sameAsFile"|"custom")とexportCustomFolderから実フォルダを求める。
    /// "custom"かつ相対パス(`./` `../` 等)のときは編集中ファイルのフォルダ基準にする
    /// (仕様書ではexportCustomFolderの相対パス記法は明記されていないが、imageCustomFolderと
    /// 同じ流儀に揃える)。編集中ファイルが未保存の場合はドキュメントフォルダへフォールバックする。</summary>
    private string ResolveExportFolder(string defaultFolder, string customFolder)
    {
        string fallback = _currentPath is not null
            ? Path.GetDirectoryName(Path.GetFullPath(_currentPath))!
            : Environment.GetFolderPath(Environment.SpecialFolder.MyDocuments);
        if (defaultFolder != "custom" || string.IsNullOrWhiteSpace(customFolder)) return fallback;
        return Path.IsPathRooted(customFolder)
            ? Path.GetFullPath(customFolder)
            : Path.GetFullPath(Path.Combine(fallback, customFolder));
    }

    /// <summary>exportAfter(仕様書、既定none)を実行する。失敗はベストエフォート(ログのみ)。</summary>
    private static void ApplyExportAfter(string exportAfter, string targetPath)
    {
        try
        {
            switch (exportAfter)
            {
                case "openFile":
                    using (Process.Start(new ProcessStartInfo(targetPath) { UseShellExecute = true })) { }
                    break;
                case "openFolder":
                    using (Process.Start(new ProcessStartInfo("explorer.exe", $"/select,\"{targetPath}\"") { UseShellExecute = true })) { }
                    break;
            }
        }
        catch (Exception ex)
        {
            Logger.WriteException($"exportAfter({exportAfter})の実行に失敗: {targetPath}", ex);
        }
    }

    /// <summary>
    /// pageOptions(JS側main.jsのbuildExportPageOptions)から用紙サイズ・向き・余白を反映した
    /// CoreWebView2PrintSettingsを作る(仕様書 exportPaperSize/exportOrientation/exportMargin*Mm)。
    /// 用紙サイズはCoreWebView2PrintMediaSizeに列挙値が無い(Default/Customのみ)ため、
    /// 既知サイズもすべてCustom+PageWidth/PageHeight(インチ)で表現する。
    /// </summary>
    private CoreWebView2PrintSettings BuildPrintSettings(JsonElement pageOptions)
    {
        CoreWebView2PrintSettings settings = _webView.CoreWebView2.Environment.CreatePrintSettings();

        string paperSize = GetStringProp(pageOptions, "paperSize", "a4");
        string orientation = GetStringProp(pageOptions, "orientation", "portrait");
        double customWidthMm = GetDoubleProp(pageOptions, "customWidthMm", 210);
        double customHeightMm = GetDoubleProp(pageOptions, "customHeightMm", 297);

        // 既知の用紙サイズ(mm、常に縦長=ポートレート基準で持つ)。B5は日本語圏向けアプリのため
        // JIS B5(182×257mm)を採用する(ISO B5=176×250mmとは異なるので注意)。
        (double widthMm, double heightMm) = paperSize switch
        {
            "a4" => (210.0, 297.0),
            "a3" => (297.0, 420.0),
            "b5" => (182.0, 257.0),
            "letter" => (215.9, 279.4),
            "legal" => (215.9, 355.6),
            "tabloid" => (279.4, 431.8),
            "custom" => (customWidthMm > 0 ? customWidthMm : 210, customHeightMm > 0 ? customHeightMm : 297),
            _ => (210.0, 297.0),
        };
        bool landscape = orientation == "landscape";
        if (landscape && widthMm < heightMm) (widthMm, heightMm) = (heightMm, widthMm);

        settings.MediaSize = CoreWebView2PrintMediaSize.Custom;
        settings.PageWidth = widthMm / MmPerInch;
        settings.PageHeight = heightMm / MmPerInch;
        settings.Orientation = landscape ? CoreWebView2PrintOrientation.Landscape : CoreWebView2PrintOrientation.Portrait;

        settings.MarginTop = GetDoubleProp(pageOptions, "marginTopMm", 20) / MmPerInch;
        settings.MarginBottom = GetDoubleProp(pageOptions, "marginBottomMm", 20) / MmPerInch;
        settings.MarginLeft = GetDoubleProp(pageOptions, "marginLeftMm", 20) / MmPerInch;
        settings.MarginRight = GetDoubleProp(pageOptions, "marginRightMm", 20) / MmPerInch;

        settings.ShouldPrintBackgrounds = true; // テーマの配色を含めて出力する(既定falseだと背景が抜ける)
        // ヘッダー・フッターはCSS側(InjectPrintHeaderFooterCssAsync)で実現するため、WebView2ネイティブの
        // 固定書式(ShouldPrintHeaderAndFooter)は使わない。
        settings.ShouldPrintHeaderAndFooter = false;

        return settings;
    }

    /// <summary>
    /// ヘッダー・フッター(仕様書 exportHeaderText/exportFooterText)をCSSの @page 内マージンボックス
    /// (@top-center/@bottom-center)へ注入する。{page}/{pages}はJS側で展開されずそのまま届くため、
    /// ここでCSSの counter(page)/counter(pages) に変換する(ページ番号・総数は印刷処理そのものが
    /// 進むまで確定しないため、JS側では展開できない)。
    ///
    /// 注意(報告に明記): @page マージンボックス(@top-center等)は比較的新しいCSS Paged Media機能で、
    /// 対応していないバージョンのChromium(WebView2ランタイム)では単に無視され、ヘッダー・フッターが
    /// 出ないだけで他の項目(用紙サイズ・余白等)には影響しない。この環境(Linux)ではWebView2を実行
    /// できないため実機での表示確認はできておらず、コードレビューでの自己確認に留まる。
    /// </summary>
    private async Task InjectPrintHeaderFooterCssAsync(JsonElement pageOptions)
    {
        string headerTemplate = GetStringProp(pageOptions, "headerTemplate", "");
        string footerTemplate = GetStringProp(pageOptions, "footerTemplate", "");
        if (headerTemplate.Length == 0 && footerTemplate.Length == 0)
        {
            // 空にする(前回の印刷で入った内容が残らないようにする)
            headerTemplate = "";
            footerTemplate = "";
        }

        string css = $"@page {{ @top-center {{ content: {BuildPageContentCss(headerTemplate)}; font-size: 9px; }} " +
            $"@bottom-center {{ content: {BuildPageContentCss(footerTemplate)}; font-size: 9px; }} }}";
        string js = "(function(){" +
            "var id='pane-print-header-footer-style';" +
            "var el=document.getElementById(id);" +
            "if(!el){el=document.createElement('style');el.id=id;document.head.appendChild(el);}" +
            $"el.textContent={JsonSerializer.Serialize(css)};" +
            "})();";
        try
        {
            await _webView.CoreWebView2.ExecuteScriptAsync(js);
        }
        catch (Exception ex)
        {
            Logger.WriteException("印刷用ヘッダー/フッターCSSの注入に失敗", ex);
        }
    }

    /// <summary>テンプレート文字列を、"{page}"/"{pages}"を境にCSSの content プロパティ用の値へ変換する。
    /// 例: "p.{page}/{pages}" → "\"p.\" counter(page) \"/\" counter(pages)"</summary>
    private static string BuildPageContentCss(string template)
    {
        if (string.IsNullOrEmpty(template)) return "\"\"";
        var parts = new List<string>();
        int last = 0;
        int i = 0;
        while (i < template.Length)
        {
            if (template.AsSpan(i).StartsWith("{page}"))
            {
                if (i > last) parts.Add(CssString(template[last..i]));
                parts.Add("counter(page)");
                i += "{page}".Length;
                last = i;
            }
            else if (template.AsSpan(i).StartsWith("{pages}"))
            {
                if (i > last) parts.Add(CssString(template[last..i]));
                parts.Add("counter(pages)");
                i += "{pages}".Length;
                last = i;
            }
            else
            {
                i++;
            }
        }
        if (last < template.Length) parts.Add(CssString(template[last..]));
        return parts.Count == 0 ? "\"\"" : string.Join(" ", parts);
    }

    private static string CssString(string s) => "\"" + s.Replace("\\", "\\\\").Replace("\"", "\\\"") + "\"";

    private static string GetStringProp(JsonElement obj, string name, string fallback) =>
        obj.ValueKind == JsonValueKind.Object && obj.TryGetProperty(name, out JsonElement p) && p.ValueKind == JsonValueKind.String
            ? p.GetString() ?? fallback
            : fallback;

    private static double GetDoubleProp(JsonElement obj, string name, double fallback) =>
        obj.ValueKind == JsonValueKind.Object && obj.TryGetProperty(name, out JsonElement p) && p.ValueKind == JsonValueKind.Number
            ? p.GetDouble()
            : fallback;

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

    // ---- 画像挿入(仕様書 docs/設定項目一覧.md「画像」節)。実体はImageInsertServiceに委譲する。
    // メニューの「画像を挿入」(ファイルダイアログ、実パスあり)・本文へのドラッグ&ドロップ
    // (OnDragDrop、不具合修正後は実パスあり)・クリップボードからの貼り付け(JS側で
    // バイト列化されたもの、実パス無し)の3経路がある。 ----
    private void HandleInsertImageRequest(JsonElement message)
    {
        string? sourcePath = null;
        byte[]? bytes = null;
        string suggestedName = "image.png";

        if (message.TryGetProperty("dataBase64", out JsonElement dataProp) && dataProp.ValueKind == JsonValueKind.String)
        {
            // クリップボード貼り付け(src/main.jsのinsertImageFile経由)。ブリッジの無い
            // ブラウザ単体動作時のD&D(main.jsのdropハンドラ、フォールバック経路)もここを通る。
            // WebView2の標準DOM File APIでは実パスが取れないため、常にバイト列で届く。
            // dataBase64はJS側からの外部入力であり、壊れたBase64だとFormatExceptionが飛ぶ。
            // 従来はこの呼び出しが下のtryブロックの外にあり、例外がOnWebMessageReceivedの
            // 外まで伝播してアプリ全体が落ちる不具合があったため、ここで確実に受け止める。
            try
            {
                bytes = Convert.FromBase64String(dataProp.GetString() ?? "");
            }
            catch (FormatException ex)
            {
                Logger.WriteException("画像挿入: dataBase64が不正なBase64だった", ex);
                PostToWeb(new { type = "insert-image-error", error = "画像データを読み取れませんでした。" });
                PaneDialog.Show(this, "画像データを読み取れませんでした。", "Pane", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                return;
            }
            if (TryGetString(message, "name", out string n) && n.Length > 0)
            {
                suggestedName = n;
            }
        }
        else
        {
            // メニュー「画像を挿入」: ファイル選択ダイアログで実パスを得る。
            using var dialog = new OpenFileDialog
            {
                Filter = "画像ファイル (*.png;*.jpg;*.jpeg;*.gif;*.svg;*.webp)|*.png;*.jpg;*.jpeg;*.gif;*.svg;*.webp",
            };
            if (dialog.ShowDialog(this) != DialogResult.OK) return;
            sourcePath = dialog.FileName;
            suggestedName = Path.GetFileName(sourcePath);
        }

        InsertLocalImageAndNotify(sourcePath, bytes, suggestedName);
    }

    /// <summary>
    /// 画像挿入の実処理(ImageInsertService呼び出し・成否のJS側への通知)を、呼び出し元3経路
    /// (メニューのファイル選択ダイアログ・クリップボード貼り付け・OnDragDropのD&amp;D)で共有する。
    /// sourcePath(実パス、D&amp;D・ファイルダイアログ経由)とbytes(バイト列、クリップボード・
    /// ブラウザ単体動作のD&amp;D経由)はどちらか一方だけが非nullになる想定
    /// (ImageInsertService.InsertLocalImage参照)。
    /// </summary>
    private void InsertLocalImageAndNotify(string? sourcePath, byte[]? bytes, string suggestedName)
    {
        AppSettings settings = SettingsService.Load();
        try
        {
            ImageInsertService.InsertResult result = ImageInsertService.InsertLocalImage(
                sourcePath, bytes, suggestedName, settings, _currentPath,
                log: reason => Logger.Write($"画像挿入: {reason}"));

            if (!result.Ok)
            {
                PaneDialog.Show(this, result.ErrorMessage, "Pane", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                return;
            }

            Logger.Write($"画像挿入完了: path={result.MarkdownPath}");
            PostToWeb(new
            {
                type = "image-inserted",
                alt = Path.GetFileNameWithoutExtension(suggestedName),
                path = result.MarkdownPath,
            });
        }
        catch (Exception ex)
        {
            Logger.WriteException("画像挿入に失敗", ex);
            PaneDialog.Show(this, $"画像を挿入できませんでした。\n{ex.Message}", "Pane", MessageBoxButtons.OK, MessageBoxIcon.Error);
        }
    }
}
