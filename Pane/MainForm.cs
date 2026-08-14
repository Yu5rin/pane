using System.Diagnostics;
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
        // カスタムCSSの参考サンプルを既定フォルダへ用意しておく(無ければ作るだけで、
        // 既にあれば何もしない。ThemeFolderService.EnsureSampleCss参照)。
        ThemeFolderService.EnsureSampleCss();

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
            // タイマーの停止漏れ対策(不具合修正)。従来は_autoSaveTimerのStopのみで、
            // _externalChangeDebounceTimerはStop/Disposeともに行っていなかった。
            // 閉じた直後にTickが走ると、破棄済みのFormに対してOnExternalChangeDebounceElapsedから
            // PaneDialog.Show(this, ...)を呼ぶ経路が残ってしまう。また、どちらのTimerも
            // コンポーネントコレクションに登録していないためForm.Dispose()では解放されず、
            // ここで明示的にDisposeしておく必要がある。
            _autoSaveTimer.Stop();
            _autoSaveTimer.Dispose();
            _externalChangeDebounceTimer.Stop();
            _externalChangeDebounceTimer.Dispose();
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
    /// 起動時の白フラッシュ対策(実機不具合の修正)。保存されているテーマ設定に応じて、
    /// WebView2がHTML/CSSを読み込み終える前に見えうる2つの背景(WinFormsコントロール自体の
    /// BackColorと、CoreWebView2ControllerのDefaultBackgroundColor)を先に塗っておく。
    /// 色はsrc/style.cssの:root(ライト既定)・html[data-theme="dark"]それぞれの--paperと
    /// 揃える(CSSファイル自体を読めないのでここでは値を決め打ちにする。style.cssには
    /// 同じセレクタ(:root / html[data-theme="dark"])のブロックが複数あり、後方のブロックが
    /// カスケードで--paperを上書きしているため、値は実際にブラウザで解決される最終値
    /// (Playwrightでcomputed styleを実測して確認済み)を使うこと。既定テーマの色が
    /// style.css側で変わった場合はここも合わせて直すこと。テーマプリセット(lightTheme/
    /// darkTheme)による上書きまでは反映していない(近似値で十分なため)。
    /// </summary>
    private void ApplyInitialWebViewBackground()
    {
        AppSettings settings = SettingsService.Load();
        bool isDark = ResolveIsDarkTheme(settings.Theme);
        Color background = isDark
            ? Color.FromArgb(0x14, 0x17, 0x1A) // src/style.css: html[data-theme="dark"] --paper(最終値)
            : Color.FromArgb(0xFB, 0xFB, 0xFA); // src/style.css: :root --paper(最終値)
        BackColor = background;
        _webView.DefaultBackgroundColor = background;
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
        // ブラウザ既定の右クリックメニューを一切表示しない(docs/コンテキストメニュー仕様.md
        // 大原則1)。代わりにJS側(src/main.js)が独自メニューを組み立て、"open-context-menu"で
        // ネイティブポップアップ(Pane/NativeMenu.cs)を表示させる(HandleOpenContextMenuRequest参照)。
        _webView.CoreWebView2.Settings.AreDefaultContextMenusEnabled = false;
        _webView.CoreWebView2.WebMessageReceived += OnWebMessageReceived;

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
            case "open-dropped-file":
                HandleOpenDroppedFile(root);
                break;
            case "log":
                // JS側の不具合調査ログ(main.jsのlogToHost)をC#側と同じログファイルへ集約する。
                string level = TryGetString(root, "level", out string levelValue) ? levelValue : "log";
                TryGetString(root, "message", out string logMessage);
                Logger.Write($"[JS:{level}] {logMessage}");
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
                Logger.Write($"titlebar-color受信: background={titlebarBackground ?? "(なし)"}, foreground={titlebarForeground ?? "(なし)"}");
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

        bool isDark = ResolveIsDarkTheme(SettingsService.Load().Theme);
        NativeMenu.Show(
            screenPoint,
            isDark,
            items,
            onCommand: id => PostToWeb(new { type = "menu-command", id }),
            onClosed: () => PostToWeb(new { type = "menu-closed", menu = menuName }));
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

        bool isDark = ResolveIsDarkTheme(SettingsService.Load().Theme);
        NativeMenu.Show(
            screenPoint,
            isDark,
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
    /// WebView2の本文エリア(Webページ側)へドラッグ&ドロップされたファイルを開く。
    /// 現在の本文が空(失われる内容が無い)ならこのウィンドウで、何か書かれていれば
    /// 新しいウィンドウで開く(空かどうかの判定はJS側が行い、newWindowで伝えてくる)。
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
        Text = $"{readOnlyMark}{name}{dirtyMark} - Pane";
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
            // タブ形式(仕様書 第2.10節 C-14、隠し設定)のときは、現在の文書を保存確認なしに
            // 置き換えず、新しいタブとして開く。
            if (SettingsService.Load().DisplayMode == "tab")
            {
                OpenInNewTab(paths[0]);
                return;
            }
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
            OpenFile(_currentPath);
        }
        // いいえの場合は現在の編集内容を保持したまま、次の変更検知まで何もしない
        // (仕様書どおり、無断で上書き・自動再読み込みはしない)。
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
            editorPaddingX = settings.EditorPaddingX,
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
    // 制約(WebView2のAPIで実現できない項目): ShowPrintUI()は「印刷ダイアログを表示する」だけの
    // メソッドで、CoreWebView2PrintSettingsを渡す引数が無い(用紙サイズ・余白・ヘッダー/フッター
    // 等の既定値を事前設定する手段がAPI上に存在しない)。設定を確実に反映できるのは
    // PrintToPdfAsync(path, printSettings)のみのため、docs/設定項目一覧.md「エクスポート・印刷」節の
    // 詳細設定はPDFエクスポート(HandleExportRequestAsync)にのみ適用し、この「印刷」コマンド
    // (Ctrl+Alt+P・File>印刷)には適用しない。印刷ダイアログ上でユーザー自身が設定し直す前提。 ----
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
    // メニューの「画像を挿入」(ファイルダイアログ、実パスあり)と、本文へのドラッグ&ドロップ・
    // クリップボードからの貼り付け(JS側でバイト列化されたもの、実パス無し)の2経路がある。 ----
    private void HandleInsertImageRequest(JsonElement message)
    {
        string? sourcePath = null;
        byte[]? bytes = null;
        string suggestedName = "image.png";

        if (message.TryGetProperty("dataBase64", out JsonElement dataProp) && dataProp.ValueKind == JsonValueKind.String)
        {
            // ドラッグ&ドロップ・クリップボード貼り付け(src/main.jsのinsertImageFile経由)。
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
