using System.Diagnostics;
using System.Text.Json;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace Pane;

/// <summary>
/// 設定画面専用の独立ウィンドウ。
///
/// これまで設定画面は本文と同じWebView2の中にHTMLのモーダルとして表示していたため、
/// 本体ウィンドウより大きく表示できなかった(ウィンドウを小さくして使っていると
/// 項目が見えない・スクロールが見にくい、という問題があった)。このクラスは
/// 本体ウィンドウ(<see cref="MainForm"/>)とは独立したWebView2を1つ持ち、
/// dist/settings-window.html(src/settings-entry.js)を読み込むことで、
/// 本体ウィンドウの大きさに関係なく設定画面を十分な大きさで表示できるようにする。
///
/// ブリッジのメッセージ(get-settings / save-settings / browse-path 等)は
/// <see cref="MainForm"/>と全く同じ内容を扱うため、実処理は<see cref="SettingsBridge"/>へ
/// 切り出してあり、ここでは受け口(WebMessageReceivedの振り分け)だけを持つ。
///
/// ライフサイクル: <see cref="PaneApplicationContext"/>が「同時に1つしか開かない」ことを
/// 保証する(既に開いていれば前面に出すだけ)。このウィンドウは
/// <see cref="PaneApplicationContext"/>のウィンドウ数の勘定(本体ウィンドウの終了判定)には
/// 含めない。そのため、
///   ・設定画面だけが開いている状態でも、それだけを理由にアプリが起動し続けることはない
///     (最後の本体ウィンドウが閉じてquitOnLastWindowClosed=trueなら、ExitThread前に
///     このウィンドウも明示的に閉じる。PaneApplicationContext.OnWindowClosed参照)。
///   ・quitOnLastWindowClosed=false またはプリロード常駐時に本体ウィンドウをすべて閉じても、
///     設定画面は取り残されず、そのまま開いた状態を維持する(アプリ自体がまだ生きているため)。
///
/// 体感速度対策(事前生成・インスタンス再利用): WebView2の初期化~ページ読み込みには実測で
/// 無視できない時間がかかる(下記の各Loggerログで実機計測できる)ため、<see cref="PaneApplicationContext"/>が
/// アイドル時にこのクラスを1つ裏で作っておく(<see cref="Prewarm"/>)。ユーザーが実際に設定を
/// 開く操作をした時点では、既に読み込みが終わっている前提で<see cref="Reveal"/>を呼ぶだけで済む
/// (間に合っていなければ、Revealされた後もこれまでどおりinitial-render-ready/フォールバックの
/// 仕組みで表示される)。閉じる操作(Escape・×ボタン・「戻る」等)ではインスタンスを破棄せず
/// 非表示にするだけにし(<see cref="OnFormClosing"/>)、次に開く時も同じインスタンス・同じ
/// WebView2を使い回す。アプリを本当に終了する時だけ<see cref="CloseForReal"/>で破棄する。
/// </summary>
internal sealed class SettingsWindow : Form
{
    private const string VirtualHostName = "pane.local";
    /// <summary>起動時の白フラッシュ対策(新方式)のフォールバック猶予。MainForm側と
    /// 同じ値・同じ考え方(<see cref="MainForm"/> WebViewRevealFallbackMs参照)。</summary>
    private const int WebViewRevealFallbackMs = 6000;
    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
    };

    private readonly WebView2 _webView = new();
    /// <summary>設定の保存後、開いているすべての本体ウィンドウへ再配信するためのコールバック
    /// (<see cref="PaneApplicationContext.BroadcastSettingsChanged"/>)。MainFormの
    /// _requestBroadcastSettingsと同じ役割。</summary>
    private readonly Action _broadcastSettingsChanged;
    /// <summary>起動時の白フラッシュ対策(新方式)のフォールバックタイマー。MainForm.RevealWebViewと
    /// 同じ役割(このクラスにはタブ・複数ウィンドウの概念が無いぶん単純)。</summary>
    private readonly System.Windows.Forms.Timer _webViewRevealFallbackTimer;
    private bool _webViewRevealed;
    /// <summary>各段階の所要時間をログに残すための計測開始点(このインスタンスが生成された瞬間)。
    /// 事前生成の場合はここが「裏で作り始めた時刻」になり、ユーザーが実際に設定を開いた瞬間の
    /// 体感速度は別途<see cref="PaneApplicationContext.OpenSettingsWindow"/>側で計測する。</summary>
    private readonly Stopwatch _stopwatch = Stopwatch.StartNew();
    /// <summary>trueの間だけ<see cref="Close"/>が実際にウィンドウを破棄する。既定はfalseで、
    /// その間の「閉じる」操作は<see cref="OnFormClosing"/>が非表示化に読み替える
    /// (インスタンス再利用のため)。アプリ終了時は<see cref="CloseForReal"/>がこれをtrueにしてから
    /// Closeを呼ぶ。</summary>
    private bool _realCloseAllowed;

    /// <summary>不具合修正(事前生成が全く効いていなかった件): WebView2環境の取得〜Navigate呼び出し
    /// までを行う<see cref="InitializeWebViewCoreAsync"/>のTask。<see cref="Prewarm"/>(事前生成)と
    /// <see cref="OnLoadAsync"/>(Loadイベント。事前生成が間に合わなかった場合のフォールバック)、
    /// さらに保険として<see cref="Reveal"/>からも呼ばれうるため、最初の呼び出しでこのフィールドに
    /// Taskを確定させ(<see cref="EnsureWebViewInitializedAsync"/>)、以後の呼び出しは同じTaskを
    /// 返すだけにして二重実行(WebMessageReceivedの二重購読・Navigateの二重呼び出し)を防ぐ。
    /// 「Prewarmの直後にユーザーが設定を開いてShow()→Loadが発火する」という競合が実機で
    /// 起こりうることへの対策。</summary>
    private Task? _initializeWebViewTask;
    /// <summary>WebView2の初期化(Navigate呼び出しまで)が完了したかどうか。<see cref="Reveal"/>が
    /// 「事前生成の初期化がその時点で終わっていたか」をログに残すために参照する
    /// (<see cref="IsRevealed"/>は「画面に実際に表示した」後の値のため別物)。</summary>
    private bool _webViewInitialized;

    /// <summary>初期描画(initial-render-ready受信 or フォールバック)が完了済みかどうか。
    /// <see cref="PaneApplicationContext.OpenSettingsWindow"/>が、事前生成が間に合っていたかを
    /// ログに残すために参照する。</summary>
    public bool IsRevealed => _webViewRevealed;

    /// <summary>
    /// 更新の適用(仕様書 U-04)で使う2つの依頼。設定ウィンドウ自身はアプリ全体の状態を
    /// 知らないため、PaneApplicationContextから受け取る。
    ///   hasUnsavedDocuments: どれか1つでも未保存の文書が開かれているか
    ///   shutdown: 新しいPaneを起動したあと、自分自身を終了させる
    /// </summary>
    private readonly Func<bool>? _hasUnsavedDocuments;
    private readonly Action? _shutdown;

    public SettingsWindow(
        Form? owner,
        Action broadcastSettingsChanged,
        Func<bool>? hasUnsavedDocuments = null,
        Action? shutdown = null)
    {
        Logger.Write("SettingsWindow: 生成開始");
        _broadcastSettingsChanged = broadcastSettingsChanged;
        _hasUnsavedDocuments = hasUnsavedDocuments;
        _shutdown = shutdown;

        Text = "Pane の設定";
        MinimumSize = new Size(640, 480);
        Size = ComputeInitialSize(owner);
        StartPosition = FormStartPosition.Manual;
        Location = ComputeCenteredLocation(owner, Size);
        // 既定でリサイズ可能(FormBorderStyle.Sizableが既定値のため明示設定は不要)。
        Icon? icon = AppIcon.Create();
        if (icon is not null) Icon = icon;

        // 起動時の白フラッシュ対策(実機不具合の修正): MainFormと同じ問題(WebView2が
        // HTML/CSSを読み込み終える前は既定のライト配色、あるいは白が一瞬見える)がこの
        // ウィンドウにもあった(ユーザー報告: 「設定も白で立ち上がってからテーマ色に変更」)。
        // 従来MainFormにしか無かった対策(背景色を先に塗る+WebView2を非表示のまま
        // 初期描画を進める新方式)をこちらにも適用する。色はMainFormと共有の
        // ResolveThemeBackgroundColorを使い、2箇所で値がずれないようにする。
        AppSettings initialSettings = SettingsService.Load();
        bool initialIsDark = MainForm.ResolveIsDarkTheme(initialSettings.Theme);
        Color initialBackground = MainForm.ResolveThemeBackgroundColor(initialIsDark);
        BackColor = initialBackground;
        _webView.DefaultBackgroundColor = initialBackground;

        _webView.Dock = DockStyle.Fill;
        Controls.Add(_webView);

        // WebView2コントロール自体を、JS側(settings-entry.js)から"initial-render-ready"が
        // 届くまで非表示にする(MainFormと同じ新方式)。非表示の間はこのフォームの
        // BackColor(直上でテーマ色に塗り済み)だけが見えるため、白は原理的に出ない。
        _webView.Visible = false;
        Logger.Write("SettingsWindow: WebView2を非表示で生成(initial-render-ready受信まで表示しない)");
        _webViewRevealFallbackTimer = new System.Windows.Forms.Timer { Interval = WebViewRevealFallbackMs };
        _webViewRevealFallbackTimer.Tick += (_, _) => RevealWebView(viaFallback: true);

        Load += OnLoadAsync;
        // 「閉じる」操作(Escape・×ボタン・キャンセル等、いずれもJS側からの
        // close-settings-windowメッセージ経由でCloseが呼ばれる、または×ボタン直接)では
        // インスタンスを破棄せず非表示にするだけにする(体感速度対策: 次に開く時に同じ
        // WebView2・同じ読み込み済みページを使い回すため)。アプリを本当に終了する時は
        // CloseForRealが_realCloseAllowedをtrueにしてからCloseを呼ぶので、その場合だけ
        // ここを素通りして本当に破棄される。
        FormClosing += OnFormClosing;
        FormClosed += (_, _) =>
        {
            Logger.Write("SettingsWindow.FormClosed(実破棄)");
            _webViewRevealFallbackTimer.Stop();
            _webViewRevealFallbackTimer.Dispose();
        };
    }

    private void OnFormClosing(object? sender, FormClosingEventArgs e)
    {
        if (_realCloseAllowed) return; // アプリ終了時: 本当に閉じる(FormClosedまで進める)
        e.Cancel = true;
        Hide();
        Logger.Debug("SettingsWindow: 閉じる操作 -> 非表示化のみ(インスタンスは再利用のため破棄しない)");
    }

    /// <summary>アプリ終了時(<see cref="PaneApplicationContext.OnWindowClosed"/>)専用。
    /// 通常の<see cref="Close"/>は<see cref="OnFormClosing"/>が非表示化に読み替えてしまうため、
    /// 本当に破棄したい場合はこちらを呼ぶ。</summary>
    public void CloseForReal()
    {
        _realCloseAllowed = true;
        Close();
    }

    /// <summary>事前生成(裏読み込み)用。Show()を呼ばずにWebView2の初期化(環境取得〜Navigateまで)を
    /// 直接始める。
    ///
    /// 不具合修正(実機ログで発覚): 従来はCreateControl()を呼ぶだけだった。CreateControl()は
    /// ネイティブハンドルを作るだけで、WinFormsのForm.LoadイベントはShow()(正確にはSetVisibleCore
    /// 経由の初回表示)でしか発火しないため、OnLoadAsync(実際のWebView2初期化・Navigateの中身)は
    /// 一切呼ばれておらず、事前生成は名前だけで実質何もしていなかった(実機ログの
    /// 「WebView2初期化完了(158922ms)」という、インスタンス生成からの異常に大きい経過時間が
    /// その証拠。ユーザーが実際に設定を開いた瞬間まで初期化そのものが始まっていなかった)。
    /// 対策として、Loadイベントに頼らずここから直接<see cref="EnsureWebViewInitializedAsync"/>
    /// (中身はOnLoadAsyncから切り出した<see cref="InitializeWebViewCoreAsync"/>)を呼ぶ。
    /// CreateControl()自体は、WebView2の初期化にネイティブハンドルが必要なため(このコントロールは
    /// 親フォームにAddControlsで追加済み)残す。
    ///
    /// 非同期だがasync voidにはしない: 呼び出し元の<see cref="PaneApplicationContext.PregenerateSettingsWindow"/>は
    /// 同期的なtry/catchで失敗時にフォールバックする作りになっており、その前提を崩さないため
    /// (async voidの例外はtry/catchで捕まえられずアプリを落としかねない)。代わりに戻り値のTaskへ
    /// ContinueWithで自前のログ出力を付け、例外はそこで握りつぶす(失敗しても次にユーザーが設定を
    /// 開いた際、Reveal経由の保険が同じEnsureWebViewInitializedAsyncを呼び直すだけで済む)。</summary>
    public void Prewarm()
    {
        Logger.Write("SettingsWindow: 事前生成(Prewarm)開始 - Show()を待たずに初期化を始める");
        CreateControl(); // WebView2の初期化にはネイティブハンドルが必要なため、Show()を呼ばずに先に作る
        Logger.Write("SettingsWindow: 事前生成で初期化を開始した");
        _ = EnsureWebViewInitializedAsync().ContinueWith(t =>
        {
            if (t.IsFaulted)
            {
                Logger.WriteException("SettingsWindow: 事前生成での初期化に失敗(次にユーザーが設定を開いた際、Reveal経由の保険が再試行する)", t.Exception!);
            }
            else
            {
                Logger.Write($"SettingsWindow: 事前生成での初期化が完了した({_stopwatch.ElapsedMilliseconds}ms)");
            }
        });
    }

    /// <summary>ユーザーが実際に設定を開いた時に呼ぶ。事前生成・前回のインスタンスを
    /// そのまま見せるだけで済ませる(WebView2の再初期化・再Navigateは行わない)。
    /// 既に表示中(既に開いている設定画面をもう一度「設定を開く」で前面に出すだけの
    /// ケース)では、ユーザーが調整済みのサイズ・位置や入力中の内容を一切変更しない
    /// (Activateのみ、旧来の「既に開いているため前面へ」と同じ挙動)。実際に非表示状態
    /// から見せ直す場合だけ、呼び出し元(owner。前回生成時とは別のウィンドウの可能性がある)に
    /// 合わせて位置・サイズを計算し直し、隠れている間に他の本体ウィンドウ経由で変わった
    /// 可能性がある項目(最近使ったファイル等)を最新化する。
    ///
    /// <see cref="PaneApplicationContext.OpenSettingsWindow"/>は、事前生成済みインスタンスの
    /// 再表示だけでなく、事前生成が間に合わず新規作成した直後の初回表示もここに統一している
    /// (どちらも「これからユーザーに見せる」という同じ意味のため)。そのため、初期化の保険
    /// (<see cref="EnsureWebViewInitializedAsync"/>)とフォールバック表示タイマーの開始は
    /// どちらもここに置く。</summary>
    /// <param name="category">開いた直後に表示する設定カテゴリ(settings.jsのカテゴリID。
    /// 例: "versionInfo")。nullなら前回開いていたカテゴリのまま。更新の案内(U-06)から
    /// 開くときに、利用者が探さずに済むよう「バージョン情報」を直接指定するために使う。</param>
    public void Reveal(Form? owner, string? category = null)
    {
        if (!string.IsNullOrEmpty(category))
        {
            // まだJS側の初期化が終わっていなければ、initial-render-readyを受けてから送る
            // (RevealWebView経由。届く前に送っても設定画面側が受け取れない)。
            _pendingCategory = category;
            TryPostPendingCategory();
        }
        bool wasHidden = !Visible;
        if (wasHidden)
        {
            Size = ComputeInitialSize(owner);
            Location = ComputeCenteredLocation(owner, Size);
            if (_webView.CoreWebView2 is not null)
            {
                SettingsBridge.PostSettingsSnapshot(PostToWeb);
            }
        }
        // 保険: 通常はPrewarm(事前生成)またはOnLoadAsync(Loadイベント)が既に初期化を始めている
        // はずだが、両方とも間に合わなかった/取りこぼした場合に備え、ここでも同じ二重実行防止
        // つきのメソッドを呼んでおく(EnsureWebViewInitializedAsyncは2回目以降は何もしない)。
        bool wasInitialized = _webViewInitialized;
        _ = EnsureWebViewInitializedAsync();
        Logger.Write($"SettingsWindow: Reveal時点で初期化{(wasInitialized ? "済みだった" : "まだだった")}");

        // 起動時の白フラッシュ対策(新方式)のフォールバック表示タイマー。
        // 不具合修正: 以前はOnLoadAsync(=事前生成の時点で発火していた)でタイマーを開始していた
        // ため、ユーザーが実際に設定を開く前の裏での事前生成の間に3秒が経過してしまい、
        // 「initial-render-readyを待たずに強制表示」というフォールバックが事前生成の裏側で
        // 意味もなく発動していた(事前生成中は誰も見ていないのでフォールバック自体は無害だが、
        // 本来の目的である「表示が遅れた時の救済」としては実際にユーザーへ見せようとした瞬間から
        // 数え直す必要がある)。このタイマーは「ユーザーに見せようとしてから」数えるべきものなので
        // ここ(実際にShow()する直前)で開始する。既に初期描画が完了済み(_webViewRevealed)なら
        // 二度と回す必要が無い。
        if (!_webViewRevealed) _webViewRevealFallbackTimer.Start();

        if (WindowState == FormWindowState.Minimized) WindowState = FormWindowState.Normal;
        Show();
        Activate();
        Logger.Debug($"SettingsWindow: Reveal (既存インスタンスを表示, wasHidden={wasHidden}, 読み込み完了済み={_webViewRevealed})");
    }

    /// <summary>MainForm.RevealWebViewと同じ役割・同じ二重防御(JS側の正常な通知と
    /// フォールバックタイマーのどちらが先に来ても1回だけ表示する)。詳細はそちらのコメント参照。</summary>
    /// <summary>開いた直後に表示するカテゴリ。まだJS側へ送れていないぶんを覚えておく。</summary>
    private string? _pendingCategory;

    /// <summary>保留中のカテゴリ指定を、送れる状態になっていればJS側へ渡す。</summary>
    private void TryPostPendingCategory()
    {
        if (_pendingCategory is null || !_webViewRevealed || _webView.CoreWebView2 is null) return;
        PostToWeb(new { type = "show-settings-category", category = _pendingCategory });
        Logger.Write($"SettingsWindow: カテゴリ「{_pendingCategory}」を表示するよう伝えた");
        _pendingCategory = null;
    }

    private void RevealWebView(bool viaFallback)
    {
        if (_webViewRevealed) return;
        _webViewRevealed = true;
        _webViewRevealFallbackTimer.Stop();
        _webView.Visible = true;
        Logger.Write(viaFallback
            ? $"SettingsWindow: WebView2を表示(フォールバック: {WebViewRevealFallbackMs}ms以内にinitial-render-readyが届かなかったため強制表示, 経過={_stopwatch.ElapsedMilliseconds}ms)"
            : "SettingsWindow: WebView2を表示(JS側からinitial-render-ready受信)");
        Logger.Write($"SettingsWindow: 表示 (合計 {_stopwatch.ElapsedMilliseconds}ms)");
        TryPostPendingCategory();
    }

    /// <summary>既定サイズ960x760。呼び出し元(owner)が表示されている画面より大きい場合は
    /// その画面の作業領域に収める。ownerがnull(事前生成の待機中で本体ウィンドウがまだ無い場合)
    /// はプライマリスクリーンを基準にする。</summary>
    private static Size ComputeInitialSize(Form? owner)
    {
        const int defaultWidth = 960;
        const int defaultHeight = 760;
        Rectangle area = ResolveWorkingArea(owner);
        int width = Math.Min(defaultWidth, area.Width);
        int height = Math.Min(defaultHeight, area.Height);
        return new Size(width, height);
    }

    /// <summary>呼び出し元ウィンドウの中央に配置する位置を求める。画面外にはみ出す場合は
    /// 画面の作業領域内に収める。ownerがnull、またはまだハンドルを持たない(表示前)の場合は
    /// 画面中央にフォールバックする。</summary>
    private static Point ComputeCenteredLocation(Form? owner, Size size)
    {
        Rectangle area = ResolveWorkingArea(owner);
        int centerX = owner is { IsHandleCreated: true } o1 ? o1.Bounds.Left + o1.Bounds.Width / 2 : area.Left + area.Width / 2;
        int centerY = owner is { IsHandleCreated: true } o2 ? o2.Bounds.Top + o2.Bounds.Height / 2 : area.Top + area.Height / 2;
        int x = centerX - size.Width / 2;
        int y = centerY - size.Height / 2;
        x = Math.Max(area.Left, Math.Min(x, area.Right - size.Width));
        y = Math.Max(area.Top, Math.Min(y, area.Bottom - size.Height));
        return new Point(x, y);
    }

    private static Rectangle ResolveWorkingArea(Form? owner)
    {
        Screen screen = owner is { IsHandleCreated: true } o ? Screen.FromControl(o) : Screen.PrimaryScreen ?? Screen.AllScreens[0];
        return screen.WorkingArea;
    }

    /// <summary>
    /// ウィンドウのネイティブハンドルが生成された直後、ネイティブタイトルバーの配色を
    /// 現在の設定(テーマ)に合わせて塗る。MainForm.OnHandleCreatedと同じ作法。
    /// </summary>
    protected override void OnHandleCreated(EventArgs e)
    {
        base.OnHandleCreated(e);
        AppSettings settings = SettingsService.Load();
        bool isDark = MainForm.ResolveIsDarkTheme(settings.Theme);
        WindowChrome.ApplyTheme(this, isDark);
    }

    /// <summary>
    /// { type: "preview-theme", isDark } を受け取り、ネイティブタイトルバーを保存前の選択中の
    /// テーマへ塗り直す(仕様: 設定画面でテーマを選んだ瞬間にプレビューできるようにする)。
    /// 本文(WebView2内)の配色はJS側(src/settings.js)がdocument.documentElementのdata属性を
    /// 直接書き換えて反映するため、ここではネイティブタイトルバーだけを扱えばよい。
    /// isDarkの計算(system/light/darkの解決)もJS側(resolveIsDark)で完結しており、ここでは
    /// 受け取った値をそのままWindowChrome.ApplyTheme(既定色、案B)へ渡すだけ。設定ファイルへの
    /// 書き込みは一切行わない(キャンセルしても消える一時的な見た目の変更にとどめるため)。
    /// </summary>
    private void HandlePreviewThemeRequest(JsonElement root)
    {
        if (!root.TryGetProperty("isDark", out JsonElement isDarkProp)) return;
        if (isDarkProp.ValueKind != JsonValueKind.True && isDarkProp.ValueKind != JsonValueKind.False) return;
        WindowChrome.ApplyTheme(this, isDarkProp.GetBoolean());
    }

    /// <summary>Loadイベント(初回Show()時に1回だけ発火)の受け口。不具合修正: 以前はWebView2の
    /// 初期化本体がここに直接書かれており、事前生成(<see cref="Prewarm"/>)からはLoadが発火しない
    /// ため実質ここが唯一の初期化経路になっていた(=事前生成が効いていなかった原因そのもの)。
    /// 中身は<see cref="InitializeWebViewCoreAsync"/>へ切り出し、ここは「事前生成が間に合わな
    /// かった場合のフォールバックとして、まだ初期化していなければ同じ処理を呼ぶ」だけの薄い
    /// 受け口にする(<see cref="EnsureWebViewInitializedAsync"/>が二重実行を防ぐため、事前生成が
    /// 先に始まっていた場合はここでは何も新しく走らない)。
    /// フォールバック表示タイマー(<see cref="_webViewRevealFallbackTimer"/>)の開始はここでは
    /// 行わない(<see cref="Reveal"/>側のコメント参照。事前生成の時点で回すとユーザーが実際に
    /// 開く前にタイマーが切れてしまうため)。</summary>
    private void OnLoadAsync(object? sender, EventArgs e)
    {
        bool alreadyStarted = _initializeWebViewTask is not null;
        Logger.Write($"SettingsWindow.OnLoadAsync開始 (事前生成{(alreadyStarted ? "が先に初期化を始めていた" : "はまだ始まっていなかった → ここから初期化する")})");
        _ = EnsureWebViewInitializedAsync().ContinueWith(
            t => Logger.WriteException("SettingsWindow: OnLoadAsync経由の初期化に失敗", t.Exception!),
            TaskContinuationOptions.OnlyOnFaulted);
    }

    /// <summary>二重実行を防ぎつつ<see cref="InitializeWebViewCoreAsync"/>を呼ぶ。
    /// <see cref="Prewarm"/>・<see cref="OnLoadAsync"/>・<see cref="Reveal"/>の保険、いずれから
    /// 呼ばれても実際に初期化処理が走るのは最初の1回だけで、2回目以降は同じTaskを返して
    /// 結果を待ち合わせるだけになる(nullコアレシング代入によるLazy初期化と同じ考え方)。</summary>
    private Task EnsureWebViewInitializedAsync() => _initializeWebViewTask ??= InitializeWebViewCoreAsync();

    /// <summary>WebView2環境の取得〜Navigate呼び出しまでの本体。旧OnLoadAsyncの中身をそのまま
    /// 切り出したもの(呼び出しタイミングだけを<see cref="EnsureWebViewInitializedAsync"/>経由に
    /// 変更した。処理の中身自体は変えていない)。直接は呼ばず、必ず
    /// <see cref="EnsureWebViewInitializedAsync"/>経由で呼ぶこと。</summary>
    private async Task InitializeWebViewCoreAsync()
    {
        // WebView2環境はMainForm側で生成・キャッシュされたものを再利用する(プロセス全体で1つ)。
        // 既に(preload起動・別ウィンドウ経由で)生成済みならここは即座に返る。
        CoreWebView2Environment env = await MainForm.EnsureEnvironmentAsync();
        await _webView.EnsureCoreWebView2Async(env);
        Logger.Write($"SettingsWindow: WebView2初期化完了 ({_stopwatch.ElapsedMilliseconds}ms)");

        // ブラウザ既定のアクセラレータキー・ページズームの無効化はMainFormと同じ設定に揃える。
        _webView.CoreWebView2.Settings.AreBrowserAcceleratorKeysEnabled = false;
        _webView.CoreWebView2.Settings.IsZoomControlEnabled = false;
        // ブラウザ既定の右クリックメニューを一切表示しない(docs/コンテキストメニュー仕様.md
        // 大原則1)。このウィンドウでは入力欄用の最小メニュー(第5節)だけを"open-context-menu"
        // 経由で表示する(MainFormと同じ受け口。下のOnWebMessageReceived参照)。
        _webView.CoreWebView2.Settings.AreDefaultContextMenusEnabled = false;
        // ブラウザ標準のスクリプトダイアログ(alert/confirm/prompt/beforeunload)を出さない。
        // Paneのデザインと無関係な標準ダイアログが出るのを防ぐ(MainFormと同じ理由)。
        _webView.CoreWebView2.Settings.AreDefaultScriptDialogsEnabled = false;
        // タッチ/プレシジョンタッチパッドの2本指ピンチズームを無効化する。IsZoomControlEnabled=false
        // だけでは塞がらず(公式に「has no effect on the existing browser zoom properties」と明記)、
        // 設定画面がクリップされてスクロールバーでも到達できない領域が生まれるため。
        _webView.CoreWebView2.Settings.IsPinchZoomEnabled = false;
        // リンクにマウスを乗せたときのChromium標準のURLチップ(左下)を出さない。
        _webView.CoreWebView2.Settings.IsStatusBarEnabled = false;
        // Chromium標準のオートフィル候補を出さない。設定画面は入力欄が多く、Paneのデザインと
        // 無関係な候補ポップアップが頻繁に出るうえ、入力内容をブラウザプロファイルへ保存しない。
        _webView.CoreWebView2.Settings.IsGeneralAutofillEnabled = false;
        _webView.CoreWebView2.WebMessageReceived += OnWebMessageReceived;
        // 外部リンクをPane内のポップアップで開かせず、OSの既定ブラウザへ委譲する
        // (処理の中身と判断の理由は3ウィンドウ共通のExternalLinkServiceを参照)。
        // この画面にリンク(バージョン情報等)が増えたとき、あるいは中クリック・Ctrl+クリックの
        // ような JS を経由しない経路でも、Pane内にポップアップが開かないようにしておく。
        _webView.CoreWebView2.NewWindowRequested += (_, e) =>
            ExternalLinkService.HandleNewWindowRequested(e, "[設定ウィンドウ] ");

        // 起動時の白フラッシュ対策の3層目(MainForm.OnLoadAsyncと同じ、多層防御のうちの1つ)。
        // WebView2が非表示の間は表に出ない対策なので必須ではないが、表示に切り替わった
        // 直後の一瞬までカバーしておく。Navigate前に注入することで、settings-window.html
        // 冒頭のOS設定フォールバックより先にdata-theme属性を確定させる。
        AppSettings navigateSettings = SettingsService.Load();
        bool navigateIsDark = MainForm.ResolveIsDarkTheme(navigateSettings.Theme);
        string initialThemeAttr = navigateIsDark ? "dark" : "light";
        await _webView.CoreWebView2.AddScriptToExecuteOnDocumentCreatedAsync(
            $"document.documentElement.dataset.theme = '{initialThemeAttr}';");

        string distPath = MainForm.ResolveDistPath();
        _webView.CoreWebView2.SetVirtualHostNameToFolderMapping(
            VirtualHostName, distPath, CoreWebView2HostResourceAccessKind.Allow);
        _webView.CoreWebView2.Navigate($"https://{VirtualHostName}/settings-window.html");
        Logger.Write($"SettingsWindow: Navigate呼び出し ({_stopwatch.ElapsedMilliseconds}ms)");

        _webViewInitialized = true;
    }

    private void OnWebMessageReceived(object? sender, CoreWebView2WebMessageReceivedEventArgs e)
    {
        using JsonDocument doc = JsonDocument.Parse(e.WebMessageAsJson);
        JsonElement root = doc.RootElement;
        string type = root.TryGetProperty("type", out JsonElement typeProp) ? typeProp.GetString() ?? "" : "";
        // "log" は内容が直後に別の行として出るため、タイプ名の記録は完全に重複する。
        // 詳細ログ側へ落として、既定のログが埋もれないようにする。
        if (type == "log") Logger.Debug($"[設定ウィンドウ] JSからのメッセージ受信: type={type}");
        else Logger.Write($"[設定ウィンドウ] JSからのメッセージ受信: type={type}");

        switch (type)
        {
            case "initial-render-ready":
                // 起動時の白フラッシュ対策(新方式)の本体。JS側(src/settings-entry.js)が
                // 設定画面の初期描画(テーマ適用・内容の描画)を終えた時点で送ってくる。
                Logger.Write($"SettingsWindow: initial-render-ready受信 ({_stopwatch.ElapsedMilliseconds}ms)");
                RevealWebView(viaFallback: false);
                break;
            case "get-settings":
                SettingsBridge.PostSettingsSnapshot(PostToWeb);
                break;
            case "preview-theme":
                // src/settings.js(previewTheme/revertThemePreview)からの、保存前のテーマプレビュー。
                // ここではネイティブタイトルバー(WebView2内のCSSでは塗れない部分)だけを塗り直す。
                // 設定ファイルへは一切書き込まない(書き込むのはsave-settingsのみ)。
                HandlePreviewThemeRequest(root);
                break;
            case "save-settings":
                SettingsBridge.HandleSaveSettingsRequest(root, PostToWeb, _broadcastSettingsChanged);
                break;
            case "browse-path":
                SettingsBridge.HandleBrowsePathRequest(root, this, PostToWeb);
                break;
            case "open-settings-file":
                SettingsBridge.OpenSettingsFileInExplorer();
                break;
            case "reset-settings":
                SettingsBridge.HandleResetSettingsRequest(PostToWeb, _broadcastSettingsChanged);
                break;
            case "clear-recent-files":
                SettingsBridge.HandleClearRecentFilesRequest(_broadcastSettingsChanged);
                break;
            case "clear-per-file-modes":
                SettingsBridge.HandleClearPerFileModesRequest(_broadcastSettingsChanged);
                break;
            case "open-default-apps-settings":
                SettingsBridge.OpenDefaultAppsSettings();
                break;
            case "open-with-dialog":
                SettingsBridge.HandleOpenWithDialog(root, this);
                break;
            // 「バージョン情報」「外観」カテゴリの各ボタン。設定画面はこの専用ウィンドウで
            // 表示されるため、これらの受け口は本体ウィンドウ側だけでなくここにも必要
            // (無いとボタンを押しても何も起きない)。
            case "open-log-folder":
                SettingsBridge.OpenLogFolderInExplorer();
                break;
            case "open-today-log":
                SettingsBridge.OpenTodayLogFile();
                break;
            case "open-theme-folder":
                SettingsBridge.OpenThemeFolderInExplorer();
                break;
            // 更新の確認と適用(仕様書 U-01・U-04)。利用者がボタンを押したときだけ通信する。
            // どちらも待ち時間があるため非同期で走らせ、結果は update-check-result /
            // update-progress として画面へ返す(ここでawaitするとUIが固まる)。
            case "check-update":
                _ = SettingsBridge.HandleCheckUpdateRequestAsync(PostToWeb);
                break;
            case "apply-update":
                _ = SettingsBridge.HandleApplyUpdateRequestAsync(
                    PostToWeb,
                    _hasUnsavedDocuments ?? (() => false),
                    _shutdown ?? (() => { }));
                break;
            // 「リリースページを開く」。開くURLはC#側が直前の確認で受け取った値だけを使う
            // (SettingsBridge.OpenReleasePage参照)。
            case "open-release-page":
                SettingsBridge.OpenReleasePage();
                break;
            case "close-settings-window":
                // JS側(settings.js、page表示モード)がキャンセル・保存完了・Escape等で
                // 「閉じる」操作をしたときの受け口。このウィンドウ自身を閉じるだけで、
                // 本体ウィンドウ・アプリ全体には影響しない。
                Close();
                break;
            case "open-context-menu":
                // 入力欄の右クリックメニュー(docs/コンテキストメニュー仕様.md 第5節)。
                // MainForm.HandleOpenContextMenuRequestと全く同じ座標変換・表示ロジック
                // (このウィンドウはCodeMirror本体を持たないため、出るのは常に入力欄用の
                // 最小メニューのみ)。
                HandleOpenContextMenuRequest(root);
                break;
            case "log":
                string level = root.TryGetProperty("level", out JsonElement levelProp) ? levelProp.GetString() ?? "log" : "log";
                string logMessage = root.TryGetProperty("message", out JsonElement msgProp) ? msgProp.GetString() ?? "" : "";
                Logger.WriteFromWeb("設定ウィンドウ JS", level, logMessage);
                break;
        }
    }

    /// <summary>{ type: "open-context-menu", x, y, items } を受け取り、ToolStripDropDownMenuを
    /// クリック位置に表示する。座標変換・NativeMenuの使い方はMainForm.HandleOpenContextMenuRequestと
    /// 全く同じ(座標変換ロジックも同じにする、という仕様書の指示どおり)。</summary>
    private void HandleOpenContextMenuRequest(JsonElement root)
    {
        double cssX = root.TryGetProperty("x", out JsonElement xProp) && xProp.ValueKind == JsonValueKind.Number ? xProp.GetDouble() : 0;
        double cssY = root.TryGetProperty("y", out JsonElement yProp) && yProp.ValueKind == JsonValueKind.Number ? yProp.GetDouble() : 0;
        List<NativeMenu.MenuItemData> items = root.TryGetProperty("items", out JsonElement itemsProp) && itemsProp.ValueKind == JsonValueKind.Array
            ? ParseMenuItems(itemsProp)
            : new List<NativeMenu.MenuItemData>();

        double dpiScale = DeviceDpi / 96.0;
        var clientPoint = new Point((int)Math.Round(cssX * dpiScale), (int)Math.Round(cssY * dpiScale));
        Point screenPoint = _webView.PointToScreen(clientPoint);
        Logger.Write($"[設定ウィンドウ] open-context-menu: 項目数={items.Count}, cssPoint=({cssX},{cssY}), screenPoint=({screenPoint.X},{screenPoint.Y})");

        AppSettings settings = SettingsService.Load();
        bool isDark = MainForm.ResolveIsDarkTheme(settings.Theme);
        // 実バグ3の修正: MainForm側と同じくテーマプリセットIDも渡す(MainForm.ResolveThemeId参照)。
        string themeId = MainForm.ResolveThemeId(settings, isDark);
        NativeMenu.Show(
            screenPoint,
            isDark,
            themeId,
            items,
            onCommand: id => PostToWeb(new { type = "menu-command", id }),
            onClosed: () => PostToWeb(new { type = "menu-closed", menu = "__context__" }));
    }

    /// <summary>"open-context-menu"のitems配列(入れ子のsubmenuを含む)をJSONから
    /// <see cref="NativeMenu.MenuItemData"/>へ変換する(MainForm.ParseMenuItemsと同一のロジック。
    /// 別クラスのprivateメソッドのため重複定義になる)。</summary>
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

    private void PostToWeb(object message)
    {
        if (_webView.CoreWebView2 is null) return;
        string json = JsonSerializer.Serialize(message, JsonOptions);
        _webView.CoreWebView2.PostWebMessageAsJson(json);
    }
}
